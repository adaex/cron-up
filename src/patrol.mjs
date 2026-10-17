// 一轮巡检：发现工作区 → 自动维护任务文件（续期/改 id/盖印）→ 保证每个
// 「创建者会话已死且处于预热窗口」的任务都有一个只属于它的健康会话。
// 这是 launchd 的入口（每 N 秒被拉起一次，跑完即退）。状态机覆盖：认亲、
// 卡死退休、失败冷却、执行完回收、resume 接管脱离、孤儿认领、任务消失回
// 收、旧版目录级 state 迁移。

import fs from 'node:fs';
import path from 'node:path';

import { deps, packageVersion } from './internals.mjs';
import {
  FAIL_LIMIT,
  COOLDOWN_SECONDS,
  FAIL_TTL_SECONDS,
  WARMUP_GRACE_SECONDS,
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
import { taskWanted, parseCronOrNone, wanted } from './cron.mjs';
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
// 性错过待补）视为立刻需要；窗口外取 cron 裸落点（刻意不取抖动后投递时
// 刻：落点更早，按落点算余量更小、回收更保守，是安全方向）。cron 无效
// 返回 Infinity，永不回收。
function taskNeedMs(task, now) {
  const cron = parseCronOrNone(task?.cron);
  if (cron === null) return Infinity;
  if (wanted(cron, task, now, 0)) return now.getTime();
  return cron.nextAfter(now)?.getTime() ?? Infinity;
}

// 一个预热 entry 是否已认到登记里的活 claude 会话。
function entryClaimed(ent) {
  return Boolean(ent?.sessionId && ent.claudeProcStart);
}

// 保证一个工作区里每个死主窗口任务都有专属预热，并完成本文件的续期/改
// id/盖印维护。bucket 是 state[ws]（原地修改）。scriptProcsRef 是全轮共
// 享的进程表快照容器（{value: 数组|null}），只在孤儿认领时拍一次。
export async function patrolWorkspace(
  ws, bucket, taskfile, now, leadMs, cur, details, scriptProcsRef, stats,
) {
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
    return;
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
    return;
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

  // 第一步：认亲。spawn 只知道 script pid，登记里是 claude 孙进程；沿轮
  // 初快照的祖先链找到我们这代的登记详情，回填 sessionId/claudePid/
  // claudeProcStart。认到 = 最强健康证据，当场清零失败计数。认不到下轮
  // 再认，不阻断任何决策。
  for (const ent of Object.values(bucket)) {
    if (!deps.trackedAlive(ent)) continue;
    const d = deps.claimWarm(details, ws, ent.pid);
    if (!d) continue;
    ent.fails = 0;
    if (d.sessionId && d.procStart) {
      ent.claudePid = d.pid;
      ent.sessionId = d.sessionId;
      ent.claudeProcStart = d.procStart;
    }
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
    // 热缓存在干活）、本任务日志静默超时、距本任务下次需要还有两步余量
    // （下轮重拉、再下轮盖印；needMs 在窗口内返回 now，天然挡住「回收后
    // 立刻又需要」）。
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

    // 盖印：已认亲且任务归属还没盖到本代预热（活创建者已在 (a) 排
    // 除）。当轮新 spawn 的会话没认亲，下轮才盖——lead 覆盖两轮巡检。
    if (entryClaimed(ent)
        && (!t.createdBySessionId || t.createdBySessionId !== ent.sessionId)) {
      const target = {
        sessionId: ent.sessionId,
        pid: ent.claudePid,
        procStart: ent.claudeProcStart,
      };
      if (stamps.has(sig)) {
        if (stamps.get(sig).sessionId !== ent.sessionId) {
          stampConflicts.add(sig);
          stamps.delete(sig);
        }
      } else if (!stampConflicts.has(sig)) {
        stamps.set(sig, target);
      }
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
        cooldownUntil: cur + COOLDOWN_SECONDS,
        log: ent?.log ?? logPath,
      };
      note('cool', `冷却 ${ws} 任务 ${key}：仍有任务需要会话，但预热连续失败 `
        + `${fails} 次，暂停重试 ${COOLDOWN_SECONDS / 60} 分钟`);
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
          ws, taskId: key, sig, pid: null, fails: newFails,
          cooldownUntil: cur + COOLDOWN_SECONDS, log: logPath,
        };
        note('cool', `冷却 ${ws} 任务 ${key}：仍有任务需要会话，但预热连续失败 `
          + `${newFails} 次，暂停重试 ${COOLDOWN_SECONDS / 60} 分钟`);
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
  }

  // 第三步：任务文件维护（续期 + 改 id + 盖印）合并为一次带乐观锁的原子
  // 写。撞车（Claude Code 刚写了 lastFiredAt/删了任务）整轮放弃写与
  // reap，下轮基于新文件重算——已 spawn 的条目留下轮处理，不受影响。
  let result;
  try {
    result = maintainWorkspace(taskfile, { reown: stamps });
  } catch (e) {
    if (e instanceof TaskFileChanged) {
      note('warn', `维护暂缓 ${ws}：任务文件刚被 Claude Code 改动，本轮不覆盖，`
        + '下轮再来');
      return;
    }
    throw e;
  }
  if (result === null) return; // 与 readTasks 不一致的极端竞态：保守不动
  if (result.renewed) {
    deps.log(`已续期 ${ws}：${result.renewed} 个周期任务标记为 permanent，`
      + '不再受 7 天过期限制');
  }
  if (result.minified) {
    deps.log(`已改小 id ${ws}：${result.minified} 个周期任务的 id 改为小哈希`
      + '值，投递延迟降到约 1 分钟内');
  }
  if (result.reowned) {
    bump(stats, 'reown');
    deps.log(`已过户 ${ws}：${result.reowned} 个窗口内任务的归属改到各自的`
      + '预热会话，这些任务将只在对应会话触发');
  }
  // id 改小同轮把 state 条目跟着改键：不改的话下轮会把换 id 的任务误判
  // 成「旧任务删除 + 新任务」，错杀刚拉起的会话再重拉一个。
  for (const { from, to } of result.idChanges) {
    if (bucket[from] && !bucket[to]) {
      bucket[to] = { ...bucket[from], taskId: to };
      delete bucket[from];
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

    // 登记每轮只读一次（含祖先链快照）：认亲与活创建者判定都靠它。
    const [consumers, registryAlert, details] = await deps.scanSessions();
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
    for (const [ws, taskfile] of deps.discover(cfg.roots)) {
      found += 1;
      if (!state[ws]) state[ws] = {};
      // 一个工作区读不动/写不动不能中断整轮：discover 是生成器，抛了会
      // 跳过后面所有工作区。
      try {
        await patrolWorkspace(
          ws, state[ws], taskfile, now, leadMs, cur, details,
          scriptProcsRef, stats);
      } catch (e) {
        bump(stats, 'error');
        deps.log(`错误 ${ws}：${e.constructor.name}：${e.message}`);
      }
      if (Object.keys(state[ws]).length === 0) delete state[ws];
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
