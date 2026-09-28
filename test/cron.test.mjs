// 测试的当前时间固定为 2026-09-20 15:47（周日）本地时间。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import {
  Cron,
  parseCronField,
  taskIsOneshot,
  taskWanted,
  wanted,
} from '../src/cron.mjs';
import { taskView } from '../src/display.mjs';
import { DISPLAY_SEARCH_DAYS } from '../src/constants.mjs';

const NOW = new Date(2026, 8, 20, 15, 47); // Sunday
const LEAD_MS = 10 * 60_000;

function dt(y, m, d, h = 0, min = 0) {
  return new Date(y, m - 1, d, h, min).getTime();
}

test('step ranges', () => {
  assert.equal(new Cron('*/5 * * * *').nextAfter(NOW)?.getTime(),
    dt(2026, 9, 20, 15, 50));
  assert.equal(new Cron('3,33 * * * *').nextAfter(NOW)?.getTime(),
    dt(2026, 9, 20, 16, 3));
});

test('rolls to next day', () => {
  assert.equal(new Cron('3 9 * * *').nextAfter(NOW)?.getTime(),
    dt(2026, 9, 21, 9, 3));
});

test('day of week', () => {
  // 仅周日，今天 10:00 已过 → 下周日
  assert.equal(new Cron('0 10 * * 0').nextAfter(NOW)?.getTime(),
    dt(2026, 9, 27, 10, 0));
});

test('dom/dow OR semantics', () => {
  // 两者都受限：命中其一。今天 20 号（DoM 命中）。
  assert.equal(new Cron('0 18 20 * 1').nextAfter(NOW)?.getTime(),
    dt(2026, 9, 20, 18, 0));
});

test('dom/dow OR hits weekday', () => {
  // 25 号或周一：明天（周一 9/21）胜出，尽管不是 25 号。
  assert.equal(new Cron('0 12 25 * 1').nextAfter(NOW)?.getTime(),
    dt(2026, 9, 21, 12, 0));
});

test('vixie start/step', () => {
  assert.deepEqual([...parseCronField('5/15', 0, 59)],
    [5, 20, 35, 50]);
});

test('dow 7 is sunday inside ranges', () => {
  // 7 表示周日；折叠必须发生在区间展开之后。
  assert.equal(new Cron('0 9 * * 1-7').nextAfter(NOW)?.getTime(),
    dt(2026, 9, 21, 9, 0));
  assert.equal(new Cron('0 9 * * 2-7').nextAfter(NOW)?.getTime(),
    dt(2026, 9, 22, 9, 0));
  assert.equal(new Cron('0 9 * * 7').nextAfter(NOW)?.getTime(),
    dt(2026, 9, 27, 9, 0));
  assert.equal(new Cron('0 9 * * 0,7').nextAfter(NOW)?.getTime(),
    dt(2026, 9, 27, 9, 0));
});

test('out of range dow is dropped not folded', () => {
  // 8 不能通过 8 % 7 === 1 变成周一。
  assert.equal(new Cron('0 9 * * 8').satisfiable, false);
});

test('empty field sets are unsatisfiable', () => {
  for (const expr of ['99 * * * *', '5-2 * * * *', '0 99 * * *',
    '0 0 * 13 *', '0 0 99 * *', '0 9 * * 8']) {
    assert.equal(new Cron(expr).satisfiable, false, expr);
  }
});

test('unsatisfiable views as invalid', () => {
  assert.equal(taskView({ cron: '99 * * * *' }, NOW).valid, false);
});

test('in-range values surrounding a typo survive', () => {
  // vixie 会拒绝整行；这里只剪掉坏值，typo 不会让合法的每小时 5 分失声。
  const cron = new Cron('5,99 * * * *');
  assert.equal(cron.satisfiable, true);
  assert.equal(cron.nextAfter(NOW)?.getTime(), dt(2026, 9, 20, 16, 5));
});

test('out of range OR side does not match through', () => {
  // DoM=99 不能留在集合里让 DoW 一侧继续匹配周一。
  const cron = new Cron('0 12 99 * 1');
  assert.equal(cron.satisfiable, false);
  assert.equal(cron.nextAfter(NOW), null);
});

// ---- 快进与朴素逐分钟扫描对拍 ----

function bruteNextAfter(cron, after, withinDays) {
  if (!cron.satisfiable) return null;
  const t = new Date(after.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const deadline = after.getTime() + withinDays * 86400_000;
  while (t.getTime() <= deadline) {
    if (cron.matches(t)) return t;
    t.setMinutes(t.getMinutes() + 1);
  }
  return null;
}

const EXPRS = ['*/5 * * * *', '3 9 * * *', '0 0 29 2 *', '0 0 31 4 *',
  '0 10 * * 0', '0 18 20 * 1', '0 12 25 * 1', '30 3 1 1 *',
  '*/7 */3 * * *', '0 0 1 * *', '15 14 * * 5', '0 0 29 2 1',
  '59 23 31 12 *', '0,30 8-18/2 1,15 * *', '0 0 29 2 0'];

const STARTS = [
  new Date(2026, 8, 20, 15, 47),
  new Date(2026, 0, 31, 23, 59),
  new Date(2027, 1, 28, 0, 0),
  new Date(2028, 1, 29, 12, 0),
  new Date(2026, 11, 31, 23, 58),
];

test('fast forward matches brute force', () => {
  for (const expr of EXPRS) {
    const cron = new Cron(expr);
    for (const start of STARTS) {
      for (const window of [7, 31, 366, 800]) {
        assert.equal(
          cron.nextAfter(start, window)?.getTime() ?? null,
          bruteNextAfter(cron, start, window)?.getTime() ?? null,
          `${expr} / ${start} / ${window}`,
        );
      }
    }
  }
});

test('year-long display window stays cheap', () => {
  const cron = new Cron('0 0 29 2 *');
  const started = performance.now();
  cron.nextAfter(NOW, DISPLAY_SEARCH_DAYS);
  assert.ok(performance.now() - started < 200);
});

test('task view sees a year ahead', () => {
  const future = new Date(NOW.getTime() + 60 * 86400_000);
  const expr = `${future.getMinutes()} ${future.getHours()} ${future.getDate()} `
    + `${future.getMonth() + 1} *`;
  const v = taskView({ cron: expr, recurring: true }, NOW);
  assert.equal(v.nxt.getTime(), future.getTime());
  // 巡检判定不受显示窗口影响：60 天外不算需要预热。
  assert.equal(taskWanted({ cron: expr, recurring: true }, NOW, 10 * 60_000),
    false);
});

test('task view can answer the patrol question too', () => {
  const soon = new Date(NOW.getTime() + 5 * 60_000);
  const expr = `${soon.getMinutes()} ${soon.getHours()} ${soon.getDate()} `
    + `${soon.getMonth() + 1} *`;
  const task = { cron: expr, recurring: true };
  assert.equal(taskView(task, NOW, LEAD_MS).wanted, true);
  assert.equal(taskView(task, NOW, LEAD_MS).wanted,
    taskWanted(task, NOW, LEAD_MS));
  // 不传 lead 时 wanted 为 null（不是缺席）。
  assert.equal(taskView(task, NOW).wanted, null);
  // 无效任务的 wanted 同样是 null。
  assert.equal(taskView({ cron: 'nope' }, NOW, LEAD_MS).wanted, null);
});

// ---- wanted ----

test('within lead window', () => {
  const t = { cron: '50 15 20 9 *', createdAt: 1_789_000_000_000 };
  assert.equal(taskWanted(t, NOW, LEAD_MS), true);
});

test('recurring flag identifies one-shot', () => {
  assert.equal(taskIsOneshot({ cron: '0 0 1 1 *', recurring: false }), true);
  // 文本形状像一次性的年度任务，有标志时不算一次性：
  assert.equal(taskIsOneshot({ cron: '0 0 1 1 *', recurring: true }), false);
});

test('shape fallback without flag', () => {
  assert.equal(taskIsOneshot({ cron: '0 0 1 1 *' }), true);
  assert.equal(taskIsOneshot({ cron: '0 0 * * *' }), false);
});

test('missed one-shot is wanted', () => {
  const t = { cron: '40 15 20 9 *', createdAt: 1_789_000_000_000 };
  assert.equal(taskWanted(t, NOW, LEAD_MS), true);
});

test('missed recurring waits for next round', () => {
  const t = { cron: '40 15 * * *', createdAt: 1_789_000_000_000 };
  assert.equal(taskWanted(t, NOW, LEAD_MS), false);
  assert.equal(new Cron('40 15 * * *').nextAfter(NOW)?.getTime(),
    dt(2026, 9, 21, 15, 40));
});

test('bad cron is not wanted', () => {
  assert.equal(taskWanted({ cron: 'not a cron' }, NOW, LEAD_MS), false);
});

test('malformed tasks never raise', () => {
  for (const task of [{ cron: 123 }, { cron: null }, { cron: [] },
  { prompt: 'no cron' }, {},
  { cron: '*/5 * * * *', createdAt: 'yesterday' },
  { cron: '*/5 * * * *', createdAt: null },
  { cron: '0 0 1 1 *', createdAt: 10 ** 18 }]) {
    assert.equal(typeof taskWanted(task, NOW, LEAD_MS), 'boolean');
  }
});

test('unsatisfiable cron returns none fast', () => {
  for (const expr of ['99 * * * *', '0 99 * * *', '0 0 * 13 *', '0 0 99 * *']) {
    const started = performance.now();
    assert.equal(new Cron(expr).nextAfter(NOW), null);
    assert.ok(performance.now() - started < 50, expr);
  }
});

test('beyond the window reads as no next fire', () => {
  assert.equal(new Cron('0 0 29 2 *').nextAfter(NOW), null);
  assert.equal(taskWanted({ cron: '0 0 29 2 *', recurring: true }, NOW, LEAD_MS),
    false);
  // 调用方显式要求看更远时仍能给出结果。
  assert.equal(new Cron('0 0 29 2 *').nextAfter(NOW, 900)?.getTime(),
    new Date(2028, 1, 29, 0, 0).getTime());
});

test('missed one-shot created long ago is still wanted', () => {
  // 补执行从创建时间向前搜，不受普通前瞻窗口限制。
  const created = new Date(NOW.getTime() - 10 * 86400_000);
  const fire = new Date(NOW.getTime() - 9 * 86400_000);
  const task = {
    cron: `${fire.getMinutes()} ${fire.getHours()} ${fire.getDate()} `
      + `${fire.getMonth() + 1} *`,
    createdAt: created.getTime(),
    recurring: false,
  };
  assert.equal(taskWanted(task, NOW, LEAD_MS), true);
});

test('missed one-shot with a far creation-to-fire span is wanted', () => {
  // 「下个月某天」的一次性任务：创建到触发跨 50 天，错过仅 3 天——
  // 创建向前的搜索不封顶，照样判定错过。
  const created = new Date(NOW.getTime() - 53 * 86400_000);
  const fire = new Date(NOW.getTime() - 3 * 86400_000);
  const task = {
    cron: `${fire.getMinutes()} ${fire.getHours()} ${fire.getDate()} `
      + `${fire.getMonth() + 1} *`,
    createdAt: created.getTime(),
    recurring: false,
  };
  assert.equal(taskWanted(task, NOW, LEAD_MS), true);
});

test('ancient unmatchable one-shot stays cheap', () => {
  const created = new Date(NOW.getTime() - 3650 * 86400_000);
  const task = {
    cron: '0 0 30 2 *', // 2 月 30 日：永不
    createdAt: created.getTime(),
    recurring: false,
  };
  const started = performance.now();
  assert.equal(taskWanted(task, NOW, LEAD_MS), false);
  assert.ok(performance.now() - started < 200);
});

// wanted 直测（taskView 复用它）
test('wanted is exported for the display view', () => {
  const soon = new Cron('*/5 * * * *');
  assert.equal(typeof wanted(soon, { recurring: true }, NOW, LEAD_MS),
    'boolean');
});
