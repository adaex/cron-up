// 全量副作用入口：import 全部业务模块，触发它们向 deps 容器自注册。CLI 与
// 测试都先 import 这里，保证 deps 上的可替换函数一个不缺（internals 不反向
// 依赖业务模块，单独 import 某个模块时其同侪可能尚未注册）。

import './tasks.mjs';
import './config.mjs';
import './sessions.mjs';
import './registry.mjs';
import './patrol.mjs';
import './service.mjs';
import './logs.mjs';
import './overview.mjs';
import './list.mjs';
