/**
 * web 底栏用量/上下文数据源（2026-11-28 下沉：原网关 readSession 从 jsonl 提取上下文占用，
 * 网关只应传输数据）。CLI 在 messages 变化时算一份快照 → /clients WS {type:'usage-state'} →
 * 网关仅存转发 → web 底栏 token 用量胶囊 + 上下文环。
 *
 * 口径：
 * - usage = 会话累计（cost-tracker 累加器，/cost 同源）：total = 未缓存输入 + 缓存读取 + 缓存写入 + 输出，
 *   缓存命中率 = 缓存读取 / 计费输入（dsh StatsPills 契约）。
 * - context = 最近一次 API 调用的真实 usage（input+cacheCreate+cacheRead）÷ 模型窗口；
 *   breakdown 为转录估算（roughTokenCountEstimation，与 api/claude.ts 同口径），fixed = 用量 − 估算和。
 */
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  getEffectiveContextWindowSize,
} from '../services/compact/autoCompact.js'
import {
  roughTokenCountEstimation,
  roughTokenCountEstimationForMessage,
} from '../services/tokenEstimation.js'
import {
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalInputTokens,
  getTotalOutputTokens,
} from '../cost-tracker.js'
import type { Message } from '../types/message.js'
import { getContextWindowForModel } from './context.js'
import { getTokenUsage } from './tokens.js'

export type UsageBreakdown = {
  fixed: number
  user: number
  assistant: number
  thinking: number
  toolCall: number
  toolResult: number
  attachment: number
}

export type SessionUsageSnapshot = {
  total: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  cacheHit: number | null
  model: string | null
}

export type ContextSnapshot = {
  usedTokens: number
  contextWindow: number
  percent: number
  model: string
  autoCompactThreshold: number
  usage: { input: number; cacheCreate: number; cacheRead: number; output: number }
  breakdown: UsageBreakdown
  topTools: Array<{ name: string; tokens: number }>
  topAttachments: Array<{ name: string; tokens: number }>
}

type MsgEstimate = {
  breakdown: UsageBreakdown
  tools: Map<string, number>
  attachments: Map<string, number>
}

const zeroBreakdown = (): UsageBreakdown => ({
  fixed: 0,
  user: 0,
  assistant: 0,
  thinking: 0,
  toolCall: 0,
  toolResult: 0,
  attachment: 0,
})

function addBlock(b: UsageBreakdown, name: string, tokens: number): void {
  ;(b as Record<string, number>)[name] += tokens
}

// tool_use id → 工具名（tool_result 归属命名）：按时间序累积，跨消息解析。
const toolNames = new Map<string, string>()
// 每条消息的估算结果（消息对象稳定引用：流式只替换末条，历史消息命中缓存）。
const estimateCache = new WeakMap<object, MsgEstimate>()

function estimateContent(content: unknown): { breakdown: UsageBreakdown; tools: Map<string, number> } {
  const breakdown = zeroBreakdown()
  const tools = new Map<string, number>()
  const addTool = (name: string, tokens: number): void => {
    tools.set(name, (tools.get(name) ?? 0) + tokens)
  }
  const walk = (c: unknown, bucket: 'user' | 'assistant'): void => {
    if (typeof c === 'string') {
      breakdown[bucket] += roughTokenCountEstimation(c)
      return
    }
    if (!Array.isArray(c)) return
    for (const block of c) {
      if (typeof block === 'string') {
        breakdown[bucket] += roughTokenCountEstimation(block)
        continue
      }
      const b = block as Record<string, unknown>
      const type = typeof b?.type === 'string' ? b.type : ''
      if (type === 'tool_use') {
        const name = typeof b.name === 'string' ? b.name : 'unknown'
        if (typeof b.id === 'string') toolNames.set(b.id, name)
        let input = ''
        try {
          input = JSON.stringify(b.input ?? {})
        } catch {
          input = ''
        }
        const tokens = roughTokenCountEstimation(name + input)
        breakdown.toolCall += tokens
        addTool(name, tokens)
      } else if (type === 'tool_result') {
        const name =
          typeof b.tool_use_id === 'string' ? (toolNames.get(b.tool_use_id) ?? 'unknown') : 'unknown'
        const tokens = estimateResultTokens(b.content)
        breakdown.toolResult += tokens
        addTool(name, tokens)
      } else if (type === 'thinking') {
        breakdown.thinking += roughTokenCountEstimation(
          typeof b.thinking === 'string' ? b.thinking : '',
        )
      } else if (type === 'redacted_thinking') {
        breakdown.thinking += roughTokenCountEstimation(typeof b.data === 'string' ? b.data : '')
      } else if (type === 'image' || type === 'document') {
        // 与 tokenEstimation.ts 同口径：图像/文档按 2000 估（禁对 base64 计长）。
        breakdown[bucket] += 2000
      } else if (type === 'text') {
        breakdown[bucket] += roughTokenCountEstimation(typeof b.text === 'string' ? b.text : '')
      } else {
        let s = ''
        try {
          s = JSON.stringify(b)
        } catch {
          s = ''
        }
        breakdown[bucket] += roughTokenCountEstimation(s)
      }
    }
  }
  return { breakdown, tools }
}

function estimateResultTokens(content: unknown): number {
  if (typeof content === 'string') return roughTokenCountEstimation(content)
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (typeof block === 'string') {
      total += roughTokenCountEstimation(block)
      continue
    }
    const b = block as Record<string, unknown>
    if (b?.type === 'text') total += roughTokenCountEstimation(typeof b.text === 'string' ? b.text : '')
    else if (b?.type === 'image' || b?.type === 'document') total += 2000
    else {
      let s = ''
      try {
        s = JSON.stringify(b)
      } catch {
        s = ''
      }
      total += roughTokenCountEstimation(s)
    }
  }
  return total
}

function estimateMessage(m: Message): MsgEstimate {
  const cached = estimateCache.get(m as object)
  if (cached) return cached
  let est: MsgEstimate
  if (m.type === 'attachment') {
    const breakdown = zeroBreakdown()
    const tokens = roughTokenCountEstimationForMessage(m as never)
    breakdown.attachment += tokens
    const attachments = new Map<string, number>()
    const att = (m as { attachment?: { type?: unknown } }).attachment
    attachments.set(typeof att?.type === 'string' ? att.type : 'unknown', tokens)
    est = { breakdown, tools: new Map(), attachments }
  } else {
    const content = (m as { message?: { content?: unknown } }).message?.content
    const role = m.type === 'user' ? 'user' : 'assistant'
    const { breakdown, tools } = estimateContent(content)
    est = { breakdown, tools, attachments: new Map() }
  }
  estimateCache.set(m as object, est)
  return est
}

function lastModelOf(messages: readonly Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { message?: { model?: unknown } } | undefined
    if (!m?.message || !getTokenUsage(messages[i]!)) continue
    return typeof m.message.model === 'string' && m.message.model ? m.message.model : null
  }
  return null
}

export function buildSessionUsage(model: string | null): SessionUsageSnapshot {
  const input = getTotalInputTokens()
  const cacheRead = getTotalCacheReadInputTokens()
  const cacheWrite = getTotalCacheCreationInputTokens()
  const output = getTotalOutputTokens()
  const billedInput = input + cacheRead + cacheWrite
  return {
    total: billedInput + output,
    input,
    cacheRead,
    cacheWrite,
    output,
    cacheHit: billedInput > 0 ? Math.round((cacheRead / billedInput) * 1000) / 10 : null,
    model,
  }
}

function buildContext(messages: readonly Message[], fallbackModel: string): ContextSnapshot | null {
  let usage: ReturnType<typeof getTokenUsage>
  let model = ''
  let index = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = getTokenUsage(messages[i]!)
    if (!u) continue
    usage = u
    index = i
    break
  }
  if (!usage) return null
  const last = messages[index] as { message?: { model?: unknown } } | undefined
  if (typeof last?.message?.model === 'string' && last.message.model) model = last.message.model
  if (!model) model = fallbackModel
  if (!model) return null
  const contextWindow = getContextWindowForModel(model)
  if (!contextWindow) return null

  const input = Number(usage.input_tokens) || 0
  const cacheCreate = Number(usage.cache_creation_input_tokens) || 0
  const cacheRead = Number(usage.cache_read_input_tokens) || 0
  const usedTokens = input + cacheCreate + cacheRead
  if (!usedTokens) return null
  const percent = Math.min(100, Math.round((usedTokens / contextWindow) * 100))

  const breakdown = zeroBreakdown()
  const tools = new Map<string, number>()
  const attachments = new Map<string, number>()
  for (const m of messages) {
    const est = estimateMessage(m)
    for (const key of Object.keys(breakdown) as Array<keyof UsageBreakdown>) {
      breakdown[key] += est.breakdown[key]
    }
    for (const [k, v] of est.tools) tools.set(k, (tools.get(k) ?? 0) + v)
    for (const [k, v] of est.attachments) attachments.set(k, (attachments.get(k) ?? 0) + v)
  }
  const estimated =
    breakdown.user +
    breakdown.assistant +
    breakdown.thinking +
    breakdown.toolCall +
    breakdown.toolResult +
    breakdown.attachment
  breakdown.fixed = Math.max(0, usedTokens - estimated)

  const top = (m: Map<string, number>): Array<{ name: string; tokens: number }> =>
    [...m.entries()]
      .filter(([, tokens]) => tokens > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, tokens]) => ({ name, tokens }))

  const autoCompactThreshold = Math.min(
    contextWindow,
    Math.max(0, getEffectiveContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS),
  )

  return {
    usedTokens,
    contextWindow,
    percent,
    model,
    autoCompactThreshold,
    usage: {
      input,
      cacheCreate,
      cacheRead,
      output: Number(usage.output_tokens) || 0,
    },
    breakdown,
    topTools: top(tools),
    topAttachments: top(attachments),
  }
}

export function buildUsageState(
  messages: readonly Message[],
  fallbackModel: string,
): { usage: SessionUsageSnapshot; context: ContextSnapshot | null } {
  const model = lastModelOf(messages) ?? (fallbackModel || null)
  return {
    usage: buildSessionUsage(model),
    context: buildContext(messages, fallbackModel),
  }
}
