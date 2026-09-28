// config.json / state.json 的读写与校验。两份文件都可能被手改，入口处统
// 一规范化形状，launchd 入口任何损坏都死成一行人能读的原因（退出码 2）。

import fs from 'node:fs';
import path from 'node:path';

import { deps, ExitError } from './internals.mjs';
import { DEFAULT_CONFIG, PID_T_MAX } from './constants.mjs';
import { expandHome } from './tasks.mjs';

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

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// 配置数值校验用：JSON 的 true 是布尔不能冒充秒数/深度
// （Number.isInteger(true) === false，天然挡住）。
export function isInt(x) {
  return typeof x === 'number' && Number.isInteger(x);
}

// 仿真 Python int() 对手改 state 的宽容度：数字字符串按纯十进制接受，浮点
// 截断，布尔拒绝；非法输入抛错由调用方按「字段不存在」处理。
export function pyInt(v) {
  if (typeof v === 'boolean') throw new Error('布尔不是整数字段');
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('数值越界');
    return Math.trunc(v); // 1.5 → 1
  }
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) {
    return parseInt(v.trim(), 10);
  }
  throw new Error(`无法整型化：${String(v)}`);
}

// opts.missingOk：缺失文件把异常抛给调用方（总览页把「缺失」当页面内容的
// 一部分）；opts.corruptOk：损坏 JSON/非对象抛错而不是 exit。launchd 的
// run 入口两个都不要——它该死成一行原因而不是 traceback。
export function loadConfig(file, opts = {}) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      if (opts.missingOk) throw e;
      throw new ExitError(2,
        `配置文件读不到：${file}\n  运行 cron-ready install 生成，`
        + '或用 --config 指定路径');
    }
    if (opts.corruptOk) throw e;
    throw new ExitError(2, `配置文件不是合法 JSON：${file}\n  ${e.message}`);
  }
  if (!isPlainObject(cfg)) {
    // 合法 JSON 但顶层不是对象（123、["a"]）：与「不是合法 JSON」同等对待。
    if (opts.corruptOk) {
      throw new Error(`配置文件顶层应是 JSON 对象：${file}`);
    }
    throw new ExitError(2,
      `配置文件顶层应是 JSON 对象而不是${Array.isArray(cfg) ? '数组' : typeof cfg}：`
      + `${file}\n  运行 cron-ready install 生成，或用 --config 指定路径`);
  }
  const merged = { ...DEFAULT_CONFIG, ...cfg };
  if (!Array.isArray(merged.roots)) merged.roots = DEFAULT_CONFIG.roots;
  merged.roots = normalizeRoots(merged.roots);
  if (!isInt(merged.maxDepth) || merged.maxDepth < 0) {
    merged.maxDepth = DEFAULT_CONFIG.maxDepth;
  }
  if (typeof merged.autoRenew !== 'boolean') {
    merged.autoRenew = DEFAULT_CONFIG.autoRenew;
  }
  return merged;
}

// 自己的文件也可能被手改或截断：非对象读成「没有 state」，数值字段入口处
// 整型化并卡范围——否则 waitpid/killpg 收到字符串会抛、负数 pid 会被当成
// 进程组号误伤无辜进程组、超 pid_t 上界的整数直到 kill 才炸。
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
    let pid = null;
    try {
      pid = pyInt(ent.pid);
    } catch {
      pid = null;
    }
    ent.pid = pid && pid > 0 && pid <= PID_T_MAX ? pid : null;
    for (const k of ['startedAt', 'cooldownUntil', 'fails']) {
      if (ent[k] !== null && ent[k] !== undefined) {
        try {
          ent[k] = pyInt(ent[k]);
        } catch {
          delete ent[k];
        }
      }
    }
    out[ws] = ent;
  }
  return out;
}

function atomicSave(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function saveState(state) {
  atomicSave(deps.paths.statePath, state);
}

export function saveConfig(cfg) {
  atomicSave(deps.paths.configPath, cfg);
}

// 软检查（不致命）：返回警告字符串列表，逐条 announce。
export function validateConfig(cfg, announce = () => {}) {
  const warnings = [];
  if (!cfg.roots || cfg.roots.length === 0) {
    warnings.push('扫描目录 roots 为空：巡检不会发现任何工作区，cron-ready 形同空转');
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
    let dir = false;
    try {
      dir = fs.statSync(root).isDirectory();
    } catch {
      dir = false;
    }
    if (!dir) warnings.push(`扫描目录不存在，巡检不会覆盖它：${root}`);
  }
  for (const w of warnings) announce(`警告：${w}`);
  return warnings;
}
