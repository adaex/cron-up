// 分钟级 cron 解析与下一次触发计算。字段全是别的程序写的，畸形表达式在
// 边界处返回 null/不可满足，绝不抛进巡检循环。

import { SEARCH_DAYS, MISSED_LOOKBACK_DAYS } from './constants.mjs';

const MS_DAY = 86400_000;
const MS_MINUTE = 60_000;

// 严格十进制整数：Python int("5x") 会抛，JS parseInt("5x") 却返回 5，必须
// 自己卡。仅接受可选负号加纯数字。
function strictInt(s) {
  if (!/^-?\d+$/.test(s)) throw new Error(`不是整数：${s}`);
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
      step = strictInt(token.slice(slash + 1)); // "/0" 必须抛：步进 0 会死循环
      if (step === 0) throw new Error('cron 步进不能为 0');
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
    const parts = expr.trim().split(/\s+/); // Python split() 折叠任意空白
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

  // JS Date 的 getDay() 本身就是周日=0，与 cron 同构，无需 Python 版的
  // (weekday+1)%7 换算。
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
}

// CronCreate 产生的一次性任务形状像 'M H DoM Mon *'，作为没有 recurring
// 标志时的兜底识别法。
export function cronLooksOneshot(expr) {
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
  if (!v || typeof v !== 'number') return null; // 等价 Python 的 truthy 检查
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
    // 从创建时间向前搜，而不是从现在。跨度要封顶：表达式永不匹配的陈旧
    // 条目否则会逐分钟扫到创建之初。一次性任务都在触发前不久创建，封顶
    // 不会漏掉真实条目，超过上界的早就死透了。
    const span = Math.min(
      Math.floor((now.getTime() - created.getTime()) / MS_DAY) + 1,
      MISSED_LOOKBACK_DAYS,
    );
    const first = cron.nextAfter(
      new Date(created.getTime() - MS_MINUTE),
      span,
    );
    if (first && first.getTime() <= now.getTime()) return true;
  }
  return false;
}

// 任务是否需要已预热的会话。任务字段全是别的程序写的，畸形条目读作「不
// 需要」，绝不能让一个坏条目中断整轮巡检。
export function taskWanted(task, now, leadMs) {
  const cron = parseCronOrNone(task?.cron);
  return cron !== null && wanted(cron, task, now, leadMs);
}

// wanted 供展示视图复用（同一个已解析 cron 顺带回答巡检问题）。
export { wanted };
