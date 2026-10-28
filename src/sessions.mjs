// 预热会话的整个生命周期：存活探测、pid 身份指纹、拉起、停止、日志文件
// 名、进程表兜底。被拉起的是 /usr/bin/script 包裹的 TUI，detached 独立进
// 程组，与短命的巡检进程在进程层早就分开。一个预热会话只服务一个任务
// （归属靠任务文件盖印，不靠命令行），日志名因此带任务 id。

import fs from 'node:fs';
import path from 'node:path';

import { deps, ensurePrivateDir } from './internals.mjs';

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
  // 固定 locale：这个字符串会跨轮次做精确相等比较，手动 run（终端
  // LANG，可能本地化）与 launchd 驱动的巡检若格式不同，会把自己的会话
  // 误判成回收 pid。
  const r = deps.execFile(
    '/bin/ps',
    ['-p', String(pid), '-o', 'lstart='],
    { env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, timeout: 5000 },
  );
  const out = (r.stdout ?? '').trim();
  return out || null;
}

// 仅当记录的 pid 仍是我们当初 spawn 的那个进程时为 true。
export function trackedAlive(ent) {
  if (!ent || !ent.pid) return false;
  if (!deps.alive(ent.pid)) return false;
  const started = ent.procStart;
  if (!started) return true; // 旧版本写的条目：退回 kill -0 判定
  return deps.procStartedAt(ent.pid) === started;
}

// 日志文件名折法：下划线转义必须在斜杠折叠之前——/a/b → a_b，
// /a_b → a__b，两类路径才不会共用同一个日志文件（script(1) 启动即截断，
// 撞名意味着两个工作区互相覆盖记录）。logs 命令按工作区前缀找日志时也
// 用同一个折法。
export function slugSegment(s) {
  return String(s).replace(/^\/+|\/+$/g, '')
    .replace(/_/g, '__')
    .replace(/\//g, '_');
}

// 每个任务的预热会话有独立日志：<工作区slug>--<任务键>.log。-- 分隔，任
// 务键是 8 位十六进制或 anon:<16 位十六进制>。
export function sessionLogPath(ws, taskId) {
  return path.join(deps.paths.sessionLogDir,
    `${slugSegment(ws)}--${slugSegment(taskId)}.log`);
}

// 文件名是否为新命名（任务级）的预热日志。升级轮清扫旧版目录级命名的孤
// 儿 script 进程时用它区分两代：任务键段的严格形状让旧命名（纯工作区
// slug）几乎不可能误判为新命名。
export function isTaskSessionLogName(name) {
  return /--(?:[0-9a-f]{8}|anon:[0-9a-f]{16})\.log$/.test(name);
}

// POSIX shell 引用：安全字符白名单内原样返回，否则单引号包裹，内部单引
// 号写成 '"'"'。
export function shellQuote(s) {
  if (s === '') return "''";
  if (/^[-@%+=:,./\w]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

export function sessionArgv(ws, logPath, model) {
  // -l -i 都不能少。-i 加载定义了私有端点/模型路由（claude shell 函数）
  // 的交互 rc；-l 加载 /etc/zprofile 的 path_helper，这是 launchd 最小环
  // 境里唯一把 homebrew（进而 fnm/node）放上 PATH 的东西。光 -ic 在终端
  // 里靠继承现成 PATH 一切正常，交给 launchd 就 fnm: command not found。
  // 模型是会话级启动参数；缺省时不传，继续服从 Claude Code 自身配置。
  const modelPart = model ? ` --model ${shellQuote(model)}` : '';
  return [
    '/usr/bin/script', '-q', logPath,
    '/bin/zsh', '-lic',
    `cd ${shellQuote(ws)} && claude --permission-mode bypassPermissions${modelPart}`,
  ];
}

// 预热会话继承的环境：strip 掉所有 CLAUDE_CODE_* 注入标记（从另一个 CC
// 会话里手动 run 时，否则 TUI 会以子会话身份启动，没有 transcript/登记），
// 再打上自我标识供外部观察工具归组。纯函数：绝不能改父进程的 process.env
// （Node 没有 fork，子环境只能显式构造）。
export function buildChildEnv(parentEnv) {
  const env = { ...parentEnv };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CODE_')) delete env[k];
  }
  // 刻意不带 CLAUDE_CODE_ 前缀（上一步刚把那批 strip 掉）；值必须严格是
  // 字符串 '1'（观察侧 === '1' 判定）。
  env.CRON_UP_SESSION = '1';
  return env;
}

// 日志保留一代（.1）：删旧代后把现役改名顶上。「.1」命名与 rm-先-于-
// rename 的顺序是两处调用（会话 typescript、launchd 巡检日志）共同的承重
// 约定——script(1) 打开即截断、launchd 按路径重开，轮转失败都不阻断调用方。
export function rotateOnce(file) {
  const old = `${file}.1`;
  fs.rmSync(old, { force: true });
  fs.renameSync(file, old);
}

// 进程组信号只接受明确大于 1 的整数 pid：0/-1 等有广播含义，浮点、
// 负数或非安全整数也都不能交给 process.kill。
function canSignalProcessGroup(pid) {
  return Number.isSafeInteger(pid) && pid > 1;
}

// 为一个任务拉起一个 detached 的 pty TUI，返回 {pid, procStart}。model 是
// 该次启动的快照；已有会话不会因之后改写配置而自动换模型。
export function spawnSession(ws, taskId, model) {
  const logPath = sessionLogPath(ws, taskId);
  // 会话日志目录 700（README 权限约定）：每任务独立文件，目录只在此处创建。
  ensurePrivateDir(path.dirname(logPath));
  // script(1) 启动即截断：每次新拉起前无条件保留上一代（.1），避免上次
  // 启动以来的界面记录被抹掉。总量上界两代，活着的一代增长再快也只影响
  // 自身，不会经轮转放大。
  try {
    if (fs.existsSync(logPath)) rotateOnce(logPath);
  } catch {
    // 轮转失败不阻断拉起。
  }
  // spawn 没有 umask 选项，而 typescript 可能含任务输出、必须 0600：先以
  // 0600 预创建，script 随后以 O_TRUNC 打开已存在文件时模式位不变。
  const fd = fs.openSync(logPath, 'a', 0o600);
  fs.closeSync(fd);
  try {
    fs.chmodSync(logPath, 0o600);
  } catch {
    // 维持 0600。
  }
  const argv = sessionArgv(ws, logPath, model);
  const child = deps.spawn(argv[0], argv.slice(1), {
    detached: true, // 子侧 setsid：child.pid 即新进程组组长
    stdio: 'ignore', // script 把 typescript 写进 logPath
    cwd: ws,
    env: buildChildEnv(process.env),
  });
  // unref 后即使异步启动失败也不要变成 uncaught（监听器不影响 loop 退出）；
  // 但错误原因要留进巡检日志——spawn 同步返回成功、子进程 exec 阶段才失败
  // （ENOENT/EAGAIN 等）时，上层只能看到会话随后死亡，没有任何原因可查。
  child.on('error', (e) => {
    deps.log(`会话进程拉起异常 ${ws} 任务 ${taskId}：${e?.code ? `${e.code}：` : ''}`
      + `${e?.message ?? e}`);
  });
  child.unref();
  // 拉不起来（spawn 当场失败，pid 是 undefined）时返回 null：没有进程可跟
  // 踪，调用方按启动失败计数，不把 pid=undefined 写进 state。
  if (child.pid === undefined) return null;
  let procStart = null;
  let fingerprintError = null;
  try {
    procStart = deps.procStartedAt(child.pid);
  } catch (e) {
    fingerprintError = e;
  }
  if (procStart) return { pid: child.pid, procStart };

  // 没有指纹的条目今后无法安全发信号，不能登记成正常会话。这里只清理
  // 刚刚由本次 spawn 创建的进程组；pid 形状异常时宁可留下日志也不冒险。
  const reason = fingerprintError
    ? `读取进程身份指纹失败：${fingerprintError?.message ?? fingerprintError}`
    : '未读到进程身份指纹';
  let cleanup;
  if (canSignalProcessGroup(child.pid)) {
    try {
      process.kill(-child.pid, 'SIGTERM');
      cleanup = '已向刚拉起的进程组发送 SIGTERM';
    } catch (e) {
      cleanup = `清理刚拉起的进程组失败：${e?.code ? `${e.code}：` : ''}`
        + `${e?.message ?? e}`;
    }
  } else {
    cleanup = 'pid 不是大于 1 的整数，未发信号';
  }
  deps.log(`会话启动失败 ${ws} 任务 ${taskId} pid=${child.pid}：${reason}；`
    + cleanup);
  return null;
}

// 按进程组结束我们拉起的会话。发信号前先核身份：state 条目可能比它命名
// 的进程活得久，给回收 pid 发组信号会杀掉无关进程组。detached（用户
// resume 接管）时 trackedAlive 为 false：本函数返回 true，绝不碰用户的裸
// claude。false 表示记录的进程仍活着，但因缺少指纹或信号失败而未能安全
// 停止；调用方必须保留跟踪并告警，不能假装已经回收。
export async function stopSession(ent) {
  const pid = ent?.pid;
  if (!canSignalProcessGroup(pid)) return true;
  if (!deps.trackedAlive(ent)) return true;
  // trackedAlive 为兼容旧条目会在没有 procStart 时退回 kill -0；读取可以
  // 沿用这个判断，停止却不行。死进程无需处理，活进程只能如实报告未停止。
  if (!ent.procStart) return deps.alive(pid) ? false : true;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return deps.alive(pid) ? false : true;
  }
  for (let i = 0; i < 20; i++) {
    await deps.sleep(100);
    if (!deps.alive(pid)) return true;
  }
  if (!deps.trackedAlive(ent)) return true;
  // 升级 SIGKILL 前已再核一次指纹；信号失败或结束后仍是同一进程，都不能
  // 向调用方报告停止成功。
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    return deps.alive(pid) ? false : true;
  }
  await deps.sleep(100);
  return deps.trackedAlive(ent) ? false : true;
}

// typescript 多少秒没被写。文件缺失读作「没有任何活动证据」：Infinity 大
// 于任何静默阈值，天然不挡回收（哨兵值曾绑定固定阈值 + 1，阈值调低后会
// 悄悄翻转语义）。
export function sessionLogIdleSeconds(logPath, cur) {
  try {
    return Math.max(0, cur - Math.floor(fs.statSync(logPath).mtimeMs / 1000));
  } catch {
    return Infinity;
  }
}

// 进程表是 state.json 丢失时的兜底：被遗忘的预热会话卡在提问界面时不会出
// 现在会话登记里，没这层交叉检查就会为同一任务堆第二个 TUI。
export function listScriptProcesses() {
  const r = deps.execFile('/bin/ps', ['-axo', 'pid=,args='], { timeout: 5000 });
  const out = [];
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\/usr\/bin\/script\s.*)$/);
    if (m) out.push([parseInt(m[1], 10), m[2]]);
  }
  return out;
}

// 从 ps 的 args 输出里解出 script(1) 的 typescript 路径（-q 与固定后缀
// /bin/zsh 之间的参数，非贪婪，路径含空格也成立）。不是本工具拉起形态的
// script 进程返回 null。
export function scriptProcLogPath(procArgs) {
  const m = procArgs.match(/ -q (.+?) \/bin\/zsh /);
  return m ? m[1] : null;
}

Object.assign(deps, {
  alive,
  procStartedAt,
  trackedAlive,
  spawnSession,
  stopSession,
  listScriptProcesses,
});
