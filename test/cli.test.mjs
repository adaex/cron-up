import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { main, parseCli } from '../src/cli.mjs';
import { ExitError } from '../src/internals.mjs';
import { mkTmp, mockDeps, tmpPaths, writeJson, scanFrom } from '../test-support/helpers.mjs';

const exit2 = (e) => {
  assert.ok(e instanceof ExitError);
  assert.equal(e.code, 2);
  return true;
};

test('--config before the subcommand (end to end list)', async (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  const cfg = path.join(tmp, 'config.json');
  writeJson(cfg, { roots: [] });
  const lines = [];
  deps.print = (m) => lines.push(m);
  await main(['node', 'cron-up', '--config', cfg, 'list']);
  assert.ok(lines.join('\n').includes('没有发现定时任务文件'));
});

test('--config after the subcommand', async (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  const cfg = path.join(tmp, 'config.json');
  writeJson(cfg, { roots: [] });
  const lines = [];
  deps.print = (m) => lines.push(m);
  await main(['node', 'cron-up', 'list', '--config', cfg]);
  assert.ok(lines.join('\n').includes('没有发现定时任务文件'));
});

test('config flag defaults to being absent', () => {
  const parsed = parseCli(['list']);
  assert.equal('config' in parsed, false);
  assert.equal(parsed.command, 'list');
});

test('--config= inline form', () => {
  assert.equal(parseCli(['--config=/x/c.json', 'run']).config, '/x/c.json');
});

test('--help shows the overview and model configuration', async (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  deps.launchctlInfo = () => null;
  deps.scanSessions = async () => scanFrom();
  deps.discover = () => [];
  const lines = [];
  deps.print = (m) => lines.push(m);
  await main(['node', 'cron-up', '--help']);
  const out = lines.join('\n');
  assert.ok(out.includes('cron-up'));
  assert.ok(out.includes('服务：'));
  assert.ok(out.includes('常用命令：'));
  assert.ok(out.includes('模型：工作区 .claude/cron-up.json'));
  assert.ok(!out.includes('用法：'));
  assert.ok(!out.includes('完全移除：'));
});

test('-h is the same as --help', () => {
  assert.equal(parseCli(['-h']).help, true);
});

test('unknown subcommand exits 2', () => {
  assert.throws(() => parseCli(['frobnicate']), exit2);
});

test('prototype property names are not commands', () => {
  for (const name of ['toString', 'constructor', '__proto__']) {
    assert.throws(() => parseCli([name]), exit2, name);
  }
});

test('renew subcommand has been removed', () => {
  assert.throws(() => parseCli(['renew']), exit2);
});

test('removed install flags are all unknown options now', () => {
  for (const args of [
    ['install', '--force'],
    ['install', '--interval', '600'],
    ['install', '--lead', '0'],
    ['install', '--auto-renew'],
    ['install', '--no-auto-renew'],
    ['install', '--auto-renew=false'],
    ['install', '--auto-min-id'],
    ['install', '--no-auto-min-id'],
    ['install', '--session-retain', 'always'],
    ['install', '--stamp-owner'],
    ['install', '--no-stamp-owner'],
  ]) {
    assert.throws(() => parseCli(args), exit2, args.join(' '));
  }
});

test('install accepts only --roots', () => {
  const p = parseCli(['install', '--roots', '/a,~/b']);
  assert.equal(p.command, 'install');
  assert.equal(p.opts.roots, '/a,~/b');
});

test('install --roots without a value exits 2', () => {
  assert.throws(() => parseCli(['install', '--roots']), exit2);
});

test('uninstall accepts --purge only; --keep-sessions is gone', () => {
  assert.equal(parseCli(['uninstall', '--purge']).opts.purge, true);
  assert.throws(() => parseCli(['uninstall', '--keep-sessions']), exit2);
});

test('bool options reject every =value form instead of becoming true', () => {
  for (const args of [
    ['uninstall', '--purge=false'],
    ['uninstall', '--purge='],
    ['logs', '--follow=true'],
  ]) {
    assert.throws(() => parseCli(args), exit2, args.join(' '));
  }
});

test('legacy --stop-sessions flag is gone (exit 2)', async (t) => {
  mockDeps(t);
  await assert.rejects(
    main(['node', 'cron-up', 'uninstall', '--stop-sessions']),
    (e) => e instanceof ExitError && e.code === 2);
});

test('logs -f maps to follow and captures positional workspace', () => {
  const p = parseCli(['logs', '-f', 'team-space']);
  assert.equal(p.command, 'logs');
  assert.equal(p.opts.follow, true);
  assert.deepEqual(p.positional, ['team-space']);
});

test('logs --follow works and rejects two positionals', () => {
  assert.equal(parseCli(['logs', '--follow', 'x']).opts.follow, true);
  assert.throws(() => parseCli(['logs', 'a', 'b']), exit2);
});

test('unknown option exits 2', () => {
  assert.throws(() => parseCli(['run', '--bogus']), exit2);
});

test('prototype property names are not options', () => {
  for (const args of [
    ['run', '--constructor=x'],
    ['run', '--toString=x'],
    ['install', '--__proto__=x'],
  ]) {
    assert.throws(() => parseCli(args), exit2, args.join(' '));
  }
});

test('an option before the subcommand is rejected', () => {
  assert.throws(() => parseCli(['--bogus', 'list']), exit2);
});

test('no command parses as overview', () => {
  assert.equal(parseCli([]).command, null);
});
