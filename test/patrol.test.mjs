import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  acquireRunLock,
  cmdRun,
  patrolWorkspace,
  releaseRunLock,
} from '../src/patrol.mjs';
import { sessionLogPath, isTaskSessionLogName } from '../src/sessions.mjs';
import {
  WARMUP_GRACE_SECONDS,
  FAIL_LIMIT,
  COOLDOWN_SECONDS,
  FAIL_TTL_SECONDS,
  SESSION_RECYCLE_IDLE_SECONDS,
  SESSION_RECYCLE_MARGIN_SECONDS,
} from '../src/constants.mjs';
import {
  mkTmp,
  mockDeps,
  tmpPaths,
  readJson,
  writeJson,
  writeTaskFile,
  makeTask,
  cronAt,
  scanFrom,
} from '../test-support/helpers.mjs';

// 「现在」锚定测试进程启动时刻（秒）：cron 落点判定走真实日历，需要窗口
// 的用例用 cronAt(偏移) 造落点，远期任务用明确的远 cron。
const T0 = Math.floor(Date.now() / 1000);
const nowAt = (sec = T0) => new Date(sec * 1000);
const LEAD_MS = 360_000;

// 一台完整的进程/登记机器：
//  - spawnSession 分配三代 pid（script、zsh），claim() 后登记里才出现孙
//    代 claude（祖先链含 script）；
//  - kill() 整组消失；resume() 模拟用户终端 --resume（script 死、同 sid
//    的裸 claude 活，祖先链不再含 script）；
//  - 外部创建者会话用 userSessions 配置。
async function setupMachine(t, { realDiscover = false } = {}) {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp, {
    statePath: path.join(tmp, 'state.json'),
  });
  fs.mkdirSync(deps.paths.sessionLogDir, { recursive: true });
  const WS = path.join(tmp, 'ws');
  fs.mkdirSync(WS);
  const taskfile = path.join(WS, '.claude', 'scheduled_tasks.json');
  const cfgPath = path.join(tmp, 'config.json');
  writeJson(cfgPath, { roots: [WS] });

  const alive = new Set();
  let nextPid = 1000;
  const spawns = [];
  const byTask = new Map();
  const userSessions = [];
  const resumed = new Map(); // sid → bare claude pid
  const scriptProcs = []; // ps 孤儿表：[pid, args]
  const logs = [];
  const patrolLogs = [];
  // 每个任务独立的 spawn 成败/行为钩子。
  const hooks = new Map();

  deps.alive = (p) => alive.has(p);
  deps.procStartedAt = (p) => (alive.has(p) ? `start-${p}` : null);
  deps.spawnSession = (wsArg, taskId, model) => {
    logs.push(taskId);
    if (hooks.get(taskId)?.failSpawn) return null;
    const scriptPid = nextPid++;
    const zshPid = nextPid++;
    alive.add(scriptPid);
    const rec = {
      ws: wsArg, taskId, model, scriptPid, zshPid,
      claimed: false, sid: null, claudePid: null,
    };
    spawns.push(rec);
    byTask.set(taskId, rec);
    return { pid: scriptPid, procStart: `start-${scriptPid}` };
  };
  deps.stopSession = async (ent) => {
    const rec = spawns.find((r) => r.scriptPid === ent.pid);
    alive.delete(ent.pid);
    if (rec) {
      alive.delete(rec.zshPid);
      if (rec.claudePid !== null) alive.delete(rec.claudePid);
    }
    return true;
  };
  deps.listScriptProcesses = () => scriptProcs;
  deps.acquireRunLock = () => ({ lockPath: null });
  deps.rotatePatrolLogs = () => {};
  deps.log = (msg) => patrolLogs.push(msg);
  // 等待轮询默认不真睡：拍钩子里突变世界（认亲/死亡），复刻 registry 测
  // 试的既有手法。拍号从 1 开始（第 N 拍 = 第 N 次 sleep 后的重扫）。
  let polls = 0;
  const pollHooks = [];
  deps.sleep = async () => {
    polls += 1;
    for (const fn of pollHooks) fn(polls);
  };
  let scanCount = 0;

  function buildDetails() {
    const list = [];
    for (const r of spawns) {
      if (!alive.has(r.scriptPid)) continue;
      if (r.claimed && r.claudePid !== null && alive.has(r.claudePid)) {
        list.push({
          pid: r.claudePid,
          sessionId: r.sid,
          procStart: `cstart-${r.claudePid}`,
          ancestors: [r.zshPid, r.scriptPid, 1],
        });
      }
    }
    for (const u of userSessions) {
      if (alive.has(u.pid)) {
        list.push({
          pid: u.pid, sessionId: u.sid, procStart: `ustart-${u.pid}`,
          ancestors: [1],
        });
      }
    }
    for (const [sid, pid] of resumed) {
      if (alive.has(pid)) {
        list.push({
          pid, sessionId: sid, procStart: `rstart-${pid}`,
          ancestors: [1],
        });
      }
    }
    const details = new Map();
    if (list.length) details.set(WS, list);
    return details;
  }
  deps.scanSessions = async () => {
    scanCount += 1;
    return scanFrom(buildDetails());
  };
  // target 可以是 rec 或返回 rec 的函数（钩子注册往往早于 spawn）。
  const asRec = (target) => (typeof target === 'function' ? target() : target);
  const claimAt = (target, atPoll, sid) => {
    pollHooks.push((p) => {
      if (p === atPoll) claim(asRec(target), sid);
    });
  };
  const killAt = (target, atPoll) => {
    pollHooks.push((p) => {
      if (p === atPoll) kill(asRec(target));
    });
  };

  const claim = (rec, sid = `sid-${rec.scriptPid}`) => {
    rec.claimed = true;
    rec.sid = sid;
    rec.claudePid = nextPid++;
    alive.add(rec.claudePid);
    return rec;
  };
  const kill = (rec) => {
    alive.delete(rec.scriptPid);
    alive.delete(rec.zshPid);
    if (rec.claudePid !== null) alive.delete(rec.claudePid);
  };
  const resume = (rec) => {
    alive.delete(rec.scriptPid);
    alive.delete(rec.zshPid);
    if (rec.claudePid !== null) alive.delete(rec.claudePid);
    const bare = nextPid++;
    alive.add(bare);
    resumed.set(rec.sid, bare);
    return bare;
  };
  const closeResume = (sid) => {
    const pid = resumed.get(sid);
    if (pid !== undefined) {
      alive.delete(pid);
      resumed.delete(sid);
    }
  };
  const addUser = (sid) => {
    const pid = nextPid++;
    alive.add(pid);
    userSessions.push({ sid, pid });
    return pid;
  };
  const touchLog = (taskId, ageSec, cur = T0) => {
    const f = sessionLogPath(WS, taskId);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x');
    fs.utimesSync(f, new Date((cur - ageSec) * 1000),
      new Date((cur - ageSec) * 1000));
    return f;
  };

  const m = {
    tmp, deps, WS, taskfile, cfgPath, alive, spawns, byTask, hooks,
    claim, kill, resume, closeResume, addUser, touchLog, buildDetails,
    claimAt, killAt,
    polls: () => polls,
    scans: () => scanCount,
    state: () => (fs.existsSync(deps.paths.statePath)
      ? readJson(deps.paths.statePath) : {}),
    scriptProcs,
    spawnLog: logs,
    patrolLogs,
  };

  if (realDiscover) {
    // 拍号/扫描计数按轮归零：跨轮用例的「第 N 拍」钩子是相对每轮的语义。
    m.patrol = () => {
      polls = 0;
      scanCount = 0;
      return cmdRun({ config: cfgPath });
    };
  } else {
    const bucket = {};
    m.bucket = bucket;
    m.patrol = async (curSec = T0, taskOverride = null) => {
      if (taskOverride !== null) writeTaskFile(WS, taskOverride);
      return patrolWorkspace(
        WS, bucket, taskfile, nowAt(curSec), LEAD_MS, curSec,
        buildDetails(), { value: null }, null);
    };
  }
  return m;
}

const fileTasks = (m) => readJson(m.taskfile).tasks;
const sidOf = (m, taskId) =>
  fileTasks(m).find((x) => x.id === taskId)?.createdBySessionId;

// ---- 一任务一会话：核心场景 ----

test('two same-time dead-owner tasks get two separate warm sessions and stamps', async (t) => {
  const m = await setupMachine(t);
  const soon = cronAt(300, nowAt(T0)); // 5 分钟后同刻，在 6 分钟提前窗内
  const a = makeTask({ id: '00000002', cron: soon, prompt: '甲日报' });
  const b = makeTask({ id: '00000004', cron: soon, prompt: '乙日报' });
  writeTaskFile(m.WS, [a, b]);

  // 轮 1：各拉各的，两条日志、两个 script pid；两条都挂起等待认亲。
  const r1 = await m.patrol();
  assert.equal(m.spawns.length, 2);
  assert.equal(m.spawnLog[0], '00000002');
  assert.equal(m.spawnLog[1], '00000004');
  assert.notEqual(m.spawns[0].scriptPid, m.spawns[1].scriptPid);
  assert.ok(m.spawnLog.every((id) =>
    isTaskSessionLogName(path.basename(sessionLogPath(m.WS, id)))));
  assert.deepEqual(r1.map((p) => p.key).sort(),
    ['00000002', '00000004']);
  // 未认亲不盖印。
  assert.equal(sidOf(m, '00000002'), undefined);
  assert.equal(sidOf(m, '00000004'), undefined);

  // 轮 2：两个预热都完成登记 → 各盖各的 sid，不再 spawn 第三个。
  m.claim(m.spawns[0], 'sid-A');
  m.claim(m.spawns[1], 'sid-B');
  await m.patrol();
  assert.equal(m.spawns.length, 2);
  assert.equal(sidOf(m, '00000002'), 'sid-A');
  assert.equal(sidOf(m, '00000004'), 'sid-B');
  assert.equal(fileTasks(m).find((x) => x.id === '00000002').createdByPid,
    m.spawns[0].claudePid);
  assert.equal(fileTasks(m).find((x) => x.id === '00000004').createdByPid,
    m.spawns[1].claudePid);

  // 轮 3：幂等，字节级不动。
  const st = fs.statSync(m.taskfile);
  await m.patrol();
  const st2 = fs.statSync(m.taskfile);
  assert.equal(st2.mtimeNs, st.mtimeNs);
});

test('workspace and task model config flow into each task spawn', async (t) => {
  const m = await setupMachine(t);
  writeJson(path.join(m.WS, '.claude', 'cron-up.json'), {
    model: 'claude-opus-5-5',
    tasks: { '00000002': { model: 'sonnet' } },
  });
  writeTaskFile(m.WS, [
    makeTask({ id: '00000002', prompt: '任务级模型' }),
    makeTask({ id: '00000004', prompt: '工作区模型' }),
  ]);
  await m.patrol();
  assert.equal(m.byTask.get('00000002').model, 'sonnet');
  assert.equal(m.byTask.get('00000004').model, 'claude-opus-5-5');
  assert.ok(m.patrolLogs.some((line) =>
    line.includes('任务 00000002') && line.includes('模型 sonnet')));

  // 改配置不热切换已有会话，也不借巡检重启它们。
  writeJson(path.join(m.WS, '.claude', 'cron-up.json'), {
    model: 'next-default',
    tasks: { '00000002': { model: 'next-task' } },
  });
  await m.patrol();
  assert.equal(m.spawns.length, 2);
  assert.equal(m.byTask.get('00000002').model, 'sonnet');
  assert.equal(m.byTask.get('00000004').model, 'claude-opus-5-5');
});

test('invalid workspace model config blocks new spawns without failure counts', async (t) => {
  const m = await setupMachine(t);
  writeJson(path.join(m.WS, '.claude', 'cron-up.json'), { model: '' });
  writeTaskFile(m.WS, [makeTask()]);
  await m.patrol();
  assert.equal(m.spawns.length, 0);
  assert.equal(m.bucket['00000001'], undefined);
  assert.ok(m.patrolLogs.some((line) =>
    line.includes('工作区模型配置无效') && line.includes('不会启动新的预热会话')));
});

test('cross-round reown refreshes process identity under the same session id', async (t) => {
  const m = await setupMachine(t);
  writeTaskFile(m.WS, [makeTask()]);
  await m.patrol(T0);
  const rec = m.spawns[0];
  m.claim(rec, 'sid-warm');
  await m.patrol(T0 + 1);

  // 同一 script 下的 claude 进程换了 pid，但 sessionId 保持不变。
  m.alive.delete(rec.claudePid);
  m.claim(rec, 'sid-warm');
  await m.patrol(T0 + 2);

  const stamped = fileTasks(m)[0];
  assert.equal(stamped.createdBySessionId, 'sid-warm');
  assert.equal(stamped.createdByPid, rec.claudePid);
  assert.equal(stamped.createdByProcStart, `cstart-${rec.claudePid}`);
  assert.equal(m.spawns.length, 1);
});

test('a __proto__ task id persists as an own entry without duplicate spawns', async (t) => {
  const m = await setupMachine(t, { realDiscover: true });
  writeTaskFile(m.WS, [makeTask({ id: '__proto__' })]);
  await m.patrol();
  const first = m.state();
  assert.ok(Object.hasOwn(first[m.WS], '__proto__'));
  assert.equal(first[m.WS].__proto__.pid, m.spawns[0].scriptPid);
  await m.patrol();
  assert.equal(m.spawns.length, 1, '落盘再读取后仍应复用同一代预热');
  assert.ok(Object.hasOwn(m.state()[m.WS], '__proto__'));
});

test('cooldown for one task never blocks the other task', async (t) => {
  const m = await setupMachine(t);
  // 甲永远拉不起来；乙正常。
  m.hooks.set('00000002', { failSpawn: true });
  writeTaskFile(m.WS, [
    makeTask({ id: '00000002', prompt: '甲' }),
    makeTask({ id: '00000004', prompt: '乙' }),
  ]);
  for (let i = 0; i < FAIL_LIMIT; i++) {
    await m.patrol(T0 + i);
    // 乙首轮就成功，之后不再 spawn。
    assert.equal(m.spawns.filter((r) => r.taskId === '00000004').length, 1);
  }
  const a = m.bucket['00000002'];
  const b = m.bucket['00000004'];
  assert.equal(a.fails, FAIL_LIMIT);
  assert.ok(a.cooldownUntil > T0);
  assert.equal(b.fails, 0);
  assert.ok(m.alive.has(b.pid));

  // 冷却期间甲不再尝试，乙照常活着。
  await m.patrol(T0 + 10);
  assert.equal(m.spawns.filter((r) => r.taskId === '00000002').length, 0);

  // 冷却结束：甲缓刑重试，计数清零（冷却时间戳盖在第三轮 T0+2）。
  m.hooks.delete('00000002');
  await m.patrol(T0 + COOLDOWN_SECONDS + 10);
  const a2 = m.bucket['00000002'];
  assert.equal(a2.fails, 0);
  assert.ok(m.alive.has(a2.pid));
});

test('a live creator session is fully respected: no spawn, no stamp', async (t) => {
  const m = await setupMachine(t);
  const creatorSid = 'creator-lives';
  m.addUser(creatorSid);
  writeTaskFile(m.WS, [
    makeTask({ id: '00000002', prompt: '甲', createdBySessionId: creatorSid }),
    makeTask({ id: '00000004', prompt: '乙' }), // 死主，照常预热
  ]);
  await m.patrol();
  await m.patrol(T0 + 1);
  assert.deepEqual(m.spawns.map((r) => r.taskId), ['00000004']);
  // 活创建者的任务归属一字未动。
  assert.equal(sidOf(m, '00000002'), creatorSid);
  assert.equal(fileTasks(m).find((x) => x.id === '00000002').createdByPid,
    undefined);
});

test('identical content with one live creator stamps only the dead-owner id', async (t) => {
  const m = await setupMachine(t);
  const creatorSid = 'creator-lives';
  m.addUser(creatorSid);
  const soon = cronAt(300, nowAt(T0));
  const base = { cron: soon, prompt: '完全一样', createdAt: T0 * 1000 - 1000 };
  writeTaskFile(m.WS, [
    makeTask({ id: '00000002', ...base, createdBySessionId: creatorSid }),
    makeTask({ id: '00000004', ...base, createdBySessionId: 'creator-dead' }),
  ]);
  await m.patrol();
  assert.deepEqual(m.spawns.map((r) => r.taskId), ['00000004']);
  m.claim(m.spawns[0], 'sid-dead-task');
  await m.patrol(T0 + 1);
  assert.equal(sidOf(m, '00000002'), creatorSid);
  assert.equal(fileTasks(m).find((x) => x.id === '00000002').createdByPid,
    undefined);
  assert.equal(sidOf(m, '00000004'), 'sid-dead-task');
  assert.equal(m.spawns.length, 1);
});

test('identical-content tasks with different ids stamp their own warm sessions', async (t) => {
  const m = await setupMachine(t);
  const soon = cronAt(300, nowAt(T0));
  // 同毫秒、同 prompt、同 cron，只有 id 不同：内容签名相同也不再串盖。
  const base = { cron: soon, prompt: '完全一样', createdAt: T0 * 1000 - 1000 };
  writeTaskFile(m.WS, [
    makeTask({ id: '00000002', ...base }),
    makeTask({ id: '00000004', ...base }),
  ]);
  await m.patrol();
  assert.equal(m.spawns.length, 2);
  m.claim(m.spawns[0], 'sid-A');
  m.claim(m.spawns[1], 'sid-B');
  await m.patrol(T0 + 1);
  assert.equal(sidOf(m, '00000002'), 'sid-A');
  assert.equal(sidOf(m, '00000004'), 'sid-B');
  assert.ok(m.alive.has(m.spawns[0].scriptPid));
  assert.ok(m.alive.has(m.spawns[1].scriptPid));
});

// ---- 卡死 ----

test('warmup alive but unregistered past grace is retired and respawned', async (t) => {
  const m = await setupMachine(t);
  writeTaskFile(m.WS, [makeTask()]);
  await m.patrol(T0);
  const first = m.spawns[0];
  // 宽限内：不动。
  await m.patrol(T0 + WARMUP_GRACE_SECONDS);
  assert.equal(m.spawns.length, 1);
  // 超宽限仍未认亲：杀掉并同轮重拉。
  await m.patrol(T0 + WARMUP_GRACE_SECONDS + 1);
  assert.equal(m.spawns.length, 2);
  assert.ok(!m.alive.has(first.scriptPid));
  assert.equal(m.bucket['00000001'].fails, 1);
  assert.equal(m.bucket['00000001'].pid, m.spawns[1].scriptPid);
});

test('stuck warmup with a live creator is killed but not respawned', async (t) => {
  const m = await setupMachine(t);
  const creatorSid = 'creator-lives';
  m.addUser(creatorSid);
  writeTaskFile(m.WS, [
    makeTask({ createdBySessionId: creatorSid }),
  ]);
  // 制造一个已在跟踪却没认亲的条目（外部预热垃圾）。
  const stuckPid = 900;
  m.alive.add(stuckPid);
  m.bucket['00000001'] = {
    ws: m.WS, taskId: '00000001', pid: stuckPid,
    procStart: `start-${stuckPid}`, startedAt: T0 - WARMUP_GRACE_SECONDS - 1,
    fails: 0,
  };
  await m.patrol(T0);
  assert.ok(!m.alive.has(stuckPid));
  assert.equal(m.spawns.length, 0, '活创建者可承接，不另拉');
  assert.equal(m.bucket['00000001'], undefined);
});

test('missing fingerprint makes stop return false: keep entry, warn, no respawn', async (t) => {
  const m = await setupMachine(t);
  const lines = [];
  m.deps.log = (msg) => lines.push(msg);
  writeTaskFile(m.WS, [makeTask()]);
  const pid = 900;
  m.alive.add(pid);
  m.bucket['00000001'] = {
    ws: m.WS, taskId: '00000001', pid,
    startedAt: T0 - WARMUP_GRACE_SECONDS - 1, fails: 0,
    // 旧条目没有 procStart；新版 stopSession 无法确认身份时返回 false。
  };
  const prevStop = m.deps.stopSession;
  m.deps.stopSession = async (ent) => {
    if (!ent.procStart) return false;
    return prevStop(ent);
  };
  await m.patrol(T0);
  assert.equal(m.bucket['00000001'].pid, pid);
  assert.ok(m.alive.has(pid));
  assert.equal(m.spawns.length, 0, '停止失败不能再拉重复会话');
  assert.equal(m.bucket['00000001'].fails, 0, '未停止不记启动失败');
  assert.ok(lines.some((l) => l.includes('无法安全停止')
    && l.includes('保留跟踪')));
});

// ---- resume 脱离 ----

test('resume in terminal detaches: no respawn, no kill; closes → fails reset and respawn', async (t) => {
  const m = await setupMachine(t);
  writeTaskFile(m.WS, [makeTask()]);
  await m.patrol(T0);
  const rec = m.spawns[0];
  m.claim(rec, 'sid-warm');
  await m.patrol(T0 + 1); // 盖印
  assert.equal(sidOf(m, '00000001'), 'sid-warm');

  // 用户在终端 --resume：script 死、裸 claude 持同 sid 活。
  const bare = m.resume(rec);
  await m.patrol(T0 + 2);
  assert.equal(m.spawns.length, 1, '不双开');
  assert.ok(m.alive.has(bare), '用户的裸 claude 不被杀');
  const ent = m.bucket['00000001'];
  assert.equal(ent.notified, true);
  assert.equal(ent.sessionId, 'sid-warm');

  // 多轮稳定脱离。
  await m.patrol(T0 + 3);
  assert.equal(m.spawns.length, 1);

  // 用户关闭接管会话：清零、重拉。
  m.closeResume('sid-warm');
  await m.patrol(T0 + 4);
  assert.equal(m.spawns.length, 2);
  assert.equal(m.bucket['00000001'].fails, 0);
});

// ---- window 回收（三条件按单任务）----

function recycleTask(over = {}) {
  // 远期年度任务：本代执行过，下一落点远在 margin 之外。
  return makeTask({
    id: '00000001',
    cron: '30 3 1 1 *',
    lastFiredAt: (T0 - 900) * 1000,
    ...over,
  });
}

// 手工布置一条「已认亲、本代执行过」的预热（远期任务在启动轮不在窗口，
// 走不了真实 spawn 流程，回收用例直接构造终态）。
function seedWarm(m, task, { startedAt = T0 - 1000, claimed = true,
  sid = 'sid-warm' } = {}) {
  writeTaskFile(m.WS, [task]);
  const scriptPid = 500;
  const zshPid = 501;
  const claudePid = claimed ? 502 : null;
  for (const p of [scriptPid, zshPid]) m.alive.add(p);
  if (claudePid !== null) m.alive.add(claudePid);
  const rec = {
    ws: m.WS, taskId: '00000001', scriptPid, zshPid,
    claimed, sid: claimed ? sid : null, claudePid,
  };
  m.spawns.push(rec);
  m.byTask.set('00000001', rec);
  const ent = {
    ws: m.WS,
    taskId: '00000001',
    pid: scriptPid,
    procStart: `start-${scriptPid}`,
    startedAt,
    fails: 0,
    log: sessionLogPath(m.WS, '00000001'),
  };
  if (claimed) {
    ent.sessionId = sid;
    ent.claudePid = claudePid;
    ent.claudeProcStart = `cstart-${claudePid}`;
  }
  m.bucket['00000001'] = ent;
  return rec;
}

test('recycle after fired + silent + distant next need', async (t) => {
  const m = await setupMachine(t);
  const rec = seedWarm(m, recycleTask());
  m.touchLog('00000001', SESSION_RECYCLE_IDLE_SECONDS + 10);
  await m.patrol(T0);
  assert.ok(!m.alive.has(rec.scriptPid));
  assert.equal(m.bucket['00000001'], undefined);
});

test('no recycle when this generation never fired', async (t) => {
  const m = await setupMachine(t);
  const rec = seedWarm(m,
    recycleTask({ lastFiredAt: (T0 - 5000) * 1000 }));
  m.touchLog('00000001', SESSION_RECYCLE_IDLE_SECONDS + 10);
  await m.patrol(T0);
  assert.ok(m.alive.has(rec.scriptPid));
});

test('no recycle while the session log is fresh', async (t) => {
  const m = await setupMachine(t);
  const rec = seedWarm(m, recycleTask());
  m.touchLog('00000001', 10);
  await m.patrol(T0);
  assert.ok(m.alive.has(rec.scriptPid));
});

test('no recycle inside the two-step margin before next need', async (t) => {
  const m = await setupMachine(t);
  // 近期一次性任务（窗口内、未触发）：needMs 很近。
  const rec = seedWarm(m,
    makeTask({
      recurring: false,
      cron: cronAt(60, nowAt(T0)),
      createdAt: T0 * 1000 - 3600_000,
      lastFiredAt: (T0 - 900) * 1000,
    }));
  m.touchLog('00000001', SESSION_RECYCLE_IDLE_SECONDS + 10);
  await m.patrol(T0);
  assert.ok(m.alive.has(rec.scriptPid));
});

test('unregistered spawning session is never recycled', async (t) => {
  const m = await setupMachine(t);
  const rec = seedWarm(m, recycleTask(), { claimed: false });
  m.touchLog('00000001', SESSION_RECYCLE_IDLE_SECONDS + 10, T0);
  await m.patrol(T0);
  assert.ok(m.alive.has(rec.scriptPid));
});

// ---- 任务消失 / 清空 / 损坏 ----

test('deleting one task reaps only its entry; empty file reaps the bucket', async (t) => {
  const m = await setupMachine(t);
  writeTaskFile(m.WS, [
    makeTask({ id: '00000002', prompt: '甲' }),
    makeTask({ id: '00000004', prompt: '乙' }),
  ]);
  await m.patrol();
  m.claim(m.spawns.find((r) => r.taskId === '00000002'), 'sid-A');
  m.claim(m.spawns.find((r) => r.taskId === '00000004'), 'sid-B');
  await m.patrol(T0 + 1);

  // 删甲，留乙。
  writeTaskFile(m.WS, [makeTask({ id: '00000004', prompt: '乙' })]);
  await m.patrol(T0 + 2);
  assert.ok(!m.alive.has(m.byTask.get('00000002').scriptPid));
  assert.ok(m.alive.has(m.byTask.get('00000004').scriptPid));
  assert.equal(m.bucket['00000002'], undefined);
  assert.ok(m.bucket['00000004']);

  // 清空：乙也收。
  writeTaskFile(m.WS, []);
  await m.patrol(T0 + 3);
  assert.ok(!m.alive.has(m.byTask.get('00000004').scriptPid));
  assert.deepEqual(m.bucket, {});
});

test('unreadable task file freezes every entry', async (t) => {
  const m = await setupMachine(t);
  writeTaskFile(m.WS, [makeTask()]);
  await m.patrol();
  const pid = m.spawns[0].scriptPid;
  fs.writeFileSync(m.taskfile, '{ broken');
  await m.patrol(T0 + 1);
  assert.ok(m.alive.has(pid));
  assert.ok(m.bucket['00000001']);
});

// ---- 孤儿认领 ----

test('orphan script process is adopted by its task-specific log path', async (t) => {
  const m = await setupMachine(t);
  writeTaskFile(m.WS, [makeTask()]);
  const orphanPid = 777;
  m.alive.add(orphanPid);
  const orphanLog = sessionLogPath(m.WS, '00000001');
  m.scriptProcs.push([orphanPid,
    `/usr/bin/script -q ${orphanLog} /bin/zsh -lic 'cd x && claude'`]);
  await m.patrol();
  assert.equal(m.spawns.length, 0, '认回孤儿，不新拉');
  assert.equal(m.bucket['00000001'].pid, orphanPid);
});

// ---- 病态重复任务键 ----

test('duplicate anonymous task keys are skipped with an alert', async (t) => {
  const m = await setupMachine(t);
  const lines = [];
  m.deps.log = (msg) => lines.push(msg);
  const a = makeTask({ prompt: '无 id 重复' });
  delete a.id;
  writeTaskFile(m.WS, [a, { ...a }]);
  await m.patrol();
  assert.equal(m.spawns.length, 0);
  assert.deepEqual(m.bucket, {});
  assert.ok(lines.some((l) => l.includes('任务键重复') && l.includes('anon:')));
});

// ---- 一次性错过补执行窗口 ----

test('missed one-shot task is treated as wanted', async (t) => {
  const m = await setupMachine(t);
  writeTaskFile(m.WS, [
    makeTask({
      id: '00000009',
      recurring: false,
      cron: cronAt(300, nowAt(T0 - 900)), // 落点 = 创建后 5 分钟 = 现在前 5 分钟
      createdAt: (T0 - 900) * 1000,
    }),
  ]);
  await m.patrol(T0);
  assert.deepEqual(m.spawns.map((r) => r.taskId), ['00000009']);
});

// ---- cmdRun 集成 ----

test('cmdRun end-to-end: two tasks, two sessions, nested state persisted', async (t) => {
  const m = await setupMachine(t, { realDiscover: true });
  writeTaskFile(m.WS, [
    makeTask({ id: '00000002', prompt: '甲' }),
    makeTask({ id: '00000004', prompt: '乙' }),
  ]);
  assert.equal(await m.patrol(), true);
  const st = m.state();
  assert.ok(st[m.WS]['00000002']);
  assert.ok(st[m.WS]['00000004']);
  assert.notEqual(st[m.WS]['00000002'].pid, st[m.WS]['00000004'].pid);
});

test('cmdRun: legacy flat state sessions are stopped and state replaced', async (t) => {
  const m = await setupMachine(t, { realDiscover: true });
  writeTaskFile(m.WS, [makeTask()]);
  const oldPid = 222;
  m.alive.add(oldPid);
  writeJson(m.deps.paths.statePath, {
    [m.WS]: {
      pid: oldPid, procStart: `start-${oldPid}`, startedAt: T0 - 10,
      fails: 0, log: path.join(m.deps.paths.sessionLogDir, 'old-style.log'),
    },
  });
  // ps 里还有一个 state 丢失的旧命名孤儿。
  const orphanPid = 333;
  m.alive.add(orphanPid);
  m.scriptProcs.push([orphanPid,
    `/usr/bin/script -q ${path.join(m.deps.paths.sessionLogDir, 'old-style.log')} /bin/zsh -lic x`]);
  await m.patrol();
  assert.ok(!m.alive.has(oldPid));
  assert.ok(!m.alive.has(orphanPid));
  // state 已被新形状整体替换：legacy 条目消失，新任务正常拉起。
  const st = m.state();
  assert.ok(st[m.WS]['00000001']);
  assert.equal(st[m.WS]['00000001'].pid, m.spawns[0].scriptPid);
});

test('cmdRun: failed legacy stop preserves the old state for a later retry', async (t) => {
  const m = await setupMachine(t, { realDiscover: true });
  writeTaskFile(m.WS, [makeTask()]);
  const oldPid = 222;
  m.alive.add(oldPid);
  writeJson(m.deps.paths.statePath, {
    [m.WS]: {
      pid: oldPid, procStart: `start-${oldPid}`, startedAt: T0 - 10,
      fails: 0, log: path.join(m.deps.paths.sessionLogDir, 'old-style.log'),
    },
  });
  m.deps.stopSession = async () => false;
  await m.patrol();
  const preserved = m.state();
  assert.equal(preserved[m.WS].pid, oldPid,
    '未停掉的旧条目不能被新形状状态覆盖遗忘');
});

test('cmdRun: passive death between rounds is reported with task id', async (t) => {
  const m = await setupMachine(t, { realDiscover: true });
  const lines = [];
  m.deps.log = (msg) => lines.push(msg);
  writeTaskFile(m.WS, [makeTask()]);
  await m.patrol();
  const pid = m.spawns[0].scriptPid;
  m.kill(m.spawns[0]);
  lines.length = 0;
  await m.patrol();
  assert.ok(lines.some((l) => l.includes('会话退出') && l.includes('00000001')
    && l.includes(`pid=${pid}`)));
});

// ---- cmdRun 轮内等待认亲盖印 ----

test('maintenance disappearing keeps new sessions in the same-round wait', async (t) => {
  const m = await setupMachine(t);
  writeTaskFile(m.WS, [makeTask({ id: '00000002' })]);
  const originalLoad = m.deps.loadTaskDoc;
  let loads = 0;
  m.deps.loadTaskDoc = (file) => {
    loads += 1;
    return loads === 2 ? null : originalLoad(file);
  };
  const pending = await m.patrol();
  assert.deepEqual(pending.map((p) => p.key), ['00000002']);
});

test('cmdRun: registration during in-round wait is claimed and stamped same round', async (t) => {
  const m = await setupMachine(t, { realDiscover: true });
  writeTaskFile(m.WS, [makeTask({ id: '00000002', prompt: '甲日报' })]);
  m.claimAt(() => m.byTask.get('00000002'), 1, 'sid-A');
  assert.equal(await m.patrol(), true);
  // 第 1 拍认到即收尾：一次 sleep；扫描 = 轮初 + 进入先扫 + 拍内重扫。
  assert.equal(m.polls(), 1);
  assert.equal(m.scans(), 3);
  assert.equal(sidOf(m, '00000002'), 'sid-A');
  assert.equal(fileTasks(m).find((x) => x.id === '00000002').createdByPid,
    m.byTask.get('00000002').claudePid);
  const ent = m.state()[m.WS]['00000002'];
  assert.equal(ent.sessionId, 'sid-A');
  assert.equal(ent.fails, 0);
});

test('cmdRun: unregistered warm session is waited out but not killed or counted', async (t) => {
  const m = await setupMachine(t, { realDiscover: true });
  writeTaskFile(m.WS, [makeTask({ id: '00000002' })]);
  assert.equal(await m.patrol(), true);
  // 8 拍打满：扫描 = 轮初 + 进入先扫 + 8 次重扫；进程活着、零失败、未盖印。
  assert.equal(m.polls(), 8);
  assert.equal(m.scans(), 10);
  const rec = m.byTask.get('00000002');
  assert.ok(m.alive.has(rec.scriptPid));
  assert.equal(m.spawns.length, 1);
  assert.equal(sidOf(m, '00000002'), undefined);
  const ent = m.state()[m.WS]['00000002'];
  assert.equal(ent.pid, rec.scriptPid);
  assert.equal(ent.fails, 0);
  assert.equal(ent.sessionId, undefined);
});

test('cmdRun: pending session dying during wait counts a failure and is kept', async (t) => {
  const m = await setupMachine(t, { realDiscover: true });
  const lines = [];
  m.deps.log = (msg) => lines.push(msg);
  writeTaskFile(m.WS, [makeTask({ id: '00000002' })]);
  m.killAt(() => m.byTask.get('00000002'), 2);
  assert.equal(await m.patrol(), true);
  // 第 2 拍死亡被认出后集合清空，不再睡满 8 拍；当轮不重拉。
  assert.equal(m.polls(), 2);
  assert.equal(m.spawns.length, 1);
  // 真拉起过却死掉要计一次失败：条目 pid 置空、fails=1、随 TTL 保留，
  // 下轮重拉。若丢弃，启动即崩的环境会每轮全新计数、永不冷却。
  const ent = m.state()[m.WS]['00000002'];
  assert.equal(ent.pid, null);
  assert.equal(ent.fails, 1);
  assert.equal(typeof ent.deadSince, 'number');
  // 启动后二十几秒内自然死亡仍报「会话退出」，不静默。
  assert.ok(lines.some((l) => l.includes('会话退出') && l.includes('00000002')));
});

test('cmdRun: warm sessions dying in the wait window reach cooldown in three rounds', async (t) => {
  const m = await setupMachine(t, { realDiscover: true });
  const lines = [];
  m.deps.log = (msg) => lines.push(msg);
  writeTaskFile(m.WS, [makeTask({ id: '00000002' })]);
  // 连续三轮：每轮拉起的会话都在等待期第 1 拍死亡。
  for (let round = 1; round <= 3; round += 1) {
    m.killAt(() => m.spawns[m.spawns.length - 1], 1);
    await m.patrol();
  }
  const ent = m.state()[m.WS]['00000002'];
  assert.equal(ent.fails, FAIL_LIMIT);
  assert.ok(ent.cooldownUntil > Math.floor(Date.now() / 1000));
  assert.ok(lines.some((l) => l.includes('冷却') && l.includes('00000002')));
  // 冷却期内不再拉起新会话。
  const spawnsBefore = m.spawns.length;
  await m.patrol();
  assert.equal(m.spawns.length, spawnsBefore);
});

test('cmdRun: two tasks claimed on different polls are both stamped same round', async (t) => {
  const m = await setupMachine(t, { realDiscover: true });
  writeTaskFile(m.WS, [
    makeTask({ id: '00000002', prompt: '甲' }),
    makeTask({ id: '00000004', prompt: '乙' }),
  ]);
  m.claimAt(() => m.byTask.get('00000002'), 1, 'sid-A');
  m.claimAt(() => m.byTask.get('00000004'), 3, 'sid-B');
  assert.equal(await m.patrol(), true);
  assert.equal(m.polls(), 3);
  assert.equal(sidOf(m, '00000002'), 'sid-A');
  assert.equal(sidOf(m, '00000004'), 'sid-B');
});

test('cmdRun: partial claim of identical-content tasks stamps only the claimed id', async (t) => {
  const m = await setupMachine(t, { realDiscover: true });
  const base = { cron: cronAt(300), prompt: '完全一样', createdAt: Date.now() - 1000 };
  writeTaskFile(m.WS, [
    makeTask({ id: '00000002', ...base }),
    makeTask({ id: '00000004', ...base }),
  ]);
  m.claimAt(() => m.byTask.get('00000002'), 1, 'sid-A');
  assert.equal(await m.patrol(), true);
  assert.equal(sidOf(m, '00000002'), 'sid-A');
  assert.equal(sidOf(m, '00000004'), undefined,
    '未认亲的另一条不能按内容签名跟着盖印');
  assert.equal(m.polls(), 8, '另一条仍等待到本轮预算结束');
  const st = m.state()[m.WS];
  assert.equal(st['00000002'].sessionId, 'sid-A');
  assert.equal(st['00000004'].sessionId, undefined);
});

test('cmdRun: no pending sessions means no extra scans or sleeps', async (t) => {
  const m = await setupMachine(t, { realDiscover: true });
  writeTaskFile(m.WS, []);
  assert.equal(await m.patrol(), true);
  assert.equal(m.polls(), 0);
  assert.equal(m.scans(), 1);
});

test('cmdRun: stamp write lost to a concurrent task-file change is skipped', async (t) => {
  const m = await setupMachine(t, { realDiscover: true });
  const task = makeTask({ id: '00000002', prompt: '甲日报' });
  writeTaskFile(m.WS, [task]);
  m.claimAt(() => m.byTask.get('00000002'), 1, 'sid-A');
  // 巡逻第三步是第 1 次 loadTaskDoc；盖印收尾是第 2 次——在它 stat 之后、
  // rename 之前改写文件，逼 mtime 乐观检测撞车。
  const lines = [];
  m.deps.log = (msg) => lines.push(msg);
  // loadTaskDoc 三次：巡逻 readTasks、巡逻第三步维护、盖印收尾维护。
  let loads = 0;
  const origLoad = m.deps.loadTaskDoc;
  m.deps.loadTaskDoc = (f) => {
    loads += 1;
    if (loads === 3) writeTaskFile(m.WS, [task]);
    return origLoad(f);
  };
  assert.equal(await m.patrol(), true);
  assert.ok(lines.some((l) => l.includes('盖印暂缓')));
  // 认亲回填不依赖写盘：state 已认到，但任务文件没被盖。
  assert.equal(sidOf(m, '00000002'), undefined);
  assert.equal(m.state()[m.WS]['00000002'].sessionId, 'sid-A');
});

test('cmdRun skipped when the lock is held elsewhere', async (t) => {
  const m = await setupMachine(t, { realDiscover: true });
  m.deps.acquireRunLock = () => null;
  const lines = [];
  m.deps.log = (msg) => lines.push(msg);
  assert.equal(await m.patrol(), false);
  assert.ok(lines.some((l) => l.includes('已有一轮巡检')));
});

// ---- kept 过滤：计数 TTL ----

test('dead fails counts survive within TTL and age out past it', async (t) => {
  const m = await setupMachine(t, { realDiscover: true });
  writeTaskFile(m.WS, [makeTask({ id: '00000002' })]);
  m.hooks.set('00000002', { failSpawn: true });
  await m.patrol();
  assert.equal(m.state()[m.WS]['00000002'].fails, 1);
  // 远超过 TTL：陈年计数连同条目一起老化（任务改为远期，不再在窗口内）。
  writeTaskFile(m.WS, [makeTask({
    id: '00000002', cron: '30 3 1 1 *',
  })]);
  // 手工把条目推过 TTL。
  const st = m.state();
  st[m.WS]['00000002'].deadSince = T0 - FAIL_TTL_SECONDS - 1;
  writeJson(m.deps.paths.statePath, st);
  await m.patrol();
  assert.equal(m.state()[m.WS]?.['00000002'], undefined);
});

// ---- 真实巡检锁（进程探测打桩，不发真实信号）----

function lockFixture(t) {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  const living = new Set([process.pid]);
  const starts = new Map([[process.pid, 'self-start']]);
  deps.alive = (pid) => living.has(pid);
  deps.procStartedAt = (pid) => starts.get(pid) ?? null;
  const lockPath = path.join(deps.paths.dataDir, 'run.lock');
  const writeLock = (value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    fs.writeFileSync(lockPath, text);
  };
  return { lockPath, living, starts, writeLock };
}

test('run lock enforces mutual exclusion and releases its own token', (t) => {
  const { lockPath } = lockFixture(t);
  const first = acquireRunLock();
  assert.equal(typeof first.token, 'string');
  assert.equal(acquireRunLock(), null);
  releaseRunLock(first);
  assert.equal(fs.existsSync(lockPath), false);
  const second = acquireRunLock();
  assert.ok(second);
  assert.notEqual(second.token, first.token);
  releaseRunLock(second);
  assert.equal(fs.existsSync(lockPath), false);
});

test('run lock detects an unrelated live process reusing the holder pid', (t) => {
  const { lockPath, living, starts, writeLock } = lockFixture(t);
  const pid = 4242;
  living.add(pid);
  starts.set(pid, 'replacement-process');
  writeLock({ pid, procStart: 'dead-holder', token: 'old-token' });
  const handle = acquireRunLock();
  assert.ok(handle, '指纹不同说明是 pid 复用，旧锁可回收');
  assert.ok(living.has(pid), '清锁不碰那个无关活进程');
  assert.equal(readJson(lockPath).token, handle.token);
  releaseRunLock(handle);
});

test('run lock gives a fresh empty file an initialization grace period', (t) => {
  const { lockPath, writeLock } = lockFixture(t);
  writeLock('');
  assert.equal(acquireRunLock(), null);
  assert.equal(fs.readFileSync(lockPath, 'utf-8'), '', '新空锁不能立刻被删');
  const old = new Date(Date.now() - 11_000);
  fs.utimesSync(lockPath, old, old);
  const handle = acquireRunLock();
  assert.ok(handle, '超过初始化宽限的半成品才可清理');
  releaseRunLock(handle);
});

test('run lock preserves a live legacy pid lock until its holder dies', (t) => {
  const { lockPath, living, writeLock } = lockFixture(t);
  living.add(4242);
  writeLock('4242\n');
  const old = new Date(Date.now() - 11_000);
  fs.utimesSync(lockPath, old, old); // 活旧锁即使超过无效文件宽限也不能删。
  assert.equal(acquireRunLock(), null);
  assert.equal(fs.readFileSync(lockPath, 'utf-8'), '4242\n');
  living.delete(4242);
  const handle = acquireRunLock();
  assert.ok(handle, '旧版 holder 明确死亡后才回收纯 pid 锁');
  releaseRunLock(handle);
});

test('run lock reclaims a dead holder', (t) => {
  const { writeLock } = lockFixture(t);
  writeLock({ pid: 4242, procStart: 'dead-holder', token: 'old-token' });
  const handle = acquireRunLock();
  assert.ok(handle);
  releaseRunLock(handle);
});

test('run lock keeps a live lock when process identity is unreadable', (t) => {
  const { lockPath, living, writeLock } = lockFixture(t);
  living.add(4242); // starts 故意没有当前指纹。
  writeLock({ pid: 4242, procStart: 'recorded-start', token: 'old-token' });
  assert.equal(acquireRunLock(), null);
  assert.equal(readJson(lockPath).token, 'old-token');
});

test('run lock refuses to create a lock without its own fingerprint', (t) => {
  const { lockPath, starts } = lockFixture(t);
  starts.delete(process.pid);
  assert.throws(() => acquireRunLock(), /不能安全创建巡检锁/);
  assert.equal(fs.existsSync(lockPath), false, '无指纹时不能留下未来的自锁');
});

test('releaseRunLock refuses to unlink a replacement token', (t) => {
  const { lockPath } = lockFixture(t);
  const first = acquireRunLock();
  fs.unlinkSync(lockPath);
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 4242, procStart: 'other-start', token: 'replacement-token',
  }));
  releaseRunLock(first);
  assert.equal(readJson(lockPath).token, 'replacement-token');
  releaseRunLock({ lockPath, token: 'replacement-token' });
  assert.equal(fs.existsSync(lockPath), false);
});
