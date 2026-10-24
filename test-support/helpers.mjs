// 测试公共辅助。放在 test/ 之外：node --test 会把 test/ 下任意 .mjs 当测
// 试文件运行，而这里没有 test()，会报「空套件」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 引全量入口：保证所有业务模块都已向 deps 自注册。
import '../src/index.mjs';
import { deps } from '../src/internals.mjs';
import { makePaths } from '../src/paths.mjs';
import { TASK_REL } from '../src/paths.mjs';

// 创建 realpath 后的临时目录（macOS /tmp 是 /private/tmp 的符号链接）。
export function mkTmp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cronup-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 快照整个 deps 容器，测试结束后还原（t.after 注册清理）。
export function mockDeps(t) {
  const snapshot = {};
  for (const k of Object.keys(deps)) snapshot[k] = deps[k];
  t.after(() => {
    for (const k of Object.keys(deps)) delete deps[k];
    Object.assign(deps, snapshot);
  });
  return deps;
}

// 把产物路径全部重定向到 tmp。
export function tmpPaths(tmp, overrides = {}) {
  const p = {
    ...makePaths({
      home: os.homedir(),
      dataDir: path.join(tmp, 'app'),
      logDir: path.join(tmp, 'logs'),
      plistPath: path.join(tmp, 'local.cron-up.plist'),
      sessionDir: path.join(tmp, 'sessions-registry'),
    }),
    ...overrides,
  };
  fs.mkdirSync(p.dataDir, { recursive: true });
  fs.mkdirSync(p.logDir, { recursive: true });
  fs.mkdirSync(p.sessionDir, { recursive: true });
  return p;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

// ---- 任务文件夹具 ----

// 在临时工作区落盘任务文件，返回任务文件路径。
export function writeTaskFile(ws, tasks) {
  const file = path.join(ws, TASK_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ tasks }, null, 2));
  return file;
}

// 标准周期任务（默认每分钟匹配，恒在窗口内）。
export function makeTask(over = {}) {
  return {
    id: over.id ?? '00000001',
    cron: over.cron ?? '*/5 * * * *',
    prompt: over.prompt ?? '做一件事',
    createdAt: over.createdAt ?? Date.now() - 3600_000,
    recurring: over.recurring ?? true,
    permanent: true,
    ...over,
  };
}

// 「距现在 offsetSec 后」的一次性 cron 五字段。
export function cronAt(offsetSec, base = new Date()) {
  const d = new Date(base.getTime() + offsetSec * 1000);
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} `
    + `${d.getMonth() + 1} *`;
}

// ---- 会话登记夹具 ----

// 构造一条会话登记详情（scanSessions 第三元素的成员形状）。
export function sessionDetail(over = {}) {
  return {
    pid: over.pid ?? 100,
    sessionId: over.sessionId ?? 'sid-1',
    procStart: over.procStart ?? 'Fri Oct 16 06:01:20 2026',
    ancestors: over.ancestors ?? [1],
  };
}

// 给定 details 构造 scanSessions 的三元组（consumers 按 details 的键集
// 合）；告警位置传 null。
export function scanFrom(details = new Map()) {
  return [new Set(details.keys()), null, details];
}
