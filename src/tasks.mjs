// Claude Code 任务文件层：发现工作区、读任务、续期（permanent 标记）、
// 周期任务 id 改小、归属盖印与原子写。任务文件是另一个程序写的外部输入，
// 所有入口都校验形状，坏数据读作「没有任务」而不是抛进巡检循环。

import fs from 'node:fs';
import path from 'node:path';

import {
  deps,
  isPlainObject,
} from './internals.mjs';
import { TASK_REL, WORKSPACE_CONFIG_REL } from './paths.mjs';
import {
  PRUNE_DIRS,
  MAX_SCAN_DEPTH,
} from './constants.mjs';
import { minTaskIdMaxN } from './cron.mjs';

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

// 工作区配置只保留统一的默认模型。旧 tasks 覆盖不能静默忽略，否则升级后
// 可能用错模型；明确报错并暂停新启动，删除该字段后恢复。
function workspaceConfigError(config) {
  if (!isPlainObject(config)) return '顶层应是 JSON 对象';
  if (config.model !== undefined
      && (typeof config.model !== 'string' || !config.model.trim())) {
    return '的 model 应是非空字符串';
  }
  if (Object.hasOwn(config, 'tasks')) {
    return '不再支持 tasks.<任务id>.model，请删除 tasks，只保留顶层 model';
  }
  return null;
}

// 工作区配置只归 cron-up 所有，不写进 Claude Code 的任务文件。返回
// {config, error}：文件缺失等价于空配置；任何已存在但不可解读的配置都让
// config 为 null，由巡检阻止新会话回退成默认模型。
export function readWorkspaceConfig(ws) {
  const file = path.join(ws, WORKSPACE_CONFIG_REL);
  const invalid = (reason) => ({ config: null, error: `${file} ${reason}` });
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { config: {}, error: null };
    const reason = e instanceof SyntaxError
      ? `不是合法 JSON：${e.message}`
      : `读取失败：${e.message}`;
    return invalid(reason);
  }
  const shapeError = workspaceConfigError(config);
  if (shapeError) return invalid(shapeError);
  if (config.model !== undefined) config.model = config.model.trim();
  return { config, error: null };
}

// 只返回工作区统一模型；没有配置时返回 undefined，启动层因此不传 --model。
// 配置无效时同样没有可用模型，但巡检会在到达启动前停下。
export function configuredModel(workspaceConfig) {
  return workspaceConfig.config?.model;
}

// 只支持具有非空字符串 id 的任务。缺少有效 id 的条目由调用方展示并跳过，
// 不再生成匿名内容键或为其启动会话。
export function taskKey(t) {
  return typeof t?.id === 'string' && t.id !== '' ? t.id : null;
}

// 任务的稳定内容签名：只含不会被我们与调度器改动的字段。改小 id、盖印改
// createdBy*、执行改 lastFiredAt、续期加 permanent 都不改变签名，用于认回
// 任务文件已改号而 state 尚未落盘的崩溃窗口。
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
    if (key === null) continue;
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

// 任务归属是否已完全等于盖印目标。巡检预判与实际写入共用同一判据，
// 避免一层只看 sessionId、另一层比较三字段而逐渐漂移。
export function taskOwnedBy(t, target) {
  return t.createdBySessionId === target.sessionId
    && t.createdByPid === target.pid
    && t.createdByProcStart === target.procStart;
}

// 严格 8 位十六进制的原生任务 id 转数值；其他形状都算需要规范化。
export function parseTaskIdN(id) {
  if (typeof id !== 'string' || !/^[0-9a-fA-F]{8}$/.test(id)) return null;
  return parseInt(id, 16);
}

function taskNeedsMinify(t, maxN) {
  if (!isPlainObject(t) || !t.recurring || taskKey(t) === null) return false;
  const n = parseTaskIdN(t.id);
  return n === null || n > maxN;
}

// 无条件把具有有效 id 的显式周期任务的大 id 改成未占用的小号，消除上游按
// id 计算的投递偏移。只原地修改 tasks，返回 {changed,idChanges} 供巡检同步
// state、pending 与 Herdr 标签；写盘仍由 maintainWorkspace 合并完成。
// reservedIds 排除不在当前任务文件里的 state 键，避免新任务继承旧会话。
// - 一次性任务、无有效 id 和没有 recurring 标志的手写条目不碰；
// - 已达标的小号（含 00000000）原样保留，第二轮起字节级不动；
// - 空号分配考虑文件内全部任务，包括一次性任务；
// - 原始任务键重复时无法唯一对应 state 和会话，整组跳过，不靠改号掩盖异常。
export function minifyIds(tasks, reservedIds = []) {
  const maxN = minTaskIdMaxN();
  const used = new Set();
  for (const id of reservedIds) {
    const n = parseTaskIdN(id);
    if (n !== null) used.add(n);
  }
  const taskGroups = groupTasksByKey(tasks);
  for (const t of tasks) {
    if (!isPlainObject(t)) continue;
    const n = parseTaskIdN(t.id);
    if (n !== null) used.add(n);
  }
  let next = 1;
  const takeFree = () => {
    while (used.has(next)) next += 1;
    // 小号耗尽时保留原 id，不能分一个同样不达标的号导致每轮重改。
    if (next > maxN) return null;
    used.add(next);
    return next;
  };
  let changed = 0;
  const idChanges = [];
  for (const t of tasks) {
    if (!taskNeedsMinify(t, maxN)) continue;
    const from = taskKey(t);
    if (taskGroups.get(from)?.length !== 1) continue;
    const free = takeFree();
    if (free === null) continue;
    const to = free.toString(16).padStart(8, '0');
    t.id = to;
    changed += 1;
    idChanges.push({ from, to });
  }
  return { changed, idChanges };
}

// 一轮巡检对一个任务文件做的维护：renew（补 permanent）、minify（周期任务
// id 改小）与 reown（归属盖给各自预热会话）合并为同一次带 mtime 乐观检测
// 的原子写。先取 mtimeNs、清残留 .cron-up-tmp、loadTaskDoc round-trip 整
// 文档；三项都为 0 时字节级不动。返回 {renewed,minified,reowned,idChanges}，
// 有实际盖印时另附 reownedTasks=[{taskId,target}]；null 表示文件缺失/损坏；
// 读到写间被改抛 TaskFileChanged。
//
// reown 形状：Map<taskKey, {sessionId, pid, procStart}>，键是调用方读到的
// 改号前任务键。minify 后先翻译成新键再盖印，返回的 reownedTasks 也使用新键。
// 同一个 taskKey 对应多条任务时无法唯一映射，这些键跳过盖印；minify 同样跳过。
// reservedIds 是调用方仍需保留的 state 键。minify=false 只供同轮补盖：首轮
// 维护已负责改号和迁移，补盖若再次改号会绕过 state/pending/Herdr 同步。
export function maintainWorkspace(
  taskfile, { reown = null, minify = true, reservedIds = [] } = {},
) {
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
    if (!isPlainObject(t) || taskKey(t) === null) continue;
    // truthy 而非 === true：与 Claude Code 自己的加载器一致
    // （...o.permanent && {permanent:true}），它已认作永久的任何值都算，
    // 不再重写。只有显式周期任务有资格——绝不从 cron 形状推断周期性，
    // 一次性任务不碰。
    if (t.recurring && !t.permanent) {
      t.permanent = true;
      renewed += 1;
    }
  }
  const minIdMaxN = minTaskIdMaxN();
  const mayMinify = minify
    && doc.tasks.some((t) => taskNeedsMinify(t, minIdMaxN));
  const { changed: minified, idChanges } = mayMinify
    ? minifyIds(doc.tasks, reservedIds)
    : { changed: 0, idChanges: [] };
  const renamed = new Map(idChanges.map((c) => [c.from, c.to]));
  const effectiveReown = new Map();
  if (reown instanceof Map) {
    for (const [key, target] of reown) {
      effectiveReown.set(renamed.get(key) ?? key, target);
    }
  }
  const reownedTasks = [];
  if (effectiveReown.size > 0) {
    for (const [key, group] of groupTasksByKey(doc.tasks)) {
      if (group.length !== 1) continue;
      const t = group[0];
      const target = effectiveReown.get(key);
      // 没有 owner 字段的外部条目同样盖——窗口内任务统一归各自预热，语义
      // 不因条目来源留例外。
      if (target && !taskOwnedBy(t, target)) {
        t.createdBySessionId = target.sessionId;
        t.createdByPid = target.pid;
        // ps lstart 原文（含「Oct  8」双空格），原样取自会话登记。
        t.createdByProcStart = target.procStart;
        reownedTasks.push({ taskId: key, target });
      }
    }
  }
  if (renewed === 0 && minified === 0 && reownedTasks.length === 0) {
    return { renewed: 0, minified: 0, reowned: 0, idChanges: [] };
  }
  atomicWriteJson(taskfile, doc, mtimeNs);
  const result = {
    renewed, minified, reowned: reownedTasks.length, idChanges,
  };
  if (reownedTasks.length > 0) result.reownedTasks = reownedTasks;
  return result;
}

Object.assign(deps, { discover, readTasks, loadTaskDoc });
