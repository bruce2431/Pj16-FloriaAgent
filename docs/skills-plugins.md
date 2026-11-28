# 技能与插件（skills / plugins）

> 技能与插件全量清单，以及**技能类 / 插件类 feature flag** 的单一入口。技能发现与注册规则 → [standards.md](standards.md) §4-§5；构建参数与其它 flag → [build.md](build.md)；工具 → [tools.md](tools.md)；命令 → [commands.md](commands.md)。
> 新增/删除技能或插件、改动门控时必须同步本文。

## 1. 内置技能（bundled）

注册真源 `src/skills/bundled/index.ts`（`initBundledSkills()`）。前 10 个无条件注册，其余按门控。

| 技能 | 功能 | 源码 | 注册条件 |
|---|---|---|---|
| `update-config` | 通过 settings.json 配置 harness（hook、权限、环境变量等） | `src/skills/bundled/updateConfig.ts` | 无条件 |
| `keybindings-help` | 自定义键盘快捷键与绑定 | `src/skills/bundled/keybindings.ts` | 无条件 |
| `verify` | 运行应用验证代码改动 | `src/skills/bundled/verify.ts` | 无条件 |
| `debug` | 调试会话 | `src/skills/bundled/debug.ts` | 无条件 |
| `lorem-ipsum` | 生成填充文本做长上下文测试 | `src/skills/bundled/loremIpsum.ts` | 无条件（ANT 文案） |
| `skillify` | 把当前会话沉淀为技能 | `src/skills/bundled/skillify.ts` | 无条件 |
| `remember` | 审查自动记忆条目并提议晋升到 CLAUDE.md / 共享记忆 | `src/skills/bundled/remember.ts` | 无条件 |
| `simplify` | 审查改动代码的复用、质量与效率并修复 | `src/skills/bundled/simplify.ts` | 无条件 |
| `batch` | 大规模改动的并行拆解与执行（5–30 个 worktree agent） | `src/skills/bundled/batch.ts` | 无条件 |
| `stuck` | 诊断卡死/缓慢会话并产出报告（ANT） | `src/skills/bundled/stuck.ts` | 无条件 |
| `dream` | 云端 dream 技能 | `src/skills/bundled/dream.js`（缺失） | `KAIROS` / `KAIROS_DREAM` |
| `hunter` | 当前改动中找 bug 并产出审查产物 | `src/skills/bundled/hunter.ts` | `REVIEW_ARTIFACT` |
| `loop` | 按间隔重复执行提示或命令 | `src/skills/bundled/loop.ts` | `AGENT_TRIGGERS`（另有运行期 `isEnabled`） |
| `schedule` | 管理定时远程 agent（triggers） | `src/skills/bundled/scheduleRemoteAgents.ts` | `AGENT_TRIGGERS_REMOTE` |
| `claude-api` | 用 Claude API / Anthropic SDK 构建应用 | `src/skills/bundled/claudeApi.ts` | `BUILDING_CLAUDE_APPS` |
| `claude-in-chrome` | Chrome 集成 | `src/skills/bundled/claudeInChrome.ts` | `shouldAutoEnableClaudeInChrome()` |
| `run-skill-generator` | 技能生成器 | `src/skills/bundled/runSkillGenerator.js` | `RUN_SKILL_GENERATOR`（注册即禁用） |

## 2. 工作区技能

位置 `@WrokSpace/.claude/skills/<name>/SKILL.md`（本工作区 12 个）。

| 技能 | 功能 |
|---|---|
| `ProjectInit` | 按规范初始化新 Floria 项目（目录、CLAUDE.md、预览等） |
| `UIDesign` | 组件设计控制台：设计、抽离、统一、调试 UI 组件 |
| `anything2explainer` | 生成黑底 MG 风格科普讲解视频（配音、字幕、章节进度条） |
| `clarify-research-idea` | 把模糊研究方向打磨为可证伪的研究问题 |
| `geo-sleuth` | 照片拍摄地点定位（元数据、图寻） |
| `json-canvas` | 创建与编辑 JSON Canvas（`.canvas`）文件 |
| `lieflat-charts` | 模板驱动的数据可视化与报告生成 |
| `officecli` | 创建、分析、校对、修改 Office 文档 |
| `open-kimi-ppt` | 创建、编辑、复刻、读取、导出演示文稿 |
| `preview-card` | 为项目预览做多卡片（`card.json`、常驻卡） |
| `wetrace-wechat-tool` | 导出微信聊天记录为 md + medias/ |
| `workspace-backup` | 工作区全量备份（逐项目压缩） |

## 3. 插件

位置 `@WrokSpace/.claude/plugins/<name>/`，含 `.claude-plugin/plugin.json`。规则 → [standards.md](standards.md) §5。

| 插件 | 功能 | 命名空间 |
|---|---|---|
| `agent-browser` | 浏览器自动化 MCP（复用系统 Chrome） | `mcp__plugin_agent-browser_browser__*` |
| `clash` | Clash Verge 网络接管 MCP（mihomo 命名管道 REST API） | `mcp__plugin_clash_clash__*` |
| `github` | GitHub 仓库管理 MCP（官方 github-mcp-server 本地二进制） | `mcp__plugin_github_github__*` |
| `windows-computer-use` | Windows 桌面自动化 MCP（windows-mcp 加固封装） | `mcp__plugin_windows-computer-use_windows__*` |

已移除：`neturon`、`qwen-mm`、`telemetry-monitor`、`codegraph`。

## 4. 技能类 Feature Flag

| 名称 | 功能 | 源码文件 | 状态 |
|---|---|---|---|
| `BUILDING_CLAUDE_APPS` | `claude-api` 技能（Claude API 应用构建） | `src/skills/bundled/claudeApi.ts` | stub（仅多语言 `.md` 资产） |
| `RUN_SKILL_GENERATOR` | 技能生成器技能 | `src/skills/bundled/runSkillGenerator.js` | stub（注册即禁用） |
| `KAIROS_DREAM` | 云端 dream 技能与任务行为 | `src/skills/bundled/dream.js`（缺失） | 已放弃 |
| `MCP_SKILLS` | MCP 技能发现 | `src/services/mcp/client.ts`、`src/commands.ts` | stub（返回 `[]`） |
| `EXPERIMENTAL_SKILL_SEARCH` | 技能检索服务（localSearch/prefetch） | `src/services/skillSearch/`（缺失） | 缺文件 |
| `SKILL_IMPROVEMENT` | 技能改进 hook | `src/utils/hooks/skillImprovement.ts` | 支持（默认关） |

## 5. 插件类 Feature Flag

| 名称 | 功能 | 源码文件 | 状态 |
|---|---|---|---|
| `MCP_RICH_OUTPUT` | MCP 工具富输出渲染 UI | `src/tools/MCPTool/UI.tsx` | 实验 |
