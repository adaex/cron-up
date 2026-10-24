// Claude Code 会话登记（~/.claude/sessions/*.json）的读取与消费者判定。
// 登记是另一个程序未文档化的输出：一旦形状变化，所有会话都会被读成「不
// 存在」，巡检就会反复重拉。scanSessions 因此内置三枚烟雾告警，分别盯住
// 三种漂移形态。
//
// 除「某目录有哪些活会话」外，它回报每个会话的进程祖先链：cron-up 拉起
// 的预热会话是三层结构 script(S) → zsh(Z) → claude(C)（claude 在交互
// shell 里是函数，函数帧不做 tail-exec），state 只记得到 S，登记里却是
// C，pgid 又被交互 shell 的作业控制改过——唯一稳定的认亲方式是沿 ppid
// 上溯。祖先链每轮恒拍（一次全机 ps，毫秒级）：任务级模型下每个预热都
// 要靠它把 script pid 认成登记里的 sessionId，没有「不需要认亲」的轮次。

import fs from 'node:fs';
import path from 'node:path';

import { deps, isPlainObject } from './internals.mjs';
import { parsePid } from './config.mjs';
import { lexReal } from './tasks.mjs';

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

// 一次 ps 同时拿进程名与父 pid：{isClaude, ppid}。ppid 按「末尾空白+
// 数字」取——comm 可能是含空格的路径，但不会以「空白+数字」结尾；列缺
// 失（ps 失败/输出漂移）时 ppid 为 null。
export function processShape(pid) {
  const line = ps(pid, 'comm=,ppid=');
  const m = line.match(/^(.*\S)\s+(\d+)\s*$/);
  const comm = path.basename((m ? m[1] : line).trim()).toLowerCase();
  const ppid = m ? parseInt(m[2], 10) : null;
  let isClaude = comm.includes('claude');
  if (!isClaude && INTERPRETER_COMMS.has(comm)) {
    isClaude = CLAUDE_ENTRY_RE.test(ps(pid, 'args=').toLowerCase());
  }
  return { isClaude, ppid };
}

// 全机进程父子表：一次 ps -axo pid=,ppid= 拍快照，Map<pid, ppid>。任何
// 异常都返回 null（祖先链一律按空链处理：认亲下轮再试，不阻断 spawn）。
export function processParentMap() {
  const r = deps.execFile('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 5000 });
  if (r.status !== 0) return null;
  const map = new Map();
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (m) map.set(parseInt(m[1], 10), parseInt(m[2], 10));
  }
  return map.size > 0 ? map : null;
}

// 沿父子表上溯（不含 pid 自身），直到 launchd(1；其父记为 0)、父 pid 在
// 快照里缺失或成环。调用方只消费祖先列表；断链时保留已读到的部分即可。
export function ancestorChain(pid, parentMap) {
  const ancestors = [];
  const seen = new Set([pid]);
  let cur = pid;
  for (;;) {
    const parent = parentMap?.get(cur);
    if (parent === undefined) return ancestors;
    ancestors.push(parent);
    if (parent <= 1) return ancestors; // 0/1 即根
    if (seen.has(parent)) return ancestors;
    seen.add(parent);
    cur = parent;
  }
}

// 本目录活着的会话 id 集合。任务的 createdBySessionId 命中其中任一个，
// 就说明创建它的会话还开着——活创建者享有最高优先级：任务铁定投进它，
// 巡检不预热、不盖印。
export function liveSessionIds(details, ws) {
  return new Set((details?.get(ws) ?? [])
    .map((d) => d.sessionId)
    .filter((x) => typeof x === 'string'));
}

// 逐任务本原谓词：这条任务的创建者会话还活着吗？liveSids 是同工作区的
// liveSessionIds 快照。
export function creatorSessionAlive(task, liveSids) {
  return typeof task?.createdBySessionId === 'string'
    && liveSids.has(task.createdBySessionId);
}

// 认亲：我们 spawn 的 script pid 是不是本目录某个活登记会话的祖先。命中
// 即该预热已完成登记、是健康会话，返回登记详情（claude 的 pid/sessionId/
// procStart）；认不到返回 null（会话还在启动，或卡在提问界面）。
export function claimWarm(details, ws, scriptPid) {
  const list = details?.get(ws) ?? [];
  return list.find((d) => d.ancestors.includes(scriptPid)) ?? null;
}

// 轻量单会话存活检查：按 sessionId 找登记、pid 活、cwd 匹配。轮末死亡复
// 核用——轮初还活的预热 script 轮中死去时，要区分「真的死了」与「用户在
// 终端 --resume 接管成裸 claude」（同一 sessionId、新 pid），后者不算会
// 话退出。不给 ws 时只看 sid 活不活。
export function sessionAliveNow(sid, ws = null) {
  if (typeof sid !== 'string') return false;
  let files = [];
  try {
    files = fs.readdirSync(deps.paths.sessionDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(deps.paths.sessionDir, f));
  } catch {
    return false;
  }
  for (const f of files) {
    let s;
    try {
      s = JSON.parse(fs.readFileSync(f, 'utf-8'));
    } catch {
      continue; // 可能正被 Claude Code 就地重写
    }
    if (!isPlainObject(s) || s.sessionId !== sid) continue;
    const pid = parsePid(s.pid);
    if (pid === null || !deps.alive(pid)) continue;
    if (ws !== null) {
      if (typeof s.cwd !== 'string' || !path.isAbsolute(s.cwd)
          || lexReal(s.cwd) !== ws) continue;
    }
    return true;
  }
  return false;
}

// 读一个登记文件；读不出返回 null。Claude Code 会就地（非原子）重写登
// 记，读写相撞读到半个 JSON 时睡一拍重读一次；文件消失不是竞态，不重
// 试。
async function readSessionFile(file) {
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

// 返回 [拥有活消费者会话的工作区集合, 告警字符串|null, 会话详情 Map]。
// 第三个元素是 Map<cwd, Array<{pid, sessionId, procStart, ancestors}>>。
// 祖先链恒拍：快照失败给空链，相关预热本轮认不到亲、下轮自动重试；
// consumers 判定不受影响。
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
    if (isPlainObject(s) && s.kind === 'interactive') {
      interactive.push(s);
    }
  }

  // 全轮一张父子表快照：所有会话的祖先链取自同一时刻，且只付一次全机
  // ps。失败给 null，祖先链一律按断链处理（本轮认不到亲）。
  let parentMap = null;
  try {
    parentMap = deps.processParentMap();
  } catch {
    parentMap = null;
  }

  const consumers = new Set();
  const details = new Map();
  const shapeCache = new Map();
  let liveOther = 0;
  // interactive 认得出来，却读不出有效 pid 或工作目录的条目数：pid/cwd
  // 字段改名就是这种形态，而下面两条自检只看 kind 与进程形态，兜不住。
  let suspect = 0;
  for (const s of interactive) {
    // pid 也是外部程序写的字段：null、非数值、非正数、超 pid_t 的巨大整
    // 数都读不出活进程。这段代码在 per-workspace 保护圈之外，一个畸形登
    // 记抛出去就是整轮巡检失败；缺失时兜底 -1 还会被 kill(-1,0)（对全
    // 部进程的权限探测，不是存在性检查）误读为存活。
    const pid = parsePid(s.pid);
    if (pid === null) {
      suspect += 1; // 正常登记必带可解析 pid：缺失/变质即字段漂移
      continue;
    }
    if (!deps.alive(pid)) continue; // 陈旧登记（崩溃留下）：正常，不计
    if (!shapeCache.has(pid)) {
      shapeCache.set(pid, deps.processShape(pid)); // ps 调用按 pid 缓存
    }
    const shape = shapeCache.get(pid);
    if (shape.isClaude) {
      // cwd 同样不可信：非字符串当定位不到工作区；空串与相对路径会被
      // resolve 拼到巡检进程自己的 cwd 下，凭空造出消费者目录。
      const cwd = s.cwd;
      if (typeof cwd === 'string' && path.isAbsolute(cwd)) {
        const ws = lexReal(cwd);
        consumers.add(ws);
        const ancestors = parentMap ? ancestorChain(pid, parentMap) : [];
        const list = details.get(ws) ?? [];
        list.push({
          pid,
          sessionId: typeof s.sessionId === 'string' ? s.sessionId : null,
          // procStart 是 ps lstart 原文（单位数日期含双空格），只许原样
          // 传递给任务文件，绝不能自己拼。
          procStart: typeof s.procStart === 'string' ? s.procStart : null,
          ancestors,
        });
        details.set(ws, list);
        continue;
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
      + '不存在，重复拉起预热会话';
  }
  return [consumers, alert, details];
}

Object.assign(deps, {
  processShape,
  processParentMap,
  ancestorChain,
  liveSessionIds,
  creatorSessionAlive,
  claimWarm,
  sessionAliveNow,
  scanSessions,
});
