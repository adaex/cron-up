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
  const aliasNode = path.join(home, '.local/share/fnm/aliases/default/bin/node');
  fakeNode(aliasNode);
  const r = resolveLauncher({
    home, execPath: '/x/fnm_multishells/1/bin/node', entryPath: '/e/cr.mjs' });
  assert.equal(r.manager, 'fnm');
  assert.equal(r.nodePath, aliasNode); // 保留别名路径，不解析到版本化目录
  assert.equal(r.entryPath, '/e/cr.mjs');
});

test('launcher: FNM_DIR is honoured', (t) => {
  const home = mkTmp(t);
  const custom = path.join(mkTmp(t), 'custom-fnm');
  fakeNode(path.join(custom, 'aliases/default/bin/node'));
  process.env.FNM_DIR = custom;
  t.after(() => { delete process.env.FNM_DIR; });
  const r = resolveLauncher({ home, entryPath: '/e/cr.mjs' });
  assert.equal(r.manager, 'fnm');
  assert.ok(r.nodePath.includes('custom-fnm'));
});

test('launcher: volta shim', (t) => {
  const home = isolatedFnmEnv(t, mkTmp(t));
  fakeNode(path.join(home, '.volta/bin/node'));
  const r = resolveLauncher({ home, entryPath: '/e/cr.mjs' });
  assert.equal(r.manager, 'volta');
});

test('launcher: nvm explicit default alias', (t) => {
  const home = isolatedFnmEnv(t, mkTmp(t));
  fs.mkdirSync(path.join(home, '.nvm/alias'), { recursive: true });
  fs.writeFileSync(path.join(home, '.nvm/alias/default'), 'v22.2.0');
  const nodePath = path.join(home, '.nvm/versions/node/v22.2.0/bin/node');
  fakeNode(nodePath);
  // 干扰版本不应被选中。
  fakeNode(path.join(home, '.nvm/versions/node/v18.0.0/bin/node'));
  const r = resolveLauncher({ home, entryPath: '/e' });
  assert.equal(r.manager, 'nvm');
  assert.equal(r.nodePath, nodePath);
});

test('launcher: nvm "node" alias picks highest installed', (t) => {
  const home = isolatedFnmEnv(t, mkTmp(t));
  fs.mkdirSync(path.join(home, '.nvm/alias'), { recursive: true });
  fs.writeFileSync(path.join(home, '.nvm/alias/default'), 'node');
  fakeNode(path.join(home, '.nvm/versions/node/v18.0.0/bin/node'));
  const high = path.join(home, '.nvm/versions/node/v24.20.0/bin/node');
  fakeNode(high);
  const r = resolveLauncher({ home, entryPath: '/e' });
  assert.equal(r.nodePath, high);
});

test('launcher: nvm lts/* resolves via alias file', (t) => {
  const home = isolatedFnmEnv(t, mkTmp(t));
  fs.mkdirSync(path.join(home, '.nvm/alias/lts'), { recursive: true });
  fs.writeFileSync(path.join(home, '.nvm/alias/default'), 'lts/*');
  fs.writeFileSync(path.join(home, '.nvm/alias/lts/*'), 'v22.11.0');
  const lts = path.join(home, '.nvm/versions/node/v22.11.0/bin/node');
  fakeNode(lts);
  fakeNode(path.join(home, '.nvm/versions/node/v25.0.0/bin/node'));
  const r = resolveLauncher({ home, entryPath: '/e' });
  assert.equal(r.nodePath, lts);
});

test('launcher: system path fallback labelled pkg/brew', (t) => {
  const home = isolatedFnmEnv(t, mkTmp(t));
  const sysNode = path.join(mkTmp(t), 'system-bin/node');
  fakeNode(sysNode);
  const r = resolveLauncher({
    home, execPath: '/run/node', entryPath: '/e', systemPaths: [sysNode] });
  assert.equal(r.manager, 'pkg');
  assert.equal(r.nodePath, sysNode);
});

test('launcher: nothing recognised falls back to execPath with a note', (t) => {
  const home = isolatedFnmEnv(t, mkTmp(t));
  const r = resolveLauncher({
    home, execPath: '/run/node', entryPath: '/e', systemPaths: [] });
  assert.equal(r.manager, 'exec-path');
  assert.equal(r.nodePath, '/run/node');
  assert.ok(r.note);
});

test('launcher priority: fnm beats volta', (t) => {
  const home = isolatedFnmEnv(t, mkTmp(t));
  fakeNode(path.join(home, '.local/share/fnm/aliases/default/bin/node'));
  fakeNode(path.join(home, '.volta/bin/node'));
  assert.equal(resolveLauncher({ home }).manager, 'fnm');
});

// ---- plist ----

test('renderPlist contains absolute node, entry, run and interval', (t) => {
  mockDeps(t).paths = tmpPaths(mkTmp(t));
  const xml = renderPlist(600, {
    nodePath: '/usr/local/bin/node', entryPath: '/opt/pkg/cron-up.mjs' });
  assert.ok(xml.includes('<string>local.cron-up</string>'));
  assert.ok(xml.includes('<string>/usr/local/bin/node</string>'));
  assert.ok(xml.includes('<string>/opt/pkg/cron-up.mjs</string>'));
  assert.ok(xml.includes('<string>run</string>'));
  assert.ok(xml.includes('<integer>600</integer>'));
  const args = readPlistProgramArgsFrom(xml);
  assert.deepEqual(args, ['/usr/local/bin/node', '/opt/pkg/cron-up.mjs', 'run']);
});

test('renderPlist XML-escapes ampersands in paths', (t) => {
  mockDeps(t).paths = tmpPaths(mkTmp(t));
  const xml = renderPlist(300, {
    nodePath: '/x/a&b/node', entryPath: '/x/e<m>.mjs' });
  assert.ok(xml.includes('/x/a&amp;b/node'));
  assert.ok(xml.includes('/x/e&lt;m&gt;.mjs'));
  assert.ok(readPlistProgramArgsFrom(xml)[0] === '/x/a&b/node');
});

function readPlistProgramArgsFrom(xml) {
  const block = xml.match(
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  return [...block[1].matchAll(/<string>([\s\S]*?)<\/string>/g)]
    .map((m) => m[1]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
}

test('launcherHealth flags a missing node path', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  const goodEntry = path.join(tmp, 'entry.mjs');
  fs.writeFileSync(goodEntry, '');
  fs.writeFileSync(deps.paths.plistPath, renderPlist(300, {
    nodePath: path.join(tmp, 'gone/node'),
    entryPath: goodEntry,
  }));
  assert.deepEqual(readPlistProgramArgs(),
    [path.join(tmp, 'gone/node'), goodEntry, 'run']);
  const alert = launcherHealth();
  assert.ok(alert && alert.includes('失效'));
});

test('launcherHealth is null when both paths exist', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  const node = path.join(tmp, 'node');
  const entry = path.join(tmp, 'entry.mjs');
  fs.writeFileSync(node, '');
  fs.writeFileSync(entry, '');
  fs.writeFileSync(deps.paths.plistPath,
    renderPlist(300, { nodePath: node, entryPath: entry }));
  assert.equal(launcherHealth(), null);
});

// 在 tmp 里伪造 fnm/nvm 的版本化目录布局（路径中出现 node-versions/<v> 段
// 即触发检测），文件真实存在，只有版本目录分属两个版本。
function writeVersioned(tmp, version, file) {
  const p = path.join(tmp, 'fnm', 'node-versions', version,
    'installation', file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '');
  return p;
}

test('launcherHealth flags entry path in another node version dir', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  const node = writeVersioned(tmp, 'v26.0.0', 'bin/node');
  const entry = writeVersioned(tmp, 'v24.20.0',
    path.join('lib', 'node_modules', 'cron-up', 'bin', 'cron-up.mjs'));
  fs.writeFileSync(deps.paths.plistPath,
    renderPlist(300, { nodePath: node, entryPath: entry }));
  const alert = launcherHealth();
  assert.ok(alert && alert.includes('另一个 node 版本'));
  assert.ok(alert.includes('cron-up install'));
});

test('launcherHealth is quiet when versions agree or path is unversioned', (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  // 同一版本目录下的 node 与入口：正常。
  const node = writeVersioned(tmp, 'v26.0.0', 'bin/node');
  const entry = writeVersioned(tmp, 'v26.0.0',
    path.join('lib', 'node_modules', 'cron-up', 'bin', 'cron-up.mjs'));
  // 入口在版本化目录外（npm link 的工作副本）：不检查。
  const linked = path.join(tmp, 'worktree', 'bin', 'cron-up.mjs');
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  fs.writeFileSync(linked, '');
  fs.writeFileSync(deps.paths.plistPath,
    renderPlist(300, { nodePath: node, entryPath: entry }));
  assert.equal(launcherHealth(), null);
  fs.writeFileSync(deps.paths.plistPath,
    renderPlist(300, { nodePath: node, entryPath: linked }));
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

test('purge removes data and points at npm for the binary', async (t) => {
  const s = await setupUninstall(t);
  fs.writeFileSync(s.deps.paths.plistPath, '<plist/>');
  fs.writeFileSync(path.join(s.tmp, 'app/state.json'), '{}');
  await s.uninstall({ purge: true });
  assert.equal(fs.existsSync(s.deps.paths.appSupport), false);
  assert.equal(fs.existsSync(s.deps.paths.logDir), false);
  assert.ok(s.lines.some((l) => l.includes('npm uninstall -g cron-up')));
});
