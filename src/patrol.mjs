// 一轮巡检：发现工作区 → 自动维护任务文件（续期/盖印）→ 保证每个
// 「创建者会话已死且处于预热窗口」的任务都有一个只属于它的健康会话。
// 这是 launchd 的入口（每 N 秒被拉起一次，跑完即退）。本轮新拉起的会话
// 在所有工作区决策完后轮内等待登记（至多 WARMUP_WAIT_MS），认亲同一轮
// 补盖归属印；等不到的留给跨轮宽限，绝不当轮判死。状态机还覆盖：卡死
// 退休、失败冷却、执行完回收、resume 接管脱离、孤儿认领、任务消失回收、
// 旧版目录级 state 迁移。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  deps,
  packageVersion,
  isPlainObject,
  getOwn,
  setOwn,
} from './internals.mjs';
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
  parsePid,
} from './config.mjs';
import {
  maintainWorkspace,
  TaskFileChanged,
  taskFileExists,
  groupTasksByKey,
  taskOwnedBy,
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
// flock 的替代：O_EXCL 创建 + 完整 JSON 锁记录。token 防止释放/清理时误删
// 已被别人替换的文件，pid + 进程启动指纹区分 pid 复用。创建后写记录有极短
// 空窗，所以无效/空文件要等初始化宽限过后才能按 stale 清理。

const RUN_LOCK_INIT_GRACE_MS = 10_000;

function tryCreateLock(lockPath) {
  try {
    return fs.openSync(lockPath, 'wx', 0o600);
  } catch (e) {
    if (e.code === 'EEXIST') return null;
    throw e;
  }
}

// 文本与 stat 一起作为删除前的比对快照：除了内容，inode/mtime 也能识别
// 「删掉旧锁后又恰好建了同样内容的新锁」。
function readLockSnapshot(lockPath) {
  try {
    return {
      text: fs.readFileSync(lockPath, 'utf-8'),
      stat: fs.statSync(lockPath, { bigint: true }),
    };
  } catch {
    return null;
  }
}

function parseLockRecord(snapshot) {
  let record;
  try {
    record = JSON.parse(snapshot.text);
  } catch {
    return null;
  }
  if (!isPlainObject(record)
      || !Number.isSafeInteger(record.pid) || record.pid <= 0
      || typeof record.token !== 'string' || record.token === '') {
    return null;
  }
  return record;
}

function sameLockSnapshot(a, b) {
  return a.text === b.text
    && a.stat.ino === b.stat.ino
    && a.stat.mtimeNs === b.stat.mtimeNs
    && a.stat.size === b.stat.size;
}

// 只能删除读取时看到的那个文件。比对失败说明别人释放/重建过，宁可本轮不
// 抢锁，也绝不能把新持有者的锁 unlink 掉。
function removeLockSnapshot(lockPath, snapshot) {
  const latest = readLockSnapshot(lockPath);
  if (latest === null || !sameLockSnapshot(snapshot, latest)) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function staleLock(snapshot) {
  const record = parseLockRecord(snapshot);
  if (record === null) {
    // 旧版锁只有十进制 pid。升级交错时它可能仍属于活巡检；没有指纹可核，
    // 因此活着就保守保留，明确死亡才允许清理。
    const legacyPid = parsePid(snapshot.text);
    if (legacyPid !== null) {
      try {
        return !deps.alive(legacyPid);
      } catch {
        return false;
      }
    }
    // 包含 O_EXCL 成功后、JSON 写完前的空文件。mtime 新于宽限的一律保留。
    return Date.now() - Number(snapshot.stat.mtimeMs) >= RUN_LOCK_INIT_GRACE_MS;
  }
  let living;
  try {
    living = deps.alive(record.pid);
  } catch {
    return false; // 活判读不出时保守保留。
  }
  if (!living) return true;
  // 活 pid 但缺记录指纹，或当前指纹读不出：都无法排除锁主仍在，不能删。
  if (typeof record.procStart !== 'string' || record.procStart === '') return false;
  let currentStart;
  try {
    currentStart = deps.procStartedAt(record.pid);
  } catch {
    return false;
  }
  if (!currentStart) return false;
  return currentStart !== record.procStart;
}

export function acquireRunLock() {
  fs.mkdirSync(deps.paths.dataDir, { recursive: true });
  const lockPath = path.join(deps.paths.dataDir, 'run.lock');
  let procStart;
  try {
    procStart = deps.procStartedAt(process.pid);
  } catch (e) {
    throw new Error('读取当前进程启动指纹失败，不能安全创建巡检锁：'
      + `${e?.message ?? e}`);
  }
  // 无指纹锁一旦被崩溃留下，pid 复用时永远无法安全清理；宁可本轮响亮
  // 失败，也不制造这种永久自锁。
  if (!procStart) {
    throw new Error('未读到当前进程启动指纹，不能安全创建巡检锁；'
      + '请检查 /bin/ps 后重试');
  }
  const token = randomUUID();
  const text = `${JSON.stringify({
    pid: process.pid,
    procStart,
    token,
  })}\n`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const fd = tryCreateLock(lockPath);
    if (fd !== null) {
      try {
        fs.writeFileSync(fd, text);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return { lockPath, token };
    }
    const snapshot = readLockSnapshot(lockPath);
    if (snapshot === null) continue; // 持有者恰好释放，直接重试创建。
    if (!staleLock(snapshot)) return null;
    if (!removeLockSnapshot(lockPath, snapshot)) return null;
  }
  return null;
}

export function releaseRunLock(handle) {
  if (!handle?.lockPath || typeof handle.token !== 'string') return;
  const snapshot = readLockSnapshot(handle.lockPath);
  if (snapshot === null) return;
  const record = parseLockRecord(snapshot);
  if (record?.token !== handle.token) return;
  removeLockSnapshot(handle.lockPath, snapshot);
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

// 保证一个工作区里每个死主窗口任务都有专属预热，并完成本文件的续期/盖印
// 维护。bucket 是 state[ws]（原地修改）。scriptProcsRef 是全轮共享的进程表
// 快照容器（{value: 数组|null}），只在孤儿认领时拍一次。
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

  // false 是 stopSession 的「活进程未能安全停止」：不能记回收、删 state
  // 或继续重拉。生产与测试桩都返回严格布尔值。
  const stopEntry = async (ent, key, kind, msg) => {
    const stopped = await deps.stopSession(ent);
    if (!stopped) {
      note('warn', `无法安全停止 ${ws} 任务 ${key} pid=${ent.pid}：`
        + '记录的进程仍存活；保留跟踪，本轮不删除条目也不另拉会话');
      return false;
    }
    note(kind, msg);
    return true;
  };

  if (tasks.length === 0) {
    // 文件完好但任务清空：一次性任务触发后被删、周期任务过期、或用户手
    // 删。我们为这些任务拉起的会话没理由继续留着；detached（用户 resume
    // 接管）的 stop 是 no-op，条目照删——sid 没了任务也没了，无需再管。
    for (const [key, ent] of Object.entries(bucket)) {
      if (deps.trackedAlive(ent)) {
        const stopped = await stopEntry(ent, key, 'recycle',
          `回收 ${ws} 任务 ${key} pid=${ent.pid}：任务已全部清空，结束预热会话`);
        if (!stopped) continue;
      }
      delete bucket[key];
    }
    return [];
  }

  // 与任务文件层共用一份按键分组视图。重复键对应多条任务时，state 与
  // 会话都无法唯一对应到条目：跳过这些组并告警，maintainWorkspace 也只
  // 处理单元素组。组的键集合同时就是后面的 currentKeys。
  const taskGroups = groupTasksByKey(tasks);
  for (const [key, group] of taskGroups) {
    if (group.length < 2) continue;
    note('warn', `任务键重复 ${ws}：${key} 对应 ${group.length} 条任务，`
      + '无法区分各自会话，本轮跳过这些条目的预热与盖印');
  }

  // 第一步：认亲。认到 = 最强健康证据，当场回填身份、清零失败计数。本
  // 轮新 spawn 的不在快照里，认亲由 cmdRun 的轮内等待补做；其余条目认
  // 不到下轮再认，不阻断任何决策。
  for (const ent of Object.values(bucket)) {
    if (deps.trackedAlive(ent)) claimEntry(ent, details, ws);
  }

  // 第二步：逐任务决策。stamps 收本轮要盖的归属印（taskKey → 预热身份），
  // 第三步合并进同一次原子写。内容相同但 id 不同的任务各有自己的键；重复
  // 键组直接跳过，不在循环内另建一套重复键索引。
  const stamps = new Map();
  for (const [key, group] of taskGroups) {
    if (group.length !== 1) continue;
    const t = group[0];
    let ent = getOwn(bucket, key) ?? null;
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
        const stopped = await stopEntry(ent, key, 'stuck',
          `卡死 ${ws} 任务 ${key} pid=${ent.pid}：`
          + '进程已存活仍未登记会话，已终止；任务的创建者会话仍在场可承接，'
          + '不另拉预热');
        if (stopped) delete bucket[key];
      } else if (ent && deps.trackedAlive(ent) && entryClaimed(ent)) {
        const stopped = await stopEntry(ent, key, 'recycle',
          `回收 ${ws} 任务 ${key} pid=${ent.pid}：`
          + '任务创建者会话已在场，结束多余的预热会话');
        if (stopped) delete bucket[key];
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
      const stopped = await stopEntry(ent, key, 'recycle',
        `回收 ${ws} 任务 ${key} pid=${ent.pid}：本任务已执行完毕且界面静默，`
        + '结束会话，下次窗口重新预热');
      if (stopped) delete bucket[key];
      continue;
    }

    // 此后只服务「死主 + 在预热窗口内」的任务。
    if (!taskWanted(t, now, leadMs)) continue;

    // (d) 卡死退休：script 活着、超登记宽限仍未认亲——停在信任/授权提
    // 问界面的垃圾进程。杀掉后继续走失败计数/冷却/重拉。
    if (ent && deps.trackedAlive(ent) && !entryClaimed(ent)
        && cur - (ent.startedAt ?? cur) > WARMUP_GRACE_SECONDS) {
      const stopped = await stopEntry(ent, key, 'stuck',
        `卡死 ${ws} 任务 ${key} pid=${ent.pid}：`
        + '进程已存活仍未登记会话，已终止'
        + `（排查：cron-up logs ${path.basename(ws)}--${key}）`);
      if (!stopped) continue;
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
    if (entryClaimed(ent)) {
      const target = reownTarget(ent);
      if (!taskOwnedBy(t, target)) stamps.set(key, target);
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
      const next = setOwn(bucket, key, {
        ...ent,
        ws,
        taskId: key,
        pid: null,
        fails,
        log: ent?.log ?? logPath,
      });
      enterCooldown(next, ws, key, fails, cur, stats);
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
        setOwn(bucket, key, {
          ws,
          taskId: key,
          pid: procPid,
          startedAt: cur,
          procStart: deps.procStartedAt(procPid),
          fails: 0,
          log: logPath,
        });
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
        const next = setOwn(bucket, key, {
          ws, taskId: key, pid: null, fails: newFails, log: logPath,
        });
        enterCooldown(next, ws, key, newFails, cur, stats);
        continue;
      }
      setOwn(bucket, key, {
        ws,
        taskId: key,
        pid: null,
        startedAt: cur,
        fails: newFails,
        log: logPath,
      });
      note('fail', `启动失败 ${ws} 任务 ${key}：会话进程没有拉起`
        + `（连续失败计数 ${newFails}）`);
      continue;
    }
    setOwn(bucket, key, {
      ws,
      taskId: key,
      pid: spawned.pid,
      startedAt: cur,
      procStart: spawned.procStart,
      fails,
      log: logPath,
    });
    note('spawn', `已启动 ${ws} 任务 ${key} pid=${spawned.pid}`
      + `（连续失败计数 ${fails}）`);
    pending.push({ ws, key, pid: spawned.pid });
  }

  // 第三步：任务文件维护（续期 + 盖印）合并为一次带 mtime 乐观检测的原子写。
  // 撞车（Claude Code 刚写了 lastFiredAt/删了任务）放弃本轮老条目维护，但已
  // spawn 的会话仍返回给 cmdRun 等待认亲，盖印收尾会再写一次。
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
  // 与 readTasks 不一致的极端竞态：维护保守不动，但本轮新 spawn 仍要进入
  // 等待认亲与补盖流程；丢掉 pending 会把同轮收尾无故推迟到下一轮。
  if (result === null) return pending;
  if (result.renewed) {
    deps.log(`已续期 ${ws}：${result.renewed} 个周期任务标记为 permanent，`
      + '不再受 7 天过期限制');
  }
  if (result.reowned) noteReowned(ws, result.reowned, stats);

  // 第四步：任务消失的条目回收。续期与盖印都不改任务键，分组视图的键集合
  // 仍是准确的 currentKeys。冷却中的条目也删——任务没了，冷却没有意义；
  // 停止失败则保留可跟踪条目，下轮继续尝试，绝不错删后遗留活会话。
  for (const [key, ent] of Object.entries({ ...bucket })) {
    if (taskGroups.has(key)) continue;
    if (deps.trackedAlive(ent)) {
      const stopped = await stopEntry(ent, key, 'recycle',
        `回收 ${ws} 任务 ${key} pid=${ent.pid}：对应任务已删除，结束预热会话`);
      if (!stopped) continue;
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
      const ent = getOwn(state[p.ws], p.key);
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
// 目，taskId 与认亲身份都在上面。无认亲的 ws 不调用、不写盘；撞 mtime 乐
// 观锁或极端竞态（result=null）跳过，下轮再来。
function stampClaimed(claimedByWs, taskfiles, stats) {
  for (const [ws, ents] of claimedByWs) {
    const stamps = new Map();
    for (const ent of ents) {
      if (entryClaimed(ent)) stamps.set(ent.taskId, reownTarget(ent));
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
  let retired = true;
  for (const ent of legacy) {
    if (deps.trackedAlive(ent)) {
      const stopped = await deps.stopSession(ent);
      if (!stopped) {
        retired = false;
        bump(stats, 'warn');
        deps.log(`旧版迁移暂缓 ${ent.ws} pid=${ent.pid}：记录的进程仍存活，`
          + '本次无法安全停止目录级预热会话；本次不记为已回收');
      } else {
        bump(stats, 'recycle');
        deps.log(`旧版迁移 ${ent.ws} pid=${ent.pid}：结束目录级预热会话，`
          + '升级后按任务重新预热');
      }
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
    const stopped = await deps.stopSession(ent);
    if (!stopped) {
      retired = false;
      bump(stats, 'warn');
      deps.log(`旧版迁移暂缓 pid=${pid}：记录的进程仍存活，本次无法安全停止`
        + `目录级预热孤儿会话（日志 ${file}）；本次不记为已回收`);
    } else {
      bump(stats, 'recycle');
      deps.log(`旧版迁移 pid=${pid}：结束目录级预热孤儿会话（日志 ${file}），`
        + '升级后按任务重新预热');
    }
  }
  return retired;
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
    const stopped = await prevStopSession(ent);
    if (stopped && ent?.pid) stoppedPids.add(ent.pid);
    return stopped;
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

    // 旧版收尾必须先于一切 spawn 决策。停止失败时轮末保留原 state，下轮
    // 才能继续重试；本轮新会话可由任务专属日志认领，不会因未落盘而重拉。
    const legacyRetired = legacy.length === 0 || await retireLegacy(legacy, stats);

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
            { ...getOwn(state[d.ws], d.key), pid: d.pid }));
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
        if (deps.trackedAlive(ent)
            || (typeof ent.sessionId === 'string'
              && sidInDetails(ws, ent.sessionId))
            || isCooling(ent, cur)) {
          setOwn(out, taskId, ent);
          continue;
        }
        if ((ent.fails ?? 0) > 0) {
          ent.deadSince ??= cur;
          if (cur - ent.deadSince < FAIL_TTL_SECONDS) {
            setOwn(out, taskId, ent);
          }
        }
      }
      if (Object.keys(out).length > 0) setOwn(kept, ws, out);
    }
    if (legacyRetired) saveState(kept);

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
    deps.releaseRunLock(lock);
  }
}

Object.assign(deps, {
  log,
  runPatrol: cmdRun,
  rotatePatrolLogs,
  acquireRunLock,
  releaseRunLock,
});
