import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { cmdRun, cmdRenew } from '../src/patrol.mjs';
import {
  mkTmp,
  mockDeps,
  tmpPaths,
  readJson,
  writeJson,
} from '../test-support/helpers.mjs';

const FAR = '0 0 1 1 *'; // 1 月 1 日：9 月的 7 天窗口内不会触发

async function setup(t) {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp, { statePath: path.join(tmp, 'state.json') });
  const root = path.join(tmp, 'root');
  fs.mkdirSync(root, { recursive: true });
  const cfgPath = path.join(tmp, 'config.json');
  deps.scanSessions = () => [new Set(), null];
  deps.acquireRunLock = () => 1; // 假锁柄无 lockPath，真 releaseLock 会直接返回
  deps.rotatePatrolLogs = () => {};
  deps.listScriptProcesses = () => [];
  const output = [];
  deps.print = (m) => output.push(m);
  deps.printErr = () => {};

  const makeWs = (name, doc) => {
    const ws = path.join(root, name);
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
    const file = path.join(ws, '.claude', 'scheduled_tasks.json');
    fs.writeFileSync(file, JSON.stringify(doc));
    return file;
  };
  const writeCfg = (autoRenew, autoMinId = false) => writeJson(cfgPath, {
    roots: [root], maxDepth: 3, intervalSeconds: 300, leadSeconds: 600,
    autoRenew, autoMinId,
  });
  const recurring = (id = 'a') => ({
    id, cron: FAR, recurring: true,
    prompt: '周期任务', createdAt: 1790000000000,
  });
  return {
    tmp, deps, cfgPath, makeWs, writeCfg, recurring,
    output: () => output.join('\n'),
  };
}

test('patrol tags when auto-renew enabled', async (t) => {
  const m = await setup(t);
  const file = m.makeWs('a', { tasks: [m.recurring()] });
  m.writeCfg(true);
  await cmdRun({ config: m.cfgPath });
  assert.equal(readJson(file).tasks[0].permanent, true);
});

test('patrol leaves the file untouched when disabled', async (t) => {
  const m = await setup(t);
  const file = m.makeWs('a', { tasks: [m.recurring()] });
  m.writeCfg(false);
  const before = fs.readFileSync(file, 'utf-8');
  await cmdRun({ config: m.cfgPath });
  assert.equal(fs.readFileSync(file, 'utf-8'), before);
});

test('manual renew tags permanent and minifies id regardless of flags', async (t) => {
  const m = await setup(t);
  // p1：大 id、未续期 → 两项都做；p2：已 permanent 且 id 已达标 → 已是最新；
  // p3：损坏 → 跳过。
  const p1 = m.makeWs('a', { tasks: [m.recurring('c1363d8b')] });
  const p2 = m.makeWs('b', {
    tasks: [{ ...m.recurring('00000002'), permanent: true }],
  });
  const p3 = m.makeWs('c', null);
  m.writeCfg(false, false); // 手动 renew 无视两个配置开关
  await cmdRenew({ config: m.cfgPath });
  const t1 = readJson(p1).tasks[0];
  assert.equal(t1.permanent, true);
  assert.equal(t1.id, '00000001', '大 id 被改成文件内第一个空号');
  assert.equal(readJson(p2).tasks[0].id, '00000002', '达标小 id 原样保留');
  const out = m.output();
  assert.ok(out.includes('已续期'));
  assert.ok(out.includes('已改小 id'));
  assert.ok(out.includes('已是最新'));
  assert.ok(out.includes('跳过'));
  assert.ok(out.includes('本次续期 1 个、改小 id 1 个任务'));
  assert.equal(fs.readFileSync(p3, 'utf-8'), 'null');
  assert.ok(readJson(p2).tasks[0].permanent);
});

test('manual renew waits its turn when locked', async (t) => {
  const m = await setup(t);
  m.deps.acquireRunLock = () => null;
  const file = m.makeWs('a', { tasks: [m.recurring()] });
  const before = fs.readFileSync(file, 'utf-8');
  await cmdRenew({ config: m.cfgPath });
  assert.equal(fs.readFileSync(file, 'utf-8'), before);
  assert.ok(m.output().includes('稍后重试'));
});

test('run reports whether it actually ran', async (t) => {
  const m = await setup(t);
  m.writeCfg(true);
  const args = { config: m.cfgPath };
  assert.equal(await cmdRun(args), true);
  m.deps.acquireRunLock = () => null;
  assert.equal(await cmdRun(args), false);
  assert.ok(m.output().includes('本轮跳过'));
});

test('patrol minifies id when enabled without renewing', async (t) => {
  const m = await setup(t);
  const file = m.makeWs('a', { tasks: [m.recurring('c1363d8b')] });
  m.writeCfg(false, true); // 续期关、改 id 开
  await cmdRun({ config: m.cfgPath });
  const task = readJson(file).tasks[0];
  assert.equal(task.id, '00000001');
  assert.equal(task.permanent, undefined, '续期关：只改 id，不补 permanent');
  assert.ok(m.output().includes('已改小 id'));
});

test('patrol leaves ids alone when auto-min-id disabled', async (t) => {
  const m = await setup(t);
  const file = m.makeWs('a', { tasks: [m.recurring('c1363d8b')] });
  m.writeCfg(false, false);
  const before = fs.readFileSync(file, 'utf-8');
  await cmdRun({ config: m.cfgPath });
  assert.equal(fs.readFileSync(file, 'utf-8'), before);
  assert.equal(readJson(file).tasks[0].id, 'c1363d8b');
});

test('patrol minify is idempotent across rounds', async (t) => {
  const m = await setup(t);
  const file = m.makeWs('a', { tasks: [m.recurring('c1363d8b')] });
  m.writeCfg(false, true);
  await cmdRun({ config: m.cfgPath });
  const after1 = fs.readFileSync(file, 'utf-8');
  await cmdRun({ config: m.cfgPath });
  assert.equal(fs.readFileSync(file, 'utf-8'), after1, '第二轮不再改写');
});
