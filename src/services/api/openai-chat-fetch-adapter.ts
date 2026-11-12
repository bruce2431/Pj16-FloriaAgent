/**
 * OpenAI Chat Completions Fetch Adapter
 *
 * Intercepts fetch calls from the Anthropic SDK and routes them to an
 * OpenAI Chat Completions endpoint, translating between Anthropic Messages
 * API format and OpenAI Chat Completions format.
 *
 * Companion to codex-fetch-adapter.ts (which targets the OpenAI *Responses*
 * API + ChatGPT OAuth). This one is generic: it talks to any OpenAI
 * Chat Completions base URL with a bearer API key — e.g. Gemini's
 * OpenAI-compat endpoint (`.../v1beta/openai`), plus OpenAI-compatible vendors.
 *
 * Contract (same as the Codex adapter): the entry receives an Anthropic-shaped
 * request and must emit an Anthropic-shaped response (SSE when the request had
 * `stream:true`, otherwise a single message JSON). The core's three SSE parsers
 * require the exact event sequence `message_start` → `content_block_*` →
 * `message_delta` → `message_stop`.
 */

// ── Thought-signature carrier ────────────────────────────────────────
//
// Gemini 3+ attaches an opaque `thought_signature` to every tool call and
// rejects the next request unless the same signature is echoed back on the
// matching functionCall. The core only persists {id,name,input} on tool_use
// blocks, so `extra_content` never survives the conversation store — but the
// id does (it is written verbatim and replayed as `tool_use_id`). The adapter
// therefore carries the signature inside the tool_use id itself, which keeps
// signed history replayable across process restarts and session resumes with
// no side store.

const ID_PAYLOAD_SEP = '__fs'

function encodeToolCallId(
  baseId: string,
  extra: Record<string, unknown> | undefined,
): string {
  if (!extra) return baseId
  const payload = Buffer.from(JSON.stringify(extra), 'utf8').toString('base64url')
  return `${baseId}${ID_PAYLOAD_SEP}${payload}`
}

function decodeToolCallId(id: string | undefined): {
  id: string
  extra?: Record<string, unknown>
} {
  if (!id) return { id: '' }
  const at = id.lastIndexOf(ID_PAYLOAD_SEP)
  if (at < 0) return { id }
  try {
    const parsed = JSON.parse(
      Buffer.from(id.slice(at + ID_PAYLOAD_SEP.length), 'base64url').toString('utf8'),
    )
    if (parsed && typeof parsed === 'object') {
      return { id: id.slice(0, at), extra: parsed as Record<string, unknown> }
    }
  } catch {
    // Not one of our ids — treat the whole string as the provider id.
  }
  return { id }
}

// ── Types ───────────────────────────────────────────────────────────

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  source?: { type?: string; media_type?: string; data?: string }
  [key: string]: unknown
}

interface AnthropicMessage {
  role: string
  content: string | AnthropicContentBlock[]
}

interface AnthropicTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

interface OpenAIToolCallDelta {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
  /**
   * Provider-specific opaque metadata attached to a tool call. Gemini 3+ puts
   * `{google:{thought_signature}}` here and rejects the *next* request with
   * "Function call is missing a thought_signature in functionCall parts"
   * unless it is echoed back verbatim on the same tool call.
   */
  extra_content?: Record<string, unknown>
}

// ── Request translation: Anthropic → OpenAI Chat Completions ─────────

function systemToText(
  system: string | Array<{ type: string; text?: string }> | undefined,
): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text!)
      .join('\n')
  }
  return ''
}

function toolResultText(block: AnthropicContentBlock): string {
  if (typeof block.content === 'string') return block.content
  if (Array.isArray(block.content)) {
    return block.content
      .map(c => (c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** Convert one Anthropic content block into an OpenAI user content part (or null to drop). */
function blockToUserPart(block: AnthropicContentBlock): Record<string, unknown> | null {
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text }
  }
  if (
    block.type === 'image' &&
    block.source?.type === 'base64' &&
    typeof block.source.data === 'string'
  ) {
    return {
      type: 'image_url',
      image_url: {
        url: `data:${block.source.media_type};base64,${block.source.data}`,
      },
    }
  }
  return null
}

function translateMessages(
  anthropicMessages: AnthropicMessage[],
): Array<Record<string, unknown>> {
  // Gemini 3+ rejects the whole request if any replayed functionCall part lacks
  // its thought_signature. Calls carrying one (encoded in the id, see
  // encodeToolCallId) replay as real tool_calls. Calls without one — history
  // written before this carrier existed, or a session resumed on another
  // provider — cannot be replayed as functionCall parts at all, so they are
  // dropped; their output is kept as plain user text. Never synthesise
  // `[tool call …]` syntax: the model imitates it as prose instead of calling
  // a tool.
  const signedIds = new Set<string>()
  for (const msg of anthropicMessages) {
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.id && decodeToolCallId(block.id).extra) {
        signedIds.add(block.id)
      }
    }
  }

  const out: Array<Record<string, unknown>> = []

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content })
      continue
    }
    if (!Array.isArray(msg.content)) continue

    if (msg.role === 'user') {
      // tool_result blocks become standalone `role:'tool'` messages; text/image
      // blocks become one `role:'user'` message (parts array when non-text).
      const userParts: Array<Record<string, unknown>> = []
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          const text = toolResultText(block)
          if (block.tool_use_id && signedIds.has(block.tool_use_id)) {
            out.push({
              role: 'tool',
              tool_call_id: decodeToolCallId(block.tool_use_id).id,
              content: text,
            })
          } else if (text) {
            userParts.push({ type: 'text', text })
          }
          continue
        }
        const part = blockToUserPart(block)
        if (part) userParts.push(part)
      }
      if (userParts.length === 1 && userParts[0].type === 'text') {
        out.push({ role: 'user', content: userParts[0].text })
      } else if (userParts.length > 0) {
        out.push({ role: 'user', content: userParts })
      }
    } else {
      // assistant / other: text as content, tool_use as tool_calls
      const textParts: string[] = []
      const toolCalls: Array<Record<string, unknown>> = []
      for (const block of msg.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text)
        } else if (block.type === 'tool_use') {
          const { id: baseId, extra } = decodeToolCallId(block.id)
          if (!extra) continue // unsigned legacy call: not replayable to Gemini
          toolCalls.push({
            id: baseId,
            type: 'function',
            function: {
              name: block.name || '',
              arguments: JSON.stringify(block.input || {}),
            },
            extra_content: extra,
          })
        }
        // thinking / redacted_thinking / others are dropped (no OpenAI equivalent)
      }
      const text = textParts.join('')
      const assistantMsg: Record<string, unknown> = { role: 'assistant' }
      assistantMsg.content = text.length > 0 ? text : null
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls
      if (text.length > 0 || toolCalls.length > 0) out.push(assistantMsg)
    }
  }

  return out
}

function translateTools(anthropicTools: AnthropicTool[]): Array<Record<string, unknown>> {
  return anthropicTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }))
}

function translateToolChoice(choice: unknown): unknown {
  if (!choice || typeof choice !== 'object') return undefined
  const c = choice as { type?: string; name?: string }
  switch (c.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'none':
      return 'none'
    case 'tool':
      return { type: 'function', function: { name: c.name ?? '' } }
    default:
      return undefined
  }
}

function translateRequestBody(anthropicBody: Record<string, unknown>): {
  openaiBody: Record<string, unknown>
  model: string
  stream: boolean
} {
  const messages = (anthropicBody.messages || []) as AnthropicMessage[]
  const system = anthropicBody.system as
    | string
    | Array<{ type: string; text?: string }>
    | undefined
  const tools = (anthropicBody.tools || []) as AnthropicTool[]
  const stream = anthropicBody.stream === true
  const model = String(anthropicBody.model ?? '')

  const openaiMessages: Array<Record<string, unknown>> = []
  const systemText = systemToText(system)
  if (systemText) openaiMessages.push({ role: 'system', content: systemText })
  openaiMessages.push(...translateMessages(messages))

  const openaiBody: Record<string, unknown> = {
    model,
    messages: openaiMessages,
    stream,
  }

  if (typeof anthropicBody.max_tokens === 'number') {
    openaiBody.max_tokens = anthropicBody.max_tokens
  }
  if (typeof anthropicBody.temperature === 'number') {
    openaiBody.temperature = anthropicBody.temperature
  }
  if (tools.length > 0) {
    openaiBody.tools = translateTools(tools)
    const toolChoice = translateToolChoice(anthropicBody.tool_choice)
    if (toolChoice !== undefined) openaiBody.tool_choice = toolChoice
  }
  if (stream) {
    // Ask the upstream for a final usage chunk (Gemini compat supports this).
    openaiBody.stream_options = { include_usage: true }
  }
  // Dropped: cache_control, thinking, betas, context_management, output_config,
  // speed, metadata, stop_sequences (no OpenAI Chat equivalent / core doesn't send).
  return { openaiBody, model, stream }
}

// ── Response translation: OpenAI Chat → Anthropic ────────────────────

interface OpenAIChatStreamChunk {
  id?: string
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  choices?: Array<{
    delta?: {
      content?: string | null
      tool_calls?: OpenAIToolCallDelta[]
    }
    finish_reason?: string | null
  }>
}

function mapStopReason(finishReason: string | null | undefined, hadToolCalls: boolean): string {
  switch (finishReason) {
    case 'tool_calls':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    default:
      return hadToolCalls ? 'tool_use' : 'end_turn'
  }
}

function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

function translateChatStreamToAnthropic(upstream: Response, model: string): Response {
  const messageId = `msg_oai_${Date.now()}`

  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      const emit = (event: string, payload: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(formatSSE(event, JSON.stringify(payload))))

      let nextIndex = 0
      let textIndex: number | null = null
      const toolIndexByOai = new Map<number, number>()
      let hadToolCalls = false
      let finishReason: string | null = null
      let sawDone = false
      let inputTokens = 0
      let outputTokens = 0
      let approxOutput = 0

      emit('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })

      const closeOpenBlocks = () => {
        const indices: number[] = []
        if (textIndex !== null) indices.push(textIndex)
        for (const idx of toolIndexByOai.values()) indices.push(idx)
        indices.sort((a, b) => a - b)
        for (const index of indices) {
          emit('content_block_stop', { type: 'content_block_stop', index })
        }
      }

      try {
        const reader = upstream.body?.getReader()
        if (!reader) throw new Error('no response body')

        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          const frames = buffer.split('\n')
          buffer = frames.pop() || ''

          for (const rawLine of frames) {
            const line = rawLine.trim()
            if (!line.startsWith('data:')) continue
            const dataStr = line.slice(5).trim()
            if (!dataStr) continue
            if (dataStr === '[DONE]') {
              sawDone = true
              continue
            }

            let chunk: OpenAIChatStreamChunk
            try {
              chunk = JSON.parse(dataStr)
            } catch {
              continue
            }

            if (chunk.usage) {
              if (typeof chunk.usage.prompt_tokens === 'number') {
                inputTokens = chunk.usage.prompt_tokens
              }
              if (typeof chunk.usage.completion_tokens === 'number') {
                outputTokens = chunk.usage.completion_tokens
              }
            }

            for (const choice of chunk.choices ?? []) {
              const delta = choice.delta
              if (delta && typeof delta.content === 'string' && delta.content.length > 0) {
                if (textIndex === null) {
                  textIndex = nextIndex++
                  emit('content_block_start', {
                    type: 'content_block_start',
                    index: textIndex,
                    content_block: { type: 'text', text: '' },
                  })
                }
                emit('content_block_delta', {
                  type: 'content_block_delta',
                  index: textIndex,
                  delta: { type: 'text_delta', text: delta.content },
                })
                approxOutput += delta.content.length
              }

              for (const tc of delta?.tool_calls ?? []) {
                const oaiIndex = tc.index ?? 0
                let blockIndex = toolIndexByOai.get(oaiIndex)
                if (blockIndex === undefined) {
                  blockIndex = nextIndex++
                  toolIndexByOai.set(oaiIndex, blockIndex)
                  hadToolCalls = true
                  const baseId = tc.id || `toolu_${Date.now()}_${oaiIndex}`
                  // Gemini ships thought_signature on the same delta as the id
                  // and the function name, so the id can carry it from the
                  // outset — no side store, no deferred block start.
                  const callId = encodeToolCallId(
                    baseId,
                    tc.extra_content && typeof tc.extra_content === 'object'
                      ? tc.extra_content
                      : undefined,
                  )
                  emit('content_block_start', {
                    type: 'content_block_start',
                    index: blockIndex,
                    content_block: {
                      type: 'tool_use',
                      id: callId,
                      name: tc.function?.name || '',
                      input: {},
                    },
                  })
                }
                const args = tc.function?.arguments
                if (typeof args === 'string' && args.length > 0) {
                  emit('content_block_delta', {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'input_json_delta', partial_json: args },
                  })
                  approxOutput += args.length
                }
              }

              if (choice.finish_reason) finishReason = choice.finish_reason
            }
          }
        }
      } catch (err) {
        // A mid-stream failure must not masquerade as a completed turn: the
        // core only retries/falls back when the stream itself errors. Turning
        // it into a text block marked `end_turn` swallowed the failure (seen
        // with Gemini when a long tool-call generation goes silent and the
        // connection drops) and left the turn dead with no retry.
        controller.error(err)
        return
      }

      // A well-formed OpenAI stream always ends with a finish_reason or
      // `data: [DONE]`. EOF without either means the upstream connection was
      // cut while the response was still being generated (Gemini compat does
      // this when the model spends too long producing a large function call).
      if (!sawDone && finishReason === null) {
        controller.error(
          new Error(
            'OpenAI chat stream ended prematurely: no finish_reason and no [DONE]',
          ),
        )
        return
      }

      closeOpenBlocks()

      if (outputTokens === 0) outputTokens = Math.ceil(approxOutput / 4)

      emit('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: mapStopReason(finishReason, hadToolCalls),
          stop_sequence: null,
        },
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      })
      emit('message_stop', { type: 'message_stop' })
      controller.close()
    },
  })

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'x-request-id': messageId,
    },
  })
}

interface OpenAIChatResponse {
  id?: string
  choices?: Array<{
    message?: {
      content?: string | null
      tool_calls?: Array<{
        id?: string
        function?: { name?: string; arguments?: string }
        extra_content?: Record<string, unknown>
      }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

function translateChatResponseToAnthropic(
  data: OpenAIChatResponse,
  model: string,
): Record<string, unknown> {
  const choice = data.choices?.[0]
  const message = choice?.message
  const content: Array<Record<string, unknown>> = []

  if (typeof message?.content === 'string' && message.content.length > 0) {
    content.push({ type: 'text', text: message.content })
  }
  for (const tc of message?.tool_calls ?? []) {
    let input: Record<string, unknown> = {}
    if (typeof tc.function?.arguments === 'string') {
      try {
        input = JSON.parse(tc.function.arguments)
      } catch {
        input = {}
      }
    }
    content.push({
      type: 'tool_use',
      id: encodeToolCallId(
        tc.id || `toolu_${Date.now()}`,
        tc.extra_content && typeof tc.extra_content === 'object'
          ? tc.extra_content
          : undefined,
      ),
      name: tc.function?.name || '',
      input,
    })
  }

  const hadToolCalls = content.some(b => b.type === 'tool_use')

  return {
    id: data.id || `msg_oai_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapStopReason(choice?.finish_reason, hadToolCalls),
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
  }
}

// ── Main fetch interceptor ───────────────────────────────────────────

export interface OpenAIChatAdapterOptions {
  /** OpenAI Chat Completions base URL (no trailing `/chat/completions`). */
  baseUrl: string
  /** Bearer API key for the endpoint. */
  apiKey: string
  /** Underlying fetch to delegate to; defaults to globalThis.fetch. */
  innerFetch?: typeof globalThis.fetch
}

/**
 * Creates a fetch function that intercepts Anthropic Messages calls and routes
 * them to an OpenAI Chat Completions endpoint. Non-messages URLs (count_tokens,
 * models.list, etc.) pass through untouched and fail normally — the core
 * tolerates those failures with local fallbacks.
 */
export function createOpenAIChatFetch(
  opts: OpenAIChatAdapterOptions,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const inner = opts.innerFetch ?? globalThis.fetch
  const chatUrl = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)

    // Intercept only the exact Messages endpoint; let everything else through.
    let pathname = ''
    try {
      pathname = new URL(url).pathname
    } catch {
      pathname = url
    }
    if (!pathname.endsWith('/v1/messages')) {
      return inner(input, init)
    }

    // Parse the Anthropic request body.
    let anthropicBody: Record<string, unknown>
    try {
      const bodyText =
        init?.body instanceof ReadableStream
          ? await new Response(init.body).text()
          : typeof init?.body === 'string'
            ? init.body
            : '{}'
      anthropicBody = JSON.parse(bodyText)
    } catch {
      anthropicBody = {}
    }

    const { openaiBody, model, stream } = translateRequestBody(anthropicBody)

    const upstream = await inner(chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(openaiBody),
      ...(init?.signal ? { signal: init.signal } : {}),
    })

    if (!upstream.ok) {
      const errorText = await upstream.text()
      const errorBody = {
        type: 'error',
        error: {
          type: 'api_error',
          message: `OpenAI chat API error (${upstream.status}): ${errorText.slice(0, 500)}`,
        },
      }
      return new Response(JSON.stringify(errorBody), {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (stream) {
      return translateChatStreamToAnthropic(upstream, model)
    }

    const data = (await upstream.json()) as OpenAIChatResponse
    return new Response(JSON.stringify(translateChatResponseToAnthropic(data, model)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
