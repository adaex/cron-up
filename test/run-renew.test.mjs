// 翻译自 Python RunRenewTests：autoRenew 接入 cmdRun、cmdRenew 独立工作、
// 锁等待、cmdRun 返回值。
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
  deps.acquireRunLock = () => 1;
  deps.releaseLock = () => {};
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
  const writeCfg = (autoRenew) => writeJson(cfgPath, {
    roots: [root], maxDepth: 3, intervalSeconds: 300, leadSeconds: 600,
    autoRenew,
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

test('manual renew tags all regardless of the flag', async (t) => {
  const m = await setup(t);
  const p1 = m.makeWs('a', { tasks: [m.recurring('a')] });
  const p2 = m.makeWs('b', { tasks: [{ ...m.recurring('b'), permanent: true }] });
  const p3 = m.makeWs('c', null); // "null"：损坏 → 跳过
  m.writeCfg(false); // 手动 renew 无视 autoRenew
  await cmdRenew({ config: m.cfgPath });
  assert.equal(readJson(p1).tasks[0].permanent, true);
  const out = m.output();
  assert.ok(out.includes('已续期'));
  assert.ok(out.includes('已是最新'));
  assert.ok(out.includes('跳过'));
  assert.ok(out.includes('本次续期 1 个任务'));
  assert.equal(fs.readFileSync(p3, 'utf-8'), 'null');
  // p2 真的是「已是最新」
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
