import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { CUSTOMIZATION_DISABLED_MARKER } from '../../utils/customizationToggle.js'
import {
  backendProcesses,
  BP_COOKIE_KEY_RE,
  BP_COOKIE_TTL_MS,
  bpSessions,
  sockets,
  sweepBpSessions,
} from '../core/state.js'
import type { BackendProc } from '../core/types.js'
import {
  isDir,
  MIME,
  readBodyWithLimit,
  readReportBody,
  ReportBodyTooLargeError,
  sendError,
  sendJson,
  sendReportBodyError,
} from '../core/utils.js'
import { backendProcAlive, ensureBackend, proxyBackendRequest } from '../domain/backends.js'
import { callBrowserCard, cardHolders, listAllCaps, pickCardHolder, pickLatestHolder } from '../domain/cards.js'
import {
  cardBackendKey,
  findEnabledCardBackend,
  findEnabledCardBackendBySeg,
  PREVIEW_INDEX_CARD_ID,
  previewDirOf,
  publicPreviewCard,
  readBackendCfg,
  readPreviewCards,
  readPreviewPaneCards,
  readPreviewQuoteActions,
} from '../domain/preview.js'
import { findProjects } from '../domain/projects.js'
import { BP_COOKIE_NAME, parseCookieHeader } from '../httpAuth.js'
import type { RouteContext } from './types.js'

export async function handlePreviewRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, url, root, auth } = ctx

  if (req.method === 'GET' && url.pathname === '/gateway/backend') {
    const bLabel = (url.searchParams.get('label') || '').trim()
    const bCardId = (url.searchParams.get('card') || '').trim()
    const bProj = findProjects(root).find((g) => g.label === bLabel && g.hasPreview)
    if (!bProj) {
      sendJson(res, 404, { error: 'no backend for project' })
      return true
    }
    const bPreviewDir = previewDirOf(bProj)
    const bCard = bCardId ? findEnabledCardBackend(bPreviewDir, bCardId) : undefined
    if (bCardId && !bCard) {
      sendJson(res, 404, { error: 'no backend for card' })
      return true
    }
    const bKey = bCard ? cardBackendKey(bLabel, bCard.id) : bLabel
    const bCfg = bCard ? bCard.cfg : readBackendCfg(bPreviewDir)
    if (!bCfg) {
      sendJson(res, 404, { error: 'no backend for project' })
      return true
    }
    try {
      const pre = backendProcesses.get(bKey)
      const alreadyRunning = !!(pre && backendProcAlive(pre))
      const proc = await ensureBackend(bKey, bCfg)
      sweepBpSessions()
      const ckJar = parseCookieHeader(req.headers.cookie)
      let ckKey = ckJar[BP_COOKIE_NAME]
      let bpSess = ckKey && BP_COOKIE_KEY_RE.test(ckKey) ? bpSessions.get(ckKey) : undefined
      if (!bpSess) {
        ckKey = randomBytes(16).toString('hex')
        bpSess = { labels: new Set<string>(), expires: 0 }
        bpSessions.set(ckKey, bpSess)
      }
      bpSess.labels.add(bLabel)
      bpSess.expires = Date.now() + BP_COOKIE_TTL_MS
      res.setHeader('Set-Cookie', `${BP_COOKIE_NAME}=${ckKey}; Path=/backend; HttpOnly; SameSite=Lax; Max-Age=86400`)
      sendJson(res, 200, {
        url: `http://127.0.0.1:${proc.port}/`,
        port: proc.port,
        pid: proc.pid,
        name: proc.cfg.name || (bCard ? bCard.id : bLabel),
        alreadyRunning,
      })
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/gateway/preview-cards') {
    const cLabel = url.searchParams.get('label') || ''
    const cProj = findProjects(root).find((g) => g.label === cLabel)
    if (!cProj || !cProj.hasPreview) {
      sendJson(res, 404, { error: 'project not found' })
      return true
    }
    try {
      const cDir = resolve(cProj.dir, '..', 'preview')
      sendJson(res, 200, {
        label: cLabel,
        cards: readPreviewCards(cDir).map(publicPreviewCard),
        quoteActions: readPreviewQuoteActions(cDir),
        previewCards: readPreviewPaneCards(cDir).map(publicPreviewCard),
        hasIndex: existsSync(join(cDir, 'index.html')),
        indexEnabled: !existsSync(join(cDir, CUSTOMIZATION_DISABLED_MARKER)),
      })
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/preview-cards/enable') {
    try {
      let evBody: unknown
      try {
        evBody = JSON.parse((await readBodyWithLimit(req, 64 * 1024)).toString('utf8') || '{}')
      } catch (e) {
        if (e instanceof ReportBodyTooLargeError) {
          sendJson(res, 413, { error: 'too large' })
          return true
        }
        throw e
      }
      if (evBody === null || typeof evBody !== 'object' || Array.isArray(evBody)) {
        sendJson(res, 400, { error: 'invalid body' })
        return true
      }
      const ev = evBody as Record<string, unknown>
      const evLabel = typeof ev.label === 'string' ? ev.label.trim() : ''
      const evCard = typeof ev.card === 'string' ? ev.card.trim() : ''
      const evEnabled = ev.enabled !== false
      if (!evLabel || !evCard) {
        sendJson(res, 400, { error: 'label/card 必填' })
        return true
      }
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(evCard)) {
        sendJson(res, 400, { error: 'card 非法' })
        return true
      }
      const evProj = findProjects(root).find((g) => g.label === evLabel && g.hasPreview)
      if (!evProj) {
        sendJson(res, 404, { error: 'project not found' })
        return true
      }
      const evPreview = previewDirOf(evProj)
      let evDir = ''
      if (evCard === PREVIEW_INDEX_CARD_ID) {
        if (!existsSync(join(evPreview, 'index.html'))) {
          sendJson(res, 404, { error: 'card not found' })
          return true
        }
        evDir = evPreview
      } else if (readPreviewPaneCards(evPreview).some((c) => c.id === evCard)) {
        evDir = join(evPreview, evCard)
      } else {
        const app = readPreviewCards(evPreview).find((c) => c.id === evCard)
        const first = app ? (app.path.split('#')[0] || '').split('/')[0] : ''
        if (first) evDir = join(evPreview, first)
      }
      const evTarget = evDir ? resolve(evDir) : ''
      if (!evTarget || !isDir(evTarget) || (evTarget !== evPreview && !evTarget.startsWith(evPreview + sep))) {
        sendJson(res, 404, { error: 'card not found' })
        return true
      }
      const evMarker = join(evTarget, CUSTOMIZATION_DISABLED_MARKER)
      if (evEnabled) {
        if (existsSync(evMarker)) unlinkSync(evMarker)
      } else if (!existsSync(evMarker)) {
        writeFileSync(evMarker, '')
      }
      sendJson(res, 200, { ok: true, label: evLabel, card: evCard, enabled: evEnabled })
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/gateway/cards') {
    sendJson(res, 200, { devices: cardHolders.size, cards: listAllCaps() })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/card-call') {
    let cc: Record<string, unknown>
    try {
      cc = await readReportBody(req)
    } catch (e) {
      sendReportBodyError(res, e)
      return true
    }
    const ccCmd = typeof cc.cmd === 'string' ? cc.cmd.trim() : ''
    if (!ccCmd) {
      sendJson(res, 400, { error: 'missing cmd' })
      return true
    }
    if (ccCmd === 'card:open') {
      const coArgs = cc.args && typeof cc.args === 'object' ? (cc.args as Record<string, unknown>) : {}
      const coLabel = typeof coArgs.label === 'string' ? coArgs.label.trim() : ''
      if (!coLabel) {
        sendJson(res, 400, { error: 'card:open 需要 args.label（项目 label）' })
        return true
      }
      if (!sockets.size) {
        sendJson(res, 503, { error: '当前无浏览器在线，卡片命令无处可达' })
        return true
      }
      const coHit = pickLatestHolder()
      if (!coHit) {
        sendJson(res, 503, { error: '在线浏览器均未上报卡片能力表，无法执行整卡显隐' })
        return true
      }
      const coTimeout = Math.max(500, Math.min(Number.isFinite(cc.timeoutMs) ? Number(cc.timeoutMs) : 8000, 60000))
      const coOut = await callBrowserCard(coHit.ws, { label: coLabel }, ccCmd, { label: coLabel }, coTimeout)
      const coWhere = { instanceId: coHit.cap.instanceId, label: coHit.cap.label, ns: coHit.cap.ns }
      if (coOut.kind === 'ok') sendJson(res, 200, { ok: true, result: coOut.result, card: coWhere })
      else if (coOut.kind === 'err') sendJson(res, 200, { ok: false, error: coOut.error, card: coWhere })
      else if (coOut.kind === 'timeout') {
        sendJson(res, 504, { error: `卡片命令超时（${coTimeout}ms）：${ccCmd}`, card: coWhere })
      } else sendJson(res, 504, { error: '持卡设备已断开', card: coWhere })
      return true
    }
    const ccTarget = {
      label: typeof cc.label === 'string' ? cc.label : '',
      ns: typeof cc.ns === 'string' ? cc.ns : '',
      instanceId: typeof cc.instanceId === 'string' ? cc.instanceId : '',
    }
    if (!ccTarget.label && !ccTarget.ns && !ccTarget.instanceId) {
      sendJson(res, 400, { error: 'missing target (label / ns / instanceId 至少其一)' })
      return true
    }
    if (!sockets.size) {
      sendJson(res, 503, { error: '当前无浏览器在线，卡片命令无处可达' })
      return true
    }
    const ccHit = pickCardHolder(ccTarget)
    if (!ccHit) {
      sendJson(res, 409, { error: '目标卡不在场', target: ccTarget, cards: listAllCaps() })
      return true
    }
    const ccTimeout = Math.max(500, Math.min(Number.isFinite(cc.timeoutMs) ? Number(cc.timeoutMs) : 8000, 60000))
    const ccOut = await callBrowserCard(ccHit.ws, ccTarget, ccCmd, cc.args ?? {}, ccTimeout)
    const ccWhere = { instanceId: ccHit.cap.instanceId, label: ccHit.cap.label, ns: ccHit.cap.ns }
    if (ccOut.kind === 'ok') sendJson(res, 200, { ok: true, result: ccOut.result, card: ccWhere })
    else if (ccOut.kind === 'err') sendJson(res, 200, { ok: false, error: ccOut.error, card: ccWhere })
    else if (ccOut.kind === 'timeout') {
      sendJson(res, 504, { error: `卡片命令超时（${ccTimeout}ms）：${ccCmd}`, card: ccWhere })
    } else sendJson(res, 504, { error: '持卡设备已断开', card: ccWhere })
    return true
  }

  const bpMatch = /^\/(?:backend|bp)\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(req.url ?? '')
  if (bpMatch) {
    let bpLabel = ''
    try {
      bpLabel = decodeURIComponent(bpMatch[1])
    } catch {
      bpLabel = bpMatch[1]
    }
    const bpJar = parseCookieHeader(req.headers.cookie)
    let bpCookieKey = bpJar[BP_COOKIE_NAME]
    let bpTicket = bpCookieKey && BP_COOKIE_KEY_RE.test(bpCookieKey) ? bpSessions.get(bpCookieKey) : undefined
    if (!bpTicket || !bpTicket.labels.has(bpLabel)) {
      if (!auth) {
        sendJson(res, 401, { error: 'unauthorized' })
        return true
      }
      sweepBpSessions()
      if (!bpTicket) {
        if (!bpCookieKey || !BP_COOKIE_KEY_RE.test(bpCookieKey)) bpCookieKey = randomBytes(16).toString('hex')
        bpTicket = { labels: new Set<string>(), expires: 0 }
        bpSessions.set(bpCookieKey, bpTicket)
        res.setHeader('Set-Cookie', `${BP_COOKIE_NAME}=${bpCookieKey}; Path=/backend; HttpOnly; SameSite=Lax; Max-Age=86400`)
      }
      bpTicket.labels.add(bpLabel)
      bpTicket.expires = Date.now() + BP_COOKIE_TTL_MS
    }
    const bpProj = findProjects(root).find((g) => g.label === bpLabel && g.hasPreview)
    if (!bpProj) {
      sendJson(res, 404, { error: 'no backend for project' })
      return true
    }
    const bpPreviewDir = previewDirOf(bpProj)
    let bpSeg = ''
    try {
      bpSeg = decodeURIComponent((bpMatch[2] || '/').split('/').filter(Boolean)[0] || '')
    } catch {
      bpSeg = ''
    }
    const bpCard = findEnabledCardBackendBySeg(bpPreviewDir, bpSeg)
    const bpKey = bpCard ? cardBackendKey(bpLabel, bpCard.id) : bpLabel
    const bpCfg = bpCard ? bpCard.cfg : readBackendCfg(bpPreviewDir)
    if (!bpCfg) {
      sendJson(res, 404, { error: 'no backend for project' })
      return true
    }
    let bpProc: BackendProc
    try {
      bpProc = await ensureBackend(bpKey, bpCfg)
    } catch (e) {
      sendError(res, e)
      return true
    }
    bpTicket.expires = Date.now() + BP_COOKIE_TTL_MS
    proxyBackendRequest(req, res, bpProc, `/backend/${bpMatch[1]}`, bpMatch[2] || '/', bpMatch[3] || '')
    return true
  }

  const pvMatch = /^\/preview\/([^/]+)((?:\/.*)?)$/.exec(url.pathname)
  if (req.method === 'GET' && pvMatch) {
    let pvLabel = pvMatch[1]
    try {
      pvLabel = decodeURIComponent(pvMatch[1])
    } catch {
      /* 保留原文 */
    }
    let pvRel = (pvMatch[2] || '').replace(/^\//, '') || 'index.html'
    try {
      pvRel = decodeURIComponent(pvRel)
    } catch {
      /* 保留原文 */
    }
    const pvProj = findProjects(root).find((g) => g.label === pvLabel && g.hasPreview)
    if (!pvProj) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return true
    }
    const pvDir = join(pvProj.dir, '..', 'preview')
    const pvFile = resolve(pvDir, pvRel)
    if (pvFile !== pvDir && !pvFile.startsWith(pvDir + sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Forbidden')
      return true
    }
    if (!existsSync(pvFile) || !statSync(pvFile).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return true
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(pvFile)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    })
    res.end(readFileSync(pvFile))
    return true
  }

  return false
}
