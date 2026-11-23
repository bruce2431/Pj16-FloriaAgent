/**
 * 2026-09-15 会话间协作 · 文本包装 + 会话寻址 探针（跑真实源码，非复刻）
 *
 * 两根不变量：
 *   ① **包装是唯一真相源**（utils/sessionMessage.ts）——来源内嵌文本，落盘/回放/压缩后天然携带；
 *      正文含同名字符串不得被误切（整条消息恒为单层包装）。
 *   ② **寻址即门**（utils/sessionAddressing.ts，2026-09-18 撤授权门；2026-11-23 收窄 sid-only）——
 *      可发会话目录内任何会话，但 to 只认 sid 整串精确命中；标题/未找到/自环/空一律拒绝
 *      （发现归 SessionSearch，跨项目 sid 由用户 @ 令牌暴露，不猜不兜底）。
 *      旧「暴露即授权」已整体移除（授权集合由上下文派生，压缩卷走令牌后只能人工重 @，
 *      2026-09-18 实测卡线后定案撤销）；唯一刹车 = 「非必要不通信」软约束，失控再补硬护栏。
 *
 * 断言：
 *   A 包装往返 —— 正文/标题含引号尖括号/含标签串/多行 均无损；非包装形态不误判
 *   D 寻址     —— 只认 sid 整串；标题/未找到/自环/空/复合令牌串 → error（不猜不兜底）
 *   F 展示层接线 —— web 投影剥包装 + 来源行；CLI 同源；排队区拆包点
 *   G CLI 接线 + 工具说明 —— 含「撤授权门」源码级钉（防回归）
 *   H 来源行对齐 —— 右对齐（2026-09-15 用户实测定案）
 *   I 拉起新会话 —— resolveSendMode 真值测（不猜不兜底）+ 工具/网关/说明接线钉（2026-09-20）
 *
 * 用法：bun probe-session-link.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  parseSessionMessage,
  SESSION_MESSAGE_TAG,
  wrapSessionMessage,
} from '../src/utils/sessionMessage.ts'
import {
  resolveSendMode,
  resolveSessionTargetBySid,
  type KnownSession,
} from '../src/utils/sessionAddressing.ts'

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass += 1
    return
  }
  fail += 1
  failures.push(`${name}${detail ? ` —— ${detail}` : ''}`)
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实得 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`)
}

// ── A 包装往返 ────────────────────────────────────────────────────────────────
const A_SRC = { sid: 'sid-a', title: '甲' }
{
  const w = wrapSessionMessage(A_SRC, '你好')
  check('A1 包装含来源与 sid', w.startsWith(`<${SESSION_MESSAGE_TAG} from="会话：甲" sid="sid-a">`), w)
  eq('A1 往返一致', parseSessionMessage(w), { source: A_SRC, body: '你好' })
}
{
  const nasty = { sid: 's"<>&', title: '乙"<>&' }
  const w = wrapSessionMessage(nasty, '正文')
  const openTag = w.slice(0, w.indexOf('>') + 1)
  // 开标签里引号只能作属性定界符用：from + sid 各一对 = 4 个，多一个就说明属性被裸引号劈开
  check('A2 属性全转义（开标签恰 4 个引号）', (openTag.match(/"/g) ?? []).length === 4, openTag)
  // 首字符是标签名的 '<'，其后不得再出现 '<'（出现即属性值里的裸尖括号破坏标签结构）
  check('A2 标题裸尖括号不入标签', openTag.indexOf('<', 1) === -1, openTag)
  eq('A2 转义往返一致', parseSessionMessage(w), { source: nasty, body: '正文' })
}
{
  const w = wrapSessionMessage({ title: '丙' }, 'x')
  check('A3 无 sid 则不写 sid 属性', !w.includes('sid="'), w)
  eq('A3 无 sid 往返', parseSessionMessage(w), { source: { sid: undefined, title: '丙' }, body: 'x' })
}
{
  const body = `多行\n第二行 <${SESSION_MESSAGE_TAG} from="会话：假">假</${SESSION_MESSAGE_TAG}> 尾巴\n`
  eq('A4 正文含同名标签不被误切', parseSessionMessage(wrapSessionMessage(A_SRC, body))!.body, body)
}
eq('A5 非包装形态返回 null', parseSessionMessage('普通用户消息'), null)
eq('A5 半包装（缺闭标签）返回 null', parseSessionMessage(`<${SESSION_MESSAGE_TAG} from="会话：甲">x`), null)
eq('A5 开标签不在开头仍可解析（parse 不限锚，展示用）', parseSessionMessage(wrapSessionMessage(A_SRC, 'x'))!.source, A_SRC)

// ── D 寻址（2026-09-18 撤授权门：寻址是唯一硬门）──────────────────────────────
const DIR: KnownSession[] = [
  { sid: 's1', title: '甲' },
  { sid: 's2', title: '乙' },
  { sid: 's3', title: '乙' },
  { sid: 'self', title: '我' },
]
const SELF = 'self'
const resolve = (to: string) => resolveSessionTargetBySid(DIR, to, SELF)
const errOf = (to: string) => resolveSessionTargetBySid(DIR, to, SELF).error ?? '(no error)'

eq('D1 sid 精确命中', resolve('s1'), { target: { sid: 's1', title: '甲' }, error: null })
check(
  'D2 标题不再可寻址（标题串按 sid 未找到）',
  !resolve('甲').target && errOf('甲').includes('未找到'),
  errOf('甲'),
)
check(
  'D3 同名标题不产生重名分支（按 sid 未找到）',
  !resolve('乙').target && errOf('乙').includes('未找到') && !errOf('乙').includes('重名'),
  errOf('乙'),
)
check('D4 未找到拒绝', !resolve('不存在').target && errOf('不存在').includes('未找到'), errOf('不存在'))
check('D5 自环拒绝（sid 命中自己）', !resolve('self').target && errOf('self').includes('本会话自己'), errOf('self'))
check('D5 标题指向自己也不放行（标题已非寻址键）', !resolve('我').target, errOf('我'))
check('D6 空串拒绝', resolve('').target === null && errOf('') === '目标 sid 为空', errOf(''))
check('D6 纯空白拒绝（trim）', resolve('   ').target === null && errOf('   ') === '目标 sid 为空', errOf('   '))
{
  // sid 键优先：to 恰好既是某会话的 sid、又是另一会话的标题时，按 sid 命中（精确键优先于标题键）
  const DIR2: KnownSession[] = [
    { sid: 'X', title: 'Y' },
    { sid: 'Z', title: 'X' },
  ]
  eq('D7 sid 键优先于同名标题', resolveSessionTargetBySid(DIR2, 'X', 'other'), {
    target: { sid: 'X', title: 'Y' },
    error: null,
  })
}
check('D8 sid 前缀不命中（不猜）', !resolve('s').target && errOf('s').includes('未找到'), errOf('s'))
eq('D9 trim 容错', resolve(' s1 '), { target: { sid: 's1', title: '甲' }, error: null })
check(
  'D10 复合令牌串「标题|sid」不拆解 → 未找到（调用方须自行拆分后传入）',
  !resolve('甲|s1').target && errOf('甲|s1').includes('未找到'),
  errOf('甲|s1'),
)

// ── F 展示层接线（源码级防回归）────────────────────────────────────────────────
// web：projection 剥离包装 + 置 fromSession + 两条气泡模板插来源行 + 排队区来源行
const proj = readFileSync(fileURLToPath(new URL('../src/utils/conversationDisplay.ts', import.meta.url)), 'utf8')
check('F1 投影 import 包装解析', proj.includes("from './sessionMessage.js'") && proj.includes('parseSessionMessage'))
check('F2 DisplayMessage 带 fromSession', /fromSession\?: SessionSource/.test(proj))
check('F3 attachment 分支剥离包装', proj.includes('stripSessionPrompt'))
check('F4 用户块分支剥离包装', /db\.text = px\.body/.test(proj))

const gw = fileURLToPath(new URL('../src/gateway/', import.meta.url))
const rawMessages = readFileSync(gw + 'web-src/chat/messages.js', 'utf8')
const styles = readFileSync(gw + 'web/styles.css', 'utf8')
check(
  'F5 web 来源行只读投影字段（前端不解析包装）',
  rawMessages.includes('m.fromSession') && !rawMessages.includes('parseSessionMessage'),
)
check(
  'F6 来源行插在 .body 之前（气泡上方，文档流占位）',
  (rawMessages.match(/\$\{whoHtml\((?:m|g\.m)\)\}(?=\$\{(?:ubody|gbody) \?)/g) ?? []).length === 2,
)
check('F7 web 复用既有 .msg .who 样式（零新增选择器）', /\.msg \.who \{/.test(styles))
const approval = readFileSync(gw + 'web-src/inputbar/approval.js', 'utf8')
check('F8 排队区来源行（跨会话队列项不再出原始 XML）', approval.includes('q-who') && approval.includes('q.from'))
check('F9 排队区来源进重建签名（换来源必重建）', /dockItems\.map\(\(q\) => \[\(q\.from/.test(approval))

// CLI：包装剥离 + 来源行 + 提及令牌只显示标题（sid 不进终端）
const cli = readFileSync(fileURLToPath(new URL('../src/components/messages/UserPromptMessage.tsx', import.meta.url)), 'utf8')
check('G1 CLI 剥离包装取来源', cli.includes('parseSessionMessage(text)') && cli.includes('parsed.body'))
check('G2 CLI 来源行在气泡外（外层无底色，底色整体在内层）', /<Box flexDirection="column" marginTop=\{[^}]*\}>\s*\{fromSession \?/.test(cli))
check(
  'G3 CLI 提及令牌带 sid 时只显示标题',
  cli.includes('([^\\]|]+)') && cli.includes('(?:\\|[^\\]]*)?'),
)
check('G4 CLI 包装不进模板（不改发往 LLM 的原文）', !/text\.replace\(/.test(cli))

// CLI 队列上报：同一拆分点（否则排队区显示原始 XML）
const gwc = readFileSync(fileURLToPath(new URL('../src/utils/gatewayClient.ts', import.meta.url)), 'utf8')
check('G5 queue-state 上报剥包装并带来源', /const parsed = parseSessionMessage\(content\)/.test(gwc) && gwc.includes('from: parsed.source'))

// 工具说明：来源由接收侧渲染，发送方不得自加前缀（2026-09-15 真运行实测发现旧措辞被读成
// 「要我加前缀」→ 发送方正文里自写来源、与对侧自动渲染行重复；措辞改显式禁止，此处钉住）
const sendPrompt = readFileSync(fileURLToPath(new URL('../src/tools/SessionSendTool/prompt.ts', import.meta.url)), 'utf8')
check(
  'G6 工具说明显式禁止发送方自加来源前缀',
  sendPrompt.includes('不要在正文里自加任何来源前缀') && sendPrompt.includes('来源标注由对方侧自动渲染'),
)
check('G6 旧歧义措辞已移除', !sendPrompt.includes('并会看到「来自 会话：'))

// 撤授权门（2026-09-18 用户定案）——源码级钉，防止暴露机制回潮或残留引用
const sendTool = readFileSync(fileURLToPath(new URL('../src/tools/SessionSendTool/SessionSendTool.ts', import.meta.url)), 'utf8')
check('G7 工具不再引用暴露/授权机制（标识符级；头注释的撤门说明不算残留）', !sendTool.includes('sessionExposure') && !sendTool.includes('collectExposedSessions') && !sendTool.includes('resolveExposure') && !sendTool.includes('findTarget') && !sendTool.includes('describeExposure'))
check(
  'G7 寻址走 sessionAddressing（sid-only）',
  sendTool.includes('resolveSessionTargetBySid') &&
    sendTool.includes("from '../../utils/sessionAddressing.js'") &&
    !sendTool.includes('resolveSessionTarget(dir'),
)
check(
  'G7 工具说明收窄为 sid 寻址（标题不再是寻址键，保留软约束）',
  sendPrompt.includes('to 只填 sid') &&
    !sendPrompt.includes('填会话标题或 sid') &&
    sendPrompt.includes('SessionSearch') &&
    sendPrompt.includes('非必要不通信'),
)
const sessionMessageSrc = readFileSync(fileURLToPath(new URL('../src/utils/sessionMessage.ts', import.meta.url)), 'utf8')
check('G7 extractSessionSource 随授权门移除（死代码不残留）', !sessionMessageSrc.includes('extractSessionSource'))
check(
  'G7 sessionExposure.ts 已不存在（已改名 sessionAddressing.ts）',
  !existsSync(fileURLToPath(new URL('../src/utils/sessionExposure.ts', import.meta.url))),
)

// H 来源行对齐（2026-09-15 用户实测定案：右对齐，随其气泡一侧）——两前端等权，必须同时成立
check(
  'H1 CLI 来源行右对齐（行盒 flex-end，气泡宽度行为不受影响）',
  /<Box flexDirection="row" justifyContent="flex-end">\s*<Text dimColor>\{`来自 会话：/.test(cli),
)
check('H2 web 来源行右对齐（.msg.user .who 靠气泡右侧）', /\.msg\.user \.who \{ align-self: flex-end; \}/.test(styles))
check('H3 web 无左对齐残留', !/\.msg\.user \.who \{ align-self: flex-start; \}/.test(styles))

// ── I 拉起新会话形态（2026-09-20）──────────────────────────────────────────────
// 模式判定是纯函数（sessionAddressing.resolveSendMode）：真值测，不靠源码钉。
// 不变量 = 「不猜不兜底」——不把 to 空当新建、不把缺 project 回落全局根、不在无 new_session 时吞掉 project。
eq('I1 new_session + project → new', resolveSendMode({ new_session: true, project: 'Pj11' }), {
  kind: 'new',
  project: 'Pj11',
})
eq('I1 project 两端空白 trim', resolveSendMode({ new_session: true, project: '  Pj11  ' }), {
  kind: 'new',
  project: 'Pj11',
})
check(
  'I2 new_session 缺 project 拒绝且点明必填',
  resolveSendMode({ new_session: true }).kind === 'invalid' &&
    (resolveSendMode({ new_session: true }) as { error: string }).error.includes('必须指定 project'),
)
check(
  'I3 new_session 与 to 互斥（不静默择一）',
  resolveSendMode({ new_session: true, to: '甲', project: 'Pj11' }).kind === 'invalid',
)
check(
  'I4 无 new_session 却给 project → 拒绝（不静默忽略）',
  resolveSendMode({ to: '甲', project: 'Pj11' }).kind === 'invalid',
)
check(
  'I5 无 new_session 且 to 空 → 拒绝（不把空 to 当新建）',
  resolveSendMode({}).kind === 'invalid' && resolveSendMode({ to: '   ' }).kind === 'invalid',
)
eq('I6 既有形态不受影响', resolveSendMode({ to: '甲' }), { kind: 'existing', to: '甲' })
eq('I6 new_session:false 等同未给', resolveSendMode({ to: '甲', new_session: false }), {
  kind: 'existing',
  to: '甲',
})

// 接线钉（工具/网关文件含 bun:bundle feature 宏，bun 直跑不可 import → 同 G 组手法读源码文本）
check(
  'I7 工具 schema 三字段齐全且回执走新链路',
  sendTool.includes('new_session') &&
    sendTool.includes('project: z') &&
    sendTool.includes('createSessionAndSend') &&
    sendTool.includes('resolveSendMode'),
)
check(
  'I7 工具说明含新建小节与 sid 回执语义（失败=没发出去）',
  sendPrompt.includes('## 拉起一个新会话') &&
    sendPrompt.includes('失败就是没发出去') &&
    sendPrompt.includes('拉起的会话'),
)
const uiSrc = readFileSync(fileURLToPath(new URL('../src/tools/SessionSendTool/UI.tsx', import.meta.url)), 'utf8')
check('I8 工具行区分新建形态', uiSrc.includes('＋ 新会话'))
check(
  'I9 CLI 出口发 session-create 帧且超时 > 网关注册超时 20s',
  gwc.includes("type: 'session-create'") &&
    /SESSION_CREATE_TIMEOUT_MS = 25_000/.test(gwc) &&
    gwc.includes('sid: msg.sessionId'),
)
const gatewaySrc = readFileSync(fileURLToPath(new URL('../src/gateway/localGateway.ts', import.meta.url)), 'utf8')
check(
  'I10 网关先 spawn 再投递（复用既有 spawnWebSession，不另造 spawn 链）',
  gatewaySrc.includes("if (m.type === 'session-create')") &&
    // 2026-10-13：session-create 可选带 model → spawnWebSession 第 4 参透传（{model} 或 undefined），仍是同一条 spawn 链
    /spawnWebSession\(undefined, project, newSid(?:, modelRaw \? \{ model: modelRaw \} : undefined)?\)/.test(gatewaySrc),
)
check(
  'I10 新会话命名走 applySessionTitle（落盘+内存成对，rename handler 同一条链）',
  gatewaySrc.includes("拉起的会话") &&
    /async function applySessionTitle/.test(gatewaySrc) &&
    (gatewaySrc.match(/applySessionTitle\(/g) ?? []).length >= 2,
)
check('I10 创建失败如实回执（不乐观承诺）', gatewaySrc.includes("'创建会话失败：' + (e?.message ?? String(e))"))

// ── J 发现入口（2026-11-23 SessionSearch 与 sid-only 同批）──────────────────────
const searchTool = (() => {
  const p = new URL('../src/tools/SessionSearchTool/SessionSearchTool.ts', import.meta.url)
  return existsSync(fileURLToPath(p)) ? readFileSync(fileURLToPath(p), 'utf8') : ''
})()
check('J1 SessionSearch 工具存在且只读', searchTool.includes('isReadOnly()') && searchTool.includes('SESSION_SEARCH_TOOL_NAME'))
check('J2 候选集固定最近 10 个、只匹配标题', searchTool.includes('CANDIDATE_LIMIT = 10') && /title\.toLowerCase\(\)\.includes/.test(searchTool))
check('J3 与 SessionSend 同组 feature 开关', searchTool.includes("feature('SESSION_LINK')"))
check(
  'J4 tools.ts 注册了 SessionSearch',
  readFileSync(fileURLToPath(new URL('../src/tools.ts', import.meta.url)), 'utf8').includes('getSessionSearchTool()'),
)
check(
  'J5 目录归一已带 projectLabel（Search 圈定候选的数据基础）',
  gwc.includes('projectLabel') && gwc.includes('updatedAt'),
)

console.log(`\n${pass} 过 / ${fail} 败`)
if (failures.length) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(fail ? 1 : 0)
