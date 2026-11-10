# 源码核心机制（core）

> 本文件属 `docs/` 文档库。
> 官方源码重构快照 2.1.87（bun + ink + React，入口 `src/entrypoints/cli.tsx`），官方文档不适用。
> 路径均相对仓库根（`Floria/`，原 `_agent-src/`）。姊妹件：**术语 → [glossary.md](glossary.md)**；**构建/flag → [build.md](build.md)**；**规则标准 → [standards.md](standards.md)**；**网关服务 → [gateway.md](gateway.md)**；**web 链路 → [web-ui.md](web-ui.md)**。改动以下任一机制时必须同步更新本文。

## 便携配置根（`envUtils.ts`）

`CLAUDE_CONFIG_DIR` → 逐级向上找 `.claude/.claude-portable`（**显式标记优先于任何内容指纹**——`settings.json`/`skills`/`commands`/`plugins` 项目级 `.claude` 同样合法，仅凭内容无法与配置根区分）→ exe 旁 `.claude/`（带 `.claude-portable` 等标记；仅在向上无标记时兜底）→ 兜底 `~/.claude`。`.claude/.claude-portable` 必须留在 `@WrokSpace` 根（规则见 [standards.md](standards.md) §3）。复验锚点 `probes/probe-portable-root-order.ts`。

**信任判据同源**：`computeTrustDialogAccepted()` / `isPathTrusted()`（均 `config.ts`）把便携根标记当**唯一显式信任锚**——`isUnderPortableRoot(cwd)` 命中即已信任，压过 `projects[<绝对路径>].hasTrustDialogAccepted` 记录（标记优先于路径推断，与上行解析链同序）。理由：TrustDialog yes 分支同时写标记（`maybeInitPortableRoot`）与路径记录，唯有标记能在盘符 / 挂载点 / 机器变化后存活 ⇒ 换盘符、换机器不触发重新信任。复验锚点 `probes/probe-portable-trust.ts`。

**裸机初始化**：TrustDialog yes 分支调 `maybeInitPortableRoot()`——无 env、exe 邻接无标记、向上无标记（=本轮落 `~/.claude` 兜底）时，于 **exe 邻接**（`dirname(process.execPath)`，非 cwd——walk-up 从 exeDir 出发，cwd 建标记会死）建 `.claude/` 并写 `.claude-portable` 空标记，**下一轮启动**第 2 步命中生效（初始化=写标记，非运行中热切换；首轮 trust 记录留旧根，第二轮需再点一次 yes）。**判定按配置根内容而非目录存在性**（`looksLikeConfigHome`）：exe 邻接 `.claude/` 若只是启动时写下的项目本地 `projects/`，不算配置根，照常补标记（早期用 `existsSync` 判存在，导致从新盘/新目录启动时该目录已存在 → 永远不建根、每轮都落 `~/.claude`；E 盘实测即此形态）。exe 邻接已是真配置根则不动；`exeDir===homedir()` 直退；失败 throw 由调用方报，不阻断 trust。本机配置根由工作区根 `.claude-portable` 标记（walk-up 第 2 步）决定，本步不触发。

## 逐家 wire protocol 与 openai-chat 适配器

请求链焊死 Anthropic Messages（`getAnthropicClient()` 恒 `new Anthropic({baseURL})` → POST `${baseURL}/v1/messages`），接入无 Anthropic 兼容端点的厂商（如 Gemini 原生）需协议翻译。**协议声明进配置、适配器族进源码**（对齐 dsh/hermes：wire 适配器写在源码，只有选哪种协议进配置）：

- **配置字段** `ProviderConfig.protocol?`（`utils/credentials/types.ts`，缺省 `'anthropic'`）。provider 级未知字段 load/save 整体透传，无需改读写器。例：`gemini` = `{baseUrl: .../v1beta/openai, protocol: 'openai-chat'}`。
- **访问器** `getActiveProviderProtocol()`（`utils/credentials/pool.ts`）走会话绑定配置（与 baseUrl/apiKey 同一不变量）。
- **单一分派点** `resolveProtocolFetch({protocol, baseUrl, apiKey})`（`services/api/protocol-fetch.ts`）：`'anthropic'`（或未知）→ `undefined`（沿用 SDK 直连）；`'openai-chat'` → `createOpenAIChatFetch(...)`。**协议判定只此一处**，主客户端 + 两处绕过 SDK 的裸 fetch 点共用它。
- **适配器** `services/api/openai-chat-fetch-adapter.ts`（复用 Codex `fetch` 覆盖先例）：入口收 Anthropic 形态请求、出口吐 Anthropic 形态响应，内部翻译到 OpenAI Chat Completions。仅拦截路径恰为 `/v1/messages`（`count_tokens`/`models` 透传）。请求侧：system→system 消息 / text / tool_use→`tool_calls` / tool_result→`role:'tool'` / image→`image_url` data URL / tools→`functions` / tool_choice 映射（auto/any→required/none/tool）；**丢弃** cache_control/thinking/betas/output_config/metadata/stop_sequences；鉴权改 `Authorization: Bearer`（剥离 `x-api-key`/`anthropic-version`）；流式加 `stream_options:{include_usage:true}`。响应侧合成 Anthropic SSE（`message_start`→逐块 `content_block_start`/`delta`/`stop`，`index` 单调递增〔load-bearing〕→`message_delta`〔stop_reason 映射 tool_calls→tool_use / length→max_tokens / 余端 turn 语义〕→`message_stop`）；非流式吐 Anthropic message JSON。非 2xx → Anthropic 形错误体 + 上游状态码。
- **thought_signature 回传**（Gemini 3+ 硬要求）：上游在 `tool_calls[].extra_content.google.thought_signature` 下发签名，下一轮请求里**每个** `functionCall` part 缺签名即 400 `INVALID_ARGUMENT`（含历史轮）。核心只持久化 tool_use 的 `{id,name,input}`，`extra_content` 过不了会话存储——但 id 会原样落盘并作为 `tool_use_id` 回传，**签名随 id 一起持久**：适配器把签名 base64url 编进交给核心的 id（`<上游id>__fs<base64url(extra_content)>`，`encodeToolCallId`/`decodeToolCallId`），请求侧解出原始 id 与签名，`tool_calls[].id`/`tool` 消息的 `tool_call_id` 用原始 id、`extra_content` 用解出的签名——跨进程重启、会话 resume 均无需旁路存储（Gemini 的签名与 id 在同一个流式 delta 到达，见 `probes` 的 raw chunk 实证）。**无签名历史**（修复前写下的、跨厂商续接的）不能回放成 functionCall，因此**整条丢弃该 tool_use、其 tool_result 内容以普通 user 文本保留**；**禁止合成 `[tool call …]` / `[tool result …]` 之类的结构化文本**——模型会模仿成正文而不再真正调用工具（实证事故）。
- **接线点** 主客户端 `services/api/client.ts` pool 分支（`...(protocolFetch && {fetch})` 须排 `...ARGS` 之后才生效，同 Codex 分支）；`utils/toolSearch.ts` 的 tool_reference 能力探针（非 anthropic 协议 fail open 跳过——该端点在 OpenAI 兼容端不存在）；`tools/neturon/cogname.ts` 社群命名 LLM（经分派器发，仅当 neuron `llm.provider` 指向非 anthropic 商才触发）。

复验锚点 `probes/probe-openai-chat-adapter.ts`（离线 38 断言：流式文本+tool_call / 签名随 id 持久与回填 / 无签名历史丢弃且不产出伪调用文本 / 非流式 / 透传；`--live` 加真 Gemini 往返 + 真 Anthropic SDK 走适配器端到端）。

## 模型解析与会话级凭据绑定（`utils/model/model.ts` + `utils/credentials/pool.ts`）

**模型解析优先级**（`getUserSpecifiedModelSetting` → `getMainLoopModel`，高→低）：① 会话内 override（`/model`、web 切换，`getMainLoopModelOverride()`）② 启动 override（`--model` 启动参数，`setMainLoopModelOverride`）③ 凭据池 activeModel（`getActiveModel()`）④ `ANTHROPIC_MODEL` 环境变量 ⑤ `settings.model` ⑥ 内置默认。池模型绕过 availableModels 白名单（自定义 provider 模型清单内即可）。**家族别名落回**：绑 provider 会话里 `haiku`/`sonnet`/`opus` 等一律解析为**该会话绑定 provider 的模型**（`getActiveModel()`），不回落 Anthropic 一号 ID（见下条）。

**会话级凭据绑定（不变量）**：`pool.ts` 三档解析 **显式 override > 进程启动快照（`_bootProviderSnapshot`）> 池文件现值**；`getActiveProviderConfig()` / `getActiveApiKey()` / `getActiveBaseUrl()` / `getActiveModel()` 全走会话有效值，**本进程请求凭据只随本进程状态变化**——池文件被改（换默认供应商）不影响已在跑的进程（新会话才取新值）。`getGlobalActive*()` 供管理视图读池现值。

**启动段配对（跨供应商模型名必须与其供应商凭据同源）**：`main.tsx` 启动段 `effectiveModel = userSpecifiedModel(--model) || agentDef.model || getActiveModel()` → `findModelProvider(effectiveModel)` 命中池内模型即 `setSessionProviderOverride(该供应商)`（先于 `setMainLoopModelOverride`）——否则模型名与 baseUrl/apiKey 分属两家。池外模型（firstParty/Bedrock/Vertex 等 `findModelProvider` 落空）保持启动快照原样。**同款配对语义见 [gateway.md](gateway.md) §7 会话启动模型表**（`--model` 落地状态源、`session_send` 的 `model` 入参 → `session-create` 帧）。

复验锚点 `probes/probe-session-model.ts`（31 断言：`resolveSendMode` 的 model 归属、网关启动模型表/spawn `--model`、main.tsx 启动段 provider 配对、`session_send` 工具链、前端待定模型随 wsession 下发、cache-bust 三处同号）。

## 生图能力层（provider-neutral，`services/imagegen/`）

生图模型（如 Gemini `*-image`）走 `chat/completions` 时 Google 兼容层**不回传生成图**（有时 400 `Image generation is not yet supported on the chat.completions endpoint`，有时 200 但 `message.content` 为空＝**静默丢图**）。故生图请求绕开协议适配器，改由**与厂商无关的能力层**直接对接各厂商原生接口。**Gemini 是第一个实现，不是架构本身**——新增一家（OpenAI/GLM/Grok…）= 实现 `ImageGenerationAdapter` + `registerImageAdapter()`，公共层与展示链零改动。

- **分流点（聊天链路唯一新增判据，provider-neutral）** `isImageOutputModel(model)`（`service.ts`）读 `ProviderConfig.imageCapabilities[model].outputImage`。接线在 `services/api/client.ts` pool 分支：provider 声明了 `imageCapabilities` 才装 `createImageGenDispatchFetch({inner: protocolFetch ?? ARGS.fetch})` 覆写，覆写内命中生图模型转 `imagegen/service.ts`、否则**逐字透传给 inner**；未声明 = 不装覆写 ⇒ 文本链路逐字不变（缺省关闭）。
- **统一能力解析** `resolveImageCapabilities(caps, model)`（`service.ts`，纯函数）= **单一真源**，供分流判据 / 请求装配 / adapter 选型三处共用：容错 `provider/model` 形态（先原样查表，未命中再查尾段），命中即返回**裸模型 id**（直送 adapter 拼 URL 不再带 `provider/` 前缀）+ 该模型能力声明；非生图模型（`outputImage !== true`）⇒ null。`isImageOutputModel` 与 `handleImageGeneration` 均经它，`provider/model` 请求不再丢能力 / 不再拼错 URL。
- **契约** `types.ts`：输入 `ImageGenerationRequest{model,prompt,images?,options?}`、输出 `ImageGenerationResult{images:[{bytes,mimeType}],text?,usage?}`、上下文 `ImageGenerationContext{provider,model,baseUrl,apiKey,capabilities,fetchImpl?,signal?}`、接口 `ImageGenerationAdapter{name,supports(ctx),generate(req,ctx)}`。`ImageGenerationError{code,httpStatus?}`：**有 `httpStatus` = 上游 HTTP 失败** → 回非 2xx Anthropic error JSON；**无 = 业务失败**（版权/安全/空响应）→ 回 assistant 文本（CLI/web 均可见，不静默）。
- **能力声明** `ProviderConfig.imageCapabilities?: Record<model,{inputImage?,outputImage?,imageEdit?,multiTurnImage?}>`（`utils/credentials/types.ts`，手工配置只读）。与 `modelVision`（输入侧识图）**并列独立、互不覆盖**；字段缺省 = 功能关闭。访问器 `getActiveProviderImageCapabilities()`（`pool.ts`，会话绑定同 baseUrl/apiKey）。另有 `ProviderConfig.imageModel?: string`（主模型编排生图时**选用的生图模型 id**，缺省 = `ImageGeneration` 工具对该 provider 关闭），访问器 `getActiveProviderImageModel()`。凭据池 `CredentialsFile.tools?: Record<能力名,{provider,model?}>`（`ToolBinding`）＝**按能力分槽的工具绑定**（当前只 `image`）＝**回落目标**：本会话 provider 无生图能力时 `ImageGeneration` 工具改用绑定 provider 的模型 / 端点 / 钥匙（访问器 `getToolProviderConfig('image')` + `getProviderApiKey()`，**全局不随会话绑定**；会话 provider 自带可出图 `imageModel` 时优先）。工具绑定模型**不出现在可切换模型列表**（web `/gateway/models` 与 CLI `/model` 补全共用谓词 `isToolBoundModel()`：`imageCapabilities[model].outputImage===true` 或被 `tools.<*>.model` 引用，**仅隐藏不禁止**——直连链仍可达）。生图会话**不传 tools**（历史 `tool_result` 降级为可见文本，非静默）。
- **输入图装配（优先级：显式附图 > `@文件:图片` 令牌 > 会话上下文回注）**，全在 `generateImages` 核心内（direct 链与 `ImageGeneration` 工具链共用同一段）、`extractPromptAndImages` 保持纯函数：
  - **`@文件:图片` 令牌解析（`mentionImages.ts`）**：web 的 `@` 路径 chip 产出纯文本令牌 `[@文件:<工作区相对路径>]`（路径内 `]` 以 `\]` 转义、反斜杠本身以 `\\` 转义，见 web-ui.md §44），而生图会话不传 tools ⇒ 模型拿不到字节；本模块在**请求装配期**把它解析成 `InputImage`（服务端解析、前端中立、单点）。门控 `capabilities.inputImage`；路径基准 = `getPortableRoot()`（与 `/gateway/fs` 同基准）。**路径加固 `resolveRealWithinRoot(root, rel)`**：先词法（`resolveWithinRoot`，拒越界/绝对路径）→ 再 `realpathSync` 复核 `realAbs` 落在 realRoot 内（**挡符号链接/junction 逃逸**）→ `statSync().isFile()`（拒目录/非普通文件）；失败按类进 `warnings`（越界 / 非文件 / 读取失败），**不静默**；**非图片扩展名静默跳过**（那是给 Read 工具的普通 `@文件`）；超限进 `warnings` 回填正文；令牌**原样留 prompt**。上限 8 张 / 单张 8MB。
  - **会话上下文自动回注（`sessionContext.ts`）**：记住本会话**最近生成的一张图**（进程内存 `Map` + 写透盘 sidecar `<dir>/.imagegen-context.json`，`/resume` 新进程可续；条目存绝对路径 + `existsSync` 守卫）。条目 `path` = **展示图**绝对路径、可选 `sourcePath` = **全保真原图**绝对路径；A 回注读 `sourcePath ?? path`（**改图基于原图、非降质预览**），旧 sidecar（仅 `path`）仍可读。门控 `capabilities.imageEdit || multiTurnImage` 且 `sessionId` 非空、且**本轮无任何显式/B 附图**——此时回注上一张，使「继续把刚才那张改成夜景」无需重新附图。命中即落盘记录、回填正文加一行 `（基于上一张图继续编辑）`、审计 `contextImage` 置位（不静默、不刷屏）。
- **公共层 `service.ts`（Direct / Orchestrated 分层，共用核心）**：核心 `generateImages(rc, {prompt, images?, options?}) → GeneratedImages`（纯函数式，凭据/目录全由参数传入，探针可离线直测）＝**装配**（显式附图 + 按上表补 B/A）→ **生成**（`AbortController` 180s 超时；**仅网络/5xx 重试一次**，生图非幂等避免重复计费）→ **落盘**（`persistImages`）→ **记上下文**（`setLastImage`）→ 审计。两条入口只是薄壳：`runImageGeneration(body, rc)`（**direct 链**）＝ `extractPromptAndImages` → `generateImages` → `composeText` → `emit`（错误映射 `httpStatus`→非 2xx JSON / 文案不变）；`ImageGeneration` 工具（**orchestrated 链**）直接调 `generateImages`。`handleImageGeneration` = 从凭据池装配 rc（经 `resolveImageCapabilities` 取裸模型 id + 能力，含 `sessionId: getSessionId()`）后转 `runImageGeneration`；`createImageGenDispatchFetch` = 覆写工厂。
- **落盘** `store.ts`：`{provider}-{模型短名}-{YYYYMMDDHHmmss}[-{n}].{ext}`（模型短名去尾 `-preview`、非 `[A-Za-z0-9._-]` 换 `-`；`seq` 加显式序号），目录 `<cwd>/.claude/images/`（与 `/gateway/file` 同口径）；**同名不覆盖**——`writeImageFileAtomic` 以 `open(…,'wx')`（O_EXCL）原子占位，冲突则依次试 `<名>-2`、`-3`…（同秒连发/同批多图各自独立落盘，无「先查后写」竞态），返回实际名字供回填；审计追加 `<dir>/.imagegen-log.jsonl`（失败不致命）。
- **展示图 / 原图分离（`persistImages` + `sourceDirOf`）**：`fitForViewer()` 返回 `compressed`（真重编码才 true），**展示图恒扁平落 `<dir>`**（web `MD_IMG_CODE` 只认单文件名——**不得**入子目录）并受网关 4MB 上限约束（超限先 `compressImageBuffer`、压不动则原样落盘 + 文本注明「图片过大，预览可能失败」，不丢图）；**仅当压缩过**才把**原始全保真字节**按源扩展名写 `<dir>/.source/<名>`（隐藏子目录、**永不被 markdown 引用**）。`PersistedImage.sourcePath` 指原图；未压缩时 `sourcePath === path`（零额外写盘、零改名）。展示链仍引用扁平展示名 ⇒ 前端零改。
- **响应合成**：非流式吐 Anthropic message JSON；`stream:true` 吐**严格 Anthropic SSE 序**（`message_start`→`content_block_start`→`text_delta`→`content_block_stop`→`message_delta`→`message_stop`，index 单调），真 SDK 可解析。
- **首个 adapter** `adapters/gemini.ts`（**全项目唯一含 Gemini 特殊逻辑处**）：走原生 `POST {baseUrl 去尾 /openai}/models/{model}:generateContent`（非流式），头 `x-goog-api-key`，读 `candidates[0].content.parts[]` 的 `inlineData`（→bytes/mimeType）与 `text`、`usageMetadata`→usage；拦截面（`IMAGE_RECITATION`/`SAFETY`/`PROHIBITED_CONTENT`…）/空 `candidates`/无有效 parts → 明确失败文案。
- **展示链零改动**：`.claude/images/` 落盘 + `![](文件名)` 回填 + `/gateway/file`（白名单 + 越界守卫 + 4MB 上限）+ CLI/web markdown 渲染全部复用。回归锚点 `probes/probe-openai-chat-adapter.ts`（28 断言）。
- **`ImageGeneration` 工具（主模型编排入口，`tools/ImageGenerationTool/`）**：文本模型会话**按运行态门控**出现——`isImageGenerationToolEnabled({target, sessionCaps, sessionModel})`＝存在**可出图的生图目标**（`selectImageTarget`：`resolveImageCapabilities` 命中 `outputImage`）**且** 会话模型**非**生图模型（`resolveImageCapabilities(sessionCaps, sessionModel) === null`，**与直连链互斥**，避免同一请求双路）。生图目标**会话 provider 优先**：本会话 provider 自带可出图 `imageModel` 就用它；否则回落凭据池 `tools.image`（`CredentialsFile.tools.image`，指向另一 provider 的生图模型 / 端点 / 钥匙——让只有 deepseek 这类无生图能力的文本会话也能编排生图）。**`sessionModel` 取自 `getMainLoopModel()`（主循环真实模型，含 `/model` 会话 override / web 切换），不得用 provider 启动快照 `getActiveModel()`**——后者漏掉本会话 override，会把「provider activeModel 是图片模型、本会话却切到文本模型」误判成直连链而关掉工具。工具调用**不用** sessionModel 当生图模型（职责分离：主模型只编排、生图模型只出图）；凭据随目标来源取——回落目标用绑定 provider 自己的 `baseUrl` + 钥匙（`getToolProviderConfig('image')` / `getProviderApiKey`），会话访问器够不着它。入参 `{prompt, image_path?, aspect_ratio?}`；`image_path`（工作区相对路径的参考/待改图）经 `resolveRealWithinRoot` 校验后组 `InputImage[]`，装配/生成/落盘全复用 `generateImages` 核心。**可见性靠模型回显**：工具结果文本含 `![](文件名)` 行 + 一行指示「请在最终回复中原样输出上面每一行」，web 只渲染 assistant 文本 ⇒ **零前端改动**。`checkPermissions` → `allow`（工具仅在存在可出生图目标时才出现，不额外弹审批）。

复验锚点 `probes/probe-imagegen.ts`（离线 **93 断言**：请求装配/URL/头、带图输入、tool_result 降级、伪造 SSE 序、错误映射〔400→非2xx / IMAGE_RECITATION / 空 / 纯文本〕、注册表可扩展性、文件名助手（含**同名不覆盖**递增 `-2`/`-3`）、4MB 守卫、**会话上下文自动回注 J**〔两轮记录+回注/显式附图抑制/门控缺省不注入〕、**`@文件:图片` 解析 K**〔命中/越界/非图静默/门控/缺文件警告〕、**B 抑制 A L**、**统一能力解析 M**〔裸 id 命中 / `provider/model` 归一尾段 / 非生图→null / 无 caps→null〕、**展示图/原图分离 N**〔>4MB 压出扁平展示图 + `.source/` 存原字节 + sidecar `sourcePath` + 次轮回注读**原字节**；小图 `sourcePath===path` 且无 `.source/`〕、**realpath 加固 O**〔根内命中 / 越界 / 缺文件 / 目录拒 / junction 逃逸拒〕；`--live` 加真 Gemini 出图 + 多轮改图 + 纯文本上下文回注）。工具链复验锚点 `probes/probe-image-tool.ts`（离线 **62 断言**：**门控真值矩阵 P**（含**回落 `tools.image`**：会话无生图能力→回落启用 / 两者都声明→会话优先 / 会话 `imageModel` 不可解析→回落 / 会话模型是生图模型→即使有回落也关）/ **工具壳接线 Q**〔名称 / 无 provider caps 时 `isEnabled()===false` / 未配置时 `call` 回可见失败〕/ **经 `image_path` 走 `generateImages` R** / **门控会话模型来源 S**〔`getMainLoopModel` vs provider 快照四态〕/ **职责分离 T**〔adapter `ctx.model === imageModel` ≠ sessionModel〕/ **回落凭据 U**〔文本会话 + `tools.image` → 工具启用且 adapter `ctx.provider/model/baseUrl/apiKey` 全取回落 provider；会话自带 `imageModel` 时优先〕/ **绑定访问器**〔`getToolProviderConfig` 解析/缺 provider 返 null；`isToolBoundModel` 对 `outputImage` 模型与 `tools.*.model` 引用模型为 true、纯文本模型为 false〕）。

## 会话/记忆项目级平铺

会话 `<项目>/.claude/projects/*.jsonl`、自动记忆 `<项目>/.claude/projects/memory/`；subagent 转录按 `<sessionId>/subagents/` 子目录（正常设计）；项目身份用 `getProjectRoot()` 而非 `getOriginalCwd()`。布局规范 → [standards.md](standards.md) §2.1。

## 插件/skill 双发现（`pluginLoader.ts`）

`.claude-plugin/plugin.json` → 插件（根 `.mcp.json` 自动注册，工具命名空间 `mcp__plugin_<插件>_<server>__*`）；`SKILL.md` → skill（`/<插件>:<skill>`）。会话启动一次性加载，改动重启生效。注册标准 → [standards.md](standards.md) §4-§5。

## feature flag

编译期 `feature('X')` 裁剪，只在 `if` 条件里直接调用才能 tree-shake。旗标逐条审计 → [build.md](build.md) §2。

## Changelog（`releaseNotes.ts`）

源 = 本仓库 GitHub Release（`api.github.com/repos/bruce2431/Floria/releases`，取 `body` 的 `- ` 行转 `## <version>`），版本变化时后台拉取写入 `<配置根>/cache/changelog.md`（会被覆盖，**禁手写**）；取不到网络不清缓存，沿用上次内容。**展示过滤**：只取新于 `lastReleaseNotesSeen` 的版本；同 base semver（dev 构建仅变 build metadata）无新条目时回落最新一版，避免 What's new 恒空。标准 → [standards.md](standards.md) §8。

## 沙箱权限（`permissions/`）

allow/deny/ask + defaultMode 兜底；路径匹配 gitignore 语义（`@/`=便携根、`~/`=home）；deny 硬拦截。工作区两档权限模型（Pj16 主控档审批制，其余项目 deny 锁死）→ 工作区级 CLAUDE.md「工作区沙箱协议」。

## 网关缺失自愈 + 日志落盘

1. **自愈**——`gatewayClient.ts` `probeAndConnect()` 探测网关不在（`/gateway/health` 失败）时，经 `feature('PRIVATE_GATEWAY')` 门控动态 import `commands/server/server.ts` 的 `ensureGatewayAutoStart()` 自动 detached spawn 独立网关（60s 节流；`isGatewayUp` 在→跳过；端口被非网关占用→**静默放弃不强抢**（自动路径禁杀进程）；token 继承盘上 `.claude/gateway/token`，无则随机），spawn 后下轮 PROBE_RETRY(10s) 自然接续——网关 crash/空闲回收退出不再需手动 `/server on`。
2. **日志**——`spawnGatewayProcess()`（`/server on` 与自动拉起共用）：网关进程 stdout/stderr 落盘便携根 `.claude/gateway/gateway.log`（5MB 截断轮转）；手动前台 `exe --gateway` 直出终端。
3. **排查第一现场**：系统 commit 内存临界时 web 首屏全量渲染的内存尖峰可触发多进程连锁 crash（Windows 不挑进程，谁撞分配失败谁死）——查 `gateway.log`；系统层根治=页面文件改自动管理（用户操作）。
4. **CLI 级缓存/日志**——`cachePaths.ts` `CACHE_PATHS` 四基路径（`baseLogs`/`errors`/`messages`/`mcpLogs`）一律锚定 `<配置根>/cache/<cwd-slug>/`，不走 `env-paths`（Windows 下会解析到宿主 `%LOCALAPPDATA%\claude-cli-nodejs\Cache`）：便携版插到任何机器都不在宿主盘留痕，基路径随盘符 / 挂载点走。目录名 slug 由本件自带 `sanitizePath`（djb2Hash）生成——**不用** `sessionStoragePortable.ts` 的 Bun.hash 版，升级后目录名保持稳定、旧缓存不孤儿化。复验锚点 `probes/probe-cache-paths.ts`。

## 神经元内置检索/记忆（NEURON_RAG，默认开）

`src/tools/neturon/` 18 件纯进程内置（引擎核心+工具层，无 Python 子进程），`feature('NEURON_RAG')` 进 build.ts defaultFeatures。

**双层根扫描发现**：cwd 根 `<cwd>/.claude/neturon/` + 全局根 `<configHome>/neturon/` + RAG_DATA_DIR 追加；目录即注册（含 config.yaml + l2.mem/mem.db），id=person.id 跨根唯一，注册表 10s TTL 缓存；仍为旧 mem.json 的目录不注册、经 neuron_list 报 `pending_migration`。

**存储层 DB 化**：`db.ts`（bun:sqlite 零依赖）三表统一 schema——`l3.raw/<来源>/message.db`（7 列）/`l2.mem/mem.db`（memories 8 列：memory_id/revelant/blocks/source/core_file/supersedes/deprecated_by/**block_vectors**(BLOB)；无 confidence/half_life/created_at 列）/`l1.cog/precog.db`（8 列，纯追加+标注 UPDATE）；缺字段=NULL、时间编码进 id 无独立 time 列（idTime/makeMessageId）、busy_timeout=5000 防双前端写碰撞；content/summary 不落库由 blocks 派生（deriveEntryText）。**块级向量与 blocks 同行**：`block_vectors` = 该条各块向量按块序拼接的 Float32（n_blocks×dim，L2 已归一的单位向量）——向量与其来源块同一行、同事务写入，**「索引行 ↔ 块」的位置映射不存在，故无漂移**（2026-09-30 定案，取代 2026-09-04 的 embeddings.npy + index_config.json 方案；npyio.ts 已归档）；老库无该列由 `openDb` 就地 `ALTER TABLE ADD COLUMN` 补齐（值 NULL，待 rebuild 填）。cog_graph.json/community.json/cog2.json 快照 JSON 保留。旧 JSON 迁移三件（mem 嵌套 men/sem→平铺 / cog precog_records / message 重编 id 返回 id_map 供 revelant 联动）。

**检索** = BGE 向量（@huggingface/transformers + Xenova/bge-small-zh-v1.5 ONNX，懒加载动态 import，编码前预小写归一化对齐 Python 生产路径，模型缓存 `<全局根>/cache/models/` 首跑 hf-mirror 下载 91MB）+ Intl.Segmenter 关键词加权（`ranking.fact.w_cos/w_kw` 权重，读全文不受截断影响）+ precog 写入（recall `mode` 三值：mem 默认=记忆检索+写 precog / cog=仅概念+聚合节点 / community=仅社群后两者不写 precog；**返回条数完全由调用方 `top_k` 决定**，未传取库配置 `precog.default_top_k`——旧「底部仍高于阈值即 ×expand_factor 自动扩 k」已删，`expand_threshold/expand_factor` 两键随之退役）；**块级打分** = 条目 cos 取其各块向量与查询的 cos 的**最大值**（`max_r cos(q, block_r)`，块级单位向量；max 有界 [0,1] 且随块数 n 不变——块各自独立向量、最匹配的块决定命中。**弃用 Σcos÷√n**：该式随 √n 增长，本库 n∈[1,453] ⇒ √n 跨 1→21 而相关/不相关块 cos 仅差 ~0.1 ⇒ 排序被条目长度支配、检索与 query 无关；索引恒与 blocks 同行故无「行数不一致」类守卫，仅 dim=0/某条增量缺口时硬抛要求 rebuild）。**写侧** remember add/update（supersede 纠错，先算后写）——每次只编码该条 blocks（O(该条块数)），随行落 mem.db，**无全库重写**；全量重编码只在建库/换模型/手工直写缺口时经 `scripts/rebuild-neuron-index.ts` 人工触发。

**l1.cog 认知层形成侧**：`neuron_cog` ops 工具（action=build_graph 批折叠建图，含防假标注门禁——pre 记录 description/accuracy 空则拦截，fill_precog 合法集 {true,revelant,false} / detect_communities 多分辨率 Leiden——本体 `leiden.ts`，leidenalg 实图对照 ΔQ≈0；community.json modularity 复刻 igraph 无权 γ=1 语义，加权 Q 以 q_weighted 另返回）；**社群命名** `cogname.ts`（`action=name_communities`，链末端=detect_communities 之后）：默认分辨率各社群 → LLM 上位概念命名重写 `l1.cog/cog2.json`（记录形状：cog2_id=C{ts}_{nn}/name/confidence/description/members/member_names/community_size/community_density/resolution/reason；旧文件 .bak；消费方 = retriever cognitionRoute 概念 cos（embedCogCache 编码 name+desc）+ getCogOnly 关键词 name×2/desc×1 ≥1 命中 + neuron_list cog2_count）。LLM 配置 = config `llm` 段 provider/model/temperature，**密钥不入 config**——凭据单源 = 全局根 credentials.json `providers.<provider>`（与 WebSearch 同惯例；Anthropic 协议 `/v1/messages` 直调）。对 Python 两处有意偏离：① 无 size 2~6/密度硬门（只尊重 community.min_group_size，异质与否交给模型 name=null 拒绝语义）；② 成员证据取 mem blocks[0] 检索锚头部 60 字 ×≤2。实测定案：glm-4.6 经 anthropic 端点回 thinking 块且计入输出预算（max_tokens=2000 防 JSON 被思考截断），**社群命名用 glm-5.3-flash**；批量社群间 30s 节奏 + 429 等 30s 重试 ×3（bigmodel 账户级限频，等窗即恢复）。

**认知图形成 = 纯标注驱动（主动偏离 Python）**：节点归并判据 `sim = jaccard(true 集) ≥ cog.merge_threshold(0.50)`、边权 `weight = cog.w_true_assoc(0.40)·jt + cog.w_revelant(0.45)·rv`——query/keywords/blocks 余弦三元全部移除，`edge_filter.no_jt_penalty` 随之删除。连带简化：`coggraph.ts` 整链不再需嵌入、节点不持久化 `merged_from` 与 `true_count/revelant_count`、边不持久化 `cq/ck/cb`；config 删 7 键并显式补 `precog.ttl_days: 90`。**语义改判 = cog 即事实层**：build_graph 永不修正既有节点记忆集（只并集折叠或建新节点，节点集合只增不减），发现错误直接改 cog 条目；precog 降级为「收件箱」（pre 必留 = 新节点入口 + 待标注队列 + 防假标注门禁载体，consumed 由 `precog.ttl_days` 回收）。完备加权图仍照 Python 原设计落盘（C(n,2) 条全写，仅 weight>0 的进 Leiden）。**Python quirk 保真勿「修正」**：`partition.q` = igraph VertexClustering.q 无权 γ=1 模块度。

**注册与名册**：tools.ts `feature('NEURON_RAG')` 门控 require，recall/remember **常驻直载不经 ToolSearch** + **延迟五件**（list/source/fill_precog/cog/**maintain**，shouldDefer）：`neuron_maintain`（`src/tools/neturon/maintain.ts`，后端在 memwriter）是块级维护口——action=set_blocks（替换某条 blocks，重写/合并/拆分/删除块的特例，重编码该条向量）/ recut（按 max_chars 重切，memory_id 省略=全库）/ forget（soft 标废弃 / hard 删行）/ merge（多条合一条新记忆，旧条废弃指向新 id）/ usage（只读，precog 命中+accuracy 概览）。记「使用中被优化、优化目标主要是 blocks」的落地口。名册经 prompts.ts dynamicSections `neuron_roster` 注入（cwd 根正文上限 8 + 全局根指针行）。

**Neuron-Pj16 项目库（三层齐备）**：cwd 根 `.claude/neturon/neurons/`，person.id=PJ16。① `l3.raw/LOG/` = LOG.md 原文全文（**真移动**——项目根不再有 LOG.md）+ `message.db`（每条目一行，`message_id=PJ16LOG_{YYYYMMDD}_{HHMMSS}[_seq]` 与 mem 条目 _seq 一一对齐，content=条目全文、source='LOG.md'）；② `l2.mem/mem.db`（`memory_id=PJ16_MEM_时间戳`，source='LOG'（迁移产物）/'MEM'（活写入））+ `block_vectors` 块级向量（n_blocks×512，随行存）；③ `l1.cog/` 认知层。**revelant 定案（照真身库惯例）**：迁移产物首元素 = 该条目在 raw 层的 message_id，其后为相关会话 jsonl 路径 + 该条目修改文件路径（证据指针数组，全相对项目根；jsonl 按首末行 timestamp 区间匹配，不迁移会话仅索引）；'MEM' 活写入条目无 raw message_id，`revelant` 直接放相关会话 jsonl + 改动文件路径。

**blocks 标准（声明源 = 各库 `config.yaml`）**：`blocks.max_chars`（Pj16 = **300 字** ≈180 token，落 BGE 位置上限 512 的安全余量）+ 库个性约定 `prompts.add_memory`（读取方 `remember.ts:52`）——块数 ≥ 2、一块一件事；单块 ≤ max_chars；**block[0] = 检索锚**（查询形自然语句 + 关键标识：功能名/文件路径/参数名/报错原文）；按 `；。` 主切、`【标签】` 并入首块；**块内不嵌时间戳**（时间已蕴含在 memory_id）；禁纯工具名块。**写入侧强制**：`memwriter.ts` `splitBlock(block, maxChars)`（就近取窗口后半段的句末标点 `。；！？` 或换行，找不到才硬切）与 `blockMaxChars(cfg)`（读 `blocks.max_chars`，缺省 300），`buildEntry` 对 `blocks` 与 `[input.content]` **两条路径都切**。**动因**：encode 对超长输入**静默丢尾**（transformers.js feature-extraction 默认按 tokenizer 512 token 截断），超长块尾部对检索零贡献。**块级向量**（2026-09-30 起）：encode 逐块产出**单位向量**、一块一行存 `block_vectors`；条目命中 = 各块 cos 的**最大值**（`max_r cos(q, block_r)`，块数 n 不变——取代旧的「逐维 max-pool 成一个条目向量」；初期误用 Σcos÷√n，因随 √n 增长致排序被条目长度支配而弃）。块长/块数仍影响打分，但由聚合式显式承担；kw 项（读全文）兜住实际检索效果。precog 标注语义：检索某组件历史→修改相同东西=true、不同东西但改相同文件相同部分=revelant。source 是来源标签（对照真身库 'QQ'/'微信'）。

**LOG 更新口（现行做法）**：新 LOG 条目经内置 **`remember` 工具**写 `l2.mem/mem.db`（`neuron=PJ16`；`content` 保留 [用户]/[Agent] 对话格式、`blocks` 按上述标准、`source` 写实来源；`memory_id=PJ16_MEM_{ts}`）。**写 mem = 更新 LOG，同一件事**，只追加原则不变——纠错走 `action=update` supersede 旧条目（不删除）。**写侧只编码该条 blocks（O(该条块数)）随行入库，无全库重写**。两件维护入口：**`scripts/rebuild-neuron-index.ts`**（走 `memwriter.rebuildVectors` 按 `readMemories` 行序逐条重编码 blocks 写回 `block_vectors`，幂等可重跑，库路径可选；**降为建库/换模型/手工直写缺口时的人工入口，启动前必须先征得用户同意**）+ **`probes/probe-neuron-index.ts`**（A 每条向量长度≡n_blocks×dim 且 dim 一致 / B 每块行 L2 归一 / C 真检索可用，秒级只读可自主跑）。**全项目神经元化**：`scripts/init-neuron-project.ts` 为各在盘项目建 Neuron-PjN 三层库并迁入各自历史 LOG，写法通用。使用标准 → [standards.md](standards.md) §7。

## WebSearch 本地多后端检索

`src/tools/WebSearchTool/`（WebSearchTool.ts + providers.ts + prompt.ts/UI.tsx）。**架构移植自 Hermes Agent web_tools**（参考源码 `C:\Users\Ma2431\AppData\Local\hermes\hermes-agent\plugins\web\`）：搜索为**纯客户端本地执行**（进程内 JSON HTTP），与推理 API 服务端工具能力解耦——任何模型 provider（GLM 反代等）都可用。原 Anthropic 服务端 `web_search_20250305` server-tool 链退役；原 isEnabled 的 provider 门控同步移除。

- **后端四家**（`providers.ts`，每家约 40 行 JSON HTTP）：`searxng`（自托管实例 `searxngUrl`，免 key，score 降序）/ `brave`（free-tier Data-for-Search，count 上限 20）/ `tavily`（/search，上限 20）/ `exa`（REST 直连不带 SDK，highlights 摘要拼接）。未移植：ddgs（Python 包爬虫，TS 无等价）、xai（仍是服务端路线）、firecrawl/parallel/keenable/perplexity（extract 向，正文抓取已由 WebFetch 覆盖）。
- **密钥与选择走全局密钥池**：credentials.json（`getClaudeConfigHomeDir()`，本机=全局根 `@WrokSpace\.claude\`）顶层 `webSearch` 段——`{ backend?: string, searxngUrl?: string, keys?: { brave|tavily|exa: string } }`；`loadCredentials` 白名单放行该段（load→save round-trip，否则被 /key 写操作冲掉），取值口 `getWebSearchCredentials()`（pool.ts）。后端选择：显式 `backend` **严格不换道**（不可用即报错，不静默 reroute）→ 从未配置过才自动探测（tavily→exa→searxng→brave）→ 全无则工具隐藏 + call 返回配置指引。密钥单源=池（不做 env 双轨）。
- **工具面**：isEnabled = 显式 backend 存在 ‖ 任一后端可用；输入 schema = `query + limit(1-100，默认 5)`（域名过滤走 `site:` 等运算符由后端自行支持）；输出 `Output` 形状 {query, results, durationSeconds}（SearchResult.tool_use_id 语义=后端名），UI 渲染链零改动；错误以字符串条目进 results（模型可见）。密钥写入暂为手编 credentials.json（/key 面板接入待做）。

## 动态模型定价（`utils/modelPricing.ts` + `utils/modelCost.ts`）

`/cost` 的第三方 provider（deepseek / glm…）单价不内置，运行时从**厂商官网价目页**抓取，官网未列模型回落 **models.dev 目录**兜底；两者皆无 = **未定价**，计 0 并在输出显式标注（`(unpriced)`），**绝不套用其它模型费率**（Anthropic 官方模型仍走 `modelCost.ts` 静态表）。

- **解析顺序**（`resolveModelCost`，全程同步）：① `credentials.json` `pricing.models[模型]` 用户覆盖 ② 厂商官网适配器（`ADAPTERS`：`deepseek`→`api-docs.deepseek.com`、`zhipu`→`docs.bigmodel.cn`，按 provider `baseUrl` 主机后缀匹配）③ models.dev 目录（目录 id 由适配器 `catalogId` 或 `pricing.providers[key].source` 显式声明，**不反查猜测**）④ `null`。目录段读入时丢弃「全模型 0 价」的 provider（订阅制套餐）。
- **峰谷只对带 `period` 的价目生效**（当前仅 DeepSeek）：时段 = 北京时间周一至周五 09:00-12:00 / 14:00-18:00（半开右边界），周末与法定节假日全天空闲；`pricing.holidays`（`YYYY-MM-DD`）/ `pricing.peakWindows`（`[[9,12],[14,18]]`）可覆盖。官网表直接给空闲/高峰两档原值，代码不做倍率乘法。
- **法定节假日自动抓取**：`HOLIDAY_URL`（`timor.tech/api/holiday/year/<年>`，当年 + 次年并行拉，跨年会话也有表）取 `holiday === true` 的日期写入 `PricingTable.holidays`，`peakPeriodAt` 判当日 = 配置手填 ∪ 抓取日历；只认休息日，**调休补班日（`holiday: false` 的工作日调休）不并入**（周末恒空闲，补班日本就该按工作日走峰谷）。拉取失败/解析空保留上一份日历（不清空已知节假日）。抓取日历缺失（接口挂）时退回仅按周末判。
- **长度分档**（智谱官网「上下文」列三类写法：`输入长度 [0, 32K)`、`输入长度 ≥32K`、`输入 [0, 32K)，输出 [0, 0.2K)`）解析为 `inputMinK/inputMaxK/outputMinK/outputMaxK` 半开区间；首个命中档生效，超出已列最大区间按最高档计；缓存命中的输入计入输入长度分档。DeepSeek 的 `cacheWrite` = 缓存未命中输入价；智谱 `cacheWrite` = 输入价（其「未命中缓存输入费用」已在输入单价内）。
- **内部计价单位恒为 USD**（`totalCostUSD` / `calculateUSDCost` / `costUSD` 未改名）：CNY 原生价目在解析时除实时汇率，展示层（`cost-tracker.formatCost`）乘回并显示 `¥`；汇率缺失退回 `$` 原值 + 尾注（不硬算）。汇率取 `pricing.usdCnyRate` 覆盖值，否则 `open.er-api.com`。
- **同步读路径不联网**：`calculateUSDCost` 在流式路径（`claude.ts`）同步调用，价格只读内存 + 缓存文件；网络仅在启动后台 `refreshModelPricing()`（`main.tsx`，与 `refreshModelCapabilities()` 并列、非阻塞，TTL 24h）。缓存 `<配置根>/cache/model-pricing.json` 原子写（tmp + rename），坏数据 `safeParse` 返回 null；拉取失败或官网页解析不出模型均保留 stale（fail-open）。
- **家族别名在 provider 会话里落回 provider 模型**：`parseUserSpecifiedModel`（`utils/model/model.ts`）在 `getActiveProviderConfig()` 非空时，把 Anthropic 家族别名（`haiku`/`sonnet`/`opus`/`best`/`opusplan`，含 `[1m]` 变体）一律解析为**该会话绑定的 provider 模型**（`getActiveModel()`），不回落一号默认 ID；未绑 provider 时行为不变。否则请求会带着「属于 Anthropic 的模型名」打到 provider 的 endpoint（模型名与 endpoint 分属两家），且记账时被 Anthropic 静态表定价——Explore 等内置子代理 frontmatter 写 `model:'haiku'`，`getAgentModel` 因而拿到一号 Haiku ID。非别名全名（含池模型名）原样透传，不受影响。
- **两个消费端共用同一格式化器**：`/cost`（`cost-tracker.formatTotalCost`）与状态行（`components/StatusLine.tsx` → `utils/statusLineBuiltin.ts`）都走 `cost-tracker.formatCost`（内部 USD → 按实时汇率折 ¥，缺汇率才回落 `$` 并尾注）。**改金额展示只动 `formatCost`**，勿在任一展示位另写 `$${...}`。
- **用量不落盘：会话累计金额从转录派生**（`cost-tracker.deriveCostStateFromTranscript`）。进程内 `addToTotalCostState` 每次累加都同时写 `modelUsage`，故恒有 `totalCostUSD ≡ Σ modelUsage.costUSD`；**恢复时不再读任何落盘计数器**，而是扫该会话自己的转录（`getTranscriptPathForSession(sid)`）+ `<sid>/subagents/**/*.jsonl`，把每条 assistant 记录的 `message.usage` 折进来重新计价。转录是既有权威记录、append-only，进程被杀/关窗口都不会丢——「恢复源被别的会话顶掉」「退出钩子没跑成整段丢账」这类问题从根上消失（2026-09-26 实测 ¥5.04 → ¥0.0x 即此）。三个必须做对的细节：**同一 `message.id` 在流式下会被写多条快照**，逐字段取最大才是终值（不去重会重复计，曾据此误判「转录求和会高估」）；**子代理转录与主转录无交集**（Explore/Plan 等），必须一并折入；**但 `agent-acompact-*.jsonl`（压缩代理）转录里含有主链消息的副本**（同 `uuid`+同 `message.id`+同 usage），所以三处必须折进**同一张 `byMessageId`** 做全局去重——按文件各自去重再相加会虚高约 1.84 倍。非派生项（API/tool 时长、行数）转录里没有，一律归 0。峰谷档按派生时刻判定（整段历史统一按当前时段计价，跨峰谷边界会有档位差，刻意保留的近似）。**金额口径 = 按会话**：厂商平台台账是**按账号**的，同日多会话并行时把眼前几个会话相加必然对不上台账，不是缺陷。
- **`restoreCostStateForSession` 是唯一恢复入口**：CLI 启动恢复与会话内 `/resume`（`REPL.tsx` 先 `resetCostState()` 再调它，须在 `switchSession` 之后——路径依赖 `sessionProjectDir`）都走它，没有第二条岔路。退出分析（`tengu_exit`）在 `costHook.ts` 的 exit 钩子里直接读进程内状态（`logSessionExitAnalytics`），不再有 `last*` 标量快照。

探针 `probes/probe-model-pricing.ts`：官网价目命中 / 峰谷判定 / 节假日日历 / 长度分档 / 目录兜底 / 未定价 / 覆盖 / 缓存 TTL / provider 会话别名落回，42 项断言（需联网，全程在临时配置根内跑）。`probes/probe-session-cost-restore.ts`：流式重复 `message.id` 去重 / 子代理转录折入 / 压缩代理副本跨文件全局去重 / 金额 = 逐模型求和 / 恢复写进 STATE / 无转录与无 assistant 记录的边界，14 项断言（离线，临时配置根 + 临时项目目录）。

## 排队消息催办 / 生成级断流（`query.ts` + `utils/messageQueueManager.ts`）

web 点击排队气泡 → 当前这次**生成流**就地收尾，排队消息由中链 drain 纳入**当前**回合（用户语义 → [web-ui.md](web-ui.md) §13）：

- **回合级 abort 不可用**：`toolUseContext.abortController.signal` 直传给 `callModel`，abort 会污染本轮后续所有迭代，且 abort 分支 `return { reason:'aborted_streaming' }` 直接结束回合。故催办走**生成级断流**：`messageQueueManager` 的 `queueNudgeRequested`（`requestQueueNudge / peekQueueNudge / consumeQueueNudge / clearQueueNudge`），**生命周期只限当前在飞回合**——两处失效：① `notifySubscribers()` 里「队列清空即失效」；② REPL 回合收尾 `finally`（`queryGuard.end()` 成立处）调 `clearQueueNudge()`。②覆盖「标记已置位但生成流在收口 `consumeQueueNudge` 前就收尾」的路径（用户打断 / 请求异常 / 提前 `return`，如 `query.ts` 的 `aborted_streaming` / `model_error` / `image_error` / `blocking_limit`），否则残留标记会在下一回合首个生成增量处误触发断流。`consumeQueueNudge` 一次性消费。
- **断流不变量**：生成流 `for await` 循环体首行 `if (isMainThread && toolUseBlocks.length === 0 && peekQueueNudge()) break`。`toolUseBlocks` 是**本迭代**数组且 tool_use 块只在 `content_block_stop` 才入数组/执行器 ⇒ 此处为 0 时断流不可能留下孤儿 `tool_use`、无需合成 `tool_result`（完全绕开工具链）。「工具一旦落定就不动它」由此门控天然成立。断流经 `claude.ts` 生成器 `finally` 释放 HTTP 流。
- **同轮续跑**：收口在 `if (!needsFollowUp)` 之前——`if (!needsFollowUp && consumeQueueNudge()) needsFollowUp = true`，走 follow-up 路径（零工具），下方既有中链 drain 把排队消息转成 `queued_command` 附件并 `removeFromQueue`，循环底部续跑下一迭代（复用「模型自然答完后排队消息被纳入」那条既有路径，不新造纳入机制）。
- **判活在外层**：REPL 侧 `bridge/gatewayQueueNudgeHandle.ts` 句柄只在「有在飞生成 + `getDrainableQueuedPrompt()` 非空」时置位。可催办对象判据与 drain 过滤同语义：`mode:'prompt'` ∧ 非斜杠 ∧ `agentId===undefined`。
- **运行程序缺口（= CLI Ctrl+B 落地点）**：断流门控 `toolUseBlocks.length === 0` 意味着**有前台任务（bash 命令 / 子代理）在跑时催办插不进去**（工具已落定，不打断）⇒ 点击气泡看着没反应。故 REPL 句柄在**判活通过后**（有在飞回合 + `getDrainableQueuedPrompt()` 非空）再判 `hasForegroundTasks(state)`：命中则 `backgroundAll(() => store.getState(), setAppState)`（`tasks/LocalShellTask/LocalShellTask.tsx`，与 `SessionBackgroundHint.tsx` 的 Ctrl+B `task:background` 同一函数）把前台任务**提升为后台任务**（进程保活、不 abort 回合），BashTool 随即以 `backgroundedByUser` 返回 ⇒ 模型继续思考 ⇒ 下一处迭代断流并入本条。无前台任务时该分支 no-op。
- **统一抽象**：催办 = 「让当前回合尽快走到下一个中链 drain 点，把排队消息并入本轮」——两个堵点（前台任务挡 drain、在飞生成未收尾）各有动作（`backgroundAll` / 置催办标记），都**不中断在飞请求、不改回合边界**。判活（有在飞回合 + 有可 drain 的用户消息）在前，动作在后。

## 工具循环熔断（`query.ts` + `utils/toolLoopBreaker.ts`）

模型复读死循环的引擎侧根治：

- **判据三维（任一触发即熔断）**：
  - ① 同名同参（tool 名 + `JSON.stringify(input)` 全等）**连续**调用达 `TOOL_LOOP_BREAKER_LIMIT`（=5）次。任何不同调用即重置（正常重试参数几乎总变，逐字重发连续 5 次不存在）。
  - ② **含簿记批连击**：连续 `TOOL_FAMILY_BATCH_LIMIT`（=10）轮每轮至少 1 个**簿记家族**调用（TaskCreate/TaskUpdate/TaskGet/TaskList/TodoWrite），任何实质工具出现即清零。病理 = 跨轮持续簿记不干活。**单批大批量突发不算多轮**——一次建 10-30 个任务是合法正常流；逐块各成一批时「建单+起步」的正常开工跨度须留余量，故阈值高于清单长度阶。
  - ③ **单轮簿记洪水**：单批内簿记调用达 `TOOL_FAMILY_FLOOD_LIMIT`（=40）次即熔断（第 40 个即拦）。
  - 纯状态机在 `utils/toolLoopBreaker.ts`（零依赖、探针直测）；批边界由调用方每批 `toolLoopBreakerBeginBatch` 划定，家族计数对任何非家族调用清零，与①的签名计数相互独立（①刻意跨批累计）。
- **落点**：`queryLoop` 跨迭代状态声明在 `while (true)` 之前；**每批 tool_use 执行前**（`runTools` 前）逐块喂入扫描。`streamingToolExecutor` 为 statsig 门控本构建恒关，不为死配置加分支。
- **触发行为**：达阈值块连同**本批后缀**全部不执行（`runTools` 只收 `allowedToolUseBlocks` 前缀）；后缀逐块合成 **error tool_result**（`is_error:true`，与 `yieldMissingToolResultBlocks` 同构——不变量「本批每个 tool_use 都有 result」，防下一轮请求孤儿 tool_use 400）；再 yield 一条用户可见的 assistant 错误消息（①维「⚠️ 工具循环熔断」/②③维「⚠️ 任务工具熔断…请立即停止创建/更新任务，直接用实际工具推进工作」）；`return { reason: 'tool_loop_breaker' }` **直接收口回合**，不回喂模型（复读态下回喂只会续读）。
- **已知取舍**：被熔断批次的 allowed 前缀已正常执行，其真实结果保留；排队消息与本熔断的交互不变（收口后 follow-up drain 照常）。
- 探针 `probes/probe-tool-loop-breaker.ts`：A 组真实状态机行为（阈值/重置/不可序列化 input）+ B 组 query.ts 结构断言。

## 会话间协作（`session_send` 工具 + `sessionMessage` / `sessionAddressing`，`SESSION_LINK`）

会话 A 的 agent 向会话 B 发消息，B 侧以**与用户消息完全同等形态**接收（空闲开新回合 / 忙则排队 / 离线自动拉起，可点气泡催办），气泡外带一行灰字标明来源。as-built 以本节 + gateway.md §13 为准；网关侧 → [gateway.md](gateway.md) §13；渲染 → [web-ui.md](web-ui.md) §24。

**寻址模型 = 目录寻址，无授权门**：可发会话目录（`GET /gateway/sessions`，读盘、含离线会话）内任何会话，唯一硬门是寻址本身——sid 精确 > 标题唯一，重名/未找到/自环/空一律拒绝。@ 提及为纯输入手势（插 chip），不产生任何授权状态。

| 件 | 职责 |
|---|---|
| `utils/sessionMessage.ts`（纯字符串） | 包装/解析：`wrapSessionMessage({sid,title}, body)` / `parseSessionMessage(text)`（不锚定，展示用） |
| `utils/sessionAddressing.ts`（**纯函数、零 import**） | `resolveSessionTarget(dir, to, selfSid)`：目录 → `{target, error}`；寻址即唯一硬门。`resolveSendMode({to,new_session,project})` → `existing`/`new`/`invalid`：两形态分岔的单一出口 |
| `tools/SessionSendTool/` | `session_send({to?, new_session?, project?, text})` 两形态（发给已有会话 / 拉起新会话）；`checkPermissions` 与 `call` 各重算一次现场（`resolveSessionTarget` 或 project 目录校验——两次调用间目录可能变化） |
| `utils/gatewayClient.ts` | `fetchSessionDirectory()`/`fetchDirectorySnapshot()`（`GET /gateway/sessions`，后者含可用项目 label）+ `sendSessionMessage()`/`createSessionAndSend()`（requestId 配对）+ 下行包装入队 + `queueItemsFromSnapshot` 拆包 |

**核心设计选择（都有根因，勿回退）**：

1. **来源走文本内嵌包装，不走新字段**。`<session-message from="会话：X" sid="…">正文</session-message>` 随消息本体落盘/回放/压缩天然携带，零传参链。**绝不能借用 `origin`/`isMeta`**——`isLoggableMessage`（`sessionStorage.ts`）对带这两个字段的 attachment 返回 false，消息刷新后直接消失。
2. **`sessionAddressing.ts` 必须保持纯函数、零 import**。**不得 import `gatewayClient.ts`**——后者顶层 `import { feature } from 'bun:bundle'` 是编译期宏，`bun` 直跑下不可解析，一旦引入 `probe-session-link.ts` 这类源码直跑探针就永久失效。输入（会话目录、本会话 sid）由调用方注入。
3. **寻址在 CLI 侧解析，网关只做纯 sid 路由**。`resolveSessionTarget` 规则唯一：sid 精确命中（`to` 恰为某会话 sid 又是另一会话标题时 **sid 键优先**）；无则标题唯一匹配；**重名/未找到/自环/空/复合令牌串「标题|sid」不代拆**（调用方须自行拆分）一律拒绝，不猜不兜底。与「寻址判定必须在转录所在侧」同源。
4. **撤门后唯一刹车 = 软约束**：「非必要不通信」（`@WrokSpace/.claude/CLAUDE.md` 通信约束节）+ 工具 `prompt.ts` 同款措辞；代码级硬边界只剩寻址层自环拒绝 + 网关拒自发自收。
5. **调用点 `UserPromptMessage.tsx` 就地解析包装**，不新增 props——一处覆盖 CLI 的开回合/排队/历史转录三条路径（都经 `createUserMessage` → `Message`）；同时把提及令牌 `[会话:标题|sid]` 显示为 `[标题]`（sid 不进终端），且**不对 `text` 做 replace**（发往 LLM 的仍是包装原文，模型可见来源）。来源灰字行**随其气泡一侧对齐**（右对齐）：外层 column Box 保持默认 stretch（否则内层气泡会被收成内容宽），只给来源行套 `<Box flexDirection="row" justifyContent="flex-end">` 行盒——web 侧同义改动在 `.msg.user .who`。
6. **来源标注由接收侧渲染，发送方只写正文**。工具说明显式禁止发送方自加来源前缀/抬头/签名（发送方读工具说明易自写来源，与对侧自动渲染的灰字行重复；链路本身正文原样投递、不强制剥离）。

**回环**：**不做代码级刹车**——靠「非必要不通信」软约束 + 工具 `prompt.ts` 同款措辞。硬边界 = 寻址自环拒绝 + 网关拒「自发自收」；实测出现 agent 对喷再补硬护栏（限频/审批）。

**新建会话形态**（`new_session: true` + `project`，2026-09-20）：除发给已有会话，`session_send` 还能**拉起一个全新会话**并把 `text` 当它首条消息（用于「要干净上下文的子任务」）。判定与 `to` 路径同源（`resolveSendMode` 是唯一出口）：`new_session` 与 `to` 互斥、`project` 必填且须在目录 `groups` 的 `scope==='project'` 项中真实存在（工具侧查目录前置校验——**不借**网关对未知 label 回退全局根的既有语义去猜项目），缺参/冲突一律拒并原样回报。投递走 `createSessionAndSend` → 网关 `session-create` 帧：先 `spawnWebSession(undefined, project, sid)`（复用 web 新建会话链，见 gateway.md §13）并**等 `/clients` 注册完成**再投递，成功回执携带新会话 sid（后续可用 sid 寻址）；创建/注册失败如实回执原因——**不做「先乐观回 sid、超时再静默丢消息」**（那是 `POST /gateway/wsession` 对 web 的语义，对工具调用即撒谎）。新会话标题自动取「<发起会话标题>拉起的会话」，走与 `/gateway/session/rename` 同一条 `applySessionTitle`（落盘 + 在线 CLI 内存同步**成对**，只落盘会被 CLI 退出时的 re-append 覆盖回去）。CLI 侧回执超时 25s（> 网关注册超时 20s，保证失败原因先到）。

**验证**：`probes/probe-session-link.ts` **62 过 / 0 败**（A 包装往返 / D 寻址含 D7 sid 键优先与 D10 复合令牌不代拆 / F web 接线 / G CLI 接线+工具说明+G7 撤门钉（标识符级防 sessionExposure 残留回潮）/ H 来源行对齐 / I 新建会话形态（`resolveSendMode` 真值测 + 工具/网关/说明接线钉））。

## 跨会话文件修改归因与 AI 并发写协作

两会话（=两进程，内存不互通）或「CLI × web 编辑卡」并发编辑同一文件时，后写方命中的 modified-since-read 门原只报「被用户/linter 改过」，报不出**谁**改的——根因 `readFileState` 是每进程私有内存，跨进程归因唯一通道是磁盘。

**归因注册表（`utils/fileModifierRegistry.ts`）**

| 件 | 职责 |
|---|---|
| `recordFileModifier(path, {projectRoot?, writer?, sid?})` | 写入侧：`appendFileSync` 追加 `{p,w,sid,ts}` 行到 `<项目根>/.claude/file-mods.jsonl`——追加无读改写竞争，坏行容忍，超 1MB 压缩保尾 1000 行，全程容错不抛。`writer:'web'` 的 sid 缺省为 `''`（**绝不回落网关进程 sid**）；CLI 缺省 `writer:'session'` + `getSessionId()`。`projectRoot` 缺省 `getProjectRoot()`，网关调用必须显式传入（否则按网关进程 cwd 解析，写错项目根） |
| `findFileModifier(path, sinceTs, {projectRoot?})` | 拦截侧：逆序找最新 `ts > sinceTs` 条目；`w:'web'` → `'web'`；CLI 条目命中的 sid 与本会话相同则跳过（自家写会刷新自家 readFileState）；旧格式无 `w` 行按 CLI 条目处理 |
| `describeFileModifier(id?)` | `undefined` → `'another process'`；`'web'` → `'the web editor'`；否则 `'session <sid>'` |

- **记录挂点**：FileEditTool / FileWriteTool / NotebookEditTool 各自 `readFileState.set` 之后 + BashTool sed 模拟写路径之后 + 网关 `writeProjectFile` **写盘成功后**（403/404/409/写入失败不入册）。
- **边界**：Bash 原生写不经工具链不可归因；注册表按项目根隔离，跨项目撞车查不到回落原文。

**并发写协作（AI 工具链）**

目标：AI 的写从「文件被动过就整条失败」改为「应用意图」——改的是别处就顺势落地并告知，真重叠才失败且能说清谁改的。

| 件 | 职责 |
|---|---|
| `utils/threeWayMerge.ts` | 合并引擎唯一真源（CLI 与 web bundle 共用同一份 TS，见下「web 注入」）。patience diff（唯一行锚点 + LIS）+ 整段替换兜底；`WK_MERGE_MAX_LINES = 20000`；冲突返回 `{ok:false, reason:'conflict', conflictLine /* 1-based */, remoteChanges}`，超限 `reason:'too-large'`。`wkLineDelta(base,result)` 给增删行数 |
| `utils/concurrentWrite.ts` | 策略层。`normalizeForCompare`（去 BOM + CRLF→LF + 去末尾换行）使**末尾换行 / BOM / CRLF 差异永不算并发修改**；`isCompleteReadSnapshot` 只接受 `source ∈ {read,tool-write,seed}` 且 `!isPartialView && !truncated`、无 `limit`、`offset` 为 undefined/0/1；`mergeTextWithPolicy` 仅 UTF-8 走合并（UTF-16 等只允许 replay）；错误/成功文案统一在此 |

- **`FileState` 完整快照标记**：`FileState` 增 `source`（`read` / `tool-write` / `notebook` / `attachment` / `seed`）与 `truncated`。FileReadTool 文本读 `source:'read'` + 从 `readFileInRange` 取 `truncatedByBytes` 写入 `truncated`（此前被静默丢弃）；notebook 读/NotebookEditTool `source:'notebook'`；Edit/Write 写后 `source:'tool-write'`；attachments 两处 memory 注入 `source:'attachment'`；`cli/print.ts` seed `source:'seed'`。局部读、截断读、notebook、attachment 一律不作合并 base。
- **Write（`FileWriteTool`）**：validateInput 只要求「必须先 Read」，mtime 判死移除；call 内读当前盘 → 与快照比对 → 一致直接写；不一致则要求完整快照并三方合并（base=`readFileState.content`，local=模型全文，remote=磁盘），无基准则报 `no merge base` 不猜不写。EOL/BOM 按模型内容还原（模型给 CRLF 就整篇 CRLF，给 BOM 就带 BOM）。
- **Edit（`FileEditTool`）**：validateInput 在磁盘已变时放行（跳过 old_string 未命中/多重命中的前置判定，交 call 处理）。call 三段：
  1. **意图重放**：`old_string` 在当前盘上命中且唯一（`replace_all` 时磁盘命中数必须等于 base 命中数）→ 直接替换；文案 `replayed (N replacement(s))`；
  2. **三方合并**：replay 不成立且快照完整 → 把意图应用在 base 上得到 local，再与磁盘合并；结果按磁盘 BOM/EOL 还原（BOM 取磁盘，EOL 走 `writeTextContent(..., endings)`）；
  3. **冲突**：重叠或超限 → 只回工具错误，含归属（`the web editor` / `session <sid>` / `another process`）、重叠行号、远端增删行数；**不写盘**。
- **settings 文件**：合并/replay 的最终内容仍过 `validateInputForSettingsFileEdit`，非法即失败不写盘。
- **web 注入**：合并引擎不再有 web 副本（原 `web-src/sidebar/work/work-merge.js` 已删）。`scripts/bundle-web-modules.ts` 以 `TS_PIECES` 占位件读 `src/utils/threeWayMerge.ts` → `Bun.Transpiler` 转译 → 去 `export ` → 首行注入 `/* @module __ts_three_way_merge__ */` marker，满足 `slicePieces`「marker 恰命中 1 次」契约。

**残余竞态（明确边界，非已解决）**：合并只消除本进程的异步交错；「读盘 → 合并 → 写盘」之间不插 `await`，但仍**不能**阻止 web 网关、外部编辑器或另一 CLI 在该亚毫秒窗口内写入，最后写者仍可能覆盖对方。恢复靠写前 `fileHistoryTrackEdit` 备份。不引入文件锁/CAS：Windows 无原生 CAS，外部编辑器不参与锁协议，锁只覆盖 Floria 自家进程，收益不抵失效锁/审批延迟。

**验证**：`probes/probe-three-way-merge.ts` **12 过 / 0 败**；`probes/probe-concurrent-write.ts` **23 过 / 0 败**；`probes/probe-file-modifier-registry.ts` **11 过 / 0 败**（含旧行兼容、本会话跳过、web 不跳过、自定义 projectRoot）；`bun scripts/bundle-web-modules.ts` 自检通过。

## 工具搜索可用性（`utils/toolSearch.ts`）

工具搜索（defer_loading）把 MCP/可延迟工具的 schema 从首轮 prompt 里挪走、改由模型调 `ToolSearchTool` 按需取回，回结果里的 `tool_reference` 块是 Anthropic 私有 beta 内容类型。**这不是模型名字的属性，而是供应商 shim 的属性**——同一家 Zhipu 的 glm-5.3-flash 容忍裸 `tool_reference`，glm-4.7 / glm-4.5-air 直接 `400 invalid_request_error code 1210`。上游用一张静态名字黑名单（`DEFAULT_UNSUPPORTED_MODEL_PATTERNS`，只有 `haiku`）来挡，于是每个新发布的 3P 模型都天然踩坑、直到有人报障改代码。

| 件 | 职责 |
|---|---|
| `modelSupportsToolReference(model)` | 同步入口。先读学习缓存，其次静态名字黑名单，未知模型默认**支持**（负向测试） |
| `probeToolReferenceSupport(model)` | 异步探测，按小写模型名缓存；同模型并发只发一次（in-flight 去重） |
| `isToolSearchEnabled(...)` | 组合门：静态名单否 → 关；名单放行但**确有可延迟工具**时才 `await` 探测 |

- **探测形状**=最小复刻 ToolSearchTool 的产物：一条 assistant `tool_use` 配一条 `tool_result`，content 为裸 `[{type:'tool_reference'}]`。**不要往 content 里加 `text`/改用消息级 sibling**——那是另一种线形，测不出 ToolSearchTool 真正会发的东西（加了 text 后 Zhipu 反而 200，探测会假报支持）。
- **只打 3P 池端点**。`findModelProvider(model)` 落空（firstParty / Bedrock / Vertex）即返回支持、不发请求——第一方 API 是参考实现。
- **fail-open**：429 / 5xx / 网络 / 超时（8s）/ 凭据读不到，一律判「支持」。只有明确的 `400` 才判不支持，避免抖动端点静默丢掉动态工具加载。
- **不为没有可延迟工具的会话花钱**：`tools.some(isDeferredTool)` 为假时根本不探测（`getToolSearchMode()==='standard'` 同理早退）。
- **老会话自愈**：探测结果进 `messagesForAPI` 构建前（`claude.ts` 的 `useToolSearch` 与本请求同拍），`useToolSearch=false` 分支照旧剥掉历史里的 `tool_reference`（`stripToolReferenceBlocksFromUserMessage`）与 `caller` 字段——与 haiku 今天走的是同一条既存路径，不复刻。

**门控分两层，别把第二层当成缺口**：

| 层 | 件 | 性质 |
|---|---|---|
| 进程内工具池 | `tools.ts` `getTools()` 里的 `isToolSearchEnabledOptimistic()`、`ToolSearchTool.isEnabled()` | **同步、只看 mode/env，不认识模型**——判不支持的模型在这一层仍会看到 ToolSearchTool |
| 请求线上 | `claude.ts` 按 `useToolSearch` 过滤后 `filteredTools` 才进 `toolToAPISchema` | **唯一决定模型看到什么的地方**；`useToolSearch=false` 时 `filteredTools` 直接剥掉 ToolSearchTool |

`useToolSearch` 由 `await isToolSearchEnabled(...)` 得出（含上表探测结果），故模型在线上根本看不到 ToolSearchTool、也无从调用；`toolExecution.ts` 那句「先用 ToolSearchTool 装载」的提示只在有延迟工具时才可能触发。系统提示里也不含工具搜索文案（`ToolSearchTool/prompt.ts` 只在工具本体进 `filteredTools` 时才随 schema 上线）。**因此不需要给 `isEnabled()` 补模型感知**——那是与线上过滤重复的第二道守卫。

**验证**：`probes/probe-toolref-autodetect.ts` **16 过 / 0 败**（A 静态名单与非池模型 / B 真端点判定 glm-4.7·glm-4.5-air 拒、glm-5.3-flash 429 fail-open / C 同步入口读同一缓存 / D 幂等 / E 组合门含 haiku 短路与「无可延迟工具零耗时」）。纯 CLI 层，无 web 改动不 bump sw。

## 会话边界标记与 resume 时间跨度注入（`utils/sessionBoundary.ts`）

会话 jsonl 记录消息但**不带进程起止痕迹**，且模型收到的 API 消息里时间戳一律被剥掉（`userMessageToMessageParam`/`assistantMessageToMessageParam` 只发 `{role,content}`）——一个休眠数天的会话 resume 后，模型读旧转录如同仍是当下，会按已过时的前提「惊慌失措」地办事。修法=写盘留痕 + resume 时注入模型可见提示，两件事缺一不可（元数据条目**不会**成为模型消息）。

| 件 | 职责 |
|---|---|
| `types/logs.ts` `SessionBoundaryEntry` | 新条目类型 `{type:'session-boundary', sessionId, event:'start'\|'end', timestamp, reason}`，并入 `Entry` 联合；**不参与 parentUuid 链、不是模型消息**（`loadTranscriptFile` 的 else-if 链静默忽略未知类型），不影响 `--resume` 列表的 firstPrompt/messageCount |
| `utils/sessionBoundary.ts` | 纯逻辑（无 I/O，可探针直跑）：`formatGap` / `parseLastSessionBoundaryFromTail` / `buildSessionBoundaryEntry` / `buildSessionContinuityNote` |
| `utils/sessionStorage.ts` | 写：`Project.recordSessionBoundary(event,reason)` 走 `appendEntryToFile`（与本就被清理路径调用的 `reAppendSessionMetadata` 同机制）——`materializeSessionFile()` 写 `start/new`、`adoptResumedSessionFile()` 写 `start/resume`、`getProject()` 的 `registerCleanup` 回调（`gracefulShutdown`→`runCleanupFunctions` 触发，覆盖 SIGINT/SIGTERM/SIGHUP/自然退出）写 `end/graceful`；读：导出 `readLastSessionBoundary(filePath)` 取 64KB 尾部 `findLast` 行首 `{"type":"session-boundary"` 行 |
| `utils/conversationRecovery.ts` | `loadConversationForResume()`（**全部** resume 入口——交互 CLI / print·SDK / web 独立会话——的汇合点）在反序列化后取源 messages 末条 `timestamp` 作 `lastActivityTs`，`buildSessionContinuityNote` 产 `<session-continuity>` 提示，`createUserMessage({isMeta:true})` 后 **`unshift` 到头部**注入 |

**不变量**：
- **判异常终止靠「无 end」**：崩溃/被杀/断电时 `registerCleanup` 根本不跑 ⇒ 尾部只有 `start` 无 `end` 即天然判据，无需额外簿记；`end` 恒为退出前最后写入 ⇒ 必落在 tail 窗口内，正常/异常判定可靠。`start` 可能被长会话挤出窗口 ⇒ 降级为「无记录」，不影响判据（间隔主要靠末条消息 timestamp 算）。
- **注入必在头部而非尾部**：`detectTurnInterruption` 遇末条 `isMeta` 直接返回 `none`，若注入尾部会掩盖真实中断检测。
- **措辞随间隔自适应、总是注入**（`lastActivityTs` 拿不到时不注入——宁缺毋滥）：分钟级「间隔短，上文仍可能有效」/ 小时级「可能已变，先核实」/ 天级「勿假设旧上下文仍成立，先核实现场」。上次无 `end` 记录时显式声明异常终止。
- **UI 隐藏**：`isMeta:true` 走既有「Continue from where you left off.」同机制，前端不渲染，无需 web 改动、不 bump sw。

**验证**：`probes/probe-session-boundary.ts` **19 过 / 0 败**（tail 解析含空/无边界/start-only/start+end/消息体内嵌同名字面量不误配/尾部混杂；`formatGap` 秒·分·时·天级；note 的 null 短路与四级措辞 + graceful/NOT-recorded/unknown 三分支）。纯 CLI 层。

## 非全屏渲染与 scrollback 不变量（`utils/renderCap.ts` + `ink/log-update.ts`）

构建期 `USER_TYPE` 常量折叠为 `'external'` ⇒ `isFullscreenEnvEnabled()` 恒 false ⇒ 消息列表是**普通动态 Ink 内容**、靠终端原生 scrollback（非 alt-screen）。此模式下已滚出视口的行（`y < viewportY`）物理不可改写，Ink 检测到这些行变化时**只能 `fullReset`**（`\x1b[2J\x1b[3J\x1b[H`＝清屏 + **清 scrollback** + 光标归零，`FlickerReason='offscreen'`）——终端因此把视口拉回顶部。**不变量：进入渲染投影的顶部内容在追加时不得变化**；违反即每条追加触发一次全屏重置（用户表现为「滚动浏览历史时概率性跳到最顶部」）。渲染历史上限（[web-ui.md](web-ui.md) §10 P1）的窗口边界因此必须用锚点 + 步长量化，而非按条数滑动。复验锚点 `probes/probe-render-cap-flicker.ts`（`render({onFrame})` 收 `FrameEvent.flickers`：纯追加 0 次、顶部滑动每帧命中、计数滑动 260 帧 60 次 → 锚点量化 1 次）。
