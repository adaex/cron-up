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

// 路径对象整体可替换（deps.paths）：测试把产物目录重定向到 tmp，不碰真实
// HOME。getter 让 sessionLogDir/configPath/statePath 跟随替换后的前缀。
export const paths = {
  home: HOME,
  appSupport: path.join(HOME, 'Library', 'Application Support', 'cron-up'),
  logDir: path.join(HOME, 'Library', 'Logs', 'cron-up'),
  plistPath: path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`),
  sessionDir: path.join(HOME, '.claude', 'sessions'),

  get sessionLogDir() {
    return path.join(this.logDir, 'sessions');
  },
  get configPath() {
    return path.join(this.appSupport, 'config.json');
  },
  get statePath() {
    return path.join(this.appSupport, 'state.json');
  },
  // launchd 拉起的启动脚本。ProgramArguments[0] 直接指向它而非 node：
  // macOS 后台项目列表按可执行文件名显示条目，直连 node 会归到「Node.js
  // Foundation」名下（node 的签名者），自有脚本则显示脚本自己的名字。
  get serviceScriptPath() {
    return path.join(this.appSupport, 'cron-up-service');
  },
};

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
