import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  scanSessions,
  processShape,
  processParentMap,
  ancestorChain,
  classifyWorkspace,
  liveSessionIds,
} from '../src/registry.mjs';
import { procStartedAt } from '../src/sessions.mjs';
import { mkTmp, mockDeps, tmpPaths, writeJson } from '../test-support/helpers.mjs';

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
  deps.processShape = (pid) => ({
    isClaude: claude.has(pid),
    ppid: parents.get(pid) ?? null,
  });
  deps.processParentMap = () => new Map(parents);
  const writeReg = (name, pid, cwd, kind = 'interactive', extra = {}) => {
    writeJson(path.join(deps.paths.sessionDir, name), { pid, cwd, kind, ...extra });
    if (typeof pid === 'number' && pid > 0) parents.set(pid, 1);
  };
  return { tmp, deps, live, claude, parents, writeReg };
}

test('live claude consumers; dead and other kinds ignored', async (t) => {
  const { tmp, live, claude, writeReg } = await setup(t);
  live.add(101); live.add(202);
  claude.add(101); claude.add(202);
  writeReg('a.json', 101, fs.realpathSync(tmp));
  writeReg('dead.json', 999, '/nowhere/dead');
  writeReg('other.json', 202, '/nowhere/x', 'some-other');
  const [consumers, alert, details] = await scanSessions({ lineage: true });
  assert.deepEqual(consumers, new Set([fs.realpathSync(tmp)]));
  assert.equal(alert, null);
  const list = details.get(fs.realpathSync(tmp));
  assert.deepEqual(list.map((d) => d.pid), [101]); // 202 不是 interactive
  assert.deepEqual(list[0].ancestors, [1]);
  assert.equal(list[0].chainComplete, true);
  assert.equal(list[0].sessionId, null);
  assert.equal(list[0].procStart, null);
});

test('empty directory is quiet', async (t) => {
  await setup(t);
  assert.deepEqual(await scanSessions(), [new Set(), null, new Map()]);
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
  const [consumers, alert] = await scanSessions();
  assert.deepEqual(consumers, new Set([fs.realpathSync(tmp)]));
  assert.equal(alert, null);
  assert.deepEqual(sleeps, [100]);
});

test('permanently corrupt registration gives up after one retry', async (t) => {
  const { deps } = await setup(t);
  fs.writeFileSync(path.join(deps.paths.sessionDir, 'bad.json'), '{ truncated');
  const sleeps = [];
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
  // 必须用真实存活判定跑——这几道关是 scanSessions 唯一的防线。损坏登记
  // （如裸 Infinity 过不了 JSON.parse）一律按「读不进有效 pid 而跳过」。
  const { tmp, deps, parents, writeReg } = await setup(t);
  const me = process.pid;
  deps.alive = (p) => p === me;
  deps.processShape = (p) => ({
    isClaude: p === me,
    ppid: parents.get(p) ?? 1,
  });
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

// ---- processShape 的 claude 识别 ----

function detect(deps, comm, argsLine = '', ppid = 7) {
  deps.execFile = (file, a) => ({
    status: 0,
    stdout: `${a.some((x) => x.startsWith('args=')) ? argsLine : `${comm} ${ppid}`}\n`,
    stderr: '',
  });
  return processShape(42).isClaude;
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
  assert.deepEqual(processShape(42), { isClaude: false, ppid: null });
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

test('processShape parses comm and trailing ppid', (t) => {
  const deps = mockDeps(t);
  deps.execFile = (file, a) => {
    assert.deepEqual(a, ['-p', '42', '-o', 'comm=,ppid=']);
    return { status: 0, stdout: 'claude 51833\n', stderr: '' };
  };
  assert.deepEqual(processShape(42), { isClaude: true, ppid: 51833 });
});

test('processShape handles spaces in comm path and digit suffixes', (t) => {
  const deps = mockDeps(t);
  deps.execFile = () => ({
    status: 0,
    // 路径含空格；comm 本体以数字结尾（node22）时不能被当成 ppid 吞掉。
    stdout: '/a b/node22 88\n',
    stderr: '',
  });
  const shape = processShape(42);
  assert.equal(shape.ppid, 88);
  deps.execFile = () => ({ status: 0, stdout: 'node22 88\n', stderr: '' });
  // node22 不在解释器白名单，args 里有 claude 也不认。
  assert.equal(processShape(42).isClaude, false);
});

test('processShape missing ppid column reads null and falls back to args', (t) => {
  const deps = mockDeps(t);
  deps.execFile = (file, a) => ({
    status: 0,
    stdout: `${a.some((x) => x.startsWith('args='))
      ? 'node /opt/homebrew/bin/claude'
      : 'node'}\n`,
    stderr: '',
  });
  assert.deepEqual(processShape(42), { isClaude: true, ppid: null });
});

test('processParentMap parses full-table snapshot', (t) => {
  const deps = mockDeps(t);
  deps.execFile = () => ({
    status: 0,
    stdout: '   1     0\n  101     1\n  202   101\n',
    stderr: '',
  });
  const map = processParentMap();
  assert.equal(map.get(202), 101);
  assert.equal(map.get(1), 0);

  deps.execFile = () => ({ status: 1, stdout: '', stderr: 'boom' });
  assert.equal(processParentMap(), null);
  deps.execFile = () => ({ status: 0, stdout: '', stderr: '' });
  assert.equal(processParentMap(), null);
});

test('ancestorChain walks to launchd, flags broken chains', () => {
  // script(10) → zsh(20) → claude(30) 的生产三层结构；上溯到 launchd(1)
  // 即终止（不追加其父 0）。
  const full = new Map([[30, 20], [20, 10], [10, 1], [1, 0]]);
  assert.deepEqual(ancestorChain(30, full),
    { ancestors: [20, 10, 1], chainComplete: true });

  // 中间代在快照里缺失：链断在 20，不能宣称「10 不在祖先里」。
  const broken = new Map([[30, 20], [10, 1], [1, 0]]);
  assert.deepEqual(ancestorChain(30, broken),
    { ancestors: [20], chainComplete: false });

  // 无快照：空链、断链（调用方按全歧义处理）。
  assert.deepEqual(ancestorChain(30, null),
    { ancestors: [], chainComplete: false });

  // 成环防御：不能死循环。
  const loop = new Map([[30, 20], [20, 30]]);
  assert.equal(ancestorChain(30, loop).chainComplete, false);
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
  // 30：script(10) → zsh(20) → claude(30)；40 保持 1 → claude(40)。
  parents.set(30, 20); parents.set(20, 10); parents.set(10, 1);
  const [consumers, alert, details] = await scanSessions({ lineage: true });
  assert.equal(alert, null);
  assert.deepEqual(consumers, new Set([ws]));
  const byPid = new Map(details.get(ws).map((d) => [d.pid, d]));
  assert.deepEqual(byPid.get(30).ancestors, [20, 10, 1]);
  assert.equal(byPid.get(30).chainComplete, true);
  assert.equal(byPid.get(30).sessionId, 'sess-warm');
  // 双空格 lstart 原文透传，不做规范化。
  assert.equal(byPid.get(40).procStart, 'Thu Oct  8 09:10:00 2026');
  assert.deepEqual(byPid.get(40).ancestors, [1]);
});

test('broken lineage raises the fourth smoke alert', async (t) => {
  const { tmp, deps, live, claude, parents, writeReg } = await setup(t);
  const ws = fs.realpathSync(tmp);
  live.add(30);
  claude.add(30);
  writeReg('warm.json', 30, ws);
  // writeReg 默认补 pid→1，这里再挖掉：全量快照里没有 30，per-pid ps
  // 也读不到 ppid——scanSessions 应计为退化并告警。
  parents.delete(30);
  deps.processShape = () => ({ isClaude: true, ppid: null });
  const [consumers, alert, details] = await scanSessions({ lineage: true });
  assert.deepEqual(consumers, new Set([ws])); // 消费者判定不受影响
  assert.ok(alert);
  assert.ok(alert.includes('父子关系'));
  assert.equal(details.get(ws)[0].chainComplete, false);
});

test('lineage off: no details, no parent snapshot, no lineage alert', async (t) => {
  const { tmp, deps, live, claude, parents, writeReg } = await setup(t);
  const ws = fs.realpathSync(tmp);
  live.add(30);
  claude.add(30);
  writeReg('warm.json', 30, ws);
  parents.delete(30); // 即使链是断的
  deps.processShape = () => ({ isClaude: true, ppid: null });
  let snapShots = 0;
  deps.processParentMap = () => { snapShots += 1; return new Map(); };
  const [consumers, alert, details] = await scanSessions();
  assert.deepEqual(consumers, new Set([ws]));
  assert.equal(alert, null, '功能未开启时退化不告警');
  assert.deepEqual(details, new Map());
  assert.equal(snapShots, 0, '不拍全机父表');
});

// ---- classifyWorkspace：stampOwner 的认亲结论 ----

function detail(over = {}) {
  return {
    pid: 30, sessionId: 's', procStart: 'start',
    ancestors: [1], chainComplete: true, ...over,
  };
}

test('classifyWorkspace: own warm session recognised by ancestor pid', () => {
  const details = new Map([['/w', [detail({ ancestors: [20, 10, 1] })]]]);
  const v = classifyWorkspace(details, '/w', { pid: 10 }, true, false);
  assert.equal(v.kind, 'own');
  assert.equal(v.target.sessionId, 's');
});

test('classifyWorkspace: own but identity incomplete gives no target', () => {
  const details = new Map([['/w', [detail({ sessionId: null })]]]);
  const v = classifyWorkspace(details, '/w', { pid: 1 }, true, false);
  assert.equal(v.kind, 'own');
  assert.equal(v.target, null, '在场但本轮不能盖印');
});

test('classifyWorkspace: live creator is respected over a foreign user session', () => {
  const foreign = new Map([['/w', [
    detail({ pid: 30, sessionId: 'creator-sid', ancestors: [1] }),
  ]]]);
  // ent 活着但链里没有它，且窗口任务的创建者会话还活着：creatorAlive
  // 优先于 user/ambiguous，不另拉。
  assert.equal(classifyWorkspace(foreign, '/w', { pid: 10 }, true, true).kind,
    'creatorAlive');
  // 同一个现场但创建者已死：才落回 user。
  assert.equal(classifyWorkspace(foreign, '/w', { pid: 10 }, true, false).kind,
    'user');
  // 没有 ent（首轮）同理。
  assert.equal(classifyWorkspace(foreign, '/w', null, false, true).kind,
    'creatorAlive');
  assert.equal(classifyWorkspace(foreign, '/w', null, false, false).kind,
    'user');
});

test('classifyWorkspace: own takes precedence over live-creator flag', () => {
  // 已盖印给本代预热的任务，其 owner 就是预热自己——两态同时成立，own
  // 必须优先（target 还要继续供盖印判定）。
  const details = new Map([['/w', [detail({ ancestors: [20, 10, 1] })]]]);
  const v = classifyWorkspace(details, '/w', { pid: 10 }, true, true);
  assert.equal(v.kind, 'own');
  assert.ok(v.target);
});

test('classifyWorkspace: dead entry or foreign chain falls back to user/ambiguous', () => {
  const foreign = new Map([['/w', [detail({ ancestors: [1] })]]]);
  // ent 活着但链里没有它、创建者也不活：user。
  assert.equal(classifyWorkspace(foreign, '/w', { pid: 10 }, true, false).kind,
    'user');
  // ent 死了同链：不能再认亲，仍是 user（接管交给调度器原生规则）。
  assert.equal(classifyWorkspace(foreign, '/w', { pid: 10 }, false, false).kind,
    'user');
  // ent 为空（首轮/无条目）。
  assert.equal(classifyWorkspace(foreign, '/w', null, false, false).kind,
    'user');
});

test('classifyWorkspace: broken chain is ambiguous even with a live ent', () => {
  const details = new Map([['/w', [
    detail({ pid: 30, ancestors: [], chainComplete: false }),
  ]]]);
  assert.equal(classifyWorkspace(details, '/w', { pid: 10 }, true, false).kind,
    'ambiguous');
  // 认亲命中优先于歧义：自己的预热链完整时，别的断链会话不影响结论。
  details.get('/w').push(detail({ pid: 31, ancestors: [20, 10, 1] }));
  assert.equal(classifyWorkspace(details, '/w', { pid: 10 }, true, false).kind,
    'own');
});

test('classifyWorkspace: missing workspace is a plain user verdict', () => {
  assert.deepEqual(classifyWorkspace(new Map(), '/w', null, false, false),
    { kind: 'user', target: null });
  assert.deepEqual(classifyWorkspace(new Map(), '/w', null, false, true),
    { kind: 'creatorAlive', target: null });
});

test('liveSessionIds lists only string session ids of the workspace', () => {
  const details = new Map([
    ['/w', [
      { sessionId: 'a' },
      { sessionId: null },
      { sessionId: 'b' },
    ]],
    ['/other', [{ sessionId: 'c' }]],
  ]);
  assert.deepEqual([...liveSessionIds(details, '/w')].sort(), ['a', 'b']);
  assert.deepEqual([...liveSessionIds(details, '/nope')], []);
});
