/**
 * Credential pool types for multi-provider, multi-key, multi-model support.
 *
 * Each provider config (Anthropic, DeepSeek, Kimi, GLM, etc.) stores its own:
 * - base URL (endpoint root; see `protocol`)
 * - Wire protocol (default 'anthropic'; 'openai-chat' = Chat Completions adapter)
 * - Pool of API keys with exhaustion tracking
 * - List of available models
 * - Active selections (which key, which model)
 *
 * All providers in this pool share the Anthropic SDK client path
 * (new Anthropic({apiKey, baseURL, ...})); a provider whose `protocol` is not
 * 'anthropic' has the SDK's fetch overridden with a translating adapter
 * (services/api/protocol-fetch.ts). Bedrock/Vertex/Foundry use separate SDKs
 * and are excluded from this pool.
 */

export interface ApiKeyEntry {
  /** The actual API key string */
  value: string
  /** Whether this key is marked as exhausted (e.g., rate-limited) */
  exhausted: boolean
  /** Timestamp when exhausted, for auto-recovery */
  exhaustedAt?: number
}

export interface ProviderConfig {
  /**
   * Endpoint root for this provider. For the default `'anthropic'` protocol this
   * is an Anthropic-compatible base URL (e.g. https://api.deepseek.com/anthropic);
   * for `'openai-chat'` it is the OpenAI Chat Completions base
   * (e.g. https://generativelanguage.googleapis.com/v1beta/openai).
   */
  baseUrl: string
  /**
   * Wire protocol this provider's endpoint speaks (2026-10-03). `undefined`
   * defaults to `'anthropic'` (Anthropic Messages API via the SDK, the
   * historical single-protocol exit). `'openai-chat'` routes requests through
   * the OpenAI Chat Completions fetch adapter
   * (services/api/openai-chat-fetch-adapter.ts) instead. Declaring the protocol
   * takes over completely: there is NO runtime auto-detection — the judgment is
   * written here once and read-only at runtime. Mirrors the capabilities/
   * effortLevels per-provider declaration convention. Takes effect on session
   * restart.
   */
  protocol?: string
  /** Pool of API keys for this provider */
  keys: ApiKeyEntry[]
  /** Index into keys[] of the currently active key */
  activeKeyIndex: number
  /** Available model names for this provider */
  models: string[]
  /** Currently selected model name */
  activeModel: string
  /**
   * Per-model explicit vision capability override.
   * `undefined` for a model = not set → fall back to name-pattern detection.
   * Absent entirely (old credentials.json) = same as empty.
   */
  modelVision?: Record<string, boolean>
  /**
   * Model capabilities this provider's endpoint actually accepts, consumed by
   * get3PModelCapabilityOverride (modelSupportOverrides.ts): 'effort' |
   * 'max_effort' | 'thinking' | 'adaptive_thinking' | 'interleaved_thinking'.
   * Declaring the array takes over completely for this provider (a capability
   * absent from the list = explicitly unsupported); absent entirely = fall
   * back to upstream env/name heuristics. Takes effect on session restart.
   */
  capabilities?: string[]
  /**
   * Official thinking/effort levels this provider's models expose, declared
   * per the vendor docs (2026-09-18). Consumed by getPoolModelEffortLevels
   * (engine Off→thinking-disabled branch) and broadcast per-item via
   * GET /gateway/models so the web effort menu renders from the vendor's
   * actual level list instead of the hardcoded default. Values: 'off' | 'low'
   * | 'medium' | 'high' | 'max'. Absent = web falls back to Off/Low/High/Max.
   */
  effortLevels?: string[]
  /**
   * Per-model image-generation capabilities (2026-10-11). Declared by hand in
   * credentials.json, read-only at runtime — the provider-neutral 生图能力层
   * (services/imagegen/) uses `outputImage` as its single dispatch predicate,
   * and `inputImage`/`imageEdit`/`multiTurnImage` as capability dimensions
   * (kept separate from `modelVision`, which is the input-side vision gate).
   * Absent entirely (old credentials.json) = features off → text path unchanged.
   */
  imageCapabilities?: Record<
    string,
    {
      /** 能吃图（图片作为输入） */
      inputImage?: boolean
      /** 能出图 —— 请求是否交给生图能力层的唯一判据 */
      outputImage?: boolean
      /** 能改图（带图编辑） */
      imageEdit?: boolean
      /** 支持多轮带图编辑（本版不启用自动回灌，仅作声明维度保留） */
      multiTurnImage?: boolean
    }
  >
  /**
   * 主模型编排生图时选用的生图模型 id（2026-10-11）。文本模型会话经
   * `ImageGeneration` 工具生图时用它；须同时在该 provider 的 `imageCapabilities`
   * 里声明且 `outputImage: true`。缺省 = `ImageGeneration` 工具对该 provider 关闭
   * （直连链不受影响：直连用会话模型本身做生图模型）。
   */
  imageModel?: string
}

/**
 * 一个模型-backed 工具能力的绑定（2026-10-11）——用哪个 provider 的哪个模型。
 * 凭据池 `tools.<能力名>` 模块的条目；能力名如 `'image'`（生图归档化）。
 */
export interface ToolBinding {
  /** credentials.json.providers 的键名。 */
  provider: string
  /** 该能力使用的模型 id；缺省 = 该 provider 的 imageModel（image 能力）。 */
  model?: string
}

export interface CredentialsFile {
  /** Name of the currently active provider */
  activeProvider: string
  /** All configured providers, keyed by name */
  providers: Record<string, ProviderConfig>
  /**
   * 按能力分槽的工具绑定（2026-10-11，取代旧的单字段 `imageProvider`）。键 = 能力名
   * （当前只 `'image'`），值 = 该能力的 provider / model 绑定。**回落目标**：本会话
   * provider 自身不能服务该能力时，对应工具改用绑定的 provider 的端点 / 钥匙 / 模型。
   * 缺省 = 无回落（工具仅在会话 provider 自带能力时出现）。
   */
  tools?: Record<string, ToolBinding>
  /**
   * WebSearch tool backend configuration (global pool section).
   * `undefined` = never configured → tool hidden unless a default applies.
   */
  webSearch?: WebSearchCredentials
  /**
   * WebFetch tool backend configuration. `undefined` = local HTTP + Turndown.
   */
  webFetch?: WebFetchCredentials
  /**
   * 模型定价覆盖（见 utils/modelPricing.ts）。全部字段可选，缺省即走
   * 「厂商官网价目 → models.dev 目录」自动链路。
   */
  pricing?: PricingConfig
}

/**
 * 模型定价覆盖。单价一律按**人民币 / 百万 token**、官方账单口径填写
 * （与厂商价目页同单位），内部按实时汇率折算成计价单位。
 */
export interface PricingConfig {
  /** USD→CNY 汇率覆盖；缺省 = 自动拉取（open.er-api.com） */
  usdCnyRate?: number
  /** 法定节假日（`YYYY-MM-DD`，北京时间），当天全天按空闲时段计 */
  holidays?: string[]
  /** 高峰时段 `[起, 止)`（北京时间整点小时）；缺省 [[9,12],[14,18]] */
  peakWindows?: number[][]
  /** 按 provider 名指定 models.dev 目录 id（如 `{ "glm": { "source": "zhipuai" } }`） */
  providers?: Record<string, { source?: string }>
  /** 按模型名覆盖单价（人民币 / 百万 token） */
  models?: Record<
    string,
    {
      input: number
      output: number
      cacheRead?: number
      cacheWrite?: number
    }
  >
}

/**
 * Configuration for the local multi-backend WebSearch tool (port of Hermes'
 * web_tools provider architecture). Lives in the same credentials.json as the
 * LLM provider pool — one global source of truth for API keys.
 */
export interface WebSearchCredentials {
  /** Explicit backend selection (searxng | brave | tavily | exa | deepseek); autodetect when unset. */
  backend?: string
  /** Self-hosted SearXNG instance base URL (enables the searxng backend). */
  searxngUrl?: string
  /** Vendor API keys, keyed by backend name (brave | tavily | exa | deepseek). */
  keys?: Record<string, string>
  /**
   * DeepSeek Search/Fetch API base (default `https://api.deepseek.com/v1/tools`,
   * or the origin of the deepseek provider baseUrl + `/v1/tools`).
   */
  deepseekBaseUrl?: string
}

/**
 * WebFetch backend selection. `http` (default) fetches locally and converts HTML
 * with Turndown; `deepseek` calls the DeepSeek Fetch API and returns its Markdown
 * directly. The backend is strict — a failure surfaces, never silently reroutes.
 */
export interface WebFetchCredentials {
  backend?: 'http' | 'deepseek'
  /** DeepSeek tools base override; defaults to the same resolution as search. */
  deepseekBaseUrl?: string
}
