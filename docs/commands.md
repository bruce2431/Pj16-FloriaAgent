# 斜杠命令（commands）

> 斜杠命令全量清单与**命令类 feature flag** 的单一入口。注册真源：`src/commands.ts`（`COMMANDS` 数组 + 条件 import + `INTERNAL_ONLY_COMMANDS`），各命令实现在 `src/commands/<name>/`。构建参数与其它 flag → [build.md](build.md)；工具 → [tools.md](tools.md)；技能/插件 → [skills-plugins.md](skills-plugins.md)。
> 改动命令注册或门控时必须同步本文。

## 1. 内置命令（默认可用）

| 命令 | 功能 | 源码 |
|---|---|---|
| `/add-dir` | 添加额外工作目录 | `src/commands/add-dir/` |
| `/agents` | 管理 agent 配置 | `src/commands/agents/` |
| `/advisor` | 配置 advisor 模型 | `src/commands/advisor.ts` |
| `/btw` | 不打断主对话的侧问 | `src/commands/btw/` |
| `/branch` | 在当前会话点创建分支 | `src/commands/branch/` |
| `/chrome` | Claude in Chrome 设置 | `src/commands/chrome/` |
| `/clear` | 清空对话历史并释放上下文 | `src/commands/clear/` |
| `/color` | 设置输入栏颜色 | `src/commands/color/` |
| `/compact` | 压缩对话为摘要（可带摘要指令） | `src/commands/compact/` |
| `/config` | 打开配置面板 | `src/commands/config/` |
| `/context` | 以彩色网格可视化上下文占用 | `src/commands/context/` |
| `/copy` | 复制回复内容 | `src/commands/copy/` |
| `/cost` | 显示会话成本与时长 | `src/commands/cost/` |
| `/desktop` | 在桌面端继续当前会话 | `src/commands/desktop/` |
| `/diff` | 查看未提交改动与逐回合差异 | `src/commands/diff/` |
| `/doctor` | 诊断安装与设置 | `src/commands/doctor/` |
| `/effort` | 设置模型推理等级 | `src/commands/effort/` |
| `/exit` | 退出 REPL | `src/commands/exit/` |
| `/export` | 导出当前会话（文件或剪贴板） | `src/commands/export/` |
| `/extra-usage` | 额度用尽后的额外用量配置 | `src/commands/extra-usage/` |
| `/fast` | 切换 fast 模式 | `src/commands/fast/` |
| `/feedback` | 提交反馈 | `src/commands/feedback/` |
| `/files` | 列出上下文中全部文件 | `src/commands/files/` |
| `/heapdump` | 导出 JS 堆到桌面 | `src/commands/heapdump/` |
| `/help` | 显示帮助与可用命令 | `src/commands/help/` |
| `/hooks` | 查看工具事件的 hook 配置 | `src/commands/hooks/` |
| `/ide` | 管理 IDE 集成 | `src/commands/ide/` |
| `/init` | 初始化项目配置 | `src/commands/init.ts` |
| `/insights` | 生成会话分析报告 | `src/commands/insights.ts` |
| `/install-github-app` | 配置仓库的 GitHub Actions | `src/commands/install-github-app/` |
| `/install-slack-app` | 安装 Claude Slack 应用 | `src/commands/install-slack-app/` |
| `/keybindings` | 打开/创建快捷键配置 | `src/commands/keybindings/` |
| `/mcp` | 管理 MCP 服务器 | `src/commands/mcp/` |
| `/memory` | 编辑记忆文件 | `src/commands/memory/` |
| `/mobile` | 下载移动端的二维码 | `src/commands/mobile/` |
| `/model` | 切换模型 | `src/commands/model/` |
| `/output-style` | 输出样式（已弃用，改用 `/config`） | `src/commands/output-style/` |
| `/passes` | 邀请奖励（分享免费周） | `src/commands/passes/` |
| `/permissions` | 管理 allow / deny 权限规则 | `src/commands/permissions/` |
| `/plan` | 开启计划模式或查看当前计划 | `src/commands/plan/` |
| `/plugin` | 管理插件 | `src/commands/plugin/` |
| `/pr-comments` | 获取 PR 评论 | `src/commands/pr_comments/` |
| `/privacy-settings` | 查看与更新隐私设置 | `src/commands/privacy-settings/` |
| `/rate-limit-options` | 限额到达时的选项 | `src/commands/rate-limit-options/` |
| `/release-notes` | 查看发布说明 | `src/commands/release-notes/` |
| `/reload-plugins` | 在当前会话激活待生效的插件变更 | `src/commands/reload-plugins/` |
| `/remote-env` | 配置 teleport 会话的默认远程环境 | `src/commands/remote-env/` |
| `/rename` | 重命名当前会话 | `src/commands/rename/` |
| `/resume` | 恢复历史会话 | `src/commands/resume/` |
| `/rewind` | 回退代码和/或对话到先前节点 | `src/commands/rewind/` |
| `/sandbox` | 切换沙箱 | `src/commands/sandbox-toggle/` |
| `/security-review` | 审查当前分支待提交改动的安全性 | `src/commands/security-review.js` |
| `/session` | 显示远程会话 URL 与二维码 | `src/commands/session/` |
| `/skills` | 列出可用技能 | `src/commands/skills/` |
| `/stats` | 查看使用统计 | `src/commands/stats/` |
| `/status` | 显示版本、模型、账户、API 连通与工具状态 | `src/commands/status/` |
| `/statusline` | 配置状态栏 | `src/commands/statusline/` |
| `/stickers` | 订购贴纸 | `src/commands/stickers/` |
| `/tag` | 为当前会话切换可搜索标记 | `src/commands/tag/` |
| `/tasks` | 列出并管理后台任务 | `src/commands/tasks/` |
| `/terminal-setup` | 配置终端快捷键 | `src/commands/terminalSetup/` |
| `/theme` | 切换主题 | `src/commands/theme/` |
| `/think-back` | 年度回顾 | `src/commands/thinkback/` |
| `/thinkback-play` | 播放回顾动画 | `src/commands/thinkback-play/` |
| `/upgrade` | 升级订阅档位 | `src/commands/upgrade/` |
| `/vim` | 切换 Vim / 普通编辑模式 | `src/commands/vim/` |

## 2. 条件编入的命令

来源：`src/commands.ts` 中以 `feature()` 判定后用 `require` 条件载入的命令。除 `/server` 外默认构建均不编入。

| 命令 | 功能 | 门控 |
|---|---|---|
| `/server` | 内置网关独立进程 | `PRIVATE_GATEWAY`（默认开） |
| `/remote-control` | 终端远程控制会话 | `BRIDGE_MODE` |
| `/remoteControlServer` | 常驻远程控制服务 | `DAEMON` + `BRIDGE_MODE`（已放弃） |
| `/remote-setup` | 远程 setup 路径 | `CCR_REMOTE_SETUP`（已放弃） |
| `/voice` | 语音模式 | `VOICE_MODE`（实验；OAuth 语音后端已移除，运行期恒不可用） |
| `/assistant` | 云端 assistant 完整栈 | `KAIROS` |
| `/proactive` | 主动式任务 | `PROACTIVE` / `KAIROS` |
| `/brief` | brief-only 模式开关 | `KAIROS` / `KAIROS_BRIEF` |
| `/workflows` | 工作流脚本命令 | `WORKFLOW_SCRIPTS` |
| `/peers` | 会话间 UDS 对端 | `UDS_INBOX` |
| `/force-snip` | 强制裁剪历史消息 | `HISTORY_SNIP`（stub） |
| `/subscribe-pr` | 订阅 PR webhook | `KAIROS_GITHUB_WEBHOOKS`（stub） |
| `/fork` | 子 agent 分支 | `FORK_SUBAGENT`（stub） |
| `/buddy` | 伴侣角色 | `BUDDY`（stub） |
| `/torch` | torch 命令 | `TORCH`（stub） |
| `/ultraplan` | 超级计划流程 | `ULTRAPLAN`（实验） |

`/init` 另有 `NEW_INIT` 实验路径（`src/commands/init.ts`）。

## 3. 内部命令（ANT-only）

在 `INTERNAL_ONLY_COMMANDS` 中，仅 `USER_TYPE=ant` 且非 demo 构建编入；其中多数为 stub（不可用）。

`/ant-trace`、`/autofix-pr`、`/backfill-sessions`、`/break-cache`、`/bridge-kick`、`/bughunter`、`/commit`、`/commit-push-pr`、`/ctx_viz`、`/debug-tool-call`、`/env`、`/good-claude`、`/init-verifiers`、`/issue`、`/mock-limits`、`/onboarding`、`/perf-issue`、`/reset-limits`、`/share`、`/summary`、`/teleport`、`/version`。

## 4. 命令类 Feature Flag

| 名称 | 功能 | 源码文件 | 状态 |
|---|---|---|---|
| `VOICE_MODE` | `/voice`、push-to-talk、语音通知与听写编排 | `src/commands/voice/`、`src/components/PromptInput/Notifications.tsx` | 实验；OAuth 语音后端已移除，运行期恒不可用 |
| `ULTRAPLAN` | `/ultraplan`、提示触发与退出计划 UI | `src/commands/ultraplan.tsx` | 实验 |
| `NEW_INIT` | `/init` 新决策路径 | `src/commands/init.ts` | 实验 |
| `BREAK_CACHE_COMMAND` | `/break-cache` 命令 | `src/context.ts`、`src/commands/break-cache/` | 支持 |
| `KAIROS_GITHUB_WEBHOOKS` | `/subscribe-pr` + `SubscribePRTool` + GitHub webhook 消息 | `src/commands/subscribe-pr.js`、`src/hooks/useReplBridge.tsx` | stub（禁用） |
| `FORK_SUBAGENT` | `/fork` 子 agent 与 boilerplate | `src/commands/branch/index.ts` | stub（禁用） |
| `BUDDY` | `/buddy` 伴侣角色 | `src/buddy/` | stub（禁用） |
| `TORCH` | `/torch` 命令 | `src/commands/torch.js` | stub（禁用） |
| `BG_SESSIONS` | 后台会话命令与退出处理 | `src/commands/exit/exit.tsx` | stub（禁用） |
| `DAEMON` | `/remoteControlServer` 常驻远程控制 | `src/commands/remoteControlServer/`（缺失） | 已放弃（内置网关承担） |
| `CCR_REMOTE_SETUP` | 远程 setup 命令路径 | `src/commands.ts` | 已放弃 |
