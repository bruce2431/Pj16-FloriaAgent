# 权威标准（standards）

> 本 fork（便携版 Claude Code 重构源码）已与官方产生结构性差异，官方文档不再适用。
> 本文件是**权威标准**：新建/修改 skill、plugin、MCP、changelog、工作区内容时以本文为准。
> 优先级：**本文 > `.claude/CLAUDE.md` 对应章节 > 官方文档**。
>
> 本文件属 `docs/` 文档库。同库姊妹件：
> **构建标准与 feature flag 活审计 → [build.md](build.md)**；
> **项目预览页 Web 容器标准 → [gateway.md](gateway.md)**；
> **代码机制细节 → [core.md](core.md)**（本文只写规则约束）。

## 1. 总则 / 设计原则

| 原则 | 说明 |
|---|---|
| **便携优先** | 整个 `@WrokSpace` 可整体拷到任意盘符/路径，配置、插件、记忆、凭证不失效 |
| **全相对路径（红线）** | 任何命令/配置/脚本/引用一律相对路径，禁止 `C:\...`、`C:/...`、写死盘符、写死用户目录 |
| **扩展只走两个口** | 简单工作流 = skill（`.claude/skills/`）；带 MCP/引擎 = plugin（`.claude/plugins/`）。目录严格分离 |
| **数据随插件走** | 插件活数据放插件目录内（如 `brain/`），随插件整体拷贝，不依赖外部路径 |
| **MCP 只经插件注册** | 禁止在 `settings.json` 的 `mcpServers` 或项目根 `.mcp.json` 单独注册 |
| **会话级生效** | MCP 工具/插件/hook 改动**重启会话才生效**（会话启动时一次性加载） |

## 2. 目录结构标准

```
@WrokSpace/               ← 便携根 = 主工作区（日常产出、项目、临时任务）
├── .claude/              ← 便携全局配置根（settings/skills/plugins；会话与自动记忆均在项目级）
│   └── .claude-portable  ← 便携标记（在配置根内部，不可移动/删除）
├── Pj16-CodeAgent构建/   ← 项目根（非仓库根）
│   ├── Floria/           ← 源码构建区 + 权威标准 = git 仓库根（远程 bruce2431/Floria）
│   │   ├── src/ scripts/ probes/ assets/ package.json node_modules/ …
│   │   ├── docs/         ← 文档库（本文件 + build/glossary/core/gateway/web-ui/README）
│   │   └── README.md     ← 仓库说明
│   ├── README.md         ← 项目目录结构说明
│   └── CLAUDE.md         ← 项目级 AI 指引
├── PjN-…/                ← 项目
├── .trash/YYYY-MM-DD/    ← 归档（禁止删除，只归档）
├── LOG.md                ← 工作区 LOG
├── README.md             ← 工作区规范
└── STATUS.md             ← 工作区状态
```

- `.claude/` 内部：
  - `skills/` — 纯 skill
  - `plugins/` — 插件（agent-browser / codegraph / github 等，现状清单见 §5.7）
  - `plugins/` 下 `marketplaces/`、`data/`、`known_marketplaces.json` 是**系统管理目录，勿动**；缓存清理只动 `cache/` 三层，不碰插件目录
  - `projects/` — 全局会话/记忆散装区（web「笔」新建会话落此，见 §2.1；旧版全局自动记忆桶遗留，App 管理）
  - `sessions/`、`history.jsonl` — 旧版会话存储，App 管理（新会话写入项目 `.claude/projects/*.jsonl` 平铺目录）

### 2.1 会话 / 自动记忆存储布局

| 数据 | 位置 | 说明 |
|---|---|---|
| **会话** | `<项目>/.claude/projects/*.jsonl` | **项目本地、平铺**（不按启动目录分桶），随项目文件夹打包/归档不丢失 |
| **自动记忆** | `<项目>/.claude/projects/memory/` | **项目本地、平铺**，随项目文件夹打包/归档不丢失；`MEMORY.md` + 各主题文件 |

- 会话目录：`getProjectDir()`（`sessionStoragePortable.ts`）＝ `<项目>/.claude/projects`（**平铺**）。跨项目会话列表（`/resume`、stats、cleanup、insights 等）用**逐级向上扫描**：`getProjectSessionDirsUpToHome(cwd)` / `getSessionProjectsParentsUpToHome(cwd)` 从 CWD 逐级收集 `<dir>/.claude/projects` 直至配置根，再加配置根本身的 projects 目录 → 从任何子目录启动都能看到该项目全部会话。全工作区已无任何 `<sanitized>` 旧桶，全部平铺。
- 自动记忆：`getAutoMemPath()`（`memdir/paths.ts`），优先级 = `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` → settings.json `autoMemoryDirectory`（policy/local/user，排除 projectSettings）→ 默认 `<项目>/.claude/projects/memory/`（镜像会话目录 `getProjectDir()`，随项目移动）。`getMemoryBaseDir()` 仍锚定全局配置根，仅服务**用户级 agent-memory**（`<配置根>/agent-memory/`）与旧路径检测；自动记忆不再落全局根。
- **启动位置决定记忆**：记忆按「启动时 CWD 的项目根」解析，写入该项目 `.claude/projects/memory/`——从 `@WrokSpace` 启动读写工作区记忆，从 `@WrokSpace/PjN-…` 启动读写该项目记忆。exe 为项目根时间戳产物、禁固定名（→ CLAUDE.md「常用命令」），从工作区根或项目根启动均可。从同一项目不同子目录启动，会话/记忆共用同一平铺目录。
- **归档**：要归档某项目时，直接 zip 整个项目文件夹（含 `.claude/projects/`）即带走会话**和自动记忆**（两者同目录），无需单独导出。

### 2.2 docs 文档库编写规范（2026-09-19 定案）

- **只写现状**：各件描述**当前实现 + 不变量 + 探针锚点**（点名 `probes/probe-*.ts`），不写「症状→根因→修法」过程叙事，不嵌日期/版本号/exe 名（历史一律留 LOG mem 层）。
- **`§` 编号与标题是稳定键**：被记忆文件与其他 docs 件交叉引用，**只增不重编不改名**。
- **精简边界**：只压叙述性从句、重复主题（改互相引用）、重复列举；**技术事实（接口/字段/路径/常量/不变量/判据/坑）一条不删**。密度已饱和的规则表/机制段不硬压。
- **同步义务**：改代码触达的链路必须同步对应件（索引 [README.md](README.md)），文档维护与代码完成同等级。

## 3. 便携配置根与路径红线

**配置根解析**（`src/utils/envUtils.ts` `getClaudeConfigHomeDir`，优先级从高到低）：

1. `CLAUDE_CONFIG_DIR` 环境变量
2. 从 exe 目录**逐级向上**找 `.claude/.claude-portable` 标记 → 命中用「该 `.claude` 目录」（**显式标记压过下条的内容指纹**：该标记只由配置根写入，而 `settings.json`/`skills`/`commands`/`plugins` 在项目级 `.claude` 中同样合法，仅凭内容无法区分二者）
3. exe 旁边的 `.claude/`（**须带配置根标记**：`.claude-portable`/`.claude.json`/`settings.json`/`plugins`/`skills`/`commands`/`credentials.json`/`history.jsonl` 任一存在才认；**只有 `projects/` 不算** → 项目本地会话目录不会误判）——仅在向上无便携标记时兜底
4. 兜底 `~/.claude`

（解析链与裸机初始化的机制细节 → [core.md](core.md)「便携配置根」。复验锚点：`probes/probe-portable-root-order.ts`。）
- **信任判据亦以标记为准**：目录位于便携根（`.claude-portable` 所在）之下即视为已信任（`isUnderPortableRoot`），压过全局配置里的绝对路径记录 ⇒ **换盘符 / 换机器不触发重新信任**。复验锚点 `probes/probe-portable-trust.ts`。

**硬性约束**：
- `.claude/.claude-portable` 和 `.claude/` **必须留在 `@WrokSpace` 根目录**。挪进子文件夹后，exe 副本从 `@WrokSpace\<项目>\` 运行向上找不到标记 → 配置掉回 `~/.claude`，插件/记忆/凭证全失效。
- 写命令/配置/脚本引用一律相对路径；只在极少数无法用相对路径处（如 hook 子进程 CWD 不固定）先与用户确认。

## 4. Skill 标准

### 4.1 定义
- 一组 markdown 工作流指令（`SKILL.md`）+ 可选脚本/参考文档，**纯 skill 不注册 MCP**。
- 需要 MCP / 引擎 / 活数据时**升级为 plugin**（§5），不要塞进 skills/。

### 4.2 目录结构
```
.claude/skills/<name>/
├── SKILL.md          # 必须
└── references/       # 可选（如 EXAMPLES.md）
```

### 4.3 SKILL.md 格式
```yaml
---
name: <英文短横线名，如 json-canvas>
description: <何时用/怎么用，一句话，供 Skill 工具自动命中>
---
# <标题>
## 工作流
1. ...
```
- frontmatter 必填 `name` + `description`；name 用英文短横线。
- 复杂脚本/工具全文存插件的 `l3.raw/`，SKILL.md 只写工作流 + 相对路径引用（见 §7）。

### 4.4 发现与注册（无 manifest 门槛）
- 项目 skills 加载器从 **originalCwd 逐级向上**扫 `.claude/skills/<name>/SKILL.md`（便携下命中 `@WrokSpace/.claude/skills/`）。
- **SKILL.md 存在即注册**；bare 模式 / projectSettings 源禁用时跳过。
- 触发：Skill 工具按 description 自动命中，或 `/skill名`。

### 4.5 规则
- 纯 skill 目录**不带** `.claude-plugin/plugin.json`——带了的目录会被插件加载器当插件（§5），skills 加载器反而跳过它。

## 5. Plugin 标准

### 5.1 定义
- 目录内**含 `.claude-plugin/plugin.json` 即视为插件**（manifest 驱动）。
- 带 MCP 服务器、引擎代码、活数据、模板的扩展一律走 plugin。

### 5.2 plugin.json（清单）
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "一句话说明",
  "author": { "name": "bruce2431" },
  "homepage": "https://…（可选）"
}
```
- 必填：`name`（英文短横线、无空格）。建议：`version`(semver)、`description`、`author`。
- 完整 schema（`PluginManifestSchema`，顶层均为可选 partial）还支持：`hooks` / `commands` / `agents` / `skills` / `outputStyles` / `channels` / `mcpServers`（内联或「相对 JSON 路径 / `.mcpb`」引用）/ `lspServers` / `settings`（合并时只保留白名单键）/ `userConfig`。
- 运行时未知顶层字段被静默剥掉（容错）；开发期用 `claude plugin validate` 严格校验（typo/非 kebab-case/缺字段会给告警）。

### 5.3 目录结构
```
.claude/plugins/<name>/
├── .claude-plugin/plugin.json   # 必须；name 决定 MCP 命名空间
├── .mcp.json                    # 可选；注册本插件 MCP 服务器
├── skills/                      # 可选；插件 skill，触发 /插件名:skill名
├── docs/                        # 可选
└── 引擎代码 / 活数据(brain/) / 模板
```

### 5.4 发现与注册（两个来源，manifest 驱动）
| 来源 | 目录 | source 标记 |
|---|---|---|
| @skills-dir | 项目 `.claude/skills/<name>/`（含 plugin.json 的才算插件） | `skillsdir` |
| @plugins-dir | 便携插件目录 `@WrokSpace/.claude/plugins/<name>/`（=`getPluginsDirectory()` = 配置根 plugins/） | `pluginsdir` |

- **判定**：子目录含 `.claude-plugin/plugin.json` → 加载为插件；纯 skill 目录（无 manifest）→ 交给 skills 加载器；系统条目（`marketplaces/`、`data/`、`*.json`）无 manifest 自动跳过。
- **常驻启用**（always enabled）、**不复制到 cache**——活在项目内，随配置根整体搬（便携）。
- 加载连带效果：
  - 插件 skills 以 `/<插件name>:<skill名>` 触发
  - 插件根 `.mcp.json` **自动注册 MCP 服务器**（`loadPluginMcpServers`）
  - MCP 工具命名空间 = `mcp__plugin_<plugin.json 的 name>_<server>__*`（**与目录名无关**）
- gates：bare 模式 / projectSettings 源禁用时跳过。

### 5.5 注册优先级与覆盖
- `--plugin-dir`（session 插件）**>** 同名 @skills-dir 插件（同名时 skillsdir 被过滤）。
- marketplace 安装插件按名被 session/skillsdir 覆盖，**除非**被 managed（policySettings）锁定。
- 依赖缺失 → `verifyAndDemote` 临时禁用（session 级，不写 settings）。

### 5.6 生命周期
- 会话启动时一次性加载；改动**重启会话才生效**。
- `.mcp.json` 用 `${CLAUDE_PLUGIN_ROOT}` 指向插件根定位脚本（相对路径，便携）。

### 5.7 现状清单
- `codegraph/`（name=`codegraph`）— 代码知识图谱 MCP，索引 `src/.codegraph/`
- `github/`（name=`github`）— GitHub 官方 MCP（github-mcp-server Windows 二进制内置 `mcp/`）：stdio + `--toolsets=context,repos,issues,pull_requests,users,git`；PAT 填 `.mcp.json` env `GITHUB_PERSONAL_ACCESS_TOKEN`（classic 勾 repo+delete_repo；`delete_repository` 不可逆须用户确认）；接入说明 `docs/setup-guide.md`；命名空间 `mcp__plugin_github_github__*`，重启会话生效
- 已移除（归档 `.trash/`，勿引用）：`neturon/`（neturon-rag RAG 插件，已被 Pj16 TS 内置版取代 → §7；数据根 `@WrokSpace/.claude/neturon/` 不动，TS 版原样续用）、`qwen-mm/`（Qwen 多模态视觉插件）、`telemetry-monitor/`（会话遥测 MCP，功能被内置网关 `/gateway/sessions` 覆盖）

## 6. MCP 服务器标准

- 只通过插件 `.mcp.json` 注册（`"command"` + `"args"`，可含 `${CLAUDE_PLUGIN_ROOT}`）。
- **参数来源仅两个**：config 或指令运行时显式提供；**禁写死默认值**。
- **序列化必须用管线序列化器**：cog.json → `_write_cog_json(_serialize_cog)`，mem.json → `serialize_revelant_inline`；**禁裸 `json.dump(indent=2)`**——numpy `float32` 等会直接序列化崩溃。
- **MCP 必须完全复刻管线逻辑**（管线=成熟摹本，MCP 须完全实现，不允许近似）。
- 检索类工具返回 `precog.record_id` 时，调用方**必须立即** `rag_fill_precog` 填 accuracy/description（`true`=直接回答 / `revelant`=相关非直接 / `false`=噪音）。

## 7. 记忆 / RAG 标准（neturon）

- **引擎 = TS 进程内置工具** `src/tools/neturon/`（18 件：config/serialize/embedder/segment/retriever/memwriter/precog/usageHint/maintain/recall/remember/leiden/coggraph/cogname/roster/ops/index），`feature('NEURON_RAG')` 门控**默认开**（build.ts defaultFeatures）。工具 = `recall` / `remember`（**不带 neuron_ 前缀**——常驻直载、不经 ToolSearch 检索，系统提示自带 schema 直接调用）+ `neuron_list` / `neuron_source` / `neuron_fill_precog` / `neuron_cog` / `neuron_maintain`（延迟加载，ToolSearch 可检索；neuron_cog 三 action = build_graph / detect_communities / name_communities；neuron_maintain 五 action = set_blocks / recut / forget / merge / usage——**块级维护口，落地「使用中被优化、优化目标主要是 blocks」**）。neturon-rag 插件已移除（§5.7）；机制细节 → [core.md](core.md)「神经元内置检索/记忆」。**Python quirk 保真勿「修正」**：`partition.q` = igraph VertexClustering.q 无权 γ=1 模块度（加权 Q 以 `q_weighted` 随工具返回）。**认知链已主动偏离 Python**：cog 全链纯标注驱动、文本不参与任何判据（core.md「认知图形成」），Python 对照只覆盖 leiden/社群统计等未改部分。
- **三层管线**：`l3.raw`（脚本/工具全文）→ `l2.mem`（记忆片段）→ `l1.cog`（社群/节点/precog）。**raw 层惯例**：每条 mem 条目的 `revelant[0]` = 其 raw 层 `message_id`（`l3.raw/<来源>/message.db`），`source` = 来源标签（'LOG'/'MEM'/'QQ'/'微信'…）——**全部在盘项目同此**：`scripts/init-neuron-project.ts` 为各在盘项目建 Neuron-PjN 三层库，各项目根历史 LOG.md 已迁入 raw+mem 层并真移动（项目根不再有 LOG.md；新 LOG 条目一律写各自 mem 层，Pj16 入口现状见 core.md）。
- **`blocks` 标准（声明源 = 各库 `config.yaml`）**：`blocks.max_chars`（Pj16=300 字）+ `prompts.add_memory`。**块数 ≥ 2，一块一件事；单块 ≤ max_chars；block[0] = 检索锚**（查询形自然语句 + 关键标识：功能名/文件路径/参数名/报错原文）；按 `；。` 主切、【标签】并入首块；**块内不嵌时间戳**；禁纯工具名块。写入侧由 `memwriter.ts` 强制切分（`blocks` 与 `[input.content]` 两条路径同切，`splitBlock`/`blockMaxChars`），不靠自觉。**动因**：encode 超 512 token 静默丢尾。**块级向量**（2026-09-30 起）：逐块单位向量随 blocks 同行存 mem.db，条目命中 = 各块 cos 的**最大值**（`max_r cos(q, block_r)`，块数无关；弃 Σcos÷√n——随 √n 增长致排序被条目长度支配）。机制推导 → [core.md](core.md)「神经元内置检索/记忆」。
- **写记忆**：脚本/工具全文存 `l3.raw/`，`core_file` 只存**相对路径**引用；同一源不重复记录（复用同一源）。
- **检索（双检索）**：`recall` 查 mem（唯一写 precog；`mode` 三值 mem/cog/community）+ `neuron_cog` 全查五层（概念/社群/precog节点/聚合节点/mem）。
- 命中后用 `neuron_source` 取完整 `mem.content` 确认真实上下文，按 `core_file[].path` 复用脚本，不重复造轮子。
- 同一话题有失败（pattern=try）和成功（pattern=succeed）两条时，认准成功那条。
- 查询用自然语句（做了什么/怎么做的），不要关键词堆砌（BGE 对自然语句友好）。
- LOG 条目写库入口（Pj16 现状）→ CLAUDE.md「文件维护规范」：新 LOG 条目经内置 `remember` 工具写各自 mem 层（`neuron=<PjN>`，写法 → [core.md](core.md)「神经元内置检索/记忆」）；写后 `probe-neuron-index.ts` 只读核验（可自主跑），`rebuild-neuron-index.ts` 全量重编码（重资源长跑）启动前必须先征得用户同意。

## 8. Changelog 标准

- **源 = 本仓库 GitHub Release**（`https://api.github.com/repos/bruce2431/Floria/releases`）。启动时版本变化即后台拉取，`releasesToChangelog()` 只取每个 release `body` 的 `- ` 行、转成 `## <version>` 段落写进 `<配置根>/cache/changelog.md`（供 "What's new" 展示）；取不到网络时**不清缓存**，沿用上次成功内容。发布流程须保证 Release 正文用 `- ` bullet（→ CLAUDE.md「发布规则」）。
- **展示语义**：默认只显示比 `lastReleaseNotesSeen` 新的版本条目；但条目键是 base semver（如 `3.48.0`）而 dev 构建每版只变 build metadata（`+YYYYMMDD.tHHMMSS`）⇒ 同一 base 永远不算「新」，直接过滤会让 What's new 恒空。故过滤结果为空时**回落展示最新一版的条目**（`getRecentReleaseNotes` 内，与 `/release-notes` 命令的空结果回落同义）。
- `cache/changelog.md` 是 **App 展示缓存**，会被网络拉取**覆盖**，**禁止手工往里写**。
- **禁止**在 `@WrokSpace` 根创建 `CHANGELOG.md`——官方惯例在本 fork 不适用，App 不读它。
- 格式：`## <版本号/日期>` + `- 条目`；支持非 semver 键（如日期），解析器会自动按日期排序。
- 工作区的变更记录走 `@WrokSpace/LOG.md`（LOG 只追加），两者职责不同，不混用。

## 9. 工作区约定（@WrokSpace）

- **🔴 所有文件只能在项目内建立（红线）**：任何生成/创建/修改文件都必须落在所属项目内（Pj16 会话：本项目与工作区根 `LOG.md` + 规范四件（`CLAUDE.md`/`README.md`/`STATUS.md`/`.hermes.md`）自动放行，其它落点写操作**弹审批**（`defaultMode: default`，仅 `rm`/`rmdir` 直接拒绝）；其余项目各自 `.claude/settings.json` 为 deny 锁死，只写自身 + 根 5 件）。**严禁在项目外创建任何文件**，包括但不限于：系统临时目录（`/tmp`、`%TEMP%`）、桌面根、其它盘符、工作区根等。截图/临时产物一律放任务目录或项目内子目录。
- **LOG 只追加不修改**：工作区根 `LOG.md` 走 `patch` 追加、时间戳从 `date` 命令获取；项目 LOG 写神经元 mem 层（见 §7），时间戳进 `memory_id`。
- **临时任务目录命名**：`YYYYMMDDHHMMSS-名称`（紧凑时间戳无方括号）；存量 `[YYYY-MM-DD-HH-MM-SS]-名称` 旧目录不改名（含其中会话，改名断接续）。
- **单文件产出不建临时目录**：单个 md/脚本/图等直接建 `YYYYMMDDHHMMSS-名称.ext` 放目标位置（如项目根），多文件才建 `YYYYMMDDHHMMSS-名称/` 目录（`.hermes.md` 规则A）。
- **禁止删除**：废弃内容移到 `.trash/YYYY-MM-DD/`。
- **操作后立即验证结果**。
- 项目变更需**同时更新**项目内神经元 mem 层 LOG 和工作区 LOG；状态目录树见 `STATUS.md`。
- 门控规则见 `.hermes.md`（禁止捏造事实、禁止删除、临时任务命名、操作后验证）。
- **不自己运行** `启动.bat` / `start_site.py` 启动本地站点（0zijun 等由用户自己双击启动；需要站点运行时告知用户去启动）。

## 10. 与官方版本的主要差异

| 项 | 官方 Claude Code | 本 fork |
|---|---|---|
| 全局配置根 | `~/.claude` | `@WrokSpace/.claude`（`.claude/.claude-portable` 标记逐级向上找） |
| 插件发现 | marketplace + `--plugin-dir` | 额外扫描 `.claude/plugins/`（@pluginsdir 原地插件） |
| MCP 命名空间 | `mcp__<server>__*` | `mcp__plugin_<plugin name>_<server>__*` |
| Changelog | 根 CHANGELOG.md / 官方 release 源 | **本仓库 GitHub Release**（`api.github.com/repos/bruce2431/Floria/releases`）→ `cache/changelog.md` |
| 构建 | npm 官方发布流程 | `bun --compile --bytecode` 自包含单文件（→ [build.md](build.md)） |
| 项目 `.claude/` | trust/onboarding 触发创建 | **惰性创建**（首次写项目设置才 mkdir；会话存储的 `.claude/projects/` 写会话时自动建） |
| 会话/记忆存储 | 全局 `~/.claude/projects/` 统一 | **会话/自动记忆均项目级、平铺**：会话 `<项目>/.claude/projects/*.jsonl`，记忆 `<项目>/.claude/projects/memory/` |
| 权限规则 `@/` 前缀 | 无此语法 | **自定义特性，生效中**：`@/` 解析到便携根（`.claude-portable` 标记所在 `.claude` 的父目录 = `@WrokSpace`），Edit/Read 的 allow/deny 规则均有效（`filesystem.ts` `patternWithRoot`） |
| `.claude` 目录编辑 | 可直接编辑 | **危险目录守卫**：路径任意段 = `.claude`，除下一段为 `worktrees` / `preview` / `neturon` / `images` / `temp` / `skills` / `plugins` 外 → acceptEdits 与项目级 allow 被无视，强制弹「编辑自己配置」审批；绕过守卫的唯一途径 = **会话级** allow 规则 `/.claude/**` 或 `~/.claude/**`（审批框选项 2 即写入，会话结束失效）。**豁免子目录（fork 改动，`filesystem.ts` worktrees 特例同款）**：预览产物、神经元库（记忆/LOG/长期件）、AI 图片、临时暂存是内容数据，skills/plugins 是 agent 日常扩展源——均非 harness 执行配置，回归 deny/ask/allow 与 acceptEdits 正常判定；其下嵌套 `.claude` 仍拦。**记忆另有更早豁免**（`checkEditableInternalPath`）：本会话项目根的 `<项目>/.claude/projects/memory/**`；会话根 = 便携根（全局会话）时，其下各项目的 `.claude/projects/memory/**` 同样免审批（`isProjectMemoryPathUnderRoot`，`memdir/paths.ts`） |
| `/cost` 单价来源 | 内置静态价目表（Anthropic 官方档） | **运行时抓厂商官网价目页**（deepseek / 智谱），官网未列回落 models.dev 目录；两者皆无 = 未定价计 0 并标注（**不套用其它模型费率**）；峰谷按时段（当前仅 DeepSeek，法定节假日自动抓取 + 可覆盖）；展示 ¥（内部计价仍 USD）→ [core.md](core.md)「动态模型定价」 |
| 品牌身份 | Claude Code / Anthropic | **白标 Floria**：身份句族 + env 假情报 + 主提示散句 + 工具描述 + guide agent 改造为 Floria guide；`CLAUDE_CODE_ATTRIBUTION_HEADER` 全局关；D 层功能性标识 `.claude`/`CLAUDE_*`/工具协议等不动 |

## 11. 常见坑速查

- **`.claude/.claude-portable` / `.claude/` 挪走** → exe 副本向上找不到标记 → 配置掉回 `~/.claude`，插件/记忆/凭证全失效。
- **exe 副本放进带配置根标记的项目 `.claude/`**（含 `.claude.json`/`settings.json`/`plugins`/`skills` 等）→ 配置根判定第 2 步静默切到项目本地，插件/记忆/凭证全失效。**只有 `projects/` 的目录不算配置根**。Pj16 现状：`Pj16-CodeAgent构建/.claude/` 自带 `settings.json` 标记位本就命中，但配置根解析第 2 步（上溯 `.claude/.claude-portable`）先命中工作区根 `@WrokSpace/.claude/` → 邻接判定（第 3 步）不生效，项目级 skill（archify）/`preview/` 可安全存放；仅把 exe 拷到无该标记处部署时按本条处理。
- **会话/自动记忆项目级、平铺**（不按启动目录分桶）：会话写入 `<项目>/.claude/projects/*.jsonl`，自动记忆写入 `<项目>/.claude/projects/memory/`，均随项目打包归档不丢失。跨项目会话列表用逐级向上扫描。
- **项目级 `.claude/` 启动不自动建** → 只在首次写项目设置（`/permissions`、`/config`、MCP 审批、插件装项目 scope）才惰性创建；要手动放 `CLAUDE.md` 或空 `settings.json`。
- **settings.json hooks 用 CWD 相对路径**（`.claude/...`）→ 在子目录会话里 hook 脚本静默跳过，只在 `@WrokSpace` 根目录跑才命中。
- **MCP/插件/hook 改动不热加载** → 必须重启会话。
- **编辑 `.claude` 下文件总弹审批** → 是危险目录守卫（`isDangerousFilePathToAutoEdit`）在拦，不是权限规则失效；审批框选项 2 = 写会话级 `/.claude/**` 豁免（会话结束失效）。`@/` 前缀 = 便携根（工作区根），不是项目根——项目内 `.claude` 规则须写成 `@/<项目目录>/.claude/...`；勿改写成绝对路径（违反便携红线）。**例外**：`preview` / `neturon` / `images` / `temp` / `skills` / `plugins` 子目录与自动记忆目录已豁免该守卫（回归 deny/ask/allow 与 acceptEdits 正常判定）——web 审批卡对上述路径还弹卡 = 会话还在跑旧 exe。
- **MCP 序列化** → 禁裸 `json.dump(indent=2)`，用管线序列化器，否则 float32 崩溃。
