import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, resolve } from 'node:path'
import { addGatewayTicket, isGatewayTicket, touchGatewayTicket } from '../../utils/gatewayToken.js'
import { mdnsPushToReachableClient } from '../core/mdns.js'
import { gwState } from '../core/state.js'
import { isPathInside, MIME, publicDir, remoteIPv4, sendJson } from '../core/utils.js'
import { AUTH_COOKIE_NAME, isProtectedPath, parseCookieHeader, resolveAuth } from '../httpAuth.js'
import { readWebAsset } from '../webAssets.js'
import { handleCatalogRoutes } from './catalog.js'
import { handleFileRoutes } from './files.js'
import { handlePreviewRoutes } from './preview.js'
import { handleSessionRoutes } from './sessions.js'
import { handleSystemRoutes } from './system.js'
import type { RouteContext, RouteHandler } from './types.js'

const ROUTE_HANDLERS: RouteHandler[] = [
  handleSystemRoutes,
  handleCatalogRoutes,
  handleSessionRoutes,
  handlePreviewRoutes,
  handleFileRoutes,
]

export async function handleRequest(req: IncomingMessage, res: ServerResponse, root: string): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`)
  try {
    mdnsPushToReachableClient(req.socket.remoteAddress ?? '')
  } catch {
    /* 推送失败不影响请求 */
  }

  const auth = resolveAuth(req, url, { token: gwState.currentToken, isTicket: isGatewayTicket })
  const isProtected = isProtectedPath(url.pathname)
  if (isProtected && !auth) {
    sendJson(res, 401, { error: 'unauthorized' })
    return
  }
  if (isProtected && auth === 'ticket') {
    touchGatewayTicket(
      parseCookieHeader(req.headers.cookie)[AUTH_COOKIE_NAME],
      req.headers['user-agent'],
      remoteIPv4(req.socket.remoteAddress),
    )
  }
  if (auth === 'token' && req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) {
    const cur = parseCookieHeader(req.headers.cookie)[AUTH_COOKIE_NAME]
    if (!cur || !isGatewayTicket(cur)) {
      const ticket = randomBytes(24).toString('hex')
      addGatewayTicket(ticket)
      res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${ticket}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`)
    }
  }

  const ctx: RouteContext = { req, res, url, root, auth }
  for (const handler of ROUTE_HANDLERS) {
    if (await handler(ctx)) return
  }

  const isSpaRoute = /^\/(?:session\/|s\/|manage\/|mgr(?:\/|$)|project\/|pview\/)/.test(url.pathname)
  const rel = isSpaRoute || url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '')
  const embedded = readWebAsset(rel)
  if (embedded) {
    res.writeHead(200, {
      'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    })
    res.end(embedded)
    return
  }
  const pub = publicDir(root)
  const file = resolve(pub, rel)
  if (!isPathInside(pub, file) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
    return
  }
  const body = readFileSync(file)
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  })
  res.end(body)
}
