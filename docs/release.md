# 发布流程

本文面向维护者，记录 `adaex/cron-up` 的版本号、tag、npm trusted publishing、发版后逐机验收与本地收尾。普通升级见 [README](../README.md#升级与启动链维护)

## 版本号

格式为 `YY.MM.serial`，例如 `26.10.33`：

- `YY` 是两位年份，`MM` 是两位月份
- `serial` 是累计序号，包含 0.x 时代，跨月份不归零
- 工程上的最终校验口径是**远端 `v*` tag 数量**，不是 npm 成功发布次数；下一序号等于发布前该数量加一

发布前同步并计算：

```bash
git fetch --prune --prune-tags --tags
git tag -l 'v*' | wc -l
```

计数结果加一就是下一序号。release 工作流会重新直接统计远端 tag，防止本地状态与远端不一致；被删除的远端 tag 不再计数。已推送但尚未 publish、且 tag 内容无需改变的失败运行，优先重跑同一工作流，而不是递增序号；需要修复 tag 内容时按下文处理

## 发布步骤

1. 确认 `main` 已包含本次发布内容，测试通过
2. 按上述规则修改 `package.json` 的 `version`，并将发布提交合入 `main`
3. 在发布提交上创建同名签名注解 tag 并推送：

   ```bash
   git tag -s v<version> <发布提交> -m "发布 <version>"
   git push origin v<version>
   ```

4. 等待 `.github/workflows/release.yml` 完成。工作流会：
   - 在 macOS 上用 Node 22、24 运行测试
   - 校验 `package.json` 版本与 tag 完全一致
   - 校验 tag 序号与远端 `v*` tag 总数一致
   - 执行 `npm pack --dry-run`
   - 通过 `npm publish --provenance` 发布

发布失败时先确认失败发生在 publish 之前，并区分两种情况：

- **tag 内容无需改变**：例如 runner 或 registry 的临时故障，可以直接对同一个 tag 重跑 release 工作流，不消耗新序号
- **必须修改仓库内容**：例如测试、版本号或工作流本身有误，只修复 main 后重跑旧 tag 仍会检出旧内容。应先把修复提交合入 main，再将同名签名 tag 重新签在修复提交上，并按仓库 tag 保护规则替换远端同名 tag，使新运行检出修复后的内容；同名 tag 不增加远端计数，因此不消耗新序号

只有尚未成功 publish 的版本才能按后一种方式替换 tag。已经成功 publish 的版本不要再移动 tag，后续问题通过新的发布修复

## Trusted publishing 与凭据边界

npm 通过 GitHub OIDC 校验发布工作流身份，仓库中不保存长期 `NPM_TOKEN`。这降低了长期 npm 令牌泄漏的风险，但不等于所有凭据、工作流或账号安全风险都不存在

npm 包设置中需要一次性登记：

- repository：`adaex/cron-up`
- workflow：`release.yml`（仓库中的 `.github/workflows/release.yml`）
- 发布触发：同名 `v*` tag 对应的 GitHub Actions 运行

配置缺失或需要重建时，按 npm 官方 [Trusted Publishers 文档](https://docs.npmjs.com/trusted-publishers/)核对，同时确认 workflow 仍具有 `id-token: write`，且发布环境使用满足要求的 npm 版本

## 每次发版后的逐机升级与验收

按 26.10.32 的实际发布记录，publish 成功后 registry 通常约两分钟可查，偶发需要七八分钟；带 provenance 时还要等待透明日志与后端入库，本机元数据缓存可能进一步滞后

在当前机器符合使用边界且已有安装时，用户提出“发布”即包含发布成功后的升级与验收授权，不再单独确认

先按仓库根目录 `CLAUDE.md` 的「使用边界」确定本次允许操作的机器，再对范围内每一台已有安装的机器分别执行：

```bash
npm i -g cron-up@<新版本> --prefer-online
cron-up install
cron-up
```

- 第一条必须使用显式新版本号和 `--prefer-online`，不要用不带版本的模糊安装命令
- 第二条重建配置、启动脚本与 LaunchAgent，并尝试首轮巡检
- 最后以总览首行的实际版本号为准，同时确认服务已加载、上次退出码为 0、“需要留意”为空；不能用 npm 命令退出码或 registry 页面代替本机核验

未安装的机器不借本次升级新装；无法连接的机器明确记为未完成。npm publish 成功只代表包已发布，不代表各台机器已经升级或巡检健康

## 发布完成后的本地收尾

发布与范围内机器验收完成后，必须清理本次产生的本地临时内容，不把临时分支或 worktree 留到下次发布：

1. 回到 `main`，核实它已与 `origin/main` 同步且包含发布提交，工作区干净
2. 删除本次修复、发布用的临时分支；用过临时 worktree 时，合入并核实后再移除
3. 清理本次产生的打包、测试等临时文件。先用 `git status`、`git clean -nd` 和文件清单确认目标，只删明确属于本次操作的残留，不做未筛选的批量删除
4. 最后复查本地分支、worktree 与工作区，并在发布结果中说明清理完成情况

正式提交、发布 tag、已升级的全局命令和按本文保留的常驻 LaunchAgent 都不是临时残留，不在清理范围内
