# 斜杠命令（commands）

> 斜杠命令全量清单与**命令类 feature flag** 的单一入口。注册真源：`src/commands.ts`（`COMMANDS` 数组 + 条件 import + `INTERNAL_ONLY_COMMANDS`），各命令实现在 `src/commands/<name>/`。构建参数与其它 flag → [build.md](build.md)；工具 → [tools.md](tools.md)；技能/插件 → [skills-plugins.md](skills-plugins.md)。
> 改动命令注册或门控时必须同步本文。

## 1. 内置命令（默认可用）

「状态」口径：可用 = 编入且运行期可进入；条件 = 依赖平台 / 交互模式 / 远程开关 / 功能 Gate；禁用 = 注册了但内置 `isEnabled()` 恒 false；ANT-only = 仅 `USER_TYPE=ant` 显示。

| 命令 | 功能 | 源码 | 状态 |
|---|---|---|---|
| `/add-dir` | 添加额外工作目录 | [`src/commands/add-dir/index.ts`](../src/commands/add-dir/index.ts) | 可用 |
| `/agents` | 管理 agent 配置 | [`src/commands/agents/index.ts`](../src/commands/agents/index.ts) | 可用 |
| `/advisor` | 配置 advisor 模型 | [`src/commands/advisor.ts`](../src/commands/advisor.ts) | 可用 |
| `/btw` | 不打断主对话的侧问 | [`src/commands/btw/index.ts`](../src/commands/btw/index.ts) | 可用 |
| `/branch` | 在当前会话点创建分支 | [`src/commands/branch/index.ts`](../src/commands/branch/index.ts) | 可用 |
| `/chrome` | Claude in Chrome 设置 | [`src/commands/chrome/index.ts`](../src/commands/chrome/index.ts) | 条件（交互式 + 扩展） |
| `/clear` | 清空对话历史并释放上下文 | [`src/commands/clear/index.ts`](../src/commands/clear/index.ts) | 可用 |
| `/color` | 设置输入栏颜色 | [`src/commands/color/index.ts`](../src/commands/color/index.ts) | 可用 |
| `/compact` | 压缩对话为摘要（可带摘要指令） | [`src/commands/compact/index.ts`](../src/commands/compact/index.ts) | 可用 |
| `/config` | 打开配置面板 | [`src/commands/config/index.ts`](../src/commands/config/index.ts) | 可用 |
| `/context` | 以彩色网格可视化上下文占用 | [`src/commands/context/index.ts`](../src/commands/context/index.ts) | 可用 |
| `/copy` | 复制回复内容 | [`src/commands/copy/index.ts`](../src/commands/copy/index.ts) | 可用 |
| `/cost` | 显示会话成本与时长 | [`src/commands/cost/index.ts`](../src/commands/cost/index.ts) | 可用 |
| `/desktop` | 在桌面端继续当前会话 | [`src/commands/desktop/index.ts`](../src/commands/desktop/index.ts) | 条件（win x64 / macOS） |
| `/diff` | 查看未提交改动与逐回合差异 | [`src/commands/diff/index.ts`](../src/commands/diff/index.ts) | 可用 |
| `/doctor` | 诊断安装与设置 | [`src/commands/doctor/index.ts`](../src/commands/doctor/index.ts) | 可用 |
| `/effort` | 设置模型推理等级 | [`src/commands/effort/index.ts`](../src/commands/effort/index.ts) | 可用 |
| `/exit` | 退出 REPL | [`src/commands/exit/index.ts`](../src/commands/exit/index.ts) | 可用 |
| `/export` | 导出当前会话（文件或剪贴板） | [`src/commands/export/index.ts`](../src/commands/export/index.ts) | 可用 |
| `/extra-usage` | 额度用尽后的额外用量配置 | [`src/commands/extra-usage/index.ts`](../src/commands/extra-usage/index.ts) | 禁用（`isEnabled=false`） |
| `/fast` | 切换 fast 模式 | [`src/commands/fast/index.ts`](../src/commands/fast/index.ts) | 条件（fast 可用） |
| `/feedback` | 提交反馈 | [`src/commands/feedback/index.ts`](../src/commands/feedback/index.ts) | 条件（Bedrock/Vertex 等禁用） |
| `/files` | 列出上下文中全部文件 | [`src/commands/files/index.ts`](../src/commands/files/index.ts) | ANT-only |
| `/heapdump` | 导出 JS 堆到桌面 | [`src/commands/heapdump/index.ts`](../src/commands/heapdump/index.ts) | 可用 |
| `/help` | 显示帮助与可用命令 | [`src/commands/help/index.ts`](../src/commands/help/index.ts) | 可用 |
| `/hooks` | 查看工具事件的 hook 配置 | [`src/commands/hooks/index.ts`](../src/commands/hooks/index.ts) | 可用 |
| `/ide` | 管理 IDE 集成 | [`src/commands/ide/index.ts`](../src/commands/ide/index.ts) | 可用 |
| `/init` | 初始化项目配置 | [`src/commands/init.ts`](../src/commands/init.ts) | 可用 |
| `/insights` | 生成会话分析报告 | [`src/commands/insights.ts`](../src/commands/insights.ts) | 可用 |
| `/install-github-app` | 配置仓库的 GitHub Actions | [`src/commands/install-github-app/index.ts`](../src/commands/install-github-app/index.ts) | 可用 |
| `/install-slack-app` | 安装 Claude Slack 应用 | [`src/commands/install-slack-app/index.ts`](../src/commands/install-slack-app/index.ts) | 可用 |
| `/keybindings` | 打开/创建快捷键配置 | [`src/commands/keybindings/index.ts`](../src/commands/keybindings/index.ts) | 条件（Gate 开） |
| `/mcp` | 管理 MCP 服务器 | [`src/commands/mcp/index.ts`](../src/commands/mcp/index.ts) | 可用 |
| `/memory` | 编辑记忆文件 | [`src/commands/memory/index.ts`](../src/commands/memory/index.ts) | 可用 |
| `/mobile` | 下载移动端的二维码 | [`src/commands/mobile/index.ts`](../src/commands/mobile/index.ts) | 可用 |
| `/model` | 切换模型 | [`src/commands/model/index.ts`](../src/commands/model/index.ts) | 可用 |
| `/output-style` | 输出样式（已弃用，改用 `/config`） | [`src/commands/output-style/index.ts`](../src/commands/output-style/index.ts) | 可用 |
| `/passes` | 邀请奖励（分享免费周） | [`src/commands/passes/index.ts`](../src/commands/passes/index.ts) | 可用 |
| `/permissions` | 管理 allow / deny 权限规则 | [`src/commands/permissions/index.ts`](../src/commands/permissions/index.ts) | 可用 |
| `/plan` | 开启计划模式或查看当前计划 | [`src/commands/plan/index.ts`](../src/commands/plan/index.ts) | 可用 |
| `/plugin` | 管理插件 | [`src/commands/plugin/index.tsx`](../src/commands/plugin/index.tsx) | 可用 |
| `/pr-comments` | 获取 PR 评论 | [`src/commands/pr_comments/index.ts`](../src/commands/pr_comments/index.ts) | 可用 |
| `/privacy-settings` | 查看与更新隐私设置 | [`src/commands/privacy-settings/index.ts`](../src/commands/privacy-settings/index.ts) | 禁用（`isEnabled=false`） |
| `/rate-limit-options` | 限额到达时的选项 | [`src/commands/rate-limit-options/index.ts`](../src/commands/rate-limit-options/index.ts) | 禁用（`isEnabled=false`） |
| `/release-notes` | 查看发布说明 | [`src/commands/release-notes/index.ts`](../src/commands/release-notes/index.ts) | 可用 |
| `/reload-plugins` | 在当前会话激活待生效的插件变更 | [`src/commands/reload-plugins/index.ts`](../src/commands/reload-plugins/index.ts) | 可用 |
| `/remote-env` | 配置 teleport 会话的默认远程环境 | [`src/commands/remote-env/index.ts`](../src/commands/remote-env/index.ts) | 禁用（`isEnabled=false`） |
| `/rename` | 重命名当前会话 | [`src/commands/rename/index.ts`](../src/commands/rename/index.ts) | 可用 |
| `/resume` | 恢复历史会话 | [`src/commands/resume/index.ts`](../src/commands/resume/index.ts) | 可用 |
| `/rewind` | 回退代码和/或对话到先前节点 | [`src/commands/rewind/index.ts`](../src/commands/rewind/index.ts) | 可用 |
| `/sandbox` | 切换沙箱 | [`src/commands/sandbox-toggle/index.ts`](../src/commands/sandbox-toggle/index.ts) | 可用 |
| `/security-review` | 审查当前分支待提交改动的安全性 | [`src/commands/security-review.ts`](../src/commands/security-review.ts) | 可用 |
| `/session` | 显示远程会话 URL 与二维码 | [`src/commands/session/index.ts`](../src/commands/session/index.ts) | 条件（远程模式） |
| `/skills` | 列出可用技能 | [`src/commands/skills/index.ts`](../src/commands/skills/index.ts) | 可用 |
| `/stats` | 查看使用统计 | [`src/commands/stats/index.ts`](../src/commands/stats/index.ts) | 可用 |
| `/status` | 显示版本、模型、账户、API 连通与工具状态 | [`src/commands/status/index.ts`](../src/commands/status/index.ts) | 可用 |
| `/statusline` | 配置状态栏 | [`src/commands/statusline.tsx`](../src/commands/statusline.tsx) | 可用 |
| `/stickers` | 订购贴纸 | [`src/commands/stickers/index.ts`](../src/commands/stickers/index.ts) | 可用 |
| `/tag` | 为当前会话切换可搜索标记 | [`src/commands/tag/index.ts`](../src/commands/tag/index.ts) | ANT-only |
| `/tasks` | 列出并管理后台任务 | [`src/commands/tasks/index.ts`](../src/commands/tasks/index.ts) | 可用 |
| `/terminal-setup` | 配置终端快捷键 | [`src/commands/terminalSetup/index.ts`](../src/commands/terminalSetup/index.ts) | 可用 |
| `/theme` | 切换主题 | [`src/commands/theme/index.ts`](../src/commands/theme/index.ts) | 可用 |
| `/think-back` | 年度回顾 | [`src/commands/thinkback/index.ts`](../src/commands/thinkback/index.ts) | 条件（Statsig Gate） |
| `/thinkback-play` | 播放回顾动画 | [`src/commands/thinkback-play/index.ts`](../src/commands/thinkback-play/index.ts) | 条件（Statsig Gate） |
| `/upgrade` | 升级订阅档位 | [`src/commands/upgrade/index.ts`](../src/commands/upgrade/index.ts) | 可用 |
| `/vim` | 切换 Vim / 普通编辑模式 | [`src/commands/vim/index.ts`](../src/commands/vim/index.ts) | 可用 |

## 2. 条件编入的命令

来源：`src/commands.ts` 中以 `feature()` 判定后用 `require` 条件载入的命令。除 `/server` 外默认构建均不编入。

| 命令 | 功能 | 门控 | 状态 |
|---|---|---|---|
| `/server` | 内置网关独立进程 | `PRIVATE_GATEWAY`（默认开） | 可用（默认编入） |
| `/remote-control` | 终端远程控制会话 | `BRIDGE_MODE` | 未编入 |
| `/remoteControlServer` | 常驻远程控制服务 | `DAEMON` + `BRIDGE_MODE`（已放弃） | 已放弃 |
| `/remote-setup` | 远程 setup 路径 | `CCR_REMOTE_SETUP`（已放弃） | 已放弃 |
| `/voice` | 语音模式 | `VOICE_MODE`（实验；OAuth 语音后端已移除，运行期恒不可用） | 未编入（运行期恒不可用） |
| `/assistant` | 云端 assistant 完整栈 | `KAIROS` | 已放弃 |
| `/proactive` | 主动式任务 | `PROACTIVE` / `KAIROS` | 已放弃 |
| `/brief` | brief-only 模式开关 | `KAIROS` / `KAIROS_BRIEF` | 未编入 |
| `/workflows` | 工作流脚本命令 | `WORKFLOW_SCRIPTS` | 未编入 |
| `/peers` | 会话间 UDS 对端 | `UDS_INBOX` | 缺文件 |
| `/force-snip` | 强制裁剪历史消息 | `HISTORY_SNIP`（stub） | stub |
| `/subscribe-pr` | 订阅 PR webhook | `KAIROS_GITHUB_WEBHOOKS`（stub） | stub |
| `/fork` | 子 agent 分支 | `FORK_SUBAGENT`（stub） | stub |
| `/buddy` | 伴侣角色 | `BUDDY`（stub） | stub |
| `/torch` | torch 命令 | `TORCH`（stub） | stub |
| `/ultraplan` | 超级计划流程 | `ULTRAPLAN`（实验） | 未编入（实验） |

`/init` 另有 `NEW_INIT` 实验路径（`src/commands/init.ts`）。

## 3. 内部命令（ANT-only）

在 `INTERNAL_ONLY_COMMANDS` 中，仅 `USER_TYPE=ant` 且非 demo 构建编入。

| 命令 | 状态 |
|---|---|
| `/ant-trace` | stub |
| `/autofix-pr` | stub |
| `/backfill-sessions` | stub |
| `/break-cache` | stub（`isEnabled=false`） |
| `/bridge-kick` | stub |
| `/bughunter` | stub |
| `/commit` | 可用（prompt 型） |
| `/commit-push-pr` | 可用（prompt 型） |
| `/ctx_viz` | stub |
| `/debug-tool-call` | stub |
| `/env` | stub |
| `/good-claude` | stub |
| `/init-verifiers` | 可用（prompt 型） |
| `/issue` | stub |
| `/mock-limits` | stub |
| `/onboarding` | stub |
| `/perf-issue` | stub |
| `/reset-limits` | stub |
| `/share` | stub |
| `/summary` | stub |
| `/teleport` | stub |
| `/version` | 可用 |

## 4. 命令类 Feature Flag

| 名称 | 功能 | 源码文件 | 状态 |
|---|---|---|---|
| `VOICE_MODE` | `/voice`、push-to-talk、语音通知与听写编排 | [`src/commands/voice/index.ts`](../src/commands/voice/index.ts)、[`src/components/PromptInput/Notifications.tsx`](../src/components/PromptInput/Notifications.tsx) | 实验；OAuth 语音后端已移除，运行期恒不可用 |
| `ULTRAPLAN` | `/ultraplan`、提示触发与退出计划 UI | [`src/commands/ultraplan.tsx`](../src/commands/ultraplan.tsx) | 实验 |
| `NEW_INIT` | `/init` 新决策路径 | [`src/commands/init.ts`](../src/commands/init.ts) | 实验 |
| `BREAK_CACHE_COMMAND` | `/break-cache` 命令 | [`src/context.ts`](../src/context.ts)、[`src/commands/break-cache/index.js`](../src/commands/break-cache/index.js) | 支持 |
| `KAIROS_GITHUB_WEBHOOKS` | `/subscribe-pr` + `SubscribePRTool` + GitHub webhook 消息 | [`src/commands/subscribe-pr.js`](../src/commands/subscribe-pr.js)、[`src/hooks/useReplBridge.tsx`](../src/hooks/useReplBridge.tsx) | stub（禁用） |
| `FORK_SUBAGENT` | `/fork` 子 agent 与 boilerplate | [`src/commands/branch/index.ts`](../src/commands/branch/index.ts) | stub（禁用） |
| `BUDDY` | `/buddy` 伴侣角色 | [`src/buddy/companion.ts`](../src/buddy/companion.ts) | stub（禁用） |
| `TORCH` | `/torch` 命令 | [`src/commands/torch.js`](../src/commands/torch.js) | stub（禁用） |
| `BG_SESSIONS` | 后台会话命令与退出处理 | [`src/commands/exit/exit.tsx`](../src/commands/exit/exit.tsx) | stub（禁用） |
| `DAEMON` | `/remoteControlServer` 常驻远程控制 | `src/commands/remoteControlServer/`（缺失） | 已放弃（内置网关承担） |
| `CCR_REMOTE_SETUP` | 远程 setup 命令路径 | [`src/commands.ts`](../src/commands.ts) | 已放弃 |
