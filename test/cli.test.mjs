import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { main, parseCli } from '../src/cli.mjs';
import { ExitError } from '../src/internals.mjs';
import { mkTmp, mockDeps, tmpPaths, writeJson } from '../test-support/helpers.mjs';

test('--config before the subcommand (end to end list)', async (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  const cfg = path.join(tmp, 'config.json');
  writeJson(cfg, { roots: [], maxDepth: 2, intervalSeconds: 300, leadSeconds: 600 });
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
  writeJson(cfg, { roots: [], maxDepth: 2, intervalSeconds: 300, leadSeconds: 600 });
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

test('--help prints usage and exits 0 semantics', async (t) => {
  const deps = mockDeps(t);
  const lines = [];
  deps.print = (m) => lines.push(m);
  await main(['node', 'cron-up', '--help']);
  assert.ok(lines.join('\n').startsWith('cron-up ——'));
  assert.ok(lines.join('\n').includes('cron-up list'));
});

test('unknown subcommand exits 2', () => {
  assert.throws(() => parseCli(['frobnicate']), (e) => {
    assert.ok(e instanceof ExitError);
    assert.equal(e.code, 2);
    return true;
  });
});

test('legacy --stop-sessions flag is gone (exit 2)', async (t) => {
  mockDeps(t);
  await assert.rejects(
    main(['node', 'cron-up', 'uninstall', '--stop-sessions']),
    (e) => e instanceof ExitError && e.code === 2);
});

test('strict integer parsing rejects 0x/5x/empty', () => {
  assert.throws(() => parseCli(['install', '--interval', '5x']),
    (e) => e instanceof ExitError && e.code === 2);
  assert.throws(() => parseCli(['install', '--interval=0x10']),
    (e) => e instanceof ExitError && e.code === 2);
});

test('--lead 0 survives as numeric zero', () => {
  const p = parseCli(['install', '--lead', '0']);
  assert.equal(p.opts.lead, 0);
});

test('--no-auto-renew and --auto-renew map to booleans', () => {
  assert.equal(parseCli(['install', '--no-auto-renew']).opts.autoRenew, false);
  assert.equal(parseCli(['install', '--auto-renew']).opts.autoRenew, true);
  assert.equal(parseCli(['install', '--auto-renew=false']).opts.autoRenew, false);
});

test('logs -f maps to follow and captures positional workspace', () => {
  const p = parseCli(['logs', '-f', 'team-space']);
  assert.equal(p.command, 'logs');
  assert.equal(p.opts.follow, true);
  assert.deepEqual(p.positional, ['team-space']);
});

test('unknown option exits 2', () => {
  assert.throws(() => parseCli(['run', '--bogus']),
    (e) => e instanceof ExitError && e.code === 2);
});

test('no command parses as overview', () => {
  assert.equal(parseCli([]).command, null);
});
