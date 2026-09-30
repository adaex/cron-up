// 一轮巡检：发现工作区 → 自动续期 → 保证该有会话的地方有一个健康会话。
// 这是 launchd 的入口（每 N 秒被拉起一次，跑完即退）。状态机覆盖：失败
// 冷却、卡死退休、超龄换代、孤儿接管、空任务回收。

import fs from 'node:fs';
import path from 'node:path';

import { deps } from './internals.mjs';
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
} from './config.mjs';
import { maintainWorkspace, TaskFileChanged } from './tasks.mjs';
import { taskWanted, parseCronOrNone, wanted } from './cron.mjs';
import {
  sessionLogPath,
  sessionLogIdleSeconds,
  scriptProcLogPath,
} from './sessions.mjs';
import { TASK_REL, packageVersion } from './paths.mjs';
import { elapsedZh } from './display.mjs';

// 事件类型 → 轮末汇总里的中文标签。patrolWorkspace 与 cmdRun 往同一个
// stats 计数器里记账，平静轮也会打出「本轮无动作」。
const EVENT_LABELS = [
  ['spawn', '启动'],
  ['recycle', '回收'],
  ['ageout', '换代'],
  ['exit', '自行退出'],
  ['stuck', '卡死退休'],
  ['adopt', '接管'],
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
  const p = (n) => String(n).padStart(2, '0');
  deps.print(
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${msg}`,
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

export function releaseLock(handle) {
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
  // 的 inode，下轮打开新文件。
  for (const name of ['launchd.out.log', 'launchd.err.log']) {
    const file = path.join(deps.paths.logDir, name);
    try {
      if (fs.existsSync(file)
          && fs.statSync(file).size > PATROL_LOG_ROTATE_BYTES) {
        const old = `${file}.1`;
        fs.rmSync(old, { force: true });
        fs.renameSync(file, old);
      }
    } catch {
      // 轮转失败不阻断巡检。
    }
  }
}

// 下次「需要会话在场」的时刻（ms）：各任务下次触发的最小值；有错过待补
// 执行的一次性任务时视为立刻需要。窗口内无安排返回 Infinity。
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

// 保证一个工作区里有一个健康的消费者会话。原地修改 state。retain 来自
// cfg.sessionRetain，直接调用（测试）默认 'always' 保持旧语义。
export async function patrolWorkspace(
  ws, state, now, leadMs, cur, consumers, scriptProcs = [],
  retain = 'always', stats = null,
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
    if (fs.existsSync(path.join(ws, TASK_REL))) {
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

  // 换代：超龄且日志静默（无任务在执行的证据）的会话主动结束，需要时下
  // 文自然重拉。换代是维护，不计失败。
  let mineAlive = deps.trackedAlive(ent);
  if (ent !== null && mineAlive) {
    const age = cur - (ent.startedAt ?? cur);
    if (age > SESSION_MAX_AGE_SECONDS
        && sessionLogIdleSeconds(
          ent.log || sessionLogPath(ws), cur) > SESSION_IDLE_SECONDS) {
      await deps.stopSession(ent);
      note('ageout', `换代 ${ws} pid=${ent.pid}：会话已连续运行 `
        + `${Math.floor(age / 86400)} 天且近期无输出，结束后按需重拉`);
      delete state[ws];
      ent = null;
      mineAlive = false;
      // 消费者快照拍于轮初，被换代的这代可能正是快照里的消费者：重扫一
      // 次，别让陈旧登记挡住下面的重拉。
      const [fresh] = await deps.scanSessions();
      consumers = fresh;
    }
  }

  // window 模式回收：会话生命周期对齐「一次执行」而非「常驻」。三个条件
  // 缺一不可：本代会话期间真的有任务触发过（lastFiredAt 晚于 startedAt
  // ——区分「执行完的空闲」与「等待触发的空闲」，后者是预热缓存在干活，
  // 回收它只会每轮空转重拉）；界面静默超时（TUI 执行期间持续渲染，静默
  // 即不在干活）；距下次需要会话还有余量（回收后同轮重拉，新会话来得及
  // 登记，不会漏掉到点任务）。时间上重叠或紧邻的任务仍共享会话：任务路
  // 由在 Claude Code 手里，同目录并发多会话无法指定归属，还有重复执行的
  // 风险。回收不计失败——任务成功执行过是最强的健康证据，陈年计数一并
  // 清零。
  if (ent !== null && mineAlive && retain === 'window'
      && tasks.some((t) => typeof t?.lastFiredAt === 'number'
        && t.lastFiredAt > (ent.startedAt ?? 0) * 1000)
      && sessionLogIdleSeconds(ent.log || sessionLogPath(ws), cur)
        > SESSION_RECYCLE_IDLE_SECONDS
      && needHorizonMs(tasks, now) - now.getTime()
        > SESSION_FIRE_MARGIN_SECONDS * 1000) {
    const pid = ent.pid;
    await deps.stopSession(ent);
    note('recycle', `回收 ${ws} pid=${pid}：本代任务已执行完毕且界面静默，`
      + '结束会话，下次需要时重拉');
    delete state[ws];
    ent = null;
    mineAlive = false;
    // 同上：快照里的消费者可能正是刚结束的这代。用户自己的会话若在场，
    // 重扫依旧看见，不会在同目录双开。
    const [fresh] = await deps.scanSessions();
    consumers = fresh;
  }

  // 登记成功即健康证据，当场清零失败计数，不等「有任务想要会话」的轮
  // 次——健康会话常驻时计数会一直挂着，一次无关死亡就能把陈年计数顶满冷
  // 却，连一次新尝试都不给。
  if (ent !== null && mineAlive && consumers.has(ws)) {
    ent.fails = 0;
  }

  if (!tasks.some((t) => taskWanted(t, now, leadMs))) return;

  const cooling = Boolean(ent && (ent.cooldownUntil ?? 0) > cur);

  if (consumers.has(ws)) {
    // 任务正在被消费。可能是我们的预热会话（已登记——上面的健康清零已覆
    // 盖），也可能是用户的交互会话——后者放手：不在这里删死条目，失败计数
    // 要跨任务窗口存活（用户会话在场不证明 launchd 拉起的环境健康），由轮
    // 末 kept 过滤统一处理。
    return;
  }

  // 活着但没有消费。健康只在真实启动所需的时间内成立；超时就是卡在无人
  // 应答的提问界面，永不登记——退休它并推进失败计数。
  if (ent !== null && mineAlive) {
    const age = cur - (ent.startedAt ?? cur);
    if (age <= WARMUP_GRACE_SECONDS) return;
    await deps.stopSession(ent);
    note('stuck', `卡死 ${ws} pid=${ent.pid}：进程已存活 ${age} 秒仍未登记会话，`
      + '已终止（排查：cron-up logs '
      + `${path.basename(ws)}）`);
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
    for (const [procPid, procArgs] of scriptProcs) {
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
  note('spawn', `已启动 ${ws} pid=${spawned.pid}（连续失败计数 ${fails}）`);
}

// 跑一轮巡检；抢不到锁返回 false。
export async function cmdRun(args) {
  const lock = deps.acquireRunLock();
  if (lock === null) {
    deps.log('已有一轮巡检在进行，本轮跳过');
    return false;
  }
  // 包一层 stopSession 记下本轮主动结束的 pid：轮末凭它区分「我们回收的」
  // 与「会话自行退出/被外部杀掉的」，后者以前是无声丢失。finally 还原。
  const prevStopSession = deps.stopSession;
  const stoppedPids = new Set();
  deps.stopSession = async (ent) => {
    if (ent?.pid) stoppedPids.add(ent.pid);
    return prevStopSession(ent);
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
    if (hb !== null
        && cur - hb.ranAt > cfg.intervalSeconds * HEARTBEAT_STALE_FACTOR) {
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
    // 不影响），分成「轮初已没气」与「轮初还活着」两组。不能只收此刻
    // kill -0 成功的——两轮之间崩溃正是最典型的被动死亡，本轮开始时它早
    // 已没气；带 deadSince 的是上轮已报过死亡的旧条目，跳过以免每轮重复报。
    const prevTracked = Object.entries(state)
      .filter(([, ent]) => ent.pid && !ent.deadSince)
      .map(([ws, ent]) => [ws, { ...ent }]);
    const prevDead = prevTracked.filter(([, ent]) => !deps.trackedAlive(ent));
    const prevAlive = prevTracked.filter(([, ent]) => deps.trackedAlive(ent));
    const exitLine = (ws, old) => `会话退出 ${ws} pid=${old.pid}：非巡检主动结束`
      + `（已存活 ${elapsedZh(cur - (old.startedAt ?? cur))}），可能自行退出或`
      + '被外部终止；若反复出现请用 cron-up logs '
      + `${path.basename(ws)} 排查启动过程`;

    // 登记每轮只读一次：否则每个工作区都要 readdir + ps 一遍，自检也归
    // 属这里。
    const [consumers, registryAlert] = await deps.scanSessions();
    if (registryAlert) {
      bump(stats, 'warn');
      deps.log(`告警：${registryAlert}`);
    }
    const scriptProcs = deps.listScriptProcesses();

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
      // 后面所有工作区。续期/改 id 与保活各自独立守卫——维护失败绝不压制
      // 该工作区的会话保活。两者合并为同一次原子写（见 maintainWorkspace）。
      if (cfg.autoRenew || cfg.autoMinId) {
        try {
          const { renewed, minified } = maintainWorkspace(taskfile, {
            renew: cfg.autoRenew,
            minify: cfg.autoMinId,
          }) ?? { renewed: null, minified: null };
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
          ws, state, now, leadMs, cur, consumers, scriptProcs,
          cfg.sessionRetain, stats);
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
        if ((ent.cooldownUntil ?? 0) > cur) return true;
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
