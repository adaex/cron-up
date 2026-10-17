import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { cmdOverview } from '../src/overview.mjs';
import { readTasks } from '../src/tasks.mjs';
import { INTERVAL_SECONDS } from '../src/constants.mjs';
import {
  mkTmp, mockDeps, tmpPaths, writeJson, scanFrom, sessionDetail,
} from '../test-support/helpers.mjs';

const WS = '/x';

async function setup(t) {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp, {
    statePath: path.join(tmp, 'state.json'),
    plistPath: path.join(tmp, 'missing.plist'),
  });
  const cfgPath = path.join(tmp, 'config.json');
  writeJson(cfgPath, { roots: [tmp] });
  deps.discover = () => [[WS, 'x']];
  // details 场景可按用例改：默认空（无任何活会话）。
  const scene = { details: new Map() };
  deps.scanSessions = async () => scanFrom(scene.details);
  deps.launchctlInfo = () => ({
    state: 'running', 'last exit code': '0', interval: INTERVAL_SECONDS,
  });
  const lines = [];
  deps.print = (m) => lines.push(m);
  deps.printErr = () => {};
  deps.terminalWidth = () => 240; // 断言完整文案，不受测试终端宽度 clip 影响
  // tasks 给 readTasks 的假返回；state 是嵌套 {ws:{taskId:ent}}。
  const render = async (tasks = null, state = null) => {
    deps.readTasks = () => tasks ?? [];
    if (state !== null) writeJson(deps.paths.statePath, state);
    else fs.rmSync(deps.paths.statePath, { force: true });
    lines.length = 0;
    await cmdOverview({ config: cfgPath });
    return lines.join('\n');
  };
  return { tmp, deps, cfgPath, render, lines, scene };
}

// 近期（约 2 分钟后）一次性任务，带固定 id 方便写嵌套 state。
function soonOneshot(over = {}) {
  const fire = new Date(Date.now() + 2 * 60_000);
  return {
    id: '00000001',
    cron: `${fire.getMinutes()} ${fire.getHours()} ${fire.getDate()} `
      + `${fire.getMonth() + 1} *`,
    recurring: false,
    createdAt: Date.now(),
    prompt: '马上要跑的一次性任务',
    ...over,
  };
}

test('empty world renders cleanly', async (t) => {
  const out = await (await setup(t)).render();
  assert.ok(out.includes('cron-up'));
  assert.ok(out.includes('launchd 已加载'));
  assert.ok(out.includes('任务：暂无'));
  assert.ok(out.includes('预热会话：无'));
  assert.ok(out.includes('常用命令'));
});

test('fixed patrol line: interval and lead, no behaviour tags', async (t) => {
  const out = await (await setup(t)).render();
  assert.ok(out.includes(`每 ${INTERVAL_SECONDS} 秒一轮`));
  assert.ok(out.includes('提前 360 秒'));
  for (const removed of ['任务归属预热', '自动续期', '会话常驻', 'id 自动改小']) {
    assert.ok(!out.includes(removed), `不应再出现 ${removed}`);
  }
});

test('launchd interval drift from the constant is an alert', async (t) => {
  const s = await setup(t);
  s.deps.launchctlInfo = () => ({
    state: 'running', 'last exit code': '0', interval: 120,
  });
  const out = await s.render();
  assert.ok(out.includes('120 秒与当前版本'));
});

test('task inventory and soonest line', async (t) => {
  const s = await setup(t);
  const out = await s.render([{
    id: '00000001', cron: '59 23 * * *', recurring: true,
    prompt: '晚间任务：收尾工作',
  }]);
  assert.ok(out.includes('任务：1 个，分布在 1 个工作区'));
  assert.ok(out.includes('晚间任务：收尾工作'));
  assert.ok(out.includes('最近：'));
});

test('soonest line uses predicted fire with the slot annotated', async (t) => {
  const s = await setup(t);
  const out = await s.render([{
    id: 'c1363d8b', cron: '0 13 * * *', recurring: true,
    prompt: 'Trae 成本刷新',
  }]);
  assert.ok(out.includes('最近：'), out);
  assert.ok(out.includes('13:30'), out);
  assert.ok(out.includes('设定 13:00'), out);
});

test('wanted task without a warm entry is an alert', async (t) => {
  const s = await setup(t);
  const out = await s.render([soonOneshot()]);
  assert.ok(out.includes('需要留意'));
  assert.ok(out.includes('任务 00000001 即将执行（或错过待补执行）'));
  assert.ok(out.includes('下轮巡检会自动启动预热'));
  assert.ok(!out.includes('近期已失败'));
});

test('wanted task with live creator session is not an alert', async (t) => {
  const s = await setup(t);
  s.scene.details = new Map([[WS, [sessionDetail({
    pid: process.pid, sessionId: 'creator-sid',
  })]]]);
  const out = await s.render([soonOneshot({ createdBySessionId: 'creator-sid' })]);
  assert.ok(!out.includes('下轮巡检会自动启动预热'));
});

test('wanted task already held by a tracked warm entry is not an alert', async (t) => {
  const s = await setup(t);
  const out = await s.render([soonOneshot()], {
    [WS]: { '00000001': { pid: process.pid, startedAt: Math.floor(Date.now() / 1000) } },
  });
  assert.ok(!out.includes('下轮巡检会自动启动预热'));
  assert.ok(out.includes('预热会话：1 个'));
});

test('wanted task surfaces recent fail count', async (t) => {
  const s = await setup(t);
  const out = await s.render([soonOneshot()], {
    [WS]: { '00000001': {
      pid: null, fails: 2, deadSince: Math.floor(Date.now() / 1000) } },
  });
  assert.ok(out.includes('下轮巡检会自动启动预热'));
  assert.ok(out.includes('近期已失败 2 次'));
});

test('pending task during cooldown gets one combined alert', async (t) => {
  const s = await setup(t);
  const out = await s.render([soonOneshot()], {
    [WS]: { '00000001': {
      pid: null, fails: 3,
      cooldownUntil: Math.floor(Date.now() / 1000) + 900 } },
  });
  assert.ok(out.includes('正处冷却中'));
  assert.ok(!out.includes('下轮巡检会自动启动预热'));
});

test('bad cron and per-task cooling become alerts', async (t) => {
  const s = await setup(t);
  const out = await s.render(
    [{ id: '00000001', cron: 'broken', prompt: '坏任务' }],
    { [WS]: { '00000009': {
      pid: null, fails: 3,
      cooldownUntil: Math.floor(Date.now() / 1000) + 900 } } });
  assert.ok(out.includes('cron 无法解析'));
  assert.ok(out.includes('冷却 1 个'));
});

test('unreadable task file is alerted, not ghosted', async (t) => {
  const s = await setup(t);
  const ws = path.join(s.tmp, 'proj');
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.claude', 'scheduled_tasks.json'), '{ broken');
  s.deps.discover = () => [[ws, path.join(ws, '.claude', 'scheduled_tasks.json')]];
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
  assert.ok(out.includes('预热会话：无'));
  assert.ok(out.includes('常用命令'));
});

test('roots wrong type is the only field-level fatal config error', async (t) => {
  const s = await setup(t);
  writeJson(s.cfgPath, { roots: '~/single-string' });
  const out = await s.render();
  assert.ok(out.includes('配置：无法生效'));
  assert.ok(out.includes('roots'));
});

test('obsolete config keys are silently ignored, not fatal', async (t) => {
  const s = await setup(t);
  writeJson(s.cfgPath, {
    roots: [s.tmp],
    autoRenew: 'false', intervalSeconds: true, leadSeconds: 'x',
    sessionRetain: 'sometimes', stampOwner: 'yes', maxDepth: null,
  });
  const out = await s.render();
  assert.ok(!out.includes('配置：无法生效'));
  assert.ok(out.includes('扫描：'));
});

test('missing config still shows sessions', async (t) => {
  const s = await setup(t);
  fs.rmSync(s.cfgPath, { force: true });
  const out = await s.render(null, {
    [WS]: { '00000001': {
      pid: null, fails: 3,
      cooldownUntil: Math.floor(Date.now() / 1000) + 900 } },
  });
  assert.ok(out.includes('配置：缺失'));
  assert.ok(out.includes('冷却 1 个'));
});

test('detached (resume) entries are listed separately, not as live or dead', async (t) => {
  const s = await setup(t);
  s.scene.details = new Map([[WS, [sessionDetail({
    pid: 999, sessionId: 'resumed-sid',
  })]]]);
  const out = await s.render(null, {
    [WS]: { '00000001': {
      ws: WS, taskId: '00000001', pid: null,
      procStart: 'start-gone', sessionId: 'resumed-sid', fails: 0 } },
  });
  assert.ok(out.includes('终端接管 1 个'));
  assert.ok(out.includes('--resume 接管'));
  assert.ok(!out.includes('已失效'));
});

test('live warmup outside scan scope is flagged', async (t) => {
  const s = await setup(t);
  s.deps.discover = () => [];
  const me = process.pid;
  const out = await s.render(null, {
    [WS]: { '00000001': { pid: me,
      startedAt: Math.floor(Date.now() / 1000) - 60 } },
  });
  assert.ok(out.includes('已不在巡检范围'));
});

test('live warmup inside scan scope is not flagged', async (t) => {
  const s = await setup(t);
  const me = process.pid;
  const out = await s.render(null, {
    [WS]: { '00000001': { pid: me,
      startedAt: Math.floor(Date.now() / 1000) - 60 } },
  });
  assert.ok(!out.includes('已不在巡检范围'));
});

test('live warmups show task id, pid and age; dead entries counted', async (t) => {
  const s = await setup(t);
  const me = process.pid;
  // 630 而非 600：渲染前会流逝几毫秒，避开分钟边界。
  const out = await s.render(null, {
    [WS]: {
      '00000001': { pid: me, startedAt: Math.floor(Date.now() / 1000) - 630 },
      '00000002': { pid: null, fails: 1 },
    },
  });
  assert.ok(out.includes('预热会话：1 个'));
  assert.ok(out.includes('/00000001'));
  assert.ok(out.includes(`pid ${me}`));
  assert.ok(out.includes('已运行 10 分钟'));
  assert.ok(out.includes('已失效 1 个'));
});

test('hand-edited state types render without crashing', async (t) => {
  const s = await setup(t);
  const out = await s.render(null, {
    [WS]: { '00000001': { pid: '123', fails: 1, cooldownUntil: 'abc' } },
  });
  assert.ok(out.includes('预热会话：'));
});

test('fresh heartbeat shows last-run time without stale alert', async (t) => {
  const s = await setup(t);
  writeJson(s.deps.paths.heartbeatPath, {
    ranAt: Math.floor(Date.now() / 1000) - 30,
  });
  const out = await s.render();
  assert.ok(out.includes('上次巡检：'));
  assert.ok(!out.includes('巡检已沉默'));
});

test('stale heartbeat with service loaded raises a silence alert', async (t) => {
  const s = await setup(t);
  writeJson(s.deps.paths.heartbeatPath, {
    ranAt: Math.floor(Date.now() / 1000) - INTERVAL_SECONDS * 3,
  });
  const out = await s.render();
  assert.ok(out.includes('巡检已沉默'));
  assert.ok(out.includes('cron-up logs'));
});

test('missing heartbeat renders without silence claim', async (t) => {
  const s = await setup(t);
  const out = await s.render();
  assert.ok(!out.includes('上次巡检：'));
  assert.ok(!out.includes('巡检已沉默'));
});
