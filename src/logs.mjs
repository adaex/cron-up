// 无参数时查看 launchd 巡检日志；给出目录、任务 id、Herdr 地址或标题片段时，
// 查看 Herdr 自己保存的会话界面与历史。

import fs from 'node:fs';
import path from 'node:path';

import { deps, ExitError } from './internals.mjs';
import { onDiskCase, lexReal } from './tasks.mjs';
import { fmtMDHM } from './display.mjs';
import { requireHerdr } from './sessions.mjs';

export function resolveLogPath(announce) {
  const say = announce ?? ((m) => deps.printErr(m));
  const out = path.join(deps.paths.logDir, 'launchd.out.log');
  const err = path.join(deps.paths.logDir, 'launchd.err.log');
  if (!fs.existsSync(out)) return err;
  try {
    const st = fs.statSync(err);
    if (st.size > 0) {
      say(`注：${err} 有内容（最后写入 ${fmtMDHM(st.mtime)}），`
        + '巡检若异常先看它');
    }
  } catch {
    // err 不存在：无事。
  }
  return out;
}

export function resolveHerdrTerminal(workspace, announce) {
  const say = announce ?? ((m) => deps.printErr(m));
  const absolute = path.isAbsolute(workspace)
    ? onDiskCase(lexReal(workspace)) : null;
  // 精确地址只需一次 get；查不到再按任务、目录或标题做全量模糊匹配。
  if (absolute === null) {
    const exact = deps.getHerdrTerminal(workspace);
    if (exact) return exact;
  }
  const matches = deps.listHerdrTerminals(null, true).filter((t) =>
    absolute !== null ? t.cwd === absolute
      : [t.address, t.taskId, t.cwd, t.title]
        .some((value) => String(value ?? '').includes(workspace)));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  say('匹配到多个 Herdr 会话，请给出更长的片段：');
  for (const t of matches) {
    say(`  ${t.address}  ${t.cwd} 任务 ${t.taskId}  ${t.title}`);
  }
  throw new ExitError(1);
}

function run(command) {
  const r = deps.spawnSync(command[0], command[1], { stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.signal) throw new ExitError(1, `日志查看进程被信号 ${r.signal} 终止`);
  if (r.status !== 0) throw new ExitError(r.status ?? 1);
}

export function cmdLogs(args) {
  if (!args.workspace) {
    // -F 同时按名字与描述符跟随：日志 rename 后原路径重建也能接上。
    const tailArgs = args.follow ? ['-F'] : ['-n', '100'];
    tailArgs.push(resolveLogPath());
    run(['/usr/bin/tail', tailArgs]);
    return;
  }

  const hc = requireHerdr();
  const terminal = resolveHerdrTerminal(args.workspace);
  if (!terminal) {
    deps.printErr(`找不到与「${args.workspace}」匹配的 Herdr 会话`);
    throw new ExitError(1);
  }
  run([hc, args.follow && terminal.state === 'live'
    ? ['attach', terminal.address]
    : ['read', '--lines', '100', terminal.address]]);
}
