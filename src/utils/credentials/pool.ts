/**
 * Credential pool — multi-provider, multi-key, multi-model management.
 *
 * Provides the runtime API for all credential operations:
 * - Reading/writing the credentials.json file
 * - Getting the active API key, base URL, model
 * - Switching provider, key, model
 * - Key rotation and exhaustion tracking
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { safeParseJSON } from '../json.js'
import { logForDebugging } from '../debug.js'
import type {
  ApiKeyEntry,
  CredentialsFile,
  PricingConfig,
  ProviderConfig,
  ToolBinding,
  WebFetchCredentials,
  WebSearchCredentials,
} from './types.js'

const CREDENTIALS_FILENAME = 'credentials.json'

/**
 * 401 停用钥匙的冷却期。exhausted 钥匙冷却期满自动可重试（自愈）——401 可能是上游
 * 临时故障或误标（跨商错配已于 2026-09-18 在 client.ts 根修为钥匙端点同源，但上游
 * 抖动无法排除）；永久停用无恢复路径且 /key 命令已移除（2026-08-29）⇒ 供应商永久
 * 不可用（实证：glm 唯一钥匙 14:54 被误标，13 分钟后仍在报登录失败）。ApiKeyEntry
 * exhaustedAt 本就注释「for auto-recovery」，此处实际接线。
 */
const KEY_EXHAUSTED_COOLDOWN_MS = 10 * 60 * 1000

/** 钥匙可用 = 未停用，或已停用但冷却期满（自动恢复）。 */
function _isKeyUsable(entry: ApiKeyEntry | undefined, now: number = Date.now()): boolean {
  if (!entry) return false
  if (!entry.exhausted) return true
  return now - (entry.exhaustedAt ?? 0) >= KEY_EXHAUSTED_COOLDOWN_MS
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function _getCredentialsPath(): string {
  return join(getClaudeConfigHomeDir(), CREDENTIALS_FILENAME)
}

function createDefaultCredentials(): CredentialsFile {
  return {
    activeProvider: '',
    providers: {},
  }
}

const CREDENTIALS_ENCODING = 'utf-8' as const

function writeCredentials(creds: CredentialsFile): void {
  const path = _getCredentialsPath()
  const dir = getClaudeConfigHomeDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(path, JSON.stringify(creds, null, 2), CREDENTIALS_ENCODING)
  // safeParseJSON memoizes by content string and loadCredentials hands back a
  // reference into the cached object (mutation-through-reference is relied upon
  // by callers like /key reset). If a write reverts the file to content that was
  // cached earlier, the next read returns the stale mutated object — e.g. setting
  // then clearing /key vision reverts credentials.json to the original bytes, so
  // the override silently persists in memory. Writes are rare and the file is
  // small, so invalidating the parse cache after each write is correct & cheap.
  safeParseJSON.cache.clear()
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load credentials from disk. Returns default (empty) if file doesn't exist.
 */
export function loadCredentials(): CredentialsFile {
  const path = _getCredentialsPath()
  if (!existsSync(path)) {
    return createDefaultCredentials()
  }
  try {
    const raw = readFileSync(path, CREDENTIALS_ENCODING)
    const parsed = safeParseJSON(raw)
    if (!parsed || typeof parsed !== 'object') {
      return createDefaultCredentials()
    }
    const data = parsed as Record<string, unknown>
    const creds: CredentialsFile = {
      activeProvider: typeof data.activeProvider === 'string' ? data.activeProvider : '',
      providers: (typeof data.providers === 'object' && data.providers !== null
        ? data.providers
        : {}) as Record<string, ProviderConfig>,
    }
    // Carry the WebSearch tool section through: load→save round-trips (key
    // rotation, /key ops) rewrite the whole file, so an unparsed section would
    // be silently wiped on the next write.
    if (typeof data.webSearch === 'object' && data.webSearch !== null) {
      creds.webSearch = data.webSearch as WebSearchCredentials
    }
    if (typeof data.webFetch === 'object' && data.webFetch !== null) {
      creds.webFetch = data.webFetch as WebFetchCredentials
    }
    // 同理由：定价覆盖段必须原样带走，否则 /key 轮换会清掉用户的价格覆盖
    if (typeof data.pricing === 'object' && data.pricing !== null) {
      creds.pricing = data.pricing as PricingConfig
    }
    // 同理由：按能力分槽的工具绑定（tools.image 等）必须原样带走，否则 /key 轮换
    // 会清掉回落配置（这是任何 load→save 白名单外字段都会蒸发的既有纪律）
    if (typeof data.tools === 'object' && data.tools !== null) {
      creds.tools = data.tools as Record<string, ToolBinding>
    }
    return creds
  } catch {
    return createDefaultCredentials()
  }
}

/**
 * Save credentials to disk.
 */
export function saveCredentials(creds: CredentialsFile): void {
  writeCredentials(creds)
}

// ── 会话级供应商绑定（2026-09-10）────────────────────────────────────────────
// 一个 CLI 进程 = 一个会话，请求凭据（baseUrl / apiKey / 默认模型）必须由本进程
// 自己决定：全局 activeProvider / activeModel 的任何写入——2026-10-11 起已无写入者
// （全局默认只由直接编辑 credentials.json 决定）——都不得漂移已运行会话的供应商。否则会出现
// 「模型名属于 A、endpoint/key 属于 B」的 400（2026-09-10 实测：
// 新会话界面切 deepseek → 全局池被改写 → 两个在跑的 GLM 会话拿 glm-5.3-flash
// 打 api.deepseek.com/anthropic 全数 400）。
//
// 解析顺序（不变量：本进程请求凭据只随本进程状态变化）：
//   1. 显式 override —— 网关按会话路由 {type:'model', provider} 时设置（跨供应商切换）
//   2. 进程启动快照 —— 首次解析时的 activeProvider + 该商 activeModel
//   3. 池文件现值 —— 快照缺失 / 绑定供应商已被删除时
let _sessionProviderOverride: string | null = null
let _bootSnapshotTaken = false
let _bootProviderSnapshot: string | null = null
let _bootModelSnapshot: string | null = null

// 2026-09-18 切换同拍化：web 路由的供应商绑定先挂起，回合边界 applyPendingSessionProvider
// 与模型名快照成对落地（同拍原语见 bootstrap/state.ts setPendingSessionModelOverride）。
let _pendingSessionProvider: string | null | undefined

/** 网关按会话路由模型切换时调用；null 清除（回落启动快照）。立即写取消挂起值。 */
export function setSessionProviderOverride(name: string | null): void {
  _sessionProviderOverride = name && name.trim() ? name.trim() : null
  _pendingSessionProvider = undefined
}

export function setPendingSessionProvider(name: string | null): void {
  _pendingSessionProvider = name
}

export function applyPendingSessionProvider(): void {
  if (_pendingSessionProvider === undefined) return
  const name = _pendingSessionProvider
  _pendingSessionProvider = undefined
  setSessionProviderOverride(name)
}

/** 本进程当前绑定的供应商名（会话有效），见 _resolveSessionProvider。 */
export function getSessionProviderName(): string {
  return _resolveSessionProvider(loadCredentials()).name
}

function _takeBootSnapshot(creds: CredentialsFile): void {
  if (_bootSnapshotTaken) return
  _bootSnapshotTaken = true
  const cfg = creds.activeProvider ? creds.providers[creds.activeProvider] : undefined
  _bootProviderSnapshot = cfg ? creds.activeProvider : null
  _bootModelSnapshot = cfg?.activeModel ?? null
}

function _resolveSessionProvider(creds: CredentialsFile): {
  name: string
  cfg: ProviderConfig | null
  explicit: boolean
} {
  _takeBootSnapshot(creds)
  if (_sessionProviderOverride && creds.providers[_sessionProviderOverride]) {
    return { name: _sessionProviderOverride, cfg: creds.providers[_sessionProviderOverride], explicit: true }
  }
  if (_bootProviderSnapshot && creds.providers[_bootProviderSnapshot]) {
    return { name: _bootProviderSnapshot, cfg: creds.providers[_bootProviderSnapshot], explicit: false }
  }
  const name = creds.activeProvider
  return { name, cfg: name ? (creds.providers[name] ?? null) : null, explicit: false }
}

/**
 * Get the config of this session's bound provider (request chain: baseUrl / keys).
 * Returns null if no provider is active or configured.
 */
export function getActiveProviderConfig(): ProviderConfig | null {
  return _resolveSessionProvider(loadCredentials()).cfg
}

/**
 * Get the config of the pool's current activeProvider, ignoring this process's
 * session binding. Management views only (gateway /gateway/models display).
 */
export function getGlobalActiveProviderConfig(): ProviderConfig | null {
  const creds = loadCredentials()
  if (!creds.activeProvider || !creds.providers[creds.activeProvider]) {
    return null
  }
  return creds.providers[creds.activeProvider]
}

/**
 * Get the active API key from the credential pool.
 * Returns null if none available.
 */
export function getActiveApiKey(): string | null {
  const config = getActiveProviderConfig()
  if (!config) return null
  const entry = config.keys[config.activeKeyIndex]
  if (!_isKeyUsable(entry)) return null
  return entry.value
}

/**
 * Get the base URL for the currently active provider.
 * Returns null if no provider is configured.
 */
export function getActiveBaseUrl(): string | null {
  const config = getActiveProviderConfig()
  return config?.baseUrl ?? null
}

/**
 * Wire protocol this session's bound provider speaks. `'anthropic'` (default)
 * = Anthropic Messages API straight through the SDK; `'openai-chat'` = route
 * through the OpenAI Chat Completions fetch adapter. Session-bound like
 * baseUrl/apiKey (same invariant, see _resolveSessionProvider above) — the
 * protocol is a request-credential property and must not drift across sessions.
 */
export function getActiveProviderProtocol(): string {
  return getActiveProviderConfig()?.protocol ?? 'anthropic'
}

/**
 * Per-model image-generation capabilities of this session's bound provider
 * (2026-10-11). Session-bound like protocol/baseUrl/apiKey (same invariant) —
 * the 生图能力层 dispatch is credential-adjacent and must not drift across
 * sessions. Returns null when the provider declares none (features off).
 */
export function getActiveProviderImageCapabilities(): ProviderConfig['imageCapabilities'] {
  return getActiveProviderConfig()?.imageCapabilities ?? null
}

/**
 * This provider's designated image-generation model for main-model orchestration
 * (2026-10-11) — consumed by the `ImageGeneration` tool. Session-bound like the
 * capabilities accessor above (same invariant). Returns null when unset
 * (tool disabled for this provider; the direct dispatch path is unaffected).
 */
export function getActiveProviderImageModel(): string | null {
  return getActiveProviderConfig()?.imageModel ?? null
}

/**
 * 某工具能力绑定的 provider（2026-10-11，`tools.<toolName>`）——**全局**、不随会话
 * 绑定漂移。文本会话 provider 自身不能服务该能力时，对应工具回落到它（取它的端点 /
 * 钥匙 / 模型）。返回 `null` = 未绑定、或绑定的 provider 名不存在（回落失败 ⇒ 工具
 * 保持关闭，**不静默改用别的 provider**）。
 */
export function getToolProviderConfig(
  toolName: string,
): { name: string; model?: string; config: ProviderConfig } | null {
  const creds = loadCredentials()
  const binding = creds.tools?.[toolName]
  if (!binding || typeof binding.provider !== 'string' || !binding.provider.trim()) {
    return null
  }
  const name = binding.provider.trim()
  const config = creds.providers[name]
  if (!config) {
    logForDebugging(
      `[credentials] tools.${toolName} 绑定的 provider "${name}" 不存在于 providers，忽略该绑定`,
    )
    return null
  }
  return { name, model: binding.model, config }
}

/**
 * 该模型是否「仅服务于工具能力」——不应出现在可切换聊天模型列表（2026-10-11）。
 * 判据：`imageCapabilities[model].outputImage === true`（生图模型）**或**被任一
 * `tools.<*>.model` 引用且其 provider === providerName。web `/gateway/models` 与
 * CLI `/model` 补全共用此谓词，判据单点。
 */
export function isToolBoundModel(
  providerName: string,
  config: ProviderConfig,
  model: string,
): boolean {
  if (config.imageCapabilities?.[model]?.outputImage === true) return true
  const tools = loadCredentials().tools
  if (!tools) return false
  for (const binding of Object.values(tools)) {
    if (binding.provider === providerName && binding.model === model) return true
  }
  return false
}

/**
 * 指定 provider 的当前可用 API key（钥池可用性语义同 `getActiveApiKey`：跳过
 * 仍处于冷却期的 exhausted 钥匙）。用于回落 provider——会话绑定访问器够不着它。
 */
export function getProviderApiKey(config: ProviderConfig): string | null {
  const entry = config.keys[config.activeKeyIndex]
  return _isKeyUsable(entry) ? entry.value : null
}

/**
 * Get this session's default model name (used when nothing overrides the model
 * in-process). Bound to the session provider: without an explicit override it
 * answers the boot snapshot's model, so another session writing the pool's
 * activeModel cannot drift this session's model name away from its endpoint.
 * Returns null if none configured.
 */
export function getActiveModel(): string | null {
  const creds = loadCredentials()
  const resolved = _resolveSessionProvider(creds)
  if (resolved.explicit) return resolved.cfg?.activeModel ?? null
  return _bootModelSnapshot ?? resolved.cfg?.activeModel ?? null
}

/**
 * Get the pool's current activeModel, ignoring this process's session binding.
 * Management views only (gateway /gateway/models display).
 */
export function getGlobalActiveModel(): string | null {
  return getGlobalActiveProviderConfig()?.activeModel ?? null
}

/**
 * Get the WebSearch tool's backend configuration section.
 * Returns {} when never configured.
 */
export function getWebSearchCredentials(): WebSearchCredentials {
  return loadCredentials().webSearch ?? {}
}

/**
 * Get the WebFetch tool's backend configuration section.
 * Returns {} when never configured (local HTTP + Turndown).
 */
export function getWebFetchCredentials(): WebFetchCredentials {
  return loadCredentials().webFetch ?? {}
}

/**
 * Switch to a different provider by name.
 * If the provider doesn't exist, does nothing and returns false.
 */
export function switchProvider(name: string): boolean {
  const creds = loadCredentials()
  if (!creds.providers[name]) return false
  creds.activeProvider = name
  saveCredentials(creds)
  return true
}

/**
 * List all configured provider names.
 */
export function listProviders(): string[] {
  return Object.keys(loadCredentials().providers)
}

/**
 * Add a new provider configuration.
 */
export function addProvider(
  name: string,
  config: ProviderConfig,
): void {
  const creds = loadCredentials()
  creds.providers[name] = config
  if (!creds.activeProvider) {
    creds.activeProvider = name
  }
  saveCredentials(creds)
}

/**
 * Remove a provider and all its keys.
 * If it was the active provider, resets active to first available.
 */
export function removeProvider(name: string): boolean {
  const creds = loadCredentials()
  if (!creds.providers[name]) return false
  delete creds.providers[name]
  if (creds.activeProvider === name) {
    const remaining = Object.keys(creds.providers)
    creds.activeProvider = remaining.length > 0 ? remaining[0] : ''
  }
  saveCredentials(creds)
  return true
}

/**
 * Find which provider's model list contains the given model.
 * Active provider is checked first (ties resolve to it), then config order.
 * Returns null if no provider lists the model.
 */
export function findModelProvider(model: string): string | null {
  const creds = loadCredentials()
  const cur = creds.activeProvider ? creds.providers[creds.activeProvider] : undefined
  if (cur && Array.isArray(cur.models) && cur.models.includes(model)) {
    return creds.activeProvider
  }
  for (const [name, cfg] of Object.entries(creds.providers)) {
    if (Array.isArray(cfg.models) && cfg.models.includes(model)) return name
  }
  return null
}

// 全局默认模型写入器（switchModelAuto / switchModel）2026-10-11 已删除：全局默认（activeProvider
// + 该 provider 的 activeModel）唯一调整入口 = 直接编辑 credentials.json，无运行期写入者。
// 会话级切换走 setSessionProviderOverride（进程内绑定，不落池），见文件头解析序注释。

/**
 * Get the explicit vision override for a model in the current provider.
 * Returns undefined when no override is set (name-pattern detection applies).
 */
export function getModelVision(model: string): boolean | undefined {
  const config = getActiveProviderConfig()
  return config?.modelVision?.[model]
}

/**
 * Set or clear the explicit vision override for a model in the current provider.
 * Pass undefined to clear the override (fall back to name-pattern detection).
 */
export function setModelVision(
  model: string,
  vision: boolean | undefined,
): void {
  const creds = loadCredentials()
  const provider = creds.providers[creds.activeProvider]
  if (!provider) return
  const modelVision = provider.modelVision ?? {}
  if (vision === undefined) {
    delete modelVision[model]
  } else {
    modelVision[model] = vision
  }
  provider.modelVision = modelVision
  saveCredentials(creds)
}

/**
 * Rotate to the next non-exhausted key in the current provider.
 * Returns the new active key, or null if no usable keys remain.
 */
export function rotateKey(): string | null {
  const creds = loadCredentials()
  const provider = creds.providers[creds.activeProvider]
  if (!provider || provider.keys.length === 0) return null

  const startIndex = provider.activeKeyIndex
  let index = (startIndex + 1) % provider.keys.length

  while (index !== startIndex) {
    if (_isKeyUsable(provider.keys[index])) {
      provider.activeKeyIndex = index
      saveCredentials(creds)
      return provider.keys[index].value
    }
    index = (index + 1) % provider.keys.length
  }

  // All keys exhausted — try the starting position one last time
  if (_isKeyUsable(provider.keys[startIndex])) {
    return provider.keys[startIndex].value
  }
  return null
}

/**
 * Retire a pool key after a 401 — but only the key that actually failed.
 *
 * 不变量（2026-09-18 根修）：被标记失效的钥匙 = 本次请求实际携带的钥匙。
 * 旧签名 `markCurrentKeyExhausted()` 无参、标记的恒为 `activeProvider.activeKeyIndex`，于是
 * 另一套凭据（env ANTHROPIC_API_KEY / apiKeyHelper）或跨商错配（钥匙 A 家 + 端点 B 家）引发的
 * 401 会把池里那把当时仍在正常工作的钥匙停用；而 `exhausted` 无消费方（无冷却、`/key` 命令
 * 2026-08-29 已移除）⇒ 该供应商永久不可用，全前端显示「Not logged in · Please run /login」
 * （2026-09-18 14:54 实证：glm 唯一钥匙被 401 误标，13 分钟后仍在报登录失败）。
 *
 * 冷却语义：被标记的钥匙 KEY_EXHAUSTED_COOLDOWN_MS 后自动恢复可重试；冷却期内重复
 * 401 不刷新时间戳（返回 false 跳过轮换），冷却期满后重试再 401 则重新计时。
 *
 * @param usedKey 本次 401 请求实际携带的钥匙（客户端构建处同一解析：池优先，其次 env/apiKeyHelper）
 * @returns 是否真的把池里当前这把标记失效（false = 该 401 与池钥匙无关，调用方应跳过轮换）
 */
export function markCurrentKeyExhaustedFor(usedKey: string | null): boolean {
  const creds = loadCredentials()
  const provider = creds.providers[creds.activeProvider]
  if (!provider) return false
  const entry = provider.keys[provider.activeKeyIndex]
  if (!entry) return false
  if (usedKey === null || usedKey !== entry.value) return false
  if (entry.exhausted && !_isKeyUsable(entry)) return false
  entry.exhausted = true
  entry.exhaustedAt = Date.now()
  saveCredentials(creds)
  return true
}

/**
 * 本会话绑定供应商「有配置但无可用钥匙」（keys 全 exhausted 或空）——错误文案分流用：
 * 池无钥匙是配置问题，不能复用指向 Anthropic OAuth 的「Please run /login」。
 */
export function isActiveProviderKeyUnavailable(): boolean {
  const config = getActiveProviderConfig()
  if (!config) return false
  return !config.keys.some(k => _isKeyUsable(k))
}

/**
 * Add an API key to the current provider's pool.
 */
export function addKey(key: string): void {
  const creds = loadCredentials()
  const provider = creds.providers[creds.activeProvider]
  if (!provider) return
  provider.keys.push({ value: key, exhausted: false })
  saveCredentials(creds)
}

/**
 * Remove an API key from the current provider's pool by index.
 */
export function removeKey(index: number): boolean {
  const creds = loadCredentials()
  const provider = creds.providers[creds.activeProvider]
  if (!provider || index < 0 || index >= provider.keys.length) return false
  provider.keys.splice(index, 1)
  if (provider.activeKeyIndex >= provider.keys.length) {
    provider.activeKeyIndex = Math.max(0, provider.keys.length - 1)
  }
  saveCredentials(creds)
  return true
}

/**
 * Check if the current provider has non-exhausted keys remaining.
 */
export function hasUsableKeys(): boolean {
  const config = getActiveProviderConfig()
  if (!config) return false
  return config.keys.some(k => _isKeyUsable(k))
}

/** Check if credentials.json exists on disk. */
export function credentialsFileExists(): boolean {
  return existsSync(_getCredentialsPath())
}
