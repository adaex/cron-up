import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dispWidth, clip, pad, displayPath, taskView, taskSummary,
} from '../src/display.mjs';
import { mockDeps } from '../test-support/helpers.mjs';

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

test('displayPath abbreviates home only on a complete path segment', (t) => {
  const deps = mockDeps(t);
  deps.paths = { home: '/Users/aex/' };
  assert.equal(displayPath('/Users/aex'), '~');
  assert.equal(displayPath('/Users/aex/space/infra-space'), '~/space/infra-space');
  assert.equal(displayPath('/Users/aex-other/space'), '/Users/aex-other/space');
  assert.equal(displayPath('/opt/project'), '/opt/project');

  deps.paths.home = '/';
  assert.equal(displayPath('/opt/project'), '~/opt/project');
});

test('taskSummary reuses the first non-empty prompt line as a single-line session name', () => {
  assert.equal(taskSummary({ prompt: '\n  每日\t 汇总  \n后续说明' }), '每日 汇总');
  assert.equal(taskSummary({ prompt: ' \n\t' }), '（无任务描述）');
  assert.equal(taskSummary(null), '（无任务描述）');
});

test('taskView shows the cron slot without a predicted fire time', () => {
  const now = new Date(2026, 8, 20, 15, 47);
  const v = taskView({
    id: 'c1363d8b', cron: '0 13 * * *', recurring: true,
  }, now);
  assert.equal(v.nxt.getTime(), new Date(2026, 8, 21, 13, 0, 0).getTime());
  assert.equal('fire' in v, false);
});

test('taskView aligns the slot to the pending tail delivery', () => {
  // 落点 15:30 已过、顶格 id 投递 16:00 未到：nxt 仍对齐今天 15:30，
  // 而非明天的落点；不再额外展示秒级预计投递。
  const now = new Date(2026, 8, 20, 15, 47);
  const v = taskView(
    { id: 'c1363d8b', cron: '30 15 * * *', recurring: true }, now);
  assert.equal(v.nxt.getTime(), new Date(2026, 8, 20, 15, 30, 0).getTime());
  assert.equal('fire' in v, false);
});

test('future one-shot within 90s of a grid slot is not shown as missed', () => {
  // 回归：一次性网格落点最多提前 90 秒投递只属于巡检的前瞻窗口
  // （leadMs>0）；lead=0 的 missed 判定不能把落点前 60 秒的未来任务
  // 显示成「已错过」（否则时间列消失、总览「最近」漏掉它）。
  const now = new Date(2026, 8, 20, 15, 59);
  const v = taskView({
    id: 'c1363d8b', cron: '0 16 20 9 *', recurring: false,
    createdAt: now.getTime() - 60_000,
  }, now, 6 * 60_000);
  assert.equal(v.missed, false);
  assert.ok(v.nxt instanceof Date);
  // 巡检口径仍把它算作窗口内（360 秒提前量 + 90 秒网格提前）。
  assert.equal(v.wanted, true);
});

test('missed one-shot has no next slot', () => {
  // 已错过的一次性任务：nxt 必须为 null，否则「一年内无」的判断和总览
  // 「最近」会把它当成明年同刻的安排。
  const now = new Date(2026, 8, 20, 15, 47);
  const v = taskView({
    id: 'c1363d8b', cron: '30 8 20 9 *', recurring: false,
    createdAt: now.getTime() - 86400_000,
  }, now);
  assert.equal(v.missed, true);
  assert.equal(v.nxt, null);
});
