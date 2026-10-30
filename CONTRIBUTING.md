# 贡献指南

本文是代码、测试与文档改动的开发入口。本机安装、升级和使用边界见根目录 `CLAUDE.md`；发布是独立流程，只有发布、发版验收或修改发布流程时才打开[发布流程](docs/release.md)

## 开发环境

- macOS，便于验证 launchd、`script(1)`、zsh 和进程行为
- Node.js 22 或更高版本
- 无第三方运行时依赖，测试直接使用 `node:test`

```bash
git clone git@github.com:adaex/cron-up.git
cd cron-up
node --test
```

测试在隔离环境中运行，不需要安装 cron-up。CI 在 macOS 上分别使用 Node 22、24 运行全部测试

本机联调仍受根目录 `CLAUDE.md` 的使用边界约束。`npm link` 会把开发版链接成全局 `cron-up` 命令，属于全局安装

## 代码地图

先打开任务涉及的模块和同名测试，再沿调用链阅读，不需要通读整个 `src/`

| 模块 | 职责 |
| --- | --- |
| `bin/cron-up.mjs`、`src/cli.mjs`、`src/args.mjs`、`src/index.mjs` | CLI 入口、参数解析、命令分发与业务模块注册 |
| `src/internals.mjs` | 可替换的 `deps` 容器、系统级默认实现与共享数据守卫 |
| `src/constants.mjs`、`src/paths.mjs` | 行为常量、扫描排除项与自产物路径 |
| `src/patrol.mjs` | 巡检主状态机 |
| `src/tasks.mjs` | 工作区发现、任务读取、工作区模型配置、续期与归属写入 |
| `src/cron.mjs` | cron 解析、预热窗口与预计投递时间 |
| `src/sessions.mjs`、`src/registry.mjs` | 预热进程生命周期、会话日志与 Claude Code 会话登记识别 |
| `src/config.mjs` | 配置、状态与心跳的读写和校验 |
| `src/service.mjs` | install、uninstall、launchd 与启动链健康检查 |
| `src/overview.mjs`、`src/list.mjs`、`src/logs.mjs`、`src/display.mjs` | 总览、任务列表、日志命令与终端展示 |
| `test/`、`test-support/` | 按模块划分的行为测试与可注入依赖的夹具 |

业务模块在文件末尾向 `deps` 注册外部依赖，`src/index.mjs` 负责全量导入以完成注册。测试通过临时目录和替换这些依赖隔离文件、进程、时钟与 launchd；修改行为时同步修改测试，不要只让旧断言适配新输出

## 文档分工与同步

用户可观察行为或维护者操作边界变化时，至少检查以下位置，避免命令、文档和实现各自描述一套口径：

| 变化 | 需要同步的位置 |
| --- | --- |
| 产品范围、安装、日常使用、限制、卸载或数据保留 | `README.md` |
| 维护者可操作的机器范围或自动化执行边界 | 根目录 `CLAUDE.md`；相关流程只引用该节，不复制机器名单 |
| 命令、选项、升级步骤或帮助文案 | `src/cli.mjs`，必要时包括 `src/overview.mjs` |
| npm 包定位 | `package.json` 的 `description` |
| 内部机制、生命周期常量、兼容性证据或投递算法 | `docs/internals.md` |
| 跨版本行为与旧安装收尾 | `docs/migration.md` |
| 版本号、工作流或发布验收 | `docs/release.md` |

根目录 `CLAUDE.md` 只保留 Agent 必须始终知道的边界和文档地图；具体开发做法、内部机制与成文流程分别留在对应主题文档，不要抄回入口

维护文档中的常量表只写语义和派生关系，具体数值链接 `src/constants.mjs`，避免同时维护两份当前值；README 中面向用户的数值仍需随行为变化核对

文档中的兼容版本必须有实际核对依据。没有把某个版本验证过，就写“未验证”，不要用“以上均支持”替代证据

示例输出应与测试或真实命令格式核对；需要执行 cron-up 时先遵守使用边界。时间、pid 等变化值可以标注为示例，不要伪造验证结果

## 提交前检查

不参与真实本机状态的常规检查：

```bash
node --test
npm pack --dry-run
```

`node bin/cron-up.mjs --help` 会读取真实配置、状态与服务信息，仅在符合根目录 `CLAUDE.md` 使用边界时作为本机验收执行

同时检查：

- README 与分拆文档的相对链接有效
- 新命令或字段有对应测试
- 文档没有引入“保证一个不少”“绝不可能失败”等超过实现边界的承诺
- 涉及任务文件写入、权限、联网或卸载时，明确说明影响范围和不会处理的内容
