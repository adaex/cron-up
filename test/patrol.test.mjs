import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { cmdRun, patrolWorkspace, rotatePatrolLogs } from '../src/patrol.mjs';
import { sessionLogPath } from '../src/sessions.mjs';
import {
  WARMUP_GRACE_SECONDS,
  SESSION_MAX_AGE_SECONDS,
  PATROL_LOG_ROTATE_BYTES,
} from '../src/constants.mjs';
import { ExitError } from '../src/internals.mjs';
import {
  mkTmp,
  mockDeps,
  tmpPaths,
  readJson,
  writeJson,
} from '../test-support/helpers.mjs';

const WS = '/x';

async function setupMachine(t) {
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
  });
  const alivePids = new Set();
  let nextPid = 100;
  const holder = { consumer: false };
  deps.discover = () => [[WS, 'x']];
  deps.readTasks = () => [{ cron: '*/5 * * * *', createdAt: 0 }];
  deps.scanSessions = () => [holder.consumer ? new Set([WS]) : new Set(), null];
  deps.listScriptProcesses = () => [];
  deps.alive = (p) => alivePids.has(p);
  deps.procStartedAt = (p) => (alivePids.has(p) ? `start-${p}` : null);
  deps.spawnSession = () => {
    const pid = nextPid;
    nextPid += 1;
    alivePids.add(pid);
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
    tmp, deps, cfgPath, alivePids, state, writeState, patrol, holder, nextPid,
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
