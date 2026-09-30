// 等宽终端展示原语与任务的展示视图。

import {
  parseCronOrNone,
  taskIsOneshot,
  wanted,
  predictedFire,
} from './cron.mjs';
import { DISPLAY_SEARCH_DAYS, ZERO_LEAD_MS } from './constants.mjs';

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
export function taskSummary(task) {
  const prompt = task?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) return '（无任务描述）';
  const first = prompt.split('\n').map((l) => l.trim()).find((l) => l) ?? '';
  return first.replace(/\s+/g, ' ');
}

// 把一个任务整理成展示数据。字段来自别的程序写的文件，畸形也不抛。
// 传 leadMs 时顺带在同一个已解析 cron 上回答「现在是否需要预热会话」
// （wanted），总览页就不必为同一任务再解析一遍 cron。
export function taskView(task, now, leadMs = undefined) {
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
  const nxt = cron.nextAfter(now, DISPLAY_SEARCH_DAYS);
  const oneshot = taskIsOneshot(task);
  // nxt 按定义严格晚于 now，「已错过」完全由补执行判定回答。
  const missed = oneshot && wanted(cron, task, now, ZERO_LEAD_MS);
  return {
    valid: true,
    nxt,
    missed,
    kind: oneshot ? '一次性' : '周期',
    permanent: Boolean(task.permanent) && !oneshot,
    cadence: typeof expr === 'string' ? expr : String(expr),
    summary: taskSummary(task),
    // wanted 恒为 null 或布尔：没传 leadMs（不问）与 cron 无效（问不了）
    // 都是 null，键的形状不随参数变化。
    wanted: leadMs !== undefined ? wanted(cron, task, now, leadMs) : null,
    // 计入 Claude Code 投递抖动后的预计实际触发时刻；已错过的一次性任务
    // 没有未来触发，为 null。与 nxt 同为 Date 或 null。
    fire: missed ? null : predictedFire(task, now),
  };
}

// MM-DD HH:MM 口径下是否同一天/同一分钟。
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}
function sameMinute(a, b) {
  return sameDay(a, b) && a.getHours() === b.getHours()
    && a.getMinutes() === b.getMinutes();
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
  const p = (n) => String(n).padStart(2, '0');
  const tail = sameDay(nxt, r)
    ? `${p(r.getHours())}:${p(r.getMinutes())}`
      + (r.getSeconds() ? `:${p(r.getSeconds())}` : '')
    : `${fmtMDHM(r)}${r.getSeconds() ? `:${p(r.getSeconds())}` : ''}`;
  return `${fmtMDHM(nxt)} → ${tail}`;
}

// 仅 HH:MM（总览「（设定 HH:MM）」附注用）。
export function fmtHM(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// MM-DD HH:MM（任务触发点的统一展示格式）。
export function fmtMDHM(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:`
    + `${p(d.getMinutes())}`;
}

// 会话年龄的粗粒度中文：长驻按天计，否则按分钟。
export function sessionAgeZh(startedAt, cur) {
  const secs = Math.max(0, cur - startedAt);
  if (secs >= 86400) return `${Math.floor(secs / 86400)} 天`;
  return `${Math.floor(secs / 60)} 分钟`;
}
