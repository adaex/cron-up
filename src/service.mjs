// launchd 服务面：launchctl 封装、服务状态查询、node bin 目录解析、plist
// 渲染、install/uninstall，以及启动链的健康检查。

import fs from 'node:fs';
import path from 'node:path';

import {
  deps,
  ExitError,
  ensurePrivateDir,
} from './internals.mjs';
import { paths, LABEL } from './paths.mjs';
import {
  DEFAULT_CONFIG,
  INTERVAL_SECONDS,
} from './constants.mjs';
import {
  loadConfig,
  saveConfig,
  loadState,
  loadLegacyEntries,
  validateConfig,
  normalizeRoots,
} from './config.mjs';
import { scriptProcLogPath } from './sessions.mjs';

function guiTarget() {
  return `gui/${process.getuid()}`;
}

// launchctl 调用统一走不抛的 execFile，判成败看 status。与 ps 同款防御：
// launchctl 卡住时命令挂死不如超时报「未加载」——总览页至少还能出来。
export function launchctl(...args) {
  return deps.execFile('/bin/launchctl', args, { timeout: 10000 });
}

export function launchctlInfo() {
  // 走 deps 而非同文件裸名：与 bootout/bootstrap 的打桩面保持一致，测试可
  // 在 launchctl 一层整体模拟 launchd。
  const r = deps.launchctl('print', `${guiTarget()}/${LABEL}`);
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

function launchdStateZh(state) {
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
// （/usr/bin:/bin:/usr/sbin:/sbin）里没有 node。安装时把「node 与 cron-up
// 所在的 bin 目录」写进启动脚本的 PATH，之后每轮由脚本自己解析：npm 升
// 级、切换默认版本都自动跟随。

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// 返回 {pathDirs}：启动脚本要写进 PATH 的 bin 目录。注入 home/execPath/
// systemPaths 仅为测试在临时 HOME 里伪造各安装形态。fnm 的
// aliases/default/bin 是跟随 `fnm default` 切换的稳定 symlink（切勿
// realpath 到版本化目录，fnm 升级后那里会失效）；volta 的 ~/.volta/bin、
// Homebrew 与官网 pkg 的系统 bin 同理是版本无关的稳定入口。都不认识时退
// 回当前安装进程自己的 bin 目录：nvm 等按版本目录安装的形态由此覆盖。
export function resolveLauncher(opts = {}) {
  const home = opts.home ?? paths.home;
  const execPath = opts.execPath ?? process.execPath;
  const systemPaths = opts.systemPaths
    ?? ['/opt/homebrew/bin/node', '/usr/local/bin/node'];

  const fnmDirs = [
    process.env.FNM_DIR,
    path.join(home, '.local', 'share', 'fnm'),
    path.join(home, '.fnm'),
  ].filter(Boolean);
  const candidates = [
    ...fnmDirs.map((d) => path.join(d, 'aliases', 'default', 'bin')),
    path.join(home, '.volta', 'bin'),
    ...systemPaths.map((p) => path.dirname(p)),
  ];
  for (const dir of candidates) {
    if (isExecutable(path.join(dir, 'node'))) return { pathDirs: [dir] };
  }
  return {
    pathDirs: [path.dirname(execPath)],
    note: '未能定位版本无关的 node bin 目录，已使用当前 node 所在目录；'
      + '该目录失效（如版本目录被删）时请重新运行 cron-up install',
  };
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

// 生成 launchd 拉起的启动脚本：ProgramArguments[0] 指向它而非 node。
// macOS 的后台项目列表按 ProgramArguments[0] 的文件名归组条目：直连
// node 会归到「Node.js Foundation」（node 的签名者）名下；指向自有脚本
// 则显示 cron-up-service。脚本把 node 所在 bin 目录放进 PATH 后直接
// exec cron-up run：npm 升级自动跟随，无需重跑 install。
export function writeServiceScript(launcher) {
  const script = deps.paths.serviceScriptPath;
  fs.mkdirSync(path.dirname(script), { recursive: true });
  const dirs = launcher.pathDirs.map((d) => `"${d}"`).join(':');
  fs.writeFileSync(script,
    '#!/bin/bash\n'
    + '# 由 cron-up install 生成；重跑 cron-up install 覆盖重生成\n'
    + `export PATH=${dirs}:"$PATH"\n`
    + 'exec cron-up run\n');
  fs.chmodSync(script, 0o755);
  return script;
}

// ProgramArguments 单参数（启动脚本路径）。间隔固定为 INTERVAL_SECONDS。
export function renderPlist(scriptPath) {
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
\t<integer>${INTERVAL_SECONDS}</integer>
</dict>
</plist>
`;
}

// 从已安装 plist 的 ProgramArguments 里抠出参数（plist 是我们自己写的，
// 正则足够，不引 plist 解析器）。
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

// 从启动脚本内容里解出 PATH 目录；脚本是我们生成的固定格式，解不出（手改
// 坏）返回 null。
function scriptPathDirs(scriptPath) {
  let text;
  try {
    text = fs.readFileSync(scriptPath, 'utf-8');
  } catch {
    return null;
  }
  const m = text.match(/^export PATH=(.+):"\$PATH"$/m);
  return m ? m[1].split('":"').map((s) => s.replace(/"/g, '')) : null;
}

// 总览页健康检查：launchd 每轮按启动脚本拉起巡检，脚本丢失、被手改或
// PATH 目录里解析不到 cron-up/node 时都会静默拉不起来。
export function launcherHealth() {
  if (!fs.existsSync(deps.paths.plistPath)) return null;
  const args = readPlistProgramArgs();
  if (!args || args.length !== 1) return null;
  const [scriptPath] = args;
  if (!fs.existsSync(scriptPath)) {
    return `launchd 配置中的启动脚本已失效（${path.basename(scriptPath)} `
      + '不存在），巡检当前拉不起来；请重新运行 cron-up install';
  }
  const dirs = scriptPathDirs(scriptPath);
  if (dirs === null) {
    return `启动脚本 ${scriptPath} 内容无法解读（可能被手改），`
      + '重跑 cron-up install 覆盖重生成';
  }
  const has = (name) => dirs.some((d) => isExecutable(path.join(d, name)));
  if (!has('cron-up')) {
    return `启动脚本的 PATH 目录（${dirs.join('、')}）里找不到 cron-up：切换`
      + '默认 Node 版本后要在新版本里重新 npm i -g cron-up，或重跑 '
      + 'cron-up install';
  }
  if (!has('node')) {
    return `启动脚本的 PATH 目录（${dirs.join('、')}）里找不到 node，重跑 `
      + 'cron-up install 重新解析';
  }
  return null;
}

// ---- install / uninstall ----

// roots 三选一：命令行显式值 > 现有配置 > 默认。现有配置损坏不阻断安
// 装——install 本身就是最自然的修复动作，回退默认并当面说明。
function resolveRoots(args) {
  if (args.roots !== undefined) {
    const roots = normalizeRoots(args.roots.split(','));
    if (roots.length === 0) {
      deps.printErr(`--roots 解析后没有有效目录：${JSON.stringify(args.roots)}`);
      throw new ExitError(1);
    }
    return roots;
  }
  if (fs.existsSync(deps.paths.configPath)) {
    try {
      return loadConfig(deps.paths.configPath).roots;
    } catch (e) {
      deps.print(`提示：现有配置无法解读（${e.message}），本次按默认扫描目录`
        + '重写；如需其他范围用 cron-up install --roots 指定');
    }
  }
  return normalizeRoots(DEFAULT_CONFIG.roots);
}

export async function cmdInstall(args) {
  // install 写盘、launchd 每轮读取的都是固定路径配置，--config 只会造成
  // 误解。
  if (args.config !== undefined) {
    throw new ExitError(2, 'install 不支持 --config：配置与 LaunchAgent 固定'
      + `使用 ${deps.paths.configPath}`);
  }
  fs.mkdirSync(deps.paths.dataDir, { recursive: true });
  ensurePrivateDir(deps.paths.sessionLogDir);

  // 每次 install 都重写配置（纯化旧版本留下的已废弃键）、脚本与 plist：
  // 这也是升级 Node、改扫描范围后的统一修复入口。
  const cfg = { roots: resolveRoots(args) };
  saveConfig(cfg);
  deps.print(`已写入配置：${deps.paths.configPath}（扫描目录：${cfg.roots.join('、')}）`);

  // 软问题（目录不存在）只警告。
  validateConfig(cfg, (m) => deps.print(m));
  if (JSON.stringify(cfg.roots)
      === JSON.stringify(normalizeRoots(DEFAULT_CONFIG.roots))) {
    // 与 README 安全说明同一句话，在配置落定的这一刻当面再说一遍。
    deps.print(`提示：未指定 --roots，默认扫描 ${DEFAULT_CONFIG.roots.join('、')}`
      + '（不存在的目录跳过）；今后 clone 进这些容器的仓库也会进入巡检，'
      + '其中的周期任务会被自动续期永久化。目录布局不同或需收窄时用 '
      + '--roots 指定（见 README 安全说明）');
  }

  const launcher = resolveLauncher();
  if (launcher.note) deps.print(`提示：${launcher.note}`);

  const script = writeServiceScript(launcher);
  fs.writeFileSync(deps.paths.plistPath, renderPlist(script));
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

// 遍历全部 tracked 预热：新版嵌套 state、旧版扁平 state、state 丢失时的
// ps 孤儿（日志位于会话日志目录即可，不区分两代命名）。
function* allTrackedWarmups() {
  const handled = new Set();
  for (const bucket of Object.values(loadState())) {
    for (const [taskId, ent] of Object.entries(bucket)) {
      if (deps.trackedAlive(ent)) {
        handled.add(ent.pid);
        yield { label: `${ent.ws} 任务 ${taskId}`, ent, orphan: false };
      }
    }
  }
  for (const ent of loadLegacyEntries()) {
    if (ent.pid) handled.add(ent.pid);
    if (deps.trackedAlive(ent)) {
      yield { label: ent.ws, ent, orphan: false };
    }
  }
  // state 丢失的兜底：没进登记的孤儿从进程表按日志目录认。
  for (const [pid, procArgs] of deps.listScriptProcesses()) {
    if (handled.has(pid)) continue;
    const log = scriptProcLogPath(procArgs);
    if (log === null
        || !log.startsWith(`${deps.paths.sessionLogDir}${path.sep}`)) continue;
    const ent = { pid, procStart: deps.procStartedAt(pid) };
    if (deps.trackedAlive(ent)) {
      yield { label: `pid=${pid}（state 已丢失）`, ent, orphan: true };
    }
  }
}

export async function cmdUninstall(args) {
  // uninstall 动的是本机固定的安装产物，--config 只会让人以为卸载的是
  // 另一套安装。
  if (args.config !== undefined) {
    throw new ExitError(2, 'uninstall 不支持 --config：卸载操作的是本机固定'
      + `的安装产物（${deps.paths.plistPath} 等）`);
  }
  const r = deps.launchctl('bootout', `${guiTarget()}/${LABEL}`);
  if (r.status === 0) deps.print('已从 launchd 卸载');

  // 服务没了就没有回收者：默认结束全部预热会话，不留以 bypass 权限空转
  // 的孤儿。各会话的停轮询（SIGTERM→等→SIGKILL）互不依赖，先逐个发信
  // 号再并行等齐。
  const stopping = [];
  for (const { label, ent } of allTrackedWarmups()) {
    deps.print(`正在结束预热会话 ${label}`);
    stopping.push(deps.stopSession(ent));
  }
  await Promise.all(stopping);

  if (fs.existsSync(deps.paths.plistPath)) {
    fs.rmSync(deps.paths.plistPath, { force: true });
    deps.print(`已删除 ${deps.paths.plistPath}`);
  }

  if (args.purge) {
    for (const p of [deps.paths.dataDir, deps.paths.logDir]) {
      fs.rmSync(p, { recursive: true, force: true });
      deps.print(`已删除 ${p}`);
    }
    // npm 管的文件不能手删：命令行本身交给 npm 卸载。
    deps.print('命令行本身请运行 npm uninstall -g cron-up 卸载');
  } else {
    deps.print('配置与日志已保留（--purge 可删除全部产物）');
  }
}

Object.assign(deps, { launchctl, launchctlInfo });
