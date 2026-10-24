// Claude Code 任务文件层：发现工作区、读任务、续期（permanent 标记）、
// 归属盖印与原子写。任务文件是另一个程序写的外部输入，所有入口都
// 校验形状，坏数据读作「没有任务」而不是抛进巡检循环。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { deps, isPlainObject } from './internals.mjs';
import { TASK_REL } from './paths.mjs';
import {
  PRUNE_DIRS,
  MAX_SCAN_DEPTH,
} from './constants.mjs';

export function expandHome(p) {
  const home = deps.paths.home;
  if (p === '~') return home;
  if (p.startsWith('~/')) return home + p.slice(1);
  return p; // ~user 形式不支持（macOS 实践中不会出现）
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// 宽容版 realpath：失败时退回词法绝对路径（输入须已绝对）。与
// realpathOrNull 的「失败即 null」是两种降级口径：会话登记匹配（registry）
// 与日志定位（logs）要的是一个还能用的路径，而不是 null。
export function lexReal(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// 任务文件是否还在：readTasks 读出 null 时区分「文件已消失」（一次性任务
// 执行完被删的正常竞态）与「文件在但损坏」（要告警）。路径拼法归任务层，
// 巡检与总览不必各自重建。
export function taskFileExists(ws) {
  return fs.existsSync(path.join(ws, TASK_REL));
}

// 路径在磁盘上真实存储的大小写形态；任何一段读不出时原样返回。
// macOS 默认文件系统大小写不敏感，而 realpath 不规范化大小写：敲错大小
// 写的路径照样通过 isDirectory，却与会话登记里真实大小写的 cwd 永远匹配
// 不上。在扫描边界认回一次真实写法，下游就不必各自提防。
export function onDiskCase(p) {
  const parts = path.resolve(p).split('/').filter(Boolean);
  let cur = '/';
  for (const name of parts) {
    let entries;
    try {
      entries = fs.readdirSync(cur);
    } catch {
      return p;
    }
    const match = entries.find((e) => e.toLowerCase() === name.toLowerCase());
    if (!match) return p;
    cur = path.join(cur, match);
  }
  return cur;
}

// 枚举所有含任务文件的工作区，产出 [workspace, taskfile]。生成器：一个工
// 作区出问题不该跳过其后所有工作区（调用方另有 per-workspace 保护）。扫
// 描深度固定为 MAX_SCAN_DEPTH，不可配置。
export function* discover(roots) {
  const seen = new Set();
  for (const raw of roots) {
    let root = realpathOrNull(path.resolve(expandHome(String(raw))));
    if (root === null || !isDir(root)) continue;
    // 在边界认回真实大小写：带错大小写的 root 会让 ws 与会话登记的 cwd
    // 匹配不上，同目录被重复拉起会话。
    root = onDiskCase(root).replace(/\/+$/, '') || '/';
    const baseDepth = root.split('/').length - 1;

    function* walk(dirpath) {
      let entries;
      try {
        entries = fs.readdirSync(dirpath, { withFileTypes: true });
      } catch {
        return;
      }
      const depth = dirpath.split('/').length - 1 - baseDepth;
      // 先剪枝：depth==MAX_SCAN_DEPTH 这一层本身仍要检查候选文件，只是不
      // 再下降；再做候选检查。
      const subdirs = depth >= MAX_SCAN_DEPTH
        ? []
        : entries.filter((e) => e.isDirectory() && !PRUNE_DIRS.has(e.name));
      const candidate = path.join(dirpath, TASK_REL);
      let isFile = false;
      try {
        isFile = fs.statSync(candidate).isFile();
      } catch {
        // 不存在按非文件处理。
      }
      // 先判有没有任务文件再 realpath：绝大多数目录没有，省一次 syscall。
      if (isFile) {
        const ws = realpathOrNull(dirpath);
        if (ws && !seen.has(ws)) {
          seen.add(ws);
          yield [ws, candidate];
        }
      }
      for (const d of subdirs) {
        yield* walk(path.join(dirpath, d.name));
      }
    }
    yield* walk(root);
  }
}

// 读一个工作区的任务列表，坏形状一律返回 null。读盘与顶层形状校验复用
// loadTaskDoc（maintain 也要同一口径 round-trip 整份文档）。
export function readTasks(ws) {
  const doc = deps.loadTaskDoc(path.join(ws, TASK_REL));
  return doc === null ? null : doc.tasks.filter(isPlainObject);
}

// 任务在 state 与盖印映射里的身份键：CronCreate 的任务总有唯一 8 位十六
// 进制 id，直接用它；手写无 id 任务退化为内容摘要键。
export function taskKey(t) {
  if (typeof t?.id === 'string' && t.id !== '') return t.id;
  return `anon:${createHash('sha1').update(taskSig(t)).digest('hex').slice(0, 16)}`;
}

// 任务的稳定内容签名：只含不会被我们与调度器改动的字段。盖印改
// createdBy*、执行改 lastFiredAt、续期加 permanent 都不改变签名；无 id
// 任务的 taskKey 用它生成内容摘要键。
export function taskSig(t) {
  return JSON.stringify([
    t?.cron ?? null,
    t?.prompt ?? null,
    t?.createdAt ?? null,
    Boolean(t?.recurring),
  ]);
}

// 按任务身份键分组的共享视图：重复键天然落在同一组，调用方不必各自
// 维护重复计数与键集合。非对象条目不参与盖印或巡检，和 readTasks/
// maintain 的既有口径一致。
export function groupTasksByKey(tasks) {
  const groups = new Map();
  for (const t of tasks) {
    if (!isPlainObject(t)) continue;
    const key = taskKey(t);
    const group = groups.get(key) ?? [];
    group.push(t);
    groups.set(key, group);
  }
  return groups;
}

// 任务文件在「读到」与「写回」之间被别的写者改了（Claude Code 更新
// lastFiredAt 或删除已触发任务）：最终检查时能发现就抛 TaskFileChanged，
// 让下轮巡检基于更新的文档重试。检查与 rename 之间仍有极小竞态，不能把
// 这层检测当成与上游共用的互斥锁。
export class TaskFileChanged extends Error {
  constructor(file) {
    super(`任务文件已被其他写者改动：${file}`);
    this.name = 'TaskFileChanged';
  }
}

// 读整份文档（未知顶层键保留）：maintain 要就地重写文件，必须 round-trip
// Claude Code 或其他工具放进去的每个键，而不只是 tasks 子集。
export function loadTaskDoc(file) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
  if (!isPlainObject(doc) || !Array.isArray(doc.tasks)) return null;
  return doc;
}

// 临时文件用专属后缀而非泛用的 .tmp：清扫时只认自己的名字，不会误删恰好
// 用同一约定的其他写者（巡检锁只隔离 cron-up 自己，管不到 Claude Code）
// 刚建好的临时文件。
function tmpSibling(file) {
  return `${file}.cron-up-tmp`;
}

// 旁边写再 rename 的原子替换，保留原文件权限位与中文字面量。
// tmp 以 0600 创建（绝不更宽），写完再放宽到原 mode。expectedMtimeNs 是
// 乐观检测：最终检查时路径 mtime 已变说明别的写者抢先，抛 TaskFileChanged
// 而不是覆盖这次检查之前发生的更新。
export function atomicWriteJson(file, doc, expectedMtimeNs) {
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    // 新文件用 0600。
  }
  const tmp = tmpSibling(file);
  // JSON.stringify 两空格缩进：中文按字面写出（不转 \u 转义），无尾换行。
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), {
    flag: 'w',
    mode: 0o600,
  });
  try {
    fs.chmodSync(tmp, mode);
  } catch {
    // 保持 0600。
  }
  let current = null;
  try {
    current = fs.statSync(file, { bigint: true }).mtimeNs;
  } catch {
    current = null;
  }
  if (current !== expectedMtimeNs) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 忽略清理失败。
    }
    throw new TaskFileChanged(file);
  }
  fs.renameSync(tmp, file);
}

// 一轮巡检对一个任务文件做的维护：renew（补 permanent）与 reown（把任务
// 归属盖给各自的预热会话）合并为同一次带 mtime 乐观检测的原子写。先取
// mtimeNs、清残留 .cron-up-tmp、loadTaskDoc round-trip 整文档；两项计数
// 都为 0 时字节级不动。返回 {renewed,reowned}；null 表示文件缺失/损坏；
// 读到写间被改抛 TaskFileChanged。
//
// reown 形状：Map<taskKey, {sessionId, pid, procStart}>。一轮内同一文件的
// 不同任务可盖向不同预热（一任务一会话）；内容相同但 id 不同的任务互不
// 影响。同一个 taskKey 对应多条任务是病态输入，无法把 state/会话唯一对应
// 到条目，这些键全部跳过盖印。只盖 createdBySessionId 不等于目标的任务，
// 第二轮起字节级不动；pid/procStart 是登记里 claude 进程的 pid 与 lstart。
export function maintainWorkspace(taskfile, { reown = null } = {}) {
  let mtimeNs;
  try {
    mtimeNs = fs.statSync(taskfile, { bigint: true }).mtimeNs;
  } catch {
    return null;
  }
  // 上次写一半被杀（SIGKILL/断电）留下的临时文件会永远躺在用户的仓库里
  // ——已无需改动的文件不再触发写入，没人替它收尾。只清专属后缀的，顺手
  // 且不碰别人。
  try {
    fs.unlinkSync(tmpSibling(taskfile));
  } catch {
    // 不存在即无事。
  }
  const doc = deps.loadTaskDoc(taskfile);
  if (doc === null) return null;
  let renewed = 0;
  for (const t of doc.tasks) {
    if (!isPlainObject(t)) continue;
    // truthy 而非 === true：与 Claude Code 自己的加载器一致
    // （...o.permanent && {permanent:true}），它已认作永久的任何值都算，
    // 不再重写。只有显式周期任务有资格——绝不从 cron 形状推断周期性，
    // 一次性任务不碰。
    if (t.recurring && !t.permanent) {
      t.permanent = true;
      renewed += 1;
    }
  }
  let reowned = 0;
  if (reown instanceof Map && reown.size > 0) {
    // 只有确实需要盖印时才计算任务键；纯续期与常见空操作不付摘要成本。
    for (const [key, group] of groupTasksByKey(doc.tasks)) {
      if (group.length !== 1) continue;
      const t = group[0];
      const target = reown.get(key);
      // 没有 owner 字段的外部条目同样盖——窗口内任务统一归各自预热，语义
      // 不因条目来源留例外。
      if (target && t.createdBySessionId !== target.sessionId) {
        t.createdBySessionId = target.sessionId;
        t.createdByPid = target.pid;
        // ps lstart 原文（含「Oct  8」双空格），原样取自会话登记。
        t.createdByProcStart = target.procStart;
        reowned += 1;
      }
    }
  }
  if (renewed === 0 && reowned === 0) {
    return { renewed: 0, reowned: 0 };
  }
  atomicWriteJson(taskfile, doc, mtimeNs);
  return { renewed, reowned };
}

Object.assign(deps, { discover, readTasks, loadTaskDoc });
