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
import { scriptProcLogPath, shellQuote } from './sessions.mjs';

function guiTarget() {
  return `gui/${process.getuid()}`;
}

// launchctl 调用统一走不抛的 execFile，判成败看 status。与 ps 同款防御：
// launchctl 卡住时命令挂死不如超时报「未加载」——总览页至少还能出来；卸载
// 等破坏性操作另用下方三态 probe，状态未知时拒绝继续。
export function launchctl(...args) {
  return deps.execFile('/bin/launchctl', args, { timeout: 10000 });
}

function parseLaunchctlInfo(stdout = '') {
  const info = {};
  for (const key of ['state', 'last exit code']) {
    const m = stdout.match(
      new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(.+)$`, 'm'));
    if (m) info[key] = m[1].trim();
  }
  const iv = stdout.match(/^\s*run interval\s*=\s*(\d+)\s*seconds/m);
  if (iv) info.interval = parseInt(iv[1], 10);
  return info;
}

// 卸载需要比 info/null 更细的结论：launchctl 对未加载与查询失败都返回非零，
// 只有明确的「找不到服务」才能安全继续删除安装产物。
function launchctlProbe() {
  const r = deps.launchctl('print', `${guiTarget()}/${LABEL}`);
  if (r.status === 0) {
    return { kind: 'loaded', info: parseLaunchctlInfo(r.stdout ?? '') };
  }
  const stderr = (r.stderr ?? '').trim();
  if (/could not find service/i.test(stderr)) return { kind: 'unloaded' };
  return {
    kind: 'unknown',
    message: stderr || `launchctl print 退出码 ${r.status ?? '未知'}`,
  };
}

export function launchctlInfo() {
  // 总览页继续只看 info/null；详细三分状态仅供卸载等破坏性操作使用。
  const probe = launchctlProbe();
  return probe.kind === 'loaded' ? probe.info : null;
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
// cronUpPath/systemPaths 仅为测试在临时 HOME 里伪造各安装形态。fnm 的
// aliases/default/bin 是跟随 `fnm default` 切换的稳定 symlink（切勿
// realpath 到版本化目录，fnm 升级后那里会失效）；volta 的 ~/.volta/bin、
// Homebrew 与官网 pkg 的系统 bin 同理是版本无关的稳定入口。都不认识时退
// 回当前安装进程自己的 node bin 目录：nvm 等按版本目录安装的形态由此覆盖。
// node 目录与当前实际 cron-up 的 bin 目录都必须保留：fnm 非默认版本、nvm
// 或独立 npm prefix 下两者经常不同，找到稳定 node 后提前返回会丢掉 cron-up。
export function resolveLauncher(opts = {}) {
  const home = opts.home ?? paths.home;
  const execPath = opts.execPath ?? process.execPath;
  const cronUpPath = opts.cronUpPath ?? process.argv[1];
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
  const stableNodeDir = candidates.find((dir) => isExecutable(path.join(dir, 'node')));
  const nodeDir = stableNodeDir ?? path.dirname(execPath);
  // argv[1] 保留 npm 全局 bin symlink 的调用路径；不要 realpath 到包内
  // bin/cron-up.mjs，否则独立 npm prefix 的 shim 目录会丢。无 argv[1] 时
  // 退回 node 目录，至少覆盖 node 与全局 bin 同目录的常见安装。
  const cronUpDir = cronUpPath
    ? path.dirname(path.resolve(cronUpPath)) : path.dirname(execPath);
  const result = { pathDirs: [...new Set([nodeDir, cronUpDir])] };
  if (stableNodeDir === undefined) {
    result.note = '未能定位版本无关的 node bin 目录，已使用当前 node 所在目录；'
      + '该目录失效（如版本目录被删）时请重新运行 cron-up install';
  }
  return result;
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
  // 整个冒号前缀作为一个 shell word 引用：健康检查可无损解回同一串目录，
  // 空格、单双引号、$ 等字符不会变成 shell 语法。
  const dirs = shellQuote(launcher.pathDirs.join(':'));
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

// 解一个 POSIX shell word（不执行它）。覆盖 shellQuote 生成的单引号与
// '"'"' 拼接，也兼容旧版脚本简单的双引号目录；含未引用空白、命令替换或
// 变量展开的手改内容拒绝猜测。
function parseShellWord(source) {
  let value = '';
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    if (ch === "'") {
      const end = source.indexOf("'", i + 1);
      if (end < 0) return null;
      value += source.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (source[i] === '$' || source[i] === '`') return null;
        if (source[i] === '\\') {
          if (i + 1 >= source.length) return null;
          i += 1;
        }
        value += source[i];
        i += 1;
      }
      if (!closed) return null;
      continue;
    }
    if (/\s/.test(ch) || /[$`;&|<>()]/.test(ch)) return null;
    if (ch === '\\') {
      if (i + 1 >= source.length) return null;
      i += 1;
    }
    value += source[i];
    i += 1;
  }
  return value;
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
  if (!m) return null;
  const prefix = parseShellWord(m[1]);
  if (!prefix) return null;
  const dirs = prefix.split(':');
  return dirs.every(Boolean) ? dirs : null;
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
    // 与 README「安全与自动修改」同一口径，在配置落定时再提示一次。
    deps.print(`提示：未指定 --roots，默认扫描 ${DEFAULT_CONFIG.roots.join('、')}`
      + '（不存在的目录跳过）；今后 clone 进这些容器的仓库也会进入巡检，'
      + '其中的周期任务会被自动续期永久化，任务、CLAUDE.md 与项目配置都会'
      + '影响无人值守会话。目录布局不同或需收窄时用 --roots 指定'
      + '（见 README「安全与自动修改」）');
  }

  const launcher = deps.resolveLauncher();
  if (launcher.note) deps.print(`提示：${launcher.note}`);

  const script = writeServiceScript(launcher);
  fs.mkdirSync(path.dirname(deps.paths.plistPath), { recursive: true });
  fs.writeFileSync(deps.paths.plistPath, renderPlist(script));
  deps.print(`已写入启动脚本与 LaunchAgent：${script}、${deps.paths.plistPath}`);

  // bootstrap 成功只代表 launchd 收下 plist，不代表脚本真能解析 node 与
  // cron-up。先自检启动链，避免随后的手动首轮巡检掩盖坏脚本。
  const health = launcherHealth();
  if (health) {
    deps.printErr(`启动链自检失败：${health}`);
    throw new ExitError(1);
  }

  deps.launchctl('bootout', `${guiTarget()}/${LABEL}`);
  const r = deps.launchctl('bootstrap', guiTarget(), deps.paths.plistPath);
  if (r.status !== 0) {
    deps.printErr(`加载到 launchd 失败：\n${r.stderr.trim()}`);
    throw new ExitError(1);
  }
  const enabled = deps.launchctl('enable', `${guiTarget()}/${LABEL}`);
  if (enabled.status !== 0) {
    deps.printErr(`启用 launchd 服务失败：\n${enabled.stderr.trim()}`);
    throw new ExitError(1);
  }
  if (deps.launchctlInfo() === null) {
    deps.printErr('加载后未能向 launchd 核实服务状态，请检查 cron-up 与 launchctl');
    throw new ExitError(1);
  }
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
  const lock = deps.acquireRunLock();
  if (lock === null) {
    deps.printErr('已有一轮巡检在进行，为避免误删正在使用的产物，本次不卸载；'
      + '请稍后重试');
    throw new ExitError(1);
  }
  try {
    const target = `${guiTarget()}/${LABEL}`;
    const before = deps.launchctlProbe();
    if (before.kind === 'unknown') {
      deps.printErr(`无法确认 launchd 服务状态：${before.message}\n`
        + '状态未知时不能安全卸载，本次不删除 LaunchAgent、配置或日志');
      throw new ExitError(1);
    }
    if (before.kind === 'unloaded') {
      deps.print('launchd 服务未加载，无需重复卸载');
    } else {
      const r = deps.launchctl('bootout', target);
      if (r.status !== 0) {
        deps.printErr(`从 launchd 卸载失败：\n${r.stderr.trim()}\n`
          + '为避免留下无人回收的预热会话，本次不删除 LaunchAgent、配置或日志');
        throw new ExitError(1);
      }
      const after = deps.launchctlProbe();
      if (after.kind === 'unknown') {
        deps.printErr(`bootout 后无法确认 launchd 服务状态：${after.message}\n`
          + '本次不继续删除 LaunchAgent、配置或日志');
        throw new ExitError(1);
      }
      if (after.kind === 'loaded') {
        deps.printErr('launchctl bootout 已返回，但服务仍能查到；本次不继续清理');
        throw new ExitError(1);
      }
      deps.print('已从 launchd 卸载');
    }

    // 服务没了就没有回收者：默认结束全部预热会话，不留以 bypass 权限空转
    // 的孤儿。各会话的停轮询（SIGTERM→等→SIGKILL）互不依赖，先逐个发信
    // 号再并行等齐。
    const stopping = [];
    for (const { label, ent } of allTrackedWarmups()) {
      deps.print(`正在结束预热会话 ${label}`);
      stopping.push(deps.stopSession(ent).then(
        (stopped) => stopped ? null : label,
      ));
    }
    const unsafe = (await Promise.all(stopping))
      .filter((label) => label !== null);
    if (unsafe.length > 0) {
      deps.printErr('警告：以下预热会话仍活着，本次无法安全停止：'
        + `${unsafe.join('、')}。已中止后续清理，`
        + '不会继续删除 LaunchAgent、配置或日志；请人工核对后重试');
      throw new ExitError(1);
    }

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
      deps.print('配置与日志已保留（--purge 可删除 cron-up 自有配置与日志）');
    }
  } finally {
    deps.releaseRunLock(lock);
  }
}

Object.assign(deps, { launchctl, launchctlInfo, launchctlProbe, resolveLauncher });
