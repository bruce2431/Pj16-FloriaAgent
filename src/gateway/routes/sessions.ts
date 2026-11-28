import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { findModelProvider, getGlobalActiveModel } from '../../utils/credentials/pool.js'
import { modelSupportsVision } from '../../utils/model/vision.js'
import {
  conversationDisplays,
  pendingModelSwitch,
  recordSessionModelLaunch,
  sessionActivity,
  sessionDeltaSeq,
  sessionEfforts,
  sessionFilesState,
  sessionModelLaunch,
  sessionModels,
  sessionQueues,
  sessionTasks,
  sessionUsageState,
  sseClients,
  sweepStaleMaps,
} from '../core/state.js'
import { sendAll } from '../core/transport.js'
import {
  isPidAlive,
  readReportBody,
  sendError,
  sendJson,
  sendReportBodyError,
} from '../core/utils.js'
import {
  applySessionTitle,
  decodeSessionPath,
  listSessions,
  mergeDisplayMessages,
  readSession,
} from '../domain/sessions.js'
import { scheduleSseFlush } from '../domain/sse.js'
import {
  gracefulStopCli,
  pendingDeliveries,
  sessionProjectRootOf,
  spawnWebSession,
  stopWebSession,
  webSessionProjectRoot,
} from '../domain/webSessions.js'
import { approvalTrailPush } from '../domain/wsBridge.js'
import type { RouteContext } from './types.js'

export async function handleSessionRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, url, root } = ctx

  if (req.method === 'GET' && url.pathname === '/gateway/sessions') {
    try {
      sendJson(res, 200, await listSessions(root))
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/wsession') {
    try {
      const parsed = await readReportBody(req)
      const resume =
        typeof parsed.resume === 'string' && parsed.resume.trim() ? parsed.resume.trim() : undefined
      const project =
        typeof parsed.project === 'string' && parsed.project.trim() ? parsed.project.trim() : undefined
      let launchModel: string | undefined
      if (typeof parsed.model === 'string' && parsed.model.trim()) {
        const m = parsed.model.trim()
        if (!findModelProvider(m)) {
          sendJson(res, 400, { error: `model "${m}" 不在凭据池任何供应商模型清单中` })
          return true
        }
        launchModel = m
      }
      const sid = resume ?? randomUUID()
      spawnWebSession(resume, project, sid, launchModel ? { model: launchModel } : undefined).catch((e) => {
        console.error(`[gateway] wsession: 后台启动失败 sid=${sid}`, e)
        pendingDeliveries.delete(sid)
        const s = `data: ${JSON.stringify({ type: 'ws-failed', session: sid, error: e?.message ?? String(e) })}\n\n`
        sendAll(sseClients, (c) => {
          c.res.write(s)
        })
      })
      let projLabel = project
      if (resume && !projLabel) projLabel = sessionProjectRootOf(resume)?.projectLabel
      const projRoot = webSessionProjectRoot(projLabel)
      const id = Buffer.from(join(projRoot, '.claude', 'projects', `${sid}.jsonl`)).toString('base64url')
      sendJson(res, 200, { id, hash: sid, resumed: !!resume, project: project ?? null, cwd: projRoot })
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/wsession/stop') {
    try {
      const parsed = await readReportBody(req)
      const id = typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id.trim() : ''
      let ok = id ? stopWebSession(id) : false
      if (!ok && id) {
        const act = sessionActivity.get(id)
        if (act && act.pid && isPidAlive(act.pid)) {
          gracefulStopCli(id, act.pid)
          sessionActivity.delete(id)
          ok = true
        }
      }
      sendJson(res, 200, { ok })
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/session/rename') {
    try {
      const parsed = await readReportBody(req)
      const id = typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id.trim() : ''
      const title = typeof parsed.title === 'string' ? parsed.title.trim() : ''
      if (!id || !title) {
        sendJson(res, 400, { error: 'id 与 title 必填' })
        return true
      }
      if (title.length > 200) {
        sendJson(res, 400, { error: '标题过长（最多 200 字符）' })
        return true
      }
      const { path: p, uuid } = decodeSessionPath(id, root)
      if (!existsSync(p)) {
        sendJson(res, 404, { error: 'session not found' })
        return true
      }
      const routed = await applySessionTitle(uuid, title, p)
      approvalTrailPush('rename-routed', uuid, undefined, routed ? 'hit' : 'miss')
      scheduleSseFlush(root)
      sendJson(res, 200, { ok: true, title })
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/gateway/session') {
    const id = url.searchParams.get('id')
    if (!id) {
      sendJson(res, 400, { error: 'missing id' })
      return true
    }
    try {
      const { uuid } = decodeSessionPath(id, root)
      const data: Record<string, unknown> = { ...readSession(id, root) }
      const disp = conversationDisplays.get(uuid)
      if (disp && Array.isArray(disp.messages) && disp.messages.length) {
        data.messages = mergeDisplayMessages(data.messages as never, disp.messages as never)
        data.display = data.messages
      }
      const sm = sessionModels.get(uuid)
      data.model = sm?.model ?? sessionModelLaunch.get(uuid)?.model ?? getGlobalActiveModel() ?? null
      data.modelTs = sm?.updatedAt ?? null
      const se = sessionEfforts.get(uuid)
      if (se) data.effort = se.effort
      const visionModel = sm?.model ?? getGlobalActiveModel()
      data.vision = visionModel ? modelSupportsVision(visionModel) : false
      data.queued = sessionQueues.get(uuid)?.items ?? []
      data.tasks = sessionTasks.get(uuid)?.tasks ?? []
      data.deltaSeq = sessionDeltaSeq.get(uuid) ?? 0
      // 2026-11-28 用量/上下文：CLI usage-state 快照原样附带（网关不算不猜；无活动 CLI → null）。
      const us = sessionUsageState.get(uuid)
      data.usage = us?.usage ?? null
      data.context = us?.context ?? null
      // 2026-11-28 摘要浮层：CLI files-state 快照原样附带（无活动 CLI → 空）。
      const fs = sessionFilesState.get(uuid)
      data.filesState = fs ? { files: fs.files, changed: fs.changed } : null
      sendJson(res, 200, data)
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/conversation') {
    try {
      const parsed = await readReportBody(req)
      const sid = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      const msgs = Array.isArray(parsed.messages) ? parsed.messages : null
      if (!sid || !msgs) {
        sendJson(res, 400, { error: 'invalid body' })
        return true
      }
      const base =
        typeof parsed.base === 'number' && Number.isInteger(parsed.base) && parsed.base >= 0 ? parsed.base : -1
      let merged = msgs
      if (base >= 0) {
        const prev = conversationDisplays.get(sid)?.messages
        if (Array.isArray(prev) && base <= prev.length) {
          merged = prev.slice(0, base).concat(msgs)
        }
      }
      conversationDisplays.set(sid, { messages: merged, updatedAt: Date.now() })
      sweepStaleMaps()
      sendJson(res, 200, { ok: true, cached: merged.length })
    } catch (error) {
      sendReportBodyError(res, error)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/activity') {
    try {
      const parsed = await readReportBody(req)
      const sid = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      const status =
        typeof parsed.status === 'string' && ['busy', 'idle', 'waiting'].includes(parsed.status)
          ? parsed.status
          : null
      if (!sid || !status) {
        sendJson(res, 400, { error: 'invalid body' })
        return true
      }
      sessionActivity.set(sid, {
        status,
        pid: Number(parsed.pid) || 0,
        cwd: typeof parsed.cwd === 'string' && parsed.cwd ? parsed.cwd : undefined,
        updatedAt: Date.now(),
      })
      sweepStaleMaps()
      const s = `data: ${JSON.stringify({ type: 'activity', session: sid, state: status })}\n\n`
      sendAll(sseClients, (c) => {
        c.res.write(s)
      })
      sendJson(res, 200, { ok: true })
    } catch (error) {
      sendReportBodyError(res, error)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/model-report') {
    try {
      const parsed = await readReportBody(req)
      const sid = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      const model = typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : ''
      const hasEffort = Object.prototype.hasOwnProperty.call(parsed, 'effort')
      const rawEffort =
        typeof parsed.effort === 'string' ? parsed.effort.trim() : parsed.effort === null ? '' : undefined
      const reportedEffort =
        !rawEffort || rawEffort === 'off' || rawEffort === 'auto' || rawEffort === 'default' ? null : rawEffort
      if (!sid || (!model && !hasEffort)) {
        sendJson(res, 400, { error: 'invalid body' })
        return true
      }
      const modelTs = Date.now()
      const PENDING_SWITCH_SENT_WINDOW_MS = 15_000
      const intent = pendingModelSwitch.get(sid)
      const modelConfirmed =
        !intent ||
        intent.model === model ||
        !intent.sentAt ||
        modelTs - intent.sentAt > PENDING_SWITCH_SENT_WINDOW_MS
      if (modelConfirmed) pendingModelSwitch.delete(sid)
      if (model && modelConfirmed) {
        sessionModels.set(sid, { model, updatedAt: modelTs })
        recordSessionModelLaunch(sid, model)
      }
      if (hasEffort) sessionEfforts.set(sid, { effort: reportedEffort ?? null, updatedAt: modelTs })
      sweepStaleMaps()
      if (model && modelConfirmed) {
        const s = `data: ${JSON.stringify({ type: 'model', session: sid, model, modelTs })}\n\n`
        sendAll(sseClients, (c) => {
          c.res.write(s)
        })
      }
      sendJson(res, 200, { ok: true })
    } catch (error) {
      sendReportBodyError(res, error)
    }
    return true
  }

  return false
}
