// 翻译自 Python ConfigTests / ValidationTests / StateFileTests（trackedAlive
// 相关的一条在 sessions 模块就绪后于 state 测试中补齐）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  normalizeRoots,
  loadConfig,
  loadState,
  validateConfig,
} from '../src/config.mjs';
import { discover, onDiskCase } from '../src/tasks.mjs';
import { ExitError } from '../src/internals.mjs';
import { DEFAULT_CONFIG } from '../src/constants.mjs';
import { mkTmp, mockDeps, tmpPaths, writeJson } from '../test-support/helpers.mjs';

test('roots normalised despite shell tilde quirks', (t) => {
  const deps = mockDeps(t);
  deps.paths = { home: '/home/u' }; // 本条只测 tilde 规范化
  assert.deepEqual(normalizeRoots(['/home/u/a', '~/b']),
    ['/home/u/a', '/home/u/b']);
  assert.deepEqual(normalizeRoots(['~/x', '', '  ']), ['/home/u/x']);
  assert.deepEqual(normalizeRoots(['/abs/path/']), ['/abs/path']);
  assert.deepEqual(normalizeRoots(['~/x', 5, null, ['y']]), ['/home/u/x']);
});

test('validateConfig warnings', () => {
  const w1 = validateConfig(
    { intervalSeconds: 300, leadSeconds: 60, roots: [] }, () => {});
  assert.ok(w1.some((w) => w.includes('leadSeconds')));

  const w2 = validateConfig(
    { intervalSeconds: 300, leadSeconds: 600, roots: ['/nonexistent/path/xyz'] },
    () => {});
  assert.ok(w2.some((w) => w.includes('不存在')));

  assert.deepEqual(
    validateConfig({ intervalSeconds: 300, leadSeconds: 600, roots: ['/tmp'] }),
    []);

  const w4 = validateConfig(
    { intervalSeconds: 300, leadSeconds: 600, roots: [] }, () => {});
  assert.ok(w4.some((w) => w.includes('roots')));
});

test('discover recovers the on-disk case of a root', (t) => {
  const tmp = mkTmp(t);
  const ws = path.join(tmp, 'MyProj');
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  writeJson(path.join(ws, '.claude', 'scheduled_tasks.json'), { tasks: [] });
  const typed = path.join(tmp, 'myproj');
  if (!fs.existsSync(typed)) t.skip('大小写敏感的文件系统上无法构造该场景');
  assert.deepEqual([...discover([typed], 2)].map(([w]) => w),
    [fs.realpathSync(ws)]);
});

test('on-disk case passes missing paths through', () => {
  assert.equal(onDiskCase('/nonexistent/xyz/abc'), '/nonexistent/xyz/abc');
});

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
    () => loadConfig('/nonexistent/cron-ready-config.json'),
    (e) => e instanceof ExitError && e.code === 2);
});

test('overview sees a missing config as absent', () => {
  assert.throws(
    () => loadConfig('/nonexistent/cron-ready-config.json', { missingOk: true }),
    (e) => e.code === 'ENOENT');
});

test('string roots falls back to default', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp, { home: tmp });
  const file = path.join(tmp, 'cfg.json');
  writeJson(file, { roots: '~/single-string' });
  const cfg = loadConfig(file);
  assert.ok(Array.isArray(cfg.roots));
  assert.ok(!cfg.roots.join('').includes('~'));
});

test('bool maxdepth is coerced to default', (t) => {
  const tmp = mkTmp(t);
  mockDeps(t);
  const file = path.join(tmp, 'cfg.json');
  writeJson(file, { maxDepth: true });
  assert.equal(loadConfig(file).maxDepth, DEFAULT_CONFIG.maxDepth);
});

// ---- state ----

test('damaged state shapes read as empty', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  for (const text of ['[]', 'null', '42', '"text"', '{ truncated']) {
    fs.writeFileSync(deps.paths.statePath, text);
    assert.deepEqual(loadState(), {}, text);
  }
});

test('non-dict state entries are dropped', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  fs.writeFileSync(deps.paths.statePath,
    '{"/a": {"pid": 1}, "/b": "junk", "/c": null}');
  assert.deepEqual(loadState(), { '/a': { pid: 1 } });
});

test('hand-edited numeric fields are sanitised', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  fs.writeFileSync(deps.paths.statePath,
    '{"/a": {"pid": "123", "startedAt": "456", '
    + '"cooldownUntil": "789", "fails": 2}, '
    + '"/b": {"pid": [1], "fails": 1, "cooldownUntil": "abc"}, '
    + '"/c": {"pid": -5}, '
    + '"/d": {"pid": 100000000000000000000}, '
    + '"/e": {"pid": 1.5}}');
  const st = loadState();
  assert.equal(st['/a'].pid, 123);
  assert.equal(st['/a'].startedAt, 456);
  assert.equal(st['/a'].cooldownUntil, 789);
  assert.equal(st['/b'].pid, null);
  assert.equal('cooldownUntil' in st['/b'], false);
  assert.equal(st['/c'].pid, null);
  assert.equal(st['/d'].pid, null);
  assert.equal(st['/e'].pid, 1);
});

test('non-numeric fails cannot wedge a workspace', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  fs.writeFileSync(deps.paths.statePath,
    '{"/a": {"pid": 1, "fails": "abc"},'
    + ' "/b": {"pid": 1, "fails": "2"},'
    + ' "/c": {"pid": 1, "fails": 2.7}}');
  const st = loadState();
  assert.equal('fails' in st['/a'], false);
  assert.equal(st['/b'].fails, 2);
  assert.equal(st['/c'].fails, 2);
});

test('missing state file reads as empty', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  assert.deepEqual(loadState(), {});
});
