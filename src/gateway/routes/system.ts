import type { ServerResponse } from 'node:http'
import { isGatewayTicket, touchGatewayTicket } from '../../utils/gatewayToken.js'
import {
  cliClients,
  GATEWAY_BOOT_AT,
  sockets,
  sseClients,
  webSessions,
} from '../core/state.js'
import { triggerIdleShutdownCheck, triggerStopLocalGateway } from '../core/transport.js'
import { sendJson } from '../core/utils.js'
import { ensureSseWatches, pollSse } from '../domain/sse.js'
import { beginSafeEject } from '../domain/webSessions.js'
import { approvalTrailSnapshot } from '../domain/wsBridge.js'
import { AUTH_COOKIE_NAME } from '../httpAuth.js'
import { webAssetSource, webAssetStamp } from '../webAssets.js'
import type { RouteContext } from './types.js'

export function handleSystemRoutes(ctx: RouteContext): boolean {
  const { req, res, url, root, auth } = ctx

  if (req.method === 'GET' && url.pathname === '/gateway/activate') {
    const code = (url.searchParams.get('code') || '').trim()
    if (code && isGatewayTicket(code)) {
      const hint = (url.searchParams.get('device') || '').trim()
      if (hint) touchGatewayTicket(code, undefined, undefined, hint)
      res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${code}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`)
      sendJson(res, 200, { ok: true })
    } else {
      sendJson(res, 403, { ok: false, error: 'not authorized' })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/gateway/health') {
    sendJson(res, 200, {
      ok: true,
      mode: 'gateway',
      boot: GATEWAY_BOOT_AT,
      auth: auth ?? false,
      web: webAssetStamp(),
      webSource: webAssetSource(),
    })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/shutdown') {
    sendJson(res, 200, { ok: true, stopping: true })
    setTimeout(() => {
      triggerStopLocalGateway()
      process.exit(0)
    }, 50)
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/eject') {
    if (!process.argv.includes('--gateway')) {
      sendJson(res, 409, { ok: false, error: 'eject 仅独立网关进程（--gateway）支持' })
      return true
    }
    const r = beginSafeEject()
    if (!r) {
      sendJson(res, 409, { ok: false, error: 'already ejecting' })
      return true
    }
    sendJson(res, 200, { ok: true, ejecting: true, sessions: r.sessions, backends: r.backends })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/gateway/diagnostics') {
    sendJson(res, 200, {
      trail: approvalTrailSnapshot(),
      cliClients: [...cliClients.keys()],
      sockets: sockets.size,
      sseClients: sseClients.size,
      webSessions: [...webSessions.keys()],
    })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/gateway/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const client: { res: ServerResponse; stuckSince?: number } = { res }
    sseClients.add(client)
    triggerIdleShutdownCheck()
    res.socket?.setKeepAlive(true, 15_000)
    res.on('drain', () => {
      client.stuckSince = undefined
    })
    res.on('error', () => {
      sseClients.delete(client)
      triggerIdleShutdownCheck()
    })
    res.write(`data: ${JSON.stringify({ type: 'hello', time: Date.now() })}\n\n`)
    req.on('close', () => {
      sseClients.delete(client)
      triggerIdleShutdownCheck()
    })
    ensureSseWatches(root)
    pollSse(root)
    return true
  }

  return false
}
