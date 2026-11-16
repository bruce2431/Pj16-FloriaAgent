import { getActiveProviderPdfDocuments } from './credentials/pool.js'
import { getMainLoopModel } from './model/model.js'

// Document extensions that are handled specially
export const DOCUMENT_EXTENSIONS = new Set(['pdf'])

/**
 * Parse a page range string into firstPage/lastPage numbers.
 * Supported formats:
 * - "5" → { firstPage: 5, lastPage: 5 }
 * - "1-10" → { firstPage: 1, lastPage: 10 }
 * - "3-" → { firstPage: 3, lastPage: Infinity }
 *
 * Returns null on invalid input (non-numeric, zero, inverted range).
 * Pages are 1-indexed.
 */
export function parsePDFPageRange(
  pages: string,
): { firstPage: number; lastPage: number } | null {
  const trimmed = pages.trim()
  if (!trimmed) {
    return null
  }

  // "N-" open-ended range
  if (trimmed.endsWith('-')) {
    const first = parseInt(trimmed.slice(0, -1), 10)
    if (isNaN(first) || first < 1) {
      return null
    }
    return { firstPage: first, lastPage: Infinity }
  }

  const dashIndex = trimmed.indexOf('-')
  if (dashIndex === -1) {
    // Single page: "5"
    const page = parseInt(trimmed, 10)
    if (isNaN(page) || page < 1) {
      return null
    }
    return { firstPage: page, lastPage: page }
  }

  // Range: "1-10"
  const first = parseInt(trimmed.slice(0, dashIndex), 10)
  const last = parseInt(trimmed.slice(dashIndex + 1), 10)
  if (isNaN(first) || isNaN(last) || first < 1 || last < 1 || last < first) {
    return null
  }
  return { firstPage: first, lastPage: last }
}

/**
 * Check if inline PDF document blocks are supported with the current model/endpoint.
 * Two independent gates:
 *  - model: Haiku 3 predates PDF support (substring match covers Bedrock/Vertex ID forms);
 *  - endpoint: the bound provider must accept base64 document sources. Official Anthropic
 *    (1P / Vertex / Bedrock / Foundry) does; third-party anthropic-compatible endpoints
 *    (DeepSeek, Kimi, GLM…) only accept `file`/`text` document sources and 400 on base64,
 *    so they stay off unless the provider declares `pdfDocuments: true`.
 * When false, FileReadTool refuses up front — a rejected document block would otherwise be
 * persisted into the transcript and poison every later request in the session.
 */
export function isPDFSupported(): boolean {
  if (getMainLoopModel().toLowerCase().includes('claude-3-haiku')) return false
  return getActiveProviderPdfDocuments()
}

/**
 * Check if a file extension is a PDF document.
 * @param ext File extension (with or without leading dot)
 */
export function isPDFExtension(ext: string): boolean {
  const normalized = ext.startsWith('.') ? ext.slice(1) : ext
  return DOCUMENT_EXTENSIONS.has(normalized.toLowerCase())
}
