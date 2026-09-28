// 可替换依赖容器：ESM 命名导出不可改，测试无法事后打桩，因此把所有要替换
// 的外部依赖集中到 deps。业务模块在文件末尾 Object.assign(deps, {...})
// 自注册（internals 不反向 import 业务模块，避免循环依赖）；cli 先 import
// 全量入口保证注册完成后再 dispatch。
//
// 纯系统叶子的默认实现放这里；业务函数（discover、spawnSession…）由各自
// 模块注册。

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { paths } from './paths.mjs';

export class ExitError extends Error {
  // CLI 入口捕获后按 code 退出。
  constructor(code, message) {
    super(message);
    this.name = 'ExitError';
    this.code = code;
  }
}

// 非 0 退出不抛：调用 ps/launchctl 的地方只关心 status 与输出，抛了反而
// 要在每个调用点 catch。返回 {status, stdout, stderr}。
function execFile(file, args, opts = {}) {
  try {
    const stdout = execFileSync(file, args, {
      // execFileSync 的默认 stdio 会让非零退出子进程的 stderr 继承父进程
      // （launchctl print 未加载服务时错误会直接糊到终端），显式 pipe 住。
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: 0, stdout: stdout ?? '', stderr: '' };
  } catch (e) {
    // launchctl bootout 找不到服务等：exit 非零但输出在 stderr。
    if (e && typeof e === 'object' && 'status' in e) {
      return {
        status: e.status ?? 1,
        stdout: typeof e.stdout === 'string' ? e.stdout : '',
        stderr: typeof e.stderr === 'string' ? e.stderr : '',
      };
    }
    if (e && typeof e === 'object' && (e.code === 'ENOENT' || e.code === 'EACCES'
        || e.code === 'ETIMEDOUT')) {
      return { status: 1, stdout: '', stderr: e.message ?? String(e) };
    }
    throw e;
  }
}

function terminalWidth() {
  return Math.max(60, process.stdout.columns ?? 100);
}

export const deps = {
  paths,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  print: (...args) => process.stdout.write(`${args.join(' ')}\n`),
  printErr: (...args) => process.stderr.write(`${args.join(' ')}\n`),
  terminalWidth,
  execFile,
  spawn,
  spawnSync,
};
