# 工具（tools）

> 工具全量清单与**工具类 feature flag** 的单一入口。门控与注册真源：`src/tools.ts`（注册）、各工具目录（`feature()` 门控 + `isEnabled()` 运行态门控）。构建参数与其它 flag → [build.md](build.md)；斜杠命令 → [commands.md](commands.md)；技能/插件 → [skills-plugins.md](skills-plugins.md)。
> 改动门控或新增工具时必须同步本文。

## 1. 工具总表

「门控」列：**无** = 无 `feature()` 编译期门控，编入即注册；其余为门控该工具的 flag；「ANT」= 仅 `USER_TYPE=ant` 编入（外部构建剔除）。

### 1.1 文件与命令

| 工具 | 功能 | 源码 | 门控 |
|---|---|---|---|
| `Bash` | 运行 shell 命令（含沙箱判定、权限分类） | [`src/tools/BashTool/`](../src/tools/BashTool/) | 无 |
| `PowerShell` | 运行 PowerShell 命令 | [`src/tools/PowerShellTool/`](../src/tools/PowerShellTool/) | 无 |
| `Read` | 读文件（文本/图片/PDF） | [`src/tools/FileReadTool/`](../src/tools/FileReadTool/) | 无 |
| `Write` | 写文件 | [`src/tools/FileWriteTool/`](../src/tools/FileWriteTool/) | 无 |
| `Edit` | 精确字符串替换编辑 | [`src/tools/FileEditTool/`](../src/tools/FileEditTool/) | 无 |
| `Glob` | 文件模式匹配 | [`src/tools/GlobTool/`](../src/tools/GlobTool/) | 无 |
| `Grep` | 内容搜索（内嵌 ripgrep） | [`src/tools/GrepTool/`](../src/tools/GrepTool/) | 无 |
| `NotebookEdit` | 编辑 Jupyter notebook 单元格 | [`src/tools/NotebookEditTool/`](../src/tools/NotebookEditTool/) | 无 |
| `LSP` | 语言服务器符号/诊断 | [`src/tools/LSPTool/`](../src/tools/LSPTool/) | 无 |
| `Config` | 读写 harness 设置 | [`src/tools/ConfigTool/`](../src/tools/ConfigTool/) | 无 |

### 1.2 任务与子代理

| 工具 | 功能 | 源码 | 门控 |
|---|---|---|---|
| `Agent` | spawn 子代理（内置 explore/plan 预设、fork、记忆快照） | [`src/tools/AgentTool/`](../src/tools/AgentTool/) | 无（子能力受 `BUILTIN_EXPLORE_PLAN_AGENTS` 等控制） |
| `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` | 任务清单增查改列 | [`src/tools/TaskCreateTool/`](../src/tools/TaskCreateTool/)、`TaskGetTool/`、`TaskListTool/`、`TaskUpdateTool/` | 无 |
| `TaskOutput` / `TaskStop` | 读后台任务输出 / 停止任务 | [`src/tools/TaskOutputTool/`](../src/tools/TaskOutputTool/)、`TaskStopTool/` | 无 |
| `TodoWrite` | 会话待办清单 | [`src/tools/TodoWriteTool/`](../src/tools/TodoWriteTool/) | 无 |
| `TeamCreate` / `TeamDelete` | 多 agent 团队协调 | [`src/tools/TeamCreateTool/`](../src/tools/TeamCreateTool/)、`TeamDeleteTool/` | 无 |
| `EnterPlanMode` / `ExitPlanMode` | 进入/退出计划模式 | [`src/tools/EnterPlanModeTool/`](../src/tools/EnterPlanModeTool/)、`ExitPlanModeTool/` | 无 |
| `EnterWorktree` / `ExitWorktree` | 创建/退出隔离 git worktree | [`src/tools/EnterWorktreeTool/`](../src/tools/EnterWorktreeTool/)、`ExitWorktreeTool/` | 无 |
| `VerifyPlanExecution` | 校验计划执行结果 | [`src/tools/VerifyPlanExecutionTool/`](../src/tools/VerifyPlanExecutionTool/) | 无 |
| `SendUserMessage` | Brief 模式消息发送 | [`src/tools/BriefTool/`](../src/tools/BriefTool/) | `KAIROS` / `KAIROS_BRIEF` |
| `Sleep` | 主动休眠（后台 agent 节奏） | [`src/tools/SleepTool/`](../src/tools/SleepTool/) | `PROACTIVE` / `KAIROS` |

### 1.3 会话与协作

| 工具 | 功能 | 源码 | 门控 |
|---|---|---|---|
| `AskUserQuestion` | 向用户提问并收集选项 | [`src/tools/AskUserQuestionTool/`](../src/tools/AskUserQuestionTool/) | 无 |
| `SessionSearch` | 按标题检索本项目最近会话，返回 sid | [`src/tools/SessionSearchTool/`](../src/tools/SessionSearchTool/) | `SESSION_LINK`（默认开） |
| `SessionSend` | 向指定 sid 会话发消息 / 拉起新会话 | [`src/tools/SessionSendTool/`](../src/tools/SessionSendTool/) | `SESSION_LINK`（默认开） |
| `SendMessage` | UDS 会话互发 | [`src/tools/SendMessageTool/`](../src/tools/SendMessageTool/) | `UDS_INBOX`（缺文件） |
| `CardCall` | 驱动浏览器在场卡片（list/call） | [`src/tools/CardCallTool/`](../src/tools/CardCallTool/) | `CARD_API`（默认开） |
| `Monitor` | spawn 后台监控进程并流式通知 | [`src/tools/MonitorTool/`](../src/tools/MonitorTool/) | `MONITOR_TOOL`（已恢复，默认不编入） |
| `CronCreate` / `CronDelete` / `CronList` | 本地 cron 触发任务 | [`src/tools/ScheduleCronTool/`](../src/tools/ScheduleCronTool/) | `AGENT_TRIGGERS` |
| `RemoteTrigger` | 远程触发任务 | [`src/tools/RemoteTriggerTool/`](../src/tools/RemoteTriggerTool/) | `AGENT_TRIGGERS_REMOTE` |
| `PushNotification` | 推送通知 | [`src/tools/PushNotificationTool/`](../src/tools/PushNotificationTool/) | `KAIROS` / `KAIROS_PUSH_NOTIFICATION`（stub） |
| `SubscribePR` | 订阅 PR webhook | [`src/tools/SubscribePRTool/`](../src/tools/SubscribePRTool/) | `KAIROS_GITHUB_WEBHOOKS`（stub） |
| `Workflow` | 扫描 `.claude/workflows/*.md` 并 spawn 后台任务 | [`src/tools/WorkflowTool/`](../src/tools/WorkflowTool/) | `WORKFLOW_SCRIPTS`（默认不编入） |
| `ReviewArtifact` | 批准弹窗选 finding，产物落 `.claude/reviews/` | [`src/tools/ReviewArtifactTool/`](../src/tools/ReviewArtifactTool/) | `REVIEW_ARTIFACT`（默认不编入） |
| `Snip` | 历史消息裁剪 | [`src/tools/SnipTool/`](../src/tools/SnipTool/) | `HISTORY_SNIP`（stub） |
| `OverflowTest` | 溢出测试 | [`src/tools/OverflowTestTool/`](../src/tools/OverflowTestTool/) | stub |

### 1.4 MCP 与网络

| 工具 | 功能 | 源码 | 门控 |
|---|---|---|---|
| `MCP` | MCP 服务器工具代理（`mcp__<server>__*`） | [`src/tools/MCPTool/`](../src/tools/MCPTool/) | 无 |
| `ListMcpResourcesTool` | 列 MCP 资源 | [`src/tools/ListMcpResourcesTool/`](../src/tools/ListMcpResourcesTool/) | 无 |
| `ReadMcpResourceTool` | 读 MCP 资源 | [`src/tools/ReadMcpResourceTool/`](../src/tools/ReadMcpResourceTool/) | 无 |
| `McpAuthTool` | MCP 服务器授权 | [`src/tools/McpAuthTool/`](../src/tools/McpAuthTool/) | 无 |
| `WebFetch` | 抓取网页并抽取内容 | [`src/tools/WebFetchTool/`](../src/tools/WebFetchTool/) | 无 |
| `WebSearch` | 网页搜索（本地多后端） | [`src/tools/WebSearchTool/`](../src/tools/WebSearchTool/) | 无 |

### 1.5 生图与工具检索

| 工具 | 功能 | 源码 | 门控 |
|---|---|---|---|
| `ImageGeneration` | 生图/改图（主模型编排，厂商 adapter） | [`src/tools/ImageGenerationTool/`](../src/tools/ImageGenerationTool/) | 无（运行态 `isImageGenerationToolEnabled`） |
| `Skill` | 调用技能（bundled / 工作区 / 插件） | [`src/tools/SkillTool/`](../src/tools/SkillTool/) | 无 |
| `ToolSearch` | 延迟加载工具的检索入口 | [`src/tools/ToolSearchTool/`](../src/tools/ToolSearchTool/) | 无（懒加载分支受 `KAIROS` 等影响） |

### 1.6 记忆（本 fork 神经元）

| 工具 | 功能 | 源码 | 门控 |
|---|---|---|---|
| `recall` / `remember` | 常驻记忆检索 / 写入（不经 ToolSearch） | [`src/tools/neturon/recall.ts`](../src/tools/neturon/recall.ts)、`remember.ts` | `NEURON_RAG`（默认关） |
| `neuron_list` / `neuron_source` / `neuron_fill_precog` / `neuron_cog` / `neuron_maintain` | 延迟加载的库浏览、原文取回、precog 标注、认知图、块级维护 | [`src/tools/neturon/`](../src/tools/neturon/) | `NEURON_RAG`（默认关） |

### 1.7 内部（外部构建剔除）

| 工具 | 功能 | 源码 | 门控 |
|---|---|---|---|
| `REPL` | 内部 REPL 工具 | [`src/tools/REPLTool/`](../src/tools/REPLTool/) | ANT |
| `TestingPermission` | 权限测试工具 | [`src/tools/testing/`](../src/tools/testing/) | ANT |
| `Tungsten` | 内部实时监视工具 | [`src/tools/TungstenTool/`](../src/tools/TungstenTool/) | 无 |
| `StructuredOutput` | 结构化输出（SyntheticOutput） | [`src/tools/SyntheticOutputTool/`](../src/tools/SyntheticOutputTool/) | 无 |

## 2. 工具类 Feature Flag

| 名称 | 功能 | 源码文件 | 状态 |
|---|---|---|---|
| `AGENT_TRIGGERS` | 本地 cron/trigger 工具（CronCreate/Delete/List） | [`src/tools/ScheduleCronTool/`](../src/tools/ScheduleCronTool/)、[`src/constants/tools.ts`](../src/constants/tools.ts) | 实验 |
| `AGENT_TRIGGERS_REMOTE` | 远程触发工具 `RemoteTrigger` | [`src/tools/RemoteTriggerTool/RemoteTriggerTool.ts`](../src/tools/RemoteTriggerTool/RemoteTriggerTool.ts)、[`src/tools.ts`](../src/tools.ts) | 实验 |
| `MONITOR_TOOL` | `Monitor` 工具：spawn 后台监控进程并流式通知 | [`src/tools/MonitorTool/MonitorTool.tsx`](../src/tools/MonitorTool/MonitorTool.tsx) | 已恢复（默认不编入） |
| `REVIEW_ARTIFACT` | `ReviewArtifact` 工具：批准弹窗选 finding，产物落 `.claude/reviews/` | [`src/tools/ReviewArtifactTool/ReviewArtifactTool.tsx`](../src/tools/ReviewArtifactTool/ReviewArtifactTool.tsx) | 已恢复（默认不编入） |
| `WORKFLOW_SCRIPTS` | `Workflow` 工具：扫描 `.claude/workflows/*.md` 并 spawn 后台任务；脚本另注册为 `/name` | [`src/tools/WorkflowTool/WorkflowTool.tsx`](../src/tools/WorkflowTool/WorkflowTool.tsx)、[`src/commands/workflows/`](../src/commands/workflows/) | 已恢复（默认不编入，需 `--feature=WORKFLOW_SCRIPTS`） |
| `HISTORY_SNIP` | `SnipTool` + 历史裁剪投影 | [`src/tools/SnipTool/`](../src/tools/SnipTool/) | stub（禁用） |
| `KAIROS_PUSH_NOTIFICATION` | `PushNotificationTool` | [`src/tools/PushNotificationTool/`](../src/tools/PushNotificationTool/) | stub（禁用） |
| `OVERFLOW_TEST_TOOL` | `OverflowTestTool` | [`src/tools/OverflowTestTool/`](../src/tools/OverflowTestTool/) | stub（禁用） |
| `CONTEXT_COLLAPSE` | `CtxInspectTool` 上下文折叠 | `src/tools/CtxInspectTool/CtxInspectTool.js`（缺失） | 缺文件 |
| `WEB_BROWSER_TOOL` | `WebBrowserTool` | `src/tools/WebBrowserTool/WebBrowserTool.js`（缺失） | 缺文件 |
| `UDS_INBOX` | UDS 会话互发（`udsMessaging` + `ListPeersTool`）；无网关独立会话的一等能力 | `src/utils/udsMessaging.js`、`src/tools/ListPeersTool/`（缺失） | 缺文件 |
| `TERMINAL_PANEL` | `TerminalCaptureTool` 终端面板 | `src/tools/TerminalCaptureTool/`（缺失） | 缺文件 |
| `BASH_CLASSIFIER` | 分类器辅助的 bash 权限判定 | [`src/cli/structuredIO.ts`](../src/cli/structuredIO.ts)、[`src/utils/permissions/`](../src/utils/permissions/) | 实验 |
| `POWERSHELL_AUTO_MODE` | PowerShell 自动权限模式 | [`src/utils/permissions/permissions.ts`](../src/utils/permissions/permissions.ts)、`yoloClassifier.ts` | 实验 |
| `TREE_SITTER_BASH` | tree-sitter bash 解析后端 | [`src/utils/bash/parser.ts`](../src/utils/bash/parser.ts) | 实验 |
| `TREE_SITTER_BASH_SHADOW` | tree-sitter bash 影子 rollout | [`src/tools/BashTool/bashPermissions.ts`](../src/tools/BashTool/bashPermissions.ts)、[`src/utils/bash/parser.ts`](../src/utils/bash/parser.ts) | 实验 |
| `NEURON_RAG` | 本 fork 神经元记忆/RAG：`recall`/`remember` 常驻 + `neuron_list`/`neuron_source`/`neuron_fill_precog`/`neuron_cog` 延迟加载 | [`src/tools/neturon/`](../src/tools/neturon/)、[`src/constants/prompts.ts`](../src/constants/prompts.ts) | 本 fork 专有（默认关，显式 `--feature=NEURON_RAG`） |
| `CHICAGO_MCP` | computer-use MCP 集成与 wrapper 加载 | [`src/entrypoints/cli.tsx`](../src/entrypoints/cli.tsx)、[`src/main.tsx`](../src/main.tsx) | 可打包；运行期依赖外部化 `@ant/computer-use-*`，非 runtime-safe |
| `NATIVE_CLIPBOARD_IMAGE` | macOS 原生剪贴板读图快路径（需 `image-processor-napi`） | [`src/utils/imagePaste.ts`](../src/utils/imagePaste.ts) | 实验 |
