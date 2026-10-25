// 无子命令时的总览页：一眼看清服务、配置、任务、预热会话与需要留意的
// 事。它回答「现在一切正常吗」：除汇总现状外，还把巡检视角的异常集中成
// 一个「需要留意」清单。

import fs from 'node:fs';
import path from 'node:path';

import { deps, packageVersion, getOwn } from './internals.mjs';
import {
  INTERVAL_SECONDS,
  LEAD_SECONDS,
} from './constants.mjs';
import {
  loadConfig,
  loadState,
  validateConfig,
  loadHeartbeat,
  heartbeatStale,
  isCooling,
  cooldownEtaMinutes,
} from './config.mjs';
import { taskFileExists, taskKey } from './tasks.mjs';
import { serviceLine, launcherHealth } from './service.mjs';
import {
  humanDelta,
  clip,
  pad,
  dispWidth,
  taskView,
  sessionAgeZh,
  elapsedZh,
  fmtMDHM,
  fmtHM,
  sameMinute,
} from './display.mjs';

// entry 此刻是否算「正在承接任务」：script 活（启动中或已认亲），或用户
// --resume 接管后 sid 仍活。冷却/死条目不报「没有会话」。
function entryHolds(ent, details, ws) {
  if (!ent) return false;
  if (deps.trackedAlive(ent)) return true;
  return typeof ent.sessionId === 'string'
    && (details.get(ws) ?? []).some((d) => d.sessionId === ent.sessionId);
}

// 总览页任务盘点。返回 [告警, 已在告警里说明冷却的 entry 键集合, 本轮发
// 现的工作区集合]（第三个供会话部分识别「已移出巡检视野」的会话）。
function overviewTasks(cfg, cols, details, state) {
  const alerts = [];
  const coolingWarned = new Set();
  const discovered = new Set();
  const now = new Date();
  const leadMs = LEAD_SECONDS * 1000;

  let nWs = 0;
  let nTasks = 0;
  let soonest = null;
  for (const [ws] of deps.discover(cfg.roots)) {
    discovered.add(ws);
    const tasks = deps.readTasks(ws);
    if (tasks === null) {
      // 与巡检同一条规则：文件还在却读不出，总览页要把它摆进「需要留
      // 意」，而不是装作这个工作区不存在。
      if (taskFileExists(ws)) {
        alerts.push(`${ws} 的任务文件读不出：其中的定时任务一个都不会执行`);
      }
      continue;
    }
    if (tasks.length === 0) continue;
    nWs += 1;
    nTasks += tasks.length;
    const liveSids = deps.liveSessionIds(details, ws);
    let bad = 0;
    for (const t of tasks) {
      const v = taskView(t, now, leadMs);
      if (!v.valid) {
        bad += 1;
        continue;
      }
      // 「最近」按计入抖动后的预计投递时间排，而非 cron 落点。
      const fire = v.fire ?? v.nxt;
      if (fire && (!soonest || fire.getTime() < soonest[0].getTime())) {
        soonest = [fire, ws, v.summary, v.nxt];
      }
      if (!v.wanted) continue;
      // 窗口内任务：创建者会话还开着（任务铁定投进它）或我们的预热已在
      // 承接，都不是异常；否则按 entry 的冷却/失败状态给一条可执行的告
      // 警。
      const key = taskKey(t);
      const ent = getOwn(state[ws], key);
      if (deps.creatorSessionAlive(t, liveSids) || entryHolds(ent, details, ws)) {
        continue;
      }
      if (isCooling(ent, Math.floor(now.getTime() / 1000))) {
        const cur = Math.floor(now.getTime() / 1000);
        const eta = cooldownEtaMinutes(ent, cur);
        alerts.push(
          `${ws} 任务 ${key} 即将执行（或错过待补执行），但预热连续失败 `
          + `${ent.fails ?? '?'} 次正处冷却中，约 ${eta} 分钟后才会重试；`
          + `请运行 cron-up logs ${path.basename(ws)}--${key} 排查`);
        coolingWarned.add(`${ws}\0${key}`);
      } else {
        const fails = ent?.fails ?? 0;
        const streak = fails > 0 ? `，近期已失败 ${fails} 次` : '';
        alerts.push(`${ws} 任务 ${key} 即将执行（或错过待补执行）${streak}，`
          + '但当前没有承接会话，下轮巡检会自动启动预热');
      }
    }
    if (bad > 0) {
      alerts.push(`${ws} 有 ${bad} 个任务的 cron 无法解析，`
        + `巡检会跳过${bad > 1 ? '它们' : '它'}`);
    }
  }

  deps.print(nTasks > 0
    ? `任务：${nTasks} 个，分布在 ${nWs} 个工作区`
    : '任务：暂无');
  if (soonest) {
    const [fire, ws, summary, nxt] = soonest;
    // 预计与设定不在同一分钟时，附注 cron 落点，解释两个时间的差。
    const setTag = (nxt && !sameMinute(fire, nxt))
      ? `，设定 ${fmtHM(nxt)}` : '';
    const line = `最近：${fmtMDHM(fire)}（${humanDelta(fire.getTime() - now.getTime())}`
      + `${setTag}） ${path.basename(ws)} · ${summary}`;
    deps.print(clip(line, cols));
  }
  return [alerts, coolingWarned, discovered];
}

function overviewSessions(cols, state, details, suppressCooling, discovered) {
  const alerts = [];
  const cur = Math.floor(Date.now() / 1000);
  const live = [];
  const detached = [];
  const cooling = [];
  const dead = [];
  for (const [ws, bucket] of Object.entries(state)) {
    for (const [taskId, ent] of Object.entries(bucket)) {
      const sidAlive = typeof ent.sessionId === 'string'
        && (details.get(ws) ?? []).some((d) => d.sessionId === ent.sessionId);
      if (isCooling(ent, cur)) {
        cooling.push([ws, taskId, ent]);
      } else if (deps.trackedAlive(ent)) {
        live.push([ws, taskId, ent]);
      } else if (sidAlive) {
        detached.push([ws, taskId, ent]);
      } else {
        dead.push([ws, taskId]);
      }
    }
  }
  let tail = '';
  if (cooling.length) tail += `，冷却 ${cooling.length} 个`;
  if (detached.length) tail += `，终端接管 ${detached.length} 个`;
  if (dead.length) tail += `，已失效 ${dead.length} 个`;
  const describe = ([ws, taskId, ent]) =>
    `${path.basename(ws)}/${taskId}（pid ${ent.pid}，已运行 `
    + `${sessionAgeZh(ent.startedAt ?? cur, cur)}）`;
  if (live.length) {
    const head = '预热会话：';
    const avail = cols - dispWidth(head) - dispWidth(tail)
      - (tail ? dispWidth('（）') : 0);
    const desc = clip(live.map(describe).join('、'), Math.max(0, avail));
    deps.print(`${head}${live.length} 个：${desc}${tail ? `（${tail.slice(1)}）` : ''}`);
  } else {
    deps.print(`预热会话：无${tail ? `（${tail.slice(1)}）` : ''}`);
  }
  for (const [ws, taskId] of detached) {
    deps.print(`  · ${path.basename(ws)}/${taskId}：已在终端 --resume 接管，`
      + '巡检不再另拉；该会话关闭后任务恢复自动预热');
  }
  for (const [ws, taskId, ent] of cooling) {
    if (suppressCooling.has(`${ws}\0${taskId}`)) continue;
    const eta = cooldownEtaMinutes(ent, cur);
    alerts.push(`${ws} 任务 ${taskId} 预热连续失败 ${ent.fails ?? '?'} 次，`
      + `冷却中，约 ${eta} 分钟后重试`);
  }
  if (discovered !== null) {
    for (const [ws, taskId, ent] of live) {
      if (!discovered.has(ws)) {
        alerts.push(
          `${ws} 任务 ${taskId} 的预热会话（pid ${ent.pid}）仍在运行，但该`
          + '目录已不在巡检范围内（任务文件被删或已移出 roots），cron-up 不'
          + '会再回收它；不需要时请自行结束');
      }
    }
  }
  return alerts;
}

const COMMANDS = [
  ['list', '逐个列出任务的内容摘要、设定/预计投递时间与预热状态'],
  ['logs [目录片段] [-f]', '查看巡检日志或后台会话记录'],
  ['run', '立即手动巡检一轮'],
  ['install --roots ~/a,~/b', '更新扫描目录并重新安装（不带参数沿用有效配置）'],
];

export async function cmdOverview(args) {
  const cols = deps.terminalWidth();
  const v = packageVersion();
  deps.print(v === null
    ? 'cron-up —— 为 Claude Code 定时任务按需预热交互会话'
    : `cron-up ${v} —— 为 Claude Code 定时任务按需预热交互会话（一任务一会话）`);

  const cfgPath = args?.config ?? deps.paths.configPath;
  let cfg = null;
  let cfgError = null;
  try {
    cfg = loadConfig(cfgPath, { missingOk: true, corruptOk: true });
  } catch (e) {
    if (e.code !== 'ENOENT') cfgError = e;
  }

  const info = deps.launchctlInfo();
  deps.print(serviceLine(info, fs.existsSync(deps.paths.plistPath)));

  const alerts = [];
  const health = launcherHealth();
  if (health) alerts.push(health);
  // 祖先链恒拍：总览要同时给出逐任务的活创建者/预热承接判定。
  const [, registryAlert, details] = await deps.scanSessions();
  if (registryAlert) alerts.push(registryAlert);
  const state = loadState();
  const curOv = Math.floor(Date.now() / 1000);
  const heartbeat = loadHeartbeat();

  if (cfgError !== null) {
    // 页面不能死在半路：损坏配置是「需要留意」的一种；巡检本身仍会以退
    // 出码 2 失败。
    deps.print(`配置：无法生效（${cfgPath}）`);
    alerts.push(`配置无法生效（巡检将以退出码 2 失败）：${cfgError.message}`);
  } else if (cfg === null) {
    deps.print('配置：缺失，运行 cron-up install 生成');
  } else {
    deps.print(`巡检：每 ${INTERVAL_SECONDS} 秒一轮，周期任务提前 ${LEAD_SECONDS} `
      + '秒进入预热窗口');
    if (info && info.interval !== null && info.interval !== undefined
        && info.interval !== INTERVAL_SECONDS) {
      alerts.push(`launchd 实际间隔 ${info.interval} 秒与当前版本的 `
        + `${INTERVAL_SECONDS} 秒不一致，重新运行 cron-up install 后生效`);
    }
    const rootsText = cfg.roots.join('、');
    deps.print(`扫描：${clip(rootsText, cols - dispWidth('扫描：'))}`);
    // 心跳回答「巡检最近真的在跑吗」：服务已加载但启动链运行期失效时，
    // 只有沉默的心跳能戳穿。
    if (heartbeat) {
      deps.print(`上次巡检：${elapsedZh(curOv - heartbeat.ranAt)}前`);
      if (info && heartbeatStale(heartbeat, INTERVAL_SECONDS, curOv)) {
        alerts.push(`巡检已沉默 ${elapsedZh(curOv - heartbeat.ranAt)}：launchd `
          + `显示服务已加载，但最近没有成功跑完的轮次，启动链可能已失效；`
          + '请运行 cron-up logs 查看巡检日志，必要时重跑 cron-up install');
      }
    }
    alerts.push(...validateConfig(cfg));
    deps.print('');
    const [taskAlerts, coolingWarned, found] = overviewTasks(
      cfg, cols, details, state);
    alerts.push(...taskAlerts);
    // 会话区需要上面产出的冷却抑制集合。
    alerts.push(...overviewSessions(cols, state, details, coolingWarned, found));
  }

  // 未安装/配置损坏时也可能有残留预热会话，照常展示（没有 discovered
  // 上下文，不做「移出 roots」告警）。
  if (cfg === null || cfgError !== null) {
    alerts.push(...overviewSessions(cols, state, details, new Set(), null));
  }

  if (alerts.length) {
    deps.print('需要留意：');
    for (const a of alerts) deps.print(`  · ${clip(a, cols - 4)}`);
    deps.print('');
  }

  deps.print('常用命令：');
  const nameW = Math.max(...COMMANDS.map(([n]) => dispWidth(n)));
  for (const [name, desc] of COMMANDS) {
    deps.print(`  cron-up ${pad(name, nameW)}  ${desc}`);
  }
}
