// 测试公共辅助。放在 test/ 之外：node --test 会把 test/ 下任意 .mjs 当测
// 试文件运行，而这里没有 test()，会报「空套件」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 引全量入口：保证所有业务模块都已向 deps 自注册。
import '../src/index.mjs';
import { deps } from '../src/internals.mjs';
import { paths } from '../src/paths.mjs';

// 创建 realpath 后的临时目录（macOS /tmp 是 /private/tmp 的符号链接）。
export function mkTmp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 快照整个 deps 容器，测试结束后还原（等价 Python addCleanup(setattr,...)）。
// paths 是带 getter 的对象，保存引用即可——测试通常整体替换 deps.paths。
export function mockDeps(t) {
  const snapshot = {};
  for (const k of Object.keys(deps)) snapshot[k] = deps[k];
  t.after(() => {
    for (const k of Object.keys(deps)) delete deps[k];
    Object.assign(deps, snapshot);
  });
  return deps;
}

// 把产物路径全部重定向到 tmp：默认给一份完整 paths，测试可再覆盖单项。
export function tmpPaths(tmp, overrides = {}) {
  const p = {
    // home 默认保持真实 HOME（expanduser 语义与 Python 测试一致），只有
    // 显式 overrides.home 才重定向。
    home: os.homedir(),
    appSupport: path.join(tmp, 'app'),
    logDir: path.join(tmp, 'logs'),
    plistPath: path.join(tmp, 'local.cron-ready.plist'),
    sessionDir: path.join(tmp, 'sessions-registry'),
    // 与生产 paths 同形的派生 getter。
    get sessionLogDir() {
      return path.join(this.logDir, 'sessions');
    },
    get configPath() {
      return path.join(this.appSupport, 'config.json');
    },
    get statePath() {
      return path.join(this.appSupport, 'state.json');
    },
    ...overrides,
  };
  // 派生目录建出来，测试直接写 statePath/configPath 不会 ENOENT。
  fs.mkdirSync(p.appSupport, { recursive: true });
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

export { paths };
