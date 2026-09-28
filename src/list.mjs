// `cron-up list`：逐工作区列出任务的下次触发、节奏、类型与摘要，标注
// 该目录当前有没有交互会话。

import { deps } from './internals.mjs';
import { loadConfig } from './config.mjs';
import {
  clip,
  pad,
  dispWidth,
  taskView,
  fmtMDHM,
} from './display.mjs';

function rank(v) {
  if (!v.valid) return 3;
  if (v.missed) return 0;
  return v.nxt ? 1 : 2;
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

  // 列宽从全部候选文案动态算（时间戳 "09-25 08:30" 恒为 11 列），改文案
  // 不会静默错位；cadence 是截断列，取固定上限。
  const statusW = Math.max(11,
    ...['cron 无效', '已错过', '一年内无'].map(dispWidth));
  const kindW = Math.max(...['一次性', '周期', '周期·永久'].map(dispWidth)) + 1;
  const cadW = 16;
  // "  " + status + "  " + kind + "  " + cadence + "  " + summary
  const summaryW = Math.max(12,
    cols - (2 + statusW + 2 + kindW + 2 + cadW + 2));
  for (const [ws, consumer, views] of blocks) {
    deps.print('');
    const label = consumer ? '交互会话：有' : '交互会话：无';
    const pathW = cols - dispWidth(label) - 1;
    deps.print(`${pad(clip(ws, pathW), pathW)} ${label}`);
    for (const v of views) {
      let status;
      let kind;
      let cadence;
      let summary;
      if (!v.valid) {
        status = 'cron 无效';
        kind = '—';
        cadence = '—';
        summary = `原字段值：${JSON.stringify(v.expr)}；${v.summary}`;
      } else {
        // 已错过：一次性任务触发点已过，下次会话启动时补执行。missed 时
        // permanent 恒为 false（taskView 对一次性任务剔除了该标记）。
        status = v.missed ? '已错过'
          : (v.nxt ? fmtMDHM(v.nxt) : '一年内无');
        kind = v.permanent ? '周期·永久' : v.kind;
        cadence = v.cadence;
        summary = v.summary;
      }
      deps.print('  ' + pad(status, statusW) + '  ' + pad(kind, kindW) + '  '
        + pad(clip(cadence, cadW), cadW) + '  ' + clip(summary, summaryW));
    }
  }
}
