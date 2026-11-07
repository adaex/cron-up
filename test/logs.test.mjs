import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { resolveLogPath, cmdLogs } from '../src/logs.mjs';
import { ExitError } from '../src/internals.mjs';
import { mkTmp, mockDeps, tmpPaths } from '../test-support/helpers.mjs';

function setup(t) {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  const notes = [];
  const errs = [];
  deps.printErr = (m) => errs.push(m);
  const out = path.join(deps.paths.logDir, 'launchd.out.log');
  const err = path.join(deps.paths.logDir, 'launchd.err.log');
  return {
    tmp, deps, notes, errs, out, err,
    resolve: () => resolveLogPath((m) => notes.push(m)),
  };
}

test('stale error does not hide the patrol log', (t) => {
  const s = setup(t);
  fs.writeFileSync(s.out, 'patrol ok\n');
  fs.writeFileSync(s.err, 'SyntaxError from days ago\n');
  assert.equal(s.resolve(), s.out);
  assert.ok(s.notes.some((n) => n.includes('巡检若异常先看它')));
});

test('empty error log is not mentioned', (t) => {
  const s = setup(t);
  fs.writeFileSync(s.out, 'patrol ok\n');
  fs.writeFileSync(s.err, '');
  assert.equal(s.resolve(), s.out);
  assert.deepEqual(s.notes, []);
});

test('falls back to stderr before the first patrol', (t) => {
  const s = setup(t);
  fs.writeFileSync(s.err, 'boom\n');
  assert.equal(s.resolve(), s.err);
});

test('cmdLogs tails -F with the resolved patrol file', (t) => {
  const s = setup(t);
  fs.writeFileSync(s.out, 'patrol ok\n');
  let seen;
  s.deps.spawnSync = (file, args, opts) => {
    seen = { file, args, opts };
    return { status: 0 };
  };
  cmdLogs({ follow: true });
  assert.equal(seen.file, '/usr/bin/tail');
  assert.deepEqual(seen.args, ['-F', s.out]);
  assert.equal(seen.opts.stdio, 'inherit');
});

test('cmdLogs defaults to tail -n 100', (t) => {
  const s = setup(t);
  fs.writeFileSync(s.out, 'patrol ok\n');
  let seen;
  s.deps.spawnSync = (file, args) => {
    seen = { file, args };
    return { status: 0 };
  };
  cmdLogs({});
  assert.deepEqual(seen.args, ['-n', '100', s.out]);
});

test('cmdLogs resolves an exact Herdr address without listing history', (t) => {
  const s = setup(t);
  s.deps.getHerdrTerminal = (address) => {
    assert.equal(address, 't7');
    return {
      address: 't7', taskId: '00000001', cwd: '/ws', title: '', state: 'finished',
    };
  };
  s.deps.listHerdrTerminals = () => assert.fail('精确地址不应扫描全部历史');
  let seen;
  s.deps.spawnSync = (file, args) => {
    seen = { file, args };
    return { status: 0 };
  };
  cmdLogs({ workspace: 't7', follow: false });
  assert.deepEqual(seen, {
    file: '/mock/hc', args: ['read', '--lines', '100', 't7'],
  });
});

test('cmdLogs reads Herdr history and only attaches to a live terminal', (t) => {
  const s = setup(t);
  s.deps.listHerdrTerminals = (taskId, includeFinished) => {
    assert.equal(taskId, null);
    assert.equal(includeFinished, true);
    return [{
      address: 't7', taskId: '00000001', cwd: '/ws',
      title: 'cron-up / ws / 每日汇总', state: 'finished',
    }];
  };
  let seen;
  s.deps.spawnSync = (file, args) => {
    seen = { file, args };
    return { status: 0 };
  };
  cmdLogs({ workspace: '汇总', follow: false });
  assert.deepEqual(seen, {
    file: '/mock/hc', args: ['read', '--lines', '100', 't7'],
  });
  cmdLogs({ workspace: '汇总', follow: true });
  assert.deepEqual(seen, {
    file: '/mock/hc', args: ['read', '--lines', '100', 't7'],
  }, '已结束的终端只读历史，不 attach');
});

test('cmdLogs follow attaches to a live Herdr terminal', (t) => {
  const s = setup(t);
  s.deps.listHerdrTerminals = () => [{
    address: 't7', taskId: '00000001', cwd: '/ws', title: '', state: 'live',
  }];
  let seen;
  s.deps.spawnSync = (file, args) => {
    seen = { file, args };
    return { status: 0 };
  };
  cmdLogs({ workspace: '00000001', follow: true });
  assert.deepEqual(seen, { file: '/mock/hc', args: ['attach', 't7'] });
});

test('Herdr selector accepts an absolute workspace and reports ambiguous candidates', (t) => {
  const s = setup(t);
  const ws = path.join(s.tmp, 'MyProj');
  fs.mkdirSync(ws);
  s.deps.listHerdrTerminals = () => [
    { address: 't7', taskId: '00000001', cwd: ws, title: '甲', state: 'finished' },
    { address: 't8', taskId: '00000002', cwd: ws, title: '乙', state: 'finished' },
  ];
  assert.throws(() => cmdLogs({ workspace: ws }), (e) => {
    assert.ok(e instanceof ExitError);
    assert.equal(e.code, 1);
    return true;
  });
  assert.ok(s.errs.some((m) => m.includes('t7') && m.includes('00000001')));
  assert.ok(s.errs.some((m) => m.includes('t8') && m.includes('00000002')));

  let seen;
  s.deps.spawnSync = (file, args) => {
    seen = { file, args };
    return { status: 0 };
  };
  cmdLogs({ workspace: 't8' });
  assert.deepEqual(seen.args, ['read', '--lines', '100', 't8']);
});

test('real tail -F survives patrol log rename and recreation', { timeout: 12000 }, async (t) => {
  const s = setup(t);
  fs.writeFileSync(s.out, 'before rename\n');
  const child = spawn('/usr/bin/tail', ['-F', s.out], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = once(child, 'exit');
  const running = () => child.exitCode === null && child.signalCode === null;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  t.after(() => {
    if (running()) child.kill('SIGKILL');
  });
  const waitFor = async (marker) => {
    const deadline = Date.now() + 6000;
    while (!stdout.includes(marker)) {
      if (!running()) throw new Error(`tail 提前退出：${stderr}\n${stdout}`);
      if (Date.now() >= deadline) throw new Error(`等待 ${marker} 超时：${stderr}`);
      await sleep(50);
    }
  };
  try {
    await waitFor('before rename');
    fs.renameSync(s.out, `${s.out}.1`);
    fs.writeFileSync(s.out, 'after recreate\n');
    await waitFor('after recreate');
  } finally {
    if (running()) child.kill('SIGTERM');
    await Promise.race([exited, sleep(1000)]);
    if (running()) {
      child.kill('SIGKILL');
      await exited;
    }
  }
  assert.match(stdout, /before rename/);
  assert.match(stdout, /after recreate/);
});

test('cmdLogs does not report success when the viewer dies by signal', (t) => {
  const s = setup(t);
  fs.writeFileSync(s.out, 'patrol ok\n');
  s.deps.spawnSync = () => ({ status: null, signal: 'SIGTERM' });
  assert.throws(() => cmdLogs({}), (e) => e instanceof ExitError
    && e.code === 1 && e.message.includes('SIGTERM'));
});

test('cmdLogs on an unmatched Herdr selector exits 1', (t) => {
  const s = setup(t);
  s.deps.spawnSync = () => assert.fail('不该走到日志查看进程');
  assert.throws(() => cmdLogs({ workspace: 'nope' }),
    (e) => e instanceof ExitError && e.code === 1);
  assert.ok(s.errs.some((m) => m.includes('nope')));
});
