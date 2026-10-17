import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { resolveLogPath, cmdLogs } from '../src/logs.mjs';
import { sessionLogPath } from '../src/sessions.mjs';
import { ExitError } from '../src/internals.mjs';
import { mkTmp, mockDeps, tmpPaths } from '../test-support/helpers.mjs';

async function setup(t) {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  fs.mkdirSync(deps.paths.sessionLogDir, { recursive: true });
  const notes = [];
  const errs = [];
  const resolve = (workspace) => resolveLogPath(workspace, (m) => notes.push(m));
  deps.printErr = (m) => errs.push(m);
  const out = path.join(deps.paths.logDir, 'launchd.out.log');
  const err = path.join(deps.paths.logDir, 'launchd.err.log');
  return {
    tmp, deps, notes, errs, resolve, out, err,
    sessionLogDir: deps.paths.sessionLogDir,
  };
}

test('stale error does not hide the patrol log', async (t) => {
  const s = await setup(t);
  fs.writeFileSync(s.out, 'patrol ok\n');
  fs.writeFileSync(s.err, 'SyntaxError from days ago\n');
  assert.equal(s.resolve(), s.out);
  assert.ok(s.notes.some((n) => n.includes('巡检若异常先看它')));
});

test('empty error log is not mentioned', async (t) => {
  const s = await setup(t);
  fs.writeFileSync(s.out, 'patrol ok\n');
  fs.writeFileSync(s.err, '');
  assert.equal(s.resolve(), s.out);
  assert.deepEqual(s.notes, []);
});

test('falls back to stderr before the first patrol', async (t) => {
  const s = await setup(t);
  fs.writeFileSync(s.err, 'boom\n');
  assert.equal(s.resolve(), s.err);
});

test('workspace fragment matches one task-level session log', async (t) => {
  const s = await setup(t);
  const file = path.join(s.sessionLogDir, 'Users_me_team-space--00000002.log');
  fs.writeFileSync(file, '');
  assert.equal(s.resolve('team-space--00000002'), file);
  // 只给任务 id 片段也能命中（includes 匹配整个文件名）。
  assert.equal(s.resolve('00000002'), file);
});

test('unmatched fragment returns null', async (t) => {
  const s = await setup(t);
  assert.equal(s.resolve('nothing-here'), null);
});

test('ambiguous fragment exits with the task-level candidates', async (t) => {
  const s = await setup(t);
  const f1 = path.join(s.sessionLogDir, 'Users_me_a-space--00000001.log');
  const f2 = path.join(s.sessionLogDir, 'Users_me_b-space--00000001.log');
  fs.writeFileSync(f1, '');
  fs.writeFileSync(f2, '');
  assert.throws(() => s.resolve('00000001'), (e) => {
    assert.ok(e instanceof ExitError);
    assert.equal(e.code, 1);
    return true;
  });
  assert.ok(s.notes.some((n) => n.includes('a-space--00000001')));
  assert.ok(s.notes.some((n) => n.includes('b-space--00000001')));
});

test('rotated .1 logs are not candidates', async (t) => {
  const s = await setup(t);
  const file = path.join(s.sessionLogDir, 'Users_me_proj--00000001.log');
  fs.writeFileSync(file, '');
  fs.writeFileSync(`${file}.1`, '');
  assert.equal(s.resolve('proj'), file);
});

test('absolute path: single task log for the workspace is returned', async (t) => {
  const s = await setup(t);
  const root = fs.realpathSync(s.tmp);
  const ws = path.join(root, 'MyProj');
  fs.mkdirSync(ws);
  const file = sessionLogPath(ws, '00000001');
  fs.writeFileSync(file, '');
  assert.equal(s.resolve(ws), file);
});

test('absolute path: multiple task logs for one workspace are ambiguous', async (t) => {
  const s = await setup(t);
  const root = fs.realpathSync(s.tmp);
  const ws = path.join(root, 'team-space');
  fs.mkdirSync(ws);
  fs.writeFileSync(sessionLogPath(ws, '00000002'), '');
  fs.writeFileSync(sessionLogPath(ws, '00000004'), '');
  assert.throws(() => s.resolve(ws), (e) => e instanceof ExitError && e.code === 1);
  assert.ok(s.notes.some((n) => n.includes('team-space--00000002')));
  assert.ok(s.notes.some((n) => n.includes('team-space--00000004')));
});

test('absolute path: existing workspace without logs returns null', async (t) => {
  const s = await setup(t);
  const root = fs.realpathSync(s.tmp);
  const ws = path.join(root, 'empty-ws');
  fs.mkdirSync(ws);
  assert.equal(s.resolve(ws), null);
});

test('absolute path recovers the on-disk case', async (t) => {
  const s = await setup(t);
  const root = fs.realpathSync(s.tmp);
  const ws = path.join(root, 'MyProj');
  fs.mkdirSync(ws);
  const file = sessionLogPath(ws, '00000001');
  fs.writeFileSync(file, '');
  const typed = path.join(root, 'myproj');
  if (!fs.existsSync(typed)) t.skip('大小写敏感的文件系统上无法构造该场景');
  assert.equal(s.resolve(typed), file);
});

test('cmdLogs tails -f with the resolved file', async (t) => {
  const s = await setup(t);
  fs.writeFileSync(s.out, 'patrol ok\n');
  let seen;
  s.deps.spawnSync = (file, args, opts) => {
    seen = { file, args, opts };
    return { status: 0 };
  };
  cmdLogs({ follow: true });
  assert.equal(seen.file, '/usr/bin/tail');
  assert.deepEqual(seen.args, ['-f', s.out]);
  assert.equal(seen.opts.stdio, 'inherit');
});

test('cmdLogs defaults to tail -n 100', async (t) => {
  const s = await setup(t);
  fs.writeFileSync(s.out, 'patrol ok\n');
  let seen;
  s.deps.spawnSync = (file, args) => {
    seen = { file, args };
    return { status: 0 };
  };
  cmdLogs({});
  assert.deepEqual(seen.args, ['-n', '100', s.out]);
});

test('cmdLogs on an unmatched fragment exits 1', async (t) => {
  const s = await setup(t);
  s.deps.spawnSync = () => {
    throw new Error('不该走到 tail');
  };
  assert.throws(() => cmdLogs({ workspace: 'nope' }),
    (e) => e instanceof ExitError && e.code === 1);
  assert.ok(s.errs.some((m) => m.includes('nope')));
});
