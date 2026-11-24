import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createConnection as netCreateConnection } from 'node:net'
import { join } from 'node:path'
import { gatewayDir, loadGatewayPortFromDisk } from '../../utils/gatewayToken.js'
import { isPidAlive } from './utils.js'

const GATEWAY_LOCK_GRACE_MS = 15_000
let gatewayLockHeld = false
const gatewayLockPath = (): string => join(gatewayDir(), 'gateway.lock')
const lockSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function releaseGatewayLock(): void {
  if (!gatewayLockHeld) return
  gatewayLockHeld = false
  try {
    unlinkSync(gatewayLockPath())
  } catch {
    /* 已被移除 */
  }
}

export function readGatewayLock(): { pid: number; createdAt: number } | null {
  try {
    const raw = readFileSync(gatewayLockPath(), 'utf8').trim()
    if (!raw) return null
    try {
      const j = JSON.parse(raw) as { pid?: unknown; createdAt?: unknown }
      const pid = Number(j.pid) || 0
      return pid > 0 ? { pid, createdAt: Number(j.createdAt) || 0 } : null
    } catch {
      const pid = Number(raw) || 0
      return pid > 0 ? { pid, createdAt: 0 } : null
    }
  } catch {
    return null
  }
}

/** 裸 TCP 探活（不经 fetch，避开系统代理劫持回环地址）。 */
export function probeGatewayHealth(port: number, host = '127.0.0.1', timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    let sock: ReturnType<typeof netCreateConnection> | null = null
    const finish = (v: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        sock?.destroy()
      } catch {
        /* 忽略 */
      }
      resolve(v)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    try {
      sock = netCreateConnection({ host, port })
    } catch {
      finish(false)
      return
    }
    let buf = ''
    sock.on('connect', () => {
      sock?.write(`GET /gateway/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)
    })
    sock.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
    })
    sock.on('end', () => finish(buf.includes('"mode":"gateway"')))
    sock.on('error', () => finish(false))
  })
}

export async function claimGatewayLock(port: number, host = '127.0.0.1'): Promise<'owned' | 'busy'> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(gatewayDir(), { recursive: true })
      writeFileSync(gatewayLockPath(), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), {
        encoding: 'utf8',
        flag: 'wx',
      })
      gatewayLockHeld = true
      return 'owned'
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return 'busy'
    }
    const owner = readGatewayLock()
    if (!owner) {
      try {
        unlinkSync(gatewayLockPath())
      } catch {
        /* 对方已清 */
      }
      continue
    }
    if (owner.pid === process.pid) {
      gatewayLockHeld = true
      return 'owned'
    }
    if (!isPidAlive(owner.pid)) {
      try {
        unlinkSync(gatewayLockPath())
      } catch {
        /* 对方已清 */
      }
      continue
    }
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      if (await probeGatewayHealth(port, host)) return 'busy'
      await lockSleep(300)
    }
    if (Date.now() - (owner.createdAt || 0) > GATEWAY_LOCK_GRACE_MS) {
      const diskPort = loadGatewayPortFromDisk()
      if (diskPort && diskPort !== port) {
        if (await probeGatewayHealth(diskPort, host)) return 'busy'
        if (host !== '127.0.0.1' && (await probeGatewayHealth(diskPort))) return 'busy'
      }
      try {
        unlinkSync(gatewayLockPath())
      } catch {
        /* 对方已清 */
      }
      continue
    }
    return 'busy'
  }
  return 'busy'
}
