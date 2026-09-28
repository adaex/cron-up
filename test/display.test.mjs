// 翻译自 Python DisplayTests：CJK 宽度、截断、补位。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dispWidth, clip, pad } from '../src/display.mjs';

test('display width handles cjk and punctuation', () => {
  assert.equal(dispWidth('中文：'), 6);
  assert.equal(dispWidth('ab'), 2);
  // 省略号 U+2026 是 East Asian Ambiguous，按 1 列计（多数终端如此）
  assert.equal(clip('中文测试', 5), '中…');
  assert.equal(dispWidth(clip('中文测试', 5)), 3);
  assert.equal(clip('abcdef', 5), 'abc…');
  assert.equal(pad('中文', 6), '中文  ');
});
