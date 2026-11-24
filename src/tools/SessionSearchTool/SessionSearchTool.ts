/**
 * SessionSearch —— 会话发现口（2026-11-23，与 SessionSend 收窄为 sid-only 同批）。
 *
 * 分工：本工具只读发现（本项目最近 10 个标题 → sid），SessionSend 只按 sid 发送。
 * 范围是用户定案：不扫全目录、不扫转录正文；跨项目目标由用户 `[@会话:标题|sid]` 令牌给 sid。
 *
 * 数据源复用网关 `GET /gateway/sessions`（gatewayClient.fetchDirectorySnapshot 归一时已带
 * projectLabel/updatedAt/state）——不引入第二份目录或标题逻辑，标题回退链仍在网关侧。
 * 本会话自己的项目归属取自同一份快照；取不到即报错（不猜全局根、不回落）。
 */

import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { errorMessage } from '../../utils/errors.js'
import { fetchDirectorySnapshot } from '../../utils/gatewayClient.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { SESSION_SEARCH_TOOL_NAME } from './constants.js'
import { getSessionSearchPrompt, SESSION_SEARCH_DESCRIPTION } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

/** 候选集上限（用户定案：本会话所在项目最近 10 个会话） */
const CANDIDATE_LIMIT = 10

const sessionRowSchema = z.object({
  sid: z.string(),
  title: z.string(),
  updatedAt: z.number().nullable(),
  state: z.string().nullable(),
})
type SessionRow = z.infer<typeof sessionRowSchema>

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z.string().describe('Title keyword (case-insensitive substring). Must not be empty.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    query: z.string(),
    project: z.string(),
    searched: z.number(),
    matches: z.array(sessionRowSchema),
    candidates: z.array(sessionRowSchema),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type SessionSearchOutput = z.infer<OutputSchema>

export type Input = z.infer<InputSchema>

const STATE_LABEL: Record<string, string> = {
  busy: '运行中',
  idle: '空闲',
  waiting: '等待输入',
}

const stateLabel = (state: string | null | undefined): string =>
  state ? (STATE_LABEL[state] ?? state) : '离线'

const formatTime = (ts: number | undefined): string =>
  typeof ts === 'number' ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '未知时间'

const toRow = (s: {
  sid: string
  title: string
  updatedAt?: number
  state?: string | null
}): SessionRow => ({
  sid: s.sid,
  title: s.title,
  updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : null,
  state: typeof s.state === 'string' ? s.state : null,
})

/** 一次目录快照完成：圈定本项目最近 10 个 → 标题子串过滤 → 组装回执文本。 */
async function searchSessions(query: string): Promise<SessionSearchOutput> {
  const snap = await fetchDirectorySnapshot()
  const selfSid = getSessionId()
  const self = snap.sessions.find(s => s.sid === selfSid)
  if (!self) {
    throw new Error('本会话不在网关会话目录中（sid 无匹配），无法确定搜索范围')
  }
  if (!self.projectLabel) {
    throw new Error('本会话目录项缺少项目归属（projectLabel），无法确定搜索范围')
  }
  const candidates = snap.sessions
    .filter(s => s.projectLabel === self.projectLabel && s.sid !== selfSid)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, CANDIDATE_LIMIT)
  const q = query.trim().toLowerCase()
  const matches = candidates.filter(s => s.title.toLowerCase().includes(q))
  const matchRows = matches.map(toRow)
  const candidateRows = candidates.map(toRow)

  const lines: string[] = []
  if (matchRows.length > 0) {
    lines.push(`项目「${self.projectLabel}」最近 ${candidateRows.length} 个会话中，标题含「${query.trim()}」的 ${matchRows.length} 个：`)
    for (const r of matchRows) {
      lines.push(`- ${r.title} — sid=${r.sid}（${formatTime(r.updatedAt ?? undefined)} · ${stateLabel(r.state)}）`)
    }
    lines.push('用 SessionSend(to="<sid>") 发送。')
  } else {
    lines.push(`项目「${self.projectLabel}」最近 ${candidateRows.length} 个会话的标题均不含「${query.trim()}」。当前候选：`)
    for (const r of candidateRows) {
      lines.push(`- ${r.title} — sid=${r.sid}（${formatTime(r.updatedAt ?? undefined)} · ${stateLabel(r.state)}）`)
    }
    lines.push('换个关键词再查；跨项目目标需用户 @ 会话提供 sid。')
  }

  return {
    query,
    project: self.projectLabel,
    searched: candidateRows.length,
    matches: matchRows,
    candidates: candidateRows,
    message: lines.join('\n'),
  }
}

export const SessionSearchTool = buildTool({
  name: SESSION_SEARCH_TOOL_NAME,
  searchHint: 'search recent sessions in current project by title (find sid for SessionSend)',
  maxResultSizeChars: 10_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    // feature() 是编译期宏，只允许直接出现在 if / 三元条件位（bun:bundle 限制）
    return feature('SESSION_LINK') ? true : false
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  userFacingName() {
    return SESSION_SEARCH_TOOL_NAME
  },
  async description() {
    return SESSION_SEARCH_DESCRIPTION
  },
  async prompt() {
    return getSessionSearchPrompt()
  },
  async validateInput(input) {
    if (input.query.trim().length === 0) {
      return { result: false, message: 'query must not be empty', errorCode: 9 }
    }
    return { result: true }
  },
  async call(input) {
    try {
      return { data: await searchSessions(input.query) }
    } catch (e) {
      return {
        data: {
          query: input.query,
          project: '',
          searched: 0,
          matches: [],
          candidates: [],
          message: `会话搜索失败：${errorMessage(e)}`,
        },
      }
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: output.message,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, SessionSearchOutput>)
