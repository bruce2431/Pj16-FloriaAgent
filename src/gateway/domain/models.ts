import {
  getGlobalActiveModel,
  getGlobalActiveProviderConfig,
  isToolBoundModel,
  loadCredentials,
} from '../../utils/credentials/pool.js'
import type { ProviderConfig } from '../../utils/credentials/types.js'
import { modelSupportsVision } from '../../utils/model/vision.js'
import { getSettingsFilePathForSource, getSettingsForSource } from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'

const MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]

const MODEL_PROVIDER_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  anthropic: 'Claude · Anthropic',
  claude: 'Claude · Anthropic',
  openai: 'OpenAI',
  qwen: 'Qwen · 通义千问',
  dashscope: 'Qwen · 通义千问',
  gemini: 'Google Gemini',
  glm: '智谱 GLM',
  moonshot: 'Moonshot Kimi',
  openrouter: 'OpenRouter',
}

function modelProviderLabel(name: string): string {
  return MODEL_PROVIDER_LABELS[name.toLowerCase()] || name
}

export function listModels(root: string): Record<string, unknown> {
  const settings = getSettingsForSource('userSettings') ?? ({} as SettingsJson)
  const items: Array<{ k: string; v: string; src: string }> = []
  if (settings.model !== undefined) items.push({ k: 'model', v: String(settings.model), src: 'settings.json' })
  const env0 = settings.env && typeof settings.env === 'object' ? (settings.env as Record<string, unknown>) : {}
  const seen = new Set(items.map((i) => i.k))
  for (const k of MODEL_ENV_KEYS) {
    if (env0[k] !== undefined && !seen.has(k)) {
      items.push({ k, v: String(env0[k]), src: 'settings.json → env' })
      seen.add(k)
    }
  }
  for (const k of MODEL_ENV_KEYS) {
    if (process.env[k] !== undefined && !seen.has(k)) {
      items.push({ k, v: String(process.env[k]), src: '进程环境变量' })
      seen.add(k)
    }
  }
  const creds = loadCredentials()
  const poolRows: Array<{
    k: string
    v: string
    src: string
    vision?: boolean
    provider?: string
    effortLevels?: string[]
  }> = []
  const poolSet = new Set<string>()
  for (const [name, cfg0] of Object.entries(creds.providers)) {
    const cfg = (cfg0 && typeof cfg0 === 'object' ? cfg0 : {}) as Record<string, unknown>
    const models = Array.isArray(cfg.models) ? (cfg.models as string[]) : []
    const mv =
      cfg.modelVision && typeof cfg.modelVision === 'object' ? (cfg.modelVision as Record<string, unknown>) : {}
    const effLv = Array.isArray(cfg.effortLevels)
      ? (cfg.effortLevels as unknown[]).map((s) => String(s).toLowerCase().trim()).filter(Boolean)
      : undefined
    const label = modelProviderLabel(name)
    for (const m of models) {
      if (poolSet.has(m)) continue
      if (isToolBoundModel(name, cfg as unknown as ProviderConfig, m)) continue
      poolSet.add(m)
      poolRows.push({
        k: m,
        v: m,
        src: `凭据池·${label}`,
        vision: mv[m] === true,
        provider: label,
        ...(effLv && effLv.length ? { effortLevels: effLv } : {}),
      })
    }
  }
  const cfgItems = items.filter((it) => !poolSet.has(it.v))
  const activeModel = getGlobalActiveModel()
  const activeCfg = getGlobalActiveProviderConfig()
  return {
    workspace: root,
    model: activeModel ?? (settings.model !== undefined ? String(settings.model) : null),
    vision: activeModel ? modelSupportsVision(activeModel) : false,
    activeProvider: creds.activeProvider || null,
    activeModel,
    providerModels:
      activeCfg && Array.isArray(activeCfg.models)
        ? (activeCfg.models as string[]).filter((m) => !isToolBoundModel(creds.activeProvider, activeCfg, m))
        : [],
    effortLevel: settings.effortLevel !== undefined ? String(settings.effortLevel) : null,
    source: getSettingsFilePathForSource('userSettings') ?? null,
    items: [...poolRows, ...cfgItems],
  }
}

const CATALOG_TIMEOUT_MS = 9000

function catalogUrls(cfg: ProviderConfig): string[] {
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '')
  if (!base) return []
  if (cfg.protocol === 'openai-chat') return [base + '/models']
  const out = [base + '/v1/models']
  const stripped = base.replace(/\/api\/anthropic$/, '').replace(/\/anthropic$/, '')
  if (stripped !== base) out.push(stripped + '/v1/models')
  return [...new Set(out)]
}

function normalizeCatalogModels(json: unknown): Array<{ id: string; name?: string }> {
  const obj = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const arr = Array.isArray(obj.data) ? obj.data : Array.isArray(obj.models) ? obj.models : []
  const out: Array<{ id: string; name?: string }> = []
  const seen = new Set<string>()
  for (const raw of arr) {
    const it = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    let id = String(it.id || it.name || '').trim()
    if (!id) continue
    if (id.startsWith('models/')) id = id.slice(7)
    if (seen.has(id)) continue
    seen.add(id)
    const dn =
      typeof it.display_name === 'string'
        ? it.display_name
        : typeof it.name === 'string' && it.name !== id
          ? it.name
          : undefined
    out.push(dn ? { id, name: dn } : { id })
  }
  return out
}

async function fetchCatalogModels(url: string, key: string): Promise<Array<{ id: string; name?: string }>> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), CATALOG_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        Accept: 'application/json',
      },
      signal: ctl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return normalizeCatalogModels(await res.json())
  } finally {
    clearTimeout(timer)
  }
}

export async function listProviderCatalog(name: string): Promise<Record<string, unknown>> {
  const creds = loadCredentials()
  const providers = creds.providers as Record<string, ProviderConfig>
  const cfg = providers[name]
  if (!cfg) return { provider: name, ok: false, error: 'provider not found', enabled: [], models: [] }
  const enabled = Array.isArray(cfg.models) ? (cfg.models as unknown[]).map(String) : []
  const keys = (Array.isArray(cfg.keys) ? cfg.keys : [])
    .filter((k) => k && typeof k.value === 'string' && k.value && !k.exhausted)
    .map((k) => k.value)
  let discovered: Array<{ id: string; name?: string }> = []
  let usedUrl: string | null = null
  let firstError = ''
  outer: for (const url of catalogUrls(cfg)) {
    for (const key of keys) {
      try {
        const list = await fetchCatalogModels(url, key)
        usedUrl = url
        if (list.length) {
          discovered = list
          break outer
        }
      } catch (e) {
        if (!firstError) firstError = e instanceof Error ? e.message : String(e)
      }
    }
  }
  const merged: Array<{ id: string; name?: string; enabled: boolean; vision: boolean; tool: boolean }> = []
  const seen = new Set<string>()
  for (const id of enabled) {
    if (seen.has(id)) continue
    seen.add(id)
    merged.push({
      id,
      enabled: true,
      vision: !!(cfg.modelVision && cfg.modelVision[id] === true),
      tool: isToolBoundModel(name, cfg, id),
    })
  }
  for (const it of discovered) {
    if (seen.has(it.id)) continue
    seen.add(it.id)
    merged.push({
      id: it.id,
      ...(it.name ? { name: it.name } : {}),
      enabled: false,
      vision: !!(cfg.modelVision && cfg.modelVision[it.id] === true),
      tool: isToolBoundModel(name, cfg, it.id),
    })
  }
  return {
    provider: name,
    ok: discovered.length > 0,
    url: usedUrl,
    error: discovered.length ? null : firstError || '未发现模型清单端点',
    enabled,
    models: merged,
  }
}
