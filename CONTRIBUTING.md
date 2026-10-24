# 贡献指南

## 开发环境

- macOS，便于验证 launchd、`script(1)`、zsh 和进程行为
- Node.js 22 或更高版本
- 无第三方运行时依赖，测试直接使用 `node:test`

```bash
git clone git@github.com:adaex/cron-up.git
cd cron-up
node --test
```

CI 在 macOS 上分别使用 Node 22、24 运行全部测试。需要本机联调时可执行 `npm link`，它会把开发版链接成全局 `cron-up` 命令；只做测试时不需要这一步

## 代码结构

- `bin/cron-up.mjs`：CLI 入口与顶层异常处理
- `src/cli.mjs`、`src/args.mjs`：参数解析、帮助和命令分发
- `src/internals.mjs`：可替换的 `deps` 容器及系统级默认实现
- `src/` 其他模块：任务发现、cron、巡检、会话、登记、展示、日志与 launchd 服务
- `test/`、`test-support/`：行为测试和可注入依赖的夹具

业务模块向 `deps` 注册外部依赖，测试通过替换这些依赖隔离文件、进程、时钟和 launchd。修改行为时同步修改测试，不要只让旧断言适配新输出

## 文档同步要求

用户可观察行为变化时，至少检查以下位置，避免命令、README 和实现各自描述一套口径：

| 变化 | 需要同步的位置 |
| --- | --- |
| 产品范围、安装、日常使用、限制、卸载或数据保留 | `README.md` |
| 命令、选项、升级步骤或帮助文案 | `src/cli.mjs`，必要时包括 `src/overview.mjs` |
| npm 包定位 | `package.json` 的 `description` |
| 内部机制、生命周期常量、兼容性证据或投递算法 | `docs/internals.md` |
| 跨版本行为与旧安装收尾 | `docs/migration.md` |
| 版本号、工作流或发布验收 | `docs/release.md` |

维护文档中的常量表只写语义和派生关系，具体数值链接 `src/constants.mjs`，避免同时维护两份当前值；README 中面向用户的数值仍需随行为变化核对

文档中的兼容版本必须有实际核对依据。没有把某个版本验证过，就写“未验证”，不要用“以上均支持”替代证据

示例输出应与真实命令格式核对；时间、pid 等变化值可以标注为示例，不要伪造验证结果

## 提交前检查

```bash
node --test
node bin/cron-up.mjs --help
npm pack --dry-run
```

同时检查：

- README 与分拆文档的相对链接有效
- 新命令或字段有对应测试
- 文档没有引入“保证一个不少”“绝不可能失败”等超过实现边界的承诺
- 涉及任务文件写入、权限、联网或卸载时，明确说明影响范围和不会处理的内容

发布是独立流程，见[发布流程](docs/release.md)
