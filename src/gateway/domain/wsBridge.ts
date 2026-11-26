import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { findModelProvider } from '../../utils/credentials/pool.js'
import { isGatewayTicket, touchGatewayTicket } from '../../utils/gatewayToken.js'
import { AUTH_COOKIE_NAME, parseCookieHeader, resolveAuth } from '../httpAuth.js'
import {
  cliClients,
  cliPids,
  cliRegisterAt,
  detachTimers,
  gwState,
  persistTurnEndAt,
  persistWebSessions,
  sessionActivity,
  sessionDeltaSeq,
  sessionModels,
  sessionQueues,
  sessionTasks,
  sockets,
  sseClients,
  sweepStaleMaps,
  turnBeatAt,
  turnEndAt,
  webSessions,
} from '../core/state.js'
import {
  applyPendingModelSwitch,
  broadcast,
  sendAll,
  triggerIdleShutdownCheck,
} from '../core/transport.js'
import type { DeliveryFeedback } from '../core/types.js'
import { isPidAlive, normalizeGatewayTasks, remoteIPv4 } from '../core/utils.js'
import {
  cardHolders,
  deviceHintOf,
  dropCardHolder,
  pendingCardCalls,
  sanitizeCaps,
  wsDevice,
} from './cards.js'
import { applySessionTitle } from './sessions.js'
import { ensureSseWatches, scheduleSseFlush } from './sse.js'
import {
  cliHelloPids,
  detachWebSessionClient,
  flushPendingDeliveries,
  pendingDeliveries,
  sessionProjectRootOf,
  spawningPromises,
  spawnWebSession,
  webSessionEntryAlive,
  webSessionProjectRoot,
} from './webSessions.js'

const approvalTrail: Array<{ ts: number; ev: string; sessionId?: string; requestId?: string; detail?: string }> = []

export function approvalTrailPush(ev: string, sessionId?: string, requestId?: string, detail?: string): void {
  approvalTrail.push({ ts: Date.now(), ev, sessionId, requestId, detail })
  if (approvalTrail.length > 500) approvalTrail.splice(0, approvalTrail.length - 500)
}

export function approvalTrailSnapshot(): unknown[] {
  return approvalTrail.slice(-50).reverse()
}

const pendingApprovals = new Map<string, { sessionId: string; payload: unknown }>()

function pendingApprovalsSet(sessionId: string, requestId: string, payload: unknown): void {
  pendingApprovals.set(requestId, { sessionId, payload })
}

function pendingApprovalsDrop(requestId: unknown): void {
  if (typeof requestId === 'string' && requestId) pendingApprovals.delete(requestId)
}

function pendingApprovalsDropSession(sessionId: string): void {
  for (const [requestId, e] of pendingApprovals) if (e.sessionId === sessionId) pendingApprovals.delete(requestId)
}

function pendingApprovalsReplay(ws: WebSocket, sessionId: string): void {
  for (const [, e] of pendingApprovals) {
    if (e.sessionId !== sessionId) continue
    try {
      ws.send(JSON.stringify(e.payload))
    } catch {
      /* 连接已断，忽略 */
    }
  }
}

const resumingSessions = new Map<string, Promise<unknown>>()

export function deliverToSession(
  sessionId: string,
  frame: Record<string, unknown>,
  fb: DeliveryFeedback,
): void {
  const target = cliClients.get(sessionId)
  if (target && target.readyState === WebSocket.OPEN) {
    try {
      target.send(JSON.stringify(frame))
      fb.done(true)
    } catch (e) {
      fb.done(false, '投递失败：' + ((e as Error)?.message ?? String(e)))
    }
    return
  }
  const spawning = spawningPromises.has(sessionId)
  if (spawning || webSessionEntryAlive(sessionId)) {
    const q = pendingDeliveries.get(sessionId) ?? []
    q.push(frame)
    pendingDeliveries.set(sessionId, q)
    fb.staged(spawning)
    fb.done(true)
    return
  }
  resumeAndDeliver(sessionId, frame, fb)
}

function resumeAndDeliver(sessionId: string, frame: Record<string, unknown>, fb: DeliveryFeedback): void {
  const loc = sessionProjectRootOf(sessionId)
  if (!loc) {
    fb.done(false, '目标会话未在线，且磁盘上找不到该会话文件')
    return
  }
  fb.resuming()
  let p = resumingSessions.get(sessionId)
  if (!p) {
    p = spawnWebSession(sessionId, loc.projectLabel).finally(() => resumingSessions.delete(sessionId))
    resumingSessions.set(sessionId, p)
  }
  p.then(() => {
    const t0 = Date.now()
    const tryInject = (): void => {
      const t = cliClients.get(sessionId)
      if (t && t.readyState === WebSocket.OPEN) {
        try {
          t.send(JSON.stringify(frame))
          fb.done(true)
        } catch (e) {
          fb.done(false, '投递失败：' + ((e as Error)?.message ?? String(e)))
        }
      } else if (Date.now() - t0 < 5000) {
        setTimeout(tryInject, 400)
      } else {
        fb.done(false, '会话恢复后仍未连接，消息未投递')
      }
    }
    tryInject()
  }).catch((e) => {
    fb.done(false, '恢复会话失败：' + ((e as Error)?.message || e))
  })
}

function sanitizeInboundImages(
  raw: unknown,
): Array<{ id?: number; content: string; mediaType: string; filename?: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ id?: number; content: string; mediaType: string; filename?: string }> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const it = item as { id?: unknown; content?: unknown; mediaType?: unknown; filename?: unknown }
    if (typeof it.content !== 'string' || !it.content || it.content.length > 7_000_000) continue
    if (typeof it.mediaType !== 'string' || !/^image\/(png|jpeg|gif|webp)$/i.test(it.mediaType)) continue
    out.push({
      ...(typeof it.id === 'number' && Number.isInteger(it.id) && it.id > 0 ? { id: it.id } : {}),
      content: it.content,
      mediaType: it.mediaType.toLowerCase(),
      ...(typeof it.filename === 'string' && it.filename ? { filename: it.filename.slice(0, 120) } : {}),
    })
  }
  return out
}

export function handleWsMessage(ws: WebSocket, raw: string): void {
  let data: {
    type?: string
    text?: string
    requestId?: string
    allowed?: boolean
    sessionId?: string
    toolUseId?: string
    input?: unknown
    answers?: Record<string, string>
    permissions?: unknown
    /** deny 时的拒绝原因/修改意见（计划审批「告诉应该怎么改」） */
    message?: string
    images?: unknown
    caps?: unknown
    callId?: string
    ok?: boolean
    result?: unknown
    error?: unknown
  }
  try {
    data = JSON.parse(raw)
  } catch {
    return
  }
  switch (data.type) {
    case 'send': {
      const text = data.text ?? ''
      if (!text.trim()) break
      const images = sanitizeInboundImages(data.images)
      const sendPayload = images.length ? { type: 'send', text, images } : { type: 'send', text }
      if (data.sessionId) {
        const status = (state: string): void => {
          try {
            ws.send(JSON.stringify({ type: 'status', state }))
          } catch {
            /* 断开忽略 */
          }
        }
        deliverToSession(data.sessionId, sendPayload, {
          staged: (spawning) => {
            if (!spawning) status('会话连接恢复中，消息已暂存，CLI 重连后自动补投')
          },
          resuming: () => status('正在恢复会话窗口…'),
          done: (ok, error) => {
            if (!ok) status(error ?? '消息未注入')
          },
        })
        break
      }
      if (cliClients.size) {
        sendAll(cliClients.values(), (c) => c.send(JSON.stringify(sendPayload)))
      } else {
        ws.send(JSON.stringify({ type: 'status', state: '当前无在线 CLI 进程，消息未注入' }))
      }
      break
    }
    case 'interrupt': {
      if (!data.sessionId) {
        ws.send(JSON.stringify({ type: 'status', state: '缺少会话标识，无法打断' }))
        break
      }
      const target = cliClients.get(data.sessionId)
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify({ type: 'interrupt' }))
      } else {
        ws.send(JSON.stringify({ type: 'status', state: '会话未在线，无法打断' }))
      }
      break
    }
    case 'queue-nudge': {
      if (!data.sessionId) {
        ws.send(JSON.stringify({ type: 'status', state: '缺少会话标识，无法催办' }))
        break
      }
      const target = cliClients.get(data.sessionId)
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify({ type: 'queue-nudge' }))
      } else {
        ws.send(JSON.stringify({ type: 'status', state: '会话未在线，无法催办' }))
      }
      break
    }
    case 'approve': {
      const target = data.sessionId ? cliClients.get(data.sessionId) : undefined
      if (target && target.readyState === WebSocket.OPEN) {
        approvalTrailPush('floria-approve-routed', data.sessionId, data.requestId, data.allowed === true ? 'allow' : 'deny')
        let qInput: unknown = data.input ?? {}
        if (
          data.input &&
          typeof data.input === 'object' &&
          Array.isArray((data.input as { questions?: unknown }).questions)
        ) {
          qInput = (data.input as { questions: unknown }).questions
        }
        const updatedInput = data.answers ? { questions: qInput, answers: data.answers } : undefined
        // 计划审批「告诉应该怎么改」：deny 可携带用户修改意见，CLI 侧 cancelAndAbort(message) 原样回给模型；
        // 无反馈时沿用既有默认拒绝文案。
        const denyMessage =
          typeof data.message === 'string' && data.message.trim()
            ? data.message
            : '用户拒绝了该工具调用'
        target.send(
          JSON.stringify({
            type: 'approval-response',
            requestId: data.requestId ?? '',
            response:
              data.allowed === true
                ? { behavior: 'allow', updatedInput, updatedPermissions: data.permissions }
                : { behavior: 'deny', message: denyMessage },
          }),
        )
      } else {
        approvalTrailPush('floria-approve-miss', data.sessionId, data.requestId, 'target-not-online')
        ws.send(
          JSON.stringify({
            type: 'status',
            state: data.sessionId ? '目标会话未在线，审批未送达' : 'approve 尚未接入（阶段2）',
          }),
        )
        ws.send(
          JSON.stringify({
            type: 'approval-rejected',
            sessionId: data.sessionId,
            requestId: data.requestId ?? '',
          }),
        )
      }
      break
    }
    case 'subscribe': {
      const sid = data.sessionId ?? ''
      if (!sid) break
      const p = webSessions.get(sid)
      if (p) {
        p.clients.add(ws)
        ws.send(JSON.stringify({ type: 'status', state: '已订阅会话实时流' }))
      } else {
        ws.send(JSON.stringify({ type: 'status', state: 'web 会话进程未运行，未订阅' }))
      }
      pendingApprovalsReplay(ws, sid)
      break
    }
    case 'card-caps': {
      const caps = sanitizeCaps(data.caps)
      if (caps.length) cardHolders.set(ws, { ws, caps, at: Date.now() })
      else cardHolders.delete(ws)
      break
    }
    case 'card-result': {
      const id = typeof data.callId === 'string' ? data.callId : ''
      const p = id ? pendingCardCalls.get(id) : undefined
      if (!p) break
      clearTimeout(p.timer)
      pendingCardCalls.delete(id)
      p.resolve(
        data.ok === false
          ? { kind: 'err', error: String(data.error || '卡片命令失败') }
          : { kind: 'ok', result: data.result },
      )
      break
    }
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }))
      break
  }
}

const HEARTBEAT_INTERVAL_MS = 30_000
const HEARTBEAT_MAX_MISS = 2
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
const wsMisses = new WeakMap<WebSocket, number>()

export function markAlive(ws: WebSocket): void {
  wsMisses.set(ws, 0)
  ws.on('pong', () => wsMisses.set(ws, 0))
}

export function startSocketHeartbeat(): void {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => {
    for (const c of [...sockets, ...cliClients.values()]) {
      if (c.readyState !== WebSocket.OPEN) continue
      const misses = wsMisses.get(c) ?? 0
      if (misses >= HEARTBEAT_MAX_MISS) {
        console.log(`[gateway] 心跳超时（${HEARTBEAT_MAX_MISS} 次无 pong），回收僵尸连接`)
        try {
          c.terminate()
        } catch {
          /* 已断忽略 */
        }
        continue
      }
      wsMisses.set(c, misses + 1)
      try {
        c.ping()
      } catch {
        /* 已断忽略，下轮 readyState 检查兜住 */
      }
    }
  }, HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref?.()
}

export function stopSocketHeartbeat(): void {
  if (!heartbeatTimer) return
  clearInterval(heartbeatTimer)
  heartbeatTimer = null
}

export function attachWsServers(server: Server, root: string): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true })
  wss.on('connection', (ws, req) => {
    sockets.add(ws)
    wsDevice.set(ws, deviceHintOf(req))
    markAlive(ws)
    triggerIdleShutdownCheck()
    ws.on('message', (data) => {
      handleWsMessage(ws, data.toString())
    })
    ws.on('close', () => {
      sockets.delete(ws)
      dropCardHolder(ws)
      detachWebSessionClient(ws)
      triggerIdleShutdownCheck()
    })
    ws.on('error', () => {
      sockets.delete(ws)
      dropCardHolder(ws)
      detachWebSessionClient(ws)
      triggerIdleShutdownCheck()
    })
  })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`)
    const wsAuth = resolveAuth(req, url, { token: gwState.currentToken, isTicket: isGatewayTicket })
    if (!wsAuth) {
      socket.destroy()
      return
    }
    const wsCookieVal = parseCookieHeader(req.headers.cookie)[AUTH_COOKIE_NAME]
    if (wsAuth === 'ticket') {
      const hint = (url.searchParams.get('device') || '').trim()
      touchGatewayTicket(wsCookieVal, req.headers['user-agent'], remoteIPv4(req.socket.remoteAddress), hint || undefined)
    }
    if (url.pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
      return
    }
    if (url.pathname === '/clients') {
      const sid = url.searchParams.get('session') || ''
      if (!sid) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        markAlive(ws)
        const prev = cliClients.get(sid)
        if (prev && prev !== ws) {
          console.log(`[gateway] /clients 重复注册顶替旧连接 sid=${sid}（高频出现=同会话双进程乒乓）`)
          try {
            prev.close()
          } catch {
            /* 忽略 */
          }
        }
        cliClients.set(sid, ws)
        cliRegisterAt.set(sid, Date.now())
        applyPendingModelSwitch(sid)
        approvalTrailPush('cli-register', sid)
        ensureSseWatches(root)
        flushPendingDeliveries(sid)
        {
          const s = `data: ${JSON.stringify({ type: 'session-up', session: sid })}\n\n`
          sendAll(sseClients, (c) => {
            c.res.write(s)
          })
        }
        triggerIdleShutdownCheck()

        ws.on('message', (data) => {
          let m: {
            type?: string
            requestId?: string
            toolName?: string
            input?: unknown
            toolUseId?: string
            description?: string
            suggestions?: unknown
            blockedPath?: string
            response?: unknown
            items?: unknown
            tasks?: unknown
            active?: unknown
            pid?: unknown
            seq?: unknown
            anchorSid?: unknown
            messages?: unknown
            toSessionId?: unknown
            from?: unknown
            project?: unknown
            label?: unknown
            live?: unknown
            text?: unknown
            relay?: unknown
            model?: unknown
          }
          try {
            m = JSON.parse(data.toString())
          } catch {
            return
          }
          if (m.type === 'cli-hello') {
            sessionDeltaSeq.delete(sid)
            approvalTrailPush('cli-hello', sid, undefined, m.relay === true ? 'relay-on' : 'relay-off')
            if (typeof m.pid === 'number' && m.pid > 0) cliPids.set(sid, m.pid)
            if (typeof m.pid === 'number' && m.pid > 0 && (webSessions.has(sid) || spawningPromises.has(sid))) {
              const proc = webSessions.get(sid)
              if (proc && proc.pid !== m.pid) {
                proc.pid = m.pid
                persistWebSessions()
              } else if (!proc) {
                cliHelloPids.set(sid, m.pid)
              }
            }
            return
          }
          if (m.type === 'queue-state') {
            const items = Array.isArray(m.items)
              ? (m.items as Array<{ content?: unknown; ts?: unknown; from?: unknown }>)
                  .filter((it) => it && typeof it === 'object' && typeof it.content === 'string')
                  .map((it) => {
                    const f = it.from as { sid?: unknown; title?: unknown } | undefined
                    const from =
                      f && typeof f === 'object' && typeof f.title === 'string' && f.title
                        ? {
                            title: f.title.slice(0, 200),
                            ...(typeof f.sid === 'string' && f.sid ? { sid: f.sid.slice(0, 200) } : {}),
                          }
                        : undefined
                    return {
                      content: (it.content as string).slice(0, 2000),
                      ts: typeof it.ts === 'number' ? it.ts : Date.now(),
                      ...(from ? { from } : {}),
                    }
                  })
              : []
            sessionQueues.set(sid, { items, updatedAt: Date.now() })
            sweepStaleMaps()
            const s = `data: ${JSON.stringify({ type: 'queue-state', session: sid, items })}\n\n`
            sendAll(sseClients, (c) => {
              c.res.write(s)
            })
            return
          }
          if (m.type === 'task-state') {
            const tasks = normalizeGatewayTasks(m.tasks)
            sessionTasks.set(sid, { tasks, updatedAt: Date.now() })
            sweepStaleMaps()
            const s = `data: ${JSON.stringify({ type: 'task-state', session: sid, tasks })}\n\n`
            sendAll(sseClients, (c) => {
              c.res.write(s)
            })
            return
          }
          if (m.type === 'spinner-state') {
            const label = typeof m.label === 'string' ? m.label.slice(0, 60) : ''
            if (label) {
              const s = `data: ${JSON.stringify({ type: 'spinner-state', session: sid, label })}\n\n`
              sendAll(sseClients, (c) => {
                c.res.write(s)
              })
            }
            return
          }
          if (m.type === 'compact-state') {
            const s = `data: ${JSON.stringify({ type: 'compact-state', session: sid, active: m.active === true })}\n\n`
            sendAll(sseClients, (c) => {
              c.res.write(s)
            })
            return
          }
          if (m.type === 'turn-state') {
            if (m.live === false) {
              turnEndAt.set(sid, Date.now())
              persistTurnEndAt()
              turnBeatAt.delete(sid)
            }
            const s = `data: ${JSON.stringify({ type: 'turn-state', session: sid, live: m.live === true })}\n\n`
            sendAll(sseClients, (c) => {
              c.res.write(s)
            })
            return
          }
          if (m.type === 'turn-beat') {
            turnBeatAt.set(sid, Date.now())
            const s = `data: ${JSON.stringify({ type: 'turn-beat', session: sid })}\n\n`
            sendAll(sseClients, (c) => {
              c.res.write(s)
            })
            return
          }
          if (m.type === 'stream-text') {
            const text = typeof m.text === 'string' ? m.text.slice(0, 65536) : ''
            const s = `data: ${JSON.stringify({ type: 'stream-text', session: sid, text })}\n\n`
            sendAll(sseClients, (c) => {
              c.res.write(s)
            })
            return
          }
          if (m.type === 'restored') {
            const text = typeof m.text === 'string' ? m.text : ''
            const s = `data: ${JSON.stringify({ type: 'restored', session: sid, text })}\n\n`
            sendAll(sseClients, (c) => {
              c.res.write(s)
            })
            return
          }
          if (m.type === 'session-message') {
            const requestId = typeof m.requestId === 'string' ? m.requestId : ''
            const toSid = typeof m.toSessionId === 'string' ? m.toSessionId : ''
            const text = typeof m.text === 'string' ? m.text : ''
            const reply = (ok: boolean, error?: string): void => {
              if (!requestId) return
              try {
                ws.send(JSON.stringify({ type: 'session-message-result', requestId, ok, ...(error ? { error } : {}) }))
              } catch {
                /* 断开忽略 */
              }
            }
            if (!toSid) reply(false, '缺少目标会话标识')
            else if (!text.trim()) reply(false, '消息内容为空')
            else if (toSid === sid) reply(false, '目标会话就是本会话，未发送')
            else {
              deliverToSession(
                toSid,
                { type: 'session-message', text, from: m.from ?? {} },
                {
                  staged: () => {},
                  resuming: () => {},
                  done: reply,
                },
              )
            }
            return
          }
          if (m.type === 'session-create') {
            const requestId = typeof m.requestId === 'string' ? m.requestId : ''
            const project = typeof m.project === 'string' ? m.project.trim() : ''
            const text = typeof m.text === 'string' ? m.text : ''
            const modelRaw = typeof m.model === 'string' && m.model.trim() ? m.model.trim() : ''
            const f = m.from as { sid?: unknown; title?: unknown } | undefined
            const from: { sid?: string; title?: string } =
              f && typeof f === 'object' && typeof f.title === 'string' && f.title
                ? {
                    title: f.title.slice(0, 200),
                    ...(typeof f.sid === 'string' && f.sid ? { sid: f.sid.slice(0, 200) } : {}),
                  }
                : {}
            const reply = (ok: boolean, error?: string, newSid?: string): void => {
              if (!requestId) return
              try {
                ws.send(
                  JSON.stringify({
                    type: 'session-message-result',
                    requestId,
                    ok,
                    ...(newSid ? { sessionId: newSid } : {}),
                    ...(error ? { error } : {}),
                  }),
                )
              } catch {
                /* 断开忽略 */
              }
            }
            if (!project) reply(false, '缺少 project：新建会话必须指定项目')
            else if (!text.trim()) reply(false, '消息内容为空')
            else if (modelRaw && !findModelProvider(modelRaw)) {
              reply(false, `model "${modelRaw}" 不在凭据池任何供应商模型清单中`)
            } else {
              const newSid = randomUUID()
              spawnWebSession(undefined, project, newSid, modelRaw ? { model: modelRaw } : undefined)
                .then(async () => {
                  const p = join(webSessionProjectRoot(project), '.claude', 'projects', `${newSid}.jsonl`)
                  try {
                    const routed = await applySessionTitle(newSid, `${from.title ?? '未命名会话'}拉起的会话`, p)
                    approvalTrailPush('session-create-named', newSid, undefined, routed ? 'hit' : 'miss')
                    scheduleSseFlush(root)
                  } catch (e) {
                    console.error(`[gateway] session-create: 命名失败 sid=${newSid}`, e)
                    approvalTrailPush('session-create-rename-fail', newSid, undefined, (e as Error)?.message)
                  }
                  deliverToSession(
                    newSid,
                    { type: 'session-message', text, from },
                    {
                      staged: () => {},
                      resuming: () => {},
                      done: (ok, error) => reply(ok, error, ok ? newSid : undefined),
                    },
                  )
                })
                .catch((e: Error) => {
                  console.error(`[gateway] session-create: 创建失败 sid=${newSid}`, e)
                  reply(false, '创建会话失败：' + (e?.message ?? String(e)))
                })
            }
            return
          }
          if (m.type === 'session-delta') {
            const seq = typeof m.seq === 'number' && Number.isInteger(m.seq) && m.seq > 0 ? m.seq : 0
            if (!seq) return
            const last = sessionDeltaSeq.get(sid) ?? 0
            if (seq <= last) return
            sessionDeltaSeq.set(sid, seq)
            const anchorSid = typeof m.anchorSid === 'string' ? m.anchorSid : ''
            if (!anchorSid) return
            const msgs = Array.isArray(m.messages)
              ? m.messages.filter((x) => x && typeof x === 'object').slice(0, 220)
              : []
            const s = `data: ${JSON.stringify({ type: 'session-delta', session: sid, seq, anchorSid, messages: msgs })}\n\n`
            sendAll(sseClients, (c) => {
              c.res.write(s)
            })
            return
          }
          if (m.type === 'approval-request' && m.requestId) {
            approvalTrailPush('cli-approval-request', sid, m.requestId, m.toolName)
            const approvalMsg = {
              type: 'approval',
              session_id: sid,
              requestId: m.requestId,
              toolName: m.toolName,
              toolUseId: m.toolUseId,
              input: m.input,
              description: m.description,
              suggestions: m.suggestions,
              blockedPath: m.blockedPath,
            }
            pendingApprovalsSet(sid, m.requestId, approvalMsg)
            broadcast(approvalMsg)
            approvalTrailPush('gw-broadcast-approval', sid, m.requestId, `sockets=${sockets.size}`)
            return
          }
          if ((m.type === 'approval-local-resolved' || m.type === 'approval-cancel') && m.requestId) {
            approvalTrailPush('cli-local-resolved-or-cancel', sid, m.requestId, m.type)
            pendingApprovalsDrop(m.requestId)
            broadcast({ type: 'approval-dismiss', session_id: sid, requestId: m.requestId })
            return
          }
          if (m.type === 'approval-processed' && m.requestId) {
            approvalTrailPush('cli-approval-processed', sid, m.requestId)
            pendingApprovalsDrop(m.requestId)
            broadcast({ type: 'approval-confirmed', session_id: sid, requestId: m.requestId })
            approvalTrailPush('gw-approval-confirmed', sid, m.requestId)
            return
          }
        })

        const detach = () => {
          if (cliClients.get(sid) === ws) cliClients.delete(sid)
          sessionQueues.delete(sid)
          sessionModels.delete(sid)
          sessionTasks.delete(sid)
          const prevDetach = detachTimers.get(sid)
          if (prevDetach) clearTimeout(prevDetach)
          detachTimers.set(
            sid,
            setTimeout(() => {
              detachTimers.delete(sid)
              if (cliClients.has(sid)) return
              turnBeatAt.delete(sid)
              sessionActivity.delete(sid)
              cliPids.delete(sid)
              pendingApprovalsDropSession(sid)
              const down = `data: ${JSON.stringify({ type: 'activity', session: sid, state: null })}\n\n`
              sendAll(sseClients, (c) => {
                c.res.write(down)
              })
              const wp = webSessions.get(sid)
              if (wp && wp.pid && !isPidAlive(wp.pid)) {
                webSessions.delete(sid)
                persistWebSessions()
                const exited = `data: ${JSON.stringify({ type: 'session-down', session: sid })}\n\n`
                sendAll(sseClients, (c) => {
                  c.res.write(exited)
                })
              }
            }, 3000),
          )
          triggerIdleShutdownCheck()
        }
        ws.on('close', detach)
        ws.on('error', detach)
        ws.send(JSON.stringify({ type: 'registered', session: sid }))
      })
      return
    }
    socket.destroy()
  })

  return wss
}
