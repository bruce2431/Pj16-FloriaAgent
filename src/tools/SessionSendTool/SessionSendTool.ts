/**
 * SessionSend —— 会话间协作的发送口（2026-09-15；2026-09-18 撤授权门）。
 *
 * 三段式：
 *   ① 寻址判定（checkPermissions 与 call 都要做，见下）——to（**只认 sid**）→ 目标
 *      （sessionAddressing.ts 纯函数）。2026-11-23：标题寻址移除，发现入口唯一归 SessionSearch；
 *      跨项目目标由用户 `[@会话:标题|sid]` 令牌或 new_session 回执给 sid。
 *      **2026-09-18 用户定案撤除「暴露即授权」门**：
 *      原授权集合由上下文扫描派生，压缩会卷走令牌、恢复只能靠用户手工重新 @（实测卡线），
 *      机制性摩擦 > 收益——现可发目录内任何会话，回环风险由「非必要不通信」软约束兜底
 *      （失控再补硬护栏）。仍拒绝：未找到 / 指向自己 / 空——那是寻址失败，非授权失败。
 *   ② 解析在本进程做（复用网关既有 GET /gateway/sessions），网关只收已解析的 sid 做路由
 *      ——网关不引入第二份会话标题索引。
 *   ③ 投递：gatewayClient.sendSessionMessage → 网关按 sid 三形态路由（在线直投/暂存补投/冷启拉起）。
 *   ④ 2026-09-20 新增「拉起新会话」形态（new_session + project，project 必填）：判定与 to 路径同源
 *      （sessionAddressing.resolveSendMode 是 existing/new/invalid 的单一出口），投递走
 *      gatewayClient.createSessionAndSend —— 网关先 spawn 一个全新会话、**等 /clients 注册完成**
 *      再投递首条消息，回执携带新 sid（后续可按 sid 寻址）。project label 由本侧查目录前置校验
 *      （网关对未知 label 会回退全局根，那是 web 建会话链的语义，工具不借那条路猜项目）。
 *
 * **为什么 checkPermissions 与 call 各解析一次**：checkPermissions 是权限门（可能被
 * bypassPermissions 等路径跳过），call 是执行点——跨会话写入是不可撤回的对外动作，
 * 执行前必须按当下的目录重算寻址（目录在两次之间也可能变化）。
 * 与 SendMessageTool 在 call 里复查 bridge 句柄同一理由（那句注释：checkPermissions 的检查在
 * 用户等待后可能已过期）。两次都是本地 HTTP + 内存比对，代价可忽略。
 */

import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { errorMessage } from '../../utils/errors.js'
import {
  createSessionAndSend,
  fetchDirectorySnapshot,
  fetchSessionDirectory,
  sendSessionMessage,
} from '../../utils/gatewayClient.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { findModelProvider } from '../../utils/credentials/pool.js'
import {
  resolveSendMode,
  resolveSessionTargetBySid,
  type ResolvedSessionTarget,
} from '../../utils/sessionAddressing.js'
import { SESSION_SEND_TOOL_NAME } from './constants.js'
import { getSessionSendPrompt, SESSION_SEND_DESCRIPTION } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

/** 正文上限：跨会话消息会变成对方的 user 消息（进上下文），超长无边界载荷对两端都是浪费 */
const MAX_TEXT_CHARS = 100_000

/** 寻址现场（目录查询 + 目标/自身解析的唯一入口，checkPermissions 与 call 各调一次，见文件头注）。
 *  self 来自同一份目录快照：来源标注用本会话自己的 sid/标题，接收端据此包 `<session-message from="会话：X" sid="…">`。 */
async function resolveAddressing(
  to: string,
): Promise<{ target: ResolvedSessionTarget; self: ResolvedSessionTarget }> {
  const dir = await fetchSessionDirectory()
  const selfSid = getSessionId()
  const r = resolveSessionTargetBySid(dir, to, selfSid)
  if (!r.target) throw new Error(r.error ?? '目标无法确定')
  return {
    target: r.target,
    self: { sid: selfSid, title: dir.find(s => s.sid === selfSid)?.title ?? '未命名会话' },
  }
}

/**
 * 新建会话寻址现场（2026-09-20）：project 必须在目录里真实存在且 scope==='project'——
 * 网关对未知 label 的既有语义是回退全局根（web 建会话链的行为），工具不能借那条路「猜」出
 * 一个项目；找不到就带可选列表拒绝（不猜不兜底）。self 与 project 取自**同一份目录快照**，
 * 两次请求会拿到两份可能漂移的状态。新会话标题由网关侧统一派生（见 localGateway session-create）。
 */
async function resolveNewSession(
  project: string,
): Promise<{ project: string; self: ResolvedSessionTarget }> {
  const snap = await fetchDirectorySnapshot()
  if (!snap.projects.includes(project)) {
    const shown = snap.projects.slice(0, 12).join('、')
    const more = snap.projects.length > 12 ? ` 等 ${snap.projects.length} 个` : ''
    throw new Error(`项目「${project}」不能作为新会话落点（可选：${shown || '目录里没有项目'}${more}）`)
  }
  const selfSid = getSessionId()
  return {
    project,
    self: { sid: selfSid, title: snap.sessions.find(s => s.sid === selfSid)?.title ?? '未命名会话' },
  }
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    to: z
      .string()
      .optional()
      .describe(
        'Target session sid (from SessionSearch, a user @-mention token, or a new_session receipt). Titles are not accepted. Mutually exclusive with new_session.',
      ),
    new_session: z
      .boolean()
      .optional()
      .describe('true = start a new session with `text` as its first message. Requires project; do not pass to.'),
    project: z
      .string()
      .optional()
      .describe(
        'Project label where the new session lands (one of the session directory groups with scope=project). Required and only valid when new_session: true.',
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Full model name from the credential pool, applied as --model when spawning. Omitted = global default. Only valid when new_session: true.',
      ),
    text: z
      .string()
      .describe('Message body. Self-contained — the receiving session cannot see your context.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    delivered: z.boolean(),
    to: z.string(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type SessionSendOutput = z.infer<OutputSchema>

export type Input = z.infer<InputSchema>

/** 寻址失败的统一拒绝（不弹审批也不静默放行） */
function deny(reason: string) {
  return {
    behavior: 'deny' as const,
    message: reason,
    decisionReason: {
      type: 'safetyCheck' as const,
      reason: '发送目标无法在会话目录中唯一定位',
      classifierApprovable: false,
    },
  }
}

export const SessionSendTool = buildTool({
  name: SESSION_SEND_TOOL_NAME,
  searchHint: 'send a message to another Claude session (cross-session collaboration)',
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
    return false
  },
  userFacingName() {
    return SESSION_SEND_TOOL_NAME
  },
  async description() {
    return SESSION_SEND_DESCRIPTION
  },
  async prompt() {
    return getSessionSendPrompt()
  },
  async validateInput(input) {
    // 形状判定单一出口（resolveSendMode）：existing / new / invalid
    const mode = resolveSendMode(input)
    if (mode.kind === 'invalid') {
      return { result: false, message: mode.error, errorCode: 9 }
    }
    // 新会话模型（2026-10-13 待办 14）：必须 ∈ 凭据池供应商模型清单（findModelProvider 与
    // 网关 /gateway/model 同源）——早失败在调用侧，网关 spawn 前还有同款校验兜形。
    if (mode.kind === 'new' && mode.model && !findModelProvider(mode.model)) {
      return {
        result: false,
        message: `model "${mode.model}" 不在凭据池任何供应商模型清单中（可先 GET /gateway/models 查可用清单）`,
        errorCode: 9,
      }
    }
    if (input.text.trim().length === 0) {
      return { result: false, message: 'text must not be empty', errorCode: 9 }
    }
    if (input.text.length > MAX_TEXT_CHARS) {
      return {
        result: false,
        message: `text is too long (${input.text.length} > ${MAX_TEXT_CHARS} chars)`,
        errorCode: 9,
      }
    }
    return { result: true }
  },
  async checkPermissions(input) {
    const mode = resolveSendMode(input)
    if (mode.kind === 'invalid') return deny(mode.error)
    try {
      if (mode.kind === 'existing') await resolveAddressing(mode.to)
      else await resolveNewSession(mode.project)
    } catch (e) {
      return deny(errorMessage(e))
    }
    return { behavior: 'allow', updatedInput: input }
  },
  async call(input) {
    const mode = resolveSendMode(input)
    if (mode.kind === 'invalid') {
      return { data: { delivered: false, to: '', message: `投递失败：${mode.error}` } }
    }
    try {
      if (mode.kind === 'existing') {
        const { target, self } = await resolveAddressing(mode.to)
        const r = await sendSessionMessage(target.sid, input.text, self)
        return {
          data: {
            delivered: r.ok,
            to: target.title,
            message: r.ok ? `已投递给会话「${target.title}」` : `投递失败：${r.error}`,
          },
        }
      }
      const { project, self } = await resolveNewSession(mode.project)
      // model（2026-10-13 待办 14）：随 session-create 帧透传，网关 spawn --model 落地
      const r = await createSessionAndSend(project, input.text, self, mode.model)
      return {
        data: {
          // to 对新会话形态 = 新会话 sid（后续寻址凭据）；失败时回落项目 label 便于定位
          delivered: r.ok,
          to: r.ok && r.sid ? r.sid : project,
          message: r.ok
            ? `已创建会话（项目：${project}${mode.model ? `，模型：${mode.model}` : ''}）sid=${r.sid} 并投递首条消息`
            : `投递失败：${r.error}`,
        },
      }
    } catch (e) {
      return {
        data: {
          delivered: false,
          to: input.to ?? input.project ?? '',
          message: `投递失败：${errorMessage(e)}`,
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
} satisfies ToolDef<InputSchema, SessionSendOutput>)
