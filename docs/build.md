# 构建标准与 Feature Flag 总表（build）

> 本文件属 `docs/` 文档库。
> 权威规则与姊妹件：**总标准 → [standards.md](standards.md)**；**前端打包对网关侧的效应 → [gateway.md](gateway.md)**；**工具 → [tools.md](tools.md)**；**斜杠命令 → [commands.md](commands.md)**；**技能与插件 → [skills-plugins.md](skills-plugins.md)**。

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

### 1.4 前端内嵌打包（改 web 前端必读）

- **内嵌**：`scripts/gen-web-assets.ts` 在 build.ts 每次构建前自动把 `src/gateway/web/` 递归 base64 内联进 exe。
- **两层投送**：运行时投送点 `src/gateway/webAssets.ts` 优先读 dev 磁盘 web 目录（exe 邻接或 cwd），否则用内嵌资源 ⇒ **dev 改前端刷新即生效；部署 exe 走内嵌层，前端改动必须重新构建。**
- **第三方库**：拼接器不解析 npm，第三方预打包成全局 IIFE 放进 `src/gateway/web/`（先例 KaTeX、CM6）；**生成器手动跑、不接进 build.ts ⇒ 常规构建不联网。**

前端手改处、cache-busting、sw.js、CM6 包与上游补丁 → [web-ui.md](web-ui.md)。

## 2. Feature Flag 总表

源码共引用 92 个 `feature('FLAG')` 编译期旗标（单双引号两种写法均已计入）。按门控对象分表，每表列：名称、功能、源码文件（门控/实现主件）、状态。

**按口拆分**：工具类 → [tools.md](tools.md) §2；技能类 → [skills-plugins.md](skills-plugins.md) §4；插件类 → [skills-plugins.md](skills-plugins.md) §5；斜杠命令类 → [commands.md](commands.md) §4。本文件保留其余类别（默认构建 / Agent·记忆·规划 / UI / 平台·远程·权限 / 构建·遥测·内部），各小节标题与编号不变、内容为指向。

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
| `BUILTIN_EXPLORE_PLAN_AGENTS` | 内置 explore/plan agent 预设 | [`src/tools/AgentTool/builtInAgents.ts`](../src/tools/AgentTool/builtInAgents.ts) | 默认开（也在 dev-full 集） |
| `PRIVATE_GATEWAY` | 内置网关：`/server` 指令、`--gateway` 独立进程、内嵌 web 前端；token 落 `getPortableRoot()/.claude/gateway/token`，空闲 10 分钟（`GATEWAY_IDLE_MINUTES`）自动回收 | [`src/commands.ts`](../src/commands.ts)、[`src/utils/gatewayClient.ts`](../src/utils/gatewayClient.ts) | 默认开 |
| `REACTIVE_COMPACT` | 拒答（usage-policy refusal）、PTL、媒体超限三类自动剥图恢复；可 `CLAUDE_CODE_DISABLE_REACTIVE_COMPACT` 停用 | [`src/services/compact/reactiveCompact.ts`](../src/services/compact/reactiveCompact.ts)、[`src/query.ts`](../src/query.ts) | 默认开 |
| `SESSION_LINK` | 会话间协作：`session_send`（只认 sid）+ `session_search`（本项目最近 10 个标题） | [`src/tools/SessionSendTool/SessionSendTool.ts`](../src/tools/SessionSendTool/SessionSendTool.ts)、[`src/tools/SessionSearchTool/SessionSearchTool.ts`](../src/tools/SessionSearchTool/SessionSearchTool.ts) | 默认开 |
| `CARD_API` | `CardCall` 工具：agent 驱动浏览器在场卡片（list/call） | [`src/tools/CardCallTool/CardCallTool.ts`](../src/tools/CardCallTool/CardCallTool.ts)、[`src/tools.ts`](../src/tools.ts) | 默认开 |

### 2.2 工具

工具类 flag 表已迁至 [tools.md](tools.md) §2。

### 2.3 技能

技能类 flag 表已迁至 [skills-plugins.md](skills-plugins.md) §4。

### 2.4 插件

插件类 flag 表已迁至 [skills-plugins.md](skills-plugins.md) §5。

### 2.5 斜杠命令

命令类 flag 表已迁至 [commands.md](commands.md) §4。

### 2.6 Agent / 记忆 / 规划（9）

| 名称 | 功能 | 源码文件 | 状态 |
|---|---|---|---|
| `AGENT_MEMORY_SNAPSHOT` | 自定义 agent 记忆快照 | [`src/tools/AgentTool/loadAgentsDir.ts`](../src/tools/AgentTool/loadAgentsDir.ts)、[`src/main.tsx`](../src/main.tsx) | 实验 |
| `CACHED_MICROCOMPACT` | 微压缩缓存状态 | [`src/query.ts`](../src/query.ts)、[`src/constants/prompts.ts`](../src/constants/prompts.ts) | 实验 |
| `COMPACTION_REMINDERS` | 压缩与附件流程提醒文案 | [`src/utils/attachments.ts`](../src/utils/attachments.ts) | 实验 |
| `EXTRACT_MEMORIES` | 对话后记忆抽取 hook | [`src/memdir/paths.ts`](../src/memdir/paths.ts)、[`src/cli/print.ts`](../src/cli/print.ts) | 实验 |
| `PROMPT_CACHE_BREAK_DETECTION` | 缓存断点检测 | [`src/services/api/claude.ts`](../src/services/api/claude.ts)、[`src/commands/compact/compact.ts`](../src/commands/compact/compact.ts) | 实验 |
| `TEAMMEM` | 团队记忆文件、watcher 与 UI 消息 | [`src/components/memory/`](../src/components/memory/)、[`src/memdir/`](../src/memdir/) | 实验 |
| `VERIFICATION_AGENT` | 验证 agent 提示与任务/todo 工具引导 | [`src/tools/AgentTool/builtInAgents.ts`](../src/tools/AgentTool/builtInAgents.ts)、[`src/constants/prompts.ts`](../src/constants/prompts.ts) | 实验 |
| `COORDINATOR_MODE` | coordinator + worker 两个内置 agent（`subagent_type: 'worker'`） | [`src/coordinator/workerAgent.ts`](../src/coordinator/workerAgent.ts)、[`src/coordinator/coordinatorMode.ts`](../src/coordinator/coordinatorMode.ts) | 已恢复（默认不编入） |
| `PROACTIVE` | 云端主动任务栈 | `src/proactive/`（缺失） | 已放弃 |

### 2.7 UI / 交互（13）

| 名称 | 功能 | 源码文件 | 状态 |
|---|---|---|---|
| `AWAY_SUMMARY` | 离开回来摘要 | [`src/hooks/useAwaySummary.ts`](../src/hooks/useAwaySummary.ts)、[`src/screens/REPL.tsx`](../src/screens/REPL.tsx) | 实验 |
| `HISTORY_PICKER` | 交互式提示历史选择器 | [`src/hooks/useHistorySearch.ts`](../src/hooks/useHistorySearch.ts)、[`src/components/PromptInput/PromptInput.tsx`](../src/components/PromptInput/PromptInput.tsx) | 实验 |
| `HOOK_PROMPTS` | hook 执行流接收 prompt/request 文本 | [`src/screens/REPL.tsx`](../src/screens/REPL.tsx) | 实验 |
| `KAIROS_BRIEF` | brief-only 转录布局与 `BriefTool` 导向 UX | [`src/commands/brief.ts`](../src/commands/brief.ts) | 实验（不恢复完整 assistant 栈） |
| `KAIROS_CHANNELS` | 频道通知与 MCP/频道回调 | [`src/components/LogoV2/ChannelsNotice.tsx`](../src/components/LogoV2/ChannelsNotice.tsx)、[`src/cli/print.ts`](../src/cli/print.ts) | 实验 |
| `LODESTONE` | 深链/协议注册与设置接线 | [`src/main.tsx`](../src/main.tsx)、[`src/interactiveHelpers.tsx`](../src/interactiveHelpers.tsx) | 实验 |
| `MESSAGE_ACTIONS` | 交互 UI 的消息动作入口 | [`src/screens/REPL.tsx`](../src/screens/REPL.tsx)、[`src/keybindings/defaultBindings.ts`](../src/keybindings/defaultBindings.ts) | 实验 |
| `QUICK_SEARCH` | 提示快速搜索 | [`src/components/PromptInput/PromptInput.tsx`](../src/components/PromptInput/PromptInput.tsx)、[`src/keybindings/defaultBindings.ts`](../src/keybindings/defaultBindings.ts) | 实验 |
| `SHOT_STATS` | 附加投递分布统计视图 | [`src/utils/stats.ts`](../src/utils/stats.ts)、[`src/components/Stats.tsx`](../src/components/Stats.tsx) | 实验 |
| `TOKEN_BUDGET` | token 预算跟踪、提示触发与警告 UI | [`src/components/Spinner.tsx`](../src/components/Spinner.tsx)、[`src/components/PromptInput/PromptInput.tsx`](../src/components/PromptInput/PromptInput.tsx) | 实验 |
| `ULTRATHINK` | 额外思考深度档 | [`src/utils/thinking.ts`](../src/utils/thinking.ts) | 实验 |
| `STREAMLINED_OUTPUT` | headless `stream-json` 的精简输出（`CLAUDE_CODE_STREAMLINED_OUTPUT=true`） | [`src/cli/print.ts`](../src/cli/print.ts) | 实验 |
| `AUTO_THEME` | OSC 11 主题跟随（5s 轮询） | [`src/components/design-system/ThemeProvider.tsx`](../src/components/design-system/ThemeProvider.tsx)、[`src/tools/ConfigTool/supportedSettings.ts`](../src/tools/ConfigTool/supportedSettings.ts) | stub |

### 2.8 平台 / 远程 / 权限（12）

| 名称 | 功能 | 源码文件 | 状态 |
|---|---|---|---|
| `BRIDGE_MODE` | Remote Control / REPL bridge 与 entitlement 路径 | [`src/bridge/bridgeEnabled.ts`](../src/bridge/bridgeEnabled.ts)、[`src/commands/bridge/index.ts`](../src/commands/bridge/index.ts) | 已放弃（内置网关覆盖） |
| `CCR_AUTO_CONNECT` | CCR 自动连接默认路径 | [`src/bridge/bridgeEnabled.ts`](../src/bridge/bridgeEnabled.ts)、[`src/utils/config.ts`](../src/utils/config.ts) | 已放弃 |
| `CCR_MIRROR` | 只出向 CCR 镜像会话 | [`src/bridge/remoteBridgeCore.ts`](../src/bridge/remoteBridgeCore.ts) | 已放弃（本地已由 `conversationDisplay.ts` 上报链承担） |
| `DIRECT_CONNECT` | `claude open <cc://url>` 外部直连会话 | [`src/main.tsx`](../src/main.tsx) | 已放弃（依赖缺失的 `src/server/parseConnectUrl.js`） |
| `SSH_REMOTE` | `claude ssh <host>` 远程机器执行 | `src/ssh/createSSHSession.js`（缺失） | 已放弃 |
| `BYOC_ENVIRONMENT_RUNNER` | 自带环境 runner | `src/environment-runner/main.js`（缺失） | 缺文件 |
| `SELF_HOSTED_RUNNER` | 自托管 runner | `src/self-hosted-runner/main.js`（缺失） | 缺文件 |
| `ALLOW_TEST_VERSIONS` | 安装器允许测试版本 | [`src/utils/nativeInstaller/download.ts`](../src/utils/nativeInstaller/download.ts) | 支持 |
| `IS_LIBC_GLIBC` | 强制 glibc 环境检测 | [`src/utils/envDynamic.ts`](../src/utils/envDynamic.ts) | 支持 |
| `IS_LIBC_MUSL` | 强制 musl 环境检测 | [`src/utils/envDynamic.ts`](../src/utils/envDynamic.ts) | 支持 |
| `UNATTENDED_RETRY` | API 重试流的无人值守重试 | [`src/services/api/withRetry.ts`](../src/services/api/withRetry.ts) | 实验 |
| `HARD_FAIL` | 更严格的失败/日志行为 | [`src/utils/log.ts`](../src/utils/log.ts)、[`src/main.tsx`](../src/main.tsx) | 支持 |

### 2.9 构建 / 遥测 / 内部（16）

| 名称 | 功能 | 源码文件 | 状态 |
|---|---|---|---|
| `ABLATION_BASELINE` | CLI 消融/基线入口 | [`src/entrypoints/cli.tsx`](../src/entrypoints/cli.tsx) | 支持 |
| `ANTI_DISTILLATION_CC` | 反蒸馏请求元数据 | [`src/services/api/claude.ts`](../src/services/api/claude.ts) | 支持 |
| `COWORKER_TYPE_TELEMETRY` | coworker 类型遥测字段 | [`src/services/analytics/metadata.ts`](../src/services/analytics/metadata.ts) | 支持 |
| `DOWNLOAD_USER_SETTINGS` | 设置同步拉取路径 | [`src/commands/reload-plugins/reload-plugins.ts`](../src/commands/reload-plugins/reload-plugins.ts)、[`src/cli/print.ts`](../src/cli/print.ts) | 支持 |
| `UPLOAD_USER_SETTINGS` | 设置同步推送路径 | [`src/main.tsx`](../src/main.tsx) | 支持 |
| `DUMP_SYSTEM_PROMPT` | 系统提示导出路径 | [`src/entrypoints/cli.tsx`](../src/entrypoints/cli.tsx) | 支持 |
| `FILE_PERSISTENCE` | 文件持久化接线 | [`src/utils/filePersistence/filePersistence.ts`](../src/utils/filePersistence/filePersistence.ts)、[`src/cli/print.ts`](../src/cli/print.ts) | 支持 |
| `PERFETTO_TRACING` | perfetto 追踪 hook | [`src/utils/telemetry/perfettoTracing.ts`](../src/utils/telemetry/perfettoTracing.ts) | 支持 |
| `SLOW_OPERATION_LOGGING` | 慢操作日志 | [`src/utils/slowOperations.ts`](../src/utils/slowOperations.ts) | 支持 |
| `SKIP_DETECTION_WHEN_AUTOUPDATES_DISABLED` | 自动更新关闭时跳过更新检测 | [`src/components/AutoUpdaterWrapper.tsx`](../src/components/AutoUpdaterWrapper.tsx) | 支持 |
| `MEMORY_SHAPE_TELEMETRY` | 记忆形状遥测（no-op） | [`src/memdir/findRelevantMemories.ts`](../src/memdir/findRelevantMemories.ts) | stub |
| `TRANSCRIPT_CLASSIFIER` | 转录分类器三模式提示 | [`src/cli/print.ts`](../src/cli/print.ts)、[`src/cli/structuredIO.ts`](../src/cli/structuredIO.ts) | stub |
| `TEMPLATES` | 模板任务 | [`src/entrypoints/cli.tsx`](../src/entrypoints/cli.tsx)、[`src/query/stopHooks.ts`](../src/query/stopHooks.ts) | stub |
| `COMMIT_ATTRIBUTION` | 提交归因 hook（no-op） | [`src/cli/print.ts`](../src/cli/print.ts)、[`src/commands/clear/caches.ts`](../src/commands/clear/caches.ts) | stub |
| `CONNECTOR_TEXT` | connector 文本块在 API/日志/UI 的处理 | [`src/constants/betas.ts`](../src/constants/betas.ts)、[`src/services/api/claude.ts`](../src/services/api/claude.ts) | 实验 |
| `KAIROS` | 云端 assistant 完整栈（需 Anthropic 后端+账号） | [`src/bridge/bridgeMain.ts`](../src/bridge/bridgeMain.ts)、[`src/cli/print.ts`](../src/cli/print.ts) | 已放弃（`KAIROS_BRIEF`/`KAIROS_CHANNELS` 独立保留） |

### 2.11 有用入口

- 构建与特性集：`scripts/build.ts`
- 命令门控：`src/commands.ts`
- 工具门控：`src/tools.ts`
- 任务门控：`src/tasks.ts`
- 查询行为门控：`src/query.ts`
- CLI 入口门控：`src/entrypoints/cli.tsx`
