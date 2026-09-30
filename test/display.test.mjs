import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dispWidth, clip, pad, fmtFireRange, taskView } from '../src/display.mjs';

test('display width handles cjk and punctuation', () => {
  assert.equal(dispWidth('中文：'), 6);
  assert.equal(dispWidth('ab'), 2);
  assert.equal(dispWidth('。「」あア한'), 12);
  // 省略号 U+2026 是 East Asian Ambiguous，按 1 列计（多数终端如此）
  assert.equal(clip('中文测试', 5), '中…');
  assert.equal(dispWidth(clip('中文测试', 5)), 3);
  assert.equal(clip('abcdef', 5), 'abc…');
  assert.equal(pad('中文', 6), '中文  ');
});

test('fmtFireRange renders slot to predicted fire', () => {
  const mk = (d, h, min, sec = 0) => new Date(2026, 9, d, h, min, sec);
  // 同日、整分顶格：省略第二个日期。
  assert.equal(fmtFireRange(mk(2, 0, 0), mk(2, 0, 30)), '10-02 00:00 → 00:30');
  // 跨天：两段都带日期。
  assert.equal(fmtFireRange(mk(1, 23, 30), mk(2, 0, 0)),
    '10-01 23:30 → 10-02 00:00');
  // 非整分抖动：第二段带秒。
  assert.equal(fmtFireRange(mk(1, 5, 0), mk(1, 5, 15, 37)),
    '10-01 05:00 → 05:15:37');
  // 同分钟（无抖动）：不画箭头。
  assert.equal(fmtFireRange(mk(1, 5, 0), mk(1, 5, 0)), '10-01 05:00');
  // fire 缺失：回退落点。
  assert.equal(fmtFireRange(mk(1, 5, 0), null), '10-01 05:00');
});

test('taskView carries a predicted fire time', () => {
  const now = new Date(2026, 8, 20, 15, 47);
  const v = taskView({
    id: 'c1363d8b', cron: '0 13 * * *', recurring: true,
  }, now);
  assert.ok(v.fire instanceof Date);
  // 下一落点 09-21 13:00，顶格 30 分钟 → 09-21 13:30。
  assert.equal(v.fire.getTime(), new Date(2026, 8, 21, 13, 30, 0).getTime());
});

test('taskView aligns the slot to the pending tail delivery', () => {
  // 落点 15:30 已过、顶格 id 投递 16:00 未到：nxt 对齐今天 15:30（而非
  // 明天的落点），fire 是今天 16:00——「15:30 → 16:00」箭头画得出，排序
  // 也把它当最临近的事。
  const now = new Date(2026, 8, 20, 15, 47);
  const v = taskView(
    { id: 'c1363d8b', cron: '30 15 * * *', recurring: true }, now);
  assert.equal(v.nxt.getTime(), new Date(2026, 8, 20, 15, 30, 0).getTime());
  assert.equal(v.fire.getTime(), new Date(2026, 8, 20, 16, 0, 0).getTime());
});

test('missed one-shot has no next slot', () => {
  // 已错过的一次性任务：nxt 必须为 null，否则「一年内无」的判断和总览
  // 「最近」（fire ?? nxt）会把它当成明年同刻的安排。
  const now = new Date(2026, 8, 20, 15, 47);
  const v = taskView({
    id: 'c1363d8b', cron: '30 8 20 9 *', recurring: false,
    createdAt: now.getTime() - 86400_000,
  }, now);
  assert.equal(v.missed, true);
  assert.equal(v.nxt, null);
  assert.equal(v.fire, null);
});
