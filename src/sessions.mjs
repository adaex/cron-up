// 预热会话的整个生命周期：存活探测、pid 身份指纹、拉起、停止、日志文件
// 名、进程表兜底。被拉起的是 /usr/bin/script 包裹的 TUI，detached 独立进
// 程组，与短命的巡检进程在进程层早就分开。

import fs from 'node:fs';
import path from 'node:path';

import { deps } from './internals.mjs';
import {
  LOG_ROTATE_BYTES,
  SESSION_IDLE_SECONDS,
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
// 撞名意味着两个工作区互相覆盖记录）。
export function sessionLogPath(ws) {
  const slug = ws.replace(/^\/+|\/+$/g, '')
    .replace(/_/g, '__')
    .replace(/\//g, '_');
  return path.join(deps.paths.sessionLogDir, `${slug}.log`);
}

// POSIX shell 引用：安全字符白名单内原样返回，否则单引号包裹，内部单引
// 号写成 '"'"'。
export function shellQuote(s) {
  if (s === '') return "''";
  if (/^[-@%+=:,./\w]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

export function sessionArgv(ws, logPath) {
  // -l -i 都不能少。-i 加载定义了私有端点/模型路由（claude shell 函数）
  // 的交互 rc；-l 加载 /etc/zprofile 的 path_helper，这是 launchd 最小环
  // 境里唯一把 homebrew（进而 fnm/node）放上 PATH 的东西。光 -ic 在终端
  // 里靠继承现成 PATH 一切正常，交给 launchd 就 fnm: command not found。
  return [
    '/usr/bin/script', '-q', logPath,
    '/bin/zsh', '-lic', `cd ${shellQuote(ws)} && claude`,
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

// 拉起一个 detached 的 pty TUI，返回 {pid, procStart}。
export function spawnSession(ws) {
  const logPath = sessionLogPath(ws);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  try {
    fs.chmodSync(path.dirname(logPath), 0o700);
  } catch {
    // 目录权限维持现状。
  }
  // script(1) 不带 O_APPEND 打开 typescript，下次 spawn 会截断，所以只轮
  // 转仍在增长的会话留下的超大日志。
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > LOG_ROTATE_BYTES) {
      const old = `${logPath}.1`;
      fs.rmSync(old, { force: true });
      fs.renameSync(logPath, old);
    }
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
  const argv = sessionArgv(ws, logPath);
  const child = deps.spawn(argv[0], argv.slice(1), {
    detached: true, // 子侧 setsid：child.pid 即新进程组组长
    stdio: 'ignore', // script 把 typescript 写进 logPath
    cwd: ws,
    env: buildChildEnv(process.env),
  });
  // unref 后即使异步启动失败也不要变成 uncaught（监听器不影响 loop 退出）。
  child.on('error', () => {});
  child.unref();
  // 拉不起来（spawn 当场失败，pid 是 undefined）时返回 null：没有进程可跟
  // 踪，调用方按启动失败计数，不把 pid=undefined 写进 state。
  if (child.pid === undefined) return null;
  return { pid: child.pid, procStart: deps.procStartedAt(child.pid) };
}

// 按进程组结束我们拉起的会话。发信号前先核身份：state 条目可能比它命名
// 的进程活得久，给回收 pid 发组信号会杀掉无关进程组。
export async function stopSession(ent) {
  if (!deps.trackedAlive(ent)) return;
  const pid = ent.pid;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let i = 0; i < 20; i++) {
    await deps.sleep(100);
    if (!deps.alive(pid)) return;
  }
  // 升级 SIGKILL 前再核一次指纹。
  if (deps.trackedAlive(ent)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // 组已消失。
    }
    await deps.sleep(100);
  }
}

// typescript 多少秒没被写。文件缺失读作「没有活动证据」，不挡轮转。
export function sessionLogIdleSeconds(logPath, cur) {
  try {
    return Math.max(0, cur - Math.floor(fs.statSync(logPath).mtimeMs / 1000));
  } catch {
    return SESSION_IDLE_SECONDS + 1;
  }
}

// 进程表是 state.json 丢失时的兜底：被遗忘的预热会话卡在提问界面时不会出
// 现在会话登记里，没这层交叉检查就会在同目录堆第二个 TUI。
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
