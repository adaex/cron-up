// 测试公共辅助。放在 test/ 之外：node --test 会把 test/ 下任意 .mjs 当测
// 试文件运行，而这里没有 test()，会报「空套件」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 引全量入口：保证所有业务模块都已向 deps 自注册。
import '../src/index.mjs';
import { deps } from '../src/internals.mjs';
import { makePaths } from '../src/paths.mjs';

// 创建 realpath 后的临时目录（macOS /tmp 是 /private/tmp 的符号链接）。
export function mkTmp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cronup-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 快照整个 deps 容器，测试结束后还原（t.after 注册清理）。paths 是带
// getter 的对象，保存引用即可——测试通常整体替换 deps.paths。
export function mockDeps(t) {
  const snapshot = {};
  for (const k of Object.keys(deps)) snapshot[k] = deps[k];
  t.after(() => {
    for (const k of Object.keys(deps)) delete deps[k];
    Object.assign(deps, snapshot);
  });
  return deps;
}

// 把产物路径全部重定向到 tmp：默认给一份完整 paths，测试可再覆盖单项
// （spread 在末尾覆盖同名键；派生键此时求值固化，测试都在构造期定下
// 前缀，不依赖事后动态跟随）。
export function tmpPaths(tmp, overrides = {}) {
  const p = {
    ...makePaths({
      // home 默认保持真实 HOME（expandHome 依赖它），只有显式
      // overrides.home 才重定向。
      home: os.homedir(),
      dataDir: path.join(tmp, 'app'),
      logDir: path.join(tmp, 'logs'),
      plistPath: path.join(tmp, 'local.cron-up.plist'),
      sessionDir: path.join(tmp, 'sessions-registry'),
    }),
    ...overrides,
  };
  // 派生目录建出来，测试直接写 statePath/configPath 不会 ENOENT。
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
