// `cron-up logs`：选日志文件并交给 tail。默认看巡检日志（它回答「最近
// 怎么样」），stderr 只是崩溃收集处，不能因为一次旧故障盖住此后所有健
// 康的巡检轮次。一个工作区现在有多个任务级日志，按前缀匹配，多义时列
// 候选让人给更长的片段。

import fs from 'node:fs';
import path from 'node:path';

import { deps, ExitError } from './internals.mjs';
import { onDiskCase, lexReal } from './tasks.mjs';
import { slugSegment } from './sessions.mjs';
import { fmtMDHM } from './display.mjs';

// 列出会话日志目录下当前一代（.log，不含 .log.1）的全部日志绝对路径。
function listCurrentLogs() {
  try {
    return fs.readdirSync(deps.paths.sessionLogDir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => path.join(deps.paths.sessionLogDir, f));
  } catch {
    return [];
  }
}

// 多个候选时打印清单并放弃（exit 1），tail 哪一个由用户补全片段决定。
function chooseOne(matches, say) {
  if (matches.length === 1) return matches[0];
  say('匹配到多个任务级会话日志，请给出更长的片段（如 目录名--任务id）：');
  for (const f of matches.sort()) say(`  ${path.basename(f)}`);
  throw new ExitError(1);
}

export function resolveLogPath(workspace, announce) {
  const say = announce ?? ((m) => deps.printErr(m));
  if (workspace) {
    if (path.isAbsolute(workspace)) {
      // 日志名由工作区路径折成前缀，任务 id 是后缀：敲绝对路径（目录）
      // 时按 <slug(ws)>--*.log 前缀匹配，认回磁盘真实大小写。
      const ws = onDiskCase(lexReal(workspace));
      const prefix = `${slugSegment(ws)}--`;
      const matches = listCurrentLogs().filter((f) =>
        path.basename(f).startsWith(prefix));
      return matches.length === 0 ? null : chooseOne(matches, say);
    }
    // 片段匹配：直接对文件名做 includes，天然覆盖「目录名」「目录名--
    // 任务id」「任务id」三种给法。
    const matches = listCurrentLogs()
      .filter((f) => path.basename(f).includes(workspace));
    if (matches.length > 1) return chooseOne(matches, say);
    return matches[0] ?? null;
  }

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
