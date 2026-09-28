// launchd 服务面：launchctl 封装、服务状态查询、node 启动路径的通用解析、
// plist 渲染、install/uninstall，以及「Node 路径是否失效」的健康检查。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { deps, ExitError } from './internals.mjs';
import { paths, LABEL, OLD_LABEL } from './paths.mjs';
// paths.home 仅用于 resolveLauncher 的默认 HOME；其余产物路径一律走
// deps.paths（测试要整体重定向）。
import {
  DEFAULT_CONFIG,
} from './constants.mjs';
import {
  loadConfig,
  saveConfig,
  loadState,
  validateConfig,
  normalizeRoots,
  isInt,
} from './config.mjs';

export function guiTarget() {
  return `gui/${process.getuid()}`;
}

// launchctl 调用统一走不抛的 execFile，判成败看 status。
export function launchctl(...args) {
  return deps.execFile('/bin/launchctl', args);
}

export function launchctlInfo() {
  const r = launchctl('print', `${guiTarget()}/${LABEL}`);
  if (r.status !== 0) return null;
  const info = {};
  for (const key of ['state', 'last exit code']) {
    const m = r.stdout.match(
      new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(.+)$`, 'm'));
    if (m) info[key] = m[1].trim();
  }
  const iv = r.stdout.match(/^\s*run interval\s*=\s*(\d+)\s*seconds/m);
  if (iv) info.interval = parseInt(iv[1], 10);
  return info;
}

const LAUNCHD_STATES = new Map([
  ['running', '运行中'],
  ['not running', '空闲中（按间隔触发）'],
]);

export function launchdStateZh(state) {
  // launchd 的 "not running" 是间隔触发型服务两轮之间的正常空闲态，直译
  // 会让人以为服务停了；未识别的值原样保留以便排查。
  if (!state) return '未知';
  return LAUNCHD_STATES.get(state) ?? state;
}

export function serviceLine(info, plistExists) {
  if (info) {
    return `服务：launchd 已加载，${launchdStateZh(info.state)}，`
      + `上次退出码 ${info['last exit code'] ?? '?'}`;
  }
  if (plistExists) {
    return '服务：plist 文件存在但未加载，运行 cron-up install 重新加载';
  }
  return '服务：未安装，运行 cron-up install 安装';
}

// ---- node 启动路径解析 ----
//
// npm 全局 bin 的 shebang 是 #!/usr/bin/env node，而 launchd 的最小 PATH
// （/usr/bin:/bin:/usr/sbin:/sbin）里没有 node，所以 plist 必须写死
// 「node 绝对路径 + 入口脚本绝对路径」。不同 node 安装方式的稳定路径各
// 不相同，按固定布局逐个探测；都不认识时退回本次安装进程的 execPath。

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function semverCompare(a, b) {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

// nvm 的 default 别名是文本文件（'node'、'lts/*' 或 'v22.2.0'），不是
// 符号链接；解析不出具体版本时取已安装的最高版本目录（lts/* 的近似）。
function nvmNodePath(nvmDir) {
  const versionsDir = path.join(nvmDir, 'versions', 'node');
  const pick = (v) => {
    const p = path.join(versionsDir, v, 'bin', 'node');
    return isExecutable(p) ? p : null;
  };
  let pref = null;
  try {
    pref = fs.readFileSync(path.join(nvmDir, 'alias', 'default'), 'utf-8').trim();
  } catch {
    pref = null;
  }
  if (/^v/.test(pref ?? '')) {
    const p = pick(pref);
    if (p) return p;
  }
  if (pref === 'lts/*') {
    try {
      const v = fs.readFileSync(path.join(nvmDir, 'alias', 'lts', '*'), 'utf-8').trim();
      const p = pick(v);
      if (p) return p;
    } catch {
      // 落到最高版本兜底。
    }
  }
  let all = [];
  try {
    all = fs.readdirSync(versionsDir);
  } catch {
    return null;
  }
  const versions = all.filter((d) => /^v/.test(d)).sort(semverCompare);
  for (let i = versions.length - 1; i >= 0; i--) {
    const p = pick(versions[i]);
    if (p) return p;
  }
  return null;
}

// 返回 {nodePath, entryPath, manager}。注入 home/execPath/entryPath 仅为
// 测试在临时 HOME 里伪造各安装形态。
export function resolveLauncher(opts = {}) {
  const home = opts.home ?? paths.home;
  const execPath = opts.execPath ?? process.execPath;
  const entryPath = opts.entryPath
    ?? fileURLToPath(new URL('../bin/cron-up.mjs', import.meta.url));

  // 1. fnm：aliases/default 是跟随 `fnm default` 切换的稳定 symlink，切勿
  //    realpath 到版本化目录（fnm 升级后那里会失效）。包含 FNM_DIR 与新
  //    旧两个默认位置。
  const fnmDirs = [
    process.env.FNM_DIR,
    path.join(home, '.local', 'share', 'fnm'),
    path.join(home, '.fnm'),
  ].filter(Boolean);
  for (const d of fnmDirs) {
    const nodePath = path.join(d, 'aliases', 'default', 'bin', 'node');
    if (isExecutable(nodePath)) return { nodePath, entryPath, manager: 'fnm' };
  }

  // 2. volta：~/.volta/bin/node 是稳定的版本无关 shim。
  const voltaNode = path.join(home, '.volta', 'bin', 'node');
  if (isExecutable(voltaNode)) {
    return { nodePath: voltaNode, entryPath, manager: 'volta' };
  }

  // 3. nvm。
  const nvmPath = nvmNodePath(path.join(home, '.nvm'));
  if (nvmPath) return { nodePath: nvmPath, entryPath, manager: 'nvm' };

  // 4. Homebrew（Apple silicon 与 Intel）与官网 pkg 共用的系统路径。这些
  //    本身就是版本无关的稳定 symlink。systemPaths 仅供测试注入。
  const systemPaths = opts.systemPaths
    ?? ['/opt/homebrew/bin/node', '/usr/local/bin/node'];
  for (const cand of systemPaths) {
    if (isExecutable(cand)) {
      return {
        nodePath: cand,
        entryPath,
        manager: cand.includes('homebrew') || isBrewCellar(cand) ? 'brew' : 'pkg',
      };
    }
  }

  // 5. 兜底：当前安装进程的 node 至少现在能跑；可能是 fnm 多 shell 的易变
  //    路径，标记 note 提示日后核对。
  return {
    nodePath: execPath,
    entryPath,
    manager: 'exec-path',
    note: '未能定位版本无关的 node 路径，已使用当前 node 的绝对路径；'
      + '切换 Node 版本后请重新运行 cron-up install',
  };
}

function isBrewCellar(p) {
  try {
    return fs.realpathSync(p).includes(`${path.sep}Cellar${path.sep}`);
  } catch {
    return false;
  }
}

// ---- plist ----

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function xmlUnescape(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// key 按字母序排列。ProgramArguments 是
// [node 绝对路径, 入口脚本绝对路径, 'run']——launchd 的最小 PATH 里没有
// node，不能写 npm shim。
export function renderPlist(intervalSeconds, launcher) {
  const args = [launcher.nodePath, launcher.entryPath, 'run']
    .map((a) => `\t\t<string>${xmlEscape(a)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(path.join(deps.paths.logDir, 'launchd.err.log'))}</string>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(path.join(deps.paths.logDir, 'launchd.out.log'))}</string>
\t<key>StartInterval</key>
\t<integer>${intervalSeconds}</integer>
</dict>
</plist>
`;
}

// 从已安装 plist 的 ProgramArguments 里抠出三个参数（plist 是我们自己写
// 的，正则足够，不引 plist 解析器）。
export function readPlistProgramArgs() {
  let text;
  try {
    text = fs.readFileSync(deps.paths.plistPath, 'utf-8');
  } catch {
    return null;
  }
  const block = text.match(
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!block) return null;
  const parts = [...block[1].matchAll(/<string>([\s\S]*?)<\/string>/g)]
    .map((m) => xmlUnescape(m[1]));
  return parts.length === 3 ? parts : null;
}

// 总览页健康检查：plist 里写死的 node/入口路径若已不存在（fnm default 被
// 删、nvm 版本目录被清），launchd 每轮都会静默拉不起来。
export function launcherHealth() {
  if (!fs.existsSync(deps.paths.plistPath)) return null;
  const args = readPlistProgramArgs();
  if (!args) return null;
  const [nodePath, entryPath] = args;
  const missing = [nodePath, entryPath].filter((p) => !fs.existsSync(p));
  if (missing.length === 0) return null;
  return 'launchd 配置中的 Node 或入口路径已失效（'
    + `${missing.map((p) => path.basename(p)).join('、')} 不存在），巡检当前拉不`
    + '起来；请重新运行 cron-up install';
}

// ---- install / uninstall ----

export async function cmdInstall(args) {
  fs.mkdirSync(deps.paths.appSupport, { recursive: true });
  fs.mkdirSync(deps.paths.sessionLogDir, { recursive: true });
  try {
    fs.chmodSync(deps.paths.sessionLogDir, 0o700);
  } catch {
    // 维持现状。
  }

  let cfg;
  if (fs.existsSync(deps.paths.configPath) && !args.force) {
    try {
      cfg = loadConfig(deps.paths.configPath);
    } catch (e) {
      // 损坏配置最自然的修复动作就是重跑 install——当面给出 --force 出口，
      // 而不是只丢下一行解析错误。
      if (e instanceof ExitError) {
        throw new ExitError(e.code,
          `${e.message}\n  丢弃损坏配置重新安装：cron-up install --force`);
      }
      throw e;
    }
    deps.print(`保留现有配置：${deps.paths.configPath}（需要更新时加 --force）`);
  } else {
    // 即使 --force 也从现有配置（全新安装则默认值）起步，只覆盖命令行给
    // 的字段——否则 --force --interval 600 会悄悄把 roots 重置成默认。
    cfg = { ...DEFAULT_CONFIG };
    if (fs.existsSync(deps.paths.configPath)) {
      let old = null;
      try {
        old = JSON.parse(fs.readFileSync(deps.paths.configPath, 'utf-8'));
      } catch {
        old = null;
      }
      // 手改成非对象（123、["a"]）：没有可继承的旧值，静默按默认走。
      if (old && typeof old === 'object' && !Array.isArray(old)) {
        cfg = { ...cfg, ...old };
      }
    }
    const overrides = {};
    if (args.roots !== undefined) {
      const roots = normalizeRoots(args.roots.split(','));
      if (roots.length === 0) {
        deps.printErr(`--roots 解析后没有有效目录：${JSON.stringify(args.roots)}`);
        throw new ExitError(1);
      }
      overrides.roots = roots;
    }
    // is not undefined，而非 truthiness：--lead 0（「不要提前量」）是合法
    // 选择，不能被悄悄丢掉；--interval 0 也要留到下面的校验被响亮拒绝。
    if (args.interval !== undefined) overrides.intervalSeconds = args.interval;
    if (args.lead !== undefined) overrides.leadSeconds = args.lead;
    if (args.autoRenew !== undefined) overrides.autoRenew = args.autoRenew;
    cfg = { ...cfg, ...overrides };
    cfg.roots = normalizeRoots(cfg.roots ?? []);
    saveConfig(cfg);
    const updated = Object.keys(overrides).join('、') || '全部默认值';
    deps.print(`已写入配置：${deps.paths.configPath}（更新字段：${updated}）`);
  }

  // 动系统前先校验生效配置：非法值中止；软问题（提前量过小、目录缺失）
  // 只警告。
  if (!isInt(cfg.intervalSeconds) || cfg.intervalSeconds <= 0) {
    deps.printErr(`intervalSeconds 必须是正整数秒，当前为 ${JSON.stringify(cfg.intervalSeconds)}`);
    throw new ExitError(1);
  }
  if (!isInt(cfg.leadSeconds) || cfg.leadSeconds < 0) {
    deps.printErr(`leadSeconds 必须是非负整数秒，当前为 ${JSON.stringify(cfg.leadSeconds)}`);
    throw new ExitError(1);
  }
  validateConfig(cfg, (m) => deps.print(m));
  if (JSON.stringify(cfg.roots)
      === JSON.stringify(normalizeRoots(DEFAULT_CONFIG.roots))) {
    // 与 README 安全说明同一句话，在配置落定的这一刻当面再说一遍。
    deps.print('提示：未指定 --roots，扫描范围是整个用户目录，今后 clone 的'
      + '仓库也会进入巡检；自动续期会把其中的周期任务永久化。建议用 '
      + '--roots 显式限定范围（见 README 安全说明）');
  }

  // npm 包没有「安装二进制」这一步：node 与入口文件已由 npm 就位，这里只
  // 解析它们的稳定绝对路径写给 launchd。
  const launcher = resolveLauncher();
  if (launcher.note) deps.print(`提示：${launcher.note}`);

  fs.writeFileSync(deps.paths.plistPath,
    renderPlist(cfg.intervalSeconds, launcher));
  deps.print(`已写入 LaunchAgent：${deps.paths.plistPath}`);

  // doorman 旧 label 若还在，先踢掉，避免两个巡检并行互相换代/回收。
  deps.launchctl('bootout', `${guiTarget()}/${OLD_LABEL}`);
  deps.launchctl('bootout', `${guiTarget()}/${LABEL}`);
  const r = deps.launchctl('bootstrap', guiTarget(), deps.paths.plistPath);
  if (r.status !== 0) {
    deps.printErr(`加载到 launchd 失败：\n${r.stderr.trim()}`);
    throw new ExitError(1);
  }
  deps.launchctl('enable', `${guiTarget()}/${LABEL}`);
  deps.print('已加载到 launchd');

  // install 与巡检撞车时首轮会被跳过，不能照常说「完成」。
  if (await deps.runPatrol({ config: undefined })) {
    deps.print('首轮巡检完成，查看状态：cron-up');
  } else {
    deps.print('首轮巡检暂未执行（已有一轮在进行），launchd 会在下个间隔自动'
      + '补跑；查看状态：cron-up');
  }
}

export async function cmdUninstall(args) {
  const r = deps.launchctl('bootout', `${guiTarget()}/${LABEL}`);
  if (r.status === 0) deps.print('已从 launchd 卸载');

  // 服务没了就没有回收者：默认结束自己拉起的保活会话，不留以 bypass 权限
  // 空转的孤儿。--keep-sessions 显式保留（例如马上重装）。
  if (!args.keepSessions) {
    for (const [ws, ent] of Object.entries(loadState())) {
      if (deps.trackedAlive(ent)) {
        deps.print(`正在结束保活会话 ${ws} pid=${ent.pid}`);
        await deps.stopSession(ent);
      }
    }
  }

  if (fs.existsSync(deps.paths.plistPath)) {
    fs.rmSync(deps.paths.plistPath, { force: true });
    deps.print(`已删除 ${deps.paths.plistPath}`);
  }

  if (args.purge) {
    for (const p of [deps.paths.appSupport, deps.paths.logDir]) {
      fs.rmSync(p, { recursive: true, force: true });
      deps.print(`已删除 ${p}`);
    }
    // npm 管的文件不能手删：命令行本身交给 npm 卸载。
    deps.print('命令行本身请运行 npm uninstall -g cron-up 卸载');
  } else {
    deps.print('配置与日志已保留（--purge 删除全部产物，--keep-sessions 保留'
      + '保活会话）');
  }
}

Object.assign(deps, { launchctl, launchctlInfo });
