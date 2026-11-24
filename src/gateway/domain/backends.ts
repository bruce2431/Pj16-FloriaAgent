import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, statSync, truncateSync } from 'node:fs'
import { request as httpRequest, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { createConnection as netCreateConnection, createServer as netCreateServer } from 'node:net'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { getPortableRoot } from '../../utils/envUtils.js'
import {
  BACKEND_PORT_BASE,
  BACKEND_PORT_MAX,
  backendProcesses,
  GATEWAY_IDLE_MINUTES,
  gwState,
  persistBackendRegistry,
  readBackendRegistry,
} from '../core/state.js'
import type { BackendCfg, BackendProc } from '../core/types.js'
import { isPidAlive, killTree, sendJson } from '../core/utils.js'

const BACKEND_LOG_MAX_BYTES = 5 * 1024 * 1024
const backendPending = new Map<string, Promise<BackendProc>>()
const bpForwardQueues = new Map<string, Promise<void>>()

const PROXY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const srv = netCreateServer()
    srv.once('error', () => done(false))
    srv.once('listening', () => srv.close(() => done(true)))
    srv.listen(port, '127.0.0.1')
  })
}

export function backendReady(port: number, path: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((done) => {
    let finished = false
    const finish = (ok: boolean) => {
      if (finished) return
      finished = true
      try {
        sock.destroy()
      } catch {
        /* 忽略 */
      }
      done(ok)
    }
    const sock = netCreateConnection({ host: '127.0.0.1', port })
    let buf = ''
    sock.on('connect', () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)
    })
    sock.on('data', (d) => {
      buf += d.toString('latin1')
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf)
      if (m) finish(m[1] === '200' || m[1] === '404')
    })
    sock.on('error', () => finish(false))
    sock.on('close', () => finish(false))
    sock.setTimeout(timeoutMs, () => finish(false))
  })
}

async function allocBackendPort(): Promise<number> {
  for (let p = BACKEND_PORT_BASE; p < BACKEND_PORT_MAX; p++) {
    if (await portFree(p)) return p
  }
  return 0
}

function backendLogPath(cfg: BackendCfg): string {
  return join(cfg.previewDir, 'backend.log')
}

function rotateBackendLogIfNeeded(p: string): void {
  try {
    if (existsSync(p) && statSync(p).size > BACKEND_LOG_MAX_BYTES) truncateSync(p, 0)
  } catch {
    /* 忽略 */
  }
}

export function backendProcAlive(p: BackendProc): boolean {
  return p.child ? p.child.exitCode === null && !p.child.killed : isPidAlive(p.pid)
}

function backendRuntimeDirs(): string[] {
  const base = join(getPortableRoot(), '.claude', 'runtime')
  return [join(base, 'python'), join(base, 'python', 'Scripts'), join(base, 'node')]
}

function expandBackendCmdArg(arg: string, port: number, previewDir: string): string {
  if (!arg.includes('{')) return arg
  return arg
    .replaceAll('{port}', String(port))
    .replaceAll('{previewDir}', previewDir)
    .replaceAll('{projectRoot}', resolve(previewDir, '..', '..'))
}

async function doSpawnBackend(label: string, cfg: BackendCfg): Promise<BackendProc> {
  const port = cfg.port > 0 ? cfg.port : await allocBackendPort()
  if (!port) throw new Error(`backend ${label}: 无可用端口（${BACKEND_PORT_BASE}-${BACKEND_PORT_MAX} 均被占用）`)
  const cmd = cfg.cmd.map((a) => expandBackendCmdArg(a, port, cfg.previewDir))
  if (cmd[0] && !isAbsolute(cmd[0]) && /[\\/]/.test(cmd[0])) cmd[0] = resolve(cfg.cwd, cmd[0])
  const logPath = backendLogPath(cfg)
  rotateBackendLogIfNeeded(logPath)
  mkdirSync(join(logPath, '..'), { recursive: true })
  const logFd = openSync(logPath, 'a')
  const child = spawn(cmd[0], cmd.slice(1), {
    cwd: cfg.cwd,
    env: {
      ...process.env,
      PORT: String(port),
      PATH: [...backendRuntimeDirs(), process.env.PATH ?? ''].filter(Boolean).join(delimiter),
    },
    stdio: ['ignore', logFd, logFd],
    shell: false,
    windowsHide: true,
  })
  let spawnError: Error | null = null
  child.on('error', (e) => {
    spawnError = e
  })
  const proc: BackendProc = { pid: child.pid ?? 0, port, cfg, startedAt: Date.now(), lastActive: Date.now(), child }
  child.on('exit', () => {
    try {
      closeSync(logFd)
    } catch {
      /* 忽略 */
    }
    if (backendProcesses.get(label) === proc) {
      backendProcesses.delete(label)
      persistBackendRegistry()
    }
  })
  let ready = false
  for (let i = 0; i < 120; i++) {
    if (gwState.gatewayStopping || child.exitCode !== null || spawnError) break
    if (await backendReady(port, cfg.readyPath)) {
      ready = true
      break
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  if (!ready) {
    try {
      child.kill()
    } catch {
      /* 忽略 */
    }
    if (child.pid) killTree(child.pid)
    if (spawnError) {
      try {
        closeSync(logFd)
      } catch {
        /* 忽略 */
      }
      throw new Error(`backend ${label}: 启动失败 ${spawnError.message}（cmd: ${cmd.join(' ')}）`)
    }
    throw new Error(`backend ${label}: 端口 ${port} 就绪探测失败（${cfg.readyPath}），详见日志 ${backendLogPath(cfg)}`)
  }
  backendProcesses.set(label, proc)
  persistBackendRegistry()
  return proc
}

export async function ensureBackend(label: string, cfg: BackendCfg): Promise<BackendProc> {
  const existing = backendProcesses.get(label)
  if (existing && backendProcAlive(existing)) {
    existing.lastActive = Date.now()
    return existing
  }
  if (existing) {
    backendProcesses.delete(label)
    persistBackendRegistry()
  }
  const rec = readBackendRegistry()[label]
  if (rec && rec.pid > 0 && rec.port > 0 && isPidAlive(rec.pid)) {
    if (await backendReady(rec.port, cfg.readyPath)) {
      const proc: BackendProc = {
        pid: rec.pid,
        port: rec.port,
        cfg,
        startedAt: rec.startedAt,
        lastActive: Date.now(),
        child: null,
      }
      backendProcesses.set(label, proc)
      persistBackendRegistry()
      console.log(`[gateway] backend ${label}: 收养存活进程 pid=${rec.pid} port=${rec.port}（网关重启不重启后端）`)
      return proc
    }
    killTree(rec.pid)
  }
  const pending = backendPending.get(label)
  if (pending) return pending
  const p = doSpawnBackend(label, cfg)
  backendPending.set(label, p)
  try {
    return await p
  } finally {
    backendPending.delete(label)
  }
}

export function killBackend(label: string): void {
  const p = backendProcesses.get(label)
  if (!p) return
  backendProcesses.delete(label)
  try {
    p.child?.kill()
  } catch {
    /* 忽略 */
  }
  if (p.pid) killTree(p.pid)
  persistBackendRegistry()
}

function rewriteLocation(loc: string, prefix: string, port: number): string {
  const abs = `http://127.0.0.1:${port}`
  if (loc === abs) return prefix
  if (loc.startsWith(abs + '/')) return prefix + loc.slice(abs.length)
  if (loc.startsWith('/')) return prefix + loc
  return loc
}

function enqueueBpForward(key: string, run: () => Promise<void>): void {
  const prev = bpForwardQueues.get(key) ?? Promise.resolve()
  const next = prev.then(run).catch((e: unknown) => {
    console.log(`[gateway] /backend 转发队列异常: ${e instanceof Error ? e.message : String(e)}`)
  })
  bpForwardQueues.set(key, next)
  void next.then(() => {
    if (bpForwardQueues.get(key) === next) bpForwardQueues.delete(key)
  })
}

export function proxyBackendRequest(
  req: IncomingMessage,
  res: ServerResponse,
  proc: BackendProc,
  prefix: string,
  rawPath: string,
  rawSearch: string,
): void {
  const upHeaders: Record<string, string | string[] | undefined> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase()
    if (PROXY_HOP_HEADERS.has(lk) || lk === 'host' || lk === 'cookie') continue
    upHeaders[k] = v as string | string[] | undefined
  }
  upHeaders.host = `127.0.0.1:${proc.port}`
  const label = prefix.slice('/backend/'.length)
  let receivedBytes = 0
  req.on('data', (c: Buffer) => {
    receivedBytes += c.length
  })
  const contentLen = Number(req.headers['content-length']) || -1
  let upReq: ClientRequest | undefined
  let killed = false
  const killUpstream = (why: string): void => {
    if (killed) return
    killed = true
    console.log(
      `[gateway] /backend ${label}${rawPath} 转发中止: ${why} (已收 ${receivedBytes}/${contentLen < 0 ? '?' : contentLen} 字节)`,
    )
    upReq?.destroy()
  }
  req.on('error', () => killUpstream('客户端请求错误'))
  req.on('aborted', () => killUpstream('客户端断开(aborted,body 未收齐)'))
  req.on('close', () => {
    if (req.complete === false) killUpstream('客户端断开(close,body 未收齐)')
  })
  res.on('close', () => {
    if (!res.writableEnded) killUpstream('客户端断开(响应中途)')
  })

  const forward = async (): Promise<void> => {
    if (killed || res.destroyed) return
    const thisReq = httpRequest(
      { host: '127.0.0.1', port: proc.port, method: req.method, path: rawPath + rawSearch, headers: upHeaders },
      (upRes) => {
        const outHeaders: Record<string, string> = {}
        for (const [k, v] of Object.entries(upRes.headers)) {
          const lk = k.toLowerCase()
          if (PROXY_HOP_HEADERS.has(lk) || lk === 'set-cookie') continue
          outHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '')
        }
        const loc = upRes.headers.location
        if (typeof loc === 'string') outHeaders.location = rewriteLocation(loc, prefix, proc.port)
        else if (Array.isArray(loc) && loc.length > 0) outHeaders.location = rewriteLocation(loc[0], prefix, proc.port)
        res.writeHead(upRes.statusCode ?? 502, outHeaders)
        upRes.pipe(res)
      },
    )
    upReq = thisReq
    req.pipe(thisReq)
    thisReq.on('socket', (s) => {
      s.setTimeout(180_000)
      s.on('timeout', () => {
        killUpstream('上游 180s 无数据')
        if (!res.destroyed && !res.headersSent) sendJson(res, 504, { error: 'upstream timeout' })
      })
    })
    thisReq.on('error', () => {
      if (res.destroyed) return
      if (!res.headersSent) sendJson(res, 502, { error: 'backend unreachable' })
      else res.destroy()
    })
  }

  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    enqueueBpForward(prefix, forward)
  } else {
    void forward()
  }
}

export function reclaimIdleBackends(): void {
  const now = Date.now()
  for (const [label, p] of [...backendProcesses]) {
    const idleMs = (p.cfg.idleMinutes ?? GATEWAY_IDLE_MINUTES) * 60 * 1000
    if (now - p.lastActive > idleMs) {
      console.log(`[gateway] backend ${label} 空闲超过 ${p.cfg.idleMinutes ?? GATEWAY_IDLE_MINUTES} 分钟，回收`)
      killBackend(label)
    }
  }
}
