// resolveLauncher / renderPlist / launcherHealth 与 install/uninstall 命令
// 的测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  resolveLauncher,
  renderPlist,
  readPlistProgramArgs,
  launcherHealth,
  writeServiceScript,
  cmdInstall,
  cmdUninstall,
} from '../src/service.mjs';
import { LABEL } from '../src/paths.mjs';
import { INTERVAL_SECONDS, DEFAULT_CONFIG } from '../src/constants.mjs';
import { normalizeRoots } from '../src/config.mjs';
import { ExitError } from '../src/internals.mjs';
import {
  mkTmp,
  mockDeps,
  tmpPaths,
  readJson,
  writeJson,
} from '../test-support/helpers.mjs';

function fakeExecutable(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, 0o755);
}

function isolatedFnmEnv(t, home) {
  // FNM_DIR 若在环境里会抢先命中，测试期间临时摘掉，强制走 home 布局。
  const saved = process.env.FNM_DIR;
  delete process.env.FNM_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.FNM_DIR;
    else process.env.FNM_DIR = saved;
  });
  return home;
}

// ---- resolveLauncher ----

test('launcher: fnm default alias wins and non-default cron-up bin is retained', (t) => {
  const home = isolatedFnmEnv(t, mkTmp(t));
  const aliasBin = path.join(home, '.local/share/fnm/aliases/default/bin');
  fakeExecutable(path.join(aliasBin, 'node'));
  const currentBin = '/x/fnm_multishells/1/bin';
  const r = resolveLauncher({
    home,
    execPath: path.join(currentBin, 'node'),
    cronUpPath: path.join(currentBin, 'cron-up'),
  });
  // 保留别名目录，不解析到版本化目录；当前实际 cron-up 也不丢。
  assert.deepEqual(r.pathDirs, [aliasBin, currentBin]);
});

test('launcher: FNM_DIR is honoured', (t) => {
  const home = mkTmp(t);
  const custom = path.join(mkTmp(t), 'custom-fnm');
  fakeExecutable(path.join(custom, 'aliases/default/bin/node'));
  process.env.FNM_DIR = custom;
  t.after(() => { delete process.env.FNM_DIR; });
  const r = resolveLauncher({ home });
  assert.ok(r.pathDirs[0].includes('custom-fnm'));
});

test('launcher: volta shim', (t) => {
  const home = isolatedFnmEnv(t, mkTmp(t));
  fakeExecutable(path.join(home, '.volta/bin/node'));
  assert.deepEqual(resolveLauncher({
    home, cronUpPath: path.join(home, '.volta/bin/cron-up') }).pathDirs,
  [path.join(home, '.volta', 'bin')]);
});

test('launcher: system bin dir is used as-is', (t) => {
  const home = isolatedFnmEnv(t, mkTmp(t));
  const sysBin = path.join(mkTmp(t), 'system-bin');
  fakeExecutable(path.join(sysBin, 'node'));
  const r = resolveLauncher({
    home,
    execPath: '/run/node',
    cronUpPath: path.join(sysBin, 'cron-up'),
    systemPaths: [path.join(sysBin, 'node')],
  });
  assert.deepEqual(r.pathDirs, [sysBin]);
});

test('launcher: standalone npm prefix survives a node in another directory', (t) => {
  const home = isolatedFnmEnv(t, mkTmp(t));
  const sysBin = path.join(mkTmp(t), 'system-bin');
  const npmBin = path.join(mkTmp(t), 'npm-prefix/bin');
  fakeExecutable(path.join(sysBin, 'node'));
  const r = resolveLauncher({
    home,
    execPath: '/nvm/versions/node/v22/bin/node',
    cronUpPath: path.join(npmBin, 'cron-up'),
    systemPaths: [path.join(sysBin, 'node')],
  });
  assert.deepEqual(r.pathDirs, [sysBin, npmBin]);
});

test('launcher: nothing recognised falls back to the running node bin dir', (t) => {
  const home = isolatedFnmEnv(t, mkTmp(t));
  const r = resolveLauncher({
    home,
    execPath: '/run/node',
    cronUpPath: '/run/cron-up',
    systemPaths: [],
  });
  assert.deepEqual(r.pathDirs, ['/run']);
  assert.ok(r.note);
});

test('launcher priority: fnm beats volta', (t) => {
  const home = isolatedFnmEnv(t, mkTmp(t));
  fakeExecutable(path.join(home, '.local/share/fnm/aliases/default/bin/node'));
  fakeExecutable(path.join(home, '.volta/bin/node'));
  assert.ok(resolveLauncher({ home }).pathDirs[0].includes('fnm'));
});

// ---- 启动脚本与 plist ----

// 装好一条完整的启动链（脚本 + plist）。
function installLaunchChain(t, pathDirs) {
  const deps = mockDeps(t);
  deps.paths = tmpPaths(mkTmp(t));
  const script = writeServiceScript({ pathDirs });
  fs.writeFileSync(deps.paths.plistPath, renderPlist(script));
  return deps;
}

test('service script execs cron-up via PATH', (t) => {
  const deps = mockDeps(t);
  deps.paths = tmpPaths(mkTmp(t));
  writeServiceScript({
    pathDirs: ['/Users/u/.local/share/fnm/aliases/default/bin'] });
  const script = deps.paths.serviceScriptPath;
  assert.equal(fs.readFileSync(script, 'utf-8'),
    '#!/bin/bash\n'
    + '# 由 cron-up install 生成；重跑 cron-up install 覆盖重生成\n'
    + 'export PATH=/Users/u/.local/share/fnm/aliases/default/bin:"$PATH"\n'
    + 'exec cron-up run\n');
  assert.equal(fs.statSync(script).mode & 0o777, 0o755);
});

test('service script and launcherHealth agree on shell-special PATH dirs', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  const bin = path.join(tmp, "bin with ' \" $");
  fakeExecutable(path.join(bin, 'node'));
  fakeExecutable(path.join(bin, 'cron-up'));
  const script = writeServiceScript({ pathDirs: [bin] });
  fs.writeFileSync(deps.paths.plistPath, renderPlist(script));
  assert.equal(launcherHealth(), null);
  assert.match(fs.readFileSync(script, 'utf-8'), /^export PATH=.+:"\$PATH"$/m);
});

test('launcherHealth resolves PATH-form script against stable bins', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  const bin = path.join(tmp, 'stable-bin');
  fs.mkdirSync(bin, { recursive: true });
  const writeScript = () => {
    const script = deps.paths.serviceScriptPath;
    fs.writeFileSync(script,
      `#!/bin/bash\nexport PATH="${bin}":"$PATH"\nexec cron-up run\n`);
    fs.writeFileSync(deps.paths.plistPath, renderPlist(script));
  };
  // bin 里 cron-up 与 node 都在：健康。
  for (const name of ['cron-up', 'node']) {
    fs.writeFileSync(path.join(bin, name), '');
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  writeScript();
  assert.equal(launcherHealth(), null);
  // 切换默认版本后忘了在新版本里装包：cron-up 解析不到。
  fs.rmSync(path.join(bin, 'cron-up'));
  assert.ok(launcherHealth()?.includes('找不到 cron-up'));
  fs.writeFileSync(path.join(bin, 'cron-up'), '');
  fs.chmodSync(path.join(bin, 'cron-up'), 0o755);
  fs.rmSync(path.join(bin, 'node'));
  assert.ok(launcherHealth()?.includes('找不到 node'));
});

test('renderPlist points ProgramArguments at the service script only', (t) => {
  const deps = installLaunchChain(t, ['/x/bin']);
  const xml = fs.readFileSync(deps.paths.plistPath, 'utf-8');
  assert.ok(xml.includes('<string>local.cron-up</string>'));
  assert.ok(xml.includes(`<string>${deps.paths.serviceScriptPath}</string>`));
  assert.ok(!xml.includes('/x/bin')); // node 路径只在脚本里
  assert.ok(xml.includes(`<integer>${INTERVAL_SECONDS}</integer>`));
});

test('renderPlist XML-escapes ampersands in the script path', (t) => {
  const deps = mockDeps(t);
  deps.paths = tmpPaths(mkTmp(t));
  const xml = renderPlist('/x/a&b/cron-up-service');
  assert.ok(xml.includes('/x/a&amp;b/cron-up-service'));
});

test('launcherHealth flags a missing service script', (t) => {
  const deps = installLaunchChain(t, ['/x/bin']);
  fs.rmSync(deps.paths.serviceScriptPath);
  const alert = launcherHealth();
  assert.ok(alert && alert.includes('启动脚本已失效'));
});

test('launcherHealth flags a hand-edited service script', (t) => {
  const deps = installLaunchChain(t, ['/x/bin']);
  fs.writeFileSync(deps.paths.serviceScriptPath, '#!/bin/bash\necho hi\n');
  const alert = launcherHealth();
  assert.ok(alert && alert.includes('无法解读'));
});

test('launcherHealth flags an unreadable ProgramArguments block', (t) => {
  const deps = mockDeps(t);
  deps.paths = tmpPaths(mkTmp(t));
  fs.writeFileSync(deps.paths.plistPath, '<plist>broken</plist>');
  const alert = launcherHealth();
  assert.ok(alert && alert.includes('ProgramArguments'));
});

test('launcherHealth is null without a plist', (t) => {
  const deps = mockDeps(t);
  deps.paths = tmpPaths(mkTmp(t));
  assert.equal(launcherHealth(), null);
});

test('launchctl probe separates explicit unload from query failure', (t) => {
  const deps = mockDeps(t);
  deps.launchctl = () => ({
    status: 113,
    stdout: '',
    stderr: 'Could not find service "local.cron-up" in domain for user gui: 501',
  });
  assert.equal(deps.launchctlProbe().kind, 'unloaded');
  assert.equal(deps.launchctlInfo(), null, '总览接口保持 info/null');
  deps.launchctl = () => ({ status: 1, stdout: '', stderr: 'Operation not permitted' });
  const failed = deps.launchctlProbe();
  assert.equal(failed.kind, 'unknown');
  assert.ok(failed.message.includes('Operation not permitted'));
});

// ---- install ----

async function setupInstall(t) {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp, {
    // LaunchAgents 父目录刻意不预建，install 必须自己创建。
    plistPath: path.join(tmp, 'LaunchAgents', 'cron-up.plist'),
  });
  const launchBin = path.join(tmp, 'launch-bin');
  fakeExecutable(path.join(launchBin, 'node'));
  fakeExecutable(path.join(launchBin, 'cron-up'));
  deps.resolveLauncher = () => ({ pathDirs: [launchBin] });
  const launchCalls = [];
  deps.launchctl = (...a) => {
    launchCalls.push(a);
    return { status: 0, stderr: '' };
  };
  let patrolResult = true;
  let patrolCalls = 0;
  deps.runPatrol = async () => {
    patrolCalls += 1;
    return patrolResult;
  };
  const lines = [];
  deps.print = (m) => lines.push(m);
  deps.printErr = (m) => lines.push(`ERR:${m}`);
  // install 现在只认 --roots：默认给 tmp，测试可显式覆盖（含 undefined
  // 模拟不带参数，此时应继承现有配置或落默认值）。
  const install = (args = {}) => cmdInstall({ roots: tmp, ...args });
  const cfg = () => readJson(deps.paths.configPath);
  return {
    tmp, deps, lines, launchCalls, install, cfg, launchBin,
    setPatrolResult: (v) => { patrolResult = v; },
    patrolCalls: () => patrolCalls,
  };
}

test('install writes roots-only config, plist, bootstraps and runs first patrol', async (t) => {
  const s = await setupInstall(t);
  await s.install();
  assert.deepEqual(s.cfg(), { roots: [s.tmp] }, '配置只剩 roots');
  assert.ok(fs.existsSync(s.deps.paths.plistPath));
  // 启动脚本随 install 生成，一律 PATH 形态，plist 只指向它。
  assert.ok(fs.existsSync(s.deps.paths.serviceScriptPath));
  assert.equal(fs.statSync(s.deps.paths.serviceScriptPath).mode & 0o777, 0o755);
  assert.match(fs.readFileSync(s.deps.paths.serviceScriptPath, 'utf-8'),
    /^export PATH=.+:"\$PATH"$/m);
  assert.deepEqual(readPlistProgramArgs(), [s.deps.paths.serviceScriptPath]);
  assert.ok(s.launchCalls.some((c) => c[0] === 'bootstrap'));
  assert.ok(s.lines.some((l) => l.includes('已加载到 launchd')));
  assert.ok(s.lines.some((l) => l.includes('首轮巡检完成')));
  assert.equal(LABEL, 'local.cron-up');
});

test('first patrol message matches what actually happened', async (t) => {
  const s = await setupInstall(t);
  s.setPatrolResult(true);
  await s.install();
  assert.ok(s.lines.some((l) => l.includes('首轮巡检完成')));
  const s2 = await setupInstall(t);
  s2.setPatrolResult(false);
  await s2.install();
  assert.ok(s2.lines.some((l) => l.includes('首轮巡检暂未执行')));
});

test('install rejects --config instead of silently ignoring it', async (t) => {
  const s = await setupInstall(t);
  await assert.rejects(s.install({ config: '/tmp/elsewhere.json' }), (e) => {
    assert.ok(e instanceof ExitError);
    assert.equal(e.code, 2);
    assert.ok(e.message.includes('--config'));
    return true;
  });
  // 一行报错走人，不能留下半个安装。
  assert.equal(fs.existsSync(s.deps.paths.configPath), false);
});

test('explicitly empty roots is rejected loudly', async (t) => {
  const s = await setupInstall(t);
  await assert.rejects(s.install({ roots: ',' }),
    (e) => e instanceof ExitError && e.code === 1);
  assert.equal(fs.existsSync(s.deps.paths.configPath), false);
});

test('comma-separated roots are normalised and persisted', async (t) => {
  const s = await setupInstall(t);
  const a = path.join(s.tmp, 'a');
  const b = path.join(s.tmp, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  await s.install({ roots: `${a},${b}` });
  assert.deepEqual(s.cfg().roots, [a, b]);
});

test('corrupt existing config does not block install: falls back with a notice', async (t) => {
  const s = await setupInstall(t);
  fs.writeFileSync(s.deps.paths.configPath, '{ not json');
  await s.install({ roots: undefined }); // 不带 --roots：读旧配置失败，回默认
  assert.deepEqual(s.cfg().roots, normalizeRoots(DEFAULT_CONFIG.roots));
  assert.ok(s.lines.some((l) => l.includes('现有配置无法解读')));
});

test('rerun without --roots keeps existing roots', async (t) => {
  const s = await setupInstall(t);
  const custom = path.join(s.tmp, 'keep-me');
  fs.mkdirSync(custom);
  writeJson(s.deps.paths.configPath, { roots: [custom] });
  await s.install({ roots: undefined });
  assert.deepEqual(s.cfg().roots, [custom]);
});

test('explicit --roots overrides the existing config', async (t) => {
  const s = await setupInstall(t);
  writeJson(s.deps.paths.configPath, { roots: ['/old/place'] });
  await s.install();
  assert.deepEqual(s.cfg().roots, [s.tmp]);
});

test('obsolete config keys are purged on reinstall', async (t) => {
  const s = await setupInstall(t);
  writeJson(s.deps.paths.configPath, {
    roots: [s.tmp],
    autoRenew: false,
    autoMinId: false,
    sessionRetain: 'always',
    stampOwner: false,
    intervalSeconds: 999,
    leadSeconds: 1,
    maxDepth: 9,
  });
  await s.install({ roots: undefined });
  assert.deepEqual(Object.keys(s.cfg()).sort(), ['roots']);
  assert.deepEqual(s.cfg().roots, [s.tmp]);
});

test('default roots prints a safety notice', async (t) => {
  const s = await setupInstall(t);
  fs.rmSync(s.deps.paths.configPath, { force: true });
  await s.install({ roots: undefined });
  assert.ok(s.lines.some((l) => l.includes('--roots') && l.includes('clone')));
});

test('non-default roots prints no safety notice', async (t) => {
  const s = await setupInstall(t);
  await s.install();
  assert.ok(!s.lines.some((l) => l.includes('今后 clone')));
});

test('bootstrap failure exits 1', async (t) => {
  const s = await setupInstall(t);
  s.deps.launchctl = (...a) => (a[0] === 'bootstrap'
    ? { status: 5, stderr: 'bootstrap failed' }
    : { status: 0, stderr: '' });
  await assert.rejects(s.install(), (e) => e instanceof ExitError && e.code === 1);
});

test('enable failure is fatal and never reports a loaded service', async (t) => {
  const s = await setupInstall(t);
  s.deps.launchctl = (...a) => (a[0] === 'enable'
    ? { status: 8, stderr: 'enable failed' }
    : { status: 0, stdout: '', stderr: '' });
  await assert.rejects(s.install(), (e) => e instanceof ExitError && e.code === 1);
  assert.ok(!s.lines.some((l) => l === '已加载到 launchd'));
  assert.ok(s.lines.some((l) => l.includes('enable failed')));
  assert.equal(s.patrolCalls(), 0);
});

test('install verifies the loaded service before running a manual patrol', async (t) => {
  const s = await setupInstall(t);
  s.deps.launchctlInfo = () => null;
  await assert.rejects(s.install(), (e) => e instanceof ExitError && e.code === 1);
  assert.ok(!s.lines.some((l) => l === '已加载到 launchd'));
  assert.equal(s.patrolCalls(), 0);
});

test('broken launcher is rejected before bootstrap and cannot be hidden by patrol', async (t) => {
  const s = await setupInstall(t);
  s.deps.resolveLauncher = () => ({ pathDirs: [path.join(s.tmp, 'missing-bin')] });
  await assert.rejects(s.install(), (e) => e instanceof ExitError && e.code === 1);
  assert.ok(s.lines.some((l) => l.includes('启动链自检失败')));
  assert.ok(!s.launchCalls.some((c) => c[0] === 'bootstrap'));
  assert.equal(s.patrolCalls(), 0);
});

// ---- uninstall ----

async function setupUninstall(t) {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp, { plistPath: path.join(tmp, 'x.plist') });
  let loaded = true;
  const launchCalls = [];
  deps.launchctlProbe = () => (loaded
    ? { kind: 'loaded', info: { state: 'not running' } }
    : { kind: 'unloaded' });
  deps.launchctl = (...a) => {
    launchCalls.push(a);
    if (a[0] === 'bootout') loaded = false;
    return { status: 0, stdout: '', stderr: '' };
  };
  let lockReleased = 0;
  let lockHeld = false;
  deps.acquireRunLock = () => {
    if (lockHeld) return null;
    lockHeld = true;
    return { lockPath: path.join(tmp, 'run.lock') };
  };
  deps.releaseRunLock = () => {
    lockHeld = false;
    lockReleased += 1;
  };
  const stopped = [];
  deps.stopSession = async (ent) => {
    stopped.push(ent.pid);
    return true;
  };
  deps.trackedAlive = (ent) => Boolean(ent.pid);
  deps.procStartedAt = (pid) => `start-${pid}`;
  deps.listScriptProcesses = () => [];
  const lines = [];
  deps.print = (m) => lines.push(m);
  deps.printErr = (m) => lines.push(`ERR:${m}`);
  const uninstall = (kw = {}) => cmdUninstall(kw);
  return {
    tmp, deps, stopped, lines, uninstall, launchCalls,
    lockReleased: () => lockReleased,
  };
}

test('uninstall rejects --config instead of silently ignoring it', async (t) => {
  const s = await setupUninstall(t);
  await assert.rejects(s.uninstall({ config: '/tmp/elsewhere.json' }), (e) => {
    assert.ok(e instanceof ExitError);
    assert.equal(e.code, 2);
    assert.ok(e.message.includes('--config'));
    return true;
  });
  assert.deepEqual(s.stopped, []);
});

test('nested-state task warmups are stopped by default', async (t) => {
  const s = await setupUninstall(t);
  writeJson(s.deps.paths.statePath, {
    '/x': { '00000001': { pid: 11 }, '00000002': { pid: 12 } },
    '/y': { '00000003': { pid: 22 } },
  });
  await s.uninstall();
  assert.deepEqual(s.stopped.sort(), [11, 12, 22]);
  assert.equal(s.lockReleased(), 1);
  assert.ok(s.lines.some((l) => l.includes('正在结束预热会话')));
});

test('legacy flat-state warmups are stopped too', async (t) => {
  const s = await setupUninstall(t);
  writeJson(s.deps.paths.statePath, {
    '/x': { pid: 33, startedAt: 1 },
    '/y': { pid: 44, startedAt: 1 },
  });
  await s.uninstall();
  assert.deepEqual(s.stopped.sort(), [33, 44]);
});

test('orphan script sessions outside state are swept on uninstall', async (t) => {
  const s = await setupUninstall(t);
  const logDir = s.deps.paths.sessionLogDir;
  s.deps.listScriptProcesses = () => [
    // 新命名（任务级）与旧命名（目录级）的本工具孤儿都停。
    [31, `/usr/bin/script -q ${logDir}/a_b--00000001.log /bin/zsh -lic x`],
    [34, `/usr/bin/script -q ${logDir}/a_b.log /bin/zsh -lic x`],
    // 别人的 script 会话：日志不在本工具目录、形态不同，都不动。
    [32, '/usr/bin/script -q /other/place.log /bin/zsh -lic x'],
    [33, '/usr/bin/script -q /somewhere /bin/bash -ic x'],
  ];
  await s.uninstall();
  assert.deepEqual(s.stopped.sort(), [31, 34]);
  assert.ok(s.lines.some((l) => l.includes('state 已丢失')));
});

test('uninstall refuses to race an active patrol and releases no untaken lock', async (t) => {
  const s = await setupUninstall(t);
  fs.writeFileSync(s.deps.paths.plistPath, '<plist/>');
  s.deps.acquireRunLock = () => null;
  await assert.rejects(s.uninstall({ purge: true }),
    (e) => e instanceof ExitError && e.code === 1);
  assert.ok(s.lines.some((l) => l.includes('稍后重试')));
  assert.equal(s.launchCalls.length, 0);
  assert.deepEqual(s.stopped, []);
  assert.equal(fs.existsSync(s.deps.paths.plistPath), true);
  assert.equal(s.lockReleased(), 0);
});

test('real bootout failure preserves plist and purgable data', async (t) => {
  const s = await setupUninstall(t);
  fs.writeFileSync(s.deps.paths.plistPath, '<plist/>');
  s.deps.launchctl = () => ({ status: 5, stdout: '', stderr: 'bootout failed' });
  await assert.rejects(s.uninstall({ purge: true }),
    (e) => e instanceof ExitError && e.code === 1);
  assert.ok(s.lines.some((l) => l.includes('bootout failed')));
  assert.deepEqual(s.stopped, []);
  assert.equal(fs.existsSync(s.deps.paths.plistPath), true);
  assert.equal(fs.existsSync(s.deps.paths.dataDir), true);
  assert.equal(fs.existsSync(s.deps.paths.logDir), true);
  assert.equal(s.lockReleased(), 1);
});

test('already unloaded service skips bootout and still cleans up', async (t) => {
  const s = await setupUninstall(t);
  fs.writeFileSync(s.deps.paths.plistPath, '<plist/>');
  s.deps.launchctlProbe = () => ({ kind: 'unloaded' });
  s.deps.launchctl = () => { throw new Error('未加载时不该调用 bootout'); };
  await s.uninstall();
  assert.equal(fs.existsSync(s.deps.paths.plistPath), false);
  assert.equal(s.lockReleased(), 1);
});

test('unknown launchd state before bootout aborts all deletion', async (t) => {
  const s = await setupUninstall(t);
  fs.writeFileSync(s.deps.paths.plistPath, '<plist/>');
  s.deps.launchctlProbe = () => ({ kind: 'unknown', message: 'print timed out' });
  s.deps.launchctl = () => { throw new Error('状态未知时不该调用 bootout'); };
  await assert.rejects(s.uninstall({ purge: true }),
    (e) => e instanceof ExitError && e.code === 1);
  assert.ok(s.lines.some((l) => l.includes('print timed out')));
  assert.deepEqual(s.stopped, []);
  assert.equal(fs.existsSync(s.deps.paths.plistPath), true);
  assert.equal(fs.existsSync(s.deps.paths.dataDir), true);
  assert.equal(fs.existsSync(s.deps.paths.logDir), true);
  assert.equal(s.lockReleased(), 1);
});

test('unknown launchd state after bootout also aborts all deletion', async (t) => {
  const s = await setupUninstall(t);
  fs.writeFileSync(s.deps.paths.plistPath, '<plist/>');
  let probes = 0;
  s.deps.launchctlProbe = () => {
    probes += 1;
    return probes === 1
      ? { kind: 'loaded', info: {} }
      : { kind: 'unknown', message: 'print timed out' };
  };
  s.deps.launchctl = () => ({ status: 0, stdout: '', stderr: '' });
  await assert.rejects(s.uninstall({ purge: true }),
    (e) => e instanceof ExitError && e.code === 1);
  assert.ok(s.lines.some((l) => l.includes('bootout 后无法确认')));
  assert.deepEqual(s.stopped, []);
  assert.equal(fs.existsSync(s.deps.paths.plistPath), true);
  assert.equal(fs.existsSync(s.deps.paths.dataDir), true);
  assert.equal(fs.existsSync(s.deps.paths.logDir), true);
  assert.equal(s.lockReleased(), 1);
});

test('successful bootout that still leaves a loaded service aborts cleanup', async (t) => {
  const s = await setupUninstall(t);
  fs.writeFileSync(s.deps.paths.plistPath, '<plist/>');
  // 不翻转 setup 里的 loaded：模拟 bootout 返回成功但 print 仍能查到。
  s.deps.launchctl = () => ({ status: 0, stdout: '', stderr: '' });
  await assert.rejects(s.uninstall({ purge: true }),
    (e) => e instanceof ExitError && e.code === 1);
  assert.ok(s.lines.some((l) => l.includes('服务仍能查到')));
  assert.deepEqual(s.stopped, []);
  assert.equal(fs.existsSync(s.deps.paths.plistPath), true);
  assert.equal(s.lockReleased(), 1);
});

test('a live warmup that cannot be stopped safely aborts destructive cleanup', async (t) => {
  const s = await setupUninstall(t);
  writeJson(s.deps.paths.statePath, {
    '/x': { '00000001': { pid: 11 } },
  });
  fs.writeFileSync(s.deps.paths.plistPath, '<plist/>');
  const keepLog = path.join(s.deps.paths.logDir, 'keep.log');
  fs.writeFileSync(keepLog, 'keep');
  s.deps.stopSession = async () => false;
  await assert.rejects(s.uninstall({ purge: true }),
    (e) => e instanceof ExitError && e.code === 1);
  assert.ok(s.lines.some((l) => l.includes('无法安全停止')));
  assert.equal(fs.existsSync(s.deps.paths.plistPath), true);
  assert.equal(fs.existsSync(s.deps.paths.statePath), true);
  assert.equal(fs.existsSync(keepLog), true);
  assert.equal(s.lockReleased(), 1);
});

test('purge removes data and points at npm for the binary', async (t) => {
  const s = await setupUninstall(t);
  fs.writeFileSync(s.deps.paths.plistPath, '<plist/>');
  fs.writeFileSync(path.join(s.deps.paths.dataDir, 'state.json'), '{}');
  await s.uninstall({ purge: true });
  assert.equal(fs.existsSync(s.deps.paths.dataDir), false);
  assert.equal(fs.existsSync(s.deps.paths.logDir), false);
  assert.ok(s.lines.some((l) => l.includes('npm uninstall -g cron-up')));
});
