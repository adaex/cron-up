// 翻译自 Python LogPathTests。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { resolveLogPath } from '../src/logs.mjs';
import { sessionLogPath } from '../src/sessions.mjs';
import { ExitError } from '../src/internals.mjs';
import { mkTmp, mockDeps, tmpPaths } from '../test-support/helpers.mjs';

async function setup(t) {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  fs.mkdirSync(deps.paths.sessionLogDir, { recursive: true });
  const notes = [];
  const resolve = (workspace) => resolveLogPath(workspace, (m) => notes.push(m));
  const out = path.join(deps.paths.logDir, 'launchd.out.log');
  const err = path.join(deps.paths.logDir, 'launchd.err.log');
  return { tmp, deps, notes, resolve, out, err, sessionLogDir: deps.paths.sessionLogDir };
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

test('workspace fragment matches one session log', async (t) => {
  const s = await setup(t);
  const file = path.join(s.sessionLogDir, 'Users_me_team-space.log');
  fs.writeFileSync(file, '');
  assert.equal(s.resolve('team'), file);
});

test('unmatched fragment returns null', async (t) => {
  const s = await setup(t);
  assert.equal(s.resolve('nothing-here'), null);
});

test('ambiguous fragment exits with the candidates', async (t) => {
  const s = await setup(t);
  fs.writeFileSync(path.join(s.sessionLogDir, 'Users_me_a-space.log'), '');
  fs.writeFileSync(path.join(s.sessionLogDir, 'Users_me_b-space.log'), '');
  assert.throws(() => s.resolve('space'), (e) => {
    assert.ok(e instanceof ExitError);
    return true;
  });
  assert.ok(s.notes.some((n) => n.includes('a-space')));
});

test('rotated .1 logs are not candidates', async (t) => {
  const s = await setup(t);
  const file = path.join(s.sessionLogDir, 'Users_me_proj.log');
  fs.writeFileSync(file, '');
  fs.writeFileSync(`${file}.1`, '');
  assert.equal(s.resolve('proj'), file);
});

test('absolute path recovers the on-disk case', async (t) => {
  const s = await setup(t);
  const root = fs.realpathSync(s.tmp);
  const ws = path.join(root, 'MyProj');
  fs.mkdirSync(ws);
  const file = sessionLogPath(ws);
  fs.writeFileSync(file, '');
  const typed = path.join(root, 'myproj');
  if (!fs.existsSync(typed)) t.skip('大小写敏感的文件系统上无法构造该场景');
  assert.equal(s.resolve(typed), file);
});
