// 布局落地：模式切换 applySbMode / 侧栏开关锚定 / 聊天 tab 开集与关合 / 主区三列不变量 applyPanes。（拆自 sidebar/work.js，纯搬迁零行为变更；符号经单 IIFE 共享作用域可见）
import { isTempProjLabel } from '../../core/util.js'
/* @module sidebar/work/work-layout.js */

  // 面板与主区布局按 state 落地。启动恢复与运行期切换共用这一条路径（无第二份初始化旁路）。
  function applySbMode() {
    const on = state.sbMode === 'work'
    // 进 work：槽里若停着非会话卡（管理/预览），先退卡回会话视图——work 助手栏就是 #session-card，
    // 残留的 .view-card 会把助手栏顶成旧卡（「在预览页切到 work，助手栏还是预览页」的根因）。
    // 退卡走 route('#/') 统一收口（顺带清管理/预览路由态、预览页注册件与后端保活心跳），不在此另起清点。
    if (on && currentCardId() && currentCardId() !== 'session') navigate('#/')
    document.querySelectorAll('.ms-btn').forEach((b) => b.classList.toggle('on', b.dataset.sbmode === state.sbMode))
    positionMsThumb() // 选中钮换位 → 空位滑到另一侧（方向性 transition 由本函数写内联）
    // #panel.work：work 模式下隐藏顶栏 #panel-search（会话搜索的 chat 模式入口）——work 的 🔍 已覆盖
    // 当前 tab 的过滤，两者同为放大镜同屏并存即「两个搜索」的重复观感（样式见 styles.css 该段）
    $('panel').classList.toggle('work', on)
    // 模式色钩子（2026-10-06）：#app.work 一处驱动全部随模式切换的颜色（--sunken-bg 等，见 styles.css #app 注释）
    $('app').classList.toggle('work', on)
    $('chat-panel').hidden = on
    $('work-panel').hidden = !on
    chatArea.classList.toggle('work', on)
    // 注册域随模式切换重算（2026-10-15）：外部卡（EXT）的语境口径含 work（看工作项目），模式一切换
    // 就必须重取 #mgr-tabs（应用 tab 的语境判据只看 chat 侧 state.preview/state.mgr，不受模式影响）。
    renderMgrTabs()
    applyPanes()
    enforceWorkScope() // 目标项目/只读标识随模式切换重算；开着别项目的会话时退回工作项目的新对话
    if (on) {
      applySidebarPin() // 进 work：侧栏开合按工作项目槽里的开关恢复（桌面）
      ensureWork()
      startWorkAuto()
      startWorkLive() // 编辑卡外部改动实时同步（0.5s HEAD）；与侧栏自动对账同一对启停点
    } else {
      if (wkEdDirty) wkEdFlush() // 退 work 模式：pending 编辑先落盘（不阻塞模式切换）
      hideWkPops()
      stopWorkAuto()
      stopWorkLive()
    }
  }

  // 浮层两开关的真源：预览 = 第三列（个性化工作区），侧边栏 = 侧栏是否**被主动打开**
  // （state.panelPinned，见 recent.js setPanel）。不用 state.panelOpen——后者含左缘悬停预览式唤出，
  // 那种瞬时露出不是「界面常在」，开关不该跟亮。
  function paneOn(k) {
    if (k === 'workspace') return state.wkPreview
    return !!state.panelPinned
  }

  // （2026-10-14 待办 5：视图浮层退役，原 syncPaneRows 行状态链随之删除——侧栏开关回归汉堡/收起钮直管）

  // 侧边栏开关的落地入口：真源始终是 state.panelPinned，而「让侧栏开合」的唯一口是 recent.js 的 setPanel
  // ——本函数只把它按项目槽里的值调一次（loadWorkSlot 已把槽写进 state）。移动端侧栏是全屏抽屉，恢复
  // 打开态会盖住主区，故不恢复（槽里的值照常存，切回桌面端仍按它开合）。
  function applySidebarPin() {
    if (isMobile()) return
    if (state.panelPinned) return setPanel(true, { pin: true })
    // 待办#4（2026-10-14）：模式切换（chat⇄work）/ work 下切项目都走本函数落地侧栏开合；若此刻
    // 鼠标正悬在侧栏区域内（用户刚在侧栏里点了模式钮/项目行），不因槽里的开关值收起——以
    // :hover 几何判定为准保持展开（悬停预览态，不置 pin），移出仍由 recent.js 的 #sidebar
    // mouseleave 收。判定用 matches(':hover') 而非事件标志：零状态、无漂移，切换瞬间即准。
    if ($('sidebar').matches(':hover')) return setPanel(true)
    setPanel(false)
  }

  // 下沉区当前显示的内容（唯一判定）：助手靠栏时按 wkMainTab（要看文件且确有文件才给 file，
  // 否则回 chat）；助手脱流（float/slim）时它不在下沉格里 ⇒ 有文件顶上来、没有就空。'' = 下沉格空。
  function wkShownTab() {
    if (wkAssistInFlow()) return state.wkMainTab === 'file' && state.workFile ? 'file' : 'chat'
    return state.workFile ? 'file' : ''
  }

  // 打开的聊天 tab 开放集（浏览器 tab 模型）：真源 = state.wkChats。**持久化、按项目重置**
  // （2026-10-13 用户待办 11 推翻 2026-10-07 的不持久化定案；切项目清空的防线不变，见 selectProject）。
  // 条目 = 会话 hash（**不含** WK_NEW_TAB：空态不占胶囊）。激活键 = 当前路由（currentHash；空 = 首页 ⇒ 'new'）。
  // 增/删/渲染的唯一口都在本模块。
  const wkActiveKey = () => state.currentHash || WK_NEW_TAB
  const wkKeyHash = (key) => (key === WK_NEW_TAB ? '' : key)
  const wkTabName = (key) => {
    if (key === WK_NEW_TAB) return '新对话'
    const s = findSession(key)
    return (s && s.title) || '未命名会话'
  }
  // 并入守卫（2026-10-14 待办 14）：开放集不变量 = 只含当前工作项目的会话（或 new 哨兵）。
  // route.js 在 renderSession 的 enforceWorkScope 弹回**之前**就调 syncWorkTabs 并入外项目 hash，
  // 不守此口则外项目/全局会话胶囊先入集并被持久化（弹回也残留，顶栏串入他项目会话）。
  // workScopeOk 查无此会话（列表未拉/刷新窗口）不判——「未知」≠「别的项目」，与 enforceWorkScope 同判据。
  function wkEnsureTab(key) {
    if (key !== WK_NEW_TAB && !workScopeOk(key)) return
    if (!state.wkChats.includes(key)) state.wkChats.push(key)
  }
  // 打开的**文件** tab 开放集（与聊天胶囊同构，2026-10-12）：真源 state.wkFiles（项目内相对路径），
  // 激活项 = 单值 state.workFile。并入唯一口在此（applyPanes 按当前 workFile 兜底 ⇒ 刷新恢复的
  // workFile 也有一枚 pill）；移除/切换在 work-editor.js closeWkFile（要 flush 编辑器，故不在此）。
  // 开放集的落盘统一收口在 applyPanes 末尾的 saveWork（2026-10-13 待办 11）。
  function wkEnsureFileTab(p) { if (p && !state.wkFiles.includes(p)) state.wkFiles.push(p) }
  // 关一枚 tab（× 只从顶栏移除，不删会话）。激活项被关 → 切右邻 / 左邻；一枚不剩且文件 tab 与预览
  // 都不在场 → 保底重开空对话 tab（守「聊天 / 文件 / 预览至少一栏在场」不变量）。
  function wkCloseTab(key) {
    const i = state.wkChats.indexOf(key)
    if (i < 0) return
    const active = wkActiveKey() === key
    state.wkChats.splice(i, 1)
    if (!active) { applyPanes(); saveWork(); return }
    const next = state.wkChats[i] != null ? state.wkChats[i] : state.wkChats[i - 1]
    if (next != null) {
      navigate(next === WK_NEW_TAB ? '#/' : '#/' + encodeURIComponent(next))
      applyPanes(); saveWork(); return
    }
    state.wkAssist = false // 聊天 tab 全关：收起聊天栏（文件 / 预览还在即可）
    if (state.sbMode === 'work' && !state.workFile && !state.wkPreview) {
      state.wkAssist = true
      navigate('#/') // 全无 → 回空态首页（助手栏在场即满足「至少一栏」）；**不**再造 new 胶囊——胶囊只由主动新建入集
    }
    applyPanes(); saveWork()
  }
  // 路由落地后并入开放集并重渲顶栏（唯一外部入口，chat/route.js 调）：仅 work + 聊天栏在场时插手。
  // 开放集不变量（2026-10-17 待办 2）：**恒不含 new 哨兵**——空对话（含「+」新建）不占顶栏胶囊，
  // new 只是激活键（currentHash===''）。历史上 new 曾被入集并持久化，故此处与「外项目污染」同点清剿。
  function syncWorkTabs() {
    const key = wkActiveKey()
    if (state.sbMode !== 'work' || !state.wkAssist) return
    // 自愈清剿（2026-10-14 待办 14 / 2026-10-17 待办 2）：①历史污染的外项目条目（旧版无并入守卫时
    // 入集并被持久化）在已知归属时一律移除；②new 哨兵条目（旧版 newWorkChat 主动入集并持久化）一并移除。
    // 查无此会话（未知）不判。
    for (let i = state.wkChats.length - 1; i >= 0; i--) {
      const k = state.wkChats[i]
      if (k === WK_NEW_TAB || (findSession(k) && !workScopeOk(k))) state.wkChats.splice(i, 1)
    }
    // 只并入**真实会话**：空路由（key === WK_NEW_TAB，即 currentHash===''）不并入；空态 = 无活动胶囊。
    if (key !== WK_NEW_TAB) wkEnsureTab(key)
    renderTopbar()
    // 2026-10-06 根修「work 侧栏选中灰底更新慢」：可见的会话列表在 #wk-body（renderWorkBody 渲），
    // 不在 route()/SSE 的重渲出口里（refreshList 只渲 #recent-body）。路由落地若不重渲它，行上的
    // .on（按 currentHash 判，见 recent.js itemHtml）要等 workAutoTick 的 5s 对账才同步 → 切会话后
    // 选中灰底滞后 1~2s 才跟手。此处随路由同步重渲一次：renderWorkBody 内有 innerHTML 比对，
    // 未变零写 DOM，故代价可忽略，且保证 .on 与 currentHash 恒同拍。
    renderWorkBody()
  }

  // 布局落地（不变量判定唯一处 + 各布局类的唯一写口）：聊天 tab / 文件 tab / 预览至少一个在场，
  // 全无 → 强制开助手（聊天 tab，唯一还能承载内容的常驻件）。判定仍是这一处。
  function applyPanes() {
    // 编辑区滚动记忆（见 work-editor.js wkEdCaptureScroll）：必须在写 .wk-show-file 类**之前**取位置，
    // 类一落地 #work-editor 就 display:none、scrollTop 立刻被夹回 0。
    const wasFile = chatArea.classList.contains('wk-show-file')
    const willFile = state.sbMode === 'work' && wkShownTab() === 'file'
    if (wasFile && !willFile) wkEdCaptureScroll()
    if (state.sbMode === 'work') {
      // 临时项目（根级时间戳任务区）不提供右栏：工具栏胶囊不渲染 ⇒ 用户无关闭入口，栏若因槽恢复或
      // 切项目留在场就是悬空态。归一只在这一处（布局落地 = 唯一写口），状态直接写、不再嵌套 applyPanes。
      if (isTempProjLabel(state.workProj) && state.wkPreview) {
        state.wkPreview = false
        state.wkPvTab = ''
      }
      if (!state.wkAssist && !state.workFile && !state.wkPreview) {
        state.wkAssist = true
        state.wkMainTab = 'chat'
        toast('至少保留一栏')
      }
      // 并入当前**真实会话**（仅当聊天 tab 正被显示、且路由停在具体会话上）。空路由不并入 new：
      // 空态 = 无活动胶囊（新建会话同样不占胶囊，2026-10-17 待办 2）。文件 tab 在场时不并入。
      const k = wkActiveKey()
      if (state.wkAssist && wkShownTab() === 'chat' && k !== WK_NEW_TAB) wkEnsureTab(k)
      wkEnsureFileTab(state.workFile) // 打开着的文件 ⇒ 顶栏必有一枚对应 pill（刷新恢复的 workFile 也在此并入）
      const shown = wkShownTab()
      chatArea.classList.toggle('wk-show-chat', shown === 'chat')
      chatArea.classList.toggle('wk-show-file', shown === 'file')
      chatArea.classList.toggle('wk-preview', !!state.wkPreview)
    } else {
      chatArea.classList.remove('wk-show-chat', 'wk-show-file', 'wk-preview')
    }
    // 文件栏从无到有 → 编辑器重新参与布局，把切走前的滚动位置写回去（同文件才恢复）。
    if (!wasFile && chatArea.classList.contains('wk-show-file')) wkEdRestoreScroll()
    applyWorkCols()
    renderTopbar()
    applyPvTab()
    saveWork() // 布局落地即持久化（2026-10-13 待办 11）：顶栏开放集（wkChats/wkFiles）的入列/移除
    // 路径分散在 ensure 兜底、syncWorkTabs、closeWkFile（关非激活）等处，并非每处都 saveWork——
    // 统一收口在布局落地这一条链上，凡可见状态变化必已过 applyPanes ⇒ 凡变化必落盘。saveWork
    // 只 patch localStorage、不回头调 applyPanes，无环。
  }
