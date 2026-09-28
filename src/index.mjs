// 全量入口：import 全部业务模块，触发它们向 deps 容器的自注册。CLI 与测
// 试都从这里进入，保证 deps 上的可替换函数一个不缺（internals 不反向依赖
// 业务模块，单独 import 某个纯模块时其同侪可能尚未注册）。

import './tasks.mjs';
import './config.mjs';
import './sessions.mjs';
import './registry.mjs';
import './patrol.mjs';
import './service.mjs';
import './logs.mjs';
import './overview.mjs';
import './list.mjs';

export * from './cron.mjs';
export * from './tasks.mjs';
export * from './config.mjs';
export * from './sessions.mjs';
export * from './registry.mjs';
export * from './patrol.mjs';
export * from './service.mjs';
export * from './logs.mjs';
export * from './display.mjs';
export * from './overview.mjs';
export * from './list.mjs';
export { deps, ExitError } from './internals.mjs';
export { paths, LABEL, packageVersion } from './paths.mjs';
