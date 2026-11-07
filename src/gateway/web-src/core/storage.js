// 界面状态持久化（localStorage 打补丁读写 + mgrView / work 两族恢复）（2026-10-07 自 engine/state.js 拆出；唯一手改处，web/app.js 为生成物）

import { state } from './ui-state.js'
/* @module core/storage.js */
  // 界面状态持久化（2026-08-16）：管理视图内部状态（mgrView：插件/技能切换、公开/个人、搜索词）
  // 存 localStorage，刷新后由 route 的 mgr 分支 loadMgrView 恢复——配合 hash 路由 #mgr/<kind>/#preview/<label>
  // 实现「刷新保持当前界面」（会话/管理/预览三态均可恢复，不再回退初始界面）。
  const UI_KEY = 'floria-ui-v1'
  // 写入 = read-modify-write 打补丁：mgrView 与 work 两族状态共用同一 key，
  // 直接 setItem(整份) 会让后写者抹掉先写者（两族各自保存时都会发生）。
  function patchUI(patch) {
    try {
      const raw = localStorage.getItem(UI_KEY)
      const cur = raw ? JSON.parse(raw) : {}
      localStorage.setItem(UI_KEY, JSON.stringify({ ...cur, ...patch }))
    } catch { /* 存储不可用忽略 */ }
  }
  // 只读整份（不自带段语义）：分表存同一 key 的调用方（外部卡申报缓存）自己取段。写口恒为 patchUI。
  function readUI() {
    try {
      const raw = localStorage.getItem(UI_KEY)
      return raw ? JSON.parse(raw) : null
    } catch { return null }
  }
  function saveMgrView() { patchUI({ mgrView: state.mgrView }) }
  function loadMgrView() {
    try {
      const raw = localStorage.getItem(UI_KEY)
      if (!raw) return
      const d = JSON.parse(raw)
      if (!d || !d.mgrView) return
      const m = { ...state.mgrView, ...d.mgrView }
      // 枚举边界归一（持久化区是外部边界）：kind∈{plugins,skills,apps}、cat∈{public,personal}，
      // 旧形态（应用曾为 cat 值）或脏值一律回落缺省，避免落成无按钮可选的空网格。
      if (m.kind !== 'plugins' && m.kind !== 'skills' && m.kind !== 'apps') m.kind = 'plugins'
      if (m.cat !== 'public' && m.cat !== 'personal') m.cat = 'public'
      state.mgrView = m
    } catch { /* 忽略 */ }
  }
  // ---------- 项目槽（2026-10-15 待办 #5/#8/#9 根治）----------
  // 槽 = <项目 label> → 一整套 work 界面状态（键见 sidebar/work-state.js 的 WORK_SLOT_DEF）。
  // state 上那些同名 live 字段是**当前项目槽的活视图**：切项目 = stash 旧槽 → 换 workProj → load 新槽。
  // 因此「切项目清空顶栏」被**删除**（那等于把「切回来恢复」永久做掉）；跨项目串台由槽分家保证。
  // live → 槽（唯一写口；saveWork 与切项目共用）。写进 **workSlotKey**（live 当前镜像的那一槽），
  // 不是 workProj——切项目时两者在换指针的瞬间不等，认 workProj 会把旧 live 写进新槽。
  function stashWorkSlot() {
    const key = state.workSlotKey || state.workProj
    if (!key) return
    // activeChat 只在 **work 模式**下由 state.currentHash 记入：chat 模式里 currentHash 会被侧栏
    // 别处导航改写（全局/他项目会话），若照记会把不属于该项目的会话写进槽（存档来自外部边界，
    // 后续切回会导到错会话）。非 work 模式保留槽里原有值。
    const prevAC = state.workSlots[key] && typeof state.workSlots[key].activeChat === 'string' ? state.workSlots[key].activeChat : ''
    state.workSlots[key] = {
      wkTab: state.wkTab,
      wkMainTab: state.wkMainTab,
      wkAssist: !!state.wkAssist,
      wkAssistMode: state.wkAssistMode,
      wkAssistH: state.wkAssistH,
      wkChats: state.wkChats.slice(),
      wkFiles: state.wkFiles.slice(),
      activeChat: state.sbMode === 'work' ? state.currentHash || '' : prevAC, // 该项目当前会话（切回时的恢复目标；见 work-context.switchWorkProject）
      workFile: state.workFile,
      wkPreview: !!state.wkPreview,
      wkPvTab: state.wkPvTab,
      wkPvCard: state.wkPvCard,
      panelPinned: !!state.panelPinned,
    }
  }
  // 槽 → live（唯一读口）：有槽用槽，无槽回落 def（def 由调用方传入 WORK_SLOT_DEF——本模块是 core 叶子，
  // 不依赖 feature 的 work-state.js）。槽值是**持久化区 = 外部边界**，逐键做类型/枚举归一后才落 state；
  // 只写 state，渲染由调用方负责（applyPanes / applySidebarPin）——纯函数不许碰 DOM。
  function loadWorkSlot(label, def) {
    const s = (label && state.workSlots[label]) || null
    const str = (k, ok) => (s && typeof s[k] === 'string' && (!ok || ok.includes(s[k])) ? s[k] : def[k])
    const num = (k) => (s && typeof s[k] === 'number' && s[k] > 0 ? s[k] : def[k])
    const bool = (k) => (s && typeof s[k] === 'boolean' ? s[k] : def[k])
    const arr = (k) => (s && Array.isArray(s[k]) ? s[k].filter((x) => typeof x === 'string' && x) : def[k].slice())
    state.wkTab = str('wkTab', ['files', 'chat'])
    state.wkMainTab = str('wkMainTab', ['chat', 'file', 'plugins'])
    state.wkAssist = bool('wkAssist')
    state.wkAssistMode = str('wkAssistMode', ['side', 'float', 'slim'])
    state.wkAssistH = num('wkAssistH')
    state.wkChats = arr('wkChats')
    state.wkFiles = arr('wkFiles')
    state.workFile = str('workFile') // 非字符串 → def（''）
    state.wkPreview = bool('wkPreview')
    state.wkPvTab = str('wkPvTab')
    state.wkPvCard = str('wkPvCard')
    state.panelPinned = bool('panelPinned')
  }
  // work 模式状态持久化（2026-09-25）：刷新后恢复模式 + 当前项目 + **全部项目槽**（每项目各自的
  // 顶栏开放集 / 侧栏页 / 开关 / 打开的文件）。落盘时机 = applyPanes（布局落地唯一口，见 work-layout.js）。
  // 全局量（模式、当前项目、预览列宽）与槽同一次 patch，绝不各自分写。
  // 注意：wkPins **不在这里写**（2026-10-21 待办「置顶状态没有持久化」根治）。布局保存是高频动作
  // （applyPanes / 切项目 / 开关面板全走本函数），而置顶集只由 togglePin 一处改；若跟着整包写，
  // 另开着的标签页用自己内存里的旧 wkPins 保存一次布局就把别处刚置顶的结果覆盖回空——置顶看起来
  // 「没持久化」。置顶因此独立写口 savePins()，布局保存不再携带它。
  function saveWork() {
    stashWorkSlot() // 当前 live 视图先归入自己项目的槽（唯一写口），与下面同一次 patch
    patchUI({ sbMode: state.sbMode, workProj: state.workProj, wkPrevW: state.wkPrevW, workSlots: state.workSlots })
  }
  // 工具栏开合的生命周期 = **同一网关进程运行期内**（用户定案）：存档里的 gwBoot 是上次写盘时网关的
  // 启动时刻（/gateway/health 的 boot）。本次 boot 与存档不同 ⇒ 全部项目槽的工具栏复位折叠
  // （wkPreview=false / wkPvTab=''）；相同 ⇒ 原样保持（刷新不清打开状态）。boot 未知（旧网关 / 非网关
  // 环境）= 不动现状。调用点 = initWork（loadWork 之后、落地之前）。
  function resetWorkPreviewOnBoot(bootAt) {
    if (!bootAt) return
    let prev = 0
    try {
      const raw = localStorage.getItem(UI_KEY)
      const d = raw ? JSON.parse(raw) : null
      if (d && typeof d.gwBoot === 'number') prev = d.gwBoot
    } catch { /* 存储不可用：按首次处理 */ }
    patchUI({ gwBoot: bootAt })
    if (prev === bootAt) return
    for (const s of Object.values(state.workSlots)) {
      if (!s || typeof s !== 'object') continue
      s.wkPreview = false
      s.wkPvTab = ''
    }
    state.wkPreview = false
    state.wkPvTab = ''
  }
  // 置顶集唯一写口（togglePin 调用；read-modify-write 由 patchUI 保证不碰其它段）。
  function savePins() {
    patchUI({ wkPins: state.wkPins })
  }
  // 旧形态（扁平字段 + wkPanes）→ 槽形态的一次性迁移：把扁平量折进当时的 workProj 槽。
  // 只在读不到 workSlots 时执行（此后存档恒为新形态，迁移条件不再成立）。
  function migrateLegacyWork(d, def) {
    const key = typeof d.workProj === 'string' ? d.workProj : ''
    if (!key) return
    const panes = (d.wkPanes && d.wkPanes[key]) || null
    const slot = { ...def, wkChats: [], wkFiles: [] }
    if (Array.isArray(d.wkChats)) slot.wkChats = d.wkChats.filter((x) => typeof x === 'string' && x)
    if (Array.isArray(d.wkFiles)) slot.wkFiles = d.wkFiles.filter((x) => typeof x === 'string' && x)
    if (typeof d.workFile === 'string') slot.workFile = d.workFile
    if (d.wkMainTab === 'chat' || d.wkMainTab === 'file' || d.wkMainTab === 'plugins') slot.wkMainTab = d.wkMainTab
    if (typeof d.wkAssist === 'boolean') slot.wkAssist = d.wkAssist
    if (d.wkAssistMode === 'side' || d.wkAssistMode === 'float' || d.wkAssistMode === 'slim') slot.wkAssistMode = d.wkAssistMode
    if (typeof d.wkAssistH === 'number' && d.wkAssistH > 0) slot.wkAssistH = d.wkAssistH
    if (typeof d.wkPvTab === 'string') slot.wkPvTab = d.wkPvTab
    if (panes) {
      if (typeof panes.workspace === 'boolean') slot.wkPreview = panes.workspace
      if (typeof panes.sidebar === 'boolean') slot.panelPinned = panes.sidebar
    }
    state.workSlots[key] = slot
    // 其余项目的旧 wkPanes 槽只剩两开关，用 def 补齐成完整槽（保住「每项目记住预览/侧栏开关」）
    for (const [k, v] of Object.entries(d.wkPanes || {})) {
      if (!k || !v || typeof v !== 'object' || state.workSlots[k]) continue
      const s = { ...def, wkChats: [], wkFiles: [] }
      if (typeof v.workspace === 'boolean') s.wkPreview = v.workspace
      if (typeof v.sidebar === 'boolean') s.panelPinned = v.sidebar
      state.workSlots[k] = s
    }
  }
  function loadWork(def) {
    try {
      const raw = localStorage.getItem(UI_KEY)
      if (!raw) return
      const d = JSON.parse(raw)
      if (!d) return
      if (d.sbMode === 'work' || d.sbMode === 'chat') state.sbMode = d.sbMode
      if (typeof d.workProj === 'string') state.workProj = d.workProj
      if (typeof d.wkPrevW === 'number' && d.wkPrevW > 0) state.wkPrevW = d.wkPrevW // 全局：预览列宽
      // 置顶集（全局，仅 work 侧栏消费）：持久化区 = 外部边界，只收非空字符串
      if (Array.isArray(d.wkPins)) state.wkPins = d.wkPins.filter((x) => typeof x === 'string' && x)
      if (d.workSlots && typeof d.workSlots === 'object') {
        for (const [k, v] of Object.entries(d.workSlots)) if (k && v && typeof v === 'object') state.workSlots[k] = v
      } else {
        migrateLegacyWork(d, def) // 旧扁平形态 → 槽（一次性；此后存档恒新形态）
      }
      loadWorkSlot(state.workProj, def) // 当前项目槽 → live（无槽回落缺省）
      state.workSlotKey = state.workProj // 恢复即对齐：live 自此镜像该项目槽（不变量见 ui-state.js）
    } catch { /* 忽略 */ }
  }

export {
  UI_KEY,
  loadMgrView,
  loadWork,
  loadWorkSlot,
  patchUI,
  readUI,
  resetWorkPreviewOnBoot,
  saveMgrView,
  savePins,
  saveWork,
  stashWorkSlot,
}
