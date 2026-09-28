#!/usr/bin/env node
// 从 Unicode 官方数据生成 src/east-asian-width.mjs（W/F 码点区间）。
// 一次性开发脚本，不是运行时依赖，CI 也不跑它；升级 Unicode 版本时手动执行：
//   curl -fsSL https://www.unicode.org/Public/UCD/latest/ucd/EastAsianWidth.txt \
//     -o /tmp/EastAsianWidth.txt
//   node scripts/gen-east-asian-width.mjs /tmp/EastAsianWidth.txt \
//     > src/east-asian-width.mjs
//
// 只取 W（Wide）与 F（Fullwidth）两档；Ambiguous（含 U+2026 省略号）按
// 1 列计，不进表。
import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('用法：gen-east-asian-width.mjs <EastAsianWidth.txt>');
  process.exit(1);
}
const text = fs.readFileSync(file, 'utf-8');

const version = text.match(/EastAsianWidth-([\d.]+)\.txt/)?.[1] ?? 'unknown';
const date = text.match(/^# Date: (.+)$/m)?.[1]?.trim() ?? 'unknown';

// 形如 "1100..115F     ; W  # ..." 或 "3000           ; W # ..."
const ranges = [];
for (const line of text.split('\n')) {
  const m = line.match(/^([0-9A-F]+)(?:\.\.([0-9A-F]+))?\s*;\s*([WF])\b/);
  if (!m) continue;
  const start = parseInt(m[1], 16);
  const end = m[2] ? parseInt(m[2], 16) : start;
  if (ranges.length && start <= ranges[ranges.length - 1][1] + 1) {
    ranges[ranges.length - 1][1] = end; // W 与相邻 F 并为同一「宽」档
  } else {
    ranges.push([start, end]);
  }
}

let out = '';
out += '// 本文件由 scripts/gen-east-asian-width.mjs 生成，请勿手改。\n';
out += `// 数据：Unicode East_Asian_Width 的 W/F 码点区间（Unicode ${version}，${date}）。\n`;
out += '// Ambiguous 字符（如 U+2026 省略号）不在表中，按 1 列计。\n';
out += `// 共 ${ranges.length} 个连续区间，二分查找。\n\n`;
out += 'const WIDE_RANGES = [\n';
for (let i = 0; i < ranges.length; i++) {
  if (i % 6 === 0) out += '  ';
  const [a, b] = ranges[i];
  out += (a === b ? `[${a}]` : `[${a},${b}]`) + (i < ranges.length - 1 ? ',' : '');
  if (i % 6 === 5 || i === ranges.length - 1) out += '\n';
}
out += '];\n\n';
out += `export function isWide(cp) {\n`;
out += '  let lo = 0, hi = WIDE_RANGES.length - 1;\n';
out += '  while (lo <= hi) {\n';
out += '    const mid = (lo + hi) >> 1;\n';
out += '    const [a, b] = WIDE_RANGES[mid];\n';
out += '    if (cp < a) hi = mid - 1;\n';
out += '    else if (cp > (b ?? a)) lo = mid + 1;\n';
out += '    else return true;\n';
out += '  }\n';
out += '  return false;\n';
out += '}\n';

process.stdout.write(out);
