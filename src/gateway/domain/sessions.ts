import type { UUID } from 'crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { AUTOCOMPACT_BUFFER_TOKENS, getEffectiveContextWindowSize } from '../../services/compact/autoCompact.js'
import { roughTokenCountEstimation } from '../../services/tokenEstimation.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { filterConversationForDisplay } from '../../utils/conversationDisplay.js'
import { parseSessionInfoFromLite } from '../../utils/listSessionsImpl.js'
import { saveAgentName, saveCustomTitle } from '../../utils/sessionStorage.js'
import {
  extractJsonStringField,
  findLastCustomTitleCached,
  readSessionLite,
} from '../../utils/sessionStoragePortable.js'
import { sessionActivity, sweepStaleMaps, turnEndAt } from '../core/state.js'
import { routeToClient } from '../core/transport.js'
import { isDir, isPidAlive, SESSION_UUID_RE } from '../core/utils.js'
import { findProjects } from './projects.js'
import { ensureSseWatches } from './sse.js'

function countUserAssistant(text: string): number {
  let n = 0
  for (const line of text.split('\n')) {
    if (line.includes('"type":"user"') || line.includes('"type":"assistant"')) n++
  }
  return n
}

type SessionCore = { title: string; messageCount: number; updatedAt: number; startAt?: number }
type SessionMeta = { sidechain: true } | (SessionCore & { createdAt: number })

function extractStartAt(head: string): number | undefined {
  let pos = 0
  while (pos < head.length) {
    const nl = head.indexOf('\n', pos)
    if (nl < 0) break
    const line = head.slice(pos, nl)
    pos = nl + 1
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line) as { timestamp?: unknown }
      if (typeof o.timestamp === 'string') {
        const t = Date.parse(o.timestamp)
        if (Number.isFinite(t)) return t
      }
    } catch {
      /* 跳过坏行 */
    }
  }
  return undefined
}

async function parseMeta(file: string): Promise<SessionCore | { sidechain: true } | null> {
  const lite = await readSessionLite(file)
  if (!lite) return null
  const { head, tail, mtime } = lite
  if (head.includes('"isSidechain":true') || head.includes('"isSidechain": true')) return { sidechain: true }
  const teamName = extractJsonStringField(head, 'teamName')
  if (teamName) return { sidechain: true }
  const messageCount = countUserAssistant(head) + (tail === head ? 0 : countUserAssistant(tail))
  const uuid = basename(file).replace(/\.jsonl$/, '')
  const info = parseSessionInfoFromLite(uuid, lite)
  let title = info ? info.summary : '（空会话）'
  if (tail !== head && extractJsonStringField(tail, 'customTitle') === undefined) {
    const last = await findLastCustomTitleCached(file, { size: lite.size, mtime: lite.mtime })
    if (last) title = last
  }
  return { title, messageCount, updatedAt: mtime, startAt: extractStartAt(head) }
}

const sessionMetaCache = new Map<string, { size: number; mtimeMs: number; meta: SessionMeta }>()

async function parseMetaCached(file: string): Promise<SessionMeta | null> {
  let st: Awaited<ReturnType<typeof stat>>
  try {
    st = await stat(file)
  } catch {
    return null
  }
  const cached = sessionMetaCache.get(file)
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.meta
  const meta = await parseMeta(file)
  if (meta) {
    const full: SessionMeta =
      'sidechain' in meta
        ? meta
        : {
            title: meta.title,
            messageCount: meta.messageCount,
            updatedAt: meta.updatedAt,
            createdAt: meta.startAt ?? meta.updatedAt,
          }
    sessionMetaCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, meta: full })
    if (sessionMetaCache.size > 500) {
      const keys = [...sessionMetaCache.keys()]
      for (const k of keys.slice(0, 250)) sessionMetaCache.delete(k)
    }
    return full
  }
  return null
}

export async function listSessions(root: string) {
  sweepStaleMaps()
  ensureSseWatches(root)
  const groups = findProjects(root)
  const sessions: unknown[] = []
  for (const g of groups) {
    let files: string[] = []
    try {
      files = readdirSync(g.dir).filter((f) => f.endsWith('.jsonl') && SESSION_UUID_RE.test(f))
    } catch {
      continue
    }
    const metas = await Promise.all(files.map((f) => parseMetaCached(join(g.dir, f))))
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const meta = metas[i]
      if (!meta || 'sidechain' in meta) continue
      const p = join(g.dir, f)
      const uuid = f.replace(/\.jsonl$/, '')
      const act = sessionActivity.get(uuid)
      const state = act && isPidAlive(act.pid) ? act.status : null
      sessions.push({
        id: Buffer.from(p).toString('base64url'),
        projectLabel: g.label,
        projectScope: g.scope,
        preview: g.hasPreview,
        file: basename(p),
        title: meta.title,
        messageCount: meta.messageCount,
        updatedAt: meta.updatedAt,
        createdAt: meta.createdAt,
        state,
        turnEndAt: turnEndAt.get(uuid),
      })
    }
  }
  sessions.sort((a, b) => (b as { updatedAt: number }).updatedAt - (a as { updatedAt: number }).updatedAt)
  return { workspace: root, groups, sessions }
}

export function decodeSessionPath(id: string, root: string): { path: string; uuid: string } {
  const p = Buffer.from(id, 'base64url').toString('utf8')
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  if (!p.startsWith(rootWithSep)) throw new Error('越界路径被拒绝: ' + p)
  return { path: p, uuid: basename(p).replace(/\.jsonl$/, '') }
}

export function sessionRootFromId(id: string, root: string): string | null {
  try {
    const { path: p } = decodeSessionPath(id, root)
    const marker = sep + '.claude' + sep + 'projects'
    const k = p.toLowerCase().lastIndexOf(marker.toLowerCase())
    return k > 0 ? p.slice(0, k) : null
  } catch {
    return null
  }
}

export function resolveUploadSession(id: string, root: string): { root: string; dirKey: string } | null {
  const fullRoot = sessionRootFromId(id, root)
  if (fullRoot) {
    try {
      const { uuid } = decodeSessionPath(id, root)
      if (/^[0-9a-f-]{36}$/i.test(uuid)) return { root: fullRoot, dirKey: uuid }
    } catch {
      /* 落到裸 uuid 分支 */
    }
  }
  const uuid = String(id || '').trim().replace(/\.jsonl$/i, '')
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) return null
  for (const g of findProjects(root)) {
    if (!isDir(g.dir)) continue
    if (existsSync(join(g.dir, `${uuid}.jsonl`))) {
      return { root: resolve(g.dir, '..', '..'), dirKey: uuid }
    }
  }
  return null
}

const CTX_BLOCK_OVERHEAD = 4
const CTX_ROLE_OVERHEAD = 4

function ctxPriceValue(v: unknown): number {
  if (v == null) return 0
  if (typeof v === 'string') return roughTokenCountEstimation(v)
  if (typeof v === 'number' || typeof v === 'boolean') return roughTokenCountEstimation(String(v))
  if (Array.isArray(v)) {
    return v.reduce<number>((sum, item) => sum + ctxPriceValue(item), 0) + CTX_BLOCK_OVERHEAD
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (o.type === 'image') {
      const src = (o.source ?? {}) as Record<string, unknown>
      return (
        CTX_BLOCK_OVERHEAD +
        roughTokenCountEstimation(
          JSON.stringify({ type: 'image', source: { type: src.type, media_type: src.media_type } }),
        )
      )
    }
    let sum = 0
    for (const [k, x] of Object.entries(o)) sum += ctxPriceValue(k) + ctxPriceValue(x)
    return sum + CTX_BLOCK_OVERHEAD
  }
  return 0
}

type CtxBreakdown = {
  fixed: number
  user: number
  assistant: number
  thinking: number
  toolCall: number
  toolResult: number
  attachment: number
}

function estimateContextBreakdown(records: Record<string, unknown>[]): {
  breakdown: CtxBreakdown
  topTools: Array<{ name: string; tokens: number }>
  topAttachments: Array<{ name: string; tokens: number }>
} {
  const breakdown: CtxBreakdown = {
    fixed: 0,
    user: 0,
    assistant: 0,
    thinking: 0,
    toolCall: 0,
    toolResult: 0,
    attachment: 0,
  }
  const tools = new Map<string, number>()
  const attachments = new Map<string, number>()

  let start = 0
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (r && r.type === 'system' && r.subtype === 'compact_boundary') {
      start = i + 1
      break
    }
  }
  const scope = records.slice(start)

  const toolNames = new Map<string, string>()
  for (const r of scope) {
    if (!r || r.type !== 'assistant') continue
    const content = (r.message as Record<string, unknown> | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const b = block as Record<string, unknown>
      if (b?.type === 'tool_use' && typeof b.id === 'string') {
        toolNames.set(b.id, typeof b.name === 'string' ? b.name : 'unknown')
      }
    }
  }

  const addTool = (name: string, tokens: number): void => {
    tools.set(name, (tools.get(name) ?? 0) + tokens)
  }

  for (const r of scope) {
    if (!r) continue
    if (r.type === 'assistant') {
      const content = (r.message as Record<string, unknown> | undefined)?.content
      if (typeof content === 'string') {
        breakdown.assistant += ctxPriceValue(content) + CTX_ROLE_OVERHEAD
        continue
      }
      if (!Array.isArray(content)) continue
      for (const block of content) {
        const b = block as Record<string, unknown>
        const tokens = ctxPriceValue(b) + CTX_ROLE_OVERHEAD
        if (b?.type === 'tool_use') {
          breakdown.toolCall += tokens
          addTool(typeof b.name === 'string' ? b.name : 'unknown', tokens)
        } else if (b?.type === 'thinking') {
          breakdown.thinking += tokens
        } else {
          breakdown.assistant += tokens
        }
      }
    } else if (r.type === 'user') {
      const content = (r.message as Record<string, unknown> | undefined)?.content
      if (typeof content === 'string') {
        breakdown.user += ctxPriceValue(content) + CTX_ROLE_OVERHEAD
        continue
      }
      if (!Array.isArray(content)) continue
      for (const block of content) {
        const b = block as Record<string, unknown>
        const tokens = ctxPriceValue(b)
        if (b?.type === 'tool_result') {
          breakdown.toolResult += tokens
          const name = typeof b.tool_use_id === 'string' ? toolNames.get(b.tool_use_id) : undefined
          addTool(name ?? 'unknown', tokens)
        } else {
          breakdown.user += tokens
        }
      }
    } else if (r.type === 'attachment') {
      const att = r.attachment as Record<string, unknown> | undefined
      const tokens = ctxPriceValue(att)
      breakdown.attachment += tokens
      const name = typeof att?.type === 'string' ? att.type : 'unknown'
      attachments.set(name, (attachments.get(name) ?? 0) + tokens)
    }
  }

  const top = (m: Map<string, number>): Array<{ name: string; tokens: number }> =>
    [...m.entries()]
      .filter(([, tokens]) => tokens > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, tokens]) => ({ name, tokens }))

  return { breakdown, topTools: top(tools), topAttachments: top(attachments) }
}

function extractContextUsage(records: Record<string, unknown>[]): Record<string, unknown> | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (!r || r.type !== 'assistant') continue
    const msg = r.message as Record<string, unknown> | undefined
    const usage = msg?.usage as Record<string, unknown> | undefined
    if (!usage) continue
    const input = Number(usage.input_tokens) || 0
    const cacheCreate = Number(usage.cache_creation_input_tokens) || 0
    const cacheRead = Number(usage.cache_read_input_tokens) || 0
    if (!(input || cacheCreate || cacheRead)) continue
    const model = typeof msg?.model === 'string' && msg.model ? msg.model : ''
    const contextWindow = model ? getContextWindowForModel(model) : 0
    if (!contextWindow) continue
    const usedTokens = input + cacheCreate + cacheRead
    const percent = Math.min(100, Math.round((usedTokens / contextWindow) * 100))

    const { breakdown, topTools, topAttachments } = estimateContextBreakdown(records)
    const estimatedMessages =
      breakdown.user +
      breakdown.assistant +
      breakdown.thinking +
      breakdown.toolCall +
      breakdown.toolResult +
      breakdown.attachment
    breakdown.fixed = Math.max(0, usedTokens - estimatedMessages)

    const autoCompactThreshold = Math.min(
      contextWindow,
      Math.max(0, getEffectiveContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS),
    )

    return {
      usedTokens,
      contextWindow,
      percent,
      model,
      autoCompactThreshold,
      usage: {
        input,
        cacheCreate,
        cacheRead,
        output: Number(usage.output_tokens) || 0,
      },
      breakdown,
      topTools,
      topAttachments,
    }
  }
  return null
}

export function readSession(id: string, root: string) {
  const { path: p } = decodeSessionPath(id, root)
  if (!existsSync(p) || !statSync(p).isFile()) {
    const marker = sep + '.claude' + sep + 'projects'
    const k = p.toLowerCase().lastIndexOf(marker.toLowerCase())
    return { file: basename(p), path: p, messages: [], context: null, cwd: k > 0 ? p.slice(0, k) : undefined }
  }
  const raw = readFileSync(p, 'utf8')
  const records: Record<string, unknown>[] = []
  let cwd: string | undefined
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const r = JSON.parse(s)
      if (!cwd && typeof (r as { cwd?: unknown }).cwd === 'string' && (r as { cwd: string }).cwd) {
        cwd = (r as { cwd: string }).cwd
      }
      if (
        r &&
        typeof r === 'object' &&
        typeof (r as { type?: unknown }).type === 'string' &&
        ['user', 'assistant', 'system', 'attachment', 'progress'].includes((r as { type: string }).type)
      ) {
        records.push(r)
      }
    } catch {
      /* 跳过坏行 */
    }
  }
  const messages = filterConversationForDisplay(records as never, 'prompt-tail-think')
  const context = extractContextUsage(records)
  return { file: basename(p), path: p, messages, context, cwd }
}

function tsMs(ts: unknown): number | undefined {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts
  if (typeof ts === 'string') {
    const n = Date.parse(ts)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

export type MergeMsg = { role: string; blocks: unknown[]; timestamp?: unknown; injected?: boolean }

export function mergeDisplayMessages(disk: MergeMsg[], live: MergeMsg[]): MergeMsg[] {
  if (!live.length) return disk
  if (!disk.length) return live
  const dLast = tsMs(disk[disk.length - 1].timestamp)
  const lLast = tsMs(live[live.length - 1].timestamp)
  if (dLast == null || lLast == null || lLast <= dLast) return disk
  const tail = live.filter((m) => (tsMs(m.timestamp) ?? 0) > dLast)
  return tail.length ? [...disk, ...tail] : disk
}

export async function applySessionTitle(uuid: string, title: string, path: string): Promise<boolean> {
  await saveCustomTitle(uuid as UUID, title, path)
  await saveAgentName(uuid as UUID, title, path)
  return routeToClient(uuid, { type: 'rename', sessionId: uuid, title })
}
