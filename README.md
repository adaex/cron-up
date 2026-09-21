# doorman

为命令行 AI agent 的定时任务**提前启动并保持一个可用的交互会话**。任务本身仍由 agent 自己的定时机制执行，doorman 只负责保证：任务到点时，对应目录里已经有一个开着的会话。名字取「门房」之意——不替客人办事，只负责到点把门打开。

> [!WARNING]
> doorman 建立在 Claude Code **未公开文档的内部机制**之上（`.claude/scheduled_tasks.json` 文件格式、`~/.claude/sessions/*.json` 会话登记、定时任务只在交互界面里执行、周期任务 7 天后失效）。这些行为可能随版本变化。已在 **Claude Code 2.1.278 / macOS** 上实测验证，升级 Claude Code 后建议重新核对。

## 平台要求

- **macOS**（依赖 launchd、`script(1)`、zsh 登录配置；暂不支持其他系统）
- Python 3.9 以上（macOS 自带的 `/usr/bin/python3` 即可，**不需要安装任何第三方包**）
- Claude Code 命令行（在交互登录 shell 里能直接运行 `claude`）

## 它解决什么问题

在 Claude Code 会话里用 `CronCreate(durable: true)` 创建的定时任务，记录在工作目录的 `.claude/scheduled_tasks.json` 里。但这些任务**只有在该目录有一个正在运行的交互式 Claude Code 会话时才会到点执行**：

- 会话一直开着 → 一切正常；
- 会话被关掉 → 一次性任务会在下次打开该目录的会话时补执行一次，**周期任务则直接跳过**，没有任何提示。

doorman 是一个由 launchd 每 5 分钟运行一次的巡检脚本，逻辑只有一条：

> 某个工作目录里存在「10 分钟内即将执行」的定时任务（或有错过补执行的一次性任务），而该目录当前没有运行中的交互会话 → 在后台启动一个无窗口的 Claude Code 会话。

提前 10 分钟是为了覆盖两轮巡检：任何任务最迟在执行前 5 分钟的那轮巡检会被发现；而会话启动只需约 10 秒。

## 工作方式

| 环节 | 由谁负责 |
|---|---|
| 任务登记 | Claude Code 原生命令 `CronCreate(durable: true)`，写入工作目录下的 `.claude/scheduled_tasks.json` |
| 定时执行 | Claude Code 交互会话自身（包括 cron 时间计算、随机延迟、一次性任务执行后自动删除） |
| 保证有会话在场 | launchd 每 5 分钟调用一次 `doorman run`，脚本运行完立即退出，不常驻 |
| 后台会话 | 通过 macOS 自带的 `script(1)` 启动无窗口交互界面，输出写入日志，可随时恢复 |

各部分互不影响：卸载 doorman 后，定时任务文件依然有效，只是没人保证会话在场；删除任务文件后，doorman 巡检发现没有任务，什么都不会启动。

## 安装

```bash
git clone git@github.com:adaex/doorman.git ~/space/doorman
~/space/doorman/bin/doorman install \
  --roots ~/code,~/work \
  --interval 300 \
  --lead 600
```

`--roots` 填写存放 agent 工作目录的父目录（逗号分隔）。不填时默认扫描家目录下两层（`~/*/*`），并自动跳过 `Library`、`Documents` 等系统目录；建议显式指定，范围越小越安全、越快。

安装完成后，源码仓库可以删除，运行只依赖以下安装产物：

| 产物 | 位置 |
|---|---|
| 命令行工具 | `~/.local/bin/doorman` |
| launchd 配置 | `~/Library/LaunchAgents/local.doorman.plist` |
| 配置文件 | `~/Library/Application Support/doorman/config.json` |
| 运行状态 | 同目录下的 `state.json` |
| 日志 | `~/Library/Logs/doorman/`（巡检日志；各后台会话的界面记录在 `sessions/` 子目录下，该目录权限 700、日志文件 600） |

安装不需要 sudo，也不安装 npm 包。

### 安装前的三个前提

1. **shell 环境要在登录交互模式下完整可用**：后台会话通过 `/bin/zsh -lic 'cd <工作目录> && claude'` 启动。`-i`（交互）会加载定义了 API 端点和模型路由的 shell 配置；`-l`（登录）会加载 `/etc/zprofile` 里的 `path_helper`——launchd 提供的环境变量极少，只有登录 shell 才能把 homebrew、fnm、node 加进 PATH。只用 `-i` 不用 `-l`，在终端里手动测试一切正常，交给 launchd 就会报 `fnm: command not found` 然后退出，这个坑我们实际踩过。
2. **工作目录已通过 Claude Code 的信任确认**：从未打开过的新目录会停在「是否信任此文件夹」的提问界面，会话无法进入空闲状态，定时任务也就不会执行。只扫描已经正常使用过的目录。
3. **无人值守时的工具权限**：后台会话没有人可以点授权确认。请使用 bypass permissions 模式，或在配置里准备好完整的允许列表，否则会话会一直停在授权提问处。

## 日常使用

```bash
doorman status                 # 查看 launchd 注册状态、配置、当前保活的会话
doorman list                   # 列出所有任务：下次执行时间、当前是否有会话可执行
doorman run                    # 立即手动巡检一次（与定时巡检互斥，同时运行时后到者自动退出）
doorman logs                   # 查看巡检日志（stderr 有内容时在开头提示一行）
doorman logs <目录名片段> -f    # 实时查看某个后台会话的界面输出
doorman uninstall              # 停止并卸载服务，保留配置和日志
doorman uninstall --stop-sessions --purge   # 停止后台会话并删除全部安装产物
```

## 使用定时任务时的三个约定

1. **创建方式不变**：照常在用着的会话里口头让 Claude 创建定时任务（`durable: true`），任务记录仍然只存在 Claude Code 自己的文件里。
2. **让一次性任务结束后自动退出**：在任务描述末尾固定加一句「按本仓工作流存好结果后，执行 `/exit` 退出会话」。这样一次性任务执行完会从任务文件自动删除，后台会话随即退出，doorman 下次巡检发现没有任务也不会再启动，整个过程有始有终。
3. **超过 7 天的周期任务需要续签**：Claude Code 的周期任务 7 天后自动失效。可在任务描述里要求每次执行结束时用 `CronCreate` 登记下一个周期，实现滚动延续。

## 恢复或接管后台会话

后台会话与普通会话一样保存对话记录，可以在任意终端恢复：

```bash
cd <工作目录>
claude --resume <会话ID>      # 或 claude -r 在列表中选择
```

对话记录在第一条消息后写入 `~/.claude/projects/<目录编码>/<会话ID>.jsonl`，即使后台进程被结束也能恢复。

## 维护

- **修改扫描范围**：直接编辑配置文件的 `roots`、`maxDepth`，最多 5 分钟后的下一轮巡检自动生效，无需重新加载服务。
- **修改巡检间隔或提前量**：重新运行 `doorman install --force --interval 600`，会重新生成 launchd 配置。`--force` 只更新命令行里显式给出的字段，其余配置（如 `roots`）保留；路径参数建议都加引号书写，例如 `--roots "$HOME/code,$HOME/work"`，避免 shell 对逗号后的波浪号不展开。
- **升级**：`git pull` 后重新运行一次 `doorman install`，程序和 launchd 配置会被覆盖更新，配置文件保留。
- **配置校验**：安装时会校验配置——间隔或提前量不是合法数字会中止安装；提前量小于间隔（可能来不及在任务前启动会话）、扫描目录不存在会给出明确警告。`doorman status` 随时也会显示这些问题；其中 interval 显示的是 launchd **实际生效**的间隔，手动改过 config 但与实际不一致时会提示需要重新 install。
- **提前量与间隔的关系**：请保持 `leadSeconds ≥ intervalSeconds`，否则极端情况下任务会在两轮巡检之间到期而来不及启动。默认 600 ≥ 300 有一倍余量。`--lead 0` 是合法取值（表示不提前，只靠错过补执行兜底），会如实写入配置；`--interval 0` 非法，安装时直接报错中止。
- **连续失败自动暂停**：doorman 能区分「自己启动的后台会话」和「你本人打开的会话」，只跟踪前者。后台会话有两种失败会被计入：**启动后立即退出**（通常是 shell 环境损坏），以及**进程活着但 3 分钟内始终没有登记成会话**（停在信任确认或工具授权提问上——这种进程不会自己退出，会被 doorman 主动终止）。同一目录连续失败 3 次后暂停重试 30 分钟，`doorman status` 显示 `COOLDOWN`；会话只要成功登记过一次，失败计数就清零；暂停结束后会给一次全新的重试机会，不会无限期停摆。健康会话实测约 1 秒完成登记，距 3 分钟的判定线有充足余量。
- **日志大小**：后台会话的界面输出是持续的全屏渲染流。单次运行产生的日志超过 10MB 时，会在下次启动该目录会话时轮转成 `.log.1`；而 `script(1)` 每次启动会清空旧日志，所以反复重启不会造成堆积。只有一个连续运行数天、从不重启的会话无法在运行中切割日志（受 macOS `script(1)` 能力限制），实际量级约为每周几十 MB。

## 安全说明

- 后台会话拥有你在 Claude Code 中的全部权限（bypass permissions 模式下执行任何操作都无需确认）。**请只把 `roots` 指向你本人信任的工作目录**；除扫描 `roots` 外，doorman 只读取 `~/.claude/sessions/`（判断目录里是否已有会话）并写入自己的配置、状态与日志目录。
- 会话日志可能包含任务执行过程和输出，默认仅本人可读（600），对外分享或截图前请留意内容。
- 本工具自身不发起任何网络请求；唯一的外部通信来自被启动的 agent 会话。

## 已知限制

- 仅支持 macOS。电脑休眠期间错过的周期任务不会补执行；唤醒后 launchd 会立即跑一轮巡检，错过的**一次性**任务会在后台会话启动时由 Claude Code 补执行。
- 周期任务 7 天后失效，需要按上文方式续签。
- 同一目录同时存在两个交互会话时，定时任务是否会被各执行一次，官方没有明确说明。doorman 的策略是「只在没有任何会话时才启动」，正常流程不会制造第二个会话。

## 故障排查

| 现象 | 排查方法 |
|---|---|
| `status` 显示 `COOLDOWN` | 运行 `doorman logs <目录名>` 查看启动界面：要么停在信任确认或工具授权提问（日志里能看到提问界面），要么 shell 环境缺少命令（日志里是 `command not found`） |
| 日志里出现 `STUCK` | 会话进程起来了但没能变成可用会话，绝大多数是停在信任确认或授权提问。先手动 `cd <目录> && claude` 走完确认，再等下一轮巡检 |
| 日志里出现 `ERROR <目录>` | 该目录的任务文件读不出来（格式损坏等），只跳过这一个目录，其余照常巡检。检查 `<目录>/.claude/scheduled_tasks.json` |
| 任务到点没有执行 | `doorman list` 查看下次执行时间和是否有会话；`launchctl print gui/$(id -u)/local.doorman` 查看 last exit code |
| 手动 `doorman run` 正常、定时执行不正常 | 基本都是 launchd 环境下 shell 初始化不一致（PATH、fnm、模型路由），会话日志里会有直接报错 |
| `last exit code=2` | config.json 字段类型不对（如 `leadSeconds` 写成字符串），`doorman status` 会指出具体问题 |

## 测试

```bash
/usr/bin/python3 -m unittest discover -s tests
```

测试覆盖：cron 下次执行时间的计算（含标准 cron 在「日期与星期同时指定」时取并集的规则、超出查找窗口与永不匹配的表达式）、一次性与周期任务的提前启动判定和错过补执行规则、畸形任务文件与畸形状态文件不会中断巡检、配置缺失或损坏时给出一行原因而非 traceback、`logs` 的日志选取（陈旧 stderr 不遮蔽巡检日志）、后台会话状态机的完整路径（启动、成功后清零、连续失败暂停、暂停后恢复、用户自开会话时不干预、卡死会话超时终止、PID 复用不误认不误杀）、安装参数处理与二进制原子安装。

## License

[MIT](LICENSE)
