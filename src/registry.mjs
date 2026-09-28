// Claude Code 会话登记（~/.claude/sessions/*.json）的读取与消费者判定。
// 登记是另一个程序未文档化的输出：一旦形状变化，所有会话都会被读成「不
// 存在」，巡检就会在用户会话旁边反复重拉。scanSessions 因此内置三枚烟
// 雾告警，分别盯住三种漂移形态。

import fs from 'node:fs';
import path from 'node:path';

import { deps } from './internals.mjs';
import { lenientInt } from './config.mjs';
import { PID_T_MAX } from './constants.mjs';

// npm/bun 形态的 claude 是解释器跑的脚本：进程 comm 是 node/bun/deno，
// 只能从完整命令行认 claude 入口（bin/claude 符号链接或包目录 cli.js）。
// 回退只对已知解释器开放——命令行里碰巧提到 claude 的进程（vim claude.md）
// 不会被误认。
const INTERPRETER_COMMS = new Set(['node', 'nodejs', 'bun', 'deno']);
const CLAUDE_ENTRY_RE = /(?:^|\/)claude(?:-code)?(?:\.js)?(?:$|[\/\s])/;

function ps(pid, fmt) {
  try {
    const r = deps.execFile('/bin/ps', ['-p', String(pid), '-o', fmt],
      { timeout: 5000 });
    return (r.stdout ?? '').trim();
  } catch {
    return '';
  }
}

// 活 pid 是否像 claude 进程；调用方先判存活，这里用来排除回收 pid 的无关
// 进程。
export function pidIsClaude(pid) {
  const comm = path.basename(ps(pid, 'comm=')).toLowerCase();
  if (comm.includes('claude')) return true;
  if (INTERPRETER_COMMS.has(comm)) {
    return CLAUDE_ENTRY_RE.test(ps(pid, 'args=').toLowerCase());
  }
  return false;
}

// 读一个登记文件；读不出返回 null。Claude Code 会就地（非原子）重写登
// 记，读写相撞读到半个 JSON 时睡一拍重读一次；文件消失不是竞态，不重
// 试。
export async function readSessionFile(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      return null; // 文件消失不是竞态，不重试
    }
    try {
      return JSON.parse(text);
    } catch {
      if (attempt === 1) return null;
    }
    // 读到半成品文件：睡一拍等 Claude Code 写完再读一次。
    await deps.sleep(100);
  }
  return null;
}

// 宽容版 realpath：fs.realpathSync 对不存在的路径抛 ENOENT，这里失败时退
// 回词法绝对路径（调用方已保证输入是绝对路径）。
function lexReal(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// 返回 [拥有活消费者会话的工作区集合, 告警字符串|null]。
export async function scanSessions() {
  let files = [];
  try {
    files = fs.readdirSync(deps.paths.sessionDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(deps.paths.sessionDir, f));
  } catch {
    files = [];
  }
  const interactive = [];
  for (const f of files) {
    const s = await readSessionFile(f);
    if (s && typeof s === 'object' && s.kind === 'interactive') {
      interactive.push(s);
    }
  }

  const consumers = new Set();
  const commCache = new Map();
  let liveOther = 0;
  // interactive 认得出来，却读不出有效 pid 或工作目录的条目数：pid/cwd
  // 字段改名就是这种形态，而下面两条自检只看 kind 与进程形态，兜不住。
  let suspect = 0;
  for (const s of interactive) {
    // pid 也是外部程序写的字段：null、非数值、非正数、超 pid_t 的巨大整
    // 数都读不出活进程。这段代码在 per-workspace 保护圈之外，一个畸形登
    // 记抛出去就是整轮巡检失败；缺失时兜底 -1 还会被 kill(-1,0)（对全
    // 部进程的权限探测，不是存在性检查）误读为存活。
    let pid;
    try {
      pid = lenientInt(s.pid);
    } catch {
      suspect += 1; // 正常登记必带可解析 pid：缺失/变质即字段漂移
      continue;
    }
    if (!(pid > 0 && pid <= PID_T_MAX)) {
      suspect += 1;
      continue;
    }
    if (!deps.alive(pid)) continue; // 陈旧登记（崩溃留下）：正常，不计
    if (!commCache.has(pid)) {
      commCache.set(pid, deps.pidIsClaude(pid)); // ps 调用按 pid 缓存
    }
    if (commCache.get(pid)) {
      // cwd 同样不可信：非字符串当定位不到工作区；空串与相对路径会被
      // resolve 拼到巡检进程自己的 cwd 下，凭空造出消费者目录，可能令预
      // 热被静默跳过。
      const cwd = s.cwd;
      if (typeof cwd === 'string' && path.isAbsolute(cwd)) {
        const real = lexReal(cwd);
        if (real) {
          consumers.add(real);
          continue;
        }
      }
      suspect += 1; // 活着的 claude 却没有可用 cwd：cwd 字段漂移
    } else {
      liveOther += 1;
    }
  }

  let alert = null;
  if (files.length > 0 && interactive.length === 0) {
    alert = `会话登记目录 ${deps.paths.sessionDir} 下有 ${files.length} 个登记文件，`
      + '但没有一个是 interactive 会话；Claude Code 的会话登记格式可能已变更，'
      + 'cron-up 将识别不到任何现有会话';
  } else if (liveOther > 0 && consumers.size === 0) {
    alert = '会话登记中的存活进程都不是 claude 命令；Claude Code 的启动形态可能'
      + '已变更，cron-up 可能反复重拉会话';
  } else if (suspect > 0 && consumers.size === 0) {
    alert = '会话登记中的 interactive 会话都读不出有效的 pid 或工作目录；'
      + 'Claude Code 的会话登记字段可能已变更，cron-up 会把已有会话误判为'
      + '不存在，在同目录重复拉起会话';
  }
  return [consumers, alert];
}

Object.assign(deps, {
  pidIsClaude,
  scanSessions,
});
