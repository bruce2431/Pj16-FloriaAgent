/**
 * localGateway.ts —— 内置私有化网关入口外观（feature: PRIVATE_GATEWAY）。
 *
 * 分层架构（严格无环 DAG）：
 *  - core/   ：类型、共享运行态、工具、传输/生命周期槽、单实例锁、mDNS
 *  - domain/ ：项目扫描、会话读写、web 会话、预览/卡片/后端代理、文件操作、上传、模型、插件、GitHub、SSE、WS 桥接
 *  - routes/ ：HTTP 路由分发（system / catalog / sessions / preview / files / index）
 *  - 本文件  ：装配启停生命周期 + 保持既有对外导出兼容。
 */
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { getPortableRoot } from '../utils/envUtils.js'
import {
  clearGatewayPortFromDisk,
  clearGatewayTokenFromDisk,
  loadGatewayPortFromDisk,
  loadGatewayTokenFromDisk,
  saveGatewayPortToDisk,
  saveGatewayTokenToDisk,
  setGatewayToken,
} from '../utils/gatewayToken.js'
import { claimGatewayLock, probeGatewayHealth, releaseGatewayLock } from './core/lock.js'
import { mdnsStart, mdnsStop } from './core/mdns.js'
import {
  adoptWebSessions,
  cliClients,
  conversationDisplays,
  ENABLE_IDLE_RECLAIM,
  GATEWAY_IDLE_MINUTES,
  GLOBAL_PROJECT_LABEL,
  gwState,
  loadSessionModelLaunch,
  loadTurnEndAt,
  sessionActivity,
  sessionModels,
  sockets,
  sseClients,
  sseSizes,
} from './core/state.js'
import { hasClients, registerLifecycleHooks } from './core/transport.js'
import type { LocalGatewayInfo } from './core/types.js'
import { lanAddress, stampGatewayConsole } from './core/utils.js'
import { ensureBackend } from './domain/backends.js'
import { cardBackendKey, enabledCardBackends } from './domain/preview.js'
import { startSseHeartbeat, stopSseHeartbeat, stopSseWatches } from './domain/sse.js'
import { scheduleReclaim } from './domain/webSessions.js'
import { attachWsServers, startSocketHeartbeat, stopSocketHeartbeat } from './domain/wsBridge.js'
import { handleRequest } from './routes/index.js'

// ---- 对外兼容 re-export（保持重构前所有导出路径不变） ----
export type {
  EntryOpResult,
  FileWriteResult,
  LocalGatewayInfo,
  ProjectComment,
  StoredUploadFile,
  UploadDeclaration,
  UploadFallback,
  UploadKind,
  UploadReferenceFormat,
  UploadScope,
  UploadSlot,
  UploadSlotResolution,
} from './core/types.js'
export { resolveWithinRoot, sanitizeEntryName, sniffBinary } from './core/utils.js'
export {
  archiveProjectEntry,
  commentsFilePath,
  createProjectEntry,
  moveProjectEntry,
  readProjectComments,
  renameProjectEntry,
  trashProjectEntry,
  writeProjectComments,
  writeProjectFile,
} from './domain/files.js'
export {
  mentionElementsFor,
  readMentionElements,
  readMentionElementsIcon,
  readMentionElementsTitle,
} from './domain/preview.js'
export { archiveProject, deleteTempProject, renameProjectDir } from './domain/projectOps.js'
export {
  buildUploadReference,
  readUploadDecl,
  resolveUploadSlot,
  storeUploadFile,
  uploadProjectFile,
} from './domain/uploads.js'

function scheduleIdleShutdown(): void {
  if (gwState.idleTimer) {
    clearTimeout(gwState.idleTimer)
    gwState.idleTimer = null
  }
  if (!ENABLE_IDLE_RECLAIM || hasClients()) return
  gwState.idleTimer = setTimeout(() => {
    gwState.idleTimer = null
    if (hasClients()) return
    console.log(`[gateway] 无任何客户端连接，空闲超过 ${GATEWAY_IDLE_MINUTES} 分钟，自动关闭`)
    stopLocalGateway()
    process.exit(0)
  }, GATEWAY_IDLE_MINUTES * 60 * 1000)
  gwState.idleTimer.unref?.()
}

registerLifecycleHooks({ stopLocalGateway, scheduleIdleShutdown })

export async function startLocalGateway(opts?: {
  host?: string
  port?: number
  token?: string
}): Promise<LocalGatewayInfo> {
  stampGatewayConsole()
  gwState.gatewayStopping = false
  if (gwState.server) {
    const lan = lanAddress()
    return {
      port: gwState.currentPort,
      host: gwState.currentHost,
      token: gwState.currentToken,
      lanUrl: lan ? `http://${lan}:${gwState.currentPort}/?token=${gwState.currentToken}` : '',
      localUrl: `http://127.0.0.1:${gwState.currentPort}/?token=${gwState.currentToken}`,
    }
  }
  gwState.currentHost = opts?.host || process.env.GATEWAY_HOST || '0.0.0.0'
  gwState.currentPort = Number(opts?.port || process.env.GATEWAY_PORT || 8124)

  const isGatewayProc = process.argv.includes('--gateway')
  const bailOut = (reason: string): never => {
    console.log(`[gateway] ${reason}，本进程不接管网关`)
    if (isGatewayProc) process.exit(0)
    throw new Error(`gateway: ${reason}`)
  }
  const probeHost = gwState.currentHost === '0.0.0.0' ? '127.0.0.1' : gwState.currentHost
  if (await probeGatewayHealth(gwState.currentPort, probeHost)) {
    bailOut(`端口 ${gwState.currentPort} 已有存活网关在服务`)
  }
  const diskGatewayPort = loadGatewayPortFromDisk()
  if (
    diskGatewayPort &&
    diskGatewayPort !== gwState.currentPort &&
    (await probeGatewayHealth(diskGatewayPort, probeHost))
  ) {
    bailOut(`端口 ${diskGatewayPort} 已有存活网关在服务`)
  }
  if ((await claimGatewayLock(gwState.currentPort, probeHost)) !== 'owned') {
    bailOut('另一网关进程已持有单实例锁')
  }
  if (await probeGatewayHealth(gwState.currentPort, probeHost)) {
    releaseGatewayLock()
    bailOut(`端口 ${gwState.currentPort} 已有存活网关在服务`)
  }

  gwState.currentToken =
    opts?.token || process.env.SERVER_TOKEN || loadGatewayTokenFromDisk() || randomBytes(16).toString('hex')
  setGatewayToken(gwState.currentToken)

  const root = getPortableRoot()
  adoptWebSessions()
  loadTurnEndAt()
  loadSessionModelLaunch()
  scheduleIdleShutdown()
  scheduleReclaim()

  const server = createServer((req, res) => {
    void handleRequest(req, res, root)
  })
  gwState.server = server
  server.on('connection', (socket) => {
    socket.on('end', () => {
      if (!socket.writableEnded) socket.end()
    })
  })
  gwState.wss = attachWsServers(server, root)
  startSocketHeartbeat()
  startSseHeartbeat()

  let gatewayListened = false
  server.on('error', (err) => {
    if (gwState.server) {
      gwState.server.close()
      gwState.server = null
    }
    console.error(`[gateway] 启动失败: ${(err as Error).message}`)
    releaseGatewayLock()
    if (process.argv.includes('--gateway') && !gatewayListened) process.exit(1)
  })
  server.listen(gwState.currentPort, gwState.currentHost, () => {
    gatewayListened = true
    saveGatewayTokenToDisk(gwState.currentToken)
    saveGatewayPortToDisk(gwState.currentPort)
    console.log(
      `[gateway] 内置网关监听 http://${gwState.currentHost}:${gwState.currentPort} (token=${gwState.currentToken})`,
    )
    if (process.argv.includes('--gateway')) {
      const bootPreview = join(getPortableRoot(), '.claude', 'preview')
      for (const c of enabledCardBackends(bootPreview)) {
        void ensureBackend(cardBackendKey(GLOBAL_PROJECT_LABEL, c.id), c.cfg).catch((e: unknown) => {
          console.warn(`[gateway] 开机拉起全局应用 ${c.id} 失败: ${e instanceof Error ? e.message : String(e)}`)
        })
      }
    }
    if (gwState.currentHost === '0.0.0.0') mdnsStart()
  })

  const lan = lanAddress()
  return {
    port: gwState.currentPort,
    host: gwState.currentHost,
    token: gwState.currentToken,
    lanUrl: lan ? `http://${lan}:${gwState.currentPort}/?token=${gwState.currentToken}` : '',
    localUrl: `http://127.0.0.1:${gwState.currentPort}/?token=${gwState.currentToken}`,
  }
}

export function stopLocalGateway(): boolean {
  gwState.gatewayStopping = true
  if (gwState.idleTimer) {
    clearTimeout(gwState.idleTimer)
    gwState.idleTimer = null
  }
  stopSseWatches()
  mdnsStop()
  if (gwState.reclaimTimer) {
    clearInterval(gwState.reclaimTimer)
    gwState.reclaimTimer = null
  }
  stopSocketHeartbeat()
  stopSseHeartbeat()
  for (const c of sockets) {
    try {
      c.close()
    } catch {
      /* 忽略 */
    }
  }
  sockets.clear()
  for (const c of cliClients.values()) {
    try {
      c.close()
    } catch {
      /* 忽略 */
    }
  }
  cliClients.clear()
  for (const c of sseClients) {
    try {
      c.res.end()
    } catch {
      /* 忽略 */
    }
  }
  sseClients.clear()
  sseSizes.clear()
  gwState.ssePrimed = false
  conversationDisplays.clear()
  sessionActivity.clear()
  sessionModels.clear()
  setGatewayToken('')
  clearGatewayTokenFromDisk()
  clearGatewayPortFromDisk()
  try {
    gwState.wss?.close()
  } catch {
    /* 忽略 */
  }
  gwState.wss = null
  if (gwState.server) {
    gwState.server.close()
    gwState.server = null
    releaseGatewayLock()
    return true
  }
  releaseGatewayLock()
  return false
}
