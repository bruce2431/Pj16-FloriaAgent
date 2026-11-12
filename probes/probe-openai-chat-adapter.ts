/**
 * probe-openai-chat-adapter.ts —— openai-chat fetch 适配器契约探针（离线为主）
 *
 * 背景：Floria 请求链焊死 Anthropic Messages；Gemini 只有 OpenAI 兼容端点。
 * 新增 per-provider `protocol` 声明 + services/api/openai-chat-fetch-adapter.ts
 * （Anthropic Messages ⇄ OpenAI Chat Completions）。本探针用假 innerFetch 喂
 * 构造好的 OpenAI 响应，断言适配器吐出的 Anthropic SSE 序列/字段与核心三处
 * 解析器（claude.ts / messages.ts / compact.ts）要求一致。
 *
 * 离线（默认）：只测翻译，不触网。
 * 联网（可选）：设 GEMINI_API_KEY 环境变量，追加一次真端点往返。
 */
import { createOpenAIChatFetch } from '../src/services/api/openai-chat-fetch-adapter.js'

let pass = 0
let fail = 0
function ok(cond: boolean, msg: string) {
  if (cond) {
    pass++
  } else {
    fail++
    console.error(`  ✗ ${msg}`)
  }
}

// ── 假 OpenAI 上游 ────────────────────────────────────────────────────
// 记录收到的请求，按 stream 决定回 SSE 还是 JSON。

interface Captured {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}
let captured: Captured | null = null

function makeInner(streamChunks: Record<string, unknown>[] | null, jsonBody: unknown) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const headers: Record<string, string> = {}
    const h = new Headers(init?.headers)
    h.forEach((v, k) => (headers[k.toLowerCase()] = v))
    captured = {
      url,
      headers,
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
    }
    if (streamChunks) {
      const text = streamChunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
      return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    return new Response(JSON.stringify(jsonBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof globalThis.fetch
}

function parseSSE(text: string): Array<{ event: string; data: any }> {
  const out: Array<{ event: string; data: any }> = []
  for (const frame of text.split('\n\n')) {
    const lines = frame.split('\n')
    let event = ''
    let data = ''
    for (const l of lines) {
      if (l.startsWith('event:')) event = l.slice(6).trim()
      else if (l.startsWith('data:')) data += l.slice(5).trim()
    }
    if (event && data) out.push({ event, data: JSON.parse(data) })
  }
  return out
}

async function run() {
  // ── Test A: 流式（文本 + tool_call）────────────────────────────────
  console.log('Test A: streaming text + tool_call')
  const streamChunks = [
    { choices: [{ delta: { role: 'assistant', content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file' } }],
          },
        },
      ],
    },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '_path":"a"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } },
  ]
  const fetchA = createOpenAIChatFetch({
    baseUrl: 'https://example.test/v1beta/openai/',
    apiKey: 'KEY',
    innerFetch: makeInner(streamChunks, null),
  })
  const respA = await fetchA('https://example.test/v1beta/openai/v1/messages', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gemini-3.8-flash',
      max_tokens: 100,
      stream: true,
      system: [{ type: 'text', text: 'be terse', cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Read', input: { file_path: 'a' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] },
      ],
      tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }],
      tool_choice: { type: 'auto' },
      thinking: { type: 'enabled', budget_tokens: 1000 },
    }),
  })

  // 上游请求翻译
  ok(captured?.url === 'https://example.test/v1beta/openai/chat/completions', `upstream url = ${captured?.url}`)
  const ub = captured!.body as any
  ok(ub.model === 'gemini-3.8-flash', 'model passthrough')
  ok(ub.stream === true, 'stream true')
  ok(ub.max_tokens === 100, 'max_tokens mapped')
  ok(ub.temperature === undefined, 'temperature absent when not sent')
  ok(ub.messages[0].role === 'system' && ub.messages[0].content === 'be terse', 'system -> system message')
  ok(ub.tools?.[0]?.function?.name === 'Read', 'tool translated to functions')
  ok(ub.tool_choice === 'auto', 'tool_choice auto')
  ok(ub.thinking === undefined, 'thinking dropped')
  // History written without a captured thought_signature cannot be replayed to
  // Gemini 3+ at all (any unsigned functionCall part 400s). The call is dropped
  // and its output kept as plain text — never as `[tool call …]` syntax, which
  // the model imitates as prose instead of making a real call.
  ok(!ub.messages.some((m: any) => m.role === 'tool'), 'unsigned history: no role:tool replay')
  ok(!ub.messages.some((m: any) => m.tool_calls), 'unsigned history: no functionCall parts')
  ok(!JSON.stringify(ub.messages).includes('[tool call'), 'unsigned history: no fake tool-call prose')
  ok(!JSON.stringify(ub.messages).includes('[tool result'), 'unsigned history: no fake tool-result prose')
  ok(
    ub.messages.some((m: any) => m.role === 'user' && m.content === 'ok'),
    'unsigned history: tool output kept as plain user text',
  )
  ok(captured!.headers['authorization'] === 'Bearer KEY', 'bearer auth set')
  ok(captured!.headers['anthropic-version'] === undefined, 'anthropic-version stripped')

  // 响应 SSE 序列
  const events = parseSSE(await respA.text())
  const types = events.map(e => e.event)
  ok(events[0].event === 'message_start', 'first event message_start')
  ok(events[0].data.message.role === 'assistant' && events[0].data.message.model === 'gemini-3.8-flash', 'message_start fields')
  const textStart = events.find(e => e.event === 'content_block_start' && e.data.content_block.type === 'text')
  ok(!!textStart && textStart.data.index === 0, 'text block start index 0')
  const textDelta = events.filter(e => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta')
  ok(textDelta.map(d => d.data.delta.text).join('') === 'Hello', 'text deltas reassemble to Hello')
  const toolStart = events.find(e => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use')
  ok(!!toolStart && toolStart.data.content_block.id === 'call_1' && toolStart.data.content_block.name === 'Read', 'tool_use block start')
  const jsonDeltas = events.filter(e => e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta')
  ok(jsonDeltas.map(d => d.data.delta.partial_json).join('') === '{"file_path":"a"}', 'input_json_delta reassembles')
  ok(types.filter(t => t === 'content_block_stop').length === 2, 'two content_block_stop')
  const md = events.find(e => e.event === 'message_delta')
  ok(!!md && md.data.delta.stop_reason === 'tool_use', 'message_delta stop_reason tool_use')
  ok(md!.data.usage.input_tokens === 12 && md!.data.usage.output_tokens === 7, 'usage mapped')
  ok(types[types.length - 1] === 'message_stop', 'last event message_stop')

  // index 单调：所有 content_block_start 的 index 唯一递增
  const starts = events.filter(e => e.event === 'content_block_start').map(e => e.data.index)
  ok(starts.length === 2 && starts[0] === 0 && starts[1] === 1, `block indices monotonic [${starts}]`)

  // ── Test A2: thought_signature 随 tool_use id 持久 / 回填 ──────────
  // Gemini 3+ 要求每个 functionCall 回传签名；核心只持久化 {id,name,input}，
  // 适配器把签名 base64url 编码进 id，回放时解出原 id + 签名。
  console.log('Test A2: thought_signature carried in the tool_use id')
  const sigChunks = [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_sig',
                type: 'function',
                function: { name: 'Read', arguments: '{}' },
                extra_content: { google: { thought_signature: 'SIG123' } },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]
  const fetchSig = createOpenAIChatFetch({
    baseUrl: 'https://example.test/v1beta/openai',
    apiKey: 'KEY',
    innerFetch: makeInner(sigChunks, null),
  })
  const respSig = await fetchSig('https://example.test/v1beta/openai/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'gemini-3.8-flash', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'go' }] }),
  })
  const sigEvents = parseSSE(await respSig.text())
  const sigStart = sigEvents.find(e => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use')
  const signedId: string = sigStart?.data.content_block.id ?? ''
  const [baseFromId, payloadB64] = signedId.split('__fs')
  ok(baseFromId === 'call_sig', `stream: provider id preserved in carrier (${baseFromId})`)
  ok(
    JSON.parse(Buffer.from(payloadB64 ?? '', 'base64url').toString('utf8'))?.google?.thought_signature ===
      'SIG123',
    'stream: signature encoded in tool_use id',
  )

  const fetchReplay = createOpenAIChatFetch({
    baseUrl: 'https://example.test/v1beta/openai',
    apiKey: 'KEY',
    innerFetch: makeInner(null, { choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }),
  })
  await fetchReplay('https://example.test/v1beta/openai/v1/messages', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gemini-3.8-flash',
      max_tokens: 50,
      messages: [
        { role: 'user', content: 'go' },
        // 核心持久化形状：只有 id/name/input，没有 extra_content（签名在 id 里）
        { role: 'assistant', content: [{ type: 'tool_use', id: signedId, name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: signedId, content: 'ok' }] },
      ],
    }),
  })
  const replayBody = captured!.body as any
  ok(
    replayBody.messages.find((m: any) => m.role === 'assistant')?.tool_calls?.[0]?.extra_content?.google
      ?.thought_signature === 'SIG123',
    'replay: signature decoded from the id',
  )
  ok(
    replayBody.messages.find((m: any) => m.role === 'assistant')?.tool_calls?.[0]?.id === 'call_sig',
    'replay: upstream sees the provider id, not the carrier',
  )
  ok(
    replayBody.messages.some((m: any) => m.role === 'tool' && m.tool_call_id === 'call_sig'),
    'replay: signed tool_result stays role:tool',
  )

  // ── Test B: 非流式 ────────────────────────────────────────────────
  console.log('Test B: non-streaming')
  const fetchB = createOpenAIChatFetch({
    baseUrl: 'https://example.test/v1beta/openai',
    apiKey: 'KEY',
    innerFetch: makeInner(null, {
      id: 'chatcmpl_1',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'done',
            tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    }),
  })
  const respB = await fetchB('https://example.test/v1beta/openai/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'gemini-3.8-flash', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const jb = await respB.json()
  ok(jb.type === 'message' && jb.role === 'assistant', 'non-stream: anthropic message shape')
  ok(jb.content[0].type === 'text' && jb.content[0].text === 'done', 'non-stream: text block')
  ok(jb.content[1].type === 'tool_use' && jb.content[1].name === 'Bash' && jb.content[1].input.cmd === 'ls', 'non-stream: tool_use parsed')
  ok(jb.stop_reason === 'tool_use', 'non-stream: stop_reason')
  ok(jb.usage.input_tokens === 3 && jb.usage.output_tokens === 4, 'non-stream: usage')

  // ── Test C: 透传非 messages URL ───────────────────────────────────
  console.log('Test C: passthrough')
  let passedThrough = ''
  const fetchC = createOpenAIChatFetch({
    baseUrl: 'https://example.test/openai',
    apiKey: 'KEY',
    innerFetch: (async (input: RequestInfo | URL) => {
      passedThrough = input instanceof Request ? input.url : String(input)
      return new Response('{}', { status: 200 })
    }) as typeof globalThis.fetch,
  })
  await fetchC('https://example.test/openai/v1/messages/count_tokens', { method: 'POST', body: '{}' })
  ok(passedThrough.endsWith('/count_tokens'), 'count_tokens passes through untreated')

  // ── Test F: 上游静默 EOF（无 finish_reason / 无 [DONE]）必须报错 ──
  // 伪造成 end_turn 会让核心以为回合正常结束，不再重试/回退（Gemini 大
  // tool call 生成期静默、被链路上限掐断时的实际形态）。
  console.log('Test F: premature EOF surfaces as a stream error')
  const fetchF = createOpenAIChatFetch({
    baseUrl: 'https://example.test/v1beta/openai',
    apiKey: 'KEY',
    innerFetch: (async () =>
      new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )) as typeof globalThis.fetch,
  })
  const respF = await fetchF('https://example.test/v1beta/openai/v1/messages', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gemini-4-carbon',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  let fErrored = false
  try {
    await respF.text()
  } catch {
    fErrored = true
  }
  ok(fErrored, 'premature EOF: body rejects instead of ending as end_turn')

  // ── Test G: 传输中途抛错必须报错 ─────────────────────────────────
  console.log('Test G: mid-stream transport error surfaces')
  const fetchG = createOpenAIChatFetch({
    baseUrl: 'https://example.test/v1beta/openai',
    apiKey: 'KEY',
    innerFetch: (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
              ),
            )
            c.error(new Error('socket connection was closed unexpectedly'))
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )) as typeof globalThis.fetch,
  })
  const respG = await fetchG('https://example.test/v1beta/openai/v1/messages', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gemini-4-carbon',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  let gErrored = false
  try {
    await respG.text()
  } catch {
    gErrored = true
  }
  ok(gErrored, 'mid-stream error: body rejects')

  if (process.argv.includes('--live')) await live()

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

async function live() {
  console.log('\nTest D (--live): real Gemini OpenAI-compat round-trip')
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { getClaudeConfigHomeDir } = await import('../src/utils/envUtils.js')
  const creds = JSON.parse(readFileSync(join(getClaudeConfigHomeDir(), 'credentials.json'), 'utf-8'))
  const g = creds.providers?.gemini
  if (!g) {
    console.error('  ✗ no gemini provider in credentials.json')
    fail++
    return
  }
  const f = createOpenAIChatFetch({ baseUrl: g.baseUrl, apiKey: g.keys[g.activeKeyIndex ?? 0].value })
  const resp = await f(`${g.baseUrl}/v1/messages`, {
    method: 'POST',
    body: JSON.stringify({
      model: g.activeModel,
      max_tokens: 256,
      stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    }),
  })
  console.log(`  HTTP ${resp.status}`)
  const events = parseSSE(await resp.text())
  const text = events
    .filter(e => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta')
    .map(e => e.data.delta.text)
    .join('')
  const md = events.find(e => e.event === 'message_delta')
  console.log(`  text=${JSON.stringify(text)}`)
  console.log(`  stop_reason=${md?.data?.delta?.stop_reason} usage=${JSON.stringify(md?.data?.usage)}`)
  ok(events[0]?.event === 'message_start', 'live: message_start first')
  ok(text.trim().length > 0, 'live: non-empty text')
  ok(events[events.length - 1]?.event === 'message_stop', 'live: message_stop last')

  // Test E: 真 Anthropic SDK 走适配器（SDK 解析我们合成的 SSE）——主链路端到端证明
  console.log('\nTest E (--live): real Anthropic SDK through the adapter')
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey: 'placeholder', baseURL: g.baseUrl, fetch: f })
  const stream = await client.messages.create({
    model: g.activeModel,
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    stream: true,
  })
  let sdkText = ''
  let stopReason: string | null = null
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') sdkText += ev.delta.text
    if (ev.type === 'message_delta') stopReason = ev.delta.stop_reason
  }
  console.log(`  sdk text=${JSON.stringify(sdkText)} stop_reason=${stopReason}`)
  ok(sdkText.includes('PONG'), 'live SDK: text assembled by SDK')
  ok(stopReason === 'end_turn', `live SDK: stop_reason end_turn (got ${stopReason})`)
}

run().catch(e => {
  console.error(e)
  process.exit(1)
})
