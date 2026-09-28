import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  spawnSession,
  buildChildEnv,
  sessionArgv,
  shellQuote,
  sessionLogPath,
  trackedAlive,
} from '../src/sessions.mjs';
import { loadState } from '../src/config.mjs';
import { mkTmp, mockDeps, tmpPaths } from '../test-support/helpers.mjs';

test('session log slug escapes underscores before folding slashes', (t) => {
  const deps = mockDeps(t);
  deps.paths = tmpPaths(mkTmp(t));
  assert.notEqual(sessionLogPath('/a/b'), sessionLogPath('/a_b'));
  assert.ok(sessionLogPath('/a/b').endsWith('a_b.log'));
  assert.ok(sessionLogPath('/a_b').endsWith('a__b.log'));
  assert.ok(sessionLogPath('/x').endsWith('x.log'));
});

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
  const log = sessionLogPath(ws);
  const { pid, procStart } = spawnSession(ws);
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

test('buildChildEnv is a pure function', () => {
  const env = { CLAUDE_CODE_X: '1', KEEP: '2' };
  const out = buildChildEnv(env);
  assert.equal(out.CRON_UP_SESSION, '1');
  assert.equal('CLAUDE_CODE_X' in out, false);
  assert.equal(out.KEEP, '2');
  assert.equal('CLAUDE_CODE_X' in env, true); // 输入不被改
});

test('session argv quotes the workspace and runs login interactive zsh', () => {
  const argv = sessionArgv('/Users/aex/My Proj', '/tmp/x.log');
  assert.deepEqual(argv, [
    '/usr/bin/script', '-q', '/tmp/x.log',
    '/bin/zsh', '-lic', "cd '/Users/aex/My Proj' && claude",
  ]);
});

test('shellQuote keeps the safe set bare and single-quotes the rest', () => {
  assert.equal(shellQuote(''), "''");
  assert.equal(shellQuote('abc-def.g'), 'abc-def.g');
  assert.equal(shellQuote('a b'), "'a b'");
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
});

test('sanitised state never throws at the unguarded call sites', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  fs.writeFileSync(deps.paths.statePath,
    '{"/a": {"pid": "123", "startedAt": "456", "cooldownUntil": "789", "fails": 2},'
    + ' "/b": {"pid": [1], "cooldownUntil": "abc"},'
    + ' "/c": {"pid": -5},'
    + ' "/d": {"pid": 100000000000000000000},'
    + ' "/e": {"pid": 1.5}}');
  const st = loadState();
  const cur = Math.floor(Date.now() / 1000);
  for (const ent of Object.values(st)) {
    assert.equal(typeof trackedAlive(ent), 'boolean'); // 不许抛
    const inCooldown = (ent.cooldownUntil ?? 0) > cur;
    assert.equal(typeof inCooldown, 'boolean');
  }
});
