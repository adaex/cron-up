// 等宽终端展示原语与任务的展示视图。

import {
  parseCronOrNone,
  taskIsOneshot,
  wanted,
  nextDelivery,
} from './cron.mjs';

// 等宽终端里的宽字符区间（CJK 文字、全角标点、谚文、常用 emoji）：启发式
// 只覆盖任务摘要里真实出现的形态，区间外一律按 1 列——判错的代价仅是对
// 齐偏一列，不值得为此维护全量 Unicode 码点表。
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1faff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

function isWide(cp) {
  return WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

// 等宽终端里的显示宽度：宽字符（中文、全角标点）占两列。
export function dispWidth(s) {
  let n = 0;
  for (const ch of String(s)) n += isWide(ch.codePointAt(0)) ? 2 : 1;
  return n;
}

// 按显示宽度截断，尾部用省略号 … 占位。
export function clip(s, width) {
  width = Math.max(0, width);
  s = String(s);
  if (dispWidth(s) <= width) return s;
  // 省略号 U+2026 在多数终端占 1 列（Ambiguous），按 2 列预留只是更保守，
  // 结果总宽保证不超过 width。
  const keep = width - 2;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const w = isWide(ch.codePointAt(0)) ? 2 : 1;
    if (used + w > keep) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

export function pad(s, width) {
  return s + ' '.repeat(Math.max(0, width - dispWidth(s)));
}

// 倒计时的粗略中文说法，只用于总览页。ms 为非负毫秒差。
export function humanDelta(ms) {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return '不到 1 分钟';
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟后`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} 小时后`;
  return `${Math.floor(secs / 86400)} 天后`;
}

// list/总览上代表任务身份的一句话：prompt 的首个非空行。真实任务第一行
// 通常自带标题；取不到时如实标注，不留空白格。
function taskSummary(task) {
  const prompt = task?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) return '（无任务描述）';
  const first = prompt.split('\n').map((l) => l.trim()).find((l) => l) ?? '';
  return first.replace(/\s+/g, ' ');
}

// 把一个任务整理成展示数据。字段来自别的程序写的文件，畸形也不抛。
// 传 leadMs 时顺带在同一个已解析 cron 上回答「现在是否需要预热会话」
// （wanted），总览页就不必为同一任务再解析一遍 cron。
export function taskView(task, now, leadMs) {
  const expr = task?.cron;
  const cron = parseCronOrNone(expr);
  if (cron === null || !cron.satisfiable) {
    // 解析失败，或字段越界/反向区间导致集合为空：任何分钟都不可能匹配。
    // 区别于「合法但展示窗口内没有触发点」（如 2 月 30 日，解析正常却
    // 永不触发）。
    return {
      valid: false,
      expr,
      summary: taskSummary(task),
      permanent: false,
      wanted: null,
      fire: null,
    };
  }
  const oneshot = taskIsOneshot(task);
  // nxt 按定义不晚于展示语境里的下一次投递，「已错过」完全由补执行判定
  // 回答：lead 传 0（不带前瞻），与巡检的补执行判定同一口径。
  const missed = oneshot && wanted(cron, task, now, 0);
  // 落点与投递由 nextDelivery 同源算出：尾窗内的周期任务即将到来的是上
  // 一落点的这次延迟投递，箭头才画得出「09:00 → 09:30」，而不是从明天
  // 的落点拐回来（2 月 29 日任务尾窗内 nextAfter 甚至找不到下一落点）。
  const { slot, fire } = nextDelivery(cron, task, now);
  return {
    valid: true,
    // 已错过的一次性任务没有未来触发：nxt 置 null，否则「一年内无」的判
    // 断和总览「最近」（fire ?? nxt）会把它当成明年同刻的安排。
    nxt: missed ? null : slot,
    missed,
    kind: oneshot ? '一次性' : '周期',
    permanent: Boolean(task.permanent) && !oneshot,
    cadence: String(expr),
    summary: taskSummary(task),
    // wanted 恒为 null 或布尔：没传 leadMs（不问）与 cron 无效（问不了）
    // 都是 null，键的形状不随参数变化。
    wanted: leadMs !== undefined ? wanted(cron, task, now, leadMs) : null,
    // 计入 Claude Code 投递抖动后的预计实际触发时刻；已错过的一次性任务
    // 没有未来触发，为 null；尾窗内的周期任务是即将到来的这次延迟投递。
    // 与 nxt 同为 Date 或 null。
    fire: missed ? null : fire,
  };
}

// MM-DD HH:MM 口径下是否同一天/同一分钟。
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}
// 「同一分钟」的唯一判据，fmtFireRange 的箭头省略与总览「设定」附注共用。
export function sameMinute(a, b) {
  return sameDay(a, b) && a.getHours() === b.getHours()
    && a.getMinutes() === b.getMinutes();
}

// 两位数字补零：时间戳格式的公共零件，巡检日志的时间戳（patrol 的 log）
// 也复用。
export function pad2(n) {
  return String(n).padStart(2, '0');
}

// 「设定落点 → 预计实际触发」文案。抖动四舍五入到秒（调度器秒级轮询）：
// 同日省略第二个日期；预计值带非零秒时显示 HH:MM:SS（如 05:15:37）；落
// 在同一分钟（无抖动）则只显示落点，不画无意义的箭头。
export function fmtFireRange(nxt, fire) {
  if (!(fire instanceof Date) || !Number.isFinite(fire.getTime())) {
    return fmtMDHM(nxt);
  }
  const r = new Date(Math.round(fire.getTime() / 1000) * 1000);
  if (sameMinute(nxt, r)) return fmtMDHM(nxt);
  const secs = r.getSeconds() ? `:${pad2(r.getSeconds())}` : '';
  const tail = sameDay(nxt, r)
    ? `${pad2(r.getHours())}:${pad2(r.getMinutes())}${secs}`
    : `${fmtMDHM(r)}${secs}`;
  return `${fmtMDHM(nxt)} → ${tail}`;
}

// 仅 HH:MM（总览「（设定 HH:MM）」附注用）。
export function fmtHM(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// MM-DD HH:MM（任务触发点的统一展示格式）。
export function fmtMDHM(d) {
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 会话年龄的粗粒度中文：长驻按天计，否则按分钟。
export function sessionAgeZh(startedAt, cur) {
  const secs = Math.max(0, cur - startedAt);
  if (secs >= 86400) return `${Math.floor(secs / 86400)} 天`;
  return `${Math.floor(secs / 60)} 分钟`;
}

// 已过去时长的粗略中文说法，秒级分辨率：巡检漏轮间隔、被动退出会话的存
// 活时长、总览页的「上次巡检」用它。
export function elapsedZh(secs) {
  secs = Math.max(0, Math.floor(secs));
  if (secs < 60) return `${secs} 秒`;
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} 小时`;
  return `${Math.floor(secs / 86400)} 天`;
}
