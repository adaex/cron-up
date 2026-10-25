// config.json / state.json 的读写与校验。两份文件都可能被手改，入口处统
// 一规范化形状，launchd 入口任何损坏都死成一行人能读的原因（退出码 2）。

import fs from 'node:fs';
import path from 'node:path';

import {
  deps,
  ExitError,
  isPlainObject,
  isDecInt,
  ensurePrivateDir,
  setOwn,
} from './internals.mjs';
import { PID_T_MAX, HEARTBEAT_STALE_FACTOR } from './constants.mjs';
import { expandHome, isDir } from './tasks.mjs';

// Shell 的 tilde 展开只发生在词首："--roots ~/a,~/b" 穿过 shell 后第二个
// 条目前的 ~ 还在。读和写两边都规范化，配置里永远存绝对路径。
// 非字符串元素（手改混入数字等）跳过，不在 trim 上崩。
export function normalizeRoots(roots) {
  const out = [];
  for (const r of roots ?? []) {
    if (typeof r !== 'string') continue;
    const s = r.trim();
    if (!s) continue;
    out.push(path.resolve(expandHome(s)));
  }
  return out;
}

// 手改的 state/登记文件里的整数字段可能是字符串或浮点：纯十进制字符串接受，
// 浮点截断，布尔拒绝；非法输入抛错由调用方按「字段不存在」处理。pid 另有
// 更严的入口，不允许浮点截断。
function lenientInt(v) {
  if (typeof v === 'boolean') throw new Error('布尔不是整数字段');
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('数值越界');
    return Math.trunc(v); // 1.5 → 1
  }
  if (typeof v === 'string' && isDecInt(v.trim())) {
    return parseInt(v.trim(), 10);
  }
  throw new Error(`无法整型化：${String(v)}`);
}

// pid 清洗：宽容解析后卡 pid_t 值域，不合法返回 null。state.json 与会话
// 登记两个外部来源共用同一条入口规则——超大整数能穿过类型转换直到
// process.kill 才抛，负数 pid 会被 kill 当成进程组号误伤无辜进程组。
export function parsePid(v) {
  // number 必须本身就是整数：1.5 截成 1 可能把停止信号发给完全无关的
  // pid。字符串仍走纯十进制解析，不接受小数、指数或十六进制。
  if (typeof v === 'number' && !Number.isInteger(v)) return null;
  let pid;
  try {
    pid = lenientInt(v);
  } catch {
    return null;
  }
  return pid > 0 && pid <= PID_T_MAX ? pid : null;
}

// 配置只有 roots 一个字段：手改写坏它时绝不静默回退——回退成空数组是
// 「形同空转」，回退成默认家目录扫描则会动到用户没打算纳入的仓库，两个
// 方向都比停机更危险。
export function configFieldErrors(cfg) {
  if (!Object.hasOwn(cfg, 'roots') || !Array.isArray(cfg.roots)) {
    return [['roots', `roots 应是字符串数组，当前为 ${JSON.stringify(cfg.roots)}`]];
  }
  return [];
}

// opts.missingOk：缺失文件把异常抛给调用方（总览页把「缺失」当页面内容的
// 一部分）；opts.corruptOk：损坏 JSON/顶层不是对象/roots 类型错抛普通错
// 误而非 exit（总览页把它们当页面内容展示）。launchd 的 run 入口两个都不
// 要——它该死成一行原因而不是 traceback。配置里的其余键（旧版本留下的
// intervalSeconds 等）一律忽略：行为已全部常量化，install 重写时纯化。
export function loadConfig(file, opts = {}) {
  const fail = (message) => {
    if (opts.corruptOk) throw new Error(message);
    throw new ExitError(2, message);
  };
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      if (opts.missingOk) throw e;
      throw new ExitError(2,
        `配置文件读不到：${file}\n  运行 cron-up install 生成，`
        + '或用 --config 指定路径');
    }
    if (opts.corruptOk) throw e;
    throw new ExitError(2, `配置文件不是合法 JSON：${file}\n  ${e.message}`);
  }
  if (!isPlainObject(cfg)) {
    fail(`配置文件顶层应是 JSON 对象而不是${Array.isArray(cfg) ? '数组' : typeof cfg}：`
      + `${file}；运行 cron-up install 生成，或用 --config 指定路径`);
  }
  // 文件已经存在就必须自己声明 roots；这里绝不补默认值。默认扫描范围只
  // 属于首次 install 或明确的安装修复，读取配置时补上会静默扩大巡检范围。
  const errs = configFieldErrors(cfg);
  if (errs.length > 0) {
    fail(`配置字段类型不对：${errs.map(([, m]) => m).join('；')}`
      + `；修复 ${file} 或重跑 cron-up install`);
  }
  return { roots: normalizeRoots(cfg.roots) };
}

// ---- state.json：两级嵌套 {ws: {taskId: entry}} ----
//
// entry 字段：pid/procStart（script 层指纹）、claudePid/sessionId/
// claudeProcStart（认亲后回填）、startedAt、fails、cooldownUntil、
// deadSince、log、notified。pid 为 null 的条目是「当场没拉起/冷却中」的
// 合法形态；未认亲时 claude* 三字段缺省。

// 旧版顶层标记字段只用于识别「值仍是标量的扁平 entry」，不能单独拿键名
// 判代：手工任务 id 也可以叫 pid/startedAt。新桶的自有值里会有任务 entry
// 对象，旧扁平 entry 的字段值则是标量或 null，先看这个值结构再分代。
const LEGACY_MARKERS = ['pid', 'startedAt', 'cooldownUntil', 'fails'];

function cleanEntry(raw, ws, taskId) {
  if (!isPlainObject(raw)) return null;
  const ent = { ...raw };
  ent.pid = parsePid(ent.pid);
  if (ent.claudePid !== undefined) {
    const claudePid = parsePid(ent.claudePid);
    if (claudePid === null) delete ent.claudePid;
    else ent.claudePid = claudePid;
  }
  for (const k of ['startedAt', 'cooldownUntil', 'fails', 'deadSince']) {
    if (ent[k] !== null && ent[k] !== undefined) {
      try {
        ent[k] = lenientInt(ent[k]);
      } catch {
        delete ent[k];
      }
    }
  }
  // 身份字符串：存在就必须是非空字符串，否则删掉（ws/taskId 随即用键补
  // 回）。
  for (const k of ['ws', 'taskId', 'sessionId', 'log', 'procStart',
    'claudeProcStart']) {
    if (ent[k] !== undefined
        && (typeof ent[k] !== 'string' || ent[k] === '')) {
      delete ent[k];
    }
  }
  if (typeof ent.notified !== 'boolean') delete ent.notified;
  ent.ws = ws;
  ent.taskId = taskId;
  return ent;
}

function hasNestedEntries(v) {
  return isPlainObject(v) && Object.values(v).some(isPlainObject);
}

function looksLegacyEntry(v) {
  return isPlainObject(v) && !hasNestedEntries(v)
    && LEGACY_MARKERS.some((k) => Object.hasOwn(v, k));
}

export function loadState() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(deps.paths.statePath, 'utf-8'));
  } catch {
    return {};
  }
  if (!isPlainObject(state)) return {};
  const out = {};
  for (const [ws, bucket] of Object.entries(state)) {
    // 旧版顶层 entry 不是桶：跳过（由 loadLegacyEntries 收口处理）。
    if (!isPlainObject(bucket) || looksLegacyEntry(bucket)) continue;
    const cleanBucket = {};
    for (const [taskId, raw] of Object.entries(bucket)) {
      const ent = cleanEntry(raw, ws, taskId);
      if (ent) setOwn(cleanBucket, taskId, ent);
    }
    if (Object.keys(cleanBucket).length > 0) setOwn(out, ws, cleanBucket);
  }
  return out;
}

// 旧版扁平 state（{ws: 目录级单 entry}）：升级轮用它停掉旧预热后整体丢
// 弃，不迁移任务归属（新流程按任务重拉）。与 loadState 读同一个文件，
// 两个读取器按值结构与标记字段互斥，互不污染。
export function loadLegacyEntries() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(deps.paths.statePath, 'utf-8'));
  } catch {
    return [];
  }
  if (!isPlainObject(state)) return [];
  const out = [];
  for (const [ws, raw] of Object.entries(state)) {
    if (!looksLegacyEntry(raw)) continue;
    const ent = cleanEntry(raw, ws, null);
    if (ent) {
      delete ent.taskId; // 旧 entry 没有任务身份
      out.push(ent);
    }
  }
  return out;
}

// state 含工作区路径与 pid，目录按 ensurePrivateDir 收紧；文件以 0600 原
// 子替换——state 每轮都写、config 每次 install 都写，老版本留下的宽松权
// 限会自动跟进。
function atomicSave(file, doc) {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  // 以 0600 创建；残留的旧 tmp 更宽时也收回来，rename 保持该模式位。
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, {
    flag: 'w',
    mode: 0o600,
  });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // 维持 0600。
  }
  fs.renameSync(tmp, file);
}

export function saveState(state) {
  atomicSave(deps.paths.statePath, state);
}

// 巡检心跳：每轮成功跑完覆盖写一次。轮首读它发现漏轮（距上次超过两个间
// 隔），总览页读它报「服务在但巡检没在跑」。缺失/损坏/形状不对一律读作
// 没有心跳——旧版本升级后的首轮、与总览读到半截文件都按此降级。
export function loadHeartbeat() {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(deps.paths.heartbeatPath, 'utf-8'));
  } catch {
    return null;
  }
  if (!isPlainObject(doc) || !Number.isFinite(doc.ranAt)) return null;
  return doc;
}

export function saveHeartbeat(doc) {
  atomicSave(deps.paths.heartbeatPath, doc);
}

// 心跳是否已沉默超过 HEARTBEAT_STALE_FACTOR 个轮次间隔：轮首的漏轮提示与
// 总览页的「服务在但巡检没在跑」共用同一判据，两边不会各说各话。
export function heartbeatStale(hb, intervalSeconds, nowSec) {
  return hb !== null && nowSec - hb.ranAt > intervalSeconds * HEARTBEAT_STALE_FACTOR;
}

// 失败冷却的唯一判据：cooldownUntil 是秒级时间戳，0/缺省表示无冷却。巡检
// 决策、kept 过滤与总览展示共用，冷却表示法只渗到这两个函数。
export function isCooling(ent, cur) {
  return (ent?.cooldownUntil ?? 0) > cur;
}

// 距冷却结束还有多少整分钟（已结束为 0），只用于总览文案。
export function cooldownEtaMinutes(ent, cur) {
  return Math.max(0, Math.floor(((ent?.cooldownUntil ?? 0) - cur) / 60));
}

export function saveConfig(cfg) {
  atomicSave(deps.paths.configPath, cfg);
}

// 软检查（不致命）：返回警告字符串列表，逐条 announce。
export function validateConfig(cfg, announce = () => {}) {
  const warnings = [];
  if (!cfg.roots || cfg.roots.length === 0) {
    warnings.push('扫描目录 roots 为空：巡检不会发现任何工作区，cron-up 形同空转');
  }
  for (const root of cfg.roots ?? []) {
    if (!isDir(root)) warnings.push(`扫描目录不存在，巡检不会覆盖它：${root}`);
  }
  for (const w of warnings) announce(`警告：${w}`);
  return warnings;
}
