import { dlopen, FFIType, JSCallback, ptr } from 'bun:ffi'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { recordFileModifier, type FileModifierWriter } from '../../utils/fileModifierRegistry.js'
import type { EntryOpResult, FileWriteResult, ProjectComment } from '../core/types.js'
import { resolveWithinRoot, runProcessQuiet, sanitizeEntryName, tarBin, tsStamp } from '../core/utils.js'
import { findProjects } from './projects.js'

export function renameProjectEntry(projRoot: string, rel: string, rawName: string): EntryOpResult {
  const abs = resolveWithinRoot(projRoot, rel)
  if (!abs || abs === projRoot) return { ok: false, code: 403, error: 'forbidden' }
  if (!existsSync(abs)) return { ok: false, code: 404, error: 'not found' }
  const name = sanitizeEntryName(rawName)
  if (!name) return { ok: false, code: 400, error: '名称不合法' }
  const from = rel.replace(/\\/g, '/').replace(/\/+$/, '')
  const to = join(dirname(abs), name)
  if (to === abs) return { ok: true, name, path: from }
  if (existsSync(to)) return { ok: false, code: 409, error: '同名条目已存在' }
  renameSync(abs, to)
  const parent = dirname(from)
  return { ok: true, name, path: parent === '.' ? name : `${parent}/${name}` }
}

export function moveProjectEntry(projRoot: string, rel: string, rawDir: string): EntryOpResult {
  const abs = resolveWithinRoot(projRoot, rel)
  if (!abs || abs === projRoot) return { ok: false, code: 403, error: 'forbidden' }
  if (!existsSync(abs)) return { ok: false, code: 404, error: 'not found' }
  const dir = String(rawDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (dir === rel || dir.startsWith(rel + '/')) return { ok: false, code: 400, error: '不能移入自身或其子目录' }
  const dirAbs = dir ? resolveWithinRoot(projRoot, dir) : projRoot
  if (!dirAbs) return { ok: false, code: 403, error: 'forbidden' }
  if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) return { ok: false, code: 404, error: '目标目录不存在' }
  const name = basename(abs)
  const to = join(dirAbs, name)
  const newPath = dir ? `${dir}/${name}` : name
  if (to === abs) return { ok: true, name, path: newPath }
  if (existsSync(to)) return { ok: false, code: 409, error: '同名条目已存在' }
  renameSync(abs, to)
  return { ok: true, name, path: newPath }
}

export function trashProjectEntry(projRoot: string, rel: string): EntryOpResult {
  const abs = resolveWithinRoot(projRoot, rel)
  if (!abs || abs === projRoot) return { ok: false, code: 403, error: 'forbidden' }
  if (!existsSync(abs)) return { ok: false, code: 404, error: 'not found' }
  const trash = join(projRoot, '.trash')
  mkdirSync(trash, { recursive: true })
  const base = basename(abs)
  let to = join(trash, base)
  if (existsSync(to)) {
    const ts = tsStamp()
    to = join(trash, `${ts}-${base}`)
    for (let i = 1; existsSync(to); i++) to = join(trash, `${ts}-${i}-${base}`)
  }
  renameSync(abs, to)
  return { ok: true, trash: `.trash/${basename(to)}` }
}

export async function archiveProjectEntry(projRoot: string, rel: string): Promise<EntryOpResult> {
  const abs = resolveWithinRoot(projRoot, rel)
  if (!abs || abs === projRoot) return { ok: false, code: 403, error: 'forbidden' }
  if (!existsSync(abs)) return { ok: false, code: 404, error: 'not found' }
  if (!statSync(abs).isDirectory()) return { ok: false, code: 400, error: '仅目录可归档' }
  const relPath = rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const archDir = join(projRoot, '.achrives')
  mkdirSync(archDir, { recursive: true })
  const base = basename(abs)
  let dest = join(archDir, `${base}-${tsStamp()}.tar.gz`)
  for (let i = 1; existsSync(dest); i++) dest = join(archDir, `${base}-${tsStamp()}-${i}.tar.gz`)
  const out = await runProcessQuiet(tarBin(), ['-czf', dest, '-C', projRoot, relPath])
  if (out.code !== 0) {
    try {
      if (existsSync(dest)) unlinkSync(dest)
    } catch {
      /* 忽略 */
    }
    const why = out.err ? `：${out.err.split('\n').slice(-2).join(' ')}` : ''
    return { ok: false, code: 500, error: `压缩失败（tar 退出码 ${out.code}）${why}` }
  }
  let size = 0
  try {
    size = statSync(dest).size
  } catch {
    /* 忽略 */
  }
  const moved = trashProjectEntry(projRoot, relPath)
  if (!moved.ok) return { ok: false, code: moved.code, error: `已生成 .achrives/${basename(dest)}，但${moved.error}` }
  return { ok: true, path: `.achrives/${basename(dest)}`, trash: moved.trash, size }
}

export function writeProjectFile(
  projRoot: string,
  rel: string,
  content: string,
  baseMtime?: number,
  attribution?: { writer?: FileModifierWriter; sid?: string },
): FileWriteResult {
  const abs = resolveWithinRoot(projRoot, rel)
  if (!abs || abs === projRoot) return { ok: false, code: 403, error: 'forbidden' }
  if (typeof baseMtime !== 'number' || !Number.isFinite(baseMtime)) {
    if (!existsSync(abs) || !statSync(abs).isFile()) return { ok: false, code: 404, error: 'not found' }
  } else {
    let cur: number
    try {
      const st = statSync(abs)
      if (!st.isFile()) return { ok: false, code: 404, error: 'not found' }
      cur = st.mtimeMs
    } catch {
      return { ok: false, code: 404, error: 'not found' }
    }
    if (cur !== baseMtime) return { ok: false, code: 409, error: 'conflict' }
  }
  writeFileSync(abs, String(content ?? ''), 'utf8')
  recordFileModifier(abs, {
    projectRoot: projRoot,
    writer: attribution?.writer ?? 'session',
    sid: attribution?.sid,
  })
  return { ok: true, path: rel.replace(/\\/g, '/').replace(/^\/+/, ''), mtime: statSync(abs).mtimeMs }
}

export function createProjectEntry(projRoot: string, relDir: string, rawName: string, isDirFlag: boolean): EntryOpResult {
  let dirAbs: string | null = null
  if (String(relDir || '').trim()) {
    dirAbs = resolveWithinRoot(projRoot, relDir)
    if (!dirAbs) return { ok: false, code: 403, error: 'forbidden' }
  } else {
    dirAbs = projRoot
  }
  let dirIsDir = false
  try {
    dirIsDir = statSync(dirAbs).isDirectory()
  } catch {
    dirIsDir = false
  }
  if (!dirIsDir) return { ok: false, code: 404, error: 'directory not found' }
  const name = sanitizeEntryName(rawName)
  if (!name) return { ok: false, code: 400, error: '名称不合法' }
  const target = join(dirAbs, name)
  if (existsSync(target)) return { ok: false, code: 409, error: '同名条目已存在' }
  if (isDirFlag) mkdirSync(target)
  else writeFileSync(target, '', 'utf8')
  const base = String(relDir || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  return { ok: true, name, path: base ? `${base}/${name}` : name }
}

export function commentsFilePath(projRoot: string): string {
  return join(projRoot, '.claude', 'comments.json')
}

export function readProjectComments(projRoot: string): ProjectComment[] {
  try {
    const p = commentsFilePath(projRoot)
    if (!existsSync(p) || !statSync(p).isFile()) return []
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown
    const list =
      raw && typeof raw === 'object' && Array.isArray((raw as { comments?: unknown }).comments)
        ? (raw as { comments: unknown[] }).comments
        : null
    if (!list) return []
    return list.filter((c): c is ProjectComment => !!c && typeof c === 'object' && !Array.isArray(c))
  } catch {
    return []
  }
}

export function writeProjectComments(
  projRoot: string,
  comments: unknown[],
): { ok: true; count: number } | { ok: false; code: number; error: string } {
  const list = Array.isArray(comments)
    ? comments.filter((c) => !!c && typeof c === 'object' && !Array.isArray(c))
    : null
  if (!list) return { ok: false, code: 400, error: 'invalid comments' }
  try {
    mkdirSync(join(projRoot, '.claude'), { recursive: true })
    writeFileSync(commentsFilePath(projRoot), JSON.stringify({ version: 1, comments: list }, null, 2), 'utf8')
    return { ok: true, count: list.length }
  } catch {
    return { ok: false, code: 500, error: 'write failed' }
  }
}

type RevealWindow = { hwnd: bigint; title: string; visible: boolean }
type RevealLibs = {
  parse: (w: Buffer, out: BigUint64Array) => number
  open: (pidl: bigint) => number
  free: (pidl: bigint) => void
  windows: () => RevealWindow[]
  foreground: (hwnd: bigint) => void
}
let revealLibs: RevealLibs | null = null

function revealLibsOf(): RevealLibs | null {
  if (revealLibs) return revealLibs
  try {
    const shell32 = dlopen('shell32.dll', {
      SHParseDisplayName: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
      SHOpenFolderAndSelectItems: {
        args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.u32],
        returns: FFIType.i32,
      },
    })
    const ole32 = dlopen('ole32.dll', {
      CoInitializeEx: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      CoTaskMemFree: { args: [FFIType.u64], returns: FFIType.void },
    })
    const user32 = dlopen('user32.dll', {
      EnumWindows: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
      GetClassNameW: { args: [FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      GetWindowTextW: { args: [FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      IsWindowVisible: { args: [FFIType.u64], returns: FFIType.i32 },
      IsIconic: { args: [FFIType.u64], returns: FFIType.i32 },
      ShowWindow: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i32 },
      SetForegroundWindow: { args: [FFIType.u64], returns: FFIType.i32 },
      BringWindowToTop: { args: [FFIType.u64], returns: FFIType.i32 },
      GetForegroundWindow: { args: [], returns: FFIType.u64 },
      GetWindowThreadProcessId: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
      AttachThreadInput: { args: [FFIType.u32, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
      SwitchToThisWindow: { args: [FFIType.u64, FFIType.i32], returns: FFIType.void },
    })
    const kernel32 = dlopen('kernel32.dll', {
      GetCurrentThreadId: { args: [], returns: FFIType.u32 },
    })
    ole32.symbols.CoInitializeEx(null, 0x2)
    const u = user32.symbols
    const windows = (): RevealWindow[] => {
      const out: RevealWindow[] = []
      const clsBuf = Buffer.alloc(64 * 2)
      const titleBuf = Buffer.alloc(512 * 2)
      const cb = new JSCallback(
        (raw: bigint | number) => {
          const hwnd = typeof raw === 'bigint' ? raw : BigInt(raw)
          const n = u.GetClassNameW(hwnd, ptr(clsBuf), 64) as number
          if (n > 0 && clsBuf.toString('utf16le', 0, n * 2) === 'CabinetWClass') {
            const m = u.GetWindowTextW(hwnd, ptr(titleBuf), 512) as number
            out.push({
              hwnd,
              title: m > 0 ? titleBuf.toString('utf16le', 0, m * 2) : '',
              visible: (u.IsWindowVisible(hwnd) as number) !== 0,
            })
          }
          return 1
        },
        { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
      )
      try {
        u.EnumWindows(cb.ptr, 0n)
      } finally {
        cb.close()
      }
      return out
    }
    const foreground = (hwnd: bigint): void => {
      const fg = u.GetForegroundWindow() as bigint
      const fgThread = fg ? (u.GetWindowThreadProcessId(fg, null) as number) : 0
      const me = kernel32.symbols.GetCurrentThreadId() as number
      const attached = fgThread !== 0 && fgThread !== me
      if (attached) u.AttachThreadInput(me, fgThread, 1)
      u.ShowWindow(hwnd, (u.IsIconic(hwnd) as number) !== 0 ? 9 : 5)
      u.BringWindowToTop(hwnd)
      u.SetForegroundWindow(hwnd)
      if (attached) u.AttachThreadInput(me, fgThread, 0)
      if (String(u.GetForegroundWindow()) !== String(hwnd)) u.SwitchToThisWindow(hwnd, 1)
    }
    revealLibs = {
      parse: (w, out) => shell32.symbols.SHParseDisplayName(ptr(w), null, ptr(out), 0, null),
      open: (pidl) => shell32.symbols.SHOpenFolderAndSelectItems(pidl, 0, 0n, 0),
      free: (pidl) => ole32.symbols.CoTaskMemFree(pidl),
      windows,
      foreground,
    }
    return revealLibs
  } catch (e) {
    console.log(`[gateway] 资源管理器定位初始化失败：${(e as Error).message}`)
    return null
  }
}

export function revealInExplorer(abs: string, isDirFlag: boolean): void {
  const libs = revealLibsOf()
  if (!libs) return
  const before = new Map(libs.windows().map((w) => [String(w.hwnd), w.visible]))
  const wbuf = Buffer.from(abs + '\0', 'utf16le')
  const pidlOut = new BigUint64Array(1)
  const hrParse = libs.parse(wbuf, pidlOut)
  if (hrParse !== 0 || !pidlOut[0]) {
    console.log(`[gateway] 资源管理器定位失败：SHParseDisplayName hr=${hrParse}`)
    return
  }
  const hrOpen = libs.open(pidlOut[0])
  libs.free(pidlOut[0])
  if (hrOpen !== 0) {
    console.log(`[gateway] 资源管理器定位失败：SHOpenFolderAndSelectItems hr=${hrOpen}`)
    return
  }
  const folderName = isDirFlag ? basename(abs) : basename(dirname(abs))
  const deadline = Date.now() + 1600
  const pick = (): RevealWindow | undefined => {
    const wins = libs.windows()
    const byTitle = wins.find((w) => w.title === folderName || w.title.startsWith(folderName + ' - '))
    if (byTitle) return byTitle
    return wins.find((w) => {
      const prev = before.get(String(w.hwnd))
      return prev === undefined || (!prev && w.visible)
    })
  }
  const tick = (): void => {
    const hit = pick()
    if (hit) {
      libs.foreground(hit.hwnd)
      return
    }
    if (Date.now() < deadline) setTimeout(tick, 50)
  }
  setTimeout(tick, 30)
}

const FILE_HISTORY_CONTEXT = 3
const FILE_HISTORY_MAX_BYTES = 2 * 1024 * 1024
const FILE_HISTORY_SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type HistoryOp = { type: 'ctx' | 'add' | 'del'; old: number; now: number; text: string }
interface HistoryHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

function historyTextLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n')
}

function historyDiffOps(a: string[], b: string[]): HistoryOp[] {
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const ops: HistoryOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'ctx', old: i + 1, now: j + 1, text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: 'del', old: i + 1, now: 0, text: a[i] })
      i++
    } else {
      ops.push({ type: 'add', old: 0, now: j + 1, text: b[j] })
      j++
    }
  }
  while (i < n) {
    ops.push({ type: 'del', old: i + 1, now: 0, text: a[i] })
    i++
  }
  while (j < m) {
    ops.push({ type: 'add', old: 0, now: j + 1, text: b[j] })
    j++
  }
  return ops
}

function historyHunks(ops: HistoryOp[]): HistoryHunk[] {
  const changed: number[] = []
  ops.forEach((op, at) => {
    if (op.type !== 'ctx') changed.push(at)
  })
  if (changed.length === 0) return []
  const spans: Array<[number, number]> = []
  let start = Math.max(0, changed[0] - FILE_HISTORY_CONTEXT)
  let end = Math.min(ops.length - 1, changed[0] + FILE_HISTORY_CONTEXT)
  for (let k = 1; k < changed.length; k++) {
    const at = changed[k]
    if (at - FILE_HISTORY_CONTEXT <= end + 1) end = Math.min(ops.length - 1, at + FILE_HISTORY_CONTEXT)
    else {
      spans.push([start, end])
      start = Math.max(0, at - FILE_HISTORY_CONTEXT)
      end = Math.min(ops.length - 1, at + FILE_HISTORY_CONTEXT)
    }
  }
  spans.push([start, end])

  const hunks: HistoryHunk[] = []
  for (const [s, e] of spans) {
    const slice = ops.slice(s, e + 1)
    const firstOld = slice.find((op) => op.type !== 'add')
    const firstNew = slice.find((op) => op.type !== 'del')
    const prev = hunks[hunks.length - 1]
    const oldStart = firstOld ? firstOld.old : prev ? prev.oldStart + prev.oldLines : 1
    const newStart = firstNew ? firstNew.now : prev ? prev.newStart + prev.newLines : 1
    const oldLines = slice.filter((op) => op.type !== 'add').length
    const newLines = slice.filter((op) => op.type !== 'del').length
    hunks.push({
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: slice.map((op) => (op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' ') + op.text),
    })
  }
  return hunks
}

export function readFileHistory(
  root: string,
  label: string,
  rawPath: string,
  session: string,
): { status: number; body: Record<string, unknown> } {
  if (!FILE_HISTORY_SESSION_RE.test(session)) return { status: 400, body: { ok: false, error: 'session 参数无效' } }
  let p = String(rawPath || '').trim().replace(/^file:/i, '')
  p = p.replace(/\\/g, '/').replace(/:\d+(?:-\d+)?$/, '')
  if (!p) return { status: 400, body: { ok: false, error: 'path 缺失' } }

  const proj = findProjects(root).find((g) => g.label === label)
  let base: string
  if (proj) {
    base = resolve(proj.dir, '..', '..')
  } else if (!label) {
    if ((p.split('/')[0] || '').startsWith('.')) return { status: 403, body: { ok: false, error: 'forbidden' } }
    base = root
  } else {
    return { status: 404, body: { ok: false, error: 'project not found' } }
  }
  const abs = /^[A-Za-z]:\//.test(p) ? resolve(p) : resolve(base, p)
  if (abs !== base && !abs.startsWith(base + sep)) return { status: 403, body: { ok: false, error: 'forbidden' } }
  const display = abs.slice(base.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')

  let currentText: string | null = null
  if (existsSync(abs) && statSync(abs).isFile()) {
    if (statSync(abs).size > FILE_HISTORY_MAX_BYTES) {
      return { status: 413, body: { ok: false, error: '当前文件超过 2 MB 上限' } }
    }
    currentText = readFileSync(abs).toString('utf8')
  }

  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 16)
  const dir = join(base, '.claude', 'file-history', session)
  const versions: Array<{ version: number; name: string }> = []
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const m = /^([0-9a-f]{16})@v(\d+)$/.exec(name)
      if (m && m[1] === hash) versions.push({ version: Number(m[2]), name })
    }
  }
  versions.sort((a, b) => a.version - b.version)

  const file = { path: display, display }
  if (!versions.length && currentText === null) {
    return { status: 404, body: { ok: false, error: '文件不存在，且该会话没有历史备份' } }
  }
  const baseBody: Record<string, unknown> = {
    ok: true,
    session,
    file,
    content: currentText === null ? '' : currentText,
    current: { exists: currentText !== null, lines: currentText === null ? 0 : historyTextLines(currentText).length },
  }
  if (!versions.length) {
    return {
      status: 200,
      body: {
        ...baseBody,
        previous: null,
        rounds: [],
        note: '该会话没有此文件的改动前备份（可能是本轮新建，或由其它会话/Web 端修改）',
      },
    }
  }

  const latest = versions[versions.length - 1]
  const backupAbs = join(dir, latest.name)
  const bytes = readFileSync(backupAbs)
  if (bytes.byteLength > FILE_HISTORY_MAX_BYTES) {
    return { status: 413, body: { ok: false, error: '备份超过 2 MB 上限' } }
  }
  const previousText = bytes.toString('utf8')
  const ops = historyDiffOps(historyTextLines(previousText), historyTextLines(currentText === null ? '' : currentText))
  const hunks = historyHunks(ops)
  const added = ops.filter((op) => op.type === 'add').length
  const deleted = ops.filter((op) => op.type === 'del').length
  return {
    status: 200,
    body: {
      ...baseBody,
      previous: { version: latest.version, backup: latest.name, mtime: statSync(backupAbs).mtimeMs },
      rounds: hunks.length
        ? [{ turn: latest.version, label: 'v' + latest.version + ' → 当前', added, deleted, hunks }]
        : [],
      note: hunks.length ? '' : '与上一版备份相比没有文本改动',
    },
  }
}
