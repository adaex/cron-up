// 预热会话由 Herdr 托管：zsh → claude，终端地址用于展示、认领、停止与
// 历史读取。state 保存根 pid 和启动指纹，供 Claude 登记认亲、低开销存活
// 检查及停止前身份核验使用。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { deps, ExitError, isExecutableFile } from './internals.mjs';
import {
  HERDR_SPACE_ID,
  HERDR_ANCHOR_CWD,
  HERDR_ANCHOR_TAB_ID,
  HERDR_ANCHOR_KEY,
} from './constants.mjs';

// pid 是否对应活进程。走到这儿的 pid 已经过入口范围校验。
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ps 报告的进程启动时间，作为 pid 的身份指纹：macOS 高负载下几小时就回收
// pid，单靠 kill -0 分不出我们的预热会话和后来继承同一编号的进程。
export function procStartedAt(pid) {
  // 固定 locale，避免手动 run 与 launchd 的日期格式不同而误判 pid 复用。
  const r = deps.execFile(
    '/bin/ps',
    ['-p', String(pid), '-o', 'lstart='],
    { env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, timeout: 5000 },
  );
  const out = (r.stdout ?? '').trim();
  return out || null;
}

// 仅当记录的 pid 仍是我们当初启动的那个进程时为 true。
export function trackedAlive(ent) {
  if (!ent?.pid || !ent.procStart || !deps.alive(ent.pid)) return false;
  return deps.procStartedAt(ent.pid) === ent.procStart;
}

// POSIX shell 引用：安全字符白名单内原样返回，否则单引号包裹。
export function shellQuote(s) {
  if (s === '') return "''";
  if (/^[-@%+=:,./\w]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

// launchd 的 PATH 不一定包含 Herdr 的默认链接目录，因此同时检查 PATH 与
// ~/.local/bin/hc；install 会把实际解析到的 hc 目录写进服务 PATH。
export function findHerdr(env = process.env) {
  const candidates = (env.PATH ?? '').split(path.delimiter).filter(Boolean)
    // install 会把所在目录写进 launchd PATH，不能保留依赖调用方 cwd 的相对路径。
    .map((dir) => path.resolve(dir, 'hc'));
  if (deps.paths.home) {
    candidates.push(path.join(deps.paths.home, '.local', 'bin', 'hc'));
  }
  for (const file of new Set(candidates)) {
    if (isExecutableFile(file)) return file;
  }
  return null;
}

export function requireHerdr() {
  const hc = deps.findHerdr();
  if (!hc) {
    throw new ExitError(2, '未找到 Herdr Core 的 hc 命令；请先安装 Herdr，'
      + '并确保 hc 位于 PATH 或 ~/.local/bin/hc');
  }
  return hc;
}

export function herdrSessionArgv(hc, ws, taskId, model, name) {
  // Herdr 使用 core 的登录会话环境，不继承巡检调用方。-lic 按 zsh 自己的
  // 规则加载完整配置，让 claude 函数与路由生效，无需手工 source 或清理环境。
  // Claude 原生 --name 同时命名会话与终端标题；只透传显式配置的模型，
  // 权限模式及其余行为服从 Claude Code 自身配置。
  const namePart = name ? ` --name ${shellQuote(name)}` : '';
  const modelPart = model ? ` --model ${shellQuote(model)}` : '';
  return [
    hc, 'run', '--json', '--bg', '--no-parent',
    '--cwd', ws,
    '--label', `cron-up=${taskId}`,
    '--label', `herdr.space=${HERDR_SPACE_ID}`,
    '/bin/zsh', '-lic', `claude${namePart}${modelPart}`,
  ];
}

export function herdrAnchorArgv(hc, cwd = HERDR_ANCHOR_CWD) {
  return [
    hc, 'run', '--json', '--bg', '--no-parent',
    '--cwd', cwd,
    '--label', `${HERDR_ANCHOR_KEY}=1`,
    '--label', `herdr.space=${HERDR_SPACE_ID}`,
    '--label', `herdr.tab=${HERDR_ANCHOR_TAB_ID}`,
    '/bin/zsh', '-il',
  ];
}

function herdrResultDetail(result) {
  return (result?.stderr ?? '').trim() || (result?.stdout ?? '').trim()
    || `退出码 ${result?.status ?? '未知'}`;
}

function nameHerdrAnchor(hc, address) {
  const command = `printf '\\033]0;%s\\a' ${shellQuote(HERDR_ANCHOR_TAB_ID)}`;
  try {
    const sent = deps.execFile(hc, ['send', address, command], { timeout: 15000 });
    return sent.status === 0 ? null : herdrResultDetail(sent);
  } catch (e) {
    return e?.message ?? String(e);
  }
}

// 临时命名方案：仅在确实要新建任务会话时由巡检调用，hc 原生支持所需 space
// 能力后删除。按独立标签检查锚点，任一存活锚点存在就复用，绝不重复启动；
// 确认缺失后才创建目录并启动普通 zsh。查询失败
// 直接抛出，避免把证据不足当成缺失。返回 null 表示复用，启动成功返回终端
// 身份；命名失败附带 titleError，由巡检单独告警。这里不查询或调整 tab
// 顺序，默认显示名只是尽力效果。
export function ensureHerdrAnchor(hc, cwd = HERDR_ANCHOR_CWD) {
  const existing = queryHerdrTerminals(hc, `${HERDR_ANCHOR_KEY}=1`)
    .find((t) => t.kind === 'anchor' && deps.alive(t.pid));
  if (existing) return null;
  fs.mkdirSync(cwd, { recursive: true });
  const launched = launchHerdrTerminal(herdrAnchorArgv(hc, cwd));
  // 只给本轮新锚点命名：启动后由 zsh 输出一次 OSC，既不把命令塞回启动
  // 参数，也不在后续巡检反复打扰这个可供人使用的交互 shell。
  const titleError = nameHerdrAnchor(hc, launched.herdr);
  return { ...launched, ...(titleError ? { titleError } : {}) };
}

// 周期任务 id 改小后，把既有 Herdr 终端的机器标签同步到新 taskId。state
// 只在旧标签与 taskId 不同时保存 herdrTaskId：同步失败时停止前身份核对仍按
// 旧标签进行；标签确认一致后删除该字段，读取方直接回退到 taskId。
// 返回 null 表示标签已经确认是目标值，否则返回可供日志展示的失败原因。
export function syncHerdrTaskId(ent) {
  const target = ent?.taskId;
  if (typeof target !== 'string' || target === '') return '目标任务 id 无效';
  if (typeof ent?.herdr !== 'string') return '缺少 Herdr 终端地址';
  const hc = deps.findHerdr();
  if (!hc) return '未找到 hc 命令';
  const { result, terminal } = herdrTerminal(hc, 'get', ent.herdr);
  if (!terminal) return herdrResultDetail(result);
  if (terminal.pid !== ent.pid || terminal.cwd !== ent.ws) {
    return '终端 pid 或工作区与 state 不一致';
  }
  const current = terminal.labels?.['cron-up'];
  if (current === target) {
    // 覆盖「标签已写、state 尚未落盘就进程退出」的恢复窗口。
    delete ent.herdrTaskId;
    return null;
  }
  const expected = ent.herdrTaskId ?? ent.taskId;
  if (current !== expected) {
    return `终端任务标签 ${String(current)} 与预期 ${expected} 不一致`;
  }
  const labelled = deps.execFile(hc, ['label', ent.herdr, `cron-up=${target}`],
    { timeout: 5000 });
  if (labelled.status !== 0) return herdrResultDetail(labelled);
  delete ent.herdrTaskId;
  return null;
}

// get 与 kill 都以 --json 返回完整 Terminal；run/ls 的 JSON 只是摘要，不能
// 用它们替代这里的身份查询。kill 会等待停止结束并返回最终 state。
function herdrTerminal(hc, command, address, timeout = 5000) {
  const result = deps.execFile(hc, [command, '--json', address], { timeout });
  if (result.status !== 0) return { result, terminal: null };
  try {
    return { result, terminal: JSON.parse(result.stdout) };
  } catch {
    return { result, terminal: null };
  }
}

// 启动一个 Herdr 终端。成功返回扁平身份；失败抛错。已经拿到地址后的任何
// 失败都先尝试清理刚创建的终端，调用方不直拉第二个，避免启动结果不明时双开。
function launchHerdrTerminal(argv) {
  const run = deps.execFile(argv[0], argv.slice(1), { timeout: 15000 });
  if (run.status !== 0) throw new Error(herdrResultDetail(run));

  let launched;
  try {
    launched = JSON.parse(run.stdout);
  } catch {
    launched = null;
  }
  const address = launched?.address;
  if (typeof address !== 'string' || address === '') {
    throw new Error('hc run 未返回终端地址');
  }

  const hc = argv[0];
  const fail = (reason) => {
    const { result, terminal } = herdrTerminal(hc, 'kill', address, 10000);
    const cleanup = terminal?.state === 'finished'
      ? '已清理刚创建的 Herdr 终端'
      : `清理 Herdr 终端失败：${herdrResultDetail(result)}`;
    throw new Error(`终端 ${address}：${reason}；${cleanup}`);
  };

  const { result: get, terminal } = herdrTerminal(hc, 'get', address, 15000);
  const pid = terminal?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    return fail(get.status === 0
      ? 'hc get 未返回有效的根进程 pid' : herdrResultDetail(get));
  }

  let procStart = null;
  let fingerprintError = null;
  try {
    procStart = deps.procStartedAt(pid);
  } catch (e) {
    fingerprintError = e;
  }
  if (!procStart) {
    return fail(fingerprintError
      ? `读取进程身份指纹失败：${fingerprintError?.message ?? fingerprintError}`
      : '未读到进程身份指纹');
  }
  return { pid, procStart, herdr: address };
}

export function spawnSession(ws, taskId, model, name) {
  const hc = deps.findHerdr();
  if (!hc) {
    deps.log(`Herdr 会话启动失败 ${ws} 任务 ${taskId}：未找到 hc 命令`);
    return null;
  }
  try {
    return launchHerdrTerminal(herdrSessionArgv(hc, ws, taskId, model, name));
  } catch (e) {
    deps.log(`Herdr 会话启动失败 ${ws} 任务 ${taskId}：${e?.message ?? e}`);
    return null;
  }
}

// 核对当前进程指纹与 Herdr 元数据后用 hc kill。pid 必须大于 1，避免
// 0/-1 等广播语义。detached（用户 resume 接管）时 trackedAlive 为 false，
// 绝不碰用户的裸 claude。
export function stopSession(ent) {
  const pid = ent?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 1 || !deps.trackedAlive(ent)) return true;
  if (typeof ent.herdr !== 'string') return false;
  const hc = deps.findHerdr();
  if (!hc) return false;
  const { terminal } = herdrTerminal(hc, 'get', ent.herdr);
  // 地址、pid、工作区和机器标签必须同时吻合，根 pid 指纹已在上面核验。
  // 自动改小任务 id 后标签同步可能失败，此时仍以最后确认的旧标签为准；
  // 锚点不是任务，使用独立标签，不占用任务 id。
  const taskId = ent.herdrTaskId ?? ent.taskId;
  const labelMatches = ent.kind === 'anchor'
    ? terminal?.labels?.[HERDR_ANCHOR_KEY] === '1'
    : terminal?.labels?.['cron-up'] === taskId;
  if (!terminal || terminal.pid !== pid || terminal.cwd !== ent.ws || !labelMatches) {
    return !deps.alive(pid);
  }
  const { terminal: killed } = herdrTerminal(hc, 'kill', ent.herdr, 10000);
  return killed?.state === 'finished' || !deps.alive(pid);
}

// 只在换代候选分支调用：working、缺少终端地址或读取失败都保守视为活跃；
// 否则用可见界面摘要判断静默。
export function sessionIdleSeconds(ent, cur) {
  const hc = typeof ent.herdr === 'string' ? deps.findHerdr() : null;
  if (!hc) {
    ent.herdrActivityAt = cur;
    return 0;
  }
  const { terminal } = herdrTerminal(hc, 'get', ent.herdr);
  if (!terminal || terminal.pid !== ent.pid || terminal.status?.state === 'working') {
    ent.herdrActivityAt = cur;
    return 0;
  }
  const result = deps.execFile(hc, ['read', ent.herdr], { timeout: 5000 });
  if (result.status !== 0) {
    ent.herdrActivityAt = cur;
    return 0;
  }
  const fingerprint = createHash('sha256').update(result.stdout ?? '').digest('hex');
  if (fingerprint !== ent.herdrActivity) {
    ent.herdrActivity = fingerprint;
    ent.herdrActivityAt = cur;
  }
  ent.herdrActivityAt ??= ent.startedAt ?? cur;
  return Math.max(0, cur - ent.herdrActivityAt);
}

function terminalRecord(address, terminal) {
  const labels = terminal?.labels;
  // 同时带两种身份时按任务处理，停止核验仍会要求任务标签吻合；锚点标签
  // 不会让一个已有任务终端改走锚点停止分支。kind 与 taskId 分开，锚点
  // 不需要伪造一个任务 id。
  const anchor = labels?.[HERDR_ANCHOR_KEY] === '1'
    && typeof labels?.['cron-up'] !== 'string';
  const taskId = labels?.['cron-up'];
  if ((!anchor && typeof taskId !== 'string')
      || !Number.isSafeInteger(terminal?.pid) || terminal.pid <= 1) return null;
  // 当前任务由 Claude --name、锚点由 OSC 0 写 Core 的顶层 title；where 是
  // 旧版 cron-up 的显示标签。Core 标题优先展示，旧标题同时保留给日志检索：
  // 旧终端可能已有默认 Core 标题，不能因此让原有 where 查询失效。
  const legacyTitle = typeof labels?.where === 'string' ? labels.where : '';
  const title = typeof terminal?.title === 'string' && terminal.title !== ''
    ? terminal.title : legacyTitle;
  return {
    address,
    cwd: terminal.cwd,
    pid: terminal.pid,
    kind: anchor ? 'anchor' : 'task',
    ...(anchor ? {} : { taskId }),
    state: terminal.state,
    title,
    ...(legacyTitle && legacyTitle !== title ? { legacyTitle } : {}),
  };
}

// 精确地址查询只水合一个终端；找不到或不是 cron-up 终端时返回 null。
export function getHerdrTerminal(address) {
  const hc = requireHerdr();
  const { terminal } = herdrTerminal(hc, 'get', address);
  return terminalRecord(address, terminal);
}

// run/ls 的 JSON 只是摘要，逐终端 get 核对完整标签和 pid。label 为空时
// 返回任务与锚点，供卸载和日志查询；查询失败不能降级成空清单。
function queryHerdrTerminals(hc, label = null, includeFinished = false) {
  const args = ['ls', '--json'];
  if (includeFinished) args.push('--all');
  if (label !== null) args.push('--label', label);
  const listed = deps.execFile(hc, args, { timeout: 5000 });
  if (listed.status !== 0) {
    throw new ExitError(1, `Herdr 终端列表查询失败：${herdrResultDetail(listed)}`);
  }
  let doc;
  try {
    doc = JSON.parse(listed.stdout);
  } catch {
    throw new ExitError(1, 'Herdr 终端列表查询失败：hc ls 返回了无效 JSON');
  }
  if (!Array.isArray(doc?.terminals)) {
    throw new ExitError(1, 'Herdr 终端列表查询失败：hc ls 未返回 terminals 数组');
  }
  const out = [];
  for (const summary of doc.terminals) {
    if (typeof summary?.address !== 'string') continue;
    if (!includeFinished && summary.state !== 'live') continue;
    const { result, terminal } = herdrTerminal(hc, 'get', summary.address);
    // 查询失败不能当作“没有这个终端”：认领会因此双开，卸载会漏停。
    if (!terminal) {
      throw new ExitError(1, `Herdr 终端 ${summary.address} 身份查询失败：`
        + herdrResultDetail(result));
    }
    const record = terminalRecord(summary.address, terminal);
    if (record !== null) out.push(record);
  }
  return out;
}

// taskId 存在时让 core 先按任务标签过滤，返回后再核对一次完整身份。
export function listHerdrTerminals(taskId = null, includeFinished = false) {
  const hc = requireHerdr();
  return queryHerdrTerminals(
    hc, taskId === null ? null : `cron-up=${taskId}`, includeFinished,
  ).filter((record) => taskId === null
    || (record.kind === 'task' && record.taskId === taskId));
}

export function findHerdrOrphan(ws, taskId) {
  const terminal = listHerdrTerminals(taskId)
    .find((t) => t.cwd === ws && deps.alive(t.pid));
  if (!terminal) return null;
  const procStart = deps.procStartedAt(terminal.pid);
  if (!procStart) {
    throw new ExitError(1, `Herdr 终端 ${terminal.address} 的根进程 `
      + `${terminal.pid} 无法读取启动指纹，不能安全认领`);
  }
  return {
    pid: terminal.pid,
    procStart,
    herdr: terminal.address,
  };
}

export function sessionDebugCommand(ent) {
  return typeof ent?.herdr === 'string'
    ? `cron-up logs ${ent.herdr}` : 'cron-up logs';
}

Object.assign(deps, {
  alive,
  procStartedAt,
  trackedAlive,
  findHerdr,
  ensureHerdrAnchor,
  syncHerdrTaskId,
  spawnSession,
  stopSession,
  sessionIdleSeconds,
  getHerdrTerminal,
  listHerdrTerminals,
  findHerdrOrphan,
});
