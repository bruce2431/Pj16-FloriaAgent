/**
 * Local multi-backend web search providers — TS port of Hermes Agent's
 * `plugins/web/<vendor>/provider.py` architecture (web_tools dispatch).
 *
 * Every provider executes the search locally in-process (plain JSON HTTP);
 * no dependence on the inference API's server-side tool capabilities, so the
 * tool works with any model provider. Credentials come from the global
 * credential pool (credentials.json `webSearch` section) — a single source of
 * truth shared with the LLM provider pool, not environment variables.
 */

import { getWebSearchCredentials } from '../../utils/credentials/pool.js'
import {
  getDeepSeekWebApiKey,
  postDeepSeekTools,
} from '../../utils/credentials/deepseekWebTools.js'

export interface WebHit {
  title: string
  url: string
  description: string
}

export type SearchResponse =
  | { success: true; hits: WebHit[] }
  | { success: false; error: string }

export interface SearchProvider {
  name: string
  isAvailable(): boolean
  search(query: string, limit: number, signal: AbortSignal): Promise<SearchResponse>
}

// Every vendor here caps results server-side (Brave/Tavily at 20).
const SEARCH_LIMIT_CAP = 20

const str = (value: unknown): string =>
  value == null ? '' : typeof value === 'string' ? value : String(value)

async function fetchJson(
  label: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  outerSignal: AbortSignal,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error(`${label} request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  )
  const onAbort = () => controller.abort(outerSignal.reason)
  if (outerSignal.aborted) {
    controller.abort(outerSignal.reason)
  } else {
    outerSignal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).trim()
      return {
        ok: false,
        error: `${label} returned HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`,
      }
    }
    return { ok: true, data: await response.json() }
  } catch (error) {
    return {
      ok: false,
      error: `${label} request failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timer)
    outerSignal.removeEventListener('abort', onAbort)
  }
}

// ── SearXNG (self-hosted, keyless) — search only ─────────────────────────────

const searxng: SearchProvider = {
  name: 'searxng',
  isAvailable() {
    return Boolean(getWebSearchCredentials().searxngUrl)
  },
  async search(query, limit, signal) {
    const baseUrl = getWebSearchCredentials().searxngUrl?.replace(/\/+$/, '')
    if (!baseUrl) {
      return { success: false, error: 'searxngUrl is not set in the webSearch credentials section' }
    }
    const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&pageno=1`
    const response = await fetchJson(
      'SearXNG',
      url,
      { headers: { Accept: 'application/json' } },
      15_000,
      signal,
    )
    if (!response.ok) return response
    const rawResults =
      ((response.data as { results?: Record<string, unknown>[] }).results ?? []) ?? []
    // SearXNG may return a score field; sort descending and cap to limit.
    const sorted = [...rawResults]
      .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))
      .slice(0, limit)
    return {
      success: true,
      hits: sorted.map(r => ({
        title: str(r.title),
        url: str(r.url),
        description: str(r.content),
      })),
    }
  },
}

// ── Brave Search (free-tier Data-for-Search API) — search only ───────────────

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

const brave: SearchProvider = {
  name: 'brave',
  isAvailable() {
    return Boolean(getWebSearchCredentials().keys?.brave)
  },
  async search(query, limit, signal) {
    const apiKey = getWebSearchCredentials().keys?.brave
    if (!apiKey) {
      return { success: false, error: 'Brave API key is not set (webSearch.keys.brave)' }
    }
    const params = new URLSearchParams({ q: query, count: String(Math.max(1, Math.min(limit, SEARCH_LIMIT_CAP))) })
    const response = await fetchJson(
      'Brave Search',
      `${BRAVE_ENDPOINT}?${params}`,
      {
        headers: {
          'X-Subscription-Token': apiKey,
          Accept: 'application/json',
        },
      },
      15_000,
      signal,
    )
    if (!response.ok) return response
    const rawResults =
      ((response.data as { web?: { results?: Record<string, unknown>[] } }).web?.results ?? []) ?? []
    return {
      success: true,
      hits: rawResults.slice(0, limit).map(r => ({
        title: str(r.title),
        url: str(r.url),
        description: str(r.description),
      })),
    }
  },
}

// ── Tavily — search (+ extract, unused here) ─────────────────────────────────

const TAVILY_ENDPOINT = 'https://api.tavily.com/search'

const tavily: SearchProvider = {
  name: 'tavily',
  isAvailable() {
    return Boolean(getWebSearchCredentials().keys?.tavily)
  },
  async search(query, limit, signal) {
    const apiKey = getWebSearchCredentials().keys?.tavily
    if (!apiKey) {
      return { success: false, error: 'Tavily API key is not set (webSearch.keys.tavily)' }
    }
    const response = await fetchJson(
      'Tavily',
      TAVILY_ENDPOINT,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'X-Client-Name': 'floria-agent',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          max_results: Math.min(limit, SEARCH_LIMIT_CAP),
          include_raw_content: false,
          include_images: false,
        }),
      },
      60_000,
      signal,
    )
    if (!response.ok) return response
    const rawResults =
      ((response.data as { results?: Record<string, unknown>[] }).results ?? []) ?? []
    return {
      success: true,
      hits: rawResults.map(r => ({
        title: str(r.title),
        url: str(r.url),
        description: str(r.content),
      })),
    }
  },
}

// ── Exa — neural/semantic search via REST (no SDK) ───────────────────────────

const EXA_ENDPOINT = 'https://api.exa.ai/search'

const exa: SearchProvider = {
  name: 'exa',
  isAvailable() {
    return Boolean(getWebSearchCredentials().keys?.exa)
  },
  async search(query, limit, signal) {
    const apiKey = getWebSearchCredentials().keys?.exa
    if (!apiKey) {
      return { success: false, error: 'Exa API key is not set (webSearch.keys.exa)' }
    }
    const response = await fetchJson(
      'Exa',
      EXA_ENDPOINT,
      {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          numResults: limit,
          contents: { highlights: true },
        }),
      },
      60_000,
      signal,
    )
    if (!response.ok) return response
    const rawResults =
      ((response.data as { results?: Record<string, unknown>[] }).results ?? []) ?? []
    return {
      success: true,
      hits: rawResults.map(r => ({
        title: str(r.title),
        url: str(r.url),
        description: Array.isArray(r.highlights) ? r.highlights.map(str).join(' ') : str(r.text),
      })),
    }
  },
}

// ── DeepSeek Search API — native search endpoint (no auxiliary model turn) ───

const DEEPSEEK_SEARCH_MAX_COUNT = 50

const deepseek: SearchProvider = {
  name: 'deepseek',
  isAvailable() {
    return Boolean(getDeepSeekWebApiKey())
  },
  async search(query, limit, signal) {
    const response = await postDeepSeekTools(
      'search',
      {
        query,
        count: Math.max(1, Math.min(limit, DEEPSEEK_SEARCH_MAX_COUNT)),
        need_content: false,
      },
      { baseUrl: getWebSearchCredentials().deepseekBaseUrl, signal },
    )
    if (!response.ok) return { success: false, error: response.error }

    let parsed: { results?: Record<string, unknown>[] }
    try {
      parsed = JSON.parse(response.text) as { results?: Record<string, unknown>[] }
    } catch {
      return { success: false, error: 'DeepSeek Search returned malformed JSON' }
    }
    const rawResults = parsed.results ?? []
    return {
      success: true,
      hits: rawResults.slice(0, limit).map(r => ({
        title: str(r.title),
        url: str(r.url),
        // `snippet` is the display excerpt; `summary` is the longer model-facing one.
        description: str(r.snippet) || str(r.summary),
      })),
    }
  },
}

export const SEARCH_PROVIDERS: SearchProvider[] = [searxng, brave, tavily, exa, deepseek]

// Autodetect preference for never-configured setups (Hermes order, restricted
// to the ported set): keyed vendors before the self-hosted URL before free-tier.
// DeepSeek is last so an already-configured vendor always wins.
const AUTODETECT_ORDER = ['tavily', 'exa', 'searxng', 'brave', 'deepseek']

export type ResolvedProvider =
  | { provider: SearchProvider }
  | { error: string }

/**
 * Resolve which backend serves the next search.
 * Explicit `webSearch.backend` is strict — a broken selection surfaces the
 * vendor's honest error rather than silently rerouting (no fallback ladder).
 * Autodetect runs only when no backend has ever been selected.
 */
export function resolveSearchProvider(): ResolvedProvider {
  const config = getWebSearchCredentials()
  const explicit = config.backend?.trim().toLowerCase()
  if (explicit) {
    const provider = SEARCH_PROVIDERS.find(p => p.name === explicit)
    if (!provider) {
      return {
        error: `Unknown web search backend "${explicit}". Available backends: ${SEARCH_PROVIDERS.map(p => p.name).join(', ')}.`,
      }
    }
    if (!provider.isAvailable()) {
      return {
        error: `Web search backend "${explicit}" is selected but not usable — set its API key (or SearXNG URL) in the webSearch section of credentials.json; the deepseek backend uses the pool's deepseek provider key (or webSearch.keys.deepseek).`,
      }
    }
    return { provider }
  }
  for (const name of AUTODETECT_ORDER) {
    const provider = SEARCH_PROVIDERS.find(p => p.name === name)
    if (provider?.isAvailable()) {
      return { provider }
    }
  }
  return {
    error: `No web search backend configured. Add a "webSearch" section to credentials.json — e.g. {"backend":"brave","keys":{"brave":"..."}} or {"searxngUrl":"http://localhost:8888"}. Backends: ${SEARCH_PROVIDERS.map(p => p.name).join(', ')}.`,
  }
}

/** Whether any web search backend is usable (tool visibility gate). */
export function isAnySearchBackendAvailable(): boolean {
  return SEARCH_PROVIDERS.some(p => p.isAvailable())
}
