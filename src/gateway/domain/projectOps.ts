import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import {
  ACTIVITY_TTL_MS,
  cliClients,
  closeSseWatchesUnder,
  sessionActivity,
} from '../core/state.js'
import { isPidAlive, runProcessQuiet, sanitizeEntryName, tarBin, tsStamp } from '../core/utils.js'
import { killBackend } from './backends.js'
import { sessionRootFromId } from './sessions.js'

function moveProjectDirToTrash(
  root: string,
  label: string,
): { ok: true; trash: string } | { ok: false; code: number; error: string } {
  const projRoot = resolve(root, label)
  if (!label || label !== basename(label) || label === '.' || label === '..' || dirname(projRoot) !== resolve(root)) {
    return { ok: false, code: 400, error: 'invalid label' }
  }
  if (!existsSync(projRoot) || !statSync(projRoot).isDirectory()) return { ok: false, code: 404, error: 'not found' }
  closeSseWatchesUnder(projRoot)
  const trash = join(root, '.trash')
  mkdirSync(trash, { recursive: true })
  let to = join(trash, `${tsStamp()}-${label}`)
  for (let i = 1; existsSync(to); i++) to = join(trash, `${tsStamp()}-${i}-${label}`)
  try {
    renameSync(projRoot, to)
  } catch (e) {
    return { ok: false, code: 500, error: `移入 .trash 失败：${(e as Error).message}` }
  }
  return { ok: true, trash: `.trash/${basename(to)}` }
}

function projectUseBlocker(root: string, projRoot: string): string | null {
  const base = resolve(projRoot).toLowerCase()
  const inside = (p: string): boolean => {
    const a = resolve(p).toLowerCase()
    return a === base || a.startsWith(base + sep)
  }
  for (const sid of cliClients.keys()) {
    const sr = sessionRootFromId(sid, root)
    if (sr && inside(sr)) return '项目内有在线会话，请先关闭会话再操作'
  }
  const now = Date.now()
  for (const [, act] of sessionActivity) {
    if (now - act.updatedAt > ACTIVITY_TTL_MS) continue
    if (act.cwd && act.pid && isPidAlive(act.pid) && inside(act.cwd)) {
      return '项目内有在线会话，请先关闭会话再操作'
    }
  }
  return null
}

export async function archiveProject(
  root: string,
  label: string,
): Promise<{ ok: true; archive: string; trash: string; bytes: number } | { ok: false; code: number; error: string }> {
  const projRoot = resolve(root, label)
  if (!label || label !== basename(label) || label === '.' || label === '..' || dirname(projRoot) !== resolve(root)) {
    return { ok: false, code: 400, error: 'invalid label' }
  }
  if (!existsSync(projRoot) || !statSync(projRoot).isDirectory()) return { ok: false, code: 404, error: 'not found' }
  const blocker = projectUseBlocker(root, projRoot)
  if (blocker) return { ok: false, code: 409, error: blocker }
  killBackend(label)
  const archDir = join(root, '.achrives')
  mkdirSync(archDir, { recursive: true })
  let dest = join(archDir, `${label}-${tsStamp()}.tar.gz`)
  for (let i = 1; existsSync(dest); i++) dest = join(archDir, `${label}-${tsStamp()}-${i}.tar.gz`)
  const out = await runProcessQuiet(tarBin(), ['-czf', dest, '-C', root, label])
  if (out.code !== 0) {
    try {
      if (existsSync(dest)) unlinkSync(dest)
    } catch {
      /* 忽略 */
    }
    const why = out.err ? `：${out.err.split('\n').slice(-2).join(' ')}` : ''
    return { ok: false, code: 500, error: `压缩失败（tar 退出码 ${out.code}）${why}` }
  }
  let bytes = 0
  try {
    bytes = statSync(dest).size
  } catch {
    /* 忽略 */
  }
  const moved = moveProjectDirToTrash(root, label)
  if (!moved.ok) {
    return { ok: false, code: moved.code, error: `已生成 .achrives/${basename(dest)}，但${moved.error}` }
  }
  return { ok: true, archive: `.achrives/${basename(dest)}`, trash: moved.trash, bytes }
}

export function deleteTempProject(
  root: string,
  label: string,
): { ok: true; trash: string } | { ok: false; code: number; error: string } {
  if (!/^\d{8,14}-/.test(label)) return { ok: false, code: 400, error: '仅临时项目可删除' }
  const projRoot = resolve(root, label)
  if (!existsSync(projRoot) || !statSync(projRoot).isDirectory()) return { ok: false, code: 404, error: 'not found' }
  const blocker = projectUseBlocker(root, projRoot)
  if (blocker) return { ok: false, code: 409, error: blocker }
  killBackend(label)
  return moveProjectDirToTrash(root, label)
}

export function renameProjectDir(
  root: string,
  label: string,
  rawName: string,
): { ok: true; label: string } | { ok: false; code: number; error: string } {
  const projRoot = resolve(root, label)
  if (!label || label !== basename(label) || label === '.' || label === '..' || dirname(projRoot) !== resolve(root)) {
    return { ok: false, code: 400, error: 'invalid label' }
  }
  if (!existsSync(projRoot) || !statSync(projRoot).isDirectory()) return { ok: false, code: 404, error: 'not found' }
  const name = sanitizeEntryName(rawName)
  if (!name || name.startsWith('.')) return { ok: false, code: 400, error: '名称不合法' }
  if (name === label) return { ok: true, label }
  const to = resolve(root, name)
  if (existsSync(to)) return { ok: false, code: 409, error: '同名项目已存在' }
  const blocker = projectUseBlocker(root, projRoot)
  if (blocker) return { ok: false, code: 409, error: blocker }
  killBackend(label)
  closeSseWatchesUnder(projRoot)
  try {
    renameSync(projRoot, to)
  } catch (e) {
    return { ok: false, code: 500, error: `重命名失败：${(e as Error).message}` }
  }
  return { ok: true, label: name }
}
