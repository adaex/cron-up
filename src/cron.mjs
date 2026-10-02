// 分钟级 cron 解析与下一次触发计算。字段全是别的程序写的，畸形表达式在
// 边界处返回 null/不可满足，绝不抛进巡检循环。

import {
  SEARCH_DAYS,
  DISPLAY_SEARCH_DAYS,
  CC_JITTER,
  TAIL_WINDOW_DAYS,
} from './constants.mjs';
import { isDecInt } from './internals.mjs';

const MS_DAY = 86400_000;
const MS_MINUTE = 60_000;

// 严格十进制整数（isDecInt 的谓词见 internals）：parseInt("5x") 会静默返回
// 5，必须自己卡。
function strictInt(s) {
  if (!isDecInt(s)) throw new Error(`不是整数：${s}`);
  return parseInt(s, 10);
}

// 解析一个 cron 字段为它命名的合法值域集合。
// 越界值丢弃而非报错：typo "99" 读作「该字段不匹配任何值」（由
// satisfiable 浮出），而不是炸掉解析或静默匹配到不该匹配的分钟。
export function parseCronField(expr, lo, hi) {
  const values = new Set();
  for (const token of expr.split(',')) {
    let rng;
    let step;
    const slash = token.indexOf('/');
    if (slash >= 0) {
      rng = token.slice(0, slash);
      step = strictInt(token.slice(slash + 1));
      // 步进必须显式卡正数：strictInt 接受负号，0 让步进循环原地打转、
      // 负数让 v+=step 递减、v<=end 恒真——两者都是永不退出的死循环，
      // 而一个含 "/-5" 的任务文件就能挂死整轮巡检。拒绝后由
      // parseCronOrNone 读作「cron 无效」。
      if (!(step > 0)) throw new Error('cron 步进必须是正整数');
    } else {
      rng = token;
      step = 1;
    }
    let start;
    let end;
    if (rng === '*') {
      start = lo;
      end = hi;
    } else if (rng.includes('-')) {
      const [a, b] = rng.split('-');
      start = strictInt(a);
      end = strictInt(b);
    } else {
      start = end = strictInt(rng);
      if (slash >= 0) end = hi; // vixie："5/10" 表示 5,15,25,… 直到 hi
    }
    for (let v = start; v <= end; v += step) {
      if (v >= lo && v <= hi) values.add(v);
    }
  }
  return values;
}

export class Cron {
  constructor(expr) {
    if (typeof expr !== 'string') throw new Error('cron 表达式必须是字符串');
    const parts = expr.trim().split(/\s+/); // 折叠任意空白
    if (parts.length !== 5) throw new Error(`cron 字段数应为 5：${expr}`);
    const [m, h, dom, mon, dow] = parts;
    this.minutes = parseCronField(m, 0, 59);
    this.hours = parseCronField(h, 0, 23);
    this.doms = parseCronField(dom, 1, 31);
    this.months = parseCronField(mon, 1, 12);
    // 先在 0..7 范围解析（0 和 7 都表示周日）再折叠。折叠必须发生在集合
    // 展开之后：文本上把 "7" 替成 "0" 会把正常区间 "1-7" 变成反向的
    // "1-0"，解析为空集后任务静默永不触发。
    this.dows = new Set([...parseCronField(dow, 0, 7)].map((v) => v % 7));
    this.domRestricted = dom !== '*';
    this.dowRestricted = dow !== '*';
    // 每字段非空只是必要条件（2 月 30 日依旧永不匹配）；这个标记只识别
    // 任何一分钟都不可能匹配的表达式，它们值得一句响亮的「cron 无效」，
    // 而不是看起来像「没有安排」。
    this.satisfiable = Boolean(
      this.minutes.size && this.hours.size && this.doms.size
        && this.months.size && this.dows.size,
    );
  }

  // Date 的 getDay() 本身就是周日=0，与 cron 同构，无需额外换算。
  matches(t) {
    if (!this.minutes.has(t.getMinutes()) || !this.hours.has(t.getHours())) {
      return false;
    }
    if (!this.months.has(t.getMonth() + 1)) return false;
    if (this.domRestricted && this.dowRestricted) {
      // DoM 与 DoW 同时受限时是 vixie 的 OR 语义：命中其一即可。
      return this.doms.has(t.getDate()) || this.dows.has(t.getDay());
    }
    return this.doms.has(t.getDate()) && this.dows.has(t.getDay());
  }

  // 严格晚于 after 的下一次触发；withinDays 内没有则 null。不可满足的表达
  // 式也返回 null。
  nextAfter(after, withinDays = SEARCH_DAYS) {
    if (!this.satisfiable) return null;
    const t = new Date(after.getTime());
    t.setSeconds(0, 0);
    t.setMinutes(t.getMinutes() + 1);
    const deadline = after.getTime() + withinDays * MS_DAY;
    while (t.getTime() <= deadline) {
      // 日历快进：跳过不可能匹配的整月、整小时，再逐分钟扫描。跳过的都
      // 是 matches 会拒绝的时刻，结果与朴素扫描完全一致；一年窗口从约
      // 5·10⁵ 次迭代降到 ~10⁴，DISPLAY_SEARCH_DAYS 因此可行。
      if (!this.months.has(t.getMonth() + 1)) {
        t.setTime(new Date(t.getFullYear(), t.getMonth() + 1, 1).getTime());
        continue;
      }
      if (!this.hours.has(t.getHours())) {
        t.setHours(t.getHours() + 1, 0, 0, 0);
        continue;
      }
      if (this.matches(t)) return t;
      t.setMinutes(t.getMinutes() + 1);
    }
    return null;
  }

  // 不晚于 t 所在分钟的最近一次匹配（含当前分钟）；withinDays 天前还没有
  // 则 null。与 nextAfter 对称做整月/整小时快进，366 天窗口也便宜。用于
  // 判断「现在是否落在某次触发的投递延迟尾窗里」。
  prevAtOrBefore(t, withinDays) {
    if (!this.satisfiable) return null;
    const cur = new Date(t.getTime());
    cur.setSeconds(0, 0);
    const deadline = cur.getTime() - withinDays * MS_DAY;
    while (cur.getTime() >= deadline) {
      if (!this.months.has(cur.getMonth() + 1)) {
        // 退到上个月最后一分钟：置本月 1 号 00:00 再退 1 分钟。
        cur.setDate(1);
        cur.setHours(0, 0, 0, 0);
        cur.setMinutes(cur.getMinutes() - 1);
        continue;
      }
      if (!this.hours.has(cur.getHours())) {
        // 退到严格更早的最近匹配小时的 59 分；当天已无更早匹配则落到前一
        // 天的最大匹配小时（小时集合每天相同，satisfiable 保证其非空）。
        let h = cur.getHours() - 1;
        while (h >= 0 && !this.hours.has(h)) h -= 1;
        if (h < 0) {
          const maxH = Math.max(...this.hours);
          cur.setDate(cur.getDate() - 1);
          cur.setHours(maxH, 59, 0, 0);
        } else {
          cur.setHours(h, 59, 0, 0);
        }
        continue;
      }
      if (this.matches(cur)) return cur;
      cur.setMinutes(cur.getMinutes() - 1);
    }
    return null;
  }
}

// CronCreate 产生的一次性任务形状像 'M H DoM Mon *'，作为没有 recurring
// 标志时的兜底识别法。
function cronLooksOneshot(expr) {
  const parts = expr.split(/\s+/);
  return parts.length === 5 && parts[4] === '*'
    && parts.slice(0, 4).every((p) => /^\d+$/.test(p));
}

export function taskIsOneshot(task) {
  // 调度器会写显式 recurring 标志，优先信它；手写任务文件才退回形状识别。
  if ('recurring' in task) return !Boolean(task.recurring);
  try {
    return cronLooksOneshot(task.cron);
  } catch {
    return false;
  }
}

// 解析 cron；任何畸形都返回 null，不把异常抛给调用方。展示页与巡检共用
// 这一个入口，两边不必各自抄一遍异常元组。
export function parseCronOrNone(expr) {
  try {
    return new Cron(expr);
  } catch {
    return null;
  }
}

function createdAtDate(task) {
  const v = task.createdAt;
  if (!v || typeof v !== 'number') return null;
  const d = new Date(v); // 字段是毫秒时间戳
  return Number.isFinite(d.getTime()) ? d : null;
}

// 在已解析的 cron 上判定：这个任务现在是否需要一个已预热的会话。
function wanted(cron, task, now, leadMs) {
  const nxt = cron.nextAfter(now);
  if (nxt && nxt.getTime() <= now.getTime() + leadMs) return true;
  // 首次触发已过却仍在文件里：一次性任务意味着没有 REPL 运行时被错过
  // （重启/睡眠）。原生机制会在会话启动时补执行一次再删除它。
  if (taskIsOneshot(task)) {
    const created = createdAtDate(task);
    if (!created) return false;
    // 从创建时间向前搜到当前：要找的就是 created..now 之间的第一个触发
    // 点，不封顶——「下个月某天」这类远跨度一次性任务错过时同样该补执行。
    // 陈年条目也不贵：nextAfter 的日历快进按月跳，十年也只有百余次迭代。
    const span = Math.floor((now.getTime() - created.getTime()) / MS_DAY) + 1;
    const first = cron.nextAfter(
      new Date(created.getTime() - MS_MINUTE),
      span,
    );
    return first !== null && first.getTime() <= now.getTime();
  }
  // 周期任务：投递不是在落点，而是落点 + 按 id 确定的抖动（每日任务通常
  // 30 分）。落点已过、抖动投递时刻未到的这段「投递尾窗」里会话仍必须在
  // 场——否则 window 模式会把执行完近邻任务后空闲下来的会话回收且不重
  // 拉，让本次触发漏跑（周期任务没有补执行）。机制与窗口口径见
  // recurringTailWindow。
  return recurringTailWindow(cron, task.id, now) !== null;
}

// 任务是否需要已预热的会话。任务字段全是别的程序写的，畸形条目读作「不
// 需要」，绝不能让一个坏条目中断整轮巡检。
export function taskWanted(task, now, leadMs) {
  const cron = parseCronOrNone(task?.cron);
  return cron !== null && wanted(cron, task, now, leadMs);
}

// wanted 供展示视图复用（同一个已解析 cron 顺带回答巡检问题）。
export { wanted };

// ---- Claude Code 投递抖动（预计实际触发时间）----
// 复刻 v2.1.285 内部的 M()：任务 id 前 8 位十六进制除以 2^32，得 [0,1) 的
// 固定哈希——同一任务每次触发的抖动完全相同，不是随机数。id 缺失或前 8
// 位都不是十六进制时 parseInt 得 NaN，上游回退 0；任务文件由别的程序书
// 写，这里同样永不抛。
export function taskIdHash(taskId) {
  if (typeof taskId !== 'string') return 0;
  const n = parseInt(taskId.slice(0, 8), 16) / 2 ** 32;
  return Number.isFinite(n) ? n : 0;
}

// 任务在展示语境里的「落点 → 预计实际投递」对：一次性任务是落点加网格
// 提前量；周期任务在投递尾窗内属于上一落点（即将到来的这次延迟投递，
// 不是 nextAfter 给出的下个落点——后者严格在未来，会把展示拐到明天），
// 否则是下一落点 + 按 id 的抖动。先于窗口检查尾窗：2 月 29 日这类长周期
// 任务的下一落点可能在展示窗口之外，正在等待的投递却依然成立。taskView
// 的 nxt/fire 与 predictedFire 共用这一个口径，落点与投递同源，两边不会
// 各说各话。返回 {slot, fire}，均为 Date 或 null（窗口内没有落点时双双
// 为 null）。cron 须已解析且 satisfiable。
export function nextDelivery(cron, task, now, withinDays = DISPLAY_SEARCH_DAYS) {
  if (taskIsOneshot(task)) {
    const slot = cron.nextAfter(now, withinDays);
    if (slot === null) return { slot: null, fire: null };
    // 复刻 Wsn()：只有落点分钟落在 :00/:30 网格上才提前一个按哈希缩放的
    // 小量（0~90 秒），其余分钟整点不抖；提前量不越过 now。
    if (slot.getMinutes() % CC_JITTER.oneShotMinuteMod !== 0) {
      return { slot, fire: slot };
    }
    const h = taskIdHash(task?.id);
    const ahead = CC_JITTER.oneShotFloorMs
      + h * (CC_JITTER.oneShotMaxMs - CC_JITTER.oneShotFloorMs);
    return { slot, fire: new Date(Math.max(slot.getTime() - ahead, now.getTime())) };
  }

  const tail = recurringTailWindow(cron, task?.id, now);
  if (tail !== null) return { slot: tail[0], fire: new Date(tail[1]) };

  const slot = cron.nextAfter(now, withinDays);
  if (slot === null) return { slot: null, fire: null };
  // 复刻 bOt()：抖动按「本落点到下一落点」的周期比例缩放并封顶。nextAfter
  // 语义是严格晚于入参（内部进位一分钟），传 slot 本身即取下一落点；窗口
  // 边缘取不到时与上游一致：视为无后续，不抖动。
  return {
    slot,
    fire: new Date(slot.getTime() + recurringDelayMs(cron, slot, task?.id, withinDays)),
  };
  // 注：上游 bOt 另有一个 cacheLeadMs 分支——仅当相邻落点间隔落在
  // [300000, 315000)ms（约 5 分钟周期的高频 cron，如 */5）且表达式匹配
  // 其内部步进正则时，调度时刻提前 15 秒。日/周/月任务周期远大于此，不
  // 经过该分支，故不予复刻。
}

// 任务按 Claude Code 的抖动规则预计的实际触发时刻（nextDelivery 的
// fire）；cron 无效、不在尾窗内、窗口内没有落点时返回 null。基准为 now
// （上游调度器以上次触发时刻为基准，展示只关心从现在起的下一次，两者算
// 出的落点一致）。
export function predictedFire(task, now, withinDays = DISPLAY_SEARCH_DAYS) {
  const cron = parseCronOrNone(task?.cron);
  if (cron === null || !cron.satisfiable) return null;
  return nextDelivery(cron, task, now, withinDays).fire;
}

// 周期任务从某个落点起的投递延迟（ms）：hash(id)·frac·周期，封顶 30 分。
// slot 后取不到下一落点（窗口边缘、不可满足）时返回 0。
function recurringDelayMs(cron, slot, taskId, withinDays) {
  const next = cron.nextAfter(new Date(slot.getTime()), withinDays);
  if (next === null) return 0;
  const period = next.getTime() - slot.getTime();
  return Math.min(
    taskIdHash(taskId) * CC_JITTER.recurringFrac * period,
    CC_JITTER.recurringCapMs,
  );
}

// 周期任务的「投递尾窗」判定：上一落点已过、按 id 算的延迟投递时刻未
// 到。返回 [落点, 投递时刻 ms]；不在尾窗、找不到上一或下一落点返回
// null。wanted（保活判定）与 nextDelivery（展示）共用这一口径，两边不会
// 各说各话；窗口取 TAIL_WINDOW_DAYS，理由见 constants。
function recurringTailWindow(cron, taskId, now) {
  const prev = cron.prevAtOrBefore(now, TAIL_WINDOW_DAYS);
  if (prev === null) return null;
  const fireMs = prev.getTime()
    + recurringDelayMs(cron, prev, taskId, TAIL_WINDOW_DAYS);
  if (now.getTime() >= fireMs) return null;
  return [prev, fireMs];
}
