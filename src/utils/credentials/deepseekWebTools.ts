/**
 * DeepSeek Search / Fetch API access (credentials + transport), shared by the
 * WebSearch `deepseek` backend and the WebFetch `deepseek` backend.
 *
 * Endpoints (2026-10 public API): `POST <base>/search`, `POST <base>/fetch`,
 * Bearer auth. The key defaults to the deepseek provider key already in the
 * pool — one source of truth — with `webSearch.keys.deepseek` as an explicit
 * override. The base URL is `webSearch.deepseekBaseUrl` / `webFetch.deepseekBaseUrl`
 * when set, otherwise the origin of the deepseek provider baseUrl + `/v1/tools`.
 */

import { getProviderApiKey, getWebSearchCredentials, loadCredentials } from './pool.js'

const OFFICIAL_TOOLS_BASE = 'https://api.deepseek.com/v1/tools'
const DEFAULT_TIMEOUT_MS = 45_000

export function getDeepSeekWebApiKey(): string | null {
  const explicit = getWebSearchCredentials().keys?.deepseek
  if (explicit) return explicit
  const cfg = loadCredentials().providers.deepseek
  return cfg ? getProviderApiKey(cfg) : null
}

export function getDeepSeekToolsBase(override?: string): string {
  const explicit = override?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  const cfg = loadCredentials().providers.deepseek
  if (cfg?.baseUrl) {
    try {
      return `${new URL(cfg.baseUrl).origin}/v1/tools`
    } catch {
      // Unparseable base URL falls through to the official endpoint.
    }
  }
  return OFFICIAL_TOOLS_BASE
}

export type DeepSeekToolsResult =
  | { ok: true; text: string }
  | { ok: false; error: string }

/**
 * POST one DeepSeek tools operation. Returns the raw response body; the caller
 * owns payload validation (search JSON vs fetch Markdown).
 */
export async function postDeepSeekTools(
  operation: 'search' | 'fetch',
  body: Record<string, unknown>,
  options: {
    baseUrl?: string
    timeoutMs?: number
    signal: AbortSignal
  },
): Promise<DeepSeekToolsResult> {
  const apiKey = getDeepSeekWebApiKey()
  if (!apiKey) {
    return {
      ok: false,
      error:
        'DeepSeek API key is not configured — add a deepseek provider key to credentials.json or set webSearch.keys.deepseek.',
    }
  }

  const endpoint = `${getDeepSeekToolsBase(options.baseUrl)}/${operation}`
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error(`DeepSeek ${operation} timed out after ${timeoutMs}ms`)),
    timeoutMs,
  )
  const onAbort = () => controller.abort(options.signal.reason)
  if (options.signal.aborted) {
    controller.abort(options.signal.reason)
  } else {
    options.signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim()
      return {
        ok: false,
        error: `DeepSeek ${operation} returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      }
    }
    return { ok: true, text: await response.text() }
  } catch (error) {
    return {
      ok: false,
      error: `DeepSeek ${operation} request failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', onAbort)
  }
}
