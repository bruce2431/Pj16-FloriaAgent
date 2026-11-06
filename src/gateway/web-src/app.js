/* floria — 会话查看器前端（ChatGPT 风格）
   hash 路由约定：
     #/          → 主界面（空态，输入栏居中）
     #/<会话哈希> → 会话转录（输入栏 docked 底部）
   「会话哈希」= 转录文件名去掉 .jsonl（Claude Code 会话 UUID）。
   数据来自后端：/gateway/sessions 列表、/gateway/session?id= 单会话。
   只读查看：composer 不可发送。 */
// —— 2026-09-10 模块化切割入口（事件绑定 + 启动序列；其余逻辑在 core/sidebar/inputbar/chat 各模块）——
import { route, navigate, renderSession, bootHash } from './chat/route.js'
import { stage, stageStart, stageSync } from './chat/stage.js'
import { hideGate, setAuthPorts } from './engine/auth.js'
import { setChar } from './core/char.js'
import { GATEWAY, HOT_RELOAD, initGateway, detectGateway, setGatewayPorts } from './engine/gateway.js'
import { I } from './core/icons.js'
import { initLive, setLiveEffortHook, setLiveModelHook, setLivePorts } from './engine/live.js'
import { applySessionEffort, applySessionModel } from './inputbar/model-select.js'
import { bootRegistry, isCardAllowedInContext } from './engine/registry.js'
import { loadSessions } from './engine/sessions.js'
import { inputEl, overlay, sInput, sidebar, state } from './engine/state.js'
import { isMobile } from './core/util.js'
import { initCodeBlock } from './core/markdown.js'
import { saveMgrView } from './core/storage.js'
import { initViewport, setViewportAdapter } from './engine/viewport.js'
import { gwSend, syncGwSend } from './inputbar/send.js'
import { openSearch, renderSearch } from './sidebar/bubble-search.js'
import { renderProject } from './sidebar/mgr.js'
import { setPanel, newWebSession, renderRecent, getFirstSendHash, setFirstSendHash } from './sidebar/recent.js'
import { initWork, setSbMode, ensureWork } from './sidebar/work.js'
import { loadMgrData, loadModelsData } from './sidebar/mgr-data.js'
import { closeMentionPop, onInputChange } from './inputbar/mention.js'
// 分层治理 4C/4D（2026-10-10）：engine/{live,gateway,auth}.js 的 feature 端口实参——入口（layer 4）统一接线。
import { absorbPending, fmtDur, getCharNote, getLastSegInfo, getPendingUserMsgs, isEndStop, isRealUser, messagesHtml, queueClaimAdopt, setPendingUserMsgs, stampMsgIn, statusFlags } from './chat/messages.js'
import { claimStartTs, clearTakeover, getTakeover, renderSettle, renderTaskDock, renderTransient, syncTurnLive, addSystem, getApprovalPending, renderApproval, setApprovalPending, showApprovalError, sendSubscribe } from './inputbar/approval.js'
import { renderCtxMeter } from './inputbar/ctx-meter.js'

/* @module __app__ */
  // ---------- 事件绑定 ----------
  // 侧栏开合（2026-09-25 定案：折叠态宽度归 0，64px rail 折叠带撤除；2026-10-14 待办#19 定案：
  // **左缘悬停唤出整条触发链移除**——work 编辑时误触屏幕边界即弹侧栏打断操作，干扰大于收益；
  // 只保留手动口：#menu-btn 汉堡（左上角，全视口共用一枚）点击 = 打开并钉住（钉住后鼠标移出侧栏
  // 不自动收）、#panel-collapse 收起钮、#scrim 遮罩（移动端抽屉）。收的判定在 sidebar/recent.js 的
  // #sidebar mouseleave（仅对未钉住的展开态生效）。
  // 2026-10-14 待办 5：汉堡两模式同语义 = 打开并钉住侧栏（work 的视图浮层已退役）；work 侧栏的
  // 收起走侧栏头部 #wk-view（work-mount.js）。面板随模式互斥显隐（#panel.work 钩子）不受影响。
  $('menu-btn').addEventListener('click', () => {
    setPanel(true, { pin: true })
  })
  $('scrim').addEventListener('click', () => setPanel(false))
  $('panel-collapse').innerHTML = I.collapse
  $('panel-collapse').addEventListener('click', () => setPanel(false))
  $('panel-search').innerHTML = I.mag
  $('panel-search').addEventListener('click', openSearch)
  // 主题切换（2026-10-06 夜晚模式）：<html> 的 data-theme 首帧由 index.html 预置脚本落地（免闪帧），
  // 此处只管交互——按当前态注入日/月图标，点击翻转 + 写 localStorage['floria-theme']（覆盖系统的跟随）
  // + 同步 theme-color meta。真源 = <html data-theme>，localStorage 只作下次首帧的预置输入。
  const THEME_KEY = 'floria-theme'
  const themeDark = () => document.documentElement.getAttribute('data-theme') === 'dark'
  function paintTheme() {
    const dark = themeDark()
    const btn = $('panel-theme')
    btn.innerHTML = dark ? I.sun : I.moon
    btn.title = dark ? '切换到浅色' : '切换到夜晚模式'
    const m = document.querySelector('meta[name="theme-color"]')
    if (m) m.setAttribute('content', dark ? '#141414' : '#ececf1')
  }
  $('panel-theme').addEventListener('click', () => {
    const dark = !themeDark()
    if (dark) document.documentElement.setAttribute('data-theme', 'dark')
    else document.documentElement.removeAttribute('data-theme')
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light') } catch { /* 存储不可用忽略 */ }
    paintTheme()
  })
  paintTheme()
  // 侧栏模式切换（2026-09-25）：floria·chat ⇄ floria·work。委托在容器上——两个 .ms-btn 常驻不重渲，
  // 但委托写法与其它侧栏控件一致，且 setSbMode 已内部落地全部渲染（applySbMode）。
  $('mode-switch').addEventListener('click', (e) => {
    const b = e.target.closest('.ms-btn')
    if (b && b.dataset.sbmode !== state.sbMode) setSbMode(b.dataset.sbmode)
  })
  $('recent-write').innerHTML = I.pen
  $('recent-write').addEventListener('click', () => { state.newProject = null; navigate('#/'); if (isMobile()) setPanel(false) })
  // 2026-08-24 定案：开启新会话只用「笔」图标（recent-write → 回首页空态），
  // 首条消息触发创建（gwSend 空态分支调 newWebSession）；不再有独立的「新建独立会话」按钮。
  $('recent-more').addEventListener('click', (e) => { e.stopPropagation(); $('organize-pop').classList.toggle('show') })

  // 项目/聊天 tab
  document.querySelectorAll('.mtab').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.mtab').forEach((x) => x.classList.toggle('on', x === b))
      state.pt = b.dataset.pt
      renderProject()
    }),
  )

  // 管理入口 tab（插件，含技能预览）：点击 → 主区切换管理视图（侧栏会话列表不变）；再点已选中 tab → 退出管理。
  // 委托绑在容器上（非逐钮）：卡片化二期起 renderMgrTabs 会在运行期重渲（外部卡注册/清空），
  // 逐钮绑定会被 innerHTML 一并抹掉。
  $('mgr-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.mgr-tab')
    if (!b) return
    const k = b.dataset.mgr
    // 注册域门（2026-10-15 Step2）：路由门在 route() 的 mgr 分支，此处挡在导航前——重渲前的残留
    // 按钮（语境已变：离开预览/换项目/停用应用）点了也不得切进域外卡（同一判据，不另立一套）。
    if (!isCardAllowedInContext(k, state)) return
    // 管理视图进/出走 hash 路由（#mgr/<kind> / #/）：刷新后可恢复当前管理视图
    if (state.mgr === k) navigate('#/')
    else { saveMgrView(); navigate('#mgr/' + k) }
  })

  // 整理会话弹层
  document.querySelectorAll('.org-opt').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.org-opt').forEach((x) => x.classList.toggle('on', x === b))
      state.mode = b.dataset.mode
      syncModeUI()
      $('organize-pop').classList.remove('show')
    }),
  )
  function syncModeUI() {
    document.querySelectorAll('.org-opt').forEach((x) => x.classList.toggle('on', x.dataset.mode === state.mode))
    renderRecent()
  }

  // 搜索
  $('s-mag').innerHTML = I.mag
  sInput.addEventListener('input', renderSearch)
  $('search-close').addEventListener('click', () => overlay.classList.remove('show'))
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('show') })


/* @module __app__ #2 */
  // ---------- 启动 ----------
  ;(async () => {
    await detectGateway()
    await loadSessions()
    initCodeBlock() // 代码块软换行偏好（localStorage）——须在首次 mdHtml 渲染之前
    initLive()
    // 依赖接线（分层治理：engine 不静态 import feature，由入口注入实现）。本段与 initLive 同一同步块，
    // SSE 回调要等本轮执行完才可能投递 → port 注入对首个事件必已就位（4C 起 engine/live.js 的渲染出口/
    // 暂态/stage/可变状态全部经端口读取）。
    setLivePorts({
      // chat/messages.js 读基元 + 可变渲染态读取口（getter 现读，勿缓存）
      msg: { isRealUser, isEndStop, fmtDur, stampMsgIn, messagesHtml, absorbPending, queueClaimAdopt, statusFlags, getLastSegInfo, getCharNote },
      // 渲染/暂态/导航出口（feature 层实现）
      ui: { renderTransient, renderSettle, renderRecent, renderTaskDock, renderCtxMeter, claimStartTs, syncTurnLive, syncGwSend, navigate },
      // 两层消息流 stage（stage 为稳定 const 对象；stageStart 为函数）
      stage: { stage, stageStart },
      // 可变状态读写口（takeover / firstSendHash / pendingUserMsgs；getter 现读，勿缓存）
      state: { getTakeover, clearTakeover, getFirstSendHash, setFirstSendHash, getPendingUserMsgs, setPendingUserMsgs },
    })
    // 依赖接线 4D（2026-10-10）：engine/gateway.js（审批态读写 + 发送态同步 + @ 提及输入回调）与
    // engine/auth.js（解锁后界面重渲 + 数据补拉 + 发送态同步）的 feature 端口——与 4C 同点接线；
    // 早于下方 initGateway()（其 connect→WS onopen/hideGate 经端口回写）。
    setGatewayPorts({
      approval: { addSystem, clearTakeover, renderApproval, showApprovalError, sendSubscribe, getTakeover, getApprovalPending, setApprovalPending },
      send: { syncGwSend },
      mention: { onInputChange },
    })
    setAuthPorts({
      ui: { route, closeMentionPop, renderRecent },
      data: { loadMgrData, loadModelsData, ensureWork },
      send: { syncGwSend },
    })
    setViewportAdapter({ syncStage: stageSync }) // 键盘适配：可视区变矮后重算两层消息流占位/跟随
    setLiveModelHook(applySessionModel) // 实时同步：CLI 上报模型 → 校准输入栏模型 seat
    setLiveEffortHook(applySessionEffort) // 2026-11-06 思考等级同链：实时刷新回程校准本会话档位
    initViewport() // 键盘弹出适配（visualViewport）：只压缩消息流底界与底栏
    setPanel(false)
    setChar(1) // 启动默认形象
    // 2026-08-30 改定案（用户）：刷新保留当前界面——/session/<hash> 直进恢复，boot 不再把会话路径
    // 重置回首页（2026-08-28「进入/刷新一律默认初始界面」旧定案作废）。刷新瞬间列表未就绪由
    // renderSession 占位「加载中」，WS 验证通过 → hideGate 的 loadSessions().then 恢复链落地重渲。
    renderRecent()
    // work 模式启动恢复（2026-09-25）：恢复持久化模式/项目/文件 → 绑事件 → 落地；须在 route() 之前，
    // route 进入 mgr/preview 时会把模式强制切回 chat（视图卡与 work 两栏互斥，见 chat/route.js）。
    // 2026-10-06 根修「work 刷新多出一枚新会话胶囊」：先把真实路由 hash 落地，否则 initWork→applyPanes
    // 的开放集兜底（wkEnsureTab(wkActiveKey())）会读到尚未赋值的 currentHash('') ⇒ 当哨兵 'new' 塞一枚。
    state.currentHash = bootHash()
    // 卡注册表引导：各卡模块已在模块求值期 registerCard 入表，此处显式渲一次侧栏 tab
    // （registry 不再在自身顶层渲染，避免模块求值期副作用；须在 initWork/route 之前就位）。
    bootRegistry()
    initWork()
    route()
    if (GATEWAY) initGateway()
    else { composerSetEditable(false); composerPlaceholder('只读查看 · 无法发送') } // 只读查看器：输入不可编辑
    if (HOT_RELOAD) {
      // 开发审阅热重载：server.mjs HOT_RELOAD=1 时，public/ 文件变化经 SSE 通知 → 自动刷新
      const hr = new EventSource('/gateway/hotreload')
      hr.onmessage = (e) => { if (e.data === 'reload') location.reload() }
    }
  })()