# 构建标准与 Feature Flag 总表（build）

> 本文件属 `docs/` 文档库。
> 权威规则与姊妹件：**总标准 → [standards.md](standards.md)**；**前端打包对网关侧的效应 → [gateway.md](gateway.md)**。

## 1. 构建

源码构建区 = 本仓库根（`Floria/`）：`src/` `scripts/` `probes/` `package.json` `bun.lock` `tsconfig.json` `env.d.ts` `node_modules/`。本目录即仓库根，其自身内容全量入库，`node_modules/`/`dist/`/`temp/`/`*.exe` 由 `.gitignore` 排除。

### 1.1 调用

均在 `cd Pj16-CodeAgent构建/Floria` 后执行（bun >= 1.3.11）：

| 命令 | 产物 | 用途 |
|---|---|---|
| `bun install` | — | 装依赖 |
| `bun run build:dev` | 项目根 `cli-dev-<YYYYMMDDHHMMSS>.exe` | **dev 构建即部署，统一入口**（产物直出项目根） |
| `bun run build` | 项目根 `cli-<YYYYMMDDHHMMSS>.exe` | 非 dev 构建 |
| `bun run compile` | `dist/cli-<YYYYMMDDHHMMSS>.exe` | 正式发布用 |
| `bun run build:dev:full` | 项目根 `cli-dev-<ts>.exe` | 等价 `--dev --feature-set=dev-full`，开全部实验特性 |
| `bun run dev` | — | 源码直跑（入口 `src/entrypoints/cli.tsx`） |

### 1.2 参数

`scripts/build.ts` 直接读 `process.argv`，参数随 `bun run ./scripts/build.ts` 一起传（npm 脚本只是快捷方式）：

| 参数 | 写法 | 作用 |
|---|---|---|
| `--dev` | 开关 | dev 模式：产物前缀 `cli-dev`，版本串 `x.y.z+<日期>.t<时分秒>.sha<HEAD 8 位>` |
| `--compile` | 开关 | 产物落 `dist/`（与 `--dev` 组合时为 `dist/cli-dev-…`） |
| `--feature=X` | `--feature=X` 或 `--feature X`，可多次 | 追加单个特性；产物名末尾追加 `-<代号>`（多个代号用 `+` 连接）。|
| `--feature-set=dev-full` | `--feature-set=dev-full` 或 `--feature-set dev-full` | 并入全部实验特性（32 项，见各表状态列「实验」） |

### 1.3 产物规则

- **ripgrep 内嵌**（Grep/Glob 依赖）：exe 不自带系统 rg，构建时把 `src/vendor/ripgrep/<arch>-<platform>/rg[.exe]` 内嵌进产物。**不变量：Grep/Glob 与 Bash 的 `rg` 必须共用同一 `ripgrepCommand()` 解析；勿回退 `argv0='rg'` 分发。**

### 1.4 前端内嵌打包与 cache-busting（改 web 前端必读）

前端权威 `src/gateway/web-src/`（`gateway/web/app.js` 为构建生成物勿手改；模块边界是源码组织、拼接时 import/export 全剥除，模块清单与分层见 [web-ui.md](web-ui.md) §12）；构建时 `scripts/gen-web-assets.ts` 把 `src/gateway/web/` 递归 base64 内联进 exe（build.ts 每次构建前自动运行）。运行时唯一投送点 = `src/gateway/webAssets.ts`：存在 dev 磁盘 web 目录（exe 邻接或 cwd）则读磁盘，否则用内嵌资源。**dev 磁盘层改前端刷新即生效；部署 exe 走内嵌层，前端改动必须重新构建。****cache-busting**：index.html 资源引用带版本号 `?v=N`（styles.css/app.js），每次前端改动同步 bump 该号（+ sw.js CACHE），浏览器强制下载新版绕过 HTTP 缓存（资源引用为绝对路径，见 [web-ui.md](web-ui.md) §1）；**注意：前端从未注册 Service Worker**（web/ 目录无 serviceWorker 代码，sw.js 是死文件，浏览器不跑它——更新可靠靠 cache-busting 而非 sw）。**bytecode exe 内嵌资产不可 grep**（字符串经编码），验证资产版本用 `curl http://127.0.0.1:8124/sw.js` 与 `/app.js`。

**vendored 第三方库（拼接器不解析 npm，第三方一律全局 `<script>`）**：拼接器 `bundle-web-modules.ts` 只拼 `web-src/**`、**不解析 npm 依赖** ⇒ 任何 npm 包必须**预打包成全局 IIFE** 提交进 `src/gateway/web/`（`gen-web-assets.ts` 递归自动内嵌，`sw.js` CORE 可预缓存，`index.html` 在 `/app.js` 之前以 `<script>` 引入）。先例 = KaTeX（`vendor/katex/`，见 [web-ui.md](web-ui.md) §57）与 CM6 编辑层（`cm6/floria-cm6.iife.js`，全局 `window.FloriaCM6`，见 §71）。**生成器/构建手动跑、不接进 `build.ts`** ⇒ **常规构建不联网**。CM6 IIFE 的生成工程 = 兄弟目录 `SubPj4-CodeMirror6开发`（`bun build.ts` → `dist/floria-cm6.iife.js`，CM6 依赖全内联），`bun tools/sync.ts deploy --yes` 只把该 IIFE 拷进 `Floria/src/gateway/web/cm6/`；ESM/sourcemap 不部署（exe 内嵌按字节计）。该包直连 npm 的 `@codemirror/*`（state/view/commands/autocomplete/language 及 lang-markdown/javascript/json/css/html/python）、`@codemirror/legacy-modes`（shell/yaml/stex）、`@lezer/markdown`、`@lezer/highlight`、`codemirror-live-markdown@0.5.1-alpha.1`。**上游库补丁**：包内 `package.json` 的 `patchedDependencies` 指向 `patches/codemirror-live-markdown@0.5.1-alpha.1.patch`（`[floria patch]`：围栏行隐藏 + 语言钮），`bun install` 时自动重放；**改库版本后必须重做补丁**（补丁按行号定位，版本一变即漂）。

## 2. Feature Flag 总表

源码共引用 92 个 `feature('FLAG')` 编译期旗标（单双引号两种写法均已计入）。按门控对象分表，每表列：名称、功能、源码文件（门控/实现主件）、状态。

状态口径：

| 状态 | 含义 |
|---|---|
| 默认开 | 进 `defaultFeatures`，所有构建编入 |
| 实验 | 可干净打包，默认关；`--feature=X` 或 `--feature-set=dev-full` 编入 |
| 支持 | rollout/平台/遥测/构建类开关，非用户可见实验 |
| 已恢复 | 曾因缺文件不可打包，现已补齐；是否进默认构建见表内标注 |
| stub | 占位文件已补齐可编译，运行时禁用（多数 `isEnabled: () => false`） |
| 已放弃 | 远程/云端方向，不恢复；源码门控保留供编译期 tree-shake |
| 缺文件 | 首次缺失 import 即不可打包 |

> 「可打包」不等于「运行期安全」：部分实验 flag 运行期仍依赖可选原生模块、外部化 `@ant/*` 包或云端账号。

### 2.1 默认构建（5）

| 名称 | 功能 | 源码文件 | 状态 |
|---|---|---|---|
| `BUILTIN_EXPLORE_PLAN_AGENTS` | 内置 explore/plan agent 预设 | `src/tools/AgentTool/builtInAgents.ts` | 默认开（也在 dev-full 集） |
| `PRIVATE_GATEWAY` | 内置网关：`/server` 指令、`--gateway` 独立进程、内嵌 web 前端；token 落 `getPortableRoot()/.claude/gateway/token`，空闲 10 分钟（`GATEWAY_IDLE_MINUTES`）自动回收 | `src/commands.ts`、`src/utils/gatewayClient.ts` | 默认开 |
| `REACTIVE_COMPACT` | 拒答（usage-policy refusal）、PTL、媒体超限三类自动剥图恢复；可 `CLAUDE_CODE_DISABLE_REACTIVE_COMPACT` 停用 | `src/services/compact/reactiveCompact.ts`、`src/query.ts` | 默认开 |
| `SESSION_LINK` | 会话间协作：`session_send`（只认 sid）+ `session_search`（本项目最近 10 个标题） | `src/tools/SessionSendTool/SessionSendTool.ts`、`src/tools/SessionSearchTool/SessionSearchTool.ts` | 默认开 |
| `CARD_API` | `CardCall` 工具：agent 驱动浏览器在场卡片（list/call） | `src/tools/CardCallTool/CardCallTool.ts`、`src/tools.ts` | 默认开 |

### 2.2 工具（19）

| 名称 | 功能 | 源码文件 | 状态 |
|---|---|---|---|
| `AGENT_TRIGGERS` | 本地 cron/trigger 工具（CronCreate/Delete/List） | `src/tools/ScheduleCronTool/`、`src/constants/tools.ts` | 实验 |
| `AGENT_TRIGGERS_REMOTE` | 远程触发工具 `RemoteTrigger` | `src/tools/RemoteTriggerTool/RemoteTriggerTool.ts`、`src/tools.ts` | 实验 |
| `MONITOR_TOOL` | `Monitor` 工具：spawn 后台监控进程并流式通知 | `src/tools/MonitorTool/MonitorTool.tsx` | 已恢复（默认不编入） |
| `REVIEW_ARTIFACT` | `ReviewArtifact` 工具：批准弹窗选 finding，产物落 `.claude/reviews/` | `src/tools/ReviewArtifactTool/ReviewArtifactTool.tsx` | 已恢复（默认不编入） |
| `WORKFLOW_SCRIPTS` | `Workflow` 工具：扫描 `.claude/workflows/*.md` 并 spawn 后台任务；脚本另注册为 `/name` | `src/tools/WorkflowTool/WorkflowTool.tsx`、`src/commands/workflows/` | 已恢复（默认不编入，需 `--feature=WORKFLOW_SCRIPTS`） |
| `HISTORY_SNIP` | `SnipTool` + 历史裁剪投影 | `src/tools/SnipTool/` | stub（禁用） |
| `KAIROS_PUSH_NOTIFICATION` | `PushNotificationTool` | `src/tools/PushNotificationTool/` | stub（禁用） |
| `OVERFLOW_TEST_TOOL` | `OverflowTestTool` | `src/tools/OverflowTestTool/` | stub（禁用） |
| `CONTEXT_COLLAPSE` | `CtxInspectTool` 上下文折叠 | `src/tools/CtxInspectTool/CtxInspectTool.js`（缺失） | 缺文件 |
| `WEB_BROWSER_TOOL` | `WebBrowserTool` | `src/tools/WebBrowserTool/WebBrowserTool.js`（缺失） | 缺文件 |
| `UDS_INBOX` | UDS 会话互发（`udsMessaging` + `ListPeersTool`）；无网关独立会话的一等能力 | `src/utils/udsMessaging.js`、`src/tools/ListPeersTool/`（缺失） | 缺文件 |
| `TERMINAL_PANEL` | `TerminalCaptureTool` 终端面板 | `src/tools/TerminalCaptureTool/`（缺失） | 缺文件 |
| `BASH_CLASSIFIER` | 分类器辅助的 bash 权限判定 | `src/cli/structuredIO.ts`、`src/utils/permissions/` | 实验 |
| `POWERSHELL_AUTO_MODE` | PowerShell 自动权限模式 | `src/utils/permissions/permissions.ts`、`yoloClassifier.ts` | 实验 |
| `TREE_SITTER_BASH` | tree-sitter bash 解析后端 | `src/utils/bash/parser.ts` | 实验 |
| `TREE_SITTER_BASH_SHADOW` | tree-sitter bash 影子 rollout | `src/tools/BashTool/bashPermissions.ts`、`src/utils/bash/parser.ts` | 实验 |
| `NEURON_RAG` | 本 fork 神经元记忆/RAG：`recall`/`remember` 常驻 + `neuron_list`/`neuron_source`/`neuron_fill_precog`/`neuron_cog` 延迟加载 | `src/tools/neturon/`、`src/constants/prompts.ts` | 本 fork 专有（默认关，显式 `--feature=NEURON_RAG`） |
| `CHICAGO_MCP` | computer-use MCP 集成与 wrapper 加载 | `src/entrypoints/cli.tsx`、`src/main.tsx` | 可打包；运行期依赖外部化 `@ant/computer-use-*`，非 runtime-safe |
| `NATIVE_CLIPBOARD_IMAGE` | macOS 原生剪贴板读图快路径（需 `image-processor-napi`） | `src/utils/imagePaste.ts` | 实验 |

### 2.3 技能（6）

| 名称 | 功能 | 源码文件 | 状态 |
|---|---|---|---|
| `BUILDING_CLAUDE_APPS` | `claude-api` 技能（Claude API 应用构建） | `src/skills/bundled/claudeApi.ts` | stub（仅多语言 `.md` 资产） |
| `RUN_SKILL_GENERATOR` | 技能生成器技能 | `src/skills/bundled/runSkillGenerator.js` | stub（注册即禁用） |
| `KAIROS_DREAM` | 云端 dream 技能与任务行为 | `src/skills/bundled/dream.js`（缺失） | 已放弃 |
| `MCP_SKILLS` | MCP 技能发现 | `src/services/mcp/client.ts`、`src/commands.ts` | stub（返回 `[]`） |
| `EXPERIMENTAL_SKILL_SEARCH` | 技能检索服务（localSearch/prefetch） | `src/services/skillSearch/`（缺失） | 缺文件 |
| `SKILL_IMPROVEMENT` | 技能改进 hook | `src/utils/hooks/skillImprovement.ts` | 支持（默认关） |

### 2.4 插件（1）

| 名称 | 功能 | 源码文件 | 状态 |
|---|---|---|---|
| `MCP_RICH_OUTPUT` | MCP 工具富输出渲染 UI | `src/tools/MCPTool/UI.tsx` | 实验 |

### 2.5 斜杠命令（11）

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

### 2.6 Agent / 记忆 / 规划（9）

| 名称 | 功能 | 源码文件 | 状态 |
|---|---|---|---|
| `AGENT_MEMORY_SNAPSHOT` | 自定义 agent 记忆快照 | `src/tools/AgentTool/loadAgentsDir.ts`、`src/main.tsx` | 实验 |
| `CACHED_MICROCOMPACT` | 微压缩缓存状态 | `src/query.ts`、`src/constants/prompts.ts` | 实验 |
| `COMPACTION_REMINDERS` | 压缩与附件流程提醒文案 | `src/utils/attachments.ts` | 实验 |
| `EXTRACT_MEMORIES` | 对话后记忆抽取 hook | `src/memdir/paths.ts`、`src/cli/print.ts` | 实验 |
| `PROMPT_CACHE_BREAK_DETECTION` | 缓存断点检测 | `src/services/api/claude.ts`、`src/commands/compact/compact.ts` | 实验 |
| `TEAMMEM` | 团队记忆文件、watcher 与 UI 消息 | `src/components/memory/`、`src/memdir/` | 实验 |
| `VERIFICATION_AGENT` | 验证 agent 提示与任务/todo 工具引导 | `src/tools/AgentTool/builtInAgents.ts`、`src/constants/prompts.ts` | 实验 |
| `COORDINATOR_MODE` | coordinator + worker 两个内置 agent（`subagent_type: 'worker'`） | `src/coordinator/workerAgent.ts`、`src/coordinator/coordinatorMode.ts` | 已恢复（默认不编入） |
| `PROACTIVE` | 云端主动任务栈 | `src/proactive/`（缺失） | 已放弃 |

### 2.7 UI / 交互（13）

| 名称 | 功能 | 源码文件 | 状态 |
|---|---|---|---|
| `AWAY_SUMMARY` | 离开回来摘要 | `src/hooks/useAwaySummary.ts`、`src/screens/REPL.tsx` | 实验 |
| `HISTORY_PICKER` | 交互式提示历史选择器 | `src/hooks/useHistorySearch.ts`、`src/components/PromptInput/PromptInput.tsx` | 实验 |
| `HOOK_PROMPTS` | hook 执行流接收 prompt/request 文本 | `src/screens/REPL.tsx` | 实验 |
| `KAIROS_BRIEF` | brief-only 转录布局与 `BriefTool` 导向 UX | `src/commands/brief.ts` | 实验（不恢复完整 assistant 栈） |
| `KAIROS_CHANNELS` | 频道通知与 MCP/频道回调 | `src/components/LogoV2/ChannelsNotice.tsx`、`src/cli/print.ts` | 实验 |
| `LODESTONE` | 深链/协议注册与设置接线 | `src/main.tsx`、`src/interactiveHelpers.tsx` | 实验 |
| `MESSAGE_ACTIONS` | 交互 UI 的消息动作入口 | `src/screens/REPL.tsx`、`src/keybindings/defaultBindings.ts` | 实验 |
| `QUICK_SEARCH` | 提示快速搜索 | `src/components/PromptInput/PromptInput.tsx`、`src/keybindings/defaultBindings.ts` | 实验 |
| `SHOT_STATS` | 附加投递分布统计视图 | `src/utils/stats.ts`、`src/components/Stats.tsx` | 实验 |
| `TOKEN_BUDGET` | token 预算跟踪、提示触发与警告 UI | `src/components/Spinner.tsx`、`src/components/PromptInput/PromptInput.tsx` | 实验 |
| `ULTRATHINK` | 额外思考深度档 | `src/utils/thinking.ts` | 实验 |
| `STREAMLINED_OUTPUT` | headless `stream-json` 的精简输出（`CLAUDE_CODE_STREAMLINED_OUTPUT=true`） | `src/cli/print.ts` | 实验 |
| `AUTO_THEME` | OSC 11 主题跟随（5s 轮询） | `src/components/design-system/ThemeProvider.tsx`、`src/tools/ConfigTool/supportedSettings.ts` | stub |

### 2.8 平台 / 远程 / 权限（12）

| 名称 | 功能 | 源码文件 | 状态 |
|---|---|---|---|
| `BRIDGE_MODE` | Remote Control / REPL bridge 与 entitlement 路径 | `src/bridge/bridgeEnabled.ts`、`src/commands/bridge/index.ts` | 已放弃（内置网关覆盖） |
| `CCR_AUTO_CONNECT` | CCR 自动连接默认路径 | `src/bridge/bridgeEnabled.ts`、`src/utils/config.ts` | 已放弃 |
| `CCR_MIRROR` | 只出向 CCR 镜像会话 | `src/bridge/remoteBridgeCore.ts` | 已放弃（本地已由 `conversationDisplay.ts` 上报链承担） |
| `DIRECT_CONNECT` | `claude open <cc://url>` 外部直连会话 | `src/main.tsx` | 已放弃（依赖缺失的 `src/server/parseConnectUrl.js`） |
| `SSH_REMOTE` | `claude ssh <host>` 远程机器执行 | `src/ssh/createSSHSession.js`（缺失） | 已放弃 |
| `BYOC_ENVIRONMENT_RUNNER` | 自带环境 runner | `src/environment-runner/main.js`（缺失） | 缺文件 |
| `SELF_HOSTED_RUNNER` | 自托管 runner | `src/self-hosted-runner/main.js`（缺失） | 缺文件 |
| `ALLOW_TEST_VERSIONS` | 安装器允许测试版本 | `src/utils/nativeInstaller/download.ts` | 支持 |
| `IS_LIBC_GLIBC` | 强制 glibc 环境检测 | `src/utils/envDynamic.ts` | 支持 |
| `IS_LIBC_MUSL` | 强制 musl 环境检测 | `src/utils/envDynamic.ts` | 支持 |
| `UNATTENDED_RETRY` | API 重试流的无人值守重试 | `src/services/api/withRetry.ts` | 实验 |
| `HARD_FAIL` | 更严格的失败/日志行为 | `src/utils/log.ts`、`src/main.tsx` | 支持 |

### 2.9 构建 / 遥测 / 内部（16）

| 名称 | 功能 | 源码文件 | 状态 |
|---|---|---|---|
| `ABLATION_BASELINE` | CLI 消融/基线入口 | `src/entrypoints/cli.tsx` | 支持 |
| `ANTI_DISTILLATION_CC` | 反蒸馏请求元数据 | `src/services/api/claude.ts` | 支持 |
| `COWORKER_TYPE_TELEMETRY` | coworker 类型遥测字段 | `src/services/analytics/metadata.ts` | 支持 |
| `DOWNLOAD_USER_SETTINGS` | 设置同步拉取路径 | `src/commands/reload-plugins/reload-plugins.ts`、`src/cli/print.ts` | 支持 |
| `UPLOAD_USER_SETTINGS` | 设置同步推送路径 | `src/main.tsx` | 支持 |
| `DUMP_SYSTEM_PROMPT` | 系统提示导出路径 | `src/entrypoints/cli.tsx` | 支持 |
| `FILE_PERSISTENCE` | 文件持久化接线 | `src/utils/filePersistence/filePersistence.ts`、`src/cli/print.ts` | 支持 |
| `PERFETTO_TRACING` | perfetto 追踪 hook | `src/utils/telemetry/perfettoTracing.ts` | 支持 |
| `SLOW_OPERATION_LOGGING` | 慢操作日志 | `src/utils/slowOperations.ts` | 支持 |
| `SKIP_DETECTION_WHEN_AUTOUPDATES_DISABLED` | 自动更新关闭时跳过更新检测 | `src/components/AutoUpdaterWrapper.tsx` | 支持 |
| `MEMORY_SHAPE_TELEMETRY` | 记忆形状遥测（no-op） | `src/memdir/findRelevantMemories.ts` | stub |
| `TRANSCRIPT_CLASSIFIER` | 转录分类器三模式提示 | `src/cli/print.ts`、`src/cli/structuredIO.ts` | stub |
| `TEMPLATES` | 模板任务 | `src/entrypoints/cli.tsx`、`src/query/stopHooks.ts` | stub |
| `COMMIT_ATTRIBUTION` | 提交归因 hook（no-op） | `src/cli/print.ts`、`src/commands/clear/caches.ts` | stub |
| `CONNECTOR_TEXT` | connector 文本块在 API/日志/UI 的处理 | `src/constants/betas.ts`、`src/services/api/claude.ts` | 实验 |
| `KAIROS` | 云端 assistant 完整栈（需 Anthropic 后端+账号） | `src/bridge/bridgeMain.ts`、`src/cli/print.ts` | 已放弃（`KAIROS_BRIEF`/`KAIROS_CHANNELS` 独立保留） |



### 2.11 有用入口

- 构建与特性集：`scripts/build.ts`
- 命令门控：`src/commands.ts`
- 工具门控：`src/tools.ts`
- 任务门控：`src/tasks.ts`
- 查询行为门控：`src/query.ts`
- CLI 入口门控：`src/entrypoints/cli.tsx`
