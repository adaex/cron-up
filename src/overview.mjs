// 无子命令时的总览页：一眼看清服务、配置、任务、保活会话与需要留意的
// 事。它回答「现在一切正常吗」：除汇总现状外，还把巡检视角的异常集中成
// 一个「需要留意」清单。

import fs from 'node:fs';
import path from 'node:path';

import { deps } from './internals.mjs';
import {
  loadConfig,
  loadState,
  validateConfig,
  loadHeartbeat,
  heartbeatStale,
} from './config.mjs';
import { taskFileExists } from './tasks.mjs';
import { packageVersion } from './paths.mjs';
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
} from './display.mjs';

// 总览页任务盘点。返回 [告警, 已在告警里说明冷却的工作区集合, 本轮发现
// 的工作区集合]（第三个供会话部分识别「已移出巡检视野」的会话）。
function overviewTasks(cfg, cols, consumers, state) {
  const alerts = [];
  const coolingWarned = new Set();
  const discovered = new Set();
  const now = new Date();
  const cur = Math.floor(now.getTime() / 1000);
  const leadMs = cfg.leadSeconds * 1000;

  let nWs = 0;
  let nTasks = 0;
  let unrenewed = 0;
  let soonest = null;
  for (const [ws] of deps.discover(cfg.roots, cfg.maxDepth)) {
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
    let bad = 0;
    let wanted = false;
    for (const t of tasks) {
      // 与 renew 同一条字段规则：显式周期任务却没有 truthy permanent，仍
      // 受 7 天过期约束。从原始任务计数，与 cron 合法性无关，坏 cron 也照
      // 提醒。
      if (t.recurring && !t.permanent) unrenewed += 1;
      const v = taskView(t, now, leadMs);
      if (!v.valid) {
        bad += 1;
        continue;
      }
      // 「最近」按计入抖动后的预计实际触发排，而非 cron 落点。
      const fire = v.fire ?? v.nxt;
      if (fire && (!soonest || fire.getTime() < soonest[0].getTime())) {
        soonest = [fire, ws, v.summary, v.nxt];
      }
      if (v.wanted) wanted = true;
    }
    if (bad > 0) {
      alerts.push(`${ws} 有 ${bad} 个任务的 cron 无法解析，`
        + `巡检会跳过${bad > 1 ? '它们' : '它'}`);
    }
    if (wanted && !consumers.has(ws)) {
      const ent = state[ws] ?? {};
      const cooldown = ent.cooldownUntil ?? 0;
      if (cooldown > cur) {
        // 与「下轮会自动启动」互斥：冷却中就是不会启动，两条同现会自相
        // 矛盾，这里合并成一条。
        const eta = Math.max(0, Math.floor((cooldown - cur) / 60));
        alerts.push(
          `${ws} 有任务即将执行（或错过待补执行），但保活会话连续失败 `
          + `${ent.fails ?? '?'} 次正处冷却中，约 ${eta} 分钟后才会重试；`
          + `请运行 cron-up logs ${path.basename(ws)} 排查`);
        coolingWarned.add(ws);
      } else {
        // 失败计数放在句子中部：总览告警按终端宽度截尾，计数比尾部的
        // 「下轮会自动启动」更该活下来；满额后的去向由「冷却中」那条合并
        // 告警解释，这里不重复。
        const fails = ent.fails ?? 0;
        const streak = fails > 0 ? `，近期已失败 ${fails} 次` : '';
        alerts.push(`${ws} 有任务即将执行（或错过待补执行）${streak}，`
          + '但当前没有交互会话，下轮巡检会自动启动');
      }
    }
  }

  deps.print(nTasks > 0
    ? `任务：${nTasks} 个，分布在 ${nWs} 个工作区`
    : '任务：暂无');
  if (soonest) {
    const [fire, ws, summary, nxt] = soonest;
    // 预计与设定不在同一分钟时，附注 cron 落点，解释两个时间的差。
    const setTag = (nxt && (fmtHM(fire) !== fmtHM(nxt)
      || fire.getDate() !== nxt.getDate()))
      ? `，设定 ${fmtHM(nxt)}` : '';
    const line = `最近：${fmtMDHM(fire)}（${humanDelta(fire.getTime() - now.getTime())}`
      + `${setTag}） ${path.basename(ws)} · ${summary}`;
    deps.print(clip(line, cols));
  }
  if (!cfg.autoRenew && unrenewed > 0) {
    alerts.push(
      `自动续期已关闭：${unrenewed} 个周期任务尚未标记 permanent，创建满 7 `
      + '天后会末次执行并被删除。运行 cron-up renew 立即续期，或在配置中'
      + '开启 autoRenew');
  }
  return [alerts, coolingWarned, discovered];
}

function overviewSessions(cols, state, suppressCooling, discovered) {
  const alerts = [];
  const cur = Math.floor(Date.now() / 1000);
  const live = [];
  const cooling = [];
  const dead = [];
  for (const [ws, ent] of Object.entries(state)) {
    if ((ent.cooldownUntil ?? 0) > cur) cooling.push([ws, ent]);
    else if (deps.trackedAlive(ent)) live.push([ws, ent]);
    else dead.push(ws); // 记录还在、进程已没：带失败计数的保留至老化，其余下轮清理
  }
  let tail = '';
  if (cooling.length) tail += `，冷却 ${cooling.length} 个`;
  if (dead.length) tail += `，已失效 ${dead.length} 个`;
  if (live.length) {
    const desc = live.map(([ws, ent]) =>
      `${path.basename(ws)}（pid ${ent.pid}，已运行 `
      + `${sessionAgeZh(ent.startedAt ?? cur, cur)}）`).join('、');
    const head = `会话：保活 ${live.length} 个（`;
    const fixed = dispWidth(head) + dispWidth(tail) + dispWidth('）');
    deps.print(`${head}${clip(desc, cols - fixed)}）${tail}`);
  } else {
    deps.print(`会话：无保活会话${tail}`);
  }
  for (const [ws, ent] of cooling) {
    if (suppressCooling.has(ws)) continue; // 任务区已给过带上下文的合并告警
    const eta = Math.max(0, Math.floor(((ent.cooldownUntil ?? 0) - cur) / 60));
    alerts.push(`${ws} 保活连续失败 ${ent.fails ?? '?'} 次，冷却中，约 ${eta} `
      + '分钟后重试');
  }
  if (discovered !== null) {
    for (const [ws, ent] of live) {
      if (!discovered.has(ws)) {
        alerts.push(
          `${ws} 的保活会话（pid ${ent.pid}）仍在运行，但该目录已不在巡检范`
          + '围内（任务文件被删或已移出 roots），cron-up 不会再回收或换代'
          + '它；不需要时请自行结束');
      }
    }
  }
  return alerts;
}

const COMMANDS = [
  ['list', '逐个列出任务的内容摘要、设定/预计触发时间与会话状态'],
  ['logs [目录片段] [-f]', '查看巡检日志或后台会话记录'],
  ['run', '立即手动巡检一轮'],
  ['renew', '立即给所有周期任务补 permanent 并改小 id'],
  ['install --force', '更新配置并重新安装（全部参数见 --help）'],
];

export async function cmdOverview(args) {
  const cols = deps.terminalWidth();
  const v = packageVersion();
  deps.print(v === null
    ? 'cron-up —— 为定时任务提前备好交互会话'
    : `cron-up ${v} —— 为定时任务提前备好交互会话`);

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
  // plist 写死的 node/入口路径失效（Node 版本目录被清）时 launchd 每轮
  // 都静默拉不起来，这是总览唯一能发现它的地方。
  const health = launcherHealth();
  if (health) alerts.push(health);
  const [consumers, registryAlert] = await deps.scanSessions();
  if (registryAlert) alerts.push(registryAlert);
  const state = loadState();
  const curOv = Math.floor(Date.now() / 1000);
  const heartbeat = loadHeartbeat();
  const coolingWarned = new Set();
  let discovered = null;

  if (cfgError !== null) {
    // 页面不能死在半路：损坏或字段类型不对的配置是「需要留意」的一种；巡
    // 检本身仍会以退出码 2 失败（loadConfig 与这里共用同一套校验）。
    deps.print(`配置：无法生效（${cfgPath}）`);
    alerts.push(`配置无法生效（巡检将以退出码 2 失败）：${cfgError.message}`);
  } else if (cfg === null) {
    deps.print('配置：缺失，运行 cron-up install 生成');
  } else {
    const actualIv = info ? info.interval : null;
    const renewTag = cfg.autoRenew ? '，自动续期开' : '，自动续期关';
    const minIdTag = cfg.autoMinId ? '，id 自动改小' : '，id 保持原样';
    const retainTag = cfg.sessionRetain === 'always'
      ? '，会话常驻' : '，会话按执行回收';
    if (actualIv === null || actualIv === undefined) {
      deps.print(`巡检：配置为每 ${cfg.intervalSeconds} 秒一轮（服务未加载），`
        + `提前 ${cfg.leadSeconds} 秒启动会话${renewTag}${minIdTag}${retainTag}`);
    } else {
      deps.print(`巡检：每 ${actualIv} 秒一轮，提前 ${cfg.leadSeconds} 秒启动`
        + `会话${renewTag}${minIdTag}${retainTag}`);
      if (actualIv !== cfg.intervalSeconds) {
        alerts.push(`launchd 实际间隔 ${actualIv} 秒与配置 ${cfg.intervalSeconds} `
          + '秒不一致，重新运行 cron-up install 后生效');
      }
    }
    const suffix = `（深度 ${cfg.maxDepth}）`;
    const rootsText = cfg.roots.join('、');
    const prefix = '扫描：';
    deps.print(prefix
      + clip(rootsText, cols - dispWidth(prefix) - dispWidth(suffix))
      + suffix);
    // 心跳回答「巡检最近真的在跑吗」：launchd 已加载但启动脚本运行期失
    // 效时，静态健康检查（launcherHealth）全绿而轮次早已停摆，只有沉默的
    // 心跳能戳穿。服务未加载（info 为 null）时不告警，服务行已说明未安装。
    if (heartbeat) {
      deps.print(`上次巡检：${elapsedZh(curOv - heartbeat.ranAt)}前`);
      if (info && heartbeatStale(heartbeat, cfg.intervalSeconds, curOv)) {
        alerts.push(`巡检已沉默 ${elapsedZh(curOv - heartbeat.ranAt)}：launchd `
          + `显示服务已加载（配置每 ${cfg.intervalSeconds} 秒一轮），但最近没有`
          + '成功跑完的轮次，启动链可能已失效；请运行 cron-up logs 查看巡检'
          + '日志，必要时重跑 cron-up install');
      }
    }
    alerts.push(...validateConfig(cfg));
    deps.print('');
    const [taskAlerts, cooled, found] = overviewTasks(cfg, cols, consumers, state);
    alerts.push(...taskAlerts);
    for (const w of cooled) coolingWarned.add(w);
    discovered = found;
  }

  // 会话状态来自 state.json，与配置无关：未安装/配置损坏时也可能有残留保
  // 活会话，照常展示。
  alerts.push(...overviewSessions(cols, state, coolingWarned, discovered));

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
