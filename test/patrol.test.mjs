import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { cmdRun, patrolWorkspace, rotatePatrolLogs } from '../src/patrol.mjs';
import { sessionLogPath } from '../src/sessions.mjs';
import { readTasks } from '../src/tasks.mjs';
import {
  WARMUP_GRACE_SECONDS,
  SESSION_MAX_AGE_SECONDS,
  PATROL_LOG_ROTATE_BYTES,
  FAIL_TTL_SECONDS,
  SESSION_FIRE_MARGIN_SECONDS,
} from '../src/constants.mjs';
import { ExitError } from '../src/internals.mjs';
import {
  mkTmp,
  mockDeps,
  tmpPaths,
  readJson,
  writeJson,
  scanResult,
} from '../test-support/helpers.mjs';

const WS = '/x';

// 「距现在 offsetSec 后的时刻」的一次性 cron 五字段（月/日按当前日历取）。
function cronAt(offsetSec) {
  const d = new Date(Date.now() + offsetSec * 1000);
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} `
    + `${d.getMonth() + 1} *`;
}

async function setupMachine(t, cfgExtra = {}) {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp, {
    statePath: path.join(tmp, 'state.json'),
    sessionLogDir: path.join(tmp, 'sessions'),
  });
  fs.mkdirSync(deps.paths.sessionLogDir, { recursive: true });
  const cfgPath = path.join(tmp, 'config.json');
  writeJson(cfgPath, {
    roots: [WS], maxDepth: 3, intervalSeconds: 300, leadSeconds: 600,
    ...cfgExtra,
  });
  const alivePids = new Set();
  const spawnPids = [];
  let nextPid = 100;
  const holder = { consumer: false };
  deps.discover = () => [[WS, 'x']];
  deps.readTasks = () => [{ cron: '*/5 * * * *', createdAt: 0 }];
  deps.scanSessions = () => (holder.consumer
    ? scanResult(new Set([WS]))
    : scanResult());
  deps.listScriptProcesses = () => [];
  deps.alive = (p) => alivePids.has(p);
  deps.procStartedAt = (p) => (alivePids.has(p) ? `start-${p}` : null);
  deps.spawnSession = () => {
    const pid = nextPid;
    nextPid += 1;
    alivePids.add(pid);
    spawnPids.push(pid);
    return { pid, procStart: `start-${pid}` };
  };
  deps.stopSession = async (ent) => { alivePids.delete(ent.pid); };
  deps.acquireRunLock = () => 1; // 假锁柄无 lockPath，真 releaseLock 会直接返回
  deps.rotatePatrolLogs = () => {};
  deps.log = () => {};
  const state = () => (fs.existsSync(deps.paths.statePath)
    ? readJson(deps.paths.statePath)
    : {});
  const patrol = () => cmdRun({ config: cfgPath });
  const writeState = (s) => writeJson(deps.paths.statePath, s);
  return {
    tmp, deps, cfgPath, alivePids, spawnPids, state, writeState, patrol,
    holder, nextPid,
  };
}

test('lifecycle: spawn, healthy, die, cooldown, probation, user session', async (t) => {
  const m = await setupMachine(t);

  // 1: 首次拉起，fails=0
  await m.patrol();
  let ent = m.state()[WS];
  assert.equal(ent.fails, 0);
  assert.ok(m.alivePids.has(ent.pid));
  const pid1 = ent.pid;

  // 2: 已登记且健康 → 继续跟踪，计数清零
  m.writeState({ ...m.state(), [WS]: { ...m.state()[WS], fails: 1 } });
  m.holder.consumer = true;
  await m.patrol();
  assert.equal(m.state()[WS].pid, pid1);
  assert.equal(m.state()[WS].fails, 0);

  // 3: 仍需要但死了 → fails=1，重拉
  m.holder.consumer = false;
  m.alivePids.delete(pid1);
  await m.patrol();
  assert.equal(m.state()[WS].fails, 1);
  assert.notEqual(m.state()[WS].pid, pid1);

  // 4: 再快速死两次 → 冷却，无活 pid
  for (let i = 0; i < 2; i++) {
    m.alivePids.delete(m.state()[WS].pid);
    await m.patrol();
  }
  ent = m.state()[WS];
  assert.equal(ent.fails, 3);
  assert.ok(ent.cooldownUntil > Math.floor(Date.now() / 1000));
  assert.ok(!ent.pid);
  const spawnedAfterCooldown = m.nextPid;

  // 5: 冷却中不重拉
  await m.patrol();
  assert.equal(m.nextPid, spawnedAfterCooldown);

  // 6: 冷却结束 → 一次干净的缓刑拉起
  m.writeState({
    ...m.state(),
    [WS]: { ...m.state()[WS], cooldownUntil: Math.floor(Date.now() / 1000) - 1 },
  });
  await m.patrol();
  ent = m.state()[WS];
  assert.equal(ent.fails, 0);
  assert.ok(m.alivePids.has(ent.pid));

  // 7: 纯用户会话（无 state）永不跟踪
  fs.rmSync(m.deps.paths.statePath, { force: true });
  m.holder.consumer = true;
  await m.patrol();
  assert.ok(!(WS in m.state()));

  // 8: 用户会话关闭 → 干净拉起
  m.holder.consumer = false;
  await m.patrol();
  assert.equal(m.state()[WS].fails, 0);
});

test('fails counter survives sparse task windows and reaches cooldown', async (t) => {
  const m = await setupMachine(t);
  // 每小时任务的节奏：提前窗口只覆盖约 2 轮巡检，窗口外的轮次不得清掉计
  // 数，否则 FAIL_LIMIT 永远数不满、冷却形同虚设。
  const WANTED = () => [{ cron: '*/5 * * * *', createdAt: 0 }];
  const QUIET = () => [{ cron: '0 9 1 1 *', recurring: true }];
  m.deps.readTasks = WANTED;

  // 窗口轮 1：首次拉起；会话随即「启动后立即退出」。
  await m.patrol();
  m.alivePids.delete(m.state()[WS].pid);
  // 窗口轮 2：发现死亡 → fails=1，重拉；又死。
  await m.patrol();
  assert.equal(m.state()[WS].fails, 1);
  m.alivePids.delete(m.state()[WS].pid);
  // 窗口外的几轮：任务不在提前窗口，条目带着计数保留。
  m.deps.readTasks = QUIET;
  await m.patrol();
  await m.patrol();
  let ent = m.state()[WS];
  assert.equal(ent.fails, 1, '窗口外不得清掉失败计数');
  assert.ok(ent.deadSince > 0, '死条目首次被发现时打老化时间戳');

  // 下一个窗口：计数接着数，第二个窗口内进入冷却。
  m.deps.readTasks = WANTED;
  await m.patrol();
  assert.equal(m.state()[WS].fails, 2);
  m.alivePids.delete(m.state()[WS].pid);
  await m.patrol();
  ent = m.state()[WS];
  assert.equal(ent.fails, 3);
  assert.ok((ent.cooldownUntil ?? 0) > Math.floor(Date.now() / 1000));
});

test('dead entry with fails is dropped after TTL', async (t) => {
  const m = await setupMachine(t);
  m.deps.readTasks = () => [{ cron: '0 9 1 1 *', recurring: true }];
  const cur = Math.floor(Date.now() / 1000);
  m.writeState({
    [WS]: { pid: 424242, procStart: 'x', fails: 2, deadSince: cur - FAIL_TTL_SECONDS - 1 },
  });
  await m.patrol();
  assert.ok(!(WS in m.state()), '超过 TTL 的陈年计数连同条目一起老化');
  // TTL 之内仍保留。
  m.writeState({
    [WS]: { pid: 424243, procStart: 'x', fails: 2, deadSince: cur - 100 },
  });
  await m.patrol();
  assert.equal(m.state()[WS].fails, 2);
});

test('user session in place keeps our dead entry and its fails', async (t) => {
  const m = await setupMachine(t);
  // 用户自己的会话在场 ≠ launchd 拉起的环境健康：死条目与计数不因消费者
  // 出现而丢，留给后续窗口继续累积或老化。
  const cur = Math.floor(Date.now() / 1000);
  m.writeState({
    [WS]: { pid: 424244, procStart: 'x', fails: 2, deadSince: cur - 10 },
  });
  m.holder.consumer = true;
  await m.patrol();
  const ent = m.state()[WS];
  assert.ok(ent, '消费者在场不删死条目');
  assert.equal(ent.fails, 2, '消费者在场不清失败计数');
});

test('observed registration resets streak even when nothing wanted', async (t) => {
  const m = await setupMachine(t);
  await m.patrol();
  const pid1 = m.state()[WS].pid;
  m.deps.readTasks = () => [{ cron: '0 9 1 1 *', recurring: true }];
  m.writeState({ ...m.state(), [WS]: { ...m.state()[WS], fails: 2 } });
  m.holder.consumer = true;
  await m.patrol();
  assert.equal(m.state()[WS].fails, 0);
  assert.equal(m.state()[WS].pid, pid1);
});

test('stuck session is retired and counted', async (t) => {
  const m = await setupMachine(t);
  await m.patrol();
  const stuckPid = m.state()[WS].pid;

  // 宽限期内不动：正常启动就是这个样子。
  await m.patrol();
  assert.equal(m.state()[WS].pid, stuckPid);
  assert.equal(m.state()[WS].fails, 0);

  // 过时限仍未登记 → 杀掉重拉。
  const age = (s) => ({
    ...s, [WS]: { ...s[WS], startedAt: s[WS].startedAt - WARMUP_GRACE_SECONDS - 1 },
  });
  m.writeState(age(m.state()));
  await m.patrol();
  const ent = m.state()[WS];
  assert.notEqual(ent.pid, stuckPid);
  assert.ok(!m.alivePids.has(stuckPid));
  assert.equal(ent.fails, 1);

  // 反复卡死必须进入冷却而不是无限循环。
  for (let i = 0; i < 2; i++) {
    m.writeState(age(m.state()));
    await m.patrol();
  }
  assert.ok((m.state()[WS].cooldownUntil ?? 0) > Math.floor(Date.now() / 1000));
});

test('spawn that never starts is counted and reaches cooldown', async (t) => {
  const m = await setupMachine(t);
  const logs = [];
  m.deps.log = (msg) => logs.push(msg);
  m.deps.spawnSession = () => null;

  await m.patrol();
  assert.equal(m.state()[WS].pid, null, '没有伪 pid 进 state');
  assert.equal(m.state()[WS].fails, 1, '当场失败的尝试立即计数');
  assert.ok(logs.some((l) => l.includes('启动失败')));

  await m.patrol();
  assert.equal(m.state()[WS].fails, 2, '无 pid 条目不再重复累计上次失败');

  await m.patrol();
  assert.equal(m.state()[WS].fails, 3);

  await m.patrol();
  const ent = m.state()[WS];
  assert.ok((ent.cooldownUntil ?? 0) > Math.floor(Date.now() / 1000),
    '连续三次拉不起后进入冷却');
});

test('recycled pid is not mistaken for our session', async (t) => {
  const m = await setupMachine(t);
  await m.patrol();
  const pid = m.state()[WS].pid;

  // 同 pid、不同进程：还「活着」但不是我们的，不当活会话，也不发信号。
  m.writeState({
    ...m.state(), [WS]: { ...m.state()[WS], procStart: 'start-some-other' },
  });
  // trackedAlive 未被 fake：真实实现经 deps.alive/deeps procStartedAt 判定。
  assert.equal(m.deps.trackedAlive(m.state()[WS]), false);

  await m.patrol();
  assert.notEqual(m.state()[WS].pid, pid);
  assert.ok(m.alivePids.has(pid)); // 冒名者继续运行
});

test('empty task list reaps our session', async (t) => {
  const m = await setupMachine(t);
  await m.patrol();
  const pid = m.state()[WS].pid;
  m.deps.readTasks = () => [];
  await m.patrol();
  assert.deepEqual(m.state(), {});
  assert.ok(!m.alivePids.has(pid));
});

test('cooldown entry is cleared when tasks disappear', async (t) => {
  const m = await setupMachine(t);
  await m.patrol();
  for (let i = 0; i < 3; i++) {
    m.alivePids.delete(m.state()[WS].pid);
    await m.patrol();
  }
  assert.ok('cooldownUntil' in m.state()[WS]);
  m.deps.readTasks = () => [];
  await m.patrol();
  assert.deepEqual(m.state(), {});
});

test('unreadable task file never reaps', async (t) => {
  const m = await setupMachine(t);
  await m.patrol();
  const pid = m.state()[WS].pid;
  m.deps.readTasks = () => null;
  await m.patrol();
  assert.ok(m.alivePids.has(pid));
  assert.equal(m.state()[WS].pid, pid);
});

test('old idle session is rotated, not counted as failure', async (t) => {
  const m = await setupMachine(t);
  await m.patrol();
  const pid1 = m.state()[WS].pid;
  m.holder.consumer = true;

  // 未满龄：不动
  m.writeState({
    ...m.state(),
    [WS]: { ...m.state()[WS], startedAt: m.state()[WS].startedAt - SESSION_MAX_AGE_SECONDS + 100 },
  });
  await m.patrol();
  assert.equal(m.state()[WS].pid, pid1);

  // 超龄且 typescript 不存在（无活动证据）→ 本轮换代，下轮重拉
  m.writeState({
    ...m.state(),
    [WS]: { ...m.state()[WS], startedAt: m.state()[WS].startedAt - 200 },
  });
  await m.patrol();
  assert.ok(!m.alivePids.has(pid1));
  assert.ok(!(WS in m.state()));

  m.holder.consumer = false;
  await m.patrol();
  const ent = m.state()[WS];
  assert.notEqual(ent.pid, pid1);
  assert.equal(ent.fails, 0);
});

test('old but active session is not rotated', async (t) => {
  const m = await setupMachine(t);
  await m.patrol();
  const pid1 = m.state()[WS].pid;
  m.holder.consumer = true;
  const logPath = sessionLogPath(WS);
  fs.writeFileSync(logPath, 'task output\n'); // mtime 即现在
  m.writeState({
    ...m.state(),
    [WS]: { ...m.state()[WS], startedAt: m.state()[WS].startedAt - SESSION_MAX_AGE_SECONDS - 1 },
  });
  await m.patrol();
  assert.equal(m.state()[WS].pid, pid1);
  assert.ok(m.alivePids.has(pid1));
});

test('orphan session is adopted, not duplicated', async (t) => {
  const m = await setupMachine(t);
  const logPath = sessionLogPath(WS);
  m.alivePids.add(555);
  m.deps.listScriptProcesses = () => [
    [555, `/usr/bin/script -q ${logPath} /bin/zsh -lic 'cd /x && claude'`],
  ];
  await m.patrol();
  const ent = m.state()[WS];
  assert.equal(ent.pid, 555);
  assert.equal(ent.procStart, 'start-555');
  assert.equal(m.nextPid, 100); // 没有新 spawn

  // 接管后进入正常生命周期
  await m.patrol();
  assert.equal(m.state()[WS].pid, 555);
});

test('dead orphan in snapshot is not adopted', async (t) => {
  const m = await setupMachine(t);
  const logPath = sessionLogPath(WS);
  m.deps.listScriptProcesses = () => [
    [556, `/usr/bin/script -q ${logPath} /bin/zsh -lic x`],
  ]; // 556 不在 alivePids：快照里的死人
  await m.patrol();
  const ent = m.state()[WS];
  assert.notEqual(ent.pid, 556);
  assert.equal(ent.pid, 100); // 正常新拉
});

test('unrelated script processes are not adopted', async (t) => {
  const m = await setupMachine(t);
  m.alivePids.add(557);
  m.deps.listScriptProcesses = () => [
    [557, '/usr/bin/script -q /other/place.log /bin/zsh -lic x'],
  ];
  await m.patrol();
  assert.equal(m.state()[WS].pid, 100);
});

test('bool leadSeconds fails the launchd entry', async (t) => {
  const m = await setupMachine(t);
  writeJson(m.cfgPath, {
    roots: [WS], maxDepth: 3, intervalSeconds: 300, leadSeconds: true,
  });
  await assert.rejects(m.patrol(), (e) => {
    assert.ok(e instanceof ExitError);
    assert.equal(e.code, 2);
    return true;
  });
});

test('one broken workspace does not stop the patrol', async (t) => {
  const m = await setupMachine(t);
  const visited = [];
  m.deps.discover = () => [['/broken', 'x'], [WS, 'x']];
  m.deps.readTasks = (ws) => {
    visited.push(ws);
    if (ws === '/broken') throw new Error('corrupt beyond readTasks');
    return [{ cron: '*/5 * * * *', createdAt: 0 }];
  };
  await m.patrol();
  assert.deepEqual(visited, ['/broken', WS]);
  assert.ok(WS in m.state());
});

// ---- TaskFileTests 的 patrol 两条 ----

test('unreadable task file is reported by the patrol', async (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  const ws = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.claude', 'scheduled_tasks.json'), '{ broken');
  const logs = [];
  deps.log = (msg) => logs.push(msg);
  deps.readTasks = () => null;
  await patrolWorkspace(ws, {}, new Date(), 0, Math.floor(Date.now() / 1000),
    new Set(), []);
  assert.ok(logs.some((m) => m.includes('任务文件读不出')));
});

test('file vanished after discovery is not reported', async (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  const ws = path.join(tmp, 'proj');
  fs.mkdirSync(ws, { recursive: true });
  const logs = [];
  deps.log = (msg) => logs.push(msg);
  deps.readTasks = () => null;
  await patrolWorkspace(ws, {}, new Date(), 0, Math.floor(Date.now() / 1000),
    new Set(), []);
  assert.deepEqual(logs, []);
});

// ---- window 模式回收 ----

// 已触发过的远方任务 + 静默的界面记录：回收的标准背景。
function recycleTasks(soonCron = null) {
  const tasks = [{
    cron: '0 9 1 1 *', recurring: true, createdAt: 0,
    lastFiredAt: Date.now(),
  }];
  if (soonCron) {
    tasks.push({ cron: soonCron, createdAt: Date.now(), recurring: false });
  }
  return () => tasks;
}

function staleLog() {
  // spawnSession 是假的、不落日志文件：没有就先造一个（空文件 + 旧
  // mtime），有则只把 mtime 拨回去。
  const file = sessionLogPath(WS);
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(file, old, old);
}

test('window mode recycles an idle session after its task fired', async (t) => {
  const m = await setupMachine(t);
  await m.patrol();
  const pid = m.state()[WS].pid;
  staleLog();
  m.deps.readTasks = recycleTasks();
  await m.patrol();
  assert.ok(!m.alivePids.has(pid), '执行完毕的会话被回收');
  assert.ok(!(WS in m.state()), '无近窗口安排则不重拉');
});

test('recycle respawns in the same round when a window is still open', async (t) => {
  const m = await setupMachine(t);
  await m.patrol();
  const pid1 = m.state()[WS].pid;
  staleLog();
  // 4 分钟后要触发的任务：在 lead 窗口内、且超出回收余量——回收旧会话后
  // 同一轮就要拉新会话，等下一轮可能就错过触发点了。
  m.deps.readTasks = recycleTasks(cronAt(4 * 60));
  await m.patrol();
  const ent = m.state()[WS];
  assert.ok(!m.alivePids.has(pid1), '旧会话被回收');
  assert.ok(ent && ent.pid !== pid1, '同轮重拉了新会话');
  assert.equal(ent.fails, 0, '回收不计失败');
});

test('busy session is never recycled', async (t) => {
  const m = await setupMachine(t);
  await m.patrol();
  const pid = m.state()[WS].pid;
  fs.writeFileSync(sessionLogPath(WS), 'still rendering\n'); // mtime 即现在
  m.deps.readTasks = recycleTasks();
  await m.patrol();
  assert.ok(m.alivePids.has(pid), '日志新鲜 = 可能在执行，不动');
});

test('waiting warm session is not recycled before anything fires', async (t) => {
  const m = await setupMachine(t);
  await m.patrol();
  const pid = m.state()[WS].pid;
  staleLog();
  m.deps.readTasks = () => [
    { cron: '0 9 1 1 *', recurring: true, createdAt: 0 }, // 无 lastFiredAt
  ];
  await m.patrol();
  assert.ok(m.alivePids.has(pid), '等待触发的空闲是预热缓存在干活，保留');
});

test('session nearing its next fire is kept for reuse', async (t) => {
  const m = await setupMachine(t);
  await m.patrol();
  const pid = m.state()[WS].pid;
  staleLog();
  // 下次触发 60 秒后，小于回收余量：宁可直接复用现有会话。
  m.deps.readTasks = recycleTasks(cronAt(60));
  await m.patrol();
  assert.equal(m.state()[WS].pid, pid, '距下次触发太近，不回收');
});

test('pending missed one-shot blocks recycle', async (t) => {
  const m = await setupMachine(t);
  await m.patrol();
  const pid = m.state()[WS].pid;
  staleLog();
  m.deps.readTasks = () => [
    { cron: '0 9 1 1 *', recurring: true, createdAt: 0,
      lastFiredAt: Date.now() },
    { cron: cronAt(-86400), createdAt: Date.now() - 2 * 86400_000,
      recurring: false },
  ];
  await m.patrol();
  assert.ok(m.alivePids.has(pid), '错过待补执行的任务需要会话，不能回收');
});

test('always mode keeps the session resident', async (t) => {
  const m = await setupMachine(t, { sessionRetain: 'always' });
  await m.patrol();
  const pid = m.state()[WS].pid;
  staleLog();
  m.deps.readTasks = recycleTasks();
  await m.patrol();
  assert.ok(m.alivePids.has(pid));
  assert.equal(m.state()[WS].pid, pid);
});

test('our session recycles beside a user session without respawning', async (t) => {
  const m = await setupMachine(t);
  await m.patrol();
  const pid = m.state()[WS].pid;
  m.holder.consumer = true; // 用户会话在场：快照与重扫都看见
  staleLog();
  m.deps.readTasks = recycleTasks(cronAt(4 * 60));
  const spawnedBefore = m.nextPid;
  await m.patrol();
  assert.ok(!m.alivePids.has(pid), '我们的一代会被回收');
  assert.equal(m.nextPid, spawnedBefore, '用户会话在场时不重拉，避免同目录双开');
  assert.ok(!(WS in m.state()));
});

// ---- 日志轮转 ----

test('patrol log rotation', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  const touch = (name, size = 0) => {
    const file = path.join(deps.paths.logDir, name);
    fs.writeFileSync(file, Buffer.alloc(size, 0x78));
    return file;
  };

  const out = touch('launchd.out.log', PATROL_LOG_ROTATE_BYTES + 1);
  rotatePatrolLogs();
  assert.equal(fs.existsSync(out), false);
  assert.equal(fs.existsSync(`${out}.1`), true);

  const err = touch('launchd.err.log', 10);
  rotatePatrolLogs();
  assert.equal(fs.existsSync(err), true);
  assert.equal(fs.existsSync(`${err}.1`), false);

  const out2 = touch('launchd.out.log', PATROL_LOG_ROTATE_BYTES + 1);
  touch('launchd.out.log.1', 5);
  rotatePatrolLogs();
  assert.equal(fs.statSync(`${out2}.1`).size, PATROL_LOG_ROTATE_BYTES + 1);
});

// ---- 投递抖动尾窗：落点已过、实际投递未到，会话不能被回收 ----
// 两个每日任务：X 落点 13:00（13:30 顶格延迟投递，已跑完），Y 落点 13:30
// （同样顶格，要到 14:00 才投递）。13:35 时 Y 落点已过却还没投递，旧逻辑
// 误把「下一落点在明天」当作今天跑完，回收会话导致 Y 漏跑。
const BUG_DAY = new Date(2026, 8, 21); // 2026-09-21 周一
function neighborTasks(yFiredAt) {
  const tasks = [
    { id: 'c1363d8b', cron: '0 13 * * *', recurring: true,
      lastFiredAt: new Date(2026, 8, 21, 13, 30, 0).getTime() },
    { id: '6b6c321b', cron: '30 13 * * *', recurring: true },
  ];
  if (yFiredAt) tasks[1].lastFiredAt = yFiredAt;
  return tasks;
}

async function setupTailWindow(t) {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp, { sessionLogDir: path.join(tmp, 'sessions') });
  fs.mkdirSync(deps.paths.sessionLogDir, { recursive: true });
  deps.listScriptProcesses = () => [];
  deps.procStartedAt = (p) => (p === 100 ? 'start-100' : null);
  const alivePids = new Set([100]);
  let spawns = 0;
  deps.alive = (p) => alivePids.has(p);
  deps.spawnSession = () => { spawns += 1; alivePids.add(999); return { pid: 999 }; };
  deps.stopSession = async (ent) => { alivePids.delete(ent.pid); };
  deps.log = () => {};
  const file = sessionLogPath(WS);
  fs.writeFileSync(file, '');
  const quiet = (at) => {
    const old = new Date(at.getTime() - 3600_000);
    fs.utimesSync(file, old, old);
  };
  return {
    deps, alivePids, file, quiet, spawnCount: () => spawns,
    run(now, tasks, consumers, stamp = null) {
      const cur = Math.floor(now.getTime() / 1000);
      deps.scanSessions = () => scanResult(consumers);
      deps.readTasks = () => tasks;
      const state = { [WS]: { pid: 100, startedAt: cur - 2700, fails: 0, log: file } };
      return patrolWorkspace(WS, state, now, 600_000, cur,
        consumers, [], 'window', null, stamp).then(() => state);
    },
  };
}

test('tail window: session kept while neighbor task awaits its delayed fire', async (t) => {
  const m = await setupTailWindow(t);
  const at1335 = new Date(BUG_DAY.getFullYear(), 8, 21, 13, 35, 0);
  m.quiet(at1335);
  const state = await m.run(at1335, neighborTasks(), new Set([WS]));
  assert.ok(m.alivePids.has(100), 'Y 14:00 才投递，13:35 不能回收会话');
  assert.ok(WS in state, 'state 条目保留');
  assert.equal(m.spawnCount(), 0, '会话还活着，无需重拉');
});

test('tail window passed: session is recycled normally', async (t) => {
  const m = await setupTailWindow(t);
  const at1405 = new Date(BUG_DAY.getFullYear(), 8, 21, 14, 5, 0);
  m.quiet(at1405);
  const yFired = new Date(BUG_DAY.getFullYear(), 8, 21, 14, 0, 0).getTime();
  const state = await m.run(at1405, neighborTasks(yFired), new Set([WS]));
  assert.ok(!m.alivePids.has(100), '两个任务都投递完且静默，正常回收');
  assert.ok(!(WS in state), '下一落点在明天，不重拉');
});

test('tail window: a dead session during the tail is respawned', async (t) => {
  const m = await setupTailWindow(t);
  m.alivePids.delete(100); // 会话恰在尾窗内死了
  const at1335 = new Date(BUG_DAY.getFullYear(), 8, 21, 13, 35, 0);
  m.quiet(at1335);
  await m.run(at1335, neighborTasks(), new Set());
  assert.ok(m.alivePids.has(999), '尾窗内缺会话必须同轮重拉，不能漏跑');
});

// ---- 轮次心跳、汇总与被动退出 ----

test('each round writes a heartbeat and logs start/end summary', async (t) => {
  // 关掉 autoRenew/autoMinId：假任务文件路径会让维护步骤报「维护错误」，
  // 干扰「本轮无动作」的断言。
  const m = await setupMachine(t, { autoRenew: false, autoMinId: false });
  const logs = [];
  m.deps.log = (msg) => logs.push(msg);

  await m.patrol(); // 首轮：拉起会话
  assert.ok(logs.some((x) => x.startsWith('巡检开始')));
  const end1 = logs.find((x) => x.startsWith('巡检结束'));
  assert.match(end1, /发现 1 个工作区/);
  assert.match(end1, /启动 1/);
  assert.match(end1, /耗时/);
  const hb1 = readJson(m.deps.paths.heartbeatPath);
  assert.equal(hb1.sessionRetain, 'window');
  assert.equal(hb1.events.spawn, 1);
  assert.equal(typeof hb1.ranAt, 'number');

  // 次轮：会话健康且已登记，平静无动作；心跳刚写过，不应有漏轮告警。
  logs.length = 0;
  m.holder.consumer = true;
  await m.patrol();
  const end2 = logs.find((x) => x.startsWith('巡检结束'));
  assert.match(end2, /活动交互会话 1 个；本轮无动作/);
  assert.ok(!logs.some((x) => x.includes('漏轮')));
  assert.ok(!logs.some((x) => x.includes('会话退出')));
});

// ---- stampOwner：即使用户会话在场也要另拉预热并过户任务 ----

// stampOwner 专用夹具：在 setupMachine 上换成 tmp 下真实工作区（盖印要
// 落盘断言，readTasks/maintainWorkspace 走真实文件），scanSessions 改为
// 可注入的场景函数。进程机器、state、锁与日志全部沿用 setupMachine。
const STAMP_USER_DETAIL = {
  pid: 900, sessionId: 'sess-user', procStart: 'start-user',
  ancestors: [1], chainComplete: true,
};
const STAMP_AMBIGUOUS_DETAIL = {
  pid: 901, sessionId: 'sess-x', procStart: 'start-x',
  ancestors: [], chainComplete: false,
};

async function setupStampMachine(t, opts = {}) {
  const m = await setupMachine(t);
  const { deps, tmp } = m;
  const ws = path.join(tmp, 'proj');
  const taskfile = path.join(ws, '.claude', 'scheduled_tasks.json');
  fs.mkdirSync(path.dirname(taskfile), { recursive: true });
  writeJson(taskfile, {
    tasks: opts.tasks ?? [{
      id: '00000001',
      cron: '*/5 * * * *',
      prompt: 'p',
      createdAt: Date.now(),
      recurring: true,
      createdBySessionId: 'sess-user',
      createdByPid: 900,
      createdByProcStart: 'start-user',
    }],
  });
  writeJson(m.cfgPath, {
    roots: [ws], maxDepth: 3, intervalSeconds: 300, leadSeconds: 600,
    autoRenew: false, autoMinId: false, stampOwner: true,
  });
  deps.discover = () => [[ws, taskfile]];
  deps.readTasks = readTasks; // 恢复 mockDeps 快照里的真实读盘实现

  // 登记里 claude 的 pid 伪装成 script pid + 1000，父链三代。S 从 state
  // 现读，换代后自然指向新代。
  const warmDetail = (S) => ({
    pid: S + 1000,
    sessionId: `sess-warm-${S}`,
    procStart: `start-${S}`,
    ancestors: [S + 500, S, 1], // script(S) → zsh(S+500) → claude
    chainComplete: true,
  });
  const readSPid = () => m.state()[ws]?.pid;
  // 场景就是一个返回登记详情数组的函数（null=没有消费者）。
  const scenes = {
    none: () => null,
    user: () => [STAMP_USER_DETAIL],
    warm: () => {
      const S = readSPid();
      return S ? [warmDetail(S)] : [];
    },
    userWarm: () => {
      const S = readSPid();
      return S ? [STAMP_USER_DETAIL, warmDetail(S)] : [STAMP_USER_DETAIL];
    },
    ambiguous: () => [STAMP_AMBIGUOUS_DETAIL],
  };
  let sceneList = scenes.none;
  deps.scanSessions = () => {
    const list = sceneList();
    return list ? scanResult(new Set([ws]), new Map([[ws, list]]))
      : scanResult();
  };
  const logs = [];
  deps.log = (msg) => logs.push(msg);
  return {
    ...m, ws, logs, scenes,
    setScene: (name) => { sceneList = scenes[name]; },
    tasks: () => readJson(taskfile).tasks,
  };
}

test('stampOwner: live creator session is respected — no spawn, no stamp', async (t) => {
  // 核心语义：任务是在当前开着的会话里创建的，它一直没关——巡检必须
  // 放手，任务到点自然进这个会话。
  const m = await setupStampMachine(t); // 默认任务 owner = sess-user
  m.setScene('user'); // 在场会话正是 sess-user

  await m.patrol();
  assert.deepEqual(m.spawnPids, [], '活创建者在场，不另拉预热');
  assert.ok(!(m.ws in m.state()), '不跟踪任何预热');
  assert.equal(m.tasks()[0].createdBySessionId, 'sess-user', '归属不动');

  // 再过一轮依然如此。
  await m.patrol();
  assert.deepEqual(m.spawnPids, []);
  assert.equal(m.tasks()[0].createdBySessionId, 'sess-user');
});

test('stampOwner: dead creator with another session present spawns and stamps', async (t) => {
  // 任务的创建者已经关闭/崩溃，同目录虽有别的会话（但不是创建者）——
  // 另拉独立预热承接，不把任务丢给无关会话。
  const m = await setupStampMachine(t, {
    tasks: [{
      id: '00000001',
      cron: '*/5 * * * *',
      prompt: 'p',
      createdAt: Date.now(),
      recurring: true,
      createdBySessionId: 'sess-dead', // 建任务的会话已经没了
      createdByPid: 800,
      createdByProcStart: 'start-dead',
    }],
  });
  m.setScene('user'); // 在场的是另一个会话 sess-user

  // 轮 1：creatorAlive=false → user 态，另拉预热；当轮没登记不急盖。
  await m.patrol();
  const S1 = m.state()[m.ws].pid;
  assert.equal(S1, 100);
  assert.equal(m.tasks()[0].createdBySessionId, 'sess-dead');
  assert.ok(m.logs.some((l) => l.includes('已另启动预热会话')));

  // 轮 2：预热完成登记（三代祖先链认亲）→ 盖印，不再 spawn 第二个。
  m.setScene('userWarm');
  await m.patrol();
  const task = m.tasks()[0];
  assert.equal(task.createdBySessionId, 'sess-warm-100');
  assert.equal(task.createdByPid, 1100); // 登记 pid = S + 1000
  assert.equal(task.createdByProcStart, 'start-100');
  assert.deepEqual(m.spawnPids, [100]);
});

test('stampOwner: nothing wanted beside user means no second session', async (t) => {
  const m = await setupStampMachine(t, {
    tasks: [{
      id: '00000002', cron: '0 9 1 1 *', prompt: 'p',
      createdAt: Date.now(), recurring: true,
      createdBySessionId: 'sess-user',
    }],
  });
  m.setScene('user');
  await m.patrol();
  assert.deepEqual(m.spawnPids, [], '窗口外不双开');
  assert.ok(!(m.ws in m.state()));
});

test('stampOwner: ambiguous lineage never spawns nor stamps', async (t) => {
  const m = await setupStampMachine(t);
  m.setScene('ambiguous');
  await m.patrol();
  assert.deepEqual(m.spawnPids, [], '父链读不完整时保守不双开');
  assert.equal(m.tasks()[0].createdBySessionId, 'sess-user');
});

test('stampOwner: stuck warm is retired but not respawned when a live creator holds', async (t) => {
  // 轮 1：没人在场时拉起 S1；S1 卡死、始终没登记。
  const m = await setupStampMachine(t); // 任务 owner = sess-user
  await m.patrol();
  const S1 = m.state()[m.ws].pid;

  // 轮 2：活创建者 sess-user 出现且任务在窗口（creatorAlive 成立），S1
  // 又超过登记宽限——垃圾进程要杀，但任务由活创建者承接，不重拉。
  m.setScene('user');
  m.writeState({
    ...m.state(),
    [m.ws]: {
      ...m.state()[m.ws],
      startedAt: m.state()[m.ws].startedAt - WARMUP_GRACE_SECONDS - 1,
    },
  });
  await m.patrol();
  assert.ok(!m.alivePids.has(S1), '卡死的预热被退休');
  assert.deepEqual(m.spawnPids, [S1], '活创建者承接任务，不另拉');
  assert.equal(m.tasks()[0].createdBySessionId, 'sess-user', '不盖印');
});

test('stampOwner: stuck warm is retired and respawned when only a foreign session holds', async (t) => {
  // 对照：在场会话不是创建者（创建者已死）时，卡死的预热退休后要重拉——
  // user 态，不能让任务漏给无关会话。
  const m = await setupStampMachine(t, {
    tasks: [{
      id: '00000001',
      cron: '*/5 * * * *',
      prompt: 'p',
      createdAt: Date.now(),
      recurring: true,
      createdBySessionId: 'sess-dead',
    }],
  });
  await m.patrol(); // 无人，拉 S1
  const S1 = m.state()[m.ws].pid;
  m.setScene('user'); // 只有无关会话 sess-user
  m.writeState({
    ...m.state(),
    [m.ws]: {
      ...m.state()[m.ws],
      startedAt: m.state()[m.ws].startedAt - WARMUP_GRACE_SECONDS - 1,
    },
  });
  await m.patrol();
  assert.ok(!m.alivePids.has(S1));
  const S2 = m.state()[m.ws].pid;
  assert.notEqual(S2, S1);
  assert.ok(m.alivePids.has(S2), 'user 态：杀掉后重拉新预热');
});

test('stampOwner: owner is re-stamped to the new generation after a death', async (t) => {
  const m = await setupStampMachine(t);

  await m.patrol(); // 无人生场，拉 S1
  const S1 = m.state()[m.ws].pid;
  m.setScene('warm');
  await m.patrol(); // 盖给第一代
  assert.equal(m.tasks()[0].createdBySessionId, `sess-warm-${S1}`);

  // 第一代死亡、登记消失：下一轮重拉 S2，再下一轮盖给第二代。
  m.alivePids.delete(S1);
  m.setScene('none');
  await m.patrol();
  const S2 = m.state()[m.ws].pid;
  assert.notEqual(S2, S1);
  m.setScene('warm');
  await m.patrol();
  assert.equal(m.tasks()[0].createdBySessionId, `sess-warm-${S2}`);
  assert.equal(m.tasks()[0].createdByPid, S2 + 1000);
});

test('stampOwner: recycle margin leaves room for respawn and re-stamp', async (t) => {
  // 直接驱动 patrolWorkspace：距落点 300s 的任务，旧余量（120s）会回收，
  // stampOwner 余量（120+300=420s）下必须留住本代。
  const m = await setupTailWindow(t);
  const stamp = {
    verdict: { kind: 'own', target: {} }, // 本代预热已登记
    recycleMarginSec: SESSION_FIRE_MARGIN_SECONDS + 300,
  };
  const at = new Date();
  m.quiet(at);
  const present = new Set([WS]);

  let state = await m.run(at, recycleTasks(cronAt(300))(), present, stamp);
  assert.ok(m.alivePids.has(100), '300s < 420s 余量：不回收，否则来不及重盖');
  assert.equal(m.spawnCount(), 0);
  assert.equal(state[WS].pid, 100);

  // 500s 超出新余量：正常回收，并因任务仍在 lead 窗口而同轮重拉。
  state = await m.run(at, recycleTasks(cronAt(500))(), present, stamp);
  assert.ok(!m.alivePids.has(100), '500s > 420s 余量：回收');
  assert.ok(m.alivePids.has(999), '窗口还开着，同轮重拉');
  assert.equal(state[WS].pid, 999);

  // 对照：stamp 关闭时仍是旧的 120s 余量，300s 就回收。
  m.alivePids.clear();
  m.alivePids.add(100);
  await m.run(at, recycleTasks(cronAt(300))(), present, null);
  assert.ok(!m.alivePids.has(100), '开关关闭时余量退回 120s');
});

test('heartbeat older than two intervals warns about missed rounds', async (t) => {
  const m = await setupMachine(t, { autoRenew: false, autoMinId: false });
  writeJson(m.deps.paths.heartbeatPath, {
    ranAt: Math.floor(Date.now() / 1000) - 900, // 间隔 300 秒 × 2 = 600
  });
  const logs = [];
  m.deps.log = (msg) => logs.push(msg);
  await m.patrol();
  assert.ok(logs.some((x) => x.includes('超过 2 个轮次间隔') && x.includes('漏轮')));
});

test('session dying on its own is reported with lifetime and respawned', async (t) => {
  const m = await setupMachine(t, { autoRenew: false, autoMinId: false });
  await m.patrol();
  const pid = m.state()[WS].pid;
  // 拨回 startedAt：验证被动退出日志带上存活时长。
  m.writeState({
    ...m.state(),
    [WS]: { ...m.state()[WS], startedAt: Math.floor(Date.now() / 1000) - 90 },
  });
  m.alivePids.delete(pid); // 非巡检结束：自行崩溃/被杀
  const logs = [];
  m.deps.log = (msg) => logs.push(msg);
  await m.patrol();
  const line = logs.find((x) => x.includes('会话退出') && x.includes(`pid=${pid}`));
  assert.ok(line, '被动退出要有独立日志');
  assert.match(line, /非巡检主动结束/);
  assert.match(line, /已存活 1 分钟/);
  assert.notEqual(m.state()[WS].pid, pid, '任务仍在窗口内：同轮重拉');
  assert.equal(readJson(m.deps.paths.heartbeatPath).events.exit, 1);
});

test('actively recycled session is not also reported as passive exit', async (t) => {
  const m = await setupMachine(t, { autoRenew: false, autoMinId: false });
  await m.patrol();
  const pid = m.state()[WS].pid;
  staleLog();
  m.deps.readTasks = recycleTasks();
  const logs = [];
  m.deps.log = (msg) => logs.push(msg);
  await m.patrol();
  assert.ok(logs.some((x) => x.startsWith(`回收 ${WS} pid=${pid}`)));
  assert.ok(!logs.some((x) => x.includes('会话退出') && x.includes(`pid=${pid}`)),
    '主动回收不能再被记一次被动退出');
});
