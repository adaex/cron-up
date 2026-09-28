#!/usr/bin/env node
// cron-up 入口（npm bin 的 shim 目标）。launchd 经自有的 cron-up-service
// 启动脚本拉起：脚本把 node 与本包所在的 bin 目录放进 PATH 后执行
// `cron-up run`，命令与本文件都从 PATH 解析，npm 升级自动跟随。

import { main } from '../src/cli.mjs';
import { ExitError } from '../src/internals.mjs';

main().catch((e) => {
  if (e instanceof ExitError) {
    if (e.message) process.stderr.write(`${e.message}\n`);
    process.exit(e.code ?? 1);
  }
  process.stderr.write(`${e?.stack || e}\n`);
  process.exit(1);
});
