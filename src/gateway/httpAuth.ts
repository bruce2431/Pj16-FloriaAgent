/**
 * httpAuth.ts —— 网关 HTTP 侧的鉴权唯一判定点。
 *
 * 三类入口（HTTP 数据接口 / WS upgrade / /backend 反代）共用同一套凭据：
 *  - `token`：网关 token（CLI 内部链路、首链 URL）
 *  - `floria_auth`：设备票证 cookie（手动配对后长期有效）
 * `floria_bp` 是同源反代票证，只在 /backend/* 消费，不属于网关授权判定。
 */
import type { IncomingMessage } from 'node:http'

export const BP_COOKIE_NAME = 'floria_bp'
export const AUTH_COOKIE_NAME = 'floria_auth'

/** 解析 Cookie 请求头为键值表（值按 URI 组件反转义；无头/坏段安全跳过） */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
    } catch {
      /* 反转义失败跳过该段 */
    }
  }
  return out
}

export interface AuthDeps {
  token: string | null
  isTicket: (v: string | undefined) => boolean
}

/** 'token' = query token 命中；'ticket' = 设备票证 cookie 命中；null = 未授权。 */
export type AuthVia = 'token' | 'ticket' | null

export function resolveAuth(req: IncomingMessage, url: URL, deps: AuthDeps): AuthVia {
  const q = url.searchParams.get('token')
  if (q && deps.token && q === deps.token) return 'token'
  const ck = parseCookieHeader(req.headers.cookie)[AUTH_COOKIE_NAME]
  if (ck && deps.isTicket(ck)) return 'ticket'
  return null
}

/** /gateway/*（health/activate 公开）与 /preview/* 需要网关授权。 */
export function isProtectedPath(pathname: string): boolean {
  return (
    (pathname.startsWith('/gateway/') && pathname !== '/gateway/health' && pathname !== '/gateway/activate') ||
    pathname.startsWith('/preview/')
  )
}
