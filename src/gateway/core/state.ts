import type { Server, ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync, type FSWatcher } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { WebSocket, WebSocketServer } from 'ws'
import { gatewayDir } from '../../utils/gatewayToken.js'
import type { BackendProc, BpSession, GatewayTaskItem, WebSessionProc } from './types.js'
import { isPidAlive } from './utils.js'

export const CLI_RECENT_REGISTER_MS = 10_000
export const PREVIEW_CHANGE_DEBOUNCE_MS = 250
export const GATEWAY_IDLE_MINUTES = Number(process.env.GATEWAY_IDLE_MINUTES || 10)
export const GATEWAY_BOOT_AT = Date.now()
export const GLOBAL_PROJECT_LABEL = '全局根 · 散装对话'
export const ENABLE_IDLE_RECLAIM = process.argv.includes('--gateway')

export const BACKEND_PORT_BASE = 8130
export const BACKEND_PORT_MAX = 8160
export const BP_COOKIE_TTL_MS = 24 * 60 * 60 * 1000
export const BP_COOKIE_KEY_RE = /^[0-9a-f]{32}$/

export const DISPLAY_TTL_MS = 10 * 60 * 1000
export const ACTIVITY_TTL_MS = 10 * 60 * 1000

/** 网关可变单值运行态（集中持有，跨模块无环读写） */
export const gwState = {
  server: null as Server | null,
  wss: null as WebSocketServer | null,
  currentToken: '',
  currentHost: '0.0.0.0',
  currentPort: 8124,
  ssePrimed: false,
  sseDebounce: null as NodeJS.Timeout | null,
  idleTimer: null as NodeJS.Timeout | null,
  reclaimTimer: null as NodeJS.Timeout | null,
  gatewayStopping: false,
  ejecting: false,
}

export const sockets = new Set<WebSocket>()
export const cliClients = new Map<string, WebSocket>()
export const cliPids = new Map<string, number>()
export const cliRegisterAt = new Map<string, number>()

export const sseClients = new Set<{ res: ServerResponse; stuckSince?: number }>()
export const sseSizes = new Map<string, { size: number; mtime: number }>()
export const sseWatches = new Map<string, FSWatcher>()
export const previewWatches = new Map<string, FSWatcher>()
export const previewDebounce = new Map<string, { cards: Set<string>; meta: boolean; timer: NodeJS.Timeout | null }>()

export const backendProcesses = new Map<string, BackendProc>()
export const bpSessions = new Map<string, BpSession>()
export const webSessions = new Map<string, WebSessionProc>()

export const conversationDisplays = new Map<string, { messages: unknown[]; updatedAt: number }>()
export const sessionActivity = new Map<string, { status: string; pid: number; cwd?: string; updatedAt: number }>()
export const sessionModels = new Map<string, { model: string; updatedAt: number }>()
export const sessionEfforts = new Map<string, { effort: string | null; updatedAt: number }>()
export const sessionModelLaunch = new Map<string, { model: string; provider?: string; updatedAt: number }>()
export const pendingModelSwitch = new Map<string, { model: string; provider?: string; sentAt?: number }>()
export const sessionQueues = new Map<
  string,
  { items: Array<{ content: string; ts: number; from?: { title: string; sid?: string } }>; updatedAt: number }
>()
export const sessionTasks = new Map<string, { tasks: GatewayTaskItem[]; updatedAt: number }>()
// 用量/上下文快照（2026-11-28）：CLI usage-state 上报，网关只存转发 + /gateway/session 附带给 web。
export const sessionUsageState = new Map<string, { usage: unknown; context: unknown; updatedAt: number }>()
export const turnEndAt = new Map<string, number>()
export const turnBeatAt = new Map<string, number>()
export const sessionDeltaSeq = new Map<string, number>()
export const detachTimers = new Map<string, ReturnType<typeof setTimeout>>()

// ---- 后端注册表落盘 ----
export function backendRegistryPath(): string {
  return join(gatewayDir(), 'backends.json')
}

export function readBackendRegistry(): Record<string, { pid: number; port: number; startedAt: number }> {
  if (!existsSync(backendRegistryPath())) return {}
  const parsed: unknown = JSON.parse(readFileSync(backendRegistryPath(), 'utf8'))
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, { pid: number; port: number; startedAt: number }>)
    : {}
}

export function persistBackendRegistry(): void {
  try {
    const reg: Record<string, { pid: number; port: number; startedAt: number }> = {}
    for (const [label, p] of backendProcesses) reg[label] = { pid: p.pid, port: p.port, startedAt: p.startedAt }
    const p = backendRegistryPath()
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, JSON.stringify(reg, null, 2))
  } catch {
    /* 忽略：磁盘瞬时故障由下个写点重试 */
  }
}

export function sweepBpSessions(now = Date.now()): void {
  for (const [k, s] of [...bpSessions]) if (s.expires <= now) bpSessions.delete(k)
}

// ---- web 会话注册表落盘 + 收养 ----
export const webSessionsRegistryPath = (): string => join(gatewayDir(), 'websessions.json')

export function persistWebSessions(): void {
  const entries: Array<{ sessionId: string; pid: number; startedAt: number }> = []
  for (const p of webSessions.values()) {
    if (p.pid) entries.push({ sessionId: p.sessionId, pid: p.pid, startedAt: p.startedAt })
  }
  try {
    const p = webSessionsRegistryPath()
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, JSON.stringify(entries), 'utf8')
  } catch {
    /* 落盘失败不影响运行 */
  }
}

export function adoptWebSessions(): void {
  const regPath = webSessionsRegistryPath()
  if (!existsSync(regPath)) return
  const raw: unknown = JSON.parse(readFileSync(regPath, 'utf8'))
  if (!Array.isArray(raw)) return
  const entries = raw as Array<{ sessionId: string; pid: number; startedAt: number }>
  for (const e of entries) {
    if (!e?.sessionId || !Number.isFinite(e.pid) || webSessions.has(e.sessionId)) continue
    if (!isPidAlive(e.pid)) continue
    webSessions.set(e.sessionId, {
      sessionId: e.sessionId,
      pid: e.pid,
      clients: new Set(),
      startedAt: Number(e.startedAt) || Date.now(),
      lastActive: Date.now(),
    })
    console.log(`[gateway] 收养存活 web 会话 ${e.sessionId} (PID ${e.pid})`)
  }
  persistWebSessions()
}

// ---- 会话启动模型表落盘 ----
const sessionModelLaunchPath = (): string => join(gatewayDir(), 'sessionmodels.json')

export function persistSessionModelLaunch(): void {
  try {
    const p = sessionModelLaunchPath()
    mkdirSync(join(p, '..'), { recursive: true })
    const entries: Array<{ sessionId: string; model: string; provider?: string; updatedAt: number }> = []
    for (const [sid, v] of sessionModelLaunch) {
      entries.push({
        sessionId: sid,
        model: v.model,
        ...(v.provider ? { provider: v.provider } : {}),
        updatedAt: v.updatedAt,
      })
    }
    writeFileSync(p, JSON.stringify(entries), 'utf8')
  } catch {
    /* 落盘失败不影响运行 */
  }
}

export function loadSessionModelLaunch(): void {
  const p = sessionModelLaunchPath()
  if (!existsSync(p)) return
  try {
    const raw: unknown = JSON.parse(readFileSync(p, 'utf8'))
    if (!Array.isArray(raw)) return
    for (const e of raw as Array<{ sessionId?: unknown; model?: unknown; provider?: unknown; updatedAt?: unknown }>) {
      if (!e || typeof e.sessionId !== 'string' || !e.sessionId) continue
      if (typeof e.model !== 'string' || !e.model.trim()) continue
      sessionModelLaunch.set(e.sessionId, {
        model: e.model.trim(),
        ...(typeof e.provider === 'string' && e.provider.trim() ? { provider: e.provider.trim() } : {}),
        updatedAt: Number.isFinite(e.updatedAt) ? Number(e.updatedAt) : Date.now(),
      })
    }
  } catch {
    /* 坏文件当不存在 */
  }
}

export function recordSessionModelLaunch(sid: string, model: string, provider?: string): void {
  if (!sid || !model.trim()) return
  sessionModelLaunch.set(sid, { model: model.trim(), ...(provider ? { provider } : {}), updatedAt: Date.now() })
  persistSessionModelLaunch()
}

// ---- turnEndAt 落盘 ----
const turnEndAtPath = (): string => join(gatewayDir(), 'turnend.json')

export function persistTurnEndAt(): void {
  try {
    const p = turnEndAtPath()
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, JSON.stringify(Object.fromEntries(turnEndAt)), 'utf8')
  } catch {
    /* 落盘失败不影响运行 */
  }
}

export function loadTurnEndAt(): void {
  try {
    const raw: unknown = JSON.parse(readFileSync(turnEndAtPath(), 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    for (const [sid, ts] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) turnEndAt.set(sid, ts)
    }
  } catch {
    /* 无文件/坏 JSON */
  }
}

// ---- 惰性清扫与目录 watch 释放 ----
export function sweepStaleMaps(now = Date.now()): void {
  for (const [sid, v] of conversationDisplays) {
    if (now - v.updatedAt > DISPLAY_TTL_MS) conversationDisplays.delete(sid)
  }
  for (const [sid, v] of sessionActivity) {
    if (now - v.updatedAt > ACTIVITY_TTL_MS || !isPidAlive(v.pid)) sessionActivity.delete(sid)
  }
}

export function closeSseWatchesUnder(projRoot: string): void {
  const base = resolve(projRoot).toLowerCase()
  const under = (p: string): boolean => {
    const d = resolve(p).toLowerCase()
    return d === base || d.startsWith(base + sep)
  }
  for (const [dir, w] of [...sseWatches]) {
    if (!under(dir)) continue
    try {
      w.close()
    } catch {
      /* 忽略 */
    }
    sseWatches.delete(dir)
  }
  for (const [dir, w] of [...previewWatches]) {
    if (!under(dir)) continue
    try {
      w.close()
    } catch {
      /* 忽略 */
    }
    previewWatches.delete(dir)
  }
}
