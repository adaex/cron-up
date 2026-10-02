// config.json / state.json 的读写与校验。两份文件都可能被手改，入口处统
// 一规范化形状，launchd 入口任何损坏都死成一行人能读的原因（退出码 2）。

import fs from 'node:fs';
import path from 'node:path';

import { deps, ExitError, isPlainObject, isDecInt } from './internals.mjs';
import { DEFAULT_CONFIG, PID_T_MAX, HEARTBEAT_STALE_FACTOR } from './constants.mjs';
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

// 配置数值校验用：JSON 的 true 是布尔不能冒充秒数/深度
// （Number.isInteger(true) === false，天然挡住）。
export function isInt(x) {
  return typeof x === 'number' && Number.isInteger(x);
}

// 宽容整型化（手改的 state/登记文件里字段可能是字符串或浮点）：纯十进制
// 字符串接受，浮点截断，布尔拒绝；非法输入抛错由调用方按「字段不存在」
// 处理。
export function lenientInt(v) {
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
  let pid;
  try {
    pid = lenientInt(v);
  } catch {
    return null;
  }
  return pid > 0 && pid <= PID_T_MAX ? pid : null;
}

// 配置字段的类型规则，loadConfig 与 install --force 继承旧配置共用。返回
// [字段名, 人话错误][]：手改把字段写坏时绝不静默回退——回退的两个可能方向
// （roots 坏 → 回扫整个家目录、autoRenew 坏 → 回开续期）都比停机更危险。
export function configFieldErrors(cfg) {
  const errs = [];
  if (!Array.isArray(cfg.roots)) {
    errs.push(['roots', `roots 应是字符串数组，当前为 ${JSON.stringify(cfg.roots)}`]);
  }
  if (!isInt(cfg.maxDepth) || cfg.maxDepth < 0) {
    errs.push(['maxDepth', `maxDepth 应是非负整数，当前为 ${JSON.stringify(cfg.maxDepth)}`]);
  }
  if (!isInt(cfg.intervalSeconds) || cfg.intervalSeconds <= 0) {
    errs.push(['intervalSeconds',
      `intervalSeconds 应是正整数秒，当前为 ${JSON.stringify(cfg.intervalSeconds)}`]);
  }
  if (!isInt(cfg.leadSeconds) || cfg.leadSeconds < 0) {
    errs.push(['leadSeconds',
      `leadSeconds 应是非负整数秒，当前为 ${JSON.stringify(cfg.leadSeconds)}`]);
  }
  if (typeof cfg.autoRenew !== 'boolean') {
    errs.push(['autoRenew',
      `autoRenew 应是布尔值（true/false），当前为 ${JSON.stringify(cfg.autoRenew)}`]);
  }
  if (typeof cfg.autoMinId !== 'boolean') {
    errs.push(['autoMinId',
      `autoMinId 应是布尔值（true/false），当前为 ${JSON.stringify(cfg.autoMinId)}`]);
  }
  if (cfg.sessionRetain !== 'window' && cfg.sessionRetain !== 'always') {
    errs.push(['sessionRetain',
      `sessionRetain 应是 "window" 或 "always"，当前为 ${JSON.stringify(cfg.sessionRetain)}`]);
  }
  return errs;
}

// opts.missingOk：缺失文件把异常抛给调用方（总览页把「缺失」当页面内容的
// 一部分）；opts.corruptOk：损坏 JSON/顶层非对象/字段类型错抛普通错误而非
// exit（总览页把它们当页面内容展示）。launchd 的 run 入口两个都不要——它
// 该死成一行原因而不是 traceback。
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
    // 合法 JSON 但顶层不是对象（123、["a"]）：与「不是合法 JSON」同等对待。
    // 单行消息：总览页按宽度截断展示，断行会失去告警前缀。
    fail(`配置文件顶层应是 JSON 对象而不是${Array.isArray(cfg) ? '数组' : typeof cfg}：`
      + `${file}；运行 cron-up install 生成，或用 --config 指定路径`);
  }
  const merged = { ...DEFAULT_CONFIG, ...cfg };
  const errs = configFieldErrors(merged);
  if (errs.length > 0) {
    // 单行消息（字段在前、修复指引在后）：总览页按宽度截断展示，截尾只
    // 伤修复指引，不伤字段清单。
    fail(`配置字段类型不对：${errs.map(([, m]) => m).join('；')}`
      + `；修复 ${file} 或重跑 cron-up install --force`);
  }
  merged.roots = normalizeRoots(merged.roots);
  return merged;
}

// 自己的文件也可能被手改或截断：非对象读成「没有 state」，数值字段入口处
// 整型化并卡范围——否则 kill 收到字符串会抛、负数 pid 会被当成进程组号
// 误伤无辜进程组、超 pid_t 上界的整数直到 kill 才炸。
export function loadState() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(deps.paths.statePath, 'utf-8'));
  } catch {
    return {};
  }
  if (!isPlainObject(state)) return {};
  const out = {};
  for (const [ws, raw] of Object.entries(state)) {
    if (!isPlainObject(raw)) continue;
    const ent = { ...raw };
    ent.pid = parsePid(ent.pid);
    for (const k of ['startedAt', 'cooldownUntil', 'fails', 'deadSince']) {
      if (ent[k] !== null && ent[k] !== undefined) {
        try {
          ent[k] = lenientInt(ent[k]);
        } catch {
          delete ent[k];
        }
      }
    }
    out[ws] = ent;
  }
  return out;
}

// 自产物按私密收紧（与会话日志、任务文件写入同一纪律）：state 含工作区路
// 径与 pid，多用户机器上不给其他账号读面。chmod 顺带收回老版本留下的宽松
// 权限——state 每轮都写、config 每次 install 都写，存量会自动跟进；失败维
// 持现状。
function atomicSave(file, doc) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // 维持现状。
  }
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

export function saveConfig(cfg) {
  atomicSave(deps.paths.configPath, cfg);
}

// 软检查（不致命）：返回警告字符串列表，逐条 announce。
export function validateConfig(cfg, announce = () => {}) {
  const warnings = [];
  if (!cfg.roots || cfg.roots.length === 0) {
    warnings.push('扫描目录 roots 为空：巡检不会发现任何工作区，cron-up 形同空转');
  }
  const interval = cfg.intervalSeconds;
  const lead = cfg.leadSeconds;
  if (isInt(interval) && isInt(lead) && interval > 0 && lead >= 0
      && lead < interval) {
    warnings.push(
      `leadSeconds=${lead} 小于 intervalSeconds=${interval}：任务可能在`
      + '两轮巡检之间到期而来不及提前启动会话，建议 lead ≥ interval');
  }
  for (const root of cfg.roots ?? []) {
    if (!isDir(root)) warnings.push(`扫描目录不存在，巡检不会覆盖它：${root}`);
  }
  for (const w of warnings) announce(`警告：${w}`);
  return warnings;
}
