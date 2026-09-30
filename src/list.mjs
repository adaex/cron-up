// `cron-up list`：逐工作区列出任务的下次触发、节奏、类型与摘要，标注
// 该目录当前有没有交互会话。

import { deps } from './internals.mjs';
import { loadConfig } from './config.mjs';
import {
  clip,
  pad,
  dispWidth,
  taskView,
  fmtFireRange,
} from './display.mjs';

function rank(v) {
  if (!v.valid) return 3;
  if (v.missed) return 0;
  return v.nxt ? 1 : 2;
}

// 状态列文案：有效任务是「设定落点 → 预计实际触发」（无抖动时只有落点）。
function statusText(v) {
  if (!v.valid) return 'cron 无效';
  if (v.missed) return '已错过';
  if (!v.nxt) return '一年内无';
  return fmtFireRange(v.nxt, v.fire);
}

export async function cmdList(args) {
  const cfg = loadConfig(args?.config ?? deps.paths.configPath);
  const now = new Date();
  const cols = deps.terminalWidth();
  const blocks = [];
  let total = 0;
  let filesSeen = 0;
  let unreadable = 0;
  const [consumers] = await deps.scanSessions();
  for (const [ws] of deps.discover(cfg.roots, cfg.maxDepth)) {
    filesSeen += 1;
    const tasks = deps.readTasks(ws);
    if (tasks === null) {
      // 读不出不等于空：损坏时如实说任务不会执行。
      unreadable += 1;
      continue;
    }
    if (tasks.length === 0) continue;
    const views = tasks.map((t) => taskView(t, now));
    // 错过待补执行排最前，然后按下次时间升序，一年内无安排的垫底，无效
    // 的最后。
    views.sort((a, b) => rank(a) - rank(b)
      || ((a.nxt?.getTime() ?? Infinity) - (b.nxt?.getTime() ?? Infinity)));
    blocks.push([ws, consumers.has(ws), views]);
    total += tasks.length;
  }

  if (blocks.length === 0) {
    if (filesSeen === 0) {
      deps.print('配置的扫描目录下没有发现定时任务文件');
    } else if (unreadable === filesSeen) {
      deps.print(`发现 ${filesSeen} 个任务文件，全部读不出：其中的定时任务一个`
        + '都不会执行');
    } else {
      const tail = unreadable ? `，其中 ${unreadable} 个读不出` : '';
      deps.print(`发现 ${filesSeen} 个任务文件${tail}，其余的任务列表均为空`);
    }
    return;
  }

  blocks.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  deps.print(`共 ${blocks.length} 个工作区、${total} 个定时任务`);

  // 列宽从全部实际文案动态算（跨天箭头最长 "09-25 08:30 → 09-26 09:00"），
  // 改文案不会静默错位；cadence 是截断列，取固定上限。
  const statusW = Math.max(11,
    ...blocks.flatMap(([, , views]) => views.map((v) => dispWidth(statusText(v)))));
  const kindW = Math.max(...['一次性', '周期', '周期·永久'].map(dispWidth)) + 1;
  const cadW = 16;
  // 固定列（不含摘要段）："  " status "  " kind "  " cadence。摘要段再占
  // "  " + summaryW。空间紧张时摘要先让位；为 0 则整段省略——状态箭头在
  // 60 列下限下本身就可能占 25 列（跨天），不能再用 12 列摘要下限把行撑爆。
  const fixedW = 2 + statusW + 2 + kindW + 2 + cadW;
  const summaryW = Math.max(0, cols - fixedW - 2);
  for (const [ws, consumer, views] of blocks) {
    deps.print('');
    const label = consumer ? '交互会话：有' : '交互会话：无';
    const pathW = cols - dispWidth(label) - 1;
    deps.print(`${pad(clip(ws, pathW), pathW)} ${label}`);
    for (const v of views) {
      let kind;
      let cadence;
      let summary;
      if (!v.valid) {
        kind = '—';
        cadence = '—';
        summary = `原字段值：${JSON.stringify(v.expr)}；${v.summary}`;
      } else {
        kind = v.permanent ? '周期·永久' : v.kind;
        cadence = v.cadence;
        summary = v.summary;
      }
      let line = '  ' + pad(statusText(v), statusW) + '  '
        + pad(kind, kindW) + '  '
        + pad(clip(cadence, cadW), cadW);
      // 极窄屏摘要列算到 0：整段省略（含前导间隔），保证行宽不超终端。
      if (summaryW > 0) line += '  ' + clip(summary, summaryW);
      deps.print(line);
    }
  }
}
