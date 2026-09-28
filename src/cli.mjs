// 命令行解析与分发。node:util parseArgs 不支持子命令、否定布尔（--no-x）
// 与自动帮助，这里手写一层：子命令前只允许隐藏的 --config（前后都可放），
// 定位子命令后按各命令的选项表解析。

import { deps, ExitError } from './internals.mjs';
import { cmdRun, cmdRenew } from './patrol.mjs';
import { cmdInstall, cmdUninstall } from './service.mjs';
import { cmdList } from './list.mjs';
import { cmdOverview } from './overview.mjs';
import { cmdLogs } from './logs.mjs';

// 选项类型：string 吃一个值；int 吃一个值且必须是严格十进制；bool 是无值
// 开关；tri 支持 --name / --no-name（install 的 auto-renew）。
const SPECS = {
  install: {
    options: {
      roots: 'string',
      interval: 'int',
      lead: 'int',
      force: 'bool',
      'auto-renew': 'tri',
    },
  },
  uninstall: {
    options: {
      purge: 'bool',
      'keep-sessions': 'bool',
    },
  },
  list: { options: {} },
  run: { options: {} },
  renew: { options: {} },
  logs: {
    options: { follow: 'bool', f: 'bool' },
    positionalMax: 1,
  },
};

// 严格十进制整数命令行值：Number("0x10")、parseInt("5x") 都会静默给出错
// 误结果，必须显式拒绝。
function cliInt(s) {
  if (!/^-?\d+$/.test(s)) {
    throw new ExitError(2, `需要整数却得到：${s}`);
  }
  return parseInt(s, 10);
}

function usageExit(message) {
  throw new ExitError(2, message);
}

// 解析单个选项 token，返回消耗后的新下标。
function consumeOption(tok, tokens, i, spec, opts) {
  let name;
  let inlineValue;
  let negate = false;
  if (tok.startsWith('--')) {
    const body = tok.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      name = body.slice(0, eq);
      inlineValue = body.slice(eq + 1);
    } else if (body.startsWith('no-') && spec.options[body.slice(3)] === 'tri') {
      name = body.slice(3);
      negate = true;
    } else {
      name = body;
    }
  } else {
    name = tok.slice(1); // -f
  }
  if (name === 'f' && spec.options.f === 'bool') name = 'follow';
  const kind = spec.options[name];
  if (!kind) usageExit(`未知选项：${tok}`);
  if (kind === 'bool') {
    opts[thisCamel(name)] = true;
    return i + 1;
  }
  if (kind === 'tri') {
    if (inlineValue !== undefined) {
      if (inlineValue !== 'true' && inlineValue !== 'false') {
        usageExit(`--${name} 只接受 true 或 false`);
      }
      opts[thisCamel(name)] = inlineValue === 'true';
    } else {
      opts[thisCamel(name)] = !negate;
    }
    return i + 1;
  }
  // string / int 吃一个值（内联或下一 token）。
  let value;
  if (inlineValue !== undefined) value = inlineValue;
  else {
    value = tokens[i + 1];
    if (value === undefined) usageExit(`选项 --${name} 缺少值`);
  }
  opts[thisCamel(name)] = kind === 'int' ? cliInt(value) : value;
  return inlineValue !== undefined ? i + 1 : i + 2;
}

// 选项名统一成代码里用的 camelCase（--keep-sessions → keepSessions）。
function thisCamel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function parseCli(argv) {
  let command = null;
  const opts = {};
  const positional = [];
  let config;
  let help = false;

  for (let i = 0; i < argv.length;) {
    const tok = argv[i];
    if (tok === '--config') {
      config = argv[i + 1];
      if (config === undefined) usageExit('--config 缺少路径值');
      i += 2;
      continue;
    }
    if (tok.startsWith('--config=')) {
      config = tok.slice('--config='.length);
      i += 1;
      continue;
    }
    if (tok === '--help' || tok === '-h') {
      help = true;
      i += 1;
      continue;
    }
    if (!tok.startsWith('-') && command === null) {
      if (!(tok in SPECS)) usageExit(`未知子命令：${tok}`);
      command = tok;
      i += 1;
      continue;
    }
    if (command === null) usageExit(`无法识别的参数：${tok}（无子命令时只接受 --config 与 --help）`);
    if (!tok.startsWith('-')) {
      positional.push(tok);
      i += 1;
      continue;
    }
    i = consumeOption(tok, argv, i, SPECS[command], opts);
  }

  const spec = command ? SPECS[command] : null;
  if (spec && positional.length > (spec.positionalMax ?? 0)) {
    usageExit(`${command} 最多接受 ${spec.positionalMax ?? 0} 个位置参数`);
  }

  const result = { command, opts, positional, help };
  if (config !== undefined) result.config = config;
  return result;
}

export const USAGE = `cron-ready —— 为定时任务提前备好交互会话

用法：
  cron-ready                    查看总览（服务、配置、任务、会话）
  cron-ready install            安装配置与 LaunchAgent（--roots --interval --lead --force --no-auto-renew）
  cron-ready uninstall          卸载（--purge 连配置日志一起删，--keep-sessions 保留后台会话）
  cron-ready list               逐个列出定时任务及下次执行时间
  cron-ready run                执行一轮巡检（launchd 入口）
  cron-ready renew              立即给所有周期任务补 permanent
  cron-ready logs [目录片段]    查看巡检日志或后台会话记录（-f 跟踪）
  cron-ready upgrade            升级到最新版：npm i -g cron-ready@latest`;

export async function main(argv = process.argv) {
  const parsed = parseCli(argv.slice(2));
  if (parsed.help) {
    deps.print(USAGE);
    return;
  }
  // --config 缺失时键根本不存在（等价 argparse SUPPRESS），命令内部用
  // args?.config ?? 默认路径 读取。
  const args = { ...parsed.opts };
  if (parsed.config !== undefined) args.config = parsed.config;
  switch (parsed.command) {
    case undefined:
      return cmdOverview(args);
    case 'install':
      return cmdInstall(args);
    case 'uninstall':
      return cmdUninstall(args);
    case 'list':
      return cmdList(args);
    case 'run':
      return cmdRun(args);
    case 'renew':
      return cmdRenew(args);
    case 'logs':
      return cmdLogs({ ...args, workspace: parsed.positional[0] });
    default:
      usageExit(`未知子命令：${parsed.command}`);
  }
}
