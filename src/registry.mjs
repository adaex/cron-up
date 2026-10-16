// Claude Code 会话登记（~/.claude/sessions/*.json）的读取与消费者判定。
// 登记是另一个程序未文档化的输出：一旦形状变化，所有会话都会被读成「不
// 存在」，巡检就会在用户会话旁边反复重拉。scanSessions 因此内置四枚烟
// 雾告警，分别盯住四种漂移形态。
//
// 除「某目录有没有消费者」外，它还回报每个消费者的进程祖先链：cron-up
// 拉起的预热会话是三层结构 script(S) → zsh(Z) → claude(C)（claude 在交
// 互 shell 里是函数，函数帧不做 tail-exec），state 只记得到 S，登记里
// 却是 C，pgid 又被交互 shell 的作业控制改过——唯一稳定的认亲方式是沿
// ppid 上溯。

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
// 失（ps 失败/输出漂移）时 ppid 为 null，调用方按歧义保守处理。
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
// 异常都返回 null（调用方退化为「全部歧义」的保守行为，绝不抛出）。
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

// 沿父子表上溯（不含 pid 自身），直到 launchd(1；其父记为 0)。中途父 pid
// 在快照里缺失（ps 退化/进程刚好退出）或成环时 chainComplete=false——
// 「没找到目标」与「证据链断了」必须由调用方区分：后者按歧义不双开。
export function ancestorChain(pid, parentMap) {
  const ancestors = [];
  const seen = new Set([pid]);
  let cur = pid;
  for (;;) {
    const parent = parentMap?.get(cur);
    if (parent === undefined) return { ancestors, chainComplete: false };
    ancestors.push(parent);
    if (parent <= 1) return { ancestors, chainComplete: true }; // 0/1 即根
    if (seen.has(parent)) return { ancestors, chainComplete: false };
    seen.add(parent);
    cur = parent;
  }
}

// 本目录活着的消费者会话 id 集合。窗口任务的 createdBySessionId 命中其中
// 任一个，就说明创建它的会话还开着——stampOwner 的最高优先级是尊重活创
// 建者，既不另拉也不过户。
export function liveSessionIds(details, ws) {
  return new Set((details?.get(ws) ?? [])
    .map((d) => d.sessionId)
    .filter((x) => typeof x === 'string'));
}

// stampOwner 的认亲结论。details/ws 是 scanSessions 的第三元素；ent 是
// state 条目，entAlive 由调用方按指纹判好（registry 不认识 state 语义）；
// creatorAlive 表示「至少一个窗口内任务的创建者会话还在本目录活着」：
//   own          祖先链里有本代 script pid——在场消费者就是我们的预热；
//                target 给出可盖印详情，身份字段缺失时为 null；
//   creatorAlive 窗口任务的创建者会话还活着——任务按 Claude Code 规则必
//                然投给它，不另拉、不盖印（用户显式要求的最高优先级）；
//   ambiguous    没有认到自己的预热，但在场会话父链不完整——无法证明不
//                是自己（如 state 丢失的孤儿预热），保守不双开；
//   user         以上皆否——创建者已关闭/崩溃，在场的只是无关用户会话
//                （或根本没有消费者），可以另拉独立预热承接。
export function classifyWorkspace(details, ws, ent, entAlive, creatorAlive) {
  const list = details?.get(ws) ?? [];
  if (ent?.pid && entAlive) {
    const own = list.find((d) => d.ancestors.includes(ent.pid));
    if (own) {
      return {
        kind: 'own',
        target: own.sessionId && own.procStart ? own : null,
      };
    }
  }
  if (creatorAlive) return { kind: 'creatorAlive', target: null };
  if (list.some((d) => !d.chainComplete)) return { kind: 'ambiguous', target: null };
  return { kind: 'user', target: null };
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
// 第三个元素是 Map<cwd, Array<{pid, sessionId, procStart, ancestors,
// chainComplete}>>；祖先链要付一次全机 ps，只有 stampOwner 需要，所以
// lineage 默认关：关时恒为空 Map，总览/list/平静巡检不增加任何进程开销
// （与本仓「全量 ps 按需现拍」的既有纪律一致）。
export async function scanSessions({ lineage = false } = {}) {
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

  // 全轮一张父子表快照：所有会话的祖先链取自同一时刻，且只付一次全量
  // ps。仅在 lineage 显式开启时拍——快照失败给 null，祖先链一律按断链
  // 处理（stampOwner 退化为「全部歧义、绝不双开」），consumers 判定不受
  // 影响。
  let parentMap = null;
  if (lineage) {
    try {
      parentMap = deps.processParentMap();
    } catch {
      parentMap = null;
    }
  }

  const consumers = new Set();
  const details = new Map();
  const shapeCache = new Map();
  let liveOther = 0;
  // interactive 认得出来，却读不出有效 pid 或工作目录的条目数：pid/cwd
  // 字段改名就是这种形态，而下面两条自检只看 kind 与进程形态，兜不住。
  let suspect = 0;
  // 已是消费者、但进程父 pid 或祖先链读不完整的条目数：stampOwner 会因
  // 此无法认亲，只能保守不双开（过户暂停），需要一行告警让人看见退化。
  let lineageMissing = 0;
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
      // resolve 拼到巡检进程自己的 cwd 下，凭空造出消费者目录，可能令预
      // 热被静默跳过。
      const cwd = s.cwd;
      if (typeof cwd === 'string' && path.isAbsolute(cwd)) {
        const ws = lexReal(cwd);
        consumers.add(ws);
        if (lineage) {
          const chain = parentMap
            ? ancestorChain(pid, parentMap)
            : { ancestors: [], chainComplete: false };
          if (shape.ppid === null || !chain.chainComplete) lineageMissing += 1;
          const list = details.get(ws) ?? [];
          list.push({
            pid,
            sessionId: typeof s.sessionId === 'string' ? s.sessionId : null,
            // procStart 是 ps lstart 原文（单位数日期含双空格），只许原样
            // 传递给任务文件，绝不能自己拼。
            procStart: typeof s.procStart === 'string' ? s.procStart : null,
            ancestors: chain.ancestors,
            chainComplete: chain.chainComplete,
          });
          details.set(ws, list);
        }
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
      + '不存在，在同目录重复拉起会话';
  } else if (lineage && lineageMissing > 0) {
    alert = `${lineageMissing} 个存活会话的进程父子关系读不完整（ps 输出异常或`
      + '会话进程正在退出）；stampOwner 本轮按保守策略不另拉预热会话、暂停'
      + '任务过户，下轮自动恢复';
  }
  return [consumers, alert, details];
}

Object.assign(deps, {
  processShape,
  processParentMap,
  ancestorChain,
  liveSessionIds,
  classifyWorkspace,
  scanSessions,
});
