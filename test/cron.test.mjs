// 测试的当前时间固定为 2026-09-20 15:47（周日）本地时间。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import {
  Cron,
  parseCronField,
  parseCronOrNone,
  taskIsOneshot,
  taskWanted,
  wanted,
  taskIdHash,
  nextDelivery,
} from '../src/cron.mjs';
import { taskView } from '../src/display.mjs';
import { DISPLAY_SEARCH_DAYS } from '../src/constants.mjs';

const NOW = new Date(2026, 8, 20, 15, 47); // Sunday
const LEAD_MS = 10 * 60_000;

// 直接测 nextDelivery 的 fire：它是 taskView nxt/fire 的唯一来源，生产侧
// 已无第二入口（原 predictedFire 薄封装已删）。
function fireOf(task, now = NOW) {
  return nextDelivery(new Cron(task.cron), task, now).fire;
}

function dt(y, m, d, h = 0, min = 0) {
  return new Date(y, m - 1, d, h, min).getTime();
}

test('step ranges', () => {
  assert.equal(new Cron('*/5 * * * *').nextAfter(NOW)?.getTime(),
    dt(2026, 9, 20, 15, 50));
  assert.equal(new Cron('3,33 * * * *').nextAfter(NOW)?.getTime(),
    dt(2026, 9, 20, 16, 3));
});

test('non-positive step is rejected, not hung on', () => {
  // strictInt 接受负号，而负步进让步进循环里 v+=step 递减、v<=end 恒真
  // ——永不退出的死循环，一个含 "/-5" 的任务文件就能挂死整轮巡检。全部
  // 读作「cron 无效」；这个测试能跑完本身即证明没有被挂住。
  for (const expr of ['*/0 * * * *', '*/-5 * * * *', '0-30/-2 * * * *',
    '5/-2 * * * *']) {
    assert.equal(parseCronOrNone(expr), null, expr);
  }
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

// ---- Claude Code 投递抖动预测 ----
// 固定参考 NOW=2026-09-20 15:47（文件头）；hash 容差覆盖双精度表达差异。
test('taskIdHash mirrors the upstream M(id) hash', () => {
  assert.ok(Math.abs(taskIdHash('0ff0d1b5') - 0.062268) < 1e-6);
  assert.ok(Math.abs(taskIdHash('c1363d8b') - 0.754734) < 1e-6);
  assert.ok(Math.abs(taskIdHash('058e0149') - 0.021698) < 1e-6);
  // 只取前 8 位：后面的字符不影响结果。
  assert.equal(taskIdHash('058e0149-aaaa-bbbb') > 0, true);
  assert.equal(taskIdHash('058e0149-aaaa-bbbb'),
    taskIdHash('058e0149'));
  // 缺失或前 8 位全非十六进制：回退 0，绝不抛。
  assert.equal(taskIdHash(undefined), 0);
  assert.equal(taskIdHash({}), 0);
  assert.equal(taskIdHash('zzzzzzzz'), 0);
});

test('recurring fire is the slot plus the deterministic jitter', () => {
  // 从固定时刻算：daily cron '0 13' 的下一落点是 09-21 13:00（NOW 当天
  // 13:00 已过），再下一个 09-22 13:00，周期 1 天。
  const slot = new Date(2026, 8, 21, 13, 0, 0);
  const day = 86400_000;
  for (const [id, expectedDelayS] of [
    ['c1363d8b', 1800],    // hash 0.7547 → min(…, cap) 顶格 30 分钟
    ['058e0149', 937.4],   // hash 0.02170 → 约 15:37.4，不顶格
    [undefined, 0],        // 无 id → hash 0，无抖动
    ['zzzzzzzz', 0],       // 坏 id 同 0
  ]) {
    const fire = fireOf(
      { id, cron: '0 13 * * *', recurring: true });
    assert.ok(fire instanceof Date, `id=${id} 应返回 Date`);
    const delayS = (fire.getTime() - slot.getTime()) / 1000;
    assert.ok(Math.abs(delayS - expectedDelayS) < 1.5,
      `id=${id} 延迟 ${delayS}s 与预期 ${expectedDelayS}s 不符`);
  }
});

test('jitter cap also binds for long-period crons', () => {
  // 周期 7 天不设顶会是 hash·0.5·7 天（数小时），顶格后只有 30 分钟。
  const fire = fireOf(
    { id: 'c1363d8b', cron: '0 10 * * 0', recurring: true });
  // 下一落点：09-27 10:00（见 day of week 测试），顶格 → 10:30。
  assert.equal(fire.getTime(), new Date(2026, 8, 27, 10, 30, 0).getTime());
});

test('one-shot grid slots fire early, other minutes do not', () => {
  // 09-25 14:00（:00 网格）：提前 hash·90s，但不早于 NOW。
  const grid = fireOf(
    { id: 'c1363d8b', cron: '0 14 25 9 *', recurring: false,
      createdAt: NOW.getTime() - 86400_000 });
  const slot = new Date(2026, 8, 25, 14, 0, 0);
  assert.ok(slot.getTime() - grid.getTime() > 0);
  assert.ok(slot.getTime() - grid.getTime() <= 90_000);

  // 09-25 14:07（非网格）：不抖。
  const plain = fireOf(
    { id: 'c1363d8b', cron: '7 14 25 9 *', recurring: false,
      createdAt: NOW.getTime() - 86400_000 });
  assert.equal(plain.getTime(), new Date(2026, 8, 25, 14, 7, 0).getTime());
});

test('nextDelivery yields no fire for an unsatisfiable cron', () => {
  // 2 月 30 日：解析成功但任何分钟都不匹配，展示读作「无安排」。
  const fire = nextDelivery(
    new Cron('0 0 30 2 *'), { recurring: true }, NOW).fire;
  assert.equal(fire, null);
});

// ---- prevAtOrBefore 与投递尾窗 ----
function brutePrev(expr, t, days) {
  const c = new Cron(expr);
  const cur = new Date(t.getTime());
  cur.setSeconds(0, 0);
  const deadline = cur.getTime() - days * 86400_000;
  while (cur.getTime() >= deadline) {
    if (c.matches(cur)) return new Date(cur.getTime());
    cur.setMinutes(cur.getMinutes() - 1);
  }
  return null;
}

test('prevAtOrBefore matches naive backward scan', () => {
  const exprs = [
    '0 5 * * *', '30 13 * * *', '30 13 * * 5', '0 0 1 * *',
    '*/7 * * * *', '0,30 9-17 * * 1-5', '0 0 29 2 *', '15 23 * * *',
  ];
  for (const expr of exprs) {
    const c = new Cron(expr);
    for (const offset of [0, 1, 37, 600, 86400 * 30]) {
      const t = new Date(NOW.getTime() - offset * 60_000);
      const fast = c.prevAtOrBefore(t, 400);
      const expect = brutePrev(expr, t, 400);
      assert.equal(fast?.getTime() ?? null, expect?.getTime() ?? null,
        `${expr} offset=${offset}`);
    }
  }
});

test('prevAtOrBefore includes the current matching minute', () => {
  const t = new Date(2026, 8, 21, 13, 30, 23); // 周一 13:30:23
  assert.equal(new Cron('30 13 * * *').prevAtOrBefore(t, 7)?.getTime(),
    new Date(2026, 8, 21, 13, 30, 0).getTime());
});

test('wanted covers the recurring post-slot jitter tail window', () => {
  // NOW = 周日 15:47。cron 30 15 的落点 15:30 已过：
  // 顶格 id → 投递点 16:00，15:47 仍在尾窗内，需要会话。
  const slotCron = '30 15 * * *';
  assert.equal(taskWanted(
    { id: 'c1363d8b', cron: slotCron, recurring: true }, NOW, 0), true);
  // 小哈希 id → 只延迟 15:37，投递点 15:45:37 已过，尾窗结束。
  assert.equal(taskWanted(
    { id: '058e0149', cron: slotCron, recurring: true }, NOW, 0), false);
});

test('wanted tail window is bounded by the actual delay, not the 30m cap', () => {
  // 非顶格任务：尾窗在落点+15:37 关闭，而不是落点+30 分。用 15:44（尾窗
  // 内，距落点 14 分）与 15:46（尾窗外，距落点 16 分）夹住。
  const cron = '30 15 * * *';
  const at = (h, m) => new Date(2026, 8, 20, h, m, 0);
  assert.equal(wanted(new Cron(cron),
    { id: '058e0149', recurring: true }, at(15, 44), 0), true);
  assert.equal(wanted(new Cron(cron),
    { id: '058e0149', recurring: true }, at(15, 46), 0), false);
});

test('nextDelivery answers the pending tail delivery, not the next slot', () => {
  // NOW 15:47：落点 15:30 已过、顶格 id 的投递点 16:00 未到——预计触发是
  // 今天 16:00，而不是明天的落点 + 抖动。落点与预计同刻的任务文件里
  // list 会画出「15:30 → 16:00」（见 display 测试的落点对齐）。
  const task = { id: 'c1363d8b', cron: '30 15 * * *', recurring: true };
  assert.equal(fireOf(task, NOW).getTime(),
    new Date(2026, 8, 20, 16, 0, 0).getTime());
  // 尾窗一过（16:30），回到下一落点 + 抖动：明天 15:30 → 16:00。
  const after = new Date(2026, 8, 20, 16, 30, 0);
  assert.equal(fireOf(task, after).getTime(),
    new Date(2026, 8, 21, 16, 0, 0).getTime());
});

test('tail window survives multi-year slot gaps (Feb 29)', () => {
  // 2028-02-29 09:15：上一落点在 1461 天前（2024-02-29），任何 366 天窗口
  // 都找不到它，尾窗会塌缩成零——wanted 仍须答 true、nextDelivery 仍须答
  // 今天 09:30（顶格 30 分钟）；且下一落点（2032 年）在展示窗口之外，
  // nextDelivery 不能先死在窗口检查上。
  const now = new Date(2028, 1, 29, 9, 15, 0);
  const task = { id: 'c1363d8b', cron: '0 9 29 2 *', recurring: true };
  assert.equal(taskWanted(task, now, 0), true);
  assert.equal(fireOf(task, now).getTime(),
    new Date(2028, 1, 29, 9, 30, 0).getTime());
  // 投递一过，回正常的「下一落点」口径：2032-02-29 超出 366 天展示窗
  // 口，nextDelivery 如实答 null（「一年内无」）——但尾窗判定不受影响，
  // 明年同日再次进入尾窗时仍能保住会话。
  const after = new Date(2028, 1, 29, 10, 0, 0);
  assert.equal(fireOf(task, after), null);
  const nextYear = new Date(2029, 1, 28, 9, 15, 0);
  assert.equal(taskWanted(task, nextYear, 0), false);
});
