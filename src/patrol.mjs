// 一轮巡检：发现工作区 → 自动续期 → 保证该有会话的地方有一个健康会话。
// 这是 launchd 的入口（每 N 秒被拉起一次，跑完即退）。状态机覆盖：失败
// 冷却、卡死退休、超龄换代、孤儿接管、空任务回收。

import fs from 'node:fs';
import path from 'node:path';

import { deps, ExitError } from './internals.mjs';
import {
  FAIL_LIMIT,
  COOLDOWN_SECONDS,
  WARMUP_GRACE_SECONDS,
  SESSION_MAX_AGE_SECONDS,
  SESSION_IDLE_SECONDS,
  PATROL_LOG_ROTATE_BYTES,
} from './constants.mjs';
import { loadConfig, loadState, saveState, isInt } from './config.mjs';
import { renewWorkspace, TaskFileChanged } from './tasks.mjs';
import { taskWanted } from './cron.mjs';
import {
  sessionLogPath,
  sessionLogIdleSeconds,
} from './sessions.mjs';
import { TASK_REL } from './paths.mjs';

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
  fs.mkdirSync(deps.paths.appSupport, { recursive: true });
  const lockPath = path.join(deps.paths.appSupport, 'run.lock');
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

// 保证一个工作区里有一个健康的消费者会话。原地修改 state。
export async function patrolWorkspace(
  ws, state, now, leadMs, cur, consumers, scriptProcs = [],
) {
  const tasks = deps.readTasks(ws);
  let ent = state[ws] ?? null;

  if (tasks === null) {
    // 任务文件读不出：证据太弱，绝不动会话；但不能不吭声——文件还在却读
    // 不出意味着这个目录的定时任务一个都不会执行。文件已消失则是正常竞
    // 态（一次性任务执行完被删），不报。
    if (fs.existsSync(path.join(ws, TASK_REL))) {
      deps.log(`任务文件读不出 ${ws}：格式损坏或不可读，本轮跳过该目录，`
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
        deps.log(`回收 ${ws} pid=${ent.pid}：任务已全部清空，结束保活会话`);
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
      deps.log(`换代 ${ws} pid=${ent.pid}：会话已连续运行 `
        + `${Math.floor(age / 86400)} 天且近期无输出，结束后按需重拉`);
      delete state[ws];
      ent = null;
      mineAlive = false;
    }
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
    // 任务正在被消费。区分我们的预热会话与用户的交互会话：前者继续跟踪
    // （活消费者证明健康 → 计数清零），后者彻底放手。
    if (ent !== null) {
      if (mineAlive) {
        ent.fails = 0;
        state[ws] = ent;
      } else if (!cooling) {
        delete state[ws];
      }
    }
    return;
  }

  // 活着但没有消费。健康只在真实启动所需的时间内成立；超时就是卡在无人
  // 应答的提问界面，永不登记——退休它并推进失败计数。
  if (ent !== null && mineAlive) {
    const age = cur - (ent.startedAt ?? cur);
    if (age <= WARMUP_GRACE_SECONDS) return;
    await deps.stopSession(ent);
    deps.log(`卡死 ${ws} pid=${ent.pid}：进程已存活 ${age} 秒仍未登记会话，`
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
    fails = (ent?.fails ?? 0) + (ent ? 1 : 0);
  }

  if (fails >= FAIL_LIMIT) {
    state[ws] = {
      pid: null,
      fails,
      cooldownUntil: cur + COOLDOWN_SECONDS,
    };
    deps.log(`冷却 ${ws}：仍有任务需要会话，但保活会话连续失败 ${fails} 次，`
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
      if (procArgs.includes(`-q ${logPath} `) && deps.alive(procPid)) {
        state[ws] = {
          pid: procPid,
          startedAt: cur,
          procStart: deps.procStartedAt(procPid),
          fails: 0,
          log: logPath,
        };
        deps.log(`接管 ${ws} pid=${procPid}：state 记录缺失，但进程表里仍有`
          + '本工作区的保活会话，重新纳入跟踪');
        return;
      }
    }
  }

  const { pid, procStart } = deps.spawnSession(ws);
  state[ws] = {
    pid,
    startedAt: cur,
    procStart,
    fails,
    log: sessionLogPath(ws),
  };
  deps.log(`已启动 ${ws} pid=${pid}（连续失败计数 ${fails}）`);
}

// 跑一轮巡检；抢不到锁返回 false。
export async function cmdRun(args) {
  const lock = deps.acquireRunLock();
  if (lock === null) {
    deps.log('已有一轮巡检在进行，本轮跳过');
    return false;
  }
  try {
    deps.rotatePatrolLogs();
    const cfg = loadConfig(args?.config ?? deps.paths.configPath);
    if (!isInt(cfg.leadSeconds) || cfg.leadSeconds < 0) {
      deps.printErr('配置错误：leadSeconds 必须是非负整数秒，当前为 '
        + `${cfg.leadSeconds}`);
      throw new ExitError(2);
    }
    const now = new Date();
    const leadMs = cfg.leadSeconds * 1000;
    const state = loadState();
    if (cfg.roots.length === 0) {
      deps.log('警告：扫描目录 roots 为空，巡检不会发现任何工作区；'
        + '请检查配置文件或用 install --roots 指定');
    }

    const cur = Math.floor(Date.now() / 1000);
    // 登记每轮只读一次：否则每个工作区都要 readdir + ps 一遍，自检也归
    // 属这里。
    const [consumers, registryAlert] = await deps.scanSessions();
    if (registryAlert) deps.log(`告警：${registryAlert}`);
    const scriptProcs = deps.listScriptProcesses();

    for (const [ws, taskfile] of deps.discover(cfg.roots, cfg.maxDepth)) {
      // 一个工作区读不动不能中断整轮：discover 是生成器，这里抛了会跳过
      // 后面所有工作区。续期与保活各自独立守卫——续期失败绝不压制该工作
      // 区的会话保活。
      if (cfg.autoRenew) {
        try {
          const n = renewWorkspace(taskfile);
          if (n) {
            deps.log(`已续期 ${ws}：${n} 个周期任务标记为 permanent，`
              + '不再受 7 天过期限制');
          }
        } catch (e) {
          if (e instanceof TaskFileChanged) {
            deps.log(`续期暂缓 ${ws}：任务文件刚被 Claude Code 改动，`
              + '本轮不覆盖，下轮再续');
          } else {
            deps.log(`续期错误 ${ws}：${e.constructor.name}：${e.message}`);
          }
        }
      }
      try {
        await patrolWorkspace(
          ws, state, now, leadMs, cur, consumers, scriptProcs);
      } catch (e) {
        deps.log(`错误 ${ws}：${e.constructor.name}：${e.message}`);
      }
    }

    // 丢掉已死且不处冷却的条目；保留冷却与活会话。
    const kept = Object.fromEntries(
      Object.entries(state).filter(([, ent]) =>
        deps.trackedAlive(ent) || (ent.cooldownUntil ?? 0) > cur),
    );
    saveState(kept);
    return true;
  } finally {
    releaseLock(lock);
  }
}

// 立即给所有周期任务补 permanent。忽略 cfg.autoRenew——手动跑命令本身就
// 是显式指令。与巡检共用同一把锁。
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
    let unchanged = 0;
    const skipped = [];
    for (const [ws, taskfile] of deps.discover(cfg.roots, cfg.maxDepth)) {
      files += 1;
      let n;
      try {
        n = renewWorkspace(taskfile);
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
      if (n === null) {
        deps.print(`跳过 ${ws}：任务文件读不出或格式损坏`);
        skipped.push(ws);
      } else if (n) {
        tagged += n;
        deps.print(`已续期 ${ws}：${n} 个周期任务标记为 permanent`);
      } else {
        unchanged += 1;
        deps.print(`已是最新 ${ws}：周期任务均已 permanent，无需改动`);
      }
    }
    deps.print('');
    let line = `扫描 ${files} 个任务文件：本次续期 ${tagged} 个任务，`
      + `${unchanged} 个文件无需改动`;
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
