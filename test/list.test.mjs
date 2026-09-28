// 翻译自 Python ListTests。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { cmdList } from '../src/list.mjs';
import { dispWidth, fmtMDHM } from '../src/display.mjs';
import { mkTmp, mockDeps, tmpPaths, writeJson } from '../test-support/helpers.mjs';

const WS = '/x';

async function setup(t) {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  const cfgPath = path.join(tmp, 'config.json');
  writeJson(cfgPath, {
    roots: [WS], maxDepth: 3, intervalSeconds: 300, leadSeconds: 600,
  });
  deps.discover = () => [[WS, 'x']];
  const lines = [];
  deps.print = (m) => lines.push(m);
  const render = async (tasks, consumers = new Set()) => {
    deps.readTasks = () => tasks;
    deps.scanSessions = () => [consumers, null];
    lines.length = 0;
    await cmdList({ config: cfgPath });
    return lines.join('\n');
  };
  const setDiscover = (f) => { deps.discover = f; };
  return { tmp, deps, render, setDiscover, lines };
}

test('missed one-shot is flagged', async (t) => {
  const s = await setup(t);
  const past = new Date(Date.now() - 86400_000);
  const created = new Date(past.getTime() - 3600_000);
  const out = await s.render([{
    cron: `${past.getMinutes()} ${past.getHours()} ${past.getDate()} `
      + `${past.getMonth() + 1} *`,
    createdAt: created.getTime(),
    recurring: false,
  }]);
  assert.ok(out.includes('已错过'));
});

test('unreadable file is reported as such', async (t) => {
  const s = await setup(t);
  assert.ok((await s.render(null)).includes('全部读不出'));
});

test('mixed unreadable and empty files are itemized', async (t) => {
  const s = await setup(t);
  s.setDiscover(() => [[WS, 'x'], ['/y', 'y']]);
  s.deps.readTasks = (ws) => (ws === WS ? null : []);
  s.lines.length = 0;
  await cmdList({ config: path.join(s.tmp, 'config.json') });
  const out = s.lines.join('\n');
  assert.ok(out.includes('其中 1 个读不出'));
  assert.ok(out.includes('其余的任务列表均为空'));
});

test('one-shot weeks ahead shows its date, not missed', async (t) => {
  const s = await setup(t);
  const future = new Date(Date.now() + 60 * 86400_000);
  const out = await s.render([{
    cron: `${future.getMinutes()} ${future.getHours()} ${future.getDate()} `
      + `${future.getMonth() + 1} *`,
    createdAt: Date.now(),
    recurring: false,
  }]);
  assert.ok(!out.includes('已错过'));
  assert.ok(out.includes(fmtMDHM(future)));
});

test('valid cron that never fires reads as such', async (t) => {
  const s = await setup(t);
  const out = await s.render([{
    cron: '0 0 30 2 *', recurring: true, prompt: '永不触发的任务',
  }]);
  assert.ok(out.includes('一年内无'));
});

test('each task gets its own row with summary and cadence', async (t) => {
  const s = await setup(t);
  const out = await s.render([
    { cron: '5 0 * * *', recurring: true, prompt: '群人数每日定时任务：执行某脚本\n第二行细节不出现' },
    { cron: '0 10 * * 0', recurring: true, prompt: '  周报任务：\n   做一些事' },
  ]);
  assert.ok(out.includes('共 1 个工作区、2 个定时任务'));
  assert.ok(out.includes('群人数每日定时任务：执行某脚本'));
  assert.ok(out.includes('周报任务：'));
  assert.ok(!out.includes('第二行细节不出现'));
  assert.ok(out.includes('5 0 * * *'));
  assert.ok(out.includes('0 10 * * 0'));
  assert.ok(out.includes('周期'));
  assert.ok(out.includes('交互会话：无'));
});

test('malformed task is shown, not dropped', async (t) => {
  const s = await setup(t);
  const out = await s.render([{ cron: 'not a cron', prompt: '坏任务' }]);
  assert.ok(out.includes('cron 无效'));
  assert.ok(out.includes('坏任务'));
});

test('task without prompt gets a placeholder', async (t) => {
  const s = await setup(t);
  assert.ok((await s.render([{ cron: '5 0 * * *', recurring: true }]))
    .includes('（无任务描述）'));
});

test('consumer column reflects a single scan', async (t) => {
  const s = await setup(t);
  const out = await s.render(
    [{ cron: '5 0 * * *', recurring: true }], new Set([WS]));
  assert.ok(out.includes('交互会话：有'));
});

test('rows never overflow the terminal width', async (t) => {
  const s = await setup(t);
  for (const width of [60, 80, 100, 200]) {
    s.deps.terminalWidth = () => width;
    const out = await s.render([
      { cron: '5 0 * * *', recurring: true, prompt: '短任务' },
      { cron: '0 10 * * 0', recurring: true, prompt: '很'.repeat(300) },
    ]);
    for (const line of out.split('\n')) {
      assert.ok(dispWidth(line) <= width, `${width} 列下溢出：${line}`);
    }
  }
});

test('permanent recurring is labeled', async (t) => {
  const s = await setup(t);
  const out = await s.render([
    { cron: '5 0 * * *', recurring: true, permanent: true, prompt: '长期任务' },
    { cron: '0 10 * * 0', recurring: true, prompt: '普通周期任务' },
  ]);
  assert.ok(out.includes('周期·永久'));
  assert.ok(out.includes('普通周期任务'));
  s.deps.terminalWidth = () => 100;
  for (const line of out.split('\n')) {
    assert.ok(dispWidth(line) <= 100);
  }
});
