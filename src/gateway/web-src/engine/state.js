// 元素引用（2026-09-10 web-src 模块化切割自 app.js v287；2026-10-07 工具/设备判定拆至 core/util.js、
// 持久化拆至 core/storage.js；2026-10-10 界面状态 state 下沉 core/ui-state.js、两开关缺省下沉
// sidebar/work-state.js、charEl/toastEl 由 core/{char,util}.js 各自持有；唯一手改处，web/app.js 为生成物）

import { state } from '../core/ui-state.js'
/* @module engine/state.js */
  // ---------- 元素 ----------
  // 一元素一所有者：仅本模块（会话视图骨架）持有下列 DOM 句柄；charEl → core/char.js、
  // toastEl → core/util.js 各自持有（避免 core 反向依赖本模块）。
  const chatArea = $('chat-area')
  const sessionCard = $('session-card') // 会话卡（视图注册表 tab:false 一条；常驻 index.html，靠 hidden 退场）
  const messagesEl = $('messages')
  const inputWrap = $('input-wrap')
  // CM6 底栏接管（2026-10-14 #17 B 口径）：#input contenteditable 退役，inputEl 由 composer-cm
  // cmMount 指到 EditorView.contentDOM（focus()/contains() 等既有读法不变；let 因 composer 后赋值）
  let inputEl = null
  const inputBarEl = $('input-bar')
  const sendBtn = $('send-btn')
  const ctxMeterEl = $('ctx-meter')
  const ctxBtnEl = $('ctx-btn')
  const ctxPanelEl = $('ctx-panel')
  const bodyEl = $('recent-body')
  const sidebar = $('sidebar')
  const bubblePop = $('bubble-pop')
  const overlay = $('search-overlay')
  const sInput = $('search-input')
  const recentLabel = $('recent-label')
  const modeTabsEl = $('mode-tabs')

/* @module engine/state.js #2 */
  let ALL = []
  // 阶段1 实时同步：SSE 变更驱动的去重/防抖状态
  const live = { es: null, listSig: '', curSig: '', listT: null, sessT: null, lastUserSig: '', pinnedUserSig: '', lastMsgLen: null, lastDataTs: 0, curUuid: null, queueRemote: [], maxImgId: 0, compactFlags: new Map(), turnEndFlags: new Map(), restoredFlags: new Map(), turnBeat: new Map(), spinnerLabel: new Map(), txProcStart: 0, localMessages: null, deltaSeq: null, streamText: '', tasks: [], taskOpen: false }
  let connUp = false // 2026-09-07 网关 WS 在线（setConn 维护）：运行态计时 tick 据此标「连接中断」

// —— 跨模块写入口（切割脚本生成）——
export function setAll(v) { ALL = v }
export function setConnUp(v) { connUp = v }

export {
  ALL,
  bodyEl,
  bubblePop,
  chatArea,
  connUp,
  ctxBtnEl,
  ctxMeterEl,
  ctxPanelEl,
  inputBarEl,
  inputEl,
  inputWrap,
  live,
  messagesEl,
  modeTabsEl,
  overlay,
  recentLabel,
  sInput,
  sendBtn,
  sessionCard,
  sidebar,
  state,
}
