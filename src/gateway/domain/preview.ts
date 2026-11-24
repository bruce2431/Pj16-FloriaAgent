import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { join, resolve } from 'node:path'
import { CUSTOMIZATION_DISABLED_MARKER } from '../../utils/customizationToggle.js'
import { GATEWAY_IDLE_MINUTES } from '../core/state.js'
import type {
  BackendCfg,
  CardBackendEntry,
  MentionElement,
  MentionElementInsert,
  MentionElementSource,
  PreviewCard,
  PreviewPaneCard,
  PreviewQuoteAction,
  ProjectInfo,
} from '../core/types.js'

export const PREVIEW_INDEX_CARD_ID = '__index__'

export function readPreviewJson(previewDir: string): Record<string, unknown> | null {
  const pj = join(previewDir, 'preview.json')
  if (!existsSync(pj)) return null
  try {
    const raw = JSON.parse(readFileSync(pj, 'utf-8')) as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function isPreviewRelPath(p: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes('?')) return false
  const i = p.indexOf('#')
  const file = i >= 0 ? p.slice(0, i) : p
  let rel: string
  try {
    rel = decodeURIComponent(file)
  } catch {
    return false
  }
  if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.includes('?')) return false
  return rel.split('/').every((s) => s && s !== '.' && s !== '..')
}

export function parseBackendCfg(raw: unknown, previewDir: string, cwdBase: string): BackendCfg | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const b = raw as {
    name?: unknown
    cmd?: unknown
    cwd?: unknown
    port?: unknown
    idleMinutes?: unknown
    readyPath?: unknown
  }
  if (!Array.isArray(b.cmd) || !b.cmd.length) return undefined
  return {
    name: typeof b.name === 'string' && b.name ? b.name : undefined,
    cmd: b.cmd.map(String),
    cwd: typeof b.cwd === 'string' && b.cwd ? resolve(cwdBase, b.cwd) : previewDir,
    port: typeof b.port === 'number' ? b.port : 0,
    idleMinutes: typeof b.idleMinutes === 'number' ? b.idleMinutes : GATEWAY_IDLE_MINUTES,
    readyPath: typeof b.readyPath === 'string' && b.readyPath ? b.readyPath : '/api/system_stats',
    previewDir,
  }
}

export function readBackendCfg(previewDir: string): BackendCfg | undefined {
  const raw = readPreviewJson(previewDir) as { backend?: unknown } | null
  return parseBackendCfg(raw?.backend, previewDir, previewDir)
}

export function readPreviewCards(previewDir: string): PreviewCard[] {
  const list = readPreviewJson(previewDir)?.cards
  if (!Array.isArray(list)) return []
  const out: PreviewCard[] = []
  const seen = new Set<string>()
  for (const it of list) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue
    const c = it as Record<string, unknown>
    const id = typeof c.id === 'string' ? c.id.trim() : ''
    const title = typeof c.title === 'string' ? c.title.trim() : ''
    const path = typeof c.path === 'string' ? c.path.trim() : ''
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id) || !title || seen.has(id)) continue
    if (c.host !== 'view') continue
    if (!isPreviewRelPath(path)) continue
    seen.add(id)
    const firstSeg = (path.split('#')[0] || '').split('/')[0]
    const backendCfg = parseBackendCfg(c.backend, previewDir, previewDir)
    out.push({
      id,
      title,
      icon: typeof c.icon === 'string' && c.icon.trim() ? c.icon.trim().slice(0, 200) : 'plug',
      path,
      host: 'view',
      tab: c.tab !== false,
      repo: typeof c.repo === 'string' ? c.repo.trim().slice(0, 500) : '',
      enabled: !firstSeg || !existsSync(join(previewDir, firstSeg, CUSTOMIZATION_DISABLED_MARKER)),
      backendName: backendCfg ? backendCfg.name || title : '',
      backendCfg,
      elements: Array.isArray(c.elements) ? (c.elements as unknown[]) : [],
      elementsTitle: typeof c.elementsTitle === 'string' ? c.elementsTitle.trim().slice(0, 200) : '',
      elementsIcon: typeof c.elementsIcon === 'string' ? c.elementsIcon.trim().slice(0, 100) : '',
      elementsScope:
        c.elementsScope === 'all'
          ? 'all'
          : Array.isArray(c.elementsScope)
            ? c.elementsScope.filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim())
            : [],
    })
  }
  return out
}

export function readPreviewPaneCards(previewDir: string): PreviewPaneCard[] {
  let ents: Dirent[]
  try {
    ents = readdirSync(previewDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: PreviewPaneCard[] = []
  for (const e of ents) {
    if (!e.isDirectory() || !/^[a-zA-Z0-9_-]{1,32}$/.test(e.name)) continue
    const dir = join(previewDir, e.name)
    const mf = join(dir, 'card.json')
    if (!existsSync(mf)) continue
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(mf, 'utf-8'))
    } catch {
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const c = raw as Record<string, unknown>
    const title = typeof c.title === 'string' ? c.title.trim() : ''
    const entry = typeof c.entry === 'string' && c.entry ? c.entry.trim() : 'index.html'
    if (!title || entry.includes('#') || !isPreviewRelPath(entry)) continue
    if (!existsSync(join(dir, entry)) || !statSync(join(dir, entry)).isFile()) continue
    const backendCfg = parseBackendCfg(c.backend, previewDir, dir)
    out.push({
      id: e.name,
      title,
      icon: typeof c.icon === 'string' && c.icon.trim() ? c.icon.trim().slice(0, 200) : 'plug',
      entry,
      order: typeof c.order === 'number' && Number.isFinite(c.order) ? c.order : 100,
      default: c.default === true,
      repo: typeof c.repo === 'string' ? c.repo.trim().slice(0, 500) : '',
      enabled: !existsSync(join(dir, CUSTOMIZATION_DISABLED_MARKER)),
      backendName: backendCfg ? backendCfg.name || title : '',
      backendCfg,
    })
  }
  out.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  let claimed = false
  for (const c of out) {
    if (c.default && !claimed) claimed = true
    else c.default = false
  }
  if (!claimed && out.length) out[0].default = true
  return out
}

function validateMentionElement(raw: unknown, card: string): MentionElement | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const e = raw as Record<string, unknown>
  const id = typeof e.id === 'string' ? e.id.trim() : ''
  const name = typeof e.name === 'string' ? e.name.trim() : ''
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !name) return null
  const desc = typeof e.desc === 'string' ? e.desc.trim().slice(0, 200) : ''
  const icon = typeof e.icon === 'string' ? e.icon.trim() : ''
  const ins = e.insert
  if (!ins || typeof ins !== 'object' || Array.isArray(ins)) return null
  const i = ins as Record<string, unknown>
  let insert: MentionElementInsert | null = null
  if (i.type === 'text' && typeof i.text === 'string' && i.text) insert = { type: 'text', text: i.text }
  else if (i.type === 'token' && typeof i.token === 'string' && i.token.trim()) {
    insert = { type: 'token', token: i.token.trim() }
  } else if (i.type === 'path' && typeof i.path === 'string' && isPreviewRelPath(i.path.trim())) {
    insert = { type: 'path', path: i.path.trim(), pathType: i.pathType === 'dir' ? 'dir' : 'file' }
  }
  if (!insert) return null
  return { id, name, desc, icon, card, insert }
}

export function readMentionElementsTitle(previewDir: string): string {
  const raw = readPreviewJson(previewDir)?.elementsTitle
  return typeof raw === 'string' ? raw.trim().slice(0, 200) : ''
}

export function readMentionElementsIcon(previewDir: string): string {
  const raw = readPreviewJson(previewDir)?.elementsIcon
  return typeof raw === 'string' ? raw.trim().slice(0, 100) : ''
}

function scanMentionElements(previewDir: string): { elements: MentionElement[]; sources: MentionElementSource[] } {
  const out: MentionElement[] = []
  const sources: MentionElementSource[] = []
  const seen = new Set<string>()
  const take = (list: unknown, name: string, icon: string) => {
    if (!Array.isArray(list)) return
    let added = false
    for (const raw of list) {
      const el = validateMentionElement(raw, name)
      if (!el) {
        console.log(`[gateway] 元素声明丢弃非法条目：${JSON.stringify(raw).slice(0, 200)}`)
        continue
      }
      if (seen.has(el.id)) {
        console.log(`[gateway] 元素声明 id 重复，保留首个：${el.id}（${name || '项目级'}）`)
        continue
      }
      seen.add(el.id)
      out.push(el)
      added = true
    }
    if (added) sources.push({ name, icon: icon || '' })
  }
  const previewJson = readPreviewJson(previewDir)
  if (!existsSync(join(previewDir, CUSTOMIZATION_DISABLED_MARKER))) {
    take(previewJson?.elements, readMentionElementsTitle(previewDir), readMentionElementsIcon(previewDir))
  }
  for (const c of readPreviewCards(previewDir)) {
    if (c.enabled) take(c.elements, c.elementsTitle || c.title, c.elementsIcon)
  }
  let ents: Dirent[]
  try {
    ents = readdirSync(previewDir, { withFileTypes: true })
  } catch {
    return { elements: out, sources }
  }
  for (const e of ents) {
    if (!e.isDirectory() || !/^[a-zA-Z0-9_-]{1,32}$/.test(e.name)) continue
    const dir = join(previewDir, e.name)
    if (existsSync(join(dir, CUSTOMIZATION_DISABLED_MARKER))) continue
    const mf = join(dir, 'card.json')
    if (!existsSync(mf)) continue
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(mf, 'utf-8'))
    } catch {
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const c = raw as Record<string, unknown>
    const title = typeof c.title === 'string' ? c.title.trim() : ''
    const etitle = typeof c.elementsTitle === 'string' ? c.elementsTitle.trim().slice(0, 200) : ''
    const eicon = typeof c.elementsIcon === 'string' ? c.elementsIcon.trim().slice(0, 100) : ''
    take(c.elements, etitle || title, eicon)
  }
  return { elements: out, sources }
}

export function readMentionElements(previewDir: string): MentionElement[] {
  return scanMentionElements(previewDir).elements
}

export function mentionElementsFor(
  previewDir: string,
  globalPreviewDir?: string,
  projectLabel?: string,
): { title: string; icon: string; elements: MentionElement[]; sources: MentionElementSource[] } {
  const local = scanMentionElements(previewDir)
  const elements = local.elements
  const sources = local.sources.slice()
  const title = readMentionElementsTitle(previewDir)
  const icon = readMentionElementsIcon(previewDir)
  const label = (projectLabel || '').trim()
  if (!label || !globalPreviewDir || resolve(globalPreviewDir) === resolve(previewDir)) {
    return { title, icon, elements, sources }
  }
  const seen = new Set(elements.map((e) => e.id))
  for (const c of readPreviewCards(globalPreviewDir)) {
    if (!c.enabled || !c.elements.length) continue
    const scopeOk = c.elementsScope === 'all' || c.elementsScope.includes(label)
    if (!scopeOk) continue
    const name = c.elementsTitle || c.title
    let contributed = false
    for (const raw of c.elements) {
      const el = validateMentionElement(raw, name)
      if (!el || seen.has(el.id)) continue
      seen.add(el.id)
      elements.push(el)
      contributed = true
    }
    if (contributed) sources.push({ name, icon: c.elementsIcon || '' })
  }
  return { title, icon, elements, sources }
}

export function readPreviewQuoteActions(previewDir: string): PreviewQuoteAction[] {
  const list = readPreviewJson(previewDir)?.quoteActions
  if (!Array.isArray(list)) return []
  const out: PreviewQuoteAction[] = []
  const seen = new Set<string>()
  for (const it of list) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue
    const a = it as Record<string, unknown>
    const id = typeof a.id === 'string' ? a.id.trim() : ''
    const title = typeof a.title === 'string' ? a.title.trim() : ''
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id) || !title || seen.has(id)) continue
    seen.add(id)
    out.push({ id, title, icon: typeof a.icon === 'string' && a.icon ? a.icon : 'plug' })
  }
  return out
}

export function cardBackendKey(label: string, cardId: string): string {
  return `${label}::${cardId}`
}

export function previewDirOf(proj: ProjectInfo): string {
  return resolve(proj.dir, '..', 'preview')
}

export function enabledCardBackends(previewDir: string): CardBackendEntry[] {
  const out: CardBackendEntry[] = []
  for (const c of readPreviewPaneCards(previewDir)) {
    if (c.enabled && c.backendCfg) out.push({ id: c.id, cfg: c.backendCfg })
  }
  for (const c of readPreviewCards(previewDir)) {
    if (c.enabled && c.backendCfg) out.push({ id: c.id, cfg: c.backendCfg })
  }
  return out
}

export function publicPreviewCard<
  T extends {
    backendCfg?: BackendCfg
    backendName: string
    elements?: unknown[]
    elementsScope?: unknown
  },
>(c: T): Record<string, unknown> {
  const { backendCfg, elements, elementsScope, ...rest } = c
  return { ...rest, backend: !!backendCfg }
}

export function findEnabledCardBackend(previewDir: string, cardId: string): CardBackendEntry | undefined {
  if (!cardId) return undefined
  return enabledCardBackends(previewDir).find((c) => c.id === cardId)
}

export function findEnabledCardBackendBySeg(previewDir: string, seg: string): CardBackendEntry | undefined {
  if (!seg) return undefined
  const pane = readPreviewPaneCards(previewDir).find((c) => c.enabled && c.backendCfg && c.id === seg)
  if (pane && pane.backendCfg) return { id: pane.id, cfg: pane.backendCfg }
  for (const c of readPreviewCards(previewDir)) {
    const first = (c.path.split('#')[0] || '').split('/')[0]
    if (c.enabled && c.backendCfg && first === seg) return { id: c.id, cfg: c.backendCfg }
  }
  return undefined
}
