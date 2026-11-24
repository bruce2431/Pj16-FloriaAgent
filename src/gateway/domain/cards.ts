import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { WebSocket } from 'ws'
import type { CardCap, CardOutcome } from '../core/types.js'

export const cardHolders = new Map<WebSocket, { ws: WebSocket; caps: CardCap[]; at: number }>()
export const wsDevice = new WeakMap<WebSocket, string>()
export const pendingCardCalls = new Map<
  string,
  { ws: WebSocket; resolve: (o: CardOutcome) => void; timer: ReturnType<typeof setTimeout> }
>()

export function sanitizeCaps(v: unknown): CardCap[] {
  if (!Array.isArray(v)) return []
  const out: CardCap[] = []
  const str = (x: unknown): string => (typeof x === 'string' ? x : '')
  for (const it of v) {
    if (!it || typeof it !== 'object') continue
    const c = it as Record<string, unknown>
    const instanceId = str(c.instanceId)
    if (!instanceId) continue
    out.push({
      label: str(c.label),
      instanceId,
      kind: str(c.kind),
      ns: str(c.ns),
      cmds: Array.isArray(c.cmds) ? c.cmds.filter((x): x is string => typeof x === 'string').slice(0, 64) : [],
      ready: c.ready === true,
    })
    if (out.length >= 200) break
  }
  return out
}

export function listAllCaps(): Array<CardCap & { device: string }> {
  const out: Array<CardCap & { device: string }> = []
  for (const h of cardHolders.values()) {
    for (const c of h.caps) out.push({ ...c, device: wsDevice.get(h.ws) || '' })
  }
  return out
}

export function pickCardHolder(t: {
  label: string
  ns: string
  instanceId: string
}): { ws: WebSocket; cap: CardCap } | null {
  let best: { ws: WebSocket; cap: CardCap; at: number } | null = null
  for (const h of cardHolders.values()) {
    for (const c of h.caps) {
      if (t.instanceId) {
        if (c.instanceId !== t.instanceId) continue
      } else if (t.ns) {
        if (c.ns !== t.ns) continue
        if (t.label && c.label !== t.label) continue
      } else if (t.label) {
        if (c.label !== t.label) continue
      } else {
        continue
      }
      if (!best || h.at > best.at) best = { ws: h.ws, cap: c, at: h.at }
    }
  }
  return best ? { ws: best.ws, cap: best.cap } : null
}

export function pickLatestHolder(): { ws: WebSocket; cap: CardCap } | null {
  let best: { ws: WebSocket; cap: CardCap; at: number } | null = null
  for (const h of cardHolders.values()) {
    if (!best || h.at > best.at) best = { ws: h.ws, cap: h.caps[0], at: h.at }
  }
  return best ? { ws: best.ws, cap: best.cap } : null
}

export function dropCardHolder(ws: WebSocket): void {
  cardHolders.delete(ws)
  for (const [id, p] of pendingCardCalls) {
    if (p.ws !== ws) continue
    clearTimeout(p.timer)
    pendingCardCalls.delete(id)
    p.resolve({ kind: 'gone' })
  }
}

export function callBrowserCard(
  ws: WebSocket,
  target: unknown,
  cmd: string,
  args: unknown,
  timeoutMs: number,
): Promise<CardOutcome> {
  const callId = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCardCalls.delete(callId)
      resolve({ kind: 'timeout' })
    }, timeoutMs)
    pendingCardCalls.set(callId, { ws, resolve, timer })
    try {
      ws.send(JSON.stringify({ type: 'card-call', callId, target, cmd, args, timeoutMs }))
    } catch {
      clearTimeout(timer)
      pendingCardCalls.delete(callId)
      resolve({ kind: 'gone' })
    }
  })
}

export function deviceHintOf(req: IncomingMessage): string {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`)
    return (url.searchParams.get('device') || '').trim().slice(0, 32)
  } catch {
    return ''
  }
}
