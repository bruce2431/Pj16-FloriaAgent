/**
 * conversationDisplay.ts —— 把「CLI 实际显示的会话」导出为结构化 JSON，供遥测查看器（SubPj1 floria）消费。
 *
 * 最根本原则（Pj16-CodeAgent构建/CLAUDE.md）：会话展示内容一律由源码侧提供，禁止在消费端复刻。
 * 本模块把 `Messages.tsx` / `Message.tsx` 渲染期的过滤逻辑提取为纯函数（唯一权威实现）：
 *   - 思考过滤：transcript 模式全局只保留最后一个 thinking（`hidePastThinking`/`lastThinkingBlockId`），
 *     prompt 模式 thinking 全隐藏（`!isTranscriptMode && !verbose → null`）。
 *   - 用户消息识别：复用 `shouldShowUserMessage`（isMeta / isVisibleInTranscriptOnly 标记）。
 * `Messages.tsx` 与 REPL 的导出共用这里，显示 = 导出，永不跑偏。
 */

import {
  COMMAND_ARGS_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  TASK_NOTIFICATION_TAG,
} from '../constants/xml.js'
import {
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  isNotEmptyMessage,
  normalizeMessages,
  NO_RESPONSE_REQUESTED,
  shouldShowUserMessage,
} from './messages.js'
import { RATE_LIMIT_FALLBACK_NOTICE_PREFIX } from '../services/api/errors.js'
import { getGatewayToken } from './gatewayToken.js'
import { parseSessionMessage, type SessionSource } from './sessionMessage.js'

/** 文件变更结构化数据（Edit/Write 工具的真实增删行数，权威数字 = diff.ts sumLinesChanged） */
export type DisplayFileChange = {
  filePath: string
  added: number
  removed: number
}

export type DisplayBlock = {
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image'
  text?: string
  name?: string
  input?: unknown
  fileChange?: DisplayFileChange
  /**
   * image 块专属（2026-08-30 web 内联渲染）：pastedContents id（= file-cache/<sessionId>/<id>.<ext>
   * 文件名主干，与文本里 `[Image #N]` 占位一一对应）。取自转录 user 记录 / queued_command attachment
   * 记录的 imagePasteIds（按 content 内 image 块顺序对位）。缺省 = 旧记录/无缓存文件，消费端回落占位。
   */
  imageId?: number
}

export type DisplayMessage = {
  role: 'user' | 'assistant' | 'tool' | 'system'
  blocks: DisplayBlock[]
  /**
   * 归一化稳定键（2026-09-10 长会话 delta 对齐根修）：位置无关的跨端一致标识，消费端
   * 据此定位增量替换锚点。规则 = 「源记录 uuid 前 24 位（deriveUUID 恒保留该前缀）+
   * 同 parent 内块序」；无源 uuid 的派生提示行用「h#时间戳#文本前 32 字」。原文见
   * filterConversationForDisplay 末尾赋值处。
   */
  sid?: string
  timestamp?: number | string
  /**
   * 助手消息的 stop_reason（2026-08-26 新增，供 floria 实时段「回合结束」判定）：
   * 'end_turn' = 正式回复（回合结束，折叠收拢为「已处理」）；'tool_use'/null = 处理中
   * （旁白/工具步，折叠保持「正在处理」并只显示当前运行工具）。仅 assistant 消息携带。
   */
  stopReason?: string
  /**
   * 回合 token 用量（web 回复操作条「用量 X tok」按钮 + 明细面板的唯一数据源）：
   * 统计单元 = 一个回合（两条真实用户消息之间），把该回合内**每一次** API 响应的 usage
   * 按 message.id 去重后求和——prompt 每次重发都计入（与厂商账单/dsh turn-usage 同口径）。
   * input=未缓存输入、cacheRead=缓存读取、cacheWrite=缓存写入、output=输出；合计 = 四者之和。
   * 只挂在回合最后一条 assistant 消息上；回合起点不在投影输入窗口内（增量尾部窗口从回合
   * 中途开始）时无法证明完整，不挂——消费端不渲染，不做估算。
   */
  turnUsage?: DisplayUsage
  /**
   * 该条 assistant 记录的请求模型名（2026-10-04 新增；回复操作条弹出面板「提供方 / 模型」行数据源）。
   * 仅 assistant 消息携带；无 model 字段 → undefined。
   */
  model?: string
  /**
   * 引导注入标（2026-08-30 共同后端定案）：queued_command attachment 人发可见时输出
   * role:'user' + injected:true——web 渲染为折叠体内旁白位（区别于 dequeue 开启消息）。
   * 仅 user 消息携带。
   */
  injected?: boolean
  /**
   * 源消息 uuid（2026-08-31 P2 增量上报）：filterConversationForDisplay 每条投影带其源
   * 消息（normalizeMessages 拆分后经 deriveUUID 派生，确定性幂等）的 uuid。CLI 侧增量
   * 对齐键（exportConversationToServer 用 fresh[0].uuid 在已上报缓存中定位 base 水位）。
   * 网关/web 消费端忽略未知字段，无兼容影响。
   */
  uuid?: string
  /**
   * 来源会话（2026-09-15 会话间协作）：仅「跨会话收到的消息」携带，undefined = 本地用户输入。
   * 正文文本里的包装已被本模块剥离（`<session-message from=… sid=…>`，见 utils/sessionMessage.ts），
   * 来源单独走本字段 → 消费端渲染为气泡外一行灰字（来自 会话：X）。留空则渲染与本地用户消息无异。
   */
  fromSession?: SessionSource
}

export type DisplayMode = 'prompt' | 'transcript' | 'prompt-tail-think'

/** 回合用量四桶（DisplayMessage.turnUsage 的形状） */
export type DisplayUsage = {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

/** 逐次 API 调用的 token 用量结构（assistant 记录 message.usage；→ 按回合求和成 DisplayUsage） */
type TokenUsage = {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens?: number
}

/** 宽松输入结构：与 NormalizedMessage / Message 运行时形状兼容（类型定义在缺失的 types/message.js） */
type SourceMessage = {
  type?: string
  /** system 记录子类型（local_command / compact_boundary / api_error …） */
  subtype?: string
  /** 记录级来源标记（转录 user 记录；'task-notification' = 后台任务通知系统注入） */
  origin?: { kind?: string }
  uuid?: string
  timestamp?: number | string
  /** system/local_command 记录的内容在顶层字符串（无 message 字段） */
  content?: unknown
  /**
   * user 记录的图片粘贴 id（processUserInput storeImages 落 file-cache 时的文件名主干）；
   * 与 message.content 内 image 块按顺序一一对应（提交链路按 image 块序生成）。
   */
  imagePasteIds?: number[]
  /** attachment 消息（queued_command = 回合中引导注入；运行时内存链路存在，非 ant 环境不落盘） */
  attachment?: {
    type?: string
    prompt?: string | Array<{ type?: string; text?: string }>
    origin?: { kind?: string }
    commandMode?: string
    isMeta?: boolean
    /** getQueuedCommandAttachments 携带的图片粘贴 id（attachments.ts:1076），语义同上 */
    imagePasteIds?: number[]
  }
  message?: {
    /** API 响应 id（同一响应的多条拆分/快照记录共享；回合用量去重键） */
    id?: string
    role?: string
    /** 该条 assistant 记录的实际请求模型名（模型切换派生提示的数据源） */
    model?: string
    content?: Array<{ type?: string; text?: string; thinking?: string; name?: string; input?: unknown; content?: unknown }>
    stop_reason?: string
    /** 该条 assistant 记录的 token 用量（逐次 API 调用；→ 按回合求和为 DisplayMessage.turnUsage） */
    usage?: TokenUsage
  }
}

/** 本地命令记录（system/local_command）顶层字符串里提取单个 XML 标签内容；无匹配返回 null */
function extractXmlTag(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)
  return m ? m[1] : null
}

/** 消息文本形态（attachment.prompt 字符串 / 数组两形态；user 记录 content 里的 text 块复用同一处理） */
type SessionPromptValue = string | Array<{ type?: string; text?: string }>

/**
 * 跨会话消息包装剥离（2026-09-15 会话间协作）：`<session-message from="会话：X" sid="…">正文</session-message>`
 * 由 wrapSessionMessage 独占产出（网关下行 → gatewayClient）。命中则返回剥离后的正文 + 来源；
 * 未命中原样返回（本地用户输入恒走此路）。数组形态（带图消息，attachments.ts 拼 text+image）里
 * 只可能是首个 text 块承载包装（getQueuedCommandAttachments 的拼接契约）。
 */
function stripSessionPrompt(prompt: SessionPromptValue): {
  prompt: SessionPromptValue
  source?: SessionSource
} {
  if (typeof prompt === 'string') {
    const px = parseSessionMessage(prompt)
    return px ? { prompt: px.body, source: px.source } : { prompt }
  }
  if (!Array.isArray(prompt)) return { prompt }
  const i = prompt.findIndex(b => b?.type === 'text' && typeof b.text === 'string')
  if (i < 0) return { prompt }
  const px = parseSessionMessage(prompt[i]!.text!)
  if (!px) return { prompt }
  const next = prompt.slice()
  next[i] = { ...next[i], text: px.body }
  return { prompt: next, source: px.source }
}

/**
 * 用户中断标记（`[Request interrupted by user]` / `… for tool use`）。转录持久化为普通 user
 * text 块（无 isMeta 字段），CLI 由 UserTextMessage → InterruptedByUser 徽标渲染；导出侧转为
 * role:'system' 居中提示。注意 isNotEmptyMessage 会把 FOR_TOOL_USE 变体判空丢弃，因此本判定
 * 必须先于该过滤使用（见 filterConversationForDisplay 的保留谓词）。
 */
function isInterruptUserMessage(msg: SourceMessage): boolean {
  if (msg.type !== 'user') return false
  const c = msg.message?.content
  if (!Array.isArray(c) || c.length !== 1 || c[0]?.type !== 'text') return false
  const t = (c[0].text ?? '').trim()
  return t === INTERRUPT_MESSAGE || t === INTERRUPT_MESSAGE_FOR_TOOL_USE
}

/**
 * 提取自 Messages.tsx `lastThinkingBlockId` useMemo：向后扫描，返回最后一个 thinking 块的
 * `${uuid}:${j}`；遇到不带 tool_result 的 user 消息（上一回合）返回 'no-thinking'；流式思考可见时返回
 * 'streaming'（令所有已完成 thinking 隐藏）。
 */
export function computeLastThinkingBlockId(
  messages: readonly SourceMessage[],
  opts: { hidePastThinking: boolean; isStreamingThinkingVisible: boolean },
): string | null {
  if (!opts.hidePastThinking) return null
  if (opts.isStreamingThinkingVisible) return 'streaming'
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.type === 'assistant') {
      const content = msg.message?.content
      if (Array.isArray(content)) {
        for (let j = content.length - 1; j >= 0; j--) {
          if (content[j]?.type === 'thinking') {
            return `${msg.uuid}:${j}`
          }
        }
      }
    } else if (msg?.type === 'user') {
      const content = msg.message?.content
      const hasToolResult = Array.isArray(content) && content.some((block) => block.type === 'tool_result')
      if (!hasToolResult) return 'no-thinking'
    }
  }
  return null
}

/**
 * 文件变更文本格式（2026-08-23 起，遥测端不再正则反解，改消费结构化 fileChange）：
 * FileEditTool/FileWriteTool 的 mapToolResultToToolResultBlockParam 在 tool_result 文本末尾
 * 追加 ` (+added -removed)`（数字 = diff.ts sumLinesChanged 的结构化统计，见 FileEditTool.ts
 * `changeSuffix` / FileWriteTool.ts create/update 分支）。本解析器与生成器同放源码侧，
 * 是「字符串 → 结构化」的唯一权威；SubPj1 app.js 的 parseFileChange 已降级为旧网关兜底。
 * 文本样例：
 *   `The file X has been updated successfully (+2 -1).`（Edit 常规 / Write update）
 *   `The file X has been updated. All occurrences were successfully replaced (+2 -1).`（Edit replaceAll）
 *   `File created successfully at: X (+3 -0)`（Write create，新文件全行算新增）
 */
const FILE_CHANGE_SUFFIX_RE = /\([+-](\d+)\s*[+-](\d+)\)\s*\.?\s*$/
const FILE_CHANGE_PATH_EDIT_RE = /The file\s+(.+?)\s+has been updated/
const FILE_CHANGE_PATH_CREATE_RE = /File created successfully at:\s+(.+?)\s*\(/

export function parseFileChangeFromToolResult(text: string): DisplayFileChange | null {
  const t = (text || '').trim()
  const m = FILE_CHANGE_SUFFIX_RE.exec(t)
  if (!m) return null
  let filePath: string | null = null
  const fm = FILE_CHANGE_PATH_EDIT_RE.exec(t)
  if (fm) filePath = fm[1]
  else {
    const cm = FILE_CHANGE_PATH_CREATE_RE.exec(t)
    if (cm) filePath = cm[1]
  }
  if (!filePath) return null
  return { filePath: filePath.trim(), added: Number(m[1]), removed: Number(m[2]) }
}

/** 输出单个块（kind 映射 + 文本提取；imageId = 图片粘贴 id，见 DisplayBlock.imageId） */
function toDisplayBlock(
  b: NonNullable<SourceMessage['message']>['content'][number],
  imageId?: number,
): DisplayBlock | null {
  switch (b?.type) {
    case 'text':
      return { kind: 'text', text: b.text || '' }
    case 'thinking':
      return { kind: 'thinking', text: (b.thinking ?? b.text) || '' }
    case 'redacted_thinking':
      return { kind: 'thinking', text: '（加密思考）' }
    case 'tool_use':
      return { kind: 'tool_use', name: b.name || 'tool', input: b.input }
    case 'tool_result': {
      const t = b.content
      const txt =
        typeof t === 'string' ? t : Array.isArray(t) ? t.map((x) => (x && typeof x === 'object' && 'text' in x ? String(x.text) : '')).join(' ') : ''
      const block: DisplayBlock = { kind: 'tool_result', text: txt }
      // 文件变更（Edit/Write）：源码侧解析真实增删行数 → 结构化 fileChange，
      // 遥测端「N 个文件已更改」卡片直接消费字段，不再从文本正则反解。
      const fc = parseFileChangeFromToolResult(txt)
      if (fc) block.fileChange = fc
      return block
    }
    case 'image':
      return imageId !== undefined ? { kind: 'image', imageId } : { kind: 'image' }
    default:
      return null
  }
}

/**
 * 「尾部放行」选中键（2026-08-27 思考等权展示·方案B；镜像 SubPj1 server.mjs readSession 同款规则）：
 * 已收尾历史 = 全剔 thinking；未收尾尾巴（最后一个 end_turn 之后；整个转录无 end_turn 则最后一条
 * 真实 user 消息之后）只保留【最后一条含 thinking/redacted_thinking 的 assistant 记录】里【最后一个】
 * 该类块的 `${uuid}:${j}`，其余全剔。用途：网关 readSession('prompt-tail-think') 把「正在思考」
 * 真实数据交给 floria liveFoldBody 行内状态；2026-09-08 起 REPL 上报/delta 投影统一本 mode
 * （同构根修，base 坐标与 fetch 序列恒对齐）。
 */
function computeTailThinkingPassId(messages: readonly SourceMessage[]): string | null {
  const hasVisibleText = (m: SourceMessage | undefined): boolean => {
    const content = m?.message?.content
    if (!Array.isArray(content)) return false
    return content.some((b) => {
      if (b?.type !== 'text' || typeof b.text !== 'string') return false
      const t = b.text.trim()
      if (!t) return false
      // 中断标记不是真实用户输入，不据此定尾巴起点（否则会把尾部思考放行窗口钉在错误位置）
      return t !== INTERRUPT_MESSAGE && t !== INTERRUPT_MESSAGE_FOR_TOOL_USE
    })
  }
  let lastEndTurn = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.type === 'assistant' && messages[i]?.message?.stop_reason === 'end_turn') { lastEndTurn = i; break }
  }
  let lastRealUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.type === 'user' && hasVisibleText(messages[i])) { lastRealUser = i; break }
  }
  const tailStart = lastEndTurn >= 0 ? lastEndTurn + 1 : lastRealUser >= 0 ? lastRealUser + 1 : messages.length
  for (let i = messages.length - 1; i >= tailStart; i--) {
    const msg = messages[i]
    if (msg?.type !== 'assistant') continue
    const content = msg.message?.content
    if (!Array.isArray(content)) continue
    for (let j = content.length - 1; j >= 0; j--) {
      const t = content[j]?.type
      if (t === 'thinking' || t === 'redacted_thinking') return `${msg.uuid}:${j}`
    }
  }
  return null
}

/**
 * 核心过滤：把原始消息转成「CLI 实际显示的」`{role, blocks[]}`。
 * - prompt 模式：thinking 全隐藏（对齐 `Message.tsx` `!isTranscriptMode && !verbose → null`）。
 * - transcript 模式：只保留全局最后一个 thinking（对齐 `hidePastThinking` + `lastThinkingBlockId`）。
 * - prompt-tail-think 模式（2026-08-27，仅网关 /gateway/session 用）：已收尾历史 thinking 全隐藏，
 *   未收尾尾巴放行最后一块（computeTailThinkingPassId）——驱动 floria「正在思考」行内实时态，
 *   且不让历史会话泄露无效思考（server.mjs 离线兜底同语义双份）。
 * - 用户消息按 `shouldShowUserMessage` 识别（isMeta/isVisibleInTranscriptOnly），替代遥测端的 isSynth 复刻。
 * - 居中灰字系统提示（2026-08-27 定案）：①本地命令记录 system/local_command（顶层 content 字符串）
 *   解析为命令行/stdout/stderr 提示行；②用户中断标记转提示行；③相邻 assistant 记录 model 字段
 *   变化派生「已切换模型」提示（回合边界自然落位）；④后台任务通知 user 记录
 *   （origin.kind='task-notification'）转「后台任务完成」提示行。全部以 role:'system' 下发，
 *   消费端居中灰字渲染。
 */
/** 归一时间戳为毫秒（流式/转录可能给 ISO 字符串；网关 /gateway/session 也转 ms，floria 时长计算依赖数字） */
function tsMs(ts: number | string | undefined): number | undefined {
  if (typeof ts === 'string') {
    const n = Date.parse(ts)
    return Number.isFinite(n) ? n : undefined
  }
  return typeof ts === 'number' && Number.isFinite(ts) ? ts : undefined
}

/**
 * 单次 API 响应的 token 用量明细（回合求和的输入单元）：
 * input=未缓存输入、cacheRead=缓存读取、cacheWrite=缓存写入、output=输出。
 * 三项输入 token 缺省按 0（部分商只报 output）；四者合计全 0 / 无 usage 返回 undefined。
 */
function usageDetail(u: TokenUsage | undefined): DisplayUsage | undefined {
  if (!u || typeof u !== 'object') return undefined
  const x = u as Record<string, unknown>
  const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const detail = {
    input: n(x.input_tokens),
    cacheRead: n(x.cache_read_input_tokens),
    cacheWrite: n(x.cache_creation_input_tokens),
    output: n(x.output_tokens),
  }
  return detail.input + detail.cacheRead + detail.cacheWrite + detail.output > 0 ? detail : undefined
}

export function filterConversationForDisplay(
  messages: readonly SourceMessage[],
  mode: DisplayMode,
  /**
   * P2 增量投影续算（2026-08-31）：initialLastModel = 上次扫描终点模型（「已切换模型」
   * 派生提示的跨扫描状态，窗口切片投影与全量投影一致的前提）；lastModelOut = 出参容器，
   * 扫描结束后回传末态供缓存。两参均可选，既有调用方（网关 jsonl 直读/全量导出）零改动。
   */
  opts?: { initialLastModel?: string; lastModelOut?: { lastModel?: string } },
): DisplayMessage[] {
  const isTranscript = mode === 'transcript'
  const isTailThink = mode === 'prompt-tail-think'
  // 中断标记消息要保留（转 role:'system' 居中提示），不能被 isNotEmptyMessage 判空丢弃
  // （FOR_TOOL_USE 变体会被它当空消息剔掉）。
  const normalized = normalizeMessages(messages as never).filter(
    m => isNotEmptyMessage(m as never) || isInterruptUserMessage(m as SourceMessage),
  )
  const lastId = computeLastThinkingBlockId(normalized, { hidePastThinking: isTranscript, isStreamingThinkingVisible: false })
  const tailPassId = isTailThink ? computeTailThinkingPassId(normalized) : null

  const out: DisplayMessage[] = []
  let lastModel: string | undefined = opts?.initialLastModel
  // ── 回合 token 用量收口（2026-11-19，dsh turn-usage 口径）──
  // 统计单元 = 回合（两条真实用户消息之间）；回合内每一次 API 响应的 usage 都计入（prompt
  // 每次重发都算，与厂商账单一致）。同一响应的多条记录（并行工具调用拆分 / 流式快照）共享
  // message.id 与同一 usage，逐字段取最大后按 id 去重，避免重复计。
  // 结果挂到回合最后一条 assistant 投影的 turnUsage；回合起点不在输入窗口内（CLI 增量上报
  // 的尾部窗口从回合中途开始）时无法证明完整 → 不挂，不估算。
  let turnUsageById = new Map<string, DisplayUsage>()
  let turnHasStart = false
  let turnLastAssistant = -1
  const foldAttemptUsage = (id: string, detail: DisplayUsage): void => {
    const cur = turnUsageById.get(id) ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    cur.input = Math.max(cur.input, detail.input)
    cur.cacheRead = Math.max(cur.cacheRead, detail.cacheRead)
    cur.cacheWrite = Math.max(cur.cacheWrite, detail.cacheWrite)
    cur.output = Math.max(cur.output, detail.output)
    turnUsageById.set(id, cur)
  }
  const closeTurnUsage = (): void => {
    if (turnHasStart && turnLastAssistant >= 0 && turnUsageById.size > 0) {
      let input = 0
      let cacheRead = 0
      let cacheWrite = 0
      let output = 0
      for (const u of turnUsageById.values()) {
        input += u.input
        cacheRead += u.cacheRead
        cacheWrite += u.cacheWrite
        output += u.output
      }
      if (input + cacheRead + cacheWrite + output > 0) {
        out[turnLastAssistant]!.turnUsage = { input, cacheRead, cacheWrite, output }
      }
    }
    turnUsageById = new Map()
    turnHasStart = false
    turnLastAssistant = -1
  }
  /** 居中灰字系统提示行（2026-08-27 定案：指令信息/中断/模型切换统一此形态，role:'system' 下发） */
  const pushSystemHint = (text: string, ts: number | string | undefined, uuid?: string): void => {
    out.push({ role: 'system', blocks: [{ kind: 'text', text }], timestamp: tsMs(ts), ...(uuid ? { uuid } : {}) })
  }
  // 非中断系统提示开关（2026-08-28 用户定案：居中灰字提示仅保留「用户中断了对话」，
  // 其余全部隐藏，保留接口以便后续更改）。false = 不下发命令类（命令行 echo/local_command
  // stdout+stderr/!bash）、模型切换等提示行；中断提示不受影响。改回 true 即恢复显示。
  // 例外（2026-09-09 用户定案）：后台任务通知恒显示、不受本开关管辖——通知唤醒续跑的
  // 回合里两次正式发言之间的空隙需原位可见（web 渲染为居中浅灰气泡，按时序堆叠）。
  const SHOW_NON_INTERRUPT_HINTS = false
  for (const msg of normalized) {
    const timestamp = tsMs(msg.timestamp)

    if (msg.type === 'system') {
      // 本地命令记录（/xxx、!bash）：CLI 渲染路径 = Message.tsx case 'system'/'local_command' →
      // UserTextMessage（<local-command-stdout> 灰字输出）。内容在顶层 content 字符串，
      // 解析为居中提示行下发；其余 system 子类型维持跳过。
      if (msg.subtype !== 'local_command') continue
      if (!SHOW_NON_INTERRUPT_HINTS) continue // 非中断提示 web 隐藏（开关见上）
      const raw = typeof msg.content === 'string' ? msg.content : ''
      if (!raw) continue
      const name = extractXmlTag(raw, COMMAND_NAME_TAG)
      if (name) {
        const args = extractXmlTag(raw, COMMAND_ARGS_TAG)?.trim()
        pushSystemHint(args ? `${name} ${args}` : name, timestamp, msg.uuid)
      }
      const stdout = extractXmlTag(raw, LOCAL_COMMAND_STDOUT_TAG)
      if (stdout?.trim()) pushSystemHint(stdout.trim(), timestamp, msg.uuid)
      const stderr = extractXmlTag(raw, LOCAL_COMMAND_STDERR_TAG)
      if (stderr?.trim()) pushSystemHint(stderr.trim(), timestamp, msg.uuid)
      continue
    }

    if (msg.type === 'attachment') {
      // 引导注入消息（2026-08-30 共同后端定案）：CLI 终端实际渲染 queued_command 附件
      // （AttachmentMessage.tsx → UserTextMessage，回合中注入消费），此前整体丢弃属
      // 「权威过滤与 CLI 实际显示脱节」。可见性判据照抄 messages.ts:3742-3756：origin
      // 回退 task-notification；origin/isMeta 任一存在 = 系统生成 → 隐藏（对齐
      // SHOW_NON_INTERRUPT_HINTS=false 现状）。人发 → role:'user' + injected:true。
      // 注：非 ant 环境 attachment 不落盘（isLoggableMessage，sessionStorage.ts），本分支
      // 只作用于实时内存链路；历史回放无 attachment 记录 = 与 CLI resume 行为同构。
      const att = msg.attachment
      if (att?.type === 'queued_command') {
        const origin =
          att.origin ??
          (att.commandMode === 'task-notification' ? { kind: 'task-notification' } : undefined)
        if (origin === undefined && !att.isMeta) {
          // 跨会话消息（2026-09-15 会话间协作）：正文包在包装里，先剥离（来源走 fromSession）
          const sx = stripSessionPrompt(att.prompt ?? '')
          const blocks: DisplayBlock[] = []
          if (typeof sx.prompt === 'string') {
            if (sx.prompt.trim()) blocks.push({ kind: 'text', text: sx.prompt })
          } else if (Array.isArray(sx.prompt)) {
            // imagePasteIds 按 content 内 image 块序对位（getImagePasteIds 契约）；imgIdx 只对
            // image 块递增——原实现逐块递增，数组形态（text+image）下 text 块抢走 ids[0] 使全部
            // 图错位丢 id（user 分支因 normalizeMessages 拆出 image-only 单条、image 恒为首块而
            // 无此问题；attachment 数组 prompt 无拆分工序，此处自对位）。2026-08-30 引导消息带图。
            let imgIdx = 0
            for (const b of sx.prompt) {
              if (b?.type === 'image') {
                blocks.push({ kind: 'image', imageId: att.imagePasteIds?.[imgIdx++] })
              } else {
                const db = toDisplayBlock(b)
                if (db) blocks.push(db)
              }
            }
          }
          if (blocks.length) {
            out.push({
              role: 'user',
              blocks,
              timestamp,
              injected: true,
              uuid: msg.uuid,
              ...(sx.source ? { fromSession: sx.source } : {}),
            })
          }
        }
      }
      continue
    }

    const content = msg.message?.content
    if (!Array.isArray(content)) continue

    if (msg.type === 'user') {
      if (isInterruptUserMessage(msg)) {
        pushSystemHint('用户中断了对话', timestamp, msg.uuid)
        continue
      }
      // 后台任务通知（2026-08-27 定案转居中提示；2026-09-09 用户定案恒显示——通知唤醒续跑
      // 的回合里两次正式发言之间的空隙需原位可见，web=居中浅灰气泡按时序堆叠，不再受
      // SHOW_NON_INTERRUPT_HINTS 总开关管辖）：转录把系统通知记成无 isMeta 的 user 记录
      // （origin.kind === 'task-notification'，内容 = <task-notification> XML 字符串，normalizeMessages
      // 转为 text 块），曾被当真实用户渲染成气泡。判据 = origin 字段（最可靠）+ 文本前缀兜底
      // （老记录无 origin）；文案对齐 SubPj1 server.mjs synthLabel（离线兜底镜像）。
      const notifyTexts = content
        .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
      const isTaskNotify =
        msg.origin?.kind === TASK_NOTIFICATION_TAG ||
        notifyTexts.some(t => t.trimStart().startsWith(`<${TASK_NOTIFICATION_TAG}>`))
      if (isTaskNotify) {
        const summary = extractXmlTag(notifyTexts.join('\n'), 'summary')?.trim()
        pushSystemHint(summary ? `后台任务完成：${summary}` : '后台任务通知', timestamp, msg.uuid)
        continue
      }
      if (!shouldShowUserMessage(msg, isTranscript)) continue
      // 真实用户消息 = 回合边界：先结算上一回合的用量，再开启本回合。
      // tool_result 的 user 记录是回合内的工具回填（同一回合仍可能有后续请求），不是真实输入，不切回合。
      const isToolResultRecord = Array.isArray(content) && content.some((b) => b?.type === 'tool_result')
      if (!isToolResultRecord) {
        closeTurnUsage()
        turnHasStart = true
      }
      const blocks: DisplayBlock[] = []
      let imgIdx = 0
      // 跨会话消息（2026-09-15 会话间协作）：user 记录里正文同样带包装（落盘即包装文本），
      // 剥离后来源走 fromSession（attachment 与 user 两形态共用 stripSessionPrompt）
      let fromSession: SessionSource | undefined
      for (const b of content) {
        const db = toDisplayBlock(b, msg.imagePasteIds?.[imgIdx++])
        if (db?.kind === 'text' && typeof db.text === 'string') {
          const px = parseSessionMessage(db.text)
          if (px) {
            fromSession = px.source
            db.text = px.body
          }
        }
        // 指令输入的 user XML echo 形态（2026-08-27 定案转居中提示行；原为静默剔除）：
        // immediateCommand（如 /server）只走此形态；非 immediate（如 /rename）另写 system/local_command
        // 双记录（见 system 分支），两形态互补不重复。<bash-input> = !bash 命令行。
        if (db?.kind === 'text' && db.text && db.text.includes(`<${COMMAND_MESSAGE_TAG}>`)) {
          if (SHOW_NON_INTERRUPT_HINTS) {
            const name = extractXmlTag(db.text, COMMAND_NAME_TAG)
            if (name) {
              const args = extractXmlTag(db.text, COMMAND_ARGS_TAG)?.trim()
              pushSystemHint(args ? `${name.trim()} ${args}` : name.trim(), timestamp, msg.uuid)
            }
          }
          continue
        }
        if (db?.kind === 'text' && db.text && db.text.includes('<bash-input>')) {
          if (SHOW_NON_INTERRUPT_HINTS) {
            const cmd = extractXmlTag(db.text, 'bash-input')
            if (cmd?.trim()) pushSystemHint(`$ ${cmd.trim()}`, timestamp, msg.uuid)
          }
          continue
        }
        if (db) blocks.push(db)
      }
      if (blocks.length) {
        // 纯图片块重组（2026-08-30 web 内联图）：normalizeMessages 会把「text+image」人发消息拆成
        // text-only 与 image-only 两条（CLI 终端分别渲染文本行 + [Image #N] 链接），web 消费端若
        // 原样输出就出现两个气泡。这里在权威导出层把 image-only 消息并回紧邻的前一条真人 user
        // 消息（= 拆分前原始 jsonl 记录同构），条件缺一不可：
        //   ① 本条 blocks 全为 image 且带 imageId；② 前一条 out 消息是 user 且其 text 含对应
        //   [Image #id] 占位（保证语义配对，工具截图等 image-only 消息因前面是 assistant/无占位
        //   而自然不合并）。前端据合并后的 blocks 渲染「图上文下」单气泡并剥离占位文本。
        const ids = blocks.map(b => (b.kind === 'image' ? b.imageId : undefined)).filter((x): x is number => x !== undefined)
        const isImageOnly = ids.length === blocks.length && ids.length > 0
        const prev = out[out.length - 1]
        const prevText =
          prev?.role === 'user'
            ? prev.blocks.filter(b => b.kind === 'text').map(b => b.text || '').join('')
            : ''
        if (isImageOnly && prevText && ids.every(id => prevText.includes(`[Image #${id}]`))) {
          prev.blocks.push(...blocks)
        } else {
          out.push({
            role: 'user',
            blocks,
            timestamp,
            uuid: msg.uuid,
            ...(fromSession ? { fromSession } : {}),
          })
        }
      }
      continue
    }

    if (msg.type === 'assistant') {
      // resume 补位哨兵（conversationRecovery 在末尾 user 消息后追加的 NO_RESPONSE_REQUESTED
      // assistant 占位，保 API 结构合法）：数据层保留、UI 全端永不显示（2026-09-10 用户定案）。
      // CLI 渲染已在 AssistantTextMessage 按精确文本 return null；web 侧曾从本投影漏出被渲染成
      // 回复气泡（用户实测「No response requested.」入列），此处权威剔除，历史回放与实时投影同治。
      if (content.some(b => b.type === 'text' && b.text === NO_RESPONSE_REQUESTED)) continue
      // 模型切换派生提示（2026-08-27）：assistant 记录自带实际请求模型名；流式回合内各片段同模型，
      // 切到新模型的第一条记录即新回合起点——提示自然落在回合结束后的边界（切在思考中也回合结束才出现）。
      // 注意：/model 是 local-jsx 命令，「Set model to …」不落盘，派生是历史回放唯一数据源。
      const model = typeof msg.message.model === 'string' && msg.message.model ? msg.message.model : undefined
      if (SHOW_NON_INTERRUPT_HINTS && model && lastModel && model !== lastModel) pushSystemHint(`已切换模型：${model}`, timestamp)
      if (model) lastModel = model
      const blocks: DisplayBlock[] = []
      for (let j = 0; j < content.length; j++) {
        const b = content[j]
        if (b.type === 'thinking') {
          if (!isTranscript && !isTailThink) continue // prompt：不显示完成思考
          const id = `${msg.uuid}:${j}`
          if (isTranscript) {
            if (!(lastId && id === lastId)) continue // transcript：只留全局最后一个
          } else if (!(tailPassId && id === tailPassId)) continue // prompt-tail-think：只留尾巴选中块，历史全剔
        } else if (b.type === 'redacted_thinking') {
          if (!isTranscript && !isTailThink) continue // prompt：不显示完成思考；transcript 恒显示（对齐 Message.tsx）
          if (isTailThink) {
            const id = `${msg.uuid}:${j}`
            if (!(tailPassId && id === tailPassId)) continue // 与 thinking 同一竞争键，只留尾巴选中的一块
          }
        }
        const db = toDisplayBlock(b)
        if (db) blocks.push(db)
      }
      // 429 限流降级提示（errors.ts rateLimitFallbackNotice）：转 role:'system' 居中灰提示
      // 下发（2026-09-10 用户定案「降级提示以居中灰色字体可见」——同后台任务通知先例，不受
      // SHOW_NON_INTERRUPT_HINTS 总开关管辖）。web 端 .msg.system 即居中灰胶囊，零前端改动。
      const noticeText = blocks
        .filter(b => b.kind === 'text')
        .map(b => b.text || '')
        .join('\n')
        .trim()
      if (noticeText.startsWith(RATE_LIMIT_FALLBACK_NOTICE_PREFIX)) {
        pushSystemHint(noticeText, timestamp, msg.uuid)
        continue
      }
      // 用量先入回合账（纯 thinking/无可见块被过滤的记录同样是已计费的 API 响应）
      const usage = usageDetail(msg.message?.usage)
      if (usage) foldAttemptUsage(msg.message?.id ?? msg.uuid ?? '', usage)
      if (blocks.length) {
        const model = typeof msg.message?.model === 'string' && msg.message.model ? msg.message.model : undefined
        out.push({ role: 'assistant', blocks, timestamp, stopReason: msg.message?.stop_reason as string | undefined, uuid: msg.uuid, ...(model !== undefined ? { model } : {}) })
        turnLastAssistant = out.length - 1
      }
      continue
    }

    // tool / progress / 其它 system 子类型：CLI 已把 tool_result 收进 user 消息，此处跳过
  }
  // 末回合结算（回合进行中时也随时给出当前累计，流式过程中按钮数值随每次响应更新）
  closeTurnUsage()
  // ── 归一化稳定键赋值（2026-09-10 长会话 delta 对齐根修，勿删）──
  // 问题：normalizeMessages 的 uuid 派生受 isNewChain 粘性标志影响（遇多块消息后恒派生），
  // 而该标志取决于「在输入数组中的位置」——CLI 侧输入是 capRenderedMessages 的 200 条尾部
  // 窗口（utils/renderCap.ts:15），网关侧输入是 jsonl 全量。窗口每滑一条，派生分界点随之
  // 漂移 → 同一消息在两端 uuid 时裸时派生 → 一切基于 uuid 的跨轮/跨端对齐（delta base0、
  // 网关 mergeDisplay）在长会话下必然失配（实证：CLI base=145/170 vs 网关投影 732/5447，
  // web 端「历史截断拒收」→ 全量对账风暴 → 回合中零更新）。
  // 解法：不改 normalizeMessages（改动面过大），在投影出口构造位置无关稳定键——源记录 uuid
  // 前 24 位为派生恒保留的不变前缀（Messages.tsx:240/528、REPL.tsx:3979 已依赖此语义做前缀
  // 匹配），配以同 parent 内块序（遍历计数，与 deriveUUID 的 index 同源）即得稳定 id。
  // 无源 uuid 的派生提示行（中断/后台任务/限流降级等）以内容+时间戳为身份。
  {
    let prevParent = ''
    let blockIdx = 0
    for (const m of out) {
      const u = typeof m.uuid === 'string' ? m.uuid : ''
      if (u) {
        const parent = u.slice(0, 24)
        if (parent === prevParent) blockIdx++
        else { prevParent = parent; blockIdx = 0 }
        m.sid = `${parent}#${blockIdx}`
      } else {
        prevParent = ''
        blockIdx = 0
        const text = m.blocks.map(b => b.text ?? '').join('')
        const ts = typeof m.timestamp === 'number' ? m.timestamp : 0
        m.sid = `h#${ts}#${text.slice(0, 32)}`
      }
    }
  }
  if (opts?.lastModelOut) opts.lastModelOut.lastModel = lastModel
  return out
}

/**
 * 发送过滤结果给遥测服务器（网关）。服务器地址优先环境变量 `FLOIRA_GATEWAY`，
 * 未配置时回退网关默认本地地址 `http://127.0.0.1:8124`（`/server on` 默认 0.0.0.0:8124，
 * 本机 127.0.0.1 可达）——网关没起则 POST 静默失败，不打扰本地 CLI。
 */
// 安全加固（2026-08-15）：网关 HTTP 数据接口要求 token。进程内网关启动时会把当前 token
// 写入 gatewayToken.ts（见 localGateway.startLocalGateway）；本进程上报据此附加 query。
// 网关未启动 / 未由本进程管理时 token 为空 → 不带参数，保持旧静默失败行为（不报错、不打扰）。
function gatewayApiUrl(base: string, path: string): string {
  const tok = getGatewayToken()
  const b = base.replace(/\/+$/, '')
  if (!tok) return `${b}${path}`
  return `${b}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(tok)}`
}

export async function sendConversationToServer(
  sessionId: string,
  display: DisplayMessage[],
  /** P2 增量水位（2026-08-31）：传入 = 网关保留缓存前 base 条、替换其后内容；缺省 = 全量替换。 */
  base?: number,
): Promise<boolean> {
  const base0 = process.env.FLOIRA_GATEWAY || 'http://127.0.0.1:8124'
  try {
    const res = await fetch(gatewayApiUrl(base0, '/gateway/conversation'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, messages: display, ...(base !== undefined ? { base } : {}) }),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return false
    if (base !== undefined) {
      // 增量模式校验网关合并结果（cached = 合并后总长）：不符 = 网关重启/缓存被 sweep 等
      // 失步 → 返回 false，上层置失步标下轮全量对账。响应解析失败宽松放行（网关同版打包）。
      try {
        const j = (await res.json()) as { cached?: number }
        if (typeof j.cached === 'number' && j.cached !== base + display.length) return false
      } catch {}
    }
    return true
  } catch {
    return false
  }
}

/**
 * 已上报展示投影缓存（P2 增量上报的 CLI 侧基线，2026-08-31）：
 * 键 = `${sessionId}:${mode}`（transcript/prompt 两种投影独立维护）。sent = 已成功上报的
 * 投影**尾部窗口**（增量对齐基线，有界：见 setCacheSent）；lastModel = 上次扫描终点模型
 * （窗口投影续算「已切换模型」提示的跨扫描状态）；needFullSync = 网关失步，下轮直传对账。
 * 只存轻量展示投影（过滤后的 blocks），与网关 conversationDisplays 同源同量级，进程退出即清。
 */
type DisplayCacheEntry = {
  /** 已上报投影的**尾部窗口**（≤ SENT_WINDOW 条），恒定等于全量投影的 slice(sentOffset)。 */
  sent: DisplayMessage[]
  /** sent[0] 在全量投影中的绝对下标（被丢弃的头部条数）。base 上报仍是绝对坐标。 */
  sentOffset: number
  lastModel?: string
  needFullSync?: boolean
}
const displayCacheBySession = new Map<string, DisplayCacheEntry>()

/** cache.sent 保留的投影尾部条数（2026-09-22 有界化）：缓存只需承载「对齐 + 尾部窗口」，
 *  全量投影在网关/jsonl 侧各有权威，CLI 进程没有理由整份驻留。取值须 > P1 渲染窗口
 *  （renderCap.ts MAX_RENDER_MESSAGES=200）——sent 覆盖范围恒 ⊇ 投影窗口时，display[0]
 *  才稳定能在 sent 内定位；否则每轮退化为窗口全量替换，P2 的峰值有界性丢失。 */
const SENT_WINDOW = 400

/** 缓存窗口只读诊断（锚点：probes/probe-render-cap-layering.ts）——sent 条数 + 绝对起点。 */
export function displayCacheStats(sessionId: string, mode: DisplayMode): { sent: number; sentOffset: number } | null {
  const c = displayCacheBySession.get(`${sessionId}:${mode}`)
  return c ? { sent: c.sent.length, sentOffset: c.sentOffset } : null
}

/** 唯一写入口：整份投影进、尾部窗口 + 绝对偏移落（sentOffset = 绝对起点）。 */
function setCacheSent(cache: DisplayCacheEntry, sent: DisplayMessage[], offset: number): void {
  if (sent.length > SENT_WINDOW) {
    cache.sentOffset = offset + sent.length - SENT_WINDOW
    cache.sent = sent.slice(sent.length - SENT_WINDOW)
  } else {
    cache.sentOffset = offset
    cache.sent = sent
  }
}

/**
 * delta 序号账本（2026-09-10 二轮根修，进程生命周期，**独立于展示缓存条目**）：
 * 旧实现把 seq 存在 DisplayCacheEntry 里，而全量路径 `displayCacheBySession.set(key,{sent,lastModel})`
 * （下 659 行，全模块唯一 .set）重建条目时静默丢掉 seq → CLI 侧序号回落到 1；网关侧
 * sessionDeltaSeq 是进程内存、只由 cli-hello 重置（localGateway.ts:3373）且 `seq <= last` 静默
 * 丢弃（3461-3463）→ 塌缩/head-miss 之后每条 delta 都被吞，直到序号重新爬过水位（水位越高遮蔽
 * 越久，长会话实时通道长期静默；实证：探针塌缩后 184 帧连丢、206 次 commit 才恢复）。迁出后
 * 不变量成立：**delta 序号单调递增、只在 CLI 进程重启时归零** —— 与网关唯一的水位复位锚点
 * （cli-hello = 进程身份确立）是同一个事件，缓存重建（塌缩/失步/重连）不再回退序号。
 */
const deltaSeqBySession = new Map<string, number>()

/** 组合入口：过滤 + 增量发送一步完成，返回过滤结果（REPL 渲染处调用）。
 * P2（2026-08-31，20260828145952-内存增长根因与代码层修改建议.md）：全量上报改为
 * 「已上报水位对齐 + 尾部窗口投影」——输入经 P1 cap 恒为尾部窗口（≤200 条），单轮
 * 构建/序列化/传输峰值全部有界；网关 /gateway/conversation 按 base 聚合为全量，
 * 遥测端全量语义不变、web 前端零改动。已知名义缺口：CLI 进程重启后 cache 空且窗口
 * 首条对不上网关缓存时走窗口全量替换（前缀短暂缺失），jsonl 权威在盘可恢复。 */
export async function exportConversationToServer(
  messages: readonly SourceMessage[],
  sessionId: string,
  mode: DisplayMode,
): Promise<DisplayMessage[]> {
  const cacheKey = `${sessionId}:${mode}`
  const cache = displayCacheBySession.get(cacheKey)
  const lastModelOut: { lastModel?: string } = {}
  const display = filterConversationForDisplay(messages, mode, {
    initialLastModel: cache?.lastModel,
    lastModelOut,
  })
  const lastModel = lastModelOut.lastModel

  // 塌缩瞬态守卫（2026-09-10 二轮根修）：投影为空 ≠ 会话空了。REACTIVE_COMPACT 边界
  // `setMessages(() => [boundary])` 把 state 收缩为单条 compact_boundary（投影层 338 行跳过
  // system/非 local_command）时 display 为空，旧实现落到下方全量路径：向网关 POST 空会话
  // （/gateway/conversation 无 base = 全量替换，网关 conversationDisplays 被 set(sid,{messages:[]})
  // 抹掉）+ 本地 cache.sent 清空（buildDisplayDelta 因 sent 空静默）＝基线双毁。不变量：
  // **cache.sent 恒等于「最后一次成功上报的完整投影」**，瞬态空投影不是新基线——本轮不 POST、
  // 不推进基线，等下一次非空投影（同一轮内 state 回补）按正常对齐语义续上。
  if (cache && display.length === 0) return display

  // 失步后的强制对账：sent 已在失步轮本地合并（含前缀），带**绝对** sentOffset 直传恢复网关完整
  // （不能省 base 直传：视窗化的 sent 无 base 会退化成「网关缓存被尾部窗口整体替换」）。网关缓存
  // 比 sentOffset 短（被 sweep/重启，前缀无法复现）时 cached 校验不符 → 失步标保留，由
  // /gateway/session 磁盘权威链恢复。
  if (cache?.needFullSync && cache.sent.length > 0) {
    if (await sendConversationToServer(sessionId, cache.sent, cache.sentOffset)) cache.needFullSync = false
    return display
  }

  if (cache && display.length > 0 && display[0]!.sid) {
    // 对齐键 = 稳定键 sid（2026-09-10 协议根修）：旧实现用 display[0].uuid 在已上报序列中定位
    // 水位，而 uuid 受 normalizeMessages 的 isNewChain 位置相关派生影响——CLI 侧输入是 200 条
    // 尾部窗口、跨轮滑动会让同一条记录的 uuid 时裸时派生 → 对齐恒失配 → 每轮退化为「窗口全量
    // 替换」，网关缓存被 200 条窗口覆盖（P2 名义缺口常态化）。sid 位置无关（见下稳定键赋值段），
    // 跨轮/跨端恒一致。
    const idx = cache.sent.findIndex(m => m.sid && m.sid === display[0]!.sid)
    if (idx >= 0) {
      // 上报 base = 绝对下标（缓存窗口起点 + 窗口内偏移），网关侧坐标与 sent 视窗化前一致。
      const base = cache.sentOffset + idx
      // 窗口覆盖不变量（与 buildDisplayDelta 同款；两侧同减 sentOffset 后即旧式比较）：
      // display 未覆盖到 sent 末尾 = state 塌缩瞬态，禁止 merged = display（idx===0 时会直接把
      // 基线截断），本轮不推进基线。
      if (idx + display.length < cache.sent.length) return display
      // 合并基线（窗口坐标；merged[0] 恒 = sent[0] ⇒ 偏移沿用 sentOffset）
      const mergedSent = idx === 0 ? display : [...cache.sent.slice(0, idx), ...display]
      if (await sendConversationToServer(sessionId, display, base)) {
        setCacheSent(cache, mergedSent, cache.sentOffset)
        cache.lastModel = lastModel
      } else {
        // 发送异常（网关不在）或网关失步（cached 校验不符）：本地先合并基线并置失步标，
        // 下轮直传对账（网关重启/sweep 场景都能恢复完整）。
        setCacheSent(cache, mergedSent, cache.sentOffset)
        cache.lastModel = lastModel
        cache.needFullSync = true
      }
      return display
    }
  }

  // 常规全量路径：首报 / 对齐未命中（CLI 重启后 cache 空、窗口滑出基线记忆）
  await sendConversationToServer(sessionId, display)
  const entry: DisplayCacheEntry = { sent: [], sentOffset: 0, lastModel }
  setCacheSent(entry, display, 0)
  displayCacheBySession.set(cacheKey, entry)
  return display
}

/**
 * 「尾部替换」增量构建（2026-09-08 事件流统一 P1，方案 20260908135557）：以 sent（上次发出的
 * 全量投影序列）为基线，求 display 相对 sent 的尾部差异——delta = { base: 分歧点在 sent 中的
 * 绝对位置, messages: display 自分歧点起的尾部 }。消费端应用 = 本地序列 slice(0, base).concat
 * (messages)，编码为「锚点 + 锚点之后整体替换」（幂等，无需三态标记）：append / 末条 blocks
 * 更新 / 段收口统一此形态。
 * 2026-09-10 协议根修：旧实现发「数字坐标 base（sent 水位）+ 尾部」，消费端按长度拼接；但 CLI
 * 侧输入是 capRenderedMessages 的 200 条窗口、消费端是全量投影，长会话下两侧长度与 uuid 派生
 * 规则都不同（详见 filterConversationForDisplay 末尾稳定键注释）→ base 恒越界、delta 恒被拒。
 * 现改为内容标识对齐：anchorSid = 分歧点前一条的稳定键，消费端定位后替换其后全部，长度差异
 * 不再参与判定。
 * 返回 null = 无可见变化或无可靠基线：CLI 重启后 cache 空由 exportConversationToServer 全量
 * POST 建基线，此后本函数才可用——窗口全量不作 delta 下发（web 端会截断历史前缀，对账链
 * /gateway/session 才是完整全量源）。投影结构失步（压缩/撤回/窗口滑出基线记忆，display 窗口
 * 首条对不上 sent）同样不发，对账链恢复。
 * 仅供 prompt 屏调用且恒以 'prompt-tail-think'（2026-09-08 同构根修：与网关 readSession 同
 * mode，base 坐标与 web fetch 序列恒对齐；'prompt' 会因尾巴 thinking 条数差产生截断错位。
 * transcript 屏投影不进事件流）。
 * delta 构建即视为已发出（sent 就地推进、seq 递增）：WS 断开静默丢失不回滚，web 端 seq gap
 * → 全量对账重建（不缓存 delta 历史，方案 §3.5 无状态转发定案）。
 */
/** 逐条比对键（buildDisplayDelta 专用）：剥 uuid 后序列化（理由见调用处注释）。 */
function cmpKey(m: DisplayMessage): string {
  return JSON.stringify(m, (k, v) => (k === 'uuid' ? undefined : v))
}

export function buildDisplayDelta(
  messages: readonly SourceMessage[],
  sessionId: string,
  mode: DisplayMode,
): { seq: number; anchorSid: string; messages: DisplayMessage[] } | null {
  const cacheKey = `${sessionId}:${mode}`
  const cache = displayCacheBySession.get(cacheKey)
  if (!cache || cache.sent.length === 0) return null
  const lastModelOut: { lastModel?: string } = {}
  const display = filterConversationForDisplay(messages, mode, {
    initialLastModel: cache.lastModel,
    lastModelOut,
  })
  // 窗口对齐：以稳定键 sid 在 sent 中定位 display 首条（sid 位置无关，见 filterConversationForDisplay
  // 末尾赋值段——旧实现用 uuid，长会话下受 isNewChain 位置相关派生影响恒失配）。
  // lastModel 仅在 delta 实际发出时回写（与 exportConversationToServer 失步 return 不回写同语义：
  // 保留下轮重产「已切换模型」提示）。
  const base0 = display.length ? cache.sent.findIndex((m) => m.sid && m.sid === display[0]!.sid) : -1
  if (base0 < 0) return null
  // 分歧点：自 base0 逐条比对至第一条不同。比对先剥掉 uuid——它是位置相关派生物（见稳定键注释：
  // 窗口滑动会让同一条记录的 uuid 时裸时派生），留在比对里会让每一轮都判「首行即分歧」，delta
  // 载荷退化为整窗重发（2026-09-10 探针实证：40 轮每轮 200+ 条）。记录身份已由 sid 承载，web 端
  // 不消费 uuid（gateway/web-src 无 .uuid 引用）。未知字段仍参与比对（下落不明的新字段不会被漏掉）。
  // append-only 常态成本 O(变化量)（每轮只序列化到首条分歧），block 级触发率 ~2.5/s 可承受。
  let k = base0
  while (k < cache.sent.length && k - base0 < display.length) {
    if (cmpKey(cache.sent[k]!) !== cmpKey(display[k - base0]!)) break
    k++
  }
  if (k - base0 >= display.length) return null // 与 sent 完全一致且无新增
  // 窗口覆盖不变量：新投影必须到达 sent 末尾（base0 + display.length >= sent.length；两侧同为
  // 缓存窗口坐标、sentOffset 相消，与旧式绝对比较等价）才可发
  // delta。不满足 = CLI React state 处于塌缩/重建瞬态（实证：非全屏 REACTIVE_COMPACT 边界
  // setMessages(() => [boundary]) 把 state 收缩为单条，随后逐条回补，每个中间 commit 都会
  // 触发本函数）——此时发出的小基线 delta 会把 web 已提交历史截断成残段（2026-09-09 录屏
  // 逐帧分析定案：web 数组被切到仅剩 [11:17 用户消息]，段收口卡「正在处理 2h 43m」）。
  // 正常尾部修正（思考蒸发/图片并回）只回改已发出的内容，窗口仍覆盖到 sent 末尾，不受此限；
  // 若回改恰好伴随窗口未覆盖，延迟一轮由下一条 delta 或 /gateway/session 对账自愈。
  if (base0 + display.length < cache.sent.length) return null
  // 锚点（2026-09-10 协议根修，替代旧数字坐标 base）：分歧点前一条的稳定键。消费端以
  // 「锚点之后整体替换」应用，不再要求 delta 覆盖到本地序列末尾——CLI 侧是 200 条窗口、
  // web 侧是全量投影，两侧长度天然不同，只有内容标识（sid）能跨端对齐。k=0（无前一条）
  // 属无可靠基线，不发，由 /gateway/session 对账链恢复。
  const anchorSid = k > 0 ? cache.sent[k - 1]!.sid : undefined
  if (!anchorSid) return null
  // 序号取进程级账本（不变量见 deltaSeqBySession 声明处）：缓存重建不得回退序号
  const seq = (deltaSeqBySession.get(cacheKey) ?? 0) + 1
  deltaSeqBySession.set(cacheKey, seq)
  const delta = { seq, anchorSid, messages: display.slice(k - base0) }
  cache.lastModel = lastModelOut.lastModel
  // 基线窗口坐标更新（merged[0] = sent[0] ⇒ 偏移不变）
  setCacheSent(cache, [...cache.sent.slice(0, k), ...display.slice(k - base0)], cache.sentOffset)
  return delta
}

// ---------- 会话活动状态上报（PID 情况只发送、不落盘）----------
// 参考 sendConversationToServer 模式：复用 FLOIRA_GATEWAY 通道 POST /gateway/activity，
// 网关在内存维护「当前打开的会话 + 运行/暂停状态」，前端据此显示绿/红点。
// 不写任何盘：concurrentSessions.ts 的 PID 写盘逻辑（registerSession/updateSessionActivity）
// 保持原样，此处只做「发送」。FLOIRA_GATEWAY 未配置时回退本地网关 127.0.0.1:8124
// （/server on 默认绑定 0.0.0.0:8124，本机 127.0.0.1 可达）；网关没起则 POST 静默失败。

export type SessionActivityStatus = 'busy' | 'idle' | 'waiting'

/**
 * 上报当前会话活动状态给网关（内存汇总、不落盘）。网关 /gateway/sessions 据此给每个会话附
 * `state`：busy=绿点（正在运行），idle/waiting=红点（运行暂停），无记录/进程退出=无点。
 * fire-and-forget，失败静默。
 */
export async function sendSessionActivity(
  sessionId: string,
  activity: { status: SessionActivityStatus; pid: number; cwd?: string },
): Promise<boolean> {
  const base = process.env.FLOIRA_GATEWAY || 'http://127.0.0.1:8124'
  if (!base) return false
  try {
    const res = await fetch(gatewayApiUrl(base, '/gateway/activity'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, ...activity }),
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}
