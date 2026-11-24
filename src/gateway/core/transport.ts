import { WebSocket } from 'ws'
import {
  cliClients,
  pendingModelSwitch,
  recordSessionModelLaunch,
  sockets,
  sseClients,
  webSessions,
} from './state.js'

/** 生命周期钩子槽（由 localGateway.ts 注入，避免 core/domain/routes 反向 import 入口）。 */
let stopGatewayFn: () => boolean = () => false
let scheduleIdleShutdownFn: () => void = () => {}

export function registerLifecycleHooks(hooks: {
  stopLocalGateway: () => boolean
  scheduleIdleShutdown: () => void
}): void {
  stopGatewayFn = hooks.stopLocalGateway
  scheduleIdleShutdownFn = hooks.scheduleIdleShutdown
}

export function triggerStopLocalGateway(): boolean {
  return stopGatewayFn()
}

export function triggerIdleShutdownCheck(): void {
  scheduleIdleShutdownFn()
}

export function hasClients(): boolean {
  return cliClients.size > 0 || sockets.size > 0 || sseClients.size > 0 || webSessions.size > 0
}

/** 统一群发：逐个发送并吞掉单个客户端断开异常。 */
export function sendAll<T>(targets: Iterable<T>, send: (t: T) => void): void {
  for (const t of targets) {
    try {
      send(t)
    } catch {
      /* 断开忽略 */
    }
  }
}

/** 向所有遥测 WS 客户端广播。 */
export function broadcast(msg: unknown): void {
  const s = JSON.stringify(msg)
  sendAll(sockets, (ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(s)
  })
}

/** 精确路由控制消息到指定会话（/clients 注册的 WS）；无 sessionId/未命中返回 false。 */
export function routeToClient(sessionId: string | undefined, msg: unknown): boolean {
  if (!sessionId) return false
  const target = cliClients.get(sessionId)
  if (target && target.readyState === WebSocket.OPEN) {
    try {
      target.send(JSON.stringify(msg))
      return true
    } catch {
      /* 断开忽略，返回 false */
    }
  }
  return false
}

/** 向全部 SSE 客户端推送 JSON data 事件，并记录背压/写错的 stuckSince。 */
export function sendSseData(payload: unknown): void {
  const frame = `data: ${JSON.stringify(payload)}\n\n`
  for (const c of sseClients) {
    try {
      const ok = c.res.write(frame)
      if (!ok) {
        if (!c.stuckSince) c.stuckSince = Date.now()
      } else {
        c.stuckSince = undefined
      }
    } catch {
      if (!c.stuckSince) c.stuckSince = Date.now()
    }
  }
}

export function applyPendingModelSwitch(sid: string): void {
  const intent = pendingModelSwitch.get(sid)
  if (!intent) return
  if (!routeToClient(sid, { type: 'model', value: intent.model, provider: intent.provider ?? null })) return
  intent.sentAt = Date.now()
  recordSessionModelLaunch(sid, intent.model, intent.provider)
  console.log(`[gateway] /clients 注册补投模型切换 sid=${sid} model=${intent.model}`)
}
