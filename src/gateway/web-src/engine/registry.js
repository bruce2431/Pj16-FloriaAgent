// 视图注册表 + 槽位整卡切换（第一方契约层，2026-10-10 自 views/registry.js 下移为 engine/；同日 Phase 5
// 再拆出 engine/ext-runtime.js——外部卡运行时 EXT/APP_TABS/QACTIONS/申报缓存/应用目录全归该件）
// （2026-09-23 视图卡化；2026-10-01 卡片化二期：一模块一卡组件 + 单通道；唯一手改处，web/app.js 为生成物）
// 单一真源：每个卡组件（views/cards/<name>/<name>-card.js）在**自身模块顶层**调 registerCard(def) 入表
// （描述符 { id, title, tip, icon, tab, mount }），本表只做「按 id 取卡 → 挂进槽 → 调 mount」的编排，
// 不写任何卡内容，也不 import 任何卡实现（engine 永不 import views）。
// 消费三处——①侧栏 tab 生成（renderMgrTabs）②路由 #mgr/<id>（parseRoute 的 r.mgr 即 id）③卡体渲染
// （openCard 把卡体交给卡自己的 mount）。
// 三张表：第一方 CARDS（本件）+ 运行时 EXT / 应用 APP_TABS（engine/ext-runtime.js，经 extTabs()/appTabs()
// 只读取用）合流于 cardOf / renderMgrTabs 两个查询点。外部卡只有宿主生成的 iframe 壳（无 mount 代码），
// 壳渲染经 setExtCardRenderer 注入（实现留 views/cards/ext/ext-card.js），外部永不获得在宿主 DOM 执行
// 的能力（SPEC-视图卡化 §7 边界）。外部申报的取回/校验/缓存全部归 ext-runtime，本件不认识 preview.json。

import { I } from '../core/icons.js'
import { chatArea, sessionCard, state } from './state.js'
import { esc } from '../core/util.js'
import { appTabs, extLabel, extTabs, isGlobalLabel, setTabRefresh } from './ext-runtime.js'
/* @module engine/registry.js */

  // ---------- 第一方卡片注册表 ----------
  // 卡描述符由各卡模块顶层 registerCard 自注册（一模块一卡）；「项目 / 模型 / 神经元」三卡自 2026-10-10
  // 起不再是第一方卡——改由工作区根以应用形式申报、用户在插件卡「应用」列表里手动启用（APP_TABS 见
  // engine/ext-runtime.js），侧栏 tab 因此是 CARDS / APP_TABS / EXT 之和。
  let CARDS = []
  function registerCard(def) { if (def && def.id) CARDS.push(def) }
  // 契约出口：卡外的局部重渲（如 mgr-data 拉完清单刷插件卡网格）不必懂该卡实现，只报 id。
  function refreshCard(id) { cardOf(id)?.refresh?.() }

  // ---------- 注册域：卡片归属语境（2026-10-15 注册域隔离 Step2）----------
  // 「这张卡在不在域内」的**唯一判据**，四个入口共用（缺一即漏；回归：只滤 tab 而让隐藏卡仍可由路由
  // 或卡 id 切进主区）：renderMgrTabs 取集 / cardOf 解析（openCard「唯一切卡口」据此拒绝隐藏卡）/
  // route 的 mgr 分支 + mgr-tabs 点击委托（按**入站**语境快照判，见 chat/route.js）。
  // 域 = 卡的归属：CARDS（第一方 plugins/preview/session）恒在域内（工具栏卡，与语境无关）；
  //   app:<id>          工作区根应用 → chat 模式恒在域内（工作区根 = chat 前端宿主；项目预览不改变这
  //                     一归属），work 模式仅认「该卡自身正在槽内」。2026-10-17 待办 3：旧判据只认
  //                     isGlobalLabel(state.preview)，而 chat 常态 state.preview 为空 ⇒ 应用 tab 全被滤掉；
  //   ext:<label>:<id>  项目外部卡   → 仅语境 = 该 label，且 EXT 运行表当前正属该 label。
  // 语境（唯一状态源）：work 看工作项目 label、chat 看预览路由 label；**已开着的 app/ext 卡自身即其
  // 语境**——st.mgr 命名空间占先，故 renderMgr 清掉 state.preview 后 openCard 仍认得自己（点击 tab 后
  // preview 已清，靠 mgr id 认领）。「应用已启用」由 appTabs() 自身过滤（ext-runtime.applyAppTabs）。
  // #mgr-tabs 是 chat 侧栏（#chat-panel 内）那一行——work 模式下整块 hidden 不可见，故 work 语境
  // （state.workProj）只影响「预览/工作项目」这条口径，不另立一套判据。
  function isCardAllowedInContext(id, st) {
    if (typeof id !== 'string' || !id) return false
    if (CARDS.some((c) => c.id === id)) return true
    const m = typeof st.mgr === 'string' ? st.mgr : ''
    const raw = (st.sbMode === 'work' ? st.workProj : st.preview) || ''
    if (id.startsWith('app:')) return st.sbMode !== 'work' || m.startsWith('app:') || isGlobalLabel(raw)
    if (id.startsWith('ext:')) {
      const label = id.slice(4, id.lastIndexOf(':'))
      if (!label || extLabel() !== label) return false
      return m.startsWith('ext:' + label + ':') || raw === label
    }
    return false
  }
  // 按 id 取卡：**域内才可解析**——隐藏卡一律查无此卡，于是 refreshCard / deactivateCard / openCard
  // 三个消费点同受此门。**例外 = 当前槽内那张卡**：openCard 切异卡时须能解析离场卡以调其 deactivate，
  // 而此刻 state.mgr 可能已指向新卡、语境不再匹配，但它在场 ⇒ 必须认。
  const cardOf = (id) => (isCardAllowedInContext(id, state) || currentCardId() === id
    ? CARDS.find((c) => c.id === id) || appTabs().find((c) => c.id === id) || extTabs().find((c) => c.id === id)
    : undefined)

  // 侧栏 tab 生成。契约 = <button class="mgr-tab" data-mgr="<id>">，两处消费点据此零改动：
  // app.js 的点击**委托**在 #mgr-tabs 容器上（本函数重渲不清事件）、route.js syncMgrTabs 按 state.mgr 切 .on。
  // 取集 = 三表合流后**过同一个域判据**（显示与可切入必须同一条：显示过而切入不过 = 串域）。
  // 表变更后的重渲由 ext-runtime 经 setTabRefresh 回调本函数（见文件末的模块体注入）；**语境变更**由
  // 变更点显式调用本函数（applySbMode 的模式切换 / route 末尾 / 切项目），硬性不变量：不得由卡片注册
  // 或应用目录同步直接触发全局重渲，一律经本函数按当前语境取集。
  // mgrTabsHtml 缓存：算出的 HTML 无变化则零写 DOM——冗余调用（路由/5s 对账）不清掉 .on 高亮与焦点。
  let mgrTabsHtml = ''
  function renderMgrTabs() {
    // 目录/默认项变化点顺带对齐常驻预热（幂等：已预载的跳过；停用或换项目的立即拆除）
    preloadEnabledCards()
    const box = $('mgr-tabs')
    if (!box) return
    const html = CARDS.concat(appTabs(), extTabs())
      .filter((v) => v.tab && isCardAllowedInContext(v.id, state))
      .map((v) => `<button class="mgr-tab" data-mgr="${v.id}" title="${esc(v.tip)}">${I[v.icon]}<span>${v.title}</span></button>`)
      .join('')
    if (html === mgrTabsHtml) return
    mgrTabsHtml = html
    box.innerHTML = html
  }
  // 启动引导：由入口（app.js 启动段）显式调用——各卡模块顶层 registerCard 已完成后再渲 tab，
  // 避免模块求值期副作用（registry 须排在卡模块之前，故不能在自身顶层调 renderMgrTabs）。
  function bootRegistry() { renderMgrTabs() }

  // ---------- 槽位（#chat-area = 无形槽）：同一时刻恰好一张卡 ----------
  // 管理/预览卡按需创建、离开即 .remove()——神经元图的 rAF 以 canvas.isConnected 自毁，
  // display:none 不释放；会话卡改 hidden（其 DOM 是单例，见上）。
  // 应用/外部卡例外：常驻预热（见下），离场只隐藏不拆除。
  let curCardEl = null
  function makeCard(id) {
    const el = document.createElement('section')
    el.className = 'view-card mgr'
    el.dataset.view = id
    el.innerHTML = '<div class="view-scroll"><div class="view-body"></div></div>'
    return el
  }
  function showCard(el) {
    if (el === curCardEl) return el
    if (curCardEl && curCardEl !== sessionCard) {
      // 预载卡离场不拆除：留着 iframe 现状，再切回来零白屏
      if (standby.has(curCardEl.dataset.view)) curCardEl.classList.add('view-standby')
      else curCardEl.remove()
    }
    curCardEl = el
    el.classList.remove('view-standby')
    el.hidden = false
    sessionCard.hidden = el !== sessionCard
    if (el !== sessionCard && !el.isConnected) chatArea.appendChild(el)
    return el
  }

  // ---------- 常驻预热（应用 / 外部卡） ----------
  // 启用即预载：给每张已启用的 APP/EXT 卡建一张常驻卡（绝对定位、透明、不可交互），iframe 在这里
  // 完成文档加载与首屏渲染；切换 = 同一张卡显隐，不重建 DOM ⇒ 不再有 iframe 白屏。
  // 代价：启用几张就后台常驻几个 iframe；停用/换项目时 pruneStandby 立即拆除。
  const standby = new Map()
  function preloadCard(id) {
    if (standby.has(id) || !(id.startsWith('app:') || id.startsWith('ext:'))) return
    if (curCardEl && curCardEl.dataset.view === id) return
    const c = cardOf(id)
    if (!c || !c.mount) return
    const el = makeCard(id)
    el.classList.add('view-standby')
    chatArea.appendChild(el)
    standby.set(id, el)
    c.mount(el.querySelector('.view-body'), { id: c.id, rerender: (p) => openCard(id, p) })
  }
  function pruneStandby() {
    const alive = new Set(appTabs().concat(extTabs()).map((v) => v.id))
    for (const [id, el] of standby) {
      if (alive.has(id) || curCardEl === el) continue
      el.remove()
      standby.delete(id)
    }
  }
  function preloadEnabledCards() {
    pruneStandby()
    for (const v of appTabs().concat(extTabs())) {
      if (!v.tab || !isCardAllowedInContext(v.id, state)) continue
      preloadCard(v.id)
    }
  }
  // 同 id 的卡在场则复用：卡体整换但 .view-scroll 不动 ⇒ 滚动位置天然保持
  // （旧版进管理视图手写 scrollTop 存取块因此退场）
  function reuseOrMake(id) {
    if (curCardEl && curCardEl !== sessionCard && curCardEl.dataset.view === id) return curCardEl
    return makeCard(id)
  }
  // 切卡唯一入口：查卡 → 换卡 → 交给卡自己的 mount 渲染。**域外 id 一律返回 null**（不回落任何视图，
  // 也不动槽内现卡——拒绝不该顺带拆掉当前视图）；未知 id 同此口。
  // 生命周期契约：切到**异**卡时先调离场卡的 deactivate()（同 id 复用/软重入不触发，避免整卡重渲
  // 误拆视图态）；会话卡的 deactivate=teardownSessionView（卸净会话态，见 session-card.js）。
  // mount 契约：mount(host, ctx)，host = 卡体元素(.view-body)，ctx = { id, payload, rerender }。
  // 卡内「整卡重渲」（插件卡切 kind/cat）走 ctx.rerender()，由本通道出，卡不反向依赖 registry。
  function openCard(id, payload) {
    if (!isCardAllowedInContext(id, state)) return null // 注册域门（与 cardOf 同判据）：隐藏卡不得由任何入口切入
    const c = cardOf(id)
    if (!c) return null
    const prev = currentCardId()
    if (prev && prev !== id) cardOf(prev)?.deactivate?.()
    const pre = standby.get(id)
    const el = showCard(pre || (c.card ? c.card() : reuseOrMake(c.id)))
    // 预载卡已 mount 过：直接显示现状，不再重建 iframe（重建即白屏）
    if (c.mount && !pre) c.mount(el.querySelector('.view-body'), { id: c.id, payload, rerender: (p) => openCard(id, p) })
    return el
  }
  // 契约出口：卡外（如 preview-frame 硬进入分支）可显式卸某卡视图态，不必懂该卡的清理清单。
  function deactivateCard(id) {
    cardOf(id)?.deactivate?.()
  }
  // 当前槽内卡的 id（'session' 表示会话卡在场；无卡返回 null）。work 模式切入时据此判定是否需先退卡。
  function currentCardId() {
    if (curCardEl === sessionCard) return 'session'
    return curCardEl ? curCardEl.dataset.view : null
  }
  // 异步回程渲染守卫：本视图的卡仍在槽里才交出卡体（否则返回 null，调用方不渲染）
  function viewBody(id) {
    if (!curCardEl || curCardEl.dataset.view !== id) return null
    return curCardEl.querySelector('.view-body')
  }

  // 表变更 → 重渲：把本件的渲染口交给 ext-runtime（它不自 import 本件，避免 engine 内成环）。
  // 注入后 EXT/APP_TABS 的任何变更（网关清单回程、postMessage 注册、启用开关）即时刷侧栏。
  setTabRefresh(renderMgrTabs)

export {
  bootRegistry,
  currentCardId,
  deactivateCard,
  isCardAllowedInContext,
  openCard,
  refreshCard,
  registerCard,
  renderMgrTabs,
  viewBody,
}
