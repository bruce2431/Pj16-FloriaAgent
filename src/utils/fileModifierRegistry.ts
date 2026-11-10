import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs'
import { dirname, resolve } from 'path'
import { getSessionId } from 'src/bootstrap/state.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getProjectRuntimeDir } from 'src/utils/projectConfig.js'

// Cross-process registry mapping file paths to the session that last wrote
// them. Each CLI session is a separate process with private memory, so the
// only channel for "who modified this file" is disk: writers append a line,
// and a session hitting the modified-since-read staleness gate looks the
// modifier's session id up here.

const REGISTRY_FILE = 'file-mods.jsonl'
const COMPACT_THRESHOLD_BYTES = 1_000_000
const COMPACT_KEEP_LINES = 1000

export type FileModifierWriter = 'session' | 'web'

type RegistryOptions = {
  /** 目标文件所在项目根；缺省 = 本进程项目根（gateway 进程必须显式传） */
  projectRoot?: string
}

function registryPath(opts?: RegistryOptions): string {
  return getProjectRuntimeDir(REGISTRY_FILE, opts?.projectRoot)
}

function normalizeKey(filePath: string): string {
  const resolved = resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Record that this session just wrote filePath. Best-effort — attribution
 * must never break the write itself.
 */
export function recordFileModifier(
  filePath: string,
  opts?: RegistryOptions & { writer?: FileModifierWriter; sid?: string },
): void {
  try {
    const path = registryPath(opts)
    mkdirSync(dirname(path), { recursive: true })
    compactIfNeeded(path)
    const writer: FileModifierWriter = opts?.writer ?? 'session'
    // web 写者没有 CLI 会话身份：不回落到网关进程的 sid，只记调用方给的 web 会话。
    const sid =
      writer === 'web' ? (opts?.sid ?? '') : (opts?.sid ?? getSessionId())
    const entry = JSON.stringify({
      p: normalizeKey(filePath),
      w: writer,
      sid,
      ts: Date.now(),
    })
    appendFileSync(path, entry + '\n', 'utf8')
  } catch (e) {
    logForDebugging(
      `fileModifierRegistry: record failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

/**
 * If another session wrote filePath after sinceTs, return its session id.
 * Newest entry wins; own-session entries are skipped (our own writes keep
 * readFileState fresh, so they cannot be the cause of a staleness gate).
 */
export function findFileModifier(
  filePath: string,
  sinceTs: number,
  opts?: RegistryOptions,
): string | undefined {
  let lines: string[]
  try {
    lines = readFileSync(registryPath(opts), 'utf8').split('\n')
  } catch {
    return undefined
  }
  const key = normalizeKey(filePath)
  const ownSid = getSessionId()
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const entry = JSON.parse(line) as {
        p?: string
        w?: string
        sid?: string
        ts?: number
      }
      if (
        entry.p !== key ||
        entry.ts === undefined ||
        entry.ts <= sinceTs
      ) {
        continue
      }
      // 旧行没有 w 字段 → 一律视为 CLI 会话写者。
      if (entry.w === 'web') return 'web'
      if (entry.sid && entry.sid !== ownSid) return entry.sid
    } catch {
      // tolerate corrupt/partial lines from racing appends
    }
  }
  return undefined
}

/** 归因展示口径：web 写者（含网关 API 与编辑卡）不冒充 CLI 会话。 */
export function describeFileModifier(modifier?: string): string {
  if (!modifier) return 'another process'
  if (modifier === 'web') return 'the web editor'
  return `session ${modifier}`
}

/**
 * Attribution suffix for staleness messages, '' when no other-writer write
 * qualifies (user/linter edits stay unattributed).
 */
export function fileModifierSuffix(
  filePath: string,
  sinceTs: number,
  opts?: RegistryOptions,
): string {
  const modifier = findFileModifier(filePath, sinceTs, opts)
  return modifier ? ` (last modified by ${describeFileModifier(modifier)})` : ''
}

function compactIfNeeded(path: string): void {
  try {
    if (statSync(path).size <= COMPACT_THRESHOLD_BYTES) return
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    writeFileSync(path, lines.slice(-COMPACT_KEEP_LINES).join('\n') + '\n', 'utf8')
  } catch {
    // ENOENT on first write, or a raced compaction — both fine
  }
}
