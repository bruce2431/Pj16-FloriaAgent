import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import { networkInterfaces } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { getProjectRoot } from '../../bootstrap/state.js'
import { isProcessRunning } from '../../utils/genericProcessUtils.js'
import type { GatewayTaskItem } from './types.js'

export const MAX_REPORT_BODY_BYTES = 1024 * 1024
export const MAX_FILE_WRITE_BYTES = 4 * 1024 * 1024

export const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.canvas': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

export const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function readJsonObject(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export function isPathInside(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(parent + sep)
}

export class ReportBodyTooLargeError extends Error {}

/** 限流读原始 body（JSON 上报与文件上传共用；超限抛 ReportBodyTooLargeError → 413） */
export async function readBodyWithLimit(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += part.length
    if (size > maxBytes) throw new ReportBodyTooLargeError()
    chunks.push(part)
  }
  return Buffer.concat(chunks)
}

export async function readReportBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse((await readBodyWithLimit(req, MAX_REPORT_BODY_BYTES)).toString('utf8') || '{}')
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

export function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
  res.end(JSON.stringify(obj))
}

export function sendError(res: ServerResponse, e: unknown): void {
  sendJson(res, 500, { error: String((e && (e as Error).message) || e) })
}

export function sendReportBodyError(res: ServerResponse, error: unknown): void {
  const status = error instanceof ReportBodyTooLargeError ? 413 : 400
  sendJson(res, status, { error: status === 413 ? 'payload too large' : 'invalid body' })
}

export function lanAddress(): string | null {
  const addrs: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address)
    }
  }
  const pick = (re: RegExp) => addrs.find((a) => re.test(a))
  return (
    pick(/^192\.168\./) ||
    pick(/^10\./) ||
    pick(/^172\.(1[6-9]|2\d|3[01])\./) ||
    addrs[0] ||
    null
  )
}

export function remoteIPv4(raw: string | undefined): string {
  const ip = (raw ?? '').replace(/^::ffff:/, '')
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : ''
}

export function publicDir(root: string): string {
  const bases = [getProjectRoot(), root]
  for (const base of bases) {
    const subPj1 = join(base, 'SubPj1-遥测网页', 'public')
    if (isDir(subPj1)) return subPj1
  }
  for (const base of bases) {
    const subPj2 = join(base, 'SubPj2-私有化网关', 'public')
    if (isDir(subPj2)) return subPj2
  }
  return join(root, 'SubPj1-遥测网页', 'public')
}

export function sniffBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export function resolveWithinRoot(root: string, rel: string): string | null {
  const base = resolve(root)
  const p = String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
  if (!p) return base
  const abs = resolve(base, p)
  return abs === base || abs.startsWith(base + sep) ? abs : null
}

export function sanitizeEntryName(raw: string): string {
  let name = basename(String(raw || '').trim())
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) name = '_' + name
  if (name === '.' || name === '..') name = ''
  if (name.length > 120) {
    const ext = extname(name)
    name = name.slice(0, 120 - ext.length) + ext
  }
  return name
}

export function tsStamp(): string {
  const d = new Date()
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
}

export function runProcessQuiet(cmd: string, args: string[]): Promise<{ code: number; err: string }> {
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false })
    } catch {
      done({ code: -1, err: '' })
      return
    }
    let err = ''
    child.stderr?.on('data', (b: Buffer) => {
      err = (err + b.toString()).slice(-4096)
    })
    let settled = false
    child.on('error', (e) => {
      if (!settled) {
        settled = true
        done({ code: -1, err: String(e?.message || e) })
      }
    })
    child.on('exit', (code) => {
      if (!settled) {
        settled = true
        done({ code: code ?? -1, err: err.trim() })
      }
    })
  })
}

export function tarBin(): string {
  if (process.platform === 'win32') {
    const p = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    if (existsSync(p)) return p
  }
  return 'tar'
}

export const isPidAlive = (pid: number): boolean =>
  Number.isInteger(pid) && pid > 0 && isProcessRunning(pid, { epermMeansRunning: true })

export function killTree(pid: number): void {
  spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
}

export function killTreeExcept(pid: number, exempt: number): void {
  if (pid === exempt) return
  const res = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
    ],
    { encoding: 'utf8', windowsHide: true },
  )
  if (res.status !== 0 || !res.stdout?.trim()) {
    throw new Error(`进程树枚举失败（拒绝盲杀，防连坐网关）：${res.stderr || 'stdout 为空'}`)
  }
  const parsed: unknown = JSON.parse(res.stdout)
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as { ProcessId: number; ParentProcessId: number }[]
  const childMap = new Map<number, number[]>()
  for (const row of rows) {
    const cpid = Number(row.ProcessId)
    if (!Number.isInteger(cpid) || cpid <= 0) continue
    const ppid = Number(row.ParentProcessId)
    const list = childMap.get(ppid)
    if (list) list.push(cpid)
    else childMap.set(ppid, [cpid])
  }
  const collectSubtree = (root: number): number[] => {
    const out = [root]
    const seen = new Set<number>([root])
    for (let i = 0; i < out.length; i++) {
      for (const c of childMap.get(out[i]) ?? []) {
        if (!seen.has(c)) {
          seen.add(c)
          out.push(c)
        }
      }
    }
    return out
  }
  const subtree = collectSubtree(pid)
  if (!subtree.includes(exempt)) {
    killTree(pid)
    return
  }
  const skip = new Set(collectSubtree(exempt))
  for (const p of subtree) {
    if (skip.has(p)) continue
    spawnSync('taskkill', ['/F', '/PID', String(p)], { stdio: 'ignore', windowsHide: true })
  }
}

export function normalizeGatewayTasks(raw: unknown): GatewayTaskItem[] {
  if (!Array.isArray(raw)) return []
  const out: GatewayTaskItem[] = []
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue
    const t = it as Record<string, unknown>
    const status = t.status === 'completed' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending'
    if (typeof t.id !== 'string' || typeof t.subject !== 'string') continue
    out.push({
      id: t.id,
      subject: t.subject.slice(0, 500),
      status,
      owner: typeof t.owner === 'string' ? t.owner : undefined,
      activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined,
      blockedBy: Array.isArray(t.blockedBy)
        ? (t.blockedBy as unknown[]).filter((x): x is string => typeof x === 'string')
        : [],
    })
  }
  return out
}

let gatewayConsoleStamped = false
export function stampGatewayConsole(): void {
  if (gatewayConsoleStamped) return
  gatewayConsoleStamped = true
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const stamp = (): string => {
    const d = new Date()
    return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  }
  const wrap =
    (orig: (...a: unknown[]) => void) =>
    (...a: unknown[]) =>
      orig(`[${stamp()}]`, ...a)
  console.log = wrap(console.log)
  console.error = wrap(console.error)
  console.warn = wrap(console.warn)
}
