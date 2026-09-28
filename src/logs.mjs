// `cron-ready logs`：选日志文件并交给 tail。默认看巡检日志（它回答「最
// 近怎么样」），stderr 只是崩溃收集处，不能因为一次旧故障盖住此后所有健
// 康的巡检轮次。

import fs from 'node:fs';
import path from 'node:path';

import { deps, ExitError } from './internals.mjs';
import { onDiskCase } from './tasks.mjs';
import { sessionLogPath } from './sessions.mjs';

export function resolveLogPath(workspace, announce) {
  const say = announce ?? ((m) => deps.printErr(m));
  if (workspace) {
    if (path.isAbsolute(workspace)) {
      // 日志名由工作区路径折成，而 spawn 记的是 discover 规范化后的真实
      // 大小写：敲错大小写的绝对路径必须认回同一个文件。
      let real;
      try {
        real = fs.realpathSync(workspace);
      } catch {
        real = workspace;
      }
      const file = sessionLogPath(onDiskCase(real));
      return fs.existsSync(file) ? file : null;
    }
    // 只匹配当前日志（*.log）：.log.1 若参与匹配，轮转过一次的工作区会永
    // 远被报成「匹配到多个」。
    let matches = [];
    try {
      matches = fs.readdirSync(deps.paths.sessionLogDir)
        .filter((f) => f.endsWith('.log'))
        .map((f) => path.join(deps.paths.sessionLogDir, f))
        .filter((f) => path.basename(f).includes(workspace));
    } catch {
      matches = [];
    }
    if (matches.length > 1) {
      say(`'${workspace}' 匹配到多个会话日志，请给出更长的片段：`);
      for (const f of matches.sort()) say(`  ${path.basename(f)}`);
      throw new ExitError(1);
    }
    return matches[0] ?? null;
  }

  const out = path.join(deps.paths.logDir, 'launchd.out.log');
  const err = path.join(deps.paths.logDir, 'launchd.err.log');
  if (!fs.existsSync(out)) return err;
  try {
    if (fs.statSync(err).size > 0) {
      const mtime = fs.statSync(err).mtime;
      const p = (n) => String(n).padStart(2, '0');
      const stamp = `${p(mtime.getMonth() + 1)}-${p(mtime.getDate())} `
        + `${p(mtime.getHours())}:${p(mtime.getMinutes())}`;
      say(`注：${err} 有内容（最后写入 ${stamp}），巡检若异常先看它`);
    }
  } catch {
    // err 不存在：无事。
  }
  return out;
}

export function cmdLogs(args) {
  const file = resolveLogPath(args.workspace);
  if (!file) {
    deps.printErr(`在 ${deps.paths.sessionLogDir} 中找不到与`
      + `「${args.workspace}」匹配的会话日志`);
    throw new ExitError(1);
  }
  const tailArgs = args.follow ? ['-f'] : ['-n', '100'];
  tailArgs.push(file);
  const r = deps.spawnSync('/usr/bin/tail', tailArgs, { stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status && r.status !== 0) throw new ExitError(r.status);
}
