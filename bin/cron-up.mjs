#!/usr/bin/env node
// cron-up 入口。launchd 以「node 绝对路径 + 本文件绝对路径 + run」直接
// 启动本文件（npm shim 的 /usr/bin/env node 在 launchd 最小 PATH 下找不
// 到 node）。

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
