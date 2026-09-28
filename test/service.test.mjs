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
import { ExitError } from '../src/internals.mjs';
import {
  mkTmp,
  mockDeps,
  tmpPaths,
  readJson,
  writeJson,
} from '../test-support/helpers.mjs';

function fakeNode(file) {
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

test('launcher: fnm default alias wins and is not realpath-ed', (t) => {
  const home = isolatedFnmEnv(t, mkTmp(t));
  const aliasBin = path.join(home, '.local/share/fnm/aliases/default/bin');
  fakeNode(path.join(aliasBin, 'node'));
  const r = resolveLauncher({ home, execPath: '/x/fnm_multishells/1/bin/node' });
  assert.deepEqual(r.pathDirs, [aliasBin]); // 保留别名目录，不解析到版本化目录
});

test('launcher: FNM_DIR is honoured', (t) => {
  const home = mkTmp(t);
  const custom = path.join(mkTmp(t), 'custom-fnm');
  fakeNode(path.join(custom, 'aliases/default/bin/node'));
  process.env.FNM_DIR = custom;
  t.after(() => { delete process.env.FNM_DIR; });
  const r = resolveLauncher({ home });
  assert.ok(r.pathDirs[0].includes('custom-fnm'));
});

test('launcher: volta shim', (t) => {
  const home = isolatedFnmEnv(t, mkTmp(t));
  fakeNode(path.join(home, '.volta/bin/node'));
  assert.deepEqual(resolveLauncher({ home }).pathDirs,
    [path.join(home, '.volta', 'bin')]);
});

test('launcher: system bin dir is used as-is', (t) => {
  const home = isolatedFnmEnv(t, mkTmp(t));
  const sysBin = path.join(mkTmp(t), 'system-bin');
  fakeNode(path.join(sysBin, 'node'));
  const r = resolveLauncher({
    home, execPath: '/run/node', systemPaths: [path.join(sysBin, 'node')] });
  assert.deepEqual(r.pathDirs, [sysBin]);
});

test('launcher: nothing recognised falls back to the running node bin dir', (t) => {
  const home = isolatedFnmEnv(t, mkTmp(t));
  const r = resolveLauncher({ home, execPath: '/run/node', systemPaths: [] });
  assert.deepEqual(r.pathDirs, ['/run']);
  assert.ok(r.note);
});

test('launcher priority: fnm beats volta', (t) => {
  const home = isolatedFnmEnv(t, mkTmp(t));
  fakeNode(path.join(home, '.local/share/fnm/aliases/default/bin/node'));
  fakeNode(path.join(home, '.volta/bin/node'));
  assert.ok(resolveLauncher({ home }).pathDirs[0].includes('fnm'));
});

// ---- 启动脚本与 plist ----

// 装好一条完整的启动链（脚本 + plist）。
function installLaunchChain(t, pathDirs) {
  const deps = mockDeps(t);
  deps.paths = tmpPaths(mkTmp(t));
  const script = writeServiceScript({ pathDirs });
  fs.writeFileSync(deps.paths.plistPath, renderPlist(300, script));
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
    + '# 由 cron-up install 生成；重跑 cron-up install --force 覆盖重生成\n'
    + 'export PATH="/Users/u/.local/share/fnm/aliases/default/bin":"$PATH"\n'
    + 'exec cron-up run\n');
  assert.equal(fs.statSync(script).mode & 0o777, 0o755);
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
    fs.writeFileSync(deps.paths.plistPath, renderPlist(300, script));
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
  assert.ok(xml.includes('<integer>300</integer>'));
});

test('renderPlist XML-escapes ampersands in the script path', (t) => {
  const deps = mockDeps(t);
  deps.paths = tmpPaths(mkTmp(t));
  const xml = renderPlist(300, '/x/a&b/cron-up-service');
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

test('launcherHealth is null without a plist', (t) => {
  const deps = mockDeps(t);
  deps.paths = tmpPaths(mkTmp(t));
  assert.equal(launcherHealth(), null);
});

// ---- install ----

async function setupInstall(t) {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp, { plistPath: path.join(tmp, 'cron-up.plist') });
  const launchCalls = [];
  deps.launchctl = (...a) => {
    launchCalls.push(a);
    return { status: 0, stderr: '' };
  };
  let patrolResult = true;
  deps.runPatrol = async () => patrolResult;
  const lines = [];
  deps.print = (m) => lines.push(m);
  deps.printErr = (m) => lines.push(`ERR:${m}`);
  const install = async (kw = {}) => cmdInstall({
    roots: tmp,
    interval: undefined,
    lead: undefined,
    force: true,
    ...kw,
  });
  const cfg = () => readJson(deps.paths.configPath);
  return {
    tmp, deps, lines, launchCalls, install, cfg,
    setPatrolResult: (v) => { patrolResult = v; },
  };
}

test('install writes config, plist, bootstraps and runs first patrol', async (t) => {
  const s = await setupInstall(t);
  await s.install();
  assert.equal(s.cfg().intervalSeconds, 300);
  assert.ok(fs.existsSync(s.deps.paths.plistPath));
  // 启动脚本随 install 生成，一律 PATH 形态，plist 只指向它。
  assert.ok(fs.existsSync(s.deps.paths.serviceScriptPath));
  assert.equal(fs.statSync(s.deps.paths.serviceScriptPath).mode & 0o777, 0o755);
  assert.match(fs.readFileSync(s.deps.paths.serviceScriptPath, 'utf-8'),
    /^export PATH=".*":"\$PATH"$/m);
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

test('zero lead is an explicit choice', async (t) => {
  const s = await setupInstall(t);
  await s.install({ lead: 0 });
  assert.equal(s.cfg().leadSeconds, 0);
});

test('zero interval is rejected loudly', async (t) => {
  const s = await setupInstall(t);
  await assert.rejects(s.install({ interval: 0 }), (e) => {
    assert.ok(e instanceof ExitError);
    assert.equal(e.code, 1);
    return true;
  });
});

test('non-object legacy config is ignored on force', async (t) => {
  const s = await setupInstall(t);
  fs.writeFileSync(s.deps.paths.configPath, '123');
  await s.install();
  assert.equal(s.cfg().intervalSeconds, 300);
  assert.deepEqual(s.cfg().roots, [s.tmp]);
});

test('corrupt config without force points to --force and force recovers', async (t) => {
  const s = await setupInstall(t);
  fs.writeFileSync(s.deps.paths.configPath, '{ not json');
  await assert.rejects(s.install({ force: false }), (e) => {
    assert.ok(e instanceof ExitError);
    assert.equal(e.code, 2);
    assert.ok(e.message.includes('--force'));
    return true;
  });
  await s.install();
  assert.equal(s.cfg().intervalSeconds, 300);
});

test('bool interval in config is rejected loudly', async (t) => {
  // 配置字段类型错统一走 loadConfig 的 ExitError(2)，install 会附上
  // --force 出口。（setupInstall 默认 force，这里显式走非 force 路径。）
  const s = await setupInstall(t);
  writeJson(s.deps.paths.configPath, {
    roots: [s.tmp], maxDepth: 2, intervalSeconds: true, leadSeconds: 600,
  });
  await assert.rejects(s.install({ force: false }), (e) => e instanceof ExitError
    && e.code === 2 && /--force/.test(e.message));
});

test('explicitly empty roots is rejected loudly', async (t) => {
  const s = await setupInstall(t);
  await assert.rejects(s.install({ roots: ',' }),
    (e) => e instanceof ExitError && e.code === 1);
});

test('default roots prints a safety notice', async (t) => {
  const s = await setupInstall(t);
  fs.rmSync(s.deps.paths.configPath, { force: true });
  await s.install({ roots: undefined });
  assert.ok(s.lines.some((l) => l.includes('--roots') && l.includes('clone')));
});

test('explicit roots prints no safety notice', async (t) => {
  const s = await setupInstall(t);
  await s.install();
  assert.ok(!s.lines.some((l) => l.includes('今后 clone')));
});

test('omitted flags preserve existing values', async (t) => {
  const s = await setupInstall(t);
  await s.install({ lead: 45 });
  await s.install({ interval: 120 });
  assert.equal(s.cfg().leadSeconds, 45);
  assert.equal(s.cfg().intervalSeconds, 120);
});

test('force drops only the mistyped legacy fields', async (t) => {
  const s = await setupInstall(t);
  await s.install({ roots: `${s.tmp}/ws` });
  // 手改坏两个字段，force 重装：坏字段回默认并当面提示，好字段照旧继承
  // （roots 不给命令行值，验证它来自继承而非 helper 默认）。
  writeJson(s.deps.paths.configPath, {
    ...s.cfg(), autoRenew: 'false', maxDepth: true,
  });
  await s.install({ roots: undefined });
  assert.equal(s.cfg().autoRenew, true); // DEFAULT_CONFIG
  assert.equal(s.cfg().maxDepth, 2);
  assert.deepEqual(s.cfg().roots, [`${s.tmp}/ws`]);
  assert.ok(s.lines.some((l) => l.includes('autoRenew') && l.includes('未继承')));
  assert.ok(s.lines.some((l) => l.includes('maxDepth') && l.includes('未继承')));
});

test('auto-renew flags set the value; omitted preserves', async (t) => {
  let s = await setupInstall(t);
  await s.install({ autoRenew: true });
  assert.equal(s.cfg().autoRenew, true);
  await s.install({ autoRenew: false });
  assert.equal(s.cfg().autoRenew, false);
  await s.install();
  assert.equal(s.cfg().autoRenew, false); // 省略则保留
});

test('bootstrap failure exits 1', async (t) => {
  const s = await setupInstall(t);
  s.deps.launchctl = (...a) => (a[0] === 'bootstrap'
    ? { status: 5, stderr: 'bootstrap failed' }
    : { status: 0, stderr: '' });
  await assert.rejects(s.install(), (e) => e instanceof ExitError && e.code === 1);
});

test('without --force existing config is kept', async (t) => {
  const s = await setupInstall(t);
  await s.install();
  const lines2 = [];
  s.deps.print = (m) => lines2.push(m);
  await cmdInstall({ roots: '/other', force: false });
  assert.ok(lines2.some((l) => l.includes('保留现有配置')));
  assert.deepEqual(s.cfg().roots, [s.tmp]); // 没被 /other 覆盖
});

// ---- uninstall ----

async function setupUninstall(t) {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp, { plistPath: path.join(tmp, 'x.plist') });
  deps.launchctl = () => ({ status: 0, stderr: '' });
  const stopped = [];
  deps.stopSession = async (ent) => { stopped.push(ent.pid); };
  deps.trackedAlive = (ent) => Boolean(ent.pid);
  deps.listScriptProcesses = () => [];
  const lines = [];
  deps.print = (m) => lines.push(m);
  const uninstall = (kw = {}) => cmdUninstall({
    purge: false, keepSessions: false, ...kw });
  return { tmp, deps, stopped, lines, uninstall };
}

test('sessions are stopped by default', async (t) => {
  const s = await setupUninstall(t);
  writeJson(s.deps.paths.statePath, { '/x': { pid: 11 }, '/y': { pid: 22 } });
  await s.uninstall();
  assert.deepEqual(s.stopped.sort(), [11, 22]);
  assert.ok(s.lines.some((l) => l.includes('正在结束保活会话')));
});

test('keep-sessions leaves them running', async (t) => {
  const s = await setupUninstall(t);
  writeJson(s.deps.paths.statePath, { '/x': { pid: 11 } });
  await s.uninstall({ keepSessions: true });
  assert.deepEqual(s.stopped, []);
});

test('orphan sessions outside state are swept on uninstall', async (t) => {
  const s = await setupUninstall(t);
  const logDir = s.deps.paths.sessionLogDir;
  s.deps.listScriptProcesses = () => [
    [31, `/usr/bin/script -q ${logDir}/a.log /bin/zsh -lic x`],
    // 别人的 script 会话：日志不在本工具目录、形态不同，都不动。
    [32, '/usr/bin/script -q /other/place.log /bin/zsh -lic x'],
    [33, '/usr/bin/script -q /somewhere /bin/bash -ic x'],
  ];
  s.deps.procStartedAt = (pid) => `start-${pid}`;
  await s.uninstall();
  assert.deepEqual(s.stopped, [31]);
  assert.ok(s.lines.some((l) => l.includes('state 已丢失')));
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
