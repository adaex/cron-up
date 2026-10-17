import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { main, parseCli } from '../src/cli.mjs';
import { ExitError } from '../src/internals.mjs';
import { mkTmp, mockDeps, tmpPaths, writeJson } from '../test-support/helpers.mjs';

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

test('--help prints usage with the five surviving commands', async (t) => {
  const deps = mockDeps(t);
  const lines = [];
  deps.print = (m) => lines.push(m);
  await main(['node', 'cron-up', '--help']);
  const usage = lines.join('\n');
  assert.ok(usage.startsWith('cron-up ——'));
  for (const name of ['install', 'uninstall', 'list', 'run', 'logs']) {
    assert.ok(usage.includes(`cron-up ${name}`), name);
  }
  assert.ok(!usage.includes('renew'));
});

test('-h is the same as --help', () => {
  assert.equal(parseCli(['-h']).help, true);
});

test('unknown subcommand exits 2', () => {
  assert.throws(() => parseCli(['frobnicate']), exit2);
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

test('an option before the subcommand is rejected', () => {
  assert.throws(() => parseCli(['--bogus', 'list']), exit2);
});

test('no command parses as overview', () => {
  assert.equal(parseCli([]).command, null);
});
