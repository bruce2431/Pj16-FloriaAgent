// 选中文本 → 松开鼠标 → 引用浮窗（2026-09-28）

import { I } from '../core/icons.js'
import { inputEl, messagesEl, state } from '../engine/state.js'
import { esc } from '../core/util.js'
import { findSession } from '../engine/sessions.js'
import { quoteActions } from '../engine/ext-runtime.js'
import { IS_TOUCH_DEVICE } from '../sidebar/recent.js'
import { openCommentComposer } from '../feature/comment/comment-composer.js'
import { gwSend, syncGwSend } from './send.js'
/* @module inputbar/quote.js */
  // ---------- 选中引用（quote）----------
  // 两个来源：① #work-editor（只读编辑区，引用**文件 + 行范围**）② #chat-scroll（消息流，引用**会话锚点 + 原文**）。
  // 两条链的落地形态不同（用户定案）：文件引用只给位置——模型自己 Read 该文件；回复引用必须带原文——
  // 回复不属于任何文件，没有位置可查。两者都在输入栏里显示成同一族「引用胶囊」（透明胶囊 + 图标）。
  //
  // 浮窗竖排菜单 = 两个动作（浅色，2026-09-28 定案）：上行「使用 AI 编辑」= 只把引用胶囊塞进主输入栏，
  // 用户补完话术自己发；下行内嵌输入栏（话术）+ 尾部发送钮 = 立即把「引用 + 话术」作为一条消息发出。
  // 两者共用 insertRefChip，发送一律走 inputbar/send.js 的 gwSend（唯一发送口，不另起链路）。
  //
  // 唤出手势 = **松开鼠标那一刻**（document mouseup，主键；用户 2026-09-28 定案）——右键不再被拦截，
  // 浏览器原生菜单照旧弹出。选区必须在**开浮窗那一刻快照**：点浮窗里的输入框会把 DOM 选区清掉，
  // 靠 selection 现场取已来不及。
  //
  // 2026-09-28 扩展（项目注册）：浮窗改为「**内置动作 + 当前项目申报动作**分表合流」。动作表由项目在
  // `<项目>/.claude/preview/preview.json` 的 `quoteActions` 段静态申报（与 cards 同构、同一拉取点），
  // 经 engine/registry.js 的 registerQuoteActions 落表、本模块 quoteActions() 读。第二来源 = 项目预览页
  // （iframe）——它的选区在宿主看来不可达（跨文档 getSelection 不达），故由预览页 postMessage 自报：
  // `floria-quote-open`（开窗）/ `floria-quote-close`（关窗），宿主点申报动作行回发 `floria-quote-action`。
  // 执行逻辑**留在项目页面自己的运行上下文**（要调 Pj13 的 API 与 pdf 状态），宿主只回发 id、不代执行。

  // 可引用区（选区落在其中才认，其它区域不唤出）
  const QUOTE_ZONE = '#chat-scroll, #work-editor'

  let quotePop = null
  let quoteSkipNextUp = false // 「点浮窗外关窗」的那一下 mousedown 已消费：紧随的 mouseup 不得重开

  // ---------- 1. 选区 → 快照 ----------
  // 编辑区行号唯一来源 = CodeMirror 文档：整篇恒渲染为编辑器（无渲染 DOM 行锚、无 textarea），
  // Range 端点经 posAtDOM 反查源行号（sidebar/work.js wkEdQuoteLines，同处一个 IIFE 作用域可直接按名调用）。
  // 拿不到 → null（令牌退化为纯路径，不编造行号）。
  function quoteEditorLines(range) {
    const body = $('wk-ed-body')
    if (body && body.querySelector('.wk-ed-cm')) return wkEdQuoteLines(range)
    return null
  }
  // 快照构造的唯一入口，**两条来源共用**（桌面 mouseup 现场取选区 / 触屏引擎收编的选区）：
  // 入参恒为 Range，不读 window.getSelection —— 触屏那条路的 Range 是程序化设回的，与「当前选区」同源但
  // 未必同一对象（且收编靠的就是先清后设），读全局选区会在时序上分叉出第二份真源。
  function quoteSnapOfRange(range) {
    if (!range || range.collapsed) return null
    const text = range.toString()
    if (!text.trim()) return null
    const node = range.startContainer
    const el = node.nodeType === 1 ? node : node.parentElement
    if (!el || !el.closest || !el.closest(QUOTE_ZONE)) return null
    const rect = range.getBoundingClientRect()
    const inEditor = el.closest('#work-editor')
    if (inEditor) {
      // 未打开文件（空态提示行）：没有可引用的文件位置
      if (!state.workFile) return null
      const lines = quoteEditorLines(range)
      return { kind: 'file', text, rect, file: state.workFile, proj: state.workProj, l0: lines && lines[0], l1: lines && lines[1] }
    }
    const msg = el.closest('.msg')
    if (!msg) return null
    const all = [...messagesEl.querySelectorAll('.msg')]
    const idx = all.indexOf(msg) + 1
    const cur = state.currentHash ? findSession(state.currentHash) : null
    return { kind: 'reply', text, rect, title: (cur && cur.title) || '本会话', idx }
  }
  // 桌面路径：现场取 window.getSelection 的那一条 Range（触屏设备不唤本浮窗，见下方 mouseup 的 IS_TOUCH_DEVICE 早退）
  function quoteSnapOf() {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null
    return quoteSnapOfRange(sel.getRangeAt(0))
  }

  // ---------- 2. 引用胶囊（输入栏内）----------
  // CM6 接管（2026-10-14 #17 B 口径）：胶囊 = 引用令牌（refToken）进 doc 的原子装饰视图。
  // 序列化即 doc 原文——「回复/PDF 原文块进消息」的语义由令牌块自身承载（不再藏 dataset）。
  function insertRefChip(snap) {
    composerAppendRef(refToken({
      rkind: snap.kind,
      file: snap.file,
      proj: snap.proj || '',
      quote: snap.text,
      p0: snap.p0, p1: snap.p1,
      l0: snap.l0, l1: snap.l1,
      title: snap.title,
      idx: snap.idx,
    }))
    syncGwSend()
    return null
  }

  // ---------- 3. 浮窗 ----------
  function closeQuotePop() {
    if (quotePop) { quotePop.remove(); quotePop = null }
  }

  // 立即发送：引用 + 浮窗话术进输入栏 → gwSend（输入栏原有草稿一并发出，不丢内容）
  async function quoteSendNow(snap) {
    if (!snap) return
    const note = (quotePop.querySelector('.qp-in').value || '').trim()
    insertRefChip(snap)
    if (note) composerAppendText(note)
    closeQuotePop()
    composerFocus()
    await gwSend()
  }
  // 只入输入栏（「使用 AI 编辑」行 / 触屏选中栏同款语义）：不发送，关浮窗把焦点交还输入栏，
  // **光标落在胶囊之后**（composerAppendRef 已落块尾；用户 2026-09-28 定案：接着打字就是给这条引用的说明）。
  function quoteStash(snap) {
    if (!snap) return
    insertRefChip(snap)
    closeQuotePop()
    composerFocus()
  }
  // 动作行 = 内置（「使用 AI 编辑」）+ 当前项目申报行**合流**（2026-09-28）。外部只能**追加**——
  // 同 id 时内置优先（申报表里同名条目直接被略过），内置行永不因申报而变样或被删。
  const QUOTE_BUILTIN_ID = 'ai-edit'
  // 「添加评论」（2026-10-06）：只对**文件选区**在场——评论对象 = 文件 + 行范围（kind:'file'），
  // 回复/PDF 选区没有文件位置可锚。落地 = feature/comment/comment-composer.js 的 openCommentComposer（另一条内置动作，
  // 不进 AI 编辑的输入栏链）。同 id 申报行同样被略过（与 ai-edit 一致：内置优先）。
  const QUOTE_COMMENT_ID = 'comment'
  function quoteActionRows(snap) {
    const rows = [{ id: QUOTE_BUILTIN_ID, title: '使用 AI 编辑', builtin: true }]
    if (snap && snap.kind === 'file' && snap.file) rows.push({ id: QUOTE_COMMENT_ID, title: '添加评论', icon: 'msg', builtin: true })
    for (const a of quoteActions()) if (a.id !== QUOTE_BUILTIN_ID && a.id !== QUOTE_COMMENT_ID) rows.push(a)
    return rows
  }
  function quoteActionRowHtml(a) {
    const lead = a.builtin ? '' : `<span class="qp-ic">${I[a.icon] || I.plug}</span>`
    return '<button type="button" class="qp-row" data-qact="' + esc(a.id) + '">' +
      lead + '<span class="qp-lb">' + esc(a.title) + '</span><span class="qp-go"></span>' +
      '</button>'
  }
  // 申报动作的落地：宿主**不代执行**（业务动作要调项目自己的 API 与页面状态）——只把 id 回发预览帧。
  function quoteRunAction(id, snap) {
    const w = snap && snap.frame
    closeQuotePop()
    if (w) { try { w.postMessage({ type: 'floria-quote-action', id }, '*') } catch { /* 帧已销毁：动作无声丢弃 */ } }
  }
  // 唯一开窗入口（两条来源共用）：宿主机内选区（quoteSnapOf）与项目预览页自报（floria-quote-open）。
  // 后者多带 frame（回发锚点）与 kind:'pdf'，其余同构——外部来源不另开一套浮窗。
  function openQuotePop(snap) {
    closeQuotePop()
    const pop = document.createElement('div')
    pop.className = 'quote-pop'
    pop.innerHTML =
      quoteActionRows(snap).map(quoteActionRowHtml).join('') +
      '<div class="qp-bar">' +
        '<input class="qp-in" type="text" placeholder="对这段说点什么…" aria-label="引用说明" />' +
        '<button type="button" class="qp-send" title="发送" aria-label="发送"></button>' +
      '</div>'
    pop.querySelectorAll('.qp-go').forEach((g) => { g.innerHTML = I.dshSend })
    pop.querySelector('.qp-send').innerHTML = I.dshSend
    document.body.appendChild(pop)
    // 落点 = 选区下方（与图片一致：菜单挂在选中行下面），越界 clamp 回视口（与 recent.js 行菜单同一算法）
    const r = snap.rect || { left: 0, bottom: 0 }
    const w = pop.offsetWidth
    const h = pop.offsetHeight
    // 越界下限取**可视**视口底（键盘上沿）：innerHeight 是布局视口，键盘在场不缩，按它 clamp 会落进键盘后。
    const vv = window.visualViewport
    const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight
    pop.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - w - 8))) + 'px'
    pop.style.top = Math.round(Math.max(8, Math.min(r.bottom + 6, viewBottom - h - 8))) + 'px'
    pop.addEventListener('mousedown', (e) => e.stopPropagation()) // 浮窗内按下不算「点外部」
    pop.querySelectorAll('.qp-row').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.qact
        if (id === QUOTE_BUILTIN_ID) quoteStash(snap)
        else if (id === QUOTE_COMMENT_ID) { closeQuotePop(); openCommentComposer(snap) }
        else quoteRunAction(id, snap)
      }),
    )
    pop.querySelector('.qp-send').addEventListener('click', () => quoteSendNow(snap))
    pop.querySelector('.qp-in').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); quoteSendNow() }
      else if (e.key === 'Escape') { e.preventDefault(); closeQuotePop() }
    })
    quotePop = pop
  }

  // ---------- 4. 手势 ----------
  // 松开鼠标那一刻（document mouseup，主键）—— 有非空选区且落在可引用区即开浮窗；右键不拦，原生菜单照旧。
  // 浮窗内的 mouseup 不算（那一处是点菜单行/输入框）。「点浮窗外关窗」的那一下同样不算——某些元素上
  // 按下并不会清掉选区，不挡就会「关掉又立刻重开」。
  document.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return
    // 触屏设备一律回归 iOS 原生选中菜单（2026-10-02 定案）：宿主自绘的触屏选中栏与系统菜单并存 = 双框，
    // 且程序化选区压不住 iOS 原生选择手势（pointerdown 是 passive，抢跑拦不住）⇒ 撤掉自绘接管。消息流/
    // 编辑区在触屏上不再弹本浮窗；PDF 预览页走 postMessage 桥（另一条来源，见 §5），不受此门影响。
    if (IS_TOUCH_DEVICE) return
    if (quoteSkipNextUp) { quoteSkipNextUp = false; return }
    if (quotePop && quotePop.contains(e.target)) return
    const snap = quoteSnapOf()
    if (snap) openQuotePop(snap)
  })
  // 点浮窗外任意处 / 滚动 / 窗口尺寸变化 / Esc → 关（fixed 浮窗会漂离锚点）。
  // 滚动关闭守护的不变量 = 「锚点漂移」：只有**浮窗外**的滚动才会让选区滚动走、浮窗漂离锚点。
  // 浮窗内输入框自己的内容滚动（qp-in 超宽横滚 / 长文本纵滚）不改变锚点关系，不得关窗——
  // 否则输入多行/长文本的瞬间（内容一滚）浮窗即消失（capture 监听 window 也能收到元素 scroll）。
  document.addEventListener('mousedown', (e) => {
    if (quotePop && !quotePop.contains(e.target)) { closeQuotePop(); quoteSkipNextUp = true }
  })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && quotePop) closeQuotePop() })
  // 开始编辑即关窗（2026-10-18 用户定案）：选区仍在、用户直接在编辑区继续敲字/退格/粘贴时，浮窗必须消失——
  // 快照已对不上文档，继续挂着等于对过期选区动手。判据 = `beforeinput`（只覆盖真编辑；纯导航/复制不触发），
  // 浮窗内输入框自身的编辑（target 在浮窗内）不关自己。
  document.addEventListener('beforeinput', (e) => {
    if (quotePop && !quotePop.contains(e.target)) closeQuotePop()
  })
  // iPad（2026-10-14 Pj13 转派）：弹软键盘会触发 resize、浮窗内输入也会带出滚动——光标在浮窗输入框里时
  // 这两类事件都不是「锚点漂移」，不得关窗（豁免判据 = 焦点在浮窗内）；浮窗外滚动/真 resize 仍照常关。
  const quoteFocusInside = () => !!quotePop && quotePop.contains(document.activeElement)
  window.addEventListener('scroll', (e) => { if (quotePop && !quotePop.contains(e.target) && !quoteFocusInside()) closeQuotePop() }, { passive: true, capture: true })
  window.addEventListener('resize', () => { if (quotePop && !quoteFocusInside()) closeQuotePop() })

  // ---------- 5. 项目预览桥（floria-quote-open / floria-quote-close / floria-quote-action）----------
  // 预览页（<项目>/.claude/preview 的 iframe，src = 127.0.0.1:<port> 或 /backend/<label>/）里的选区
  // 宿主看不到（跨文档 getSelection 不达）⇒ 由预览页自报开窗；关窗同理：iframe 内点击/滚动都不冒泡
  // 到宿主 document，宿主那两条「点外部/滚动即关」的策略对帧内事件失效，故预览页必须显式发 close。
  // **门 = e.source 必须是当前在场 .preview-frame 的 contentWindow**（与 rail-ext / ext-card 同一道）。
  // **按 e.source 反查帧、不取 querySelector 第一个**：槽位预览卡与 work 预览栏可能同时在场，
  // 取「第一个」会把 bridge 认到错误的帧（rail-ext 同病，本模块不重蹈）。
  const QUOTE_FRAME_SEL = '.preview-frame'
  function quoteFrameBySource(src) {
    let hit = null
    document.querySelectorAll(QUOTE_FRAME_SEL).forEach((el) => {
      if (hit || !el.contentWindow) return
      if (el.contentWindow === src) hit = el
    })
    return hit
  }
  // 坐标换算：预览页给的是 **iframe 内视口坐标**（0,0 = 帧左上角），叠上帧自身的位置即是宿主视口坐标。
  // 浮窗落点只需 left/bottom（openQuotePop 用这两项 + 视口 clamp）。
  function quoteFrameRect(frame, r) {
    const b = frame.getBoundingClientRect()
    const x = Number(r && r.x) || 0
    const y = Number(r && r.y) || 0
    const h = Number(r && r.h) || 0
    return { left: b.left + x, bottom: b.top + y + h }
  }
  function quoteBridgeOnMessage(e) {
    const d = e.data
    if (!d || typeof d !== 'object') return
    if (d.type !== 'floria-quote-open' && d.type !== 'floria-quote-close') return
    const frame = quoteFrameBySource(e.source)
    if (!frame) return // 非当前预览帧的输入一律不理（唯一守门）
    if (d.type === 'floria-quote-close') { closeQuotePop(); return }
    const text = typeof d.text === 'string' ? d.text : ''
    if (!text.trim()) return
    const p0 = Number(d.page) > 0 ? Number(d.page) : 0
    const p1 = Number(d.pageEnd) > 0 ? Number(d.pageEnd) : 0
    // 路径基准交给 refPath（会话开在 Pj13 时出项目内相对路径，否则带 label 前缀）——proj 取帧的 data-label。
    openQuotePop({
      kind: 'pdf',
      text,
      rect: quoteFrameRect(frame, d.rect),
      frame: frame.contentWindow,
      file: typeof d.pdf === 'string' ? d.pdf : '',
      proj: frame.dataset.label || '',
      p0,
      p1: p1 || p0,
    })
  }
  window.addEventListener('message', quoteBridgeOnMessage)

export {
  QUOTE_FRAME_SEL,
  QUOTE_ZONE,
  closeQuotePop,
  insertRefChip,
  openQuotePop,
  quoteActionRows,
  quoteEditorLines,
  quoteFrameBySource,
  quoteFrameRect,
  quoteRunAction,
  quoteSnapOf,
  quoteSnapOfRange,
  quoteStash,
}
