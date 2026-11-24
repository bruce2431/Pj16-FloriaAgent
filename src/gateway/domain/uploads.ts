import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'
import { FILE_CACHE_DIR } from '../../utils/fileCache.js'
import type {
  EntryOpResult,
  StoredUploadFile,
  UploadDeclaration,
  UploadFallback,
  UploadKind,
  UploadReferenceFormat,
  UploadScope,
  UploadSlot,
  UploadSlotResolution,
} from '../core/types.js'
import { readJsonObject, resolveWithinRoot, sanitizeEntryName } from '../core/utils.js'

const RESERVED_UPLOAD_SLOT_IDS = new Set(['session', 'document-markdown'])

export function storeUploadFile(root: string, relDir: string, rawName: string, buf: Buffer): StoredUploadFile {
  const dir = resolveWithinRoot(root, relDir)
  if (!dir) return { ok: false, code: 403, error: 'forbidden' }
  const name = sanitizeEntryName(rawName)
  if (!name) return { ok: false, code: 400, error: '名称不合法' }
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return { ok: false, code: 500, error: 'mkdir failed' }
  }
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  const base = String(relDir || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  for (let i = 0; i < 10000; i++) {
    const candidate = i === 0 ? name : `${stem}-${i}${ext}`
    const target = join(dir, candidate)
    try {
      writeFileSync(target, buf, { flag: 'wx' })
      return {
        ok: true,
        name: candidate,
        relPath: base ? `${base}/${candidate}` : candidate,
        abs: target,
        size: buf.length,
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        return { ok: false, code: 500, error: 'write failed' }
      }
    }
  }
  return { ok: false, code: 500, error: 'name collision' }
}

export function uploadProjectFile(projRoot: string, relDir: string, rawName: string, buf: Buffer): EntryOpResult {
  const stored = storeUploadFile(projRoot, relDir, rawName, buf)
  if (!stored.ok) return stored
  return { ok: true, name: stored.name, path: stored.relPath, size: stored.size }
}

export function stampUploadName(rawName: string): string {
  const name = sanitizeEntryName(rawName) || 'file'
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length) || 'file'
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `${stem}-${stamp}${ext}`
}

function validateUploadSlot(raw: unknown): UploadSlot | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id.trim() : ''
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id) || RESERVED_UPLOAD_SLOT_IDS.has(id)) return null
  const priority = Number(o.priority)
  if (!Number.isInteger(priority) || priority < -10000 || priority > 10000) return null
  const fallback: UploadFallback | undefined =
    o.fallback === 'session' ? 'session' : o.fallback === 'reject' ? 'reject' : undefined
  const m = (o.match && typeof o.match === 'object' ? o.match : {}) as Record<string, unknown>
  const exts = (Array.isArray(m.workFileExtensions) ? m.workFileExtensions : [])
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim().toLowerCase())
    .filter((x) => /^\.[a-z0-9]{1,10}$/.test(x))
  const kinds = (Array.isArray(m.uploadKinds) ? m.uploadKinds : []).filter(
    (x): x is UploadKind => x === 'image' || x === 'file',
  )
  if (!exts.length || !kinds.length) return null
  const s = (o.storage && typeof o.storage === 'object' ? o.storage : {}) as Record<string, unknown>
  const scope: UploadScope | null = s.scope === 'session' ? 'session' : s.scope === 'document' ? 'document' : null
  if (!scope) return null
  let directory = ''
  if (scope === 'document') {
    directory = typeof s.directory === 'string' ? s.directory.trim().replace(/\\/g, '/') : ''
    if (!directory || isAbsolute(directory) || /^[A-Za-z]:/.test(directory)) return null
    if (directory.split('/').some((seg) => !seg || seg === '.' || seg === '..')) return null
  }
  const r = (o.reference && typeof o.reference === 'object' ? o.reference : {}) as Record<string, unknown>
  const format: UploadReferenceFormat | null =
    r.format === 'none' ||
    r.format === 'markdown' ||
    r.format === 'latex-includegraphics' ||
    r.format === 'template'
      ? r.format
      : null
  if (!format) return null
  if (r.pathBase !== undefined && r.pathBase !== 'workFileDirectory') return null
  let template = ''
  if (format === 'template') {
    template = typeof r.template === 'string' ? r.template : ''
    if (!template || template.length > 512) return null
    if (template.split('{{$path}}').length !== 2) return null
  }
  let pathPrefix = ''
  if (typeof r.pathPrefix === 'string' && r.pathPrefix.trim()) {
    pathPrefix = r.pathPrefix.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
    if (!pathPrefix || isAbsolute(pathPrefix)) return null
    if (pathPrefix.split('/').some((seg) => !seg || seg === '.' || seg === '..')) return null
  }
  return {
    id,
    priority,
    match: { workFileExtensions: Array.from(new Set(exts)), uploadKinds: Array.from(new Set(kinds)) },
    storage: { scope, directory },
    reference: format === 'template' ? { format, template, pathPrefix } : { format, pathPrefix },
    ...(fallback ? { fallback } : {}),
  }
}

export function readUploadDecl(projectRoot: string): UploadDeclaration {
  const empty: UploadDeclaration = { slots: [], fallback: 'session' }
  const p = join(projectRoot, '.claude', 'file-upload.json')
  if (!existsSync(p)) return empty
  const obj = readJsonObject(p)
  if (!obj || Number(obj.version) !== 1 || !Array.isArray(obj.slots)) {
    console.log(`[gateway] 上传声明无效（需 version:1 + slots[]），忽略：${p}`)
    return empty
  }
  const out: UploadSlot[] = []
  const seen = new Set<string>()
  for (const raw of obj.slots) {
    const slot = validateUploadSlot(raw)
    if (!slot) {
      console.log(`[gateway] 上传声明丢弃非法 slot：${JSON.stringify(raw).slice(0, 200)}`)
      continue
    }
    if (seen.has(slot.id)) continue
    seen.add(slot.id)
    out.push(slot)
  }
  return { slots: out, fallback: obj.fallback === 'reject' ? 'reject' : 'session' }
}

function builtinSessionSlot(): UploadSlot {
  return {
    id: 'session',
    priority: 0,
    builtin: true,
    match: { workFileExtensions: [], uploadKinds: ['image', 'file'] },
    storage: { scope: 'session', directory: '' },
    reference: { format: 'none' },
  }
}

function builtinDocumentMarkdownSlot(): UploadSlot {
  return {
    id: 'document-markdown',
    priority: 0,
    builtin: true,
    match: { workFileExtensions: ['.md', '.markdown'], uploadKinds: ['image', 'file'] },
    storage: { scope: 'document', directory: FILE_CACHE_DIR },
    reference: { format: 'markdown' },
  }
}

export function resolveUploadSlot(opts: {
  projectRoot: string
  workFile: string
  kind: UploadKind
  slotId?: string
}): UploadSlotResolution {
  const decl = readUploadDecl(opts.projectRoot)
  const workFile = String(opts.workFile || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const ext = extname(workFile).toLowerCase()
  if (opts.slotId && opts.slotId.trim()) {
    const id = opts.slotId.trim()
    if (id === 'session') return { ok: true, slot: builtinSessionSlot(), fallback: false }
    if (id === 'document-markdown') {
      if (!workFile) return { ok: false, code: 400, error: 'document-markdown 需要 workFile' }
      return { ok: true, slot: builtinDocumentMarkdownSlot(), fallback: false }
    }
    const hit = decl.slots.find((s) => s.id === id)
    if (!hit) return { ok: false, code: 400, error: `未知上传槽位: ${id}` }
    if (hit.storage.scope === 'document' && !workFile) {
      if (hit.fallback === 'session') {
        return { ok: true, slot: builtinSessionSlot(), fallback: true, fallbackReason: 'slot-needs-workfile' }
      }
      return { ok: false, code: 400, error: `${id} 需要 workFile` }
    }
    return { ok: true, slot: hit, fallback: false }
  }
  const sorted = decl.slots
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.priority - a.s.priority || a.i - b.i)
    .map((x) => x.s)
  for (const s of sorted) {
    if (!s.match.uploadKinds.includes(opts.kind)) continue
    if (!ext || !s.match.workFileExtensions.includes(ext)) continue
    return { ok: true, slot: s, fallback: false }
  }
  if (ext === '.md' || ext === '.markdown') {
    return { ok: true, slot: builtinDocumentMarkdownSlot(), fallback: false }
  }
  if (workFile) {
    if (decl.fallback === 'reject') {
      return { ok: false, code: 400, error: `没有可用的上传槽位：${ext || workFile}` }
    }
    return { ok: true, slot: builtinSessionSlot(), fallback: true, fallbackReason: 'no-document-slot' }
  }
  return { ok: true, slot: builtinSessionSlot(), fallback: false }
}

function latexEscapePath(p: string): string {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/[#%&{}$^~_]/g, (c) => '\\' + c)
    .replace(/ /g, '\\ ')
}

export function buildUploadReference(slot: UploadSlot, kind: UploadKind, refPath: string, name: string): string {
  const fmt = slot.reference.format
  if (fmt === 'none') return ''
  if (fmt === 'latex-includegraphics') return `\\includegraphics{${latexEscapePath(refPath)}}`
  const enc = encodeURI(refPath)
  if (fmt === 'markdown') return kind === 'image' ? `![${name}](${enc})` : `[${name}](${enc})`
  if (fmt === 'template') return String(slot.reference.template || '').replace('{{$path}}', enc)
  return ''
}
