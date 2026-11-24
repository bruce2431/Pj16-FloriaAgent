import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthVia } from '../httpAuth.js'

export interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  root: string
  auth: AuthVia
}

export type RouteHandler = (ctx: RouteContext) => Promise<boolean> | boolean
