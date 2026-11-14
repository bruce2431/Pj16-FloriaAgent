/**
 * localGateway.ts —— 内置私有化网关（feature: PRIVATE_GATEWAY）。
 *
 * 2026-08-17 网关独立化：网关以「同一 exe 的 --gateway 模式」作为独立进程运行（/server on
 * detached spawn 自身 exe），本模块即该网关进程的主体。CLI 进程（非网关宿主）启动后作为
 * WS 客户端连 /clients 注册自己的 sessionId（见 src/utils/gatewayClient.ts）；遥测端（浏览器）
 * 经 /ws 发消息，网关按 sessionId 跨进程路由转发给对应 CLI，由 CLI 侧 enqueue 注入其 REPL
 * （与打字同路径）。token 落盘便携根 .claude/gateway/token，供各 CLI 进程读取后上报/连接。
 *
 * 生命周期（2026-08-17）：网关以独立进程长驻，不随任何 CLI 退出而消失；「无客户端空闲自动回收」
 * ——CLI 注册(cliClients)/遥测 WS(sockets)/SSE(sseClients) 三集合全空持续 GATEWAY_IDLE_MINUTES
 * （默认 10，可用环境变量调）分钟后自动 stopLocalGateway + 清盘 token + 退出，避免孤儿网关占端口。
 * 停止途径：/server off（POST /gateway/shutdown）、空闲自动回收、SIGINT/SIGTERM、taskkill、系统关机。
 *
 * 复用已有实现：
 *  - 会话展示由 CLI 侧 conversationDisplay.ts 导出（POST /gateway/conversation），/gateway/session
 *    命中时优先返回 display；此处 jsonl 兜底读取仅用于 CLI 未导出的情况。
 *  - 注入路径与 useReplBridge.handleInboundMessage 相同：enqueue({mode:'prompt', bridgeOrigin:true})
 *    —— 现在在 CLI 进程（gatewayClient）内执行，而非本网关进程。
 *
 * HTTP/WS 用 node:http + ws（已验证可打包进 bun 编译产物），不依赖 Bun.serve。
 */
import { createServer, request as httpRequest, type Server } from 'node:http'
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, openSync, closeSync, truncateSync, unlinkSync, watch, mkdirSync, renameSync, createReadStream, type FSWatcher, type Dirent } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, resolve, dirname, extname, basename, sep, isAbsolute, delimiter } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import type { UUID } from 'crypto'
import { networkInterfaces } from 'node:os'
import { createSocket, type RemoteInfo } from 'node:dgram'
import { createServer as netCreateServer, createConnection as netCreateConnection } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { dlopen, FFIType, JSCallback, ptr } from 'bun:ffi'
import { WebSocketServer, WebSocket } from 'ws'
import { getPortableRoot, getClaudeConfigHomeDir } from '../utils/envUtils.js'
import {
  CUSTOMIZATION_DISABLED_MARKER,
  isCustomizationDirEnabled,
} from '../utils/customizationToggle.js'
import { FILE_CACHE_DIR, PENDING_FILE_DIR, getFileCacheDir } from '../utils/fileCache.js'
import { getProjectRoot } from '../bootstrap/state.js'
import {
  recordFileModifier,
  type FileModifierWriter,
} from '../utils/fileModifierRegistry.js'
import {
  extractJsonStringField,
  findLastCustomTitleCached,
  readSessionLite,
} from '../utils/sessionStoragePortable.js'
import { parseSessionInfoFromLite } from '../utils/listSessionsImpl.js'
import { filterConversationForDisplay } from '../utils/conversationDisplay.js'
import {
  setGatewayToken,
  saveGatewayTokenToDisk,
  clearGatewayTokenFromDisk,
  saveGatewayPortToDisk,
  clearGatewayPortFromDisk,
  loadGatewayTokenFromDisk,
  isGatewayTicket,
  touchGatewayTicket,
  gatewayDir,
} from '../utils/gatewayToken.js'

// 复用官方凭据池：模型校验与 CLI 同一来源（credentials.json activeProvider.models），
// 每会话切换不写全局凭据池（不 switchModel）；getActiveModel 与 CLI getUserSpecifiedModelSetting 同源。
// 全局默认模型（credentials.json activeProvider/activeModel）2026-10-11 起无运行期写入者——
// 唯一调整入口 = 直接改凭据池文件；网关只读全局值下发，写侧一律走会话级路由。
import { findModelProvider, getGlobalActiveModel, getGlobalActiveProviderConfig, isToolBoundModel, loadCredentials } from '../utils/credentials/pool.js'
import { modelSupportsVision } from '../utils/model/vision.js'
// 神经元可视化数据源（/gateway/neurons[/graph]，只读）：复用 neturon config/db 读取层
import { buildNeuronGraph, listNeuronsForGateway } from './neuronViz.js'
import { getCwdRoot, getGlobalRoot } from '../tools/neturon/config.js'
// 上下文占用（dsh ContextMeter 数据源）：复用 auto-compact 同源的模型上下文窗口解析，不本地复刻。
import { getContextWindowForModel } from '../utils/context.js'
// 会话重命名（2026-08-24 修复）：直接复用 CLI /rename 的落盘函数（saveCustomTitle + saveAgentName），
// 不本地复刻写盘格式——与 CLI 完全同路径，保证含 sessionId、CLI resume 能读到、退出不回退。
import { saveAgentName, saveCustomTitle } from '../utils/sessionStorage.js'
import { webAssets } from './web-assets.generated.js'
// 统一设置服务（2026-08-26 E）：写 effortLevel 走官方 updateSettingsForSource、读侧走官方
// getSettingsForSource（带缓存，写后自动失效），均不本地手解 settings.json。
// userSettings 在便携模式下解析到便携根 .claude/settings.json。
import { getSettingsFilePathForSource, getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js'
import type { SettingsJson } from '../utils/settings/types.js'
import type { ProviderConfig } from '../utils/credentials/types.js'
// effort 持久化守卫（2026-09-18）：与 CLI 同源——parseEffortValue 做边界解析，toPersistableEffort
// 保证落盘值合法（'max' 是 session-scoped，非 ant 不持久化；settings schema 非 ant 无 max，写进即整文件作废）。
import { parseEffortValue, toPersistableEffort } from '../utils/effort.js'
// P2 探活收敛（2026-08-27）：signal-0 探活唯一实现在官方 genericProcessUtils，不再保留本文件第二份
import { isProcessRunning } from '../utils/genericProcessUtils.js'

// ============================================================================
// 状态
// ============================================================================
let server: Server | null = null
let wss: WebSocketServer | null = null
let currentToken = ''
let currentHost = '0.0.0.0'
let currentPort = 8124
const sockets = new Set<WebSocket>()
// 2026-08-17 网关独立化：CLI 进程（非网关宿主）作为 WS 客户端连 /clients 注册自己的
// sessionId。遥测端发消息时网关按 sessionId 路由转发给对应 CLI，由 CLI 注入其 REPL。
const cliClients = new Map<string, WebSocket>()
// 2026-11-10 安全卸载：/clients 的 cli-hello 上报的真实 CLI pid，按 sessionId 存全部会话
// （此前只存 web spawn 在途/已入库的 webSessions）。eject 用它做「shutdown 后仍在」的树杀兜底——
// 终端直开的会话不再依赖 sessionActivity 是否已上报过 pid。重连窗口内保留，会话失联确认时删。
const cliPids = new Map<string, number>()
// 2026-08-31 防双进程（遥测端同步异常根修）：/clients 注册时间戳（每会话最近一次）。
// 普通 CLI 断连重连的 ~1s 窗口内 cliClients 暂 miss，此前 resume 链路直接 spawn → 与重连中的
// 原进程形成同会话双进程（每秒互踢乒乓 + 双写 jsonl，永不自愈，2026-08-30 92bbd49b 实锤）。
// 10s 内有注册痕迹 = 活进程在重连 → 复用不 spawn。痕迹不清理（仅时间戳，内存开销可忽略）。
const cliRegisterAt = new Map<string, number>()
const CLI_RECENT_REGISTER_MS = 10_000
// stuckSince（2026-10-14 SSE 半开根治，GPT 定案第一阶段⑤）：res.write() 返回 false（内核缓冲
// 满 = 背压）或写异常时记下起点；心跳循环里超 30s 未恢复 drain 即 destroy 摘除。
// res.write() 成功 ≠ 浏览器收到——写异常/背压是服务端唯一能观测到的死亡信号。
const sseClients = new Set<{ res: import('node:http').ServerResponse; stuckSince?: number }>()
let ssePrimed = false
const sseSizes = new Map<string, { size: number; mtime: number }>()
// O4：SSE 事件驱动 —— 用 fs.watch 监听各项目会话目录，替代 2s 轮询。sseWatches 持所有 watcher
// （key = 会话目录绝对路径），sseDebounce 合并同一波文件写入的多个 change/rename 事件（250ms 去抖），
// 避免频繁扫描。
const sseWatches = new Map<string, FSWatcher>()
let sseDebounce: NodeJS.Timeout | null = null
// 2026-08-17 空闲自动回收：三集合（cliClients/sockets/sseClients）全空持续 GATEWAY_IDLE_MINUTES
// 分钟后自动关闭网关，避免「所有 CLI/遥测端都退出、网关空转占端口」的孤儿状态。仅 --gateway
// 独立进程模式启用（进程内模式网关随 CLI 同生共死，无孤儿问题）。阈值可用 GATEWAY_IDLE_MINUTES 调。
const GATEWAY_IDLE_MINUTES = Number(process.env.GATEWAY_IDLE_MINUTES || 10)
// 本网关进程启动时刻（/gateway/health 的 boot）：前端据此区分「同网关刷新」与「换了网关」。
const GATEWAY_BOOT_AT = Date.now()
// 工作区根（全局根）在项目清单里的 label（findProjects 产出、前端 pickHome 同口径）
const GLOBAL_PROJECT_LABEL = '全局根 · 散装对话'
const ENABLE_IDLE_RECLAIM = process.argv.includes('--gateway')
let idleTimer: NodeJS.Timeout | null = null

// ============================================================================
// Web 容器 backend 进程管理（2026-08-19；2026-08-28 生命周期与网关解耦）
// preview.json 声明 backend 的项目 → 网关懒加载 spawn 后端进程 + 动态端口分配，
// 前端 iframe 本机直连 http://127.0.0.1:<port>/；远程宿主走同源代理 /backend/<label>/。
// 生命周期（2026-08-28 解耦定案）：后端进程不再随网关关停（/server off/restart、空闲退出、
// 网关硬杀均不 kill）——注册表落盘 .claude/gateway/backends.json，网关重启后 ensureBackend
// 按注册表收养存活进程（pid 活着 + 端口就绪），预览页刷新/重进秒开不再冷启动；后端仅由
// 空闲回收（preview.json idleMinutes）与用户手动关闭管理。根治「网关重启 → 后端冷启动 + 孤儿占端口漂移」。
// ============================================================================
interface BackendCfg {
  name?: string // 显示名（前端启动覆盖层提示用），缺省 = 项目 label；可插拔：任意后端在 preview.json 声明
  // 命令数组。占位符 spawn 时替换（expandBackendCmdArg）：{port}=分配到的端口；
  // {previewDir}=该项目 .claude/preview；{projectRoot}=项目根（previewDir 上两级）。
  cmd: string[]
  cwd: string // 工作目录（readBackendCfg 恒回填：preview.json 声明值解析后，或 preview 目录本身）
  port: number // 0 = 动态分配（网关从 8130 起探测顺延）
  idleMinutes?: number // 空闲回收阈值，缺省继承 GATEWAY_IDLE_MINUTES
  readyPath?: string // 就绪探测路径，缺省 /api/system_stats（项目后端自身 API，非网关前缀）
  // 该项目 .claude/preview 目录（readBackendCfg 回填，非 preview.json 字段）：后端日志
  // 落该目录下的 backend.log（2026-09-19 定案「一个文件就直接放」，不建 logs/ 子目录）。
  previewDir: string
}
// preview.json 的 cards 声明（2026-09-25 卡片化二期）：与 backend 并列的同一份「项目向宿主申报
// 界面能力」清单。宿主只按声明摆位、不解释卡片内容——卡源仍是项目自己的 .claude/preview/ 静态页，
// 走既有 /preview/<label>/* 托管（自包含与隔离边界见 docs/gateway.md §4/§6）。
interface PreviewCard {
  id: string
  title: string
  icon: string // @floria/web 图标表键，或 preview 目录内相对图片路径（相对卡页目录）；前端 core/icon-spec.js 校验，缺省 plug
  path: string // preview 目录内相对路径，可带 #片段（同页自我定位）
  host: 'view' // 渲染位置，由 preview 声明；本版只定义 view（主区独立视图卡）
  tab: boolean // host=view 时是否上侧栏 tab，缺省 true
  repo: string // 上游仓库（GitHub 等，用户填写；插件卡「应用」详情页展示与写入），缺省 ''
  // 启用态 = <previewDir>/<path 首段>/.disabled 不存在（与项目/卡同一判据，2026-11-07）
  enabled: boolean
  backendName: string // 该卡后端显示名（backend.name，缺省 title）；无后端 = ''
  backendCfg?: BackendCfg // 卡级后端声明（preview.json 应用卡可选 backend）
  elements: unknown[] // 卡级「可 @ 元素」声明原值（启用时才参与扫描；对外不下发）
}
// 预览工作区的独立卡片（2026-10-18）：<previewDir>/<id>/card.json，id = 目录名。
// 每张卡是一份独立静态页（entry 默认 index.html），宿主把它注册成右栏工具栏 tab；
// 卡片自带 title/order/default，宿主不猜渲染内容（与 PreviewCard 的外部调用语义分开）。
interface PreviewPaneCard {
  id: string
  title: string
  icon: string // @floria/web 图标表键，或卡目录内相对图片路径；前端 core/icon-spec.js 校验，缺省 plug
  entry: string // 卡目录内相对路径，默认 index.html
  order: number // tab 排序（小在前），缺省 100
  default: boolean // 默认激活卡（至多一张；无声明时取排序首张）
  repo: string // 上游仓库（GitHub 等，用户填写；插件卡「应用」详情页展示与写入），缺省 ''
  // 启用态 = 卡目录内 .disabled 不存在（2026-11-07 定案：状态载体是目录标记，网关可读、跨浏览器一致）
  enabled: boolean
  backendName: string // 该卡后端显示名（backend.name，缺省 title）；无后端 = ''
  backendCfg?: BackendCfg // 卡级后端声明（card.json 的 backend；cwd 相对卡目录解析）
}
// 元素声明（2026-11-13）：预览页向宿主申报的「可 @ 元素」，扫描源 = preview.json 顶层 elements[] 与
// 各卡 card.json 的 elements[]。insert 是落地唯一语义（宿主只按声明执行，不在前端硬编码元素含义）：
//   text  → 原文写入输入栏；token → 令牌原文写入（交后端/插件解读）；path → 项目根相对文件路径引用。
// path 用正斜杠、不得绝对、不得含 `.`/`..` 段（与预览资源同一路径校验）。
type MentionElementInsert =
  | { type: 'text'; text: string }
  | { type: 'token'; token: string }
  | { type: 'path'; path: string; pathType: 'file' | 'dir' }
interface MentionElement {
  id: string // ^[a-zA-Z0-9_-]{1,64}$，跨来源不重名
  name: string
  desc: string
  icon: string // @floria/web 图标表键，缺省 chip
  card: string // 声明来源卡标题（preview.json 顶层声明 = ''）
  insert: MentionElementInsert
}
// preview.json 的 quoteActions 声明（2026-09-28）：与 backend / cards 并列的第三种「项目向宿主申报
// 界面能力」清单——宿主选中引用浮窗（.quote-pop）里追加的动作行。动作是**纯数据**（无 path、不指向
// 文件）：点击后宿主只把 id 回发给预览页（floria-quote-action），执行逻辑留在项目页面自己的运行上下文。
interface PreviewQuoteAction {
  id: string
  title: string
  icon: string // core/icons.js I 表键（前端校验），缺省 plug
}
interface BackendProc {
  pid: number
  port: number
  cfg: BackendCfg
  startedAt: number
  lastActive: number // 最近一次活跃（/gateway/backend 被调用/就绪探测），用于空闲回收
  // 网关亲 spawn 的进程持有句柄；收养的（网关重启后接管现存进程）为 null，存活判定走 isPidAlive(pid)
  child: import('node:child_process').ChildProcess | null
}
const backendProcesses = new Map<string, BackendProc>()

// 后端注册表落盘（2026-08-28 生命周期解耦）：label → {pid, port, startedAt}。
// 写点 = Map 变化处（spawn 就绪/收养/kill/异常退出）；网关死后记录仍在，重启后收养。
function backendRegistryPath(): string {
  return join(gatewayDir(), 'backends.json')
}
function readBackendRegistry(): Record<string, { pid: number; port: number; startedAt: number }> {
  if (!existsSync(backendRegistryPath())) return {}
  const parsed: unknown = JSON.parse(readFileSync(backendRegistryPath(), 'utf8'))
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, { pid: number; port: number; startedAt: number }>)
    : {}
}
function persistBackendRegistry(): void {
  try {
    const reg: Record<string, { pid: number; port: number; startedAt: number }> = {}
    for (const [label, p] of backendProcesses) reg[label] = { pid: p.pid, port: p.port, startedAt: p.startedAt }
    const p = backendRegistryPath()
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, JSON.stringify(reg, null, 2))
  } catch {
    /* 忽略：磁盘瞬时故障由下个写点重试 */
  }
}
const BACKEND_PORT_BASE = 8130
const BACKEND_PORT_MAX = 8160
// 网关正在停止标志（O1 修复）：/server off → stopLocalGateway 置位，doSpawnBackend 就绪探测
// 循环据此提前退出并 kill 已 spawn 的子进程，避免「探测期网关停止 → 孤儿后端进程」竞态。
let gatewayStopping = false

// 2026-08-27 同源代理 /backend/<label>/（2026-08-29 全称定案，旧 /bp/ 保留解析兼容）：Web 容器 iframe 直连方案写死 http://127.0.0.1:<port>/，
// 仅在本机浏览器成立——遥测端（手机）打开预览时 127.0.0.1 指向手机自身 → 连接拒绝、页面永远转圈。
// 解法：后端仍只绑回环（访问面不变），流量经网关主端口转发（/backend/<label>/）。鉴权不靠 query token
// （页面内相对子请求不带 token，参考 /preview/* 子资源全 401 的教训），改用票证 cookie：
// /gateway/backend 本身受 token 校验，成功时种 HttpOnly cookie 作为 /backend/* 凭据（票证内含 label 白名单）。
const BP_COOKIE_NAME = 'floria_bp'
// 2026-08-28 floria 设备记忆票证：首链 ?token= 校验通过 → 种 HttpOnly cookie，之后 URL 不再携带 token。
// 校验二选一（query token 或本 cookie），票证落盘见 gatewayToken.ts；/server off 清盘全设备掉线。
const AUTH_COOKIE_NAME = 'floria_auth'
const BP_COOKIE_TTL_MS = 24 * 60 * 60 * 1000
const BP_COOKIE_KEY_RE = /^[0-9a-f]{32}$/
interface BpSession {
  labels: Set<string>
  expires: number
}
const bpSessions = new Map<string, BpSession>()

/** 解析 Cookie 请求头为键值表（值按 URI 组件反转义；无头/坏段安全跳过） */
function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
    } catch {
      /* 反转义失败跳过该段 */
    }
  }
  return out
}

/** 清扫过期票证（拷贝遍历防迭代中删除） */
function sweepBpSessions(now = Date.now()): void {
  for (const [k, s] of [...bpSessions]) if (s.expires <= now) bpSessions.delete(k)
}

// ============================================================================
// Web 独立会话（2026-08-23 遥测端会话与 CLI 等权）
// 每个 web 独立会话 = 网关 spawn 一个 cli-dev exe headless 子进程
// （-p --verbose --input-format stream-json --output-format stream-json），
// 复用同一 CLI 会话引擎/工具/权限/落盘格式，天然与 CLI 等权、真并行（独立进程，
// CLI 主进程退出不影响 web 会话）。web 消息经子进程 stdin 喂入，stdout NDJSON
// 逐行转发给订阅该会话的遥测端 WS；can_use_tool 审批请求转 approval 卡片。
// ============================================================================
interface WebSessionProc {
  sessionId: string
  /** 真实 CLI 进程 pid（2026-09-07 起由 cli-hello 上报补填——wt.exe 中转即退拿不到 pid。gracefulStopCli 用它做 3s 树杀兜底） */
  pid?: number
  clients: Set<WebSocket>
  startedAt: number
  lastActive: number // 最近活跃（消息/审批），用于空闲回收
}
const webSessions = new Map<string, WebSessionProc>()
// ============================================================================
// web 会话注册表落盘 + 重启收养（2026-08-29）
// 根因：/server restart → /gateway/shutdown → stopLocalGateway 曾 killAllWebSessions，
// 把「正在执行 restart 的 web 会话窗口自己」也杀了（CLI 死 → doOn 重拉网关永远不执行，
// restart 断在半路）。定案：web 会话与普通 CLI 会话同等权重——网关关停/重启一律不杀
// 存活窗口（gatewayClient 自动重连新网关）。代价是重启后内存注册表丢失 → resume 幂等
// （spawnWebSession 防双进程写同一 jsonl）失效，故注册表落盘（变更即写，防 kill -9 留脏），
// 网关启动时收养 pid 仍存活的条目。
// ============================================================================
const webSessionsRegistryPath = (): string => join(gatewayDir(), 'websessions.json')
function persistWebSessions(): void {
  const entries: Array<{ sessionId: string; pid: number; startedAt: number }> = []
  for (const p of webSessions.values()) {
    if (p.pid) entries.push({ sessionId: p.sessionId, pid: p.pid, startedAt: p.startedAt })
  }
  try {
    const p = webSessionsRegistryPath()
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, JSON.stringify(entries), 'utf8')
  } catch {
    /* 落盘失败不影响运行：最坏情况重启后收养不到，退化为 resume 重开窗口 */
  }
}
function adoptWebSessions(): void {
  const regPath = webSessionsRegistryPath()
  if (!existsSync(regPath)) return
  const raw: unknown = JSON.parse(readFileSync(regPath, 'utf8'))
  if (!Array.isArray(raw)) return
  const entries = raw as Array<{ sessionId: string; pid: number; startedAt: number }>
  for (const e of entries) {
    if (!e?.sessionId || !Number.isFinite(e.pid) || webSessions.has(e.sessionId)) continue
    if (!isPidAlive(e.pid)) continue
    webSessions.set(e.sessionId, {
      sessionId: e.sessionId,
      pid: e.pid,
      clients: new Set(),
      startedAt: Number(e.startedAt) || Date.now(),
      lastActive: Date.now(),
    })
    console.log(`[gateway] 收养存活 web 会话 ${e.sessionId} (PID ${e.pid})`)
  }
  persistWebSessions()
}
// 会话 → 项目根定位（2026-08-25 用户定案：resume 不依赖 web 注册表，改按磁盘会话文件定位）。
// 会话转录在 <项目根>/.claude/projects/<sessionId>.jsonl；扫描 findProjects 各组找该文件 →
// 项目 scope → {projectLabel}（供 webSessionProjectRoot/webSessionExe 路由 cwd 与 exe），
// 全局根命中 → {projectLabel: undefined}。找不到 → null（会话不存在于本机磁盘）。
// web 与 CLI 会话一视同仁：CLI 会话同样落 <cwd>/.claude/projects/，文件在即能恢复。
function sessionProjectRootOf(sessionId: string): { projectLabel?: string } | null {
  for (const g of findProjects(getPortableRoot())) {
    if (existsSync(join(g.dir, sessionId + '.jsonl'))) {
      return g.scope === 'project' ? { projectLabel: g.label } : {}
    }
  }
  return null
}
// web 会话启动 cwd（2026-08-24 用户定案：笔=全局根，项目=项目目录内）：
//  CLI 的 getProjectRoot() = 进程启动时的 cwd（state.ts getInitialState projectRoot: resolvedCwd），
//  会话 jsonl 自然落 <cwd>/.claude/projects/——所以只需把 cwd 指对，落盘位置即正确，无需额外落盘逻辑。
//  - project 指定（findProjects 命中的项目组，防任意路径）→ 该项目根目录；label 唯一命中，故
//    「全局根 · 散装对话」同样命中（= 工作区根 = getPortableRoot()，与未指定同一落点，非兜底）
//  - 未指定（笔/首页消息发送）→ 全局根（便携根 getPortableRoot() = @WrokSpace 散装对话区）
function webSessionProjectRoot(project: string | undefined): string {
  if (project && project.trim()) {
    const g = findProjects(getPortableRoot()).find((x) => x.label === project)
    if (g) return resolve(g.dir, '..', '..') // dir = <项目根>/.claude/projects → 上两级 = 项目根
  }
  return getPortableRoot()
}

// web 会话 exe 定位（2026-08-31 根修，取代 2026-08-24 目录扫描旧案）：
//  一律用网关自身 exe（process.execPath）——与网关同二进制，探测/注册协议必然匹配。
//  旧案「笔=全局根/项目=项目根下扫 cli-dev*.exe」废弃：08-30 网关 API 前缀迁 /gateway/* 且根
//  /api 撤空后，目录里的旧 exe（全局根仅 08-29 版 140859，Pj1/Pj11/Pj14/Pj17/Pj2 项目根更旧）
//  探测 /api/health 404 → 永不注册 → wsession 20s 超时 =「遥测端无法启动新会话」
//  （20260830222122 委派，异常1/2 双会话独立实锤）。会话落盘位置与 exe 来源无关
//  （cwd 由 webSessionProjectRoot 决定，08-24 落盘定案不受影响）。
function webSessionExe(): string {
  return process.execPath
}

// CLI 侧 conversationDisplay.ts 上报的展示结果（内存，进程退出即消失）
const conversationDisplays = new Map<string, { messages: unknown[]; updatedAt: number }>()
// CLI 侧 sendSessionActivity 上报的活动状态（内存，进程退出即消失）
const sessionActivity = new Map<string, { status: string; pid: number; cwd?: string; updatedAt: number }>()
// 2026-08-24 模型 web/CLI 同步：CLI 侧 reportCurrentModel 上报的每会话实际模型（内存，进程退出即消失）。
// 每会话模型 override 只存在于 CLI 进程内存，web 端 /gateway/session 据此读取校准模型 seat。
// 纯引擎内存态镜像，CLI 断开随 detach 删除（重连由 open reportCurrentModel 补报对齐）。
// 无时间 TTL（09-16：与 CLI「载荷不变不发」矛盾，见 sweepStaleMaps 注）。
const sessionModels = new Map<string, { model: string; updatedAt: number }>()
// 2026-11-06 思考等级按会话隔离（C）：每会话实际生效的 effortLevel 镜像（null = Off/未设置）。
// 写入点两处：① POST /gateway/model 带 sessionId 精确路由成功；② /gateway/model-report 的
// CLI 自报（GatewayControlBridge 收到 {type:'effort'} 后 reportSessionEffort）。读取点唯一：
// /gateway/session 附带 effort → web 进入会话即以该会话上报值校准推理等级座，不再沿用上一会话。
// 不写全局 settings.json（那是「新会话默认」，见 /gateway/model 无 sessionId 分支）。
const sessionEfforts = new Map<string, { effort: string | null; updatedAt: number }>()

// 会话启动模型表（2026-10-13，待办 12「重启会话模型不保持」根治）：
//   sid → { model, provider?, updatedAt }，落盘 .claude/gateway/sessionmodels.json（变更即写，
//   网关启动 loadSessionModelLaunch() 恢复，与 websessions.json 同构）。
// 语义 = 「该会话**下一次启动**用什么模型」的唯一状态源（区别于 sessionModels 的「在线会话
// 当前模型镜像」——后者 CLI 断开即 detach 清，进程死后无从取）。写入点两处：
//   ① POST /gateway/model 会话级路由成功（用户在 web 切模型，意图即「本会话此后用它」）；
//   ② POST /gateway/model-report 落值（CLI 自报实际生效模型，含启动 --model 的 open 补报——
//      由它闭环：新建时经 spawn --model 启动 → CLI open 补报 → 表记录 → 下次 resume 带同值）。
// 消费点唯一：spawnWebSession resume 时查表补 --model 启动参数。条目不删（sid 为 uuid 不复用，
// 孤儿条目无害；会话转录删除后条目永不再命中）。
const sessionModelLaunchPath = (): string => join(gatewayDir(), 'sessionmodels.json')
const sessionModelLaunch = new Map<string, { model: string; provider?: string; updatedAt: number }>()
function persistSessionModelLaunch(): void {
  try {
    const p = sessionModelLaunchPath()
    mkdirSync(join(p, '..'), { recursive: true })
    const entries: Array<{ sessionId: string; model: string; provider?: string; updatedAt: number }> = []
    for (const [sid, v] of sessionModelLaunch) {
      entries.push({ sessionId: sid, model: v.model, ...(v.provider ? { provider: v.provider } : {}), updatedAt: v.updatedAt })
    }
    writeFileSync(p, JSON.stringify(entries), 'utf8')
  } catch {
    /* 落盘失败不影响运行：最坏情况重启后 resume 不带模型，退化为跟随全局默认 */
  }
}
function loadSessionModelLaunch(): void {
  const p = sessionModelLaunchPath()
  if (!existsSync(p)) return
  try {
    const raw: unknown = JSON.parse(readFileSync(p, 'utf8'))
    if (!Array.isArray(raw)) return
    for (const e of raw as Array<{ sessionId?: unknown; model?: unknown; provider?: unknown; updatedAt?: unknown }>) {
      if (!e || typeof e.sessionId !== 'string' || !e.sessionId) continue
      if (typeof e.model !== 'string' || !e.model.trim()) continue
      sessionModelLaunch.set(e.sessionId, {
        model: e.model.trim(),
        ...(typeof e.provider === 'string' && e.provider.trim() ? { provider: e.provider.trim() } : {}),
        updatedAt: Number.isFinite(e.updatedAt) ? Number(e.updatedAt) : Date.now(),
      })
    }
  } catch {
    /* 坏文件当不存在：启动模型回落全局默认，与表缺席同语义 */
  }
}
/** 写入并落盘（两个写入点共用；provider 可省——resume 消费只用 model 名，--model 启动后
 *  CLI 自会按 findModelProvider 补绑 provider，见 main.tsx 启动段）。 */
function recordSessionModelLaunch(sid: string, model: string, provider?: string): void {
  if (!sid || !model.trim()) return
  sessionModelLaunch.set(sid, { model: model.trim(), ...(provider ? { provider } : {}), updatedAt: Date.now() })
  persistSessionModelLaunch()
}
// 2026-08-30 共同后端队列快照（接力文档清单#2）：CLI 侧 /clients WS queue-state 上报的当前
// 排队项（仅用户 prompt）。web 排队区置底数据源：/gateway/session.queued 首载 + SSE queue-state 增量。
// 纯引擎内存态镜像，CLI 断开即随 detach 删除。无时间 TTL（09-12：与 CLI「载荷不变不发」矛盾，
// 见 sweepStaleMaps 注）。
const sessionQueues = new Map<
  string,
  { items: Array<{ content: string; ts: number; from?: { title: string; sid?: string } }>; updatedAt: number }
>()
// 2026-09-10 web 底栏任务浮窗数据源：CLI 侧 /clients WS task-state 上报的当前可见任务清单
//（TodoV2 TasksV2Store 单源出口快照，与 CLI TaskListV2 同源）。首载 = /gateway/session.tasks，
// 增量 = SSE task-state。纯引擎内存态镜像，CLI 断开随 detach 删除（重连由 task-state 补发对齐）。
// 无时间 TTL（09-12：与 CLI「载荷不变不发」矛盾，见 sweepStaleMaps 注）。
// 字段对齐 CLI 源码 TaskSchema（utils/tasks.ts）+ TaskListV2 实际渲染列：状态图标/subject/
// owner/进行中活动/阻塞计数。description 等长文本不透传（web 浮窗只显示清单行）。
type GatewayTaskItem = {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  owner?: string
  activeForm?: string
  blockedBy: string[]
}
const sessionTasks = new Map<string, { tasks: GatewayTaskItem[]; updatedAt: number }>()

/** CLI task-state 载荷净化：丢弃结构不符项，字段裁剪到浮窗所需最小集（形状边界在网关收口）。 */
function normalizeGatewayTasks(raw: unknown): GatewayTaskItem[] {
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
      blockedBy: Array.isArray(t.blockedBy) ? (t.blockedBy as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    })
  }
  return out
}
// 2026-09-06 web 打断收口二轮：回合被中止的网关权威时刻（per-session）。打断后 jsonl 零写入，
// 本时刻是刷新后恢复收口判定的唯一持久源（turn-state SSE 只覆盖不刷新的实时路径）；无 TTL、
// 不入 sweepStaleMaps——被打断的回合永无回复，语义同前端 turnEndFlags「无 TTL 防运行态复活」。
// 2026-09-07 落盘持久化（.claude/gateway/turnend.json，变更即写、启动恢复）：重启不杀 CLI 进程（09-05
// 不杀定案），重启前被打断的回合其收口信号必须跨重启存活——否则 CLI 重连重报 activity 后 state
// 恢复非 null，两收口信号全失，「正在处理」无限计时复活（09-06 2h26m 挂死的重启回归路径）。
// 旧注释「重启连坐杀全部 CLI 进程 → state=null 先行收口」系不杀定案前的时代残留，已作废。
const turnEndAt = new Map<string, number>()
const turnEndAtPath = (): string => join(gatewayDir(), 'turnend.json')
function persistTurnEndAt(): void {
  try {
    const p = turnEndAtPath()
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, JSON.stringify(Object.fromEntries(turnEndAt)), 'utf8')
  } catch {
    /* 落盘失败不影响运行：最坏情况重启后该次打断收口退化为内存态丢失 */
  }
}
function loadTurnEndAt(): void {
  try {
    const raw: unknown = JSON.parse(readFileSync(turnEndAtPath(), 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    for (const [sid, ts] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) turnEndAt.set(sid, ts)
    }
  } catch {
    /* 无文件/坏 JSON：视为空（首次启动常态） */
  }
}
// 2026-09-07 web 僵死感知：CLI 引擎每产出真实增量经 /clients 上报 turn-beat（gatewayClient 4s
// 节流），记每会话最后活性时刻；SSE 群发 → web 运行态计时 tick 对账，beat 落后超阈值显「无响应」。
// 进程/WS 活但 query 链僵死时 beat 恒停 = web 唯一可判信号（60s activity 心跳测不出 query 僵死）。
// 仅内存运行态：turn-state(live:false) 即删、detach 进 3s 复核窗到期未重连才删（09-08），
// 不入落盘与 sweep（过期由 web 阈值判定消化）。
const turnBeatAt = new Map<string, number>()
// 2026-09-08 事件流统一 P1（方案 20260908135557）：session-delta 的 per-session 单调 seq 记账。
// 网关只做去重（seq <= last 丢弃，防 CLI 重发/广播竞态）与重置（cli-hello = 新 CLI 进程 seq 流
// 重启），不缓存 delta 历史——丢失靠 web 端 seq gap → 全量对账恢复（无状态转发定案 §3.5）。
// 仅内存：网关重启即空，CLI 重连（session-up → web 全量对账 + /gateway/session 附 deltaSeq）自然对齐。
const sessionDeltaSeq = new Map<string, number>()
// 2026-09-08 detach 复核窗：/clients WS 断开后延迟收口（activity null 群发/表清理）的定时器表。
// 窗口内重连即静默跳过；同 sid 重复 detach 由 clearTimeout 去重。兜底语义与 session-down 一致：
// 进程失联确认才收口，重连窗内 web 保持最后快照不感知。
const detachTimers = new Map<string, ReturnType<typeof setTimeout>>()
// C1 修复：内存 Map 无上限（只增不删）→ 长跑泄漏。加 TTL + 死进程惰性清扫。
// 2026-09-12：sessionQueues/sessionTasks 退出时间 TTL（原 SESSION_QUEUE_TTL_MS/SESSION_TASK_TTL_MS
// 删除）——CLI 上行契约「载荷不变不发」（notifyTaskState 去重 / queue-state 事件驱动）与时间 TTL
// 直接矛盾：活跃会话里清单 10 分钟不变即被 sweepStaleMaps 清仓 → /gateway/session 首载/刷新拉到
// [] 当权威 → web 任务浮窗/排队区消失（09-12「任务浮窗不刷新」实证：回合 2h4m 长工具期清单未变
// 被清）。生命周期不变量收敛为「清单态只属于在线 CLI 进程」：上报 upsert + detach 删除 + 重连
// open 补发 + 网关重启空表由 CLI 重连补发对齐（gatewayClient openSocket sendQueueState/sendTaskState）。
// 2026-09-16：sessionModels 同构退出时间 TTL（原 SESSION_MODEL_TTL_MS 删除）——reportCurrentModel
// 只在 WS open + 切模型时上报，模型 10 分钟不变即被清 → /gateway/session model=null → web seat
// 校准跳过停在 localStorage 旧值（09-16「iPad 显示 deepseek 实际 glm」实证）。
const DISPLAY_TTL_MS = 10 * 60 * 1000 // conversationDisplays 10 分钟无刷新视为过期
const ACTIVITY_TTL_MS = 10 * 60 * 1000 // sessionActivity 10 分钟无上报视为过期
const MAX_REPORT_BODY_BYTES = 1024 * 1024
// 编辑区单次写回上限：对齐 GET /gateway/file 的 4 MB 读侧上限（能读到的就能写回）
const MAX_FILE_WRITE_BYTES = 4 * 1024 * 1024

// ============================================================================
// 小工具
// ============================================================================
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isPathInside(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(parent + sep)
}

class ReportBodyTooLargeError extends Error {}

/** 限流读原始 body（JSON 上报与文件上传共用；超限抛 ReportBodyTooLargeError → 413） */
async function readBodyWithLimit(req: import('node:http').IncomingMessage, maxBytes: number): Promise<Buffer> {
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

async function readReportBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse((await readBodyWithLimit(req, MAX_REPORT_BODY_BYTES)).toString('utf8') || '{}')
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}
function lanAddress(): string | null {
  const addrs: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address)
    }
  }
  // 优先真实私有局域网网段，跳过 VPN/代理虚拟网卡（198.18.x benchmark 段、Tailscale 100.x 等）
  const pick = (re: RegExp) => addrs.find((a) => re.test(a))
  return (
    pick(/^192\.168\./) ||
    pick(/^10\./) ||
    pick(/^172\.(1[6-9]|2\d|3[01])\./) ||
    addrs[0] ||
    null
  )
}

// ============================================================================
// mDNS 应答器（2026-08-29 floria.local 自广播）：网关在 UDP 5353 多播组应答 floria.local
// 的 A 查询，返回本机全部局域网 IPv4 —— 任何同 WiFi/热点设备打开 http://floria.local:<port>/
// 即免配置连入（Apple/Windows 原生 mDNS 解析 .local；Android 浏览器支持差，IP 直连兜底）。
// 地址发现与 HTTP 绑定解耦：HTTP 仍绑 0.0.0.0，mDNS 只解决「设备怎么找到本机 IP」——
// 应答时实时读网卡，无需配置路由器 DNS（热点场景同样工作）。
// 手写最小应答器（查询解析 + A 记录构造），不引 multicast-dns 依赖（bun compile 下
// dgram 多播 bind/addMembership/send 已实测可用）；5353 被其它 mDNS 服务占用时静默
// 放弃（自动路径禁抢端口，回落 IP 直连）。
// ============================================================================
const MDNS_NAME = 'floria.local'
const MDNS_PORT = 5353
const MDNS_GROUP = '224.0.0.251'
// 300s：设备侧缓存时长。旧值 120s 太短——TTL 一到期设备就必须重新走一次「查询→应答」，
// 而该链路任一环丢包（5353 被 msedge/svchost 多进程复用抢包、AP 多播抑制）即解析失败，
// 表现为「floria.local 概率性打不开」。拉长到 300s 把重查询频率降到 1/2.5，再配合 60s
// 多播 announce 保活（见 mdnsAnnounceOne），正常网络下设备缓存永不过期、根本不再重查询；
// IP 变化时旧缓存最多多留 3 分钟，由 30s watch 重绑 + 保活推新地址覆盖。
const MDNS_RECORD_TTL = 300
// 2026-08-31 多接口根修：旧版单 socket bind 首个 LAN 地址，Windows 上绑定具体单播 IP 的
// socket 只收该接口的组播（addMembership 指定其它接口对其无效）——热点（移动热点虚拟适配器
// 192.168.137.1）与 WLAN 并存时，热点侧 iPad 的查询 WLAN socket 收不到 → floria.local 永不
// 解析。改为每 LAN IP 一个 socket（bind 该 IP + 该接口入组）：应答从查询到达的 socket 发出，
// 源 IP/出接口天然正确；A 记录只回该 socket 的 bind IP（查询来自哪个网段就回哪个可达地址，
// 不再让设备先试到别的网段 IP 拖慢/失败）。
const mdnsSockets = new Map<string, ReturnType<typeof createSocket>>() // bind IP → socket
const mdnsPendingBinds = new Set<string>() // bind 异步期间占位，防 watch 轮询重复发起
// 网络切换自愈（2026-08-30 热点根修）：30s 轮询实时读网卡，LAN 地址集合变化即全量重建。
let mdnsWatchTimer: ReturnType<typeof setInterval> | null = null
const MDNS_WATCH_INTERVAL = 30_000
// 周期 announce 保活（2026-09-01 起为 iPhone 热点根修的主动推送；2026-09-16 扩为「多播为主、
// 子网单播枚举为辅」）：不等设备查询，周期性主动推 floria.local A 记录，让设备侧缓存常新。
// 多播路径刷新网段内全部设备（标准 announce），单播枚举路径覆盖吞多播的热点/AP 网络——
// 设备接入、锁屏唤醒、以及 TTL 到期后都无需再走「查询→应答」（该链路丢包即解析失败）。
// 周期 60s 远小于 TTL(300s)，抗连续丢包；设备接入/唤醒后最多一个周期自动恢复。
let mdnsAnnounceTimer: ReturnType<typeof setInterval> | null = null
const MDNS_ANNOUNCE_INTERVAL = 60_000
// 查询触发回推的节流表（源 IP → 上次回推时刻）
const mdnsAnnounceSeen = new Map<string, number>()
// 名字内联编码（announce 无问题段，压缩指针无处可指）：\x06floria\x05local\x00
const MDNS_NAME_ENC = Buffer.concat([
  Buffer.from([6]),
  Buffer.from('floria', 'latin1'),
  Buffer.from([5]),
  Buffer.from('local', 'latin1'),
  Buffer.from([0]),
])

interface MdnsIf {
  address: string
  netmask: string
}

function mdnsLanIfs(): MdnsIf[] {
  const out: MdnsIf[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ address: ni.address, netmask: ni.netmask })
    }
  }
  // 过滤不可用网段（169.254 link-local、198.18 benchmark 段、Tailscale 100.64-127 CGNAT 段），
  // 避免设备先试到不可达地址拖慢连接
  return out.filter(
    (x) =>
      !x.address.startsWith('169.254.') &&
      !/^198\.18\./.test(x.address) &&
      !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(x.address),
  )
}

function mdnsLanAddrs(): string[] {
  return mdnsLanIfs().map((x) => x.address)
}

// 读 DNS 报文 QNAME（标签序列 + 压缩指针防御）：返回点分名与问题段结束所需 next 偏移
function mdnsReadName(buf: Buffer, offset: number): { name: string; next: number } | null {
  const labels: string[] = []
  let ptr = offset
  let next = -1
  for (let i = 0; i < 32; i++) {
    const len = buf[ptr]
    if (len === undefined) return null
    if (len === 0) {
      return { name: labels.join('.'), next: next === -1 ? ptr + 1 : next }
    }
    if ((len & 0xc0) === 0xc0) {
      if (next === -1) next = ptr + 2
      const target = ((len & 0x3f) << 8) | buf[ptr + 1]
      if (target === undefined) return null
      ptr = target
      continue
    }
    labels.push(buf.subarray(ptr + 1, ptr + 1 + len).toString('latin1'))
    ptr += 1 + len
  }
  return null
}

// A 资源记录（TYPE A + CLASS + TTL + RDLENGTH 4 + IP）。nameField = 名字字段字节：
// 查询应答里传压缩指针 0xc00c（指向应答包偏移 12 的问题段），announce 里传内联全名
// MDNS_NAME_ENC（QD=0 的包没有可指的问题段，指针无目标）。cls 传 1（普通）/0x8001
// （多播 announce 的 cache-flush 位；RFC 6762 §18.11 规定单播应答中该位必须为 0）。
function mdnsAddrRecord(nameField: Buffer, ip: string, cls: number): Buffer {
  const rec = Buffer.alloc(nameField.length + 14)
  nameField.copy(rec, 0)
  rec.writeUInt16BE(1, nameField.length) // TYPE A
  rec.writeUInt16BE(cls, nameField.length + 2)
  rec.writeUInt32BE(MDNS_RECORD_TTL, nameField.length + 4)
  rec.writeUInt16BE(4, nameField.length + 8) // RDLENGTH
  const octets = ip.split('.').map(Number)
  for (let i = 0; i < 4; i++) rec[nameField.length + 10 + i] = octets[i] & 0xff
  return rec
}

function mdnsStart(): void {
  if (mdnsSockets.size) return
  // 每个 LAN IP 一个 socket（多接口根修，见 mdnsSockets 注释）。Meta TUN（198.18.0.1）等
  // 已被 mdnsLanAddrs 过滤，bind 恒为真实接口地址（2026-08-29 Meta TUN 根修延续：Windows 上
  // 绑定特定单播地址压过多播路由 metric，bun 的 setMulticastInterface 无效）。
  // 无 LAN 地址（DHCP 未就绪等）不建 socket，等 mdnsWatch 下轮重试（旧版降级 bind 0.0.0.0
  // 会被 Meta TUN 吸走多播，弃用）。
  for (const ip of mdnsLanAddrs()) mdnsStartOne(ip)
  // timer 无条件启动（2026-08-31 自旋根修）：bind 是异步的，mdnsStart 返回时 mdnsSockets 尚空，
  // 旧条件 `mdnsSockets.size &&` 恒 false → watch 从未启动 → 网络切换后应答器永远绑死旧地址
  // （热点场景 floria.local 永不解析的直接根因）。watch 对比集合自动收敛，无需 map 非空前置。
  if (!mdnsWatchTimer) mdnsWatchTimer = setInterval(mdnsWatch, MDNS_WATCH_INTERVAL)
  if (!mdnsAnnounceTimer) {
    mdnsAnnounceTimer = setInterval(() => {
      for (const ip of mdnsSockets.keys()) mdnsAnnounceOne(ip, false)
    }, MDNS_ANNOUNCE_INTERVAL)
  }
}

function mdnsStartOne(ip: string): void {
  if (mdnsPendingBinds.has(ip) || mdnsSockets.has(ip)) return
  mdnsPendingBinds.add(ip)
  const sock = createSocket({ type: 'udp4', reuseAddr: true })
  sock.on('error', () => {
    // 5353 被占/防火墙拒绝等：该接口静默退出（其余接口照常），不拖垮网关
    mdnsPendingBinds.delete(ip)
    try {
      sock.close()
    } catch {
      /* 忽略 */
    }
    if (mdnsSockets.get(ip) === sock) mdnsSockets.delete(ip)
    console.error(`[gateway] mDNS 应答器启动失败（${ip}，该接口回落 IP 直连）`)
  })
  sock.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
    try {
      mdnsHandleQuery(sock, ip, msg, rinfo)
    } catch {
      /* 忽略坏包 */
    }
  })
  sock.bind(MDNS_PORT, ip, () => {
    mdnsPendingBinds.delete(ip)
    try {
      sock.addMembership(MDNS_GROUP, ip)
      mdnsSockets.set(ip, sock)
      console.log(`[gateway] mDNS 应答器就绪：floria.local → ${ip}`)
      // RFC 6762 §8.3 announce 应连发 ≥2 次（间隔 ≥1s）：三连发覆盖新设备刚入网窗口，
      // UDP 丢包不必等 60s 周期（周期轮保持单发）
      for (const delay of [0, 1000, 2000]) setTimeout(() => mdnsAnnounceOne(ip, false), delay)
      console.log(`[gateway] mDNS announce 保活启动：floria.local → ${ip}（多播 + 子网单播，3 连发）`)
    } catch (e) {
      try {
        sock.close()
      } catch {
        /* 忽略 */
      }
      if (mdnsSockets.get(ip) === sock) mdnsSockets.delete(ip)
      console.error(`[gateway] mDNS 入组失败（${ip}）: ${(e as Error).message}`)
    }
  })
}

// 轮询检测网络变化：与 socket 集合 diff 增量增删（2026-09-01 抖动根修：旧版集合不等即
// 全量 stop/start——日志实证热点 IP 每分钟在 172.20.10.x 与其它接口间抖动，一次抖动就把
// 健康接口一起拆掉，服务网段出现 30s 无人应答窗口；增量化后未变化接口的 socket/announce
// 常驻，仅补缺失、关多余）。
// 无地址（断网抖动瞬间）不动，保持旧 socket 自生自灭，避免中途降级。
function mdnsWatch(): void {
  const cur = new Set(mdnsLanAddrs())
  let changed = false
  for (const [ip, sock] of [...mdnsSockets]) {
    if (cur.has(ip)) continue
    changed = true
    try {
      sock.close()
    } catch {
      /* 忽略 */
    }
    mdnsSockets.delete(ip)
  }
  for (const ip of cur) {
    if (mdnsSockets.has(ip) || mdnsPendingBinds.has(ip)) continue
    changed = true
    mdnsStartOne(ip)
  }
  if (changed) console.log(`[gateway] mDNS 接口变化，现绑：${[...mdnsSockets.keys()].join('/') || '无'}`)
}

function mdnsHandleQuery(sock: ReturnType<typeof createSocket>, bindIp: string, msg: Buffer, rinfo: RemoteInfo): void {
  if (msg.length < 12 + 5) return
  // QR=1（应答）不处理：无参 addMembership 落在默认多播接口（Meta TUN 时 = 198.18.0.1），
  // 本机自发的多播应答经 IP_MULTICAST_LOOP 回环后会被自己收到——无此检查会形成应答→再应答
  // 的本地反馈循环（2026-08-29 实证：单条查询收到 2 条应答）
  if (msg.readUInt16BE(2) & 0x8000) return
  // 任一 mDNS 查询到达即单播回推 announce（30s/源节流）：设备刚入网/亮屏时 iOS 先发系统
  // 服务查询（_companion-link/_rdlink 等），此刻回推让 floria.local 缓存立即建立，不等周期
  const lastSeen = mdnsAnnounceSeen.get(rinfo.address) ?? 0
  if (Date.now() - lastSeen > 30_000) {
    mdnsAnnounceSeen.set(rinfo.address, Date.now())
    console.log(`[gateway] mDNS 单播回推 announce → ${rinfo.address}（30s/源节流）`)
    mdnsAnnounceToPeer(bindIp, rinfo.address)
  }
  const qdcount = msg.readUInt16BE(4)
  console.log(`[gateway] mDNS 查询到达：${rinfo.address}:${rinfo.port}（QD=${qdcount}）`)
  if (qdcount < 1) return
  // 逐问题扫描（2026-08-29 打包查询根修）：iOS mDNSResponder 会把 floria.local 与
  // _companion-link/_rdlink 等系统服务发现打包进同一查询（QD>1），floria.local 常不在首位；
  // 旧逻辑只读首个 QNAME → 整包忽略 → iPad 侧永不解析成功（现场取证：iPad 5 连查零应答，
  // 同窗本机单问题查询秒应答）。取首个匹配 floria.local 的问题（A/ANY）作答。
  let off = 12
  let hit = -1 // 匹配问题的序号；-1 = 无
  let hitType = 1
  let hitClass = 1
  for (let qi = 0; qi < qdcount && off + 1 < msg.length; qi++) {
    const parsed = mdnsReadName(msg, off)
    if (!parsed || parsed.next + 4 > msg.length) return
    const qtype = msg.readUInt16BE(parsed.next)
    const qclass = msg.readUInt16BE(parsed.next + 2)
    if (hit < 0 && parsed.name.toLowerCase() === MDNS_NAME && (qtype === 1 || qtype === 255)) {
      hit = qi
      hitType = qtype
      hitClass = qclass & 0x7fff // 清 QU 位（RFC 6762 §5.4：应答中部不应带 unicast-response 位）
    }
    off = parsed.next + 4
  }
  if (hit < 0) return
  // A 记录只回查询到达接口的 bind IP（多接口根修）：设备从哪个网段问，就答哪个网段的可达地址
  const addrs = [bindIp]
  // 应答：header(QR=1 AA=1) + 匹配问题段【重新编码】+ 1 条 A 记录（NAME 用压缩指针 0xc00c
  // 指向应答包内偏移 12 = 我们重写的问题段起始）。
  // ⚠️ 2026-09-16 概率性失败根修：旧版把匹配问题的**原始字节** subarray 复制进应答，而 iOS
  // mDNSResponder 的打包查询（QD>1）里 floria.local（常不在首位）名字多用**压缩指针**指向包内
  // 别处（如 _companion-link._tcp.local 的 'local' 标签）——指针复制到新包后指向错位，设备端
  // 解出的问题名退化成 "floria"（探针实测：QD=1 [floria]），问题段与自己的查询不匹配 → 整个
  // 应答被丢弃 → 设备重试。设备这次是否把 floria.local 排首位、是否用指针，决定应答是否作数，
  // 宏观表现就是「floria.local 概率性打不开」。故问题段一律用内联全名重编码，绝不复制原字节。
  const header = Buffer.alloc(12)
  // ID：源端口 5353 的标准 mDNS 查询 → ID=0（RFC 6762 §18.1）；legacy 查询（随机源端口，
  // Windows/Node 等解析器）→ 必须回显查询 ID（§6.7），旧版恒写 0 会被这类解析器丢弃
  header.writeUInt16BE(rinfo.port === MDNS_PORT ? 0 : msg.readUInt16BE(0), 0)
  header.writeUInt16BE(0x8400, 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(addrs.length, 6)
  const qtail = Buffer.alloc(4)
  qtail.writeUInt16BE(hitType, 0)
  qtail.writeUInt16BE(hitClass || 1, 2)
  const question = Buffer.concat([MDNS_NAME_ENC, qtail])
  const namePtr = Buffer.from([0xc0, 0x0c])
  const reply = Buffer.concat([header, question, ...addrs.map((ip) => mdnsAddrRecord(namePtr, ip, 1))])
  // 双发（2026-08-29）：多播应答（组内标准路径）+ 单播回源——iOS 查询（源端口 5353）可达 PC，
  // 但应答走多播组回程时常被 AP 的 IGMP snooping/多播抑制丢弃（实测设备解析不到 floria.local），
  // 单播直达查询者穿该抑制；mDNS 应答幂等，设备收两份无害。legacy 查询（随机源端口）本就单播。
  sock.send(reply, MDNS_PORT, MDNS_GROUP, () => {})
  sock.send(reply, rinfo.port, rinfo.address, () => {})
}

// ---- 单播 announce（2026-09-01，见 mdnsAnnounceTimer 注释）----

// announce 报文（2026-09-01 legacy 格式化）：header(QR=1 AA=1, QD=1 AN=1) + 问题段
// floria.local A IN + 1 条 A 记录（0xc00c 压缩指针指向偏移 12 问题段起始）。
// 带问题段是关键：无问题段的纯 answer 单播属 unsolicited，iPad mDNSResponder 实测无视
// （08-31 无 announce 与 09-01 纯 answer announce 两次热点实测均不解析，其余链路相同）；
// 带问题段的 legacy unicast response 走 mDNSResponder 常规应答通道（商用 mDNS 网关同款做法）。
function mdnsAnnouncePacket(bindIp: string): Buffer {
  const question = Buffer.concat([MDNS_NAME_ENC, Buffer.from([0, 1, 0, 1])]) // QTYPE=A QCLASS=IN
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x8400, 2) // QR=1 AA=1（ID=0：legacy 应答无匹配查询时规范值）
  header.writeUInt16BE(1, 4) // QDCOUNT=1
  header.writeUInt16BE(1, 6) // ANCOUNT=1
  // CLASS IN：RFC 6762 §18.11 单播应答中 cache-flush 位必须为 0（0x8001 仅多播合法，
  // iOS mDNSResponder 严格实现会拒收）——单播 announce 不依赖该位，靠周期重发保新鲜
  return Buffer.concat([header, question, mdnsAddrRecord(Buffer.from([0xc0, 0x0c]), bindIp, 1)])
}

// 多播 announce（2026-09-16 概率性失败根修）：单播 announce 本质是 unsolicited unicast
// response，mDNSResponder 对「没有匹配 outstanding query」的单播包多数直接丢弃——09-01 三轮
// 单播根修只在设备刚发过查询的 30s 窗口内有效，设备 TTL 一到期仍必须重新查询，而重查询链路
// （5353 被 msedge/svchost 多进程复用抢包、AP 多播抑制）任一环丢包即解析失败，宏观表现就是
// 「floria.local 概率性打不开」。多播 announce 是 RFC 6762 §8.3 的标准路径，设备无条件接受
// 并刷新缓存：60s 周期（< TTL/2）推送后设备侧缓存永不过期，正常网络下不再触发重查询。
// 报文 QD=0（announce 无问题段，名字只能内联）+ class 0x8001（cache-flush，声明权威数据）。
function mdnsMulticastAnnouncePacket(bindIp: string): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x8400, 2) // QR=1 AA=1
  header.writeUInt16BE(0, 4) // QDCOUNT=0
  header.writeUInt16BE(1, 6) // ANCOUNT=1
  return Buffer.concat([header, mdnsAddrRecord(MDNS_NAME_ENC, bindIp, 0x8001)])
}

const ipToU32 = (s: string) =>
  s.split('.').reduce((acc, o) => (acc << 8) + (Number(o) & 0xff), 0) >>> 0

function mdnsSameSubnet(a: string, b: string, netmask: string): boolean {
  const m = ipToU32(netmask)
  return ((ipToU32(a) & m) >>> 0) === ((ipToU32(b) & m) >>> 0)
}

// 同子网全部主机地址（排除网络地址/广播地址/自身）；网段总地址数 > 512 返回空——
// 大网段（校园网 /16 等）全网枚举推送纯属浪费，定向推（mdnsPushToReachableClient）不受此限
function mdnsSubnetPeers(ip: string, netmask: string): string[] {
  const ipN = ipToU32(ip)
  const maskN = ipToU32(netmask)
  const base = (ipN & maskN) >>> 0
  const size = (~maskN >>> 0) + 1
  if (size > 512) return []
  const out: string[] = []
  for (let n = 1; n < size - 1; n++) {
    const a = (base + n) >>> 0
    if (a === ipN) continue
    out.push([(a >>> 24) & 0xff, (a >>> 16) & 0xff, (a >>> 8) & 0xff, a & 0xff].join('.'))
  }
  return out
}

function mdnsAnnounceOne(bindIp: string, log: boolean): void {
  const sock = mdnsSockets.get(bindIp)
  if (!sock) return
  // ① 多播 announce（标准路径，见 mdnsMulticastAnnouncePacket）：刷新网段内所有设备缓存
  sock.send(mdnsMulticastAnnouncePacket(bindIp), MDNS_PORT, MDNS_GROUP, () => {})
  // ② 子网单播枚举（2026-09-01 iPhone 热点实测：该类网络吞多播，多播 announce 到不了设备，
  // 只能按主机地址逐个单播推；≤512 地址的网段才枚举，大网段交定向推 mdnsPushToReachableClient）
  const netmask = mdnsLanIfs().find((x) => x.address === bindIp)?.netmask
  if (!netmask) return
  const pkt = mdnsAnnouncePacket(bindIp)
  const peers = mdnsSubnetPeers(bindIp, netmask)
  for (const peer of peers) sock.send(pkt, MDNS_PORT, peer, () => {})
  if (log) {
    console.log(`[gateway] mDNS announce：floria.local → ${bindIp}（多播 + 单播 ${peers.length} 地址）`)
  }
}

// 单播推送一份 announce 到指定地址（收到该设备任一 mDNS 查询时用）
function mdnsAnnounceToPeer(bindIp: string, peer: string): void {
  const sock = mdnsSockets.get(bindIp)
  if (!sock) return
  sock.send(mdnsAnnouncePacket(bindIp), MDNS_PORT, peer, () => {})
}

// 请求来源 IPv4 归一化：剥 ::ffff: 前缀，非 IPv4（IPv6/Unix socket）返回空串。
// mDNS 定向推与设备票证回写（touchGatewayTicket）共用。
function remoteIPv4(raw: string | undefined): string {
  const ip = (raw ?? '').replace(/^::ffff:/, '')
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : ''
}

// 直连客户端定向推送（2026-09-01 校园网单播互通场景）：设备（iPad/iPhone）的 mDNS 多播被
// AP 吞（查询到不了 PC、PC 多播应答回不去），但设备 HTTP 直连 8124 证明**单播双向可达**
// （iPad 分流实证：IP 直连页面正常打开）——此刻向该客户端定向单播推 legacy announce（3 连发
// 覆盖丢包），设备 mDNSResponder 收到后 floria.local 免查询可解析，形成「直连一次 → 域名
// 永通」的自愈闭环。回环/非同网段地址跳过；30s/IP 节流（与查询回推共用 mdnsAnnounceSeen）。
// 全网枚举推（mdnsAnnounceOne）在校园网 /16 因 >512 跳过，定向推不受该限——只推已知可达地址。
function mdnsPushToReachableClient(remoteIpRaw: string): void {
  const remoteIp = remoteIPv4(remoteIpRaw)
  if (!remoteIp) return // IPv6 等非 IPv4 跳过
  if (remoteIp.startsWith('127.')) return // 本机访问（PC 端有 hosts 兜底，无需 mDNS）
  for (const bindIp of mdnsSockets.keys()) {
    const netmask = mdnsLanIfs().find((x) => x.address === bindIp)?.netmask
    if (!netmask || !mdnsSameSubnet(remoteIp, bindIp, netmask)) continue
    const lastSeen = mdnsAnnounceSeen.get(remoteIp) ?? 0
    if (Date.now() - lastSeen > 30_000) {
      mdnsAnnounceSeen.set(remoteIp, Date.now())
      console.log(`[gateway] mDNS 定向推（直连客户端 ${remoteIp}）：floria.local → 3 连发`)
      for (const delay of [0, 1000, 2000]) {
        setTimeout(() => mdnsAnnounceToPeer(bindIp, remoteIp), delay)
      }
    }
    return
  }
}

function mdnsStop(): void {
  if (mdnsWatchTimer) {
    clearInterval(mdnsWatchTimer)
    mdnsWatchTimer = null
  }
  if (mdnsAnnounceTimer) {
    clearInterval(mdnsAnnounceTimer)
    mdnsAnnounceTimer = null
  }
  mdnsAnnounceSeen.clear()
  mdnsPendingBinds.clear()
  for (const sock of mdnsSockets.values()) {
    try {
      sock.close()
    } catch {
      /* 忽略 */
    }
  }
  mdnsSockets.clear()
}

// 静态资源根：SubPj1 前端优先，SubPj2 本地 public 兜底。
// SubPj 是当前项目的子项目（Pj16-CodeAgent构建/SubPj1-遥测网页/...），故项目根优先；
// 便携根兜底兼容旧假设（2026-08-14 修：原只按便携根 @WrokSpace 定位，SubPj1 在项目根内导致磁盘兜底恒 404）。
function publicDir(root: string): string {
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

// 内嵌 web 资源（打包进 exe，gen-web-assets.ts 生成）；命中则内存 serve，磁盘 SubPj public 仅作开发兜底。
// base64 解码结果惰性缓存，避免每次静态请求重复解码 index.html/app.js 等常驻资源。
const webAssetCache = new Map<string, Buffer>()
function readWebAsset(name: string): Buffer | null {
  const cached = webAssetCache.get(name)
  if (cached) return cached
  const b64 = webAssets[name]
  if (b64 === undefined) return null
  const buf = Buffer.from(b64, 'base64')
  webAssetCache.set(name, buf)
  return buf
}

const MIME: Record<string, string> = {
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

/**
 * 未知扩展名的文本嗅探（git 同款启发式）：前 8 KB 内出现 NUL 字节判二进制。
 * 无 NUL = 文本 → 落 `text/plain; charset=utf-8`。这是 `/gateway/file` 内容分类的唯一兜底点：
 * MIME 表覆盖到的扩展名以其为准，其余（.tex/.py/Makefile/Dockerfile 等）由此定型，
 * 使 work 编辑区的「文本/二进制」门不再因扩展名未登记而把源码挡成二进制。
 */
export function sniffBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

// ============================================================================
// 会话列表 / 读取（基于便携根扫描；逻辑对齐旧 gateway.mjs）
// ============================================================================
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i

interface ProjectInfo {
  label: string
  dir: string
  scope: string
  hasPreview: boolean
  hasBackend?: boolean
  backendCfg?: BackendCfg
}

/**
 * 把「相对工作区根的路径」解析为绝对路径，越界（`..` 逃逸、盘符/绝对路径）返回 null。
 * /gateway/fs 与 /gateway/file 同源的穿越防护口径；抽成纯函数是要让探针能直测真实现
 * （probe-gateway-fs.ts），而不是在探针里复刻一份算法。
 */
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

/**
 * 落盘条目名清洗（上传文件名 / 文件树重命名共用同一口径）：basename 化（禁带路径）+
 * Windows 非法字符 `\/:*?"<>|` 与控制符换 `_` + 保留名（con/prn/aux/nul/com1-9/lpt1-9）前缀 `_` +
 * 长度钳到 120（尽保扩展名）。空串/`.`/`..` 返回 ''，由调用方决定回落（上传回落 'file'，重命名报错）。
 */
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

/** 文件树写操作结果。code 与 HTTP 状态同码，由 /gateway/file/* 端点直译。 */
export type EntryOpResult =
  | { ok: true; path?: string; name?: string; trash?: string; size?: number }
  | { ok: false; code: number; error: string }

/** 文件内容写结果。成功附新 mtime（= 下次编辑的冲突基线）。 */
export type FileWriteResult = { ok: true; path: string; mtime: number } | { ok: false; code: number; error: string }

/**
 * 项目内条目重命名（GET /gateway/file 的写侧对应件）：只改 basename，不跨目录移动。
 * 目标已存在 → 409（不覆盖、不自动序号——改名是用户显式输入，静默换成别的名字比报错更糟）。
 * 抽成纯函数是要让探针能直测真实现（probe-file-tree-ops.ts），不在探针里复刻一份算法。
 */
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

/**
 * 项目内条目移动（拖拽放入文件夹，2026-10-14 待办 10）：把 rel 整体搬到 dir 目录下（dir='' = 项目根），
 * basename 不变。防护与 renameProjectEntry 同口径：resolveWithinRoot 越界拒绝（path 与 dir 两侧都查）、
 * 目标已存在 → 409（不覆盖、不自动序号）；另拒移入自身或自身子目录（dir === rel 或在其下）→ 400。
 * 抽成纯函数供探针直测（与 probe-file-tree-ops 同段约定）。
 */
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

/**
 * 项目内条目删除 = 移入项目根 .trash/（工作区规范禁止 rm）：永不真删、永不覆盖——
 * .trash/ 下同名冲突加 <YYYYMMDDHHMMSS>- 前缀（同秒再撞加 -N）。.trash 以 `.` 开头，
 * 本就不进 /gateway/project 文件树（walkProjectTree 跳过点开头条目）。
 */
export function trashProjectEntry(projRoot: string, rel: string): EntryOpResult {
  const abs = resolveWithinRoot(projRoot, rel)
  if (!abs || abs === projRoot) return { ok: false, code: 403, error: 'forbidden' }
  if (!existsSync(abs)) return { ok: false, code: 404, error: 'not found' }
  const trash = join(projRoot, '.trash')
  mkdirSync(trash, { recursive: true })
  const base = basename(abs)
  let to = join(trash, base)
  if (existsSync(to)) {
    const d = new Date()
    const p2 = (n: number): string => String(n).padStart(2, '0')
    const ts = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
    to = join(trash, `${ts}-${base}`)
    for (let i = 1; existsSync(to); i++) to = join(trash, `${ts}-${i}-${base}`)
  }
  renameSync(abs, to)
  return { ok: true, trash: `.trash/${basename(to)}` }
}

/**
 * 项目内**目录**归档（2026-11-07 work 文件树行菜单）：打成 <项目根>/.achrives/<目录名>-<ts>.tar.gz，
 * 原目录移入 <项目根>/.trash/。语义与项目归档完全一致（tar 顺序流 + .trash 是撤销位），只是作用对象
 * 是项目内子树。`.achrives` / `.trash` 都以点开头，不进 /gateway/project 文件树（walkProjectTree 跳过）。
 * 打包用系统 tar；失败清掉本次半成品，不留误导性残包。
 */
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
      if (existsSync(dest)) unlinkSync(dest) // 本次刚生成的半成品，非用户数据
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

// ---------- 项目归档 / 临时项目删除（2026-11-06 work 项目行菜单） ----------
// 工作区根下的项目目录不是「文件树条目」，/gateway/file/* 的 resolveWithinRoot 口径管不到
// 「整个项目消失」这件事，故单列两个接口。目录真身只有一处：<root>/<label>（findProjects 的
// dir 上两级），label 必须是根的直接子目录名——任何含分隔符 / `.` / `..` 的写法一律拒。
function tsStamp(): string {
  const d = new Date()
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
}

// 关掉项目根下所有 SSE watcher。Windows 上 fs.watch 对**子目录**（<项目>/.claude/projects）持有目录句柄，
// 该句柄会让父目录（项目根）的 rename 返回 EPERM——表现为「包已生成，但移入 .trash 失败」。
// 实测：watch a/b 后 rename a → EPERM；w.close() 后同一次 rename 立即成功。项目即将整体移走，watch 本就该销毁。
function closeSseWatchesUnder(projRoot: string): void {
  const base = resolve(projRoot).toLowerCase()
  for (const [dir, w] of [...sseWatches]) {
    const d = resolve(dir).toLowerCase()
    if (d === base || d.startsWith(base + sep)) {
      try {
        w.close()
      } catch {
        /* 忽略 */
      }
      sseWatches.delete(dir)
    }
  }
}

// 项目目录整体移入 <root>/.trash/：工作区规范禁止 rm，.trash 本身就是撤销位。
// 归档与「临时项目删除」共用本口；rename 是同卷原子改名，不拷贝内容。
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

// 跑一个外部命令并等退出码（归档用系统 tar：流式打包、内存恒定、跨平台自带）。
// stdout 丢弃（不把 GB 级进度读进内存），stderr 只留尾部 4KB 供失败文案定位——tar 的错误全在 stderr，
// 只报退出码会把「路径解析失败 / 磁盘满」这类原因糊成一句「压缩失败」。
function runProcessQuiet(cmd: string, args: string[]): Promise<{ code: number; err: string }> {
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

// Windows 必须用系统自带 bsdtar 的绝对路径：网关继承的 PATH 里常有 Git Bash 的 /usr/bin/tar（MSYS tar），
// 它把 `F:/@WrokSpace` 的盘符冒号当远端主机（`Cannot connect to WrokSpace/...`，退出码 2）。
// 非 Windows 直接用 PATH 里的 tar（macOS bsdtar / Linux GNU tar 参数一致）。
function tarBin(): string {
  if (process.platform === 'win32') {
    const p = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    if (existsSync(p)) return p
  }
  return 'tar'
}

// 项目占用判定（2026-11-06）：归档 / 删除会整体改项目目录名，正在该目录里跑的会话（终端 CLI 与
// web 会话子进程都经 /clients 注册，sid 即 jsonl 路径，启动根可从 sid 还原；两者 cwd 都是项目根）
// 会瞬间失根。命中即拒绝，让用户先关会话——不自动杀用户会话，也不做「先打包再失败」的半成品。
// cliClients 在断线重连 ~1s 窗口会暂 miss，再由活动表（带 cwd + pid，TTL 内且进程存活）兜一层。
// 预览后端（网关自己的子进程）不算用户会话，归档前由调用方 killBackend 停掉。
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

/**
 * 项目归档：打包到 <root>/.achrives/<label>-<ts>.tar.gz → 原目录移入 <root>/.trash/。
 * 格式选 tar.gz 而非 zip：顺序流写、无中央目录索引，进程中断只会截断尾部、不会整包不可读。
 * 压缩用系统 tar（Windows 10+ 自带 System32\tar.exe，macOS/Linux 自带），不进进程内存。
 * 归档产物与 .trash 同卷，rename 即完成；tar 失败时清掉半成品，磁盘不留误导性残包。
 */
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
  killBackend(label) // 预览后端是网关子进程（cwd 在项目内），先停掉再打包/改名
  const archDir = join(root, '.achrives')
  mkdirSync(archDir, { recursive: true })
  let dest = join(archDir, `${label}-${tsStamp()}.tar.gz`)
  for (let i = 1; existsSync(dest); i++) dest = join(archDir, `${label}-${tsStamp()}-${i}.tar.gz`)
  const out = await runProcessQuiet(tarBin(), ['-czf', dest, '-C', root, label])
  if (out.code !== 0) {
    try {
      if (existsSync(dest)) unlinkSync(dest) // 本次刚生成的半成品，非用户数据
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

/** 临时项目（根级时间戳任务区）删除 = 移入 .trash/；非临时项目一律拒（长期项目只提供归档）。 */
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

/**
 * 项目重命名（2026-11-07 work 项目行菜单）：把 <root>/<label> 整目录改名为 <root>/<name>。
 * label 即项目标识（findProjects 的目录名），会话转录随目录一起走，故不需要迁移任何数据。
 * 与归档/删除同口径：项目内有在线会话 → 409（改父目录名会让运行中的会话瞬间失根）；
 * 改名后旧目录的 SSE watcher 已失效（Windows 上还阻着 rename），先 close 再改，由调用方重扫补齐。
 * 名称走 sanitizeEntryName；点开头一律拒（.trash/.achrives 之类会被项目扫描跳过）。
 */
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
  killBackend(label) // 预览后端按 label 注册，改名后旧键失效
  closeSseWatchesUnder(projRoot)
  try {
    renameSync(projRoot, to)
  } catch (e) {
    return { ok: false, code: 500, error: `重命名失败：${(e as Error).message}` }
  }
  return { ok: true, label: name }
}

/**
 * 写已存在文件的内容（GET /gateway/file 的写侧对应件，2026-10-05 work 编辑区）。只改内容，
 * 不新建/不删除；路径穿越防护同 resolveWithinRoot。baseMtime 缺省 = 强制覆盖；给了则与当前
 * mtime 比对（浮点精确相等，来自读侧同一 stat），不等 → 409 conflict（外部已改，不静默覆盖）。
 * 抽成纯函数是要让探针能直测真实现（probe-file-tree-ops.ts）。
 */
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
    // 未给基线：允许写（首次保存），但文件必须已存在（write 不做新建）
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
  // 写成功后入册（403/404/409/写失败都不入册），供 CLI 撞车归因；projectRoot 必须显式传——
  // 网关进程 cwd 不是目标项目，不能落到进程默认项目根。
  recordFileModifier(abs, {
    projectRoot: projRoot,
    writer: attribution?.writer ?? 'session',
    sid: attribution?.sid,
  })
  return { ok: true, path: rel.replace(/\\/g, '/').replace(/^\/+/, ''), mtime: statSync(abs).mtimeMs }
}

/**
 * 项目内新建文件 / 目录（2026-10-13 work 侧栏「创建文件 / 文件夹」，#wk-new-pop 接入）。
 * relDir = 落点目录（'' = 项目根本身，合法）；名称走 sanitizeEntryName。
 * 不变量：**显式输入不静默换名**——目标已存在 → 409（与 renameProjectEntry 同判，不自动序号）；
 * 落点目录必须已存在（新建不做多级 mkdir——用户逐级建，路径树与 /gateway/project 文件树一致）→ 404。
 * 抽成纯函数让探针直测真实现（probe-file-create.ts）。
 */
export function createProjectEntry(projRoot: string, relDir: string, rawName: string, isDir: boolean): EntryOpResult {
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
  if (isDir) mkdirSync(target)
  else writeFileSync(target, '', 'utf8')
  const base = String(relDir || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  return { ok: true, name, path: base ? `${base}/${name}` : name }
}

/** 上传落盘结果：relPath = 相对给定 root 的 POSIX 路径；abs 仅内部使用，**不进响应**。 */
export type StoredUploadFile =
  | { ok: true; name: string; relPath: string; abs: string; size: number }
  | { ok: false; code: number; error: string }

/**
 * 上传落盘唯一实现（统一上传服务）：resolveWithinRoot 锁根 → 清洗文件名 → 递归建目录 →
 * 同名 -1/-2 序号避让 → 写盘。落点目录由调用方按 slot 给出，本函数只管「收字节、命名、落盘」。
 * **独占创建**（writeFileSync flag:'wx'）：并发同名不会互相覆盖，EEXIST 再顺延序号。
 * 字节上限由 handler 的 readBodyWithLimit 管（20 MB）。
 */
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

/**
 * 项目内上传文件（work 侧栏「上传文件 / 文件夹」，#wk-new-pop 接入）：落点 = 项目根相对目录，
 * 语义全部来自 storeUploadFile（同名序号避让、递归建目录、越界 403）。抽成纯函数让探针直测
 * 真实现（probe-file-create.ts）。
 */
export function uploadProjectFile(projRoot: string, relDir: string, rawName: string, buf: Buffer): EntryOpResult {
  const stored = storeUploadFile(projRoot, relDir, rawName, buf)
  if (!stored.ok) return stored
  return { ok: true, name: stored.name, path: stored.relPath, size: stored.size }
}

/**
 * 上传落盘名 = 原名主干 + `-YYYYMMDDHHMMSS` + 原扩展名（如 `报告-20261109173000.docx`）。
 * 命名归网关：前端只传原始文件名，时间戳只作同名基础区分；同秒同名仍由 storeUploadFile 的
 * `-1/-2` 独占序号兜底。只用于 /gateway/upload（work 文件树上传保留用户原名，不加戳）。
 */
function stampUploadName(rawName: string): string {
  const name = sanitizeEntryName(rawName) || 'file'
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length) || 'file'
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `${stem}-${stamp}${ext}`
}

// ============================================================================
// 统一上传服务：声明式槽位（slot）
//   POST /gateway/upload 只负责「收字节 / 命名 / 落盘 / 鉴权」；落点目录与正文引用由槽位声明决定。
//   内置槽位只有 session（会话附件，不进正文）与 document-markdown（.md/.markdown 文档邻位）。
//   项目可用 <项目根>/.claude/file-upload.json（version 1）声明额外槽位（如 .tex 的 includegraphics）。
// ============================================================================
export type UploadKind = 'image' | 'file'
export type UploadScope = 'session' | 'document'
export type UploadReferenceFormat = 'none' | 'markdown' | 'latex-includegraphics' | 'template'
export type UploadFallback = 'session' | 'reject'

export type UploadSlot = {
  id: string
  priority: number
  match: { workFileExtensions: string[]; uploadKinds: UploadKind[] }
  storage: { scope: UploadScope; directory: string }
  reference: { format: UploadReferenceFormat; template?: string; pathPrefix?: string }
  /** 该槽位匹配后无法确定落点（如 document 槽位缺 workFile）时的行为；缺省 reject。 */
  fallback?: UploadFallback
  /** 内置槽位：项目声明不得复用 id。 */
  builtin?: boolean
}

export type UploadDeclaration = {
  slots: UploadSlot[]
  /** 文档上下文没有命中任何槽位时的行为；缺省 session（并带 fallback 标记返回）。 */
  fallback: UploadFallback
}

/** 内置槽位 id（项目声明里出现即丢弃，避免顶替内置行为）。 */
const RESERVED_UPLOAD_SLOT_IDS = new Set(['session', 'document-markdown'])

/**
 * 校验单条槽位声明。字段口径：
 *  - id：`^[a-z][a-z0-9-]{0,31}$`，不得占用内置 id；
 *  - priority：整数 -10000..10000（降序匹配，同序按声明顺序）；
 *  - match.workFileExtensions：`\.[a-z0-9]{1,10}` 小写扩展名，非空；
 *  - match.uploadKinds：image / file 子集，非空；
 *  - storage.scope：session | document；document 必须给 directory（项目内相对、无反斜杠、无 `.`/`..` 段）；
 *  - reference.format：none / markdown / latex-includegraphics / template；
 *    markdown 由 kind 决定图片或文件引用；template 最多 512 字符且只允许一个 `{{$path}}`；
 *    pathBase 只接受 workFileDirectory（文档引用恒相对 workFile 所在目录）；pathPrefix 只影响引用路径。
 * 非法条目返回 null，由 readUploadDecl 丢弃该条（单条坏不拖垮整份声明）。
 */
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
  const kinds = (Array.isArray(m.uploadKinds) ? m.uploadKinds : [])
    .filter((x): x is UploadKind => x === 'image' || x === 'file')
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
    r.format === 'none' || r.format === 'markdown' ||
    r.format === 'latex-includegraphics' || r.format === 'template'
      ? r.format
      : null
  if (!format) return null
  if (r.pathBase !== undefined && r.pathBase !== 'workFileDirectory') return null
  let template = ''
  if (format === 'template') {
    template = typeof r.template === 'string' ? r.template : ''
    if (!template || template.length > 512) return null
    if (template.split('{{$path}}').length !== 2) return null // 只允许一个 {{$path}} 占位
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

/**
 * 读项目上传声明 `<项目根>/.claude/file-upload.json`（每请求现读，与 readPreviewJson 同口径）。
 * 文件缺失 → 空声明；整份非法（坏 JSON / version !== 1 / slots 非数组）→ 空声明并写网关日志；
 * 单条非法 → 丢该条。绝不抛：GET/POST 每次都跑。
 */
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

export type UploadSlotResolution =
  | { ok: true; slot: UploadSlot; fallback: boolean; fallbackReason?: string }
  | { ok: false; code: number; error: string }

/**
 * 槽位匹配：
 *  显式 slot（未知 400；document 槽位缺 workFile 按该槽位 fallback 处理，缺省 reject）
 *  → 项目声明（priority 降序、同序按声明顺序，扩展名与 kind 同时命中）
 *  → 内置 document-markdown（.md/.markdown）
 *  → 文档上下文未命中：按声明 fallback（session 默认 / reject），session 结果带 fallback 标记
 *  → 无文档上下文（composer）：内置 session，不算 fallback。
 */
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
    .sort((a, b) => (b.s.priority - a.s.priority) || (a.i - b.i))
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

/** LaTeX 文件名转义（% # & { } $ ^ ~ _ 与空格），避免文件名字符被 TeX 当语法。 */
function latexEscapePath(p: string): string {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/[#%&{}$^~_]/g, (c) => '\\' + c)
    .replace(/ /g, '\\ ')
}

/** 正文引用生成：refPath 已含 pathPrefix。markdown 按 kind 选图片/文件语法，LaTeX 单独转义。 */
export function buildUploadReference(slot: UploadSlot, kind: UploadKind, refPath: string, name: string): string {
  const fmt = slot.reference.format
  if (fmt === 'none') return ''
  if (fmt === 'latex-includegraphics') return `\\includegraphics{${latexEscapePath(refPath)}}`
  const enc = encodeURI(refPath)
  if (fmt === 'markdown') return kind === 'image' ? `![${name}](${enc})` : `[${name}](${enc})`
  if (fmt === 'template') return String(slot.reference.template || '').replace('{{$path}}', enc)
  return ''
}

/**
 * 项目内文件批注（2026-10-06 work 评论功能）。存储 <projRoot>/.claude/comments.json，单一真源；
 * 前端为唯一写入方、每次全量替换（列表规模小，全量写避免并发合并歧义）。与 writeProjectFile 不同，
 * 这里**允许新建**（comments.json 是本功能专有文件，不存在于文件树上——walkProjectTree 跳 dot 项）。
 * readProjectComments 缺失 / 坏 JSON / 顶层非对象 → []（不抛：GET 每次请求都跑，抛＝网关 500）。
 */
export type ProjectComment = {
  id: string
  path: string
  l0: number
  l1: number
  excerpt: string
  body: string
  author: string
  createdAt: string
  resolved: boolean
}

export function commentsFilePath(projRoot: string): string {
  return join(projRoot, '.claude', 'comments.json')
}

export function readProjectComments(projRoot: string): ProjectComment[] {
  try {
    const p = commentsFilePath(projRoot)
    if (!existsSync(p) || !statSync(p).isFile()) return []
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { comments?: unknown }).comments)
      ? ((raw as { comments: unknown[] }).comments)
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
  const list = Array.isArray(comments) ? comments.filter((c) => !!c && typeof c === 'object' && !Array.isArray(c)) : null
  if (!list) return { ok: false, code: 400, error: 'invalid comments' }
  try {
    mkdirSync(join(projRoot, '.claude'), { recursive: true })
    writeFileSync(commentsFilePath(projRoot), JSON.stringify({ version: 1, comments: list }, null, 2), 'utf8')
    return { ok: true, count: list.length }
  } catch {
    return { ok: false, code: 500, error: 'write failed' }
  }
}


// 「在资源管理器中打开」并置顶（POST /gateway/file/reveal）。
// 走 Windows Shell API `SHOpenFolderAndSelectItems`（与 Obsidian 的「在文件夹中显示」同一条路）：由 shell
// 自己完成「打开 + 定位」，不启动新的 explorer.exe 进程、没有 PowerShell 冷启动，因此打开即出窗。
// **前置必须自己补**：网关是后台进程（没有前台窗口），shell 只会把窗口挂出来而不激活它（用户看到
// 「开在最下层」）；而从后台进程直接 SetForegroundWindow 会被前台锁拒绝。这里用 AttachThreadInput
// 附到当前前台窗口线程后再 SetForegroundWindow，末尾 SwitchToThisWindow 兜住仍被拒的情形。
// 文件 → 传文件自身 PIDL + cidl=0（打开父目录并选中该文件）；目录 → 同调用（打开该目录）。
type RevealWindow = { hwnd: bigint; title: string; visible: boolean }
type RevealLibs = {
  parse: (w: Buffer, out: BigUint64Array) => number
  open: (pidl: bigint) => number
  free: (pidl: bigint) => void
  windows: () => RevealWindow[]
  foreground: (hwnd: bigint) => void
}
let revealLibs: RevealLibs | null = null

/** 懒加载 shell32/ole32/user32（仅 win32 调用；dlopen 失败只记日志，不影响其它端点）。 */
function revealLibsOf(): RevealLibs | null {
  if (revealLibs) return revealLibs
  try {
    const shell32 = dlopen('shell32.dll', {
      SHParseDisplayName: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
      SHOpenFolderAndSelectItems: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.u32], returns: FFIType.i32 },
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
    // GetCurrentThreadId 在 kernel32（不在 user32），单独取。
    const kernel32 = dlopen('kernel32.dll', {
      GetCurrentThreadId: { args: [], returns: FFIType.u32 },
    })
    // STA：SHOpenFolderAndSelectItems 要求调用线程已初始化 COM（已初始化时返回 S_FALSE/RPC_E_CHANGED_MODE 均可用）。
    ole32.symbols.CoInitializeEx(null, 0x2)
    const u = user32.symbols
    const windows = (): RevealWindow[] => {
      const out: RevealWindow[] = []
      const clsBuf = Buffer.alloc(64 * 2)
      const titleBuf = Buffer.alloc(512 * 2)
      const cb = new JSCallback((raw: bigint | number) => {
        const hwnd = typeof raw === 'bigint' ? raw : BigInt(raw)
        const n = u.GetClassNameW(hwnd, ptr(clsBuf), 64) as number
        if (n > 0 && clsBuf.toString('utf16le', 0, n * 2) === 'CabinetWClass') {
          const m = u.GetWindowTextW(hwnd, ptr(titleBuf), 512) as number
          out.push({ hwnd, title: m > 0 ? titleBuf.toString('utf16le', 0, m * 2) : '', visible: (u.IsWindowVisible(hwnd) as number) !== 0 })
        }
        return 1
      }, { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 })
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
      u.ShowWindow(hwnd, (u.IsIconic(hwnd) as number) !== 0 ? 9 /* SW_RESTORE */ : 5 /* SW_SHOW */)
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

/** 在系统资源管理器中定位并前置（仅 win32；调用方已判平台）。失败只记日志，不影响接口返回。
 *  shell 会复用/新建一个 CabinetWClass 窗口；等它出现（最多 1.6s，异步轮询不阻塞事件循环）后
 *  按「标题 == 文件夹名」或「新窗口/由隐藏转可见」认领，再强制置前。 */
function revealInExplorer(abs: string, isDir: boolean): void {
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
  const folderName = isDir ? basename(abs) : basename(dirname(abs))
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

function findProjects(root: string): ProjectInfo[] {
  const groups: ProjectInfo[] = []
  const global = join(root, '.claude', 'projects')
  // 全局根也参与 preview 申报（2026-10-10 全局根插件卡）：dir 保持 <root>/.claude/projects，
  // 其 `..` 即 <root>/.claude ⇒ join(dir,'..','preview') = <root>/.claude/preview，与项目同一公式。
  if (isDir(global)) {
    groups.push({
      label: GLOBAL_PROJECT_LABEL,
      dir: global,
      scope: 'global',
      hasPreview: isDir(join(root, '.claude', 'preview')),
    })
  }
  const entries = readdirSync(root, { withFileTypes: true })
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith('.')) continue
    // 根级时间戳目录（临时任务区）也是一等项目（2026-10-30 用户定案）：它们通常没有 `.claude/projects`，
    // 但 work 模式要直接在其文件树里读写，故按「目录名即项目 label」放行——`dir` 仍按同一公式给出
    // （可能不存在：会话扫描/SSE watch 各自 try/catch 跳过，`/gateway/project` 只用 dir 上两级取项目根）。
    const isTempTaskDir = /^\d{8,14}-/.test(e.name)
    const pd = join(root, e.name, '.claude', 'projects')
    if (isDir(pd) || isTempTaskDir) {
      // hasPreview：项目自带 .claude/preview/（网页渲染，点击项目胶囊时前端 iframe 加载替换界面）
      const previewDir = join(root, e.name, '.claude', 'preview')
      const info: ProjectInfo = { label: e.name, dir: pd, scope: 'project', hasPreview: isDir(previewDir) }
      // hasBackend：preview.json 声明 backend → 该项目预览以「Web 容器」方式运行（网关 spawn 后端进程，iframe 直连）
      if (info.hasPreview) {
        const cfg = readBackendCfg(previewDir)
        if (cfg) {
          info.hasBackend = true
          info.backendCfg = cfg
        }
      }
      groups.push(info)
    }
  }
  return groups
}

// 读 <previewDir>/preview.json 原始对象（backend 与 cards 共用一份解析）。文件缺失 / 坏 JSON /
// 顶层非对象 → null。不变量：坏文件不得抛出（findProjects 每次请求都跑，抛=整个网关 500）。
function readPreviewJson(previewDir: string): Record<string, unknown> | null {
  const pj = join(previewDir, 'preview.json')
  if (!existsSync(pj)) return null
  try {
    const raw = JSON.parse(readFileSync(pj, 'utf-8')) as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// 卡片资源路径必须是 preview 目录内的相对文件路径：拒绝绝对路径 / 反斜杠 / query / 空段 /
// `.` `..` 段（含 %2e 编码后的形态——先 decode 再判）；允许尾随 #片段（不参与路径解析）。
function isPreviewRelPath(p: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes('?')) return false
  const i = p.indexOf('#')
  const file = i >= 0 ? p.slice(0, i) : p
  let rel: string
  try {
    rel = decodeURIComponent(file)
  } catch {
    return false // 非法 % 序列
  }
  if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.includes('?')) return false
  return rel.split('/').every((s) => s && s !== '.' && s !== '..')
}

// 读 <previewDir>/preview.json 的 cards 声明。不合格条目整条丢弃（不猜不兜底，与前端 rail-ext
// 边界校验同范式）：id 非法 / 重名、title 空、path 越界、host 非 view。整个 cards 缺失 = 空集。
function readPreviewCards(previewDir: string): PreviewCard[] {
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
    if (c.host !== 'view') continue // 本版只定义 view
    if (!isPreviewRelPath(path)) continue
    seen.add(id)
    // 启用态载体 = <previewDir>/<path 首段>/.disabled（应用卡目录），路径首段不存在则恒启用
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
    })
  }
  return out
}

// 扫描 <previewDir>/<card>/card.json → 预览工作区卡片（2026-10-18）。目录即卡片，id = 目录名：
//   { "title": "PDF", "entry": "index.html", "icon": "dshFile", "order": 10, "default": true }
// 不合格条目整条丢弃（不猜不兜底）：目录名不合 id 规则 / card.json 缺失或坏 JSON / title 空 /
// entry 越界或文件不存在。order 缺省 100；default 只认首张声明者，全无声明时排序首张为默认。
// 卡片页经既有 /preview/<label>/<id>/<entry> 托管（无新路由）。
function readPreviewPaneCards(previewDir: string): PreviewPaneCard[] {
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
    // 卡级后端：cwd 相对卡目录解析（缺省 = preview 根）；previewDir 仍回填项目 preview 根，
    // 使 backend.log 与项目后端同位（一个项目一份日志）。
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

// 单条元素声明校验（不猜不兜底）：id 非法 / name 空 / insert 类型未知或缺内容 → 丢该条。
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
  else if (i.type === 'token' && typeof i.token === 'string' && i.token.trim()) insert = { type: 'token', token: i.token.trim() }
  else if (i.type === 'path' && typeof i.path === 'string' && isPreviewRelPath(i.path.trim())) {
    insert = { type: 'path', path: i.path.trim(), pathType: i.pathType === 'dir' ? 'dir' : 'file' }
  }
  if (!insert) return null
  return { id, name, desc, icon, card, insert }
}

// 扫描 <previewDir> 的元素声明（2026-11-13）：preview.json 顶层 elements[] 在前，各已启用卡 card.json
// 的 elements[] 随后（卡标题入 card 字段）；id 全局唯一，重复者保留首个并写日志（不静默覆盖）。
// 停用卡（目录内 .disabled）不参与。声明整份缺失 = 空集；坏文件不抛（每次请求都跑）。
// 元素入口标题（可选）：preview.json 顶层 elementsTitle。用于「+」工具栏入口与下钻分组名；
// 未声明 / 空白 → ''（前端回落「元素」）。纯展示名，不参与元素校验。
export function readMentionElementsTitle(previewDir: string): string {
  const raw = readPreviewJson(previewDir)?.elementsTitle
  return typeof raw === 'string' ? raw.trim().slice(0, 200) : ''
}

// 元素入口图标（可选）：preview.json 顶层 elementsIcon = @floria/web 图标表键；未声明 / 空白 → ''
// （前端回落 chip）。只控制入口图标，元素行仍用各条 el.icon。
export function readMentionElementsIcon(previewDir: string): string {
  const raw = readPreviewJson(previewDir)?.elementsIcon
  return typeof raw === 'string' ? raw.trim().slice(0, 100) : ''
}

export function readMentionElements(previewDir: string): MentionElement[] {
  const out: MentionElement[] = []
  const seen = new Set<string>()
  const take = (list: unknown, card: string) => {
    if (!Array.isArray(list)) return
    for (const raw of list) {
      const el = validateMentionElement(raw, card)
      if (!el) {
        console.log(`[gateway] 元素声明丢弃非法条目：${JSON.stringify(raw).slice(0, 200)}`)
        continue
      }
      if (seen.has(el.id)) {
        console.log(`[gateway] 元素声明 id 重复，保留首个：${el.id}（${card || '项目级'}）`)
        continue
      }
      seen.add(el.id)
      out.push(el)
    }
  }
  // 顶层声明 = 预览页自身（传统单页预览）申报：随预览页启用态生效（preview 根无 .disabled）。
  if (!existsSync(join(previewDir, CUSTOMIZATION_DISABLED_MARKER))) take(readPreviewJson(previewDir)?.elements, '')
  // preview.json 应用卡的卡级声明：随「该卡启用」生效（enabled = 路径首段目录无 .disabled）。
  for (const c of readPreviewCards(previewDir)) if (c.enabled) take(c.elements, c.title)
  let ents: Dirent[]
  try {
    ents = readdirSync(previewDir, { withFileTypes: true })
  } catch {
    return out
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
    take(c.elements, title)
  }
  return out
}

// 读 <previewDir>/preview.json 的 quoteActions 声明。与 cards 同范式（不合格条目整条丢弃、不猜不兜底）：
// id 非法 / 重名、title 空 → 丢。整个 quoteActions 缺失 = 空集。无 path/host —— 动作不指向文件。
function readPreviewQuoteActions(previewDir: string): PreviewQuoteAction[] {
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

// backend 声明解析（唯一处）：项目级（preview.json 顶层 backend）与卡级（card.json / cards[] 条目
// 的 backend）共用。cwd 相对 cwdBase 解析（项目级 = preview 目录，卡级 = 卡目录），缺省 = previewDir；
// previewDir 恒回填项目 .claude/preview，供 backendLogPath 落同一份 backend.log。
function parseBackendCfg(raw: unknown, previewDir: string, cwdBase: string): BackendCfg | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const b = raw as { name?: unknown; cmd?: unknown; cwd?: unknown; port?: unknown; idleMinutes?: unknown; readyPath?: unknown }
  if (!Array.isArray(b.cmd) || !b.cmd.length) return undefined
  return {
    name: typeof b.name === 'string' && b.name ? b.name : undefined,
    cmd: b.cmd.map(String),
    cwd: typeof b.cwd === 'string' && b.cwd ? resolve(cwdBase, b.cwd) : previewDir,
    port: typeof b.port === 'number' ? b.port : 0,
    idleMinutes: typeof b.idleMinutes === 'number' ? b.idleMinutes : GATEWAY_IDLE_MINUTES,
    readyPath: typeof b.readyPath === 'string' && b.readyPath ? b.readyPath : '/api/system_stats', // 项目后端(如 ComfyUI)自身 API,勿随网关前缀迁移
    previewDir,
  }
}

// 读 <previewDir>/preview.json 的项目级 backend 声明；不存在或结构非法 → undefined
function readBackendCfg(previewDir: string): BackendCfg | undefined {
  const raw = readPreviewJson(previewDir) as { backend?: unknown } | null
  return parseBackendCfg(raw?.backend, previewDir, previewDir)
}

// 传统单页预览（<previewDir>/index.html）的保留应用 id：启停端点据此把 .disabled 写到 preview 根。
const PREVIEW_INDEX_CARD_ID = '__index__'

// 卡级后端的进程键（唯一处）：项目级 = label，卡级 = label::<cardId>。
// 同一项目的多张卡可各起一份后端（Pj18：PDF 卡 / 日志卡各一个 server）。
function cardBackendKey(label: string, cardId: string): string {
  return `${label}::${cardId}`
}

// 项目/全局根预览目录：proj.dir 恒 = <根>/.claude/projects → 上一级 .claude → preview
function previewDirOf(proj: ProjectInfo): string {
  return resolve(proj.dir, '..', 'preview')
}

// 已启用且有 backend 的卡清单（唯一处）：pane 卡（card.json）在前，preview.json 应用卡在后。
// cardId = pane 卡目录名 / 应用卡 id，是进程键与启停端点的稳定键。
interface CardBackendEntry {
  id: string
  cfg: BackendCfg
}
function enabledCardBackends(previewDir: string): CardBackendEntry[] {
  const out: CardBackendEntry[] = []
  for (const c of readPreviewPaneCards(previewDir)) {
    if (c.enabled && c.backendCfg) out.push({ id: c.id, cfg: c.backendCfg })
  }
  for (const c of readPreviewCards(previewDir)) {
    if (c.enabled && c.backendCfg) out.push({ id: c.id, cfg: c.backendCfg })
  }
  return out
}

// 下发前裁剪（/gateway/preview-cards）：后端 cfg（cmd/cwd/port）属网关侧实现，浏览器只要
// 「有没有 backend + 显示名」——不带出去也不影响启停与挂载决策。
function publicPreviewCard<T extends { backendCfg?: BackendCfg; backendName: string; elements?: unknown[] }>(
  c: T,
): Record<string, unknown> {
  const { backendCfg, elements, ...rest } = c
  return { ...rest, backend: !!backendCfg }
}

// ---------- 上游版本探测（插件卡「应用」详情）----------
// 只接受 https://github.com/<owner>/<repo>（严格两段，防 SSRF 到内网）；对外请求固定三个 GitHub 域名。
// 依次回退：最新 Release tag → 最新 tag → 仓库根 package.json 的 version → 最新提交短 SHA
// （无 Release/tag/package.json 的卡仓库也有 git 版本可显示）。成功缓存 10 分钟、
// 失败缓存 1 分钟——详情页反复打开不重复打未认证 API。
interface RepoVersionEntry {
  version: string
  source: string
  error?: string
  at: number
}
const repoVersionCache = new Map<string, RepoVersionEntry>()
const REPO_VERSION_TTL_MS = 10 * 60 * 1000
const REPO_VERSION_ERR_TTL_MS = 60 * 1000
// 上游 README（应用详情「介绍」）：按仓库缓存全文，10min；失败 60s 后重试。
type RepoReadmeEntry = { name: string; text: string; error?: string; at: number }
const repoReadmeCache = new Map<string, RepoReadmeEntry>()
const REPO_README_TTL_MS = 10 * 60 * 1000
const REPO_README_MAX_CHARS = 80_000

function parseGithubRepo(raw: string): { owner: string; repo: string } | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || (u.hostname !== 'github.com' && u.hostname !== 'www.github.com')) return null
  const seg = u.pathname.replace(/\.git$/i, '').split('/').filter(Boolean)
  if (seg.length !== 2) return null
  if (!/^[A-Za-z0-9_.-]+$/.test(seg[0]) || !/^[A-Za-z0-9_.-]+$/.test(seg[1])) return null
  return { owner: seg[0], repo: seg[1] }
}

// GitHub 读接口凭据：环境变量优先，其次 github 插件 MCP 配置里的 GITHUB_PERSONAL_ACCESS_TOKEN。
// 私有仓库（如 Pj15-LocalMediabase）匿名 API 会 404，带 token 才能读版本。60s 缓存，改配置无需重启网关。
let githubTokenCache: { token: string; at: number } | null = null
function githubToken(): string {
  if (githubTokenCache && Date.now() - githubTokenCache.at < 60_000) return githubTokenCache.token
  let token = (process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim()
  if (!token) {
    try {
      const p = join(getPortableRoot(), '.claude', 'plugins', 'github', '.mcp.json')
      const cfg = JSON.parse(readFileSync(p, 'utf8')) as { mcpServers?: { github?: { env?: Record<string, string> } } }
      token = String(cfg?.mcpServers?.github?.env?.GITHUB_PERSONAL_ACCESS_TOKEN || '').trim()
    } catch { /* 无插件配置：按匿名访问 */ }
  }
  githubTokenCache = { token, at: Date.now() }
  return token
}

async function githubJson<T>(url: string): Promise<T> {
  const token = githubToken()
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Floria-Gateway',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return (await res.json()) as T
}

async function probeRepoVersion(g: { owner: string; repo: string }): Promise<RepoVersionEntry> {
  const base = `https://api.github.com/repos/${g.owner}/${g.repo}`
  try {
    const rel = await githubJson<{ tag_name?: string }>(base + '/releases/latest')
    if (rel && typeof rel.tag_name === 'string' && rel.tag_name.trim()) {
      return { version: rel.tag_name.trim(), source: 'release', at: Date.now() }
    }
  } catch { /* 无 Release：继续回退 */ }
  try {
    const tags = await githubJson<Array<{ name?: string }>>(base + '/tags?per_page=1')
    const name = Array.isArray(tags) && tags[0] && typeof tags[0].name === 'string' ? tags[0].name.trim() : ''
    if (name) return { version: name, source: 'tag', at: Date.now() }
  } catch { /* 无 tag：继续回退 */ }
  try {
    const token = githubToken()
    const res = await fetch(`https://raw.githubusercontent.com/${g.owner}/${g.repo}/HEAD/package.json`, {
      headers: { 'User-Agent': 'Floria-Gateway', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) {
      const pkg = (await res.json()) as { version?: unknown }
      if (typeof pkg.version === 'string' && pkg.version.trim()) {
        return { version: pkg.version.trim(), source: 'package.json', at: Date.now() }
      }
    }
  } catch { /* 无 package.json */ }
  try {
    // 无 Release/tag/package.json 的仓库仍有 git 版本：取默认分支最新提交的短 SHA。
    const commits = await githubJson<Array<{ sha?: string }>>(base + '/commits?per_page=1')
    const sha = Array.isArray(commits) && commits[0] && typeof commits[0].sha === 'string' ? commits[0].sha.trim() : ''
    if (sha) return { version: sha.slice(0, 7), source: 'commit', at: Date.now() }
  } catch { /* 仓库不可访问（私有/不存在） */ }
  return { version: '', source: '', error: '未找到版本信息', at: Date.now() }
}

// 上游 README：先走 GitHub readme API（带 token ⇒ 私有库可读），失败再试 raw 的常见文件名。
async function probeRepoReadme(g: { owner: string; repo: string }, sub = ''): Promise<RepoReadmeEntry> {
  const token = githubToken()
  const base = `https://api.github.com/repos/${g.owner}/${g.repo}`
  // 子目录条目（市场 git-subdir / 市场仓库自带的 ./plugins/x）：README 在子目录里，仓库根的 README 是别的项目。
  const dir = sub.replace(/^\/+|\/+$/g, '')
  if (dir) {
    // 走 contents API（api.github.com）：raw.githubusercontent.com 在部分网络环境下不可直连。
    for (const name of ['README.md', 'readme.md', 'Readme.md', 'README.mdx']) {
      try {
        const res = await fetch(`${base}/contents/${dir}/${name}`, {
          headers: {
            Accept: 'application/vnd.github.raw',
            'User-Agent': 'Floria-Gateway',
            ...(token ? { Authorization: 'Bearer ' + token } : {}),
          },
          signal: AbortSignal.timeout(8000),
        })
        if (res.ok) {
          const text = (await res.text()).slice(0, REPO_README_MAX_CHARS)
          if (text.trim()) return { name, text, at: Date.now() }
        }
      } catch { /* 试下一个文件名 */ }
    }
    return { name: '', text: '', error: '未找到 README', at: Date.now() }
  }
  try {
    const res = await fetch(base + '/readme', {
      headers: {
        Accept: 'application/vnd.github.raw',
        'User-Agent': 'Floria-Gateway',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) {
      const text = (await res.text()).slice(0, REPO_README_MAX_CHARS)
      if (text.trim()) return { name: 'README', text, at: Date.now() }
    }
  } catch { /* 无 readme API 访问：继续回退 raw */ }
  for (const name of ['README.md', 'readme.md', 'README.mdx']) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${g.owner}/${g.repo}/HEAD/${name}`, {
        headers: { 'User-Agent': 'Floria-Gateway', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        signal: AbortSignal.timeout(8000),
      })
      if (res.ok) {
        const text = (await res.text()).slice(0, REPO_README_MAX_CHARS)
        if (text.trim()) return { name, text, at: Date.now() }
      }
    } catch { /* 试下一个文件名 */ }
  }
  return { name: '', text: '', error: '未找到 README', at: Date.now() }
}

// 按卡 id 找已启用卡后端（/gateway/backend?card= 与启停端点共用）
function findEnabledCardBackend(previewDir: string, cardId: string): CardBackendEntry | undefined {
  if (!cardId) return undefined
  return enabledCardBackends(previewDir).find((c) => c.id === cardId)
}

// 按页面 URL 首段找卡后端（/backend/<label>/<首段>/... 反代路由用）：
// pane 卡首段 = 卡 id；preview.json 应用卡首段 = path 首段（如 models/index.html → models）。
function findEnabledCardBackendBySeg(previewDir: string, seg: string): CardBackendEntry | undefined {
  if (!seg) return undefined
  const pane = readPreviewPaneCards(previewDir).find((c) => c.enabled && c.backendCfg && c.id === seg)
  if (pane && pane.backendCfg) return { id: pane.id, cfg: pane.backendCfg }
  for (const c of readPreviewCards(previewDir)) {
    const first = (c.path.split('#')[0] || '').split('/')[0]
    if (c.enabled && c.backendCfg && first === seg) return { id: c.id, cfg: c.backendCfg }
  }
  return undefined
}

// 网关神经元库发现根（2026-09-18 全项目神经元化）：内置双根只覆盖 cwd 根 + 全局根，
// 看不到其它项目根的 .claude/neturon（神经 tab 只出 3 库的根因）——扩展为
// 「cwd 根 → 全部项目根 → 全局根」优先序枚举，同 id keep-first（cwd 根真身优先）。
function gatewayNeuronRoots(): string[] {
  const roots = [getCwdRoot()]
  const portable = getPortableRoot()
  for (const e of readdirSync(portable, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith('.')) continue
    if (/^\d{8,14}-/.test(e.name)) continue // 根级临时任务目录
    const nr = join(portable, e.name, '.claude', 'neturon')
    if (isDir(nr)) roots.push(nr)
  }
  roots.push(getGlobalRoot())
  return [...new Set(roots)]
}

function countUserAssistant(text: string): number {
  let n = 0
  for (const line of text.split('\n')) {
    if (line.includes('"type":"user"') || line.includes('"type":"assistant"')) n++
  }
  return n
}

type SessionCore = { title: string; messageCount: number; updatedAt: number; startAt?: number }
type SessionMeta = { sidechain: true } | (SessionCore & { createdAt: number })

// 会话创建时刻的唯一可信源 = 转录首条记录的 timestamp（2026-11-06 根因定案）。
// 文件 birthtime 会被复制/恢复整体重置（Pj5/Pj14/Pj13 于一次 restore 后整批 createdAt 变成恢复时刻，
// 侧栏旧会话整批冒到最前），故不再作为状态源。head 已由 readSessionLite 读入，逐行 JSON.parse 取
// 首个顶层 timestamp；被截断的尾行丢弃，坏行跳过。content 字符串里出现的 "timestamp" 不会被误取。
function extractStartAt(head: string): number | undefined {
  let pos = 0
  while (pos < head.length) {
    const nl = head.indexOf('\n', pos)
    if (nl < 0) break // 尾行被截断：不完整，丢弃
    const line = head.slice(pos, nl)
    pos = nl + 1
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line) as { timestamp?: unknown }
      if (typeof o.timestamp === 'string') {
        const t = Date.parse(o.timestamp)
        if (Number.isFinite(t)) return t
      }
    } catch {
      // 坏行/非 JSON 行：继续找下一条
    }
  }
  return undefined
}

// B2（2026-08-26）大文件兜底（反向扫描 findLastCustomTitle 及其 (size, mtime) 缓存）
// 2026-08-31 迁入共享权威 sessionStoragePortable.ts（findLastCustomTitleCached），
// 与 CLI readLiteMetadata 同源；共享版并修复原本地副本在 start===0 时
// end=start+OVERLAP 的自旋缺陷（无任何 custom-title 记录的文件会死循环）。
// 标题写入仍只由 sessionStorage.ts 的 saveCustomTitle/saveAgentName 负责，网关不另造标题存储。

async function parseMeta(file: string): Promise<SessionCore | { sidechain: true } | null> {
  const lite = await readSessionLite(file)
  if (!lite) return null
  const { head, tail, mtime } = lite
  if (head.includes('"isSidechain":true') || head.includes('"isSidechain": true')) return { sidechain: true }
  const teamName = extractJsonStringField(head, 'teamName')
  if (teamName) return { sidechain: true }
  const messageCount =
    countUserAssistant(head) + (tail === head ? 0 : countUserAssistant(tail))
  const uuid = basename(file).replace(/\.jsonl$/, '')
  // 复用 CLI 权威标题提取（parseSessionInfoFromLite：customTitle → aiTitle →
  // lastPrompt → summary → firstPrompt 回退链），不再本地复刻标题逻辑。
  const info = parseSessionInfoFromLite(uuid, lite)
  let title = info ? info.summary : '（空会话）'
  // B2（2026-08-26，二次修正）触发条件：仅当 tail 窗口内无 custom-title 时反向扫描。
  // 尾窗内任意 custom-title 都是文件里最后一条（重命名记录按位置递增，最新一条若已被
  // 推出窗口则更早的也必然在窗外）→ info.summary 的 customTitle 已是正确最新值，无需扫描；
  // 正常退出会话 tail 有 re-append 标题 → 不扫（count_scan 实证 122 个大文件仅 2 个需扫）。
  // 首版 B2 无条件扫（`tail !== head`）导致 /gateway/sessions 全量反向扫描所有大文件超时；
  // 原条件 `&& !info?.customTitle` 会从 head 回退到旧标题（B1 磁盘实证 d95e3566）不触发。
  // 小文件（tail === head，窗口即全文件）tail 提取天然是最新，无需扫描。
  if (tail !== head && extractJsonStringField(tail, 'customTitle') === undefined) {
    const last = await findLastCustomTitleCached(file, { size: lite.size, mtime: lite.mtime })
    if (last) title = last
  }
  return { title, messageCount, updatedAt: mtime, startAt: extractStartAt(head) }
}

// SessionMeta 全量缓存（2026-08-30）：listSessions 原先每次刷新都对所有会话文件重读 head/tail
// + 全量 countUserAssistant 同步正则扫描（122 文件 ≈ 15MB），而活动会话逐消息触发 SSE → 前端
// refreshList 风暴 → 网关事件循环被扫描窗口频繁占住 → rename 等 HTTP 请求排队（web 实测「点确定
// 后弹窗偶发悬挂数秒」）。键 = (size, mtimeMs)：转录只有 append（append 必变 size）→ 无假命中，
// 键设计与 B2 lastCustomTitleCache 同源（线上实证可靠）。null（读不到）不缓存，保持每次重试语义。
const sessionMetaCache = new Map<string, { size: number; mtimeMs: number; meta: SessionMeta }>()
async function parseMetaCached(file: string): Promise<SessionMeta | null> {
  let st: Awaited<ReturnType<typeof stat>>
  try {
    st = await stat(file)
  } catch {
    return null
  }
  const cached = sessionMetaCache.get(file)
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.meta
  const meta = await parseMeta(file)
  if (meta) {
    // createdAt（侧栏创建时间排序，2026-09-18 定案）：唯一权威 = 转录首条记录的 timestamp。
    // 2026-11-06 根治：文件 birthtime 会被复制/恢复整体重置，曾让 Pj5/Pj14 整项目旧会话冒到最前，
    // 已从状态源里剔除。空转录（尚无任何记录）没有 timestamp，此时 mtime 即创建时刻，取其值。
    // startAt 不对外。
    const full: SessionMeta = 'sidechain' in meta
      ? meta
      : {
          title: meta.title,
          messageCount: meta.messageCount,
          updatedAt: meta.updatedAt,
          createdAt: meta.startAt ?? meta.updatedAt,
        }
    sessionMetaCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, meta: full })
    if (sessionMetaCache.size > 500) {
      // 防无限增长：清掉最旧一半（Map 保持插入序），同 lastCustomTitleCache
      const keys = [...sessionMetaCache.keys()]
      for (const k of keys.slice(0, 250)) sessionMetaCache.delete(k)
    }
    return full
  }
  return null
}

// B 探活收敛（2026-08-27 P2）：与 utils/genericProcessUtils.isProcessRunning 同为 signal-0 探活，
// 唯一差异是 EPERM 语义——锁恢复方保守报「不在跑」（防误抢他人锁），网关场景 EPERM=进程存在但属
// 他人所有 → 应视为存活（活动记录不误删、子进程不误判退出）。差异用选项表达，全部调用点经由本别名。
const isPidAlive = (pid: number): boolean =>
  Number.isInteger(pid) && pid > 0 && isProcessRunning(pid, { epermMeansRunning: true })

/** Windows 杀进程树兜底：child.kill() 只杀直接进程，taskkill /F /T 连同子孙进程一并结束。 */
function killTree(pid: number): void {
  spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
}

/**
 * 杀进程树但豁免某进程及其子树（2026-09-05 网关自保）：网关是「跑 /server restart 或被自愈
 * 拉起」的那个 CLI 会话的子进程，web「关闭会话」命中宿主 CLI 时 taskkill /T 会连坐杀掉网关
 * 自身 → 先枚举全量进程表建父子索引，豁免进程在目标树内时逐个 taskkill 并整体跳过豁免子树；
 * 不在树内则走 taskkill /T 快路径。枚举失败直接抛错（交由调用方 sendError），不做降级。
 */
function killTreeExcept(pid: number, exempt: number): void {
  if (pid === exempt) return // 防 pid 复用巧合自杀
  const res = spawnSync(
    'powershell',
    ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
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
  // BFS 收集 root 的整棵子树（seen 防 PID 环）
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
    killTree(pid) // 网关不在目标树内：原 taskkill /T 快路径
    return
  }
  const skip = new Set(collectSubtree(exempt))
  for (const p of subtree) {
    if (skip.has(p)) continue
    spawnSync('taskkill', ['/F', '/PID', String(p)], { stdio: 'ignore', windowsHide: true })
  }
}

// C1 修复：惰性清扫。删除超过 TTL 的展示/活动记录，以及进程已退出的活动记录。
// 挂在 listSessions / pollSse / 上报入口上（这些是 Map 写入与读取的高频点），
// 不设独立定时器，避免无前端连接时空转。规模 = 活跃会话数，O(n) 遍历无碍。
function sweepStaleMaps(now = Date.now()): void {
  for (const [sid, v] of conversationDisplays) {
    if (now - v.updatedAt > DISPLAY_TTL_MS) conversationDisplays.delete(sid)
  }
  for (const [sid, v] of sessionActivity) {
    if (now - v.updatedAt > ACTIVITY_TTL_MS || !isPidAlive(v.pid)) sessionActivity.delete(sid)
  }
  // sessionModels/sessionQueues/sessionTasks 不入时间清扫（09-12/09-16 定案，见上方常量区注）：CLI「载荷不变不发」
  // 契约下时间 TTL 会清仓长不变期的活跃清单 → web 浮窗/排队区消失。生命周期 = detach 清 +
  // 重连 open 补发 + 网关重启对齐，「清单态只属于在线 CLI 进程」由这三者直接持有。
}

async function listSessions(root: string) {
  sweepStaleMaps()
  ensureSseWatches(root) // P0 自愈兜底：前端拉列表即按当前项目布局增量补齐 watch
  const groups = findProjects(root)
  const sessions: unknown[] = []
  for (const g of groups) {
    let files: string[] = []
    try {
      files = readdirSync(g.dir).filter((f) => f.endsWith('.jsonl') && SESSION_UUID_RE.test(f))
    } catch {
      continue
    }
    // 并行读各会话 head/tail 元数据（异步 I/O，不再同步阻塞事件循环）；未变文件命中
    // sessionMetaCache 直接复用，只有真正变化的文件重读+重扫（2026-08-30）
    const metas = await Promise.all(files.map((f) => parseMetaCached(join(g.dir, f))))
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const meta = metas[i]
      if (!meta || meta.sidechain) continue
      const p = join(g.dir, f)
      const uuid = f.replace(/\.jsonl$/, '')
      const act = sessionActivity.get(uuid)
      // 会话状态（2026-08-25 定案「web 与 CLI 一视同仁」；2026-09-04 根修恒绿）：一律经 activity
      // 上报（act + 存活 pid）判定——busy=绿 · idle/waiting=红/橘 · 停止/进程退出 → 无点（透明）。
      // 旧案 webSessions 短路恒报 busy：web 会话回合结束进程常驻仍显示绿点，已废；
      // webSessions 仅保留 spawn 幂等/stop 路由/重启收养用途，不再参与显示判定。
      const state = act && isPidAlive(act.pid) ? act.status : null
      sessions.push({
        id: Buffer.from(p).toString('base64url'),
        projectLabel: g.label,
        projectScope: g.scope,
        preview: g.hasPreview,
        file: basename(p),
        title: meta.title,
        messageCount: meta.messageCount,
        updatedAt: meta.updatedAt,
        createdAt: meta.createdAt,
        state,
        // 2026-09-06 回合中止权威时刻（有才有键）：web 首载恢复 turnEndFlags，防打断后刷新
        // 「正在处理」无限计时复活（closeSeg 二信号之一）。
        turnEndAt: turnEndAt.get(uuid),
      })
    }
  }
  sessions.sort((a, b) => ((b as { updatedAt: number }).updatedAt) - ((a as { updatedAt: number }).updatedAt))
  return { workspace: root, groups, sessions }
}

function decodeSessionPath(id: string, root: string): { path: string; uuid: string } {
  const p = Buffer.from(id, 'base64url').toString('utf8')
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  if (!p.startsWith(rootWithSep)) throw new Error('越界路径被拒绝: ' + p)
  return { path: p, uuid: basename(p).replace(/\.jsonl$/, '') }
}

// sid → 会话启动根（`<启动根>/.claude/projects/<uuid>.jsonl` 剥 marker）。
// file-cache 落盘/取字节都以该根为基址：CLI 侧 getProjectRoot() 与 web 会话 spawn cwd 同源。
// 非法/越界/路径形不符 → null（调用方按 project label 或网关自身根解析）。
function sessionRootFromId(id: string, root: string): string | null {
  try {
    const { path: p } = decodeSessionPath(id, root)
    const marker = sep + '.claude' + sep + 'projects'
    const k = p.toLowerCase().lastIndexOf(marker.toLowerCase())
    return k > 0 ? p.slice(0, k) : null
  } catch {
    return null
  }
}

/**
 * 上传上下文的会话解析，兼容两种 sid 形态：
 *  ① 完整 sid = base64url(<启动根>/.claude/projects/<uuid>.jsonl)（会话间协作 / API 口径）；
 *  ② web 路由 hash = 转录文件名主干 `<uuid>`（sessions.js 的 hashOf，URL `#/<uuid>`）。
 * 裸 uuid 无法解出启动根，按各项目与全局根的 `.claude/projects/<uuid>.jsonl` 逐一确认归属；
 * 找不到 → null（/gateway/upload 判 400；GET 读取侧按 project/网关根回落）。
 */
function resolveUploadSession(id: string, root: string): { root: string; dirKey: string } | null {
  const fullRoot = sessionRootFromId(id, root)
  if (fullRoot) {
    try {
      const { uuid } = decodeSessionPath(id, root)
      if (/^[0-9a-f-]{36}$/i.test(uuid)) return { root: fullRoot, dirKey: uuid }
    } catch { /* 落到裸 uuid 分支 */ }
  }
  const uuid = String(id || '').trim().replace(/\.jsonl$/i, '')
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) return null
  for (const g of findProjects(root)) {
    if (!isDir(g.dir)) continue
    if (existsSync(join(g.dir, `${uuid}.jsonl`))) {
      return { root: resolve(g.dir, '..', '..'), dirKey: uuid }
    }
  }
  return null
}

// 上下文占用（2026-08-23 dsh ContextMeter 移植数据源）：取转录最后一条 assistant 的 message.usage，
// usedTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens（该轮发送的完整
// 上下文 token 数），除以 getContextWindowForModel(model)（auto-compact 同源窗口）。无 usage 返回 null。
function extractContextUsage(records: Record<string, unknown>[]): Record<string, unknown> | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (!r || r.type !== 'assistant') continue
    const msg = r.message as Record<string, unknown> | undefined
    const usage = msg?.usage as Record<string, unknown> | undefined
    if (!usage) continue
    const input = Number(usage.input_tokens) || 0
    const cacheCreate = Number(usage.cache_creation_input_tokens) || 0
    const cacheRead = Number(usage.cache_read_input_tokens) || 0
    if (!(input || cacheCreate || cacheRead)) continue
    const model = typeof msg?.model === 'string' && msg.model ? msg.model : ''
    const contextWindow = model ? getContextWindowForModel(model) : 0
    if (!contextWindow) continue
    const usedTokens = input + cacheCreate + cacheRead
    const percent = Math.min(100, Math.round((usedTokens / contextWindow) * 100))
    return { usedTokens, contextWindow, percent, model }
  }
  return null
}

function readSession(id: string, root: string) {
  const { path: p } = decodeSessionPath(id, root)
  // 2026-08-23 web 独立会话：新会话进程刚 spawn 时 jsonl 可能尚未落盘 → 返回空消息而非 500。
  // 2026-09-12 文件占位相对化配套：cwd 从会话路径自带的项目根推出（id = base64url(
  // <启动根>/.claude/projects/<sid>.jsonl)）——首条消息落盘前前端 fetch 回程也拿到 cwd，
  // 不然 setSessionCwd(null) 会冲掉 wsession 响应带回值；路径形不符（异常 id）则 cwd 缺省。
  if (!existsSync(p) || !statSync(p).isFile()) {
    const marker = sep + '.claude' + sep + 'projects'
    const k = p.toLowerCase().lastIndexOf(marker.toLowerCase())
    return { file: basename(p), path: p, messages: [], context: null, cwd: k > 0 ? p.slice(0, k) : undefined }
  }
  const raw = readFileSync(p, 'utf8')
  const records: Record<string, unknown>[] = []
  let cwd: string | undefined
  // 2026-08-30 共同后端定案（接力文档清单#3）：删除 queue-op FIFO 配对补插 + guide 打标
  // 后置匹配整块（~85 行）。jsonl 的 queue-operation 日志（enqueue/dequeue/remove）无可靠配对
  // 依据（dequeue/remove 不带 content，FIFO 混序消耗即错位、double 风险），从日志反推渲染事件
  // 是本链路全部渲染 bug 的总根源。新语义：
  //  - dequeue 终结 → user 条目天然落盘于消费位置 = CLI 显示位置，前端切段直接消费；
  //  - 回合中注入 → 实时链路由 filterConversationForDisplay 的 queued_command attachment
  //    分支输出（injected:true，内存 messages 权威，conversationDisplay.ts）；非 ant 环境
  //    attachment 不落盘（isLoggableMessage）→ 历史回放无注入引导 = 与 CLI resume 行为同构；
  //  - 排队中 → 队列快照链（CLI queue-state 上报 → /gateway/session.queued + SSE 群发）。
  const lines = raw.split('\n')
  for (const line of lines) {
    const s = line.trim()
    if (!s) continue
    try {
      const r = JSON.parse(s)
      // 会话启动根（2026-08-29 变更卡相对路径显示）：转录记录自带 cwd（= 进程启动 cwd），
      // 取首条即得；前端据此把 fileChange 绝对路径剥成相对启动根路径
      if (!cwd && typeof (r as { cwd?: unknown }).cwd === 'string' && (r as { cwd: string }).cwd) cwd = (r as { cwd: string }).cwd
      // 只保留 normalizeMessages/filterConversationForDisplay 能处理的类型。
      // custom-title/agent-name/file-history-snapshot/queue-operation/last-prompt 等
      // 元记录会让 normalizeMessages 的 switch 无分支返回 undefined → isNotEmptyMessage
      // 崩溃（历史会话全部 500，遥测端看不了）。user/assistant/system 之外的展示不需要。
      // attachment 保留（落盘例外 hook_additional_context / 未来 ant 环境；filter 新分支可处理）。
      if (
        r &&
        typeof r === 'object' &&
        typeof (r as { type?: unknown }).type === 'string' &&
        ['user', 'assistant', 'system', 'attachment', 'progress'].includes((r as { type: string }).type)
      ) {
        records.push(r)
      }
    } catch {
      /* 跳过坏行 */
    }
  }
  // 复用 CLI 权威过滤（conversationDisplay.filterConversationForDisplay），
  // 与 CLI 上报的 display 同源，不再本地复刻 isSynth/toBlocks 等逻辑。
  // mode 用 'prompt-tail-think'（2026-08-27 思考等权展示·方案B）：已收尾历史 thinking 全隐藏
  // （原 'prompt' 语义不变），未收尾尾巴放行最后一块 thinking → 前端 liveFoldBody 以 vacuumState=
  // 'think' 驱动「正在思考」行内状态（CLI 高 effort 思考期 web 不再全空白）。原 'transcript' 曾
  // 保留全局最后一个 thinking，遥测端历史会话因此泄露不该出现的思考过程（废弃）。
  const messages = filterConversationForDisplay(records as never, 'prompt-tail-think')
  const context = extractContextUsage(records)
  return { file: basename(p), path: p, messages, context, cwd }
}

// 统一时间戳为毫秒（CLI 导出与 /gateway/session 均用数字；字符串 ISO 兜底解析）。
function tsMs(ts: unknown): number | undefined {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts
  if (typeof ts === 'string') {
    const n = Date.parse(ts)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

type MergeMsg = { role: string; blocks: unknown[]; timestamp?: unknown; injected?: boolean }
// 合并展示消息：以磁盘 jsonl 全量历史为基底，把 live（CLI 上报的内存窗口）中比磁盘末尾
// 更新的消息追加到尾部。原因：CLI 内存窗口在上下文压缩/续接后会缺历史真实用户消息，
// 直接返回 live 会让遥测端看不到完整历史（前端按真实用户消息切段，历史被折叠成一个 blob）；
// 磁盘是完整权威。live 未越过磁盘末尾 → 磁盘已覆盖 live 全部，整段丢弃 live 不重复。
// 2026-08-30 晚：queued_command attachment 已改为落盘（isLoggableMessage 放行，物理位置 =
// 消费位置 = 感知序）→ 注入引导由磁盘权威提供，此处不再做 live injected 归并
// （归并会在磁盘已有注入时产生双份；12:54 版归并基于「不落盘」前提，随落盘一并作废）。
function mergeDisplayMessages(
  disk: MergeMsg[],
  live: MergeMsg[],
): MergeMsg[] {
  if (!live.length) return disk
  if (!disk.length) return live
  const dLast = tsMs(disk[disk.length - 1].timestamp)
  const lLast = tsMs(live[live.length - 1].timestamp)
  if (dLast == null || lLast == null || lLast <= dLast) return disk
  const tail = live.filter((m) => (tsMs(m.timestamp) ?? 0) > dLast)
  return tail.length ? [...disk, ...tail] : disk
}

// ============================================================================
// 项目元信息（GET /gateway/project）：work 侧栏文件树消费其中的 files；响应同时带 README /
// 会话元信息（/gateway/project 的既有形状，不随宿主内置预览页下线而改变）。
//  - 文件树：递归扫项目根，跳过重型/隐藏目录（.git/node_modules/.claude/.trash/dist 等），
//    目录在前、按自然序（SubPj2 在 SubPj10 之前）；不设深度上限、不设每层 cap——单层条目
//    全部返回，唯一约束是 TREE_BUDGET=8000 全局预算。遍历为**广度优先**：先给每一层的所有
//    目录铺开直接子项，再下钻下一层，所以某个大目录（venv、抓取数据等）吃尽预算时，只牺牲
//    最深处的尾部，不会让同级其它目录变成空壳。
//  - README：项目根 README*（.md/.markdown/.txt）优先，内容截断防超大 payload。
//  - 描述：从 README 首行标题推断，兜底项目名。
// ============================================================================
const SKIP_TREE_DIRS = new Set(['.git', 'node_modules', '.claude', '.trash', '.cache', 'dist', 'cli-dist', '.idea', '.vscode'])
// 护栏：单次响应最多 TREE_BUDGET 个节点。目的只是防超大项目撑爆响应，不是业务裁剪——
// 单层不设 cap（此前每层 200 会把 349 项的目录截成前 200，@/+ 浮窗「进入目录后显示不全」即此）。
const TREE_BUDGET = 8000
type TreeNode = { name: string; type: 'file' | 'dir'; children?: TreeNode[] }

/** 自然序：数字段按数值比（SubPj2 < SubPj10），目录恒在文件前。 */
function cmpTreeEntry(a: { name: string; isDirectory(): boolean }, b: { name: string; isDirectory(): boolean }): number {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { numeric: true })
}

/** 轻量列出一层直接子项（不递归，不扣预算），供 /gateway/fs 单层浏览使用。 */
function listOneLevel(dir: string): TreeNode[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  entries.sort(cmpTreeEntry)
  const out: TreeNode[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.isDirectory() && SKIP_TREE_DIRS.has(e.name)) continue
    out.push(e.isDirectory() ? { name: e.name, type: 'dir' } : { name: e.name, type: 'file' })
  }
  return out
}

/** 列出一层直接子项（不递归），每收一个节点扣一次全局预算；预算耗尽即停。 */
function listTreeLevel(dir: string, budget: { n: number }): TreeNode[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  entries.sort(cmpTreeEntry)
  const out: TreeNode[] = []
  for (const e of entries) {
    if (budget.n <= 0) break
    if (e.name.startsWith('.')) continue
    if (e.isDirectory() && SKIP_TREE_DIRS.has(e.name)) continue
    budget.n--
    out.push(e.isDirectory() ? { name: e.name, type: 'dir' } : { name: e.name, type: 'file' })
  }
  return out
}

// 不设固定深度上限：唯一约束是条目预算（同一 budget 对象全局共享、沿树递减）。此前 `depth > 3`
// 会把第 5 层起的目录截成浅节点（无 children）——文件树「展开四次后再无内容」的根因。
// 单层不设 cap（2026-10-25 去掉 TREE_PER_LEVEL=200：349 项的目录只显示前 200 = 用户实报的「截断」）。
// 遍历取**广度优先**：DFS 下第一棵大树（如 backend/_venv_excluded 的 5585 项）会把预算吃光，
// 后续同级目录连一层都拿不到（SubPj10 展开空白即此）。BFS 先铺满当前层再下钻，任何目录都在
// 同深度上先拿到自己的直接子项，预算只可能耗尽在最深的尾部。
function walkProjectTree(dir: string, budget: { n: number }): TreeNode[] {
  const roots = listTreeLevel(dir, budget)
  const queue: Array<{ path: string; node: TreeNode }> = []
  for (const n of roots) if (n.type === 'dir') queue.push({ path: join(dir, n.name), node: n })
  while (queue.length && budget.n > 0) {
    const cur = queue.shift()!
    const kids = listTreeLevel(cur.path, budget)
    if (!kids.length) continue
    cur.node.children = kids
    for (const k of kids) if (k.type === 'dir') queue.push({ path: join(cur.path, k.name), node: k })
  }
  return roots
}

function findProjectReadme(dir: string): string | null {
  const names = ['README.md', 'readme.md', 'README.markdown', 'readme.markdown', 'README.txt', 'readme.txt']
  for (const n of names) {
    const p = join(dir, n)
    if (existsSync(p) && statSync(p).isFile()) {
      const txt = readFileSync(p, 'utf8')
      return txt.length > 200 * 1024 ? txt.slice(0, 200 * 1024) : txt
    }
  }
  try {
    const hit = readdirSync(dir).find((f) => /^readme/i.test(f) && !/^\./.test(f))
    if (hit) {
      const p = join(dir, hit)
      if (existsSync(p) && statSync(p).isFile()) {
        const txt = readFileSync(p, 'utf8')
        return txt.length > 200 * 1024 ? txt.slice(0, 200 * 1024) : txt
      }
    }
  } catch {
    /* 忽略 */
  }
  return null
}

function deriveProjectDescription(readme: string | null, label: string): string {
  if (readme) {
    for (const line of readme.split('\n')) {
      const m = /^#\s+(.+?)\s*$/.exec(line)
      if (m) return m[1].trim().slice(0, 120)
    }
  }
  return label
}

// ============================================================================
// 插件/技能清单（便携根扫描；供 MGR 管理视图 GET /gateway/plugins）
//  - 已安装插件：.claude/plugins/<name>/.claude-plugin/plugin.json
//  - 已安装技能：.claude/skills/<name>/SKILL.md 的 frontmatter（name/description）
// 不读公开市场清单（marketplaces/）：管理视图只列本地已安装项。
// ============================================================================
function readJsonObject(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function parseSkillFrontmatter(text: string): { name: string; description: string; repo: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const out = { name: '', description: '', repo: '' }
  if (!m) return out
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const key = line.slice(0, i).trim()
    const val = line.slice(i + 1).trim()
    if (key === 'name') out.name = val
    else if (key === 'description') out.description = val
    else if (key === 'repo' || key === 'repository') out.repo = val.replace(/^['"]|['"]$/g, '')
  }
  return out
}

// 技能目录扫描（唯一处）：只认带 SKILL.md 的目录，名称/描述取 frontmatter，缺省回落目录名。
// 便携根（listPlugins 的 personal.skills）与项目根（/gateway/plugins?label=）共用本函数——
// 项目技能 = <项目根>/.claude/skills（项目会话安装落点见工作区规范）。
// k = 目录名（启停端点与前端开关的稳定键，显示名 n 可能来自 frontmatter）；
// en = 启用态（目录内无 .disabled 标记），与加载侧 isCustomizationDirEnabled 同一判据。
function readSkillDir(skillsDir: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  if (!isDir(skillsDir)) return out
  for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const dir = join(skillsDir, e.name)
    const fp = join(dir, 'SKILL.md')
    if (!existsSync(fp)) continue
    const fm = parseSkillFrontmatter(readFileSync(fp, 'utf8'))
    out.push({
      n: fm.name || e.name,
      d: fm.description,
      repo: fm.repo,
      inst: 1,
      k: e.name,
      en: isCustomizationDirEnabled(dir) ? 1 : 0,
    })
  }
  return out
}

// 已安装插件目录扫描（唯一处）：只认带 .claude-plugin/plugin.json 的直接子目录。
// 便携根（listPlugins）与项目根（/gateway/plugins?label=，work 插件 tab）共用本函数。
// k = 目录名（启停端点与前端开关的稳定键），en = 目录内无 .disabled 标记。
function readPluginDir(pluginsDir: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  if (!isDir(pluginsDir)) return out
  for (const e of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'data' || e.name === 'marketplaces') continue
    const m = readJsonObject(join(pluginsDir, e.name, '.claude-plugin', 'plugin.json'))
    if (!m) continue
    const repoRaw = m.repository
    const repoField = typeof repoRaw === 'string' ? repoRaw : (repoRaw && typeof repoRaw === 'object' ? String((repoRaw as Record<string, unknown>).url || '') : '')
    const homepage = typeof m.homepage === 'string' ? m.homepage : ''
    const repo = /^https?:\/\/github\.com\//i.test(repoField) ? repoField : (/^https?:\/\/github\.com\//i.test(homepage) ? homepage : '')
    out.push({
      n: String(m.name || e.name),
      d: String(m.description || ''),
      v: String(m.version || ''),
      repo,
      inst: 1,
      k: e.name,
      en: isCustomizationDirEnabled(join(pluginsDir, e.name)) ? 1 : 0,
    })
  }
  return out
}

function listPlugins(root: string): Record<string, unknown> {
  const pluginsDir = join(root, '.claude', 'plugins')
  const skillsDir = join(root, '.claude', 'skills')

  // 已安装插件（跳过 data/marketplaces 等系统目录与隐藏目录）
  const personalPlugins = readPluginDir(pluginsDir)

  // 已安装技能（只有带 SKILL.md 的目录才算技能）
  const personalSkills = readSkillDir(skillsDir)

  // 按名称字母序
  const sortN = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    String(a.n).localeCompare(String(b.n))
  personalPlugins.sort(sortN)
  personalSkills.sort(sortN)

  return {
    workspace: root,
    plugins: { personal: personalPlugins },
    skills: { personal: personalSkills },
  }
}

// ============================================================================
// 模型配置（MGR 管理视图 GET /gateway/models，与 SubPj1 server.mjs 同逻辑）
// 数据源 = 便携根 .claude/credentials.json 凭据池各 provider 的可用模型 +
//          settings.json 的 model 字段 + env 中模型类环境变量 + 进程实际环境。
// 只读展示，不改写任何配置。
// ============================================================================
const MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]
const MODEL_PROVIDER_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  anthropic: 'Claude · Anthropic',
  claude: 'Claude · Anthropic',
  openai: 'OpenAI',
  qwen: 'Qwen · 通义千问',
  dashscope: 'Qwen · 通义千问',
  gemini: 'Google Gemini',
  glm: '智谱 GLM',
  moonshot: 'Moonshot Kimi',
  openrouter: 'OpenRouter',
}
function modelProviderLabel(name: string): string {
  return MODEL_PROVIDER_LABELS[name.toLowerCase()] || name
}
function listModels(root: string): Record<string, unknown> {
  // 读侧走官方统一设置服务（2026-08-27 P1 修复）：getSettingsForSource('userSettings') 解析到
  // 便携根 .claude/settings.json（与写侧 updateSettingsForSource 同源，写后缓存自动失效）。
  const settings = getSettingsForSource('userSettings') ?? ({} as SettingsJson)
  const items: Array<{ k: string; v: string; src: string }> = []
  if (settings.model !== undefined) items.push({ k: 'model', v: String(settings.model), src: 'settings.json' })
  const env0 = settings.env && typeof settings.env === 'object' ? (settings.env as Record<string, unknown>) : {}
  const seen = new Set(items.map((i) => i.k))
  for (const k of MODEL_ENV_KEYS) {
    if (env0[k] !== undefined && !seen.has(k)) {
      items.push({ k, v: String(env0[k]), src: 'settings.json → env' })
      seen.add(k)
    }
  }
  for (const k of MODEL_ENV_KEYS) {
    if (process.env[k] !== undefined && !seen.has(k)) {
      items.push({ k, v: String(process.env[k]), src: '进程环境变量' })
      seen.add(k)
    }
  }
  // 凭据池（2026-08-27 P1 修复）：不再手解 credentials.json，复用官方 loadCredentials()
  // （providers[].models[] = 各供应商实际可用的模型清单）
  const creds = loadCredentials()
  const poolRows: Array<{ k: string; v: string; src: string; vision?: boolean; provider?: string; effortLevels?: string[] }> = []
  const poolSet = new Set<string>()
  for (const [name, cfg0] of Object.entries(creds.providers)) {
    const cfg = (cfg0 && typeof cfg0 === 'object' ? cfg0 : {}) as Record<string, unknown>
    const models = Array.isArray(cfg.models) ? (cfg.models as string[]) : []
    const mv =
      cfg.modelVision && typeof cfg.modelVision === 'object' ? (cfg.modelVision as Record<string, unknown>) : {}
    // 官方思考等级声明（2026-09-18，供应商 effortLevels）随条目下发 → web 推理等级菜单按官方档位动态渲染
    const effLv = Array.isArray(cfg.effortLevels)
      ? (cfg.effortLevels as unknown[]).map((s) => String(s).toLowerCase().trim()).filter(Boolean)
      : undefined
    const label = modelProviderLabel(name)
    for (const m of models) {
      if (poolSet.has(m)) continue
      // 工具绑定模型（生图等）不出现在可切换列表（2026-10-11）：仅隐藏，直连链仍可达
      if (isToolBoundModel(name, cfg as unknown as ProviderConfig, m)) continue
      poolSet.add(m)
      // provider=真实归属供应商标签（2026-08-29 直接切模型自动切供应商：前端据此分组/跨商直选，免启发式前缀判定）
      poolRows.push({
        k: m,
        v: m,
        src: `凭据池·${label}`,
        vision: mv[m] === true,
        provider: label,
        ...(effLv && effLv.length ? { effortLevels: effLv } : {}),
      })
    }
  }
  // 已作为凭据池模型展示的 settings/env 条目不再重复（同一模型只出现一次）
  const cfgItems = items.filter((it) => !poolSet.has(it.v))
  // 当前真实启用模型 = 凭据池 activeModel（与 CLI getUserSpecifiedModelSetting 同源，优先级高于 settings.model）；
  // 无凭据池配置时回落到 settings.model，保证显示值与 CLI 实际使用一致。
  // 管理视图语义（2026-09-10）：读池文件现值，不走本进程会话绑定（网关展示的是全局默认，
  // 不因某个会话的绑定而变）。
  const activeModel = getGlobalActiveModel()
  const activeCfg = getGlobalActiveProviderConfig()
  return {
    workspace: root,
    model: activeModel ?? (settings.model !== undefined ? String(settings.model) : null),
    // 2026-08-28 遥测端图片门控：当前生效模型是否识图（凭据池 override，/key vision <model> on；
    // 默认非识图）→ 前端据此显隐图片上传入口
    vision: activeModel ? modelSupportsVision(activeModel) : false,
    activeProvider: creds.activeProvider || null,
    activeModel,
    // 当前供应商可切换的模型清单（每会话模型切换的校验集；前端模型浮窗据此渲染）
    // 工具绑定模型（生图等）同样剔除（2026-10-11）：否则前端 model-select 的 fallback 分支仍会漏出
    providerModels:
      activeCfg && Array.isArray(activeCfg.models)
        ? (activeCfg.models as string[]).filter((m) => !isToolBoundModel(creds.activeProvider, activeCfg, m))
        : [],
    effortLevel: settings.effortLevel !== undefined ? String(settings.effortLevel) : null,
    source: getSettingsFilePathForSource('userSettings') ?? null,
    items: [...poolRows, ...cfgItems],
  }
}

// 供应商模型目录（2026-10-30 模型卡「选择启用」）：用凭据池里的 key 实时向供应商拉取
// **全部**模型清单，只读——写回 providers[].models 由前端经 /gateway/file/write 完成。
// 端点探测顺序（各厂商把 /v1/models 挂在不同根）：
//   openai-chat → {baseUrl}/models
//   anthropic   → {baseUrl}/v1/models → 去掉尾部 /anthropic 的 {root}/v1/models
// 响应归一化：{data:[{id,display_name}]}（Anthropic/OpenAI/GLM）与 {models:[{id,name}]}。
// 失败不抛错：ok=false + error，前端回落密钥池现有清单。
const CATALOG_TIMEOUT_MS = 9000
function catalogUrls(cfg: ProviderConfig): string[] {
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '')
  if (!base) return []
  if (cfg.protocol === 'openai-chat') return [base + '/models']
  const out = [base + '/v1/models']
  const stripped = base.replace(/\/api\/anthropic$/, '').replace(/\/anthropic$/, '')
  if (stripped !== base) out.push(stripped + '/v1/models')
  return [...new Set(out)]
}
function normalizeCatalogModels(json: unknown): Array<{ id: string; name?: string }> {
  const obj = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const arr = Array.isArray(obj.data) ? obj.data : Array.isArray(obj.models) ? obj.models : []
  const out: Array<{ id: string; name?: string }> = []
  const seen = new Set<string>()
  for (const raw of arr) {
    const it = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    let id = String(it.id || it.name || '').trim()
    if (!id) continue
    if (id.startsWith('models/')) id = id.slice(7)
    if (seen.has(id)) continue
    seen.add(id)
    const dn =
      typeof it.display_name === 'string'
        ? it.display_name
        : typeof it.name === 'string' && it.name !== id
          ? it.name
          : undefined
    out.push(dn ? { id, name: dn } : { id })
  }
  return out
}
async function fetchCatalogModels(url: string, key: string): Promise<Array<{ id: string; name?: string }>> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), CATALOG_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        Accept: 'application/json',
      },
      signal: ctl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return normalizeCatalogModels(await res.json())
  } finally {
    clearTimeout(timer)
  }
}
async function listProviderCatalog(name: string): Promise<Record<string, unknown>> {
  const creds = loadCredentials()
  const providers = creds.providers as Record<string, ProviderConfig>
  const cfg = providers[name]
  if (!cfg) return { provider: name, ok: false, error: 'provider not found', enabled: [], models: [] }
  const enabled = Array.isArray(cfg.models) ? (cfg.models as unknown[]).map(String) : []
  const keys = (Array.isArray(cfg.keys) ? cfg.keys : [])
    .filter((k) => k && typeof k.value === 'string' && k.value && !k.exhausted)
    .map((k) => k.value)
  let discovered: Array<{ id: string; name?: string }> = []
  let usedUrl: string | null = null
  let firstError = ''
  outer: for (const url of catalogUrls(cfg)) {
    for (const key of keys) {
      try {
        const list = await fetchCatalogModels(url, key)
        usedUrl = url
        if (list.length) {
          discovered = list
          break outer
        }
      } catch (e) {
        if (!firstError) firstError = e instanceof Error ? e.message : String(e)
      }
    }
  }
  // 已启用的模型恒在（目录拉取失败也不能让启用项从界面消失），其余按厂商返回顺序追加
  const merged: Array<{ id: string; name?: string; enabled: boolean; vision: boolean; tool: boolean }> = []
  const seen = new Set<string>()
  for (const id of enabled) {
    if (seen.has(id)) continue
    seen.add(id)
    merged.push({
      id,
      enabled: true,
      vision: !!(cfg.modelVision && cfg.modelVision[id] === true),
      tool: isToolBoundModel(name, cfg, id),
    })
  }
  for (const it of discovered) {
    if (seen.has(it.id)) continue
    seen.add(it.id)
    merged.push({
      id: it.id,
      ...(it.name ? { name: it.name } : {}),
      enabled: false,
      vision: !!(cfg.modelVision && cfg.modelVision[it.id] === true),
      tool: isToolBoundModel(name, cfg, it.id),
    })
  }
  return {
    provider: name,
    ok: discovered.length > 0,
    url: usedUrl,
    error: discovered.length ? null : firstError || '未发现模型清单端点',
    enabled,
    models: merged,
  }
}

/** 统一群发（P2 收敛）：逐个发送并吞掉单个客户端断开异常，broadcast/pollSse/内联群发共用。 */
function sendAll<T>(targets: Iterable<T>, send: (t: T) => void): void {
  for (const t of targets) {
    try {
      send(t)
    } catch {
      /* 断开忽略 */
    }
  }
}

/** 精确路由控制消息到指定会话（/clients 注册的 WS）；无 sessionId/未命中 → 返回 false（不广播兜底，2026-08-23 用户定案）。 */
function routeToClient(sessionId: string | undefined, msg: unknown): boolean {
  if (!sessionId) return false
  const target = cliClients.get(sessionId)
  if (target && target.readyState === WebSocket.OPEN) {
    try {
      target.send(JSON.stringify(msg))
      return true
    } catch {
      /* 断开忽略，返回 false（不广播兜底） */
    }
  }
  return false
}

// ============================================================================
// SSE 实时事件（jsonl 变化，事件驱动）
// ============================================================================
// O4：watch 事件 → 去抖 → pollSse 扫描。watch 事件仅做「有变化」的提示，真正 diff 仍由 pollSse
// 用 size/mtime 判定（与旧轮询同一逻辑），保证跨平台（尤其 Windows ReadDirectoryChangesW 只给
// 文件名不给内容）也能准确识别具体哪个会话文件变了。
function scheduleSseFlush(root: string): void {
  if (sseClients.size === 0 || sseDebounce) return
  sseDebounce = setTimeout(() => {
    sseDebounce = null
    pollSse(root)
  }, 250)
}
function ensureSseWatches(root: string): void {
  // P0 修复（2026-08-27）：原版 `size > 0` 早退只在首个 SSE 订阅时建一批 watch，网关运行中
  // 新建的项目目录永不覆盖，其会话变化无法触发 SSE → 改为增量补建：每次调用按 findProjects
  // 当前结果为缺失的目录补 watch；watcher error（Windows 目录删除等失效）摘除条目，下次调用自动重建。
  for (const g of findProjects(root)) {
    if (sseWatches.has(g.dir)) continue
    try {
      const dir = g.dir
      const w = watch(dir, () => scheduleSseFlush(root))
      w.on('error', () => {
        if (sseWatches.get(dir) === w) sseWatches.delete(dir)
      })
      sseWatches.set(dir, w)
    } catch {
      /* 目录不存在/被移除，忽略 */
    }
  }
}
function stopSseWatches(): void {
  for (const w of sseWatches.values()) {
    try {
      w.close()
    } catch {
      /* 忽略 */
    }
  }
  sseWatches.clear()
  if (sseDebounce) {
    clearTimeout(sseDebounce)
    sseDebounce = null
  }
}

function pollSse(root: string): void {
  if (sseClients.size === 0) return
  sweepStaleMaps()
  const groups = findProjects(root)
  for (const g of groups) {
    let files: string[] = []
    try {
      files = readdirSync(g.dir).filter((f) => f.endsWith('.jsonl') && SESSION_UUID_RE.test(f))
    } catch {
      continue
    }
    for (const f of files) {
      const p = join(g.dir, f)
      let st: { size: number; mtimeMs: number }
      try {
        st = statSync(p)
      } catch {
        continue
      }
      const prev = sseSizes.get(p)
      const changed = !!prev && (prev.size !== st.size || prev.mtime !== st.mtimeMs)
      if (ssePrimed && (changed || !prev)) {
        const obj = { type: 'updated', hash: f.replace(/\.jsonl$/, ''), file: f, updatedAt: st.mtimeMs }
        const s = `data: ${JSON.stringify(obj)}\n\n`
        sendAll(sseClients, (c) => {
          c.res.write(s)
        })
      }
      sseSizes.set(p, { size: st.size, mtime: st.mtimeMs })
    }
  }
  ssePrimed = true
}

// ============================================================================
// HTTP / WS
// ============================================================================
type ServerResponse = import('node:http').ServerResponse
// O2：统一 JSON 响应帮助函数，消除 handleRequest 内每路由重复的 writeHead/end/JSON.stringify
function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
  res.end(JSON.stringify(obj))
}
function sendError(res: ServerResponse, e: unknown): void {
  sendJson(res, 500, { error: String((e && (e as Error).message) || e) })
}
/** readReportBody 统一 catch 响应（P2 收敛）：超限 413 payload too large，其余一律 400 invalid body。 */
function sendReportBodyError(res: ServerResponse, error: unknown): void {
  const status = error instanceof ReportBodyTooLargeError ? 413 : 400
  sendJson(res, status, { error: status === 413 ? 'payload too large' : 'invalid body' })
}

async function handleRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, root: string): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`)
  // 直连客户端自愈：凡同网段 IPv4 设备发来 HTTP 请求即定向推 legacy announce（iPad 多播被吞
  // 场景，直连 8124 即建立 floria.local 解析——见 mdnsPushToReachableClient）
  try {
    mdnsPushToReachableClient(req.socket.remoteAddress ?? '')
  } catch {
    /* 推送失败不影响请求 */
  }
  // 安全加固（2026-08-15）：HTTP 数据接口与 WS 升级一致要求 token。
  //  - /gateway/health 保持公开探活（/server status、前端 detectGateway 只读 mode），响应已精简不含路径泄露；
  //  - 其余 /gateway/*（会话/插件/SSE/上报写接口）与 /preview/* 一律校验「query token 或 cookie 票证」，失败 401。
  //  - /gateway/project 属于 /gateway/* 已受保护（work 侧栏文件树消费）。
  // 2026-08-28 设备认证配对（用户定案：浏览器侧完全删除 token 授权链）：
  //  - 浏览器授权只走 floria_auth cookie 票证（手动配对：设备门显示请求码 → PC `/server auth add`
  //    → 设备 GET /gateway/activate?code=<码> 种 cookie）→ 授权设备 URL 干净、永久免认证。
  //  - query token 仅剩网关 token（CLI 上报/内部链路），只放行请求、不种 cookie（浏览器不可用
  //    它获得授权；浏览器 URL 也不再出现 token）。
  const qToken = url.searchParams.get('token')
  const qOk = qToken != null && qToken !== '' && qToken === currentToken
  const cookieVal = parseCookieHeader(req.headers.cookie)[AUTH_COOKIE_NAME]
  const cookieOk = isGatewayTicket(cookieVal)
  const isProtected =
    (url.pathname.startsWith('/gateway/') && url.pathname !== '/gateway/health' && url.pathname !== '/gateway/activate') ||
    url.pathname.startsWith('/preview/')
  if (isProtected && !qOk && !cookieOk) {
    sendJson(res, 401, { error: 'unauthorized' })
    return
  }
  // 授权设备活跃回写（2026-09-01 /server auth 设备情况展示：UA/IP/lastSeen，60s 写盘节流）
  if (isProtected && cookieOk) {
    touchGatewayTicket(cookieVal, req.headers['user-agent'], remoteIPv4(req.socket.remoteAddress))
  }
  // 设备配对激活（公开端点，防枚举靠请求码熵）：码在授权名单（/server auth add）→ 种 HttpOnly
  // floria_auth cookie（票证=码本身，1 年）；不在名单 → 403。前端门态轮询此端点实现「授权后自动进入」。
  if (req.method === 'GET' && url.pathname === '/gateway/activate') {
    const code = (url.searchParams.get('code') || '').trim()
    if (code && isGatewayTicket(code)) {
      // 设备自报类型（iPad 等 UA 无解场景）随配对轮询上报，记入设备情况
      const hint = (url.searchParams.get('device') || '').trim()
      if (hint) touchGatewayTicket(code, undefined, undefined, hint)
      res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${code}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`)
      sendJson(res, 200, { ok: true })
    } else {
      sendJson(res, 403, { ok: false, error: 'not authorized' })
    }
    return
  }
  if (req.method === 'GET' && url.pathname === '/gateway/health') {
    // boot：本网关进程启动时刻。前端用它判定「是否换了网关」——同一网关刷新保留工具栏开合，
    // 换网关（boot 变）则复位为折叠（2026-11-07 用户定案）。
    sendJson(res, 200, { ok: true, mode: 'gateway', boot: GATEWAY_BOOT_AT })
    return
  }
  // 2026-08-17 独立网关优雅关闭端点（受上方 /gateway/* token 校验保护）：/server off 调用。
  // 先回响应，再 stopLocalGateway + 退出进程（网关是独立 --gateway 进程，exit 即释放端口）。
  if (req.method === 'POST' && url.pathname === '/gateway/shutdown') {
    sendJson(res, 200, { ok: true, stopping: true })
    setTimeout(() => {
      stopLocalGateway()
      process.exit(0)
    }, 50)
    return
  }
  // 安全卸载（拔盘前全关）：停全部会话 + 全部卡片后端 + 网关自身。先回清单，再异步收尾。
  if (req.method === 'POST' && url.pathname === '/gateway/eject') {
    if (!process.argv.includes('--gateway')) {
      sendJson(res, 409, { ok: false, error: 'eject 仅独立网关进程（--gateway）支持' })
      return
    }
    const r = beginSafeEject()
    if (!r) {
      sendJson(res, 409, { ok: false, error: 'already ejecting' })
      return
    }
    sendJson(res, 200, { ok: true, ejecting: true, sessions: r.sessions, backends: r.backends })
    return
  }
  if (req.method === 'GET' && url.pathname === '/gateway/sessions') {
    try {
      sendJson(res, 200, await listSessions(root))
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 元素清单（2026-11-13）：扫描预览声明（preview.json 顶层 elements[] + 各卡 card.json 的 elements[]），
  // 供「+」工具栏「元素」入口与 @ 跨类搜索。有 label = 该项目 preview 目录；无 label = 便携根 preview
  // （全局上下文，与 chat 侧应用卡同源）。项目不存在 → 404（与 /gateway/plugins?label= 同口径）。
  if (req.method === 'GET' && url.pathname === '/gateway/mention-elements') {
    const elLabel = (url.searchParams.get('label') || '').trim()
    try {
      let previewDir: string
      if (elLabel) {
        const proj = findProjects(root).find((g) => g.label === elLabel)
        if (!proj) {
          sendJson(res, 404, { error: 'project not found' })
          return
        }
        previewDir = join(resolve(proj.dir, '..', '..'), '.claude', 'preview')
      } else {
        previewDir = join(root, '.claude', 'preview')
      }
      sendJson(res, 200, {
        label: elLabel,
        title: readMentionElementsTitle(previewDir),
        icon: readMentionElementsIcon(previewDir),
        elements: readMentionElements(previewDir),
      })
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // ?label=<项目> = 该项目自己的技能清单（项目根 .claude/skills），供 work 右栏「技能」工具页；
  // 无 label = 便携根清单（管理视图「插件」卡）。两者结构不合并：项目技能只回 {label, skills}。
  if (req.method === 'GET' && url.pathname === '/gateway/plugins') {
    const plLabel = (url.searchParams.get('label') || '').trim()
    try {
      if (plLabel) {
        const plProj = findProjects(root).find((g) => g.label === plLabel)
        if (!plProj) {
          sendJson(res, 404, { error: 'project not found' })
          return
        }
        const plDir = resolve(plProj.dir, '..', '..') // <项目根>/.claude/projects → <项目根>
        sendJson(res, 200, {
          label: plLabel,
          // work 插件 tab：项目自己的已安装插件 / 技能（无公开市场，只列个人已安装项）
          plugins: readPluginDir(join(plDir, '.claude', 'plugins')),
          skills: readSkillDir(join(plDir, '.claude', 'skills')),
        })
        return
      }
      sendJson(res, 200, listPlugins(root))
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 插件/技能启停（2026-11-07 定案）：POST /gateway/plugins/enable {kind, name, enabled, label?}
  // 状态 = 自定义件目录内的 .disabled 标记文件（存在即停用），不写 settings.json、不改
  // plugin.json / SKILL.md（前者是厂家清单、后者是用户手写内容）。加载侧同一判据：
  // utils/customizationToggle → loadSkillsFromSkillsDir / loadSkillsDirPlugins。
  // name 只认直接子目录名（禁分隔符/上溯/隐藏目录），并按 kind 校验目录形态。
  if (req.method === 'POST' && url.pathname === '/gateway/plugins/enable') {
    try {
      let eBody: unknown
      try {
        eBody = JSON.parse((await readBodyWithLimit(req, 64 * 1024)).toString('utf8') || '{}')
      } catch (e) {
        if (e instanceof ReportBodyTooLargeError) {
          sendJson(res, 413, { error: 'too large' })
          return
        }
        throw e
      }
      if (eBody === null || typeof eBody !== 'object' || Array.isArray(eBody)) {
        sendJson(res, 400, { error: 'invalid body' })
        return
      }
      const eb = eBody as Record<string, unknown>
      const kind = eb.kind === 'plugins' || eb.kind === 'skills' ? eb.kind : ''
      const name = typeof eb.name === 'string' ? eb.name.trim() : ''
      const enabled = eb.enabled !== false
      const eLabel = typeof eb.label === 'string' ? eb.label.trim() : ''
      if (!kind) {
        sendJson(res, 400, { error: 'kind 必须是 plugins 或 skills' })
        return
      }
      if (!name || name === '.' || name === '..' || name.startsWith('.') || /[\\/]/.test(name)) {
        sendJson(res, 400, { error: 'name 非法（只接受直接子目录名）' })
        return
      }
      let eBase: string
      if (eLabel) {
        // 项目维度：plugins / skills 均可（work 插件 tab 管理项目自己的已安装项）
        const eProj = findProjects(root).find((g) => g.label === eLabel)
        if (!eProj) {
          sendJson(res, 404, { error: 'project not found' })
          return
        }
        eBase = join(resolve(eProj.dir, '..', '..'), '.claude', kind)
      } else {
        eBase = join(root, '.claude', kind)
      }
      const eDir = join(eBase, name)
      if (!isDir(eDir)) {
        sendJson(res, 404, { error: '目录不存在' })
        return
      }
      const eIsPlugin = existsSync(join(eDir, '.claude-plugin', 'plugin.json'))
      const eIsSkill = existsSync(join(eDir, 'SKILL.md'))
      if (kind === 'plugins' ? !eIsPlugin : !eIsSkill) {
        sendJson(res, 400, { error: kind === 'plugins' ? '该目录不是插件' : '该目录不是技能' })
        return
      }
      const eMarker = join(eDir, CUSTOMIZATION_DISABLED_MARKER)
      if (enabled) {
        if (existsSync(eMarker)) unlinkSync(eMarker)
      } else if (!existsSync(eMarker)) {
        writeFileSync(eMarker, '')
      }
      sendJson(res, 200, { ok: true, kind, name, enabled })
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  if (req.method === 'GET' && url.pathname === '/gateway/models') {
    try {
      sendJson(res, 200, listModels(root))
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 供应商全部模型目录（模型卡「选择启用」的只读数据源，见 listProviderCatalog 头注）
  if (req.method === 'GET' && url.pathname === '/gateway/models/catalog') {
    try {
      const name = (url.searchParams.get('provider') || '').trim()
      if (!name) {
        sendJson(res, 400, { error: '缺少 provider 参数' })
        return
      }
      sendJson(res, 200, await listProviderCatalog(name))
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 神经元可视化（web「神经」tab，只读；数据源与复用层见 neuronViz.ts 头注）：
  //   GET /gateway/neurons            → 神经元清单（层级 1 选择界面）
  //   GET /gateway/neurons/graph?id=&res= → 单库三级图数据包（层级 2 Canvas 力导向）
  if (req.method === 'GET' && url.pathname === '/gateway/neurons') {
    try {
      sendJson(res, 200, listNeuronsForGateway(gatewayNeuronRoots()))
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  if (req.method === 'GET' && url.pathname === '/gateway/neurons/graph') {
    try {
      const id = (url.searchParams.get('id') || '').trim()
      if (!id) {
        sendJson(res, 400, { error: '缺少 id 参数' })
        return
      }
      sendJson(res, 200, buildNeuronGraph(id, gatewayNeuronRoots(), url.searchParams.get('res') || undefined))
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 2026-08-22 模型/思考等级切换（受上方 /gateway/* token 校验保护）：
  //   POST /gateway/model {model?, effortLevel?, sessionId?}
  //   - model → 每会话切换：校验放宽到凭据池全部供应商（findModelProvider），随
  //     {type:'model', provider} 按 sessionId 精确路由到对应 CLI 进程（该进程进程内绑定该
  //     供应商的 baseUrl/key + STATE 模型覆盖），只影响本会话；未在线拒绝、无 sessionId 拒绝。
  //     2026-09-10 根治：本分支不再写全局凭据池（原先 ensureProviderForModel 全局切
  //     activeProvider，导致切一个会话的模型毒害其它在跑会话——模型名/endpoint 错配 400）。
  //   - effortLevel → 两态（2026-11-06 会话隔离）：带 sessionId = 该会话自己的档位，精确路由
  //     到该 CLI 并落 sessionEfforts 镜像，不写盘/不广播；无 sessionId = 全局默认，写 settings.json
  //     供新会话继承（过 toPersistableEffort 守卫：'max' 非 ant 为 session-scoped 不落盘=删键跟随
  //     默认），同样不广播——已在跑的会话各自保持自己的档位。
  //   （2026-10-11 删除 defaultModel 分支：全局默认模型不再有运行期写入口，改全局默认 =
  //     直接编辑凭据池 credentials.json，见文件头注释。）
  if (req.method === 'POST' && url.pathname === '/gateway/model') {
    try {
      const parsed = await readReportBody(req)
      const model = typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : undefined
      const sessionId =
        typeof parsed.sessionId === 'string' && parsed.sessionId.trim() ? parsed.sessionId.trim() : undefined
      const rawEffort =
        typeof parsed.effortLevel === 'string' && parsed.effortLevel.trim() ? parsed.effortLevel.trim() : undefined
      // 'off'/'auto'/'default' = 清除思考等级（null → CLI effortValue=undefined；全局态下删 settings 键）
      const effortLevel =
        rawEffort === 'off' || rawEffort === 'auto' || rawEffort === 'default' ? null : rawEffort
      if (model === undefined && effortLevel === undefined) {
        sendJson(res, 400, { error: 'invalid body' })
        return
      }
      // 模型归属供应商：随路由下发，目标 CLI 进程据此绑定 baseUrl/key（跨供应商会话级切换）
      let modelProvider: string | null = null
      if (model !== undefined) {
        modelProvider = findModelProvider(model)
        if (!modelProvider) {
          sendJson(res, 400, { error: `model "${model}" 不在凭据池任何供应商模型清单中` })
          return
        }
      }
      // 2026-11-06 会话隔离（C）：带 sessionId 的 effortLevel = **该会话自己**的思考等级，只精确
      // 路由到目标 CLI，不写全局 settings.json、不广播给其它会话（旧实现两者都做 → 改一个会话的
      // 等级，全部会话跟着变）。无 sessionId（首页/新会话选择）= 全局默认，写盘供新会话继承，
      // 同样不广播——已在跑的会话保持各自的值。
      if (effortLevel !== undefined && !sessionId) {
        // E（2026-08-26）：统一设置服务——不再手写 settings.json，改接官方 updateSettingsForSource
        // （校验/合并/删除/缓存失效/失败暴露全在服务内）。'userSettings' 写便携根
        // getClaudeConfigHomeDir()/settings.json（便携模式 = 便携根/.claude，与旧 writeSettingsModel 同路径）。
        // effortLevel 为 null（off/auto/default 清除）→ 传 undefined → mergeWith 删除该键；
        // 写盘失败 → 返回 500 暴露（不再静默），也不广播（避免 CLI 内存与磁盘全局态不一致）。
        // 2026-09-18 根修：持久化前过官方边界解析 + toPersistableEffort 守卫。读侧 settings schema
        // 非 ant 只接受 low/medium/high 且是整文件 safeParse（readSettingsFile 失败→settings:null），
        // 此前 'max' 原样落盘 → 下次任何进程读 userSettings 整体校验失败作废（model/permissions 全丢）。
        // 守卫语义与 CLI 持久化同源：'max' 是 session-scoped（非 ant 不落盘）→ 删键 = 重启后跟随模型默认；
        // 运行时仍按下方广播 'max' 实时生效（claude.ts 对 opus-4-6 发 max、其它模型自动降 high）。
        const persistable = toPersistableEffort(parseEffortValue(effortLevel))
        const r = updateSettingsForSource('userSettings', { effortLevel: persistable })
        if (r.error) {
          sendJson(res, 500, { error: `写 settings.json 失败：${r.error.message}` })
          return
        }
      }
      if (model !== undefined) {
        // model 每会话覆盖，精确路由到目标会话；未在线/未连接则拒绝而非广播兜底（2026-08-23 用户定案）
        // provider 一并下发：CLI 进程内绑定该供应商（baseUrl/key），与模型名同源，避免错配
        if (!routeToClient(sessionId, { type: 'model', value: model, provider: modelProvider })) {
          sendJson(res, 400, { error: '目标会话未在线，无法切换模型' })
          return
        }
        // 路由成功即记入启动模型表：用户对该会话的切换意图 = 「此后（含重启后）用它」；
        // CLI 随后的 model-report 上报会以实际生效值校正本条（挂起对在回合边界落地的窗口内
        // 表值先行，进程死在该窗口时表值 = 用户意图，resume 仍按意图恢复）。
        if (sessionId) recordSessionModelLaunch(sessionId, model, modelProvider ?? undefined)
      }
      if (effortLevel !== undefined && sessionId) {
        // 会话级思考等级：与 model 同链精确路由（未在线拒绝，不广播兜底）；落镜像供
        // /gateway/session 回读——进程内存态只在目标会话生效。
        if (!routeToClient(sessionId, { type: 'effort', value: effortLevel })) {
          sendJson(res, 400, { error: '目标会话未在线，无法切换思考等级' })
          return
        }
        sessionEfforts.set(sessionId, { effort: effortLevel, updatedAt: Date.now() })
      }
      sendJson(res, 200, { ok: true, model: model ?? null, effortLevel: effortLevel ?? null })
    } catch (error) {
      sendReportBodyError(res, error)
    }
    return
  }
  // 2026-08-23 web 独立会话（受上方 /gateway/* token 校验保护）：
  //   POST /gateway/wsession {resume?} → 预分配 sid 立即返回 {id,hash}，spawn+注册后台进行（2026-09-06 异步化）；
  //   resume 恢复已有会话同路径。POST /gateway/wsession/stop {id} → 关闭会话（2026-09-08 起 web spawn/终端直开统一 gracefulStopCli：shutdown 优雅退出 + 3s 树杀兜底）
  if (req.method === 'POST' && url.pathname === '/gateway/wsession') {
    try {
      const parsed = await readReportBody(req)
      const resume =
        typeof parsed.resume === 'string' && parsed.resume.trim() ? parsed.resume.trim() : undefined
      // 2026-08-24 指定项目：project = findProjects 命中的项目 label → 会话落该项目 .claude/projects
      const project =
        typeof parsed.project === 'string' && parsed.project.trim() ? parsed.project.trim() : undefined
      // 2026-10-13 待办 12：新建会话可带模型（首页模型选择器 → spawn --model 从启动固化，替代
      // 旧「建会话后 apiSetModel 补投」链——后者在 wsession 异步化后必 miss：POST 立即返回时
      // CLI 尚未注册，routeToClient 恒 400）。校验与 /gateway/model 同源（findModelProvider 池内
      // 全名）。resume 的模型源唯一 = 启动模型表（显式 model 传给 spawnWebSession 仍恒优先，
      // 本端不传），故此处仅新建分支携带。
      let launchModel: string | undefined
      if (typeof parsed.model === 'string' && parsed.model.trim()) {
        const m = parsed.model.trim()
        if (!findModelProvider(m)) {
          sendJson(res, 400, { error: `model "${m}" 不在凭据池任何供应商模型清单中` })
          return
        }
        launchModel = m
      }
      // 2026-09-06 异步化（首条消息单状态根治，用户「可不可以只有一个状态」）：预分配 sid 立即
      // 返回，spawn+注册后台进行——前端瞬时进会话态（乐观气泡直通落盘），消除同步等注册 1-2s 的
      // 「创建中」中间态。spawn 期间到达的 send 经 pendingDeliveries 暂存、CLI 注册钩子补投；
      // 失败/注册超时经 SSE ws-failed 群发（前端清合成条目+回滚首条事务+报错），不留静默。
      const sid = resume ?? randomUUID()
      spawnWebSession(resume, project, sid, launchModel ? { model: launchModel } : undefined).catch((e) => {
        console.error(`[gateway] wsession: 后台启动失败 sid=${sid}`, e)
        pendingDeliveries.delete(sid)
        const s = `data: ${JSON.stringify({ type: 'ws-failed', session: sid, error: e?.message ?? String(e) })}\n\n`
        sendAll(sseClients, (c) => { c.res.write(s) })
      })
      // id = listSessions 同源 base64url（web 会话落盘 <项目根>/.claude/projects；笔=全局根、项目=项目根）；
      // hash = 前端导航/WS 过滤用的会话哈希（= 转录文件名去 .jsonl，即 sessionId）
      // resume 未显式指定项目时按磁盘会话文件定位（与 spawnWebSession effectiveProject 同源）
      let projLabel = project
      if (resume && !projLabel) projLabel = sessionProjectRootOf(resume)?.projectLabel
      const projRoot = webSessionProjectRoot(projLabel)
      const id = Buffer.from(join(projRoot, '.claude', 'projects', `${sid}.jsonl`)).toString('base64url')
      // 2026-09-12 文件占位相对化配套：cwd = 本会话启动根（与 spawnWebSession 的 cwd 同源），
      // 前端首条消息发送前即知会话 cwd，[文件:<相对路径>] 占位按它相对化（新会话 jsonl 落盘前 cwd 不存在）。
      sendJson(res, 200, { id, hash: sid, resumed: !!resume, project: project ?? null, cwd: projRoot })
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/gateway/wsession/stop') {
    try {
      const parsed = await readReportBody(req)
      const id = typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id.trim() : ''
      // 2026-09-04 关闭会话扩展：web 会话（网关 spawn）走 stopWebSession；非 web spawn 的在线
      // 会话（用户终端直开，activity 上报 pid=CLI 进程本体 process.pid）按同协议优雅停——
      // 2026-09-08 起两会话形态统一走 gracefulStopCli（shutdown → CLI exit 0 → WT 自动收 tab；
      // 3s 树杀兜底豁免网关子树，防关宿主会话连坐杀网关），「关闭会话」对任何在线会话都是
      // 两次 Ctrl+C 退出语义，不存在需要回终端手动退的分支。
      let ok = id ? stopWebSession(id) : false
      if (!ok && id) {
        const act = sessionActivity.get(id)
        if (act && act.pid && isPidAlive(act.pid)) {
          gracefulStopCli(id, act.pid)
          sessionActivity.delete(id)
          ok = true
        }
      }
      sendJson(res, 200, { ok })
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 2026-08-24 审批链路诊断（受 token 保护）：返回最近审批轨迹 + 连接概览，用于调试「审批卡不弹」。
  if (req.method === 'GET' && url.pathname === '/gateway/diagnostics') {
    sendJson(res, 200, {
      trail: approvalTrailSnapshot(),
      cliClients: [...cliClients.keys()],
      sockets: sockets.size,
      sseClients: sseClients.size,
      webSessions: [...webSessions.keys()],
    })
    return
  }
  // → 直接复用 CLI /rename 的落盘逻辑（saveCustomTitle + saveAgentName，见命令 rename.ts），
  // 与 CLI 完全同路径：写盘格式含 sessionId（loadTranscriptFile/restoreSessionMetadata 按
  // entry.sessionId 建索引，缺字段会被 resume 跳过 → 旧标题在退出时 re-append 回退 web 列表）；
  // 若目标会话恰好是网关宿主 CLI 的当前会话，还会同步更新 CLI 内存标题缓存。
  // 对已停止的会话同样生效；正在运行的会话下次列表刷新读盘即见新标题。
  if (req.method === 'POST' && url.pathname === '/gateway/session/rename') {
    try {
      const parsed = await readReportBody(req)
      const id = typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id.trim() : ''
      const title = typeof parsed.title === 'string' ? parsed.title.trim() : ''
      if (!id || !title) {
        sendJson(res, 400, { error: 'id 与 title 必填' })
        return
      }
      if (title.length > 200) {
        sendJson(res, 400, { error: '标题过长（最多 200 字符）' })
        return
      }
      const { path: p, uuid } = decodeSessionPath(id, root)
      if (!existsSync(p)) {
        sendJson(res, 404, { error: 'session not found' })
        return
      }
      // 2026-08-25 web 重命名 → CLI 实时同步：目标会话若有 /clients 注册的在线 CLI 进程
      //（web 独立会话窗口 / 终端 CLI），按会话精确路由 rename 事件，CLI 侧更新内存标题缓存
      // + 输入栏徽标（standaloneAgentContext），无需重启即可看到新名字；未命中静默跳过。
      // B2（2026-08-26）route 未命中诊断：补 rename 命中/未命中轨迹到 /gateway/diagnostics，
      // 区分「目标在线已同步缓存」（hit）与「未命中——仅写盘，在线 CLI 缓存未更新，退出可能回退」（miss）。
      // 2026-09-20 落盘+路由成对逻辑抽为 applySessionTitle（session-create 命名共用同一条链）。
      const routed = await applySessionTitle(uuid, title, p)
      approvalTrailPush('rename-routed', uuid, undefined, routed ? 'hit' : 'miss')
      scheduleSseFlush(root) // 立即触发列表刷新，让新标题落进前端列表
      sendJson(res, 200, { ok: true, title })
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 项目元信息：/gateway/project?label=<项目|工作区根> → 文件树 + README + 会话元信息（work 侧栏文件树消费 files）
  // 2026-10-15 待办7：工作区根 = 一个特殊「项目」（统一复用本路由，不留第三态）——label 不再硬判 scope==='project'，
  // findProjects 已含 scope==='global'（label「全局根 · 散装对话」），按唯一 label 命中即服务。pDir 仍用同一条
  // 公式 resolve(dir,'..','..')：项目 = <root>/<label>/.claude/projects → <root>/<label>；工作区根 =
  // <root>/.claude/projects → <root>（即工作区根），无需分支。
  // 2026-08-19 Web 容器：/gateway/backend?label=<项目> → 懒加载 spawn 该项目 preview.json 声明的后端进程，
  // 返回 {url}：本机 iframe 直连；远程宿主由前端改走同源代理 /backend/<label>/（受上方 /gateway/* token 校验保护；后端仅监听 127.0.0.1，访问面可控）。
  if (req.method === 'GET' && url.pathname === '/gateway/backend') {
    const bLabel = (url.searchParams.get('label') || '').trim()
    const bCardId = (url.searchParams.get('card') || '').trim()
    // label 允许项目与全局根（应用卡的服务器同样要能拉起）；是否有 backend 按下面两条支路判
    const bProj = findProjects(root).find((g) => g.label === bLabel && g.hasPreview)
    if (!bProj) {
      sendJson(res, 404, { error: 'no backend for project' })
      return
    }
    const bPreviewDir = previewDirOf(bProj)
    // 带 card = 卡级后端（必须已启用且自己声明了 backend）；不带 card = 项目级 backend（旧链）
    const bCard = bCardId ? findEnabledCardBackend(bPreviewDir, bCardId) : undefined
    if (bCardId && !bCard) {
      sendJson(res, 404, { error: 'no backend for card' })
      return
    }
    const bKey = bCard ? cardBackendKey(bLabel, bCard.id) : bLabel
    const bCfg = bCard ? bCard.cfg : readBackendCfg(bPreviewDir)
    if (!bCfg) {
      sendJson(res, 404, { error: 'no backend for project' })
      return
    }
    try {
      // alreadyRunning：调用前进程已在册且存活（复用/收养，非本次 spawn）→ 前端不渲染「正在启动」覆盖层，iframe 直挂秒开
      const pre = backendProcesses.get(bKey)
      const alreadyRunning = !!(pre && backendProcAlive(pre))
      const proc = await ensureBackend(bKey, bCfg)
      // 同源代理票证：为该浏览器种/续 HttpOnly cookie，开放 /backend/<label>/ 转发通道；
      // 已有票证则追加本 label 并续期（多项目并行预览互不顶掉）。
      sweepBpSessions()
      const ckJar = parseCookieHeader(req.headers.cookie)
      let ckKey = ckJar[BP_COOKIE_NAME]
      let bpSess = ckKey && BP_COOKIE_KEY_RE.test(ckKey) ? bpSessions.get(ckKey) : undefined
      if (!bpSess) {
        ckKey = randomBytes(16).toString('hex')
        bpSess = { labels: new Set<string>(), expires: 0 }
        bpSessions.set(ckKey, bpSess)
      }
      bpSess.labels.add(bLabel)
      bpSess.expires = Date.now() + BP_COOKIE_TTL_MS
      res.setHeader('Set-Cookie', `${BP_COOKIE_NAME}=${ckKey}; Path=/backend; HttpOnly; SameSite=Lax; Max-Age=86400`)
      // name：overlay 提示用（preview.json backend.name 或项目 label），前端据此显示「正在启动 <name>…」，可插拔
      sendJson(res, 200, { url: `http://127.0.0.1:${proc.port}/`, port: proc.port, pid: proc.pid, name: proc.cfg.name || (bCard ? bCard.id : bLabel), alreadyRunning })
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  if (req.method === 'GET' && url.pathname === '/gateway/project') {
    const pLabel = url.searchParams.get('label') || ''
    const pProj = findProjects(root).find((g) => g.label === pLabel)
    if (!pProj) {
      sendJson(res, 404, { error: 'project not found' })
      return
    }
    try {
      const pDir = resolve(pProj.dir, '..', '..') // pProj.dir = <root>/<label>/.claude/projects（工作区根 = <root>/.claude/projects）→ 上两级即项目根/工作区根
      const budget = { n: TREE_BUDGET }
      const files = walkProjectTree(pDir, budget) ?? []
      const readme = findProjectReadme(pDir)
      const list = await listSessions(root)
      const pSessions = (list.sessions as Array<Record<string, unknown>>)
        .filter((s) => s.projectScope === pProj.scope && s.projectLabel === pLabel)
        .map((s) => ({
          hash: String(s.file).replace(/\.jsonl$/, ''),
          id: s.id,
          title: s.title,
          messageCount: s.messageCount,
          updatedAt: s.updatedAt,
        }))
        .slice(0, 100)
      sendJson(res, 200, {
        label: pLabel,
        scope: pProj.scope,
        hasPreview: pProj.hasPreview,
        description: deriveProjectDescription(readme, pLabel),
        files,
        readme,
        sessionCount: pSessions.length,
        sessions: pSessions,
        lastActive: pSessions.length ? (pSessions[0].updatedAt as number) : 0,
      })
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 预览申报表：/gateway/preview-cards?label=<项目|全局根> → { label, cards:[…], quoteActions:[…] }
  // （卡片化二期 + 2026-09-28；2026-10-10 起含全局根）preview.json 的 cards / quoteActions 声明；
  // label 必须命中 findProjects（项目名或「全局根 · 散装对话」）且该项目有 .claude/preview → 否则 404，
  // 命中但无声明 → 各自空数组。一次请求取两份申报（消费点 = preview-card.syncExtCards / 全局插件拉取）。
  if (req.method === 'GET' && url.pathname === '/gateway/preview-cards') {
    const cLabel = url.searchParams.get('label') || ''
    // 项目 label 与全局根 label 不重叠，故只按 label 命中判；hasPreview 已含全局根（findProjects）——
    // 无 .claude/preview 一律 404，不猜不兜底。
    const cProj = findProjects(root).find((g) => g.label === cLabel)
    if (!cProj || !cProj.hasPreview) {
      sendJson(res, 404, { error: 'project not found' })
      return
    }
    try {
      // dir = <root>/<label>/.claude/projects（项目）或 <root>/.claude/projects（全局根），
      // 两者 `..` 再配 preview 均为各自的 .claude/preview。
      const cDir = resolve(cProj.dir, '..', 'preview')
      sendJson(res, 200, {
        label: cLabel,
        cards: readPreviewCards(cDir).map(publicPreviewCard),
        quoteActions: readPreviewQuoteActions(cDir),
        previewCards: readPreviewPaneCards(cDir).map(publicPreviewCard),
        // 传统单页预览（.claude/preview/index.html）：与「有卡」并列决定预览页签是否出现；
        // 启用态载体 = <preview>/.disabled（与应用卡同一判据，管理页可启停）。
        hasIndex: existsSync(join(cDir, 'index.html')),
        indexEnabled: !existsSync(join(cDir, CUSTOMIZATION_DISABLED_MARKER)),
      })
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 上游版本：GET /gateway/repo-version?repo=<GitHub 仓库地址> → { version, source, error? }
  if (req.method === 'GET' && url.pathname === '/gateway/repo-version') {
    const repoUrl = (url.searchParams.get('repo') || '').trim()
    const g = parseGithubRepo(repoUrl)
    if (!g) {
      sendJson(res, 400, { error: '仅支持 https://github.com/<owner>/<repo>' })
      return
    }
    const key = `${g.owner}/${g.repo}`.toLowerCase()
    const hit = repoVersionCache.get(key)
    const ttl = hit && hit.version ? REPO_VERSION_TTL_MS : REPO_VERSION_ERR_TTL_MS
    if (hit && Date.now() - hit.at < ttl) {
      sendJson(res, 200, { version: hit.version, source: hit.source, error: hit.error })
      return
    }
    const entry = await probeRepoVersion(g)
    repoVersionCache.set(key, entry)
    sendJson(res, 200, { version: entry.version, source: entry.source, error: entry.error })
    return
  }
  // 上游 README：GET /gateway/repo-readme?repo=<GitHub 仓库地址> → { name, text, error? }
  if (req.method === 'GET' && url.pathname === '/gateway/repo-readme') {
    const repoUrl = (url.searchParams.get('repo') || '').trim()
    const g = parseGithubRepo(repoUrl)
    if (!g) {
      sendJson(res, 400, { error: '仅支持 https://github.com/<owner>/<repo>' })
      return
    }
    // path = 仓库内子目录（市场 git-subdir / 市场自带条目），只允许相对路径。
    const sub = (url.searchParams.get('path') || '').trim().replace(/^\/+|\/+$/g, '')
    if (sub && (sub.includes('..') || sub.includes('\\'))) {
      sendJson(res, 400, { error: '非法的子目录' })
      return
    }
    const key = `${g.owner}/${g.repo}/${sub}`.toLowerCase()
    const hit = repoReadmeCache.get(key)
    const ttl = hit && hit.text ? REPO_README_TTL_MS : REPO_VERSION_ERR_TTL_MS
    if (hit && Date.now() - hit.at < ttl) {
      sendJson(res, 200, { name: hit.name, text: hit.text, error: hit.error })
      return
    }
    const entry = await probeRepoReadme(g, sub)
    repoReadmeCache.set(key, entry)
    sendJson(res, 200, { name: entry.name, text: entry.text, error: entry.error })
    return
  }
  // 卡片/应用启停（2026-11-07 定案）：POST /gateway/preview-cards/enable {label, card, enabled}
  // 状态载体 = 目录内 .disabled 标记（与插件/技能同一判据 isCustomizationDirEnabled，网关可读 ⇒
  // 开机自动拉起与工具栏显示都能按它决策）。card = pane 卡目录名，或 preview.json 应用卡 id
  // （后者落到 <path 首段> 目录）。停用卡仍在清单里返回（管理页要能重新启用），只是 enabled=false。
  if (req.method === 'POST' && url.pathname === '/gateway/preview-cards/enable') {
    try {
      let evBody: unknown
      try {
        evBody = JSON.parse((await readBodyWithLimit(req, 64 * 1024)).toString('utf8') || '{}')
      } catch (e) {
        if (e instanceof ReportBodyTooLargeError) {
          sendJson(res, 413, { error: 'too large' })
          return
        }
        throw e
      }
      if (evBody === null || typeof evBody !== 'object' || Array.isArray(evBody)) {
        sendJson(res, 400, { error: 'invalid body' })
        return
      }
      const ev = evBody as Record<string, unknown>
      const evLabel = typeof ev.label === 'string' ? ev.label.trim() : ''
      const evCard = typeof ev.card === 'string' ? ev.card.trim() : ''
      const evEnabled = ev.enabled !== false
      if (!evLabel || !evCard) {
        sendJson(res, 400, { error: 'label/card 必填' })
        return
      }
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(evCard)) {
        sendJson(res, 400, { error: 'card 非法' })
        return
      }
      const evProj = findProjects(root).find((g) => g.label === evLabel && g.hasPreview)
      if (!evProj) {
        sendJson(res, 404, { error: 'project not found' })
        return
      }
      const evPreview = previewDirOf(evProj)
      // 定位卡目录：传统单页预览 = preview 根（保留 id）；pane 卡 = <preview>/<card>；
      // 应用卡 = <preview>/<path 首段>
      let evDir = ''
      if (evCard === PREVIEW_INDEX_CARD_ID) {
        if (!existsSync(join(evPreview, 'index.html'))) {
          sendJson(res, 404, { error: 'card not found' })
          return
        }
        evDir = evPreview
      } else if (readPreviewPaneCards(evPreview).some((c) => c.id === evCard)) {
        evDir = join(evPreview, evCard)
      } else {
        const app = readPreviewCards(evPreview).find((c) => c.id === evCard)
        const first = app ? (app.path.split('#')[0] || '').split('/')[0] : ''
        if (first) evDir = join(evPreview, first)
      }
      const evTarget = evDir ? resolve(evDir) : ''
      if (!evTarget || !isDir(evTarget) || (evTarget !== evPreview && !evTarget.startsWith(evPreview + sep))) {
        sendJson(res, 404, { error: 'card not found' })
        return
      }
      const evMarker = join(evTarget, CUSTOMIZATION_DISABLED_MARKER)
      if (evEnabled) {
        if (existsSync(evMarker)) unlinkSync(evMarker)
      } else if (!existsSync(evMarker)) {
        writeFileSync(evMarker, '')
      }
      sendJson(res, 200, { ok: true, label: evLabel, card: evCard, enabled: evEnabled })
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 卡片公开 API · 只读能力表：GET /gateway/cards → 当前在线浏览器上报的全部帧能力表（agent 据此决定
  // 调哪张卡：instanceId 最精确，或按 label/ns 寻址）。devices = 上报过能力表的浏览器连接数（一台设备
  // 一条 /ws）；每条卡带 device（?device= 自报类型）便于同 ns 多机时自己分辨。
  if (req.method === 'GET' && url.pathname === '/gateway/cards') {
    sendJson(res, 200, { devices: cardHolders.size, cards: listAllCaps() })
    return
  }
  // 卡片公开 API · agent 驱动卡：POST /gateway/card-call {label?,ns?,instanceId?,cmd,args?,timeoutMs?}
  // → 挑一台持卡设备下行 → 前端总线翻成卡的 `<ns>-cmd` → ack 原路回来。
  // 状态语义：无浏览器在线 503；有浏览器但目标卡不在场 409（附当场能力表，agent 可直接改地址重试）；
  // 卡超时 / 持卡设备中途断开 504。**卡自己回 ok:false 是 HTTP 200**（「未注册的命令 x」是卡给的
  // 正常答复，不是传输错误——把两者混成 4xx/5xx 会让 agent 误以为链路坏了而反复重试）。
  if (req.method === 'POST' && url.pathname === '/gateway/card-call') {
    let cc: Record<string, unknown>
    try {
      cc = await readReportBody(req)
    } catch (e) {
      sendReportBodyError(res, e)
      return
    }
    const ccCmd = typeof cc.cmd === 'string' ? cc.cmd.trim() : ''
    if (!ccCmd) {
      sendJson(res, 400, { error: 'missing cmd' })
      return
    }
    // 整卡显隐 · card:open（打开项目预览卡，2026-10-13）：对象（未显示的卡）不在能力表、不可帧寻址
    // ——按 args.label 寻址、选「最近上报」的持卡设备执行（不查能力表、绝不广播）。真值表差异：
    // card:open 不走 409（目标本就常不在场）；无持卡设备按 503。
    if (ccCmd === 'card:open') {
      const coArgs = cc.args && typeof cc.args === 'object' ? (cc.args as Record<string, unknown>) : {}
      const coLabel = typeof coArgs.label === 'string' ? coArgs.label.trim() : ''
      if (!coLabel) {
        sendJson(res, 400, { error: 'card:open 需要 args.label（项目 label）' })
        return
      }
      if (!sockets.size) {
        sendJson(res, 503, { error: '当前无浏览器在线，卡片命令无处可达' })
        return
      }
      const coHit = pickLatestHolder()
      if (!coHit) {
        sendJson(res, 503, { error: '在线浏览器均未上报卡片能力表，无法执行整卡显隐' })
        return
      }
      const coTimeout = Math.max(500, Math.min(Number.isFinite(cc.timeoutMs) ? Number(cc.timeoutMs) : 8000, 60000))
      const coOut = await callBrowserCard(coHit.ws, { label: coLabel }, ccCmd, { label: coLabel }, coTimeout)
      const coWhere = { instanceId: coHit.cap.instanceId, label: coHit.cap.label, ns: coHit.cap.ns }
      if (coOut.kind === 'ok') sendJson(res, 200, { ok: true, result: coOut.result, card: coWhere })
      else if (coOut.kind === 'err') sendJson(res, 200, { ok: false, error: coOut.error, card: coWhere })
      else if (coOut.kind === 'timeout') sendJson(res, 504, { error: `卡片命令超时（${coTimeout}ms）：${ccCmd}`, card: coWhere })
      else sendJson(res, 504, { error: '持卡设备已断开', card: coWhere })
      return
    }
    const ccTarget = {
      label: typeof cc.label === 'string' ? cc.label : '',
      ns: typeof cc.ns === 'string' ? cc.ns : '',
      instanceId: typeof cc.instanceId === 'string' ? cc.instanceId : '',
    }
    if (!ccTarget.label && !ccTarget.ns && !ccTarget.instanceId) {
      sendJson(res, 400, { error: 'missing target (label / ns / instanceId 至少其一)' })
      return
    }
    if (!sockets.size) {
      sendJson(res, 503, { error: '当前无浏览器在线，卡片命令无处可达' })
      return
    }
    const ccHit = pickCardHolder(ccTarget)
    if (!ccHit) {
      sendJson(res, 409, { error: '目标卡不在场', target: ccTarget, cards: listAllCaps() })
      return
    }
    const ccTimeout = Math.max(500, Math.min(Number.isFinite(cc.timeoutMs) ? Number(cc.timeoutMs) : 8000, 60000))
    const ccOut = await callBrowserCard(ccHit.ws, ccTarget, ccCmd, cc.args ?? {}, ccTimeout)
    const ccWhere = { instanceId: ccHit.cap.instanceId, label: ccHit.cap.label, ns: ccHit.cap.ns }
    if (ccOut.kind === 'ok') sendJson(res, 200, { ok: true, result: ccOut.result, card: ccWhere })
    else if (ccOut.kind === 'err') sendJson(res, 200, { ok: false, error: ccOut.error, card: ccWhere })
    else if (ccOut.kind === 'timeout') sendJson(res, 504, { error: `卡片命令超时（${ccTimeout}ms）：${ccCmd}`, card: ccWhere })
    else sendJson(res, 504, { error: '持卡设备已断开', card: ccWhere })
    return
  }
  // 文件内容读取：/gateway/file?label=<会话 label>&path=<相对路径> → 原始字节
  // （供个性化预览页识图渲染 Obsidian canvas / 加载图片音频视频 / 会话消息里 AI 生成图取图）。
  // label 不做 scope 筛选：项目会话 label=<项目名>（fDir=项目根），全局根会话 label=「全局根 · 散装对话」
  // （fDir=工作区根）——两者标签空间不重叠（项目 label 是目录名，不含 `·`）。受上方 /gateway/* token 校验保护。
  // GET 取原文；HEAD 只回 ETag（= mtimeMs）供 work 编辑卡做 0.5s 外部变更探测——HEAD 不读盘，
  // 只 stat，避免轮询把整个文件反复搬进内存。鉴权/越界/404/413 与 GET 同一口径。
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/gateway/file') {
    const fLabel = url.searchParams.get('label') || ''
    const fPath = url.searchParams.get('path') || ''
    // dl=1 = 浏览器下载语义（work 文件树「下载」）：不套 4MB 预览上限、回 Content-Disposition
    // attachment、GET 走流式管道（不把整文件读进内存）。4MB 口径只守护「预览/识图/编辑」读取，
    // 下载是要把用户自己的文件取走，不属于该上限的守护对象；确认门（过大先确认）在前端做。
    const fDl = url.searchParams.get('dl') === '1'
    // label 缺省 = 读工作区根散装文件（2026-10-14 待办 9：work 侧栏「工作区」tab 点开全局文件）。
    // 根直读仅限 label 缺省；另拒顶层隐藏段（.claude/.trash 等，防摸 token/凭据），其余走同一条防越界与 4MB 口径。
    let fDir: string
    const fProj = findProjects(root).find((g) => g.label === fLabel)
    if (fProj) {
      fDir = resolve(fProj.dir, '..', '..') // 项目根（fProj.dir = <root>/<label>/.claude/projects）
    } else if (!fLabel) {
      if ((fPath.split(/[\\/]/)[0] || '').startsWith('.')) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      fDir = root
    } else {
      sendJson(res, 404, { error: 'project not found' })
      return
    }
    const fAbs = resolve(fDir, fPath)
    if (fAbs !== fDir && !fAbs.startsWith(fDir + sep)) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }
    if (!existsSync(fAbs) || !statSync(fAbs).isFile()) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    const fStat = statSync(fAbs)
    if (!fDl && fStat.size > 4 * 1024 * 1024) {
      sendJson(res, 413, { error: 'too large' })
      return
    }
    const fMtime = fStat.mtimeMs
    // ETag = 毫秒级 mtime（Last-Modified 只有秒级、不足以表达同一秒内的两次写）；work 编辑区记它作
    // 冲突基线，写回时带回由 writeProjectFile 精确比对（见该函数）。
    const fHeaders: Record<string, string> = {
      'Cache-Control': 'no-cache',
      ETag: `"${fMtime}"`,
      'Last-Modified': new Date(fMtime).toUTCString(),
    }
    if (fDl) {
      // 文件名双写：filename=ASCII 回退（非 ASCII/引号/反斜杠统一换成 _），
      // filename*=RFC 5987 UTF-8 原文——浏览器优先取后者，中文名不乱码。
      const fName = basename(fAbs)
      const fAscii = fName.replace(/[^\x20-\x7e]|["\\]/g, '_')
      const fEnc = encodeURIComponent(fName).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
      fHeaders['Content-Length'] = String(fStat.size)
      fHeaders['Content-Disposition'] = `attachment; filename="${fAscii}"; filename*=UTF-8''${fEnc}`
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, fHeaders)
      res.end()
      return
    }
    if (fDl) {
      res.writeHead(200, { ...fHeaders, 'Content-Type': 'application/octet-stream' })
      const fStream = createReadStream(fAbs)
      fStream.on('error', () => res.destroy())
      fStream.pipe(res)
      return
    }
    const fBuf = readFileSync(fAbs)
    const fType = MIME[extname(fAbs)] ?? (sniffBinary(fBuf) ? 'application/octet-stream' : 'text/plain; charset=utf-8')
    res.writeHead(200, { ...fHeaders, 'Content-Type': fType })
    res.end(fBuf)
    return
  }
  // 项目内文件 / 目录重命名：POST /gateway/file/rename {label, path, name} → 同目录改名（2026-09-27）
  // 语义与防护全在 renameProjectEntry（纯函数，探针 probe-file-tree-ops 直测）；此处只管解析 label。
  // 穿越防护口径同 GET /gateway/file（resolveWithinRoot）。受上方 /gateway/* token 校验保护。
  // label 唯一命中（含工作区根「全局根 · 散装对话」）——工作区根 = 一等公民项目，写链同口径放行。
  if (req.method === 'POST' && url.pathname === '/gateway/file/rename') {
    try {
      const rp = await readReportBody(req)
      const rProj = findProjects(root).find((g) => g.label === (typeof rp.label === 'string' ? rp.label : ''))
      if (!rProj) {
        sendJson(res, 404, { error: 'project not found' })
        return
      }
      const rOut = renameProjectEntry(
        resolve(rProj.dir, '..', '..'),
        typeof rp.path === 'string' ? rp.path : '',
        typeof rp.name === 'string' ? rp.name : '',
      )
      if (!rOut.ok) sendJson(res, rOut.code, { error: rOut.error })
      else sendJson(res, 200, rOut)
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 项目内文件 / 目录移动（拖拽放入文件夹，2026-10-14 待办 10）：POST /gateway/file/move
  // {label, path, dir} → basename 不变、整体搬到 dir（'' = 项目根）。语义与防护全在 moveProjectEntry
  // （纯函数）；此处只管解析 label（label 唯一命中，含工作区根）。受上方 /gateway/* token 校验保护。
  if (req.method === 'POST' && url.pathname === '/gateway/file/move') {
    try {
      const mp = await readReportBody(req)
      const mProj = findProjects(root).find((g) => g.label === (typeof mp.label === 'string' ? mp.label : ''))
      if (!mProj) {
        sendJson(res, 404, { error: 'project not found' })
        return
      }
      const mOut = moveProjectEntry(
        resolve(mProj.dir, '..', '..'),
        typeof mp.path === 'string' ? mp.path : '',
        typeof mp.dir === 'string' ? mp.dir : '',
      )
      if (!mOut.ok) sendJson(res, mOut.code, { error: mOut.error })
      else sendJson(res, 200, mOut)
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 项目内已存在文件写内容：POST /gateway/file/write {label, path, content, baseMtime?}（2026-10-05 work 编辑区）
  // 语义与防护全在 writeProjectFile（纯函数，探针 probe-file-tree-ops 直测）；此处只管解析 label（label
  // 唯一命中，含工作区根）与 body 上限。
  // body 用 4 MB 上限（readReportBody 的 1 MB 容不下源码文件），超限 → 413。受上方 /gateway/* token 校验保护。
  if (req.method === 'POST' && url.pathname === '/gateway/file/write') {
    try {
      let wBody: unknown
      try {
        wBody = JSON.parse((await readBodyWithLimit(req, MAX_FILE_WRITE_BYTES)).toString('utf8') || '{}')
      } catch (e) {
        if (e instanceof ReportBodyTooLargeError) {
          sendJson(res, 413, { error: 'too large' })
          return
        }
        throw e
      }
      if (wBody === null || typeof wBody !== 'object' || Array.isArray(wBody)) {
        sendJson(res, 400, { error: 'invalid body' })
        return
      }
      const wp = wBody as Record<string, unknown>
      // 可选 web 会话 sid（归因用）：只做字符集/长度校验，非法 → 400 不静默丢弃。
      let wsid: string | undefined
      if (wp.sid !== undefined && wp.sid !== null && wp.sid !== '') {
        if (typeof wp.sid !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(wp.sid)) {
          sendJson(res, 400, { error: 'invalid sid' })
          return
        }
        wsid = wp.sid
      }
      const wProj = findProjects(root).find((g) => g.label === (typeof wp.label === 'string' ? wp.label : ''))
      if (!wProj) {
        sendJson(res, 404, { error: 'project not found' })
        return
      }
      const wOut = writeProjectFile(
        resolve(wProj.dir, '..', '..'),
        typeof wp.path === 'string' ? wp.path : '',
        typeof wp.content === 'string' ? wp.content : '',
        typeof wp.baseMtime === 'number' ? wp.baseMtime : undefined,
        { writer: 'web', sid: wsid },
      )
      if (!wOut.ok) sendJson(res, wOut.code, { error: wOut.error })
      else sendJson(res, 200, wOut)
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 项目内评论批注：GET /gateway/comments?label= → {comments:[...]}；
  // POST /gateway/comments {label, comments:[...]} → 全量替换（2026-10-06 work 评论功能）。
  // 存储 <项目根>/.claude/comments.json，读写语义全在 read/writeProjectComments（纯函数，探针直测）。
  // 只认 scope==='project'（评论属项目，不落全局根散装区）。受上方 /gateway/* token 校验保护。
  if (req.method === 'GET' && url.pathname === '/gateway/comments') {
    const cLabel = url.searchParams.get('label') || ''
    const cProj = findProjects(root).find((g) => g.scope === 'project' && g.label === cLabel)
    if (!cProj) {
      sendJson(res, 404, { error: 'project not found' })
      return
    }
    sendJson(res, 200, { comments: readProjectComments(resolve(cProj.dir, '..', '..')) })
    return
  }
  if (req.method === 'POST' && url.pathname === '/gateway/comments') {
    try {
      const cb = await readReportBody(req)
      const cProj = findProjects(root).find(
        (g) => g.scope === 'project' && g.label === (typeof cb.label === 'string' ? cb.label : ''),
      )
      if (!cProj) {
        sendJson(res, 404, { error: 'project not found' })
        return
      }
      const cOut = writeProjectComments(
        resolve(cProj.dir, '..', '..'),
        Array.isArray(cb.comments) ? cb.comments : [],
      )
      if (!cOut.ok) sendJson(res, cOut.code, { error: cOut.error })
      else sendJson(res, 200, cOut)
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 项目归档：POST /gateway/project/archive {label} → 打包 .achrives/<label>-<ts>.tar.gz + 原目录进 .trash/
  // （2026-11-06 work 项目行菜单长按/右键）。只认 findProjects 里 scope==='project' 的真项目。
  // 大项目打包是分钟级同步等待：前端已 toast 告知「正在归档」，本请求即完成信号。
  if (req.method === 'POST' && url.pathname === '/gateway/project/archive') {
    try {
      const ap = await readReportBody(req)
      const aLabel = typeof ap.label === 'string' ? ap.label : ''
      if (!findProjects(root).some((g) => g.scope === 'project' && g.label === aLabel)) {
        sendJson(res, 404, { error: 'project not found' })
        return
      }
      const aOut = await archiveProject(root, aLabel)
      if (!aOut.ok) sendJson(res, aOut.code, { error: aOut.error })
      else sendJson(res, 200, aOut)
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 临时项目删除：POST /gateway/project/delete {label} → 移入 .trash/（仅根级时间戳任务区，2026-11-06）
  if (req.method === 'POST' && url.pathname === '/gateway/project/delete') {
    try {
      const dpj = await readReportBody(req)
      const dLabel = typeof dpj.label === 'string' ? dpj.label : ''
      if (!findProjects(root).some((g) => g.scope === 'project' && g.label === dLabel)) {
        sendJson(res, 404, { error: 'project not found' })
        return
      }
      const dOut = deleteTempProject(root, dLabel)
      if (!dOut.ok) sendJson(res, dOut.code, { error: dOut.error })
      else sendJson(res, 200, dOut)
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 项目重命名：POST /gateway/project/rename {label, name} → <root>/<label> 整目录改名（2026-11-07）
  if (req.method === 'POST' && url.pathname === '/gateway/project/rename') {
    try {
      const rpj = await readReportBody(req)
      const rLabel = typeof rpj.label === 'string' ? rpj.label : ''
      const rName = typeof rpj.name === 'string' ? rpj.name : ''
      if (!findProjects(root).some((g) => g.scope === 'project' && g.label === rLabel)) {
        sendJson(res, 404, { error: 'project not found' })
        return
      }
      const rOut = renameProjectDir(root, rLabel, rName)
      if (!rOut.ok) sendJson(res, rOut.code, { error: rOut.error })
      else {
        ensureSseWatches(root) // 旧 watcher 已随改名关闭，按新目录布局补齐
        sendJson(res, 200, rOut)
      }
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 项目内目录归档：POST /gateway/file/archive {label, path} → <项目根>/.achrives/<名>-<ts>.tar.gz
  // + 原目录移入 <项目根>/.trash/（2026-11-07 work 文件树目录行菜单）。语义同项目归档，作用对象是子树。
  if (req.method === 'POST' && url.pathname === '/gateway/file/archive') {
    try {
      const ap2 = await readReportBody(req)
      const aProj = findProjects(root).find((g) => g.label === (typeof ap2.label === 'string' ? ap2.label : ''))
      if (!aProj) {
        sendJson(res, 404, { error: 'project not found' })
        return
      }
      const aOut2 = await archiveProjectEntry(resolve(aProj.dir, '..', '..'), typeof ap2.path === 'string' ? ap2.path : '')
      if (!aOut2.ok) sendJson(res, aOut2.code, { error: aOut2.error })
      else sendJson(res, 200, aOut2)
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 项目内文件 / 目录删除：POST /gateway/file/delete {label, path} → 移入项目根 .trash/（2026-09-27）
  // 「删除」= 移动（工作区规范：禁止 rm），语义与冲突命名全在 trashProjectEntry（纯函数，同上探针直测）。
  // label 唯一命中（含工作区根）；<项目根>/.trash/ 对工作区根即 <root>/.trash/。
  if (req.method === 'POST' && url.pathname === '/gateway/file/delete') {
    try {
      const dp = await readReportBody(req)
      const dProj = findProjects(root).find((g) => g.label === (typeof dp.label === 'string' ? dp.label : ''))
      if (!dProj) {
        sendJson(res, 404, { error: 'project not found' })
        return
      }
      const dOut = trashProjectEntry(resolve(dProj.dir, '..', '..'), typeof dp.path === 'string' ? dp.path : '')
      if (!dOut.ok) sendJson(res, dOut.code, { error: dOut.error })
      else sendJson(res, 200, dOut)
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 在系统资源管理器中定位：POST /gateway/file/reveal {label, path}（2026-10-24 work 文件树行菜单）
  // 文件 → `explorer /select,<abs>`（在父目录里选中该文件）；目录 → `explorer <abs>`（直接打开）。
  // 网关进程跑在用户本机，打开的即用户桌面；越界 / 不存在同 /gateway/file 口径（resolveWithinRoot）。
  // explorer 成功时也常回非 0 退出码，故 detached 拉起、不取退出码，也不等它结束。
  if (req.method === 'POST' && url.pathname === '/gateway/file/reveal') {
    const tRevealIn = Date.now()
    try {
      const vp = await readReportBody(req)
      const vProj = findProjects(root).find((g) => g.label === (typeof vp.label === 'string' ? vp.label : ''))
      if (!vProj) {
        sendJson(res, 404, { error: 'project not found' })
        return
      }
      if (process.platform !== 'win32') {
        sendJson(res, 501, { error: 'unsupported platform' })
        return
      }
      const vAbs = resolveWithinRoot(resolve(vProj.dir, '..', '..'), typeof vp.path === 'string' ? vp.path : '')
      if (!vAbs || !existsSync(vAbs)) {
        sendJson(res, vAbs ? 404 : 403, { error: vAbs ? 'not found' : 'forbidden' })
        return
      }
      const isDir = statSync(vAbs).isDirectory()
      console.log(`[gateway] 资源管理器定位 ${vProj.label} → ${vAbs}（${isDir ? '目录' : '文件'} · 请求到发起 ${Date.now() - tRevealIn}ms）`)
      revealInExplorer(vAbs, isDir)
      sendJson(res, 200, { ok: true })
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 项目内新建文件 / 目录：POST /gateway/file/create {label, path, name, dir}（2026-10-13 work 侧栏
  // 「创建文件 / 文件夹」）。语义与防护全在 createProjectEntry（纯函数，探针 probe-file-create 直测）；
  // 此处只管解析 label（label 唯一命中，含工作区根）。path = 落点目录（'' = 项目根）。
  // 受上方 /gateway/* token 校验保护。
  if (req.method === 'POST' && url.pathname === '/gateway/file/create') {
    try {
      const cp = await readReportBody(req)
      const cProj = findProjects(root).find((g) => g.label === (typeof cp.label === 'string' ? cp.label : ''))
      if (!cProj) {
        sendJson(res, 404, { error: 'project not found' })
        return
      }
      const cOut = createProjectEntry(
        resolve(cProj.dir, '..', '..'),
        typeof cp.path === 'string' ? cp.path : '',
        typeof cp.name === 'string' ? cp.name : '',
        cp.dir === true,
      )
      if (!cOut.ok) sendJson(res, cOut.code, { error: cOut.error })
      else sendJson(res, 200, cOut)
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 项目内上传文件：POST /gateway/file/upload?label=&path=<落点目录>&name=<文件名>，body=原始字节
  // （2026-10-13 work 侧栏「上传文件 / 文件夹」）。语义与防护全在 uploadProjectFile（纯函数，
  // probe-file-create 直测）：同名 -1/-2 序号避让（storeUploadFile 口径）、落点目录 recursive
  // 创建（承载「上传文件夹」的子目录结构）、越界 403、单文件上限 20 MB（对齐 /gateway/upload）。
  // label 唯一命中（含工作区根）。受上方 /gateway/* token 校验保护。
  if (req.method === 'POST' && url.pathname === '/gateway/file/upload') {
    try {
      const upLabel = url.searchParams.get('label') || ''
      const uProj = findProjects(root).find((g) => g.label === upLabel)
      if (!uProj) {
        sendJson(res, 404, { error: 'project not found' })
        return
      }
      let uBuf: Buffer
      try {
        uBuf = await readBodyWithLimit(req, 20 * 1024 * 1024)
      } catch (e) {
        if (e instanceof ReportBodyTooLargeError) {
          sendReportBodyError(res, e)
          return
        }
        throw e
      }
      const uOut = uploadProjectFile(
        resolve(uProj.dir, '..', '..'),
        url.searchParams.get('path') || '',
        url.searchParams.get('name') || '',
        uBuf,
      )
      if (!uOut.ok) sendJson(res, uOut.code, { error: uOut.error })
      else sendJson(res, 200, uOut)
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 工作区根单层列目录（@ 提及「目录 / 文件」能力的数据源，2026-09-26）：
  //   GET /gateway/fs?path=<相对工作区根的可选子路径> → { path, entries:[{name,type,mtime}] }
  // path 缺省/空串 = 工作区根。相对路径基准恒为工作区根——与 @ chip 上行的 [@目录:]/[@文件:] 同基准。
  // 只读单层，复用 listOneLevel（跳过隐藏项与 .git/node_modules/.claude 等重型目录、目录在前、单层不设上限）
  // ——与 /gateway/project 的文件树同一套裁剪口径，不另立一份排除表。
  // mtime = 文件/目录最后修改时间（ms），供 @/+ 弹窗「按时间混排」使用；stat 失败则省略该字段（排序时按 0 处理）。
  // 路径穿越防护同 /gateway/file（resolve 后必须仍在工作区根内）。受上方 /gateway/* token 校验保护。
  if (req.method === 'GET' && url.pathname === '/gateway/fs') {
    const qPath = (url.searchParams.get('path') || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
    const qAbs = resolveWithinRoot(root, qPath)
    if (!qAbs) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }
    let qIsDir = false
    try {
      qIsDir = statSync(qAbs).isDirectory()
    } catch {
      qIsDir = false
    }
    if (!qIsDir) {
      sendJson(res, 404, { error: 'not a directory' })
      return
    }
    const entries = listOneLevel(qAbs).map((e) => {
      try {
        return { ...e, mtime: statSync(join(qAbs, e.name)).mtimeMs }
      } catch {
        return e
      }
    })
    sendJson(res, 200, { path: qPath, entries })
    return
  }

  // 统一上传端点：POST /gateway/upload?sid=&project=&workFile=&kind=image|file&slot=&name=
  // body = 原始字节（上限 20 MB）。上传服务只负责收字节/命名/落盘/鉴权；落点目录与正文引用由槽位决定
  // （resolveUploadSlot：显式 slot → 项目 .claude/file-upload.json → 内置 document-markdown → 内置 session）。
  //   · name = 原始文件名；时间戳与 -1/-2 序号全部由网关加（前端不再拼命名规则）。
  //   · sid 两种形态：完整 base64url(jsonl 路径) 或 web 路由 hash（裸 <uuid>）；给了但解析不到 → 400。
  //   · project 必须是 findProjects 命中的 label（含全局根），否则 404。
  //   · workFile 必须是项目内已存在文件（越界 403 / 不存在 400）；document 槽位缺它 → 400（除非槽位声明 fallback=session）。
  //   · 响应恒含 slot/scope/originalName/name/storedPath/relativePath/reference/url/size/fallback，
  //     session 作用域 reference 恒为 ""；不返回任何绝对文件系统路径。
  if (req.method === 'POST' && url.pathname === '/gateway/upload') {
    try {
      const uSid = (url.searchParams.get('sid') || '').trim()
      const uProject = (url.searchParams.get('project') || '').trim()
      const uWorkFile = (url.searchParams.get('workFile') || '').trim()
      const uKindRaw = (url.searchParams.get('kind') || '').trim()
      if (uKindRaw && uKindRaw !== 'image' && uKindRaw !== 'file') {
        sendJson(res, 400, { error: 'invalid kind' })
        return
      }
      const uKind: UploadKind = uKindRaw === 'image' ? 'image' : 'file'
      const uOriginalName = sanitizeEntryName(url.searchParams.get('name') || '') || 'file'
      const uStoredName = stampUploadName(uOriginalName)
      let uProjRoot = root
      if (uProject) {
        const g = findProjects(root).find((x) => x.label === uProject)
        if (!g) {
          sendJson(res, 404, { error: 'project not found' })
          return
        }
        uProjRoot = resolve(g.dir, '..', '..')
      }
      // sid 显式给了就必须能解析（不静默降级到 project/网关根）
      let uSess: { root: string; dirKey: string } | null = null
      if (uSid) {
        uSess = resolveUploadSession(uSid, root)
        if (!uSess) {
          sendJson(res, 400, { error: 'invalid sid' })
          return
        }
      }
      // workFile 越界 / 不存在在校验槽位之前拦下（它是槽位匹配判据与 document 落点基准）
      if (uWorkFile) {
        const wfAbs = resolveWithinRoot(uProjRoot, uWorkFile)
        if (!wfAbs) {
          sendJson(res, 403, { error: 'forbidden' })
          return
        }
        try {
          if (!statSync(wfAbs).isFile()) {
            sendJson(res, 400, { error: 'workFile not found' })
            return
          }
        } catch {
          sendJson(res, 400, { error: 'workFile not found' })
          return
        }
      }
      const uResolved = resolveUploadSlot({
        projectRoot: uProjRoot,
        workFile: uWorkFile,
        kind: uKind,
        slotId: url.searchParams.get('slot') || '',
      })
      if (!uResolved.ok) {
        sendJson(res, uResolved.code, { error: uResolved.error })
        return
      }
      const uSlot = uResolved.slot
      const uBuf = await readBodyWithLimit(req, 20 * 1024 * 1024)
      if (uSlot.storage.scope === 'session') {
        const uRoot = uSess ? uSess.root : (uProject ? uProjRoot : getProjectRoot())
        const uDirKey = uSess ? uSess.dirKey : PENDING_FILE_DIR
        if (uSess && uProject && resolve(uSess.root).toLowerCase() !== resolve(uProjRoot).toLowerCase()) {
          console.log(`[gateway] upload: sid 与 project 归属不一致，以 sid 为准（${uSess.root}）`)
        }
        const stored = storeUploadFile(uRoot, `.claude/${FILE_CACHE_DIR}/${uDirKey}`, uStoredName, uBuf)
        if (!stored.ok) {
          sendJson(res, stored.code, { error: stored.error })
          return
        }
        const uQuery = uSid
          ? '?sid=' + encodeURIComponent(uSid)
          : (uProject ? '?project=' + encodeURIComponent(uProject) : '')
        sendJson(res, 200, {
          ok: true, slot: uSlot.id, scope: 'session',
          originalName: uOriginalName, name: stored.name,
          storedPath: `.claude/${FILE_CACHE_DIR}/${uDirKey}/${stored.name}`,
          relativePath: `${FILE_CACHE_DIR}/${uDirKey}/${stored.name}`,
          reference: '',
          url: `/gateway/file-cache/${uDirKey}/${encodeURIComponent(stored.name)}${uQuery}`,
          size: stored.size,
          fallback: uResolved.fallback,
          ...(uResolved.fallback ? { fallbackReason: uResolved.fallbackReason || '' } : {}),
        })
        return
      }
      // document 作用域：落点 = workFile 所在目录 + slot.storage.directory（项目根相对）
      if (!uWorkFile) {
        sendJson(res, 400, { error: `${uSlot.id} 需要 workFile` })
        return
      }
      if (!uProject) {
        sendJson(res, 400, { error: `${uSlot.id} 需要 project` })
        return
      }
      const uWf = uWorkFile.replace(/\\/g, '/').replace(/^\/+/, '')
      const uDocDir = dirname(uWf) === '.' ? '' : dirname(uWf).replace(/\\/g, '/')
      const uRelDir = uDocDir ? `${uDocDir}/${uSlot.storage.directory}` : uSlot.storage.directory
      const stored = storeUploadFile(uProjRoot, uRelDir, uStoredName, uBuf)
      if (!stored.ok) {
        sendJson(res, stored.code, { error: stored.error })
        return
      }
      const uRefPath = (uSlot.reference.pathPrefix ? uSlot.reference.pathPrefix + '/' : '') +
        `${uSlot.storage.directory}/${stored.name}`
      sendJson(res, 200, {
        ok: true, slot: uSlot.id, scope: 'document',
        originalName: uOriginalName, name: stored.name,
        storedPath: stored.relPath,
        relativePath: uRefPath,
        reference: buildUploadReference(uSlot, uKind, uRefPath, stored.name),
        url: `/gateway/file?label=${encodeURIComponent(uProject)}&path=${encodeURIComponent(stored.relPath)}`,
        size: stored.size,
        fallback: false,
      })
      return
    } catch (e) {
      if (e instanceof ReportBodyTooLargeError) sendReportBodyError(res, e)
      else sendError(res, e)
    }
    return
  }

  // 兼容入口（保留一个版本周期）：POST /gateway/file-cache?name=&sid=&project=[&...]，body=原始字节。
  // 内部转调统一落盘（session 作用域），不再独立落盘；返回旧格式 {ok,name,rel,size}（不再返回 abs）。
  // 旧前端传的 name 已含时间戳，这里不二次加戳；sid 非法按旧语义回落 project / 网关自身根。
  if (req.method === 'POST' && url.pathname === '/gateway/file-cache') {
    try {
      const legacyName = sanitizeEntryName(url.searchParams.get('name') || '') || 'file'
      const legacySid = (url.searchParams.get('sid') || '').trim()
      const legacyProj = (url.searchParams.get('project') || '').trim()
      let legacyProjRoot = root
      if (legacyProj) {
        const g = findProjects(root).find((x) => x.label === legacyProj)
        if (g) legacyProjRoot = resolve(g.dir, '..', '..')
      }
      const legacySess = legacySid ? resolveUploadSession(legacySid, root) : null
      const legacyRoot = legacySess ? legacySess.root : (legacyProj ? legacyProjRoot : getProjectRoot())
      const legacyDirKey = legacySess ? legacySess.dirKey : PENDING_FILE_DIR
      const buf = await readBodyWithLimit(req, 20 * 1024 * 1024)
      const stored = storeUploadFile(legacyRoot, `.claude/${FILE_CACHE_DIR}/${legacyDirKey}`, legacyName, buf)
      if (!stored.ok) {
        sendJson(res, stored.code, { error: stored.error })
        return
      }
      sendJson(res, 200, {
        ok: true, name: stored.name,
        rel: `${FILE_CACHE_DIR}/${legacyDirKey}/${stored.name}`,
        size: stored.size,
      })
    } catch (e) {
      if (e instanceof ReportBodyTooLargeError) sendReportBodyError(res, e)
      else sendError(res, e)
    }
    return
  }
  // 文件缓存读取：GET /gateway/file-cache/<会话uuid|_pending>/<键>?sid=<会话hash>[&project=<label>]
  // （image-cache 已升级并入此链；写入侧 = POST /gateway/upload 的 session 作用域）。
  // 基址 = 会话启动根/.claude/file-cache（由 sid 解出；无 sid 时按 project label、再退网关自身根，
  // 与 /gateway/upload 的 session 作用域同序）。
  // 键两种形态，同一目录：① 纯数字 id —— CLI 落盘的粘贴图片 <id>.<ext>（扩展名由 mediaType 推导，
  // 此处按 `<id>.` 前缀 readdir 解析，消费端无需知道扩展名）；② 完整文件名 —— 网关落盘的上传附件。
  // 文件名单段校验（禁 / \ .. 与空串），目录键限 uuid / _pending——越界一律 400。
  if (req.method === 'GET' && url.pathname.startsWith('/gateway/file-cache/')) {
    const m = /^\/gateway\/file-cache\/([0-9a-f-]{36}|_pending)\/([^/]+)$/.exec(url.pathname)
    if (!m) {
      sendJson(res, 400, { error: 'invalid path' })
      return
    }
    let fcKey = m[2]
    try { fcKey = decodeURIComponent(m[2]) } catch { /* 畸形编码 → 用原文，下面校验会挡掉危险字符 */ }
    if (!fcKey || fcKey === '.' || fcKey === '..' || /[\\/]/.test(fcKey)) {
      sendJson(res, 400, { error: 'invalid name' })
      return
    }
    const fcSid = (url.searchParams.get('sid') || '').trim()
    const fcProj = (url.searchParams.get('project') || '').trim()
    const fcSess = fcSid ? resolveUploadSession(fcSid, root) : null
    const fcRoot = (fcSess && fcSess.root) || (fcProj ? webSessionProjectRoot(fcProj) : getProjectRoot())
    const fcDir = getFileCacheDir(fcRoot, m[1])
    let fcHit = fcKey
    if (/^\d+$/.test(fcKey)) {
      try {
        fcHit = readdirSync(fcDir).find((f) => /^\d+\./.test(f) && f.startsWith(`${fcKey}.`)) || ''
      } catch {
        fcHit = ''
      }
      if (!fcHit) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
    }
    const fcPath = join(fcDir, fcHit)
    try {
      const buf = readFileSync(fcPath)
      res.writeHead(200, {
        'Content-Type': MIME[extname(fcPath)] || 'application/octet-stream',
        'Content-Length': buf.length,
        // 2026-09-16 no-cache 根修（用户定案，原 image-cache 口径沿用）：id/文件名虽由分配器保证唯一，
        // 但会话目录可被清理重写，no-cache 是「URL 字节一变立即反映」的防线，localhost/LAN 开销可忽略。
        'Cache-Control': 'private, no-cache',
      })
      res.end(buf)
    } catch {
      sendJson(res, 404, { error: 'not found' })
    }
    return
  }

  // 2026-08-27 Web 容器同源反向代理：/backend/<label>/<path>?<query> → http://127.0.0.1:<port>/<path>?<query>
  // 远程端（手机遥测）无法直连回环后端端口，统一经网关主端口转发；后端仍只绑 127.0.0.1，访问面不变。
  // 不做 query token 校验（子资源必裸奔）；凭 /gateway/backend 种下的票证 cookie + label 白名单放行。
  // 2026-08-29 全称定案：主前缀 /backend/，旧 /bp/ 保留解析兼容（不再生成）。
  const bpMatch = /^\/(?:backend|bp)\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(req.url ?? '')
  if (bpMatch) {
    let bpLabel = ''
    try {
      bpLabel = decodeURIComponent(bpMatch[1])
    } catch {
      bpLabel = bpMatch[1]
    }
    const bpJar = parseCookieHeader(req.headers.cookie)
    const bpCookieKey = bpJar[BP_COOKIE_NAME]
    const bpTicket = bpCookieKey ? bpSessions.get(bpCookieKey) : undefined
    if (!bpTicket || !bpTicket.labels.has(bpLabel)) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    const bpProj = findProjects(root).find((g) => g.label === bpLabel && g.hasPreview)
    if (!bpProj) {
      sendJson(res, 404, { error: 'no backend for project' })
      return
    }
    const bpPreviewDir = previewDirOf(bpProj)
    // 首段 = 卡页目录（pane 卡 id / 应用卡 path 首段）：命中已启用卡后端则走该卡，
    // 否则回落项目级 backend（旧链：项目级后端托管多张卡页，如 Pj8 cuvette）。
    let bpSeg = ''
    try {
      bpSeg = decodeURIComponent((bpMatch[2] || '/').split('/').filter(Boolean)[0] || '')
    } catch {
      bpSeg = ''
    }
    const bpCard = findEnabledCardBackendBySeg(bpPreviewDir, bpSeg)
    const bpKey = bpCard ? cardBackendKey(bpLabel, bpCard.id) : bpLabel
    const bpCfg = bpCard ? bpCard.cfg : readBackendCfg(bpPreviewDir)
    if (!bpCfg) {
      sendJson(res, 404, { error: 'no backend for project' })
      return
    }
    let bpProc: BackendProc
    try {
      bpProc = await ensureBackend(bpKey, bpCfg) // 直开页面（无父页心跳）也顺带保活
    } catch (e) {
      sendError(res, e)
      return
    }
    bpTicket.expires = Date.now() + BP_COOKIE_TTL_MS
    // rest/search 原样透传（保留原始 %xx 编码），不在网关层二次解码重组，防中文路径双重编码错乱
    proxyBackendRequest(req, res, bpProc, `/backend/${bpMatch[1]}`, bpMatch[2] || '/', bpMatch[3] || '')
    return
  }
  // 项目预览页静态托管：/preview/<项目>/* → <root>/<项目>/.claude/preview/*（点击项目胶囊时前端 iframe 加载替换界面）
  // label 必须是 findProjects 命中且带 .claude/preview 的真实项目（用 dir 推 preview 目录，避免按 label 拼路径）；
  // 子路径 resolve 后必须落在 preview 目录内（越界防护），默认 index.html。
  const pvMatch = /^\/preview\/([^/]+)((?:\/.*)?)$/.exec(url.pathname)
  if (req.method === 'GET' && pvMatch) {
    // 畸形 % 序列（如 %ZZ）decode 会抛 URIError——未捕获曾崩掉整个网关进程（2026-08-29 gateway.log
    // 取证：URIError at handleRequest，反复崩溃重启→遥测端断连/预览打不开）。decode 失败用原文，
    // 后续 findProjects 不命中自然 404 兜底。
    let pvLabel = pvMatch[1]
    try {
      pvLabel = decodeURIComponent(pvMatch[1])
    } catch {
      /* 保留原文 */
    }
    let pvRel = (pvMatch[2] || '').replace(/^\//, '') || 'index.html'
    try {
      pvRel = decodeURIComponent(pvRel)
    } catch {
      /* 保留原文，existsSync 不命中自然 404 兜底 */
    }
    // label 命中且带 .claude/preview（项目或全局根，2026-10-10 起含全局根）——同 /gateway/preview-cards
    const pvProj = findProjects(root).find((g) => g.label === pvLabel && g.hasPreview)
    if (!pvProj) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return
    }
    const pvDir = join(pvProj.dir, '..', 'preview') // dir = <root>/<label>/.claude/projects 或全局根 <root>/.claude/projects
    const pvFile = resolve(pvDir, pvRel)
    if (pvFile !== pvDir && !pvFile.startsWith(pvDir + sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Forbidden')
      return
    }
    if (!existsSync(pvFile) || !statSync(pvFile).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(pvFile)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    })
    res.end(readFileSync(pvFile))
    return
  }
  if (req.method === 'GET' && url.pathname === '/gateway/session') {
    const id = url.searchParams.get('id')
    if (!id) {
      sendJson(res, 400, { error: 'missing id' })
      return
    }
    try {
      const { path: p, uuid } = decodeSessionPath(id, root)
      // 历史一律以磁盘 jsonl 全量为基底（readSession，含上下文压缩前的完整历史）；
      // CLI 上报的内存窗口（conversationDisplays）只作尾部追加——直接返回 live 会因
      // 内存窗口缺失历史用户消息而看不到完整历史。
      const data = readSession(id, root)
      const disp = conversationDisplays.get(uuid)
      if (disp && Array.isArray(disp.messages) && disp.messages.length) {
        data.messages = mergeDisplayMessages(data.messages as never, disp.messages as never)
        data.display = data.messages
      }
      // 2026-08-24 模型 web/CLI 同步：附每会话实际模型（CLI 上报，override 不落盘只此有源）+
      // 上报时间戳（web 端据此判断是否覆盖本地选择）；无上报时回落 null（web 回落凭据池 activeModel）。
      const sm = sessionModels.get(uuid)
      // 2026-11-06 会话模型隔离（B）：在线上报缺失时按「该会话的启动模型表」回落——会话未在线/
      // 从未在本网关生命周期内上报过时，旧实现回 null，web 便保留**上一个会话**的模型座（用户
      // 实测「切会话后模型停在上一会话」）。再兜底全局 activeModel（该会话从未改过模型时的实际值）。
      // modelTs 只在真上报时给：null 让 web 的在途快照守卫直接放行（启动表/全局值是权威落值）。
      data.model = sm?.model ?? sessionModelLaunch.get(uuid)?.model ?? getGlobalActiveModel() ?? null
      data.modelTs = sm?.updatedAt ?? null
      // 2026-11-06 每会话思考等级（C）：该会话自己的档位（null = Off/未设置，web 回落全局默认）。
      // 无上报时不给键——web 据此区分「该会话没改过档」与「明确 Off」。
      const se = sessionEfforts.get(uuid)
      if (se) data.effort = se.effort
      // 2026-08-28 遥测端图片门控：该会话模型是否识图（有上报按上报模型，无上报回落全局 activeModel，
      // 与 model 字段回落同源）→ 前端 renderSession/applySessionModel 据此显隐图片上传入口
      const visionModel = sm?.model ?? getGlobalActiveModel()
      data.vision = visionModel ? modelSupportsVision(visionModel) : false
      // 2026-08-30 队列快照（清单#2）：当前排队项（首载/刷新时与 SSE queue-state 增量同构）
      data.queued = sessionQueues.get(uuid)?.items ?? []
      // 2026-09-10 任务清单快照：当前可见任务（首载/刷新时与 SSE task-state 增量同构）
      data.tasks = sessionTasks.get(uuid)?.tasks ?? []
      // 2026-09-08 事件流统一 P1：当前 delta seq 记账随全量下发——web 全量对账后以此为续流
      // 起点（seq 连续应用 / gap 再对账），网关重启清零后 CLI 未发 delta 时回落 0（下条 seq=1 连续）。
      data.deltaSeq = sessionDeltaSeq.get(uuid) ?? 0
      sendJson(res, 200, data)
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/gateway/conversation') {
    try {
      const parsed = await readReportBody(req)
      const sid = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      const msgs = Array.isArray(parsed.messages) ? parsed.messages : null
      if (!sid || !msgs) {
        sendJson(res, 400, { error: 'invalid body' })
        return
      }
      // P2 增量上报聚合（2026-08-31，20260828145952-内存增长根因与代码层修改建议.md）：
      // body.base 为非负整数 = 增量语义——CLI 侧已确认缓存前 base 条不变，本批 messages
      // 替换第 base 条起的内容（尾部 thinking 可见性/图片并回等投影回改天然覆盖）。
      // base 越界（网关重启/缓存被 sweep）→ 按窗口投影展示，CLI 校验响应 cached 长度不符
      // 后下轮自动全量对账恢复完整。无 base = 全量替换（旧语义，兼容）。TTL/sweep 不变。
      const base = typeof parsed.base === 'number' && Number.isInteger(parsed.base) && parsed.base >= 0 ? parsed.base : -1
      let merged = msgs
      if (base >= 0) {
        const prev = conversationDisplays.get(sid)?.messages
        if (Array.isArray(prev) && base <= prev.length) {
          merged = prev.slice(0, base).concat(msgs)
        }
      }
      conversationDisplays.set(sid, { messages: merged, updatedAt: Date.now() })
      sweepStaleMaps()
      sendJson(res, 200, { ok: true, cached: merged.length })
    } catch (error) {
      sendReportBodyError(res, error)
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/gateway/activity') {
    try {
      const parsed = await readReportBody(req)
      const sid = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      const status = typeof parsed.status === 'string' && ['busy', 'idle', 'waiting'].includes(parsed.status)
        ? parsed.status
        : null
      if (!sid || !status) {
        sendJson(res, 400, { error: 'invalid body' })
        return
      }
      sessionActivity.set(sid, {
        status,
        pid: Number(parsed.pid) || 0,
        cwd: typeof parsed.cwd === 'string' && parsed.cwd ? parsed.cwd : undefined,
        updatedAt: Date.now(),
      })
      sweepStaleMaps()
      // 状态点即时性（2026-08-29 状态点偶发观测不到修复）：收到活动上报即群发轻量 SSE activity
      // 事件 → 前端 refreshList 重拉 /gateway/sessions。busy/waiting 翻转不再等 jsonl 落盘（updated）
      // 才可见；负载极小，只触发列表刷新、不触发 refreshSession。
      const s = `data: ${JSON.stringify({ type: 'activity', session: sid, state: status })}\n\n`
      sendAll(sseClients, (c) => {
        c.res.write(s)
      })
      sendJson(res, 200, { ok: true })
    } catch (error) {
      sendReportBodyError(res, error)
    }
    return
  }
  // 2026-08-24 模型 web/CLI 同步：CLI 侧 reportCurrentModel 上报每会话实际模型（内存 Map，detach 清扫）。
  // 每会话 override 不写凭据池，web 端 /gateway/session 据此读取校准模型 seat，与 CLI 实际使用一致；
  // 2026-09-19 起同一落值再 SSE 群发（见下），web 不必等拉取。
  if (req.method === 'POST' && url.pathname === '/gateway/model-report') {
    try {
      const parsed = await readReportBody(req)
      const sid = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      const model = typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : ''
      // 2026-11-06 思考等级按会话隔离（C）：同一端点接收 CLI 自报的 effort（'off'/'auto' = 清除）。
      // 只有带 effort 键的上报才写镜像——模型上报不带该键时不能把已记录的档位抹掉。
      const hasEffort = Object.prototype.hasOwnProperty.call(parsed, 'effort')
      const rawEffort = typeof parsed.effort === 'string' ? parsed.effort.trim() : parsed.effort === null ? '' : undefined
      // null / 空串 / 'off' / 'auto' / 'default' 一律记 null（= 明确 Off/退出档位）
      const reportedEffort = !rawEffort || rawEffort === 'off' || rawEffort === 'auto' || rawEffort === 'default' ? null : rawEffort
      if (!sid || (!model && !hasEffort)) {
        sendJson(res, 400, { error: 'invalid body' })
        return
      }
      const modelTs = Date.now()
      if (model) {
        sessionModels.set(sid, { model, updatedAt: modelTs })
        // 同值记入启动模型表（2026-10-13）：CLI 自报的是本会话实际生效模型——含 spawn --model
        // 启动后的 open 补报（闭环：新建带模型启动 → 表记录 → 下次 resume 带同值）与运行期
        // 切换生效后的上报（校正 /gateway/model 先记的意图值）。
        recordSessionModelLaunch(sid, model)
      }
      if (hasEffort) sessionEfforts.set(sid, { effort: reportedEffort ?? null, updatedAt: modelTs })
      sweepStaleMaps()
      // 2026-09-19 实时化：落值后 SSE 群发 {type:'model', session, model, modelTs}（与 queue-state/
      // task-state 同款「镜像存储 + 转发」）——此前 web 只能等下一次 /gateway/session 拉取才校准，
      // 会话空闲时可能长时间不来，「CLI 切了模型、web 底栏不动」正是这条延迟造成的。
      // modelTs = 本次上报时刻，web 端与「用户刚在 web 切过的时刻」比对，用于丢弃切换前的在途快照。
      if (model) {
        const s = `data: ${JSON.stringify({ type: 'model', session: sid, model, modelTs })}\n\n`
        sendAll(sseClients, (c) => { c.res.write(s) })
      }
      sendJson(res, 200, { ok: true })
    } catch (error) {
      sendReportBodyError(res, error)
    }
    return
  }
  if (req.method === 'GET' && url.pathname === '/gateway/events') {
    // SSE：idleTimeout 禁用（长连接保持，避免重连级联）
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const client = { res }
    sseClients.add(client)
    scheduleIdleShutdown()
    // TCP keepalive（2026-10-14 GPT 定案）：只辅助回收半开 TCP（内核层探测死对端），
    // 不作实时性保证——实时性由应用层命名 heartbeat（startSseHeartbeat）+ 客户端 watchdog 承担。
    res.socket?.setKeepAlive(true, 15_000)
    // 背压恢复即清 stuckSince；error = 写失败，立即摘除名册（close 会随后触发同一清理路径，幂等）。
    res.on('drain', () => { client.stuckSince = undefined })
    res.on('error', () => {
      sseClients.delete(client)
      scheduleIdleShutdown()
    })
    res.write(`data: ${JSON.stringify({ type: 'hello', time: Date.now() })}\n\n`)
    req.on('close', () => {
      sseClients.delete(client)
      scheduleIdleShutdown()
    })
    // O4：建立文件监听 + 立即 primed 一轮（填充 sseSizes 基线），后续变化由 watch 事件驱动
    ensureSseWatches(root)
    pollSse(root)
    return
  }
  // 静态资源：内嵌 web 资源优先（打包进 exe），磁盘 SubPj public 兜底（开发模式）
  // 2026-08-28 SPA 路径路由：/session/<hash>、/manage/…、/project/<label> 非真实文件 → 一律回 index.html，
  // 由前端 parseRoute 按 location.pathname 解析（pushState 路由）。2026-08-29 全称定案：前端只生成全称前缀
  // （/session/、/manage/、/project/、/backend/），旧缩写（/s/、/mgr/、/pview/、/bp/）保留解析兼容。
  // /preview、/backend 等真实路径在前面的分支已消费，不会落到此处。
  const isSpaRoute = /^\/(?:session\/|s\/|manage\/|mgr(?:\/|$)|project\/|pview\/)/.test(url.pathname)
  const rel = isSpaRoute || url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '')
  const embedded = readWebAsset(rel)
  if (embedded) {
    res.writeHead(200, {
      'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    })
    res.end(embedded)
    return
  }
  const pub = publicDir(root)
  const file = resolve(pub, rel)
  if (!isPathInside(pub, file) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
    return
  }
  const body = readFileSync(file)
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  })
  res.end(body)
}

function broadcast(msg: unknown): void {
  const s = JSON.stringify(msg)
  sendAll(sockets, (c) => c.send(s))
}

/** 遥测端 WS 断开 → 从所有 web 会话订阅集合中摘除（重连后前端重新 subscribe） */
function detachWebSessionClient(ws: WebSocket): void {
  for (const p of webSessions.values()) {
    p.clients.delete(ws)
  }
}

// 2026-08-24 审批链路诊断轨迹：环形日志记录 /clients 注册、approval-request 接收与广播、
// approve 接收与路由、local-resolved/cancel；2026-08-26 P0 加 approval-processed（CLI 已处理回执）
// 与 gw-approval-confirmed（确认转发 floria）。GET /gateway/diagnostics 读取（调试审批「卡片不弹」）。
const approvalTrail: Array<{ ts: number; ev: string; sessionId?: string; requestId?: string; detail?: string }> = []
function approvalTrailPush(ev: string, sessionId?: string, requestId?: string, detail?: string): void {
  approvalTrail.push({ ts: Date.now(), ev, sessionId, requestId, detail })
  if (approvalTrail.length > 500) approvalTrail.splice(0, approvalTrail.length - 500)
}

// 2026-08-30 审批/提问 pending 重放（DSH 同款「待答=会话持久状态」语义）：approval-request 是
// 瞬态广播，前端按 currentHash 过滤丢弃后即永久丢失（提问时页面开着别的会话或没开 → 切回只剩
// 只读兜底卡「请在 CLI 窗口作答」）。改为网关按 requestId 暂存未决 approval，前端 renderSession/WS
// 重连发 subscribe 时回放该会话未决项 → 打开会话总能补弹交互卡。
// 2026-10-02 生命周期根治：清理只绑两个真实释放源——①会话进程失联确认（detach 3s 复核窗，
// pendingApprovalsDropSession 与其它 per-session 态一起清）②显式回执（resolved/cancel/processed）。
// 原 30 分钟墙钟 TTL 兜底已删：它把「CLI 仍活着、进程仍阻塞在等作答」的有效待决项按时间误杀
// （实测 8h58m 后重放不发卡，只剩转录紧凑行「提问·等待回答」+无响应红标）。
const pendingApprovals = new Map<string, { sessionId: string; payload: unknown }>()
function pendingApprovalsSet(sessionId: string, requestId: string, payload: unknown): void {
  pendingApprovals.set(requestId, { sessionId, payload })
}
function pendingApprovalsDrop(requestId: unknown): void {
  if (typeof requestId === 'string' && requestId) pendingApprovals.delete(requestId)
}
function pendingApprovalsDropSession(sessionId: string): void {
  for (const [requestId, e] of pendingApprovals) if (e.sessionId === sessionId) pendingApprovals.delete(requestId)
}
function pendingApprovalsReplay(ws: WebSocket, sessionId: string): void {
  for (const [, e] of pendingApprovals) {
    if (e.sessionId !== sessionId) continue
    try {
      ws.send(JSON.stringify(e.payload))
    } catch {
      /* 连接已断，忽略 */
    }
  }
}
function approvalTrailSnapshot(): unknown[] {
  return approvalTrail.slice(-50).reverse()
}

// 2026-08-25 发送即 resume：任何会话（web 与 CLI 一视同仁）进程未在线 → 先恢复本地 CLI 窗口再投递消息。
// 会话项目按磁盘文件定位（sessionProjectRootOf → 项目根/全局根），复用 spawnWebSession 的 --resume +
// 原生 resume 逻辑，cwd/exe 由 webSessionProjectRoot/webSessionExe 按定位到的项目正确路由，
// 注册完成后再把消息注入 REPL（cliClients 精确路由，与本地打字同路径）。会话文件不在磁盘 → 拒绝。
// 同一会话 resume 在途（spawn 最长 20s）→ 复用同一 promise，多消息串行投递，杜绝双 spawn 双写 jsonl。
const resumingSessions = new Map<string, Promise<void>>()

/**
 * 会话标题落盘 + 在线 CLI 内存同步（2026-09-20 抽自 /gateway/session/rename handler，
 * 供 session-create 新建会话命名共用）。**成对不可拆**：只落盘不路由 → 在线 CLI 内存仍持旧标题，
 * 退出时 re-append 覆盖回去（rename handler 原注释即此坑）；只路由不落盘 → 列表刷新后标题丢失。
 * 返回 routeToClient 是否命中在线 CLI（仅诊断轨迹用来区分 hit/miss）。
 */
async function applySessionTitle(uuid: string, title: string, path: string): Promise<boolean> {
  await saveCustomTitle(uuid as UUID, title, path)
  await saveAgentName(uuid as UUID, title, path)
  return routeToClient(uuid, { type: 'rename', sessionId: uuid, title })
}

/**
 * 投递反馈（2026-09-15 抽取）：三形态路由对发起端的回报口径由调用方决定——web 发送 = status
 * 提示行（纯展示），会话间消息 = session-message-result 回执（调用方的工具在等结果）。
 * done 恒被调用且只调一次；staged/resuming 是过程提示，纯展示侧使用。
 */
type DeliveryFeedback = {
  /** ② 已暂存待投。spawning=true：会话进程正在冷启，注册钩子会补投；false：活进程断连重连间隙 */
  staged: (spawning: boolean) => void
  /** ③ 目标离线且磁盘有会话文件，正在冷启恢复窗口 */
  resuming: () => void
  /** 终局。ok=false 时 error 为面向用户/模型的可读原因 */
  done: (ok: boolean, error?: string) => void
}

/**
 * 目标会话投递三形态统一路由（2026-09-15 抽取，web 发送 `send` 与会话间 `session-message` 共用
 * ——寻址语义只此一处，避免两路各自漂移）：
 *   ① 目标进程在线 → cliClients 直投
 *   ② spawn/注册在途（含活进程断连重连间隙）→ pendingDeliveries 暂存，/clients 注册钩子按序补投
 *   ③ 未在线 → resumeAndDeliver 按磁盘会话文件冷启恢复后补投
 * frame = 投给目标 CLI 的 /clients 帧（两路帧型不同，由调用方构造）。
 */
function deliverToSession(sessionId: string, frame: Record<string, unknown>, fb: DeliveryFeedback): void {
  const target = cliClients.get(sessionId)
  if (target && target.readyState === WebSocket.OPEN) {
    try {
      target.send(JSON.stringify(frame))
      fb.done(true)
    } catch (e) {
      fb.done(false, '投递失败：' + ((e as Error)?.message ?? String(e)))
    }
    return
  }
  const spawning = spawningPromises.has(sessionId)
  if (spawning || webSessionEntryAlive(sessionId)) {
    const q = pendingDeliveries.get(sessionId) ?? []
    q.push(frame)
    pendingDeliveries.set(sessionId, q)
    fb.staged(spawning)
    // 暂存即投递成立（不丢消息由 /clients 注册钩子的补投保证）→ 此处即终局 ok
    fb.done(true)
    return
  }
  resumeAndDeliver(sessionId, frame, fb)
}

function resumeAndDeliver(sessionId: string, frame: Record<string, unknown>, fb: DeliveryFeedback): void {
  const loc = sessionProjectRootOf(sessionId)
  if (!loc) {
    fb.done(false, '目标会话未在线，且磁盘上找不到该会话文件')
    return
  }
  fb.resuming()
  let p = resumingSessions.get(sessionId)
  if (!p) {
    p = spawnWebSession(sessionId, loc.projectLabel).finally(() => resumingSessions.delete(sessionId))
    resumingSessions.set(sessionId, p)
  }
  p.then(() => {
    // 2026-08-31 防双进程路径：复用的活进程可能仍在断连重连（cliClients 暂 miss）——
    // 轮询等其重新注册再注入（最长 5s，400ms 间隔），替代原「miss 即报未注入」单次判定。
    const t0 = Date.now()
    const tryInject = (): void => {
      const t = cliClients.get(sessionId)
      if (t && t.readyState === WebSocket.OPEN) {
        try {
          t.send(JSON.stringify(frame))
          fb.done(true)
        } catch (e) {
          fb.done(false, '投递失败：' + ((e as Error)?.message ?? String(e)))
        }
      } else if (Date.now() - t0 < 5000) {
        setTimeout(tryInject, 400)
      } else {
        fb.done(false, '会话恢复后仍未连接，消息未投递')
      }
    }
    tryInject()
  }).catch((e) => {
    fb.done(false, '恢复会话失败：' + (e.message || e))
  })
}

// 2026-08-28 遥测端图片上行校验：前端把图片以 base64（无 data: 前缀）随 'send' 上行，
// 逐项校验后透传给 CLI（CLI 侧 gatewayClient 构造 pastedContents → 与本地粘贴图片同链路）。
// 限制：单张 base64 ≤7MB（API 限 5MB 二进制，留编码余量）、mediaType 白名单 image/*（png/jpeg/gif/webp）。
// **张数上限归发送方（web 前端 pendingImages ≥9 拦截），本处不再另设更小的数**——2026-10-16 根修：
// 原 `raw.slice(0, 4)` 的静默截断与前端 9 张上限不一致，第 5 张起被悄悄丢掉，而消息文本里的
// `[Image #N]` 占位早已按 9 张拼好 → 多出的占位无图可对应，漏成消息裸文本（用户实测
// [Image #5] [Image #6] [Image #7]）。同一条链上的张数策略只留一个真源（发送方）。
// 2026-09-06 显式 id 透传：web 前端 2026-09-02 起分配全会话唯一 id（[Image #N] 占位与之一一
// 对应），此处此前重组时把 id 剥掉 → CLI pastedContentsFromImages 收不到显式号，回落每条从 1
// 递增——同会话所有带图消息全存 1.png 互覆错图，且占位 [Image #N] 与落盘 imagePasteIds 错位
// （conversationDisplay 拆分并回条件不满足 → 非排队首条带图消息渲染成文本/图两个气泡）。
// 仅透传正整数显式 id；缺省/非法仍由 CLI 侧自造递增兜底（旧前端兼容不变）。
function sanitizeInboundImages(raw: unknown): Array<{ id?: number; content: string; mediaType: string; filename?: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ id?: number; content: string; mediaType: string; filename?: string }> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const it = item as { id?: unknown; content?: unknown; mediaType?: unknown; filename?: unknown }
    if (typeof it.content !== 'string' || !it.content || it.content.length > 7_000_000) continue
    if (typeof it.mediaType !== 'string' || !/^image\/(png|jpeg|gif|webp)$/i.test(it.mediaType)) continue
    out.push({
      ...(typeof it.id === 'number' && Number.isInteger(it.id) && it.id > 0 ? { id: it.id } : {}),
      content: it.content,
      mediaType: it.mediaType.toLowerCase(),
      ...(typeof it.filename === 'string' && it.filename ? { filename: it.filename.slice(0, 120) } : {}),
    })
  }
  return out
}

// ============================================================================
// 卡片公开 API（2026-10-11）：agent → 浏览器里的卡
// ============================================================================
// 卡活在 iframe 里：进程外无法寻址、也没有身份（浏览器给的物理边界——卡只认识 window.parent）。唯一
// 既**能寻址**又**持有鉴权**的一层是宿主（web 前端总线 engine/card-bus.js）。故链路只有一条：
//   宿主把每帧能力表（label/instanceId/ns/cmds/ready）经 /ws 的 {type:'card-caps'} 报上来
//   → agent 侧 POST /gateway/card-call → 本网关挑一台持卡设备下行 {type:'card-call',callId,target,cmd,args}
//   → 前端总线把 target 解析成具体帧、翻成卡的 `<ns>-cmd` → 卡的 ack 沿总线回 {type:'card-result',callId}
//   → 本网关按 callId 配对，落成 HTTP 响应。
// **卡片侧对此全程无感（零改动）**；卡↔宿主 / 卡↔卡两向根本不经过网关（在浏览器总线内闭环）。
type CardCap = { label?: string; instanceId?: string; kind?: string; ns?: string; cmds?: string[]; ready?: boolean }
/** 上报过能力表的浏览器连接（key = /ws socket）。at = 最近一次上报时刻（多设备歧义的裁决依据） */
const cardHolders = new Map<WebSocket, { ws: WebSocket; caps: CardCap[]; at: number }>()
/** 设备自报类型（/ws?device= hint）：仅用于 /gateway/cards 展示与多设备时人工分辨，不参与寻址 */
const wsDevice = new WeakMap<WebSocket, string>()
type CardOutcome =
  | { kind: 'ok'; result: unknown }
  | { kind: 'err'; error: string }
  | { kind: 'timeout' }
  | { kind: 'gone' }
const pendingCardCalls = new Map<
  string,
  { ws: WebSocket; resolve: (o: CardOutcome) => void; timer: ReturnType<typeof setTimeout> }
>()

/** 前端上报的能力表落表前的收口：无 instanceId 的条目不可寻址，直接丢（总线恒会带） */
function sanitizeCaps(v: unknown): CardCap[] {
  if (!Array.isArray(v)) return []
  const out: CardCap[] = []
  const str = (x: unknown): string => (typeof x === 'string' ? x : '')
  for (const it of v) {
    if (!it || typeof it !== 'object') continue
    const c = it as Record<string, unknown>
    const instanceId = str(c.instanceId)
    if (!instanceId) continue
    out.push({
      label: str(c.label),
      instanceId,
      kind: str(c.kind),
      ns: str(c.ns),
      cmds: Array.isArray(c.cmds) ? c.cmds.filter((x): x is string => typeof x === 'string').slice(0, 64) : [],
      ready: c.ready === true,
    })
    if (out.length >= 200) break
  }
  return out
}

function listAllCaps(): Array<CardCap & { device: string }> {
  const out: Array<CardCap & { device: string }> = []
  for (const h of cardHolders.values()) {
    for (const c of h.caps) out.push({ ...c, device: wsDevice.get(h.ws) || '' })
  }
  return out
}

/**
 * 挑持卡设备：instanceId 最精确 > ns > label（可叠加 label 收窄 ns）；命中多台 → 取**最近上报**的那台。
 * 绝不广播猜测：广播会让两台设备（PC + iPad）的卡同时动。命中 0 返回 null（调用方按 503/409 区分）。
 */
function pickCardHolder(t: { label: string; ns: string; instanceId: string }): { ws: WebSocket; cap: CardCap } | null {
  let best: { ws: WebSocket; cap: CardCap; at: number } | null = null
  for (const h of cardHolders.values()) {
    for (const c of h.caps) {
      if (t.instanceId) {
        if (c.instanceId !== t.instanceId) continue
      } else if (t.ns) {
        if (c.ns !== t.ns) continue
        if (t.label && c.label !== t.label) continue
      } else if (t.label) {
        if (c.label !== t.label) continue
      } else {
        continue
      }
      if (!best || h.at > best.at) best = { ws: h.ws, cap: c, at: h.at }
    }
  }
  return best ? { ws: best.ws, cap: best.cap } : null
}

/** card:open 用：不按能力表筛（打开的对象本就常不在场），取「最近上报」的那台持卡设备执行整卡显隐 */
function pickLatestHolder(): { ws: WebSocket; cap: CardCap } | null {
  let best: { ws: WebSocket; cap: CardCap; at: number } | null = null
  for (const h of cardHolders.values()) {
    if (!best || h.at > best.at) best = { ws: h.ws, cap: h.caps[0], at: h.at }
  }
  return best ? { ws: best.ws, cap: best.cap } : null
}

/** 持卡 socket 断开：摘登记 + 在途调用当场收口（设备没了就是没了，不白等超时） */
function dropCardHolder(ws: WebSocket): void {
  cardHolders.delete(ws)
  for (const [id, p] of pendingCardCalls) {
    if (p.ws !== ws) continue
    clearTimeout(p.timer)
    pendingCardCalls.delete(id)
    p.resolve({ kind: 'gone' })
  }
}

/** 下行一次卡片调用并等回执。恒 resolve（不 reject），超时/断连是 outcome 的两种形态。 */
function callBrowserCard(ws: WebSocket, target: unknown, cmd: string, args: unknown, timeoutMs: number): Promise<CardOutcome> {
  const callId = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCardCalls.delete(callId)
      resolve({ kind: 'timeout' })
    }, timeoutMs)
    pendingCardCalls.set(callId, { ws, resolve, timer })
    try {
      ws.send(JSON.stringify({ type: 'card-call', callId, target, cmd, args, timeoutMs }))
    } catch {
      clearTimeout(timer)
      pendingCardCalls.delete(callId)
      resolve({ kind: 'gone' })
    }
  })
}

/** ?device= 自报类型（同 /gateway/activate 与 upgrade 的取值口径） */
function deviceHintOf(req: import('node:http').IncomingMessage): string {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`)
    return (url.searchParams.get('device') || '').trim().slice(0, 32)
  } catch {
    return ''
  }
}

function handleWsMessage(ws: WebSocket, raw: string): void {
  let data: { type?: string; text?: string; requestId?: string; allowed?: boolean; sessionId?: string; toolUseId?: string; input?: unknown; answers?: Record<string, string>; permissions?: unknown; images?: unknown; caps?: unknown; callId?: string; ok?: boolean; result?: unknown; error?: unknown }
  try {
    data = JSON.parse(raw)
  } catch {
    return
  }
  switch (data.type) {
    case 'send': {
      const text = data.text ?? ''
      if (!text.trim()) break
      // 2026-08-24 web 会话改造：web 会话 = 本地可见交互 REPL（CLI 自己连 /clients 注册），
      // 消息不再写子进程 stdin（stdin 归本地终端窗口），统一经 cliClients 精确路由 →
      // CLI 侧 gatewayClient enqueue 注入 REPL（与本地打字同路径）。审批也在本地窗口操作。
      // 2026-08-28 遥测端图片：images（base64 数组）校验后随消息透传，CLI 构造 pastedContents 走本地粘贴同链路。
      const images = sanitizeInboundImages(data.images)
      const sendPayload = images.length ? { type: 'send', text, images } : { type: 'send', text }
      if (data.sessionId) {
        // 2026-09-15 三形态路由抽为 deliverToSession（web 发送与会话间消息共用，见该函数注）。
        // web 侧反馈口径：恢复中/暂存/失败都走 status 提示行；成功不提示（前端会话态自明）。
        const status = (state: string): void => {
          try {
            ws.send(JSON.stringify({ type: 'status', state }))
          } catch {
            /* 断开忽略 */
          }
        }
        deliverToSession(data.sessionId, sendPayload, {
          // 2026-09-10 暂存回执：spawn 在途是 wsession 异步化常态（前端会话态自明，不弹）；
          // 活进程断连重连间隙的暂存须可见——否则 web 无响应而消息去向成谜。
          staged: (spawning) => {
            if (!spawning) status('会话连接恢复中，消息已暂存，CLI 重连后自动补投')
          },
          resuming: () => status('正在恢复会话窗口…'),
          done: (ok, error) => {
            if (!ok) status(error ?? '消息未注入')
          },
        })
        break
      }
      // 无 sessionId → 广播全部在线 CLI 客户端；无在线 CLI → status 提示
      if (cliClients.size) {
        sendAll(cliClients.values(), (c) => c.send(JSON.stringify(sendPayload)))
      } else {
        ws.send(JSON.stringify({ type: 'status', state: '当前无在线 CLI 进程，消息未注入' }))
      }
      break
    }
    case 'interrupt': {
      // 2026-09-04 web 打断按钮：web 前端 {type:'interrupt', sessionId} → 按会话精确路由给在线
      // CLI → CLI 侧 onCancel（与本地 Ctrl+C 同路径）。会话未在线只回 status 提示（不 resumeAndDeliver：
      // 打断对离线/空闲会话无意义，CLI 侧判活未命中本就是 no-op）。
      if (!data.sessionId) {
        ws.send(JSON.stringify({ type: 'status', state: '缺少会话标识，无法打断' }))
        break
      }
      const target = cliClients.get(data.sessionId)
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify({ type: 'interrupt' }))
      } else {
        ws.send(JSON.stringify({ type: 'status', state: '会话未在线，无法打断' }))
      }
      break
    }
    case 'queue-nudge': {
      // 2026-09-10 web 排队消息催办：web 前端 {type:'queue-nudge', sessionId}（点击排队
      // 气泡）→ 按会话精确路由给在线 CLI → CLI 侧判活后置位催办标记，query.ts 生成流
      // 就地断流、本轮 drain 把该消息纳入当前轮次（与 interrupt 不同：不改回合边界、
      // 不撤回、不产生新回合）。会话未在线只回 status（无生成流可断，排队消息在离线
      // 会话里本就只会走常规投递），不 resumeAndDeliver。
      if (!data.sessionId) {
        ws.send(JSON.stringify({ type: 'status', state: '缺少会话标识，无法催办' }))
        break
      }
      const target = cliClients.get(data.sessionId)
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify({ type: 'queue-nudge' }))
      } else {
        ws.send(JSON.stringify({ type: 'status', state: '会话未在线，无法催办' }))
      }
      break
    }
    case 'approve': {
      // 2026-08-24 审批双操作（web 与 CLI 均可）：floria 审批卡的应答路由回对应 CLI 会话
      // （/clients 注册的交互 REPL——普通 CLI 会话与 web 独立会话窗口同路径，均支持远程审批）。
      const target = data.sessionId ? cliClients.get(data.sessionId) : undefined
      if (target && target.readyState === WebSocket.OPEN) {
        approvalTrailPush('floria-approve-routed', data.sessionId, data.requestId, data.allowed === true ? 'allow' : 'deny')
        // 2026-08-24 提问答复：floria 交互表单提交答案 → updatedInput 带 {questions, answers}，
        // CLI 交互应答（buildAllow(updatedInput)）用完整输入执行工具（AskUserQuestion 拿到 answers）。
        // data.input 是工具原始输入 {questions:[...]}，questions 取数组本体（勿再嵌套）。
        let qInput: unknown = data.input ?? {}
        if (data.input && typeof data.input === 'object' && Array.isArray((data.input as { questions?: unknown }).questions)) {
          qInput = (data.input as { questions: unknown }).questions
        }
        // 2026-08-26 A1 修复：普通工具允许时 updatedInput 必须为 undefined（而非空对象 {}），
        // 否则 CLI 侧 interactiveHandler 的 response.updatedInput ?? displayInput 回退会被 {} 阻断，
        // 普通工具拿到空输入 {}。仅提问（data.answers）才构造 {questions, answers}。
        const updatedInput = data.answers
          ? { questions: qInput, answers: data.answers }
          : undefined
        target.send(
          JSON.stringify({
            type: 'approval-response',
            requestId: data.requestId ?? '',
            // 2026-08-26 A2：透传 web 端勾选的「记住此规则」permissionUpdates（data.permissions）
            // → CLI interactiveHandler onResponse 消费 response.updatedPermissions?.length → persistPermissions；
            // undefined 字段经 JSON.stringify 自动省略，不影响旧 CLI。
            response: data.allowed === true
              ? { behavior: 'allow', updatedInput, updatedPermissions: data.permissions }
              : { behavior: 'deny', message: '用户拒绝了该工具调用' },
          }),
        )
      } else {
        approvalTrailPush('floria-approve-miss', data.sessionId, data.requestId, 'target-not-online')
        ws.send(
          JSON.stringify({
            type: 'status',
            state: data.sessionId ? '目标会话未在线，审批未送达' : 'approve 尚未接入（阶段2）',
          }),
        )
        // 2026-08-26 P0：路由失败显式回 approval-rejected（带 requestId）→ 前端保留卡片 + 可见错误 + 重试
        ws.send(
          JSON.stringify({
            type: 'approval-rejected',
            sessionId: data.sessionId,
            requestId: data.requestId ?? '',
          }),
        )
      }
      break
    }
    case 'subscribe': {
      // 2026-08-24 web 会话改造：实时流走 SSE（conversationDisplay 上报 + jsonl + 列表刷新），
      // 无 WS out/approval 回推；订阅保留为兼容空操作（会话存在即确认）。
      const sid = data.sessionId ?? ''
      if (!sid) break
      const p = webSessions.get(sid)
      if (p) {
        p.clients.add(ws)
        ws.send(JSON.stringify({ type: 'status', state: '已订阅会话实时流' }))
      } else {
        ws.send(JSON.stringify({ type: 'status', state: 'web 会话进程未运行，未订阅' }))
      }
      // 2026-08-30 pending 重放：切会话/重连订阅时补弹该会话未决审批/提问（瞬态广播被
      // currentHash 过滤丢弃或页面未开的场景；已解决项不回放）。
      pendingApprovalsReplay(ws, sid)
      break
    }
    case 'card-caps': {
      // 前端总线帧表变更即上报（总线内 50ms 防抖），整份替换本连接的快照。空表 = 该设备当前无卡，
      // 摘登记而非留空表（否则 409 会列出已离场的卡）。
      const caps = sanitizeCaps(data.caps)
      if (caps.length) cardHolders.set(ws, { ws, caps, at: Date.now() })
      else cardHolders.delete(ws)
      break
    }
    case 'card-result': {
      // 卡的 ack 经前端总线回传：按 callId 配对（「哪一帧、哪条命令」的收口在前端 bus 内，网关不重复判）
      const id = typeof data.callId === 'string' ? data.callId : ''
      const p = id ? pendingCardCalls.get(id) : undefined
      if (!p) break
      clearTimeout(p.timer)
      pendingCardCalls.delete(id)
      p.resolve(data.ok === false ? { kind: 'err', error: String(data.error || '卡片命令失败') } : { kind: 'ok', result: data.result })
      break
    }
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }))
      break
  }
}

// ============================================================================
// 生命周期
// ============================================================================
export type LocalGatewayInfo = {
  port: number
  host: string
  token: string
  lanUrl: string
  localUrl: string
}

function hasClients(): boolean {
  return cliClients.size > 0 || sockets.size > 0 || sseClients.size > 0 || webSessions.size > 0
}

// 2026-08-17 空闲自动回收：无任何客户端连接（CLI 注册 / 遥测 WS / SSE 全空）时起计时，持续
// GATEWAY_IDLE_MINUTES 分钟仍无连接 → 自动 stopLocalGateway（清空三集合 + 清盘 token）+ 退出进程。
// 任一连接增删都会调用本函数重置计时（有动静即顺延）。仅 --gateway 独立进程模式启用。
// ============================================================================
// Web 容器 backend 进程管理实现
// ============================================================================
// 端口可用性探测：短暂监听 127.0.0.1:<port>，成功即释放 → 可用
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = netCreateServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

// 后端就绪探测：原生 TCP 连 127.0.0.1:<port> → 发最小 HTTP GET，2xx/404 均视为服务已起来。
// 用 node:net 而非 node:http：bun 编译产物里 httpRequest 对某些后端（aiohttp）可能 hang，
// 原生 socket 最稳（2026-08-19 实测网关 spawn ComfyUI 探测）。
function backendReady(port: number, path: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch {
        /* 忽略 */
      }
      resolve(ok)
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

// 进行中的 spawn（防并发重复拉起）：同一 label 探测期间，后续请求复用同一 Promise
const backendPending = new Map<string, Promise<BackendProc>>()

// 后端日志落「该项目自己的」<previewDir>/backend.log（2026-09-19 定案：一个项目一份 preview.json
// = 一个后端 = 单文件 ⇒ 直接放 preview/ 根，不建 logs/ 子目录）。
function backendLogPath(cfg: BackendCfg): string {
  return join(cfg.previewDir, 'backend.log')
}

// O3：backend 日志轮转 —— 超过上限截断重写，防长期运行无限增长（stdout/stderr 落盘只追加）
const BACKEND_LOG_MAX_BYTES = 5 * 1024 * 1024
function rotateBackendLogIfNeeded(p: string): void {
  try {
    if (existsSync(p) && statSync(p).size > BACKEND_LOG_MAX_BYTES) truncateSync(p, 0)
  } catch {
    /* 忽略 */
  }
}

// 懒加载 spawn 后端进程（已运行则复用并刷新活跃时间；2026-08-28 起支持按注册表收养网关重启后的存活进程）
function backendProcAlive(p: BackendProc): boolean {
  return p.child ? p.child.exitCode === null && !p.child.killed : isPidAlive(p.pid)
}
async function ensureBackend(label: string, cfg: BackendCfg): Promise<BackendProc> {
  const existing = backendProcesses.get(label)
  if (existing && backendProcAlive(existing)) {
    existing.lastActive = Date.now()
    return existing
  }
  if (existing) {
    backendProcesses.delete(label) // 进程已退出，清理后重起
    persistBackendRegistry()
  }
  // 收养：注册表有存活记录（pid 活着 + 端口就绪）→ 直接接管，不重新 spawn
  // （网关 stop/restart/硬杀后进程仍在跑；服务 hang 死则杀掉清记录防占端口成孤儿）
  const rec = readBackendRegistry()[label]
  if (rec && rec.pid > 0 && rec.port > 0 && isPidAlive(rec.pid)) {
    if (await backendReady(rec.port, cfg.readyPath)) {
      const proc: BackendProc = { pid: rec.pid, port: rec.port, cfg, startedAt: rec.startedAt, lastActive: Date.now(), child: null }
      backendProcesses.set(label, proc)
      persistBackendRegistry()
      console.log(`[gateway] backend ${label}: 收养存活进程 pid=${rec.pid} port=${rec.port}（网关重启不重启后端）`)
      return proc
    }
    killTree(rec.pid) // pid 活着但端口不通：服务 hang 死，清掉防占端口（pid 被复用且恰占原端口的双巧合误杀概率可忽略）
  }
  const pending = backendPending.get(label)
  if (pending) return pending // 探测进行中，等待同一 Promise 结果（不重复 spawn）
  const p = doSpawnBackend(label, cfg)
  backendPending.set(label, p)
  try {
    return await p
  } finally {
    backendPending.delete(label)
  }
}

// 预览后端运行时解析（2026-09-24 便携化定案）：backend 的 cmd[0] 多是裸名（"python"/"node"），
// 按系统 PATH 解析会命中机器级安装或 Microsoft Store 0 字节存根（Pj15/Pj18 事故根因），且换机即失效。
// 前置工作区内置便携 runtime <portableRoot>/.claude/runtime/{python,python/Scripts,node} 即让内置 runtime
// 赢，工作区整体拷走即可用；目录不存在时 PATH 条目被系统静默忽略，行为同既往。
function backendRuntimeDirs(): string[] {
  const base = join(getPortableRoot(), '.claude', 'runtime')
  return [join(base, 'python'), join(base, 'python', 'Scripts'), join(base, 'node')]
}

// cmd 占位符展开（2026-09-25 定案）：{projectRoot}/{previewDir} 让项目后端直接声明根目录参数，
// 不必再自备一份 live_server.py 样板去算路径（Pj18 型 launcher 由此可删）。
// previewDir = <项目>/.claude/preview，恒由 readBackendCfg 回填。
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
  // cmd[0] 若是相对路径（含 / 或 \），node spawn 按进程 cwd 而非选项 cwd 解析 → 手动 resolve 到 cfg.cwd
  if (cmd[0] && !isAbsolute(cmd[0]) && /[\\/]/.test(cmd[0])) cmd[0] = resolve(cfg.cwd, cmd[0])
  // 子进程 stdout/stderr 落盘到该项目自己的 .claude/preview/backend.log（stdio ignore 会丢启动报错，难诊断）
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
    windowsHide: true, // 2026-08-20 黑框根因修复：python.exe 是 console 子系统，不设 windowsHide 每次 spawn 会弹出黑色命令行窗口（用户「黑框=单独弹出的指令框，类似 cmd」）
  })
  // spawn 失败（解释器缺失 ENOENT 等）异步 emit 'error'，无监听即成未捕获异常打死整个网关进程
  // （2026-09-24 Pj13 事故：cmd[0]="node" 本机不存在 → 点开预览即 floria.local 全断）。
  // 记为 spawnError，由就绪探测循环退出后统一抛给调用方（路由回 400，网关存活）。
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
  // 就绪探测：最多 ~24s（冷启动慢的后端如 ComfyUI torch 初始化实测 ~22s）
  let ready = false
  for (let i = 0; i < 120; i++) {
    if (gatewayStopping || child.exitCode !== null || spawnError) break
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
      // spawn 根本没起来（无 'exit'，exit 处理器不会跑）→ 此处收日志 fd 防泄漏
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

function killBackend(label: string): void {
  const p = backendProcesses.get(label)
  if (!p) return
  backendProcesses.delete(label)
  try {
    p.child?.kill()
  } catch {
    /* 忽略 */
  }
  // Windows 兜底：child.kill 不杀进程树，taskkill /T 连子进程一起清（收养的 child=null 直接走这里）
  if (p.pid) killTree(p.pid)
  persistBackendRegistry()
}

// ============================================================================
// Web 容器同源反代助手（2026-08-27）：远程端经网关主端口访问回环后端容器
// ============================================================================
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

/** 上游 Location 重写：127.0.0.1:<port> 绝对地址或根相对路径改写到 /backend 前缀下；其余原样返回 */
function rewriteLocation(loc: string, prefix: string, port: number): string {
  const abs = `http://127.0.0.1:${port}`
  if (loc === abs) return prefix
  if (loc.startsWith(abs + '/')) return prefix + loc.slice(abs.length)
  if (loc.startsWith('/')) return prefix + loc
  return loc
}

// per-backend 上传转发串行队列（2026-08-29 Pj15 上传断流接力包取证）：带 body 的请求并发经
// Bun node:http 兼容层 pipe 泵会卡死（后端日志铁证：同一张图 90s×3 重试全 400，前端降级串行
// 后 25 张全 200），串行后单路 pipe 通畅。同 key 逐个转发，队列空时自清理防 Map 膨胀。
const bpForwardQueues = new Map<string, Promise<void>>()
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

/** 把 /backend/<label>/… 请求原样转发到回环后端 http://127.0.0.1:<port>/…（双向流式管道，媒体大文件不落盘） */
function proxyBackendRequest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  proc: BackendProc,
  prefix: string,
  rawPath: string,
  rawSearch: string,
): void {
  const upHeaders: Record<string, string | string[] | undefined> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase()
    // cookie 必须剥离：不向项目后端泄露 floria_bp 票证
    if (PROXY_HOP_HEADERS.has(lk) || lk === 'host' || lk === 'cookie') continue
    upHeaders[k] = v as string | string[] | undefined
  }
  upHeaders.host = `127.0.0.1:${proc.port}`
  const label = prefix.slice('/backend/'.length)
  // 断流取证（2026-08-29）：已收/声明字节数，半截体一眼定性（误杀=已收远小于声明；真断开=接近声明）
  let receivedBytes = 0
  req.on('data', (c: Buffer) => {
    receivedBytes += c.length
  })
  const contentLen = Number(req.headers['content-length']) || -1
  let upReq: import('node:http').ClientRequest | undefined
  let killed = false
  // 僵尸连接根治（2026-08-28 Pj15 上传卡死移交）：客户端断开必须联动中止上游连接。
  // 此前仅 req 'error' 时 destroy——隧道抖动/刷新页只触发 'aborted'/'close' 不触发 'error'，
  // pipe 不传播断开 → 上游 socket 永挂（请求头已转发、body 永没送齐）→ 后端线程在
  // rfile.read 永久阻塞（事发 12 条 ESTABLISHED 僵尸），死连接同时是网关空闲自旋的燃料。
  const killUpstream = (why: string): void => {
    if (killed) return
    killed = true
    // 请求级断流取证（gateway.log）：来源区分 + 字节计数（upReq 尚未创建的排队期同样可取证）
    console.log(
      `[gateway] /backend ${label}${rawPath} 转发中止: ${why} (已收 ${receivedBytes}/${contentLen < 0 ? '?' : contentLen} 字节)`,
    )
    upReq?.destroy()
  }
  req.on('error', () => killUpstream('客户端请求错误'))
  // body 未收齐客户端就断开（'aborted' 与 close+complete 双保险，覆盖不同运行时语义；文案区分来源）
  req.on('aborted', () => killUpstream('客户端断开(aborted,body 未收齐)'))
  req.on('close', () => {
    if (req.complete === false) killUpstream('客户端断开(close,body 未收齐)')
  })
  // 响应中途客户端消失（刷新/断线）→ 中止上游，后端不再往死管写流
  res.on('close', () => {
    if (!res.writableEnded) killUpstream('客户端断开(响应中途)')
  })

  const forward = async (): Promise<void> => {
    // 轮到转发时客户端已断开/响应已死 → 放弃（避免向上游白转半截体占后端线程）
    if (killed || res.destroyed) return
    const thisReq = httpRequest(
      { host: '127.0.0.1', port: proc.port, method: req.method, path: rawPath + rawSearch, headers: upHeaders },
      (upRes) => {
        const outHeaders: Record<string, string> = {}
        for (const [k, v] of Object.entries(upRes.headers)) {
          const lk = k.toLowerCase()
          // hop-by-hop 与上游 set-cookie 一并剥离（防止上游会话 cookie 泄漏到网关作用域）
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
    // 上游静默超时（180s 无任何数据，与 Pj15 后端 Handler.timeout 对齐）：后端挂死/隧道断流
    // 不再永久滞留连接；正常流式传输只要数据在流就不会触发（按静默计，非总时长）
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

  // 并发上传根治（2026-08-29 取证）：POST/PUT/PATCH（带 body）按 backend label 排队逐个转发；
  // GET/HEAD（无 body，媒体大文件下载）直通不受影响。
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    enqueueBpForward(prefix, forward)
  } else {
    void forward()
  }
}

// 空闲回收：backend 超过 idleMinutes 无活跃 → kill（独立于网关自身空闲回收，
// 因为 iframe 直连后端不经网关，网关三集合可能为空但后端仍被使用中）
function reclaimIdleBackends(): void {
  const now = Date.now()
  for (const [label, p] of [...backendProcesses]) {
    const idleMs = (p.cfg.idleMinutes ?? GATEWAY_IDLE_MINUTES) * 60 * 1000
    if (now - p.lastActive > idleMs) {
      console.log(`[gateway] backend ${label} 空闲超过 ${p.cfg.idleMinutes ?? GATEWAY_IDLE_MINUTES} 分钟，回收`)
      killBackend(label)
    }
  }
}

// ============================================================================
// Web 独立会话实现（2026-08-24 改造：本地可见交互 REPL 窗口，替代 headless 管道转发）
// ============================================================================

/**
 * spawn 一个「本地可见交互 REPL 窗口」作为 web 独立会话（2026-08-24 改造，替代 headless）。
 *
 * 与 headless 的区别：
 *  - 不再传 -p/stream-json（headless 打印模式），改为交互 REPL（正常 ink UI + 终端窗口），
 *    用户在本地可见窗口里可以直接看/操作（审批也在本地窗口弹）。
 *  - 通信不再走 stdin/stdout 管道：交互 REPL 启动后由 CLI 侧 gatewayClient 连 /clients 注册
 *    sessionId（interactiveHelpers.renderAndRun → startGatewayProbeAndConnect），web 消息经
 *    cliClients 精确路由注入 REPL（gatewayClient enqueue，与本地打字同路径）；
 *    展示走 conversationDisplay 上报（/gateway/conversation）+ jsonl 落盘 + SSE 列表刷新。
 *  - 窗口通过 PowerShell Start-Process -PassThru 弹出（复用 deepLink/terminalLauncher 的
 *    可见终端思路；-PassThru 返回真实 CLI pid 供 stopWebSession taskkill）。
 *
 * resume 提供 → 恢复已有会话（--resume <id>）；否则新会话由网关预分配 UUID 经 --session-id
 * 传给子进程（main.tsx 支持 --session-id <uuid>：'Use a specific session ID for the
 * conversation (must be a valid UUID)'），CLI 转录 init 首行即带该 id，jsonl 落盘
 * <项目根>/.claude/projects/<id>.jsonl。
 * project 提供（2026-08-24）→ 在指定项目下新建/恢复会话（cwd = 该项目根）；未指定 → 默认项目根。
 * resolve 在 CLI 完成 /clients 注册后返回 sessionId（保证 web 首条消息可注入，不丢消息）；
 * 注册超时（CLI 启动失败/网关未探测到）→ reject。
 */
// 2026-09-06 wsession 异步化配套（首条消息单状态根治）：
//   spawningPromises = spawn 在途登记（预分配 sid 后台 spawn；同 sid 并发调用——wsession 与
//   resumeAndDeliver 竞速——复用同一 promise，防双进程双写同一 jsonl）；settle 即清。
//   pendingDeliveries = spawn/注册完成前到达的消息暂存（send 路由入队），CLI /clients 注册钩子
//   flushPendingDeliveries 按序补投——原「web 会话启动中，请稍后再发送」丢弃路径根除。
const spawningPromises = new Map<string, Promise<string>>()
// 2026-09-07 wt 直并：cli-hello 上报的 pid 暂存（wt.exe 中转即退，注册成功前 cli-hello 到达时
// webSessions 尚无该 sid）。spawnWebSession 注册成功时取走填入；仅 spawn 在途（spawningPromises
// 命中）才暂存，普通 CLI 主进程的 cli-hello 不入此表防泄漏。
const cliHelloPids = new Map<string, number>()
// 2026-09-15 存整帧而非 {text, images}：send 与会话间 session-message 帧型不同，暂存层不该只认一种
// （投递三形态路由共同维护，见 deliverToSession）。
const pendingDeliveries = new Map<string, Record<string, unknown>[]>()

// CLI /clients 注册钩子调用：spawn 期间暂存的消息按序补投。cliClients 刚 set（注册即 OPEN），
// 不 OPEN 则保留等下次注册再投（断连重连同钩子触发）——不丢消息。投递形态与路由直投一致（整帧原样）。
function flushPendingDeliveries(sessionId: string): void {
  const q = pendingDeliveries.get(sessionId)
  if (!q?.length) return
  const t = cliClients.get(sessionId)
  if (!t || t.readyState !== WebSocket.OPEN) return
  pendingDeliveries.delete(sessionId)
  for (const frame of q) t.send(JSON.stringify(frame))
}

function spawnWebSession(
  resume: string | undefined,
  project: string | undefined,
  sidForNew?: string,
  /** 会话启动模型（2026-10-13）：新建 = 调用方显式指定（wsession body.model / session-create 帧
   *  model，均为池内模型名，校验在调用方）；resume 缺省查 sessionModelLaunch 启动模型表。
   *  显式传参恒优先于表（表只做缺省回落）。落到 --model 启动参数——CLI 启动段把 options.model
   *  固化为会话覆盖并按 findModelProvider 绑定 provider（凭据与模型名同源），先于一切帧与消息，
   *  无投递时序问题。复用分支（活进程/近期注册痕迹）不消费模型：活进程已在跑，不注入切换。 */
  opts?: { model?: string },
): Promise<string> {
  // 安全卸载已接受：拒绝任何新进程落在即将拔除的卷上（响应先于网关退出，此窗内不得再 spawn）
  if (ejecting) return Promise.reject(new Error('网关正在安全卸载'))
  // 幂等：resume 的会话进程已在跑（前端切走再切回）→ 复用现有进程，不重复 spawn（双进程会双写同一 jsonl）
  // 2026-09-10 复用前验活：账面记录 ≠ 进程活性（死记录直接 resolve → 注入轮询 5s miss → 消息
  // 未注入丢失）。死记录清理后走正常 spawn；防双写不破——死进程不写盘，活进程重连窗口仍由
  // 下方 cliRegisterAt 近期注册痕迹保护兜住（不 spawn）。
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
  // 2026-08-31 防双进程根修：近期有 /clients 注册痕迹 = 活进程在断连重连 → 复用不 spawn
  //（双进程乒乓根因，见 cliRegisterAt 注释）。wsession（点开会话）与 resumeAndDeliver（发送
  // 即 resume）两个调用路径同时受保护。边界：进程刚死 10s 内 resume 会误判复用 → 注入轮询
  // 5s miss 后报「未注入」，重发即正常（痕迹超窗）。若真进程活着，它重连回来即恢复路由。
  const lastReg = resume ? cliRegisterAt.get(resume) : undefined
  if (resume && lastReg && Date.now() - lastReg < CLI_RECENT_REGISTER_MS) {
    console.log(`[gateway] wsession: 近期注册痕迹（${Date.now() - lastReg}ms 前），复用活进程不 spawn sid=${resume}`)
    return Promise.resolve(resume)
  }
  // 新建场景 sid 由 wsession handler 预分配传入（异步化：响应需先于 spawn 返回）；resume 场景 sid=resume
  const sid = resume ?? sidForNew ?? randomUUID()
  // spawn 在途：同 sid 并发调用复用同一 promise（2026-09-06，异步化后 wsession 与 resumeAndDeliver 可竞速）
  const inflight = spawningPromises.get(sid)
  if (inflight) return inflight
  // resume 未显式指定项目时，按磁盘会话文件定位项目（项目会话切回后仍落在原项目，web/CLI 一视同仁）
  let effectiveProject = project
  if (resume && !effectiveProject) {
    effectiveProject = sessionProjectRootOf(resume)?.projectLabel
  }
  const p = new Promise<string>((resolve, reject) => {
    const args = resume ? ['--resume', resume] : ['--session-id', sid]
    // 启动模型（2026-10-13）：显式指定 > 启动模型表（仅 resume 有表可查，新建 sid 全新无表）；
    // 校验在调用方（wsession/session-create 均经 findModelProvider），此处透传。
    const launchModel = opts?.model?.trim() || (resume ? sessionModelLaunch.get(sid)?.model : undefined)
    if (launchModel) args.push('--model', launchModel)
    // cwd = 项目根（指定项目 → 该项目根）：会话 jsonl 落盘到 <项目根>/.claude/projects/<sessionId>.jsonl（与 CLI 同目录）
    const cwd = webSessionProjectRoot(effectiveProject)
    // 2026-09-07 根治定案：wt.exe -w last nt 直并最近 WT 窗口（无窗自动开新窗），启动链彻底脱离
    // 系统默认终端委托（defterm）。背景：25H2 更新把 defterm 激活链本身弄坏（注册表配置正确仍全落
    // conhost 老式黑窗——用户所见「管理员指令框」置顶抢眼、多窗不合并），配置层无解；原 powershell
    // Start-Process 链依赖 defterm 托管，系统更新随时可能再坏。改为网关直接调 wt.exe，行为不再随
    // defterm 配置漂移。配套：①真实 CLI pid 由 cli-hello 上报补填（wt 自身即退拿不到）；
    // ②端口落盘 .claude/gateway/port（并入已存在 WT 窗口时新标签继承旧 WT 进程环境，FLOIRA_GATEWAY
    // 传不到 → CLI env 缺失时读盘发现，见 gatewayToken.ts）。
    // 2026-08-31 根修不变：exe 一律网关自身（协议必然匹配；目录扫描旧案已废，见 webSessionExe 注释）
    const exe = webSessionExe()
    const gwUrl = `http://127.0.0.1:${currentPort}`
    // 2026-08-31 取证日志（20260830222122 事故：spawn 全程零日志，「日志无失败记录」是假象）
    console.log(
      `[gateway] wsession: spawn 开始 resume=${resume ?? '新建'} sid=${sid} project=${effectiveProject ?? '(笔/全局根)'} model=${launchModel ?? '(默认)'} exe=${exe} cwd=${cwd}`,
    )
    let child: import('node:child_process').ChildProcess
    try {
      child = spawn('wt.exe', ['-w', 'last', 'nt', '-d', cwd, exe, ...args], {
        env: { ...process.env, FLOIRA_GATEWAY: gwUrl, FLORIA_IN_WT: '1' },
        // 不设 windowsHide（2026-09-09 双启动根因）：SW_HIDE 随 STARTUPINFO 被 -w last 无窗时
        // 新开的 WindowsTerminal 继承 = 首窗创建即隐藏；wt.exe 是 GUI 子系统，无黑窗可防。
        stdio: 'ignore',
      })
    } catch (e) {
      reject(e as Error)
      return
    }
    // 等 CLI 完成 /clients 注册（cliClients.has(sid)）——注册成功即 resolve；
    // 超时（wt 打开失败/CLI 未能探测到网关）→ reject（wt pid 即退，无中转进程可杀）。
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
        resolve(sid)
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
    // wt.exe 启动成功即正常退出（exit 0）——它退出不代表 CLI 窗口关闭，不在此清 timer。
    // 非 0 退出且未注册 → wt 命令本身失败（无 WT/命令被拒），提前 reject 避免空等 20s。
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
  // 2026-09-11 根治（②「web 发送信息，cli 侧无法正常 resume 并运行；手动 resume 后发送的信息自动出现」）：
  // spawn 在途登记必须 settle 即清。此前只 set 无 delete（全文件零 delete）⇒ 该会话首次 spawn 后条目
  // 永久驻留（含已 settle 的 promise）：① 上方 `inflight` 幂等短路恒命中旧 promise，再也 spawn 不起来；
  // ② send 路由 `spawningPromises.has(sid)` 恒真 → 消息全落 pendingDeliveries 等一个永不再来的注册。
  // 用户手动 resume（CLI 侧原生 --resume，不经此表）注册成功 → /clients 钩子 flushPendingDeliveries
  // 补投 → 消息「自己出现」。新建会话 sid 每次新分配、不经此表 → 用户观察「开启会话是正常的」。
  // 不变量：spawningPromises 里的条目恒为「真在途、未 settle」的 spawn。
  const tracked = p.finally(() => {
    spawningPromises.delete(sid)
  })
  spawningPromises.set(sid, tracked)
  return tracked
}

// 2026-08-24 web 会话改造：web 消息经 cliClients 注入（CLI 侧 gatewayClient enqueue），
// 审批在本地窗口操作 → 原 stdin 管道函数 sendWebSessionMessage/handleWebApproval 已删除。

/**
 * 优雅停 CLI 进程（2026-09-08 协议，web spawn 与终端直开两会话形态共用）：先经 /clients 通路
 * 请 CLI 自行退出（gatewayClient 收 shutdown → 停重连 → exit 0）——WT 的 closeOnExit=graceful
 * 只对 exit 0 自动收 tab，taskkill 强杀 exit 1 会残留「已退出进程，代码为 1」提示页（wt 直并
 * 链副作用，用户实测）。3s 后进程仍活再树杀兜底（覆盖 WS 已断、收不到 shutdown 的 CLI，含旧
 * exe 无 shutdown handler 的进程）。shutdown 按 sid 精确单发（cliClients.get），非广播不波及
 * 其它会话。
 */
function gracefulStopCli(sid: string, pid: number | undefined): void {
  const sock = cliClients.get(sid)
  if (sock) {
    try { sock.send(JSON.stringify({ type: 'shutdown' })) } catch { /* 断开忽略，走兜底 */ }
  }
  if (pid && isPidAlive(pid)) {
    setTimeout(() => {
      // 豁免版树杀：会话里跑 /server on 会把网关挂到该会话进程树下，普通 /T 会连坐杀网关
      if (isPidAlive(pid)) killTreeExcept(pid, process.pid)
    }, 3000)
  }
}

/**
 * 优雅停 web 会话：关闭本地可见 CLI 窗口（gracefulStopCli 优雅退出协议，窗口随之关闭）。
 * 仅用于用户显式关闭单个会话/超时清理；网关自身关停（off/restart/空闲/SIGINT）不得走这里——
 * web 会话与 CLI 会话同等权重，网关不在了窗口照常活着（2026-08-29 重启杀窗根修）。
 */
function stopWebSession(sessionId: string): boolean {
  const p = webSessions.get(sessionId)
  if (!p) return false
  webSessions.delete(sessionId)
  persistWebSessions()
  gracefulStopCli(sessionId, p.pid)
  return true
}

// ============================================================================
// 安全卸载（2026-11-10）：拔除外置盘前把卷上所有 Floria 进程一次收干净。
// 与 /gateway/shutdown（/server off）的分工：后者按 2026-08-28/29 定案只停网关，会话窗口与卡片
// 后端故意存活；eject 是显式的「全关」动词，顺序 = 请所有 CLI 优雅退出 → 超时树杀 → 停全部
// 卡片后端 → 停 SSE watcher → 网关自身退出。不改变既有 /server off 语义。
// 不变量：接受 eject 后不再 spawn 新会话/后端（ejecting 与 gatewayStopping 双门）。
// ============================================================================
let ejecting = false

interface EjectTarget {
  sessionId: string
  pid?: number
}

function collectEjectSessions(): EjectTarget[] {
  const sids = new Set<string>([...cliClients.keys(), ...webSessions.keys()])
  return [...sids].map((sessionId) => ({
    sessionId,
    pid: webSessions.get(sessionId)?.pid ?? cliPids.get(sessionId) ?? sessionActivity.get(sessionId)?.pid,
  }))
}

/** 返回快照；实际收尾异步执行（响应必须先发出，网关随后退出）。重复调用返回 null。 */
function beginSafeEject(): { sessions: EjectTarget[]; backends: string[] } | null {
  if (ejecting) return null
  ejecting = true
  gatewayStopping = true
  const sessions = collectEjectSessions()
  // 后端清单 = 本运行期 Map + 落盘注册表：注册表里可能有上一代网关遗留、本代尚未懒加载收养的存活进程
  const registry = readBackendRegistry()
  const backends = [...new Set([...backendProcesses.keys(), ...Object.keys(registry)])]
  // 先请在线 CLI 自行退出（gatewayClient 收 shutdown → exit 0，WT 自动收 tab）
  for (const sock of cliClients.values()) {
    try {
      sock.send(JSON.stringify({ type: 'shutdown' }))
    } catch {
      /* 断开忽略，走树杀兜底 */
    }
  }
  void (async () => {
    // 给优雅退出留时间（与单会话关闭的 3s 树杀窗口同量级，另加 1s 余量）
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && cliClients.size > 0) {
      await new Promise((r) => setTimeout(r, 100))
    }
    // 仍在的进程逐个树杀；killTreeExcept 豁免网关自身（网关常是某个会话的子进程）
    for (const t of sessions) {
      if (!t.pid || !isPidAlive(t.pid)) continue
      try {
        killTreeExcept(t.pid, process.pid)
      } catch (e) {
        console.warn(`[gateway] eject: 会话 ${t.sessionId} 树杀失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    // 停全部卡片后端（含收养的 child=null 条目，killBackend 内部走 killTree）
    for (const label of [...backendProcesses.keys()]) {
      try {
        killBackend(label)
      } catch {
        /* 单个失败不阻塞卸载 */
      }
    }
    // 注册表里的进程未被本代收养（懒加载尚未触达）→ 按记录 pid 直接树杀，再清空注册表
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
    stopLocalGateway()
    process.exit(0)
  })()
  return { sessions, backends }
}

// 2026-09-10 账面活性判定（send 暂存分支 / spawn 幂等复用 / reclaim 三处共用一判）：
// webSessions 记录 ≠ 进程活性（pid 由 cli-hello 上报补填，旧 exe 或上报缺失则 pid 空）。
// 权威信号：pid 已知 → isPidAlive；pid 空 → cliClients WS 在（WS 由进程发起，连接在即进程在）。
// 无记录 → false。守护的不变量：账面记录命中「存续」判定时，必有活进程或其活跃连接可承接消息/复用。
function webSessionEntryAlive(sid: string): boolean {
  const p = webSessions.get(sid)
  if (!p) return false
  return p.pid ? isPidAlive(p.pid) : cliClients.has(sid)
}

// 空闲回收：web 会话（本地可见交互 CLI 窗口）生命周期由用户本地操作决定——进程活着不回收
// （lastActive 只是网关侧活跃，本地窗口用户可能正直接操作）；仅清理「进程已死」的残留注册。
// 2026-09-10 判活统一走 webSessionEntryAlive：原条件 `p.pid && !isPidAlive(p.pid)` 对 pid 空
// 记录恒不清（孤儿注册永存，恒挡 send 暂存分支）。边界：活进程 WS 重连间隙（≤30s backoff）
// 恰逢 60s 步进被清记录 → 后续 send 走 resumeAndDeliver → spawnWebSession 由 cliRegisterAt
// 近期注册痕迹保护复用不 spawn，无双写风险。
function reclaimIdleWebSessions(): void {
  let changed = false
  for (const [sid, p] of [...webSessions]) {
    if (webSessionEntryAlive(sid)) continue
    console.log(`[gateway] web 会话 ${sid} CLI 进程已退出，清理运行注册`)
    webSessions.delete(sid)
    changed = true
  }
  if (changed) persistWebSessions()
}

// P2 收敛（2026-08-27）：backend 与 web 会话原是两套平行 setInterval 回收样板（同 ENABLE_IDLE_RECLAIM
// 门控、同 60s 步进），合并为单一 interval 依次跑两份清扫；停止时在 stopLocalGateway 统一 clearInterval。
let reclaimTimer: NodeJS.Timeout | null = null
function scheduleReclaim(): void {
  if (!ENABLE_IDLE_RECLAIM || reclaimTimer) return
  reclaimTimer = setInterval(() => {
    reclaimIdleBackends()
    reclaimIdleWebSessions()
  }, 60 * 1000)
  reclaimTimer.unref?.()
}

function scheduleIdleShutdown(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (!ENABLE_IDLE_RECLAIM || hasClients()) return
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (hasClients()) return // 计时期间已有连接，放弃回收
    console.log(`[gateway] 无任何客户端连接，空闲超过 ${GATEWAY_IDLE_MINUTES} 分钟，自动关闭`)
    stopLocalGateway()
    process.exit(0)
  }, GATEWAY_IDLE_MINUTES * 60 * 1000)
  idleTimer.unref?.()
}

// 2026-09-11 ① 协议级心跳（web⇄CLI「总是显示连接中断」根修）：/ws 与 /clients 都是长连接，此前
// 两侧判活只靠 TCP FIN——对端进程消失/链路半开（改网、睡眠唤醒、中间设备静默断流、NAT 超时）时不产生
// FIN，连接永久滞留 ESTABLISHED：网关侧表现为 cliClients/sockets 里的僵尸（send 进黑洞、而
// webSessionEntryAlive 的 `cliClients.has(sid)` 判活又据此误判「活进程」→ send 路由暂存兜住不投），
// 浏览器侧表现为 connUp 该断不断或该连不连、永不自愈。ping/pong 是唯一不依赖 FIN 的判活手段
// （两侧实现都自动回 pong：浏览器按 RFC 6455 由网络层应答，CLI 侧 ws 客户端默认 autoPong）。
// 不变量：sockets/cliClients 里的连接恒为「最近一个心跳窗内可应答」的活连接——僵尸在 ≤60s 内被回收，
// 上层判活/路由/暂存分支据此看见真相。
const HEARTBEAT_INTERVAL_MS = 30_000
// 连续 2 次无 pong（≈60s）才判死：> 事件循环可预见的最长阻塞（重任务/大批量向量推理），避免误杀活连接。
const HEARTBEAT_MAX_MISS = 2
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
const wsMisses = new WeakMap<WebSocket, number>()
/** 挂进每个 WS 连接：pong 到达即清零未应答计数（markAlive 在 /ws 与 /clients 两处接入）。 */
function markAlive(ws: WebSocket): void {
  wsMisses.set(ws, 0)
  ws.on('pong', () => wsMisses.set(ws, 0))
}
function startSocketHeartbeat(): void {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => {
    for (const c of [...sockets, ...cliClients.values()]) {
      if (c.readyState !== WebSocket.OPEN) continue
      const misses = wsMisses.get(c) ?? 0
      if (misses >= HEARTBEAT_MAX_MISS) {
        console.log(`[gateway] 心跳超时（${HEARTBEAT_MAX_MISS} 次无 pong），回收僵尸连接`)
        try {
          c.terminate()
        } catch {
          /* 已断忽略 */
        }
        continue
      }
      wsMisses.set(c, misses + 1)
      try {
        c.ping()
      } catch {
        /* 已断忽略，下轮 readyState 检查兜住 */
      }
    }
  }, HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref?.()
}
function stopSocketHeartbeat(): void {
  if (!heartbeatTimer) return
  clearInterval(heartbeatTimer)
  heartbeatTimer = null
}

// ——SSE 应用层命名 heartbeat（2026-10-14 GPT 定案第一阶段③⑤）——
// 旧形态：SSE 只写 hello 无任何活性机制，网关对半开死对端恒写成功 → 永不摘除 sseClients，
// 前端 onerror 永不触发 → 冻结到 F5。根治 = 服务端 15s 写命名心跳（`event: heartbeat` +
// data JSON——`: ping` 注释浏览器拿不到，无效），兼作服务端背压探测：write 返回 false 记
// stuckSince，超 SSE_BACKPRESSURE_DESTROY_MS 未恢复 drain 即 destroy 摘除；写异常/close/error
// 从名册移除。客户端侧 45s watchdog（web-src live.js）看「长时间没收到任何数据」自行重建。
// 两侧不可互替：服务端查写入错误/背压，客户端查下行断流。
const SSE_HEARTBEAT_INTERVAL_MS = 15_000
const SSE_BACKPRESSURE_DESTROY_MS = 30_000
let sseHeartbeatTimer: ReturnType<typeof setInterval> | null = null
function startSseHeartbeat(): void {
  if (sseHeartbeatTimer) return
  sseHeartbeatTimer = setInterval(() => {
    const frame = `event: heartbeat\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`
    for (const c of [...sseClients]) {
      if (c.res.destroyed || c.res.writableEnded) {
        sseClients.delete(c)
        continue
      }
      // 背压长期不恢复 → 销毁连接：客户端 onerror → 3s 重连 → hello 全量对账（靠监督者，不靠时序侥幸）。
      if (c.stuckSince !== undefined && Date.now() - c.stuckSince > SSE_BACKPRESSURE_DESTROY_MS) {
        console.log('[gateway] SSE 背压超时，销毁连接交由客户端重连')
        sseClients.delete(c)
        try {
          c.res.destroy()
        } catch {
          /* 已断忽略 */
        }
        scheduleIdleShutdown()
        continue
      }
      try {
        if (!c.res.write(frame)) {
          if (c.stuckSince === undefined) c.stuckSince = Date.now()
        } else {
          c.stuckSince = undefined
        }
      } catch {
        sseClients.delete(c)
        scheduleIdleShutdown()
      }
    }
  }, SSE_HEARTBEAT_INTERVAL_MS)
  sseHeartbeatTimer.unref?.()
}
function stopSseHeartbeat(): void {
  if (!sseHeartbeatTimer) return
  clearInterval(sseHeartbeatTimer)
  sseHeartbeatTimer = null
}

// 2026-08-31 取证强化：网关日志逐行加 [MM-DD HH:MM:SS] 时间戳。落盘是 fd 重定向（server.ts
// spawnGatewayProcess stdio 直传 fd），无法在落盘侧加前缀 → 输出侧劫持 console。startLocalGateway
// 仅 --gateway 独立进程调用（cli.tsx fast-path），不影响 CLI 进程自身输出。2026-08-30 新会话
// 事故：日志无时间戳严重妨碍取证（「多次重启发生在何时」无法判读）。
let gatewayConsoleStamped = false
function stampGatewayConsole(): void {
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

export function startLocalGateway(opts?: { host?: string; port?: number; token?: string }): LocalGatewayInfo {
  stampGatewayConsole()
  gatewayStopping = false
  if (server) {
    const lan = lanAddress()
    return {
      port: currentPort,
      host: currentHost,
      token: currentToken,
      lanUrl: lan ? `http://${lan}:${currentPort}/?token=${currentToken}` : '',
      localUrl: `http://127.0.0.1:${currentPort}/?token=${currentToken}`,
    }
  }
  currentHost = opts?.host || process.env.GATEWAY_HOST || '0.0.0.0'
  currentPort = Number(opts?.port || process.env.GATEWAY_PORT || 8124)
  // 2026-09-18 token 竞态根治：读盘-or-创建的稳定密钥。盘上有值即复用——多进程抢起网关时
  // 各方持有同一秘密，竞态从「毒化源」降级为无害事件（败者转 client 后天然可注册赢家）；
  // 显式 opts/env 覆盖仍最高；盘上无值（首次启动或 /server off 清盘后）才随机生成。
  // 旧版每次随机：12:48 事故中两个 CLI 各自拉起 --gateway 子进程，两把不同密钥竞速 bind，
  // 胜者 token 与败者已写盘的 token 分裂 → 所有 CLI 读盘注册全 401（侧栏无状态/web 误
  // spawn resume/消息悬空/会话退化折叠，2026-09-18 实证）。
  currentToken = opts?.token || process.env.SERVER_TOKEN || loadGatewayTokenFromDisk() || randomBytes(16).toString('hex')
  // 共享 token：CLI 侧上报（conversationDisplay.ts /gateway/conversation、/gateway/activity）据此附加校验参数。
  setGatewayToken(currentToken)
  // 落盘移至 listen 成功回调（下方）：不变量「盘上 token/port 恒描述现网关，只有端口持有者可发布」。
  // 旧序（先写盘后 bind）下 bind 失败者（EADDRINUSE）会把败者 token 覆盖盘上胜者 token——即 12:48
  // 事故的直接成因。2026-09-07 wt 直并配套的端口落盘（env 缺失时 CLI 的发现通道）同批迁移。
  const root = getPortableRoot()
  // 收养上一代网关遗留的存活 web 会话窗口（注册表落盘，重启不杀窗 → 必须收养，否则 resume 幂等失效双开进程）
  adoptWebSessions()
  loadTurnEndAt() // 2026-09-07 恢复上一代网关的打断收口时刻（落盘见 turnEndAt 注）
  loadSessionModelLaunch() // 2026-10-13 恢复会话启动模型表（resume 带 --model 的缺省源，见表注）
  // 启动即挂上空闲回收计时：此时无任何连接，若后续一直无人使用，到点自动关闭
  scheduleIdleShutdown()
  // backend（2026-08-19）与 web 会话（2026-08-23）空闲回收合并定时器（P2 收敛，独立于网关自身空闲回收）
  scheduleReclaim()

  server = createServer((req, res) => handleRequest(req, res, root))
  // CLOSE_WAIT 收尸（2026-08-28）：对端半关（发来 FIN、我方一直不关）的 socket 会永久滞留
  // CLOSE_WAIT——实测网关空闲积压 8+ 条，死连接是事件循环空转烧 CPU 的燃料（事发 0.76 核）。
  // 对 'end'（对端 FIN 已收）回应自己的 FIN：keep-alive 对端关了就该收，WS 场景对端 FIN 即关闭流程。
  server.on('connection', (socket) => {
    socket.on('end', () => {
      if (!socket.writableEnded) socket.end()
    })
  })
  wss = new WebSocketServer({ noServer: true })
  startSocketHeartbeat() // ① 心跳：/ws 与 /clients 的僵尸连接回收（stopLocalGateway 统一停）
  startSseHeartbeat() // ② SSE 命名心跳：活性探测 + 背压回收（stopLocalGateway 统一停）
  wss.on('connection', (ws, req) => {
    sockets.add(ws)
    wsDevice.set(ws, deviceHintOf(req)) // 卡片能力表的设备标签（仅展示/人工分辨用）
    markAlive(ws) // 心跳接驳：/ws 断链检测（僵尸回收，见 startSocketHeartbeat）
    scheduleIdleShutdown()
    // 2026-08-27 移除「connected」状态广播：此前每次 WS 连接 broadcast {type:'status',state:'connected'}，
    // 前端把它渲染成 chat 区系统行「· connected」；该提示无消费价值（其它 status 状态保留），故根因删除。
    ws.on('message', (data) => {
      handleWsMessage(ws, data.toString())
    })
    ws.on('close', () => {
      sockets.delete(ws)
      dropCardHolder(ws) // 卡片能力表随连接消失：在途卡片调用当场收口（504 设备已断开）
      detachWebSessionClient(ws) // 2026-08-24 订阅修复：断开即摘除 web 会话订阅
      scheduleIdleShutdown()
    })
    ws.on('error', () => {
      sockets.delete(ws)
      dropCardHolder(ws)
      detachWebSessionClient(ws)
      scheduleIdleShutdown()
    })
  })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`)
    // 2026-08-28 与 HTTP 一致：网关 token（CLI 内部链路）或 floria_auth cookie 票证二选一；
    // 浏览器授权全靠 cookie（/gateway/activate 配对激活时种下），URL 无 token。
    const wsToken = url.searchParams.get('token') || ''
    const qOk = wsToken !== '' && wsToken === currentToken
    const wsCookieVal = parseCookieHeader(req.headers.cookie)[AUTH_COOKIE_NAME]
    const cOk = isGatewayTicket(wsCookieVal)
    if (!qOk && !cOk) {
      socket.destroy()
      return
    }
    // 授权设备活跃回写（WS 长连接是设备在线的主要形态，upgrade 即更新 UA/IP/lastSeen；
    // 设备自报类型 hint 一并更新——存量票证不经 activate，靠 WS 重连补齐）
    if (cOk) {
      const hint = (url.searchParams.get('device') || '').trim()
      touchGatewayTicket(wsCookieVal, req.headers['user-agent'], remoteIPv4(req.socket.remoteAddress), hint || undefined)
    }
    if (url.pathname === '/ws') {
      // 遥测端（浏览器 floria）连接
      wss?.handleUpgrade(req, socket, head, (ws) => {
        wss?.emit('connection', ws, req)
      })
      return
    }
    if (url.pathname === '/clients') {
      // 2026-08-17 CLI 进程客户端：query 带 session=<uuid>，注册进 cliClients，
      // 遥测端消息经 send 分支转发过来，由 CLI 侧注入其 REPL。不 emit wss 'connection'
      // （不进遥测 broadcast 集合，避免遥测状态误发给 CLI）。
      const sid = url.searchParams.get('session') || ''
      if (!sid) {
        socket.destroy()
        return
      }
      wss?.handleUpgrade(req, socket, head, (ws) => {
        markAlive(ws) // 心跳接驳：/clients 断链检测（僵尸回收，见 startSocketHeartbeat）
        const prev = cliClients.get(sid)
        if (prev && prev !== ws) {
          // 2026-08-31 取证（同步异常根修）：重复注册顶替旧连接此前零日志（盲区）——高频出现
          // 即「同会话双进程乒乓」（两进程注册同一 sid 互踢，消息路由 50% miss，2026-08-30 92bbd49b 实锤）。
          console.log(`[gateway] /clients 重复注册顶替旧连接 sid=${sid}（高频出现=同会话双进程乒乓）`)
          try {
            prev.close()
          } catch {
            /* 忽略 */
          }
        }
        cliClients.set(sid, ws)
        cliRegisterAt.set(sid, Date.now())
        approvalTrailPush('cli-register', sid)
        ensureSseWatches(root) // P0：新 CLI 会话上线（web spawn / 终端在全新项目首开会话）→ 补齐其落盘目录 watch
        flushPendingDeliveries(sid) // 2026-09-06 wsession 异步化：spawn 期间暂存的消息按序补投
        // 2026-09-07 断连感知闭环：注册成功=会话进程回归，SSE 群发 session-up → web 清「已断开」
        // 提示并刷新（状态点恢复由 CLI 注册后的 activity 上报/60s 心跳兜底，网关不代答状态）。
        {
          const s = `data: ${JSON.stringify({ type: 'session-up', session: sid })}\n\n`
          sendAll(sseClients, (c) => { c.res.write(s) })
        }
        scheduleIdleShutdown()
        // 2026-08-24 审批双操作（web 与 CLI 均可）：CLI 交互权限弹窗经 /clients 上报审批请求，
        // 网关转 floria 审批卡；本地先操作/请求撤销 → 通知 floria 撤卡。
        ws.on('message', (data) => {
          let m: {
            type?: string
            requestId?: string
            toolName?: string
            input?: unknown
            toolUseId?: string
            description?: string
            suggestions?: unknown
            blockedPath?: string
            response?: unknown
            items?: unknown
            /** 2026-09-10 任务清单快照（TodoV2 可见清单，见 task-state 分支） */
            tasks?: unknown
            active?: unknown
            pid?: unknown
            seq?: unknown
            /** 2026-09-10 协议根修：delta 对齐键（旧数字坐标 base 已废弃，见 conversationDisplay.buildDisplayDelta） */
            anchorSid?: unknown
            messages?: unknown
            /** 2026-09-15 会话间协作：跨会话消息的收发（发送端已解析好的目标 sid + 来源会话标识） */
            toSessionId?: unknown
            from?: unknown
            /** 2026-09-20 会话间协作·拉起新会话：新会话落在哪个项目的 label（见 session-create 分支） */
            project?: unknown
          }
          try {
            m = JSON.parse(data.toString())
          } catch {
            return
          }
          // 2026-08-24 中继握手：记录 CLI 是否带审批/提问中继代码（relay:true = 新代码）
          if (m.type === 'cli-hello') {
            // 2026-09-08 事件流统一：cli-hello = 进程身份确立，seq 流随进程重启归 1 →
            // 旧记账作废（否则新进程首条 delta 被「seq <= last」去重永久吞掉，web 卡死）。
            sessionDeltaSeq.delete(sid)
            approvalTrailPush('cli-hello', sid, undefined, m.relay === true ? 'relay-on' : 'relay-off')
            // 2026-09-07 wt 直并：真实 CLI pid 由 cli-hello 上报（wt.exe 中转即退，网关拿不到）。
            // spawn 在途（webSessions 尚无此 sid）→ 暂存，spawnWebSession 注册成功时取走填入；
            // 已入库 → 直接补填。普通 CLI 主进程（非 web spawn）不入暂存表。
            if (typeof m.pid === 'number' && m.pid > 0) cliPids.set(sid, m.pid)
            if (typeof m.pid === 'number' && m.pid > 0 && (webSessions.has(sid) || spawningPromises.has(sid))) {
              const proc = webSessions.get(sid)
              if (proc && proc.pid !== m.pid) {
                proc.pid = m.pid
                persistWebSessions()
              } else if (!proc) {
                cliHelloPids.set(sid, m.pid)
              }
            }
            return
          }
          // 2026-08-30 队列快照（清单#2）：CLI commandQueue 当前排队项 → 存 per-session +
          // SSE 群发（事件体直接带 items，前端免拉 /gateway/session 即更新置底排队区）。
          // items 为全量快照（CLI 侧 enqueue/dequeue 后都重发），网关只做镜像存储+转发。
          if (m.type === 'queue-state') {
            // from（2026-09-15 会话间协作）：跨会话来件的来源，形状与 session-message 下行同款
            // （title 必有、sid 可选）；网关只做形状边界（长截断），标题的 HTML 转义归渲染端
            const items = Array.isArray(m.items)
              ? (m.items as Array<{ content?: unknown; ts?: unknown; from?: unknown }>)
                  .filter(it => it && typeof it === 'object' && typeof it.content === 'string')
                  .map(it => {
                    const f = it.from as { sid?: unknown; title?: unknown } | undefined
                    const from = f && typeof f === 'object' && typeof f.title === 'string' && f.title
                      ? { title: f.title.slice(0, 200), ...(typeof f.sid === 'string' && f.sid ? { sid: f.sid.slice(0, 200) } : {}) }
                      : undefined
                    return {
                      content: (it.content as string).slice(0, 2000),
                      ts: typeof it.ts === 'number' ? it.ts : Date.now(),
                      ...(from ? { from } : {}),
                    }
                  })
              : []
            sessionQueues.set(sid, { items, updatedAt: Date.now() })
            sweepStaleMaps()
            const s = `data: ${JSON.stringify({ type: 'queue-state', session: sid, items })}\n\n`
            sendAll(sseClients, (c) => { c.res.write(s) })
            return
          }
          // 2026-09-10 底栏任务浮窗：CLI TodoV2 清单快照（useTasksV2 单源出口）→ 存 per-session +
          // SSE 群发（事件体直接带 tasks，前端免拉 /gateway/session 即更新浮窗）。tasks 为全量
          // 快照（空数组 = 清单清空/隐藏 → 前端整浮窗不出现），网关只镜像+转发，不做渲染语义。
          if (m.type === 'task-state') {
            const tasks = normalizeGatewayTasks(m.tasks)
            sessionTasks.set(sid, { tasks, updatedAt: Date.now() })
            sweepStaleMaps()
            const s = `data: ${JSON.stringify({ type: 'task-state', session: sid, tasks })}\n\n`
            sendAll(sseClients, (c) => { c.res.write(s) })
            return
          }
          // 2026-09-04 压缩实时态：CLI onCompactProgress → /clients WS {type:'compact-state', active}
          // → SSE 群发（无状态转发，web 自持 per-session 标记）。压缩进行中 jsonl 零写入（boundary+
          // summary 同毫秒落盘于结束时刻），SSE 'updated' 不会来——本事件是 web「正在压缩」唯一实时源。
          if (m.type === 'compact-state') {
            const s = `data: ${JSON.stringify({ type: 'compact-state', session: sid, active: m.active === true })}\n\n`
            sendAll(sseClients, (c) => { c.res.write(s) })
            return
          }
          // 2026-09-06 web 打断收口/撤回链：CLI onCancel → {type:'turn-state', live:false}（web 收口
          // 「正在处理/正在思考」运行态——打断后 jsonl 零写入，本事件是 web「回合被中止」唯一实时源）；
          // auto-restore（web 发起打断且无 meaningful 响应）→ {type:'restored', text}（web 摘开启气泡
          // + 文本回填输入栏）。均无状态转发，web 自持 per-session 标记。
          if (m.type === 'turn-state') {
            // 2026-09-06 收口二轮：live:false = 回合被中止，记网关权威时刻（无 TTL）供
            // /gateway/sessions 下发，前端刷新后凭此恢复收口判定（实时路径照旧 SSE 直达）。
            // 2026-09-07：回合中止即清活性 beat（旧 beat 不得跨回合参与新回合的无响应判定）。
            if (m.live === false) {
              turnEndAt.set(sid, Date.now())
              persistTurnEndAt() // 2026-09-07 变更即写：打断收口信号跨网关重启存活
              turnBeatAt.delete(sid)
            }
            const s = `data: ${JSON.stringify({ type: 'turn-state', session: sid, live: m.live === true })}\n\n`
            sendAll(sseClients, (c) => { c.res.write(s) })
            return
          }
          if (m.type === 'turn-beat') {
            // 2026-09-07 僵死感知：CLI 引擎增量心跳（4s 节流），记最后活性时刻 + SSE 群发。
            // web 运行态计时 tick 对账：beat 落后超阈值 → 「无响应」提示（进程/WS 活但 query 链
            // 僵死的唯一可判信号）。无状态转发语义，web 自持 per-session 时刻。
            turnBeatAt.set(sid, Date.now())
            const s = `data: ${JSON.stringify({ type: 'turn-beat', session: sid })}\n\n`
            sendAll(sseClients, (c) => { c.res.write(s) })
            return
          }
          if (m.type === 'stream-text') {
            // 2026-09-08 流式字符通道：引擎流式 delta（CLI 100ms 合帧全文快照）无状态转发 +
            // SSE 群发 → web 状态行后流式预览。空串 = 块边界/消息落盘/打断清除信号。纯暂态
            // 显示层（不落盘、不进权威序列），载荷截断防滥用；丢失无害（下一帧覆盖）。
            const text = typeof m.text === 'string' ? m.text.slice(0, 65536) : ''
            const s = `data: ${JSON.stringify({ type: 'stream-text', session: sid, text })}\n\n`
            sendAll(sseClients, (c) => { c.res.write(s) })
            return
          }
          if (m.type === 'restored') {
            const text = typeof m.text === 'string' ? m.text : ''
            const s = `data: ${JSON.stringify({ type: 'restored', session: sid, text })}\n\n`
            sendAll(sseClients, (c) => { c.res.write(s) })
            return
          }
          // 2026-09-15 会话间协作：本会话的 agent 发消息给另一个会话（session_send 工具出口）。
          // 网关只做「按已解析 sid 路由」——会话名 → sid 的解析在发送端 CLI 完成（sessionAddressing.ts），
          // 网关不引入第二份标题索引；from（来源会话标识）原样透传，由接收端包进消息文本
          // （sessionMessage.ts）。投递帧走 /clients → 接收端 gatewayClient 与本地打字同路径 enqueue。
          // 回执语义 =「网关已接手投递」（在线直投/已暂存/已冷启），非端到端消费确认（离线冷启异步，见 sendSessionMessage）。
          if (m.type === 'session-message') {
            const requestId = typeof m.requestId === 'string' ? m.requestId : ''
            const toSid = typeof m.toSessionId === 'string' ? m.toSessionId : ''
            const text = typeof m.text === 'string' ? m.text : ''
            const reply = (ok: boolean, error?: string): void => {
              if (!requestId) return
              try {
                ws.send(JSON.stringify({ type: 'session-message-result', requestId, ok, ...(error ? { error } : {}) }))
              } catch {
                /* 断开忽略 */
              }
            }
            if (!toSid) reply(false, '缺少目标会话标识')
            else if (!text.trim()) reply(false, '消息内容为空')
            else if (toSid === sid) reply(false, '目标会话就是本会话，未发送')
            else
              deliverToSession(toSid, { type: 'session-message', text, from: m.from ?? {} }, {
                staged: () => {},
                resuming: () => {},
                done: reply,
              })
            return
          }
          // 2026-09-20 会话间协作·拉起新会话（CLI 侧 session_send 的 new_session 形态）。
          // 与上一支的分工：本帧让网关先 spawn 一个**全新**会话（无 --resume）并**等 /clients
          // 注册完成**再投递首条消息——回执带新会话 sid（后续可按 sid 寻址），spawn/注册失败
          // 如实回执原因。不做「先乐观回 sid、注册超时再静默丢消息」那条链（POST /gateway/wsession
          // 的预分配语义对 web 有效——前端会话态自明；对工具调用则是撒谎）。
          // 命名：新会话标题 =「<发起会话标题>拉起的会话」，走 applySessionTitle（落盘 + 在线
          // CLI 内存同步成对），先于投递执行，且失败不阻断投递（只补诊断轨迹，不吞消息）。
          // project label 是否真实存在由 CLI 工具侧查目录前置校验；本处不校验也不回退——网关
          // 对未知 label 的既有语义（webSessionProjectRoot 回退全局根）只属 web 建会话链。
          if (m.type === 'session-create') {
            const requestId = typeof m.requestId === 'string' ? m.requestId : ''
            const project = typeof m.project === 'string' ? m.project.trim() : ''
            const text = typeof m.text === 'string' ? m.text : ''
            // 2026-10-13 待办 14：可选 model（池内全名），随 spawn --model 落地（校验与
            // /gateway/model 同源 findModelProvider）；未指定 = 回落池默认，行为不变。
            const modelRaw = typeof m.model === 'string' && m.model.trim() ? m.model.trim() : ''
            const f = m.from as { sid?: unknown; title?: unknown } | undefined
            const from: { sid?: string; title?: string } =
              f && typeof f === 'object' && typeof f.title === 'string' && f.title
                ? {
                    title: f.title.slice(0, 200),
                    ...(typeof f.sid === 'string' && f.sid ? { sid: f.sid.slice(0, 200) } : {}),
                  }
                : {}
            const reply = (ok: boolean, error?: string, newSid?: string): void => {
              if (!requestId) return
              try {
                ws.send(
                  JSON.stringify({
                    type: 'session-message-result',
                    requestId,
                    ok,
                    ...(newSid ? { sessionId: newSid } : {}),
                    ...(error ? { error } : {}),
                  }),
                )
              } catch {
                /* 断开忽略 */
              }
            }
            if (!project) reply(false, '缺少 project：新建会话必须指定项目')
            else if (!text.trim()) reply(false, '消息内容为空')
            else if (modelRaw && !findModelProvider(modelRaw)) reply(false, `model "${modelRaw}" 不在凭据池任何供应商模型清单中`)
            else {
              const newSid = randomUUID()
              spawnWebSession(undefined, project, newSid, modelRaw ? { model: modelRaw } : undefined)
                .then(async () => {
                  const p = join(webSessionProjectRoot(project), '.claude', 'projects', `${newSid}.jsonl`)
                  try {
                    const routed = await applySessionTitle(newSid, `${from.title ?? '未命名会话'}拉起的会话`, p)
                    approvalTrailPush('session-create-named', newSid, undefined, routed ? 'hit' : 'miss')
                    scheduleSseFlush(root)
                  } catch (e) {
                    // 命名失败不阻断投递：消息必须落地，标题问题留在轨迹里可查（不静默）
                    console.error(`[gateway] session-create: 命名失败 sid=${newSid}`, e)
                    approvalTrailPush('session-create-rename-fail', newSid, undefined, (e as Error)?.message)
                  }
                  deliverToSession(newSid, { type: 'session-message', text, from }, {
                    staged: () => {},
                    resuming: () => {},
                    done: (ok, error) => reply(ok, error, ok ? newSid : undefined),
                  })
                })
                .catch((e: Error) => {
                  console.error(`[gateway] session-create: 创建失败 sid=${newSid}`, e)
                  reply(false, '创建会话失败：' + (e?.message ?? String(e)))
                })
            }
            return
          }
          if (m.type === 'session-delta') {
            // 2026-09-08 事件流统一 P1（方案 20260908135557）：引擎投影 delta 直达 web。
            // CLI 侧 buildDisplayDelta（过滤权威单源）即发 → 本处 seq 记账去重 + SSE 群发。
            // seq <= last = 重复/迟到丢弃；gap（seq > last+1）照发——web 端 gap 判定 → 全量
            // 对账重建基线（CLI 重启 seq 归 1 由 cli-hello 重置覆盖）。不缓存 delta 历史。
            // 载荷基本校验（数组/对象/条数上限=投影窗口 200+裕量）防异常膨胀。
            const seq = typeof m.seq === 'number' && Number.isInteger(m.seq) && m.seq > 0 ? m.seq : 0
            if (!seq) return
            const last = sessionDeltaSeq.get(sid) ?? 0
            if (seq <= last) return
            sessionDeltaSeq.set(sid, seq)
            // 2026-09-10 协议根修：数字坐标 base → 稳定键 anchorSid（见 buildDisplayDelta）。
            // 无锚点 = 不可增量（CLI 侧无可靠基线），不群发，web 由对账链恢复。
            const anchorSid = typeof m.anchorSid === 'string' ? m.anchorSid : ''
            if (!anchorSid) return
            const msgs = Array.isArray(m.messages)
              ? m.messages.filter((x) => x && typeof x === 'object').slice(0, 220)
              : []
            const s = `data: ${JSON.stringify({ type: 'session-delta', session: sid, seq, anchorSid, messages: msgs })}\n\n`
            sendAll(sseClients, (c) => { c.res.write(s) })
            return
          }
          if (m.type === 'approval-request' && m.requestId) {
            approvalTrailPush('cli-approval-request', sid, m.requestId, m.toolName)
            // 2026-08-26 A2：补透传 CLI 侧 sendRequest 已上报的 description/suggestions/blockedPath，
            // 供前端审批卡展示原因说明、可勾选的「记住此规则」与被拒路径（undefined 字段自动省略）。
            const approvalMsg = {
              type: 'approval',
              session_id: sid,
              requestId: m.requestId,
              toolName: m.toolName,
              toolUseId: m.toolUseId,
              input: m.input,
              description: m.description,
              suggestions: m.suggestions,
              blockedPath: m.blockedPath,
            }
            pendingApprovalsSet(sid, m.requestId, approvalMsg) // 2026-08-30 pending 重放：暂存未决项
            broadcast(approvalMsg)
            approvalTrailPush('gw-broadcast-approval', sid, m.requestId, `sockets=${sockets.size}`)
            return
          }
          // 本地（CLI 终端/窗口）已操作（allow/deny/abort）或请求已解决 → floria 撤卡
          if ((m.type === 'approval-local-resolved' || m.type === 'approval-cancel') && m.requestId) {
            approvalTrailPush('cli-local-resolved-or-cancel', sid, m.requestId, m.type)
            pendingApprovalsDrop(m.requestId) // 2026-08-30 pending 重放：已解决不再回放
            broadcast({ type: 'approval-dismiss', session_id: sid, requestId: m.requestId })
            return
          }
          // 2026-08-26 P0 审批确认送达：CLI 处理完 approval-response（handler 命中消费）后回执，
          // 网关转 approval-confirmed 给 floria → 前端收到确认才关卡（不再 WS send 后立即清卡）。
          // 目标 CLI 在线但本地已 resolve（竞速输/已撤销）不发本回执——floria 会收到 approval-dismiss 撤卡。
          if (m.type === 'approval-processed' && m.requestId) {
            approvalTrailPush('cli-approval-processed', sid, m.requestId)
            pendingApprovalsDrop(m.requestId) // 2026-08-30 pending 重放：CLI 已消费不再回放
            broadcast({ type: 'approval-confirmed', session_id: sid, requestId: m.requestId })
            approvalTrailPush('gw-approval-confirmed', sid, m.requestId)
            return
          }
        })
        const detach = () => {
          if (cliClients.get(sid) === ws) cliClients.delete(sid)
          // 2026-08-30 队列快照：队列态只属于在线 CLI 进程，断开即清（重连后 queue-state 补发对齐）
          sessionQueues.delete(sid)
          // 2026-09-16 会话真实模型镜像：同队列——模型态只属于在线 CLI 进程（重连 open reportCurrentModel 补报对齐）
          sessionModels.delete(sid)
          // 2026-09-10 任务清单快照：同队列——清单态只属于在线 CLI 进程（重连由 task-state 补发对齐）
          sessionTasks.delete(sid)
          // 2026-09-08 断连感知根修：detach 不再立即清 activity/beat + 群发 null——CLI /clients
          // WS 断开 ~1s 重连（RECONNECT_BASE_MS）是常态（网络抖动/睡眠恢复），立即群发会让 web
          // 把活回合误收口成「已处理」（未完成对话停止计时实证）。改 3s 复核窗：窗口内重连 →
          // 全静默（CLI 重连 activityResync 重报自然恢复）；到期未重连才收口——activity null
          // 群发与 session-down 从此共用同一判定时机（进程失联确认），状态源减少。
          // （close 与 error 双触发由 detachTimers 去重；error 后 close 亦会到，幂等无害。）
          const prevDetach = detachTimers.get(sid)
          if (prevDetach) clearTimeout(prevDetach)
          detachTimers.set(
            sid,
            setTimeout(() => {
              detachTimers.delete(sid)
              if (cliClients.has(sid)) return // 复核窗内重连：状态由重连重报恢复，静默
              turnBeatAt.delete(sid)
              sessionActivity.delete(sid)
              cliPids.delete(sid)
              // 2026-10-02：进程失联确认 → 该会话未决审批/提问一并清（其唯一寿命来源=会话存活，
              // 非墙钟）。仍在线会话的待决项跨重连窗保留，见 pendingApprovals 注释。
              pendingApprovalsDropSession(sid)
              const down = `data: ${JSON.stringify({ type: 'activity', session: sid, state: null })}\n\n`
              sendAll(sseClients, (c) => { c.res.write(down) })
              // 2026-08-24 web 会话：CLI 窗口被用户关闭 → 进程死亡 → 从运行表移除
              // （会话仍可从磁盘 resume；2026-08-25 起无来源注册表，列表不再区分来源）。
              // 仅进程真死才删（gatewayClient 断线重连期间进程仍活着，不能误删）。
              const wp = webSessions.get(sid)
              if (wp && wp.pid && !isPidAlive(wp.pid)) {
                webSessions.delete(sid)
                persistWebSessions()
                // 进程真死 → 显式 session-down 群发，web toast 告知用户会话已退出、需点开重开
                const exited = `data: ${JSON.stringify({ type: 'session-down', session: sid })}\n\n`
                sendAll(sseClients, (c) => { c.res.write(exited) })
              }
            }, 3000),
          )
          scheduleIdleShutdown()
        }
        ws.on('close', detach)
        ws.on('error', detach)
        ws.send(JSON.stringify({ type: 'registered', session: sid }))
      })
      return
    }
    socket.destroy()
  })
  let gatewayListened = false
  server.on('error', (err) => {
    // 端口被占等错误：关闭对象避免悬挂
    if (server) {
      server.close()
      server = null
    }
    console.error(`[gateway] 启动失败: ${(err as Error).message}`)
    // P5（2026-08-28）：--gateway 独立进程 listen 失败（EADDRINUSE 等）→ 直接退出，
    // 不留无监听僵尸进程驻留（实测 8199 冲突进程不退，干扰下轮诊断）。
    if (process.argv.includes('--gateway') && !gatewayListened) process.exit(1)
  })
  server.listen(currentPort, currentHost, () => {
    gatewayListened = true
    // 端口到手才发布 token/port（2026-09-18 竞态根治，见上方 currentToken 注）：
    // bind 失败者不再写盘，盘上永远是现网关的秘密，CLI 读盘注册恒可达。
    saveGatewayTokenToDisk(currentToken)
    saveGatewayPortToDisk(currentPort)
    console.log(`[gateway] 内置网关监听 http://${currentHost}:${currentPort} (token=${currentToken})`)
    // 全局根应用卡后端开机自启（2026-11-07 定案）：只拉全局根（工作区根的 .claude/preview），
    // 仅独立 --gateway 进程；逐个「已启用且有 backend」的卡拉起，失败只记日志、不影响网关。
    // 项目级后端的开机行为不变（项目后端仍按需懒加载）。
    if (process.argv.includes('--gateway')) {
      const bootPreview = join(getPortableRoot(), '.claude', 'preview')
      for (const c of enabledCardBackends(bootPreview)) {
        void ensureBackend(cardBackendKey(GLOBAL_PROJECT_LABEL, c.id), c.cfg).catch((e: unknown) => {
          console.warn(`[gateway] 开机拉起全局应用 ${c.id} 失败: ${e instanceof Error ? e.message : String(e)}`)
        })
      }
    }
    // mDNS 应答器只在全网卡监听时有意义；绑 127.0.0.1（调试）时不起
    if (currentHost === '0.0.0.0') mdnsStart()
  })

  const lan = lanAddress()
  return {
    port: currentPort,
    host: currentHost,
    token: currentToken,
    lanUrl: lan ? `http://${lan}:${currentPort}/?token=${currentToken}` : '',
    localUrl: `http://127.0.0.1:${currentPort}/?token=${currentToken}`,
  }
}

export function stopLocalGateway(): boolean {
  gatewayStopping = true
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  stopSseWatches()
  mdnsStop() // mDNS 应答器随网关关停（floria.local 停止解析，设备回落 IP 直连）
  // P2 收敛：停单一回收定时器。web 会话窗口不随网关关停（2026-08-29 根修：此前 killAllWebSessions
  // 把正在执行 /server restart 的 web 会话自己杀掉，restart 断在半路且窗口退出）——web 会话与普通
  // CLI 会话同等权重，网关 off/restart/空闲退出均只关网关，窗口存活并自动重连新网关（注册表已落盘，
  // 新网关启动 adoptWebSessions 收养）；backend 同理（2026-08-28 生命周期解耦）。
  if (reclaimTimer) {
    clearInterval(reclaimTimer)
    reclaimTimer = null
  }
  stopSocketHeartbeat() // ① 心跳定时器随网关关停（下一步即 close 全部 WS，无需再探测）
  stopSseHeartbeat() // ② SSE 心跳定时器随网关关停
  for (const c of sockets) {
    try {
      c.close()
    } catch {
      /* 忽略 */
    }
  }
  sockets.clear()
  // 2026-08-17 独立化：一并断开所有 CLI 客户端（它们会各自重连或静默等待）
  for (const c of cliClients.values()) {
    try {
      c.close()
    } catch {
      /* 忽略 */
    }
  }
  cliClients.clear()
  // SSE 僵尸连接根治（2026-09-09）：server.close() 只停止接受新连接，不断开既有连接——已挂上的
  // EventSource 流保持 ESTABLISHED，浏览器收不到 TCP FIN → onerror 永不触发 → 前端永不重连。
  // 此前这里只 sseClients.clear() 清引用，旧页面的 SSE 就成了僵尸：消息区收不到
  // updated/session-delta/stream-text，只剩首个乐观气泡永不更新（「web 新建会话长时间空白」根因）。
  // 根治 = 显式 end() 所有 SSE 响应流：客户端收到流结束 → onerror → 3s 后 initLive 重连新网关
  // → hello → refreshSession 全量对账，页面不刷新自动恢复（与上方 WS 显式 close → 自动重连对称）。
  for (const c of sseClients) {
    try {
      c.res.end()
    } catch {
      /* 忽略 */
    }
  }
  sseClients.clear()
  sseSizes.clear()
  ssePrimed = false
  // C1 修复：停网关时一并清空 CLI 上报的内存缓存（内存数据本就随网关重启失效）
  conversationDisplays.clear()
  sessionActivity.clear()
  sessionModels.clear()
  // 共享 token 一并清空：网关停止后 CLI 上报不再附加（保持静默失败，不报错）。
  // 2026-08-17 独立化：同时清盘 token 文件，避免遗留的 token 被误用（新一轮网关会重新生成写盘）。
  setGatewayToken('')
  clearGatewayTokenFromDisk()
  clearGatewayPortFromDisk()
  // 2026-08-28 修订：/server off|restart 不再清设备授权票证（用户实测「重启后授权全没了」）——
  // 授权名单是手动配对的持久资产，只由 /server auth add / auth off 管理；网关 token（内部）
  // 照旧清盘（重启随机新生成）。设备 cookie 的票证在名单里始终有效，跨重启免重配。
  try {
    wss?.close()
  } catch {
    /* 忽略 */
  }
  wss = null
  if (server) {
    server.close()
    server = null
    return true
  }
  return false
}
