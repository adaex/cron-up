// launchd 服务面：launchctl 封装、服务状态查询、node bin 目录解析、plist
// 渲染、install/uninstall，以及启动链的健康检查。

import fs from 'node:fs';
import path from 'node:path';

import { deps, ExitError } from './internals.mjs';
import { paths, LABEL } from './paths.mjs';
// paths.home 仅用于 resolveLauncher 的默认 HOME；其余产物路径一律走
// deps.paths（测试要整体重定向）。
import { scriptProcLogPath } from './sessions.mjs';
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
// （/usr/bin:/bin:/usr/sbin:/sbin）里没有 node。安装时把「node 与 cron-up
// 所在的 bin 目录」写进启动脚本的 PATH，之后每轮由脚本自己解析：npm 升
// 级、切换默认版本都自动跟随，且 node 与包永远同版本。

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
// 回当前安装进程自己的 bin 目录：nvm 等按版本目录安装的形态由此覆盖（node
// 与 cron-up 同目录，npm 升级自动跟随），代价是绑定装包时的版本目录——切
// 换默认版本后要重跑 install 才切过去。
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
// macOS 的后台项目列表（系统设置 → 登录项与扩展 → 允许在后台）按
// ProgramArguments[0] 的文件名归组条目：直连 node 会与所有 node 系后台服务
// 合并显示在「Node.js Foundation」（node 的签名者）名下；指向自有脚本则
// 显示 cron-up-service。脚本把 node 所在 bin 目录放进 PATH 后直接
// exec cron-up run：npm 升级自动跟随，无需重跑 install（node 与 cron-up
// 同目录，天然同版本）。
export function writeServiceScript(launcher) {
  const script = deps.paths.serviceScriptPath;
  fs.mkdirSync(path.dirname(script), { recursive: true });
  const dirs = launcher.pathDirs.map((d) => `"${d}"`).join(':');
  fs.writeFileSync(script,
    '#!/bin/bash\n'
    + '# 由 cron-up install 生成；重跑 cron-up install --force 覆盖重生成\n'
    + `export PATH=${dirs}:"$PATH"\n`
    + 'exec cron-up run\n');
  fs.chmodSync(script, 0o755);
  return script;
}

// ProgramArguments 单参数（启动脚本路径）。
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
// PATH 目录里解析不到 cron-up/node（典型断点：切换默认 Node 版本后忘了
// 在新版本里装包、版本目录被删）时都会静默拉不起来，这是总览唯一能发现
// 它的地方。
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

export async function cmdInstall(args) {
  fs.mkdirSync(deps.paths.dataDir, { recursive: true });
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
    // 不带 --force 时配置原样保留，命令行显式给的参数一律不生效：点名说清
    // 被忽略的是哪些，而不是让用户以为已经改了。
    const ignored = [];
    if (args.roots !== undefined) ignored.push('--roots');
    if (args.interval !== undefined) ignored.push('--interval');
    if (args.lead !== undefined) ignored.push('--lead');
    if (args.autoRenew !== undefined) ignored.push('--auto-renew / --no-auto-renew');
    if (ignored.length > 0) {
      deps.print(`警告：参数 ${ignored.join('、')} 未生效（现有配置保留）；`
        + '要更新这些字段请带 --force 重跑，--force 只覆盖显式给出的字段');
    }
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
    deps.print('提示：未指定 --roots，默认扫描 ~/space、~/workspace、~/tasks'
      + '（不存在的目录跳过）；今后 clone 进这些容器的仓库也会进入巡检，'
      + '自动续期会把其中的周期任务永久化。目录布局不同或需收窄时用 '
      + '--roots 指定（见 README 安全说明）');
  }

  // npm 包没有「安装二进制」这一步：node 与入口文件已由 npm 就位，这里只
  // 解析它们所在的 bin 目录，写进启动脚本（plist 只指向脚本，让后台项目
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
    // state 丢失时的兜底：没进登记的孤儿会话（卡在提问界面就不会出现在
    // state 里）从进程表按日志目录精确认领。
    for (const [pid, procArgs] of deps.listScriptProcesses()) {
      const log = scriptProcLogPath(procArgs);
      if (log === null
          || !log.startsWith(`${deps.paths.sessionLogDir}${path.sep}`)) continue;
      const ent = { pid, procStart: deps.procStartedAt(pid) };
      if (!deps.trackedAlive(ent)) continue;
      deps.print(`正在结束保活会话（state 已丢失） pid=${pid}`);
      await deps.stopSession(ent);
    }
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
    deps.print('配置与日志已保留（--purge 删除全部产物，--keep-sessions 保留'
      + '保活会话）');
  }
}

Object.assign(deps, { launchctl, launchctlInfo });
