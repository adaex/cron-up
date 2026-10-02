// HOME 派生的全部产物路径。这些是另一个程序（launchd/Claude Code）也会
// 触达的契约面，改名要慎重——因此集中在一个地方。

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LABEL = 'local.cron-up';

const HOME = os.homedir();
// 被预热的 agent 工作区里，定时任务文件的相对路径。
export const TASK_REL = path.join('.claude', 'scheduled_tasks.json');

// 派生 getter 只写这一份：生产 paths 与测试重定向用的 tmpPaths
// （test-support/helpers.mjs）共用同一工厂，派生路径改布局不会出现两处各
// 改一半。
export function makePaths({ home, dataDir, logDir, plistPath, sessionDir }) {
  return {
    home,
    dataDir,
    logDir,
    plistPath,
    sessionDir,

    get sessionLogDir() {
      return path.join(this.logDir, 'sessions');
    },
    get configPath() {
      return path.join(this.dataDir, 'config.json');
    },
    get statePath() {
      return path.join(this.dataDir, 'state.json');
    },
    // 巡检心跳：每轮成功跑完写一次，总览页据此判断上次巡检多久前。
    get heartbeatPath() {
      return path.join(this.dataDir, 'heartbeat');
    },
    // launchd 拉起的启动脚本。ProgramArguments[0] 直接指向它而非 node：
    // macOS 后台项目列表按可执行文件名显示条目，直连 node 会归到「Node.js
    // Foundation」名下（node 的签名者），自有脚本则显示脚本自己的名字。
    get serviceScriptPath() {
      return path.join(this.dataDir, 'cron-up-service');
    },
  };
}

// 路径对象整体可替换（deps.paths）：测试把产物目录重定向到 tmp，不碰真实
// HOME。getter 让 sessionLogDir/configPath/statePath 跟随替换后的前缀。
export const paths = makePaths({
  home: HOME,
  // 数据目录用 XDG 风格的 ~/.local/share/cron-up：config、state 与启动脚本
  // 集中一处，purge 一删全清。
  dataDir: path.join(HOME, '.local', 'share', 'cron-up'),
  logDir: path.join(HOME, 'Library', 'Logs', 'cron-up'),
  plistPath: path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`),
  sessionDir: path.join(HOME, '.claude', 'sessions'),
});

// 版本号读 package.json（用 fs 读而非 JSON import attribute，避免对 Node
// 版本实验特性的依赖）；读不到返回 null，总览页降级显示。
export function packageVersion() {
  try {
    const pkg = fileURLToPath(new URL('../package.json', import.meta.url));
    return JSON.parse(fs.readFileSync(pkg, 'utf-8')).version ?? null;
  } catch {
    return null;
  }
}
