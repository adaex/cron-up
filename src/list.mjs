// `cron-up list`：逐工作区列出任务的下次触发、节奏、类型、摘要与该任务
// 的预热状态。

import { deps, getOwn } from './internals.mjs';
import { LEAD_SECONDS } from './constants.mjs';
import { loadConfig, loadState, isCooling } from './config.mjs';
import { taskKey, readWorkspaceConfig, configuredModel } from './tasks.mjs';
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

// 状态列文案：有效任务是「设定时间 → 预计投递」（无抖动时只有设定时间）。
function statusText(v) {
  if (!v.valid) return 'cron 无效';
  if (v.missed) return '已错过';
  if (!v.nxt) return '一年内无';
  return fmtFireRange(v.nxt, v.fire);
}

// 单个任务的预热状态标签。创建者会话还开着时返回空串——任务原生投进创
// 建者，无需预热；其余按 entry 的派生阶段给短标签。
function warmTag(t, v, ent, liveSids, ws, cur) {
  if (deps.creatorSessionAlive(t, liveSids)) return '';
  if (ent) {
    if (isCooling(ent, cur)) return '冷却中';
    if (deps.trackedAlive(ent)) {
      return ent.sessionId ? `预热中 ${ent.pid}` : `启动中 ${ent.pid}`;
    }
    if (typeof ent.sessionId === 'string'
        && (liveSids.has(ent.sessionId))) return '终端接管';
    if ((ent.fails ?? 0) > 0) return `失败${ent.fails}次`;
  }
  return v.wanted ? '待预热' : '';
}

export async function cmdList(args) {
  const cfg = loadConfig(args?.config ?? deps.paths.configPath);
  const now = new Date();
  const cur = Math.floor(now.getTime() / 1000);
  const cols = deps.terminalWidth();
  const blocks = [];
  let total = 0;
  let filesSeen = 0;
  let unreadable = 0;
  const [, , details] = await deps.scanSessions();
  const state = loadState();
  for (const [ws] of deps.discover(cfg.roots)) {
    filesSeen += 1;
    const tasks = deps.readTasks(ws);
    if (tasks === null) {
      // 读不出不等于空：损坏时如实说任务不会执行。
      unreadable += 1;
      continue;
    }
    if (tasks.length === 0) continue;
    const workspaceConfig = readWorkspaceConfig(ws);
    const liveSids = deps.liveSessionIds(details, ws);
    const views = tasks.map((t) => {
      // 带提前量：「待预热」标签与巡检的预热窗口同一口径。
      const v = taskView(t, now, LEAD_SECONDS * 1000);
      const key = taskKey(t);
      return {
        v,
        t,
        model: configuredModel(workspaceConfig, key),
        tag: warmTag(t, v, getOwn(state[ws], key), liveSids, ws, cur),
      };
    });
    // 错过待补执行排最前，然后按下次时间升序，一年内无安排的垫底，无效
    // 的最后。
    views.sort((a, b) => rank(a.v) - rank(b.v)
      || ((a.v.nxt?.getTime() ?? Infinity) - (b.v.nxt?.getTime() ?? Infinity)));
    blocks.push([ws, views, workspaceConfig.error]);
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
  if (unreadable > 0) {
    deps.print(`另有 ${unreadable} 个任务文件读不出，其中的定时任务不会执行`);
  }

  // 列宽从全部实际文案动态算；cadence 是截断列，取固定上限。
  const statusW = Math.max(11,
    ...blocks.flatMap(([, views]) => views.map(({ v }) => dispWidth(statusText(v)))));
  const kindW = Math.max(...['一次性', '周期', '周期·永久'].map(dispWidth)) + 1;
  const cadW = 16;
  // 固定列："  " status "  " kind "  " cadence "  " summary ["  " tag]。
  const fixedW = 2 + statusW + 2 + kindW + 2 + cadW;
  for (const [ws, views, configError] of blocks) {
    deps.print('');
    deps.print(clip(ws, cols));
    if (configError) {
      deps.print(clip(`  配置告警：修复前不会启动新的预热会话；${configError}`, cols));
    }
    for (const { v, tag, model } of views) {
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
      // 给模型与预热标签预留宽度（含括号与间隔）；极窄屏摘要可以截到 0。
      const tags = [model ? `模型 ${clip(model, 32)}` : '', tag].filter(Boolean);
      const rawTagPart = tags.length ? ` [${tags.join('，')}]` : '';
      const tagPart = clip(rawTagPart, Math.max(0, cols - fixedW - 2));
      const summaryW = Math.max(0,
        cols - fixedW - 2 - dispWidth(tagPart));
      let line = '  ' + pad(statusText(v), statusW) + '  '
        + pad(kind, kindW) + '  '
        + pad(clip(cadence, cadW), cadW);
      if (summaryW > 0) line += '  ' + clip(summary, summaryW);
      line += tagPart;
      deps.print(line);
    }
  }
}
