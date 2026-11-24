import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { WebSocket } from 'ws'
import { getPortableRoot } from '../../utils/envUtils.js'
import {
  backendProcesses,
  CLI_RECENT_REGISTER_MS,
  cliClients,
  cliPids,
  cliRegisterAt,
  ENABLE_IDLE_RECLAIM,
  gwState,
  persistBackendRegistry,
  persistWebSessions,
  readBackendRegistry,
  sessionActivity,
  sessionModelLaunch,
  webSessions,
} from '../core/state.js'
import { triggerStopLocalGateway } from '../core/transport.js'
import type { EjectTarget, WebSessionProc } from '../core/types.js'
import { isPidAlive, killTree, killTreeExcept } from '../core/utils.js'
import { killBackend, reclaimIdleBackends } from './backends.js'
import { findProjects } from './projects.js'

export const spawningPromises = new Map<string, Promise<string>>()
export const cliHelloPids = new Map<string, number>()
export const pendingDeliveries = new Map<string, Record<string, unknown>[]>()

export function sessionProjectRootOf(sessionId: string): { projectLabel?: string } | null {
  for (const g of findProjects(getPortableRoot())) {
    if (existsSync(join(g.dir, sessionId + '.jsonl'))) {
      return g.scope === 'project' ? { projectLabel: g.label } : {}
    }
  }
  return null
}

export function webSessionProjectRoot(project: string | undefined): string {
  if (project && project.trim()) {
    const g = findProjects(getPortableRoot()).find((x) => x.label === project)
    if (g) return resolve(g.dir, '..', '..')
  }
  return getPortableRoot()
}

export function webSessionExe(): string {
  return process.execPath
}

export function detachWebSessionClient(ws: WebSocket): void {
  for (const p of webSessions.values()) {
    p.clients.delete(ws)
  }
}

export function flushPendingDeliveries(sessionId: string): void {
  const q = pendingDeliveries.get(sessionId)
  if (!q?.length) return
  const t = cliClients.get(sessionId)
  if (!t || t.readyState !== WebSocket.OPEN) return
  pendingDeliveries.delete(sessionId)
  for (const frame of q) t.send(JSON.stringify(frame))
}

export function webSessionEntryAlive(sid: string): boolean {
  const p = webSessions.get(sid)
  if (!p) return false
  return p.pid ? isPidAlive(p.pid) : cliClients.has(sid)
}

export function spawnWebSession(
  resume: string | undefined,
  project: string | undefined,
  sidForNew?: string,
  opts?: { model?: string },
): Promise<string> {
  if (gwState.ejecting) return Promise.reject(new Error('网关正在安全卸载'))
  if (resume && webSessions.has(resume)) {
    const existing = webSessions.get(resume)
    if (existing && webSessionEntryAlive(resume)) {
      existing.lastActive = Date.now()
      return Promise.resolve(resume)
    }
    if (existing) {
      console.log(`[gateway] wsession: 复用检查发现死记录，清理后走恢复 spawn sid=${resume}`)
      webSessions.delete(resume)
      persistWebSessions()
    }
  }
  const lastReg = resume ? cliRegisterAt.get(resume) : undefined
  if (resume && lastReg && Date.now() - lastReg < CLI_RECENT_REGISTER_MS) {
    console.log(`[gateway] wsession: 近期注册痕迹（${Date.now() - lastReg}ms 前），复用活进程不 spawn sid=${resume}`)
    return Promise.resolve(resume)
  }
  const sid = resume ?? sidForNew ?? randomUUID()
  const inflight = spawningPromises.get(sid)
  if (inflight) return inflight
  let effectiveProject = project
  if (resume && !effectiveProject) {
    effectiveProject = sessionProjectRootOf(resume)?.projectLabel
  }
  const p = new Promise<string>((resolvePromise, reject) => {
    const args = resume ? ['--resume', resume] : ['--session-id', sid]
    const launchModel = opts?.model?.trim() || (resume ? sessionModelLaunch.get(sid)?.model : undefined)
    if (launchModel) args.push('--model', launchModel)
    const cwd = webSessionProjectRoot(effectiveProject)
    const exe = webSessionExe()
    const gwUrl = `http://127.0.0.1:${gwState.currentPort}`
    console.log(
      `[gateway] wsession: spawn 开始 resume=${resume ?? '新建'} sid=${sid} project=${effectiveProject ?? '(笔/全局根)'} model=${launchModel ?? '(默认)'} exe=${exe} cwd=${cwd}`,
    )
    let child: ChildProcess
    try {
      child = spawn('wt.exe', ['-w', 'last', 'nt', '-d', cwd, exe, ...args], {
        env: { ...process.env, FLOIRA_GATEWAY: gwUrl, FLORIA_IN_WT: '1' },
        stdio: 'ignore',
      })
    } catch (e) {
      reject(e as Error)
      return
    }
    const startedAt = Date.now()
    const REGISTER_TIMEOUT_MS = 20_000
    const timer = setInterval(() => {
      if (cliClients.has(sid)) {
        clearInterval(timer)
        console.log(`[gateway] wsession: 注册成功 sid=${sid} 耗时=${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
        const helloPid = cliHelloPids.get(sid)
        cliHelloPids.delete(sid)
        const proc: WebSessionProc = {
          sessionId: sid,
          pid: helloPid,
          clients: new Set(),
          startedAt,
          lastActive: Date.now(),
        }
        webSessions.set(sid, proc)
        persistWebSessions()
        resolvePromise(sid)
        return
      }
      if (Date.now() - startedAt > REGISTER_TIMEOUT_MS) {
        clearInterval(timer)
        console.error(
          `[gateway] wsession: 注册超时 sid=${sid} exe=${exe}（${REGISTER_TIMEOUT_MS / 1000}s 内未完成 /clients 注册，wt 打开失败或 CLI 探测不到网关）`,
        )
        reject(new Error(`web 会话启动超时（${REGISTER_TIMEOUT_MS / 1000}s 内未完成网关注册）`))
      }
    }, 300)
    child.on('exit', (code) => {
      if (code !== 0 && !cliClients.has(sid) && !webSessions.has(sid)) {
        clearInterval(timer)
        console.error(`[gateway] wsession: wt 打开 CLI 窗口失败 sid=${sid} exit=${code ?? '?'}`)
        reject(new Error(`打开本地 CLI 窗口失败（wt exit ${code ?? '?'}）`))
      }
    })
    child.on('error', (err) => {
      clearInterval(timer)
      reject(err)
    })
  })
  const tracked = p.finally(() => {
    spawningPromises.delete(sid)
  })
  spawningPromises.set(sid, tracked)
  return tracked
}

export function gracefulStopCli(sid: string, pid: number | undefined): void {
  const sock = cliClients.get(sid)
  if (sock) {
    try {
      sock.send(JSON.stringify({ type: 'shutdown' }))
    } catch {
      /* 断开忽略，走兜底 */
    }
  }
  if (pid && isPidAlive(pid)) {
    setTimeout(() => {
      if (isPidAlive(pid)) killTreeExcept(pid, process.pid)
    }, 3000)
  }
}

export function stopWebSession(sessionId: string): boolean {
  const p = webSessions.get(sessionId)
  if (!p) return false
  webSessions.delete(sessionId)
  persistWebSessions()
  gracefulStopCli(sessionId, p.pid)
  return true
}

export function collectEjectSessions(): EjectTarget[] {
  const sids = new Set<string>([...cliClients.keys(), ...webSessions.keys()])
  return [...sids].map((sessionId) => ({
    sessionId,
    pid: webSessions.get(sessionId)?.pid ?? cliPids.get(sessionId) ?? sessionActivity.get(sessionId)?.pid,
  }))
}

export function beginSafeEject(): { sessions: EjectTarget[]; backends: string[] } | null {
  if (gwState.ejecting) return null
  gwState.ejecting = true
  gwState.gatewayStopping = true
  const sessions = collectEjectSessions()
  const registry = readBackendRegistry()
  const backends = [...new Set([...backendProcesses.keys(), ...Object.keys(registry)])]
  for (const sock of cliClients.values()) {
    try {
      sock.send(JSON.stringify({ type: 'shutdown' }))
    } catch {
      /* 断开忽略，走树杀兜底 */
    }
  }
  void (async () => {
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && cliClients.size > 0) {
      await new Promise((r) => setTimeout(r, 100))
    }
    for (const t of sessions) {
      if (!t.pid || !isPidAlive(t.pid)) continue
      try {
        killTreeExcept(t.pid, process.pid)
      } catch (e) {
        console.warn(`[gateway] eject: 会话 ${t.sessionId} 树杀失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    for (const label of [...backendProcesses.keys()]) {
      try {
        killBackend(label)
      } catch {
        /* 单个失败不阻塞卸载 */
      }
    }
    for (const rec of Object.values(registry)) {
      if (rec.pid > 0 && isPidAlive(rec.pid)) {
        try {
          killTree(rec.pid)
        } catch {
          /* 忽略 */
        }
      }
    }
    persistBackendRegistry()
    console.log(
      `[gateway] 安全卸载完成：会话 ${sessions.length} 个、卡片后端 ${backends.length} 个已停，网关退出`,
    )
    triggerStopLocalGateway()
    process.exit(0)
  })()
  return { sessions, backends }
}

export function reclaimIdleWebSessions(): void {
  let changed = false
  for (const [sid] of [...webSessions]) {
    if (webSessionEntryAlive(sid)) continue
    console.log(`[gateway] web 会话 ${sid} CLI 进程已退出，清理运行注册`)
    webSessions.delete(sid)
    changed = true
  }
  if (changed) persistWebSessions()
}

export function scheduleReclaim(): void {
  if (!ENABLE_IDLE_RECLAIM || gwState.reclaimTimer) return
  gwState.reclaimTimer = setInterval(() => {
    reclaimIdleBackends()
    reclaimIdleWebSessions()
  }, 60 * 1000)
  gwState.reclaimTimer.unref?.()
}
