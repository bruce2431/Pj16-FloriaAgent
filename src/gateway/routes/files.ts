import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { getProjectRoot } from '../../bootstrap/state.js'
import { FILE_CACHE_DIR, getFileCacheDir, PENDING_FILE_DIR } from '../../utils/fileCache.js'
import type { UploadKind } from '../core/types.js'
import {
  MAX_FILE_WRITE_BYTES,
  MIME,
  readBodyWithLimit,
  readReportBody,
  ReportBodyTooLargeError,
  resolveWithinRoot,
  sanitizeEntryName,
  sendError,
  sendJson,
  sendReportBodyError,
  sniffBinary,
} from '../core/utils.js'
import {
  archiveProjectEntry,
  createProjectEntry,
  moveProjectEntry,
  readFileHistory,
  readProjectComments,
  renameProjectEntry,
  revealInExplorer,
  trashProjectEntry,
  writeProjectComments,
  writeProjectFile,
} from '../domain/files.js'
import { archiveProject, deleteTempProject, renameProjectDir } from '../domain/projectOps.js'
import {
  deriveProjectDescription,
  findProjectReadme,
  findProjects,
  listOneLevel,
  TREE_BUDGET,
  walkProjectTree,
} from '../domain/projects.js'
import { listSessions, resolveUploadSession } from '../domain/sessions.js'
import { ensureSseWatches } from '../domain/sse.js'
import {
  buildUploadReference,
  resolveUploadSlot,
  stampUploadName,
  storeUploadFile,
  uploadProjectFile,
} from '../domain/uploads.js'
import { webSessionProjectRoot } from '../domain/webSessions.js'
import type { RouteContext } from './types.js'

export async function handleFileRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, url, root } = ctx

  if (req.method === 'GET' && url.pathname === '/gateway/project') {
    const pLabel = url.searchParams.get('label') || ''
    const pProj = findProjects(root).find((g) => g.label === pLabel)
    if (!pProj) {
      sendJson(res, 404, { error: 'project not found' })
      return true
    }
    try {
      const pDir = resolve(pProj.dir, '..', '..')
      const budget = { n: TREE_BUDGET }
      const files = walkProjectTree(pDir, budget) ?? []
      const readme = findProjectReadme(pDir)
      const list = await listSessions(root)
      const pSessions = (list.sessions as Array<Record<string, unknown>>)
        .filter((s) => s.projectScope === pProj.scope && s.projectLabel === pLabel)
        .map((s) => ({
          hash: String(s.file).replace(/\.jsonl$/, ''),
          id: s.id,
          title: s.title,
          messageCount: s.messageCount,
          updatedAt: s.updatedAt,
        }))
        .slice(0, 100)
      sendJson(res, 200, {
        label: pLabel,
        scope: pProj.scope,
        hasPreview: pProj.hasPreview,
        description: deriveProjectDescription(readme, pLabel),
        files,
        readme,
        sessionCount: pSessions.length,
        sessions: pSessions,
        lastActive: pSessions.length ? (pSessions[0].updatedAt as number) : 0,
      })
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/gateway/file') {
    const fLabel = url.searchParams.get('label') || ''
    const fPath = url.searchParams.get('path') || ''
    const fDl = url.searchParams.get('dl') === '1'
    let fDir: string
    const fProj = findProjects(root).find((g) => g.label === fLabel)
    if (fProj) {
      fDir = resolve(fProj.dir, '..', '..')
    } else if (!fLabel) {
      if ((fPath.split(/[\\/]/)[0] || '').startsWith('.')) {
        sendJson(res, 403, { error: 'forbidden' })
        return true
      }
      fDir = root
    } else {
      sendJson(res, 404, { error: 'project not found' })
      return true
    }
    const fAbs = resolve(fDir, fPath)
    if (fAbs !== fDir && !fAbs.startsWith(fDir + sep)) {
      sendJson(res, 403, { error: 'forbidden' })
      return true
    }
    if (!existsSync(fAbs) || !statSync(fAbs).isFile()) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    const fStat = statSync(fAbs)
    if (!fDl && fStat.size > 4 * 1024 * 1024) {
      sendJson(res, 413, { error: 'too large' })
      return true
    }
    const fMtime = fStat.mtimeMs
    const fHeaders: Record<string, string> = {
      'Cache-Control': 'no-cache',
      ETag: `"${fMtime}"`,
      'Last-Modified': new Date(fMtime).toUTCString(),
    }
    if (fDl) {
      const fName = basename(fAbs)
      const fAscii = fName.replace(/[^\x20-\x7e]|["\\]/g, '_')
      const fEnc = encodeURIComponent(fName).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
      fHeaders['Content-Length'] = String(fStat.size)
      fHeaders['Content-Disposition'] = `attachment; filename="${fAscii}"; filename*=UTF-8''${fEnc}`
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, fHeaders)
      res.end()
      return true
    }
    if (fDl) {
      res.writeHead(200, { ...fHeaders, 'Content-Type': 'application/octet-stream' })
      const fStream = createReadStream(fAbs)
      fStream.on('error', () => res.destroy())
      fStream.pipe(res)
      return true
    }
    const fBuf = readFileSync(fAbs)
    const fType = MIME[extname(fAbs)] ?? (sniffBinary(fBuf) ? 'application/octet-stream' : 'text/plain; charset=utf-8')
    res.writeHead(200, { ...fHeaders, 'Content-Type': fType })
    res.end(fBuf)
    return true
  }

  if (req.method === 'GET' && url.pathname === '/gateway/file-history') {
    const hLabel = url.searchParams.get('label') || ''
    const hPath = url.searchParams.get('path') || ''
    const hSession = url.searchParams.get('session') || ''
    const data = readFileHistory(root, hLabel, hPath, hSession)
    sendJson(res, data.status, data.body)
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/file/rename') {
    try {
      const rp = await readReportBody(req)
      const rProj = findProjects(root).find((g) => g.label === (typeof rp.label === 'string' ? rp.label : ''))
      if (!rProj) {
        sendJson(res, 404, { error: 'project not found' })
        return true
      }
      const rOut = renameProjectEntry(
        resolve(rProj.dir, '..', '..'),
        typeof rp.path === 'string' ? rp.path : '',
        typeof rp.name === 'string' ? rp.name : '',
      )
      if (!rOut.ok) sendJson(res, rOut.code, { error: rOut.error })
      else sendJson(res, 200, rOut)
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/file/move') {
    try {
      const mp = await readReportBody(req)
      const mProj = findProjects(root).find((g) => g.label === (typeof mp.label === 'string' ? mp.label : ''))
      if (!mProj) {
        sendJson(res, 404, { error: 'project not found' })
        return true
      }
      const mOut = moveProjectEntry(
        resolve(mProj.dir, '..', '..'),
        typeof mp.path === 'string' ? mp.path : '',
        typeof mp.dir === 'string' ? mp.dir : '',
      )
      if (!mOut.ok) sendJson(res, mOut.code, { error: mOut.error })
      else sendJson(res, 200, mOut)
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/file/write') {
    try {
      let wBody: unknown
      try {
        wBody = JSON.parse((await readBodyWithLimit(req, MAX_FILE_WRITE_BYTES)).toString('utf8') || '{}')
      } catch (e) {
        if (e instanceof ReportBodyTooLargeError) {
          sendJson(res, 413, { error: 'too large' })
          return true
        }
        throw e
      }
      if (wBody === null || typeof wBody !== 'object' || Array.isArray(wBody)) {
        sendJson(res, 400, { error: 'invalid body' })
        return true
      }
      const wp = wBody as Record<string, unknown>
      let wsid: string | undefined
      if (wp.sid !== undefined && wp.sid !== null && wp.sid !== '') {
        if (typeof wp.sid !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(wp.sid)) {
          sendJson(res, 400, { error: 'invalid sid' })
          return true
        }
        wsid = wp.sid
      }
      const wProj = findProjects(root).find((g) => g.label === (typeof wp.label === 'string' ? wp.label : ''))
      if (!wProj) {
        sendJson(res, 404, { error: 'project not found' })
        return true
      }
      const wOut = writeProjectFile(
        resolve(wProj.dir, '..', '..'),
        typeof wp.path === 'string' ? wp.path : '',
        typeof wp.content === 'string' ? wp.content : '',
        typeof wp.baseMtime === 'number' ? wp.baseMtime : undefined,
        { writer: 'web', sid: wsid },
      )
      if (!wOut.ok) sendJson(res, wOut.code, { error: wOut.error })
      else sendJson(res, 200, wOut)
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/gateway/comments') {
    const cLabel = url.searchParams.get('label') || ''
    const cProj = findProjects(root).find((g) => g.scope === 'project' && g.label === cLabel)
    if (!cProj) {
      sendJson(res, 404, { error: 'project not found' })
      return true
    }
    sendJson(res, 200, { comments: readProjectComments(resolve(cProj.dir, '..', '..')) })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/comments') {
    try {
      const cb = await readReportBody(req)
      const cProj = findProjects(root).find(
        (g) => g.scope === 'project' && g.label === (typeof cb.label === 'string' ? cb.label : ''),
      )
      if (!cProj) {
        sendJson(res, 404, { error: 'project not found' })
        return true
      }
      const cOut = writeProjectComments(
        resolve(cProj.dir, '..', '..'),
        Array.isArray(cb.comments) ? cb.comments : [],
      )
      if (!cOut.ok) sendJson(res, cOut.code, { error: cOut.error })
      else sendJson(res, 200, cOut)
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/project/archive') {
    try {
      const ap = await readReportBody(req)
      const aLabel = typeof ap.label === 'string' ? ap.label : ''
      if (!findProjects(root).some((g) => g.scope === 'project' && g.label === aLabel)) {
        sendJson(res, 404, { error: 'project not found' })
        return true
      }
      const aOut = await archiveProject(root, aLabel)
      if (!aOut.ok) sendJson(res, aOut.code, { error: aOut.error })
      else sendJson(res, 200, aOut)
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/project/delete') {
    try {
      const dpj = await readReportBody(req)
      const dLabel = typeof dpj.label === 'string' ? dpj.label : ''
      if (!findProjects(root).some((g) => g.scope === 'project' && g.label === dLabel)) {
        sendJson(res, 404, { error: 'project not found' })
        return true
      }
      const dOut = deleteTempProject(root, dLabel)
      if (!dOut.ok) sendJson(res, dOut.code, { error: dOut.error })
      else sendJson(res, 200, dOut)
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/project/rename') {
    try {
      const rpj = await readReportBody(req)
      const rLabel = typeof rpj.label === 'string' ? rpj.label : ''
      const rName = typeof rpj.name === 'string' ? rpj.name : ''
      if (!findProjects(root).some((g) => g.scope === 'project' && g.label === rLabel)) {
        sendJson(res, 404, { error: 'project not found' })
        return true
      }
      const rOut = renameProjectDir(root, rLabel, rName)
      if (!rOut.ok) sendJson(res, rOut.code, { error: rOut.error })
      else {
        ensureSseWatches(root)
        sendJson(res, 200, rOut)
      }
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/file/archive') {
    try {
      const ap2 = await readReportBody(req)
      const aProj = findProjects(root).find((g) => g.label === (typeof ap2.label === 'string' ? ap2.label : ''))
      if (!aProj) {
        sendJson(res, 404, { error: 'project not found' })
        return true
      }
      const aOut2 = await archiveProjectEntry(resolve(aProj.dir, '..', '..'), typeof ap2.path === 'string' ? ap2.path : '')
      if (!aOut2.ok) sendJson(res, aOut2.code, { error: aOut2.error })
      else sendJson(res, 200, aOut2)
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/file/delete') {
    try {
      const dp = await readReportBody(req)
      const dProj = findProjects(root).find((g) => g.label === (typeof dp.label === 'string' ? dp.label : ''))
      if (!dProj) {
        sendJson(res, 404, { error: 'project not found' })
        return true
      }
      const dOut = trashProjectEntry(resolve(dProj.dir, '..', '..'), typeof dp.path === 'string' ? dp.path : '')
      if (!dOut.ok) sendJson(res, dOut.code, { error: dOut.error })
      else sendJson(res, 200, dOut)
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/file/reveal') {
    const tRevealIn = Date.now()
    try {
      const vp = await readReportBody(req)
      const vProj = findProjects(root).find((g) => g.label === (typeof vp.label === 'string' ? vp.label : ''))
      if (!vProj) {
        sendJson(res, 404, { error: 'project not found' })
        return true
      }
      if (process.platform !== 'win32') {
        sendJson(res, 501, { error: 'unsupported platform' })
        return true
      }
      const vAbs = resolveWithinRoot(resolve(vProj.dir, '..', '..'), typeof vp.path === 'string' ? vp.path : '')
      if (!vAbs || !existsSync(vAbs)) {
        sendJson(res, vAbs ? 404 : 403, { error: vAbs ? 'not found' : 'forbidden' })
        return true
      }
      const isDirFlag = statSync(vAbs).isDirectory()
      console.log(
        `[gateway] 资源管理器定位 ${vProj.label} → ${vAbs}（${isDirFlag ? '目录' : '文件'} · 请求到发起 ${Date.now() - tRevealIn}ms）`,
      )
      revealInExplorer(vAbs, isDirFlag)
      sendJson(res, 200, { ok: true })
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/file/create') {
    try {
      const cp = await readReportBody(req)
      const cProj = findProjects(root).find((g) => g.label === (typeof cp.label === 'string' ? cp.label : ''))
      if (!cProj) {
        sendJson(res, 404, { error: 'project not found' })
        return true
      }
      const cOut = createProjectEntry(
        resolve(cProj.dir, '..', '..'),
        typeof cp.path === 'string' ? cp.path : '',
        typeof cp.name === 'string' ? cp.name : '',
        cp.dir === true,
      )
      if (!cOut.ok) sendJson(res, cOut.code, { error: cOut.error })
      else sendJson(res, 200, cOut)
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/file/upload') {
    try {
      const upLabel = url.searchParams.get('label') || ''
      const uProj = findProjects(root).find((g) => g.label === upLabel)
      if (!uProj) {
        sendJson(res, 404, { error: 'project not found' })
        return true
      }
      let uBuf: Buffer
      try {
        uBuf = await readBodyWithLimit(req, 20 * 1024 * 1024)
      } catch (e) {
        if (e instanceof ReportBodyTooLargeError) {
          sendReportBodyError(res, e)
          return true
        }
        throw e
      }
      const uOut = uploadProjectFile(
        resolve(uProj.dir, '..', '..'),
        url.searchParams.get('path') || '',
        url.searchParams.get('name') || '',
        uBuf,
      )
      if (!uOut.ok) sendJson(res, uOut.code, { error: uOut.error })
      else sendJson(res, 200, uOut)
    } catch (e) {
      sendError(res, e)
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/gateway/fs') {
    const qPath = (url.searchParams.get('path') || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
    const qAbs = resolveWithinRoot(root, qPath)
    if (!qAbs) {
      sendJson(res, 403, { error: 'forbidden' })
      return true
    }
    let qIsDir = false
    try {
      qIsDir = statSync(qAbs).isDirectory()
    } catch {
      qIsDir = false
    }
    if (!qIsDir) {
      sendJson(res, 404, { error: 'not a directory' })
      return true
    }
    const entries = listOneLevel(qAbs).map((e) => {
      try {
        return { ...e, mtime: statSync(join(qAbs, e.name)).mtimeMs }
      } catch {
        return e
      }
    })
    sendJson(res, 200, { path: qPath, entries })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/upload') {
    try {
      const uSid = (url.searchParams.get('sid') || '').trim()
      const uProject = (url.searchParams.get('project') || '').trim()
      const uWorkFile = (url.searchParams.get('workFile') || '').trim()
      const uKindRaw = (url.searchParams.get('kind') || '').trim()
      if (uKindRaw && uKindRaw !== 'image' && uKindRaw !== 'file') {
        sendJson(res, 400, { error: 'invalid kind' })
        return true
      }
      const uKind: UploadKind = uKindRaw === 'image' ? 'image' : 'file'
      const uOriginalName = sanitizeEntryName(url.searchParams.get('name') || '') || 'file'
      const uStoredName = stampUploadName(uOriginalName)
      let uProjRoot = root
      if (uProject) {
        const g = findProjects(root).find((x) => x.label === uProject)
        if (!g) {
          sendJson(res, 404, { error: 'project not found' })
          return true
        }
        uProjRoot = resolve(g.dir, '..', '..')
      }
      let uSess: { root: string; dirKey: string } | null = null
      if (uSid) {
        uSess = resolveUploadSession(uSid, root)
        if (!uSess) {
          sendJson(res, 400, { error: 'invalid sid' })
          return true
        }
      }
      if (uWorkFile) {
        const wfAbs = resolveWithinRoot(uProjRoot, uWorkFile)
        if (!wfAbs) {
          sendJson(res, 403, { error: 'forbidden' })
          return true
        }
        try {
          if (!statSync(wfAbs).isFile()) {
            sendJson(res, 400, { error: 'workFile not found' })
            return true
          }
        } catch {
          sendJson(res, 400, { error: 'workFile not found' })
          return true
        }
      }
      const uResolved = resolveUploadSlot({
        projectRoot: uProjRoot,
        workFile: uWorkFile,
        kind: uKind,
        slotId: url.searchParams.get('slot') || '',
      })
      if (!uResolved.ok) {
        sendJson(res, uResolved.code, { error: uResolved.error })
        return true
      }
      const uSlot = uResolved.slot
      const uBuf = await readBodyWithLimit(req, 20 * 1024 * 1024)
      if (uSlot.storage.scope === 'session') {
        const uRoot = uSess ? uSess.root : uProject ? uProjRoot : getProjectRoot()
        const uDirKey = uSess ? uSess.dirKey : PENDING_FILE_DIR
        if (uSess && uProject && resolve(uSess.root).toLowerCase() !== resolve(uProjRoot).toLowerCase()) {
          console.log(`[gateway] upload: sid 与 project 归属不一致，以 sid 为准（${uSess.root}）`)
        }
        const stored = storeUploadFile(uRoot, `.claude/${FILE_CACHE_DIR}/${uDirKey}`, uStoredName, uBuf)
        if (!stored.ok) {
          sendJson(res, stored.code, { error: stored.error })
          return true
        }
        const uQuery = uSid
          ? '?sid=' + encodeURIComponent(uSid)
          : uProject
            ? '?project=' + encodeURIComponent(uProject)
            : ''
        sendJson(res, 200, {
          ok: true,
          slot: uSlot.id,
          scope: 'session',
          originalName: uOriginalName,
          name: stored.name,
          storedPath: `.claude/${FILE_CACHE_DIR}/${uDirKey}/${stored.name}`,
          relativePath: `${FILE_CACHE_DIR}/${uDirKey}/${stored.name}`,
          reference: '',
          url: `/gateway/file-cache/${uDirKey}/${encodeURIComponent(stored.name)}${uQuery}`,
          size: stored.size,
          fallback: uResolved.fallback,
          ...(uResolved.fallback ? { fallbackReason: uResolved.fallbackReason || '' } : {}),
        })
        return true
      }
      if (!uWorkFile) {
        sendJson(res, 400, { error: `${uSlot.id} 需要 workFile` })
        return true
      }
      if (!uProject) {
        sendJson(res, 400, { error: `${uSlot.id} 需要 project` })
        return true
      }
      const uWf = uWorkFile.replace(/\\/g, '/').replace(/^\/+/, '')
      const uDocDir = dirname(uWf) === '.' ? '' : dirname(uWf).replace(/\\/g, '/')
      const uRelDir = uDocDir ? `${uDocDir}/${uSlot.storage.directory}` : uSlot.storage.directory
      const stored = storeUploadFile(uProjRoot, uRelDir, uStoredName, uBuf)
      if (!stored.ok) {
        sendJson(res, stored.code, { error: stored.error })
        return true
      }
      const uRefPath =
        (uSlot.reference.pathPrefix ? uSlot.reference.pathPrefix + '/' : '') +
        `${uSlot.storage.directory}/${stored.name}`
      sendJson(res, 200, {
        ok: true,
        slot: uSlot.id,
        scope: 'document',
        originalName: uOriginalName,
        name: stored.name,
        storedPath: stored.relPath,
        relativePath: uRefPath,
        reference: buildUploadReference(uSlot, uKind, uRefPath, stored.name),
        url: `/gateway/file?label=${encodeURIComponent(uProject)}&path=${encodeURIComponent(stored.relPath)}`,
        size: stored.size,
        fallback: false,
      })
      return true
    } catch (e) {
      if (e instanceof ReportBodyTooLargeError) sendReportBodyError(res, e)
      else sendError(res, e)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/gateway/file-cache') {
    try {
      const legacyName = sanitizeEntryName(url.searchParams.get('name') || '') || 'file'
      const legacySid = (url.searchParams.get('sid') || '').trim()
      const legacyProj = (url.searchParams.get('project') || '').trim()
      let legacyProjRoot = root
      if (legacyProj) {
        const g = findProjects(root).find((x) => x.label === legacyProj)
        if (g) legacyProjRoot = resolve(g.dir, '..', '..')
      }
      const legacySess = legacySid ? resolveUploadSession(legacySid, root) : null
      const legacyRoot = legacySess ? legacySess.root : legacyProj ? legacyProjRoot : getProjectRoot()
      const legacyDirKey = legacySess ? legacySess.dirKey : PENDING_FILE_DIR
      const buf = await readBodyWithLimit(req, 20 * 1024 * 1024)
      const stored = storeUploadFile(legacyRoot, `.claude/${FILE_CACHE_DIR}/${legacyDirKey}`, legacyName, buf)
      if (!stored.ok) {
        sendJson(res, stored.code, { error: stored.error })
        return true
      }
      sendJson(res, 200, {
        ok: true,
        name: stored.name,
        rel: `${FILE_CACHE_DIR}/${legacyDirKey}/${stored.name}`,
        size: stored.size,
      })
    } catch (e) {
      if (e instanceof ReportBodyTooLargeError) sendReportBodyError(res, e)
      else sendError(res, e)
    }
    return true
  }

  if (req.method === 'GET' && url.pathname.startsWith('/gateway/file-cache/')) {
    const m = /^\/gateway\/file-cache\/([0-9a-f-]{36}|_pending)\/([^/]+)$/.exec(url.pathname)
    if (!m) {
      sendJson(res, 400, { error: 'invalid path' })
      return true
    }
    let fcKey = m[2]
    try {
      fcKey = decodeURIComponent(m[2])
    } catch {
      /* 畸形编码用原文 */
    }
    if (!fcKey || fcKey === '.' || fcKey === '..' || /[\\/]/.test(fcKey)) {
      sendJson(res, 400, { error: 'invalid name' })
      return true
    }
    const fcSid = (url.searchParams.get('sid') || '').trim()
    const fcProj = (url.searchParams.get('project') || '').trim()
    const fcSess = fcSid ? resolveUploadSession(fcSid, root) : null
    const fcRoot = (fcSess && fcSess.root) || (fcProj ? webSessionProjectRoot(fcProj) : getProjectRoot())
    const fcDir = getFileCacheDir(fcRoot, m[1])
    let fcHit = fcKey
    if (/^\d+$/.test(fcKey)) {
      try {
        fcHit = readdirSync(fcDir).find((f) => /^\d+\./.test(f) && f.startsWith(`${fcKey}.`)) || ''
      } catch {
        fcHit = ''
      }
      if (!fcHit) {
        sendJson(res, 404, { error: 'not found' })
        return true
      }
    }
    const fcPath = join(fcDir, fcHit)
    try {
      const buf = readFileSync(fcPath)
      res.writeHead(200, {
        'Content-Type': MIME[extname(fcPath)] || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': 'private, no-cache',
      })
      res.end(buf)
    } catch {
      sendJson(res, 404, { error: 'not found' })
    }
    return true
  }

  return false
}
