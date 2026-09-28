// launchd 服务面：launchctl 封装、服务状态查询、node 启动路径的通用解析、
// plist 渲染、install/uninstall，以及「Node 路径是否失效」的健康检查。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { deps, ExitError } from './internals.mjs';
import { paths, LABEL } from './paths.mjs';
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
  configFieldErrors,
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
// 生成 launchd 拉起的启动脚本：ProgramArguments[0] 指向它而非 node。
// macOS 的后台项目列表（系统设置 → 登录项与扩展 → 允许在后台）按
// ProgramArguments[0] 的文件名归组条目：直连 node 会与所有 node 系后台服务
// 合并显示在「Node.js Foundation」（node 的签名者）名下；指向自有脚本则
// 显示 cron-up-service。路径变化（换 Node 安装方式、升级）后重跑
// cron-up install 覆盖重生成。
export function writeServiceScript(launcher) {
  const script = deps.paths.serviceScriptPath;
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script,
    '#!/bin/bash\n'
    + '# 由 cron-up install 生成；重跑 cron-up install --force 覆盖重生成\n'
    + `exec "${launcher.nodePath}" "${launcher.entryPath}" run\n`);
  fs.chmodSync(script, 0o755);
  return script;
}

// ProgramArguments 单参数（启动脚本路径）——node 与入口路径在脚本里。
export function renderPlist(intervalSeconds, scriptPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${xmlEscape(scriptPath)}</string>
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

// 从已安装 plist 的 ProgramArguments 里抠出参数（plist 是我们自己写的，
// 正则足够，不引 plist 解析器）。两种形态：单参数（当前，启动脚本路径）
// 与三参数 [node, 入口, 'run']（旧版 plist，升级后重跑 install 前的过渡
// 形态）。
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
  return parts.length > 0 ? parts : null;
}

// 从启动脚本内容里解出 [node 路径, 入口路径]；脚本是我们生成的固定格
// 式，解不出（手改坏）返回 null。
function readServiceScriptPaths(scriptPath) {
  let text;
  try {
    text = fs.readFileSync(scriptPath, 'utf-8');
  } catch {
    return null;
  }
  const m = text.match(/^exec "(.+)" "(.+)" run$/m);
  return m ? [m[1], m[2]] : null;
}

// fnm 与 nvm 的全局包装在版本化目录里（…/node-versions/v<X>/… 与
// …/versions/node/v<X>/…）。default 别名切换后 node 路径依然有效，但入口
// 路径仍指向装包时的旧版本目录——巡检会静默继续跑旧版 cron-up，直到旧版
// 本被卸载才表现为「路径失效」。这里提前一步提示。版本段固定以 v 开头
// （fnm/nvm 的目录命名），避免路径里恰好出现 node-versions 字样的普通目
// 录误报；volta/brew/pkg 的包路径不含版本化目录，返回 null 跳过检查
// （npm link 的工作副本同理）。
function nodeVersionRoot(p) {
  const m = p.match(/(?:node-versions|versions\/node)\/v[^/]+/);
  return m ? m[0] : null;
}

// node/入口路径的存在性与版本分叉检查，新（启动脚本内）旧（plist 三参
// 数）两种形态共用。
function pathHealthAlert(nodePath, entryPath) {
  const missing = [nodePath, entryPath].filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    return 'launchd 配置中的 Node 或入口路径已失效（'
      + `${missing.map((p) => path.basename(p)).join('、')} 不存在），巡检当前拉不`
      + '起来；请重新运行 cron-up install';
  }
  let nodeReal = nodePath;
  try {
    nodeReal = fs.realpathSync(nodePath);
  } catch {
    // 存在性已确认，保留原路径。
  }
  const nodeRoot = nodeVersionRoot(nodeReal);
  const entryRoot = nodeVersionRoot(entryPath);
  if (nodeRoot !== null && entryRoot !== null && nodeRoot !== entryRoot) {
    return 'launchd 配置里的入口路径属于另一个 node 版本目录'
      + `（${entryRoot}），而当前 node 是 ${nodeReal}；巡检可能在运行旧版`
      + ' cron-up，重跑 cron-up install 更新路径';
  }
  return null;
}

// 总览页健康检查：plist 指定的启动链若已断（脚本或其中的 node/入口路径
// 不存在，如 fnm default 被删、nvm 版本目录被清），launchd 每轮都会静默
// 拉不起来；路径都在但分属不同 node 版本目录时，巡检跑的多半是旧版包。
export function launcherHealth() {
  if (!fs.existsSync(deps.paths.plistPath)) return null;
  const args = readPlistProgramArgs();
  if (!args) return null;
  if (args.length === 1) {
    const [scriptPath] = args;
    if (!fs.existsSync(scriptPath)) {
      return `launchd 配置中的启动脚本已失效（${path.basename(scriptPath)} `
        + '不存在），巡检当前拉不起来；请重新运行 cron-up install';
    }
    const paths = readServiceScriptPaths(scriptPath);
    if (paths === null) {
      return `启动脚本 ${scriptPath} 内容无法解读（可能被手改），`
        + '重跑 cron-up install 覆盖重生成';
    }
    return pathHealthAlert(...paths);
  }
  if (args.length === 3) {
    // 旧版 plist（ProgramArguments 直写 node 与入口）：升级后重跑
    // install 前的过渡形态，照常检查。
    return pathHealthAlert(args[0], args[1]);
  }
  return null;
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
    let inherited = false;
    if (fs.existsSync(deps.paths.configPath)) {
      let old = null;
      try {
        old = JSON.parse(fs.readFileSync(deps.paths.configPath, 'utf-8'));
      } catch {
        old = null;
      }
      // 手改成非对象（123、["a"]）：没有可继承的旧值，静默按默认走。
      if (old && typeof old === 'object' && !Array.isArray(old)) {
        // 类型坏的字段不继承（回到默认值）并当面说明，其余照旧——force 不
        // 该把类型错误写进新配置，也不该因一个字段坏了丢掉其余设置。
        const errs = configFieldErrors({ ...DEFAULT_CONFIG, ...old });
        for (const [key, msg] of errs) {
          delete old[key];
          deps.print(`提示：旧配置的 ${msg}，未继承，采用默认值`);
        }
        cfg = { ...cfg, ...old };
        inherited = true;
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
    const updated = Object.keys(overrides).join('、') || '无';
    const rest = inherited ? '其余继承现有配置' : '全部默认值';
    deps.print(`已写入配置：${deps.paths.configPath}（更新字段：${updated}，${rest}）`);
  }

  // 动系统前先校验生效配置：文件继承的值由 loadConfig / configFieldErrors
  // 保证类型，但命令行给的 --interval/--lead 只经过整数解析，取值范围要在
  // 这里拦（--interval 0 非法、--lead 0 是合法选择）；软问题（提前量过
  // 小、目录缺失）只警告。
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
  // 解析它们的稳定绝对路径，写进启动脚本（plist 只指向脚本，让后台项目
  // 列表显示 cron-up-service 而非 node 的签名者）。
  const launcher = resolveLauncher();
  if (launcher.note) deps.print(`提示：${launcher.note}`);

  const script = writeServiceScript(launcher);
  fs.writeFileSync(deps.paths.plistPath,
    renderPlist(cfg.intervalSeconds, script));
  deps.print(`已写入启动脚本与 LaunchAgent：${script}、${deps.paths.plistPath}`);

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
