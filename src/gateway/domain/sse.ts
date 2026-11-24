import { readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import {
  gwState,
  PREVIEW_CHANGE_DEBOUNCE_MS,
  previewDebounce,
  previewWatches,
  sseClients,
  sseSizes,
  sseWatches,
  sweepStaleMaps,
} from '../core/state.js'
import { sendAll, triggerIdleShutdownCheck } from '../core/transport.js'
import type { ProjectInfo } from '../core/types.js'
import { SESSION_UUID_RE } from '../core/utils.js'
import { previewDirOf } from './preview.js'
import { findProjects } from './projects.js'

const SSE_HEARTBEAT_INTERVAL_MS = 15_000
const SSE_BACKPRESSURE_DESTROY_MS = 30_000
let sseHeartbeatTimer: ReturnType<typeof setInterval> | null = null

export function scheduleSseFlush(root: string): void {
  if (sseClients.size === 0 || gwState.sseDebounce) return
  gwState.sseDebounce = setTimeout(() => {
    gwState.sseDebounce = null
    pollSse(root)
  }, 250)
}

export function notePreviewChange(label: string, eventType: string, filename: string | Buffer | null): void {
  if (sseClients.size === 0) return
  const f = (typeof filename === 'string' ? filename : filename ? filename.toString() : '').replace(/\\/g, '/')
  const segs = f.split('/').filter(Boolean)
  if (
    /\.log$/i.test(f) ||
    /\.pyc$/i.test(f) ||
    segs.some((s) => s === 'backend' || s === '__pycache__' || s.startsWith('.'))
  ) {
    return
  }
  let entry = previewDebounce.get(label)
  if (!entry) {
    entry = { cards: new Set(), meta: false, timer: null }
    previewDebounce.set(label, entry)
  }
  const card = segs.length > 1 && /^[a-zA-Z0-9_-]{1,32}$/.test(segs[0]) ? segs[0] : ''
  if (!card || segs[segs.length - 1] === 'card.json' || eventType === 'rename') entry.meta = true
  else entry.cards.add(card)
  if (entry.meta) entry.cards.clear()
  if (entry.timer) return
  entry.timer = setTimeout(() => {
    previewDebounce.delete(label)
    const objs: Array<{ type: string; label: string; card: string; meta: boolean }> = entry.meta
      ? [{ type: 'preview-changed', label, card: '', meta: true }]
      : [...entry.cards].map((c) => ({ type: 'preview-changed', label, card: c, meta: false }))
    for (const obj of objs) {
      const s = `data: ${JSON.stringify(obj)}\n\n`
      sendAll(sseClients, (c) => {
        c.res.write(s)
      })
    }
  }, PREVIEW_CHANGE_DEBOUNCE_MS)
}

export function ensurePreviewWatches(projs: ProjectInfo[]): void {
  const seen = new Set<string>()
  if (sseClients.size > 0) {
    for (const g of projs) {
      if (!g.hasPreview) continue
      const dir = previewDirOf(g)
      seen.add(dir)
      if (previewWatches.has(dir)) continue
      try {
        const onEv = (ev: string, fn: string | Buffer | null) => notePreviewChange(g.label, ev, fn)
        let w: FSWatcher
        try {
          w = watch(dir, { recursive: true }, onEv)
        } catch {
          w = watch(dir, onEv)
        }
        w.on('error', () => {
          if (previewWatches.get(dir) === w) previewWatches.delete(dir)
        })
        previewWatches.set(dir, w)
      } catch {
        /* 目录不存在/被移除，忽略 */
      }
    }
  }
  for (const [dir, w] of previewWatches) {
    if (seen.has(dir)) continue
    try {
      w.close()
    } catch {
      /* 忽略 */
    }
    previewWatches.delete(dir)
  }
}

export function ensureSseWatches(root: string): void {
  const projs = findProjects(root)
  for (const g of projs) {
    if (sseWatches.has(g.dir)) continue
    try {
      const dir = g.dir
      const w = watch(dir, () => scheduleSseFlush(root))
      w.on('error', () => {
        if (sseWatches.get(dir) === w) sseWatches.delete(dir)
      })
      sseWatches.set(dir, w)
    } catch {
      /* 目录不存在/被移除，忽略 */
    }
  }
  ensurePreviewWatches(projs)
}

export function stopSseWatches(): void {
  for (const w of sseWatches.values()) {
    try {
      w.close()
    } catch {
      /* 忽略 */
    }
  }
  sseWatches.clear()
  for (const w of previewWatches.values()) {
    try {
      w.close()
    } catch {
      /* 忽略 */
    }
  }
  previewWatches.clear()
  for (const e of previewDebounce.values()) if (e.timer) clearTimeout(e.timer)
  previewDebounce.clear()
  if (gwState.sseDebounce) {
    clearTimeout(gwState.sseDebounce)
    gwState.sseDebounce = null
  }
}

export function pollSse(root: string): void {
  if (sseClients.size === 0) return
  sweepStaleMaps()
  const groups = findProjects(root)
  for (const g of groups) {
    let files: string[] = []
    try {
      files = readdirSync(g.dir).filter((f) => f.endsWith('.jsonl') && SESSION_UUID_RE.test(f))
    } catch {
      continue
    }
    for (const f of files) {
      const p = join(g.dir, f)
      let st: { size: number; mtimeMs: number }
      try {
        st = statSync(p)
      } catch {
        continue
      }
      const prev = sseSizes.get(p)
      const changed = !!prev && (prev.size !== st.size || prev.mtime !== st.mtimeMs)
      if (gwState.ssePrimed && (changed || !prev)) {
        const obj = { type: 'updated', hash: f.replace(/\.jsonl$/, ''), file: f, updatedAt: st.mtimeMs }
        const s = `data: ${JSON.stringify(obj)}\n\n`
        sendAll(sseClients, (c) => {
          c.res.write(s)
        })
      }
      sseSizes.set(p, { size: st.size, mtime: st.mtimeMs })
    }
  }
  gwState.ssePrimed = true
}

export function startSseHeartbeat(): void {
  if (sseHeartbeatTimer) return
  sseHeartbeatTimer = setInterval(() => {
    const frame = `event: heartbeat\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`
    for (const c of [...sseClients]) {
      if (c.res.destroyed || c.res.writableEnded) {
        sseClients.delete(c)
        continue
      }
      if (c.stuckSince !== undefined && Date.now() - c.stuckSince > SSE_BACKPRESSURE_DESTROY_MS) {
        console.log('[gateway] SSE 背压超时，销毁连接交由客户端重连')
        sseClients.delete(c)
        try {
          c.res.destroy()
        } catch {
          /* 已断忽略 */
        }
        triggerIdleShutdownCheck()
        continue
      }
      try {
        if (!c.res.write(frame)) {
          if (c.stuckSince === undefined) c.stuckSince = Date.now()
        } else {
          c.stuckSince = undefined
        }
      } catch {
        sseClients.delete(c)
        triggerIdleShutdownCheck()
      }
    }
  }, SSE_HEARTBEAT_INTERVAL_MS)
  sseHeartbeatTimer.unref?.()
}

export function stopSseHeartbeat(): void {
  if (!sseHeartbeatTimer) return
  clearInterval(sseHeartbeatTimer)
  sseHeartbeatTimer = null
}
