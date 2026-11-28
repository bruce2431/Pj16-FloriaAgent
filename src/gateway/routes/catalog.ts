import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findModelProvider, isModelInProvider } from '../../utils/credentials/pool.js'
import { CUSTOMIZATION_DISABLED_MARKER } from '../../utils/customizationToggle.js'
import { parseEffortValue, toPersistableEffort } from '../../utils/effort.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import {
  pendingModelSwitch,
  recordSessionModelLaunch,
  sessionEfforts,
} from '../core/state.js'
import { routeToClient } from '../core/transport.js'
import {
  isDir,
  readBodyWithLimit,
  readReportBody,
  ReportBodyTooLargeError,
  sendError,
  sendJson,
  sendReportBodyError,
} from '../core/utils.js'
import {
  parseGithubRepo,
  probeRepoReadme,
  probeRepoVersion,
  REPO_README_TTL_MS,
  REPO_VERSION_ERR_TTL_MS,
  REPO_VERSION_TTL_MS,
  repoReadmeCache,
  repoVersionCache,
} from '../domain/github.js'
import { listModels, listProviderCatalog } from '../domain/models.js'
import { listPlugins, readPluginDir, readSkillDir } from '../domain/plugins.js'
import { mentionElementsFor } from '../domain/preview.js'
import { findProjects, gatewayNeuronRoots } from '../domain/projects.js'
import { buildNeuronGraph, listNeuronsForGateway } from '../neuronViz.js'
import type { RouteContext } from './types.js'

export async function handleCatalogRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, url, root } = ctx

  if (req.method === 'GET' && url.pathname === '/gateway/mention-elements') {
    const elLabel = (url.searchParams.get('label') || '').trim()
    try {
      let previewDir: string
      if (elLabel) {
        const proj = findProjects(root).find((g) => g.label === elLabel)
        if (!proj) {
          sendJson(res, 404, { error: 'project not found' })
          return true
        }
        previewDir = join(resolve(proj.dir, '..', '..'), '.claude', 'preview')
      } else {
        previewDir = join(root, '.claude', 'preview')
      }
      sendJson(res, 200, {
        label: elLabel,
        ...mentionElementsFor(previewDir, join(root, '.claude', 'preview'), elLabel),
      })
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/gateway/plugins') {
    const plLabel = (url.searchParams.get('label') || '').trim()
    try {
      if (plLabel) {
        const plProj = findProjects(root).find((g) => g.label === plLabel)
        if (!plProj) {
          sendJson(res, 404, { error: 'project not found' })
          return true
        }
        const plDir = resolve(plProj.dir, '..', '..')
        sendJson(res, 200, {
          label: plLabel,
          plugins: readPluginDir(join(plDir, '.claude', 'plugins')),
          skills: readSkillDir(join(plDir, '.claude', 'skills')),
        })
        return true
      }
      sendJson(res, 200, listPlugins(root))
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/plugins/enable') {
    try {
      let eBody: unknown
      try {
        eBody = JSON.parse((await readBodyWithLimit(req, 64 * 1024)).toString('utf8') || '{}')
      } catch (e) {
        if (e instanceof ReportBodyTooLargeError) {
          sendJson(res, 413, { error: 'too large' })
          return true
        }
        throw e
      }
      if (eBody === null || typeof eBody !== 'object' || Array.isArray(eBody)) {
        sendJson(res, 400, { error: 'invalid body' })
        return true
      }
      const eb = eBody as Record<string, unknown>
      const kind = eb.kind === 'plugins' || eb.kind === 'skills' ? eb.kind : ''
      const name = typeof eb.name === 'string' ? eb.name.trim() : ''
      const enabled = eb.enabled !== false
      const eLabel = typeof eb.label === 'string' ? eb.label.trim() : ''
      if (!kind) {
        sendJson(res, 400, { error: 'kind 必须是 plugins 或 skills' })
        return true
      }
      if (!name || name === '.' || name === '..' || name.startsWith('.') || /[\\/]/.test(name)) {
        sendJson(res, 400, { error: 'name 非法（只接受直接子目录名）' })
        return true
      }
      let eBase: string
      if (eLabel) {
        const eProj = findProjects(root).find((g) => g.label === eLabel)
        if (!eProj) {
          sendJson(res, 404, { error: 'project not found' })
          return true
        }
        eBase = join(resolve(eProj.dir, '..', '..'), '.claude', kind)
      } else {
        eBase = join(root, '.claude', kind)
      }
      const eDir = join(eBase, name)
      if (!isDir(eDir)) {
        sendJson(res, 404, { error: '目录不存在' })
        return true
      }
      const eIsPlugin = existsSync(join(eDir, '.claude-plugin', 'plugin.json'))
      const eIsSkill = existsSync(join(eDir, 'SKILL.md'))
      if (kind === 'plugins' ? !eIsPlugin : !eIsSkill) {
        sendJson(res, 400, { error: kind === 'plugins' ? '该目录不是插件' : '该目录不是技能' })
        return true
      }
      const eMarker = join(eDir, CUSTOMIZATION_DISABLED_MARKER)
      if (enabled) {
        if (existsSync(eMarker)) unlinkSync(eMarker)
      } else if (!existsSync(eMarker)) {
        writeFileSync(eMarker, '')
      }
      sendJson(res, 200, { ok: true, kind, name, enabled })
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/gateway/models') {
    try {
      sendJson(res, 200, listModels(root))
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/gateway/models/catalog') {
    try {
      const name = (url.searchParams.get('provider') || '').trim()
      if (!name) {
        sendJson(res, 400, { error: '缺少 provider 参数' })
        return true
      }
      sendJson(res, 200, await listProviderCatalog(name))
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/gateway/neurons') {
    try {
      sendJson(res, 200, listNeuronsForGateway(gatewayNeuronRoots()))
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/gateway/neurons/graph') {
    try {
      const id = (url.searchParams.get('id') || '').trim()
      if (!id) {
        sendJson(res, 400, { error: '缺少 id 参数' })
        return true
      }
      sendJson(res, 200, buildNeuronGraph(id, gatewayNeuronRoots(), url.searchParams.get('res') || undefined))
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/model') {
    try {
      const parsed = await readReportBody(req)
      const model = typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : undefined
      const sessionId =
        typeof parsed.sessionId === 'string' && parsed.sessionId.trim() ? parsed.sessionId.trim() : undefined
      const rawEffort =
        typeof parsed.effortLevel === 'string' && parsed.effortLevel.trim() ? parsed.effortLevel.trim() : undefined
      const effortLevel =
        rawEffort === 'off' || rawEffort === 'auto' || rawEffort === 'default' ? null : rawEffort
      if (model === undefined && effortLevel === undefined) {
        sendJson(res, 400, { error: 'invalid body' })
        return true
      }
      let modelProvider: string | null = null
      let modelApplied = true
      if (model !== undefined) {
        const preferred =
          typeof parsed.provider === 'string' && parsed.provider.trim() ? parsed.provider.trim() : undefined
        if (preferred !== undefined) {
          if (!isModelInProvider(preferred, model)) {
            sendJson(res, 400, { error: `供应商 "${preferred}" 不存在或其模型清单不含 "${model}"` })
            return true
          }
          modelProvider = preferred
        } else {
          modelProvider = findModelProvider(model)
          if (!modelProvider) {
            sendJson(res, 400, { error: `model "${model}" 不在凭据池任何供应商模型清单中` })
            return true
          }
        }
      }
      if (effortLevel !== undefined && !sessionId) {
        const persistable = toPersistableEffort(parseEffortValue(effortLevel))
        const r = updateSettingsForSource('userSettings', { effortLevel: persistable })
        if (r.error) {
          sendJson(res, 500, { error: `写 settings.json 失败：${r.error.message}` })
          return true
        }
      }
      if (model !== undefined) {
        if (!sessionId) {
          sendJson(res, 400, { error: '目标会话未在线，无法切换模型' })
          return true
        }
        recordSessionModelLaunch(sessionId, model, modelProvider ?? undefined)
        if (routeToClient(sessionId, { type: 'model', value: model, provider: modelProvider })) {
          pendingModelSwitch.delete(sessionId)
        } else {
          pendingModelSwitch.set(sessionId, { model, ...(modelProvider ? { provider: modelProvider } : {}) })
          modelApplied = false
        }
      }
      if (effortLevel !== undefined && sessionId) {
        if (!routeToClient(sessionId, { type: 'effort', value: effortLevel })) {
          sendJson(res, 400, { error: '目标会话未在线，无法切换思考等级' })
          return true
        }
        sessionEfforts.set(sessionId, { effort: effortLevel, updatedAt: Date.now() })
      }
      sendJson(res, 200, { ok: true, model: model ?? null, effortLevel: effortLevel ?? null, applied: modelApplied })
    } catch (error) {
      sendReportBodyError(res, error)
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/gateway/repo-version') {
    const repoUrl = (url.searchParams.get('repo') || '').trim()
    const g = parseGithubRepo(repoUrl)
    if (!g) {
      sendJson(res, 400, { error: '仅支持 https://github.com/<owner>/<repo>' })
      return true
    }
    const key = `${g.owner}/${g.repo}`.toLowerCase()
    const hit = repoVersionCache.get(key)
    const ttl = hit && hit.version ? REPO_VERSION_TTL_MS : REPO_VERSION_ERR_TTL_MS
    if (hit && Date.now() - hit.at < ttl) {
      sendJson(res, 200, { version: hit.version, source: hit.source, error: hit.error })
      return true
    }
    const entry = await probeRepoVersion(g)
    repoVersionCache.set(key, entry)
    sendJson(res, 200, { version: entry.version, source: entry.source, error: entry.error })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/gateway/repo-readme') {
    const repoUrl = (url.searchParams.get('repo') || '').trim()
    const g = parseGithubRepo(repoUrl)
    if (!g) {
      sendJson(res, 400, { error: '仅支持 https://github.com/<owner>/<repo>' })
      return true
    }
    const sub = (url.searchParams.get('path') || '').trim().replace(/^\/+|\/+$/g, '')
    if (sub && (sub.includes('..') || sub.includes('\\'))) {
      sendJson(res, 400, { error: '非法的子目录' })
      return true
    }
    const key = `${g.owner}/${g.repo}/${sub}`.toLowerCase()
    const hit = repoReadmeCache.get(key)
    const ttl = hit && hit.text ? REPO_README_TTL_MS : REPO_VERSION_ERR_TTL_MS
    if (hit && Date.now() - hit.at < ttl) {
      sendJson(res, 200, { name: hit.name, text: hit.text, error: hit.error })
      return true
    }
    const entry = await probeRepoReadme(g, sub)
    repoReadmeCache.set(key, entry)
    sendJson(res, 200, { name: entry.name, text: entry.text, error: entry.error })
    return true
  }

  return false
}
