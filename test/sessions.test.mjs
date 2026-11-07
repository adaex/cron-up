import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  spawnSession,
  stopSession,
  findHerdr,
  herdrDisplayTitle,
  herdrSessionArgv,
  setHerdrTitle,
  syncHerdrTaskId,
  sessionIdleSeconds,
  getHerdrTerminal,
  listHerdrTerminals,
  findHerdrOrphan,
  sessionDebugCommand,
  shellQuote,
  trackedAlive,
} from '../src/sessions.mjs';
import { mkTmp, mockDeps, tmpPaths } from '../test-support/helpers.mjs';

test('findHerdr searches PATH and the documented per-user install location', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  const home = path.join(tmp, 'home');
  deps.paths = tmpPaths(tmp, { home });
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const hc = path.join(bin, 'hc');
  fs.writeFileSync(hc, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(findHerdr({ PATH: bin }), hc);
  assert.equal(findHerdr({ PATH: path.relative(process.cwd(), bin) }), hc,
    '写入 launchd 前把相对 PATH 目录解析成绝对路径');

  const defaultHc = path.join(home, '.local', 'bin', 'hc');
  fs.mkdirSync(path.dirname(defaultHc), { recursive: true });
  fs.writeFileSync(defaultHc, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(findHerdr({ PATH: path.join(tmp, 'missing') }), defaultHc);
  fs.chmodSync(defaultHc, 0o644);
  assert.equal(findHerdr({ PATH: path.join(tmp, 'missing') }), null);
  assert.equal(findHerdr({ PATH: '' }), null, '空 PATH 不读取当前目录');
});

test('Herdr display title uses a bounded single-line prompt instead of a hash', () => {
  assert.equal(herdrDisplayTitle('/work/a', '  每日\n汇总  '), 'cron-up / a / 每日 汇总');
  assert.equal(herdrDisplayTitle('/work/a', ''), 'cron-up / a / 未命名任务');
  assert.ok(herdrDisplayTitle('/work/a', 'x'.repeat(80))
    .endsWith(`${'x'.repeat(40)}…`));
  assert.equal(herdrDisplayTitle('/work/a', '一行\u0000\u001f\u007f任务'),
    'cron-up / a / 一行 任务');
});

test('setHerdrTitle returns a compact backend error', (t) => {
  const deps = mockDeps(t);
  deps.execFile = (file, args) => {
    assert.equal(file, '/mock/hc');
    assert.deepEqual(args, ['label', 't7', 'where=cron-up / ws / 任务']);
    return { status: 1, stdout: '', stderr: 'label unsupported\n' };
  };
  assert.equal(setHerdrTitle('t7', 'cron-up / ws / 任务'), 'label unsupported');
  deps.execFile = () => ({ status: 0, stdout: '', stderr: '' });
  assert.equal(setHerdrTitle('t7', 'title'), null);
});

test('syncHerdrTaskId moves a verified terminal label and accepts an already moved label', (t) => {
  const deps = mockDeps(t);
  let current = '554e2879';
  const commands = [];
  deps.execFile = (file, args) => {
    commands.push(args);
    if (args[0] === 'get') {
      return { status: 0, stdout: JSON.stringify({
        pid: 4242, cwd: '/ws', labels: { 'cron-up': current },
      }) };
    }
    assert.deepEqual(args, ['label', 't7', 'cron-up=00000001']);
    current = '00000001';
    return { status: 0, stdout: '', stderr: '' };
  };
  const ent = {
    pid: 4242, ws: '/ws', herdr: 't7',
    taskId: '00000001', herdrTaskId: '554e2879',
  };
  assert.equal(syncHerdrTaskId(ent), null);
  assert.equal('herdrTaskId' in ent, false);
  assert.deepEqual(commands.map((args) => args[0]), ['get', 'label']);

  // 模拟标签已更新但 state 尚未落盘：旧记录仍能认回新标签，不重复写。
  ent.herdrTaskId = '554e2879';
  assert.equal(syncHerdrTaskId(ent), null);
  assert.equal('herdrTaskId' in ent, false);
  assert.deepEqual(commands.map((args) => args[0]), ['get', 'label', 'get']);
});

test('syncHerdrTaskId refuses to relabel a terminal owned by another task', (t) => {
  const deps = mockDeps(t);
  deps.execFile = (file, args) => {
    assert.equal(args[0], 'get');
    return { status: 0, stdout: JSON.stringify({
      pid: 4242, cwd: '/ws', labels: { 'cron-up': 'another-task' },
    }) };
  };
  const ent = {
    pid: 4242, ws: '/ws', herdr: 't7',
    taskId: '00000001', herdrTaskId: '554e2879',
  };
  assert.match(syncHerdrTaskId(ent), /不一致/);
  assert.equal(ent.herdrTaskId, '554e2879');
});

test('Herdr argv is the complete minimal native launch command', () => {
  const ws = '/Users/aex/My Proj';
  assert.deepEqual(herdrSessionArgv('/opt/herdr/hc', ws, '00000001'), [
    '/opt/herdr/hc', 'run', '--json', '--bg', '--no-parent',
    '--cwd', ws,
    '--label', 'cron-up=00000001',
    '/bin/zsh', '-lic', 'claude',
  ]);
  assert.equal(
    herdrSessionArgv('/opt/herdr/hc', ws, '00000001', "model; printf 'bad'").at(-1),
    `claude --model 'model; printf '"'"'bad'"'"''`,
  );
});

test('shellQuote leaves safe values alone and quotes shell-special values', () => {
  assert.equal(shellQuote(''), "''");
  assert.equal(shellQuote('abc-def.g'), 'abc-def.g');
  assert.equal(shellQuote('a b'), "'a b'");
});

test('spawn returns one flat Herdr session identity without a caller env or log', (t) => {
  const deps = mockDeps(t);
  deps.paths = tmpPaths(mkTmp(t));
  deps.procStartedAt = () => 'start';
  const calls = [];
  deps.execFile = (file, args, opts) => {
    calls.push({ file, args, opts });
    if (args[0] === 'run') {
      return { status: 0, stdout: '{"address":"t7"}', stderr: '' };
    }
    assert.deepEqual(args, ['get', '--json', 't7']);
    return { status: 0, stdout: '{"pid":4242}', stderr: '' };
  };
  assert.deepEqual(spawnSession('/ws', '00000001'), {
    pid: 4242, procStart: 'start', herdr: 't7',
  });
  assert.equal(calls.length, 2);
  assert.equal('env' in calls[0].opts, false, 'Herdr 使用 core 环境，不构造调用方 env');
});

test('spawn without hc fails without starting another backend', (t) => {
  const deps = mockDeps(t);
  deps.findHerdr = () => null;
  deps.execFile = () => assert.fail('没有 hc 时不应尝试其他启动方式');
  const logged = [];
  deps.log = (m) => logged.push(m);
  assert.equal(spawnSession('/ws', '00000001'), null);
  assert.ok(logged[0].includes('未找到 hc'));
});

test('spawn failure returns null without a duplicate direct launch', (t) => {
  const deps = mockDeps(t);
  deps.execFile = () => ({ status: 1, stdout: '', stderr: 'core unavailable' });
  const logged = [];
  deps.log = (m) => logged.push(m);
  assert.equal(spawnSession('/ws', '00000001'), null);
  assert.ok(logged[0].includes('core unavailable'));
});

for (const [name, get, procStart] of [
  ['identity query fails', { status: 1, stdout: '', stderr: 'core unavailable' }, 'start'],
  ['root pid is invalid', { status: 0, stdout: '{"pid":1}', stderr: '' }, 'start'],
  ['fingerprint is missing', { status: 0, stdout: '{"pid":4242}', stderr: '' }, null],
]) {
  test(`spawn cleans its new terminal when ${name}`, (t) => {
    const deps = mockDeps(t);
    deps.procStartedAt = () => procStart;
    const logged = [];
    deps.log = (m) => logged.push(m);
    const commands = [];
    deps.execFile = (file, args) => {
      commands.push(args);
      if (args[0] === 'run') return { status: 0, stdout: '{"address":"t8"}' };
      if (args[0] === 'get') return get;
      assert.deepEqual(args, ['kill', '--json', 't8']);
      return { status: 0, stdout: '{"state":"finished"}' };
    };
    assert.equal(spawnSession('/ws', '00000001'), null);
    assert.deepEqual(commands.map((args) => args[0]), ['run', 'get', 'kill']);
    assert.ok(logged[0].includes('终端 t8'), '清理失败时必须留下终端地址');
  });
}

test('stop kills a Herdr terminal using the last confirmed task label', (t) => {
  const deps = mockDeps(t);
  deps.alive = () => true;
  deps.procStartedAt = () => 'start';
  const commands = [];
  deps.execFile = (file, args) => {
    commands.push(args);
    if (args[0] === 'get') {
      return { status: 0, stdout: JSON.stringify({
        pid: 4242, cwd: '/ws', labels: { 'cron-up': '554e2879' },
      }) };
    }
    assert.deepEqual(args, ['kill', '--json', 't7']);
    return { status: 0, stdout: '{"state":"finished"}' };
  };
  const ent = {
    pid: 4242, procStart: 'start', herdr: 't7', ws: '/ws',
    taskId: '00000001', herdrTaskId: '554e2879',
  };
  assert.equal(stopSession(ent), true);
  assert.deepEqual(commands.map((args) => args[0]), ['get', 'kill']);
});

test('stop refuses a Herdr identity mismatch', (t) => {
  const deps = mockDeps(t);
  deps.alive = () => true;
  deps.procStartedAt = () => 'start';
  deps.execFile = (file, args) => {
    assert.equal(args[0], 'get');
    return { status: 0, stdout: JSON.stringify({
      pid: 4242, cwd: '/ws', labels: { 'cron-up': 'another-task' },
    }) };
  };
  const ent = {
    pid: 4242, procStart: 'start', herdr: 't7', ws: '/ws', taskId: '00000001',
  };
  assert.equal(stopSession(ent), false);
});

test('stop does not report success while Herdr still reports the terminal live', (t) => {
  const deps = mockDeps(t);
  deps.alive = () => true;
  deps.procStartedAt = () => 'start';
  deps.execFile = (file, args) => ({
    status: 0,
    stdout: JSON.stringify(args[0] === 'get' ? {
      pid: 4242, cwd: '/ws', labels: { 'cron-up': '00000001' },
    } : { state: 'live' }),
  });
  assert.equal(stopSession({
    pid: 4242, procStart: 'start', herdr: 't7', ws: '/ws', taskId: '00000001',
  }), false);
});

test('stop ignores dead entries and refuses active entries without Herdr identity', (t) => {
  const deps = mockDeps(t);
  deps.alive = () => false;
  deps.procStartedAt = () => 'other';
  assert.equal(stopSession({ pid: 4242, procStart: 'start', herdr: 't7' }), true);

  deps.alive = () => true;
  deps.procStartedAt = () => 'start';
  const noHerdr = { pid: 4242, procStart: 'start' };
  assert.equal(trackedAlive(noHerdr), true);
  assert.equal(stopSession(noHerdr), false);
  assert.equal(trackedAlive({ pid: 4242 }), false);
  for (const pid of [1, 1.5, -4242, 0]) {
    assert.equal(stopSession({ pid, procStart: 'start' }), true);
  }
});

test('activity is read lazily and tracks screen changes, working and failures', (t) => {
  const deps = mockDeps(t);
  let working = false;
  let screen = 'first';
  let readFails = false;
  deps.execFile = (file, args) => {
    if (args[0] === 'get') {
      return { status: 0, stdout: JSON.stringify({
        pid: 4242, status: { state: working ? 'working' : 'idle' },
      }) };
    }
    assert.deepEqual(args, ['read', 't7']);
    return readFails
      ? { status: 1, stdout: '', stderr: 'unavailable' }
      : { status: 0, stdout: screen, stderr: '' };
  };
  const ent = { pid: 4242, herdr: 't7', startedAt: 50 };
  assert.equal(sessionIdleSeconds(ent, 100), 0, '首次只建立摘要基线');
  assert.equal(sessionIdleSeconds(ent, 150), 50);
  screen = 'second';
  assert.equal(sessionIdleSeconds(ent, 170), 0);
  working = true;
  assert.equal(sessionIdleSeconds(ent, 200), 0);
  working = false;
  readFails = true;
  assert.equal(sessionIdleSeconds(ent, 230), 0);
  assert.equal(sessionIdleSeconds({ pid: 4242 }, 230), 0,
    '缺少终端地址时没有静默证据，保守视为活跃');
});

test('Herdr orphan is found by task label and workspace with a flat result', (t) => {
  const deps = mockDeps(t);
  deps.alive = () => true;
  deps.procStartedAt = () => 'start';
  deps.execFile = (file, args) => {
    if (args[0] === 'ls') {
      assert.deepEqual(args, ['ls', '--json', '--label', 'cron-up=00000001']);
      return { status: 0, stdout: '{"terminals":[{"address":"t7","state":"live"}]}' };
    }
    assert.deepEqual(args, ['get', '--json', 't7']);
    return { status: 0, stdout: JSON.stringify({
      pid: 4242, cwd: '/ws', labels: { 'cron-up': '00000001' },
    }) };
  };
  assert.deepEqual(findHerdrOrphan('/ws', '00000001'), {
    pid: 4242, procStart: 'start', herdr: 't7',
  });
});

test('Herdr orphan without a process fingerprint is not adopted', (t) => {
  const deps = mockDeps(t);
  deps.alive = () => true;
  deps.procStartedAt = () => null;
  deps.execFile = (file, args) => {
    if (args[0] === 'ls') {
      return { status: 0, stdout: '{"terminals":[{"address":"t7","state":"live"}]}' };
    }
    return { status: 0, stdout: JSON.stringify({
      pid: 4242, cwd: '/ws', labels: { 'cron-up': '00000001' },
    }) };
  };
  assert.throws(() => findHerdrOrphan('/ws', '00000001'), /启动指纹/);
});

test('exact Herdr lookup returns only a labelled terminal', (t) => {
  const deps = mockDeps(t);
  deps.execFile = (file, args) => {
    assert.deepEqual(args, ['get', '--json', 't7']);
    return { status: 0, stdout: JSON.stringify({
      pid: 4242, cwd: '/ws', state: 'finished',
      labels: { 'cron-up': '00000001', where: 'title' },
    }) };
  };
  assert.deepEqual(getHerdrTerminal('t7'), {
    address: 't7', pid: 4242, cwd: '/ws', taskId: '00000001',
    state: 'finished', title: 'title',
  });
  deps.execFile = () => ({ status: 0, stdout: '{"pid":4242,"labels":{}}' });
  assert.equal(getHerdrTerminal('t7'), null);
});

test('Herdr terminal listing does not turn query failures into an empty list', (t) => {
  const deps = mockDeps(t);
  deps.execFile = () => ({ status: 1, stdout: '', stderr: 'core unavailable' });
  assert.throws(() => listHerdrTerminals(), /列表查询失败.*core unavailable/);

  deps.execFile = (file, args) => {
    if (args[0] === 'ls') {
      return { status: 0, stdout: '{"terminals":[{"address":"t7","state":"live"}]}' };
    }
    return { status: 1, stdout: '', stderr: 'get unavailable' };
  };
  assert.throws(() => listHerdrTerminals(), /t7 身份查询失败.*get unavailable/);

  deps.execFile = () => ({ status: 0, stdout: '{broken', stderr: '' });
  assert.throws(() => listHerdrTerminals(), /无效 JSON/);
});

test('Herdr terminal listing can include finished history for logs', (t) => {
  const deps = mockDeps(t);
  deps.execFile = (file, args) => {
    if (args[0] === 'ls') {
      assert.deepEqual(args, ['ls', '--json', '--all']);
      return { status: 0, stdout: '{"terminals":[{"address":"t7","state":"live"}]}' };
    }
    assert.deepEqual(args, ['get', '--json', 't7']);
    return { status: 0, stdout: JSON.stringify({
      pid: 4242, cwd: '/ws', state: 'finished',
      labels: { 'cron-up': '00000001', where: 'title' },
    }) };
  };
  assert.deepEqual(listHerdrTerminals(null, true), [{
    address: 't7', pid: 4242, cwd: '/ws', taskId: '00000001',
    state: 'finished', title: 'title',
  }]);
});

test('debug commands use the Herdr selector or the patrol log before launch', () => {
  assert.equal(sessionDebugCommand({ herdr: 't7' }), 'cron-up logs t7');
  assert.equal(sessionDebugCommand({}), 'cron-up logs');
});
