import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { cmdOverview } from '../src/overview.mjs';
import { readTasks } from '../src/tasks.mjs';
import { mkTmp, mockDeps, tmpPaths, writeJson } from '../test-support/helpers.mjs';

const WS = '/x';

async function setup(t) {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp, {
    statePath: path.join(tmp, 'state.json'),
    plistPath: path.join(tmp, 'missing.plist'),
  });
  const cfgPath = path.join(tmp, 'config.json');
  writeJson(cfgPath, {
    roots: [tmp], maxDepth: 3, intervalSeconds: 300, leadSeconds: 600,
  });
  deps.discover = () => [[WS, 'x']];
  deps.scanSessions = () => [new Set(), null];
  deps.launchctlInfo = () => ({
    state: 'running', 'last exit code': '0', interval: 300,
  });
  const lines = [];
  deps.print = (m) => lines.push(m);
  deps.printErr = () => {};
  const render = async (tasks = null, state = null) => {
    deps.readTasks = () => tasks ?? [];
    if (state !== null) writeJson(deps.paths.statePath, state);
    else fs.rmSync(deps.paths.statePath, { force: true });
    lines.length = 0;
    await cmdOverview({ config: cfgPath });
    return lines.join('\n');
  };
  return { tmp, deps, cfgPath, render, lines };
}

test('empty world renders cleanly', async (t) => {
  const out = await (await setup(t)).render();
  assert.ok(out.includes('cron-up'));
  assert.ok(out.includes('launchd 已加载'));
  assert.ok(out.includes('任务：暂无'));
  assert.ok(out.includes('无保活会话'));
  assert.ok(out.includes('常用命令'));
});

test('no cooling tail when nothing is cooling', async (t) => {
  const out = await (await setup(t)).render();
  assert.ok(out.includes('会话：无保活会话'));
  assert.ok(!out.includes('冷却'));
});

test('task inventory and soonest line', async (t) => {
  const s = await setup(t);
  const out = await s.render([{
    cron: '59 23 * * *', recurring: true, prompt: '晚间任务：收尾工作',
  }]);
  assert.ok(out.includes('任务：1 个，分布在 1 个工作区'));
  assert.ok(out.includes('晚间任务：收尾工作'));
  assert.ok(out.includes('最近：'));
});

test('wanted without consumer is an alert', async (t) => {
  const s = await setup(t);
  const fire = new Date(Date.now() + 2 * 60_000);
  const out = await s.render([{
    cron: `${fire.getMinutes()} ${fire.getHours()} ${fire.getDate()} `
      + `${fire.getMonth() + 1} *`,
    recurring: false,
    createdAt: Date.now(),
    prompt: '马上要跑的一次性任务',
  }]);
  assert.ok(out.includes('需要留意'));
  assert.ok(out.includes('即将执行（或错过待补执行）'));
  assert.ok(out.includes('下轮巡检会自动启动'));
  // 从未失败过就不预告冷却，避免告警噪音。
  assert.ok(!out.includes('近期已失败'));
});

test('wanted without consumer surfaces recent fail count', async (t) => {
  const s = await setup(t);
  const fire = new Date(Date.now() + 2 * 60_000);
  const out = await s.render([{
    cron: `${fire.getMinutes()} ${fire.getHours()} ${fire.getDate()} `
      + `${fire.getMonth() + 1} *`,
    recurring: false,
    createdAt: Date.now(),
    prompt: '马上要跑的一次性任务',
  }], { [WS]: { pid: null, fails: 2, deadSince: Math.floor(Date.now() / 1000) } });
  assert.ok(out.includes('下轮巡检会自动启动'));
  assert.ok(out.includes('近期已失败 2 次'));
});

test('pending task during cooldown gets one combined alert', async (t) => {
  const s = await setup(t);
  const fire = new Date(Date.now() + 2 * 60_000);
  const out = await s.render([{
    cron: `${fire.getMinutes()} ${fire.getHours()} ${fire.getDate()} `
      + `${fire.getMonth() + 1} *`,
    recurring: false,
    createdAt: Date.now(),
    prompt: '马上要跑的一次性任务',
  }], { [WS]: { pid: null, fails: 3, cooldownUntil: Math.floor(Date.now() / 1000) + 900 } });
  assert.ok(out.includes('冷却中'));
  assert.ok(!out.includes('下轮巡检会自动启动'));
});

test('bad cron and cooldown become alerts', async (t) => {
  const s = await setup(t);
  const out = await s.render(
    [{ cron: 'broken', prompt: '坏任务' }],
    { [WS]: { pid: null, fails: 3, cooldownUntil: Math.floor(Date.now() / 1000) + 900 } });
  assert.ok(out.includes('cron 无法解析'));
  assert.ok(out.includes('冷却中'));
});

test('unreadable task file is alerted, not ghosted', async (t) => {
  const s = await setup(t);
  const ws = path.join(s.tmp, 'proj');
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.claude', 'scheduled_tasks.json'), '{ broken');
  s.deps.discover = () => [[ws, path.join(ws, '.claude', 'scheduled_tasks.json')]];
  // 不走 render() 的 readTasks fake：显式恢复成真实读取（得到 null）。
  s.deps.readTasks = readTasks;
  s.lines.length = 0;
  await cmdOverview({ config: s.cfgPath });
  assert.ok(s.lines.join('\n').includes('任务文件读不出'));
});

test('corrupt config renders the whole page', async (t) => {
  const s = await setup(t);
  fs.writeFileSync(s.cfgPath, '{ not valid json');
  const out = await s.render();
  assert.ok(out.includes('配置：无法生效'));
  assert.ok(out.includes('会话：无保活会话'));
  assert.ok(out.includes('常用命令'));
});

test('missing config still shows sessions', async (t) => {
  const s = await setup(t);
  fs.rmSync(s.cfgPath, { force: true });
  const out = await s.render(null, {
    [WS]: { pid: null, fails: 3, cooldownUntil: Date.now() / 1000 + 900 },
  });
  assert.ok(out.includes('配置：缺失'));
  assert.ok(out.includes('冷却 1 个'));
});

test('non-int numeric fields alert instead of crashing', async (t) => {
  const s = await setup(t);
  writeJson(s.cfgPath, {
    roots: [s.tmp], maxDepth: 3, intervalSeconds: 300, leadSeconds: '600',
  });
  const out = await s.render();
  assert.ok(out.includes('配置：无法生效'));
  assert.ok(out.includes('leadSeconds'));
  assert.ok(out.includes('非负整数'));
  assert.ok(out.includes('需要留意'));
  assert.ok(out.includes('会话：'));
});

test('bool numeric fields alert like other bad types', async (t) => {
  const s = await setup(t);
  writeJson(s.cfgPath, {
    roots: [s.tmp], maxDepth: 3, intervalSeconds: true, leadSeconds: 600,
  });
  const out = await s.render();
  assert.ok(out.includes('intervalSeconds'));
  assert.ok(out.includes('正整数'));
  assert.ok(out.includes('需要留意'));
});

test('live session outside scan scope is flagged', async (t) => {
  const s = await setup(t);
  const me = process.pid;
  s.deps.discover = () => [];
  const out = await s.render(null, {
    [WS]: { pid: me, startedAt: Math.floor(Date.now() / 1000) - 60 },
  });
  assert.ok(out.includes('已不在巡检范围'));
});

test('live session inside scan scope is not flagged', async (t) => {
  const s = await setup(t);
  const me = process.pid;
  const out = await s.render(null, {
    [WS]: { pid: me, startedAt: Math.floor(Date.now() / 1000) - 60 },
  });
  assert.ok(out.includes('保活 1 个'));
  assert.ok(!out.includes('已不在巡检范围'));
});

test('live sessions show pid and dead entries are counted', async (t) => {
  const s = await setup(t);
  const me = process.pid;
  // 630 而非 600：渲染前会流逝几毫秒，避开分钟边界。
  const out = await s.render(null, {
    [WS]: { pid: me, startedAt: Math.floor(Date.now() / 1000) - 630 },
    '/gone': { pid: null, fails: 1 },
  });
  assert.ok(out.includes('保活 1 个'));
  assert.ok(out.includes(`pid ${me}`));
  assert.ok(out.includes('已运行 10 分钟'));
  assert.ok(out.includes('已失效 1 个'));
});

test('hand-edited state types render without crashing', async (t) => {
  const s = await setup(t);
  const out = await s.render(null, {
    [WS]: { pid: '123', fails: 1, cooldownUntil: 'abc' },
  });
  assert.ok(out.includes('会话：'));
});
