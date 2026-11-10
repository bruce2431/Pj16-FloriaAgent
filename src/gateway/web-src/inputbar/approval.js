// 瞬态/落定渲染 + 审批卡 + 提问卡 + 回合态（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { TOOL_NAMES, fmtDur, CHEV, ICON_COPY, writeClipboard, pendingUserMsgs, statusFlags, fileCardsHtml } from '../chat/messages.js'
import { renderHome, renderSession } from '../chat/route.js'
import { scrollBottom, stage, stageFollow, stageSync, appendMsg } from '../chat/stage.js'
import { gws } from '../engine/gateway.js'
import { I } from '../core/icons.js'
import { refreshSession, bindLiveFoldTimer } from '../engine/live.js'
import { mdHtml } from '../core/markdown.js'
import { messagesEl, inputWrap, inputBarEl, inputEl, sendBtn, state, live, connUp } from '../engine/state.js'
import { esc, toast } from '../core/util.js'
import { renderUserText, quoteBodiesAsMarkdown } from './mention.js'
import { syncGwSend } from './send.js'
import { closeCmdPop } from './commands.js'
import { firstSendHash } from '../sidebar/recent.js'
/* @module inputbar/approval.js */
  function renderTransient() {
    const cur = state.currentHash
    const authLive = !!messagesEl.querySelector('details.done-fold.done-live[data-m]')
    // 事务期（首条消息乐观权威窗口）项 hash 暂空：hash='' 且事务在场（firstSendHash===cur，
    // 含导航前 ''==='') 的项计入本会话——首页发送瞬间 currentHash/firstSendHash 双空也要能渲
    // 出开启主张；'' 项的清理由会话切换/事务回滚/撤回链负责（renderSession 869/ws-failed/renderHome）
    const local = pendingUserMsgs.filter((p) => p.hash === cur || (p.hash === '' && firstSendHash === cur))
    const bubble = authLive ? [] : local.filter((p) => p.form === 'bubble')
    // 排队区合并（2026-08-30 清单#4②）：本地乐观项（dock 形态 + 权威在场时降级的气泡项）
    // + CLI 队列快照（live.queueRemote，queue-state SSE / queued 首载）。文本去重防 web 自发
    // 消息与 CLI 快照回报双份；按入队 ts 升序（FIFO）。首条消息事务期 remote 不渲（注入中
    // 开启消息保持对话流气泡形态，快照照渲会同条消息以「排队中」重现 = 三态第②态根源）。
    const inTx = firstSendHash && firstSendHash === cur
    const remote = cur && !inTx ? (live.queueRemote || []) : []
    const dockItems = []
    const seen = new Set()
    for (const p of local) {
      const t = String(p.text || '')
      if (!t || seen.has(t)) continue
      seen.add(t)
      if (!authLive && p.form === 'bubble') continue // 开启气泡走气泡渲染，不进 dock
      dockItems.push({ content: t, ts: p.baseTs || p.claimTs || Date.now(), imgs: Array.isArray(p.imgs) ? p.imgs : [] })
    }
    for (const q of remote) {
      if (q && typeof q.content === 'string' && q.content && !seen.has(q.content)) {
        seen.add(q.content)
        // 跨会话来件在队列里同样标来源（CLI 侧 queue-state 已把 wrapper 剥成 content+from，
        // 见 gatewayClient.queueItemsFromSnapshot）——排队区不出现原始 XML 包装文本
        dockItems.push({ content: q.content, from: q.from || null, ts: typeof q.ts === 'number' ? q.ts : 0 })
      }
    }
    dockItems.sort((a, b) => (a.ts || 0) - (b.ts || 0))
    if (!bubble.length && !dockItems.length) {
      const z0 = document.getElementById('live-zone')
      if (z0) z0.remove()
      claimTimerSet(false)
      syncTurnLive()
      renderSettle() // zone 摘除 = 内容高度骤减：两层占位/scrollTop 立即对账（防 clamp 跳变）
      return
    }
    // 签名跳过：区内容无变化的重复调用（400ms 防抖刷新/逐条 SSE）不重建 DOM——重建会重播
    // msg-in 入场动画（跳字/滚动路径上的闪烁根源）
    const sig = JSON.stringify([authLive, bubble.map((p) => p.text), dockItems.map((q) => [(q.from && q.from.title) || '', q.content])])
    let zone = document.getElementById('live-zone')
    if (zone && zone.dataset.sig === sig) {
      claimTimerSet(bubble.length > 0)
      syncTurnLive()
      return
    }
    // 重建事务先移除旧区（2026-09-07 偶发重复渲染根修：漏移除则旧 zone 残留 DOM，新 zone
    // 插到 spacer 前、getElementById 恒拿最旧第一个 → 其 sig 永不匹配 → 只增不减；回合运行中
    // 走增量路径无整页重建洗地，queue-state/吸收翻转连发即堆出「排队消息 ×N」历史快照层）。
    // 不变量：#live-zone 全文档至多一个，由本函数独占维护。
    if (zone) zone.remove()
    zone = document.createElement('div')
    zone.id = 'live-zone'
    zone.dataset.sig = sig
    // 容器恒插在 .pin-stage 之前（两层占位块必须是 #messages 末元素）；display:contents 不产生盒，
    // 子元素即 #messages 直接 flex 参与者，布局与散挂时完全一致（styles.css #live-zone）
    messagesEl.insertBefore(zone, messagesEl.querySelector('.pin-stage'))
    // 2026-08-30 排队图片：本地乐观项带图 → 渲染缩略图并剥 [Image #N] 占位（占位仅供 CLI 注入
    // 对应 pastedContents，原样显示即「排队图片没有渲染」根因）；remote（CLI 队列快照）无图数据仅文本。
    // 乐观开启气泡与落盘气泡同构（2026-09-07）：带复制按钮（document 级委托天然可点），否则落盘
    // 接管帧按钮凭空出现（无按钮→有按钮形态跳变）。
    zone.innerHTML =
      bubble.map((p) => {
        const imgs = Array.isArray(p.imgs) && p.imgs.length ? p.imgs : []
        const imgsHtml = imgs.length
          ? '<div class="msg-imgs">' + imgs.map((im) => '<img class="msg-img" src="' + (im.dataUrl || '') + '" alt="">').join('') + '</div>'
          : ''
        // 文件卡片（2026-09-12）：乐观气泡与落盘气泡同构——[文件:<路径>] 占位剥出渲染卡片
        const files = Array.isArray(p.files) && p.files.length ? p.files.map((f) => f.abs).filter(Boolean) : []
        const filesHtml = files.length ? fileCardsHtml(files) : ''
        const bodyText = quoteBodiesAsMarkdown(String(p.text).replace(/\s*\[Image #\d+\]/g, '').replace(/\s*\[文件:[^\]]*\]/g, ''))
        // 正文渲染与落盘气泡同源（messages.js userBodyHtml → mdHtml）：此前乐观侧走 renderUserText
        // （esc 裸文本、无块级包裹），落盘侧出 <p>（styles.css `.msg .body p { margin: 3px 0 }` 上下各 3px）
        // ⇒ 接管帧气泡高度跳 6px、多行文本还从「空白折叠」变 <br>（2026-09-15 用户实测「气泡大小有微小差异」）。
        // 同构不变量见下（乐观开启气泡与落盘气泡同构，2026-09-07 定案）——body 渲染是它此前漏网的一环。
        const bodyInner = mdHtml(bodyText)
        // 纯图/纯文件消息：无 .body 空气泡、无复制按钮（落盘接管帧同构同去，2026-09-07 空气炮根修）
        return '<div class="msg user msg-in" data-t="u">' + (bodyInner ? '<div class="body md-scope">' + bodyInner + '</div>' : '') + imgsHtml + filesHtml + (bodyInner ? '<div class="msg-actions"><button class="msg-copy" title="复制" aria-label="复制">' + ICON_COPY + '</button></div>' : '') + '</div>'
      }).join('') +
      (bubble.length
        ? '<details class="done-fold done-live msg-in" id="claim-fold" open><summary>' + procLabel('正在处理', '0s') + '</summary><div class="done-body"></div></details>'
        : '') +
      (dockItems.length
        ? '<div class="queue-dock" id="queue-dock">' + dockItems.map((q) => {
            const imgs = Array.isArray(q.imgs) && q.imgs.length
              ? '<div class="q-imgs">' + q.imgs.map((im) => '<img class="q-img" src="' + (im.dataUrl || '') + '" alt="">').join('') + '</div>'
              : ''
            const txt = quoteBodiesAsMarkdown(String(q.content).replace(/\s*\[Image #\d+\]/g, '').replace(/\s*\[文件:[^\]]*\]/g, ''))
            // 来源行在 q-body 首行（排队项是单行 flex；行内首行即视觉上方）
            const who = q.from && q.from.title ? '<div class="q-who">来自 会话：' + esc(String(q.from.title)) + '</div>' : ''
            // 纯图排队项（[Image #N] 剥出后无文本）不渲染空气泡段 <p>，否则图片上方凭空多一行高
            // 气泡归属文字、不归属图片（2026-09-19 用户定案「总是文字有气泡而图片没有」）：
            // 气泡壳挂在 .q-text 上（styles.css），不在 .q-item 上——纯文本项=一个气泡；纯图项无
            // .q-text ⇒ 无气泡、整张图即点击体（点图催办不开大图；大图只认 .msg-img，此处恒 .q-img）；
            // 文字+图项=文字带气泡、图片在气泡外裸渲染。归属由 DOM 结构本身决定，无额外类/状态源。
            const body = txt ? '<div class="q-text"><p>' + renderUserText(txt) + '</p></div>' : ''
            return '<div class="q-item" role="button" title="点击催办：结束当前思考，本条立即并入本轮"><div class="q-body">' + who + body + imgs + '</div></div>'
          }).join('') + '</div>'
        : '')
    claimTimerSet(bubble.length > 0)
    syncTurnLive() // 主张折叠在场 = 回合开启运行态（停止键）；权威接管/吸收后按实况校准
    renderSettle()
  }
  // 渲染权威出口对账（2026-09-08 两层消息流收口）：渲染链每动 DOM 后在此强制 stageSync——
  // 占位块重挂/高度校准/气泡重定位/两层跟随归位；占位未激活零开销。暂态区 #live-zone 高度
  // 随乐观气泡/主张折叠/排队区增减、queue-state SSE 直调 renderTransient、发送瞬间主张上屏
  // 等路径全部经此对账，无盲区。占位=机制态（内存状态机+DOM 投影），渲染权威是事实源。
  function renderSettle() {
    if (!stage.active) return
    stageSync()
  }
  // 2026-09-10 排队消息催办：点击排队气泡 = 「这条我等不及了」——请求引擎把当前正在飞的
  // 生成流就地收尾，好让本轮 drain 把它作为注入引导织进当前折叠体（与「模型自然答完后排队
  // 消息被纳入」同一条路径、同一种渲染）。**不是中断**：不改回合边界、不撤回、不产生新回合、
  // 不产生新的乐观气泡。
  // 动作是队列级的（非按条定位）：网关按会话把 {type:'queue-nudge'} 路由给在线 CLI，由 CLI
  // 侧判活决定是否置位（无在飞生成 / 队列里没有可 drain 的用户消息 → 静默 no-op）。
  // 事件委托：队列区 DOM 由 renderTransient 反复重建（签名跳过不等于恒不重建），逐项绑定会
  // 随重建失效（同 .msg-copy/.ch-toggle 的委托写法）。
  document.addEventListener('click', (e) => {
    const item = e.target && e.target.closest ? e.target.closest('.q-item') : null
    if (!item || !messagesEl.contains(item)) return
    if (!state.currentHash || !gws || gws.readyState !== 1) return
    gws.send(JSON.stringify({ type: 'queue-nudge', sessionId: state.currentHash }))
    toast('已催办：本条并入当前轮次')
  })
  // 乐观主张计时起点移交（接管帧 refreshSession/renderSession）：取当前会话/事务未吸收的
  // 开启气泡最早 claimTs——发送瞬间早于落盘 user ts（异步化暂存补投窗口），移交 live.txProcStart
  // 供 bindLiveFoldTimer 续算，「正在处理 Xs」跨接管连续不回跳。
  function claimStartTs() {
    const cur = state.currentHash
    let t0 = 0
    for (const p of pendingUserMsgs) {
      if (p.form !== 'bubble' || !p.claimTs) continue
      if (p.hash !== cur && !(p.hash === '' && firstSendHash === cur)) continue
      if (!t0 || p.claimTs < t0) t0 = p.claimTs
    }
    return t0
  }
  // 主张折叠计时：发送瞬间 T0 起跳字；权威折叠接管后由 bindLiveFoldTimer（数据起点）接棒，
  // 本计时器随主张折叠移除/降级一并停止（claimTick 自检兜停）。
  let claimTimer = null
  function claimTick() {
    const fold = document.getElementById('claim-fold')
    if (!fold || !fold.isConnected) { claimTimerSet(false); return }
    const claims = pendingUserMsgs.filter((p) => p.form === 'bubble' && p.claimTs && (p.hash === state.currentHash || (p.hash === '' && firstSendHash === state.currentHash)))
    if (!claims.length) { claimTimerSet(false); return }
    const t0 = Math.min(...claims.map((p) => p.claimTs))
    const sum = fold.querySelector('summary')
    if (sum) {
      // 2026-09-07 僵死/断连对账（同 bindLiveFoldTimer tick）：乐观窗口 = 消息已发、引擎未应答
      // ——正是「一直思考不说话」第一现场。beat 缺席/落后 ≥150s → 标「无响应」；网关 WS 断 →
      // 标「连接中断」。beat 恢复即消失（每秒 tick 重算，无残留状态）。
      // 同 tick 回合基线规则：beat 早于主张起点 t0 = 上回合残留 → 视同缺席（乐观窗口发送
      // 瞬间恰是新回合开头，旧 beat 必残留，不 clamp 必误标——12:42 实测同根）。
      const rawBeat = live.turnBeat.get(state.currentHash) || 0
      const beatAt = rawBeat >= t0 ? rawBeat : 0
      const staleSec = beatAt ? Math.round((Date.now() - beatAt) / 1000) : Math.round((Date.now() - t0) / 1000)
      // ③ 2026-09-11 审批等待不算「无响应」（同 bindLiveFoldTimer tick 判定，两处同一规则）：
      // 审批卡在场 = 回合阻塞在等用户作答，引擎无产出是预期 → 本帧不参与僵死判定，传 0。
      // 文案/阈值/优先级由 messages.js statusFlags 单源构造（2026-09-11 单状态槽定案：红标即状态，
      // 文案不带前导「·」）。主张折叠体（.done-body）内无 .think-state，故无独占标可挂。
      const flags = statusFlags(connUp, takeover !== 'approval' ? staleSec : 0)
      // 原地续时（2026-09-08 同 bindLiveFoldTimer tick 收口）：节点级更新不 innerHTML 重建。
      // summary 恒「正在处理 + d-dur」；流式预览/红标挂 done-body（2026-09-09 定案：折叠顶
      // 只留「正在处理/已处理」字样，与权威折叠同规则）。
      const durEl = sum.querySelector('.d-dur')
      if (durEl) durEl.textContent = ' ' + fmtDur(Math.round((Date.now() - t0) / 1000))
      const cbody = fold.querySelector('.done-body')
      if (cbody) {
        let flEl = cbody.querySelector('.d-flags')
        if (!flEl) { flEl = document.createElement('span'); flEl.className = 'd-flags'; cbody.appendChild(flEl) }
        flEl.innerHTML = flags
      }
    }
  }
  function claimTimerSet(on) {
    if (on && !claimTimer) { claimTimer = setInterval(claimTick, 1000); claimTick() }
    else if (!on && claimTimer) { clearInterval(claimTimer); claimTimer = null }
  }
  // 本地状态系统行开关（2026-08-28 用户定案：连接/回合结束/审批回执/状态行等本地反馈
  // 一律不插入聊天流，保留接口以便后续更改；错误行 addError 不受影响）
  const SHOW_LOCAL_SYS = false
  function addSystem(text) {
    if (!SHOW_LOCAL_SYS) return
    appendMsg(`<div class="msg msg-system">${esc(text)}</div>`)
  }
  function addError(text) {
    appendMsg(`<div class="msg msg-system" style="color:#ef4444">${esc(text)}</div>`)
  }
  // ---- 回合运行态（2026-09-04 web 打断按钮）：turnLive = 发送按钮形态（发送/停止）。点击停止经
  //      /clients 通路发 {type:'interrupt', sessionId} → 网关精确路由 → CLI onCancel（与 Ctrl+C 同路径）。
  //      2026-09-07 两区重构：turnLive 不再由 procOpen/procClose 维护（链已退役）——由 syncTurnLive()
  //      按 DOM 实况推导：权威 done-live[data-m] 折叠或暂态区乐观主张折叠在场 = 回合运行中；
  //      每次渲染路径末尾（renderTransient / 整页重建）校准，DOM 才是事实源。
  let turnLive = false
  let btnMode = 'send'
  function setBtnMode(mode) {
    if (btnMode === mode) return
    btnMode = mode
    sendBtn.innerHTML = mode === 'stop' ? I.dshStop : I.dshSend
    sendBtn.title = mode === 'stop' ? '打断当前回合' : '发送'
  }
  function syncTurnLive() {
    const has = !!messagesEl.querySelector('details.done-fold.done-live')
    if (has !== turnLive) { turnLive = has; syncGwSend() }
  }
  function procLabel(verb, dur) {
    const live = verb === '正在处理'
    return `<span class="d-chev">${CHEV}</span>${live ? '<span class="df-dot"></span>' : ''}${verb}${dur ? `<span class="d-dur"> ${dur}</span>` : ''}`
  }
  // 2026-09-07 两区重构：实时流式渲染链（procThink/procTool/procResult/startReply/streamText/
  // streamThinking/toolChip/addThinking 等）整体退役——网关从不给 web 投递 WS out 流，实时展示
  // 只走 SSE 会话上报 + jsonl 渲染权威（整页/增量重建），「正在处理」乐观主张折叠由 renderTransient
  // 从 pendingUserMsgs 统一渲染；历史定案注释（工具行只显当前步等）随链废弃，勿再引用。
  // ---- composer takeover（2026-10-24 用户定案：底栏不再变形，改为底栏上方独立浮层）----
  //      takeover = 'approval' | null，记录当前在场的待审批卡（提问与审批共用，2026-09-11 ④ 起只读
  //      提问卡的 'ask' 接管已移除，见 chat/messages.js askLineHtml 注）。
  //      形态：卡片是浮在输入栏上方的图层（#composer-takeover absolute bottom:100%），从底栏背后
  //      向上滑出；输入栏几何/外观/焦点完全不动（不隐藏输入内容组、不改高度、不 blur），草稿天然存活；
  //      聊天区不让位（不改 #chat-scroll padding）——底栏衍生 UI 一律是消息流之上的覆盖层。 ----
  let takeover = null
  // 分层治理 4C（2026-10-10）：engine/live.js 的读取口（写侧仍是尾部 setTakeover）——每次现读，
  // 调用方严禁缓存返回值。
  function getTakeover() { return takeover }
  const takeoverEl = () => $('composer-takeover')
  // 2026-10-24 重做（用户定案「不要用低栏变形，从底栏滑出、悬浮在其上；聊天区不用让位；
  // 底栏衍生的一切 UI 都是消息流上面一个图层」）：
  //   ①卡片是独立浮层，几何/外观不参与输入栏布局——输入栏高度、padding、焦点、草稿全不受影响；
  //   ②出入场 = 卡片在裁剪盒（bottom:100%）内 translateY 上滑/下滑，上滑起点整块藏进底栏背后，
  //     视觉上「从底栏滑出」；换题/重渲染（卡已展开）不重播入场动画；
  //   ③聊天区零让位：不写 #chat-scroll padding，卡片覆盖在消息流之上；
  //   ④动画所有权收敛到 tkToken：收起途中来新卡则沿用当前位移续走，不留「动画中」残留。
  const SLIDE_MS = 320 // = styles.css #composer-takeover .appr-card 的 transform 过渡时长
  let tkToken = 0
  function showTakeover(html, kind) {
    ++tkToken // 作废进行中的收起收尾
    const t = takeoverEl()
    if (!t) return
    const wasOpen = !!takeover
    const wasClosing = t.classList.contains('tk-out')
    takeover = kind
    t.innerHTML = html
    t.hidden = false
    t.classList.remove('tk-out')
    inputBarEl.classList.add('tk-open') // 仅作状态标记（任务浮窗让位）；不改输入栏视觉
    if (!wasOpen && !wasClosing) {
      // 首次出卡：先让浏览器渲染「藏在底栏背后」的首帧，再起播上滑
      t.classList.remove('tk-in')
      void t.offsetHeight
    }
    t.classList.add('tk-in')
    renderTaskDock() // 接管卡在场 → 任务浮窗收敛并让位（状态标记 tk-open 隐藏其头部条）
    scrollBottom()
  }
  function clearTakeover() {
    if (!takeover) return
    const my = ++tkToken
    takeover = null
    const t = takeoverEl()
    if (!t) { inputBarEl.classList.remove('tk-open'); renderTaskDock(); return }
    t.classList.remove('tk-in')
    t.classList.add('tk-out') // 下滑回底栏背后 + 淡出；tk-open 保留到收尾，任务浮窗不提前闪现
    setTimeout(() => {
      if (my !== tkToken) return
      t.hidden = true
      t.innerHTML = ''
      t.classList.remove('tk-out')
      inputBarEl.classList.remove('tk-open')
      renderTaskDock() // 浮动层撤走 → 任务浮窗恢复（仍是收敛态）
    }, SLIDE_MS)
    renderTaskDock() // 卡撤走 → 任务浮窗恢复（仍是收敛态，由用户点开）
  }

  // 2026-08-26 任务 A2：把 CLI 的 PermissionUpdate 建议转成前端可读标签/副标题
  // （addRules=始终允许/拒绝 <工具>(<内容>)；addDirectories=添加目录；setMode=权限模式）。
  // 勾选项原样透传（sendApprove.permissions → 网关 approval-response.updatedPermissions → CLI persistPermissions）。
  function sugLabel(u) {
    if (!u || typeof u !== 'object') return '记住此规则'
    switch (u.type) {
      case 'setMode': return '权限模式：' + (u.mode || '')
      case 'addDirectories': return '添加目录：' + (Array.isArray(u.directories) ? u.directories.join('、') : '')
      case 'removeDirectories': return '移除目录：' + (Array.isArray(u.directories) ? u.directories.join('、') : '')
      case 'addRules': case 'replaceRules': case 'removeRules': {
        const r = (Array.isArray(u.rules) && u.rules[0]) || null
        const tool = r && r.toolName ? r.toolName : ''
        const content = r && r.ruleContent ? r.ruleContent : ''
        const verb = u.type === 'removeRules' ? '取消规则' : (u.behavior === 'allow' ? '始终允许' : u.behavior === 'deny' ? '始终拒绝' : '始终询问')
        return (verb + (tool ? ' ' + tool : '') + (content ? ' (' + content + ')' : '')).trim()
      }
      default: return '记住此规则'
    }
  }
  function sugSub(u) {
    if (!u || typeof u !== 'object' || u.destination === 'session') return ''
    const D = { userSettings: '全局', projectSettings: '项目', localSettings: '本目录' }
    return (D[u.destination] || '') + '生效'
  }

  // ===== 审批卡正文渲染（2026-09-10 用户实测「可不可以把 json 转化为好看点的文本格式」）=====
  // 旧版把 a.input 原样 `JSON.stringify(input, null, 2)` 倒进 .appr-command —— Edit 的 old/new_string
  // 就是几十行转义 JSON（\n 满天飞、不可读）。改为按工具语义渲染：Edit=红/绿两段文本 diff，其余=
  // 中文字段标签 + 值列表（长值/多行值落成 mono 块）。纯 web 展示层格式化：进料仍是 CLI sendRequest
  // 原样透传的 a.input，不改协议、不新增后端字段。
  const FIELD_LABELS = {
    file_path: '文件', notebook_path: '文件', path: '目录', pattern: '匹配', glob: '文件过滤',
    output_mode: '输出', url: '网址', query: '关键词', prompt: '要求', offset: '起始行', limit: '行数',
    timeout: '超时', description: '说明', subagent_type: '子代理', command: '命令', content: '内容',
    old_string: '旧文本', new_string: '新文本', replace_all: '替换全部', cell_id: '单元格',
    edit_mode: '模式', new_source: '源码', run_in_background: '后台运行', model: '模型', isolation: '隔离',
  }
  const TOOL_FIELD_ORDER = {
    Read: ['file_path', 'offset', 'limit'],
    Grep: ['pattern', 'path', 'glob', 'output_mode'],
    Write: ['file_path', 'content'],
    NotebookEdit: ['notebook_path', 'cell_id', 'edit_mode', 'new_source'],
    WebFetch: ['url', 'prompt'],
    WebSearch: ['query'],
    Task: ['description', 'subagent_type', 'prompt'],
    Bash: ['command', 'description', 'timeout', 'run_in_background'],
  }
  function kvRow(label, value) {
    return `<div class="appr-kv"><span class="ak-l">${esc(label)}</span><span class="ak-v">${esc(value)}</span></div>`
  }
  function preBlock(text) { return `<pre class="appr-pre">${esc(text)}</pre>` }
  function diffBlock(label, oldStr, newStr, note) {
    const sign = (sg, s) => esc((s === '' ? '(空)' : s).split('\n').map((l) => sg + ' ' + l).join('\n'))
    const n = (s) => (s === '' ? 0 : s.split('\n').length)
    const file = label ? `<div class="appr-file">${esc(label)}</div>` : ''
    const meta = note ? `<div class="appr-meta">${esc(note)}</div>` : ''
    return file + meta +
      '<div class="appr-diff">' +
      `<div class="appr-diff-h">旧文本 · ${n(oldStr)} 行</div><pre class="appr-diff-b old">${sign('-', oldStr)}</pre>` +
      `<div class="appr-diff-h">新文本 · ${n(newStr)} 行</div><pre class="appr-diff-b new">${sign('+', newStr)}</pre>` +
      '</div>'
  }
  // 命令/正文类字段恒落 mono 代码块（哪怕一行——观感上是「一段代码」而不是「一个参数值」）；
  // 其余短值走行内「标签 + 值」，多行/超长值自动升级成块。
  const BLOCK_FIELDS = new Set(['command', 'content', 'new_source', 'prompt'])
  function fieldRow(key, value, desc) {
    const label = FIELD_LABELS[key] || key
    if (typeof value === 'boolean') return value ? kvRow(label, '是') : ''
    const s = typeof value === 'object' ? JSON.stringify(value) : String(value)
    if (desc && s.trim() === desc) return '' // 与卡头说明重复的行不再渲染一遍
    if (BLOCK_FIELDS.has(key) || s.includes('\n') || s.length > 140) {
      return `<div class="appr-kv"><span class="ak-l">${esc(label)}</span></div>${preBlock(s)}`
    }
    return kvRow(label, s)
  }
  function prettyToolInput(toolName, input, desc) {
    const o = input && typeof input === 'object' ? input : {}
    const str = (v) => (v == null ? '' : String(v))
    const present = (k) => o[k] != null && o[k] !== '' && !(Array.isArray(o[k]) && !o[k].length)
    if (toolName === 'Edit') return diffBlock(str(o.file_path), str(o.old_string), str(o.new_string), o.replace_all ? '替换文件中全部匹配' : '')
    if (Array.isArray(o.edits) && o.edits.length) { // MultiEdit 形态：逐处并列
      const head = str(o.file_path) ? `<div class="appr-file">${esc(str(o.file_path))}</div>` : ''
      return head + o.edits.map((e, i) => diffBlock(`第 ${i + 1} 处修改`, str(e.old_string), str(e.new_string), '')).join('')
    }
    // ExitPlanMode：输入里的 plan 是模型写的 Markdown 计划正文，走 mdHtml 渲染（.appr-md 作用域样式），
    // 与 CLI 弹窗 <Markdown> 同源语义；其余字段（allowedPrompts 等）仍按通用字段列表渲染。
    if (toolName === 'ExitPlanMode') {
      const plan = str(o.plan)
      const rest = Object.keys(o).filter((k) => k !== 'plan' && present(k))
      const restHtml = rest.length ? `<div class="appr-kvs">${rest.map((k) => fieldRow(k, o[k], desc)).join('')}</div>` : ''
      return (plan.trim() ? `<div class="appr-md md-scope">${mdHtml(plan)}</div>` : '') + restHtml
    }
    const order = TOOL_FIELD_ORDER[toolName] || []
    const keys = order.filter(present).concat(Object.keys(o).filter((k) => !order.includes(k) && present(k)))
    if (!keys.length) return ''
    return `<div class="appr-kvs">${keys.map((k) => fieldRow(k, o[k], desc)).join('')}</div>`
  }

  function renderApproval(a) {
    // 2026-08-24 提问答复（web 与 CLI 均可）：AskUserQuestion 审批卡渲染为交互表单，逐题选答案，
    // 提交后经 approve 带 {input, answers} 回 CLI（网关 updatedInput 透传 → 工具拿到 answers）。
    const qs = a.input && Array.isArray(a.input.questions) ? a.input.questions : null
    if (a.toolName === 'AskUserQuestion' && qs && qs.length) {
      renderQuestionApproval(a, qs)
      return
    }
    const zh = TOOL_NAMES[a.toolName] || ''
    const headline = a.justification || a.headline || (zh || a.toolName || '工具调用')
    // 2026-08-26 任务 A2：审批增强——展示 CLI 侧 sendRequest 已上报的 description（原因说明）与
    // blockedPath（被阻止路径）；suggestions = 「记住此规则」候选（PermissionUpdate[]），可多选，
    // 允许时随 approve 带 permissions 透传回 CLI persistPermissions（复用既有 onAllow 语义，不扩协议）。
    const sugs = Array.isArray(a.suggestions) ? a.suggestions : []
    const desc = a.description && typeof a.description === 'string' ? a.description.trim() : ''
    const path = a.blockedPath && typeof a.blockedPath === 'string' ? a.blockedPath.trim() : ''
    const input = prettyToolInput(a.toolName, a.input, desc)
    // 计划审批（ExitPlanMode）：strip 行尾给一枚复制按钮，复制计划 Markdown 原文
    const planText = a.toolName === 'ExitPlanMode' && a.input && typeof a.input.plan === 'string' ? a.input.plan : ''
    let sugsHtml = ''
    if (sugs.length) {
      sugsHtml = `<div class="appr-sugs">${sugs.map((s, si) => {
        const lbl = sugLabel(s)
        const sub = sugSub(s)
        return `<button type="button" class="appr-sug" data-si="${si}"><span class="as-box"></span><span class="as-copy"><span class="as-title">${esc(lbl)}</span>${sub ? `<span class="as-sub">${esc(sub)}</span>` : ''}</span></button>`
      }).join('')}</div>`
    }
    // 2026-08-22 composer takeover：审批卡占输入栏（DSH ApprovalPanel 语义），不再 appendMsg 进 chat
    showTakeover(`
      <div class="appr-card">
        <div class="appr-strip"><span class="appr-dot"></span>需要批准${zh ? ' · ' + esc(zh) : ''}${a.toolName ? '（' + esc(a.toolName) + '）' : ''}${planText ? '<button type="button" class="appr-plan-copy" title="复制计划" aria-label="复制计划">' + ICON_COPY + '</button>' : ''}</div>
        <div class="appr-body">
          <div class="appr-headline">${esc(headline)}</div>
          ${desc ? `<div class="appr-desc">${esc(desc)}</div>` : ''}
          ${path ? `<div class="appr-path"><span class="ap-l">路径</span><span>${esc(path)}</span></div>` : ''}
          <div class="appr-input">${input}</div>
          ${sugsHtml}
        </div>
        <div class="appr-btns">
          <button class="appr-deny">拒绝</button>
          <button class="appr-allow">允许</button>
        </div>
        <div class="appr-state"></div>
      </div>`, 'approval')
    const t = takeoverEl()
    const sel = new Set()
    if (sugs.length) {
      t.querySelectorAll('.appr-sug').forEach((btn) => {
        btn.addEventListener('click', () => {
          const i = Number(btn.dataset.si)
          if (sel.has(i)) { sel.delete(i); btn.classList.remove('sel') }
          else { sel.add(i); btn.classList.add('sel') }
        })
      })
    }
    t.querySelector('.appr-allow').addEventListener('click', () => sendApprove(a.requestId, true, null, [...sel].map((i) => sugs[i])))
    t.querySelector('.appr-deny').addEventListener('click', () => sendApprove(a.requestId, false))
    // 计划复制：反馈形态同 .msg-copy（图标换对勾 1s）；卡片被重建时随 innerHTML 一并替换，无需解绑
    const copyBtn = t.querySelector('.appr-plan-copy')
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        writeClipboard(planText).then((ok) => {
          if (!ok) { toast('复制失败'); return }
          copyBtn.classList.add('copied')
          copyBtn.innerHTML = I.dshCheck
          copyBtn.title = '已复制'
          setTimeout(() => {
            if (!copyBtn.isConnected) return
            copyBtn.classList.remove('copied')
            copyBtn.innerHTML = ICON_COPY
            copyBtn.title = '复制计划'
          }, 1000)
        })
      })
    }
  }

  // 2026-08-24 提问交互表单：DSH「输入栏转化、依次显示」的降级——floria 在一张卡里列出所有问题，
  // 每题为单选（点选 option），全答完点「提交答案」→ 经审批中继回 CLI（CLI 端 handleInteractivePermission
  // 的桥应答对 allow 用 updatedInput={questions, answers}，工具即拿到答案）。
  // 2026-08-26 用户「一次仅渲染一个」：与 DSH QuestionComposer 一致的逐题语义——输入栏只显示当前一题，
  // 点选选项即记录，点「下一题」推进（带进度 第N/共M题），最后一题按钮变「提交答案」带全部 answers 回 CLI。
  function renderQuestionApproval(a, qs) {
    // 2026-08-30 提问卡对齐 DSH QuestionComposer（用户按 DSH 截图定稿）：eyebrow(header)+右上 折叠/×；
    // 编号方块选项（label+描述同行）；「输入你的答案」自由输入行（自定义答案优先于选项）；
    // 底部 <N/M> 翻题导航（可回看修改）+ 跳过本题 + 下一题/提交；整卡可折叠为一行（header+标题）。
    // 多选题（multiSelect:true）同编号方块、可多选 toggle、eyebrow 带「（可多选）」；提交时多选
    // join(", ") —— 与 CLI answers 契约对齐（record(question,string)，CLI join(", ") 同构）。
    // 取消回答 = 右上 ×（sendApprove deny），不再设「拒绝」按钮；跳过本题 = 该题留空推进（允许空答）。
    const answers = {}     // question -> string（单选）/ string[]（多选）
    const customText = {}  // question -> 自由输入文本
    const pick = {}        // question -> 'opt' | 'text'：单选本题的答案来源（点击即切换，见 pickText/pickOpt）
    const multiOf = {}     // question -> bool：多选题 = 勾选项 + 自定义文本并存（不受 pick 约束）
    let qi = 0
    let collapsed = false
    let submitting = false
    // 2026-09-30 修：单选沿用 pick 单源（点选项/点输入行二者只其一高亮、只其一参与提交）；
    // 多选下 pick 不再互斥——勾选项与自定义文本同时保留、一起提交（join(", ")，与 CLI concat 语义同构）。
    const ansOf = (q) => {
      if (multiOf[q]) {
        const arr = Array.isArray(answers[q]) ? answers[q].slice() : []
        const t = String(customText[q] || '').trim()
        if (t) arr.push(t)
        return arr.length ? arr.join(', ') : undefined
      }
      if (pick[q] === 'text') {
        const t = String(customText[q] || '').trim()
        return t || undefined
      }
      const v = answers[q]
      const s = Array.isArray(v) ? v.join(', ') : v
      return s || undefined
    }
    const submit = () => {
      submitting = true
      const out = {}
      qs.forEach((qq) => {
        const q = String(qq.question || '').trim()
        const v = ansOf(q)
        if (v) out[q] = v
      })
      sendApprove(a.requestId, true, { input: a.input, answers: out })
    }
    const bindChrome = (t) => {
      // 折叠/展开与 ×（取消回答）——展开/收起两态共用；点击 qa-top 空白处也可切换
      t.querySelector('.qa-top').addEventListener('click', (e) => {
        if (submitting || e.target.closest('.qa-x')) return
        collapsed = !collapsed
        render()
      })
      t.querySelector('.qa-x').addEventListener('click', () => {
        if (!submitting) sendApprove(a.requestId, false)
      })
    }
    function renderCollapsed() {
      const qq = qs[qi]
      const question = String(qq.question || '').trim()
      const header = String(qq.header || '提问')
      showTakeover(`<div class="appr-card qa-card qa-collapsed"><div class="qa-top"><span class="qa-fold" role="button" title="展开">${I.dshChevDown}</span><span class="qa-head"><span class="qa-eyebrow">${esc(header)}</span><span class="qa-title-sm">${esc(question)}</span></span><span class="qa-x" role="button" title="取消回答">${I.dshClose}</span></div></div>`, 'approval')
      bindChrome(takeoverEl())
    }
    function renderOne() {
      const qq = qs[qi]
      const question = String(qq.question || '').trim()
      const header = String(qq.header || '提问')
      const opts = Array.isArray(qq.options) ? qq.options : []
      const multi = qq.multiSelect === true
      const isLast = qi + 1 >= qs.length
      const fmt = (o) => (o && typeof o === 'object') ? String(o.label || '') : String(o || '')
      const descOf = (o) => (o && typeof o === 'object' && o.description) ? String(o.description) : ''
      const curAns = multi ? (Array.isArray(answers[question]) ? answers[question] : []) : answers[question]
      const isText = pick[question] === 'text'
      multiOf[question] = multi
      const hasText = String(customText[question] || '').trim().length > 0
      let rows = ''
      opts.forEach((o, oi) => {
        const label = fmt(o)
        const desc = descOf(o)
        const sel = multi ? curAns.includes(label) : (isText ? false : curAns === label)
        rows += `<button type="button" class="qa-opt${sel ? ' sel' : ''}" data-v="${esc(label)}"><span class="qa-num">${oi + 1}</span><span class="qa-copy"><span class="qa-label">${esc(label)}</span>${desc ? `<span class="qa-desc">${esc(desc)}</span>` : ''}</span></button>`
      })
      let html = '<div class="appr-card qa-card">'
      html += `<div class="qa-top"><span class="qa-fold" role="button" title="收起">${I.dshChevDown}</span><span class="qa-head"><span class="qa-eyebrow">${esc(header)}${multi ? '<span class="qa-multi-hint">（可多选）</span>' : ''}</span></span><span class="qa-x" role="button" title="取消回答">${I.dshClose}</span></div>`
      html += `<div class="qa-main"><div class="qa-title">${esc(question)}</div>`
      html += `<div class="qa-opts">${rows}</div>`
      html += `<div class="qa-inputrow${(multi ? hasText : isText) ? ' sel' : ''}"><span class="qa-input-ico">${I.dshEdit}</span><input type="text" class="qa-input" placeholder="${multi ? '输入你的答案（与勾选项一并提交）' : '输入你的答案'}" value="${esc(String(customText[question] || ''))}"></div>`
      html += `<div class="qa-foot"><div class="qa-nav"><button type="button" class="qa-nav-btn prev${qi > 0 ? '' : ' off'}" data-nav="prev" title="上一题">${I.dshChevRight}</button><span class="qa-nav-pos">${qi + 1}/${qs.length}</span><button type="button" class="qa-nav-btn next${qi < qs.length - 1 ? '' : ' off'}" data-nav="next" title="下一题">${I.dshChevRight}</button></div>`
      html += `<div class="qa-foot-btns"><button type="button" class="qa-skip">跳过本题</button><button type="button" class="appr-allow">${isLast ? '提交答案' : '下一题'}</button></div></div>`
      html += '<div class="appr-state"></div></div></div>'
      showTakeover(html, 'approval')
      const t = takeoverEl()
      bindChrome(t)
      // 2026-09-26 用户定案（单选）：①选中态由「点击」决定，不等输入；②切换来源不清空另一侧内容
      // （选过的选项、打过的字都留着）；③单选任何时刻只有一处高亮——pick[question] 是唯一判据，
      // `.qa-opt.sel` 与 `.qa-inputrow.sel` 二者只其一（聚焦态不再单独强调，见 gateway.js 的 qa-inputrow）。
      // 2026-09-30 修：以上 ③ 只适用于单选；多选下 pick 不参与——勾选高亮与自定义输入高亮可同时存在，
      // 输入行 `.sel` 由「有无自定义文本」驱动，选项高亮恒由勾选集合驱动（互不熄灭）。
      const inp = t.querySelector('.qa-input')
      const row = t.querySelector('.qa-inputrow')
      const paintOpts = () => { // 选项高亮 = 该 option 在选中集合里（单选且来源为 text 时才熄灭）
        const srcText = !multi && pick[question] === 'text'
        t.querySelectorAll('.qa-opt').forEach((b) => {
          const on = !srcText && (multi ? curAns.includes(b.dataset.v) : answers[question] === b.dataset.v)
          b.classList.toggle('sel', on)
        })
      }
      const pickText = () => { pick[question] = 'text'; if (multi) return; row.classList.add('sel'); paintOpts() }
      const pickOpt = () => { pick[question] = 'opt'; if (multi) return; row.classList.remove('sel') }
      row.addEventListener('click', () => { pickText(); inp.focus() }) // 点行任意处 = 选中本行并进入输入
      inp.addEventListener('focus', pickText) // 键盘 Tab / 程序聚焦同语义
      // 选项点选：只 toggle 行高亮不整卡重渲染（输入框不闪不失焦）；多选互不影响、单选互斥
      t.querySelectorAll('.qa-opt').forEach((btn) => {
        btn.addEventListener('click', () => {
          pickOpt()
          if (multi) {
            const v = btn.dataset.v
            const at = curAns.indexOf(v)
            if (at >= 0) curAns.splice(at, 1)
            else curAns.push(v)
            answers[question] = curAns
          } else {
            answers[question] = btn.dataset.v
          }
          paintOpts()
        })
      })
      inp.addEventListener('input', () => { // 只维护文本值（切换来源不丢字），选中态由点击决定
        const has = !!inp.value.trim()
        if (has) customText[question] = inp.value
        else delete customText[question]
        if (multi) row.classList.toggle('sel', has) // 多选：输入行高亮 = 有无自定义文本
      })
      t.querySelectorAll('.qa-nav-btn').forEach((b) => {
        b.addEventListener('click', () => {
          if (b.classList.contains('off')) return
          if (b.dataset.nav === 'prev' && qi > 0) { qi--; render() }
          if (b.dataset.nav === 'next' && qi < qs.length - 1) { qi++; render() }
        })
      })
      t.querySelector('.qa-skip').addEventListener('click', () => {
        if (submitting) return
        delete answers[question]
        delete customText[question]
        delete pick[question]
        if (isLast) submit()
        else { qi++; render() }
      })
      t.querySelector('.appr-allow').addEventListener('click', () => {
        if (submitting) return
        if (isLast) submit()
        else { qi++; render() }
      })
    }
    function render() { if (collapsed) renderCollapsed(); else renderOne() }
    render()
  }

  // 2026-08-26 P0 审批确认送达（Codex）：sendApprove 不再 WS send 后立即 clearTakeover。
  // 进入「提交中」（禁用按钮 + 状态行），等网关 approval-confirmed（CLI 已处理回执）才关卡；
  // approval-rejected（目标不在线）/断连 → 卡片保留 + 可见错误 + 重试按钮；等待无超时（2026-08-26 用户定案，与 CLI 一致，仅凭 confirmed/rejected/dismiss 收尾）。
  let approvalPending = null // {requestId, allowed, qa, perms}：等待确认中的审批
  // 分层治理 4D（2026-10-10）：engine/gateway.js 的只读读取口（写侧仍是尾部 setApprovalPending）——
  // 每次现读可变绑定，调用方严禁缓存返回值。
  function getApprovalPending() { return approvalPending }
  function sendApprove(requestId, allowed, qa, perms) {
    if (!gws || gws.readyState !== 1) return showApprovalError('连接已断开，审批未送达', requestId, allowed, qa, perms)
    // 2026-08-23 web 独立会话：带 sessionId 供网关路由到对应子进程（CLI 会话无此字段走 broadcast 未接入提示）
    const payload = { type: 'approve', requestId, allowed, sessionId: state.currentHash || undefined }
    if (qa && qa.answers) { payload.input = qa.input; payload.answers = qa.answers } // 2026-08-24 提问答复
    if (perms && perms.length) payload.permissions = perms // 2026-08-26 A2：勾选的「记住此规则」→ CLI persistPermissions
    gws.send(JSON.stringify(payload))
    if (approvalPending && approvalPending.requestId === requestId) approvalPending = null
    approvalPending = { requestId, allowed, qa, perms }
    const t = takeoverEl()
    if (t) {
      // 2026-08-30 提问卡改版：.qa-skip（跳过本题）同属提交动作按钮，busy 一并禁用
      t.querySelectorAll('.appr-allow, .appr-deny, .qa-skip').forEach((b) => { b.disabled = true; b.classList.add('busy') })
      let st = t.querySelector('.appr-state')
      if (!st) {
        const btns = t.querySelector('.appr-btns')
        st = document.createElement('div')
        st.className = 'appr-state'
        if (btns) btns.parentNode.appendChild(st)
      }
      st.innerHTML = '<span class="as-wait">正在提交…</span>'
    }
  }
  // P0：审批失败（断连/目标不在线/超时）→ 卡片保留 + 可见错误 + 重试；卡片不在则降级 addError
  function showApprovalError(text, requestId, allowed, qa, perms) {
    if (approvalPending && approvalPending.requestId === requestId) approvalPending = null
    const t = takeoverEl()
    if (t && takeover === 'approval') {
      t.querySelectorAll('.appr-allow, .appr-deny, .qa-skip').forEach((b) => { b.disabled = false; b.classList.remove('busy') })
      let st = t.querySelector('.appr-state')
      if (!st) {
        const btns = t.querySelector('.appr-btns')
        st = document.createElement('div')
        st.className = 'appr-state'
        if (btns && btns.nextSibling) btns.parentNode.insertBefore(st, btns.nextSibling)
        else if (btns) btns.parentNode.appendChild(st)
      }
      st.innerHTML = `<span class="as-err">${esc(text)}</span><button type="button" class="appr-retry">重试</button>`
      const retry = st.querySelector('.appr-retry')
      if (retry) retry.addEventListener('click', () => sendApprove(requestId, allowed, qa, perms))
    } else {
      addError(text)
    }
  }

  // 2026-08-30 网关 pending approval 重放（DSH 同款「待答=会话持久状态」语义）：切会话/WS 重连时
  // 告知网关当前会话 → 网关回放该会话未决 approval（提问瞬间开着别的会话或页面没开 → 切回补弹交互卡，
  // 不再只剩只读兜底卡）。gws 未开/无当前会话时静默跳过（onopen 与 renderSession 双向兜底）。
  function sendSubscribe() {
    if (!gws || gws.readyState !== 1 || !state.currentHash) return
    try { gws.send(JSON.stringify({ type: 'subscribe', sessionId: state.currentHash })) } catch { /* 连接已断 */ }
  }

  // 设备自报类型（2026-09-05）：iPadOS Safari 桌面模式 UA 与 macOS 全同（无 iPad 字样），
  // 网关按 UA 判设备恒显示 Mac——iPad 判定只能前端做（MacIntel + 多点触控），
  // 随 activate 轮询与 WS 连接上报，网关记入 gateway-devices（hint 优先于 UA 判定）。
  // ===== 底栏任务浮窗（2026-09-10；2026-10-04 改 dsh 任务栏形态）=====
  // 数据源 = CLI TodoV2 清单（源码 useTasksV2 单源出口 → /clients WS task-state → 网关 SSE /
  // /gateway/session.tasks 首载）。web 只渲染不复刻判定（根本原则 1）：排序/阻塞语义与 CLI
  // TaskListV2 同构（blockedBy 命中未完成项 = 阻塞变暗；id 升序）；状态显示改 dsh 任务栏的圆点
  // （.td-dot：完成=绿实心 / 进行中=蓝环 / 待办=灰实心，无删除线）。
  // 形态（2026-10-04 定案）：#input-bar 的子元素、贴其上沿（bottom:100%）——收敛态 = 一条完整
  // 头部条（.td-lip，与面板同族白卡，即列表图标 + 「任务」 + 计数 + chevron），点击上展；展开态
  // 面板顶（.td-head）渲同一份头部，下方圆点行列表；宽度 = 输入栏宽 −48px 居中；展开底边与
  // 输入栏上沿留 --td-gap=10px 间距、最高 min(40vh,460px) 内部滚动。
  // 接管卡（审批/提问）在场 → 自动收敛 + 禁点：浮层在场时头部条由 #input-bar.tk-open 隐藏，
  // 此处再清 taskOpen，保证卡撤走后浮窗重现仍是收敛态。
  function taskById(a, b) {
    const na = parseInt(a.id, 10)
    const nb = parseInt(b.id, 10)
    if (!isNaN(na) && !isNaN(nb)) return na - nb
    return String(a.id).localeCompare(String(b.id))
  }
  // 「+」工具栏（#cmd-pop）是否在场（2026-11-06 D）：以 DOM 可见性为准——cmd.open 在风险确认
  // 模态期间仍为真但弹窗已隐藏，那时任务浮窗不必让位（全屏模态本就盖住一切）。
  function cmdPopVisible() {
    const el = $('cmd-pop')
    return !!el && !el.hidden
  }
  function toggleTaskDock() {
    if (takeover) return // 接管卡在场：禁点（卡即输入栏本体，任务浮窗让位）
    // 2026-11-06 D：任务浮窗要展开/收起时先收「+」工具栏（互斥的另一半入口；
    // 打开工具栏时工具栏侧同样会收起本浮窗）。closeCmdPop 回程会重渲本浮窗。
    if (cmdPopVisible()) closeCmdPop()
    live.taskOpen = !live.taskOpen
    renderTaskDock()
  }
  function renderTaskDock() {
    const dock = $('task-dock')
    if (!dock) return
    const panel = $('task-panel')
    const lip = $('task-lip')
    const list = Array.isArray(live.tasks) ? live.tasks : []
    // 无清单（CLI 侧清空/隐藏，或未打开会话）→ 整窗不出现（与 CLI「tasks.length===0 → null」同判）
    if (!list.length || !state.currentHash) {
      dock.hidden = true
      dock.classList.remove('open', 'blocked')
      live.taskOpen = false
      return
    }
    // 2026-11-06 D 弹层互斥：两窗同挂 #input-bar 上沿，展开态会直接叠在一起。工具栏在场时
    // 任务浮窗整窗让位（含收敛把手）；工具栏关闭时 closeCmdPop 重渲本函数恢复。
    if (cmdPopVisible()) {
      dock.hidden = true
      dock.classList.remove('open', 'blocked')
      live.taskOpen = false
      return
    }
    const blocked = !!takeover // 接管卡在场：收敛并禁点
    if (blocked) live.taskOpen = false
    const open = !!live.taskOpen
    const keepTop = open ? panel.scrollTop : 0
    const unresolved = new Set(list.filter((t) => t.status !== 'completed').map((t) => t.id))
    const done = list.filter((t) => t.status === 'completed').length
    const running = list.filter((t) => t.status === 'in_progress').length
    const pending = list.length - done - running
    const items = [...list].sort(taskById).map((t) => {
      const status = t.status // 形状收口在网关 normalizeGatewayTasks（id/subject/status/blockedBy 已净化）
      const blockers = t.blockedBy.filter((id) => unresolved.has(id))
      const dim = blockers.length ? ' dim' : '' // 阻塞行变暗；完成行靠绿点区分（dsh 无删除线/不变暗）
      // 提示文案（不占版面）：阻塞行说明等哪条，进行中行给 CLI spinner 同源的 activeForm
      const tips = []
      if (blockers.length) tips.push('等待前序任务：' + blockers.join('、'))
      if (status === 'in_progress' && t.activeForm) tips.push(t.activeForm)
      const title = tips.length ? ` title="${esc(tips.join(' · '))}"` : ''
      const owner = t.owner ? `<span class="td-owner">@${esc(t.owner)}</span>` : ''
      return `<div class="td-item${dim}" data-st="${status}"${title}>`
        + `<span class="td-dot"></span>`
        + `<span class="td-sub">${esc(t.subject)}</span>${owner}</div>`
    }).join('')
    // dsh 任务栏形态（2026-10-04）：头部=列表图标 + 「任务」 + 计数（N 已完成 · M 进行中 · K 待处理）
    // + chevron；同一份头部既渲进收起把手（.td-lip），也渲进面板顶（.td-head），两态视觉连续。
    const header = '<span class="td-hico">' + I.dshPlan + '</span>'
      + '<span class="td-title">任务</span>'
      + `<span class="td-counts">${done} 已完成 · ${running} 进行中 · ${pending} 待处理</span>`
      + '<span class="td-chev">' + I.dshChevDown + '</span>'
    if (lip) lip.innerHTML = header
    // 面板整体重建（清单事件低频）：头部（点击向下收敛）+ 圆点状态行列表
    panel.innerHTML = '<div class="td-head" role="button" tabindex="0" aria-label="收起任务清单">'
      + header
      + '</div>'
      + `<div class="td-list">${items}</div>`
    dock.hidden = false
    dock.classList.toggle('open', open)
    dock.classList.toggle('blocked', blocked)
    if (lip) {
      lip.onclick = blocked ? null : toggleTaskDock
      lip.disabled = blocked
      lip.setAttribute('aria-expanded', open ? 'true' : 'false')
      lip.title = blocked ? '任务（审批中）' : open ? '收起任务' : '展开任务（' + list.length + ' 项）'
    }
    const head = panel.querySelector('.td-head')
    if (head) {
      head.onclick = blocked ? null : toggleTaskDock
      head.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTaskDock() } }
    }
    if (keepTop) panel.scrollTop = keepTop
  }

// —— 跨模块写入口（切割脚本生成）——
export function setTakeover(v) { takeover = v }
export function setTurnLive(v) { turnLive = v }
export function setBtnModeSet(v) { btnMode = v }
export function setApprovalPending(v) { approvalPending = v }

export {
  SHOW_LOCAL_SYS,
  SLIDE_MS,
  addError,
  addSystem,
  approvalPending,
  btnMode,
  claimStartTs,
  claimTick,
  claimTimer,
  claimTimerSet,
  clearTakeover,
  procLabel,
  renderApproval,
  renderQuestionApproval,
  renderSettle,
  renderTaskDock,
  renderTransient,
  sendApprove,
  sendSubscribe,
  setBtnMode,
  showApprovalError,
  showTakeover,
  sugLabel,
  sugSub,
  syncTurnLive,
  takeover,
  takeoverEl,
  turnLive,
}
