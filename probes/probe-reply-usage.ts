// 只读探针（2026-11-19，回合收口版）：验证 filterConversationForDisplay 的 turnUsage 输出——
// 统计单元 = 回合（真实用户消息之间），每次 API 响应的 usage 按 message.id 去重求和，只挂在
// 回合最后一条 assistant 投影上（web 回复操作条「用量 X tok」按钮 + 弹出面板数据源）。
// 读项目根真实转录跑投影，校验「每回合恰有末条 assistant 带 turnUsage」并抽样。不写盘、不建会话。
// 运行：bun probes/probe-reply-usage.ts
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { filterConversationForDisplay } from '../src/utils/conversationDisplay.js'

// probes/ → Floria/ → Pj16 项目根
const root = join(import.meta.dir, '..', '..', '.claude', 'projects')
const files = readdirSync(root)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => ({ f: join(root, f), m: statSync(join(root, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)
  .slice(0, 6)

type UsageD = { input: number; cacheRead: number; cacheWrite: number; output: number }
type Msg = {
  role: string
  turnUsage?: UsageD
  model?: string
  timestamp?: number
  stopReason?: string
  injected?: boolean
  blocks: Array<{ kind: string; text?: string }>
}
const totalOf = (d: UsageD | undefined): number =>
  d ? d.input + d.cacheRead + d.cacheWrite + d.output : 0

let turns = 0
let turnsWithUsage = 0
const samples: unknown[] = []
const failures: string[] = []

for (const { f } of files) {
  const raw = readFileSync(f, 'utf8')
  const records: unknown[] = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const r = JSON.parse(s) as { type?: string }
      if (r && typeof r.type === 'string' && ['user', 'assistant', 'system', 'attachment', 'progress'].includes(r.type)) records.push(r)
    } catch {}
  }
  const msgs = filterConversationForDisplay(records as never, 'prompt-tail-think') as Msg[]
  const file = f.split(/[\\/]/).pop()

  // 回合分组：真实用户消息（非注入）开新回合。首条 assistant 之前没有用户消息 = 起点不可证，
  // 该前导回合不计入分母（投影能证明的回合才要求出数）。
  let started = false
  let lastAsst = -1
  const closeTurn = (): void => {
    // 回合内没有任何可见 assistant（在飞/全被过滤）= 无法证末条，不进入分母
    if (started && lastAsst >= 0) {
      turns++
      const m = lastAsst >= 0 ? msgs[lastAsst] : undefined
      const d = m?.turnUsage
      if (d && totalOf(d) > 0) {
        turnsWithUsage++
        if (samples.length < 400) {
          samples.push({
            file,
            total: totalOf(d),
            ...d,
            model: m!.model,
            ts: m!.timestamp,
            stop: m!.stopReason,
            txt: m!.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('').slice(0, 24),
          })
        }
      } else {
        failures.push(`${file}: 回合无末条用量（lastAsst=${lastAsst}）`)
      }
    }
    started = false
    lastAsst = -1
  }

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!
    // tool_result 记录的投影同为 role:'user'，属回合内工具回填，不是真实输入
    const isToolResultRecord = m.blocks.some((b) => b.kind === 'tool_result')
    if (m.role === 'user' && !m.injected && !isToolResultRecord) {
      closeTurn()
      started = true
      continue
    }
    if (m.role !== 'assistant') continue
    // 同一回合内，上一条 assistant 不能已经带 turnUsage（只允许末条携带）
    if (lastAsst >= 0 && msgs[lastAsst]!.turnUsage) {
      failures.push(`${file}: 回合内非末条 assistant 携带 turnUsage（idx=${lastAsst}）`)
    }
    lastAsst = i
  }
  closeTurn()
}

console.log('scanned:', files.map((x) => x.f.split(/[\\/]/).pop()).join(', '))
console.log('turns:', turns, '| turns with usage:', turnsWithUsage)
console.log('samples:', JSON.stringify(samples.slice(-4), null, 1))
if (failures.length) {
  console.error(`FAIL: ${failures.length} 处不变量违背\n` + failures.slice(0, 10).join('\n'))
  process.exit(1)
}
if (turns === 0 || turnsWithUsage !== turns) {
  console.error(`FAIL: 回合用量未覆盖全部可证回合（turns=${turns} withUsage=${turnsWithUsage}）`)
  process.exit(1)
}
console.log('PASS: 全部可证回合的末条 assistant 带回合用量，且仅末条携带')
