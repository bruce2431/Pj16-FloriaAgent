// 主区列宽分界条拖拽 + 助手三态（靠栏/悬浮/收敛）几何与把手拖拽。（拆自 sidebar/work.js，纯搬迁零行为变更；符号经单 IIFE 共享作用域可见）
/* @module sidebar/work/work-assist.js */
  // ---------- 主区列宽（分界条拖拽，参考 Pj18 preview 的 #divider）----------
  // 只剩一条分界条：下沉区 ↔ 预览列。列宽真源 = state.wkPrevW（预览列 px，写进 CSS 变量 --wk-pw 落 grid）。
  // 分界条显隐 = 预览在场（.wk-preview 类由 applyPanes 落，CSS 同步收窄成单列模板）。
  function applyWorkCols() {
    const on = state.sbMode === 'work'
    document.querySelectorAll('#chat-area > .work-gutter').forEach((g) => g.classList.toggle('on', on && !!state.wkPreview))
    if (on) chatArea.style.setProperty('--wk-pw', state.wkPrevW + 'px')
    else chatArea.style.removeProperty('--wk-pw')
    applyAssistMode() // 列宽/显隐变了 → 悬浮卡跟着重锚（分界条拖拽、开关栏、切模式都经这里）
  }

  // 拖动分界条：只改预览列宽（条往左拉 = 预览变宽），左侧下沉区自适应吃掉余量。
  // 地板 WK_PREV_MIN；上限 = 主区宽的 70%（拖不出一屏只剩预览）。
  const WK_PREV_MIN = 260
  const WK_PREV_MAX_RATIO = 0.7
  function bindGutter(g) {
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      const prev = $('work-preview')
      const main = chatArea.getBoundingClientRect()
      if (!prev || main.width <= 0) return
      const right = prev.getBoundingClientRect().right
      const maxW = Math.max(WK_PREV_MIN, Math.round(main.width * WK_PREV_MAX_RATIO))
      g.setPointerCapture(e.pointerId)
      g.classList.add('dragging')
      document.body.classList.add('wk-resizing')
      e.preventDefault()
      const move = (ev) => {
        state.wkPrevW = Math.max(WK_PREV_MIN, Math.min(maxW, Math.round(right - ev.clientX)))
        applyWorkCols()
      }
      g.addEventListener('pointermove', move)
      const done = () => {
        g.removeEventListener('pointermove', move)
        g.classList.remove('dragging')
        document.body.classList.remove('wk-resizing')
        saveWork()
      }
      g.addEventListener('pointerup', done, { once: true })
      g.addEventListener('pointercancel', done, { once: true })
    })
  }


  // ---------- 助手三态（2026-09-27，与 Pj18 preview 的三态助手对齐） ----------
  // 同一张 #session-card 的三个形态：'side'（靠栏 = 聊天 tab 的内容，占下沉格）/ 'float'（悬浮卡，脱流不占格）/
  // 'slim'（收敛成底部输入栏）。形态类落在卡上（.wk-assist-float / .wk-assist-slim），可见性与几何的
  // 静态部分全由 CSS 给（web/styles.css「助手三态」段），本模块只写类 + 内联定位。
  // **绝不 reparent**：卡里挂着 engine/state.js 模块级 const 引用的 messagesEl / inputWrap / charEl 单例，
  // 搬 DOM 会丢消息流与输入草稿（Pj18 #chat-pane 的同款约束）。
  // 锚点 = 当前可见的下沉内容栏（文件 tab 的 #work-editor）→ 整个 #chat-area；预览列固定最右不参与。
  // 坐标一律在 #chat-area 局部系算：用 absolute + #chat-area（position:relative）作包含块，左右上下
  // 全数相减——与壳体（body）在键盘态怎么定位无关，量到的恒是局部几何。
  const WK_ASSIST_PAD = 8      // 浮卡/输入栏与锚栏左右各留的白
  const WK_ASSIST_BOT = 24     // 距主区底部的距离（浮卡写 top、输入栏写 bottom，两态共用这一个值）
  // 正常底栏（#input-wrap.docked）在会话卡内的底距：top: calc(100% - 22px) —— 收敛输入栏要与它
  // 落在同一处，故停在「卡片底边 −22px」= 浮卡的 WK_ASSIST_BOT 再让出这 22px。两处数值同源，
  // 改一边必须改另一边（probe-work-scope F3c 锁这条耦合）。
  const WK_INPUT_BOT = 22
  const WK_ASSIST_MIN_W = 240
  const WK_ASSIST_MIN_H = 200
  const WK_ASSIST_MAX_VH = 0.7 // 高度上限 = 视口 70%（窄屏/横屏时浮卡不顶满）
  const WK_DRAG_SLOP = 3       // 位移 ≤3px 不算拖拽（区分点按与拖动）

  function wkAssistMode() {
    return state.wkAssistMode === 'float' || state.wkAssistMode === 'slim' ? state.wkAssistMode : 'side'
  }
  // in-flow = 助手是否占着下沉格（靠栏且开着）。wkShownTab 判定、三态几何两处共用这一条判据。
  function wkAssistInFlow() {
    return !!state.wkAssist && wkAssistMode() === 'side'
  }
  function wkAssistBase() {
    const b = chatArea.getBoundingClientRect()
    return b.width > 0 ? b : null
  }
  // 浮卡尺寸上限的基准高 = **可视**视口高：键盘在场时布局视口（innerHeight）不缩，按它算上限会让
  // 浮卡比可见区还高、上下被键盘裁掉。visualViewport 是键盘几何唯一真源（同 engine/viewport.js）。
  function wkViewportH() {
    const vv = window.visualViewport
    return Math.round(vv && vv.height > 0 ? vv.height : window.innerHeight)
  }
  // 锚点 = 当前可见的下沉内容栏（文件 tab 的 #work-editor）→ 整个 #chat-area。预览列固定最右、
  // 不再作锚（浮卡不会压到它）；#work-editor 仅在文件 tab 正在显示时有宽（够宽才算「正在看的栏」）。
  function wkAssistAnchor() {
    const el = $('work-editor')
    if (el) {
      const r = el.getBoundingClientRect()
      if (r.width > 120) return r
    }
    return wkAssistBase()
  }
  function wkAssistW(a) {
    return Math.max(WK_ASSIST_MIN_W, Math.round(a.width - WK_ASSIST_PAD * 2))
  }
  function wkAssistH() {
    const max = Math.round(wkViewportH() * WK_ASSIST_MAX_VH)
    return Math.max(WK_ASSIST_MIN_H, Math.min(state.wkAssistH || 430, max))
  }
  function wkClearAssistBox() {
    for (const p of ['position', 'left', 'top', 'bottom', 'width', 'height']) sessionCard.style.removeProperty(p)
  }
  // 两态共用的横向公式：宽 = 锚栏宽 − 2×留白，左缘 = 锚栏左缘 + 剩余留白的一半（水平居中于锚栏）。
  // **一律写左缘、不写中线**：CSS 里没有 translateX(-50%) 之类的自居中，横向只有一个写口（本函数），
  // 中线公式 + CSS 自居中会在改宽度时双重位移（2026-09-27 实报「折叠形态定位有问题」的根因）。
  function wkPlaceAssistBox(a, w, base) {
    sessionCard.style.position = 'absolute'
    sessionCard.style.width = w + 'px'
    sessionCard.style.left = Math.round(a.left - base.left + (a.width - w) / 2) + 'px'
  }
  // 空态「底栏不压卡边界」的缺口（返 0 = 已达标或非空态）。不变量：空态底栏（#empty-hint #input-wrap，
  // 锚在立绘台上、中心锚——用户保护项，绝不可动）的底边距卡底边 ≥ WK_INPUT_BOT（与正常底栏 .docked
  // 在卡内的内缩同源，都是「底栏离卡底边 22px」）。台面在卡内垂直居中 ⇒ 卡高 h 时该底距 = h/2 − 常量
  // （常量 = 台面高×0.2675 + 底栏高/2，只由台面与底栏尺寸决定）：h = 430 时该值为负 ⇒ 底栏下沿被卡边界
  // 裁掉（2026-09-27 实报「低栏和卡片边界都挨上了」）。补法只能是**加高卡**（底栏与立绘同步上移，二者
  // 相对位置不变）：底距随卡高以 1/2 变化 ⇒ 加高量 = 2×缺口；卡底边锚在主区底部不动 ⇒ 卡向上长。
  function wkFloatEmptyDeficit() {
    const bar = document.querySelector('#empty-hint #input-wrap')
    if (!bar) return 0
    const br = bar.getBoundingClientRect()
    if (!br.width) return 0 // 门后 / 非空态：无盒，不参与
    return WK_INPUT_BOT - (sessionCard.getBoundingClientRect().bottom - br.bottom)
  }
  // 悬浮卡：定宽（锚栏宽 − 2×留白）、定高（state.wkAssistH，收在 70vh 内），水平居中于锚栏、贴主区底部。
  // 落位两拍：先按用户高放，量出空态缺口再补高（非空态缺口恒 0，只放一拍）——量算放在落位之后，是因为
  // 缺口只能从已落位的几何上量得。补高量不写回 state.wkAssistH（用户值不被改写；把手拖动的起点读的是
  // 实际渲染高，故拖一下即把当前高收进用户值，缺口随之归零，不来回弹）。
  function wkPlaceAssistFloat() {
    const base = wkAssistBase()
    const a = wkAssistAnchor()
    if (!base || !a) return
    wkPlaceAssistBox(a, wkAssistW(a), base)
    const put = (h) => {
      sessionCard.style.height = h + 'px'
      sessionCard.style.top = Math.round(base.height - h - WK_ASSIST_BOT) + 'px'
      sessionCard.style.removeProperty('bottom')
    }
    put(wkAssistH())
    const d = wkFloatEmptyDeficit()
    if (d > 0.5) {
      const max = Math.round(wkViewportH() * WK_ASSIST_MAX_VH)
      put(Math.min(wkAssistH() + 2 * d, Math.max(max, WK_ASSIST_MIN_H)))
    }
  }
  // 收敛输入栏：宽与左缘同浮卡，高度由 pill 内容给（清掉内联 height）。底距 = 浮卡底距 + 正常底栏
  // 在卡内的 22px 内缩 ⇒ pill 底边与 #input-wrap.docked 的底边齐平（都停在卡片底边上方 22px，
  // 2026-09-27 用户实报「两个底栏到卡片下边界的距离不一样」）。
  function wkPlaceAssistSlim() {
    const base = wkAssistBase()
    const a = wkAssistAnchor()
    if (!base || !a) return
    wkPlaceAssistBox(a, wkAssistW(a), base)
    sessionCard.style.bottom = WK_ASSIST_BOT + WK_INPUT_BOT + 'px'
    sessionCard.style.removeProperty('height')
    sessionCard.style.removeProperty('top')
  }
  // 三态唯一写口：形态类 + 几何一把落。side（或非 work / 助手关着）清掉全部内联几何，回到 CSS 的普通栏。
  function applyAssistMode() {
    const on = state.sbMode === 'work' && !!state.wkAssist
    const m = wkAssistMode()
    sessionCard.classList.toggle('wk-assist-float', on && m === 'float')
    sessionCard.classList.toggle('wk-assist-slim', on && m === 'slim')
    if (!on || m === 'side') {
      wkClearAssistBox()
      return
    }
    if (m === 'float') wkPlaceAssistFloat()
    else wkPlaceAssistSlim()
  }
  // 重锚：主区尺寸 / 栏宽 / 显隐变化时（分界条拖拽、侧栏开合、窗口缩放、开关栏）由 ResizeObserver 触发。
  function wkReflowAssist() {
    if (state.sbMode !== 'work' || !state.wkAssist || wkAssistMode() === 'side') return
    applyAssistMode()
  }
  // 形态切换入口（头部工具条 / 收敛输入栏的 pill 都走这里）。切形态 = 明确要用助手：顺手把它打开
  // （关着的卡切形态无意义，用户看不到任何反馈）。
  function setAssistMode(m) {
    state.wkAssistMode = m === 'float' || m === 'slim' ? m : 'side'
    state.wkAssist = true
    applyPanes()
    saveWork()
  }

  // 悬浮卡加高把手：只调高（宽由锚栏给定），触屏必须能用 → pointer events + setPointerCapture。
  // 收尾三规矩照抄 Pj18（都是真踩过的坑）：① 只认主键且位移 >3px 才算拖；② 收尾看 ev.buttons 而不只等
  // pointerup（up 若落在内嵌内容/窗口外，状态会永久卡死，之后指针一动高度就跟着走）；③ 拖拽期给 body 挂
  // wk-assist-dragging，关掉内嵌内容的 pointer-events（拖过 #work-preview 的 iframe 时事件仍全归把手）。
  function bindAssistGrip() {
    const g = $('wk-assist-grip')
    if (!g) return
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      const base = wkAssistBase()
      if (!base) return
      const y0 = e.clientY
      const startH = sessionCard.getBoundingClientRect().height || state.wkAssistH || 430
      let dragging = false
      g.setPointerCapture(e.pointerId)
      e.preventDefault()
      const end = () => {
        g.removeEventListener('pointermove', move)
        g.removeEventListener('pointerup', end)
        g.removeEventListener('pointercancel', end)
        if (!dragging) return
        document.body.classList.remove('wk-assist-dragging')
        saveWork()
      }
      const move = (ev) => {
        if (!ev.buttons) { end(); return } // ② 主键已松（up 落在内嵌内容/窗口外也走这里收尾）
        if (!dragging) {
          if (Math.abs(ev.clientY - y0) <= WK_DRAG_SLOP) return // ① 位移太小不算拖
          dragging = true
          document.body.classList.add('wk-assist-dragging') // ③ 拖拽期关掉内嵌内容 pointer-events
        }
        const max = Math.round(wkViewportH() * WK_ASSIST_MAX_VH)
        state.wkAssistH = Math.round(Math.max(WK_ASSIST_MIN_H, Math.min(max, startH + (ev.clientY - y0))))
        wkPlaceAssistFloat()
      }
      g.addEventListener('pointermove', move)
      g.addEventListener('pointerup', end)
      g.addEventListener('pointercancel', end)
    })
  }
