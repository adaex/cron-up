import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  scanSessions,
  isClaudeProcess,
  processTable,
  ancestorChain,
  claimWarm,
  sessionAliveNow,
  liveSessionIds,
  creatorSessionAlive,
} from '../src/registry.mjs';
import { procStartedAt } from '../src/sessions.mjs';
import { mkTmp, mockDeps, tmpPaths, writeJson } from '../test-support/helpers.mjs';

const makeTable = (entries) => new Map([...entries].map(
  ([pid, ppid]) => [pid, { ppid, comm: 'claude' }],
));

async function setup(t) {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  const live = new Set();
  const claude = new Set();
  // 父子表夹具：登记的活进程默认挂在 launchd(1) 下（链完整到根）；需要
  // 模拟预热三代结构或断链的用例直接改 parents。
  const parents = new Map([[1, 0]]);
  deps.alive = (pid) => live.has(pid);
  deps.isClaudeProcess = (pid) => claude.has(pid);
  deps.processTable = () => makeTable(parents);
  const writeReg = (name, pid, cwd, kind = 'interactive', extra = {}) => {
    writeJson(path.join(deps.paths.sessionDir, name), { pid, cwd, kind, ...extra });
    if (typeof pid === 'number' && pid > 0) parents.set(pid, 1);
  };
  return { tmp, deps, live, claude, parents, writeReg };
}

test('live claude workspaces; dead and other kinds ignored', async (t) => {
  const { tmp, live, claude, writeReg } = await setup(t);
  live.add(101); live.add(202);
  claude.add(101); claude.add(202);
  writeReg('a.json', 101, fs.realpathSync(tmp));
  writeReg('dead.json', 999, '/nowhere/dead');
  writeReg('other.json', 202, '/nowhere/x', 'some-other');
  const [alert, details] = await scanSessions();
  assert.deepEqual([...details.keys()], [fs.realpathSync(tmp)]);
  assert.equal(alert, null);
  const list = details.get(fs.realpathSync(tmp));
  assert.deepEqual(list.map((d) => d.pid), [101]); // 202 不是 interactive
  assert.deepEqual(list[0].ancestors, [1]);
  assert.equal(list[0].sessionId, null);
  assert.equal(list[0].procStart, null);
});

test('empty directory is quiet', async (t) => {
  await setup(t);
  assert.deepEqual(await scanSessions(), [null, new Map()]);
});

test('registry shape change alerts', async (t) => {
  const { writeReg } = await setup(t);
  writeReg('x.json', 1, '/a', 'brand-new-kind');
  const [alert, details] = await scanSessions();
  assert.equal(details.size, 0);
  assert.ok(alert);
});

test('all corrupt files alert', async (t) => {
  const { deps } = await setup(t);
  fs.writeFileSync(path.join(deps.paths.sessionDir, 'bad.json'), '{ truncated');
  const [, alert] = await scanSessions();
  assert.ok(alert);
});

test('transiently unreadable registration is retried', async (t) => {
  const { tmp, deps, live, claude, parents } = await setup(t);
  live.add(101);
  claude.add(101);
  parents.set(101, 1); // 该用例手写登记文件，夹具默认补不到它的父链
  // Claude Code 就地重写登记：第一次读撞上写一半的文件，重试前写完。
  const file = path.join(deps.paths.sessionDir, 'a.json');
  fs.writeFileSync(file, '{ truncated');
  const good = { kind: 'interactive', pid: 101, cwd: fs.realpathSync(tmp) };
  const sleeps = [];
  deps.sleep = async (ms) => {
    sleeps.push(ms);
    fs.writeFileSync(file, JSON.stringify(good));
  };
  const [alert, details] = await scanSessions();
  assert.deepEqual([...details.keys()], [fs.realpathSync(tmp)]);
  assert.equal(alert, null);
  assert.deepEqual(sleeps, [100]);
});

test('permanently corrupt registration gives up after one retry', async (t) => {
  const { deps } = await setup(t);
  fs.writeFileSync(path.join(deps.paths.sessionDir, 'bad.json'), '{ truncated');
  const sleeps = [];
  deps.sleep = async (ms) => { sleeps.push(ms); };
  const [alert, details] = await scanSessions();
  assert.equal(details.size, 0);
  assert.ok(alert); // 有文件却读不出会话：自检告警仍在
  assert.equal(sleeps.length, 1); // 只重试一次，不无限纠缠
});

test('live non-claude process alerts', async (t) => {
  const { tmp, live, writeReg } = await setup(t);
  live.add(101);
  writeReg('a.json', 101, fs.realpathSync(tmp));
  const [alert, details] = await scanSessions();
  assert.equal(details.size, 0);
  assert.ok(alert);
});

test('malformed pid entries are skipped', async (t) => {
  // 必须用真实存活判定跑——这几道关是 scanSessions 唯一的防线。损坏登记
  // 一律按「读不进有效 pid 而跳过」。
  const { tmp, deps, writeReg } = await setup(t);
  const me = process.pid;
  deps.alive = (p) => p === me;
  deps.isClaudeProcess = (p) => p === me;
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
  const [alert, details] = await scanSessions();
  assert.deepEqual([...details.keys()], [fs.realpathSync(tmp)]);
  assert.equal(alert, null);
});

test('registrations without pid or cwd alert', async (t) => {
  const { deps, live, claude, writeReg } = await setup(t);
  live.add(101);
  claude.add(101);
  writeJson(path.join(deps.paths.sessionDir, 'nopid.json'),
    { kind: 'interactive', cwd: '/a' });
  writeReg('nocwd.json', 101, null);
  const [alert, details] = await scanSessions();
  assert.equal(details.size, 0);
  assert.ok(alert);
  assert.ok(alert.includes('pid'));
});

test('dead pid registrations are quiet', async (t) => {
  const { writeReg } = await setup(t);
  writeReg('stale.json', 999, '/a');
  const [alert, details] = await scanSessions();
  assert.equal(details.size, 0);
  assert.equal(alert, null);
});

// ---- isClaudeProcess 的 claude 识别 ----

function detect(deps, comm, argsLine = '') {
  deps.execFile = (file, a) => ({
    status: 0,
    stdout: `${a.some((x) => x.startsWith('args=')) ? argsLine : comm}\n`,
    stderr: '',
  });
  return isClaudeProcess(42);
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

test('snapshot comm avoids a per-pid process query', (t) => {
  const deps = mockDeps(t);
  deps.execFile = () => assert.fail('快照已给出 comm，不应再执行单 pid ps');
  assert.equal(isClaudeProcess(42, '/Users/u/.local/bin/claude'), true);
  assert.equal(isClaudeProcess(42, 'vim'), false);
});

test('ps failure reads as not claude', (t) => {
  const deps = mockDeps(t);
  deps.execFile = () => { throw new Error('ps gone'); };
  assert.equal(isClaudeProcess(42), false);
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

test('processTable parses process identity and ancestry together', (t) => {
  const deps = mockDeps(t);
  deps.execFile = (file, args) => {
    assert.deepEqual(args, ['-axo', 'pid=,ppid=,comm=']);
    return {
      status: 0,
      stdout: '   1     0 /sbin/launchd\n  101     1 /bin/zsh\n'
        + '  202   101 /Users/u/.local/bin/claude\n',
      stderr: '',
    };
  };
  const table = processTable();
  assert.deepEqual(table.get(202), { ppid: 101, comm: '/Users/u/.local/bin/claude' });
  assert.deepEqual(table.get(1), { ppid: 0, comm: '/sbin/launchd' });

  deps.execFile = () => ({ status: 1, stdout: '', stderr: 'boom' });
  assert.equal(processTable(), null);
  deps.execFile = () => ({ status: 0, stdout: '', stderr: '' });
  assert.equal(processTable(), null);
});

test('ancestorChain walks to launchd and stops on broken chains', () => {
  // root(10) → zsh(20) → claude(30) 的生产三层结构；上溯到 launchd(1)
  // 即终止（不追加其父 0）。
  const full = makeTable([[30, 20], [20, 10], [10, 1], [1, 0]]);
  assert.deepEqual(ancestorChain(30, full), [20, 10, 1]);

  // 中间代在快照里缺失：链断在 20。
  const broken = makeTable([[30, 20], [10, 1], [1, 0]]);
  assert.deepEqual(ancestorChain(30, broken), [20]);

  // 无快照：空链。
  assert.deepEqual(ancestorChain(30, null), []);

  // 成环防御：不能死循环，保留已经读到的祖先。
  const loop = makeTable([[30, 20], [20, 30]]);
  assert.deepEqual(ancestorChain(30, loop), [20, 30]);
});

test('details group sessions by cwd with identity fields', async (t) => {
  const { tmp, deps, live, claude, parents, writeReg } = await setup(t);
  const ws = fs.realpathSync(tmp);
  live.add(30); live.add(40);
  claude.add(30); claude.add(40);
  writeReg('warm.json', 30, ws, 'interactive', {
    sessionId: 'sess-warm',
    procStart: 'Fri Oct 16 06:01:20 2026',
  });
  writeReg('user.json', 40, ws, 'interactive', {
    sessionId: 'sess-user',
    procStart: 'Thu Oct  8 09:10:00 2026',
  });
  // writeReg 默认把消费者挂 launchd 下，之后再改成生产三代链：
  // 30：root(10) → zsh(20) → claude(30)；40 保持 1 → claude(40)。
  parents.set(30, 20); parents.set(20, 10); parents.set(10, 1);
  const [alert, details] = await scanSessions();
  assert.equal(alert, null);
  assert.deepEqual([...details.keys()], [ws]);
  const byPid = new Map(details.get(ws).map((d) => [d.pid, d]));
  assert.deepEqual(byPid.get(30).ancestors, [20, 10, 1]);
  assert.equal(byPid.get(30).sessionId, 'sess-warm');
  // 双空格 lstart 原文透传，不做规范化。
  assert.equal(byPid.get(40).procStart, 'Thu Oct  8 09:10:00 2026');
  assert.deepEqual(byPid.get(40).ancestors, [1]);
});

test('broken lineage is quiet: consumer kept with empty chain and no alert', async (t) => {
  const { tmp, deps, live, claude, parents, writeReg } = await setup(t);
  const ws = fs.realpathSync(tmp);
  live.add(30);
  claude.add(30);
  writeReg('warm.json', 30, ws);
  // 全量快照里没有 30，per-pid ps 也读不到 ppid：祖先链断。任务级模型
  // 不再为此告警——认亲下轮再试，工作区判定不受影响。
  parents.delete(30);
  deps.isClaudeProcess = () => true;
  const [alert, details] = await scanSessions();
  assert.deepEqual([...details.keys()], [ws]);
  assert.equal(alert, null);
  assert.deepEqual(details.get(ws)[0].ancestors, []);
});

test('null process table yields empty chains without alerting', async (t) => {
  const { tmp, deps, live, claude, writeReg } = await setup(t);
  const ws = fs.realpathSync(tmp);
  live.add(30);
  claude.add(30);
  writeReg('warm.json', 30, ws);
  deps.processTable = () => null;
  const [alert, details] = await scanSessions();
  assert.deepEqual([...details.keys()], [ws]);
  assert.equal(alert, null);
  assert.deepEqual(details.get(ws)[0].ancestors, []);
});

test('display scans skip the process table and ancestors', async (t) => {
  const { tmp, deps, live, claude, writeReg } = await setup(t);
  const ws = fs.realpathSync(tmp);
  live.add(30);
  claude.add(30);
  writeReg('warm.json', 30, ws);
  deps.processTable = () => assert.fail('展示扫描不需要全机进程快照');
  const [, details] = await scanSessions({ ancestors: false });
  assert.deepEqual([...details.keys()], [ws]);
  assert.deepEqual(details.get(ws)[0].ancestors, []);
});

// ---- claimWarm：root pid → 登记详情的认亲 ----

function claimDetail(over = {}) {
  return {
    pid: 30, sessionId: 's', procStart: 'start',
    ancestors: [1], ...over,
  };
}

test('claimWarm matches the registration whose ancestor chain contains the root pid', () => {
  const details = new Map([['/w', [
    claimDetail({ pid: 40, sessionId: 'other', ancestors: [1] }),
    claimDetail({ pid: 30, sessionId: 'sess-warm',
      ancestors: [20, 10, 1] }),
  ]]]);
  // root pid 是 10（链 [zsh 20, root 10, launchd 1]）。
  const d = claimWarm(details, '/w', 10);
  assert.equal(d.sessionId, 'sess-warm');
  assert.equal(d.pid, 30);
});

test('claimWarm returns null when no ancestor chain contains the pid', () => {
  const details = new Map([['/w', [claimDetail({ ancestors: [1] })]]]);
  assert.equal(claimWarm(details, '/w', 10), null);
});

test('claimWarm returns null for an unknown workspace', () => {
  const details = new Map([['/w', [claimDetail({ ancestors: [20, 10, 1] })]]]);
  assert.equal(claimWarm(details, '/elsewhere', 10), null);
  assert.equal(claimWarm(new Map(), '/w', 10), null);
});

// ---- sessionAliveNow：轮末死亡复核的轻量存活检查 ----

async function aliveSetup(t) {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  const live = new Set();
  deps.alive = (pid) => live.has(pid);
  return { tmp, deps, live };
}

test('sessionAliveNow: live registration matching sid and cwd', async (t) => {
  const { tmp, deps, live } = await aliveSetup(t);
  live.add(101);
  writeJson(path.join(deps.paths.sessionDir, 'a.json'), {
    kind: 'interactive', pid: 101, sessionId: 'sid-x',
    cwd: fs.realpathSync(tmp),
  });
  assert.equal(sessionAliveNow('sid-x', fs.realpathSync(tmp)), true);
});

test('sessionAliveNow: dead pid does not count', async (t) => {
  const { tmp, deps } = await aliveSetup(t);
  writeJson(path.join(deps.paths.sessionDir, 'a.json'), {
    kind: 'interactive', pid: 999, sessionId: 'sid-x',
    cwd: fs.realpathSync(tmp),
  });
  assert.equal(sessionAliveNow('sid-x', fs.realpathSync(tmp)), false);
});

test('sessionAliveNow: mismatched cwd does not count', async (t) => {
  const { tmp, deps, live } = await aliveSetup(t);
  live.add(101);
  writeJson(path.join(deps.paths.sessionDir, 'a.json'), {
    kind: 'interactive', pid: 101, sessionId: 'sid-x',
    cwd: fs.realpathSync(tmp),
  });
  assert.equal(sessionAliveNow('sid-x', '/somewhere/else'), false);
});

test('sessionAliveNow: half-written json is skipped and bad sid is false', async (t) => {
  const { deps, live } = await aliveSetup(t);
  live.add(101);
  fs.writeFileSync(path.join(deps.paths.sessionDir, 'bad.json'), '{ truncated');
  writeJson(path.join(deps.paths.sessionDir, 'ok.json'), {
    kind: 'interactive', pid: 101, sessionId: 'sid-ok', cwd: '/a',
  });
  assert.equal(sessionAliveNow('sid-missing', '/a'), false);
  assert.equal(sessionAliveNow(123, '/a'), false);
});

test('sessionAliveNow: missing session directory is false', async (t) => {
  const { deps } = await aliveSetup(t);
  deps.paths = { ...deps.paths, sessionDir: '/nonexistent/cron-up-sess-dir' };
  assert.equal(sessionAliveNow('sid-x', '/a'), false);
});

// ---- 活会话集合与逐任务创建者谓词 ----

test('liveSessionIds lists only string session ids of the workspace', () => {
  const details = new Map([
    ['/w', [
      claimDetail({ pid: 1, sessionId: 'a' }),
      claimDetail({ pid: 2, sessionId: null }),
      claimDetail({ pid: 3, sessionId: 'b' }),
    ]],
    ['/other', [claimDetail({ pid: 4, sessionId: 'c' })]],
  ]);
  assert.deepEqual([...liveSessionIds(details, '/w')].sort(), ['a', 'b']);
  assert.deepEqual([...liveSessionIds(details, '/nope')], []);
});

test('creatorSessionAlive matches the task owner against live session ids', () => {
  const live = new Set(['s1', 's2']);
  assert.equal(creatorSessionAlive({ createdBySessionId: 's1' }, live), true);
  assert.equal(creatorSessionAlive({ createdBySessionId: 'dead' }, live), false);
  assert.equal(creatorSessionAlive({}, live), false);
  assert.equal(creatorSessionAlive(null, live), false);
});
