// 翻译自 Python SessionScanTests / ClaudeProcessDetectionTests /
// ProcessFingerprintTests。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { scanSessions, pidIsClaude } from '../src/registry.mjs';
import { procStartedAt } from '../src/sessions.mjs';
import { mkTmp, mockDeps, tmpPaths, writeJson } from '../test-support/helpers.mjs';

async function setup(t) {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  const live = new Set();
  const claude = new Set();
  deps.alive = (pid) => live.has(pid);
  deps.pidIsClaude = (pid) => claude.has(pid);
  const writeReg = (name, pid, cwd, kind = 'interactive') => {
    writeJson(path.join(deps.paths.sessionDir, name), { pid, cwd, kind });
  };
  return { tmp, deps, live, claude, writeReg };
}

test('live claude consumers; dead and other kinds ignored', async (t) => {
  const { tmp, live, claude, writeReg } = await setup(t);
  live.add(101); live.add(202);
  claude.add(101); claude.add(202);
  writeReg('a.json', 101, fs.realpathSync(tmp));
  writeReg('dead.json', 999, '/nowhere/dead');
  writeReg('other.json', 202, '/nowhere/x', 'some-other');
  const [consumers, alert] = await scanSessions();
  assert.deepEqual(consumers, new Set([fs.realpathSync(tmp)]));
  assert.equal(alert, null);
});

test('empty directory is quiet', async (t) => {
  await setup(t);
  assert.deepEqual(await scanSessions(), [new Set(), null]);
});

test('registry shape change alerts', async (t) => {
  const { writeReg } = await setup(t);
  writeReg('x.json', 1, '/a', 'brand-new-kind');
  const [consumers, alert] = await scanSessions();
  assert.equal(consumers.size, 0);
  assert.ok(alert);
});

test('all corrupt files alert', async (t) => {
  const { deps } = await setup(t);
  fs.writeFileSync(path.join(deps.paths.sessionDir, 'bad.json'), '{ truncated');
  const [, alert] = await scanSessions();
  assert.ok(alert);
});

test('transiently unreadable registration is retried', async (t) => {
  const { tmp, deps, live, claude, writeReg } = await setup(t);
  live.add(101);
  claude.add(101);
  writeReg('a.json', 1, '/placeholder'); // 内容被 parseJson 接管
  const good = { kind: 'interactive', pid: 101, cwd: fs.realpathSync(tmp) };
  let calls = 0;
  const sleeps = [];
  deps.parseJson = () => {
    calls += 1;
    if (calls === 1) throw new SyntaxError('mid-write');
    return good;
  };
  deps.sleep = async (ms) => { sleeps.push(ms); };
  const [consumers, alert] = await scanSessions();
  assert.deepEqual(consumers, new Set([fs.realpathSync(tmp)]));
  assert.equal(alert, null);
  assert.deepEqual(sleeps, [100]);
});

test('permanently corrupt registration gives up after one retry', async (t) => {
  const { deps, writeReg } = await setup(t);
  writeReg('bad.json', 1, '/placeholder');
  const sleeps = [];
  deps.parseJson = () => { throw new SyntaxError('corrupt'); };
  deps.sleep = async (ms) => { sleeps.push(ms); };
  const [consumers, alert] = await scanSessions();
  assert.equal(consumers.size, 0);
  assert.ok(alert); // 有文件却读不出会话：自检告警仍在
  assert.equal(sleeps.length, 1); // 只重试一次，不无限纠缠
});

test('live non-claude process alerts', async (t) => {
  const { tmp, live, writeReg } = await setup(t);
  live.add(101);
  writeReg('a.json', 101, fs.realpathSync(tmp));
  const [consumers, alert] = await scanSessions();
  assert.equal(consumers.size, 0);
  assert.ok(alert);
});

test('malformed pid entries are skipped', async (t) => {
  // 必须用真实存活判定跑——这几道关是 scanSessions 唯一的防线。裸
  // Infinity 在 JS 里 JSON.parse 直接抛，按「损坏登记」忽略，语义等价于
  // Python 版「读不进有效 pid 而跳过」。
  const { tmp, deps, writeReg } = await setup(t);
  const me = process.pid;
  deps.alive = (p) => p === me;
  deps.pidIsClaude = (p) => p === me;
  writeReg('live.json', me, fs.realpathSync(tmp));
  writeReg('null.json', null, '/a');
  writeReg('neg.json', -1, '/a');
  writeReg('junk.json', 'abc', '/a');
  writeReg('huge.json', 10 ** 20, '/a');
  writeReg('cwdnum.json', me, 5);
  writeReg('cwdlist.json', me, ['/a']);
  writeReg('cwdempty.json', me, '');
  writeReg('cwdrel.json', me, 'some/relative/path');
  fs.writeFileSync(path.join(deps.paths.sessionDir, 'inf.json'),
    '{"kind": "interactive", "pid": Infinity, "cwd": "/a"}');
  writeReg('absent.json', undefined, '/a');
  const [consumers, alert] = await scanSessions();
  assert.deepEqual(consumers, new Set([fs.realpathSync(tmp)]));
  assert.equal(alert, null);
});

test('registrations without pid or cwd alert', async (t) => {
  const { deps, live, claude, writeReg } = await setup(t);
  live.add(101);
  claude.add(101);
  writeJson(path.join(deps.paths.sessionDir, 'nopid.json'),
    { kind: 'interactive', cwd: '/a' });
  writeReg('nocwd.json', 101, null);
  const [consumers, alert] = await scanSessions();
  assert.equal(consumers.size, 0);
  assert.ok(alert);
  assert.ok(alert.includes('pid'));
});

test('dead pid registrations are quiet', async (t) => {
  const { writeReg } = await setup(t);
  writeReg('stale.json', 999, '/a');
  const [consumers, alert] = await scanSessions();
  assert.equal(consumers.size, 0);
  assert.equal(alert, null);
});

// ---- pidIsClaude ----

function detect(deps, comm, argsLine = '') {
  deps.execFile = (file, a) => ({
    status: 0,
    stdout: `${a.includes('comm=') ? comm : argsLine}\n`,
    stderr: '',
  });
  return pidIsClaude(42);
}

test('native install recognised by comm', (t) => {
  const deps = mockDeps(t);
  assert.equal(detect(deps, 'claude'), true);
  assert.equal(detect(deps, '/Users/u/.local/bin/claude'), true);
});

test('npm install recognised via interpreter args', (t) => {
  const deps = mockDeps(t);
  assert.equal(detect(deps, 'node', 'node /opt/homebrew/bin/claude'), true);
  assert.equal(detect(deps, 'node',
    'node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js'), true);
  assert.equal(detect(deps, 'bun', 'bun /home/u/.bun/bin/claude -r'), true);
  assert.equal(detect(deps, 'node', 'node /x/claude/run.js'), true);
});

test('unrelated processes are rejected', (t) => {
  const deps = mockDeps(t);
  assert.equal(detect(deps, 'node', 'node server.js'), false);
  assert.equal(detect(deps, 'node', 'node claude.md'), false);
  assert.equal(detect(deps, 'vim', 'vim claude.md'), false);
  assert.equal(detect(deps, 'zsh', ''), false);
  assert.equal(detect(deps, 'python3', 'python3 /x/claude'), false);
});

test('ps failure reads as not claude', (t) => {
  const deps = mockDeps(t);
  deps.execFile = () => { throw new Error('ps gone'); };
  assert.equal(pidIsClaude(42), false);
});

test('ps start time runs under pinned C locale', (t) => {
  const deps = mockDeps(t);
  let seen;
  deps.execFile = (file, args, opts) => {
    seen = opts;
    return { status: 0, stdout: 'x', stderr: '' };
  };
  procStartedAt(42);
  assert.equal(seen.env.LC_ALL, 'C');
  assert.equal(seen.env.LANG, 'C');
});
