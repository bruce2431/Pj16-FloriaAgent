// 会话映射 + 数据拉取（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { hideGate } from './auth.js'
import { needToken, apiUrl } from './gateway.js'
import { refreshList } from './live.js'
import { bodyEl, state, ALL, live } from './state.js'
import { toast } from '../core/util.js'
/* @module engine/sessions.js */
  // ---------- 会话映射 ----------
  const hashOf = (s) => (s.file || '').replace(/\.jsonl$/, '')
  // 2026-08-28 定案（用户）：URL 用完整会话 hash 不简写 → 精确匹配即可
  const findSession = (hash) => ALL.find((s) => hashOf(s) === hash)
  // 侧栏会话 tab 排序（2026-09-18 定案）：有状态（CLI 在线：busy/waiting/idle 状态点在场）置顶，
  // 组内按创建时间新→旧（createdAt = 网关透传的 jsonl 创建时刻）；无状态组同按创建时间。
  const sessCmp = (a, b) => {
    const pa = a.state ? 0 : 1
    const pb = b.state ? 0 : 1
    if (pa !== pb) return pa - pb
    return b.createdAt - a.createdAt
  }
  const sorted = () => [...ALL].sort(sessCmp)
  // 合成条目保全（2026-09-18 新建会话 tab 闪现→消失→再现根治）：newWebSession 本地先插的合成
  // tab 在 jsonl 落盘前，/gateway/sessions 权威列表尚不含它——权威拉取整体替换 ALL 会洗掉 tab，
  // 落盘后下次刷新再出现（三次闪变根因）。不变量：用户刚建的会话 tab 不因权威刷新窗口消失。
  // 凡权威列表写 ALL 的出口（loadSessions/refreshList）统一过此函数：synthetic 条目在权威条目
  // 出现前保留，出现后由真实条目自然取代（真实条目无 synthetic 标）；创建失败由 ws-failed 显式移除。
  function withSynthetic(fetched) {
    const known = new Set(fetched.map((s) => hashOf(s)))
    const kept = ALL.filter((s) => s.synthetic && !known.has(hashOf(s)))
    return kept.length ? fetched.concat(kept) : fetched
  }

  // ---------- 数据 ----------
  // 列表签名（2026-08-29 状态点偶发观测不到修复）：数量+最新 updatedAt+标题+各会话状态点。
  // 状态翻转不改 count/updatedAt，签名不含 state 时 refreshList 判同跳过重渲染 → 点不刷新。
  function listSigOf(sessions) {
    const top = sessions[0]
    return sessions.length + ':' + (top ? top.updatedAt : 0) + ':' + (top ? top.title : '') + ':' +
      sessions.map((s) => s.state || '').join(',')
  }
  // 2026-09-06 收口二轮：网关权威 turnEndAt（回合中止时刻）→ live.turnEndFlags 恢复。
  // 首载(loadSessions)与增量(refreshList)两处拉列表同源调用；实时 turn-state SSE 照旧增量。
  // closeSeg 凭此判定「回合已被中止」收口，打断/关闭会话后刷新不再挂「正在处理」无限计时。
  function applyTurnEndAt(sessions) {
    for (const s of sessions) if (typeof s.turnEndAt === 'number') live.turnEndFlags.set(hashOf(s), s.turnEndAt)
  }
  async function loadSessions() {
    if (needToken()) return // token 门锁定态：不发请求（hideGate 解锁后刷新）
    try {
      const res = await fetch(apiUrl('/gateway/sessions'))
      const data = await res.json()
      if (!Array.isArray(data.sessions)) throw new Error(data.error || 'bad response')
      setAll(withSynthetic(data.sessions))
      // work 模式项目列表（2026-09-25）：/gateway/sessions 随 sessions 一并返回 groups（含「无会话的
      // 项目」），此前被丢弃。work 侧栏的项目切换必须用它——按 sessions 自行分组的做法只覆盖有会话者。
      state.projects = Array.isArray(data.groups) ? data.groups : []
      state.workspace = typeof data.workspace === 'string' ? data.workspace : ''
      applyTurnEndAt(ALL)
      live.listSig = listSigOf(data.sessions)
    } catch (e) {
      toast('加载失败: ' + (e.message || e))
      bodyEl.innerHTML = '<div class="no-hit">无法连接后端服务。请确认服务已启动。</div>'
    }
  }

  let sessionCwd = null // 当前会话启动根（网关 /gateway/session 附带，取自 jsonl 记录 cwd）；变更卡相对路径显示用
  async function fetchMessages(sessionId) {
    if (needToken()) return { messages: [], context: null, model: null, modelTs: null, effort: undefined } // token 门锁定态
    const res = await fetch(apiUrl('/gateway/session?id=' + encodeURIComponent(sessionId)))
    const data = await res.json()
    if (!Array.isArray(data.messages)) throw new Error(data.error || 'bad response')
    // CLI 已按「复用已有实现」原则导出过滤后的会话展示（display，见 conversationDisplay.ts /
    // 网关 /gateway/session 注入）→ 存在时优先消费（thinking 过滤 / 真实用户消息识别由 CLI 权威完成），
    // 尚未导出（如网关重启后 CLI 未重发）时回退后端原始消息映射。
    // context = 网关 readSession 提取的上下文占用（dsh ContextMeter 数据源），无则 null。
    // model/modelTs = 网关附带的每会话实际模型（CLI reportCurrentModel 上报），无则 null。
    // cwd = 会话启动根（2026-08-29 变更卡相对路径显示），无则 null。
    // queued = 当前排队项快照（2026-08-30 队列快照链，CLI queue-state 上报，置底排队区首载数据源）；
    // tasks = 当前任务清单快照（2026-09-10 任务浮窗链，CLI task-state 上报，底栏任务浮窗首载数据源）；
    // file = jsonl 文件名（uuid），供 SSE queue-state / task-state 事件按会话精确匹配。
    // effort（2026-11-06 每会话思考等级）：网关有该会话档位镜像才给键——缺键 = 该会话没改过档
    // （web 回落全局默认），null = 明确 Off。
    return { messages: data.display || data.messages, context: data.context || null, model: data.model || null, modelTs: data.modelTs || null, effort: data.effort, vision: !!data.vision, cwd: data.cwd || null, queued: Array.isArray(data.queued) ? data.queued : [], tasks: Array.isArray(data.tasks) ? data.tasks : [], file: typeof data.file === 'string' ? data.file : null, deltaSeq: typeof data.deltaSeq === 'number' ? data.deltaSeq : null }
  }
  // 模型 seat 校准（applySessionModel）已于 2026-10-10 分层治理 4B 迁入 inputbar/model-select.js——
  // 它操作的是输入栏状态（MODEL_CUR/modelUserPicked），归 feature 层；engine 不得 import feature。
// —— 跨模块写入口（切割脚本生成）——
export function setSessionCwd(v) { sessionCwd = v }

export {
  applyTurnEndAt,
  fetchMessages,
  findSession,
  hashOf,
  listSigOf,
  loadSessions,
  sessCmp,
  sessionCwd,
  sorted,
  withSynthetic,
}
