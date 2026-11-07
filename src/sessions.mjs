// 预热会话由 Herdr 托管：zsh → claude，终端地址用于展示、认领、停止与
// 历史读取。state 保存根 pid 和启动指纹，供 Claude 登记认亲、低开销存活
// 检查及停止前身份核验使用。

import path from 'node:path';
import { createHash } from 'node:crypto';

import { deps, ExitError, isExecutableFile } from './internals.mjs';

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

function oneLine(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim().replace(/\s+/g, ' ');
}

// where 是给人看的：工作区加任务 prompt，不展示无意义的哈希名称。
export function herdrDisplayTitle(ws, prompt) {
  const chars = [...oneLine(prompt)];
  const summary = chars.length > 40
    ? `${chars.slice(0, 40).join('')}…` : chars.join('');
  return `cron-up / ${oneLine(path.basename(ws) || ws)} / ${summary || '未命名任务'}`;
}

export function herdrSessionArgv(hc, ws, taskId, model) {
  // Herdr 使用 core 的登录会话环境，不继承巡检调用方。-lic 按 zsh 自己的
  // 规则加载完整配置，让 claude 函数与路由生效，无需手工 source 或清理环境。
  // 只透传显式配置的模型；权限模式及其余行为服从 Claude Code 自身配置。
  const modelPart = model ? ` --model ${shellQuote(model)}` : '';
  return [
    hc, 'run', '--json', '--bg', '--no-parent',
    '--cwd', ws,
    '--label', `cron-up=${taskId}`,
    '/bin/zsh', '-lic', `claude${modelPart}`,
  ];
}

function herdrResultDetail(result) {
  return (result?.stderr ?? '').trim() || (result?.stdout ?? '').trim()
    || `退出码 ${result?.status ?? '未知'}`;
}

export function setHerdrTitle(address, title) {
  const hc = deps.findHerdr();
  if (!hc) return '未找到 hc 命令';
  const result = deps.execFile(hc, ['label', address, `where=${title}`],
    { timeout: 5000 });
  return result.status === 0 ? null : herdrResultDetail(result);
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

// 启动一个 Herdr 终端。失败不直拉第二个会话，避免启动结果不明时双开。
export function spawnSession(ws, taskId, model) {
  const hc = deps.findHerdr();
  if (!hc) {
    deps.log(`Herdr 会话启动失败 ${ws} 任务 ${taskId}：未找到 hc 命令`);
    return null;
  }
  const argv = herdrSessionArgv(hc, ws, taskId, model);
  const run = deps.execFile(argv[0], argv.slice(1), { timeout: 15000 });
  if (run.status !== 0) {
    deps.log(`Herdr 会话启动失败 ${ws} 任务 ${taskId}：${herdrResultDetail(run)}`);
    return null;
  }

  let launched;
  try {
    launched = JSON.parse(run.stdout);
  } catch {
    launched = null;
  }
  const address = launched?.address;
  if (typeof address !== 'string' || address === '') {
    deps.log(`Herdr 会话启动失败 ${ws} 任务 ${taskId}：hc run 未返回终端地址`);
    return null;
  }

  const fail = (reason) => {
    const { result, terminal } = herdrTerminal(hc, 'kill', address, 10000);
    const cleanup = terminal?.state === 'finished'
      ? '已清理刚创建的 Herdr 终端'
      : `清理 Herdr 终端失败：${herdrResultDetail(result)}`;
    deps.log(`Herdr 会话启动失败 ${ws} 任务 ${taskId}（终端 ${address}）：`
      + `${reason}；${cleanup}`);
    return null;
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
  // 地址、pid、工作区和任务标签必须同时吻合，根 pid 指纹已在上面核验。
  if (!terminal || terminal.pid !== pid || terminal.cwd !== ent.ws
      || terminal.labels?.['cron-up'] !== ent.taskId) {
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
  const taskId = terminal?.labels?.['cron-up'];
  if (typeof taskId !== 'string'
      || !Number.isSafeInteger(terminal?.pid) || terminal.pid <= 1) return null;
  return {
    address,
    cwd: terminal.cwd,
    pid: terminal.pid,
    taskId,
    state: terminal.state,
    title: terminal.labels?.where ?? '',
  };
}

// 精确地址查询只水合一个终端；找不到或不是 cron-up 终端时返回 null。
export function getHerdrTerminal(address) {
  const hc = requireHerdr();
  const { terminal } = herdrTerminal(hc, 'get', address);
  return terminalRecord(address, terminal);
}

// 列出由 cron-up 标记的 Herdr 终端。taskId 存在时让 core 先按标签过滤；
// 全量形式用于卸载与日志查询，逐终端 get 核对完整标签和 pid。
export function listHerdrTerminals(taskId = null, includeFinished = false) {
  const hc = requireHerdr();
  const args = ['ls', '--json'];
  if (includeFinished) args.push('--all');
  if (taskId !== null) args.push('--label', `cron-up=${taskId}`);
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
    if (record === null || (taskId !== null && record.taskId !== taskId)) continue;
    out.push(record);
  }
  return out;
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
  setHerdrTitle,
  spawnSession,
  stopSession,
  sessionIdleSeconds,
  getHerdrTerminal,
  listHerdrTerminals,
  findHerdrOrphan,
});
