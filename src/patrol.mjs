// 一轮巡检：发现工作区 → 自动续期 → 保证该有会话的地方有一个健康会话。
// 这是 launchd 的入口（每 N 秒被拉起一次，跑完即退）。状态机覆盖：失败
// 冷却、卡死退休、超龄换代、孤儿接管、空任务回收。

import fs from 'node:fs';
import path from 'node:path';

import { deps, packageVersion } from './internals.mjs';
import {
  FAIL_LIMIT,
  COOLDOWN_SECONDS,
  FAIL_TTL_SECONDS,
  WARMUP_GRACE_SECONDS,
  SESSION_MAX_AGE_SECONDS,
  SESSION_IDLE_SECONDS,
  SESSION_RECYCLE_IDLE_SECONDS,
  SESSION_FIRE_MARGIN_SECONDS,
  PATROL_LOG_ROTATE_BYTES,
  HEARTBEAT_STALE_FACTOR,
} from './constants.mjs';
import {
  loadConfig,
  loadState,
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
} from './tasks.mjs';
import { taskWanted, parseCronOrNone, wanted } from './cron.mjs';
import {
  sessionLogPath,
  sessionLogIdleSeconds,
  scriptProcLogPath,
  rotateOnce,
} from './sessions.mjs';
import { TASK_REL } from './paths.mjs';
import { elapsedZh, pad2 } from './display.mjs';

// 事件类型 → 轮末汇总里的中文标签。patrolWorkspace 与 cmdRun 往同一个
// stats 计数器里记账，平静轮也会打出「本轮无动作」。
const EVENT_LABELS = [
  ['spawn', '启动'],
  ['recycle', '回收'],
  ['ageout', '换代'],
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

// 下次「需要会话在场」的时刻（ms）：各任务下次触发的最小值；有错过待补
// 执行的一次性任务时视为立刻需要。窗口内无安排返回 Infinity。锚点刻意取
// cron 裸落点而非 nextDelivery 的抖动后投递时刻：落点总不晚于投递时刻，
// 按落点算余量更小、回收更保守，是安全方向；真正的重拉闸门是下面的
// wanted(leadMs)，margin 只需保住新会话登记。若改用 fire，落点后、投递
// 前的整段延迟窗内都不会回收，回收频率被悄悄改变。
function needHorizonMs(tasks, now) {
  let horizon = Infinity;
  for (const t of tasks) {
    const cron = parseCronOrNone(t?.cron);
    if (cron === null) continue;
    if (wanted(cron, t, now, 0)) return now.getTime();
    const nxt = cron.nextAfter(now)?.getTime();
    if (nxt !== undefined && nxt < horizon) horizon = nxt;
  }
  return horizon;
}

// stampOwner 的活创建者判定，一处备齐 classifyWorkspace 需要的输入：
// 返回本目录活会话 id 集合与「窗口内是否还有任务的创建者会话活着」。
// 逐任务的 creatorSessionAlive 是本原（盖印逐个任务判定时复用同一谓词），
// 聚合布尔只是它的派生。
function liveCreatorWanted(tasks, details, ws, now, leadMs) {
  const liveSids = deps.liveSessionIds(details, ws);
  const creatorAlive = tasks.some((t) =>
    taskWanted(t, now, leadMs) && deps.creatorSessionAlive(t, liveSids));
  return { liveSids, creatorAlive };
}

// 保证一个工作区里有一个健康的消费者会话。原地修改 state。retain 来自
// cfg.sessionRetain，直接调用（测试）默认 'always' 保持旧语义。scriptProcs
// 是进程表快照或 null：null 时仅在需要认领孤儿（state 丢失的兜底分支）当
// 下才拍快照，平静轮不付全量 ps 的代价。
// stamp=null 表示 stampOwner 关（一切旧行为）；开启时为
// {verdict, recycleMarginSec}：verdict 是 classifyWorkspace 对轮初消费者
// 快照的认亲结论（own/creatorAlive/ambiguous/user，换代或回收导致快照变
// 化时在 retire 内用新快照重算），recycleMarginSec 是 window 回收余量。
export async function patrolWorkspace(
  ws, state, now, leadMs, cur, consumers, scriptProcs = null,
  retain = 'always', stats = null, stamp = null,
) {
  const tasks = deps.readTasks(ws);
  let ent = state[ws] ?? null;
  // 边记日志边给轮末汇总记账：日志给人翻，stats 给轮首/轮末心跳行一个
  // 紧凑全貌。stats 为 null（直接单测）时退化为纯日志。
  const note = (kind, msg) => {
    bump(stats, kind);
    deps.log(msg);
  };

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
  if (tasks.length === 0) {
    // 文件完好但任务清空：一次性任务触发后被删、周期任务过期、或用户手
    // 删。我们拉起的会话没理由继续留着；用户自己开的会话不在 state 里，
    // 永不触碰。
    if (ent !== null) {
      if (deps.trackedAlive(ent)) {
        await deps.stopSession(ent);
        note('recycle', `回收 ${ws} pid=${ent.pid}：任务已全部清空，结束保活会话`);
      }
      delete state[ws];
    }
    return;
  }

  // 结束本代会话的完整收尾：停掉 → 摘 state → 重扫消费者。换代与 window
  // 回收是同一个动作，差别只在触发条件与文案；消费者快照拍于轮初，刚结束
  // 的这代可能正是快照里的消费者，不重扫会让陈旧登记挡住下面的重拉。
  let mineAlive = deps.trackedAlive(ent);
  // verdict 是轮初快照的认亲结论；换代/回收杀掉本代后消费者集合变了，
  // 必须按重扫结果重算而不是手改布尔——幸存下来的断链会话（进程组杀不
  // 掉的用户会话）仍应是歧义态，否则会被误当普通用户会话、在它旁边双开。
  let verdict = stamp?.verdict ?? null;
  const retire = async (kind, msg) => {
    await deps.stopSession(ent);
    note(kind, msg);
    delete state[ws];
    ent = null;
    mineAlive = false;
    if (stamp) {
      const [nextConsumers, , nextDetails] = await deps.scanSessions({ lineage: true });
      consumers = nextConsumers;
      // ent 已没（ownPid 给 null）；creatorAlive 也必须按新快照重算——
      // 重扫本身就承认换代这几秒现场会变，活创建者可能恰好开关会话。
      verdict = deps.classifyWorkspace(nextDetails, ws, null,
        liveCreatorWanted(tasks, nextDetails, ws, now, leadMs).creatorAlive);
    } else {
      consumers = (await deps.scanSessions())[0];
    }
  };

  // 换代：超龄且日志静默（无任务在执行的证据）的会话主动结束，需要时下
  // 文自然重拉。换代是维护，不计失败。
  if (ent !== null && mineAlive) {
    const age = cur - (ent.startedAt ?? cur);
    if (age > SESSION_MAX_AGE_SECONDS
        && sessionLogIdleSeconds(
          ent.log || sessionLogPath(ws), cur) > SESSION_IDLE_SECONDS) {
      await retire('ageout', `换代 ${ws} pid=${ent.pid}：会话已连续运行 `
        + `${Math.floor(age / 86400)} 天且近期无输出，结束后按需重拉`);
    }
  }

  // window 模式回收：会话生命周期对齐「一次执行」而非「常驻」。三个条件
  // 缺一不可：本代会话期间真的有任务触发过（lastFiredAt 晚于 startedAt
  // ——区分「执行完的空闲」与「等待触发的空闲」，后者是预热缓存在干活，
  // 回收它只会每轮空转重拉）；界面静默超时（TUI 执行期间持续渲染，静默
  // 即不在干活）；距下次需要会话还有余量（回收后下轮巡检重拉的新会话来
  // 得及登记，不会漏掉到点任务）。时间上重叠或紧邻的任务仍共享会话：任
  // 务路由在 Claude Code 手里，同目录并发多会话无法指定归属，还有重复
  // 执行的风险。回收不计失败——任务成功执行过是最强的健康证据，陈年计
  // 数一并清零。
  // 余量取值：默认只保登记抖动（约 2 分钟）；stampOwner 开启时必须再留
  // 出一个巡检间隔——回收后要靠「下轮重拉→再下轮过户」两步把 owner 盖
  // 到新会话，余量小于间隔就可能在过户完成前到点（cmdRun 传入
  // SESSION_FIRE_MARGIN_SECONDS + intervalSeconds）。
  const fireMarginSec = stamp
    ? stamp.recycleMarginSec
    : SESSION_FIRE_MARGIN_SECONDS;
  if (ent !== null && mineAlive && retain === 'window'
      && tasks.some((t) => typeof t?.lastFiredAt === 'number'
        && t.lastFiredAt > (ent.startedAt ?? 0) * 1000)
      && sessionLogIdleSeconds(ent.log || sessionLogPath(ws), cur)
        > SESSION_RECYCLE_IDLE_SECONDS
      && needHorizonMs(tasks, now) - now.getTime()
        > fireMarginSec * 1000) {
    // stampOwner 关时：用户自己的会话若在场，retire 的重扫依旧看见，不
    // 会在同目录双开；开启时：旧代整组结束后重扫只可能剩用户会话，下面
    // 的逻辑会按需另拉新预热。
    await retire('recycle', `回收 ${ws} pid=${ent.pid}：本代任务已执行完毕且`
      + '界面静默，结束会话，下次需要时重拉');
  }

  const wantedNow = tasks.some((t) => taskWanted(t, now, leadMs));
  const warmAge = ent !== null ? cur - (ent.startedAt ?? cur) : 0;
  // 我们跟踪的预热活着、超过登记宽限、且没被认成自己（own 不可能卡死）：
  // 卡在提问界面的垃圾进程。两条善后路径共用这一个判定：
  //  - 有别的会话可承接（consumerHolds）：只杀掉，不摘 state、不计数、不
  //    重拉——是垃圾回收，不是一次启动失败；
  //  - 没人承接：杀掉后继续走失败计数/冷却/重拉。
  const warmStuck = ent !== null && mineAlive && wantedNow
    && warmAge > WARMUP_GRACE_SECONDS
    && (!stamp || verdict.kind !== 'own');
  const killStuckWarm = async (held) => {
    await deps.stopSession(ent);
    note('stuck', `卡死 ${ws} pid=${ent.pid}：进程已存活 ${warmAge} 秒仍未登记`
      + '会话，已终止'
      + (held ? '；同目录已有会话可承接任务，不另拉预热' : '')
      + `（排查：cron-up logs ${path.basename(ws)}）`);
  };

  // 在场的消费者足以让我们放手吗？功能关时任何消费者都算；开启时除 user
  // 外的三态都算——认到自己的预热（own）、窗口任务的创建者会话还活着
  // （creatorAlive：用户显式要求尊重，绝不另拉）、父链有歧义无法排除是
  // 自己（ambiguous）。仅 user 不算：创建者已关闭/崩溃，下面继续走到
  // wanted→卡死退休/冷却→spawn，在同目录另起独立预热承接（全程只 stop
  // 自己的 ent，不碰用户会话）。
  const consumerHolds = consumers.has(ws)
    && (!stamp || verdict.kind !== 'user');

  // 登记成功即健康证据，当场清零失败计数，不等「有任务想要会话」的轮
  // 次——健康会话常驻时计数会一直挂着，一次无关死亡就能把陈年计数顶满冷
  // 却，连一次新尝试都不给。只有真的认到自己（own）或歧义态才清零：
  // creatorAlive 时在场的是活创建者、我们的预热可能正卡着没登记，不能替
  // 它清零。
  if (ent !== null && mineAlive && consumers.has(ws)
      && (!stamp || verdict.kind === 'own' || verdict.kind === 'ambiguous')) {
    ent.fails = 0;
  }

  // 任务正在被消费。可能是我们的预热会话（已登记——上面的健康清零已覆
  // 盖），也可能是用户的交互会话——后者默认放手：不在这里删死条目，失败
  // 计数要跨任务窗口存活（用户会话在场不证明 launchd 拉起的环境健康），
  // 由轮末 kept 过滤统一处理。creatorAlive/ambiguous 返回前顺手清掉卡死
  // 的垃圾预热；平稳态在此提前返回，不必继续后面的流程。
  if (consumerHolds) {
    // 默认配置（stamp 关）沿用旧行为：用户会话在场时「掩护」卡死预热，
    // 不在这里杀，交给 7 天换代——所以 holds 路径只在 stamp 开启时清垃圾。
    if (stamp && warmStuck) await killStuckWarm(true);
    return;
  }

  if (!wantedNow) return;

  const cooling = isCooling(ent, cur);

  // 活着但没有消费。健康只在真实启动所需的时间内成立；超时就是卡在无人
  // 应答的提问界面，永不登记——退休它并推进失败计数。宽限内的年轻会话
  // 直接返回；warmStuck 已含超宽限判定。
  if (ent !== null && mineAlive) {
    if (!warmStuck) return;
    await killStuckWarm(false);
  }

  if (cooling) return;

  // 没有消费者，我们跟踪的会话（若有）已死或刚作为卡死退休。
  let fails;
  if (ent && ent.cooldownUntil) {
    // 冷却刚结束：给一次干净的缓刑拉起，而不是立刻再次顶满限制。
    fails = 0;
  } else {
    // 只有真的拉起过（pid 非空）的条目死亡才算一次新失败；pid 为空的条目
    // 是当场就没拉起的尝试，那次失败已在写入时计过，不再重复累计。
    fails = (ent?.fails ?? 0) + (ent?.pid ? 1 : 0);
  }

  if (fails >= FAIL_LIMIT) {
    state[ws] = {
      pid: null,
      fails,
      cooldownUntil: cur + COOLDOWN_SECONDS,
    };
    note('cool', `冷却 ${ws}：仍有任务需要会话，但保活会话连续失败 ${fails} 次，`
      + `暂停重试 ${COOLDOWN_SECONDS / 60} 分钟`);
    return;
  }

  if (ent === null) {
    // state 里没有记录不等于没有会话：state.json 丢失（手删、purge 时保留
    // 会话）后进程表里可能还躺着这个工作区的 script 会话，卡在提问界面就
    // 不会出现在登记里，直接再拉就是同目录双开。认回孤儿，重新纳入正常
    // 生命周期（卡死的 3 分钟后照退休处理）。
    const logPath = sessionLogPath(ws);
    for (const [procPid, procArgs] of scriptProcs ?? deps.listScriptProcesses()) {
      // alive 复核：快照拍于本轮开头，可能含着刚被换代/回收杀掉的 pid——
      // 把死人认回来会白记一次失败。
      if (scriptProcLogPath(procArgs) === logPath && deps.alive(procPid)) {
        state[ws] = {
          pid: procPid,
          startedAt: cur,
          procStart: deps.procStartedAt(procPid),
          fails: 0,
          log: logPath,
        };
        note('adopt', `接管 ${ws} pid=${procPid}：state 记录缺失，但进程表里仍有`
          + '本工作区的保活会话，重新纳入跟踪');
        return;
      }
    }
  }

  // 成败只认一个事实——有没有拿到 pid：null、undefined、无 pid 的对象都算
  // 没拉起，计数与日志同源，不会各说各话。
  const spawned = deps.spawnSession(ws);
  if (spawned?.pid == null) {
    // 本次尝试已当场失败，立即计入（成功拉起则本次尚待观察，沿用 fails）。
    const newFails = fails + 1;
    state[ws] = {
      pid: null,
      startedAt: cur,
      fails: newFails,
      log: sessionLogPath(ws),
    };
    note('fail', `启动失败 ${ws}：会话进程没有拉起（连续失败计数 ${newFails}）`);
    return;
  }
  state[ws] = {
    pid: spawned.pid,
    startedAt: cur,
    procStart: spawned.procStart,
    fails,
    log: sessionLogPath(ws),
  };
  if (stamp && consumers.has(ws) && verdict?.kind === 'user') {
    note('spawn', `已另启动预热会话 ${ws} pid=${spawned.pid}：你的交互会话仍在`
      + `，窗口内任务将改由预热会话承接（连续失败计数 ${fails}）`);
  } else {
    note('spawn', `已启动 ${ws} pid=${spawned.pid}（连续失败计数 ${fails}）`);
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
  // 与「会话自行退出/被外部杀掉的」，后者以前是无声丢失。同样包一层
  // procStartedAt：同一 pid 的 lstart 一轮内不会变，而轮初分区、各工作区
  // 的 trackedAlive、轮末复核与 kept 过滤都会查指纹，缓存后每个 pid 只
  // spawn 一次 ps。finally 一并还原。
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
    const leadMs = cfg.leadSeconds * 1000;
    const state = loadState();
    const cur = Math.floor(Date.now() / 1000);

    // 轮首心跳：没有这两行，launchd 拉不起巡检（启动脚本失效、node 缺失）
    // 时日志会一片寂静，无法和「平安无事」区分。上轮心跳过老说明中间漏
    // 轮——休眠期间错过的 StartInterval，launchd 醒来只补跑一轮。
    const hb = loadHeartbeat();
    if (heartbeatStale(hb, cfg.intervalSeconds, cur)) {
      bump(stats, 'warn');
      deps.log(`距上次巡检已 ${elapsedZh(cur - hb.ranAt)}，超过 `
        + `${HEARTBEAT_STALE_FACTOR} 个轮次间隔（${cfg.intervalSeconds} 秒），`
        + '期间 launchd 可能漏轮（常见于电脑休眠）');
    }
    deps.log(`巡检开始：${cfg.sessionRetain} 模式，扫描根目录 `
      + `${cfg.roots.length} 个`);
    if (cfg.roots.length === 0) {
      bump(stats, 'warn');
      deps.log('警告：扫描目录 roots 为空，巡检不会发现任何工作区；'
        + '请检查配置文件或用 install --roots 指定');
    }

    // 轮初拍一份「上轮末仍相信活着」的会话快照（entry 复制，本轮原地改写
    // 不影响），一遍分成「轮初已没气」与「轮初还活着」两组。不能只收此刻
    // kill -0 成功的——两轮之间崩溃正是最典型的被动死亡，本轮开始时它早
    // 已没气；带 deadSince 的是上轮已报过死亡的旧条目，跳过以免每轮重复报。
    const prevDead = [];
    const prevAlive = [];
    for (const [ws, ent] of Object.entries(state)) {
      if (!ent.pid || ent.deadSince) continue;
      const copy = [ws, { ...ent }];
      (deps.trackedAlive(copy[1]) ? prevAlive : prevDead).push(copy);
    }
    const exitLine = (ws, old) => `会话退出 ${ws} pid=${old.pid}：非巡检主动结束`
      + `（已存活 ${elapsedZh(cur - (old.startedAt ?? cur))}），可能自行退出或`
      + '被外部终止；若反复出现请用 cron-up logs '
      + `${path.basename(ws)} 排查启动过程`;

    // 登记每轮只读一次：否则每个工作区都要 readdir + ps 一遍，自检也归
    // 属这里。进程表快照不在这里拍：只有孤儿认领分支需要，按需现拍（见
    // patrolWorkspace 的 scriptProcs 形参）。
    // lineage 只在 stampOwner 开启时拍：祖先链要一次全机 ps，关闭时
    // scanSessions 不付这个代价（见 registry 的 scanSessions 注释）。
    const [consumers, registryAlert, details] =
      await deps.scanSessions({ lineage: cfg.stampOwner });
    if (registryAlert) {
      bump(stats, 'warn');
      deps.log(`告警：${registryAlert}`);
    }

    // stampOwner 的结论依赖任务内容（活创建者判定要看窗口任务的
    // createdBySessionId），所以在下面 discover 循环里、读到任务后逐工
    // 作区现算；这里只留全轮常量。
    const recycleMarginSec = SESSION_FIRE_MARGIN_SECONDS
      + cfg.intervalSeconds;

    // 轮间死亡在进入工作区循环前先报：随后该工作区若需要会话会打印重拉，
    // 日志时间线就是「退出 → 重拉」，而不是反过来。
    for (const [ws, old] of prevDead) {
      bump(stats, 'exit');
      deps.log(exitLine(ws, old));
    }

    let found = 0;
    for (const [ws, taskfile] of deps.discover(cfg.roots, cfg.maxDepth)) {
      found += 1;
      // 一个工作区读不动不能中断整轮：discover 是生成器，这里抛了会跳过
      // 后面所有工作区。续期/改 id/过户与保活各自独立守卫——维护失败绝不
      // 压制该工作区的会话保活。三者合并为同一次原子写（见
      // maintainWorkspace）。
      //
      // stampOwner 的判定在这里现算（依赖任务内容）：窗口内是否还有任务
      // 的创建者会话活着——活创建者拥有否决权，不另拉、不盖印。
      let stampArg = null;
      let liveSids = null;
      if (cfg.stampOwner) {
        const wsTasks = deps.readTasks(ws) ?? []; // readTasks 已滤掉非对象
        const creator = liveCreatorWanted(wsTasks, details, ws, now, leadMs);
        liveSids = creator.liveSids;
        const entNow = state[ws] ?? null;
        const ownPid = entNow && deps.trackedAlive(entNow) ? entNow.pid : null;
        stampArg = {
          verdict: deps.classifyWorkspace(details, ws, ownPid,
            creator.creatorAlive),
          recycleMarginSec,
        };
      }
      const target = stampArg?.verdict?.target ?? null;
      // 盖印谓词只盖「窗口内且创建者已不活」的任务：活创建者的任务永远
      // 不碰（即便本目录另有我们的预热在承接别的死主任务）；已盖给本代
      // 预热的任务因 owner 就在活会话集合里而自然跳过，幂等不靠另写比较。
      if (cfg.autoRenew || cfg.autoMinId || target) {
        try {
          const { renewed, minified, reowned } = maintainWorkspace(taskfile, {
            renew: cfg.autoRenew,
            minify: cfg.autoMinId,
            // target 多出的祖先链字段 tasks 层不读，展开即可，不必手抄
            // 三个盖印字段。
            reown: target
              ? {
                  ...target,
                  isWanted: (t) => taskWanted(t, now, leadMs)
                    && !deps.creatorSessionAlive(t, liveSids),
                }
              : null,
          }) ?? {};
          if (renewed) {
            deps.log(`已续期 ${ws}：${renewed} 个周期任务标记为 permanent，`
              + '不再受 7 天过期限制');
          }
          if (minified) {
            deps.log(`已改小 id ${ws}：${minified} 个周期任务的 id 改为小哈希`
              + '值，投递延迟降到约 1 分钟内；下次预热拉起的新会话起生效，'
              + '已在运行的会话要等其结束重拉（window 模式执行完即回收、'
              + 'always 模式换代）后才读到新 id');
          }
          if (reowned) {
            bump(stats, 'reown');
            deps.log(`已过户 ${ws}：${reowned} 个窗口内任务的归属改到预热会话`
              + ` pid=${target.pid}，这些任务将只在该会话触发`);
          }
        } catch (e) {
          bump(stats, e instanceof TaskFileChanged ? 'warn' : 'error');
          if (e instanceof TaskFileChanged) {
            deps.log(`维护暂缓 ${ws}：任务文件刚被 Claude Code 改动，`
              + '本轮不覆盖，下轮再来');
          } else {
            deps.log(`维护错误 ${ws}：${e.constructor.name}：${e.message}`);
          }
        }
      }
      try {
        await patrolWorkspace(
          ws, state, now, leadMs, cur, consumers, null,
          cfg.sessionRetain, stats, stampArg);
      } catch (e) {
        bump(stats, 'error');
        deps.log(`错误 ${ws}：${e.constructor.name}：${e.message}`);
      }
    }

    // 轮中死亡：轮初还活着、轮末复核没气、又不是本轮主动 stop 的。指纹复
    // 核由 trackedAlive 完成（带 procStart 指纹，pid 回收不会误报）。主动
    // 回收/换代/卡死有各自的日志，这里只补轮中自行消亡那一类；轮间死亡刚
    // 才已在循环前报过。报过的死条目随后由 kept 过滤打上 deadSince，后续
    // 轮次不会重复报。
    for (const [ws, old] of prevAlive) {
      if (stoppedPids.has(old.pid)) continue;
      if (deps.trackedAlive(old)) continue;
      bump(stats, 'exit');
      deps.log(exitLine(ws, old));
    }

    // 丢掉已死且不处冷却的条目；保留冷却、活会话，以及带失败计数的死条
    // 目——计数跨任务窗口累积才能数满 FAIL_LIMIT（提前窗口常常只覆盖一两
    // 轮巡检），首次发现死亡时打 deadSince，超过 FAIL_TTL 后连同计数一起
    // 老化丢弃。
    const kept = Object.fromEntries(
      Object.entries(state).filter(([, ent]) => {
        if (deps.trackedAlive(ent)) return true;
        if (isCooling(ent, cur)) return true;
        if ((ent.fails ?? 0) > 0) {
          ent.deadSince ??= cur;
          return cur - ent.deadSince < FAIL_TTL_SECONDS;
        }
        return false;
      }),
    );
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
      intervalSeconds: cfg.intervalSeconds,
      sessionRetain: cfg.sessionRetain,
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

// 立即给所有周期任务补 permanent 并把 id 改小。忽略 cfg.autoRenew /
// cfg.autoMinId——手动跑命令本身就是显式指令（想只续期不改 id 的场景极
// 少，真需要可临时关掉配置后跑巡检）。与巡检共用同一把锁。
export async function cmdRenew(args) {
  const lock = deps.acquireRunLock();
  if (lock === null) {
    deps.print('已有一轮巡检（或另一次 renew）在进行，请稍后重试');
    return;
  }
  try {
    const cfg = loadConfig(args?.config ?? deps.paths.configPath);
    let files = 0;
    let tagged = 0;
    let minified = 0;
    let unchanged = 0;
    const skipped = [];
    for (const [ws, taskfile] of deps.discover(cfg.roots, cfg.maxDepth)) {
      files += 1;
      let r;
      try {
        r = maintainWorkspace(taskfile, { renew: true, minify: true });
      } catch (e) {
        if (e instanceof TaskFileChanged) {
          deps.print(`暂缓 ${ws}：任务文件刚被 Claude Code 改动，本次未写入，`
            + '可再跑一次');
          skipped.push(ws);
          continue;
        }
        deps.print(`跳过 ${ws}：（${e.constructor.name}：${e.message}）`);
        skipped.push(ws);
        continue;
      }
      if (r === null) {
        deps.print(`跳过 ${ws}：任务文件读不出或格式损坏`);
        skipped.push(ws);
        continue;
      }
      if (r.renewed || r.minified) {
        if (r.renewed) {
          tagged += r.renewed;
          deps.print(`已续期 ${ws}：${r.renewed} 个周期任务标记为 permanent`);
        }
        if (r.minified) {
          minified += r.minified;
          deps.print(`已改小 id ${ws}：${r.minified} 个周期任务投递延迟降到约`
            + ' 1 分钟内（下次预热的新会话起生效）');
        }
      } else {
        unchanged += 1;
        deps.print(`已是最新 ${ws}：周期任务均已 permanent 且 id 已足够小，`
          + '无需改动');
      }
    }
    deps.print('');
    let line = `扫描 ${files} 个任务文件：本次续期 ${tagged} 个、改小 id `
      + `${minified} 个任务，${unchanged} 个文件无需改动`;
    if (skipped.length) line += `，${skipped.length} 个跳过`;
    deps.print(line);
    if (tagged) {
      deps.print('这些周期任务此后不再受 7 天过期限制；为它们保活的后台会话'
        + '会长期常驻。');
    }
  } finally {
    releaseLock(lock);
  }
}

Object.assign(deps, {
  log,
  runPatrol: cmdRun,
  rotatePatrolLogs,
  acquireRunLock,
});
