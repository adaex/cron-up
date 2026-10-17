import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { cmdList } from '../src/list.mjs';
import { dispWidth, fmtMDHM } from '../src/display.mjs';
import {
  mkTmp, mockDeps, tmpPaths, writeJson,
  writeTaskFile, makeTask, sessionDetail, scanFrom,
} from '../test-support/helpers.mjs';

// 真实工作区落盘 + 可注入登记/state 的夹具。roots 指向 tmp，工作区在其一
// 层之下（discover 深度固定 3）。
async function setup(t) {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  const cfgPath = path.join(tmp, 'config.json');
  writeJson(cfgPath, { roots: [tmp] });
  fs.mkdirSync(path.join(tmp, 'ws'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ws2'), { recursive: true });
  const WS = fs.realpathSync(path.join(tmp, 'ws'));
  const WS2 = fs.realpathSync(path.join(tmp, 'ws2'));

  const alive = new Set();
  deps.alive = (p) => alive.has(p);
  deps.procStartedAt = (p) => `start-${p}`;
  const details = new Map();
  deps.scanSessions = async () => scanFrom(details);

  const lines = [];
  deps.print = (m) => lines.push(m);
  deps.terminalWidth = () => 120;

  // scene：任务列表、嵌套 state、本目录活登记详情。
  const render = async (tasks = [], scene = {}) => {
    writeTaskFile(WS, tasks);
    if (scene.state !== undefined) {
      writeJson(deps.paths.statePath,
        scene.state === null ? {} : { [WS]: scene.state });
    }
    details.clear();
    if (scene.live) details.set(WS, scene.live);
    lines.length = 0;
    await cmdList({ config: cfgPath });
    return lines.join('\n');
  };
  return {
    tmp, deps, WS, WS2, cfgPath, alive, details, lines, render,
  };
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
  fs.mkdirSync(path.join(s.WS, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(s.WS, '.claude', 'scheduled_tasks.json'), '{ broken');
  s.lines.length = 0;
  await cmdList({ config: s.cfgPath });
  assert.ok(s.lines.join('\n').includes('全部读不出'));
});

test('mixed unreadable and empty files are itemized', async (t) => {
  const s = await setup(t);
  // WS 是一个被发现但任务列表为空的文件，WS2 的文件损坏。
  writeTaskFile(s.WS, []);
  fs.mkdirSync(path.join(s.WS2, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(s.WS2, '.claude', 'scheduled_tasks.json'), '{ broken');
  s.lines.length = 0;
  await cmdList({ config: s.cfgPath });
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
  const out = await s.render([
    { cron: '0 0 30 2 *', recurring: true, prompt: '永不触发的任务' },
  ]);
  assert.ok(out.includes('一年内无'));
});

test('each task gets its own row under the full workspace path', async (t) => {
  const s = await setup(t);
  const out = await s.render([
    makeTask({ id: '00000001', cron: '5 0 * * *',
      prompt: '群人数每日定时任务：执行某脚本\n第二行细节不出现' }),
    makeTask({ id: '00000002', cron: '0 10 * * 0', prompt: '  周报任务：\n   做一些事' }),
  ]);
  assert.ok(out.includes('共 1 个工作区、2 个定时任务'));
  assert.ok(out.includes(s.WS), '块首是完整工作区路径');
  assert.ok(out.includes('群人数每日定时任务：执行某脚本'));
  assert.ok(out.includes('周报任务：'));
  assert.ok(!out.includes('第二行细节不出现'));
  assert.ok(out.includes('5 0 * * *'));
  assert.ok(out.includes('0 10 * * 0'));
  assert.ok(out.includes('周期'));
  assert.ok(!out.includes('交互会话：'), '旧版每目录消费者表头已删');
});

test('malformed task is shown, not dropped', async (t) => {
  const s = await setup(t);
  const out = await s.render([
    makeTask({ id: '00000001', cron: 'not a cron', prompt: '坏任务' }),
  ]);
  assert.ok(out.includes('cron 无效'));
  assert.ok(out.includes('坏任务'));
});

test('task without prompt gets a placeholder', async (t) => {
  const s = await setup(t);
  // 不用 makeTask：它会注入默认 prompt。
  const out = await s.render([
    { id: '00000001', cron: '5 0 * * *', recurring: true,
      createdAt: Date.now() - 3600_000, permanent: true },
  ]);
  assert.ok(out.includes('（无任务描述）'));
});

test('permanent recurring is labeled', async (t) => {
  const s = await setup(t);
  const out = await s.render([
    makeTask({ id: '00000001', cron: '5 0 * * *', prompt: '长期任务' }),
    makeTask({ id: '00000002', cron: '0 10 * * 0', prompt: '普通周期',
      permanent: false }),
  ]);
  assert.ok(out.includes('周期·永久'));
  assert.ok(out.includes('普通周期'));
});

test('status shows slot to predicted-fire range for jittered tasks', async (t) => {
  const s = await setup(t);
  s.deps.terminalWidth = () => 120;
  // id 哈希顶格：每日 13:00 的任务预计 13:30 才投递。
  const out = await s.render([
    makeTask({ id: 'c1363d8b', cron: '0 13 * * *', prompt: 'Trae 成本刷新' }),
  ]);
  assert.ok(out.includes('→ 13:30'), out);
});

// ---- 逐任务预热标签 ----

const WARM_TASK = () => makeTask({ id: '00000001', prompt: '日报',
  createdBySessionId: 'dead-creator' });

test('warm tag: live creator session shows no tag even when wanted', async (t) => {
  const s = await setup(t);
  const out = await s.render(
    [makeTask({ id: '00000001', prompt: '日报',
      createdBySessionId: 'alive-creator' })],
    { live: [sessionDetail({ pid: 10, sessionId: 'alive-creator' })] });
  assert.ok(!out.includes('待预热'));
  assert.ok(!out.includes('['));
});

test('warm tag: claimed live warmup shows its script pid', async (t) => {
  const s = await setup(t);
  s.alive.add(4242);
  const out = await s.render([WARM_TASK()], {
    state: {
      '00000001': {
        ws: s.WS, taskId: '00000001', pid: 4242, procStart: 'start-4242',
        sessionId: 'sid-warm', claudePid: 4240, startedAt: 1, fails: 0,
      },
    },
    live: [sessionDetail({ pid: 4240, sessionId: 'sid-warm' })],
  });
  assert.ok(out.includes('[预热中 4242]'), out);
});

test('warm tag: alive but unregistered shows spawning', async (t) => {
  const s = await setup(t);
  s.alive.add(4242);
  const out = await s.render([WARM_TASK()], {
    state: {
      '00000001': {
        ws: s.WS, taskId: '00000001', pid: 4242, procStart: 'start-4242',
        startedAt: 1, fails: 0,
      },
    },
  });
  assert.ok(out.includes('[启动中 4242]'), out);
});

test('warm tag: resumed bare claude shows terminal takeover', async (t) => {
  const s = await setup(t);
  // script pid 已不在 alive（4242 不加入），同 sid 的裸 claude 在登记里。
  const out = await s.render([WARM_TASK()], {
    state: {
      '00000001': {
        ws: s.WS, taskId: '00000001', pid: 4242, procStart: 'start-4242',
        sessionId: 'sid-warm', startedAt: 1, fails: 0,
      },
    },
    live: [sessionDetail({ pid: 9001, sessionId: 'sid-warm' })],
  });
  assert.ok(out.includes('[终端接管]'), out);
});

test('warm tag: cooling entry', async (t) => {
  const s = await setup(t);
  const future = Math.floor(Date.now() / 1000) + 600;
  const out = await s.render([WARM_TASK()], {
    state: {
      '00000001': {
        ws: s.WS, taskId: '00000001', pid: null, fails: 3,
        cooldownUntil: future,
      },
    },
  });
  assert.ok(out.includes('[冷却中]'), out);
});

test('warm tag: dead entry with fails count', async (t) => {
  const s = await setup(t);
  const out = await s.render([WARM_TASK()], {
    state: {
      '00000001': {
        ws: s.WS, taskId: '00000001', pid: 4242, procStart: 'start-4242',
        startedAt: 1, fails: 2,
      },
    },
  });
  assert.ok(out.includes('[失败2次]'), out);
});

test('warm tag: wanted task with no entry is pending warmup', async (t) => {
  const s = await setup(t);
  const out = await s.render([WARM_TASK()], { state: null });
  assert.ok(out.includes('[待预热]'), out);
});

test('warm tag: distant task with no entry has no tag', async (t) => {
  const s = await setup(t);
  const out = await s.render([
    makeTask({ id: '00000001', cron: '30 3 1 1 *', prompt: '远期年报' }),
  ], { state: null });
  assert.ok(!out.includes('['), out);
});

// ---- 排版 ----

test('rows never overflow the terminal width', async (t) => {
  const s = await setup(t);
  for (const width of [60, 80, 100, 200]) {
    s.deps.terminalWidth = () => width;
    const out = await s.render([
      makeTask({ id: '00000001', cron: '5 0 * * *', prompt: '短任务' }),
      makeTask({ id: '00000002', cron: '0 10 * * 0',
        prompt: '很'.repeat(300) }),
    ]);
    for (const line of out.split('\n')) {
      assert.ok(dispWidth(line) <= width, `${width} 列下溢出：${line}`);
    }
  }
});

test('tagged rows never overflow, even at the 60-col floor', async (t) => {
  const s = await setup(t);
  s.alive.add(4242);
  for (const width of [60, 80, 100, 200]) {
    s.deps.terminalWidth = () => width;
    const out = await s.render([
      makeTask({ id: '00000001', cron: '5 0 * * *', prompt: '短' }),
      makeTask({ id: '00000002', cron: '0 10 * * 0',
        prompt: '很'.repeat(300) }),
    ], {
      state: {
        '00000001': {
          ws: s.WS, taskId: '00000001', pid: 4242, procStart: 'start-4242',
          sessionId: 'sid-warm', startedAt: 1, fails: 0,
        },
      },
    });
    for (const line of out.split('\n')) {
      assert.ok(dispWidth(line) <= width, `${width} 列下溢出：${line}`);
    }
  }
});

test('empty scan roots say no task files found', async (t) => {
  const tmp = mkTmp(t);
  const deps = mockDeps(t);
  deps.paths = tmpPaths(tmp);
  const emptyRoot = path.join(tmp, 'empty');
  fs.mkdirSync(emptyRoot);
  const cfgPath = path.join(tmp, 'config.json');
  writeJson(cfgPath, { roots: [emptyRoot] });
  const lines = [];
  deps.print = (m) => lines.push(m);
  await cmdList({ config: cfgPath });
  assert.ok(lines.join('\n').includes('没有发现定时任务文件'));
});
