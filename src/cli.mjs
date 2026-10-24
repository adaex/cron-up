// 命令行解析与分发。node:util parseArgs 不支持子命令与自动帮助，这里手
// 写一层：子命令前只允许隐藏的 --config（前后都可放），定位子命令后按
// 各命令的选项表解析。

// 先引全量入口，保证所有业务模块都已向 deps 自注册，再引命令函数。
import './index.mjs';
import { deps, ExitError } from './internals.mjs';
import { cmdRun } from './patrol.mjs';
import { cmdInstall, cmdUninstall } from './service.mjs';
import { cmdList } from './list.mjs';
import { cmdOverview } from './overview.mjs';
import { cmdLogs } from './logs.mjs';
import { SPECS, thisCamel } from './args.mjs';

function usageExit(message) {
  throw new ExitError(2, message);
}

// 解析单个选项 token，返回消耗后的新下标。
function consumeOption(tok, tokens, i, spec, opts) {
  let name;
  let inlineValue;
  if (tok.startsWith('--')) {
    const body = tok.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      name = body.slice(0, eq);
      inlineValue = body.slice(eq + 1);
    } else {
      name = body;
    }
  } else {
    name = tok.slice(1); // -f
  }
  if (name === 'f' && Object.hasOwn(spec.options, 'f')
      && spec.options.f === 'bool') name = 'follow';
  if (!Object.hasOwn(spec.options, name)) usageExit(`未知选项：${tok}`);
  const kind = spec.options[name];
  if (kind === 'bool') {
    if (inlineValue !== undefined) usageExit(`布尔选项 --${name} 不接受值`);
    opts[thisCamel(name)] = true;
    return i + 1;
  }
  // string 吃一个值（内联或下一 token）。
  let value;
  if (inlineValue !== undefined) value = inlineValue;
  else {
    value = tokens[i + 1];
    if (value === undefined) usageExit(`选项 --${name} 缺少值`);
  }
  opts[thisCamel(name)] = value;
  return inlineValue !== undefined ? i + 1 : i + 2;
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
      if (!Object.hasOwn(SPECS, tok)) usageExit(`未知子命令：${tok}`);
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

const USAGE = `cron-up —— 为定时任务提前备好交互会话（一任务一会话）

用法：
  cron-up                    查看总览（服务、配置、任务、预热会话）
  cron-up install            安装配置与 LaunchAgent（可用 --roots 指定扫描目录）
  cron-up uninstall          卸载并结束全部预热会话（--purge 连配置日志一起删）
  cron-up list               逐个列出定时任务的设定/预计实际触发时间与预热状态
  cron-up run                执行一轮巡检（launchd 入口，也可手动立即跑一轮）
  cron-up logs [目录片段]    查看巡检日志或后台会话记录（-f 跟踪）

升级：npm i -g cron-up@latest`;

export async function main(argv = process.argv) {
  const parsed = parseCli(argv.slice(2));
  if (parsed.help) {
    deps.print(USAGE);
    return;
  }
  // --config 缺失时键根本不存在，命令内部用 args?.config ?? 默认路径读取。
  const args = { ...parsed.opts };
  if (parsed.config !== undefined) args.config = parsed.config;
  switch (parsed.command) {
    case null:
      return cmdOverview(args);
    case 'install':
      return cmdInstall(args);
    case 'uninstall':
      return cmdUninstall(args);
    case 'list':
      return cmdList(args);
    case 'run':
      return cmdRun(args);
    case 'logs':
      return cmdLogs({ ...args, workspace: parsed.positional[0] });
    default:
      return usageExit(`未知子命令：${parsed.command}`);
  }
}
