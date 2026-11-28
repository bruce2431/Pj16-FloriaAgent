import type { UUID } from 'crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
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

export function readSession(id: string, root: string) {
  const { path: p } = decodeSessionPath(id, root)
  if (!existsSync(p) || !statSync(p).isFile()) {
    const marker = sep + '.claude' + sep + 'projects'
    const k = p.toLowerCase().lastIndexOf(marker.toLowerCase())
    return { file: basename(p), path: p, messages: [], cwd: k > 0 ? p.slice(0, k) : undefined }
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
  // 上下文占用不在此计算（2026-11-28 下沉 CLI）：网关只做传输，context 由 CLI usage-state
  // 快照经 routes/sessions.ts 附带。
  return { file: basename(p), path: p, messages, cwd }
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
