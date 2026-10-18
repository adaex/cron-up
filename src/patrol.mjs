// 一轮巡检：发现工作区 → 自动维护任务文件（续期/改 id/盖印）→ 保证每个
// 「创建者会话已死且处于预热窗口」的任务都有一个只属于它的健康会话。
// 这是 launchd 的入口（每 N 秒被拉起一次，跑完即退）。本轮新拉起的会话
// 在所有工作区决策完后轮内等待登记（至多 WARMUP_WAIT_MS），认亲同一轮
// 补盖归属印；等不到的留给跨轮宽限，绝不当轮判死。状态机还覆盖：卡死
// 退休、失败冷却、执行完回收、resume 接管脱离、孤儿认领、任务消失回收、
// 旧版目录级 state 迁移。

import fs from 'node:fs';
import path from 'node:path';

import { deps, packageVersion } from './internals.mjs';
import {
  FAIL_LIMIT,
  COOLDOWN_SECONDS,
  FAIL_TTL_SECONDS,
  WARMUP_GRACE_SECONDS,
  WARMUP_WAIT_MS,
  WARMUP_POLL_MS,
  SESSION_RECYCLE_IDLE_SECONDS,
  SESSION_RECYCLE_MARGIN_SECONDS,
  PATROL_LOG_ROTATE_BYTES,
  HEARTBEAT_STALE_FACTOR,
  INTERVAL_SECONDS,
  LEAD_SECONDS,
} from './constants.mjs';
import {
  loadConfig,
  loadState,
  loadLegacyEntries,
  saveState,
  loadHeartbeat,
  saveHeartbeat,
  heartbeatStale,
  isCooling,
} from './config.mjs';
import {
  maintainWorkspace,
  TaskFileChanged,
  taskFileExists,
  taskKey,
  taskSig,
} from './tasks.mjs';
import { taskWanted, parseCronOrNone, wantedNow } from './cron.mjs';
import {
  sessionLogPath,
  sessionLogIdleSeconds,
  scriptProcLogPath,
  isTaskSessionLogName,
  rotateOnce,
} from './sessions.mjs';
import { TASK_REL } from './paths.mjs';
import { elapsedZh, pad2 } from './display.mjs';

// 事件类型 → 轮末汇总里的中文标签。平静轮也会打出「本轮无动作」。
const EVENT_LABELS = [
  ['spawn', '启动'],
  ['recycle', '回收'],
  ['exit', '自行退出'],
  ['stuck', '卡死退休'],
  ['adopt', '接管'],
  ['reown', '过户'],
  ['fail', '启动失败'],
  ['cool', '进入冷却'],
  ['warn', '告警'],
  ['error', '错误'],
];

function bump(stats, kind) {
  if (stats) stats[kind] = (stats[kind] ?? 0) + 1;
}

export function log(msg) {
  const d = new Date();
  deps.print(
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${msg}`,
  );
}

// ---- 巡检互斥锁 ----
// flock 的替代：O_EXCL 创建 + 持锁 pid。内核不会在持有者死亡时自动释放
// 这种锁，所以抢锁失败要读 pid 判活，死锁/半成品文件按 stale 清理后有
// 限重试。对 300 秒一轮的单机 launchd，残余的 pid 复用窗口最坏只跳过一
// 轮，可接受。

function tryCreateLock(lockPath) {
  try {
    return fs.openSync(lockPath, 'wx', 0o600);
  } catch (e) {
    if (e.code === 'EEXIST') return null;
    throw e;
  }
}

function readLockPid(lockPath) {
  let text;
  try {
    text = fs.readFileSync(lockPath, 'utf-8').trim();
  } catch {
    return null;
  }
  return /^\d+$/.test(text) ? parseInt(text, 10) : null;
}

export function acquireRunLock() {
  fs.mkdirSync(deps.paths.dataDir, { recursive: true });
  const lockPath = path.join(deps.paths.dataDir, 'run.lock');
  for (let attempt = 0; attempt < 3; attempt++) {
    const fd = tryCreateLock(lockPath);
    if (fd !== null) {
      try {
        fs.writeFileSync(fd, `${process.pid}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return { lockPath };
    }
    const holder = readLockPid(lockPath);
    if (holder !== null) {
      let live = false;
      try {
        process.kill(holder, 0);
        live = true;
      } catch (e) {
        // EPERM：进程存在但不是我们的——当作活锁，不删别人的锁。
        live = e.code === 'EPERM';
      }
      if (live) return null;
    }
    // 持有者已死 / 空文件 / pid 损坏：当作 stale 清掉重试。
    try {
      fs.unlinkSync(lockPath);
    } catch {
      return null; // 别人抢先重建了锁
    }
  }
  return null;
}

function releaseLock(handle) {
  if (!handle?.lockPath) return;
  try {
    fs.unlinkSync(handle.lockPath);
  } catch {
    // 锁文件已不在即达成目的。
  }
}

// ---- 日志轮转 ----

export function rotatePatrolLogs() {
  // launchd 按路径每次重开文件，轮初改名是安全的：本轮 fd 继续写改名后
  // 的 inode，下轮打开新文件。超阈值才轮转，与会话日志的「无条件保留一
  // 代」共用 rotateOnce 的 rm+rename 顺序。
  for (const name of ['launchd.out.log', 'launchd.err.log']) {
    const file = path.join(deps.paths.logDir, name);
    try {
      if (fs.existsSync(file)
          && fs.statSync(file).size > PATROL_LOG_ROTATE_BYTES) {
        rotateOnce(file);
      }
    } catch {
      // 轮转失败不阻断巡检。
    }
  }
}

// 该任务下次「需要会话在场」的时刻（ms）：现在已在窗口（落点尾窗、一次
// 性错过待补）视为立刻需要；窗口外取 cron 裸落点（周期任务投递晚于落
// 点，按落点算余量更小、回收更保守；一次性网格落点反而提前至多 90 秒投
// 递，这段提前量由回收余量 SESSION_FIRE_MARGIN_SECONDS 罩住）。cron
// 无效返回 Infinity，永不回收。
function taskNeedMs(task, now) {
  const cron = parseCronOrNone(task?.cron);
  if (cron === null) return Infinity;
  if (wantedNow(cron, task, now)) return now.getTime();
  return cron.nextAfter(now)?.getTime() ?? Infinity;
}

// 一个预热 entry 是否已认到登记里的活 claude 会话。
function entryClaimed(ent) {
  return Boolean(ent?.sessionId && ent.claudeProcStart);
}

// 沿登记快照把一个活 script pid 认成登记里的 claude 孙进程：认到则回填
// 身份、清零失败计数并返回登记详情，否则返回 null。轮初认亲与轮内等待
// 认亲共用这唯一一份回填。
function claimEntry(ent, details, ws) {
  const d = deps.claimWarm(details, ws, ent.pid);
  if (!d) return null;
  ent.fails = 0;
  if (d.sessionId && d.procStart) {
    ent.claudePid = d.pid;
    ent.sessionId = d.sessionId;
    ent.claudeProcStart = d.procStart;
  }
  return d;
}

// 盖印目标三字段（tasks.mjs maintainWorkspace reown 映射的值形状）。
const reownTarget = (ent) => ({
  sessionId: ent.sessionId,
  pid: ent.claudePid,
  procStart: ent.claudeProcStart,
});

// 同 sig 的归属仲裁：先到先入；同 sig 被不同会话认亲（同毫秒连建的重复
// 任务）则双双撤出、都不盖。
function mergeStamp(stamps, conflicts, sig, target) {
  const prev = stamps.get(sig);
  if (prev) {
    if (prev.sessionId !== target.sessionId) {
      conflicts.add(sig);
      stamps.delete(sig);
    }
  } else if (!conflicts.has(sig)) {
    stamps.set(sig, target);
  }
}

// 过户后的统一计数与日志（巡逻第三步与等待期补盖共用）。
function noteReowned(ws, count, stats) {
  bump(stats, 'reown');
  deps.log(`已过户 ${ws}：${count} 个窗口内任务的归属改到各自的`
    + '预热会话，这些任务将只在对应会话触发');
}

// 失败顶限时的统一冷却迁移：置冷却截止、计数、日志。cooldownUntil 之外
// 的条目形状由各调用点按自身语境构造。
function enterCooldown(ent, ws, key, fails, cur, stats) {
  ent.cooldownUntil = cur + COOLDOWN_SECONDS;
  bump(stats, 'cool');
  deps.log(`冷却 ${ws} 任务 ${key}：仍有任务需要会话，但预热连续失败 `
    + `${fails} 次，暂停重试 ${COOLDOWN_SECONDS / 60} 分钟`);
}

// 保证一个工作区里每个死主窗口任务都有专属预热，并完成本文件的续期/改
// id/盖印维护。bucket 是 state[ws]（原地修改）。scriptProcsRef 是全轮共
// 享的进程表快照容器（{value: 数组|null}），只在孤儿认领时拍一次。
// 返回 pending：本轮新纳入跟踪、尚未认亲的活 script（新 spawn 与孤儿认
// 领）的 {ws,key,pid} 列表，cmdRun 据此轮内等待认亲并补盖印。
export async function patrolWorkspace(
  ws, bucket, taskfile, now, leadMs, cur, details, scriptProcsRef, stats,
) {
  const pending = [];
  const tasks = deps.readTasks(ws);
  const note = (kind, msg) => {
    bump(stats, kind);
    deps.log(msg);
  };
  const liveSids = deps.liveSessionIds(details, ws);

  if (tasks === null) {
    // 任务文件读不出：证据太弱，绝不动会话；但不能不吭声——文件还在却读
    // 不出意味着这个目录的定时任务一个都不会执行。文件已消失则是正常竞
    // 态（一次性任务执行完被删），不报。
    if (taskFileExists(ws)) {
      note('warn', `任务文件读不出 ${ws}：格式损坏或不可读，本轮跳过该目录，`
        + `其中 ${TASK_REL} 里的定时任务都不会执行`);
    }
    return [];
  }

  const stopEntry = async (ent, kind, msg) => {
    await deps.stopSession(ent);
    note(kind, msg);
  };

  if (tasks.length === 0) {
    // 文件完好但任务清空：一次性任务触发后被删、周期任务过期、或用户手
    // 删。我们为这些任务拉起的会话没理由继续留着；detached（用户 resume
    // 接管）的 stop 是 no-op，条目照删——sid 没了任务也没了，无需再管。
    for (const [key, ent] of Object.entries(bucket)) {
      if (deps.trackedAlive(ent)) {
        await stopEntry(ent, 'recycle',
          `回收 ${ws} 任务 ${key} pid=${ent.pid}：任务已全部清空，结束预热会话`);
      }
      delete bucket[key];
    }
    return [];
  }

  // 第零步：id 改键的崩溃窗口治愈。任务文件里旧键已不存在（上轮 minify
  // 改小了 id、state 却没来得及存盘），而内容签名唯一匹配某个当前任务、
  // 目标键又无主：先把条目挪到新键，让下面的决策把它当作连续的一代——
  // 否则会按「旧任务删除 + 新任务」错杀活会话再重拉一个。必须在逐任务
  // 决策之前做，spawn 才不会抢先占掉目标键。
  let sigToKeys = new Map();
  let currentKeys = new Set();
  for (const t of tasks) {
    const k = taskKey(t);
    currentKeys.add(k);
    const list0 = sigToKeys.get(taskSig(t)) ?? [];
    list0.push(k);
    sigToKeys.set(taskSig(t), list0);
  }
  for (const [key, ent] of Object.entries({ ...bucket })) {
    if (currentKeys.has(key) || !ent.sig) continue;
    const candidates = sigToKeys.get(ent.sig) ?? [];
    if (candidates.length === 1 && !bucket[candidates[0]]) {
      bucket[candidates[0]] = { ...ent, taskId: candidates[0] };
      delete bucket[key];
    }
  }

  // 第一步：认亲。认到 = 最强健康证据，当场回填身份、清零失败计数。本
  // 轮新 spawn 的不在快照里，认亲由 cmdRun 的轮内等待补做；其余条目认
  // 不到下轮再认，不阻断任何决策。
  for (const ent of Object.values(bucket)) {
    if (deps.trackedAlive(ent)) claimEntry(ent, details, ws);
  }

  // 第二步：逐任务决策。stamps 收本轮要盖的归属印（sig → 预热身份），
  // 第三步合并进同一次原子写。stampConflicts 记「同内容签名被多个预热
  // 声称」的病态任务（同毫秒连建的重复任务）：一律不盖，交回调度锁原
  // 生规则，避免错盖后没拿到任务的预热永不满足回收条件而空转泄漏。
  const stamps = new Map();
  const stampConflicts = new Set();
  for (const t of tasks) {
    const key = taskKey(t);
    const sig = taskSig(t);
    let ent = bucket[key] ?? null;
    const logPath = sessionLogPath(ws, key);
    const ownerIsOurs = entryClaimed(ent)
      && typeof t.createdBySessionId === 'string'
      && t.createdBySessionId === ent.sessionId;

    // (a) 任务的创建者会话还开着：最高优先级，任务铁定投进它，我们不预
    // 热、不盖印。ownerIsOurs 除外（归属本就是我们这代预热，sid 在活集
    // 合里是理所当然）。若此前已为它拉过预热，结束多余的那条：未认亲超
    // 宽限是卡垃圾，已认亲则是归属被外部改回活创建者，两者都不计失败。
    if (!ownerIsOurs && deps.creatorSessionAlive(t, liveSids)) {
      if (ent && deps.trackedAlive(ent)
          && cur - (ent.startedAt ?? cur) > WARMUP_GRACE_SECONDS
          && !entryClaimed(ent)) {
        await stopEntry(ent, 'stuck', `卡死 ${ws} 任务 ${key} pid=${ent.pid}：`
          + '进程已存活仍未登记会话，已终止；任务的创建者会话仍在场可承接，'
          + '不另拉预热');
        delete bucket[key];
      } else if (ent && deps.trackedAlive(ent) && entryClaimed(ent)) {
        await stopEntry(ent, 'recycle', `回收 ${ws} 任务 ${key} pid=${ent.pid}：`
          + '任务创建者会话已在场，结束多余的预热会话');
        delete bucket[key];
      }
      continue;
    }

    // (b) 用户在终端 --resume 接管：script 层已死，但同一 sessionId 的
    // 裸 claude 还活着。冻结条目：不重拉（双开）、不计数、不碰用户进
    // 程；sid 消失后再按死主任务正常重拉。
    if (ent && !deps.trackedAlive(ent)
        && typeof ent.sessionId === 'string'
        && liveSids.has(ent.sessionId)) {
      if (!ent.notified) {
        ent.notified = true;
        deps.log(`接管脱离 ${ws} 任务 ${key}：预热会话已在终端被 --resume `
          + '打开（sessionId 仍存活），停止管理它，不再另拉预热；该会话关闭'
          + '后巡检会重新拉起');
      }
      continue;
    }

    // (c) window 回收：不要求任务此刻在窗口内——恰恰是执行完、已离开窗
    // 口的会话要被收掉。三条件缺一不可：本任务在本代执行过（lastFiredAt
    // 晚于 startedAt——区分「执行完的空闲」与「等触发的空闲」，后者是预
    // 热缓存在干活）、本任务日志静默超时、距本任务下次需要还有一个巡检
    // 间隔加余量（下轮发现并 spawn、当轮等待认亲盖印；needMs 在窗口内
    // 返回 now，天然挡住「回收后立刻又需要」）。
    if (ent && deps.trackedAlive(ent) && entryClaimed(ent)
        && typeof t.lastFiredAt === 'number'
        && t.lastFiredAt > (ent.startedAt ?? 0) * 1000
        && sessionLogIdleSeconds(ent.log || logPath, cur)
          > SESSION_RECYCLE_IDLE_SECONDS
        && taskNeedMs(t, now) - now.getTime()
          > SESSION_RECYCLE_MARGIN_SECONDS * 1000) {
      await stopEntry(ent, 'recycle',
        `回收 ${ws} 任务 ${key} pid=${ent.pid}：本任务已执行完毕且界面静默，`
        + '结束会话，下次窗口重新预热');
      delete bucket[key];
      continue;
    }

    // 此后只服务「死主 + 在预热窗口内」的任务。
    if (!taskWanted(t, now, leadMs)) continue;

    // (d) 卡死退休：script 活着、超登记宽限仍未认亲——停在信任/授权提
    // 问界面的垃圾进程。杀掉后继续走失败计数/冷却/重拉。
    if (ent && deps.trackedAlive(ent) && !entryClaimed(ent)
        && cur - (ent.startedAt ?? cur) > WARMUP_GRACE_SECONDS) {
      await stopEntry(ent, 'stuck', `卡死 ${ws} 任务 ${key} pid=${ent.pid}：`
        + '进程已存活仍未登记会话，已终止'
        + `（排查：cron-up logs ${path.basename(ws)}--${key}）`);
    }

    // (e) resume 接管结束：sid 已从登记消失。整代身份作废（script 已
    // 死、认亲信息失效），fails 清零（用户使用期间的退出不算我们的启动
    // 失败），作为全新一条落入下面的重拉。
    if (ent && !deps.trackedAlive(ent)
        && typeof ent.sessionId === 'string'
        && !liveSids.has(ent.sessionId)) {
      ent.pid = null;
      delete ent.procStart;
      delete ent.claudePid;
      delete ent.sessionId;
      delete ent.claudeProcStart;
      delete ent.notified;
      ent.fails = 0;
    }

    // 盖印（跨轮老条目）：已认亲且任务归属还没盖到本代预热（活创建者
    // 已在 (a) 排除）。当轮新 spawn 的会话在第三步之后的轮内等待里认
    // 亲，由 cmdRun 的 stampClaimed 补盖，不走这里。
    if (entryClaimed(ent)
        && (!t.createdBySessionId || t.createdBySessionId !== ent.sessionId)) {
      mergeStamp(stamps, stampConflicts, sig, reownTarget(ent));
    }

    // warm 未到回收 / spawning 宽限内：本轮无事。
    if (ent && deps.trackedAlive(ent)) continue;

    if (isCooling(ent, cur)) continue;

    // 失败计数：冷却刚结束给一次干净缓刑；只有真拉起过（pid 非空）的条
    // 目死亡才算一次新失败，当场没拉起的尝试已在写入时计过。
    let fails;
    if (ent?.cooldownUntil) {
      fails = 0;
    } else {
      fails = (ent?.fails ?? 0) + (ent?.pid ? 1 : 0);
    }

    if (fails >= FAIL_LIMIT) {
      bucket[key] = {
        ...ent,
        ws,
        taskId: key,
        sig,
        pid: null,
        fails,
        log: ent?.log ?? logPath,
      };
      enterCooldown(bucket[key], ws, key, fails, cur, stats);
      continue;
    }

    // 孤儿认领：state 丢了但进程表里还有为本任务拉起的 script（卡在提问
    // 界面就不会出现在登记里）。按任务专属日志路径精确相认，alive 复核
    // 防把快照里刚被杀的 pid 认回来。
    if (ent === null) {
      if (scriptProcsRef.value === null) {
        scriptProcsRef.value = deps.listScriptProcesses();
      }
      const adopted = scriptProcsRef.value.find(
        ([procPid, procArgs]) =>
          scriptProcLogPath(procArgs) === logPath && deps.alive(procPid));
      if (adopted) {
        const [procPid] = adopted;
        bucket[key] = {
          ws,
          taskId: key,
          sig,
          pid: procPid,
          startedAt: cur,
          procStart: deps.procStartedAt(procPid),
          fails: 0,
          log: logPath,
        };
        note('adopt', `接管 ${ws} 任务 ${key} pid=${procPid}：state 记录缺失，`
          + '但进程表里仍有本该任务的预热会话，重新纳入跟踪');
        pending.push({ ws, key, pid: procPid });
        continue;
      }
    }

    // spawn：成败只认有没有拿到 pid。当场失败立即计入；本轮就顶满失败上
    // 限的，直接进冷却（不必再空跑一轮）。
    const spawned = deps.spawnSession(ws, key);
    if (spawned?.pid == null) {
      const newFails = fails + 1;
      if (newFails >= FAIL_LIMIT) {
        bucket[key] = {
          ws, taskId: key, sig, pid: null, fails: newFails, log: logPath,
        };
        enterCooldown(bucket[key], ws, key, newFails, cur, stats);
        continue;
      }
      bucket[key] = {
        ws,
        taskId: key,
        sig,
        pid: null,
        startedAt: cur,
        fails: newFails,
        log: logPath,
      };
      note('fail', `启动失败 ${ws} 任务 ${key}：会话进程没有拉起`
        + `（连续失败计数 ${newFails}）`);
      continue;
    }
    bucket[key] = {
      ws,
      taskId: key,
      sig,
      pid: spawned.pid,
      startedAt: cur,
      procStart: spawned.procStart,
      fails,
      log: logPath,
    };
    note('spawn', `已启动 ${ws} 任务 ${key} pid=${spawned.pid}`
      + `（连续失败计数 ${fails}）`);
    pending.push({ ws, key, pid: spawned.pid });
  }

  // 第三步：任务文件维护（续期 + 改 id + 盖印）合并为一次带乐观锁的原子
  // 写。撞车（Claude Code 刚写了 lastFiredAt/删了任务）放弃本轮老条目维
  // 护，但已 spawn 的会话仍返回给 cmdRun 等待认亲，盖印收尾会再写一次。
  let result;
  try {
    result = maintainWorkspace(taskfile, { reown: stamps });
  } catch (e) {
    if (e instanceof TaskFileChanged) {
      note('warn', `维护暂缓 ${ws}：任务文件刚被 Claude Code 改动，本轮不覆盖，`
        + '稍后重试');
      return pending;
    }
    throw e;
  }
  // 与 readTasks 不一致的极端竞态：保守不动，新 spawn 也全留跨轮路径。
  if (result === null) return [];
  if (result.renewed) {
    deps.log(`已续期 ${ws}：${result.renewed} 个周期任务标记为 permanent，`
      + '不再受 7 天过期限制');
  }
  if (result.minified) {
    deps.log(`已改小 id ${ws}：${result.minified} 个周期任务的 id 改为小哈希`
      + '值，投递延迟降到约 1 分钟内');
  }
  if (result.reowned) noteReowned(ws, result.reowned, stats);
  // id 改小同轮把 state 条目跟着改键：不改的话下轮会把换 id 的任务误判
  // 成「旧任务删除 + 新任务」，错杀刚拉起的会话再重拉一个。pending 是本
  // 轮 spawn 的返回快照，键也要跟着改，否则轮内等待按旧键找不到条目，新
  // 任务的盖印被白白推到下轮。
  for (const { from, to } of result.idChanges) {
    if (bucket[from] && !bucket[to]) {
      const movedPid = bucket[from].pid;
      bucket[to] = { ...bucket[from], taskId: to };
      delete bucket[from];
      for (const p of pending) {
        if (p.key === from && p.pid === movedPid) p.key = to;
      }
    }
  }

  // 第四步：任务消失的条目回收。第零步已做过签名治愈；这里重建当前键索
  // 引——注意内存里的 tasks 是维护前的快照，minify 改的是重新读盘的
  // doc，所以键必须经 idChanges 修正，否则刚改到新键的条目会被旧 id 视
  // 图误当成「签名可治愈的旧键」再改回去。剩下对不上的键就是真的被删
  // 了。冷却中的条目也删——任务没了，冷却没有意义。
  const renamed = new Map(result.idChanges.map((c) => [c.from, c.to]));
  sigToKeys = new Map();
  currentKeys = new Set();
  for (const t of tasks) {
    const k = renamed.get(taskKey(t)) ?? taskKey(t);
    currentKeys.add(k);
    const list = sigToKeys.get(taskSig(t)) ?? [];
    list.push(k);
    sigToKeys.set(taskSig(t), list);
  }
  for (const [key, ent] of Object.entries({ ...bucket })) {
    if (currentKeys.has(key)) continue;
    const candidates = ent.sig ? (sigToKeys.get(ent.sig) ?? []) : [];
    if (candidates.length === 1 && !bucket[candidates[0]]) {
      const to = candidates[0];
      bucket[to] = { ...ent, taskId: to };
      delete bucket[key];
      continue;
    }
    if (deps.trackedAlive(ent)) {
      await stopEntry(ent, 'recycle', `回收 ${ws} 任务 ${key} pid=${ent.pid}：`
        + '对应任务已删除，结束预热会话');
    }
    delete bucket[key];
  }
  return pending;
}

// 等待拍数是墙钟帽的派生：假时钟（测试）下墙钟不走，拍数帽单独兜底。
const MAX_WARMUP_POLLS = WARMUP_WAIT_MS / WARMUP_POLL_MS;

// 轮内等待本轮新 spawn/认领的会话完成登记，认亲走与轮初同一个
// claimEntry。这是盖印加速，不是判死：等不到的活会话原样留下，判死只
// 走跨轮 WARMUP_GRACE 路径。先扫后睡——进入时各工作区决策已串行花掉数
// 秒，健康会话可能已登记；任一 pending 认亲或死亡都移出集合，全部移出
// 即提前结束。返回最新登记快照、按 ws 分组的认亲条目（供补盖印）与等
// 待期内死亡的 pending（供退出日志；其 bucket 条目已计失败）。
async function awaitWarmups(pending, state, cur, stats) {
  const claimedByWs = new Map();
  const died = [];
  let details;
  const deadline = Date.now() + WARMUP_WAIT_MS;
  const recognize = () => {
    const rest = [];
    for (const p of pending) {
      const ent = state[p.ws]?.[p.key];
      if (!ent || ent.pid !== p.pid) continue;
      if (!deps.trackedAlive(ent)) {
        // 启动即崩的典型窗口：真拉起过却死掉，计一次失败并置空 pid，条
        // 目靠 fails 走 48 小时 TTL 保留、下轮重拉；满三次当轮进冷却。
        // 只打日志丢弃会让 fails 永远从零起，坏掉的环境每轮重拉却永不
        // 冷却。
        ent.fails = (ent.fails ?? 0) + 1;
        ent.pid = null;
        delete ent.procStart;
        if (ent.fails >= FAIL_LIMIT) {
          enterCooldown(ent, p.ws, p.key, ent.fails, cur, stats);
        }
        died.push(p);
        continue;
      }
      if (claimEntry(ent, details, p.ws)) {
        if (!claimedByWs.has(p.ws)) claimedByWs.set(p.ws, []);
        claimedByWs.get(p.ws).push(ent);
      } else {
        rest.push(p);
      }
    }
    pending = rest;
  };
  // 轮初快照拍于决策之前、spawn 尚未发生，认亲必然落空；进入先重扫一
  // 拍再开始睡。之后睡一拍、扫一拍。
  [, , details] = await deps.scanSessions();
  recognize();
  for (let polls = 0;
    pending.length > 0 && polls < MAX_WARMUP_POLLS && Date.now() < deadline;
    polls += 1) {
    await deps.sleep(WARMUP_POLL_MS);
    [, , details] = await deps.scanSessions();
    recognize();
  }
  return { details, claimedByWs, died };
}

// 等待期认到亲的会话补盖归属印：claimedByWs 的每个 ent 已是 bucket 条
// 目，sig/认亲身份都在上面。无认亲的 ws 不调用、不写盘；撞 mtime 乐观
// 锁或极端竞态（result=null）跳过，下轮再来。
function stampClaimed(claimedByWs, taskfiles, stats) {
  for (const [ws, ents] of claimedByWs) {
    const stamps = new Map();
    const conflicts = new Set();
    for (const ent of ents) {
      if (entryClaimed(ent)) mergeStamp(stamps, conflicts, ent.sig, reownTarget(ent));
    }
    if (stamps.size === 0) continue;
    try {
      const result = maintainWorkspace(taskfiles.get(ws), { reown: stamps });
      if (result?.reowned) noteReowned(ws, result.reowned, stats);
    } catch (e) {
      if (e instanceof TaskFileChanged) {
        bump(stats, 'warn');
        deps.log(`盖印暂缓 ${ws}：任务文件刚被 Claude Code 改动，本轮不覆盖，`
          + '下轮再来');
        continue;
      }
      throw e;
    }
  }
}

// 升级轮：旧版目录级 state 的预热逐个结束（不迁移归属，新流程按任务重
// 拉）；state.json 已丢的旧孤儿 script（日志是旧命名，不含任务键段）从
// 进程表兜底清扫。只在 loadLegacyEntries 非空（确在跨版本）时执行。
async function retireLegacy(legacy, stats) {
  for (const ent of legacy) {
    if (deps.trackedAlive(ent)) {
      await deps.stopSession(ent);
      bump(stats, 'recycle');
      deps.log(`旧版迁移 ${ent.ws} pid=${ent.pid}：结束目录级预热会话，`
        + '升级后按任务重新预热');
    }
  }
  const handled = new Set(legacy.filter((e) => e.pid).map((e) => e.pid));
  for (const [pid, procArgs] of deps.listScriptProcesses()) {
    if (handled.has(pid)) continue;
    const file = scriptProcLogPath(procArgs);
    if (file === null) continue;
    if (path.dirname(file) !== deps.paths.sessionLogDir) continue;
    if (isTaskSessionLogName(path.basename(file))) continue; // 新一代命名
    const ent = { pid, procStart: deps.procStartedAt(pid) };
    if (!deps.trackedAlive(ent)) continue;
    await deps.stopSession(ent);
    bump(stats, 'recycle');
    deps.log(`旧版迁移 pid=${pid}：结束目录级预热孤儿会话（日志 ${file}），`
      + '升级后按任务重新预热');
  }
}

// 跑一轮巡检；抢不到锁返回 false。
export async function cmdRun(args) {
  const lock = deps.acquireRunLock();
  if (lock === null) {
    deps.log('已有一轮巡检在进行，本轮跳过');
    return false;
  }
  // 包一层 stopSession 记下本轮主动结束的 pid：轮末凭它区分「我们回收的」
  // 与「会话自行退出/被外部杀掉的」。同样包一层 procStartedAt：同一 pid
  // 的 lstart 一轮内不会变，缓存后每个 pid 只 spawn 一次 ps。finally 还
  // 原。
  const prevStopSession = deps.stopSession;
  const stoppedPids = new Set();
  deps.stopSession = async (ent) => {
    if (ent?.pid) stoppedPids.add(ent.pid);
    return prevStopSession(ent);
  };
  const prevProcStartedAt = deps.procStartedAt;
  const lstartCache = new Map();
  deps.procStartedAt = (pid) => {
    if (!lstartCache.has(pid)) lstartCache.set(pid, prevProcStartedAt(pid));
    return lstartCache.get(pid);
  };
  try {
    const startedAtMs = Date.now();
    const stats = {};
    deps.rotatePatrolLogs();
    const cfg = loadConfig(args?.config ?? deps.paths.configPath);
    const now = new Date();
    const leadMs = LEAD_SECONDS * 1000;
    const state = loadState();
    const legacy = loadLegacyEntries();
    const cur = Math.floor(Date.now() / 1000);

    // 轮首心跳：没有这两行，launchd 拉不起巡检（启动脚本失效、node 缺失）
    // 时日志会一片寂静，无法和「平安无事」区分。上轮心跳过老说明中间漏
    // 轮——休眠期间错过的 StartInterval，launchd 醒来只补跑一轮。
    const hb = loadHeartbeat();
    if (heartbeatStale(hb, INTERVAL_SECONDS, cur)) {
      bump(stats, 'warn');
      deps.log(`距上次巡检已 ${elapsedZh(cur - hb.ranAt)}，超过 `
        + `${HEARTBEAT_STALE_FACTOR} 个轮次间隔（${INTERVAL_SECONDS} 秒），`
        + '期间 launchd 可能漏轮（常见于电脑休眠）');
    }
    deps.log(`巡检开始：扫描根目录 ${cfg.roots.length} 个`);
    if (cfg.roots.length === 0) {
      bump(stats, 'warn');
      deps.log('警告：扫描目录 roots 为空，巡检不会发现任何工作区；'
        + '请检查配置文件或用 cron-up install --roots 指定');
    }

    // 登记轮初读一次（含祖先链快照）：认亲与活创建者判定都靠它。有新
    // spawn 时等待期会重扫，details 随之刷新到最新快照（轮末 kept 判定
    // 与消费者计数都用刷新后的版本）。
    let [consumers, registryAlert, details] = await deps.scanSessions();
    if (registryAlert) {
      bump(stats, 'warn');
      deps.log(`告警：${registryAlert}`);
    }

    // 旧版收尾必须先于一切 spawn 决策（state 轮末被新形状整体覆盖）。
    if (legacy.length > 0) await retireLegacy(legacy, stats);

    // 轮初把上轮末仍相信活着的条目分成三组：活、resume 脱离（script 已
    // 死但 sid 还在，不报退出）、真死（立即报）。带 deadSince 的旧报条
    // 目跳过。不能只收此刻 kill -0 成功的——两轮之间崩溃正是最典型的被
    // 动死亡。
    const prevDead = [];
    const prevAlive = [];
    const sidInDetails = (ws, sid) =>
      (details.get(ws) ?? []).some((d) => d.sessionId === sid);
    for (const [ws, bucket] of Object.entries(state)) {
      for (const [taskId, ent] of Object.entries(bucket)) {
        if (!ent.pid || ent.deadSince) continue;
        const copy = { ...ent };
        if (deps.trackedAlive(copy)) {
          prevAlive.push([ws, taskId, copy]);
        } else if (typeof ent.sessionId === 'string'
          && sidInDetails(ws, ent.sessionId)) {
          // detached：静默。
        } else {
          prevDead.push([ws, taskId, copy]);
        }
      }
    }
    const exitLine = (ws, taskId, old) => `会话退出 ${ws} 任务 ${taskId} `
      + `pid=${old.pid}：非巡检主动结束（已存活 `
      + `${elapsedZh(cur - (old.startedAt ?? cur))}），可能自行退出或被外部`
      + '终止；若反复出现请用 cron-up logs '
      + `${path.basename(ws)}--${taskId} 排查启动过程`;
    for (const [ws, taskId, old] of prevDead) {
      bump(stats, 'exit');
      deps.log(exitLine(ws, taskId, old));
    }

    let found = 0;
    const scriptProcsRef = { value: null };
    const pendingAll = [];
    const taskfiles = new Map();
    for (const [ws, taskfile] of deps.discover(cfg.roots)) {
      found += 1;
      if (!state[ws]) state[ws] = {};
      taskfiles.set(ws, taskfile);
      // 一个工作区读不动/写不动不能中断整轮：discover 是生成器，抛了会
      // 跳过后面所有工作区。
      try {
        pendingAll.push(...await patrolWorkspace(
          ws, state[ws], taskfile, now, leadMs, cur, details,
          scriptProcsRef, stats));
      } catch (e) {
        bump(stats, 'error');
        deps.log(`错误 ${ws}：${e.constructor.name}：${e.message}`);
      }
      if (Object.keys(state[ws]).length === 0) delete state[ws];
    }

    // 本轮有新会话拉起才等待：绝大多数轮次 pending 为空，零额外 ps、零睡
    // 眠。认亲后同一轮补盖归属印（否则要等下一轮，提前量就得兜两轮）。
    // 等待只认亲、不判死；等不到的下轮按 WARMUP_GRACE 跨轮处理。
    if (pendingAll.length > 0) {
      try {
        const { details: latest, claimedByWs, died } = await awaitWarmups(
          pendingAll, state, cur, stats);
        details = latest;
        consumers = new Set(details.keys());
        // 等待期内自然死亡的是本轮新 spawn 的会话，不在轮初 prevAlive 分
        // 组里，单独补一条退出日志，否则启动即崩将完全静默。死亡条目
        // fails≥1，轮末 kept 必保留，此刻仍在 bucket 里（pid 已置空，
        // 用 pending 记的 pid 补回给日志）。
        for (const d of died) {
          bump(stats, 'exit');
          deps.log(exitLine(d.ws, d.key,
            { ...state[d.ws]?.[d.key], pid: d.pid }));
        }
        stampClaimed(claimedByWs, taskfiles, stats);
      } catch (e) {
        // 等待或补盖失败不能丢轮末落盘：最坏只是盖印晚一轮，会话进程已
        // 在场，目录调度锁仍兜底。
        bump(stats, 'error');
        deps.log(`等待预热登记出错：${e.constructor.name}：${e.message}`);
      }
    }

    // 轮中死亡复核：轮初活、轮末没气、又不是本轮主动 stop 的。轮中刚被
    // --resume 接管（sid 换 pid 存活）的不报。
    for (const [ws, taskId, old] of prevAlive) {
      if (stoppedPids.has(old.pid)) continue;
      if (deps.trackedAlive(old)) continue;
      if (typeof old.sessionId === 'string'
          && deps.sessionAliveNow(old.sessionId, ws)) continue;
      bump(stats, 'exit');
      deps.log(exitLine(ws, taskId, old));
    }

    // kept 过滤（嵌套）：活会话、resume 脱离（sid 仍在登记）、冷却中、
    // 带失败计数的死条目（计数跨任务窗口累积，48 小时 TTL 老化）保留；
    // 其余丢掉。首次发现死亡打 deadSince。
    const kept = {};
    for (const [ws, bucket] of Object.entries(state)) {
      const out = {};
      for (const [taskId, ent] of Object.entries(bucket)) {
        if (deps.trackedAlive(ent)) {
          out[taskId] = ent;
          continue;
        }
        if (typeof ent.sessionId === 'string'
            && sidInDetails(ws, ent.sessionId)) {
          out[taskId] = ent;
          continue;
        }
        if (isCooling(ent, cur)) {
          out[taskId] = ent;
          continue;
        }
        if ((ent.fails ?? 0) > 0) {
          ent.deadSince ??= cur;
          if (cur - ent.deadSince < FAIL_TTL_SECONDS) out[taskId] = ent;
        }
      }
      if (Object.keys(out).length > 0) kept[ws] = out;
    }
    saveState(kept);

    // 轮末汇总：一行交代这轮看见了什么、动了什么、花了多久，随后更新心跳。
    const actions = EVENT_LABELS
      .filter(([kind]) => stats[kind])
      .map(([kind, label]) => `${label} ${stats[kind]}`)
      .join('、');
    const durationMs = Date.now() - startedAtMs;
    const durationZh = durationMs < 1000
      ? `${durationMs} 毫秒` : `${(durationMs / 1000).toFixed(1)} 秒`;
    deps.log(`巡检结束：发现 ${found} 个工作区，活动交互会话 ${consumers.size} `
      + `个；本轮${actions || '无动作'}，耗时 ${durationZh}`);
    saveHeartbeat({
      ranAt: cur,
      version: packageVersion(),
      intervalSeconds: INTERVAL_SECONDS,
      durationMs,
      events: stats,
    });
    return true;
  } finally {
    deps.stopSession = prevStopSession;
    deps.procStartedAt = prevProcStartedAt;
    releaseLock(lock);
  }
}

Object.assign(deps, {
  log,
  runPatrol: cmdRun,
  rotatePatrolLogs,
  acquireRunLock,
});
