import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  spawnSession,
  stopSession,
  buildChildEnv,
  sessionArgv,
  shellQuote,
  sessionLogPath,
  slugSegment,
  isTaskSessionLogName,
  trackedAlive,
} from '../src/sessions.mjs';
import { loadState } from '../src/config.mjs';
import { mkTmp, mockDeps, tmpPaths } from '../test-support/helpers.mjs';

// process.kill 是全局可变方法：每个用例显式打桩，并即使断言失败也在
// finally 里恢复，既不发真实信号，也不把桩泄漏给后续测试。
async function withMockKill(fn, kill = () => true) {
  const originalKill = process.kill;
  const calls = [];
  process.kill = (pid, signal) => {
    calls.push([pid, signal]);
    return kill(pid, signal);
  };
  try {
    return await fn(calls);
  } finally {
    process.kill = originalKill;
  }
}

// ---- 日志命名 ----

test('session log slug escapes underscores before folding slashes', (t) => {
  const deps = mockDeps(t);
  deps.paths = tmpPaths(mkTmp(t));
  assert.notEqual(sessionLogPath('/a/b', '00000001'),
    sessionLogPath('/a_b', '00000001'));
  assert.ok(sessionLogPath('/a/b', '00000001').endsWith('a_b--00000001.log'));
  assert.ok(sessionLogPath('/a_b', '00000001').endsWith('a__b--00000001.log'));
  assert.ok(sessionLogPath('/x', '00000002').endsWith('x--00000002.log'));
});

test('different tasks in one workspace get different log files', (t) => {
  const deps = mockDeps(t);
  deps.paths = tmpPaths(mkTmp(t));
  assert.notEqual(sessionLogPath('/x', '00000002'),
    sessionLogPath('/x', '00000004'));
  assert.equal(slugSegment('anon:0123456789abcdef'), 'anon:0123456789abcdef');
});

test('isTaskSessionLogName recognises only the task-level naming', () => {
  assert.equal(isTaskSessionLogName('a_b--00000001.log'), true);
  assert.equal(isTaskSessionLogName('x--abcdef01.log'), true);
  assert.equal(isTaskSessionLogName('x--anon:0123456789abcdef.log'), true);
  // 旧的目录级命名（无 -- 任务段）。
  assert.equal(isTaskSessionLogName('a_b.log'), false);
  // 轮转代、任务段形状不对、非日志后缀都不算。
  assert.equal(isTaskSessionLogName('x--00000001.log.1'), false);
  assert.equal(isTaskSessionLogName('x--0000001.log'), false);
  assert.equal(isTaskSessionLogName('x--zzzzzzzz.log'), false);
  assert.equal(isTaskSessionLogName('x--00000001'), false);
});

// ---- spawn ----

test('spawn: child env marked and claude markers stripped', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  deps.procStartedAt = () => 'start';
  let captured;
  deps.spawn = (file, args, opts) => {
    captured = { file, args, opts };
    return { pid: 4242, on() {}, unref() {} };
  };
  process.env.CLAUDE_CODE_CHILD_SESSION = 'parent-sid';
  process.env.CLAUDE_CODE_OTHER = 'x';
  t.after(() => {
    delete process.env.CLAUDE_CODE_CHILD_SESSION;
    delete process.env.CLAUDE_CODE_OTHER;
  });
  const ws = path.join(tmp, 'proj');
  fs.mkdirSync(ws);
  const log = sessionLogPath(ws, '00000001');
  const { pid, procStart } = spawnSession(ws, '00000001');
  assert.equal(pid, 4242);
  assert.equal(procStart, 'start');
  assert.equal(captured.file, '/usr/bin/script');
  assert.deepEqual(captured.args.slice(0, 2), ['-q', log]);
  assert.equal(captured.opts.detached, true);
  assert.equal(captured.opts.stdio, 'ignore');
  assert.equal(captured.opts.cwd, ws);
  assert.equal(captured.opts.env.CRON_UP_SESSION, '1');
  assert.equal('CLAUDE_CODE_CHILD_SESSION' in captured.opts.env, false);
  assert.ok(!Object.keys(captured.opts.env)
    .some((k) => k.startsWith('CLAUDE_CODE_')));
  // typescript 被预创建为 0600。
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  // 父进程环境未被污染。
  assert.ok('CLAUDE_CODE_CHILD_SESSION' in process.env);
});

test('spawn that never started returns null, not a pid-less record', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  // 拉不起来（如解释器缺失）时 child.pid 是 undefined：调用方拿到的应是
  // null，好按启动失败计数，而不是把 pid=undefined 写进 state。
  deps.spawn = () => ({ pid: undefined, on() {}, unref() {} });
  const ws = path.join(tmp, 'proj');
  fs.mkdirSync(ws);
  assert.equal(spawnSession(ws, '00000001'), null);
});

test('spawn without a process fingerprint cleans only the new process group',
  async (t) => {
    const tmp = mkTmp(t);
    const deps = mockDeps(t);
    deps.paths = tmpPaths(tmp);
    deps.procStartedAt = () => null;
    deps.spawn = () => ({ pid: 4242, on() {}, unref() {} });
    const logged = [];
    deps.log = (msg) => logged.push(msg);
    const ws = path.join(tmp, 'proj');
    fs.mkdirSync(ws);
    await withMockKill(async (calls) => {
      assert.equal(spawnSession(ws, '00000001'), null);
      assert.deepEqual(calls, [[-4242, 'SIGTERM']]);
      assert.equal(logged.length, 1);
      assert.ok(logged[0].includes('未读到进程身份指纹'));
      assert.ok(logged[0].includes('已向刚拉起的进程组发送 SIGTERM'));
    });
  });

test('spawn fingerprint cleanup failure is logged with the real error',
  async (t) => {
    const tmp = mkTmp(t);
    const deps = mockDeps(t);
    deps.paths = tmpPaths(tmp);
    deps.procStartedAt = () => null;
    deps.spawn = () => ({ pid: 4242, on() {}, unref() {} });
    const logged = [];
    deps.log = (msg) => logged.push(msg);
    const ws = path.join(tmp, 'proj');
    fs.mkdirSync(ws);
    await withMockKill(async (calls) => {
      assert.equal(spawnSession(ws, '00000001'), null);
      assert.deepEqual(calls, [[-4242, 'SIGTERM']]);
      assert.equal(logged.length, 1);
      assert.ok(logged[0].includes('清理刚拉起的进程组失败'));
      assert.ok(logged[0].includes('EPERM'));
    }, () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
  });

test('spawn fingerprint cleanup never signals an unsafe pid', async (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  deps.procStartedAt = () => null;
  deps.spawn = () => ({ pid: 1, on() {}, unref() {} });
  const logged = [];
  deps.log = (msg) => logged.push(msg);
  const ws = path.join(tmp, 'proj');
  fs.mkdirSync(ws);
  await withMockKill(async (calls) => {
    assert.equal(spawnSession(ws, '00000001'), null);
    assert.deepEqual(calls, []);
    assert.equal(logged.length, 1);
    assert.ok(logged[0].includes('未发信号'));
  });
});

test('async spawn error is logged with workspace and task id', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  deps.procStartedAt = () => 'start';
  let onError;
  deps.spawn = () => ({
    pid: 4242,
    on(event, fn) { if (event === 'error') onError = fn; },
    unref() {},
  });
  const logged = [];
  deps.log = (msg) => logged.push(msg);
  const ws = path.join(tmp, 'proj');
  fs.mkdirSync(ws);
  spawnSession(ws, '00000004');
  assert.equal(typeof onError, 'function');
  onError(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  assert.equal(logged.length, 1);
  assert.ok(logged[0].includes('ENOENT'));
  assert.ok(logged[0].includes(ws));
  assert.ok(logged[0].includes('00000004'), '日志带任务 id');
});

test('spawn rotates the previous generation log to .1 per task', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  deps.procStartedAt = () => 'start';
  deps.spawn = () => ({ pid: 4242, on() {}, unref() {} });
  const ws = path.join(tmp, 'proj');
  fs.mkdirSync(ws);
  const log = sessionLogPath(ws, '00000001');
  spawnSession(ws, '00000001');
  // script(1) 打开即截断：不轮转的话，上一次执行的界面记录会随本次拉起
  // 被抹掉。
  fs.writeFileSync(log, '上一代的界面记录\n');
  spawnSession(ws, '00000001');
  assert.equal(fs.readFileSync(`${log}.1`, 'utf-8'), '上一代的界面记录\n');
});

test('two tasks spawned in one workspace keep independent logs', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  deps.procStartedAt = () => 'start';
  let n = 0;
  deps.spawn = () => ({ pid: ++n + 4000, on() {}, unref() {} });
  const ws = path.join(tmp, 'proj');
  fs.mkdirSync(ws);
  spawnSession(ws, '00000002');
  spawnSession(ws, '00000004');
  const a = sessionLogPath(ws, '00000002');
  const b = sessionLogPath(ws, '00000004');
  assert.notEqual(a, b);
  assert.equal(fs.statSync(a).mode & 0o777, 0o600);
  assert.equal(fs.statSync(b).mode & 0o777, 0o600);
});

test('buildChildEnv is a pure function', () => {
  const env = { CLAUDE_CODE_X: '1', KEEP: '2' };
  const out = buildChildEnv(env);
  assert.equal(out.CRON_UP_SESSION, '1');
  assert.equal('CLAUDE_CODE_X' in out, false);
  assert.equal(out.KEEP, '2');
  assert.equal('CLAUDE_CODE_X' in env, true); // 输入不被改
});

test('session argv quotes the workspace and sets unattended permission mode', () => {
  const argv = sessionArgv('/Users/aex/My Proj', '/tmp/x.log');
  assert.deepEqual(argv, [
    '/usr/bin/script', '-q', '/tmp/x.log',
    '/bin/zsh', '-lic',
    "cd '/Users/aex/My Proj' && claude --permission-mode bypassPermissions",
  ]);
});

test('shellQuote keeps the safe set bare and single-quotes the rest', () => {
  assert.equal(shellQuote(''), "''");
  assert.equal(shellQuote('abc-def.g'), 'abc-def.g');
  assert.equal(shellQuote('a b'), "'a b'");
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
});

// ---- stop ----

test('stop: a tracked session exits after SIGTERM', async (t) => {
  const deps = mockDeps(t);
  let living = true;
  deps.alive = () => living;
  deps.procStartedAt = () => 'start';
  let sleeps = 0;
  deps.sleep = async (ms) => {
    sleeps++;
    assert.equal(ms, 100);
  };
  await withMockKill(async (calls) => {
    assert.equal(await stopSession({ pid: 4242, procStart: 'start' }), true);
    assert.deepEqual(calls, [[-4242, 'SIGTERM']]);
    assert.equal(sleeps, 1);
  }, (pid, signal) => {
    if (signal === 'SIGTERM') living = false;
    return true;
  });
});

test('stop: a tracked session that ignores SIGTERM gets SIGKILL', async (t) => {
  const deps = mockDeps(t);
  let living = true;
  deps.alive = () => living;
  deps.procStartedAt = () => 'start';
  let sleeps = 0;
  deps.sleep = async (ms) => {
    sleeps++;
    assert.equal(ms, 100);
  };
  await withMockKill(async (calls) => {
    assert.equal(await stopSession({ pid: 4242, procStart: 'start' }), true);
    assert.deepEqual(calls, [
      [-4242, 'SIGTERM'],
      [-4242, 'SIGKILL'],
    ]);
    assert.equal(sleeps, 21);
  }, (pid, signal) => {
    if (signal === 'SIGKILL') living = false;
    return true;
  });
});

test('stop: SIGTERM failure keeps the entry marked as not stopped', async (t) => {
  const deps = mockDeps(t);
  deps.alive = () => true;
  deps.procStartedAt = () => 'start';
  deps.sleep = async () => {
    throw new Error('failed SIGTERM must not enter the wait loop');
  };
  await withMockKill(async (calls) => {
    assert.equal(await stopSession({ pid: 4242, procStart: 'start' }), false);
    assert.deepEqual(calls, [[-4242, 'SIGTERM']]);
  }, () => {
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  });
});

test('stop: surviving SIGKILL is not reported as stopped', async (t) => {
  const deps = mockDeps(t);
  deps.alive = () => true;
  deps.procStartedAt = () => 'start';
  deps.sleep = async () => {};
  await withMockKill(async (calls) => {
    assert.equal(await stopSession({ pid: 4242, procStart: 'start' }), false);
    assert.deepEqual(calls, [
      [-4242, 'SIGTERM'],
      [-4242, 'SIGKILL'],
    ]);
  });
});

test('stop: dead or detached sessions need no signals', async (t) => {
  const deps = mockDeps(t);
  let living = false;
  deps.alive = () => living;
  deps.procStartedAt = () => 'other';
  deps.sleep = async () => {
    throw new Error('dead or detached sessions must not wait');
  };
  await withMockKill(async (calls) => {
    const ent = { pid: 4242, procStart: 'start' };
    assert.equal(await stopSession(ent), true, '已死');
    living = true;
    assert.equal(await stopSession(ent), true, '已脱离');
    assert.deepEqual(calls, []);
  });
});

test('stop: unsafe pids return without any process operation', async (t) => {
  const deps = mockDeps(t);
  deps.alive = () => {
    throw new Error('unsafe pids must not be probed');
  };
  deps.trackedAlive = () => {
    throw new Error('unsafe pids must not be identity-checked');
  };
  deps.sleep = async () => {
    throw new Error('unsafe pids must not wait');
  };
  await withMockKill(async (calls) => {
    for (const pid of [1, 1.5, -4242, 0]) {
      assert.equal(await stopSession({ pid, procStart: 'start' }), true,
        `pid=${pid}`);
    }
    assert.deepEqual(calls, []);
  });
});

test('stop: a live legacy entry without a fingerprint is not signalled',
  async (t) => {
    const deps = mockDeps(t);
    deps.alive = () => true;
    deps.sleep = async () => {
      throw new Error('an unidentified live process must not wait');
    };
    await withMockKill(async (calls) => {
      const ent = { pid: 4242 };
      assert.equal(trackedAlive(ent), true, '旧条目仍兼容 kill -0 读取');
      assert.equal(await stopSession(ent), false);
      assert.deepEqual(calls, []);
    });
  });

test('stop: a dead legacy entry without a fingerprint needs no action',
  async (t) => {
    const deps = mockDeps(t);
    deps.alive = () => false;
    deps.sleep = async () => {
      throw new Error('a dead process must not wait');
    };
    await withMockKill(async (calls) => {
      const ent = { pid: 4242 };
      assert.equal(trackedAlive(ent), false);
      assert.equal(await stopSession(ent), true);
      assert.deepEqual(calls, []);
    });
  });

// ---- 嵌套 state 的清洗 ----

test('nested state: hand-edited numeric fields are sanitised per entry', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  fs.writeFileSync(deps.paths.statePath,
    '{"/a": {"00000001": {"pid": "123", "startedAt": "456", '
    + '"cooldownUntil": "789", "fails": 2, "sessionId": "s1"}, '
    + '"00000002": {"pid": [1], "fails": 1, "cooldownUntil": "abc"}}, '
    + '"/c": {"00000003": {"pid": -5}}, '
    + '"/d": {"00000004": {"pid": 100000000000000000000}}, '
    + '"/e": {"00000005": {"pid": 1.5}}}');
  const st = loadState();
  assert.equal(st['/a']['00000001'].pid, 123);
  assert.equal(st['/a']['00000001'].startedAt, 456);
  assert.equal(st['/a']['00000001'].cooldownUntil, 789);
  assert.equal(st['/a']['00000001'].sessionId, 's1');
  // 键回填 ws/taskId。
  assert.equal(st['/a']['00000001'].ws, '/a');
  assert.equal(st['/a']['00000001'].taskId, '00000001');
  // 数组 pid 落空；坏 cooldownUntil 删掉。
  assert.equal(st['/a']['00000002'].pid, null);
  assert.equal('cooldownUntil' in st['/a']['00000002'], false);
  // 非法 pid 落空。
  assert.equal(st['/c']['00000003'].pid, null);
  assert.equal(st['/d']['00000004'].pid, null);
  // pid 入口拒绝浮点，不截成另一个进程编号。
  assert.equal(st['/e']['00000005'].pid, null);
});

test('nested state: bad buckets and bad entries are dropped', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  fs.writeFileSync(deps.paths.statePath,
    '{"top": "junk", '
    + '"/a": "not-a-bucket", '
    + '"/b": {"00000001": "junk-entry", "00000002": {"pid": 1}}, '
    + '"/empty": {}, '
    + '"/c": {"00000003": null}}');
  const st = loadState();
  assert.equal('top' in st, false);
  assert.equal('/a' in st, false);
  assert.deepEqual(Object.keys(st['/b']), ['00000002']);
  assert.equal('/empty' in st, false, '空桶整个丢弃');
  assert.equal('/c' in st, false, '桶内条目全坏 → 桶丢弃');
});

test('nested state sanitisation never throws at trackedAlive call sites', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  fs.writeFileSync(deps.paths.statePath,
    '{" /a": {"00000001": {"pid": "123", "procStart": "x", "fails": 2}, '
    + '"00000002": {"pid": 505, "sessionId": 42}}}');
  const st = loadState();
  const cur = Math.floor(Date.now() / 1000);
  for (const bucket of Object.values(st)) {
    for (const ent of Object.values(bucket)) {
      assert.equal(typeof trackedAlive(ent), 'boolean'); // 不许抛
      assert.equal(typeof ((ent.cooldownUntil ?? 0) > cur), 'boolean');
    }
  }
  // 非字符串 sessionId 被清洗。
  assert.equal('sessionId' in st[' /a']['00000002'], false);
});

test('damaged or missing nested state reads as empty', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  assert.deepEqual(loadState(), {});
  for (const text of ['[]', 'null', '42', '"text"', '{ truncated']) {
    fs.writeFileSync(deps.paths.statePath, text);
    assert.deepEqual(loadState(), {}, text);
  }
});
