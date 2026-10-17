import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  normalizeRoots,
  loadConfig,
  loadState,
  loadLegacyEntries,
  saveState,
  validateConfig,
  configFieldErrors,
  isCooling,
  cooldownEtaMinutes,
  heartbeatStale,
  loadHeartbeat,
  saveHeartbeat,
} from '../src/config.mjs';
import { discover, onDiskCase } from '../src/tasks.mjs';
import { ExitError } from '../src/internals.mjs';
import { mkTmp, mockDeps, tmpPaths, writeJson } from '../test-support/helpers.mjs';

// ---- roots 规范化 ----

test('roots normalised despite shell tilde quirks', (t) => {
  const deps = mockDeps(t);
  deps.paths = { home: '/home/u' }; // 本条只测 tilde 规范化
  assert.deepEqual(normalizeRoots(['/home/u/a', '~/b']),
    ['/home/u/a', '/home/u/b']);
  assert.deepEqual(normalizeRoots(['~/x', '', '  ']), ['/home/u/x']);
  assert.deepEqual(normalizeRoots(['/abs/path/']), ['/abs/path']);
  assert.deepEqual(normalizeRoots(['~/x', 5, null, ['y']]), ['/home/u/x']);
});

// ---- validateConfig：只剩 roots 空、roots 不存在两条 ----

test('validateConfig warns on empty roots and missing dirs only', () => {
  const w1 = validateConfig({ roots: [] }, () => {});
  assert.ok(w1.some((w) => w.includes('roots')));

  const w2 = validateConfig({ roots: ['/nonexistent/path/xyz'] }, () => {});
  assert.ok(w2.some((w) => w.includes('不存在')));

  assert.deepEqual(validateConfig({ roots: ['/tmp'] }), []);
  assert.deepEqual(validateConfig({ roots: [] }, () => {}).length, 1);

  // 旧版本的间隔/提前量字段不再被读取：带在配置里也不产生警告。
  const w3 = validateConfig(
    { roots: ['/tmp'], intervalSeconds: 300, leadSeconds: 60 }, () => {});
  assert.deepEqual(w3, []);
});

test('validateConfig announces each warning', () => {
  const announced = [];
  validateConfig({ roots: [] }, (m) => announced.push(m));
  assert.equal(announced.length, 1);
  assert.ok(announced[0].includes('roots'));
});

// ---- discover 深度常量化 ----

test('discover recovers the on-disk case of a root', (t) => {
  const tmp = mkTmp(t);
  const ws = path.join(tmp, 'MyProj');
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  writeJson(path.join(ws, '.claude', 'scheduled_tasks.json'), { tasks: [] });
  const typed = path.join(tmp, 'myproj');
  if (!fs.existsSync(typed)) t.skip('大小写敏感的文件系统上无法构造该场景');
  assert.deepEqual([...discover([typed])].map(([w]) => w),
    [fs.realpathSync(ws)]);
});

test('on-disk case passes missing paths through', () => {
  assert.equal(onDiskCase('/nonexistent/xyz/abc'), '/nonexistent/xyz/abc');
});

// ---- 配置文件的坏形状 ----

test('corrupt json exits cleanly', (t) => {
  const tmp = mkTmp(t);
  const file = path.join(tmp, 'cfg.json');
  fs.writeFileSync(file, '{ not valid json');
  assert.throws(() => loadConfig(file), (e) => {
    assert.ok(e instanceof ExitError);
    assert.equal(e.code, 2);
    return true;
  });
});

test('corrupt json can be raised for human pages', (t) => {
  const tmp = mkTmp(t);
  const file = path.join(tmp, 'cfg.json');
  fs.writeFileSync(file, '{ not valid json');
  assert.throws(() => loadConfig(file, { corruptOk: true }), SyntaxError);
});

test('non-object json config exits legibly', (t) => {
  const tmp = mkTmp(t);
  for (const content of ['123', '["a", "b"]', '"text"']) {
    const file = path.join(tmp, `cfg-${content.length}.json`);
    fs.writeFileSync(file, content);
    assert.throws(() => loadConfig(file), (e) => {
      assert.ok(e instanceof ExitError);
      assert.equal(e.code, 2);
      return true;
    }, content);
  }
});

test('non-object json config is corrupt for human pages', (t) => {
  const tmp = mkTmp(t);
  const file = path.join(tmp, 'cfg.json');
  fs.writeFileSync(file, '123');
  assert.throws(() => loadConfig(file, { corruptOk: true }), /JSON 对象/);
});

test('missing config exits cleanly for launchd', () => {
  assert.throws(
    () => loadConfig('/nonexistent/cron-up-config.json'),
    (e) => e instanceof ExitError && e.code === 2);
});

test('overview sees a missing config as absent', () => {
  assert.throws(
    () => loadConfig('/nonexistent/cron-up-config.json', { missingOk: true }),
    (e) => e.code === 'ENOENT');
});

// ---- roots 是唯一被校验的字段，其余键静默忽略 ----

test('string roots is rejected loudly', (t) => {
  const tmp = mkTmp(t);
  mockDeps(t);
  const file = path.join(tmp, 'cfg.json');
  writeJson(file, { roots: '~/single-string' });
  assert.throws(() => loadConfig(file), (e) => {
    assert.ok(e instanceof ExitError);
    assert.equal(e.code, 2);
    assert.ok(e.message.includes('roots'));
    return true;
  });
});

test('roots non-array variants are all rejected', (t) => {
  const tmp = mkTmp(t);
  mockDeps(t);
  for (const bad of [5, true, { x: 1 }, null]) {
    const file = path.join(tmp, `cfg-${String(bad)}.json`);
    writeJson(file, { roots: bad });
    assert.throws(() => loadConfig(file), (e) => {
      assert.ok(e instanceof ExitError);
      assert.equal(e.code, 2);
      assert.ok(e.message.includes('roots'));
      return true;
    }, String(bad));
  }
});

test('legacy keys are silently ignored and absent from the returned config', (t) => {
  const tmp = mkTmp(t);
  mockDeps(t);
  const file = path.join(tmp, 'cfg.json');
  writeJson(file, {
    roots: ['/tmp'],
    intervalSeconds: 999,
    leadSeconds: 1,
    maxDepth: 9,
    autoRenew: false,
    autoMinId: false,
    sessionRetain: 'always',
    stampOwner: false,
    unknownExtra: 'kept-or-not-we-do-not-care',
  });
  assert.deepEqual(loadConfig(file), { roots: ['/tmp'] });
});

test('config without roots falls back to defaults', (t) => {
  const tmp = mkTmp(t);
  mockDeps(t);
  const file = path.join(tmp, 'cfg.json');
  writeJson(file, {});
  const cfg = loadConfig(file);
  assert.ok(Array.isArray(cfg.roots));
  assert.deepEqual(Object.keys(cfg).sort(), ['roots']);
});

test('roots type error can be raised as a plain error for human pages', (t) => {
  const tmp = mkTmp(t);
  mockDeps(t);
  const file = path.join(tmp, 'cfg.json');
  writeJson(file, { roots: 'not-an-array' });
  assert.throws(() => loadConfig(file, { corruptOk: true }),
    (e) => e instanceof Error && !(e instanceof ExitError)
      && e.message.includes('roots'));
});

test('configFieldErrors only looks at roots', () => {
  assert.deepEqual(configFieldErrors({ roots: ['/a'] }), []);
  assert.equal(configFieldErrors({ roots: [] }).length, 0);
  assert.equal(configFieldErrors({ roots: 'x' }).length, 1);
  assert.equal(configFieldErrors({ roots: 5 }).length, 1);
});

// ---- state.json：两级嵌套 ----

test('damaged state shapes read as empty', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  for (const text of ['[]', 'null', '42', '"text"', '{ truncated']) {
    fs.writeFileSync(deps.paths.statePath, text);
    assert.deepEqual(loadState(), {}, text);
    assert.deepEqual(loadLegacyEntries(), [], text);
  }
});

test('missing state file reads as empty', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  assert.deepEqual(loadState(), {});
  assert.deepEqual(loadLegacyEntries(), []);
});

test('nested state: non-dict buckets and entries are dropped', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  fs.writeFileSync(deps.paths.statePath, JSON.stringify({
    '/a': { '00000001': { pid: 1 }, 'bad': 'junk', 'nul': null },
    '/b': 'junk',
    '/c': null,
    '/empty': {},
  }));
  assert.deepEqual(loadState(), {
    '/a': { '00000001': { pid: 1, ws: '/a', taskId: '00000001' } },
  });
});

test('nested state: fields are sanitised and ws/taskId forced from keys', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  fs.writeFileSync(deps.paths.statePath, JSON.stringify({
    '/a': {
      '00000002': {
        pid: '123', startedAt: '456', cooldownUntil: '789', fails: 2,
        claudePid: '100', sessionId: 'sid-1', log: '/l',
        procStart: 'Mon Jan 1 00:00:00 2026',
        claudeProcStart: 'Tue Jan 2 00:00:00 2026',
        notified: true, deadSince: 55,
      },
    },
    '/b': {
      // 坏值字段该删的删：非法 pid→null、非法 claudePid→删字段、布尔冒
      // 充整型→删字段、空串/非字符串身份字段→删字段、notified 非布尔→删。
      '00000003': {
        pid: -5, claudePid: 'abc', startedAt: true, fails: 1.7,
        sessionId: '', log: 9, procStart: '', notified: 'yes',
      },
    },
  }));
  const st = loadState();
  const a = st['/a']['00000002'];
  assert.equal(a.pid, 123);
  assert.equal(a.startedAt, 456);
  assert.equal(a.cooldownUntil, 789);
  assert.equal(a.fails, 2);
  assert.equal(a.claudePid, 100);
  assert.equal(a.sessionId, 'sid-1');
  assert.equal(a.log, '/l');
  assert.equal(a.deadSince, 55);
  assert.equal(a.notified, true);
  assert.equal(a.ws, '/a');
  assert.equal(a.taskId, '00000002');
  const b = st['/b']['00000003'];
  assert.equal(b.pid, null);
  assert.equal('claudePid' in b, false);
  assert.equal('startedAt' in b, false);
  assert.equal(Math.trunc(b.fails), 1);
  assert.equal('sessionId' in b, false);
  assert.equal('log' in b, false);
  assert.equal('procStart' in b, false);
  assert.equal('notified' in b, false);
  assert.equal(b.ws, '/b');
  assert.equal(b.taskId, '00000003');
});

test('oversized pid and float pid are sanitised in nested state', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  fs.writeFileSync(deps.paths.statePath, JSON.stringify({
    '/a': {
      '00000001': { pid: 100000000000000000000 },
      '00000002': { pid: 1.5 },
    },
  }));
  const st = loadState();
  assert.equal(st['/a']['00000001'].pid, null);
  assert.equal(st['/a']['00000002'].pid, 1);
});

// ---- 旧版扁平 state：loadState 与 loadLegacyEntries 互斥 ----

test('new nested and legacy flat shapes are mutually exclusive across loaders', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);

  // 新形状：state 有内容，legacy 为空。
  writeJson(deps.paths.statePath, {
    '/ws': {
      '00000001': { pid: 111, procStart: 's1', startedAt: 1, fails: 0 },
      '00000002': { pid: 222, procStart: 's2', startedAt: 2, fails: 0 },
    },
  });
  const fresh = loadState();
  assert.deepEqual(Object.keys(fresh['/ws']).sort(),
    ['00000001', '00000002']);
  assert.deepEqual(loadLegacyEntries(), []);

  // 旧形状：state 为空，legacy 读出两条，ws 补回、taskId 删除。
  writeJson(deps.paths.statePath, {
    '/ws': { pid: 111, procStart: 's1', startedAt: 1, fails: 0 },
    '/ws2': { pid: null, cooldownUntil: 999, fails: 3 },
  });
  assert.deepEqual(loadState(), {});
  const legacy = loadLegacyEntries();
  assert.equal(legacy.length, 2);
  const byWs = Object.fromEntries(legacy.map((e) => [e.ws, e]));
  assert.equal(byWs['/ws'].pid, 111);
  assert.equal(byWs['/ws'].ws, '/ws');
  assert.equal('taskId' in byWs['/ws'], false);
  assert.equal(byWs['/ws2'].pid, null);
  assert.equal(byWs['/ws2'].cooldownUntil, 999);
  assert.equal(byWs['/ws2'].fails, 3);
});

test('legacy markers: any of pid/startedAt/cooldownUntil/fails flags a flat entry', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  writeJson(deps.paths.statePath, {
    '/a': { startedAt: 7 },
    '/b': { cooldownUntil: 0 },
    '/c': { fails: 0 },
    // 新形状桶：内层 taskId 条目带标记不影响顶层判定。
    '/d': { '00000001': { pid: 1 } },
  });
  const legacy = loadLegacyEntries().map((e) => e.ws).sort();
  assert.deepEqual(legacy, ['/a', '/b', '/c']);
  assert.deepEqual(Object.keys(loadState()), ['/d']);
});

// ---- 保存权限 ----

test('state saves as 0600 inside a 0700 data dir', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  // tmpPaths 建出的 dataDir 是默认 0755，正好代表老版本留下的宽松目录。
  deps.paths = tmpPaths(tmp);
  saveState({ '/a': { '00000001': { pid: 1, fails: 0 } } });
  assert.equal(fs.statSync(deps.paths.statePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(deps.paths.dataDir).mode & 0o777, 0o700);
});

// ---- 心跳 ----

test('heartbeat round-trips, and missing or broken files read as null', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  assert.equal(loadHeartbeat(), null, '尚无心跳文件');
  saveHeartbeat({ ranAt: 123 });
  assert.equal(loadHeartbeat().ranAt, 123);
  writeJson(deps.paths.heartbeatPath, { noRanAt: true });
  assert.equal(loadHeartbeat(), null, '形状不对按没有心跳处理');
  fs.writeFileSync(deps.paths.heartbeatPath, '{ half');
  assert.equal(loadHeartbeat(), null, '半截 JSON 按没有心跳处理');
});

test('heartbeat saves as 0600', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  saveHeartbeat({ ranAt: 1 });
  assert.equal(fs.statSync(deps.paths.heartbeatPath).mode & 0o777, 0o600);
});

test('heartbeatStale compares ranAt against factor of the interval', () => {
  assert.equal(heartbeatStale({ ranAt: 100 }, 300, 1000), true);
  assert.equal(heartbeatStale({ ranAt: 900 }, 300, 1000), false);
  assert.equal(heartbeatStale(null, 300, 1000), false);
});

// ---- 冷却谓词 ----

test('isCooling and cooldownEtaMinutes read cooldownUntil', () => {
  assert.equal(isCooling({ cooldownUntil: 100 }, 99), true);
  assert.equal(isCooling({ cooldownUntil: 100 }, 100), false);
  assert.equal(isCooling(null, 100), false);
  assert.equal(isCooling({}, 100), false);
  assert.equal(cooldownEtaMinutes({ cooldownUntil: 725 }, 100), 10);
  assert.equal(cooldownEtaMinutes({ cooldownUntil: 50 }, 100), 0);
});
