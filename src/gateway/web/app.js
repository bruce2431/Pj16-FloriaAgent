/* floria — 会话查看器前端（ChatGPT 风格）
   hash 路由约定：
     #/          → 主界面（空态，输入栏居中）
     #/<会话哈希> → 会话转录（输入栏 docked 底部）
   「会话哈希」= 转录文件名去掉 .jsonl（Claude Code 会话 UUID）。
   数据来自后端：/gateway/sessions 列表、/gateway/session?id= 单会话。
   只读查看：composer 不可发送。 */
(() => {
  'use strict'

  const $ = (id) => document.getElementById(id)

  // 2026-10-24 收口：图标表（I + fileIcon）整体移入 UI 基础包
  // `SubPj1-FloriaWebUI安装包开发/packages/web/src/icons.js`，产物 /webui/floria-web.iife.js 先于 app.js 同步加载并挂
  // window.FloriaWeb。缺包即抛错（不回落本地副本——回落会让两份图标表各自漂移）。
  if (!window.FloriaWeb) throw new Error('@floria/web 包未加载（/webui/floria-web.iife.js 须先于 app.js）')
  const {
    I,
    fileIcon,
  } = window.FloriaWeb

  // 页面壳 / 搜索 / 分类 / 卡片 / 动作位 / 详情头的结构与绑定在包内（mgr.js + mgr.css），
  // 业务侧只提供数据与回调。缺包即抛错（不回落本地副本）。
  if (!window.FloriaWeb) throw new Error('@floria/web 包未加载（/webui/floria-web.iife.js 须先于 app.js）')
  const MgrUI = window.FloriaWeb.mgr

  // ---------- 管理视图数据源（2026-08-15 起接后端 /gateway/plugins：真实已安装插件/技能 + 官方市场） ----------
  // 结构镜像后端返回：{ plugins:{personal,public}, skills:{personal,public} }，每项 {n, d, v, inst}。
  // 首次进入管理视图 fetch，刷新按钮 force 重新拉取；失败显示错误 + 重试（不回落假数据）。
  let MGR = null
  let MGR_LOADING = false
  let MGR_ERR = ''
  async function loadMgrData(force) {
    if (MGR && !force) return MGR
    if (needToken()) return null // token 门锁定态：不发起数据请求（hideGate 解锁后刷新）
    MGR_LOADING = true
    MGR_ERR = ''
    refreshCard('plugins')
    try {
      const res = await fetch(apiUrl('/gateway/plugins'))
      const data = await res.json()
      if (!data || !data.plugins || !data.skills) throw new Error(data.error || 'bad response')
      MGR = data
    } catch (e) {
      MGR_ERR = e.message || String(e)
    } finally {
      MGR_LOADING = false
      refreshCard('plugins')
    }
    return MGR
  }
  // 项目级技能清单（GET /gateway/plugins?label=<项目>）：项目根 .claude/skills/*/SKILL.md 的 frontmatter，
  // 返回 [{n, d, inst}]。与 MGR（便携根清单）分离——按项目 label 各自缓存，切项目不串。
  async function loadProjectSkills(label) {
    if (!label) return []
    const res = await fetch(apiUrl('/gateway/plugins?label=' + encodeURIComponent(label)))
    const data = await res.json()
    if (!data || !Array.isArray(data.skills)) throw new Error((data && data.error) || 'bad response')
    return data.skills
  }
  // 项目插件清单（work 插件 tab）：与技能同一个端点，一次返回 {plugins, skills}（均只含已安装个人项）。
  // 不做模块内缓存——work tab 每次项目切换由 work-plugins 自行持有并刷新（启停后要拿服务端真值）。
  async function loadProjectPlugins(label) {
    if (!label) return { plugins: [], skills: [] }
    const res = await fetch(apiUrl('/gateway/plugins?label=' + encodeURIComponent(label)))
    const data = await res.json()
    if (!data || !Array.isArray(data.plugins) || !Array.isArray(data.skills)) {
      throw new Error((data && data.error) || 'bad response')
    }
    return { plugins: data.plugins, skills: data.skills }
  }
  // 项目技能按 label 的进程内缓存（+ 工具栏与 @ 搜索共用一份）：{list, loaded, loading, err}。
  // ensureProjectSkills 同一 label 只发一次请求（在途期间复用同一 Promise），失败记 err 并在下次调用时重试。
  const PROJ_SKILLS = new Map()
  function projSkillsOf(label) {
    if (!label) return { list: [], loaded: true, loading: false, err: '' }
    let r = PROJ_SKILLS.get(label)
    if (!r) { r = { list: [], loaded: false, loading: false, err: '' }; PROJ_SKILLS.set(label, r) }
    return r
  }
  function ensureProjectSkills(label) {
    const r = projSkillsOf(label)
    if (!label || r.loaded || r.loading) return Promise.resolve(r.list)
    r.loading = true
    r.err = ''
    return loadProjectSkills(label)
      .then((list) => { r.list = list; r.loaded = true; return r.list })
      .catch((e) => { r.err = (e && e.message) || String(e); return r.list })
      .then((list) => { r.loading = false; return list })
  }
  // 模型配置数据源（/gateway/models：便携根 settings.json 的 model + 模型类环境变量；只读展示）
  let MODELS = null
  let MODELS_LOADING = false
  let MODELS_ERR = ''
  async function loadModelsData(force) {
    if (MODELS && !force) return MODELS
    if (needToken()) return null // token 门锁定态：不发起数据请求
    MODELS_LOADING = true
    MODELS_ERR = ''
    try {
      const res = await fetch(apiUrl('/gateway/models'))
      const data = await res.json()
      if (!data || !('model' in data)) throw new Error(data.error || 'bad response')
      MODELS = data
      // 与凭据池真实状态对齐（CLI 同源）：provider=activeProvider；effortLevel=settings.effortLevel。
      // model 优先级分两态（2026-09-19 修正「CLI 已切、web 底栏保留上一个」）：
      //   会话内（state.currentHash 非空）：本地 MODEL_CUR 最高——它由 /gateway/session（CLI 上报）
      //     与 SSE model 事件写入，是本会话的权威值；localStorage(saved) 是上次刷新残留，最低。
      //     旧实现把 saved 放最高，刷新即用陈旧值压掉网关真实模型（用户看到的「保留上一个」）。
      //   非会话态（列表/home）：无会话权威，按网关 activeModel → 便携根 settings.model → saved。
      const saved = loadModelCur()
      const inSession = !!state.currentHash
      setModelCur({
        provider: data.activeProvider || (saved ? saved.provider : '') || MODEL_CUR.provider,
        model: inSession
          ? MODEL_CUR.model || data.activeModel || (data.model ? String(data.model) : '') || (saved && saved.model) || ''
          : data.activeModel || (data.model ? String(data.model) : '') || (saved && saved.model) || MODEL_CUR.model,
        // effortLevel 只认网关真值（settings.json 落盘态）：网关返回 null/缺省 = 未设置 →
        // undefined（CLI 同源显示默认）。**不回落 localStorage**——陈旧 saved 会让座显报低档
        // 而 CLI 实际跑默认档（2026-10-24 用户实报「web 显示 low、CLI 是 high」的根因）。
        // 2026-11-06 会话隔离（C）：settings.json 的 effortLevel 是**全局默认**，会话内档位归属
        // 该会话（/gateway/session.effort 上报）——会话态下不得用全局默认覆盖座显。
        effortLevel: inSession
          ? MODEL_CUR.effortLevel
          : (data.effortLevel != null ? String(data.effortLevel) : undefined),
      })
      saveModelCur()
      // 全局默认到达后，会话档位按最近上报重算一次（无参 = 只重算、不改归属）
      if (inSession) applySessionEffort()
    } catch (e) {
      // 2026-08-25 竞态防护：若期间已有一次成功加载（如 hideGate 用新 token 补拉已先落地），
      // 此陈旧失败（典型：gate 前空 token 的 401）不覆盖已就绪数据，避免把成功态又标成错误。
      if (!MODELS) MODELS_ERR = e.message || String(e)
    } finally {
      MODELS_LOADING = false
      renderModelSeat() // 2026-08-25 模型数据落地后刷新输入栏模型 seat（含 hideGate 补拉场景）
    }
    return MODELS
  }
  // 色块取色（mgrColor）已随管理页通用 UI 收进 @floria/web 包（mgr.color），本层不再持有第二份调色板。
  // 供应商判定（2026-10-05 自 views/cards/models/models-card.js 迁入数据层——模型卡与输入栏模型菜单
  // 共用唯一一份；卡片去兄弟子系统横向依赖后经此取用）。key 优先（模型类环境变量名带供应商前缀），
  // 通用 model 键或未命中则按模型串前缀。
  const MODEL_PROVIDER_KEYS = [
    [/^ANTHROPIC_/, 'Claude · Anthropic'],
    [/^OPENAI_/, 'OpenAI'],
    [/^GEMINI_/, 'Google Gemini'],
    [/^DEEPSEEK_/, 'DeepSeek'],
    [/^QWEN_/, 'Qwen · 通义千问'],
    [/^DASHSCOPE_/, 'Qwen · 通义千问'],
    [/^GLM_/, '智谱 GLM'],
    [/^MOONSHOT_/, 'Moonshot Kimi'],
    [/^OPENROUTER_/, 'OpenRouter'],
  ]
  function modelProviderOf(it) {
    const k = String(it.k || '')
    const v = String(it.v || '')
    if (k !== 'model') {
      for (const [re, name] of MODEL_PROVIDER_KEYS) if (re.test(k)) return name
    }
    const vl = v.toLowerCase()
    if (vl.startsWith('claude')) return 'Claude · Anthropic'
    if (vl.startsWith('deepseek')) return 'DeepSeek'
    if (vl.startsWith('qwen')) return 'Qwen · 通义千问'
    if (vl.startsWith('gpt') || vl.startsWith('o1') || vl.startsWith('o3')) return 'OpenAI'
    if (vl.startsWith('gemini')) return 'Google Gemini'
    if (vl.startsWith('glm')) return '智谱 GLM'
    if (vl.startsWith('moonshot') || vl.includes('kimi')) return 'Moonshot Kimi'
    if (vl.includes('doubao')) return '字节豆包'
    return '自定义 / 其他'
  }

  // ---------- 状态 ----------
  // currentHash 无会话态 = ''（与 recent.js firstSendHash 同一表示，禁止再引入 null）：乐观项
  // pendingUserMsgs.hash 的「未归属」判定（p.hash === ''）依赖此约定——两套空值表示会让首页
  // 发送的乐观气泡在 navigate 进会话时被 renderSession 的归属守卫判为异类而丢弃（消息先闪现后消失）。
  // panelOpen = 侧栏**此刻可见**（含左缘悬停预览式唤出）；panelPinned = 侧栏**被主动打开**（汉堡/视图浮层
  // 开关，鼠标移出不自动收）。二者不同源：悬停唤出只置 panelOpen，故「侧边栏」开关的真源是 panelPinned
  // ——开关亮 = 侧栏常在，不是「此刻恰好露出」（见 sidebar/recent.js setPanel、sidebar/work.js paneOn）。
  const state = { mode: 'list', pt: 'projects', panelOpen: false, panelPinned: false, currentHash: '', mgr: null, preview: null, previewMounted: null, newProject: null, mgrView: { kind: 'plugins', cat: 'public', q: '' },
    // work 模式（2026-09-25）：sbMode = 侧栏模式（chat=现状 / work=Prism 式工作区）；
    // projects = /gateway/sessions 的 groups（全部项目，含无会话者，chat 侧栏不用）；
    // workProj = 当前项目 label（= 槽键，见下 workSlots）；workFile = 打开的文件（项目内相对路径）。
    // wkPreview = 预览列（最右，常驻）；wkMainTab = 下沉区当前 tab（'chat' 助手 / 'file' 编辑区 / 'plugins' 项目插件页），同时只显一个；
    // wkAssist = 聊天 tab 是否在场；wkPrevW = 预览列宽 px（拖分界条调，见 work.js applyWorkCols）——**全局，不按项目分槽**
    // （是窗口几何，不是项目内容）。
    // wkAssistMode = 助手形态（'side'=靠栏 = 聊天 tab 内容 / 'float'=悬浮卡 / 'slim'=收敛输入栏）；
    // wkAssistH = 悬浮卡高度（宽由锚栏宽给定，见 sidebar/work.js applyAssistMode）。
    // wkPvTab = 右栏「页态」：'' = 预览态（挂项目预览帧 #wk-pv-body）/ 已注册工具 id = 工具态（顶 tab 条
    // + 该工具 pane 互斥显隐，注册表见 sidebar/work-tools.js）。与 wkPreview（栏在不在场）正交：
    // 预览态 ⇄ 工具态由顶栏「工具栏」胶囊切（工具态时胶囊变「关闭」，点回预览态）。
    // wkPvCard = 预览态下当前激活的卡片 id（<项目>/.claude/preview/<id>/，元信息 card.json）；
    // '' = 无卡项目（传统 index.html 单页）。随项目入槽；项目卡表变化时由 renderWorkPreview 归一。
    sbMode: 'chat', projects: [], workspace: '', workProj: '', workFile: '', wkAssist: true, wkPreview: true,
    wkMainTab: 'chat', wkPrevW: 420, wkPvTab: '', wkPvCard: '',
    // wkTab = 侧栏体当前页（'files' 文件树 / 'chat' 会话列表）。2026-10-15 由
    // sidebar/work.js 的模块局部变量提升到 state 并**随项目入槽**（此前不持久化 ⇒ 重启恒回「文件」，
    // 这既是待办 #5 的一半，也让「切项目恢复上次侧栏页」成为可能）。
    wkTab: 'files',
    // wkChats = 下沉区打开的聊天 tab 开放集（浏览器 tab 模型）：条目 = 会话 hash，或 'new'（空对话 /
    // 首页的哨兵键）。增/删/切换唯一口 = sidebar/work-layout.js（wkEnsureTab / wkCloseTab；路由落地由
    // syncWorkTabs 并入）。× 只从顶栏移除，不删会话。
    wkChats: [],
    // wkFiles = 下沉区打开的文件 tab 开放集（与 wkChats 完全同构的浏览器 tab 模型，2026-10-12 加入）：
    // 条目 = **项目内相对 POSIX 路径**（如 MATH/main.tex —— 顶栏标签必须带目录段才认得出是哪一本）；
    // 激活项仍是单值 state.workFile。增唯一口 = sidebar/work/work-layout.js wkEnsureFileTab
    // （applyPanes 兜底并入当前 workFile）；删/切换 = work-editor.js closeWkFile。**非激活 tab 不保留
    // 编辑器态**——本模型是单编辑器 + 切前 flush，刻意不承诺「各自保留未保存内容」。
    wkFiles: [],
    // wkPins = work 侧栏会话列表的置顶集（会话 hash 数组，右键/长按浮窗「置顶」写入）。
    // **只在 work 侧栏渲染与排序**（chat 侧栏列表不读它）；**全局、不按项目分槽**——会话 hash 全局
    // 唯一，且 work 列表只列当前项目会话，天然按项目隔离。持久化随 saveWork 同一 patch。
    wkPins: [],
    wkAssistMode: 'side', wkAssistH: 430,
    // ---------- 项目槽（2026-10-15 待办 #5/#8/#9 根治）----------
    // workSlots: <项目 label> → 该项目的一整套 work 界面状态（键 = WORK_SLOT_DEF，sidebar/work-state.js）。
    // 上面那些同名 live 字段 = **当前项目槽的活视图**：切项目 = stash 旧槽 → 换 workProj → load 新槽
    // （唯一口 = stashWorkSlot / loadWorkSlot，core/storage.js），因此**切项目不再清空**（旧的
    // `state.wkChats = []` / `wkFiles = []` 重置已删——那等于把「切回来恢复」永久做掉），跨项目串台
    // 由「槽按 label 分家」保证：任何一槽只装自己项目的条目。
    // 语境唯一源 = getWorkContext()（sidebar/work-context.js）；顶栏该显示什么 = getWorkSurfaceProjection()。
    workSlots: {},
    // workSlotKey = **live 字段当前镜像的那一槽的键**。不变量：workSlotKey === workProj
    // （空 workProj 时两者皆空）。两者不等 = live 与语境脱钩（漂移），由 reconcileWorkSurface 归一。
    // 它是「切项目」这件事的唯一判据——stash 用 workSlotKey 而不是 workProj，否则换指针后归档会写错槽。
    workSlotKey: '' }

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

  let ALL = []
  // 阶段1 实时同步：SSE 变更驱动的去重/防抖状态
  const live = { es: null, listSig: '', curSig: '', listT: null, sessT: null, lastUserSig: '', pinnedUserSig: '', lastMsgLen: null, lastDataTs: 0, curUuid: null, queueRemote: [], maxImgId: 0, compactFlags: new Map(), turnEndFlags: new Map(), restoredFlags: new Map(), turnBeat: new Map(), txProcStart: 0, localMessages: null, deltaSeq: null, streamText: '', tasks: [], taskOpen: false }
  let connUp = false // 2026-09-07 网关 WS 在线（setConn 维护）：运行态计时 tick 据此标「连接中断」

function setAll(v) { ALL = v }
function setConnUp(v) { connUp = v }
  // ---------- 工具 ----------
  // 一元素一所有者：本模块自持 #toast 句柄（原取 engine/state.js ⇒ core→engine 逆向边）。
  const toastEl = $('toast')
  let timer = null

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  // 一元素一所有者：本模块自持 #char 句柄（原取 engine/state.js ⇒ core→engine 逆向边）。
  const charEl = $('char')
  // ---------- 角色形象（2026-08-14 实验） ----------
  // 右侧空缺处的 AI 形象随操作类型切换：读取/搜索=3、书写/编辑=2、执行代码/插件/命令行=4、其余（思考/输出/空闲）=1。
  const CHAR_READ = /^(read|grep|glob|web(fetch|search)|search|lookup|view|show|list|ls|cat|head|tail|find)$/i
  const CHAR_WRITE = /^(edit|write|notebookedit|todowrite|task(create|update|get|list|stop|delete)?)$/i
  const CHAR_EXEC = /^(bash|skill|agent|task|mcp__plugin|plugin:|kill|bash_sandbox|run)/i
  function toolToChar(name) {
    const n = String(name || '').toLowerCase()
    if (CHAR_EXEC.test(n)) return 4
    if (CHAR_READ.test(n)) return 3
    if (CHAR_WRITE.test(n)) return 2
    return 1
  }
  function setChar(n) {
    if (!charEl) return
    charEl.src = '/char/' + n + '.jpg'
  }

  const MENTION_PLUGIN_RE = /\[插件:([^\]]+)\]/g
  const MENTION_SESSION_RE = /\[会话:([^\]]+)\]/g
  // @ 提及 icon（2026-09-28 换 dsh v0.2.0-rc.1 产品图标集，16 描线/currentColor；旧 24 手绘那套作废）。
  // 语义与 dsh 一致：会话=ChatLines、插件=PluginPinwheel、技能=Skill、目录=FolderClose、文件=Browse
  // ——与 + 浮窗行图标同源（同一批 I.* 常量），两处不得分叉。
  const MENTION_SESSION_ICON = I.dshChat
  // 目录 / 文件引用令牌（2026-09-26）：令牌 [@目录:路径] / [@文件:路径] 与上传附件占位 [文件:<路径>]
  // 刻意不同名：后者会被 messages.js 的附件卡片链（userFilesHtml/userBodyHtml）剥走，同名会吞掉 @ chip。
  // 路径里允许出现 `]`（Windows 文件名唯一禁用的是 `\ / : * ? " < > |`），而 `]` 正是令牌收口符 ⇒
  // 不转义会把令牌提前截断（2026-10-25 用户实报：`[@文件:…_[1617+第5组+…] 1(1).pdf]` 只渲前半截，
  // 后面 `1(1).pdf]` 裸露成黑字）。转义符用 `\`（Windows 路径不可能含它）：`\`→`\\`、`]`→`\]`。
  // 正则 `(?:[^\]\\\n]|\\.)+` 认两种字符；旧令牌不含反斜杠 ⇒ 同一正则原样兼容，不引入双语法。
  const MENTION_PATH_RE = /\[@(目录|文件):((?:[^\]\\\n]|\\.)+)\]/g
  // 选中引用令牌（2026-09-28，inputbar/quote.js 产出）：`[@引用:<路径>#L12-L20]`——**只给位置**，
  // 模型自己 Read 该文件（与 `[文件:]` 上传占位、`[@文件:]` 路径 chip 都不同名，三者互不吞）。
  // 无行号（拿不到原文行偏移的文件）退化为 `[@引用:<路径>]`。MENTION_PATH_RE 只认「目录|文件」，
  // 不会抢「引用」。
  const QUOTE_REF_RE = /\[@引用:([^\]#]+?)(?:#L(\d+)-L?(\d+))?\]/g
  // 回复引用令牌（2026-09-28，同由 inputbar/quote.js 产出）：回复不属于任何文件、没有位置可查 ⇒
  // **原文必须进消息**（模型直接读到，以普通正文给出），进令牌的只是**锚点行**——`[@引用回复:<第N条>|<标题>]`。
  // 2026-10-21 起渲染侧（inputbar/mention.js quoteBodiesAsMarkdown）把原文块折成令牌的**第三个字段**
  // `[@引用回复:<第N条>|<标题>|<百分号编码原文>]`：气泡里「图标 + 原文」合成一枚蓝色引用胶囊（用户定案：
  // 不要「引用自…」字样，用引用的真实文本替换）。百分号编码是必需的——mdInline 在令牌替换之前先跑
  // 粗体/斜体/代码/链接/裸 URL，原文若原样夹带这些记号会被就地改写（*、~、反引号、括号等）。
  // 第三段省略 = 旧消息/纯锚点，退回来源标签形态。形态与 `[@引用:]`、`[@目录|文件:]` 互不吞。
  const QUOTE_REPLY_RE = /\[@引用回复:(\d+)\|([^\]|]*)(?:\|([^\]]*))?\]/g
  // PDF 引用令牌（2026-09-28，同由 inputbar/quote.js 经 floria-quote-open 产出）：`[@引用PDF:<路径>#p7]`。
  // PDF **没有行号**（Read 工具用 pages 参数，>10 页必须传），故位置粒度 = **路径 + 页码**（跨页 `#p7-9`，
  // 无页码退化纯路径）——与 `[@引用:]`（行号语义）刻意分家，混用会误导模型。
  // 第三段同回复引用 = 渲染侧折进来的百分号编码原文（2026-10-21）；省略 = 纯锚点。
  const QUOTE_PDF_RE = /\[@引用PDF:([^\]#|]+?)(?:#p(\d+)(?:-p?(\d+))?)?(?:\|([^\]]*))?\]/g
  const MENTION_FILE_ICON = I.dshFile

  // 令牌形态解析（会话令牌可带 sid：`标题|sid`，@ 提及 chip 序列化产出，CLI 侧按它精确寻址——
  // 见 src/utils/sessionAddressing.ts）。渲染一律只显示标题，sid 是给工具用的寻址键。
  function splitSessionToken(v) {
    const i = String(v).indexOf('|')
    return i >= 0 ? { title: String(v).slice(0, i), sid: String(v).slice(i + 1) } : { title: String(v), sid: '' }
  }

  // 路径令牌的转义/解码 + 唯一序列化口（@ 插入与「+」直选共用，禁各自拼字符串）。
  // 解码只认 `\X` → `X`：序列化侧保证反斜杠本身也成对转义，故不会误吞真实字符。
  function escapeMentionPath(p) {
    return String(p == null ? '' : p).replace(/\\/g, '\\\\').replace(/\]/g, '\\]')
  }
  function unescapeMentionPath(p) {
    return String(p == null ? '' : p).replace(/\\(.)/g, '$1')
  }
  function mentionPathToken(p, ptype) {
    return `[@${ptype === 'dir' ? '目录' : '文件'}:${escapeMentionPath(p)}]`
  }

  // chip HTML（name 为已转义文本：mdInline/addUser 入口已 esc，这里不再二次转义）
  // 消息内渲染=透明胶囊（无图标），仅保留名称文本（用户要求「只要一个白色浮窗似的胶囊」→ 透明胶囊）
  // 路径 chip 额外包一层 .mc-t：长路径在胶囊内省略号收口（inline-flex 直挂文本无法 text-overflow）
  // 2026-10-24 用户定案「发送后的引用 UI 要与底栏一致」：气泡侧三种 chip（路径/会话/插件）
  // 一律 = 图标 + 蓝字（与底栏 .mention 同构），不再有边框胶囊/等宽灰字/无图标形态。
  function mentionChipHtml(kind, name, ptype) {
    if (kind === 'path') {
      // chip 只显示**末段文件名**，全路径进 title：长路径前缀会把真正要看的文件名挤出可视区
      // （2026-10-25 用户实测：宽 180px 的胶囊只剩「@20261013120000-形…」）。
      const full = unescapeMentionPath(name)
      const base = full.split('/').pop()
      // 展示不带头部 @（2026-10-26 用户定案「引用的文本应该过滤掉艾特这个字符」）：
      // @ 只是输入侧唤出提及的手势字符，落地文本里它既不参与令牌解析也不属文件名。
      const label = base
      const icon = ptype === 'dir' ? I.dshFolder : fileIcon(full)
      return `<span class="mention-chip m-path" title="${full}"><span class="mc-ic">${icon}</span><span class="mc-t">${label}</span></span>`
    }
    if (kind === 'session') {
      const title = splitSessionToken(name).title
      return `<span class="mention-chip m-session"><span class="mc-ic">${MENTION_SESSION_ICON}</span><span class="mc-t">${title}</span></span>`
    }
    return `<span class="mention-chip m-plugin"><span class="mc-ic">${I.dshPlugin}</span><span class="mc-t">${name}</span></span>`
  }

  // 引用原文编码（2026-10-21）：原文要挤进令牌的一行字段，必须先抹掉会被 mdInline 预处理的记号
  // （粗体/斜体 `*`、删除线 `~`、行内代码反引号、图片/链接括号、裸 URL 的 `:/`、以及会被 esc 改写的 `'`）。
  // encodeURIComponent 本身不含 `'()*!~`，逐个补编码；解码失败（旧令牌/手改文本）原样返回，不丢内容。
  const quoteEscChars = /['()*!~]/g
  function encodeQuoteBody(s) {
    return encodeURIComponent(String(s == null ? '' : s))
      .replace(quoteEscChars, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  }
  function decodeQuoteBody(s) {
    const raw = String(s == null ? '' : s)
    if (!raw) return ''
    try { return decodeURIComponent(raw) } catch (_) { return raw }
  }

  // ---------- 引用原文块 ⇄ 折叠令牌（唯一真源）----------
  // 块形态（模型侧/旧消息）：`[@引用回复:idx|标题]\n原文\n[/引用回复]`。
  // 折叠形态（渲染侧/底栏 doc）：`[@引用回复:idx|标题|<百分号编码原文>]`——单行，可整体装饰成一枚胶囊。
  // 底栏 doc 存折叠形态（chip 即所见），**发送时 unfoldQuoteBodies 还原块形态**，模型读到的仍是原文。
  const QUOTE_REPLY_BODY_RE = /\[@引用回复:(\d+)\|([^\]]*)\]([\s\S]*?)\[\/引用回复\]/g
  const QUOTE_PDF_BODY_RE = /(\[@引用PDF:[^\]]*\])([\s\S]*?)\[\/引用PDF\]/g
  const QUOTE_REPLY_FOLDED_RE = /\[@引用回复:(\d+)\|([^\]|\n]*)\|([^\]\n]*)\]/g
  const QUOTE_PDF_FOLDED_RE = /\[@引用PDF:([^\]|]+)\|([^\]\n]*)\]/g
  // 块 → 折叠。收尾令牌不保证独占一行（退格/编辑会把它与正文并到同行），故用非贪婪全量捕获。
  // **折叠后严禁补换行**（2026-10-24 用户实报「引用发送后后面总有莫名其妙的换行」）：mdHtml 按行
  // 拆段、行间落 <br>，块形态里锚点/原文/收尾三行只服务于模型；渲染侧整块折成一枚行内胶囊，
  // 用户话术必须紧接胶囊流动（补 \n 会变成紧跟在胶囊后的额外 <br>）。
  function foldQuoteBodies(text) {
    const clean = (body) => String(body == null ? '' : body).replace(/^\s+|\s+$/g, '')
    const withBody = (token, body) => token.replace(/\]$/, '|' + encodeQuoteBody(clean(body)) + ']')
    return String(text || '')
      .replace(QUOTE_REPLY_BODY_RE, (m, idx, title, body) => withBody(`[@引用回复:${idx}|${title}]`, body))
      .replace(QUOTE_PDF_BODY_RE, (m, token, body) => withBody(token, body))
  }
  // 折叠 → 块（发送口）：底栏 doc 的折叠胶囊在这里还原成模型可读的原文块。
  function unfoldQuoteBodies(text) {
    return String(text || '')
      .replace(QUOTE_REPLY_FOLDED_RE, (m, idx, title, bodyEnc) => {
        const body = decodeQuoteBody(bodyEnc)
        return body ? `[@引用回复:${idx}|${title}]\n${body}\n[/引用回复]` : m
      })
      .replace(QUOTE_PDF_FOLDED_RE, (m, token, bodyEnc) => {
        const body = decodeQuoteBody(bodyEnc)
        return body ? `${token}\n${body}\n[/引用PDF]` : m
      })
  }

  // 选中引用的消息内形态（透明胶囊 + 文件图标 + 「引用自 <文件名>」，与输入栏内 .mention.ref 同族观感）。
  // path 来自已 esc 的文本（mdInline/renderUserText 入口已整体转义），此处不再二次转义。
  // data-qjump/q* = 点击跳转凭据（chat/messages/msg-actions.js 委托 → 卡片公开 API）。
  function quoteRefChipHtml(path, l0, l1) {
    const name = String(path).split('/').pop()
    const range = l0 ? ':' + l0 + (l1 && l1 !== l0 ? '-' + l1 : '') : ''
    return `<span class="mention-chip m-ref" data-qjump="file" data-qpath="${path}" data-ql0="${l0 || ''}" title="${path}${range}（work 模式下点击打开）"><span class="mc-ic">${fileIcon(path)}</span><span class="mc-t">引用自 ${name}${range}</span></span>`
  }
  // 回复引用的消息内形态（2026-10-21 用户定案）：**图标跟随引用的真实文本**，不再显示「引用自…第 N 条回复」；
  // 文本沿用 .m-ref 的蓝色，data-qidx = 第 N 条（1-based .msg 文档序，与令牌同源），点击经 chat 卡片 scroll 跳转。
  // 原文来自编码字段 → 此处解码后必须 esc 一次（其余 chip 入参已由渲染入口整段转义，唯此段是解码产物）。
  function quoteReplyChipHtml(idx, title, bodyEnc) {
    const t = String(title || '').trim() || '本会话'
    const where = `引用自「${t}」· 第 ${idx} 条回复`
    const n = Number(idx) || 0
    const body = decodeQuoteBody(bodyEnc)
    if (body) {
      return `<span class="mention-chip m-ref m-quote" data-qjump="reply" data-qidx="${n}" title="${where}（点击跳转）"><span class="mc-ic">${MENTION_SESSION_ICON}</span><span class="mc-t">${esc(body)}</span></span>`
    }
    return `<span class="mention-chip m-ref" data-qjump="reply" data-qidx="${n}" title="${where}"><span class="mc-ic">${MENTION_SESSION_ICON}</span><span class="mc-t">${where}</span></span>`
  }
  // PDF 引用的消息内形态：同样「图标 + 真实原文」（蓝色）；位置（文件/页码）退到 title 提示，不再占正文。
  // 位置粒度 = 路径 + 页码（跨页「第 s-e 页」，无页码退化为仅文件名）。
  function quotePdfChipHtml(path, p0, p1, bodyEnc) {
    const name = String(path).split('/').pop()
    const pages = p0 ? ' · 第 ' + p0 + (p1 && p1 !== p0 ? '-' + p1 : '') + ' 页' : ''
    const where = `引用自 ${name}${pages}`
    const body = decodeQuoteBody(bodyEnc)
    if (body) {
      return `<span class="mention-chip m-ref m-quote" title="${where}"><span class="mc-ic">${fileIcon(path)}</span><span class="mc-t">${esc(body)}</span></span>`
    }
    return `<span class="mention-chip m-ref" title="${where}"><span class="mc-ic">${fileIcon(path)}</span><span class="mc-t">${where}</span></span>`
  }

  // 源串（不带 flag）：消费方各自 new RegExp(src, 'g') —— 共享同一个 RegExp 对象会踩 lastIndex 状态。
  const MATH_SRC_BLOCK_DOLLAR = '\\$\\$([\\s\\S]+?)\\$\\$'   // $$…$$（可跨行）
  const MATH_SRC_BLOCK_BRACKET = '\\\\\\[([\\s\\S]+?)\\\\\\]' // \[…\]（可跨行）
  const MATH_SRC_INLINE_PAREN = '\\\\\\(([\\s\\S]+?)\\\\\\)'  // \(…\)（行内）
  const MATH_SRC_INLINE_DOLLAR = '\\$([^$\\n]+?)\\$'          // $…$（单行）
  // 行内 $…$ 假阳性防护：首尾不留空白、不紧跟数字（避免 "$5 and $10" 这类货币被误吃）。
  // 与 core/markdown.js 2026-10-06 定案同判据（提取到本层后行为不变）。
  const mathInlineOk = (body) => !/^\s/.test(body) && !/\s$/.test(body) && !/^\d/.test(body)
  // 抽取顺序契约：块级先于行内（否则 $$ 被 $ 抢占）。消费方按此序依次 replace。
  const MATH_EXTRACT_ORDER = ['blockDollar', 'blockBracket', 'inlineParen', 'inlineDollar']

  // ---------- Markdown 渲染（安全：mdHtml 入口先整体转义，再生成白名单 HTML） ----------
  const MD_MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Consolas, 'Courier New', monospace"
  const MD_LINK_OK = (u) => /^(https?:)?\/\//.test(u) || /^[a-z0-9][a-z0-9./_-]*$/i.test(u)
  // AI 生成图代号（2026-10-03）：markdown ![](code) 里的 code 只允许「文件名.ext」白名单
  // （无 / 无 . 段 → 防路径穿越），真实取图 URL 由注入的 resolver 拼（见 messages.js 注册）。
  const MD_IMG_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g|webp|gif)$/
  let mdImgResolver = null
  const setImageSrcResolver = (fn) => { mdImgResolver = fn }
  // 附件引用（2026-10-24 统一 file-cache）：正文里的 `![](file-cache/<会话id>/x.png)`——@ 艾特插入 /
  // 上传后发送的原文（网关签发的 rel，基址 = 配置根/file-cache）。渲染成**行内小图**
  // （与文字同高，见 styles.css `.msg .md-att-img`），类名带 msg-img ⇒ 复用既有 lightbox 委托，与消息
  // 流里的图片是同一条预览链。取图 URL 由 resolver 注入（core 不依赖 feature）：无 resolver → 保留原文。
  const MD_ATT_CODE = /^file-cache\/[^)\s]+$/
  let mdAttResolver = null
  const setAttachmentResolver = (fn) => { mdAttResolver = fn }

  // ---------- 数学公式（2026-10-06，仅 web；CLI 侧不渲染，Markdown.tsx 不挂 math 扩展） ----------
  // 支持 $…$ 行内、$$…$$ 块级，另兼容 \(…\) 行内 / \[…\] 块级。抽取必须发生在 esc 之前、且在原文上——
  // esc 会把 & < > " ' 转义，而 LaTeX 里的 a<b、& 对齐符、\alpha 需原样交给 KaTeX。
  // 做法：先把围栏/行内代码遮罩（防公式误伤代码），再抽公式渲染成 HTML 存表、原文留 \u0002N\u0002 占位；
  // 占位符全为控制字符，可安全穿过 esc。块级占位前后补 \n 独占一行，由 mdHtml 行循环还原为
  // <div class="math-block">；行内占位留在段落文字里，由 mdInline 末尾还原。katex 未加载则整段跳过
  // （$…$ 原样显示）。KaTeX 输出自身安全（trust 默认 false + 整体 esc），可直接进 innerHTML。
  const MATH_PH = /\u0002(\d+)\u0002/g
  let mathStore = null
  function renderMath(body, displayMode) {
    try {
      // output 必须保留 mathml：`.katex-mathml` 里的 `<annotation encoding="application/x-tex">` 是碎片选区
      // 复制时唯一能还原公式源码的凭据（copyTextOf 依赖它）；`output:'html'` 会把它砍掉 ⇒ 复制退化为纯字符。
      // mathml 由 KaTeX 自带样式视觉隐藏，不影响排版。
      return window.katex.renderToString(body, { displayMode, throwOnError: false, strict: false })
    } catch (_) { return null }
  }
  function extractMath(src) {
    mathStore = null
    if (typeof window === 'undefined' || !window.katex) return src
    mathStore = []
    const masked = []
    let s = src.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (m) => { masked.push(m); return `\u0003${masked.length - 1}\u0003` })
    s = s.replace(/`[^`\n]*`/g, (m) => { masked.push(m); return `\u0003${masked.length - 1}\u0003` })
    const put = (body, block) => {
      const html = renderMath(body, block)
      if (!html) return null
      mathStore.push({ html, src: body, block })
      const ph = `\u0002${mathStore.length - 1}\u0002`
      return block ? `\n${ph}\n` : ph
    }
    // 文法与判据来自 core/math-spec.js（三条链唯一真源）；块级先于行内（否则 $$ 会被 $ 抢占）
    s = s.replace(new RegExp(MATH_SRC_BLOCK_DOLLAR, 'g'), (m, body) => put(body, true) ?? m)
    s = s.replace(new RegExp(MATH_SRC_BLOCK_BRACKET, 'g'), (m, body) => put(body, true) ?? m)
    s = s.replace(new RegExp(MATH_SRC_INLINE_PAREN, 'g'), (m, body) => put(body, false) ?? m)
    // 行内 $…$：单行内、非空、首尾不留空白、不紧跟数字（避免误吃 $5 之类货币）
    s = s.replace(new RegExp(MATH_SRC_INLINE_DOLLAR, 'g'), (m, body) => (mathInlineOk(body) ? (put(body, false) ?? m) : m))
    return s.replace(/\u0003(\d+)\u0003/g, (_, i) => masked[+i])
  }
  function restoreMath(s) {
    return mathStore ? s.replace(MATH_PH, (_, i) => mathStore[+i].html) : s
  }
  // data-md 复制用：把公式占位符还原成「$$原始 LaTeX$$」（供 md 源码复制），src 未 esc → 需 esc 一次
  // 才能安全落进属性。s 本身已是 esc 后文本（mdHtml 行循环里），故整体仍为「esc 一次」口径。
  function phAttr(s) {
    return mathStore ? String(s).replace(MATH_PH, (_, i) => {
      const m = mathStore[+i]
      return m.block ? '$$' + esc(m.src) + '$$' : '$' + esc(m.src) + '$'
    }) : String(s)
  }
  // 块级原始 md 挂载：raw 必须是 mdHtml 入口 esc 之后的文本（公式占位已由 phAttr 还原）。
  // 属性值经浏览器 DOM 解析解码一次 → el.dataset.md 即原始 md 文本（esc 与解码互相抵消）。
  function mdAttr(raw) {
    return raw ? ` data-md="${phAttr(raw)}"` : ''
  }

  // ---------- 围栏代码块渲染（2026-10-10 codex 化：语法高亮 + 头栏 + 软换行） ----------
  // 高亮复用内置网关已 vendored 的 codemirror-live-markdown `highlightCode`（lowlight/highlight.js，
  // 输出 hljs-* 类；即 @floria/cm6 包的 edCMG，见 editor/cm-bridge.js）——不自建高亮器。
  // 语言为空/库缺失/未注册 → highlightCodeHtml 返 null，正文回落「已转义纯文本」（不预判语言，禁猜高亮）。
  const CB_WRAP_KEY = 'floria-code-wrap'
  let cbWrapOn = true // 默认软换行（用户 2026-10-10 定案「没有自动换行」；持久化偏好见 initCodeBlock）
  // 头栏图标（16px 线性，currentColor；不引 core/icons 以免动全局图标表）
  const CB_ICON_COPY = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
  const CB_ICON_WRAP = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"/><path d="M4 12h13a3 3 0 0 1 0 6h-3"/><path d="M17 15l-3 3 3 3"/><path d="M4 18h6"/></svg>'
  // 高亮原码：入参必须是「未转义」的原始代码（lowlight 内部自行 escapeHtml，给已转义文本会二次转义）。
  // lang 为空/库缺失/语言未注册 → null = 调用方走已转义纯文本。
  function highlightCodeHtml(raw, lang) {
    const CM = edCMG
    if (!CM || !CM.highlightCode || !lang) return null
    try {
      const r = CM.highlightCode(raw, lang)
      return r && r.html ? r.html : null
    } catch (_) { return null }
  }
  // esc 的逆（markdown.js 入口已整体转义一次；closeCode 拿到的 raw 是**已转义**文本，喂给高亮前要还原，
  // 否则 `<`→`&lt;` 被 lowlight 再转成 `&amp;lt;` 显示错）。&amp; 必须最后解（防 `&amp;lt;` 二次解码）。
  const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  // 代码块 HTML：头栏（语言名 + 换行/复制按钮）+ pre>code（高亮 HTML 或已转义纯文本）。
  // data-md=fence 挂最外层（复制/选区复制靠它还原源码）；复制按钮的原文由消费端读 pre>code.textContent
  // （高亮只包 span 不改文本，textContent 即原始代码，无需另存）。lang 已是 esc 后文本，直接落属性不再转义。
  function renderCodeBlock(f, lang, text) {
    const tag = lang ? `<span class="code-lang">${lang}</span>` : '<span class="code-lang">代码</span>'
    const hi = highlightCodeHtml(unesc(text), lang)
    const body = hi != null ? hi : text
    const head = '<div class="code-head">' + tag +
      `<div class="code-acts"><button type="button" class="code-btn cb-wrap" title="切换自动换行" aria-label="切换自动换行">${CB_ICON_WRAP}</button>` +
      `<button type="button" class="code-btn cb-copy" title="复制" aria-label="复制">${CB_ICON_COPY}</button></div></div>`
    return `<div class="code-block${cbWrapOn ? ' wrap' : ''}"${mdAttr(f)}${hi != null ? ' data-lang="' + lang + '"' : ''}>${head}<pre><code>${body}</code></pre></div>`
  }
  // 换行偏好初始化（web-src/app.js 顶层调用一次）：读 localStorage 覆盖默认值。
  function initCodeBlock() {
    try {
      const v = localStorage.getItem(CB_WRAP_KEY)
      if (v === '0') cbWrapOn = false
      else if (v === '1') cbWrapOn = true
    } catch (_) {}
  }
  // 切换软换行（委托点击处理）——同步持久化偏好 + 全页现有代码块。
  function toggleCodeWrap() {
    cbWrapOn = !cbWrapOn
    try { localStorage.setItem(CB_WRAP_KEY, cbWrapOn ? '1' : '0') } catch (_) {}
    document.querySelectorAll('.code-block').forEach((el) => el.classList.toggle('wrap', cbWrapOn))
    return cbWrapOn
  }

  function mdInline(s) {
    // s 必须是已转义文本（来自 mdHtml 入口）
    const codes = []
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000' })
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>')
    // 图片代号（AI 生成图）：![](文件名.png) → <img>，code 过白名单 + resolver 拼取图 URL；
    // 不匹配或无 resolver 则保留原文（不兜底）。必须在下方链接替换之前，否则被拆成 ! + <a>。
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, code) => {
      // 附件引用（file-cache/）：行内小图（与文字同高），类含 msg-img ⇒ 与消息图片共用 lightbox
      if (mdAttResolver && MD_ATT_CODE.test(code)) {
        const aurl = mdAttResolver(code)
        if (aurl) return `<img class="msg-img md-att-img" loading="lazy" alt="${alt}" src="${esc(aurl)}">`
      }
      if (!mdImgResolver || !MD_IMG_CODE.test(code)) return `![${alt}](${code})`
      const url = mdImgResolver(code)
      if (!url) return `![${alt}](${code})`
      return `<img class="msg-img md-img" loading="lazy" alt="${alt}" src="${esc(url)}">`
    })
    // 附件文件引用（file-cache/）：与编辑器同形 = 类型徽标 + 文件名（@ 上传组插入的 `[名](file-cache/…)`）；
    // 非 file-cache 链接仍走普通外链。
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
      if (MD_ATT_CODE.test(u)) {
        return `<span class="mention-chip m-path m-att" title="${u}"><span class="mc-ic">${fileIcon(u)}</span><span class="mc-t">${t}</span></span>`
      }
      return MD_LINK_OK(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : t
    })
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => p + `<a href="${u}" target="_blank" rel="noopener">${u}</a>`)
    // @ 提及令牌 → chip（[插件:名称] / [会话:名称]，名称已转义）。
    // ⚠️ 必须在行内代码还原（下一行）之前替换：行内代码 `[插件:X]` 已抽成占位符 \u0000N\u0000，
    // 令牌替换命中不到代码内文本，避免 chip 嵌套进 <code>（白胶囊+灰代码气泡叠一起）。
    s = s.replace(MENTION_PLUGIN_RE, (_, n) => mentionChipHtml('plugin', n))
         .replace(MENTION_SESSION_RE, (_, n) => mentionChipHtml('session', n))
         .replace(MENTION_PATH_RE, (_, t, p) => mentionChipHtml('path', p, t === '目录' ? 'dir' : 'file'))
         .replace(QUOTE_REF_RE, (_, p, a, b) => quoteRefChipHtml(p, a, b))
         .replace(QUOTE_REPLY_RE, (_, i, t, b) => quoteReplyChipHtml(i, t, b))
         .replace(QUOTE_PDF_RE, (_, p, a, b, q) => quotePdfChipHtml(p, a, b, q))
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`)
    return restoreMath(s)
  }
  // 单段行内文本 → HTML（mdHtml 行循环里对每行做的事，抽成可独立调用的一口）。
  // 顺序与 mdHtml 入口一致且不可换：extractMath（原文上抽公式，先于 esc）→ esc → mdInline（末尾 restoreMath）。
  // 消费者：work.js 编辑区表格 widget 的单元格渲染器（CM.setTableCellRenderer(mdInlineText)）。
  function mdInlineText(s) { return mdInline(esc(extractMath(String(s == null ? '' : s)))) }
  function mdHtml(src) {
    if (!src) return ''
    const lines = esc(extractMath(String(src))).split('\n')
    let html = ''
    let para = []
    let paraRaw = [] // 段落原始行（esc 后），供 data-md 还原 md 源码
    const flushPara = () => {
      if (para.length) {
        html += `<p${mdAttr(paraRaw.join('\n'))}>${para.join('<br>')}</p>`
        para = []
        paraRaw = []
      }
    }
    let inCode = false, codeLang = '', codeBuf = []
    // ---- 嵌入式图表（```chart 双段围栏，2026-09-12 定案）----
    // 契约（全局根 CLAUDE.md）：模型输出 ```chart 围栏，内含 %%html / %%ascii 两个哨兵段（同一图表的两种等价表达）。
    // web 取 %%html 段进 sandbox iframe（opaque origin，BOOT 上报高度），%%ascii 段弃用（「源码」按钮看全文）；
    // CLI 反向过滤只留 ascii（src/components/Markdown.tsx stripChartHtml）。普通 ```html 围栏不受影响。
    // srcdoc 安全链：mdHtml 入口已整体 esc（含引号）→ 属性不破出；浏览器解析 srcdoc 实体解码一次，
    // iframe 文档恰好还原为模型原始 HTML（esc 链与属性解码互相抵消，语义透明）；BOOT 是自有串，esc 一次同理。
    const CHART_BOOT = '<style>html,body{margin:0;padding:0;background:transparent}</style>' +
      '<script>(function(){var p=function(){try{var b=document.body;parent.postMessage({__chartH:Math.max(b?b.scrollHeight:0,document.documentElement.scrollHeight)},"*")}catch(_){}};' +
      'if(window.ResizeObserver)new ResizeObserver(p).observe(document.documentElement);addEventListener("load",p);p()})()</scr' + 'ipt>'
    // 哨兵行（行首精确匹配 %%html / %%ascii）拆段；缺段由 closeCode 降级回代码块
    function chartSplit(buf) {
      let mode = null, hasHtml = false, hasAscii = false, html = [], ascii = []
      for (const line of buf) {
        const t = line.trim()
        if (t === '%%html') { mode = 'html'; hasHtml = true; continue }
        if (t === '%%ascii') { mode = 'ascii'; hasAscii = true; continue }
        if (mode === 'html') html.push(line)
        else if (mode === 'ascii') ascii.push(line)
      }
      return { html: html.join('\n'), ascii: ascii.join('\n'), hasHtml, hasAscii }
    }
    // closed=false（流式未闭合围栏的 EOF 收口）恒回退代码块：闭合那一帧才切 iframe，防流式每 delta 重建闪烁
    const closeCode = (closed) => {
      if (!inCode) return
      const raw = codeBuf.join('\n')
      const fence = '```' + codeLang + '\n' + raw + '\n```' // data-md：围栏原文重建
      const sec = (codeLang === 'chart' && closed) ? chartSplit(codeBuf) : null
      // ---- 公式围栏（```math，2026-10-29 与 CM6 口径统一）----
      // CM6 vendor live-markdown 的 blockMathField 只认语言名 `math`（SubPj4 cm-math.js 同口径）；
      // 消息流此前把它当普通代码块，同一段内容在底栏是公式、发出后变灰色代码。此处补齐。
      // 流式未闭合（closed=false）或 katex 缺失（renderMath 回 null）→ 回落代码块：与 chart 同口径，
      // 防流式每帧在「代码块 ↔ 公式」之间重建闪烁。codeBuf 是 esc 后文本，喂 KaTeX 前须 unesc。
      const mathHtml = (closed && codeLang === 'math') ? renderMath(unesc(raw), true) : null
      if (sec && sec.hasHtml && sec.html.trim()) {
        html += `<div class="chart-embed"${mdAttr(fence)}><div class="chart-bar"><span class="chart-tag">CHART</span><button type="button" class="chart-src" title="切换 图表/源码">源码</button></div><iframe class="chart-frame" sandbox="allow-scripts" srcdoc="${sec.html}${esc(CHART_BOOT)}"></iframe><pre class="chart-raw"><code>${raw}</code></pre></div>`
      } else if (mathHtml) {
        html += `<div class="math-block"${mdAttr(fence)}>${mathHtml}</div>`
      } else {
        html += renderCodeBlock(fence, codeLang, raw)
      }
      codeBuf = []; codeLang = ''; inCode = false
    }
    let list = null
    const closeList = () => { if (list) { html += `</${list}>`; list = null } }
    const isSep = (r) => { const x = r.replace(/\|/g, '').replace(/[\s:-]/g, ''); return x === '' && r.includes('-') }
    const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
    // 任务列表复选框（2026-10-15 待办 10）：`- [ ] ` / `- [x] ` / `- [X] `（-/*/+ bullet 与有序列表同支持）
    // 行解析阶段转**真实** <input type="checkbox">（禁 CSS 伪元素模拟）。data-task-line = 1-based 源行号
    // （可编辑面据此还原源码，见 editor-markdown.toggleTask）；disabled = 渲染面只读（消息是渲染产物，
    // 勾选语义只在编辑面发生，此处不改消息内容）。data-md 仍挂 li 整行原文（含 `[ ]`）→ 复制口径不变。
    const TASK_RE = /^\[([ xX])\]\s+(.*)$/
    const taskBox = (n, mark) => `<input type="checkbox" class="md-task-checkbox" data-task-line="${n}"${mark !== ' ' ? ' checked' : ''} disabled>`

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const t = line.trim()
      if (!t) { flushPara(); closeList(); continue }
      if (/^```/.test(t)) {
        if (inCode) { closeCode(true) } else { inCode = true; codeLang = t.slice(3).trim() }
        continue
      }
      if (inCode) { codeBuf.push(line); continue }
      // 块级公式占位（extractMath 已渲染成 HTML 存 mathStore）：独占一行 → 输出块级容器
      const mblk = /^\u0002(\d+)\u0002$/.exec(t)
      if (mblk) { flushPara(); closeList(); const mm = mathStore[+mblk[1]]; html += `<div class="math-block"${mdAttr('$$' + esc(mm.src) + '$$')}>${mm.html}</div>`; continue }
      const h = /^(#{1,4})\s+(.*)$/.exec(t)
      if (h) { flushPara(); closeList(); html += `<h${h[1].length}${mdAttr(t)}>${mdInline(h[2])}</h${h[1].length}>`; continue }
      if (t.startsWith('&gt;')) {
        flushPara(); closeList()
        html += `<blockquote${mdAttr(t)}>${mdInline(t.replace(/^&gt;\s?/, ''))}</blockquote>`
        continue
      }
      if (/^[-*+]\s+/.test(t)) {
        flushPara()
        if (list !== 'ul') { closeList(); list = 'ul'; html += '<ul>' }
        const body = t.replace(/^[-*+]\s+/, '')
        const tk = TASK_RE.exec(body)
        html += `<li${mdAttr(t)}>${tk ? taskBox(i + 1, tk[1]) : ''}${mdInline(tk ? tk[2] : body)}</li>`
        continue
      }
      if (/^\d+[.)]\s+/.test(t)) {
        flushPara()
        if (list !== 'ol') { closeList(); list = 'ol'; html += '<ol>' }
        const body = t.replace(/^\d+[.)]\s+/, '')
        const tk = TASK_RE.exec(body)
        html += `<li${mdAttr(t)}>${tk ? taskBox(i + 1, tk[1]) : ''}${mdInline(tk ? tk[2] : body)}</li>`
        continue
      }
      if (/^(-{3,}|\*{3,})$/.test(t)) { flushPara(); closeList(); html += `<hr${mdAttr(t)}>`; continue }
      if (t.startsWith('|') && lines[i + 1] && isSep(lines[i + 1].trim())) {
        flushPara(); closeList()
        const tbl = [t]
        let tHtml = `<table><thead><tr>` + cells(t).map((c) => `<th>${mdInline(c)}</th>`).join('') + '</tr></thead><tbody>'
        i += 1
        tbl.push(lines[i])
        while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
          i += 1
          tbl.push(lines[i])
          tHtml += `<tr>` + cells(lines[i]).map((c) => `<td>${mdInline(c)}</td>`).join('') + '</tr>'
        }
        tHtml += '</tbody></table>'
        html += `<div class="md-table"${mdAttr(tbl.join('\n'))}>${tHtml}</div>`
        continue
      }
      para.push(mdInline(t)); paraRaw.push(t)
    }
    flushPara(); closeCode(false); closeList()
    return html
  }

  // ---------- data-md 消费：复制方向（2026-10-09） ----------
  // mdHtml 给每个块级元素挂了 data-md=原始 md 片段（见 mdAttr），复制据此还原 md 源码：
  //  · messageMd(root)  → root 内全部块级 data-md 按序拼接（复制按钮用，root 传该消息 .body）
  //  · selectionMd(sel) → 选区整块覆盖的块用原文，块内碎片无一一对应关系返回 null（调用方按纯文本降级）
  // 全局唯一的 copy 拦截在 inputbar/ctx-meter.js，两函数即其判据来源（不再另起监听，避免双监听互相覆盖）。
  const COPY_PARA_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'DIV', 'TABLE'])
  const COPY_LINE_TAGS = new Set(['LI', 'TR', 'UL', 'OL', 'HR'])
  // 降级文本：textContent 会把相邻块级元素文本直接拼接（<p>a</p><p>b</p> → "ab"、<br> 更被吞），
  // 故按标签补换行——段落级补空行、列表/表格行补单换行。接受元素/DocumentFragment（nodeType 11）。
  function copyTextOf(node) {
    let out = ''
    const walk = (n) => {
      if (n.nodeType === 3) { out += n.nodeValue; return }
      if (n.nodeType === 11) { n.childNodes.forEach(walk); return }
      if (n.nodeType !== 1) return
      // 碎片选区里的公式：KaTeX 渲染树本身只有排好的字符（σ − π、上下标拆成多个 span），直接走文本会
      // 「退化为纯字符」。KaTeX 在 mathml 里保留了原始 TeX 的 `<annotation>`，据此还原 `$…$` / `$$…$$`
      // （2026-10-17 用户实测：任意粒度选区复制都不得丢公式源码）。整块选区仍由 data-md 走原文，不经过此支。
      if (n.classList && (n.classList.contains('katex') || n.classList.contains('katex-display'))) {
        const ann = n.querySelector('annotation[encoding="application/x-tex"]')
        const tex = ann && ann.textContent
        if (tex) {
          const d = n.classList.contains('katex-display') ? '$$' : '$'
          out += d + tex + d
          return
        }
      }
      if (n.tagName === 'BR') { out += '\n'; return }
      const sep = COPY_PARA_TAGS.has(n.tagName) ? '\n\n' : (COPY_LINE_TAGS.has(n.tagName) ? '\n' : '')
      if (sep && out && !out.endsWith('\n')) out += sep
      n.childNodes.forEach(walk)
      if (sep && out && !out.endsWith('\n')) out += sep
    }
    walk(node)
    return out
  }
  // 最外层带 data-md 的块（最近的 data-md 祖先即自身 → 嵌套里的顶层块，父块+子块不重复计）
  function topDataMd(root) {
    return Array.from(root.querySelectorAll('[data-md]')).filter((el) => el.closest('[data-md]') === el)
  }
  // 块间拼接：同属一个列表的相邻 LI 之间单换行，其余块之间空行（保持 md 分块语义）
  function joinMdBlocks(els, pick) {
    const parts = []
    els.forEach((el) => { const piece = pick(el); if (piece) parts.push({ el, piece }) })
    let out = ''
    for (let i = 0; i < parts.length; i++) {
      if (i) out += (parts[i].el.tagName === 'LI' && parts[i - 1].el.tagName === 'LI') ? '\n' : '\n\n'
      out += parts[i].piece
    }
    return out
  }
  function messageMd(root) {
    return root ? joinMdBlocks(topDataMd(root), (el) => el.dataset.md).trim() : ''
  }
  // 块内容的起/止边界点 = 块内**首个/末个内容文本节点**（跳过装饰/chrome：KaTeX 的空 <span class="strut">、
  // 代码块 .code-head、图表 .chart-bar、按钮）。盲降 firstChild/lastChild 会落到这些无文本/旁枝节点上，
  // 边界点落在内容之外 → isPointInRange 恒 false ⇒ 整块选全也被当成碎片降级成渲染文本（待办 5 根因）。
  // 块内无内容文本（<hr>、纯图段）回退元素自身边界（元素层点，void 块整块选中时仍成立）。
  function contentEdges(el) {
    const SKIP = 'button, .code-head, .chart-bar, iframe'
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (t) => (t.parentElement && t.parentElement.closest(SKIP)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    })
    let first = null
    let last = null
    let n
    while ((n = walker.nextNode())) {
      if (n.nodeValue && n.nodeValue.length) { if (!first) first = n; last = n }
    }
    if (first) return [[first, 0], [last, last.nodeValue.length]]
    let a = el
    let b = el
    while (a.firstChild) a = a.firstChild
    while (b.lastChild) b = b.lastChild
    return [[a, 0], [b, b.nodeType === 3 ? b.nodeValue.length : b.childNodes.length]]
  }
  // 某块是否被 range 完整覆盖：range 同时覆盖该块的起、止两个内容边界点即算完整（边界贴合含在内）
  function isCoveredByRange(range, el) {
    const [[sn, so], [en, eo]] = contentEdges(el)
    try {
      return range.isPointInRange(sn, so) && range.isPointInRange(en, eo)
    } catch (_) { return false }
  }
  // 选区与某块的交集片段（碎片降级文本用）：两端各自向块内容边界收拢，越界/异树异常交回 null
  function intersectFragment(range, el) {
    const [[sn, so], [en, eo]] = contentEdges(el)
    try {
      const startAfter = range.comparePoint(sn, so) === -1  // 选区起点落于块内容起点之后
      const endWithin = range.comparePoint(en, eo) !== 1    // 选区终点未越过块内容终点
      const r = document.createRange()
      r.setStart(startAfter ? range.startContainer : sn, startAfter ? range.startOffset : so)
      r.setEnd(endWithin ? en : range.endContainer, endWithin ? eo : range.endOffset)
      return r.cloneContents()
    } catch (_) { return null }
  }
  function selectionMd(sel) {
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null
    const range = sel.getRangeAt(0)
    const els = topDataMd(document).filter((el) => range.intersectsNode(el))
    if (!els.length) return null
    const text = joinMdBlocks(els, (el) => {
      if (isCoveredByRange(range, el)) return el.dataset.md
      const frag = intersectFragment(range, el)
      return frag ? copyTextOf(frag) : ''
    }).trim()
    return text || null
  }

  function relTime(ms) {
    if (!ms) return ''
    const diff = Date.now() - ms
    const m = Math.floor(diff / 60000)
    if (m < 1) return '刚刚'
    if (m < 60) return `${m} 分钟前`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h} 小时前`
    const d = Math.floor(h / 24)
    if (d < 30) return `${d} 天前`
    const dt = new Date(ms)
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
  }

  function toast(msg) {
    toastEl.textContent = msg
    toastEl.hidden = false
    clearTimeout(timer)
    timer = setTimeout(() => (toastEl.hidden = true), 2600)
  }

  // 临时项目 = 根级时间戳任务区（`<YYYYMMDDHHMMSS>-名称`，后端 findProjects 一并产出为 scope='project'）。
  // 它不承载自有会话与预览：work 模式下聊天列表展示**全局根散装会话**、工具栏胶囊不渲染、新建会话也落
  // 全局根（2026-10-30 用户定案）。判据只认 label 形态这一条，不新增 scope 值。
  const TEMP_PROJ_RE = /^\d{8,14}-/
  const isTempProjLabel = (label) => TEMP_PROJ_RE.test(label || '')

  // 会话的项目归属（chat 侧栏唯一判据，2026-11-06 用户定案）：临时项目 label 下的会话按**全局根**对待（''）。
  // 根级时间戳任务区只是 work 的文件树入口，不是可归属的会话项目——chat 侧栏不识别它、也不显示项目标签；
  // work 侧栏与底栏项目选择器不走本函数（那里临时项目仍需可选，见 feature/project-picker/）。
  const sessionProjLabel = (s) =>
    s && s.projectScope === 'project' && s.projectLabel && !isTempProjLabel(s.projectLabel) ? s.projectLabel : ''

  // 会话是否属于某工作项目的辖内（work 侧唯一判据）：临时项目（根级时间戳任务区）的在辖会话 =
  // 全局根散装会话（它不承载自有会话）；普通项目 = projectLabel 命中。
  const sessionInWork = (s, workProj) =>
    isTempProjLabel(workProj) ? !!s && s.projectScope === 'global' : !!s && s.projectLabel === workProj

  // 新会话的落项目（唯一真源）：work 模式 = 「在项目中工作」，目标项目恒 = 工作项目（state.workProj）；
  // 其余情况 = chat 侧栏/初始界面选的 state.newProject（null = 全局）。所有建会话/上传的落项目判定
  // 都读本函数——写死 state.newProject 的消费点会在 work 模式下漏掉工作项目（会话落到全局）。
  // 临时项目例外：返回空串（= 全局根），否则新会话带临时项目 label，会从「展示全局会话」的列表里消失。
  function newSessionProject() {
    if (state.sbMode !== 'work' || !state.workProj) return state.newProject
    return isTempProjLabel(state.workProj) ? '' : state.workProj
  }

  // 手机端（≤720px）：侧栏为全屏抽屉，选择会话后自动收起
  const isMobile = () => window.matchMedia('(max-width: 720px)').matches
  // 纯触屏设备（iPad/iPhone Safari）：打开弹层时不得程序化聚焦输入框——iOS 会因此弹出系统键盘
  // （2026-08-28：+ 命令菜单搜索框 / 模型菜单回填输入栏焦点均被识别为文本输入；桌面不受影响，方向键导航保留）
  const isTouch = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches


const cardBus = (function () {
  // ---------- 帧实例表 ----------
  // key = `<kind>:<label>:<id>`（preview 帧 id 为自增序，ext 卡 id 取 card.id）；反向查「来源窗口」用
  // 遍历 el.contentWindow（帧数 <10，比维护 Window 反向索引更不容易失效：iframe 换 src 后 WindowProxy
  // 身份不变，而 contentWindow 需惰性现读）。
  const frames = new Map()
  let seq = 0

  // 帧状态：ns/cmds 由卡片第一条 `<ns>-*` 消息与 ready 事件确定；busy+queue = 每帧串行队列
  // （串行是 ack 用 cmd 配对的必要前提：并发两条同 cmd 无法区分，串行天然规避）。
  function resetFrame(f) {
    f.ns = ''
    f.cmds = []
    f.ready = false
    f.latestState = null
    f.updatedAt = Date.now()
  }

  function registerFrame(rec) {
    if (!rec || !rec.el) return ''
    for (const [k, f] of frames) {
      if (f.el === rec.el) { resetFrame(f); scheduleCaps(); return k } // 软重入换 src：复用 key、清卡态
    }
    const kind = rec.kind || 'frame'
    const label = typeof rec.label === 'string' ? rec.label : ''
    // id = 卡自身的稳定标识（ext 卡取 card.id）；缺省取自增序。同 kind+label 已被占（同项目的槽预览与
    // work 栏并存）时加 `#seq` 后缀保唯一——否则整键覆盖会连带把先者的注销键也改指过去。
    const base = `${kind}:${label}:${rec.id ? String(rec.id) : String(++seq)}`
    const key = frames.has(base) ? `${base}#${++seq}` : base
    frames.set(key, {
      key, kind, label, el: rec.el, ns: '', cmds: [], ready: false, latestState: null,
      handlers: null, busy: false, queue: [], timer: null, updatedAt: Date.now(), active: true,
    })
    rec.el.__cardKey = key // 反向键：DOM 被拆的挂点（preview-frame 换 label）据此注销，不必另存表
    scheduleCaps()
    return key
  }

  function unregisterFrame(key) {
    const f = frames.get(key)
    if (!f) return
    if (f.timer) clearTimeout(f.timer)
    for (const job of f.queue.splice(0)) job.resolve({ ok: false, error: '卡片已离场' })
    frames.delete(key)
    scheduleCaps()
  }

  // 第一方 inline 卡（无 iframe）：直接挂表，命令走 handlers 直调
  function registerInlineCard(rec) {
    if (!rec || typeof rec !== 'object') return ''
    const key = rec.instanceId || `inline:${rec.label || ''}:${rec.ns || 'card'}`
    frames.set(key, {
      key, kind: 'inline', label: rec.label || '', el: null, ns: rec.ns || '',
      cmds: Array.isArray(rec.cmds) ? rec.cmds.map(String) : [], ready: true, latestState: null,
      handlers: rec.handlers && typeof rec.handlers === 'object' ? rec.handlers : {},
      busy: false, queue: [], timer: null, updatedAt: Date.now(), active: true,
    })
    scheduleCaps()
    return key
  }

  const frameBySource = (src) => {
    if (!src) return null
    for (const f of frames.values()) if (f.el && f.el.contentWindow === src) return f
    return null
  }

  const describe = (t) =>
    [t.label ? `项目=${t.label}` : '', t.ns ? `ns=${t.ns}` : '', t.instanceId ? `实例=${t.instanceId}` : '']
      .filter(Boolean).join(' ') || '(未指定)'

  // 在场 = 帧仍挂在文档里**且处于激活态**。iframe 卡随宿主卡片 DOM 被拆（换 label / 退卡）即失格——以元素
  // isConnected 为准，不要求每个拆除点都记得注销（漏注销只会留个不可达表项，不会让 agent 打到一个已死的帧上）。
  // active（2026-10-26 卡池）：work 右栏多卡并行时同时挂着多枚 iframe，只有当前显示的那枚可寻址——
  // 隐藏帧留在池里仅为「切回不重载」，不参与 resolveTarget/listCaps，否则同 label 多帧会判「目标卡不唯一」。
  const isLive = (f) => !!f.handlers || !!(f.el && f.el.isConnected && f.active !== false)
  const liveFrames = () => [...frames.values()].filter(isLive)
  // 广播面 = 所有仍挂着的帧（含隐藏帧）：「事实类」通知必须让后台卡保持同步（隐藏的 PDF 卡也要跟上
  // 用户新打开的文件），与「指令类」的可寻址面刻意分家。
  const attachedFrames = () => [...frames.values()].filter((f) => f.handlers || (f.el && f.el.isConnected))
  // 卡池切显隐的唯一写口：work 右栏换卡时对旧帧调 off、新帧调 on（registerFrame 缺省 active=true）。
  function setFrameActive(key, on) {
    const f = frames.get(key)
    if (!f || f.handlers) return
    const next = on !== false
    if (f.active === next) return
    f.active = next
    scheduleCaps()
  }

  // 寻址：instanceId 最精确；否则按 label 过滤。ns 只用于构造命令信封，不作筛选键（卡 ready 前宿主
  // 尚不知其 ns，用它筛选会让未就绪的卡不可达）。命中 0/多 → 报错，不猜不兜底。
  function resolveTarget(t) {
    const target = t && typeof t === 'object' ? t : {}
    let list = liveFrames()
    if (target.instanceId) list = list.filter((f) => f.key === target.instanceId)
    else if (target.label) list = list.filter((f) => f.label === target.label)
    if (!list.length) return { error: `目标卡不在场：${describe(target)}` }
    if (list.length > 1) {
      return { error: `目标卡不唯一：${describe(target)}`, candidates: list.map((f) => f.key) }
    }
    return { frame: list[0] }
  }

  // ---------- 宿主保留动词（card:*，整卡显隐，2026-10-13）----------
  // `card:open` / `card:close` / `card:delete`（同义）由总线自答、不发给卡：执行口 slotHost 由宿主侧
  // （feature/preview-frame.js）注入——open = 路由链 '#preview/<label>'（与用户点侧栏项目预览同链），
  // close = 回主页（renderHome 清槽）。card:open 的对象（未显示的卡）不在帧表、不可帧寻址，故按
  // args.label 寻址；card:close/delete 先按 target 验证该卡在场（不在场显式报错，绝不静默退别的卡），
  // inline 卡无宿主槽位显式报错。slotHost 未注入 = 显隐中枢未接，报错不静默。
  let slotHost = null
  function setSlotHost(o) {
    slotHost = o && typeof o.open === 'function' && typeof o.close === 'function' ? o : null
  }
  function callSlotVerb(t, cmd, args) {
    if (!slotHost) return Promise.resolve({ ok: false, error: '宿主未接入显隐中枢（setSlotHost 未注入）' })
    if (cmd === 'card:open') {
      const label = args && typeof args.label === 'string' ? args.label.trim() : ''
      if (!label) return Promise.resolve({ ok: false, error: 'card:open 需要 args.label（项目 label）' })
      return Promise.resolve()
        .then(() => slotHost.open(label))
        .then(
          () => ({ ok: true, result: { card: 'preview', label } }),
          (e) => ({ ok: false, error: String((e && e.message) || e) }),
        )
    }
    const r = resolveTarget(t)
    if (r.error) return Promise.resolve({ ok: false, error: r.error })
    if (r.frame.handlers) return Promise.resolve({ ok: false, error: 'inline 卡无宿主槽位，不支持 card:close/card:delete' })
    return Promise.resolve()
      .then(() => slotHost.close())
      .then(
        () => ({ ok: true, result: { hidden: true } }),
        (e) => ({ ok: false, error: String((e && e.message) || e) }),
      )
  }

  // ---------- 命令通道（卡↔宿主）----------
  // 恒 resolve 一个 ack 对象（**不 reject**：与 gatewayClient 的 sendSessionMessage 同口径，调用方按
  // ok 判成败）；超时由宿主兜底，长动作由卡自己等完再 ack。
  function callCard(target, cmd, args, opts) {
    // 宿主保留动词（整卡显隐）先行分流：总线自答，不发给卡
    if (cmd === 'card:open' || cmd === 'card:close' || cmd === 'card:delete') return callSlotVerb(target, cmd, args)
    const r = resolveTarget(target)
    if (r.error) return Promise.resolve({ ok: false, error: r.error })
    const f = r.frame
    if (f.handlers) return callInline(f, cmd, args)
    if (!f.ns) return Promise.resolve({ ok: false, error: `卡片未就绪（未收到 ready）：${f.key}` })
    const timeoutMs = opts && Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 8000
    return new Promise((resolve) => {
      f.queue.push({ cmd, args: args || {}, resolve, timeoutMs })
      pumpFrame(f)
    })
  }

  function callInline(f, cmd, args) {
    const h = f.handlers[cmd]
    if (typeof h !== 'function') return Promise.resolve({ ok: false, error: `未注册的命令 ${cmd}` })
    try {
      return Promise.resolve(h(args)).then(
        (result) => ({ ok: true, result }),
        (err) => ({ ok: false, error: String((err && err.message) || err) }),
      )
    } catch (err) {
      return Promise.resolve({ ok: false, error: String((err && err.message) || err) })
    }
  }

  function pumpFrame(f) {
    if (f.busy || !f.queue.length) return
    const job = f.queue[0]
    if (!f.el || !f.el.contentWindow) { finishFrame(f, { ok: false, error: '卡片帧已销毁' }); return }
    f.busy = true
    f.timer = setTimeout(() => finishFrame(f, { ok: false, error: `命令超时（${job.timeoutMs}ms）：${cmdLabel(f, job.cmd)}` }), job.timeoutMs)
    try {
      f.el.contentWindow.postMessage({ type: `${f.ns}-cmd`, cmd: job.cmd, ...job.args }, '*')
    } catch {
      finishFrame(f, { ok: false, error: '卡片帧已销毁' })
    }
  }

  const cmdLabel = (f, cmd) => `${f.ns}/${cmd}`

  // 当前在途命令出队（成功/失败/超时都走此处），驱动队列下一拍
  function finishFrame(f, ack) {
    if (!f.busy) return
    if (f.timer) { clearTimeout(f.timer); f.timer = null }
    f.busy = false
    const job = f.queue.shift()
    if (job) job.resolve(ack)
    pumpFrame(f)
  }

  // ---------- 事件订阅（供 feature 层消费卡片上报）----------
  const eventSubs = []
  function addCardEventListener(fn) { if (typeof fn === 'function') eventSubs.push(fn) }
  function emitEvent(ev, data, frame) {
    for (const fn of eventSubs) { try { fn(ev, data, frame) } catch { /* 订阅方异常不打断总线 */ } }
  }

  // ---------- 卡↔卡 broker ----------
  // 别的卡要驱动目标卡，只能对 parent 说 floria-card-call（它拿不到对方的 contentWindow）；
  // 宿主查表转译，ack 原路带回。目标不在场**显式报错、绝不打开/启动它**（避免 agent/卡把用户界面弹来弹去）。
  function routeCardCall(srcFrame, d) {
    const callId = d.callId
    const reply = (payload) => {
      if (!srcFrame.el || !srcFrame.el.contentWindow) return
      try { srcFrame.el.contentWindow.postMessage({ type: 'floria-card-result', callId, ...payload }, '*') } catch { /* 帧已销毁：回执无声丢弃 */ }
    }
    const target = d.target || {}
    const r = resolveTarget(target)
    if (r.error) { reply({ ok: false, error: r.error, candidates: r.candidates }); return }
    if (r.frame.key === srcFrame.key) { reply({ ok: false, error: '卡片不能调用自身' }); return }
    callCard(target, d.cmd, d.args).then((ack) => reply(ack))
  }

  // ---------- 标准事件：src-open（卡内点击 → 宿主打开源文件并滚到行）----------
  // path 口径 = 项目根相对 POSIX（与 /gateway/file?label=&path= 同口径）。门禁：只认「当前工作项目」
  // 的帧——否则一个预览页能把编辑器切到别的项目文件去（跨项目越权）。
  // 「开 + 定位」只给宿主**一个**口 open(path, line)：载入是异步的（读文件 → 灌编辑器），何时能定位是
  // 宿主自己的时序，总线不揣测（旧写法 open() 完就滚，会滚在尚未换掉的上一份文档上）。
  let sourceOpener = null
  function handleSrcOpen(f, d) {
    if (!sourceOpener) return
    const path = typeof d.path === 'string' ? d.path : ''
    if (!path) return
    if (state.sbMode !== 'work' || !state.workProj || f.label !== state.workProj) {
      toast('该卡片不属于当前工作项目，已忽略跳转请求')
      return
    }
    const n = Number(d.line)
    Promise.resolve(sourceOpener.open(path, Number.isFinite(n) && n > 0 ? n : 0))
      .catch(() => { /* 文件打不开：静默（编辑器自会提示） */ })
  }

  // ---------- 宿主→卡 广播（一事实、多收听者）----------
  // 与命令的区别：广播是**事实**（如「用户打开了某文件」），无配对 ack、不指定单一收件人；命令是**指令**、
  // 只发给一张卡且恒有 ack。发送前仍按目标（label/ns/instanceId）筛一遍在场帧，避免跨项目串台。
  // 帧的 ns 由卡自己在 `ready` 里申报，发送时逐帧翻译成 `<ns>-broadcast`——**调用方不必知道卡的命名空间**
  // （与 callCard 拼 `<ns>-cmd` 同一手法）。迟到入场的帧由 ready 时补发（见 onCardEvent），故宿主侧
  // 「先开文件、后挂帧」不丢事实。
  const lastNotes = new Map() // ev → { target, data }
  function broadcast(target, ev, data) {
    const t = target && typeof target === 'object' ? target : {}
    const payload = data && typeof data === 'object' ? data : {}
    lastNotes.set(String(ev), { target: t, data: payload })
    for (const f of attachedFrames()) sendNote(f, t, ev, payload)
  }
  function matchesTarget(f, t) {
    if (t.instanceId && f.key !== t.instanceId) return false
    if (t.ns && f.ns !== t.ns) return false
    if (t.label && f.label !== t.label) return false
    return true
  }
  // 只发 iframe 帧：inline 卡没有 window，广播无落点（需要时另开 handlers 口，勿在此伪造）
  function sendNote(f, t, ev, data) {
    if (!f.el || !f.el.contentWindow || !f.ns || !matchesTarget(f, t)) return
    try { f.el.contentWindow.postMessage({ type: `${f.ns}-broadcast`, ev, ...data }, '*') } catch { /* 帧已销毁：丢弃 */ }
  }
  function replayNotes(f) {
    for (const [ev, rec] of lastNotes) sendNote(f, rec.target, ev, rec.data)
  }

  // ---------- 单一 message 分发 ----------
  // 与既有 5 条 addEventListener('message')（rail-ext / quote / work-mount / msg-actions / ctx-meter）
  // **并存**：那些 handler 对未知 d.type 早退，互不干扰。本件只认卡片 API 信封（<ns>-cmd 的回执、
  // <ns>-event、floria-card-call），双门禁：来源窗口必须命中已注册帧，否则一律丢弃。
  function onMessage(e) {
    const d = e.data
    if (!d || typeof d !== 'object' || typeof d.type !== 'string') return
    if (d.type === 'floria-card-call') {
      const src = frameBySource(e.source)
      if (src) routeCardCall(src, d)
      return
    }
    if (d.type.slice(-6) !== '-event') return
    const f = frameBySource(e.source)
    if (!f) return // 非已注册帧的来源（含别的窗口伪报）不采纳
    const ns = d.type.slice(0, -6)
    if (ns && f.ns !== ns) { f.ns = ns; f.updatedAt = Date.now() }
    onCardEvent(f, d)
  }

  function onCardEvent(f, d) {
    const ev = d.ev
    if (ev === 'ack') {
      // 串行队列下，在途命令恒为 queue[0]；cmd 不符者不配对（防卡异步乱序回执串台）
      if (f.busy && f.queue[0] && (d.cmd === undefined || d.cmd === f.queue[0].cmd)) {
        finishFrame(f, d.ok === false ? { ok: false, error: d.error || '命令失败' } : { ok: true, result: d.result })
      }
      return
    }
    if (ev === 'ready') {
      f.ready = true
      if (typeof d.ns === 'string' && d.ns) f.ns = d.ns
      if (Array.isArray(d.cmds)) f.cmds = d.cmds.map(String)
      f.updatedAt = Date.now()
      scheduleCaps()
      emitEvent('ready', d, f)
      // 迟到入场的帧补发最近广播（ns 此刻才确定）：「用户先开了文件、预览帧后挂」不丢事实
      replayNotes(f)
      return
    }
    if (ev === 'state') { f.latestState = d; f.updatedAt = Date.now() }
    if (ev === 'src-open') { handleSrcOpen(f, d); return }
    emitEvent(ev, d, f)
  }

  // ---------- 能力表 + 上报（agent 侧据此路由）----------
  const listCaps = () =>
    liveFrames().map((f) => ({
      label: f.label, instanceId: f.key, kind: f.kind, ns: f.ns, cmds: f.cmds, ready: f.ready,
    }))

  let gatewaySender = null
  let capsTimer = null
  function scheduleCaps() {
    if (capsTimer) return
    capsTimer = setTimeout(() => { capsTimer = null; reportCaps() }, 50)
  }
  function reportCaps() {
    if (!gatewaySender) return
    try { gatewaySender({ type: 'card-caps', caps: listCaps() }) } catch { /* 未连接：下次表变或 onopen 再报 */ }
  }
  // WS 发送端口由 engine/gateway.js 注入（避免 engine 内成环），注入即补报一次
  function setGatewaySender(fn) {
    gatewaySender = typeof fn === 'function' ? fn : null
    if (gatewaySender) reportCaps()
  }
  function setSourceOpener(o) {
    sourceOpener = o && typeof o.open === 'function' ? o : null
  }

  // ---------- agent 指令入口（gateway.js 的 gws.onmessage 调）----------
  // agent 经网关 POST /gateway/card-call → WS 下行 {type:'card-call'} → 此处 → 目标卡 → ack → WS 上行
  // {type:'card-result'} 回网关 resolve。卡片侧对此全程无感（零改动）。
  function handleGatewayCall(msg) {
    const callId = msg && msg.callId
    callCard(msg && msg.target, msg && msg.cmd, msg && msg.args, { timeoutMs: msg && msg.timeoutMs }).then((ack) => {
      if (!gatewaySender) return
      try {
        gatewaySender({ type: 'card-result', callId, ok: ack.ok !== false, result: ack.result, error: ack.error })
      } catch { /* 连接已断：网关侧按超时收口 */ }
    })
  }

  addEventListener('message', onMessage)

  return {
    addCardEventListener,
    broadcast,
    callCard,
    frames: liveFrames,
    handleGatewayCall,
    listCaps,
    registerFrame,
    registerInlineCard,
    reportCaps,
    setFrameActive,
    setGatewaySender,
    setSlotHost,
    setSourceOpener,
    unregisterFrame,
  }
})()

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
function setSessionCwd(v) { sessionCwd = v }

  // 依赖反转（分层治理 4B，2026-10-10）：engine 不静态 import feature。「CLI 上报模型 → 校准模型 seat」
  // 是输入栏行为（inputbar/model-select.js 的 applySessionModel），改由 app 启动序列经此钩子注入；
  // 未注入时为空操作（initLive 之前必已注入，见 app.js 依赖接线段）。两处调用＝SSE model 事件与
  // 会话全量刷新（refreshSession）。
  let onSessionModel = () => {}
  // 2026-11-06 每会话思考等级（C）：与模型同一条注入钩子——实时刷新回程把该会话上报的档位
  // 交给 feature 层（model-select.js 的 applySessionEffort），座显只看本会话，不串档。
  let onSessionEffort = () => {}

  // 依赖反转（分层治理 4C，2026-10-10）：engine/live.js 不再静态 import chat/inputbar/sidebar——
  // 渲染出口、暂态/stage、可变状态一律经 app 启动序列注入的端口对象访问。端口内的 getter
  // （getLastSegInfo/getCharNote/getPendingUserMsgs/getTakeover/getFirstSendHash）每次调用现读 feature
  // 模块的可变绑定，调用侧严禁缓存返回值（缓存即与 owner 的实时状态脱钩）；写侧只在需要时调端口回调。
  // 端口注入先于 initLive（app.js 依赖接线段），故此处空对象占位即可，无需兜底分支。
  let liveMsgPort = {}   // chat/messages.js 的读基元 + 可变渲染态读取口（isRealUser/fmtDur/messagesHtml/…）
  let liveUiPort = {}    // 渲染/暂态/导航出口（renderTransient/renderSettle/renderRecent/renderTaskDock/…）
  let liveStagePort = {} // 两层消息流 stage（stage 对象 + stageStart）
  let liveStatePort = {} // 可变状态读写口（takeover/firstSendHash/pendingUserMsgs）

  // ---------- 实时同步（阶段1：SSE 监听 jsonl 变化，自动刷新会话/列表）----------
  // 兼容：刷新只替换 messagesEl 内层，折叠开合（含网关实时折叠）与滚动位置尽量保留；
  // 只读视图下最后一段「处理中（尚无回复）」的已处理折叠默认展开，回复落地后自动收起。

  // 前端资产版本自愈（2026-09-17）：守护不变量 = 运行中的前端代码 = 网关当前资产版本。
  // 换 exe/新构建后旧标签页只重连 WS/SSE、不重载 JS（代码还是页面加载时那份），修复永远
  // 送达不了常开标签页（三轮「修复没生效」实报的交付根因）。hello（每次 SSE 建连/重连都发）
  // 时拉服务器 sw.js 的 CACHE 版本与页面加载时基线比对：漂移即自动刷新（输入栏有内容则只
  // 提示不强刷，不毁用户正在输入的内容）。重载后新基线同版本 → 无回环。
  let bootSwVer = null
  async function checkAssetFresh() {
    try {
      const res = await fetch('/sw.js', { cache: 'no-store' })
      const m = /CACHE\s*=\s*'([^']+)'/.exec(await res.text())
      if (!m) return
      if (bootSwVer == null) { bootSwVer = m[1]; return }
      if (m[1] === bootSwVer) return
      bootSwVer = m[1]
      if (serializeInput().trim()) { toast('前端有新版本，请手动刷新页面'); return }
      toast('前端已更新，正在刷新…')
      setTimeout(() => location.reload(), 800)
    } catch { /* 离线等瞬时失败忽略，下次 hello 再对 */ }
  }

  // ——SSE 连接监督者（2026-10-14 GPT 定案第一阶段①②④）——
  // 不变量：下行 SSE 的生命周期由监督者统一编排，与 WS 心跳链联动——WS open → 强制重建 SSE
  //（重建后 hello → refreshSession 全量对账，重建瞬间丢的 delta 由快照覆盖）；WS close →
  // 关 SSE 一并等 WS 重连。SSE 自身活性由双侧检测：服务端 15s 命名 heartbeat（localGateway
  // startSseHeartbeat），客户端 watchdog 45s 无任何数据 → 重建 SSE（容忍丢 2 次心跳）；连续
  // 3 次重建失败判「网关不可达」→ 触发 WS 重连链（onclose → 4s → onopen → noteWsOpen 重建 SSE）。
  // generation（esGen）防旧连接晚到事件污染新状态：每次重建/关闭 +1，旧代回调整帧丢弃。
  let esGen = 0
  let lastSseDataAt = 0 // 任何下行数据（含 heartbeat）到达时刻 = watchdog 基点（不分会话/类型，监督者只管链路活性）
  let sseFailStreak = 0
  let watchdogTimer = null
  const SSE_WATCHDOG_MS = 45_000 // 45s 无任何数据（15s 心跳 ×3 窗口）
  const SSE_RECONNECT_DELAY_MS = 3000

  function closeEs() {
    if (live.es) { try { live.es.close() } catch { /* 已断忽略 */ } live.es = null }
  }

  function rebuildEs() {
    if (!('EventSource' in window)) return
    if (needToken()) return // token 门锁定态：不建 SSE（避免 401 重连刷屏，hideGate 解锁后再建）
    closeEs()
    esGen++
    const gen = esGen
    lastSseDataAt = Date.now()
    const es = new EventSource(apiUrl('/gateway/events'))
    live.es = es
    es.onmessage = (e) => {
      if (gen !== esGen) return // 旧代连接的晚到事件：整帧丢弃
      sseFailStreak = 0
      lastSseDataAt = Date.now()
      handleSseMessage(e)
    }
    // heartbeat 是命名事件（event: heartbeat），EventSource 走 addEventListener，不进 onmessage
    es.addEventListener('heartbeat', () => {
      if (gen !== esGen) return
      sseFailStreak = 0
      lastSseDataAt = Date.now()
    })
    es.onerror = () => {
      if (gen !== esGen) return
      closeEs()
      sseFailStreak++
      if (sseFailStreak >= 3) { sseFailStreak = 0; forceWsReconnect() }
      setTimeout(() => { if (gen === esGen) rebuildEs() }, SSE_RECONNECT_DELAY_MS)
    }
  }

  // watchdog（GPT 定案④）：查「长时间没收到任何数据」——TCP 半开（无 FIN/RST）时 onerror 不
  // 触发，唯一客户端侧观测手段是数据断流。与服务端 heartbeat 的写入错误/背压检测不可互替。
  function startSseWatchdog() {
    if (watchdogTimer) return
    watchdogTimer = setInterval(() => {
      if (!live.es) return // 重建窗/已移交 WS 重连链，不重复计数
      if (Date.now() - lastSseDataAt <= SSE_WATCHDOG_MS) return
      lastSseDataAt = Date.now()
      sseFailStreak++
      if (sseFailStreak >= 3) { sseFailStreak = 0; forceWsReconnect(); return }
      rebuildEs()
    }, 5000)
    watchdogTimer.unref?.()
  }

  // 监督者联动口（gateway.js WS onopen/onclose 调用）
  function noteWsOpen() { sseFailStreak = 0; rebuildEs() } // WS 重连成功 = SSE 复活信号：强制换新连接（hello 全量对账）
  function noteWsClosed() { closeEs(); esGen++ } // WS 断开：SSE 一并关，待 WS 重链后统一重建

  // 启动入口（app.js 启动序列 + hideGate 解锁后调用）。已在监督态（live.es 在场 = watchdog 已启）不重复；
  // 否则建连 + 启 watchdog。此后 SSE 重建/联动一律走监督者（noteWsOpen/noteWsClosed/rebuildEs）。
  function initLive() {
    if (!('EventSource' in window)) return
    if (live.es) return // 防重建（hideGate 每次 WS 重连都会跑）：重复 new 泄漏旧 SSE 连接+事件双发
    rebuildEs()
    startSseWatchdog()
  }

  function handleSseMessage(e) {
    let ev
    try { ev = JSON.parse(e.data) } catch { return }
    if (ev.type === 'hello') { refreshList(); refreshSession(); checkAssetFresh() }
    else if (ev.type === 'activity') {
        // 状态点翻转即时刷新（网关 /gateway/activity 群发，2026-08-29）。
        // 2026-09-07 断连感知：state=null（CLI /clients 断开 → 网关 detach 群发）= 会话进程
        // 断开 → 该会话状态点立即熄（不等 600ms 防抖重拉），当前打开的会话立即收口运行态
        //（「正在思考/正在处理」停表），不再冻结在断流前的最后快照上假绿假转。
        if (ev.state == null && typeof ev.session === 'string') {
          const s = ALL.find((x) => hashOf(x) === ev.session)
          if (s && s.state) { s.state = null; liveUiPort.renderRecent() }
          if (ev.session === live.curUuid) refreshSession(true)
        }
        // 2026-09-07 状态恢复对称刷新：state 由真空恢复（CLI 重连重报/60s 心跳补报——网关重启
        // 清 sessionActivity 后的空窗）时，当前会话视图同样立即重渲。否则真空窗里的误收口
        // （state=null 被 closeSeg 判「进程不在线」→ 活回合冻结成「已处理」停表）要等下一次
        // jsonl 落盘才翻回，glm 长思考期可达十几分钟（Pj5 会话重启实证）。不变量：当前会话
        // 视图状态显示收敛到网关最新 state，null↔非 null 两向同治。
        else if (typeof ev.session === 'string' && ev.session === live.curUuid) refreshSession()
        refreshList()
      }
      else if (ev.type === 'session-down') {
        // 2026-09-07 进程退出显式告知：detach 且 pid 已死（非重连窗）→ 网关群发。收口运行态
        // + toast 指路（转录在磁盘，列表点开即 resume 重开，积压消息自动补投）。
        if (typeof ev.session === 'string') {
          const s = ALL.find((x) => hashOf(x) === ev.session)
          if (s && s.state) { s.state = null; liveUiPort.renderRecent() }
          if (ev.session === live.curUuid) refreshSession(true)
          toast('会话进程已退出，可从列表点开重开（转录已保留）')
        }
      }
      else if (ev.type === 'session-up') {
        // 2026-09-07 会话进程回归（/clients 注册成功）：刷新列表与当前会话；状态点恢复由
        // CLI 注册后的 activity 上报/60s 心跳随后到达，网关不代答状态。
        refreshList()
        if (ev.session === live.curUuid) refreshSession()
      }
      else if (ev.type === 'turn-beat') {
        // 2026-09-07 僵死感知：引擎增量心跳（CLI setResponseLength → gatewayClient 4s 节流）
        // → 记 per-session 最后活性时刻。bindLiveFoldTimer tick 对账：运行态持续而 beat 缺席
        // 或落后超阈值 = 引擎无真实进展（进程/WS 活但 query 链僵死）→ 计时行标「无响应」。
        if (typeof ev.session === 'string') live.turnBeat.set(ev.session, Date.now())
      }
      else if (ev.type === 'queue-state') {
        // 2026-08-30 队列快照增量（清单#2/#4）：CLI commandQueue 变化 → 网关 SSE 群发（事件体
        // 直接带 items 全量快照）→ 当前会话置底排队区即时重渲，不等 400ms 防抖的 refreshSession。
        if (live.curUuid && ev.session === live.curUuid) {
          live.queueRemote = Array.isArray(ev.items) ? ev.items : []
          liveMsgPort.queueClaimAdopt(live.queueRemote) // 队首主张收编（同回程入口：CLI 端/另一端入队的瞬态同样立即主张化）
          liveUiPort.renderTransient() // 暂态区对账重渲（2026-09-07 收编：远端快照更新与气泡/主张折叠同趟对账）
        }
      }
      else if (ev.type === 'task-state') {
        // 2026-09-10 任务浮窗链：CLI TodoV2 清单快照（useTasksV2 单源出口）→ 网关 SSE 群发
        //（事件体直接带 tasks 全量快照）→ 底栏任务浮窗即时重渲，不等 gss 防抖的 refreshSession。
        // 空数组 = 清单清空/隐藏 → 浮窗整体不出现（与 CLI「tasks.length===0 → null」同一判定）。
        if (live.curUuid && ev.session === live.curUuid) {
          live.tasks = Array.isArray(ev.tasks) ? ev.tasks : []
          liveUiPort.renderTaskDock()
        }
      }
      else if (ev.type === 'model') {
        // 2026-09-19 模型实时校准（用户「CLI 切了模型、web 底栏不动」）：CLI 每会话实际模型变化 →
        // 网关 /gateway/model-report 落值后 SSE 群发（事件体带 model + modelTs）。此前 web 只能等
        // 下一次 /gateway/session 拉取才校准，会话空闲时长时间不来 → 底栏停在旧模型。
        // 仅当前会话采纳（其它会话的模型变化与本会话底栏无关），冲突判定见 applySessionModel。
        if (live.curUuid && ev.session === live.curUuid) onSessionModel(ev.model, ev.modelTs)
      }
      else if (ev.type === 'session-delta') {
        // 2026-09-08 事件流统一 P1（方案 20260908135557）：引擎变化 delta 直达——CLI 过滤投影
        //（filterConversationForDisplay 权威单源）的「锚点 + 其后整体替换」增量（anchorSid =
        // 分歧点前一条的稳定键，messages = 分歧点起的尾部；append/末条 blocks 更新/段收口统一
        // 此编码，幂等）。
        // 2026-09-10 协议根修：CLI 侧输入是 capRenderedMessages 的 200 条尾部窗口、本地是全量
        // 投影，两侧长度与 normalizeMessages 派生的 uuid 规则都不同——旧「数字坐标 base +
        // 长度拼接」在长会话下恒被判「历史截断」拒收 → 全量对账风暴 → 回合中零更新（Bash/Edit
        // 零提示实证）。改以内容标识 sid 定位锚点，长度差异不再参与判定。
        // seq 每会话单调：连续 → 应用进本地基线走 renderSessionBody（与全量对账同一渲染出口，
        // absorbPending/renderTransient/钉顶/计时不变量同源）；重复忽略；gap/无基线/无锚点 →
        // refreshSession(true) 全量对账重建基线（分布式流缺失恢复标准形态，对账源 = /gateway/
        // session，display 链 P1 存活）。本回调同步执行无 await，无切会话写穿窗口。
        if (ev.session !== live.curUuid) return
        if (typeof ev.seq !== 'number' || !Number.isInteger(ev.seq) || ev.seq <= 0) return
        if (live.deltaSeq == null) { refreshSession(true); return }
        if (ev.seq <= live.deltaSeq) return
        if (ev.seq !== live.deltaSeq + 1) { refreshSession(true); return }
        if (!Array.isArray(ev.messages) || !ev.messages.length) return
        const cur = Array.isArray(live.localMessages) ? live.localMessages : null
        const anchor = typeof ev.anchorSid === 'string' ? ev.anchorSid : ''
        if (!cur || !anchor) { refreshSession(true); return }
        const idx = cur.findIndex((m) => m && m.sid === anchor)
        // 塌缩防护（不变量）：CLI 恒发 ≤200 条尾部窗口，锚点 = 分歧点前一条 → 锚点之后的本地
        // 条目必然落在投影窗口量级内。超出 512（窗口 200 的保守余量，含跨轮多次 delta 前移）
        // = CLI state 塌缩/失步瞬态（压缩边界/reactive compact），此时应用会截断已提交历史
        //（2026-09-09 录屏实证：web 数组被切到仅剩一条用户消息）→ 走对账链，不应用。
        if (idx === -1 || cur.length - idx - 1 > 512) { refreshSession(true); return }
        live.localMessages = cur.slice(0, idx + 1).concat(ev.messages)
        live.deltaSeq = ev.seq
        renderSessionBody(live.localMessages, { force: false, hash: state.currentHash })
      }
      else if (ev.type === 'compact-state') {
        // 2026-09-04 压缩实时态（queue-state 同款链）：CLI onCompactProgress → 网关 SSE 群发。
        // 压缩进行中 jsonl 零写入 → SSE 'updated' 不来，本事件是「正在压缩」唯一实时源。
        // Map 按会话 uuid 存到达时刻（render 侧 5min TTL 防 compact_end 丢失后卡死），结束即删。
        if (typeof ev.session === 'string') {
          if (ev.active) live.compactFlags.set(ev.session, Date.now())
          else live.compactFlags.delete(ev.session)
          if (ev.session === live.curUuid) refreshSession()
        }
      }
      else if (ev.type === 'turn-state') {
        // 2026-09-06 打断收口链：CLI onCancel → 网关 SSE（compact-state 同款链）。打断后 jsonl
        // 零写入 → SSE 'updated' 不来，本事件是「回合被中止」唯一实时源——记 per-session 时刻
        // （closeSeg 以「段末落盘 ts < 该时刻」判 finished 收口「已处理」），jsonl 永无该回合回复
        // → 无 TTL（防重建后运行态复活）。jsonl 无变化 sig 不变 → refreshSession(true) 强制重渲。
        if (typeof ev.session === 'string' && ev.live === false) {
          live.turnEndFlags.set(ev.session, Date.now())
          if (ev.session === live.curUuid) {
            live.streamText = '' // 2026-09-08 流式字符通道：回合中止 = 暂态收口（CLI 已 streamClear 同发，双端确定性）
            refreshSession(true)
          }
        }
      }
      else if (ev.type === 'stream-text') {
        // 2026-09-08 流式字符通道：CLI 引擎流式 delta（thinking/text，onUpdateLength 单路累积
        // 100ms 合帧全文快照）→ 运行态状态显示行（.think-state）后/乐观主张折叠体内流式预览。
        // 纯显示暂态：不进 localMessages 权威基线、不落盘；空串 = 块边界/消息落盘清除（权威
        // delta 随后接管）。applyStreamPreview 直写 textContent，不走整页重建；重渲洗 DOM 后由
        // renderSessionBody 出口重挂恢复。
        if (ev.session === live.curUuid) {
          live.streamText = typeof ev.text === 'string' ? ev.text : ''
          applyStreamPreview()
        }
      }
      else if (ev.type === 'restored') {
        // 2026-09-06 撤回链：CLI auto-restore（web 打断且无 meaningful 响应）→ 文本回填本端输入栏
        // + 对话流摘该条开启气泡（jsonl 不删，渲染按 flag 永久跳过该 user——无 TTL 防气泡复活）。
        // 打断时输入栏必空（停止键只在输入栏空时显示，v213 定案），有内容时不覆盖（同 CLI 守卫语义）。
        // 撤回动画（同日二轮，用户反馈瞬间消失生硬）：气泡先塌缩淡出再重渲——定位 = body 文本
        // 匹配 restored 文本的最后一个 user 气泡（打断撤回时队列必空 = 流尾气泡）；找不到直接重渲。
        if (typeof ev.session === 'string' && typeof ev.text === 'string') {
          live.restoredFlags.set(ev.session, { ts: Date.now(), text: ev.text })
          if (ev.session === live.curUuid) {
            // 撤回 = 该条乐观主张一并作废（jsonl 永无该 user，absorbPending 永不命中）——
            // 不同步丢弃 pending 项，renderTransient 会让主张气泡/折叠复活（幻影回流）。
            const t0 = ev.text.trim()
            const pend0 = liveStatePort.getPendingUserMsgs()
            const n0 = pend0.length
            liveStatePort.setPendingUserMsgs(pend0.filter((p) => {
              const inCur = p.hash === state.currentHash || (p.hash === '' && liveStatePort.getFirstSendHash() === state.currentHash)
              if (!inCur) return true
              return String(p.text || '').replace(/\s*\[Image #\d+\]/g, '').trim() !== t0
            }))
            if (liveStatePort.getPendingUserMsgs().length !== n0) liveUiPort.renderTransient()
            if (!serializeInput().trim()) {
              composerSetText(ev.text)
              liveUiPort.syncGwSend()
              composerFocus()
            }
            const t = ev.text.trim()
            const bubbles = [...messagesEl.querySelectorAll('.msg.user[data-t="u"]')].filter(el => (el.querySelector('.body')?.textContent || '').trim() === t)
            const el = bubbles[bubbles.length - 1]
            if (el && !el.classList.contains('msg-out')) {
              el.style.maxHeight = el.scrollHeight + 'px'
              void el.offsetHeight // 强制 reflow：让 max-height 初值生效后再过渡到 0
              el.classList.add('msg-out')
              setTimeout(() => { el.remove(); refreshSession(true) }, 360)
            } else {
              refreshSession(true)
            }
          }
        }
      }
      else if (ev.type === 'ws-failed') {
        // 2026-09-06 wsession 异步化失败链：后台 spawn/注册失败（含 20s 注册超时）→ 网关 SSE 群发。
        // 收尾不留静默：清首条事务 + 移除合成列表条目 + toast 报错；当前正看该会话 → 回首页。
        if (typeof ev.session === 'string') {
          if (liveStatePort.getFirstSendHash() === ev.session) liveStatePort.setFirstSendHash('')
          setAll(ALL.filter((s) => hashOf(s) !== ev.session))
          liveUiPort.renderRecent()
          toast('web 会话启动失败：' + (ev.error || '未知错误'))
          if (state.currentHash === ev.session) liveUiPort.navigate('#/')
        }
      }
      else if (ev.type === 'updated') {
        if (ev.hash === state.currentHash) refreshSession()
        refreshList()
      }
  }

  function refreshList() {
    if (live.listT) return
    live.listT = setTimeout(async () => {
      live.listT = null
      if (needToken()) return // token 门锁定态
      try {
        const res = await fetch(apiUrl('/gateway/sessions'))
        const data = await res.json()
        if (!Array.isArray(data.sessions)) return
        applyTurnEndAt(data.sessions) // sig 短路前恢复：turnEndAt 新增不改 listSig，不能被短路跳过
        const sig = listSigOf(data.sessions)
        if (sig === live.listSig) return
        live.listSig = sig
        // 保留展开中的项目文件夹
        const openF = [...bodyEl.querySelectorAll('.folder.open')].map((f) => f.dataset.f)
        setAll(withSynthetic(data.sessions))
        applyTurnEndAt(ALL)
        liveUiPort.renderRecent()
        if (openF.length) {
          for (const f of bodyEl.querySelectorAll('.folder')) {
            if (openF.includes(f.dataset.f)) f.classList.add('open')
          }
        }
      } catch { /* 瞬时错误忽略 */ }
    }, 600)
  }

  // 2026-08-24 回合进行中探测（refreshSession 处理折叠抑制窗用）：末段是否仍处理中。
  // 复刻 messagesHtml closeSeg 的 finished 判定——末条 assistant 纯文本回复（无 tool_use）= 回合结束；
  // 刚发的真实用户消息 / thinking / tool_use / tool_result / 其余 = 处理中（等待回复）。
  // system/progress/attachment 等非内容记录跳过（jsonl 末尾常有 progress 尾巴）。仅此一处轻量判定，
  // 数据渲染权威仍在 messagesHtml；折叠关闭后交回下方整页数据渲染一次性出最终态。
  function segIsProcessing(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'system' || m.role === 'progress' || m.role === 'attachment') continue
      if (liveMsgPort.isRealUser(m)) return true // 刚发的用户消息（assistant 回复未到）= 处理中
      if (m.role === 'assistant') {
        // 2026-08-26：stopReason 精确判定（stop_reason=null 的旁白/工具=处理中，end_turn/stop_sequence=结束）；
        // 字段缺失（旧数据 undefined）回落旧启发式
        if (m.stopReason !== undefined) return !liveMsgPort.isEndStop(m.stopReason)
        const hasText = m.blocks.some((b) => b.kind === 'text' && b.text && b.text.trim())
        const hasTool = m.blocks.some((b) => b.kind === 'tool_use')
        return !(hasText && !hasTool)
      }
      return true
    }
    return false
  }

  // 回退快照防御（2026-09-11 三诊根治「发送瞬间跳到上一条消息」真主链）：全量快照必须单调
  // 前进。网关 /gateway/session = 磁盘 jsonl 全量 + CLI 异步上报窗口合并（localGateway.ts
  // mergeDisplayMessages），回合开启时序窗内两源都可能短暂落后（dequeue 落盘前 / display 缓冲
  // 重建期）→ 同一会话先后两次 fetch 可能拿到「已渲染内容消失」的回退快照（20260911203904
  // 录像三态实证：回合4权威渲染在屏 → 0.1s 后被旧快照整页重建洗掉 → hasNewUser 在回退数据上
  // 把上一回合误判为「新用户消息」stageStart 重钉 =「跳到上一条消息」；随后 delta gap 强制对账
  // 撞上空窗，force 绕过下方空 fetch 守卫整页清空 = 空白窗口）。回退快照一律整帧丢弃：不渲染、
  // 不重写 localMessages/deltaSeq 基线、不碰 cwd/模型/队列/任务槽，等下一条 SSE/落盘触发的新
  // 快照自然恢复。合法重渲（撤回/turn-state 收口）ts 持平放行；压缩收口 summary ts 前进放行；
  // 首载/切会话基线为 null 无从回退放行。
  function snapshotStale(local, incoming) {
    if (!Array.isArray(local) || !local.length) return false
    if (!Array.isArray(incoming) || !incoming.length) return true
    const maxTs = (msgs) => {
      let t = 0
      for (const m of msgs) {
        const ts = m && m.timestamp
        if (typeof ts === 'number' && ts > t) t = ts
      }
      return t
    }
    const cur = maxTs(local)
    const next = maxTs(incoming)
    return next > 0 && cur > 0 && next < cur
  }

  function refreshSession(force) {
    const hash = state.currentHash
    if (!hash) return
    if (live.sessT) return
    live.sessT = setTimeout(async () => {
      live.sessT = null
      if (state.currentHash !== hash) return
      const s = findSession(hash)
      if (!s) return
      try {
        const { messages, context, model, modelTs, effort, cwd, queued, tasks, file, deltaSeq } = await fetchMessages(s.id)
        // 2026-08-30 串会话根治：会话校验只在 await 前做过一次 → fetch 回程期间用户切到其它
        // 会话时，本响应（A 的整份消息/cwd/模型/上下文/队列快照）会写穿全部全局槽并把 A 的
        // 历史 innerHTML 整页渲染进新会话 DOM（CLI 单进程单会话无此异步边界，web 必须在每个
        // 异步边界重验身份）。await 后已切走 → 本响应整体作废。
        if (state.currentHash !== hash) return
        // 回退快照防御（snapshotStale）：必须先于一切副作用与基线赋值——旧快照哪怕被下方
        // 空 fetch 守卫挡住不渲染，基线（localMessages/deltaSeq）也已被静默回写，后续 delta
        // 判 gap 反复触发强制对账（回退风暴）。丢弃 = 本响应整体作废。
        if (snapshotStale(live.localMessages, messages)) return
        setSessionCwd(cwd)
        // 2026-08-30 队列快照：jsonl 文件名（uuid）供 SSE queue-state 会话匹配；queued 交排队区
        live.curUuid = file ? file.replace(/\.jsonl$/, '') : live.curUuid
        live.queueRemote = queued
        // 2026-09-10 任务浮窗首载/刷新：与 SSE task-state 增量同构（全量快照 → 整窗重渲）
        live.tasks = tasks
        liveUiPort.renderTaskDock()
        onSessionModel(model, modelTs) // 2026-08-24：实时刷新同样按 CLI 上报模型校准 seat（注入的钩子）
        onSessionEffort(effort) // 2026-11-06 思考等级同链：缺键 = 该会话没改过档，null = 明确 Off
        liveUiPort.renderCtxMeter(context)
        // 2026-09-08 事件流统一 P1（方案 20260908135557）：全量回程 = 权威快照，重置本地 delta
        // 基线（localMessages 副本 + 网关 seq 记账）。此后 session-delta SSE 按「尾部替换」增量
        // 演进副本；fetch 回程是基线唯一重置点（单源），gap/失步由本函数全量对账恢复。
        live.localMessages = messages
        live.deltaSeq = deltaSeq
        renderSessionBody(messages, { force, hash, adoptQueue: queued })
      } catch { /* 瞬时错误忽略 */ }
    }, 400)
  }

  // 渲染统一出口（2026-09-08 事件流统一 P1 提取；方案 §5.5「应用 delta 后同样走既有出口对账」）：
  // 全量对账（refreshSession fetch 回程）与 session-delta 增量应用共用同一条渲染路径——首条消息
  // 事务收口/接管帧、absorbPending、暂态区对账、sig 幂等判定、增量末段替换或整页重建、计时/钉顶/
  // 滚动全部同源，渲染不变量不因入口分叉（状态源不增加）。opts.adoptQueue 仅全量回程携带
  //（queued 载荷驱动的队首主张收编；delta 路径无 queued 载荷，queue-state SSE 自有入口）。
  function renderSessionBody(messages, opts) {
    const { force, hash, adoptQueue } = opts
    // 首条消息事务收口（2026-09-06）：本会话真实数据已落盘（SSE 接管起点）→ 销毁事务，
    // queue-dock 恢复正常渲染。与 renderSession fetch 回程的收口同一判定、双入口对称。
    // 接管帧（用户「两个状态的『正在处理』定位不同」根治）：乐观气泡/proc 折叠无 data-m，
    // stampMsgIn 的 prev 采集命中不了 → 接管重建把同位真实元素判「新增」重播 fadeup
    //（气泡+「正在处理」跳变重现）→ txTakeover 帧跳过 stampMsgIn（同位换皮不是新增）；
    // 乐观 proc 计时起点（发送瞬间 T0）早于落盘 user ts（异步化后消息经暂存补投）→
    // 移交 live.txProcStart 供 bindLiveFoldTimer 续算，「正在处理 Xs」跨接管连续不回跳。
    let txTakeover = false
    // 接管帧判定（2026-09-07 推广）：乐观开启气泡在屏（无 data-m 的 data-t="u"——真实渲染恒带
    // data-m、引导气泡另带 data-g，无 data-m 的 user 气泡只可能是乐观 DOM）即乐观权威期，
    // 不再只认 firstSendHash（web 新建事务）：CLI 启动会话的 web 首条消息同样经「乐观气泡→
    // 落盘接管」同位换皮，漏判则真实气泡被 stampMsgIn 判「新增」重播 fadeup = 闪动。
    if (messages.length > 0 && (liveStatePort.getFirstSendHash() === hash || messagesEl.querySelector('[data-t="u"]:not([data-m])'))) {
      txTakeover = true
      for (const p of liveStatePort.getPendingUserMsgs()) if (p.hash === '') p.hash = hash // 事务归属落定：'' 项归入本会话（吸收判定依赖 p.hash===cur）
      live.txProcStart = liveUiPort.claimStartTs()
      if (liveStatePort.getFirstSendHash() === hash) liveStatePort.setFirstSendHash('')
    }
    live.lastDataTs = (messages.length && messages[messages.length - 1].timestamp) || live.lastDataTs
    // 2026-09-02 排队图 id 防撞：扫描当前会话 display 已用最大 imageId（CLI getInitialPasteId
    // 同法），gwSend 分配 id 从 max+1 起——同会话多条带图消息 id 互不复用，file-cache 字节
    // 不再互覆（原恒从 1 起，第二条覆盖第一条 → 历史图错图）。
    // 2026-09-16 单调不回卷根修：视图（localMessages）在压缩归档/delta 重写窗口会丢历史块，
    // 清零重扫会把 maxImgId 回卷 → 下张图复用旧 id → CLI storeImage('w') 覆写字节 + 网关
    // max-age=86400 把首次取到的旧字节钉在该 URL 上 = 新图显示成旧图（b5bd1265 实证 A/B/C
    // 三图全 1 号互覆）。id 不复用是分配器不变量，不依赖视图完整：重扫只增不减（跨会话切回
    // 基准偏高无害，file-cache 按会话分目录，id 只需会话内唯一）。
    for (const m of messages) {
      for (const b of m.blocks || []) {
        if (b.kind === 'image' && typeof b.imageId === 'number' && b.imageId > live.maxImgId) live.maxImgId = b.imageId
      }
    }
    // 2026-08-29 待落盘乐观消息吸收判定：jsonl 已出现该文本（单条落盘或 drainCommandQueue
    // 多条合并成一条，join 后 includes 命中）→ 真实气泡已由渲染权威接管，不再重插
    liveMsgPort.absorbPending(messages)
    if (adoptQueue) liveMsgPort.queueClaimAdopt(adoptQueue) // 队首主张收编（刷新两段式根治，形态由 renderTransient 按 authLive 定）
    liveUiPort.renderTransient() // 暂态区对账重渲（吸收变化/远端快照更新后；权威重建后由下方再渲带降级判定）
    const last = messages.length ? messages[messages.length - 1] : null
    const sig = messages.length + ':' + (last ? (last.timestamp || '') : '') + ':' + (last && last.blocks.length ? last.blocks[last.blocks.length - 1].kind : '')
    // 新增用户消息检测（实时同步的钉顶触发点）：末尾真实用户消息索引/时间变了 = 新回合。
    // 注入引导消息（injected:true）不触发钉顶（用户定案：引导消息不钉顶，钉顶只属于新回合开启消息）
    let lastU = -1
    for (let i = messages.length - 1; i >= 0; i--) if (liveMsgPort.isRealUser(messages[i]) && !messages[i].injected) { lastU = i; break }
    const uSig = lastU >= 0 ? lastU + ':' + (messages[lastU].timestamp || '') : ''
    const hasNewUser = live.lastUserSig !== '' && uSig && uSig !== live.lastUserSig
    // 基线推进规则（2026-09-08 二轮根修）：无新回合（含 lastUserSig==='' 的基线补齐）→ 直接
    // 跟随；hasNewUser 帧不在此推进——钉顶触发未命中气泡时保留旧基线 = 下帧 hasNewUser 仍真
    // = 重试，直到气泡在屏命中才随 pinnedUserSig 一并推进（见下方触发块）。v261 注释宣称
    // 「未命中保留重试」，但此处无条件推进使 hasNewUser 下帧即假、重试永不发生。
    if (uSig && !hasNewUser) live.lastUserSig = uSig
    // 2026-08-26 定案：处理中段实时重建。原 2026-08-24 抑制逻辑（回合进行中跳过整页 innerHTML 重建）
    // 假设实时折叠由 WS out 增量填充——但网关从不给 web 发 out 消息（实时流走 SSE：conversationDisplay
    // 上报 + jsonl + 列表刷新），WS out 是死代码 → 处理中折叠一直空白（用户反馈「完全没有渲染，并且也不同步」）。
    // 现改为：回合未结束（数据在增长或 segIsProcessing）→ 照常整页重建，messagesHtml 对处理中段走
    // liveFoldBody 只渲染一个工具折叠行（「正在运行：<当前工具>」轮转；400ms 去抖已限频，SSE 逐条写入时最多 ~2.5 次/秒）；
    // 回合结束（末段回复落地）→ 关掉空 proc 折叠交回下方数据渲染一次性出最终态（已处理时长/回复/变更卡）。
    // 2026-09-06 空 fetch 不洗盘：发送瞬间乐观气泡（data-t="u"）/乐观折叠已上屏，jsonl 尚未
    // 落盘的窗口期 SSE 触发 refreshSession 拿到空 messages → 整页重建把乐观气泡洗成
    // 空白消息区，落盘后才恢复（用户实测「刷新两次+空态一闪」根因；原空态占位行 2026-09-07 移除）。
    // 消息区已有内容且数据为空 = 落盘窗口，跳过本次渲染保留乐观 DOM，等真实数据接管。
    // force 例外：restored 撤回链靠重渲收口（含空态），必须放行。
    if (!force && !messages.length && messagesEl.querySelector('[data-m], [data-t="u"], details')) return
    if (sig === live.curSig && !force) return // force=true：turn-state/restored 等运行态信号到达，jsonl 无新落盘也强制重渲收口
    live.curSig = sig
    const sc = $('chat-scroll')
    const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 80
    // 2026-08-26 增量重建根治：SSE 实时推送只追加/改写尾部「处理中段」，历史消息不变。
    // 对处理中末段只替换该段 DOM（applySegDelta，头部保留）→ 消除每次推送整页 innerHTML
    // 重建的闪烁，且 tool-running 光泽动画不再被重建打断（2.6s 扫光能完整播放）。
    // 条件：上次渲染存在 + 消息数只增不减（SSE 纯追加；回退/压缩等减少则整页）+ 有处理中末段。
    // 回复落地（段结束）/新回合/消息数减少 → 整页重建一次（低频，带「已处理」收拢可接受）。
    // 2026-09-18 卡顿根治（增量帧省历史段渲染）：原实现每帧无条件全量 messagesHtml 序列化整个
    // 会话，而历史段自上轮渲染以来内容不变、增量路径只消费末段 html——长会话下每条 session-delta
    //（引擎变化合帧最高 ~10 次/秒）都付 MB 级字符串拼接 + md 全文重解析 = 主线程卡顿主根。改惰性
    // 两段式：先 lazy 切段（历史段只切段不生成 HTML，O(N) 轻量；末段真渲染产出本轮 lastSegInfo/
    // charNote）→ 判定可增量直接 applySegDelta（历史段零渲染成本）；不可增量（切段边界/回合收口/
    // 锚点缺失）再跑全量渲染付全额——行为与原等价，全量频次=切段边界（低频）。
    liveMsgPort.messagesHtml(messages, true)
    // 2026-08-29 吞消息根治：末条真实用户消息（常为刚落盘的引导消息）气泡若不在 DOM（中间段
    // 新增，乐观气泡已被洗掉），增量路径只贴末段永远补不上 → 强制整页重建一次补齐；气泡在位
    // 后续轮次恢复增量（只多一次整页，折叠开合/入场动画已有恢复机制）。
    let lastRealUser = -1
    for (let i = messages.length - 1; i >= 0; i--) if (liveMsgPort.isRealUser(messages[i])) { lastRealUser = i; break }
    // 2026-08-29 引导消息折叠链：引导消息气泡 data-m=段 key ≠ 自身索引 → 额外带 data-g=自身索引，
    // 此处一并查（否则引导消息在末段时 userBubbleMissing 恒真 → 每次 SSE 都整页重建）
    const userBubbleMissing = lastRealUser >= 0 && !messagesEl.querySelector(`[data-m="${lastRealUser}"][data-t="u"], [data-g="${lastRealUser}"]`)
    const segInfo = liveMsgPort.getLastSegInfo() // 现读（不得缓存跨帧）：本轮 messagesHtml 刚产出的末段信息
    const canDelta = !userBubbleMissing && live.lastMsgLen != null && messages.length >= live.lastMsgLen && segInfo && segInfo.processing && segInfo.html
    live.lastMsgLen = messages.length
    if (canDelta) {
      applySegDelta(segInfo)
      liveUiPort.renderTransient() // 增量末段替换后暂态区对账（权威 done-live 复判 → 乐观主张降级/移除）
    } else {
      const html = liveMsgPort.messagesHtml(messages)
      // 折叠开合恢复改用**结构稳定键**（2026-09-11 根治）：原实现按 querySelectorAll('details')
      // 的数组下标采集/回填，注释假定「索引稳定」——但整页重建时 details 序列本就会变：处理中段的
      // liveFoldBody 尾组数随工具增长、think-row 数随思考块增长、回合收口时处理中段转已完成段
      // （liveFoldBody 多组 → groupTools 合并组）。下标错位会把旧 done-fold 的 open 赋给新 tool-fold，
      // 工具折叠体**莫名自动展开**（用户实测「没点开，自己就这么大」）。
      // 键 = 宿主段(data-m|data-t) + 主类名 + 段内同类序号：跨类型错配彻底消除（思考展开态不会再
      // 灌给工具折叠）；同类内序号偏移只在同段同类折叠增删时发生（后果轻，回落默认收起）。
      const foldKey = (d) => {
        const cls = d.className.split(' ')[0]
        if (d.dataset.m) return `@${d.dataset.m}|${d.dataset.t || ''}|${cls}`
        const host = d.closest('[data-m]')
        const scope = host || messagesEl
        const idx = [...scope.querySelectorAll('details.' + cls)].indexOf(d)
        return `${host ? host.dataset.m + '|' + (host.dataset.t || '') : 'root'}|${cls}#${idx}`
      }
      const openState = new Map([...messagesEl.querySelectorAll('details')].map((d) => [foldKey(d), d.open]))
      const doneLivePrev = new Set([...messagesEl.querySelectorAll('details')].filter((d) => d.classList.contains('done-live')).map(foldKey))
      // 采集刷新前的消息 key（data-m|data-t），重建后只给新增块播放入场动画
      const prevMsgs = new Set([...messagesEl.querySelectorAll('[data-m]')].map((e) => e.dataset.m + '|' + (e.dataset.t || '')))
      // img 换血（2026-09-18 内存峰值/闪烁根治）：整页 innerHTML 重建全部节点 → 全部 <img> 重建且
      // file-cache private,no-cache 每张必回源（网络风暴 + 全图重新解码 = 回合边界卡顿峰值 +
      // 「先塌后弹」闪烁）。src 相同的图内容不变 → 重建前按 src 采池，重建后同 src 换回旧节点
      //（池 shift 支持同 src 多图），零回源零重解码；池剩余节点随 GC 回收。
      const imgPools = new Map()
      for (const im of messagesEl.querySelectorAll('img')) {
        const k = im.getAttribute('src')
        if (!k) continue
        let pool = imgPools.get(k)
        if (!pool) { pool = []; imgPools.set(k, pool) }
        pool.push(im)
      }
      messagesEl.innerHTML = html
      for (const im of messagesEl.querySelectorAll('img')) {
        const pool = imgPools.get(im.getAttribute('src'))
        if (pool && pool.length) im.replaceWith(pool.shift())
      }
      if (!txTakeover) liveMsgPort.stampMsgIn(prevMsgs) // 接管帧不播入场动画（同位换皮，见上方事务收口注释）
      // 已存在的折叠恢复刷新前状态（覆盖 messagesHtml 对处理中折叠的默认 open，避免折叠后被刷新强制弹开）；
      // 处理中折叠（done-live）回复落地 → 自动收起（对齐「回复落地后收起」设计，短回复占位得以重新补回）；
      // 用户手动展开的「已处理」折叠照常恢复。新增折叠（索引越界）保留默认：处理中展开、已处理收起
      ;[...messagesEl.querySelectorAll('details')].forEach((d) => {
        const k = foldKey(d)
        if (!openState.has(k)) return // 新增折叠（键不在旧集）保留 HTML 默认：处理中展开、已处理收起
        const finishedNow = doneLivePrev.has(k) && !d.classList.contains('done-live')
        // 无正文回合（data-nobody）收口时不自动折叠——保留过程证据（对齐 dsh 轮次过程折叠）
        d.open = finishedNow ? !!d.dataset.nobody : openState.get(k)
      })
      // 2026-08-30 乐观改排队区（清单#4③）→ 2026-09-07 暂态区收编：整页重建洗掉 #live-zone
      // → renderTransient 从状态整体重建（气泡/折叠/排队区恒定顺序挂回 pin-stage 之前）
      liveUiPort.renderTransient()
    }
    // 2026-09-11 ④ 只读提问卡接管已移除（见 route.js 同处注）：提问态由消息流紧凑工具行表达，
    // 此处只保留审批卡保护——交互式逐题审批卡占据输入栏时不得被 clearTakeover 洗掉。
    if (liveStatePort.getTakeover() !== 'approval') liveStatePort.clearTakeover()
    setChar(liveMsgPort.getCharNote()) // 只读 SSE：按末段最近工具/处理状态切形象
    bindLiveFoldTimer(messages)
    applyStreamPreview() // 2026-09-08 流式字符通道：重渲洗 DOM 后重挂流式预览暂态（streamText 内存态恢复）
    liveUiPort.syncTurnLive() // 2026-09-04 打断按钮：SSE 刷新整页/增量重建后校准（回合收口→还原发送键）
    if (hasNewUser && uSig !== live.pinnedUserSig) {
      // 真正的新用户消息 → 回合开启唤出（两层消息流）：占位按跟随几何同帧就位。
      // pinnedUserSig 防重复：迟到的刷新不会再重钉上一回合。
      // 命中才推进 lastUserSig/pinnedUserSig（配合上方基线推进规则=真实可重试）。
      const el = messagesEl.querySelector(`[data-m="${lastU}"][data-t="u"]`)
      if (el) {
        live.lastUserSig = uSig // 命中才推进（配合上方基线推进规则=真实可重试）
        live.pinnedUserSig = uSig
        // 换 key 帧必须走 stageStart 换参照气泡（脚印随参照实时量取，2026-09-10 起无诞生快照）：
        // 乐观气泡唤出的占位在场 → 接管帧同回合延续；CLI 端发起的新回合（web 观察）同样在此
        // 唤出。2026-09-11 起无动画窗（smooth 分支退役）——两条路径同一落点，不再分叉。
        liveStagePort.stageStart(el, uSig)
      }
    } else {
      liveUiPort.renderSettle() // 无新回合：占位在场时对账（重挂/校准/跟随归位），未激活零开销
    }
    // 占位在场=两层跟随接管（stageFollow/动画期已自带让位逻辑）；
    // 否则保留原有「原本在底部就跟着吸底」行为
    if (!liveStagePort.stage.active) {
      sc.style.scrollBehavior = 'auto'
      if (atBottom) sc.scrollTop = sc.scrollHeight
      sc.style.scrollBehavior = ''
    }
  }

  // 增量重建（2026-08-26）：只替换「处理中末段」的 DOM，头部历史消息保留不动（不整页 innerHTML，
  // 消除闪烁 + tool-running 光泽动画不被重建打断）。info = lastSegInfo {key, html, prev, processing}：
  // 先删旧末段全部节点（data-m=key，含用户消息/折叠/回复/变更卡），新段节点按 prev 锚点
  // （该段输出前的最后一个 data-m 元素）插回原位；无锚点（末段即首条）则追加到末尾。
  function applySegDelta(info) {
    const key = String(info.key)
    // 增量替换状态保持（2026-09-18「状态行更新/旁白行新增→界面跳动」根治）：段替换以段为粒度
    // 整段换血，段内有两类 HTML 再生不出来的状态——
    // ① details 开合态（段折叠用户手动关上 / tool-fold 用户手动展开）：按 HTML 默认值重建
    //    （处理中=open、tool-fold=收起）意味着每次状态行更新/旁白行新增都把折叠态拍回默认 =
    //    整段高度每增量跳一次。全量重建路径已按 foldKey 恢复开合（2026-09-11 定案「用户手动
    //    展开的折叠照常恢复」），增量路径同受此不变量约束——此处按同一键语义捕获并恢复
    //    （键不在旧集的新增折叠保留 HTML 默认：处理中展开、工具行收起）。
    // ② 用户气泡及其图片：气泡在段内不变（who/图/文件/复制钮落盘后皆静态），重建节点令 imgs
    //    重新请求/解码（file-cache no-cache 必回源 → 至少一帧 0 高塌缩再回弹）= 每增量先塌后弹
    //    的跳动。DOM 已有同 key 气泡时保留旧节点、丢弃新段气泡节点只换其余（气泡=段首元素，
    //    其余部分删后插回流末锚点前=文档序不变；处理中段恒为末段，旧气泡与流末锚点之间不存在
    //    他段节点）。
    const oldNodes = [...messagesEl.querySelectorAll(`[data-m="${key}"]`)]
    const foldKeyOf = (d) => {
      const cls = d.className.split(' ')[0]
      if (d.dataset.m) return `@${d.dataset.m}|${d.dataset.t || ''}|${cls}`
      const host = d.closest('[data-m]')
      const scope = host || messagesEl
      const idx = [...scope.querySelectorAll('details.' + cls)].indexOf(d)
      return `${host ? host.dataset.m + '|' + (host.dataset.t || '') : 'root'}|${cls}#${idx}`
    }
    const prevOpen = new Map()
    for (const n of oldNodes) {
      for (const d of (n.matches('details') ? [n] : []).concat([...n.querySelectorAll('details')])) {
        prevOpen.set(foldKeyOf(d), d.open)
      }
    }
    const tmp = document.createElement('div')
    tmp.innerHTML = info.html
    const frag = document.createDocumentFragment()
    for (const n of [...tmp.children]) frag.appendChild(n)
    const oldBubble = oldNodes.find((n) => n.matches('[data-t="u"]'))
    const newBubble = [...frag.children].find((n) => n.matches('[data-t="u"]')) || null
    const keepBubble = !!(oldBubble && newBubble && oldBubble.isConnected)
    if (keepBubble) newBubble.remove()
    // img 换血（2026-09-18「旁白消息的图片仍闪」根治）：段内除段首用户气泡外的节点（尤其
    // 引导气泡 data-t="g<gi>"——上传图片经排队注入后正是落在这里，与旁白行同段）每帧重建，
    // 新 <img> 到 paint 时尚未解码（file-cache private,no-cache 必回源）= 至少一帧 0 高塌缩
    // 再回弹。与全量重建路径同一不变量：已落盘图片字节不可变 → 同 src 的旧节点直接换回，
    // 零回源零重解码。只从「本次将被删除」的节点采池——保留的旧气泡节点不动（引导气泡与
    // 用户气泡可能同 src，采走会让保留气泡丢图）。
    const imgsOf = (n) => (n.matches('img') ? [n] : []).concat([...n.querySelectorAll('img')])
    const imgPools = new Map()
    for (const n of oldNodes) {
      if (keepBubble && n === oldBubble) continue
      for (const im of imgsOf(n)) {
        const k = im.getAttribute('src')
        if (!k) continue
        let pool = imgPools.get(k)
        if (!pool) { pool = []; imgPools.set(k, pool) }
        pool.push(im)
      }
    }
    for (const n of oldNodes) if (!(keepBubble && n === oldBubble)) n.remove()
    const inserted = [...frag.children]
    let anchor = null
    if (info.prev) {
      // 同 data-t 多元素时（如多轮 end_turn 的多个 reply 气泡、同 key 多 fold）取文档序最后一个
      // = 段尾精确锚点（碎片化交错渲染 2026-08-29：prev.type 语义=段尾最后元素）
      const nodes = messagesEl.querySelectorAll(`[data-m="${info.prev.key}"][data-t="${info.prev.type}"]`)
      anchor = nodes.length ? nodes[nodes.length - 1] : null
    }
    // 插入点恒避让暂态区与 .pin-stage（暂态区子元素/两层占位必须是流末）：段尾无后继或无锚点
    //（首段处理中）时都插到 #live-zone 之前——否则新段节点越过暂态区/落到占位块后面，
    // 占位错位到内容中间持续到刷新（2026-08-28 钉顶占位突然死亡根因一；2026-09-07 排队区
    // 插到新消息上一行同根因，暂态区结构化消除）。气泡保留旧节点时同样插流末锚点前
    //（见上：旧行为按 prev 锚点插会把新折叠体插到保留气泡之前，文档序颠倒）。
    const zone = document.getElementById('live-zone')
    const spacer = messagesEl.querySelector('.pin-stage')
    const tail = zone || spacer
    let ref = tail
    if (!keepBubble && anchor && anchor.isConnected) {
      let after = anchor.nextSibling
      while (after && after.nodeType !== 1) after = after.nextSibling
      ref = after || tail
    }
    messagesEl.insertBefore(frag, ref)
    // 同 src 的新 <img> 换回旧节点（见上方「img 换血」；此时新图尚未解码，换回即沿用已解码位图）
    for (const n of inserted) {
      for (const im of imgsOf(n)) {
        const pool = imgPools.get(im.getAttribute('src'))
        if (pool && pool.length) im.replaceWith(pool.shift())
      }
    }
    // ① 开合态恢复（仅旧集已有的折叠；新增折叠不在集内=保留 HTML 默认）
    for (const n of inserted) {
      for (const d of (n.matches('details') ? [n] : []).concat([...n.querySelectorAll('details')])) {
        const k = foldKeyOf(d)
        if (prevOpen.has(k)) d.open = prevOpen.get(k)
      }
    }
  }

  // 处理中折叠的「正在处理」实时计时（历史/SSE 路径）：末段尚无回复 = 处理中，
  // 从该段最后一个真实用户消息时间起跳字，回复落地后下轮刷新换成「已处理 X」并停表。
  let liveFoldTimer = null
  function stopLiveFoldTimer() {
    if (liveFoldTimer) { clearInterval(liveFoldTimer); liveFoldTimer = null }
  }
  // （2026-10-14 收口：90s 静默探测 probeCurStall/lastCurSseAt/#claim-fold 探测分支已随 SSE
  // 根治第一阶段删除——SSE 活性判定下沉到连接监督者 watchdog + 服务端 heartbeat，见文件头。）
  function bindLiveFoldTimer(messages) {
    stopLiveFoldTimer()
    const fold = messagesEl.querySelector('details.done-fold.done-live[data-m]') // 权威折叠（data-m）；乐观主张折叠在暂态区无 data-m，不参与
    if (!fold) return
    let t1 = live.txProcStart || 0
    live.txProcStart = 0 // 读取即清：移交起点只服务接管帧这一跳（残留会污染其它会话/回合的计时）
    if (!t1) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        // 注入引导消息（injected:true）不重置计时——「已处理」时长 = 从段开启消息起算，不打断（用户定案）
        if (liveMsgPort.isRealUser(m) && !m.injected && m.timestamp) {
          t1 = m.timestamp
          break
        }
      }
    }
    if (!t1) return
    const sum = fold.querySelector('summary')
    const tick = () => {
      if (!fold.isConnected) { stopLiveFoldTimer(); return }
      // SSE 活性监督已下沉到连接监督者（watchdog/heartbeat，见文件头）；此处只剩计时与状态对账。
      const sec = Math.round((Date.now() - t1) / 1000)
      // 僵死/断连对账（每秒 tick 无残留状态，信号恢复即自动消失）：
      // ① beat = 引擎最后产出增量的时刻（turn-beat SSE）。落后 ≥150s（beat 缺席则从本折叠
      //    计时起点起算）= query 链僵死或长任务无输出 → 标「无响应」。2026-09-08 判定统一：
      //    与 claimTick 同规则，删掉「beat 缺席即标」的短路——纯工具回合（bash 长跑零增量）/
      //    回合切换后 beat 窗口/旧 exe CLI（不发 beat）整回合误标「无响应」（未上屏先挂标实证）。
      // ② connUp = 网关 WS 在线（setConn 维护）。断开（网关死/网络断）→ 标「连接中断」，
      //    此前断流后计时行冻结假转（09-07 Pj5 断流残影实证），用户无从分辨。
      // 回合基线（2026-09-08 无响应误标根治）：turnBeat 是 per-session 永续 Map，上回合残留
      // beat（早于本段开启消息 t1）对新回合毫无意义——回合切换后的静默期（乐观窗口/首响前）
      // 拿旧值算出 staleSec≥150 会立即误标「无响应 X 分」（12:42 实测：正在处理 5s 并挂无响应
      // 2m59s）。beat 早于 t1 视同缺席，从本折叠起点 sec 起算，与本判定设计语义对齐。
      const rawBeat = live.curUuid ? live.turnBeat.get(live.curUuid) || 0 : 0
      const beatAt = rawBeat >= t1 ? rawBeat : 0
      const staleSec = beatAt ? Math.round((Date.now() - beatAt) / 1000) : sec
      // ③ 2026-09-11 已知阻塞原因不算「无响应」：审批卡在场（回合阻塞在等用户作答）/ 工具在飞
      // （引擎阻塞在等工具结果）都是合法阻塞，引擎无产出是预期——beat 自然不会增长。
      // 红标语义 = 「引擎无产出**且无已知阻塞原因**」；纯工具期与审批同等豁免（用户实测
      // 「正在运行时候怎么会无响应呢」，案例=长跑命令 3m33s 被误标）。工具判据取 DOM 运行态标记
      // .tool-line.tool-running——running 分支 summary 与 toolCurHtml 两条出口同款类，单一判据。
      const awaitingApproval = liveStatePort.getTakeover() === 'approval'
      const toolRunning = !!fold.querySelector('.tool-line.tool-running')
      // ④ 2026-09-18 用户定案：无响应降为**最底层优先级**——状态行有任意状态在场（正在思考/
      // 正在生成/正在压缩/正在运行）即不判，仅当无任何状态时才允许红标。压缩期误标实证根修：
      // 压缩是一次大 LLM 调用，零增量产出 → beat 恒停超 150s 被判「无响应」，且单状态槽挤掉
      // 「正在压缩」。状态判据 = .think-state 的 data-label（messages.js vacuumOf 单源渲染，
      // 压缩实证档 compact-state 同源 TTL 5min）；stEl 查询提前至此，下方计时复用同一节点。
      const stEl = fold.querySelector('.think-state')
      const hasStatus = !!(stEl && (stEl.dataset.label || '').trim())
      // 单状态槽（2026-09-11 用户定案「一次应该只有一个状态」）：红标在场时它**独占**状态槽——
      // stEl 所在状态显示行挂 .is-flagged，styles.css 隐去同行 .think-state（含并发尾缀「并思考」）
      // 与 .think-stream（流式预览=引擎产出的暂态，引擎无产出即过期，留着与红标互相打脸）。
      // 信号恢复即整行复原（每秒重算，无残留态）。
      // 豁免规则（审批等待/工具在飞/任意状态在场 = 已知阻塞或已有状态表达）→ 本帧不参与僵死
      // 判定，传 0 表达「判据不适用」；阈值与文案由 messages.js statusFlags/STALE_SEC 单源构造
      // （优先级：连接中断 > 无响应，无响应为最底层）。
      const flags = liveMsgPort.statusFlags(connUp, awaitingApproval || toolRunning || hasStatus ? 0 : staleSec)
      // 两行各自独立跳字（2026-09-09 用户定案「折叠顶只留正在处理/已处理，状态标识归工具行层」；
      // 二轮定案：工具调用行=折叠体，状态显示行是其内暂态层 .fold-state——有工具组并入 summary
      // 同行、无工具组独立行，动画展示不留存）：① 折叠顶 summary 恒「正在处理 + d-dur 总时长」；
      // ② 思考/压缩状态 .think-state 落 .fold-state 暂态层，tick 原地续「 Ns」（2026-09-18 分隔点
      // 全撤：用户定案状态行不用「·」，空格分隔）。全程节点级
      // textContent 更新、不 innerHTML 重建——重建会每秒重启扫光动画并洗掉 applyStreamPreview
      // 挂的流式预览节点。
      // 状态行文本节点独立（2026-09-11）：.think-state 首子节点恒为 .t-ico 行首槽（与工具行同款
      // 16px 槽 + 5px gap，文字左缘同基准）——整节点 textContent 赋值会连图标槽一并洗掉，槽一没
      // 文字左缘即回跳（用户实测的「跳动」），故 tick 只写 .ts-text 文本节点。
      if (stEl) {
        // 文案由 messages.js vacuumLabel 单一映射后写进 data-label（含并发尾缀「并思考」形态）；
        // tick 只补计时，不复刻 mode→label 映射（旧实现在此处重复一份三元链，改文案要改两处）。
        const label = stEl.dataset.label || ''
        const ts = Number(stEl.dataset.ts) || 0
        const dsec = ts ? Math.max(0, Math.round((Date.now() - ts) / 1000)) : 0
        stEl.querySelector('.ts-text').textContent = label && ts ? `${label} ${liveMsgPort.fmtDur(dsec)}` : label
      }
      const durEl = sum.querySelector('.d-dur')
      if (durEl) durEl.textContent = ' ' + liveMsgPort.fmtDur(sec)
      // 僵死/断连红标独立对账（原地，信号恢复即自动消失）；宿主=状态显示行 .fold-state（有工具组时
      // 在工具行 summary 内、无工具组时段尾独立行）或 done-body 尾（乐观主张折叠），不上折叠顶
      // summary（同上定案：折叠顶不留状态标识字样）
      let flEl = fold.querySelector('.d-flags')
      if (!flEl) {
        flEl = document.createElement('span')
        flEl.className = 'd-flags'
        const fhost = stEl ? stEl.parentElement : fold.querySelector('.done-body')
        if (!fhost) return
        fhost.appendChild(flEl)
      }
      if (flEl.innerHTML !== flags) flEl.innerHTML = flags // 值不变不重写：每秒空写会打断子动画并触发无谓样式重算（2026-09-18 卡顿小刀）
      // 状态槽独占判定（同帧、同一判据 flags 非空）：宿主是状态显示行 .fold-state 时才挂标
      //（回退宿主 .done-body 里本就没有 .think-state，无需隐）。信号恢复 → 摘标 = 状态文字复原。
      const frow = flEl.parentElement
      if (frow && frow.classList.contains('fold-state')) frow.classList.toggle('is-flagged', !!flags)
    }
    tick()
    liveFoldTimer = setInterval(tick, 1000)
  }

  // 2026-09-08 流式字符通道：把 live.streamText 挂到状态显示行 .fold-state 内（权威段体工具行
  // summary 内暂态层 / 段尾独立行 / 乐观主张折叠 #claim-fold 的 done-body 内，2026-09-09 定案
  // 起不再进任何折叠顶 summary——折叠顶只留「正在处理/已处理」字样）。单行 rtl 保尾（.think-stream 样式，v151 .ch-file 同款技巧），
  // JS 截 200 字符防 DOM 膨胀。无状态显示行在场且无主张折叠 = 不显示（内存保留，状态显示行渲染出
  // 来后由下一帧/renderSessionBody 出口带出）；text 空 = 移除暂态节点。
  // 清除信号：stream-text ''（块边界/消息落盘）、turn-state live:false（打断）、切会话清槽。
  function applyStreamPreview() {
    const old = messagesEl.querySelector('.think-stream')
    const text = live.streamText || ''
    if (!text) { if (old) old.remove(); return }
    let host = null
    let anchor = null
    const stEl = messagesEl.querySelector('details.done-fold.done-live .think-state')
    if (stEl) { anchor = stEl; host = stEl.parentElement }
    else {
      const claim = document.getElementById('claim-fold')
      if (claim) host = claim.querySelector('.done-body')
    }
    if (!host) { if (old) old.remove(); return }
    // 流式预览与状态文字同挂 .fold-state 暂态层一行（2026-09-09 定案：与工具行同一行）；已有节点全
    // host 查找复用（行内 d-flags 与流式预览共存，anchor.nextElementSibling 判定会误判成
    // 需重建 → 孤儿残留），只在缺节点时插入到状态文字之后（claim 路径 anchor 空则追加体尾）。
    let el = host.querySelector(':scope > .think-stream')
    if (!el) {
      el = document.createElement('span')
      el.className = 'think-stream'
      if (anchor) anchor.after(el); else host.appendChild(el)
    }
    el.textContent = text.length > 200 ? '…' + text.slice(-200) : text
  }

function setLiveModelHook(fn) { onSessionModel = fn }
function setLiveEffortHook(fn) { onSessionEffort = fn }
function setLivePorts(p) { liveMsgPort = p.msg; liveUiPort = p.ui; liveStagePort = p.stage; liveStatePort = p.state }
  // ---------- 路由 ----------
  // 2026-08-28 pushState 路径路由：/session/<全长会话hash>、/manage/<kind>、/project/<label>（project 避开网关
  // /preview/* 静态页路径）；hash 路由保留为旧链接/旧缓存页兜底（parseRoute 先 pathname 后 hash）。
  // 2026-08-29 用户定案：全部前缀用全称（/session/、/manage/、/project/、/backend/，禁止简写）；
  // 旧缩写前缀（/s/、/mgr/、/pview/）仅作已发出链接的解析兼容，不再生成。
  // navigate('#mgr/k')/'#preview/l' 是内部调用约定 hash，经 pathFor 转真路径，URL 上不出现。
  function parseRoute() {
    const p = location.pathname
    if (p.startsWith('/session/')) return { name: 'session', hash: decodeURIComponent(p.slice(9)) }
    if (p.startsWith('/s/')) return { name: 'session', hash: decodeURIComponent(p.slice(3)) }
    if (p.startsWith('/manage/')) return { name: 'mgr', mgr: decodeURIComponent(p.slice(8)) }
    if (p.startsWith('/mgr/')) return { name: 'mgr', mgr: decodeURIComponent(p.slice(5)) }
    if (p.startsWith('/project/')) return { name: 'preview', label: decodeURIComponent(p.slice(9)) }
    if (p.startsWith('/pview/')) return { name: 'preview', label: decodeURIComponent(p.slice(7)) }
    const raw = location.hash.replace(/^#\/?/, '')
    if (!raw) return { name: 'home' }
    // 会话 UUID 不会以 mgr//preview/ 开头，前缀判定安全。
    if (raw.startsWith('mgr/')) return { name: 'mgr', mgr: raw.slice(4) }
    if (raw.startsWith('preview/')) return { name: 'preview', label: decodeURIComponent(raw.slice(8)) }
    return { name: 'session', hash: decodeURIComponent(raw) }
  }

  // 会话 hash 归一（全长 / 旧短 hash → 列表内规范 hash；查无原样透传，由 renderSession 显示「不存在」）。
  const resolveSessionHash = (h) => { const s = findSession(h); return s ? hashOf(s) : h }

  // 启动期预解析当前路由 hash（唯一调用点 = app.js，须在 initWork 之前）：让 initWork→applyPanes 的
  // 「聊天栏在场 ⇒ 当前路由 tab 必在开放集」兜底读到**真实** active key，而不是尚未被 route 赋值的
  // currentHash('')。否则 work 模式刷新时该兜底把 '' 当哨兵 'new'，凭空往开放集塞一枚「新对话」胶囊
  // （不变量见 sidebar/work.js applyPanes；与同步修复前「刷新多出一枚新会话胶囊」同根）。
  function bootHash() {
    const r = parseRoute()
    return r.name === 'session' ? resolveSessionHash(r.hash) : ''
  }

  function route() {
    closeMentionPop()
    const r = parseRoute()
    // 入站语境快照（2026-10-15 注册域隔离 Step2）：state.mgr/state.preview 在本函数内会被清空/改写，
    // 而「这张卡在不在域内」必须按**入站时**的语境判——否则 r.mgr 一旦写进 state.mgr，卡就靠自己的
    // id 认领了自己（自授权），隐藏卡再度可由手敲/残留路由打开。快照后立刻被下面清空的两行作废，
    // 只在此处读一次。sbMode/workProj 一并带上（work 语境口径）。
    const ctx0 = { mgr: state.mgr, preview: state.preview, sbMode: state.sbMode, workProj: state.workProj }
    // work 模式与视图卡（管理/预览）互斥（2026-09-25）：work 主区两栏只在会话卡在场时成立，
    // 进入 mgr/preview 一律强制回 chat 模式（顶部 tab 高亮、#work-panel 显隐、主区 .work 由
    // applySbMode 一并落地）。反向（work 里点开管理 tab）由 mgr-tabs 点击走 navigate → 命中此处。
    if ((r.name === 'mgr' || r.name === 'preview') && state.sbMode === 'work') setSbMode('chat')
    // 任何导航（route 被调用）→ 退出管理视图；管理视图只由 mgr-tab 点击直接 renderMgr 进入，不走 route
    state.mgr = null
    state.preview = null
    // 离开预览：清已挂载标记（下次进入重挂）+ 清预览页注册的侧栏快捷按钮（注册集属于那份文档）
    if (r.name !== 'preview') { state.previewMounted = null; clearRailExt() }
    // 离开项目预览时回收 backend 保活心跳（2026-08-27 返回按钮移除后，退出预览全靠导航）
    if (window.__backendHeartbeat) {
      clearInterval(window.__backendHeartbeat)
      window.__backendHeartbeat = null
    }
    syncMgrTabs()
    // 2026-08-25 会话切换滞后修复：renderRecent() 里 .on 高亮按 state.currentHash 判定，
    // 原先 renderSession() 在 renderRecent() 之后才设 currentHash → 点第一次侧栏高亮停在旧会话，
    // 要再点一次才高亮正确（用户反馈「需要选中会话多次才可以完全切换」）。这里按路由目标预置，
    // 让 renderRecent() 一次导航即高亮正确目标。
    // 2026-08-28 /session/<全长hash> → resolve 校验会话存在（currentHash/SSE/WS 全链全长）；
    // 未知 hash 原样透传（renderSession 显示「会话不存在」）。
    if (r.name === 'session') r.hash = resolveSessionHash(r.hash)
    state.currentHash = r.name === 'session' ? r.hash : ''
    syncWorkTabs() // work 模式：把当前路由并入聊天 tab 开放集并重渲顶栏（chat 模式空跑）
    renderRecent()
    if (r.name === 'home') renderHome()
    // 外部卡（ext:<label>:<id>）先按缓存回填运行时表再渲染卡：EXT 只活在内存里，刷新直进
    // /manage/ext:… 时表是空的，不先回填则 openCard 查无此卡、主区空白（缓存真源与刷新恢复链见 registry.js）。
    // 注册域门（2026-10-15 Step2）：回填 EXT 后按 **ctx0**（入站语境）判该卡在不在域内——域外（别的
    // 项目的外部卡 / 非工作区根语境的 app 卡）退回首页，不得靠 URL 直接切进主区。极端后果（知情取舍）：
    // 冷启动/刷新停在 /manage/<app|ext> URL 上时 ctx0 无语境 ⇒ 落首页，须经原入口（工作区根/项目预览）
    // 重新进入——「卡 tab 在什么语境显示」与「卡在什么语境可开」从此是同一条判据。
    else if (r.name === 'mgr') {
      hydrateExtCardId(r.mgr)
      if (!isCardAllowedInContext(r.mgr, ctx0)) { navigate('#/'); return }
      state.mgr = r.mgr; loadMgrView(); renderMgr()
    }
    else if (r.name === 'preview') { state.preview = r.label; openProjectPreview(r.label, true) }
    else renderSession(r.hash)
    // 注册域随语境重算（2026-10-15 注册域隔离）：#mgr-tabs 的 EXT 段只在「当前语境 = EXT 所属项目」
    // （chat 语境 = 预览路由 state.preview / 正在看其 ext 卡 state.mgr）时进表——离开预览后 EXT 内存表
    // 不清（离开预览路由不清，见 ext-runtime 生命周期不变量），不重算就会把外部卡 tab 串进无关视图。
    // 须落在 state.mgr / state.preview 定值之后（上面分支），并随后重落高亮（重渲可能重建按钮节点）。
    renderMgrTabs()
    syncMgrTabs()
  }

  // 同步管理 tab 高亮（route/renderRecent 前调用）
  function syncMgrTabs() {
    document.querySelectorAll('.mgr-tab').forEach((x) => x.classList.toggle('on', x.dataset.mgr === state.mgr))
  }

  // 2026-08-25 同步路由：navigate 后同步调用 route()，不再依赖 hashchange 异步时序。
  // 背景：切换会话需双击——第一次点击走 hashchange 异步 route() 内容区不切换（侧栏 .on 高亮已对，
  // 因 currentHash 在 renderRecent 前预置），第二次点击 hash 已同 → navigate 同步 route() 才切。
  // 实测差异在同步 vs 异步，故改为同步渲染。
  // 2026-08-28 pushState 路径路由：navigate 参数保持既有 hash 形式（调用点零改动），内部转真路径：
  // '#/' → '/'、'#/<hash>' → '/session/<全长hash>'、'#mgr/<k>' → '/manage/<k>'、'#preview/<l>' → '/project/<l>'；
  // history.pushState + popstate 兜底前进/后退（hashchange 保留为旧 hash 链接兜底）。
  let lastNavHash = null
  function pathFor(hash) {
    if (hash === '#/' || hash === '#') return '/'
    if (hash.startsWith('#/')) return '/session/' + hash.slice(2)
    if (hash.startsWith('#mgr/')) return '/manage/' + hash.slice(5)
    if (hash.startsWith('#preview/')) return '/project/' + hash.slice(9)
    return '/'
  }
  function navigate(hash) {
    const path = pathFor(hash)
    if (location.pathname === path) return route()
    lastNavHash = path
    history.pushState(null, '', path)
    route()
  }

  // 2026-08-18 按 SubPj3 实现：空态输入栏挂 #empty-hint .g-stage 内真相对定位（台面中心锚），
  // 会话态移回会话卡沉底。界面切换时移动 DOM，保证定位基准正确且 transition 平滑。
  // 2026-09-23 卡化：两处基准都在会话卡内（.g-stage 是卡的后代；docked 目标是卡本身），
  // 输入栏随会话卡生灭——不再有「挂槽位」的旧路径。
  const emptyStageEl = () => document.querySelector('#empty-hint .g-stage')
  function mountInput(where) {
    const target = where === 'stage' ? emptyStageEl() : sessionCard
    if (target && inputWrap.parentNode !== target) target.appendChild(inputWrap)
  }
  // 输入栏 stage↔chat 迁移的 FLIP 补间（2026-08-30 丝滑空态→会话）：换父后 top/width 是
  // 百分比/calc，插值基准随新父容器变化 → 直接过渡会首帧跳变甚至离散。改 FLIP：变更前测
  // 旧矩形 → 统一施加类/父容器变更 → transform 从旧位滑到新位（transform 终点=恒等，无
  // 收尾跳变）→ 结束恢复样式表过渡。隐藏态（门/管理视图 display:none）或未移动时退回普通切换。
  let flipInputTimer = null
  function flipInput(toStage) {
    const el = inputWrap
    if (flipInputTimer) { // 上一次 FLIP 动画中途重入：清定时器并恢复内联样式，防残留
      clearTimeout(flipInputTimer)
      el.style.transition = ''
      el.style.transformOrigin = ''
      flipInputTimer = null
    }
    const apply = () => {
      if (toStage) {
        el.classList.remove('docked')
        chatArea.classList.remove('in-session')
        mountInput('stage')
      } else {
        mountInput('chat')
        el.classList.add('docked')
        chatArea.classList.add('in-session')
      }
    }
    const r1 = el.getBoundingClientRect()
    if (getComputedStyle(el).display === 'none' || !r1.width) { apply(); return }
    el.style.transition = 'none'
    apply()
    const r2 = el.getBoundingClientRect()
    if (!r2.width) { el.style.transition = ''; return }
    // 类变换恒等盒换算：stage 态 translate(-50%,-50%)（中心锚）、docked 态 translate(-50%,-100%)
    const anchorY = toStage ? 0.5 : 1
    const tx = r1.left - (r2.left + r2.width / 2)
    const ty = r1.top - (r2.top + r2.height * anchorY)
    const kx = r1.width / r2.width
    const ky = r1.height / r2.height
    if (Math.abs(tx) < 1 && Math.abs(ty) < 1 && Math.abs(kx - 1) < 0.01 && Math.abs(ky - 1) < 0.01) {
      el.style.transition = ''
      return
    }
    el.style.transformOrigin = 'top left'
    el.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + kx + ', ' + ky + ')'
    void el.offsetWidth // 提交起始帧
    el.style.transition = 'transform 0.55s cubic-bezier(0.22, 0.61, 0.36, 1)'
    el.style.transform = ''
    flipInputTimer = setTimeout(() => {
      el.style.transition = ''
      el.style.transformOrigin = ''
      flipInputTimer = null
    }, 580)
  }

  // 切视图即清全局槽（离开会话视图的唯一出口；2026-09-19 收敛）：
  // 不变量 = live.curUuid 非空 ⇔ 当前视图正展示该会话。session-delta/queue-state/task-state/
  // compact-state/turn-state/stream-text 六条 SSE 守卫全部以它为前提。**任何离开会话视图的入口
  // 都必须清槽**——漏一处，残留 curUuid 就让该会话的实时流继续命中守卫：renderSessionBody 整页
  // 重建 #messages 把非会话视图洗成会话消息流（renderHome 08-29「新会话界面串行」、
  // openProjectPreview 09-16「项目页被洗成 chat」、renderMgr 09-19「神经 tab 跳 chat 有宽度
  // 没底栏」三次实证同一根因，前两次都是就地补清单、漏了下一个入口）。
  // 清槽清单：curUuid/deltaSeq/localMessages（SSE 匹配与增量基线）、lastMsgLen（增量守卫）、
  // queueRemote/tasks（跨会话快照串染）、streamText（流式暂态）、接管卡与上下文环（视图级 UI 态）。
  // 会话视图的重新接线由 renderSession/refreshSession 负责（唯一重建点，不在此处）。
  function clearSessionSlots() {
    live.lastMsgLen = null
    live.localMessages = null
    live.deltaSeq = null
    live.queueRemote = []
    live.curUuid = null
    live.tasks = [] // 任务浮窗快照（空数组 = 浮窗整体不出现）
    renderTaskDock()
    live.streamText = '' // 流式字符通道暂态
    clearTakeover() // 清残留的提问/审批 takeover（输入栏恢复）
    renderCtxMeter(null) // 无会话上下文：隐藏上下文环
  }

  // 会话卡离场钩子（session-card.js 的 deactivate 契约；registry.openCard 切异卡时调用，preview-card
  // 硬进入分支经 registry.deactivateCard('session') 显式调用）——停实时计时 → 拆 stage 占位 →
  // 清全局槽 → 复位 currentHash。**仅此一处合成**：离开会话视图的清单不再散落各入口（三次同根
  // 复发教训：就地补清单必漏下一个入口）。
  function teardownSessionView() {
    stopLiveFoldTimer()
    stageRelease()
    clearSessionSlots()
    state.currentHash = ''
  }

  function renderHome() {
    stopLiveFoldTimer()
    setTurnLive(false); syncGwSend() // 2026-09-04 打断按钮：离开会话还原发送键
    stageRelease()
    state.currentHash = ''
    messagesEl.innerHTML = ''
    clearSessionSlots() // 回首页（空态）同样清「当前会话」全局槽（不变量见上）
    setPendingUserMsgs(pendingUserMsgs.filter((p) => p.hash)) // 首页无事务归属：丢弃 hash='' 残留项（防主张气泡飘上空态）
    setChar(1) // 首页空态 → 默认形象
    renderProjSeat()
    // 回首页无待定新会话选择 → 模型 seat 回落凭据池全局默认（web 不再改全局默认，2026-10-11）
    syncSeatToGlobalDefault()
    openCard('session') // 整卡换回会话卡（须先于 flipInput：隐藏卡的矩形为零，FLIP 会退化成硬切）
    flipInput(true) // docked/in-session 移除 + 挂回 stage 一并由 FLIP 处理（旧位取变更前矩形）
  }

  function renderSession(hash) {
    // work 模式不变量（判定点见 sidebar/work.js workScopeOk）：助手栏只显示工作项目的会话——
    // 直接打开别的项目/全局的会话路径（含刷新恢复）时退回工作项目的新对话空态，与切模式/切项目同一条。
    if (!workScopeOk(hash)) { navigate('#/'); return }
    stopLiveFoldTimer()
    setTurnLive(false); syncGwSend() // 2026-09-04 打断按钮：切会话先复位，busy 会话由下方 syncTurnLive 按实况恢复
    // 切换会话：丢空态（hash=null）乐观项；各会话 pending 保留（2026-08-29 用户反馈
    // 「切换会话引导消息会消失」→ 按 hash 关联，切回时 absorbPending + renderTransient 处理）。
    // 首条消息事务进行中（firstSendHash 在场）hash='' 的乐观项属事务，不丢。
    setPendingUserMsgs(pendingUserMsgs.filter((p) => p.hash || (firstSendHash && p.hash === '')))
    live.lastMsgLen = null // 切换会话：重置增量重建守卫（首个刷新必整页渲染，防跨会话误增量）
    // 2026-09-08 事件流统一 P1：清 delta 本地基线（localMessages/seq）——串会话防写穿（等权
    // 正确性：切会话即清全局槽），新会话基线由 fetch 回程（renderSession/refreshSession）重建。
    live.localMessages = null
    live.deltaSeq = null
    // 2026-08-30 串会话根治：上一会话遗留的全局槽在切换瞬间必须清空——
    // ① live.queueRemote 不清 → 新会话首屏 renderTransient 直接渲染上一会话的 CLI 队列快照
    //   （确定性串染，连竞态都不需要；fetch 回来再硬重置为本会话 queued）；② live.curUuid
    //   不清 → 加载窗口内 queue-state SSE 按旧 uuid 匹配成功，把旧会话快照写进新会话视图。
    live.queueRemote = []
    live.curUuid = null
    live.tasks = [] // 2026-09-10 任务浮窗：切会话清任务快照（同 queueRemote 槽清单，防上一会话清单串染）
    renderTaskDock()
    live.streamText = '' // 2026-09-08 流式字符通道：切会话清流式暂态（串会话防写穿，同 queueRemote/curUuid 槽清单）
    setModelUserPicked(false) // 切换会话：允许 /gateway/session 上报的会话模型校准 seat
    // 2026-11-06 思考等级会话隔离（C）：切换瞬间清掉上一会话的档位归属（回全局默认），
    // 等本次 fetchMessages 回程按本会话上报值校准——否则加载窗口内座显仍是上一会话的档位。
    applySessionEffort(undefined)
    stageRelease()
    clearTakeover() // 切换会话：清掉残留的提问/审批 takeover（输入栏恢复）
    closeProjPop() // 切换会话：项目选择器弹层一并收起（初始界面专属件）
    renderProjSeat() // 会话态：工作文件夹标识按当前会话项目重渲（锁定只读）
    openCard('session') // 整卡换回会话卡（须先于 flipInput：隐藏卡的矩形为零，FLIP 会退化成硬切）
    flipInput(false) // 输入栏移回会话卡沉底（FLIP 像素级补间）
    const s = findSession(hash)
    state.currentHash = hash
    sendSubscribe() // 2026-08-30 pending 重放：切会话即订阅 → 网关回放该会话未决审批/提问（补弹交互卡）
    if (!s) {
      // 2026-08-30 刷新直进 /session/<hash>：token 门未过时会话列表未拉（loadSessions 空跑），
      // 此时找不到 ≠ 真不存在 → 占位「加载中」，由 hideGate 的 loadSessions().then 恢复链落地重渲；
      // 列表就绪后仍找不到才渲染「会话不存在或已删除」。
      if (needToken()) {
        messagesEl.innerHTML = '<div class="msg msg-system">加载中…</div>'
        renderCtxMeter(null) // 无会话数据 → 隐藏上下文环
        inputWrap.classList.add('docked')
        chatArea.classList.add('in-session')
        return
      }
      messagesEl.innerHTML = '<div class="msg msg-system">会话不存在或已删除</div>'
      renderCtxMeter(null) // 无会话数据 → 隐藏上下文环
      inputWrap.classList.add('docked')
      chatArea.classList.add('in-session')
      return
    }
    // 2026-08-25 发送即 resume：打开 web 会话仅预览（与 CLI 会话一致），不再自动拉起本地 CLI 窗口；
    // 会话进程未在线时，发送消息（gwSend → 网关 resumeAndDeliver）才恢复窗口并投递。
    // 原自动 resume + subscribe 已移除：审批卡经网关 broadcast → /ws sockets 到达，subscribe 为死代码。
    // 首条消息事务（2026-09-06 根治）：newWebSession 在 navigate 之前回填 firstSendHash——
    // navigate 同步 route → 本函数跑在 gwSend await 续体之前（旧 pendingFirstSend.hash 此刻
    // 仍为 ''，事后守卫必失效 =「加载中…」洗掉乐观 DOM 的三态根因），hash 回填前移后守卫全程有效。
    // 事务期不洗「加载中…」，乐观 DOM 是权威等真实数据；切到其它会话=放弃首条乐观视图，事务作废。
    if (firstSendHash && firstSendHash !== hash) setFirstSendHash('')
    if (firstSendHash !== hash) {
      messagesEl.innerHTML = '<div class="msg msg-system">加载中…</div>'
    }
    setChar(1) // 加载中 → 默认形象
    inputWrap.classList.add('docked')
    chatArea.classList.add('in-session')
    fetchMessages(s.id)
      .then(({ messages, context, model, modelTs, effort, cwd, file, queued, tasks, deltaSeq }) => {
        if (state.currentHash !== hash) return
        setSessionCwd(cwd)
        // 2026-09-08 事件流统一 P1：首载回程同样重置 delta 本地基线（与 refreshSession 对称，
        // 切会话清理后由本回程重建；此后 session-delta 增量演进至下轮全量对账）。
        live.localMessages = messages
        live.deltaSeq = deltaSeq
        // 切会话队列快照硬重置（2026-08-30）：以本会话响应为准，杜绝上一会话残留
        live.queueRemote = Array.isArray(queued) ? queued : []
        // 切会话任务清单硬重置（2026-09-10）：以本会话响应为准（空数组 = 该会话无清单 → 浮窗不出现）
        live.tasks = Array.isArray(tasks) ? tasks : []
        renderTaskDock()
        // 首条消息事务收口：本会话真实数据已落盘（渲染权威接管起点）→ 销毁事务，queue-dock
        // 恢复正常渲染。销毁先于下方守卫/重建：事务只在「乐观权威期」存在。
        // txTakeover/计时移交语义见 refreshSession 同款收口注释（接管帧跳过 stampMsgIn+续算计时）。
        let txTakeover = false
        if (firstSendHash === hash && messages.length > 0) {
          txTakeover = true
          for (const p of pendingUserMsgs) if (p.hash === '') p.hash = hash // 事务归属落定：'' 项归入本会话（吸收判定依赖 p.hash===cur）
          live.txProcStart = claimStartTs() // 主张计时起点移交（bindLiveFoldTimer 续算，跨接管不回跳）
          setFirstSendHash('')
        }
        // 2026-08-30 图片内联渲染：会话 uuid（file-cache 目录名）供用户气泡 <img> URL 拼接，
        // 首开即设（refreshSession 同款，防首屏图片 URL 带空 uuid）
        if (file) live.curUuid = file.replace(/\.jsonl$/, '')
        live.lastDataTs = (messages.length && messages[messages.length - 1].timestamp) || 0 // 切会话：基线硬重置为本会话末条 ts
        applySessionModel(model, modelTs) // 2026-08-24：打开会话即用 CLI 上报的实际模型校准 seat
        applySessionEffort(effort) // 2026-11-06：思考等级同链——本会话上报档位校准座显（缺键=未改过 → 全局默认）
        renderCtxMeter(context)
        // 首条消息事务期（2026-09-06）：fetch 空（CLI 尚未落盘首条 user）→ 跳过整页重建保留
        // 乐观 DOM（开启气泡+主张折叠是权威，不被「加载中…」/空态行洗掉），真实数据经 SSE
        // refreshSession 接管（refreshSession 同款「空 fetch 不洗盘」守卫已挡后续）。非空照常重建。
        if (!(firstSendHash === hash && messages.length === 0)) {
          messagesEl.innerHTML = messagesHtml(messages)
        }
        // 2026-08-29 切回会话：吸收该会话已落盘消息（切走不再清空 pending）；2026-09-07 暂态区
        // 收编——innerHTML 重建洗掉 #live-zone，renderTransient 从状态整体重渲（气泡/主张折叠/排队区）
        absorbPending(messages)
        queueClaimAdopt(queued) // 队首主张收编（刷新两段式根治，形态由 renderTransient 按 authLive 定）
        renderTransient()
        // 2026-09-11 ④ 只读提问卡接管已移除（用户定案「静态的提问卡不可交互的…直接移除就好」）：
        // 提问态在消息流里由紧凑工具行表达（askLineHtml「提问 · 等待回答」），作答在 CLI 窗口。
        // 此处只保留审批卡保护——交互式逐题审批卡占据输入栏时不得被 clearTakeover 洗掉。
        if (takeover !== 'approval') clearTakeover()
        setChar(charNote) // 只读 SSE：按末段最近工具/处理状态切形象
        bindLiveFoldTimer(messages)
        syncTurnLive() // 2026-09-04 打断按钮：渲染权威重建后按 done-live 在场校准（busy 会话直进）
        // 事务期（空 fetch 保留乐观 DOM）与接管帧不播入场动画：乐观气泡/proc 折叠已在位，
        // stampMsgIn(new Set()) 会对其重播 fadeup（「正在处理」创建/接管瞬间闪现重现）
        if (firstSendHash !== hash && !txTakeover) stampMsgIn(new Set())
        const last = messages.length ? messages[messages.length - 1] : null
        live.curSig = messages.length + ':' + (last ? (last.timestamp || '') : '') + ':' + (last && last.blocks.length ? last.blocks[last.blocks.length - 1].kind : '')
        // 记录末尾真实用户消息基线（=「回合开启消息」，与 live.js 同一条规则）：首屏默认不钉顶
        // （只有实时同步新增用户消息才唤出）。**注入引导消息（injected:true）恒排除**——它们是段内
        // 引导气泡（渲染为 data-t="g…"），不是回合开启消息；旧实现漏此过滤 → 末条 user 为引导消息
        // 时 lastU 指向它、`[data-m=lastU][data-t="u"]` 恒落空 → pinned=false → 该会话视图从不
        // 唤出占位（stage 全程未激活），发送时占位才首次创建 = 走旧拉伸动画首帧（跳到上一条消息）；
        // 同时把引导消息当新回合基线 → 下帧 hasNewUser 误判为真。
        let lastU = -1
        for (let i = messages.length - 1; i >= 0; i--) if (isRealUser(messages[i]) && !messages[i].injected) { lastU = i; break }
        const baseU = lastU >= 0 ? lastU + ':' + (messages[lastU].timestamp || '') : ''
        live.lastUserSig = baseU
        live.pinnedUserSig = baseU
        // 刷新/首屏恢复（两层消息流口径，2026-09-09 修订）：最后回合开启气泡在场即唤出占位
        // ——占位=开启气泡在第二层的映射，同等地位（2026-09-09 用户定案）。旧口径「仅末段
        // 处理中（done-live 在场）才唤出、回合已结束普通吸底」为 09-08 残留：回合收口「已
        // 处理」后刷新/切回占位永久死亡且无法恢复（用户实证）。几何 stageFollow 自洽无需
        // 分支：内容超一屏 → 贴顶位<内容底 → 吸底（与旧「普通吸底」逐像素一致）；不足一屏
        // → 占位垫底停贴顶位（两层流正确形态）。
        let pinned = false
        if (lastU >= 0) {
          const el = messagesEl.querySelector(`[data-m="${lastU}"][data-t="u"]`)
          if (el) {
            stageStart(el, baseU)
            pinned = true
          }
        }
        const sc = $('chat-scroll')
        if (!pinned) {
          sc.style.scrollBehavior = 'auto'
          sc.scrollTop = sc.scrollHeight
          sc.style.scrollBehavior = ''
        }
        // 2026-09-06 首条消息事务化：旧「fetch 空时补挂 addUser/procOpen」兜底整段删除——
        // 事务期乐观 DOM 是权威且不会被任何路径洗掉（888/913 守卫），无需补挂；不留兜底。
      })
      .catch((e) => toast('读取会话失败: ' + (e.message || e)))
  }

function setLastNavHash(v) { lastNavHash = v }
  // ---------- 消息渲染 ----------
  // AI 生成图取图 URL 解析（2026-10-03）：模型输出 ![](code)（code = 该项目根 .claude/images/ 下的文件名），
  // 把代号拼成网关取图 URL——复用 GET /gateway/file?label=<会话 label>&path=<相对路径>。
  // label 直接取会话自带 projectLabel：项目会话=<项目名>、全局根会话=「全局根 · 散装对话」；
  // 网关按 label 把全局项解析到工作区根，故全局会话同样能取图（不再按 scope 筛）。
  // 无 label（会话未找到）→ 返回 null，渲染层保留原文（不兜底）。label 取法同 inputbar/mention.js。
  setImageSrcResolver((code) => {
    const s = findSession(live.curUuid)
    const label = s ? (s.projectLabel || '') : ''
    return label ? `/gateway/file?label=${encodeURIComponent(label)}&path=${encodeURIComponent('.claude/images/' + code)}` : null
  })
  // 附件引用取图（2026-10-24 统一 file-cache）：正文里的 `![](file-cache/<会话id>/x.png)` 是网关签发的
  // rel（基址 = 会话启动根/.claude/file-cache），取字节走 GET /gateway/file-cache/<会话id>/<名>?sid=——
  // dir/uuid 无法区分项目，必须带上当前会话 sid 供网关解出项目根。
  setAttachmentResolver((code) => {
    const sid = state.currentHash
    return `/gateway/${code}` + (sid ? `?sid=${encodeURIComponent(sid)}` : '')
  })
  // 工具名 → 中文动作（弱化行展示，不单独成气泡）
  const TOOL_NAMES = {
    Read: '阅读', Edit: '编辑', Write: '写入', Grep: '搜索', Glob: '查找文件',
    Bash: '运行命令', WebFetch: '抓取网页', WebSearch: '搜索网页',
    NotebookEdit: '编辑笔记', TaskCreate: '创建任务', TaskUpdate: '更新任务',
    TaskGet: '查询任务', Agent: '委派 Agent', Skill: '调用技能', TodoWrite: '更新待办',
    AskUserQuestion: '提问',
  }
  // MCP 工具名 → 短显示名（沿用源码 mcpInfoFromString 的 split('__') 解析约定：
  // mcp__<server>__<tool> 取 tool 段；仅显示层用，权限匹配仍走原始名）。无 tool 段退回 server 名。
  function mcpShortName(name) {
    const parts = name.split('__')
    if (parts[0] !== 'mcp' || !parts[1]) return null
    return parts.slice(2).join('__') || parts[1]
  }
  // 工具块元信息：英文名 + 中文动作 + 详情（命令/路径/搜索词等）
  function toolMeta(block) {
    const name = block.name || 'tool'
    const zh = TOOL_NAMES[name] || mcpShortName(name) || name
    const inp = block.input && typeof block.input === 'object' ? block.input : null
    const detail = inp ? (inp.file_path || inp.filePath || inp.query || inp.pattern || inp.command || inp.toolName || inp.path || '') : ''
    return { name, zh, detail: typeof detail === 'string' && detail ? String(detail).slice(0, 120) : '' }
  }
  function toolLine(block) {
    const t = toolMeta(block)
    return `<span class="tool-line" data-name="${esc(t.name)}"><span class="t-ico">${toolIcon(t.name)}</span><span class="tl-text">${esc(t.zh)}${t.detail ? ' ' + esc(t.detail) : ''}</span></span>`
  }
  // 提问在消息流里的紧凑行（DSH 工具行语义）：icon + 「提问」+ 状态（等待回答 / 已回答）。
  // 2026-09-11 ④ 用户定案移除只读提问卡（`questionCardHtml` 静态不可交互的输入栏接管卡，
  // 「有一个静态的提问卡不可交互的…直接移除就好」）——AskUserQuestion 在 web 只留本紧凑行，
  // 作答在 CLI 窗口；web 可交互提问走 CLI 经审批链下发的 question 分支（renderQuestionApproval）。
  function askLineHtml(answered) {
    return `<span class="tool-line" data-name="AskUserQuestion"><span class="t-ico">${toolIcon('AskUserQuestion')}</span>提问 ${answered ? '已回答' : '等待回答'}</span>`
  }
  // 工具类型 → 概括短语（连续工具折叠的 summary 标签）
  const TOOL_VERB = {
    Read: '阅读了文件', Glob: '查找了文件', Grep: '搜索了代码',
    Bash: '运行了命令', WebFetch: '查看了网页', WebSearch: '搜索了网页',
    Edit: '编辑了文件', Write: '写入文件', NotebookEdit: '编辑了文件',
    Agent: '委派了子代理', Skill: '调用了技能', TodoWrite: '更新了待办',
    TaskCreate: '创建了任务', TaskUpdate: '更新了任务', TaskGet: '查询了任务',
    AskUserQuestion: '提出了问题',
  }
  // 一组工具的概括标签：去重保序 + 「、」/「并」连接，如「编辑了文件并运行了命令（3）」
  function toolFoldLabel(tools) {
    const verbs = []
    for (const t of tools) {
      const v = TOOL_VERB[t.name] || t.zh || '调用了工具'
      if (!verbs.includes(v)) verbs.push(v)
    }
    const label = verbs.length <= 1 ? (verbs[0] || '调用了工具') : verbs.slice(0, -1).join('、') + '并' + verbs[verbs.length - 1]
    return `${label}（${tools.length}）`
  }
  // 把段内 items（think/text/guide/tool 对象）渲染为 done-body 内部 HTML：
  // 连续 tool 合并成一个可展开折叠（默认收起省空间），思考/旁白/引导气泡原位穿插显示（与动作关联）。
  // 2026-08-30 恢复（工具行折叠回归）：v163 stackBody 重写把 groupTools/liveFoldBody 连同折叠
  // 一起删除（用户实测「工具行折叠的功能消失了」，对照 182358 正常版 diff 定位），本函数原样取回；
  // running 判定改用 done 标（现行 items 约定），供被打断段（closeSeg(false)）未完成工具亮 tf-dot。
  function groupTools(items) {
    let html = ''
    let group = []
    const flush = () => {
      if (!group.length) return
      const rows = group.map((g) => g.html).join('')
      const running = group.some((g) => !g.done)
      html += `<details class="tool-fold"${running ? ' data-state="running"' : ''}><summary>${running ? '<span class="tf-dot"></span>' : ''}<span class="tf-label">${esc(toolFoldLabel(group))}</span></summary><div class="tool-fold-body">${rows}</div></details>`
      group = []
    }
    for (const it of items) {
      if (!it || !it.html) continue // 占位/置空的块（reply 占位、被过滤的思考）
      if (it.kind === 'tool') { group.push(it); continue }
      flush()
      html += it.html
    }
    flush()
    return html
  }
  // 「状态行」归属判定（纯函数；2026-09-11 并发复合态根治——探针 probe-concurrent-status 跑本函数真实实现）。
  // 状态行（正在思考/正在生成/正在压缩）表述的是「引擎仍在产出」这一事实，**与「工具在飞」正交**。
  // 旧式把两者绑成互斥（busyOk 含 `!s.pendingTools.length`）→「模型边跑工具边继续产出」的真并发态被压成
  // 二选一，随内容块起点来回翻（用户实测「左侧 search 在闪」；CLI 侧同源判据 MessageRow.isActiveCollapsedGroup
  // 的 `isLoading && !hasContentAfter` 亦按内容块重算）。分档判据即不变量：
  //   ① 无工具在飞 + 无待答提问 + 回合未收口 → 回合未收口即引擎必然在产出（推断成立；原 busyOk 语义原样保留）；
  //   ② 有工具在飞 → 引擎是否仍在产出**不可推断**（工具跑完后引擎可能已收工等结果）→ 取证据 turn-beat 新鲜度：
  //      （此取证只约束**推断档** think/generating；压缩态是 CLI 显式上报的**实证**，自带证据，故判定序在其先，
  //       不受「工具在飞」约束——压缩与工具互斥是巧合而非不变量，把实证挂到推断之后正是本次要根除的互斥绑定。）
  //      REPL setResponseLength 内容增长分支 → notifyTurnBeat（4s 节流；thinking/text/工具参数三类 delta 全汇聚
  //      于此，= messages.ts onUpdateLength 的三处调用点）。新鲜 = 真并发 → 状态行与「正在运行：<工具>」同 summary
  //      并存（liveFoldBody 的 stateAppend 构造期拼接天然支持两行并存，无新渲染分支）。
  // 阈值 6s = 节流窗 4s + 2s 抖动余量；生产流中途 >6s 无 delta 属停摆，归 150s 无响应红标另管（live.js tick）。
  // beat 早于本回合起点视同缺席（上回合残留 beat 对新回合无意义）——与 live.js tick 的回合基线 clamp 同规则。
  const BEAT_FRESH_MS = 6000
  function vacuumOf(s, processing, live, now) {
    if (!processing) return null
    if (s.lastAsk && s.lastAsk.answer == null) return null
    // 压缩实时态（2026-09-04 queue-state 同款链）：压缩进行中 jsonl 零写入（boundary+summary 同毫秒落盘
    // 于结束时刻）→ lastStep 停在 'result'，CLI onCompactProgress → 网关 compact-state SSE 到达即强制压缩态
    // （TTL 5min 防 compact_end 丢失卡死）；结束回退思考态逻辑。显式实证，先于工具在飞取证。
    const cfTs = live.compactFlags.get(live.curUuid)
    if (s.lastStep === 'compact' || (cfTs && now - cfTs < 300000)) return 'compact'
    if (s.pendingTools.length > 0) {
      const beatAt = live.curUuid ? (live.turnBeat.get(live.curUuid) || 0) : 0
      const turnStart = (s.user && s.user.timestamp) || s.startTs || 0
      if (!(beatAt >= turnStart && now - beatAt < BEAT_FRESH_MS)) return null
    }
    // 行为分级文本（2026-09-10 用户定案「根据行为确定状态显示行文本」）：思考落盘/流式、工具结果刚回、
    // 段刚开 → 'think'「正在思考」；旁白已落盘、引擎产出下一动作（典型=生成 tool_use 参数 3~14s）
    // → 'generating'「正在生成」。
    return s.lastStep === 'text' ? 'generating' : 'think'
  }
  // 状态行文案（唯一映射源，2026-09-11 并发复合态定案）：join=false = 独立状态行全称
  // （正在思考/正在生成/正在压缩会话中……）；join=true = 并发尾缀，接在「正在运行：<工具> · <detail>」
  // 之后成同一行同一句（用户原话「思考和搜索同时进行就显示正在搜索xxx并思考」）。
  // 文案经 data-label 落到 DOM，live.js tick 只读该字段补计时，不在第二处复刻 mode→label 映射。
  function vacuumLabel(mode, join) {
    if (mode === 'compact') return join ? '并压缩中' : '正在压缩会话中……'
    if (mode === 'generating') return join ? '并生成' : '正在生成'
    return join ? '并思考' : '正在思考'
  }
  // 僵死/断连红标阈值：引擎最后产出（turn-beat）落后该秒数 = 无产出（live.js tick / approval.js
  // claimTick 同基准，两处共用本常量，不再各写 150）。
  const STALE_SEC = 150
  // 红标文案（唯一构造源，两处 tick 共用）。【2026-09-11 单状态槽定案】用户定案「一次应该只有一个
  // 状态，现在是无响应，应该只有无响应」——红标不再是状态文字旁的**注解**（旧形态前置分隔符「·」，
  // 与状态文字并排 ⇒ 实测出现「正在思考 · 2m57s · 无响应 2m51s」两个状态同时在场），而是状态槽的
  // **唯一占用者**：有红标时调用方给宿主状态行挂 .is-flagged（styles.css 隐去同行 .think-state/
  // .think-stream），故文案不带前导「·」。优先级：连接中断（链路断，一切产出不可信）> 无响应（链路
  // 活而引擎无产出）。staleSec<=0 = 本帧无僵死判定（调用方按各自豁免规则传 0：审批等待/工具在飞）。
  function statusFlags(connUp, staleSec) {
    return (connUp ? '' : '<span class="d-stale">连接中断</span>')
      + (staleSec >= STALE_SEC ? '<span class="d-stale">无响应 ' + fmtDur(staleSec) + '</span>' : '')
  }
  // 实时（处理中）段体（2026-08-26 用户定案：一个工具调用轮次只渲染一个工具折叠行）：
  // 有工具在运行 → summary 显示「正在运行：<当前工具>」+ 光泽扫动，点开看全部工具步明细
  // （已完成行 + 当前运行行）；全部完成 → 折叠概括（与已处理段同形态）。
  // 【状态显示行落位（2026-09-09 用户定案两轮：①「折叠顶只留正在处理/已处理，状态标识
  // 与工具调用行在一起」；②二轮澄清「工具调用行本质=折叠体，子 DOM 分两类——tf-label 工具
  // 概括留存；正在思考/压缩/断连等标识显示动画但不留存」）】：状态显示行 .fold-state（扫光
  // 文字 + data-ts 起点，bindLiveFoldTimer 每秒原地补「· Ns」，流式预览/无响应红标同层）并入
  // 尾部工具折叠行 summary——四轮定案（2026-09-09）真空态并入时折叠顶只留状态显示行、不带已处理
  // 概括（「正在思考时不应再有『运行了命令（N）』」，两状态同行并存=图二实测反例；工具明细
  // 点开折叠仍在）；无状态并入时 summary=toolFoldLabel——单宿主单实例，不复现
  // 09-08 前双轨（尾组 label 原位替换+独立兜底行）的随机命中；折叠顶 summary 恒「正在处理」
  // 不轮转（v267 的 summary 轮转方案废弃）。
  // 思考永不独立成行（if (it.kind === 'think') continue）。引导气泡（kind 'guide'）按非 tool
  // 项原样穿插，打断工具组时组照常收口。
  function liveFoldBody(items, vacuumState, vacuumStart) {
    let html = ''
    let tools = []
    // 状态显示行并入走构造期拼接（2026-09-09 三轮根治）：stateAppend 仅循环后那次
    // flushTools 生效（旁白打断的收口组不带）；v275 的 sumEnd 字符偏移回切废弃——偏移漏算
    // `<details class="tool-fold"><summary>` 前缀 33 字符，插入点前错 33 字符把
    // <span class="tf-label"> 切碎成 `pan class="tf-label">` 纯文本漏出。
    let stateAppend = ''
    let stateMerged = false
    // 状态显示行原子件（唯一构造点）：join=false + withIcon=true → 独立状态行（行首图标槽）；
    // join=true → 并发尾缀，无独立图标（同一行已有工具图标，避免第二个图标槽=视觉堆叠）。
    const stateSpan = (join, withIcon) => {
      const label = vacuumLabel(vacuumState, join)
      return `<span class="think-state${join ? ' ts-join' : ''}" data-ts="${vacuumStart || ''}" data-mode="${vacuumState}" data-label="${esc(label)}">${withIcon ? `<span class="t-ico">${THINK_ICON}</span>` : ''}<span class="ts-text">${esc(label)}</span></span>`
    }
    const flushTools = (isTail) => {
      if (!tools.length) return
      const rows = tools.map((g) => (g.kind === 'tool' && g.done) ? g.html : toolCurHtml(g.block)).join('')
      const running = tools.filter((g) => g.kind === 'tool' && !g.done)
      let sumInner
      if (running.length) {
        // 并发复合态（2026-09-11 用户定案）：状态并入同一行成「正在运行：<工具> · <detail> 并思考」。
        // 旧并列实现把工具行与状态行当 summary 的两个 flex 兄弟，而行容器 .fold-state 是 flex:1 1 0
        // （flex-basis 0 + min-width 0）→ 尺寸只看剩余空间、不看内容：nowrap 的工具文本吃满整行后
        // .fold-state 只剩 ~0.8px，其内无 white-space 规则的短标签逐字换行成竖列（N×22px）→ summary
        // 撑成 ~90px 高的空灰块（受控浏览器实测 summary 716×90、.fold-state 0.8×88、字号 14px）。
        // 根治：唯一行容器 .fold-state 同时承载「运行行（可收缩，.tl-text 省略号收尾）+ 状态尾缀（原子）」，
        // 收缩压力落在工具文本上、尾缀恒完整 → 几何上不可能再出现逐字换行。
        const cur = toolMeta(running[running.length - 1].block)
        const runLine = `<span class="tool-line tool-running" data-name="${esc(cur.name)}"><span class="t-ico">${toolIcon(cur.name)}</span><span class="tl-text">正在运行：${esc(cur.zh)}${cur.detail ? ' ' + esc(cur.detail) : ''}</span></span>`
        if (isTail && vacuumState) {
          sumInner = `<span class="fold-state">${runLine}${stateSpan(true, false)}</span>`
          stateAppend = '' // 已并入本行，防下方 ${stateAppend} 二次追加
          stateMerged = true
        } else {
          sumInner = runLine
        }
      } else if (stateAppend) {
        // 真空态（正在思考/生成/压缩）并入：折叠顶只留状态显示行、不带已处理概括（2026-09-09 四轮定案
        // 「正在思考时不应再有『运行了命令（N）』」，两状态同行并存=图二实测反例）；工具明细点开折叠仍在
        sumInner = ''
      } else {
        sumInner = `<span class="tf-label">${esc(toolFoldLabel(tools))}</span>`
      }
      html += `<details class="tool-fold"><summary>${sumInner}${stateAppend}</summary><div class="tool-fold-body">${rows}</div></details>`
      if (stateAppend) stateMerged = true
      stateAppend = ''
      tools = []
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (!it || !it.html) continue // 占位/置空的块（reply 占位、被过滤的思考）
      if (it.kind === 'think') continue // 思考永不独立成行（真空态=工具行内 .fold-state 状态显示行）
      if (it.kind === 'tool') { tools.push(it); continue } // 完成/运行中的工具都进当前组 → 统一成一个折叠行
      flushTools(false) // 中途被旁白/文本/引导气泡打断的工具组按普通折叠收口（非段尾，不并状态行）
      html += it.html
    }
    // 状态显示行（真空态；2026-09-09 二轮定案：工具调用行=折叠体，tf-label 留存、状态标识暂态不
    // 留存）：有尾部工具组 → .fold-state 暂态层构造期并入其 summary（label 后同一行）；
    // 尾部无工具组（纯思考真空/末尾是旁白）→ 段尾独立行。计时起点=段内最后一条落盘记录时刻。
    let stateInner = ''
    if (vacuumState) {
      // 行首图标槽（2026-09-11 用户定案）：独立状态行与工具行共享同一行首几何（16px 槽 + 5px gap，
      // 图标复用 DSH IconThinkOutline14 原子图标）——同一宿主行在「正在运行：<工具>」⇄「正在思考/
      // 生成/压缩」之间切换时文字左缘零位移（此前状态行无槽，文字回跳 21px = 用户实测「跳动」）。
      // 文本另置 .ts-text 子节点：live.js tick 只更新该节点（整节点 textContent 会连图标槽一起
      // 洗掉 → 槽消失、回跳依旧）。
      stateInner = stateSpan(false, true)
      stateAppend = `<span class="fold-state">${stateInner}</span>`
    }
    // 尾部工具组恒收口（2026-09-10 根治）：旧实现 flushTools() 只写在 vacuumState 分支内，而当时的
    // 判定式含 `!pendingTools.length`（工具在飞恒假）→ vacuumState=null → 该分支不进 → 尾部工具组
    // 整组不产出（无中断项调 flushTools）。实证（受控浏览器页面自采样，前台 Bash 20s 窗口）：
    // .tool-running=0、.tool-fold 数恒定不长、状态行亦空 → 处理中段体整段空白；工具结果
    // 回来那一帧才借真空态 flush 长出折叠行 = 用户实测「工具行只在跑完后才出现 / read、search 更是
    // 根本没有」。收口后 flushTools 内 running 分支（`正在运行：<工具>`）成为可达出口——正是术语
    // 定案里「状态行 = 正在思考/正在生成/正在压缩/正在运行:工具」的一次性实时动画位。不变量：
    // 处理中段的尾部工具组恒有渲染出口，段体空白只允许发生在「无工具且无真空态」的瞬态。
    // 2026-09-11 并发复合态：vacuumState 与 pendingTools 解耦后，「有工具在飞 + 引擎仍在产出」时
    // stateAppend 非空，且被尾组 running 分支取走、并成一行一句（见上方 running 分支注）——
    // 尾组无运行行时 stateAppend 仍走下面普通并存路径（`${sumInner}${stateAppend}`）。
    flushTools(true)
    if (vacuumState && !stateMerged) html += `<div class="fold-state">${stateInner}</div>`
    return html
  }
  // 当前正在运行的工具步（实时段专用）：复用原灰色工具行（tool-line）的 inline 形态，仅加 .tool-running
  // 光泽扫动标识运行态（无蓝点、无 <details> 提示行、无输入 JSON，用户 2026-08-26 定案）。
  function toolCurHtml(block) {
    const t = toolMeta(block)
    return `<span class="tool-line tool-running" data-name="${esc(t.name)}"><span class="t-ico">${toolIcon(t.name)}</span><span class="tl-text">${esc(t.zh)}${t.detail ? ' ' + esc(t.detail) : ''}</span></span>`
  }

  // ---- 文件变更汇总卡片（Codex 风格：+N 绿 / -N 红）----
  // 数据源（2026-08-23 起）：源码 conversationDisplay.ts 在 tool_result 块上输出结构化
  // fileChange {filePath, added, removed}（权威数字 = 源码 diff.ts sumLinesChanged，由
  // Edit/Write 工具写入文本后缀 `(+N -M)`），前端直接消费字段。
  // parseFileChange 正则反解仅作旧网关/离线数据兜底，新 exe 部署后可删。
  function baseName(p) {
    const s = String(p || '').replace(/\\/g, '/')
    return s.split('/').pop() || s
  }
  // 相对启动根路径显示（2026-08-29）：路径在会话启动根（sessionCwd）下 → 剥前缀显示相对路径
  // （如 src/gateway/web/app.js）；不在根下/未知 cwd → 回退文件名。仅显示层，聚合 key 仍用绝对路径。
  function relFromCwd(p) {
    const norm = String(p || '').replace(/\\/g, '/')
    const root = String(sessionCwd || '').replace(/\\/g, '/').replace(/\/+$/, '') + '/'
    if (root.length > 1 && norm.toLowerCase().startsWith(root.toLowerCase())) {
      return norm.slice(root.length) || baseName(norm)
    }
    return baseName(norm)
  }
  // 从 tool_result 文本提取文件路径与增删行数（Edit/Write 统一格式）——旧网关兜底
  function parseFileChange(text) {
    if (!text) return null
    const t = String(text).trim()
    const m = /\([+-](\d+)\s*[+-](\d+)\)\s*\.?\s*$/.exec(t)
    if (!m) return null
    let path = null
    const fm = /The file\s+(.+?)\s+has been updated/.exec(t)
    if (fm) path = fm[1]
    else {
      const cm = /File created successfully at:\s+(.+?)\s*\(/.exec(t)
      if (cm) path = cm[1]
    }
    if (!path) return null
    return { path: path.trim(), added: Number(m[1]), removed: Number(m[2]) }
  }
  // 归一化为聚合用的 {path, added, removed} 形态（结构化 fileChange 用 filePath 命名）
  function normalizeFileChange(fc) {
    if (!fc) return null
    if (fc.path != null) return { path: fc.path, added: fc.added || 0, removed: fc.removed || 0 }
    if (fc.filePath != null) return { path: fc.filePath, added: fc.added || 0, removed: fc.removed || 0 }
    return null
  }
  function mergeChanges(map, fc) {
    const prev = map.get(fc.path)
    map.set(fc.path, prev ? { added: prev.added + fc.added, removed: prev.removed + fc.removed } : { added: fc.added, removed: fc.removed })
  }
  function renderChangeCardHtml(changes, key) {
    if (!changes || !changes.size) return ''
    let totalAdd = 0, totalDel = 0
    let rows = ''
    for (const [path, c] of changes) {
      totalAdd += c.added
      totalDel += c.removed
      rows += `<div class="ch-row"><span class="ch-file">${esc(relFromCwd(path))}</span><span class="ch-add">+${c.added}</span><span class="ch-del">-${c.removed}</span></div>`
    }
    // 2026-08-19 默认折叠：卡片落地即为收起姿态（标题行 + ▸），点右上角展开文件列表
    // 2026-08-26：key 可选（messagesHtml 段尾传入 s.key）→ 带 data-m/data-t 供增量重建定位删除；
    // 实时 commitLiveChangeCard 不带 key（无 data-m，属消息流外手动追加，不受增量删除影响）
    return `<div class="msg change-card collapsed"${key != null ? ` data-m="${key}" data-t="c"` : ''}><div class="ch-title"><span class="ch-count">${changes.size}个文件已更改</span><span class="ch-add">+${totalAdd}</span><span class="ch-del">-${totalDel}</span><button class="ch-toggle" title="收起/展开文件列表">${CHEV}</button></div><div class="ch-list">${rows}</div></div>`
  }

  // ---- 文件变更汇总卡片：历史/实时统一由 messagesHtml 段尾 seg.changes 数据驱动渲染
  //     （从 transcript 的 tool_result.fileChange 重建，切会话/刷新不丢）。原 WS out 实时内联行/
  //     commitLiveChangeCard 链随 WS out 流退役删除（网关从不投递 out，2026-09-07 定案）----
  // 卡片右上角隐藏按钮：点击切换列表收起/展开（事件委托，innerHTML 重建不受影响）
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.ch-toggle') : null
    if (!btn || !messagesEl.contains(btn)) return
    const card = btn.closest('.change-card')
    if (!card) return
    const collapsed = card.classList.toggle('collapsed')
    btn.innerHTML = CHEV
    btn.classList.toggle('open', !collapsed)
  })

  // 消息复制（2026-10-09 定案：复制「原始 markdown 源码」，非渲染文本）：data-md 的生产与消费同处
  // core/markdown.js（mdAttr 挂载 / messageMd·selectionMd 消费），此处只做「复制按钮点击 → writeClipboard」。
  // 复制按钮 = 该条消息 .body 内全部块级 data-md 按序拼接（折叠体/操作条不在 .body 内，天然排除）；
  // 选区复制（含纯文本降级）由全局唯一的 copy 拦截在 inputbar/ctx-meter.js 承载（勿在此另起监听）。
  function messageCopyText(msgEl) {
    return messageMd(msgEl.querySelector('.body'))
  }
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.msg-copy') : null
    if (!btn || !messagesEl.contains(btn) || btn.classList.contains('copied')) return
    const msgEl = btn.closest('.msg')
    if (!msgEl) return
    const text = messageCopyText(msgEl)
    if (!text) return
    writeClipboard(text).then((ok) => {
      if (!ok) { toast('复制失败'); return }
      btn.classList.add('copied')
      btn.innerHTML = I.dshCheck
      btn.title = '已复制'
      btn.setAttribute('aria-label', '已复制')
      setTimeout(() => {
        if (!btn.isConnected) return
        btn.classList.remove('copied')
        btn.innerHTML = ICON_COPY
        btn.title = '复制'
        btn.setAttribute('aria-label', '复制')
      }, 1000)
    })
  })

  // 引用胶囊点击跳转（2026-10-21）：一律经**卡片公开 API**（engine/card-bus.js）驱动目标卡，不直取他模块内部状态——
  //   · 回复引用 → chat 卡 `scroll{line}`（第 N 条 = .msg 文档序，与引用令牌「第 N 条回复」同源）
  //   · 文件引用 → work 卡 `scroll{path,line}`（卡内自带「仅 work 模式」门禁；非 work 回 ok:false → toast）
  // 目标卡不在场（如 work 卡尚未初始化）时总线显式报错，这里同样走 toast，不静默。
  document.addEventListener('click', (e) => {
    const chip = e.target && e.target.closest ? e.target.closest('.mention-chip[data-qjump]') : null
    if (!chip || !messagesEl.contains(chip)) return
    const kind = chip.dataset.qjump
    const p = kind === 'reply'
      ? cardBus.callCard({ instanceId: 'floria-chat' }, 'scroll', { line: Number(chip.dataset.qidx) || 0 })
      : kind === 'file'
        ? cardBus.callCard({ instanceId: 'floria-work' }, 'scroll', { path: chip.dataset.qpath || '', line: Number(chip.dataset.ql0) || 0 }, { timeoutMs: 15000 })
        : null
    if (!p) return
    e.stopPropagation()
    p.then((ack) => { if (ack && ack.ok === false) toast(ack.error || '跳转失败') }).catch(() => {})
  })

  // 围栏代码块头栏按钮（2026-10-10；同 msg-copy 的委托+反馈模式）：复制 = 读本块 pre>code.textContent
  // （高亮只包 hljs-* span、不改文本，textContent 即原始代码）；换行 = toggleCodeWrap（全页现有块同步 + 持久化）。
  document.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target : null
    if (!el) return
    if (el.closest('.cb-wrap')) { toggleCodeWrap(); return }
    const btn = el.closest('.cb-copy')
    if (!btn || btn.classList.contains('copied')) return
    const block = btn.closest('.code-block')
    const codeEl = block && block.querySelector('pre > code')
    const text = codeEl ? codeEl.textContent : ''
    if (!text) return
    writeClipboard(text).then((ok) => {
      if (!ok) { toast('复制失败'); return }
      const prev = btn.innerHTML
      btn.classList.add('copied')
      btn.innerHTML = I.dshCheck
      setTimeout(() => { if (!btn.isConnected) return; btn.classList.remove('copied'); btn.innerHTML = prev }, 1000)
    })
  })

  // 用量明细弹层（DSH 回复操作条「用量 X tok」按钮 → 点击弹出面板）：单开互斥（开本关它），点外区关闭。
  // 面板 .usage-pop 在 .msg-actions 内、与 .msg-usage 同属 .msg；按钮 aria-expanded 同步。
  function closeUsagePops(except) {
    messagesEl.querySelectorAll('.usage-pop:not([hidden])').forEach((p) => {
      if (p === except) return
      p.hidden = true
      const b = p.parentElement && p.parentElement.querySelector('.msg-usage')
      if (b) b.setAttribute('aria-expanded', 'false')
    })
  }
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.msg-usage') : null
    if (btn && messagesEl.contains(btn)) {
      const pop = btn.parentElement && btn.parentElement.querySelector('.usage-pop')
      if (!pop) return
      const open = pop.hidden
      closeUsagePops(pop)
      pop.hidden = !open
      btn.setAttribute('aria-expanded', open ? 'true' : 'false')
      return
    }
    if (e.target && e.target.closest && e.target.closest('.usage-pop')) return
    closeUsagePops(null)
  })

  // ---- 嵌入式图表（```chart 围栏，渲染链见 core/markdown.js）----
  // 「源码」切换（事件委托，innerHTML 重建不受影响）：.chart-embed.as-src 切 iframe ↔ 原文
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.chart-src') : null
    if (!btn || !messagesEl.contains(btn)) return
    const box = btn.closest('.chart-embed')
    if (!box) return
    btn.textContent = box.classList.toggle('as-src') ? '图表' : '源码'
  })

  // 高度自适应：sandbox iframe（opaque origin）内 BOOT 量 body/documentElement scrollHeight 上报
  // __chartH；按 e.source 精确匹配本页 .chart-frame 才采纳（其它窗口/preview iframe 伪造不进来），
  // 高度上限交给 CSS max-height，超出内部滚动。宽度变化（如侧栏拖宽）→ 内容高变 → 内部 ResizeObserver 重报，闭环。
  addEventListener('message', (e) => {
    const h = e.data && e.data.__chartH
    if (typeof h !== 'number' || !isFinite(h) || h <= 0) return
    for (const f of document.querySelectorAll('iframe.chart-frame')) {
      if (f.contentWindow !== e.source) continue
      const nh = Math.round(h)
      if (Math.abs((parseFloat(f.style.height) || 0) - nh) > 1) f.style.height = nh + 'px'
      return
    }
  })

  // 压缩/自动摘要标记：转录里压缩会把「会话续接」记成 user|text（后端已映射 role:'system'，
  // 标签「会话续接（自动摘要）」）。命中它 = 当前回合被压缩打断，但 agent 仍在干活——
  // 不应把它当成回合结束，否则「正在处理」被强收成「已处理」、后续思考/工具拆成断开的新段。
  // ⚠️ 存活代码勿删（2026-08-27 P2 复核纠正审查报告§C 结论）：shouldShowUserMessage 只剔 isMeta，
  // 而 isCompactSummary 续接记录不带 isMeta、conversationDisplay 亦无专门剔除 → 经网关 display /
  // 磁盘兜底同样以 role:'user' 到达前端；处理中命中即驱动 liveFoldBody 真空态「正在压缩会话中……」行，
  // 已收尾时静默吞行。英/中双正则分别兜官方原文与离线标签两种形态。
  const CONTINUED_RE = /This session is being continued from a previous conversation/i
  function isContinuationMsg(m) {
    if (m.role !== 'system' && m.role !== 'user') return false
    return m.blocks.some((b) => b.kind === 'text' && (CONTINUED_RE.test(b.text) || b.text.includes('会话续接')))
  }

  // 真实用户消息（带文本/图片，非纯工具回包）：开新段/新回合检测/处理中计时共用。
  // 合成 user（后台任务通知/对话中断等）已由源码 shouldShowUserMessage 剔除（A/B 路径）、
  // 离线路径由 server.mjs readSession 映射为 role:'system'（C 路径）——前端无需再判系统注入
  // 文本（isSynthText/SYNTH_RE 已于 2026-08-23 删除，见交接文档任务 1）。
  // 跨会话来件的来源行（2026-09-15 会话间协作）：气泡外一行灰字标识来自哪个会话。
  // 来源由 CLI 投影给定（DisplayMessage.fromSession，正文里的 `<session-message from=…>` 包装
  // 已在 conversationDisplay 剥离）——前端不解析包装、不复刻判据。无该字段 = 本地用户输入，
  // 渲染与本地消息完全一致（用户定案：气泡本体形态不变，只有气泡外多一行小字）。
  // 位置：插在 .body 之前（DOM 序 = 视觉上方），.msg 是列向 flex → 在文档流里占位（不做绝对定位，
  // 不参与气泡高度计算），故对既有高度/滚动占位（stageSync 贴顶位）零影响。
  function whoHtml(m) {
    const f = m && m.fromSession
    if (!f || !f.title) return ''
    return `<div class="who">来自 会话：${esc(String(f.title))}</div>`
  }

  function isRealUser(m) {
    if (m.role !== 'user') return false
    return m.blocks.some((b) => (b.kind === 'text' && b.text && b.text.trim()) || b.kind === 'image')
  }

  // 回合终止性 stopReason（2026-08-31）：官方 end_turn 之外，第三方商正常终止可能返回
  // 'stop_sequence'（CLI 未配置 stop_sequence 参数，纯文本回复即自然结束；jsonl 实证其后无
  // assistant 记录 = CLI 已按回合结束收尾）。只认 end_turn 会把这类已完成的回合刷新后误判
  // 「正在处理」重新计时、回复沉进折叠体（实测 2471f361/6f1f48fb）。'tool_use'/null 仍=处理中。
  function isEndStop(sr) {
    return sr === 'end_turn' || sr === 'stop_sequence'
  }

  // 用户气泡正文（2026-08-30 图片渲染，用户定案：图在气泡外）：
  // 带 imageId 的 image 块 → 气泡只出文本（剥掉文本里已渲染图的 [Image #N] 占位），
  // 图由 userImgsHtml 渲染在气泡框外；字节走网关 GET /gateway/file-cache/<会话uuid>/<id>?sid=<会话hash>
  // （复用 CLI processUserInput storeImages 落盘的 <项目根>/.claude/file-cache，display JSON 不塞 base64）。
  // 无 imageId（旧记录）→ 回落 [图片] 占位/纯文本；图已落盘后被清（会话重启
  // cleanupOldFileCaches 清非当前会话缓存）→ userImgsHtml onerror 出 [Image #N] 裸文本。
  function userBodyHtml(m) {
    const ids = []
    for (const b of m.blocks) if (b.kind === 'image' && b.imageId) ids.push(b.imageId)
    let txt = m.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('')
    // [Image #N] 是 web 发送端内部令牌（占位 ↔ pastedContents id ↔ file-cache 文件名 ↔ 图片块
    // imageId 同源），**永不上屏：无条件全剥**。旧「只剥有 image 块对应的那几个 id」在链上任何一处
    // 少一张图时（网关曾按 ≤4 张静默截断；non-vision 模型 CLI 丢弃 image 块同理）多出的占位会漏成
    // 消息裸文本（用户实测 [Image #5] [Image #6] [Image #7]）。对应图片本体由 userImgsHtml 依图片块
    // imageId（无图片块时回落文本占位）另行渲染，与剥除无关、不重影。
    txt = txt.replace(/\s*\[Image #\d+\]/g, '')
    // 文件占位（2026-09-12 文件上传）：[文件:<绝对路径>] 剥出渲染成文件卡片（userFilesHtml）
    txt = txt.replace(/\s*\[文件:[^\]]*\]/g, '')
    // 引用原文块 → 锚点胶囊 + 原文引用块（2026-10-21：原文照样显示，不再剥掉）
    txt = quoteBodiesAsMarkdown(txt)
    const hasImg = m.blocks.some((b) => b.kind === 'image')
    return mdHtml(hasImg && !ids.length && !txt.trim() ? '[图片]' : txt)
  }

  // 文本里的 [Image #N] 占位（web 发送端拼的内部令牌）→ id 列表。CLI 落盘文件名即 N
  // （storeImages 按 pastedContents id 命名），故凭占位即可拼出 file-cache URL。
  function textImageIds(m) {
    const txt = m.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('')
    const out = []
    txt.replace(/\[Image #(\d+)\]/g, (_, n) => { out.push(Number(n)); return '' })
    return out
  }

  // 图片容器（用户 2026-08-30 定案：渲染在气泡外）：.msg 内、.body 后——.msg 无背景，
  // 视觉即气泡正下方右侧。图未落盘（404）→ onerror 替换为 [Image #N] 裸文本，不出破图
  //（用户定案「会话重启后图片不留盘，就仅渲染裸文本就好了」）。
  // id 来源两路：image 块 imageId（vision 模型，CLI 把图附进 content）；无 image 块时回落
  // 文本占位符（non-vision 模型，CLI 丢弃 image 块但 storeImages 仍无条件落盘）——保证
  // 「模型忽略图片」不等于「界面不显示图片」，切换识图模型后同一路径即正常可用。
  function userImgsHtml(m) {
    const ids = []
    for (const b of m.blocks) if (b.kind === 'image' && b.imageId) ids.push(b.imageId)
    if (!ids.length) ids.push(...textImageIds(m))
    if (!ids.length) return ''
    // 取字节的基址由网关按 sid → project → 网关自身根 解析。sid = currentHash，**首屏早期它可能还是
    // 路由里的短 uuid（会话列表未拉到时 resolveSessionHash 原样透传）**，解不出启动根 → 落到网关自身
    // 根，全局会话（jsonl 在工作区根）的图因此 404、onerror 变 [Image #N] 裸文本（用户实测）。
    // 故同时带上会话自带 projectLabel（项目会话=项目名 / 全局=「全局根 · 散装对话」），网关按 label
    // 解析到会话启动根——与 /gateway/file 取 AI 生成图是同一口径，不再依赖 currentHash 是否已归一。
    const s = findSession(live.curUuid)
    const q = []
    if (state.currentHash) q.push('sid=' + encodeURIComponent(state.currentHash))
    if (s && s.projectLabel) q.push('project=' + encodeURIComponent(s.projectLabel))
    const qs = q.length ? '?' + q.join('&') : ''
    const imgs = ids.map((id) => `<img class="msg-img" loading="lazy" alt="图片" data-ph="[Image #${id}]" onerror="this.replaceWith(document.createTextNode(this.dataset.ph))" src="/gateway/file-cache/${live.curUuid || ''}/${id}${qs}">`).join('')
    return `<div class="msg-imgs">${imgs}</div>`
  }

  // 文件卡片（2026-09-12 文件上传，用户定案「像图片一样有对应的 UI」）：与图片同构——消息文本里
  // 的 [文件:<落盘绝对路径>] 占位剥出渲染成气泡外下方文件卡片（图标+文件名，title=完整路径，
  // 点击复制路径供粘贴他用）。文件落 file-cache/<会话id>/（与粘贴图片同目录，随会话清理），
  // 卡片形态与图片的 404/裸文本回落不共用。
  function fileCardsHtml(paths) {
    const cards = paths.map((p) => {
      const name = String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
      return `<span class="msg-file" role="button" data-path="${esc(p)}" title="${esc(p)}">${fileIcon(name)}<span class="mf-name">${esc(name)}</span></span>`
    }).join('')
    return `<div class="msg-files">${cards}</div>`
  }
  function userFilesHtml(m) {
    const txt = m.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('')
    const paths = []
    txt.replace(/\[文件:([^\]]+)\]/g, (_, p) => { paths.push(p.trim()); return '' })
    return paths.length ? fileCardsHtml(paths) : ''
  }
  // 文件卡片点击 = 复制落盘路径（事件委托，innerHTML 重建不受影响）
  document.addEventListener('click', (e) => {
    const c = e.target && e.target.closest ? e.target.closest('.msg-file') : null
    if (!c || !messagesEl.contains(c)) return
    writeClipboard(c.dataset.path || '').then((ok) => toast(ok ? '已复制路径' : '复制失败'))
  })

  // 大图预览 lightbox（2026-08-30 用户定案：单击缩略图看大图）：单例覆盖层，
  // src 复用缩略图同 URL（网关 Cache-Control private 1d，字节已缓存零请求）；
  // 点击任意处 / Esc 关闭。事件委托 document 级绑一次，覆盖历史/实时/SSE 全渲染路径。
  function ensureLightbox() {
    let lb = document.getElementById('img-lightbox')
    if (lb) return lb
    lb = document.createElement('div')
    lb.id = 'img-lightbox'
    lb.innerHTML = '<img alt="大图预览">'
    lb.addEventListener('click', () => lb.classList.remove('on'))
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') lb.classList.remove('on') })
    document.body.appendChild(lb)
    return lb
  }
  // 除消息内缩略图外，底栏附件胶囊缩略图（`.img-pill`）也走同链——复用单例 lightbox（禁另起一套），
  // 胶囊 dataUrl 直接作 src（本地无请求）。（2026-10-16：胶囊点击大图预览）
  // 注意：`.img-pill img` 恒 `pointer-events:none`（点击落在包裹层），故匹配 `.img-pill` 再取内层 img；
  // 且须排除 `.img-x`（移除钮）——它也在 `.img-pill` 内，命中则只移除不开预览。
  // 编辑面内联小图（`.cm-att-img`：底栏 @ 引用图 / work 编辑卡上传图，editor-attachments.edAttImgPlugin
  // 渲成 `<span class="cm-att-img"><img>`）同链——此前只认 `.msg-img` ⇒ 编辑面点小图无反应（2026-10-16
  // 用户实测「发送出来的小图可以、编辑面里的不行」）。widget `ignoreEvent()===true` ⇒ 点击直达 document。
  document.addEventListener('click', (e) => {
    const t = e.target
    if (!t || !t.closest) return
    let src = ''
    const mimg = t.closest('.msg-img')
    if (mimg) src = mimg.currentSrc || mimg.src
    else {
      const aimg = t.closest('.cm-att-img')
      if (aimg) {
        const im = aimg.querySelector('img')
        if (im) src = im.currentSrc || im.src
      } else if (!t.closest('.img-x')) {
        const pill = t.closest('.img-pill')
        const im = pill && pill.querySelector('img')
        if (im) src = im.currentSrc || im.src
      }
    }
    if (!src) return
    const lb = ensureLightbox()
    lb.querySelector('img').src = src
    lb.classList.add('on')
  })

  // 已处理时长：10m 50s 风格
  function fmtDur(sec) {
    if (!(sec > 0)) return ''
    if (sec < 60) return sec + 's'
    const m = Math.floor(sec / 60)
    const s = sec % 60
    if (m < 60) return s ? m + 'm ' + s + 's' : m + 'm'
    const h = Math.floor(m / 60)
    return h + 'h ' + (m % 60) + 'm'
  }

  // 思考/旁白文本：无气泡框，浅灰小字（收在「已处理」折叠区内）
  function processTextHtml(text) {
    return `<div class="done-think">${mdHtml(text)}</div>`
  }

  // ---- 思考折叠行（2026-08-22 移植 deepseek-harness ReasoningRow / DisclosureRow）----
  // 每个思考块 = 一条可展开折叠行：14px 思考图标 + 「思考」标题 + 2×2 圆点 + 摘要
  // （已结束=首行 / 运行中=末行实时跟随），展开正文 14/24 弱化色、左缩进 22px，运行中扫光动画。
  // 图标 path 精确取自 deepseek-harness packages/client/ui-primitives/src/icons/index.tsx
  // （IconThinkOutline14 / IconChevronDownOutline14，fill=currentColor 随父级）。
  const THINK_ICON = '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7.06431 5.93342C7.68763 5.93342 8.19307 6.43904 8.19322 7.06233C8.19322 7.68573 7.68772 8.19123 7.06431 8.19123C6.44099 8.19113 5.9354 7.68567 5.9354 7.06233C5.93555 6.43911 6.44108 5.93353 7.06431 5.93342Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M8.6815 0.963693C10.1169 0.447019 11.6266 0.374829 12.5633 1.31135C13.5 2.24805 13.4277 3.75776 12.911 5.19319C12.7126 5.74431 12.4386 6.31796 12.0965 6.89729C12.4969 7.54638 12.8141 8.19018 13.036 8.80647C13.5527 10.2419 13.6251 11.7516 12.6883 12.6883C11.7516 13.625 10.242 13.5527 8.8065 13.036C8.19022 12.8141 7.54641 12.4969 6.89732 12.0965C6.31797 12.4386 5.74435 12.7125 5.19322 12.911C3.75777 13.4276 2.2481 13.5 1.31138 12.5633C0.374859 11.6266 0.447049 10.1168 0.963724 8.68147C1.17185 8.10338 1.46321 7.50063 1.82896 6.8924C1.52182 6.35711 1.27235 5.82825 1.08872 5.31819C0.572068 3.88278 0.499714 2.37306 1.43638 1.43635C2.37308 0.499655 3.8828 0.572044 5.31822 1.08869C5.82828 1.27232 6.35715 1.5218 6.89243 1.82893C7.50066 1.46318 8.10341 1.17181 8.6815 0.963693ZM11.3573 8.01154C10.9083 8.62253 10.3901 9.22873 9.80943 9.8094C9.22877 10.3901 8.62255 10.9083 8.01158 11.3572C8.4257 11.5841 8.8287 11.7688 9.21275 11.9071C10.5456 12.3868 11.4246 12.2547 11.8397 11.8397C12.2548 11.4246 12.3869 10.5456 11.9071 9.21272C11.7688 8.82866 11.5841 8.42568 11.3573 8.01154ZM2.56529 8.02912C2.37344 8.39322 2.21495 8.74796 2.09263 9.08772C1.61291 10.4204 1.74512 11.2995 2.16001 11.7147C2.57505 12.1297 3.45415 12.2618 4.78697 11.7821C5.11057 11.6656 5.44786 11.5164 5.7938 11.3367C5.249 10.9223 4.70922 10.4533 4.19029 9.9344C3.57578 9.31987 3.03169 8.67633 2.56529 8.02912ZM6.90708 3.2469C6.24065 3.70479 5.5646 4.26321 4.91392 4.91389C4.26325 5.56456 3.70482 6.24063 3.24693 6.90705C3.72674 7.63325 4.32777 8.37459 5.03892 9.08576C5.64943 9.69627 6.28183 10.2265 6.90806 10.6678C7.59368 10.2025 8.2908 9.63076 8.96079 8.96076C9.6308 8.29075 10.2025 7.59366 10.6678 6.90803C10.2265 6.2818 9.69631 5.6494 9.08579 5.03889C8.37462 4.32773 7.63328 3.72672 6.90708 3.2469ZM11.7147 2.15998C11.2996 1.74509 10.4204 1.61288 9.08775 2.0926C8.74835 2.21479 8.39382 2.37271 8.03013 2.56428C8.67728 3.03065 9.31995 3.5758 9.93443 4.19026C10.4534 4.7092 10.9223 5.24896 11.3368 5.79377C11.5164 5.44785 11.6656 5.11052 11.7821 4.78694C12.2618 3.45416 12.1297 2.57502 11.7147 2.15998ZM4.91197 2.2176C3.57922 1.73788 2.70004 1.86995 2.28501 2.28498C1.87001 2.70003 1.73791 3.5792 2.21763 4.91194C2.31709 5.18822 2.44112 5.47427 2.58677 5.7674C3.01931 5.1887 3.51474 4.6158 4.06529 4.06526C4.61584 3.5147 5.18872 3.01928 5.76743 2.58674C5.47431 2.4411 5.18824 2.31706 4.91197 2.2176Z" fill="currentColor"/></svg>'
  const THINK_CHEV = '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z" fill="currentColor"/></svg>'
  // ---- 折叠 chevron（DSH IconChevronRightOutline14，「>」箭头，替换旧 ▸ 小三角）----
  const CHEV = '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M5.5 2.15137L5.92383 2.57617L8.65137 5.30273C8.90706 5.55843 9.13382 5.78438 9.29785 5.98828C9.46883 6.20088 9.61756 6.44405 9.66602 6.75C9.69222 6.91565 9.69222 7.08435 9.66602 7.25C9.61756 7.55595 9.46883 7.79912 9.29785 8.01172C9.13382 8.21561 8.90706 8.44157 8.65137 8.69727L5.92383 11.4238L5.5 11.8486L4.65137 11L5.07617 10.5762L7.80273 7.84863C8.07732 7.57405 8.24849 7.40124 8.3623 7.25977C8.46904 7.12709 8.47813 7.07728 8.48047 7.0625C8.48703 7.02105 8.48703 6.97895 8.48047 6.9375C8.47813 6.92272 8.46904 6.87291 8.3623 6.74023C8.24848 6.59876 8.07732 6.42595 7.80273 6.15137L5.07617 3.42383L4.65137 3L5.5 2.15137Z" fill="currentColor"/></svg>'

  // ---- 工具步骤图标（2026-08-21 移植 deepseek-harness ui-tool 的 variant leading 映射，
  // path 精确取自 ui-primitives/icons/index.tsx，fill=currentColor 随父级；替代旧 ⚙ 齿轮）----
  const ICON_BROWSE = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.2426 4.80473V6.10551H4.75819V4.80473H11.2426Z" fill="currentColor"/><path d="M9.40858 7.84478V9.14557H4.75819V7.84478H9.40858Z" fill="currentColor"/><path d="M9.23438 0.546389C10.1941 0.546389 10.9683 0.544914 11.5859 0.611819C12.2161 0.680096 12.7634 0.825745 13.2393 1.17139C13.5172 1.3733 13.7619 1.61812 13.9639 1.896C14.3096 2.37183 14.4551 2.91922 14.5234 3.54932C14.5903 4.16686 14.5889 4.94133 14.5889 5.90088V10.0981C14.5889 11.0576 14.5903 11.8321 14.5234 12.4497C14.4552 13.0798 14.3094 13.6272 13.9639 14.103C13.7619 14.381 13.5172 14.6257 13.2393 14.8276C12.7633 15.1734 12.2163 15.3189 11.5859 15.3872C10.9683 15.4541 10.1942 15.4536 9.23438 15.4536H6.76563C5.80591 15.4536 5.03168 15.4541 4.41407 15.3872C3.78385 15.3189 3.23665 15.1734 2.76074 14.8276C2.48291 14.6257 2.23802 14.3809 2.03614 14.103C1.69066 13.6272 1.54483 13.0798 1.47657 12.4497C1.40973 11.8321 1.41114 11.0576 1.41114 10.0981V5.90088C1.41113 4.94132 1.40966 4.16686 1.47657 3.54932C1.54488 2.91921 1.69042 2.37184 2.03614 1.896C2.2381 1.61807 2.4828 1.37333 2.76074 1.17139C3.23665 0.825682 3.78386 0.680109 4.41407 0.611819C5.03168 0.544905 5.80591 0.546389 6.76563 0.546389H9.23438ZM6.76563 1.896C5.77586 1.896 5.0876 1.89738 4.55957 1.95459C4.0443 2.01043 3.76214 2.11349 3.55469 2.26416C3.39135 2.38284 3.24761 2.52662 3.12891 2.68994C2.97821 2.89736 2.8752 3.17967 2.81934 3.69483C2.76214 4.22279 2.76075 4.91131 2.76074 5.90088V10.0981C2.76074 11.0876 2.76221 11.7762 2.81934 12.3042C2.87516 12.8194 2.97829 13.1026 3.12891 13.3101C3.24754 13.4733 3.39147 13.6172 3.55469 13.7358C3.76213 13.8865 4.04438 13.9896 4.55957 14.0454C5.0876 14.1026 5.77586 14.103 6.76563 14.103H9.23438C10.2242 14.103 10.9124 14.1026 11.4404 14.0454C11.9556 13.9896 12.2379 13.8865 12.4453 13.7358C12.6086 13.6172 12.7525 13.4733 12.8711 13.3101C13.0217 13.1026 13.1248 12.8195 13.1807 12.3042C13.2378 11.7762 13.2393 11.0876 13.2393 10.0981V5.90088C13.2393 4.91131 13.2379 4.22279 13.1807 3.69483C13.1248 3.17969 13.0218 2.89736 12.8711 2.68994C12.7524 2.52667 12.6086 2.38281 12.4453 2.26416C12.2379 2.11355 11.9556 2.01041 11.4404 1.95459C10.9124 1.8974 10.2241 1.896 9.23438 1.896H6.76563Z" fill="currentColor"/></svg>'
  const ICON_EDIT = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.94076 1.34942C10.7047 0.90231 11.6503 0.902415 12.4143 1.34942C12.7061 1.52015 12.9688 1.79118 13.3104 2.13284C13.6521 2.47448 13.9231 2.73721 14.0939 3.02894C14.5408 3.79294 14.5409 4.73856 14.0939 5.50251C13.9231 5.79415 13.652 6.05704 13.3104 6.39861L6.65932 13.0497C6.28068 13.4284 6.00695 13.7108 5.66543 13.9097C5.32391 14.1085 4.94315 14.2074 4.42705 14.3498L3.24394 14.6761C2.77527 14.8054 2.34538 14.9262 2.00131 14.9684C1.65196 15.0112 1.17964 15.0013 0.810764 14.6325C0.441921 14.2637 0.432107 13.7913 0.47486 13.442C0.517035 13.0979 0.6379 12.668 0.767181 12.1993L1.09352 11.0162C1.23588 10.5001 1.33481 10.1193 1.5336 9.77784C1.7325 9.43632 2.0149 9.1626 2.39355 8.78395L9.04466 2.13284C9.38625 1.79126 9.64911 1.52016 9.94076 1.34942ZM15.5427 14.8398H7.55223L8.96707 13.425H15.5427V14.8398ZM3.39382 9.78422C2.965 10.213 2.84244 10.3436 2.75709 10.49C2.67183 10.6366 2.61862 10.8079 2.45733 11.3925L2.13099 12.5756C2.00183 13.0439 1.92194 13.3419 1.88863 13.5536C2.10041 13.5204 2.39872 13.4416 2.86764 13.3123L4.05075 12.9859C4.63544 12.8246 4.80669 12.7715 4.95323 12.6862C5.09968 12.6008 5.23022 12.4783 5.65905 12.0494L10.721 6.98644L8.45577 4.72121L3.39382 9.78422ZM11.7 2.57079C11.3774 2.38198 10.9777 2.38198 10.6551 2.57079C10.5602 2.62647 10.4487 2.72931 10.0449 3.13311L9.45604 3.72094L11.7213 5.98617L12.3102 5.39833C12.7139 4.99457 12.8168 4.88307 12.8725 4.78818C13.0613 4.46561 13.0612 4.06585 12.8725 3.74326C12.8169 3.64827 12.7146 3.53752 12.3102 3.13311C11.9057 2.72863 11.795 2.6264 11.7 2.57079Z" fill="currentColor"/></svg>'
  const ICON_SEARCH = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.894845 6.647401C11.894845 3.725463 9.534486 1.356779 6.623219 1.35657C3.711786 1.35657 1.351635 3.725338 1.351635 6.647401C1.351843 9.569296 3.711911 11.938273 6.623219 11.938273C9.534361 11.938064 11.894637 9.569171 11.894845 6.647401ZM13.245462 6.647401C13.245254 10.317935 10.280401 13.293613 6.623219 13.293821C2.965871 13.293821 0.000204 10.31806 0 6.647401C0 2.976574 2.965746 0 6.623219 0C10.280526 0.000205 13.245462 2.9767 13.245462 6.647401Z" fill="currentColor"/><path d="M16.000417 15.041079L15.044449 16.000433L11.530434 12.473588L12.486298 11.514234L16.000417 15.041079Z" fill="currentColor"/></svg>'
  const ICON_API = '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path transform="translate(0.6689 1.073)" d="M11.4818 5.57813C11.4818 4.45301 11.4807 3.66237 11.4075 3.05908C11.3359 2.46953 11.2024 2.13852 10.9939 1.89441C10.9247 1.81341 10.8493 1.73801 10.7683 1.66882C10.5242 1.46033 10.1932 1.32686 9.60364 1.25525C9.00034 1.18198 8.20974 1.18091 7.0846 1.18091L5.57813 1.18091C4.45301 1.18091 3.66238 1.18198 3.05908 1.25525C2.46953 1.32686 2.13852 1.46033 1.89441 1.66882C1.81341 1.73801 1.73801 1.81341 1.66882 1.89441C1.46033 2.13852 1.32686 2.46953 1.25525 3.05908C1.18198 3.66238 1.18091 4.45301 1.18091 5.57813L1.18091 6.2771C1.18091 7.40218 1.18197 8.19288 1.25525 8.79614C1.32687 9.38553 1.46036 9.71674 1.66882 9.96082C1.73797 10.0417 1.81347 10.1173 1.89441 10.1864C2.13851 10.3948 2.46965 10.5275 3.05908 10.5991C3.66238 10.6724 4.45298 10.6735 5.57813 10.6735L7.0846 10.6735C8.20977 10.6735 9.00033 10.6724 9.60364 10.5991C10.1931 10.5275 10.5242 10.3948 10.7683 10.1864C10.8493 10.1173 10.9247 10.0417 10.9939 9.96082C11.2024 9.71674 11.3358 9.38553 11.4075 8.79614C11.4808 8.19288 11.4818 7.40218 11.4818 6.2771L11.4818 5.57813ZM12.6627 6.2771C12.6627 7.37222 12.6637 8.247 12.5798 8.93799C12.4942 9.64284 12.3133 10.2359 11.8928 10.7282C11.7834 10.8562 11.6637 10.9751 11.5356 11.0845C11.0434 11.5049 10.4511 11.6867 9.74634 11.7723C9.05525 11.8563 8.17999 11.8552 7.0846 11.8552L5.57813 11.8552C4.48273 11.8552 3.60747 11.8563 2.91638 11.7723C2.21157 11.6867 1.61933 11.5049 1.12708 11.0845C0.99901 10.9751 0.879281 10.8562 0.769898 10.7282C0.349454 10.2359 0.168506 9.64284 0.0828864 8.93799C-0.00101964 8.247 4.88512e-07 7.37222 6.47206e-07 6.2771L6.47206e-07 5.57813C6.47206e-07 4.48273 -0.00106163 3.60747 0.0828864 2.91638C0.168502 2.21168 0.349594 1.61928 0.769898 1.12708C0.879302 0.998981 0.998981 0.879302 1.12708 0.769898C1.61928 0.349594 2.21168 0.168502 2.91638 0.0828864C3.60747 -0.00106163 4.48273 6.47206e-07 5.57813 6.47206e-07L7.0846 6.47206e-07C8.17999 6.47206e-07 9.05525 -0.00106163 9.74634 0.0828864C10.451 0.168505 11.0434 0.349587 11.5356 0.769898C11.6637 0.879302 11.7834 0.998981 11.8928 1.12708C12.3131 1.61928 12.4942 2.21169 12.5798 2.91638C12.6638 3.60747 12.6627 4.48273 12.6627 5.57813L12.6627 6.2771Z" fill="currentColor"/><path transform="translate(0.6689 1.073)" d="M6.02607 5.50955L6.44306 5.9274L3.84284 8.52762L3.425 8.11063L3.00715 7.69278L4.77253 5.9274L3.00715 4.16202L3.84284 3.32633L6.02607 5.50955Z" fill="currentColor"/><path transform="translate(0.6689 1.073)" d="M9.23789 7.35397L9.23789 8.53488L6.96238 8.53488L6.96238 7.35397L9.23789 7.35397Z" fill="currentColor"/></svg>'
  const ICON_GLOBE = '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.00018 0.353516C10.6708 0.353535 13.6468 3.32958 13.6469 7.00018C13.6468 10.6708 10.6708 13.6468 7.00018 13.6469C3.32957 13.6468 0.353535 10.6708 0.353516 7.00018C0.353535 3.32957 3.32957 0.353531 7.00018 0.353516ZM5.44643 7.59661C5.49463 8.97506 5.70762 10.191 6.02136 11.0793C6.20141 11.5891 6.40328 11.9585 6.59898 12.1889C6.79501 12.4196 6.93213 12.454 7.00018 12.454C7.06822 12.454 7.20533 12.4197 7.40138 12.1889C7.59708 11.9585 7.79895 11.589 7.979 11.0793C8.29274 10.191 8.50574 8.97506 8.55394 7.59661H5.44643ZM1.57861 7.59661C1.80785 9.70467 3.2386 11.4509 5.1715 12.1388C5.07135 11.9317 4.97972 11.7098 4.89746 11.477C4.53084 10.4391 4.30224 9.0828 4.25357 7.59661H1.57861ZM9.74679 7.59661C9.69813 9.0828 9.46952 10.4391 9.1029 11.477C9.0206 11.7099 8.92818 11.9316 8.82797 12.1388C10.7613 11.4511 12.1925 9.70496 12.4218 7.59661H9.74679ZM5.1706 1.8616C3.23814 2.54963 1.80876 4.29604 1.5795 6.40376H4.25357C4.30224 4.91756 4.53083 3.56129 4.89746 2.5234C4.97968 2.29066 5.07051 2.0686 5.1706 1.8616ZM7.00018 1.54637C6.93213 1.54638 6.79503 1.5807 6.59898 1.81145C6.40332 2.04177 6.20139 2.41058 6.02136 2.92012C5.70754 3.80851 5.49461 5.02499 5.44643 6.40376H8.55394C8.50575 5.025 8.29282 3.80851 7.979 2.92012C7.79898 2.41059 7.59705 2.04177 7.40138 1.81145C7.20531 1.58067 7.06823 1.54637 7.00018 1.54637ZM8.82887 1.8616C8.92902 2.0687 9.02064 2.29053 9.1029 2.5234C9.46953 3.56129 9.69812 4.91756 9.74679 6.40376H12.4209C12.1916 4.29575 10.7618 2.54943 8.82887 1.8616Z" fill="currentColor"/></svg>'
  const ICON_CHECKLIST = '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M13.3277 9.69629V10.976H7.28086V9.69629H13.3277Z" fill="currentColor"/><path d="M13.3277 2.97256V4.25225H7.28086V2.97256H13.3277Z" fill="currentColor"/><path d="M4.64512 10.336C4.64505 9.62755 4.07081 9.05322 3.3623 9.05322C2.65386 9.05329 2.07956 9.62759 2.07949 10.336C2.07949 11.0445 2.65382 11.6188 3.3623 11.6188C4.07085 11.6188 4.64512 11.0446 4.64512 10.336ZM5.92559 10.336C5.92559 11.7515 4.77777 12.8993 3.3623 12.8993C1.94689 12.8993 0.799805 11.7515 0.799805 10.336C0.799871 8.92066 1.94693 7.7736 3.3623 7.77354C4.77773 7.77354 5.92552 8.92062 5.92559 10.336Z" fill="currentColor"/><path d="M4.64531 3.6123C4.6453 2.90382 4.07098 2.32949 3.3625 2.32949C2.65403 2.32951 2.0797 2.90383 2.07969 3.6123C2.07969 4.32079 2.65402 4.8951 3.3625 4.89512C4.07099 4.89512 4.64531 4.3208 4.64531 3.6123ZM5.925 3.6123C5.925 5.02772 4.77792 6.1748 3.3625 6.1748C1.9471 6.17479 0.8 5.02771 0.8 3.6123C0.800013 2.19691 1.9471 1.04982 3.3625 1.0498C4.77791 1.0498 5.92499 2.1969 5.925 3.6123Z" fill="currentColor"/></svg>'
  const ICON_SKILL = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M12.5113 15.4067C12.4395 15.6249 12.1308 15.6249 12.059 15.4067L11.643 14.1416C11.454 13.567 11.0033 13.1164 10.4288 12.9274L9.16369 12.5113C8.94544 12.4395 8.94544 12.1308 9.16369 12.059L10.4288 11.643C11.0033 11.454 11.454 11.0033 11.643 10.4288L12.059 9.16369C12.1308 8.94544 12.4395 8.94544 12.5113 9.16369L12.9274 10.4288C13.1164 11.0033 13.567 11.454 14.1416 11.643L15.4067 12.059C15.6249 12.1308 15.6249 12.4395 15.4067 12.5113L14.1416 12.9274C13.567 13.1164 13.1164 13.567 12.9274 14.1416L12.5113 15.4067Z" fill="currentColor"/><path d="M9.02246 0.546878C9.9822 0.546878 10.7564 0.545403 11.374 0.612307C12.0042 0.680586 12.5515 0.826244 13.0273 1.17188C13.3052 1.37376 13.5501 1.61868 13.752 1.89649C14.0975 2.37225 14.2432 2.91984 14.3115 3.54981C14.3784 4.16727 14.377 4.94206 14.377 5.90137V8.51367C13.9611 8.29533 13.5071 8.13985 13.0273 8.06055V5.90137C13.0273 4.9121 13.0259 4.22322 12.9688 3.69532C12.9129 3.18044 12.8098 2.89782 12.6592 2.69043C12.5406 2.52724 12.3966 2.38326 12.2334 2.26465C12.026 2.11404 11.7437 2.0109 11.2285 1.95508C10.7005 1.89789 10.0122 1.89649 9.02246 1.89649H6.55371C5.56395 1.89649 4.87569 1.89787 4.34766 1.95508C3.83242 2.01092 3.55022 2.11398 3.34278 2.26465C3.17953 2.38329 3.03564 2.52719 2.91699 2.69043C2.76642 2.89782 2.66325 3.18042 2.60742 3.69532C2.55027 4.22322 2.54883 4.9121 2.54883 5.90137V10.0986C2.54883 11.0878 2.55031 11.7768 2.60742 12.3047C2.66326 12.8196 2.76642 13.1032 2.91699 13.3105C3.03558 13.4736 3.17966 13.6178 3.34278 13.7363C3.5502 13.8869 3.83265 13.9901 4.34766 14.0459C4.87568 14.1031 5.56398 14.1035 6.55371 14.1035H8.08399C8.27443 14.6025 8.55077 15.0585 8.89551 15.4541H6.55371C5.59402 15.4541 4.81976 15.4546 4.20215 15.3877C3.57204 15.3194 3.02468 15.1738 2.54883 14.8281C2.27111 14.6263 2.02606 14.3813 1.82422 14.1035C1.47883 13.6278 1.33293 13.08 1.26465 12.4502C1.19783 11.8327 1.19922 11.0579 1.19922 10.0986V5.90137C1.19922 4.94206 1.1978 4.16727 1.26465 3.54981C1.33295 2.91984 1.47867 2.37225 1.82422 1.89649C2.02613 1.61864 2.27098 1.37379 2.54883 1.17188C3.02472 0.826181 3.57197 0.6806 4.20215 0.612307C4.81976 0.545393 5.594 0.546877 6.55371 0.546878H9.02246ZM9.19629 9.14649H4.5459V7.84571H9.19629V9.14649ZM11.0303 6.10645H4.5459V4.80567H11.0303V6.10645Z" fill="currentColor"/></svg>'
  const ICON_SPARKLE = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6.1 3.1Q6.6 7.8 11.3 8.3Q6.6 8.8 6.1 13.5Q5.6 8.8 0.9 8.3Q5.6 7.8 6.1 3.1Z" fill="currentColor"/><path d="M11.9 1Q12.2 3.7 14.9 4Q12.2 4.3 11.9 7Q11.6 4.3 8.9 4Q11.6 3.7 11.9 1Z" fill="currentColor"/><path d="M12.5 9.4Q12.7 11.4 14.7 11.6Q12.7 11.8 12.5 13.8Q12.3 11.8 10.3 11.6Q12.3 11.4 12.5 9.4Z" fill="currentColor"/></svg>'
  // 映射对齐 DSH ui-tool GenericToolCard variant leading：read→browse、write/edit→edit、search→search、
  // bash→api、web_search→globe（web_fetch→browse）、todo/task→checklist、skill→skill、其余（含 Agent）→sparkle
  const TOOL_ICONS = {
    Read: ICON_BROWSE, Edit: ICON_EDIT, Write: ICON_EDIT, NotebookEdit: ICON_EDIT,
    Grep: ICON_SEARCH, Glob: ICON_SEARCH, Bash: ICON_API,
    WebFetch: ICON_BROWSE, WebSearch: ICON_GLOBE,
    TaskCreate: ICON_CHECKLIST, TaskUpdate: ICON_CHECKLIST, TaskGet: ICON_CHECKLIST, TodoWrite: ICON_CHECKLIST,
    Skill: ICON_SKILL,
  }
  function toolIcon(name) { return TOOL_ICONS[name] || ICON_SPARKLE }

  // ---- 消息复制按钮（2026-08-21 移植 DSH MessageIconActions：28px 圆形图标钮，copy → check 1s 反馈。
  // path 取自 ui-primitives/icons IconCopyOutline16；成功对勾复用 I.dshCheck）----
  const ICON_COPY = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6.14929 4.02032C7.11197 4.02032 7.87983 4.02016 8.49597 4.07598C9.12128 4.13269 9.65792 4.25188 10.1415 4.53106C10.7202 4.8653 11.2008 5.3459 11.535 5.92462C11.8142 6.40818 11.9334 6.94481 11.9901 7.57012C12.0459 8.18625 12.0458 8.95419 12.0458 9.9168C12.0458 10.8795 12.0459 11.6473 11.9901 12.2635C11.9334 12.8888 11.8142 13.4254 11.535 13.909C11.2008 14.4877 10.7202 14.9683 10.1415 15.3025C9.65792 15.5817 9.12128 15.7009 8.49597 15.7576C7.87984 15.8134 7.11196 15.8133 6.14929 15.8133C5.18667 15.8133 4.41874 15.8134 3.80261 15.7576C3.1773 15.7009 2.64067 15.5817 2.1571 15.3025C1.5784 14.9683 1.09778 14.4877 0.76355 13.909C0.484366 13.4254 0.365184 12.8888 0.308472 12.2635C0.252649 11.6473 0.252808 10.8795 0.252808 9.9168C0.252808 8.95418 0.252664 8.18625 0.308472 7.57012C0.365184 6.94481 0.484366 6.40818 0.76355 5.92462C1.09777 5.34589 1.57839 4.86529 2.1571 4.53106C2.64067 4.25188 3.1773 4.13269 3.80261 4.07598C4.41874 4.02017 5.18666 4.02032 6.14929 4.02032ZM6.14929 5.37774C5.16181 5.37774 4.46634 5.37761 3.92566 5.42657C3.39434 5.47472 3.07859 5.56574 2.83582 5.70587C2.4632 5.92106 2.15354 6.2307 1.93835 6.60333C1.79823 6.8461 1.70721 7.16185 1.65906 7.69317C1.6101 8.23385 1.61023 8.92933 1.61023 9.9168C1.61023 10.9043 1.61009 11.5998 1.65906 12.1404C1.70721 12.6717 1.79823 12.9875 1.93835 13.2303C2.15356 13.6029 2.46321 13.9126 2.83582 14.1277C3.07859 14.2679 3.39434 14.3589 3.92566 14.407C4.46634 14.456 5.16182 14.4559 6.14929 14.4559C7.13682 14.4559 7.83224 14.456 8.37292 14.407C8.90425 14.3589 9.21999 14.2679 9.46277 14.1277C9.83535 13.9126 10.145 13.6029 10.3602 13.2303C10.5004 12.9875 10.5914 12.6717 10.6395 12.1404C10.6885 11.5998 10.6884 10.9043 10.6884 9.9168C10.6884 8.92934 10.6885 8.23384 10.6395 7.69317C10.5914 7.16185 10.5004 6.8461 10.3602 6.60333C10.1451 6.23071 9.83536 5.92107 9.46277 5.70587C9.21999 5.56574 8.90424 5.47472 8.37292 5.42657C7.83224 5.3776 7.13682 5.37774 6.14929 5.37774ZM9.80164 0.367975C10.7638 0.367975 11.5314 0.36788 12.1473 0.423639C12.7726 0.480307 13.3093 0.598759 13.7928 0.877741C14.3717 1.21192 14.8521 1.69355 15.1864 2.27227C15.4655 2.75574 15.5857 3.29164 15.6425 3.9168C15.6983 4.53301 15.6971 5.3016 15.6971 6.26446V7.82989C15.6971 8.29264 15.6989 8.58993 15.6649 8.84844C15.4668 10.3525 14.401 11.5738 12.9833 11.9988V10.5467C13.6973 10.1903 14.2105 9.49662 14.3192 8.67169C14.3387 8.52347 14.3407 8.3358 14.3407 7.82989V6.26446C14.3407 5.27706 14.3398 4.58149 14.2909 4.04083C14.2428 3.50968 14.1526 3.19372 14.0126 2.95098C13.7974 2.57849 13.4876 2.26869 13.1151 2.05352C12.8724 1.91347 12.5564 1.82237 12.0253 1.77423C11.4847 1.72528 10.7888 1.7254 9.80164 1.7254H7.71472C6.7562 1.72558 5.92665 2.27697 5.52332 3.07891H4.07019C4.54221 1.51132 5.9932 0.368186 7.71472 0.367975H9.80164Z" fill="currentColor"/></svg>'
  // 回复底部「用量」标签图标（2026-10-04 还原 dsh 回复操作条）：数据库圆柱（顶部椭圆 + 侧壁/中缝弧）。
  const ICON_USAGE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><ellipse cx="8" cy="3.6" rx="5.1" ry="1.9"/><path d="M2.9 3.6v8.8c0 1.05 2.28 1.9 5.1 1.9s5.1-.85 5.1-1.9V3.6"/><path d="M2.9 8c0 1.05 2.28 1.9 5.1 1.9s5.1-.85 5.1-1.9"/></svg>'
  // token 用量格式化（dsh「用量 69.4K tok」同款）：≥1e6 → M、≥1e3 → K 一位小数，否则原值。
  function fmtUsage(n) {
    const v = Number(n)
    if (!(v > 0)) return ''
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
    return String(v)
  }
  // 回复时刻（本地中文单位格式 `YYYY 年 M 月 D 日 HH : MM`；数字前导零一律省略，如 4 月 3 日 9 : 5。
  // 2026-10-04 用户定「写成 YYYY 年 MM 月 DD 日 HH : SS，数字为 02 时仅显示 2」= 时分精度 + 去前导零）。
  function fmtClock(ts) {
    const n = Number(ts)
    if (!(n > 0)) return ''
    const d = new Date(n)
    if (Number.isNaN(d.getTime())) return ''
    return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${d.getHours()} : ${d.getMinutes()}`
  }
  // 精确 token 计数（弹出面板用，dsh 同款千分位：69,353）。
  function fmtTok(n) {
    const v = Number(n)
    return Number.isFinite(v) && v > 0 ? v.toLocaleString('en-US') : '0'
  }
  // 「用量」按钮 + 点击弹出的明细面板（2026-10-04 还原 dsh 回复底部：按钮点开显示本轮 token 明细）。
  // 数据源 = DisplayMessage.usage 明细 + DisplayMessage.model；提供方由 modelProviderOf(模型名) 派生。
  // 面板置于 .msg-actions 内 → messageCopyText 剔除 `.msg-actions` 时一并排除，不污染复制文本。
  function usageButtonHtml(usage, model) {
    const d = usage || {}
    const input = Number(d.input) || 0
    const cacheRead = Number(d.cacheRead) || 0
    const cacheWrite = Number(d.cacheWrite) || 0
    const output = Number(d.output) || 0
    const total = input + cacheRead + cacheWrite + output
    const denom = input + cacheRead + cacheWrite
    const hit = denom > 0 ? (cacheRead / denom) * 100 : 0
    const who = model ? `${modelProviderOf({ k: 'model', v: model })}/${model}` : ''
    const rows = [
      ['提供方 / 模型', who || '—'],
      ['缓存命中', hit.toFixed(1) + '%'],
      ['未缓存输入', fmtTok(input) + ' tok'],
      ['缓存读取', fmtTok(cacheRead) + ' tok'],
      ['缓存写入', fmtTok(cacheWrite) + ' tok'],
      ['输出', fmtTok(output) + ' tok'],
    ]
      .map(([k, v]) => `<div class="up-row"><span class="up-k">${k}</span><span class="up-v">${esc(v)}</span></div>`)
      .join('')
    // 按钮与面板包进 .usage-wrap（position:relative）→ 面板左缘对齐「用量」按钮左缘（dsh 同款锚点，
    // 2026-10-04；此前挂在 .msg-actions 上 left:0 是复制钮左缘＝偏左）。
    return (
      `<span class="usage-wrap">` +
      `<button class="msg-usage" type="button" aria-expanded="false" title="本轮用量明细">${ICON_USAGE}<span class="mu-txt">用量 ${fmtUsage(total)} tok</span></button>` +
      `<div class="usage-pop" hidden><div class="up-head"><span class="up-title">${ICON_USAGE}本轮用量</span><span class="up-total">${fmtTok(total)} tok</span></div><div class="up-rows">${rows}</div></div>` +
      `</span>`
    )
  }
  // 剪贴板写入（DSH ui-primitives clipboard.ts 移植）：异步 Clipboard API 优先，
  // 非安全上下文（http 局域网 / 无 clipboard）回退 textarea + execCommand('copy')
  async function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(text); return true } catch { return false }
    }
    const exec = typeof document.execCommand === 'function' ? document.execCommand.bind(document) : undefined
    if (!exec) return false
    const el = document.createElement('textarea')
    el.value = text
    el.setAttribute('readonly', '')
    el.style.position = 'fixed'
    el.style.left = '-9999px'
    document.body.appendChild(el)
    el.select()
    try { return exec('copy') } catch { return false } finally { el.remove() }
  }

  function thinkRowHtml(text, running) {
    const t = String(text || '')
    if (!t.trim()) return ''
    // 2026-08-26 任务 D 定案：思考块收起时**不显示思考正文摘要**（用户「思考过程未折叠」反馈——
    // 摘要「思考 先说明：触发。」直接暴露内部推理）。summary 只留「思考」标题 + 运行态扫光，
    // 点开才看全文。删除 thinkSummary 摘要（运行中 latestLine / 完成后 firstLine 语义一并废弃）。
    return `<details class="think-row" data-state="${running ? 'running' : 'ok'}"><summary><span class="tr-leading" aria-hidden="true"><span class="tr-ico">${THINK_ICON}</span><span class="tr-chev">${THINK_CHEV}</span></span><span class="tr-title">思考</span></summary><div class="tr-body">${mdHtml(t)}</div></details>`
  }

  // 入场动画标记：对比刷新前的顶层消息 key 集合，只给「本次新增」的块加 .msg-in，
  // 已存在的块静默保留（视觉无缝），避免整体 innerHTML 重建时整屏重播动画造成强刷感。
  // key = data-m|data-t（段起始消息索引 | 块类型：u=用户 a=回复 f=独立处理折叠 s=系统）。
  // prev 为空（首屏加载）时全部淡入并带轻微 stagger，让会话打开更有层次。
  function stampMsgIn(prev) {
    let n = 0
    messagesEl.querySelectorAll('[data-m]').forEach((el) => {
      const k = el.dataset.m + '|' + (el.dataset.t || '')
      if (!prev.has(k)) {
        el.classList.add('msg-in')
        el.style.animationDelay = Math.min(n * 22, 330) + 'ms'
        n++
      }
    })
  }

  // messagesHtml 渲染时记录的末段形象（只读 SSE 路径）：末段仍在处理中且段内最近有工具调用
  // → 按该工具选形象（读/搜=3、写/编=2、执行/插件/命令=4）；回复已发布/空闲 → 默认 1
  let charNote = 1
  // 增量重建（2026-08-26）：messagesHtml 记录「最后一个被 closeSeg 的段」的 key/html/前驱锚点/处理中标志，
  // refreshSession 对处理中末段只替换该段 DOM（applySegDelta），头部历史消息保留不动——消除整页重建闪烁。
  let lastSegInfo = null
  // 分层治理 4C（2026-10-10）：engine/live.js 的只读读取口——经端口注入调用，每次现读可变绑定，
  // 调用方严禁缓存返回值（缓存即与渲染实时态脱钩）。
  function getCharNote() { return charNote }
  function getLastSegInfo() { return lastSegInfo }

  // lazy（2026-09-18 web 卡顿根治）：true = 惰性两段式——切段循环照跑（桶分配 O(N) 轻量）但
  // 历史段不生成 HTML（think/ask/tool/reply 行的 html 置空）、closeSeg 只封存不渲染（按渲染同序
  // 静态推进 lastNode 供末段 prev 锚点链）；仅末段（isFinal）真渲染并在入口补齐置空行。调用方
  // live.js renderSessionBody 增量帧据此把「每帧全会话 MB 级序列化」降为「O(N) 切段 + 末段渲染」；
  // 判定不可增量时再跑一次全量（lazy=false）付全额，行为与原等价。
  function messagesHtml(messages, lazy) {
    // 按「用户消息 → AI 处理 → 回复」切段：
    // 真实 user 消息开新段；assistant/tool 的 thinking 与 tool_use 归入「已处理」折叠，
    // 段内最后一个带文本的 assistant 消息 = 回复（主内容），其余文本（过程旁白）也折进去。
    // role:'system'（后端已把合成/系统注入标成 system）= 无发布者的居中提示，独立一行。
    let html = ''
    let seg = null
    lastSegInfo = null // 每次渲染重置：仅记录本次被 closeSeg 的最后一个段
    let lastNode = null // 最近输出的 data-m 元素 {key, type}（供增量重建定位插入锚点）
    // 兜底：最后一条真实用户消息的时间（供「系统消息打断后」无 user 的末段计时/展示时长）；
    // 注入引导消息（injected）不计入——计时起点不打断（单折叠定稿）
    let lastUserTs = 0
    for (const m of messages) if (isRealUser(m) && !m.injected && m.timestamp) lastUserTs = m.timestamp
    // 引导消息按 pos 织进 items 流（从后往前插避免下标位移）；guides 按 push 序天然 pos 升序。
    // A 方案（用户 2026-08-29 定案）：处理中/完成态均为顶层完整用户气泡，原位保留。
    function weave(items, guides, s) {
      if (!guides || !guides.length) return items
      const out = items.slice()
      for (let gi = guides.length - 1; gi >= 0; gi--) {
        const g = guides[gi]
        const gbody = userBodyHtml(g.m)
        out.splice(Math.min(g.pos, out.length), 0, {
          kind: 'guide', gi,
          html: `<div class="msg user" data-m="${s.key}" data-t="g${gi}"${g.i != null ? ` data-g="${g.i}"` : ''}>${whoHtml(g.m)}${gbody ? `<div class="body">${gbody}</div>` : ''}${userImgsHtml(g.m)}${userFilesHtml(g.m)}</div>`, // 引导气泡不带复制按钮（用户 2026-08-30 定案）；纯图无文本不出空气泡（2026-09-07 空气炮根修）
        })
      }
      return out
    }
    // end_turn 正式回复气泡（流内 reply 项用，形态与原 reply 特判渲染一致）
    // 2026-10-04 还原 dsh 回复操作条：复制按钮之后依次「用量 X tok」按钮（点击弹出本轮 token 明细面板）+ 时间（HH:MM）。
    // 均置于 .msg-actions 内 → messageCopyText 剔除 `.msg-actions` 时一并排除，不污染复制文本。
    function replyBubbleHtml(key, text, usage, ts, model) {
      const clock = fmtClock(ts)
      const useBtn = usage ? usageButtonHtml(usage, model) : ''
      const meta = `${useBtn}${clock ? `<span class="msg-time">${clock}</span>` : ''}`
      return `<div class="msg assistant" data-m="${key}" data-t="a"><div class="body"><div class="blocks">${mdHtml(text)}</div><div class="msg-actions"><button class="msg-copy" title="复制" aria-label="复制">${ICON_COPY}</button>${meta}</div></div></div>`
    }
    function closeSeg(isFinal) {
      if (!seg) return
      const s = seg
      seg = null
      const segPrev = lastNode // 该段输出前的最后一个 data-m 元素（增量重建插入锚点）
      // 2026-09-06 打断收口：回合被中止后 jsonl 零写入（永远不会有 end_turn 回复），数据形态与
      // 「正在处理」不可区分——收口判定靠两持久信号，任一命中即强制按「已处理」收口，不再挂
      // 「正在处理/正在思考」无限计时（用户实测 2h26m 挂死根修）：
      // ① 会话进程不在线（state=null，网关按存活 pid 判定）= 不可能在处理：封死进程退出/关闭
      //    会话（直接 taskkill 零 onCancel）/崩溃路径；
      // ② turnEndAt（网关权威时刻：turn-state SSE 实时 + /gateway/sessions 首载恢复，无 TTL）
      //    晚于段末落盘 ts = 该回合已被中止：封死打断后刷新丢前端内存标记路径。
      const turnEnded = (() => {
        const sess = findSession(live.curUuid)
        if (sess && !sess.state) return true
        const te = live.turnEndFlags.get(live.curUuid)
        return !!(te && (s.lastTs || (s.user && s.user.timestamp) || 0) < te)
      })()
      const processing = isFinal && !s.finished && !turnEnded // 最后一段且末尾还没收到纯文本回复 = 处理中
      // 末段仍在处理中（未出正式回复）且段内最近有工具调用 → 按该工具选形象；否则（回复已发布/空闲）默认 1
      if (isFinal) charNote = (!(s.finished || turnEnded) && s.lastTool) ? toolToChar(s.lastTool) : 1
      // 惰性收口（2026-09-18）：非末段不渲染——历史段 DOM/内容自上轮以来不变，增量路径只消费
      // 末段 html。按渲染同序静态推进 lastNode（u→f→a→c）供末段 prev 锚点链；节点存在性与渲染
      // 路径等价：u=有开启气泡；f=非 reply 项非空（groupTools/liveFoldBody 有行必有折叠，skip 段
      // processing 恒 false）；a=每条 reply 项；c=变更卡。texts 回填（重 markdown）一并跳过。
      if (lazy && !isFinal) {
        if (s.user) lastNode = { key: s.key, type: 'u' }
        let nFold = s.guides ? s.guides.length : 0
        for (const it of s.items) if (it.kind !== 'reply') nFold++
        if (nFold) lastNode = { key: s.key, type: 'f' }
        for (const it of s.items) if (it.kind === 'reply') lastNode = { key: s.key, type: 'a' }
        if (s.changes && s.changes.size) lastNode = { key: s.key, type: 'c' }
        return
      }
      // 旁白 text 原位回填（与其后的动作交错，不再统一沉到段尾）；正式回复（end_turn）已在切段时
      // 气泡化（reply 项 → 折叠体外），不进 texts
      for (const t of s.texts) s.items[t.idx].html = processTextHtml(t.text)
      // 惰性帧渲染段补生成（2026-09-18）：lazy 切段置空的行在此补齐（仅末段真渲染会走到）。
      // ask 按吸附后的 answer 终态生成（切段时 false 缓存失效）；tool 行 html 恒为完成行基线
      //（toolLine 产物，运行态由 flushTools 按改写分派 toolCurHtml，与原切段即生成等价）。
      if (lazy) {
        for (const it of s.items) {
          if (it.html) continue
          if (it.kind === 'think') it.html = thinkRowHtml(it.text, false)
          else if (it.kind === 'ask') it.html = askLineHtml(it.answer != null)
          else if (it.kind === 'reply') it.html = replyBubbleHtml(s.key, it.text, it.usage, it.ts, it.model)
          else if (it.kind === 'tool') it.html = toolLine(it.block)
        }
      }
      // 思考行不做 running 态回填（思考永不独立成行：真空态=liveFoldBody 工具行内 .fold-state
      // 状态显示行，2026-09-09 用户定案「状态标识与工具调用行在一起」，v267 summary 轮转方案废弃）

      let segHtml = ''
      if (s.user) {
        const m = s.user
        // 纯图消息（文本剥 [Image #N] 占位后为空）不出 .body 空气泡，复制按钮同去（无文本可复制；
        // 乐观气泡同构同去防接管帧形态跳变）——2026-09-07 空气炮根修
        const ubody = userBodyHtml(m)
        segHtml += `<div class="msg user" data-m="${s.key}" data-t="u">${whoHtml(m)}${ubody ? `<div class="body">${ubody}</div>` : ''}${userImgsHtml(m)}${userFilesHtml(m)}${ubody ? `<div class="msg-actions"><button class="msg-copy" title="复制" aria-label="复制">${ICON_COPY}</button></div>` : ''}</div>`
        lastNode = { key: s.key, type: 'u' }
      }

      // 2026-08-29 最终定案（用户）：开启消息渲染一个折叠体，旁白/工具调用行/思考/引导消息
      // 都作为折叠体内部的元素（思考/旁白/引导原位穿插，连续工具折叠概括——liveFoldBody/groupTools），end_turn 正式
      // 回复是唯一折叠体外元素（「已处理 X」+回复）。顺序与 CLI 线性序一致（网关已把回合中
      // 引导重定位回 enqueue 位置并打 guide 标——「回复跑到引导上面」的顺序颠倒已根治）。
      const woven = weave(s.items, s.guides, s)
      const foldItems = []
      const flowParts = []
      for (const it of woven) {
        if (it.kind === 'reply') flowParts.push({ html: it.html, type: 'a' })
        else foldItems.push(it)
      }

      // 「正在思考/正在生成/正在压缩」状态行（2026-08-27 机制沿用；2026-09-11 判定收敛为纯函数 vacuumOf）。
      // 【真空窗口实锤（ff7dc1c2 转录逐行计时）】CLI 按块流式落盘：旁白 text 落盘后 LLM 生成 Edit 的
      // tool_use 参数 3~14s——期间 jsonl 零写入、turn-beat 仍随 delta 持续 → 旧白名单判定（result/thinking
      // 才亮 think，text 不亮）使状态显示行整段真空数秒（用户实测「编辑文件时短暂真空期」）。text 落盘与
      // thinking 落盘语义相同（回合未收口、无工具运行 = 引擎在产出），判定不再按尾动作类型区分；
      // lastStep=null（段刚开、首条记录未落盘）同样亮态。提问 ask 不亮态（提问卡接管输入栏即状态，
      // 2026-09-09 定案维持）。thinking 流式期间 jsonl 零写入 → SSE 不触发，web 保持本次渲染的思考态
      // 直到落盘轮转。判定细则与「工具在飞时以 turn-beat 取证」见 vacuumOf。
      const vacuumState = vacuumOf(s, processing, live, Date.now())
      // 思考/压缩态计时起点：段内最后一条落盘记录的时刻（真空期从那时开始）；尚无记录退回段 user 时间
      const vacuumStart = s.lastTs || (s.user && s.user.timestamp) || 0
      // 处理中（实时）段 = liveFoldBody（单工具折叠行轮转 + 真空态段尾状态显示行，2026-09-09 定案
      // 状态标识与工具行同一行）；已处理/被打断段 = groupTools（连续工具合并概括折叠，思考/旁白/
      // 引导原位穿插）。2026-08-30 恢复 182358 形态（v163 stackBody 重写误删工具折叠，用户实测
      // 「工具行折叠的功能消失」退回）。处理中恒渲染（即使空体——刚发消息乐观折叠语义）；完成态空体跳过。
      const bodyHtml = processing ? liveFoldBody(foldItems, vacuumState, vacuumStart) : groupTools(foldItems)
      if (bodyHtml || processing) {
        // dur 计时（CLI spinner 对应物）：t1=段开启消息 ts（开启消息/新回合段首引导），endTs=回复落盘 ts/段末 ts
        const t1 = (s.user && s.user.timestamp) || s.startTs || (isFinal ? lastUserTs : 0)
        const endTs = s.replyTs || s.lastTs
        const dur = !processing && t1 && endTs ? fmtDur(Math.round((endTs - t1) / 1000)) : ''
        // 处理状态行：summary「正在处理 + 总时长」（处理中）/ 终态词 + 摘要计数 + 时长（完成）。
        // 借鉴 dsh 轮次过程折叠（TurnProcessNodeView）三处：
        //  ①终态词区分「已处理 / 已停止」（dsh aborted 用 message.stopped；「处理失败」需后端 end reason，暂缺）；
        //  ②摘要计数（工具调用/提问，0 值省略；dsh 三段式 messageCount/toolCallCount/subagentCount）；
        //  ③无面向用户正文的回合默认展开、收口不自动折叠（dsh「关闭时没有最终正文的轮次保留全部过程证据」）。
        // 真空期（思考/生成/压缩）状态显示行仍由 liveFoldBody 并入尾组 summary，无响应红标挂暂态层。
        const totalSec = processing && t1 ? Math.max(0, Math.round((Date.now() - t1) / 1000)) : 0
        const hasBody = flowParts.length > 0 // 折叠体外是否有面向用户的最终正文（reply 项）
        // 无正文且非正常终止（end_turn/stop_sequence）= 被打断/被新消息取代 → 「已停止」（dsh aborted 语义）
        const stopped = !processing && !hasBody && s.finished !== 1
        const nTool = foldItems.reduce((n, it) => n + (it.kind === 'tool' ? 1 : 0), 0)
        const nAsk = foldItems.reduce((n, it) => n + (it.kind === 'ask' ? 1 : 0), 0)
        const cntParts = []
        if (nTool) cntParts.push(nTool + ' 次工具调用')
        if (nAsk) cntParts.push(nAsk + ' 次提问')
        const cnt = !processing && !stopped && cntParts.length ? `<span class="d-count">${cntParts.join(' · ')}</span>` : ''
        const stateHtml = processing
          ? `正在处理<span class="d-dur"> ${fmtDur(totalSec)}</span>`
          : stopped
            ? '已停止'
            : `已处理${cnt}${dur ? `<span class="d-dur"> ${dur}</span>` : ''}`
        // 无正文回合默认展开（data-nobody 供 live.js 增量重建时抑制收口自动折叠）
        const openWhenIdle = !hasBody
        segHtml += `<details class="done-fold${processing ? ' done-live' : ''}" data-m="${s.key}" data-t="f"${processing || openWhenIdle ? ' open' : ''}${!processing && openWhenIdle ? ' data-nobody="1"' : ''}><summary><span class="d-chev">${CHEV}</span>${processing ? '<span class="df-dot"></span>' : ''}${stateHtml}</summary><div class="done-body">${bodyHtml}</div></details>`
        lastNode = { key: s.key, type: 'f' }
      }
      // 流内项（按落盘序）：引导气泡 + 回复气泡（data-t 精确值供下段 prev 锚点查询命中）
      for (const p of flowParts) {
        segHtml += p.html
        lastNode = { key: s.key, type: p.type }
      }

      // 段末文件变更汇总卡片（回合内 Edit/Write 的真实增删行数）
      if (s.changes && s.changes.size) {
        segHtml += renderChangeCardHtml(s.changes, s.key)
        lastNode = { key: s.key, type: 'c' }
      }
      html += segHtml
      lastSegInfo = { key: s.key, html: segHtml, prev: segPrev, processing }
    }

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (isContinuationMsg(m)) {
        // 压缩/自动摘要标记（2026-08-27 二轮修正）：不再产生任何可见行——曾以 note 吸进折叠或
        // 居中系统提示，都会打断实时工具折叠行的展示（用户实测）。现在处理中段记 lastStep=
        // 'compact'，由 liveFoldBody 纯空窗兜底附加闪烁「正在压缩会话中……」状态显示行
        // （与「正在思考」同机制）；段间/已完成则静默吞行——数据层不剔 isCompactSummary 续接记录，拦截必须留。
        if (seg && !seg.finished) seg.lastStep = 'compact'
        continue
      }
      if (m.role === 'system') {
        // 无发布者的系统提示：中断当前段并居中展示
        closeSeg(false)
        const txt = m.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('\n').trim()
        html += `<div class="msg system" data-m="s${i}" data-t="s">${esc(txt || '系统消息')}</div>`
        lastNode = { key: 's' + i, type: 's' }
        continue
      }
      if (isRealUser(m)) {
        // 2026-08-30 共同后端定案（接力文档清单#4①）：切段由语义事件驱动——injected:true
        // （queued_command attachment 注入，filterConversationForDisplay 权威输出）= 回合中
        // 引导 → 归当前未收尾段 guides（weave 织入折叠体内部，记 pos=织入 items 流的下标）。
        // 无未收尾段的孤儿注入 → 不开新回合段（user:null，引导为折叠体首元素，兜底防吞）。
        // 非 injected 真实 user = dequeue 消费落盘的开启消息 → 永远开新段并立即计时。
        // 原「段未收尾到来的真实 user 一律吸 guides」启发式删除——它是排队消息被渲染成
        // 引导气泡的根因（102156 二轮实测），排队语义现由置底排队区承担。
        if (m.injected === true) {
          if (seg && !seg.finished) {
            if (!seg.guides) seg.guides = []
            seg.guides.push({ m, i, pos: seg.items.length })
            if (m.timestamp) seg.lastTs = m.timestamp
            continue
          }
          closeSeg(false)
          seg = { user: null, guides: [{ m, i, pos: 0 }], items: [], texts: [], lastTs: m.timestamp || null, startTs: m.timestamp || 0, key: i, thinks: [], lastTool: null, lastAsk: null, pendingTools: [], changes: new Map(), lastStep: null }
          continue
        }
        closeSeg(false)
        // 2026-09-06 撤回链：restoredFlags 命中该 user（落盘早于标记时刻且文本一致）→ 渲染层跳过
        // ——jsonl 不删（CLI rewind 只动内存+换 conversationId），气泡由渲染权威按标记永久不渲染。
        const rst = live.restoredFlags.get(live.curUuid)
        let userSkipped = false
        if (rst && (m.timestamp || 0) <= rst.ts) {
          const ut = (m.blocks || []).filter((b) => b.kind === 'text').map((b) => b.text).join('')
          if (ut.trim() === rst.text.trim()) userSkipped = true
        }
        seg = { user: userSkipped ? null : m, guides: [], items: [], texts: [], lastTs: null, startTs: m.timestamp || 0, key: i, thinks: [], lastTool: null, lastAsk: null, pendingTools: [], changes: new Map(), lastStep: null } // lastStep=段尾最新动作类型（thinking/tool/result/ask/text），真空期「正在思考」占位判定用
        continue
      }
      if (!seg) seg = { user: null, guides: [], items: [], texts: [], lastTs: null, startTs: m.timestamp || 0, key: i, thinks: [], lastTool: null, lastAsk: null, pendingTools: [], changes: new Map(), lastStep: null }
      const hasText = m.blocks.some((b) => b.kind === 'text' && b.text && b.text.trim())
      const hasTool = m.blocks.some((b) => b.kind === 'tool_use')
      for (const b of m.blocks) {
        // 思考块进 items 并记索引（s.thinks 供处理中段 running 态定位）；单块放行由数据层保证
        //（prompt 全剔/transcript 单全局/prompt-tail-think 尾巴单块），前端不再二次折叠（P2 删留尾兜底）
        if (b.kind === 'thinking') { seg.thinks.push(seg.items.length); seg.items.push({ kind: 'think', text: b.text, html: lazy ? '' : thinkRowHtml(b.text, false) }); seg.lastStep = 'thinking' } // 思考块：lastStep='thinking'（旁白走 text 分支，严格分流）
        else if (b.kind === 'text' && hasTool && b.text && b.text.trim()) {
          // 工具消息里的旁白文本：按块原位插入 items（保持 content 数组顺序——旁白在其对应工具调用之上），
          // 不统一沉到段尾；纯文本消息（无 tool_use）仍在循环后整体追加（保持同消息多 text 块拼接为一条的语义）。
          // end_turn/stop_sequence 正式回复（理论不带 tool_use，防御分支）→ 流内 reply 气泡，不进 texts
          if (isEndStop(m.stopReason)) {
            seg.items.push({ kind: 'reply', html: lazy ? '' : replyBubbleHtml(seg.key, b.text, m.usage, m.timestamp, m.model), text: b.text, usage: m.usage, model: m.model, ts: m.timestamp })
            seg.replyTs = m.timestamp
          } else {
            seg.items.push({ kind: 'text', html: '', text: b.text })
            seg.texts.push({ text: b.text, ts: m.timestamp, idx: seg.items.length - 1 })
          }
          seg.lastStep = 'text' // 工具消息内旁白 ≠ 思考
        }
        else if (b.kind === 'tool_use') {
          if (b.name === 'AskUserQuestion') {
            // 提问块 → DSH 风格提问卡（答案由后续 tool_result 文本吸附）
            const it = { kind: 'ask', name: 'AskUserQuestion', zh: '提问', input: b.input, answer: null, html: lazy ? '' : askLineHtml(false) }
            seg.items.push(it)
            seg.lastAsk = it
            seg.lastStep = 'ask'
          } else {
            const t = toolMeta(b); seg.items.push({ kind: 'tool', html: lazy ? '' : toolLine(b), block: b, name: t.name, zh: t.zh }); seg.lastTool = b.name; seg.pendingTools.push(seg.items.length - 1); seg.lastStep = 'tool' // 待完成工具队列（FIFO：连续多个 tool_use 全部登记，tool_result 按序逐个标记 done）
          }
        }
        else if (b.kind === 'tool_result') {
          // 文件变更（2026-08-23 起）：源码 conversationDisplay.ts 输出结构化 fileChange（Edit/Write
          // 真实增删行数，权威 = diff.ts sumLinesChanged），优先消费；parseFileChange 正则反解仅作
          // 旧网关/旧数据兜底（新 exe 部署后可删）。聚合文件变更 → 段末汇总卡片
          const fc = normalizeFileChange(b.fileChange) || parseFileChange(b.text); if (fc) mergeChanges(seg.changes, fc)
          // 2026-08-26 实时折叠：该工具步已收到结果 → 标记 done，groupTools/liveFoldBody 对完成的工具步
          // 显示为普通文本行（「当这一步工具调用完成后，折叠为文本」，不再显示「正在运行」）
          if (seg.pendingTools.length) { const pi = seg.pendingTools.shift(); seg.items[pi].done = true }
          seg.lastStep = 'result'
          // AskUserQuestion 答案关联：最近的未回答提问卡吸附该 tool_result 文本并标出所选
          if (seg.lastAsk && seg.lastAsk.answer == null && b.text) {
            seg.lastAsk.answer = String(b.text)
            seg.lastAsk.html = askLineHtml(true) // 已答 → 「提问 · 已回答」
          }
        }
      }
      if (hasText && !hasTool) {
        // 纯文本消息：end_turn/stop_sequence 正式回复 → 流内 assistant 气泡（reply 项，B 缺陷根治：end_turn 后
        // 继续有工具调用时回复不再被沉进折叠体；多轮 end_turn 各自原位气泡）。旧数据无 stopReason
        // 字段 → 纯文本=回复（与现行 finished 启发式同口径迁移）。其余为过程旁白 → 占位进 items，
        // closeSeg 时原位填充。
        const text = m.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('')
        if (m.stopReason === undefined || isEndStop(m.stopReason)) {
          seg.items.push({ kind: 'reply', html: lazy ? '' : replyBubbleHtml(seg.key, text, m.usage, m.timestamp, m.model), text, usage: m.usage, model: m.model, ts: m.timestamp })
          seg.replyTs = m.timestamp
        } else {
          seg.items.push({ kind: 'text', html: '', text })
          seg.texts.push({ text, ts: m.timestamp, idx: seg.items.length - 1 })
        }
        seg.lastStep = 'text' // 纯文本旁白/回复（无 tool_use 的消息）≠ 思考
      }
      // finished = 段已收尾判定。2026-08-26 起优先用 stopReason（源码 conversationDisplay 新增，
      // 'end_turn'/'stop_sequence' = 正式回复 = 回合结束（stop_sequence=第三方商正常终止，
      // 2026-08-31 补）；'tool_use'/null = 处理中，旁白/工具步保持「正在处理」）——
      // 精确区分「过程旁白纯文本」与「正式回复」，根治旁白中段误判成已处理（实时折叠闪「已处理」）。
      // 注意：stopReason=null（旁白，JSON 保留 null）也要算「处理中」；仅字段缺失（旧数据 undefined）回落
      // 旧启发式：纯文本回复（无 tool_use）= 收尾。
      if (m.role === 'assistant') {
        seg.finished = m.stopReason !== undefined ? (isEndStop(m.stopReason) ? 1 : 0) : (hasText && !m.blocks.some((b) => b.kind === 'tool_use') ? 1 : 0)
      }
      if (m.timestamp) seg.lastTs = m.timestamp
    }
    // 末尾待答提问在消息流里由紧凑行表达（askLineHtml「提问 · 等待回答」，见 b.name==='AskUserQuestion' 分支）；
    // 2026-09-11 ④ 起不再向上报 pendingAskInput（只读接管卡已移除，见 askLineHtml 注释）。
    closeSeg(true)
    // 2026-09-07 用户定案：空会话不再渲染「暂无 user/assistant 记录」占位行——该界面让会话
    // 出现「空态/内容态」两种视觉状态；移除后空会话消息区即纯空白，状态统一。
    return html
  }

  // ---------- 侧栏 ----------
  // 开合唯一入口。opt.pin 只在打开时有意义：钉住 = 鼠标移出侧栏不自动收（汉堡/抽屉把手点击），
  // 不钉 = 预览式（左缘悬停唤出）。收起一律清钉住态，避免上一轮的钉住 residual 影响下次悬停。
  // 钉住态挂 state.panelPinned（跨模块真源）。pin 可由 menu-btn/panel-collapse/scrim 任一处翻转。
  function setPanel(open, opt) {
    applyPanelOpen(open, !!(opt && opt.pin)) // 状态落地唯一核（engine/panel.js）：钉住态 + 可见态 + #sidebar.open + 调宽复位
    // 展开/折叠侧栏时关闭相关弹层
    bubblePop.classList.remove('show')
    $('organize-pop').classList.remove('show')
    if (!open) { closeRowMenu(); peekClear() } // 不变量：侧栏收起 ⇒ 挂在它里面的行浮窗/延展层一并收
    // （2026-10-14 待办 5：视图浮层退役，原 syncPaneRows 行状态链删除）
  }
  // 悬停预览的收口：鼠标离开侧栏且未钉住 → 收起。钉住态（汉堡打开）鼠标怎么走都不收；
  // 侧栏折叠时宽度 0，本事件不会触发。行浮窗挂在 #sidebar 内（见 openRowMenu），指针移到浮窗上
  // 不算离开侧栏，故悬停预览下浮窗可用。
  sidebar.addEventListener('mouseleave', () => { if (!state.panelPinned) setPanel(false) })

  // ---------- 侧栏拖拽调宽（2026-09-12）：仅桌面展开态生效（#panel-resizer 由 CSS 按
  // #sidebar.open + ≥721px 门控显示，pointerdown 再复核 .open 双保险）。拖动改 :root 内联
  // --panel-w——#sidebar 与 .panel-inner 的宽消费同一变量，主区靠 flex 跟随；不持久化，
  // setPanel(false) 清内联值。拖拽中 body.sb-resizing 关宽度过渡即时跟手。
  {
    const rz = $('panel-resizer')
    const clampW = (x) => Math.max(232, Math.min(560, window.innerWidth - 120, x))
    rz.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !sidebar.classList.contains('open')) return
      rz.setPointerCapture(e.pointerId)
      rz.classList.add('dragging')
      document.body.classList.add('sb-resizing')
      e.preventDefault()
    })
    rz.addEventListener('pointermove', (e) => {
      if (!rz.classList.contains('dragging')) return
      document.documentElement.style.setProperty('--panel-w', `${Math.round(clampW(e.clientX))}px`)
    })
    const release = () => {
      if (!rz.classList.contains('dragging')) return
      rz.classList.remove('dragging')
      document.body.classList.remove('sb-resizing')
    }
    rz.addEventListener('pointerup', release)
    rz.addEventListener('pointercancel', release)
  }

  // 项目编号提取（2026-08-25）：projectLabel 如 'Pj16-CodeAgent构建' → 短编号 'Pj16'；
  // 命中 Pj<数字> 前缀取前缀，否则回落完整 label（个别非 Pj 命名项目也能区分）。
  function projIdOf(label) {
    const m = /^Pj\d+/.exec(label || '')
    return m ? m[0] : label || ''
  }

  // ---------- work 侧栏会话置顶（2026-10-18）----------
  // 状态源 = state.wkPins（core/ui-state.js，经独立写口 savePins 持久化——不进 saveWork 整包，
  // 免得别的标签页保存布局时用旧内存态把新置顶覆盖回去）。**只在 work 侧栏渲染**：
  // 排序与行内图钉标记都由 work 列表出口（work-files.js wkBodyHtml）消费；chat 侧栏列表不读、
  // 菜单项也只对 #wk-body 内的行出现。置顶/取消置顶的唯一写口 = togglePin。
  function isPinned(hash) {
    return !!hash && state.wkPins.includes(hash)
  }
  function togglePin(hash) {
    if (!hash) return
    state.wkPins = isPinned(hash)
      ? state.wkPins.filter((h) => h !== hash)
      : state.wkPins.concat(hash)
    savePins()
    renderWorkBody() // 列表唯一渲染出口（work-files.js）：重排 + 图钉标记一次落地
    toast(isPinned(hash) ? '已置顶' : '已取消置顶')
  }

  function itemHtml(s, showProj, showPin) {
    const on = hashOf(s) === state.currentHash
    // 会话状态点：busy=绿（正在运行）· waiting=橘（等待用户）· idle=红（运行暂停/已完成）· 无=透明（CLI 未打开）
    const dotCls = s.state === 'busy' ? ' st-busy' : s.state === 'waiting' ? ' st-ask' : s.state === 'idle' ? ' st-wait' : ''
    // 2026-08-25 项目会话编号气泡（仅「在一个列表中」堆叠视图，renderList 传 showProj=true）：
    // 平铺时项目会话混在根会话里，用短编号（Pj16）标识所属项目；项目文件夹视图已有文件夹名，不重复显示。
    // 临时项目（根级时间戳任务区）的会话按全局根对待，不出项目标签（sessionProjLabel 归一）。
    const pl = sessionProjLabel(s)
    const projTag = showProj && pl
      ? `<span class="w-tag" title="${esc(pl)}">${esc(projIdOf(pl))}</span>` : ''
    // 2026-09-26 行操作入口 = 右键（桌面）/ 长按（触屏）唤出浮窗，三点按钮已删除（见 openRowMenu）
    // 置顶标记只在调用方显式要求时渲染（work 侧栏传 true）——chat 侧栏即使同一会话已置顶也不出图钉
    const pinIco = showPin && isPinned(hashOf(s)) ? `<span class="pin-ico" title="已置顶">${I.dshPin}</span>` : ''
    // 置顶图钉在行尾（2026-11-01 用户定案，照 dsh）：标题从行首正常起排、省略号区域不被图钉侵占
    return `<button class="sess-item${on ? ' on' : ''}" data-hash="${esc(hashOf(s))}" title="${esc(s.file)}">
      <span class="dot${dotCls}"></span><span class="title">${esc(s.title)}</span>${projTag}${pinIco}</button>`
  }

  // ---------- 真触屏判定（2026-09-05）：iPadOS Safari 桌面模式报 hover:hover+pointer:fine（与 macOS
  // 全同），CSS @media 骗不过 → 「hover 才显」规则（folder-add 等）在 iPad 上生效，
  // 触发 iOS「hover 改变布局 → 首击只应用 hover 吞 click」双击（笔按钮实测首击选中二击才跳转）。
  // 判定 = hover:none（手机）或 MacIntel+多点触控（iPad，与 deviceHint 同式）→ body.touch，
  // CSS 对触屏恒显这些元素（见 styles.css body.touch 段），hover 展开同步禁用。
  const IS_TOUCH_DEVICE =
    matchMedia('(hover: none)').matches ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  if (IS_TOUCH_DEVICE) document.body.classList.add('touch')

  // ---------- 行标题展开：桌面横向延展 / 触屏长按换行（2026-10-21）----------
  // 桌面 hover = body 下挂一份 fixed 克隆（.row-peek，pointer-events:none）：真实行始终留在列表流中，
  // 滚动链不被破坏（2026-10-19 fixed 真行导致 iPad 侧栏滑不动的根因）；克隆按 max-content 向右延展，
  // 长标题/长路径不再是「向下换行把后面的行推走」（用户待办：水平延展，而不是向下拓宽）。
  // 触屏长按仍用 .expanded 换行（无 hover，浮窗与展开同生同灭）；会话行与文件树行（.wk-row）共用本层。
  // 判据按**事件指针类型**而非设备（2026-10-21 返修）：iPad 桌面模式谎报 hover:hover，但接了触控板/鼠标时
  // pointerType='mouse' 真实有悬停，旧 IS_TOUCH_DEVICE 一刀切会让这类设备退回垂直换行（实报截图正是它）；
  // 手指触控（'touch'）没有 hover：**点击/长按该行时也横向延展**（2026-10-21 用户定案：
  // iPad 点 tab 拓宽、电脑鼠标悬浮拓宽），同样只出克隆、行高不变。
  let lastPointerType = 'mouse'
  const canPeek = () => lastPointerType !== 'touch'
  // 触屏点击后的延展锚：行点击常触发导航/列表重建（克隆随旧节点清掉），重建后按 (sel,dataset 键,值) 找回并重开。
  let peekPin = null
  let peekEl = null
  let peekSrc = null
  function peekClear() {
    if (peekEl) { peekEl.remove(); peekEl = null }
    peekSrc = null
  }
  function peekStart(el) {
    // 高度不变量：克隆按原行矩形落位、标题恒单行（.row-peek .title nowrap），行高与列表流都不变。
    // 是否允许由调用方决定（hover 绑 pointerType；长按菜单直调 force）。
    if (!el || peekSrc === el) return
    peekClear()
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return
    const c = el.cloneNode(true)
    c.classList.add('row-peek')
    c.removeAttribute('id')
    c.setAttribute('aria-hidden', 'true')
    c.style.left = Math.round(r.left) + 'px'
    c.style.top = Math.round(r.top) + 'px'
    c.style.height = Math.round(r.height) + 'px'
    c.style.minWidth = Math.round(r.width) + 'px'
    c.style.maxWidth = Math.max(120, window.innerWidth - r.left - 8) + 'px'
    document.body.appendChild(c)
    peekEl = c
    peekSrc = el
  }
  // 行的稳定标识（触屏重开后认回同一行）：会话 hash / 文件 wkfile / 目录 wkdir。
  function peekPinOf(el, sel) {
    for (const k of ['hash', 'wkfile', 'wkdir']) {
      if (typeof el.dataset[k] === 'string' && el.dataset[k]) return { sel, k, v: el.dataset[k] }
    }
    return null
  }
  function peekPinRestore(root) {
    if (!peekPin || !root) return false
    const el = [...root.querySelectorAll(peekPin.sel)].find((x) => x.dataset[peekPin.k] === peekPin.v)
    if (!el) return false
    peekStart(el)
    return true
  }
  function bindRowPeek(root, sel) {
    if (!root || !sel) return
    root.querySelectorAll(sel).forEach((el) => {
      el.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') peekStart(el) })
      el.addEventListener('pointerleave', peekClear)
      // 触屏点击/长按：按下即拓宽（click 在导航重建之后才到，那时旧节点已脱离文档，故落在 pointerdown）。
      el.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch') return
        lastPointerType = 'touch'
        peekPin = peekPinOf(el, sel)
        peekStart(el)
      })
    })
  }
  let expandedEl = null
  let reLiftHash = null // 行点击触发的导航：renderRecent 重建后按 hash 重新展开被点行（用后即清）
  let mouseXY = null // 最近光标落点：列表重建后按落点恢复 hover 展开（页面加载前 null 不误开）
  function expandClear() {
    if (expandedEl) { expandedEl.classList.remove('expanded'); expandedEl = null }
  }
  function expandStart(el) {
    if (!el || !el.classList.contains('sess-item') || expandedEl === el) return
    expandClear()
    el.classList.add('expanded')
    expandedEl = el
  }
  document.addEventListener('pointermove', (e) => {
    mouseXY = [e.clientX, e.clientY]
    lastPointerType = e.pointerType || 'mouse'
  }, { passive: true, capture: true })
  // 触屏点空白/点别的行 = 收起上一枚延展（无 pointerleave 可依赖）；点在当前行上则保留给行自己的 pointerdown。
  document.addEventListener('pointerdown', (e) => {
    lastPointerType = e.pointerType || 'mouse'
    if (e.pointerType !== 'touch') { peekPin = null; return }
    if (peekPin && e.target.closest && e.target.closest(peekPin.sel)) return
    peekPin = null
    peekClear()
  }, { capture: true })
  // 滚轮到达列表 = 菜单外交互（浮窗 fixed 会漂离锚点），一并收口；展开态本身不随滚动还原。
  // 监听按行所在滚动容器挂，每容器只挂一次（重复挂 = 同一次滚轮触发多遍）。
  const expandBoundRoots = new WeakSet()
  function expandBindRoot(root) {
    if (!root || expandBoundRoots.has(root)) return
    expandBoundRoots.add(root)
    root.addEventListener('wheel', () => { peekClear(); if (rowMenuPop) closeRowMenu() }, { passive: false })
  }
  // expandRoot = 行所在的滚动容器（chat = #recent-body；work 下沉区 = #wk-body）。
  function bindSessExpand(root, expandRoot) {
    // 逐事件按 pointerType 分流（见上）：触控板/鼠标 → peek，手指长按 → openRowMenu 直调 expandStart。
    bindRowPeek(root, '.sess-item')
    expandBindRoot(expandRoot || bodyEl)
  }

  // ---------- 会话行协议（2026-10-15 统一 Chat/Work 会话行生命周期）----------
  // `.sess-item` 在 chat 侧栏（#recent-body / 项目管理卡列表）与 work 下沉区（#wk-body 里的 .wk-chats）
  // 各渲一份，**行 HTML 本来就是同一份实现（itemHtml）**——行为也必须同源。回归根因：work 侧只在
  // #wk-body 容器上委托了一段「改 wkMainTab/wkAssist + navigate」，既没接本文件的点击语义（reLiftHash
  // 恢复展开 / 移动端收侧栏），也没接 hover 展开 ⇒ 同一行两模式表现分叉（展开不一致 / 选中滞后 / 点了
  // 像没反应）。协议两个出口，谁拥有行谁接线：
  //   activateSession(hash, { source })  —— 会话激活唯一口
  //   bindSessionRows(root, { source })  —— 行行为唯一接线口（点击 → activateSession + hover 展开）
  // 接线点 = 行节点**新建后**（innerHTML 重写分支里）：chat 侧 renderList/renderProject（mgr.js）/
  // work 侧 renderWorkBody（work-files.js）。

  // 会话激活唯一口。source='work' 才落 work 页面态（顶栏胶囊 + 聊天栏顶上来）——那是「在下沉区点行」
  // 的语义；chat 侧栏点行不该改 work 布局。导航 / 移动端收侧栏两模式一致。
  function activateSession(hash, opts = {}) {
    if (!hash) return
    if (opts.source === 'work') {
      wkEnsureTab(hash) // 显式打开一个会话 = 顶栏占一枚胶囊
      // 点会话 = 明确要看这个会话：聊天 tab 顶上来（否则文件 tab 占着格，看着像「点了没反应」）
      state.wkMainTab = 'chat'
      state.wkAssist = true
      state.wkAssistMode = 'side'
    }
    // 已在该会话内：不 navigate（route→ 重建整列换节点，展开态随旧节点消亡，需按 hash 恢复）
    if (hash !== state.currentHash) {
      reLiftHash = hash // 重建后恢复被点行展开（新节点 :hover 不恢复）
      navigate('#/' + encodeURIComponent(hash))
    }
    if (opts.source === 'work') { applyPanes(); saveWork() } // 新胶囊 + active 落地
    if (isMobile()) setPanel(false)
  }

  // 行行为接线（点击 + hover 展开）。**只在行节点新建后调用**：节点未变时重复调用会让同一节点累积
  // 多份监听。opts.root = 行所在滚动容器（滚轮关闭行浮窗的监听挂它）；缺省 #recent-body。
  function bindSessionRows(root, opts = {}) {
    if (!root) return
    root.querySelectorAll('.sess-item').forEach((b) =>
      b.addEventListener('click', () => activateSession(b.dataset.hash, opts)))
    bindSessExpand(root, opts.root || bodyEl)
  }

  // ---------- 行操作浮窗（2026-09-26：三点按钮删除，改右键 / 长按唤出；2026-09-27 泛化为注册式）----------
  // 两个入口：桌面右键（contextmenu）、触屏长按（pointerdown 计时 480ms）。浮窗是 document.body 下
  // 独立 fixed 卡片（脱出 #recent-body / #wk-body 这类 overflow 裁剪容器），落位在被操作行近旁
  // （长按：行左下）/ 指针处（右键），越界翻折 + clamp 回视口。长按同时展开该行标题（触屏不绑
  // hover，故 expandStart 直调）——展开与浮窗同生同灭：点两者之外任意空白（mousedown / pointerdown）→
  // closeRowMenu 一并还原。菜单不切换当前选中项：操作对象由行的 dataset 显式携带。
  //
  // 泛化（2026-09-27）：本模块只负责「唤出手势 + 浮窗 DOM + 会话行展开联动」，不认具体是哪种行。
  // 谁拥有行谁注册：registerRowMenu({ sel, key, items, pick })，items(el) 返回菜单项
  // [{a,icon,label,danger?}]（空数组 = 该行无菜单，右键保留浏览器默认），pick(a, el) 执行动作。
  const rowMenuSources = []
  function registerRowMenu(src) { rowMenuSources.push(src) }
  function rowMenuHit(target) {
    for (const src of rowMenuSources) {
      const el = target.closest(src.sel)
      if (el) return { src, el }
    }
    return null
  }
  let rowMenuPop = null
  let rowMenuTouch = false // 长按开启：展开由本浮窗负责，关闭时必须显式收起（触屏无 mouseleave 自然回位）
  let rowMenuGuard = 0 // 长按抬手会补发 mousedown，短时守卫防「刚弹出就被自己关掉」
  let rowMenuSrc = null // 当前浮窗的行源 + 行标识：列表重建后按此恢复展开（见 reliftRowMenu）
  let rowMenuKey = null
  function openRowMenu(hit, x, y, rowEl) {
    closeRowMenu()
    peekClear() // 延展克隆与浮窗同锚点，先收 clone 再弹菜单
    if (!hit) return
    const items = hit.src.items(hit.el)
    if (!items || !items.length) return
    rowMenuTouch = !!rowEl
    rowMenuGuard = Date.now() + 600
    const pop = document.createElement('div')
    pop.className = 'row-menu-pop'
    pop.innerHTML = items
      .map(
        (it) =>
          `<button type="button" class="rm-item${it.danger ? ' rm-danger' : ''}" data-a="${esc(it.a)}">` +
          `${it.icon || ''}<span>${esc(it.label)}</span></button>`,
      )
      .join('')
    // 宿主 = 行所属的 #sidebar（行属于侧栏时），否则 document.body（如 #bubble-pop 里的会话行）。
    // 挂在 #sidebar 内是本浮窗与「侧栏悬停预览」共存的前提：#sidebar 的 mouseleave 是收起侧栏的
    // 唯一入口，浮窗若是 body 子节点，指针从行移到浮窗上就等于「离开侧栏」→ 侧栏连带浮窗一起收。
    // .row-menu-pop 是 position:fixed，无 transform 祖先时仍以视口定位，故宿主变更不影响落点。
    const host = hit.el.closest('#sidebar') || document.body
    host.appendChild(pop)
    // 期望落点 = 行左下（长按）/ 指针右下（右键），越界翻折回视口内
    const r = rowEl ? rowEl.getBoundingClientRect() : null
    let lx = r ? r.left + 8 : x
    let ly = r ? r.bottom + 4 : y
    const w = pop.offsetWidth
    const h = pop.offsetHeight
    // 越界下限取**可视**视口底（键盘上沿）：innerHeight 是布局视口，键盘在场不缩，按它 clamp 会落进键盘后。
    const vv = window.visualViewport
    const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight
    lx = Math.max(8, Math.min(lx, window.innerWidth - w - 8))
    ly = Math.max(8, Math.min(ly, viewBottom - h - 8))
    pop.style.left = Math.round(lx) + 'px'
    pop.style.top = Math.round(ly) + 'px'
    pop.addEventListener('click', (e) => {
      const b = e.target.closest('.rm-item')
      if (!b) return
      // 菜单内部点击必须止于此：closeRowMenu 会把 pop 从 DOM 摘掉，若事件继续冒泡，文档级
      // 「点空白收起」拿到已脱离文档的 target（closest 一律 null）→ 会把项目的下拉一并误关。
      e.stopPropagation()
      const src = hit.src
      closeRowMenu()
      src.pick(b.dataset.a, hit.el)
    })
    pop.addEventListener('contextmenu', (e) => e.preventDefault()) // 浮窗上右键不弹浏览器菜单
    rowMenuPop = pop
    rowMenuSrc = hit.src
    rowMenuKey = hit.src.key(hit.el)
    // 长按同样只做横向延展（高度不变）：expandStart 只留底色高亮，标题不换行（CSS 已改），
    // 完整标题由 peek 克隆单行展示；菜单关闭时一并收。
    if (rowEl) { expandStart(rowEl); peekStart(rowEl) }
  }
  function closeRowMenu() {
    if (rowMenuPop) { rowMenuPop.remove(); rowMenuPop = null }
    // 展开还原：桌面右键场景鼠标仍在该行则保留展开（几何判定而非 :hover——鼠标未动时 :hover 判定不稳）。
    if (!rowMenuTouch && expandedEl && mouseXY) {
      const r = expandedEl.getBoundingClientRect()
      if (mouseXY[0] >= r.left && mouseXY[0] <= r.right && mouseXY[1] >= r.top && mouseXY[1] <= r.bottom) return
    }
    expandClear()
    if (rowMenuTouch) peekClear() // 长按的延展与浮窗同生同灭（桌面 hover 克隆仍由 mouseleave 管理）
  }
  // 列表重建后恢复：浮窗锚定的旧节点已被换掉（innerHTML 重渲），按 (行源, 行标识) 找新节点补展开。
  // 由各列表的渲染出口在重渲后调用（recent.js renderRecent / work.js renderWorkBody）。
  function reliftRowMenu() {
    if (!rowMenuPop || !rowMenuTouch || !rowMenuSrc || rowMenuKey == null) return
    const el = [...document.querySelectorAll(rowMenuSrc.sel)].find((x) => rowMenuSrc.key(x) === rowMenuKey)
    if (el) { expandStart(el); peekStart(el) }
  }
  // 桌面右键：只认已注册的行（其它区域保留浏览器默认菜单）
  document.addEventListener('contextmenu', (e) => {
    const hit = rowMenuHit(e.target)
    if (!hit || !hit.src.items(hit.el).length) return
    e.preventDefault()
    openRowMenu(hit, e.clientX, e.clientY)
  })
  // 触屏长按：480ms 未移动即触发（展开 + 浮窗）；移动 >8px / 抬手 / 取消即作废。长按后抬手若
  // 补发 click（误导航），在 capture 阶段吞掉——它先于元素自身的 click 处理器到达。
  let lpTimer = 0
  let lpFired = false
  let lpHit = null
  let lpXY = null
  const lpCancel = () => { clearTimeout(lpTimer); lpTimer = 0; lpHit = null }
  document.addEventListener('pointerdown', (e) => {
    lpFired = false
    // 浮窗开着时，落在浮窗与行之外的按下 = 明确的关闭意图，即刻收口（触屏抬手补发的 mousedown
    // 没有配套的新 pointerdown，故不受此支路影响，只受 rowMenuGuard 约束）
    if (rowMenuPop && !rowMenuPop.contains(e.target) && !rowMenuHit(e.target)) { closeRowMenu(); return }
    if (e.pointerType !== 'touch') return
    const hit = rowMenuHit(e.target)
    if (!hit || !hit.src.items(hit.el).length) return
    lpHit = hit
    lpXY = [e.clientX, e.clientY]
    clearTimeout(lpTimer)
    lpTimer = setTimeout(() => {
      lpTimer = 0
      const h = lpHit
      if (!h) return
      lpFired = true
      // 480ms 悬停期内列表可能整列重建（refreshList 按活动流签名随时重渲，处理中 2-3 次/秒），
      // 此时捕获的节点已成孤儿：getBoundingClientRect 归零 ⇒ 落点被 clamp 到视口左上角。
      // 不变量「浮窗与展开锚定现役节点」——按 (行源, 行标识) 重解析；行已消失（删除/换视图）则放弃。
      let el = h.el
      if (!el.isConnected) {
        const key = h.src.key(el)
        if (key == null) return
        el = [...document.querySelectorAll(h.src.sel)].find((x) => h.src.key(x) === key) || null
        if (!el) return
      }
      openRowMenu({ src: h.src, el }, 0, 0, el)
    }, 480)
  }, { passive: true })
  document.addEventListener('pointermove', (e) => {
    if (!lpTimer || !lpXY) return
    if (Math.abs(e.clientX - lpXY[0]) > 8 || Math.abs(e.clientY - lpXY[1]) > 8) lpCancel()
  }, { passive: true })
  document.addEventListener('pointerup', () => {
    lpCancel()
    // 长按抬手发生在守卫之后（长按更久）时续期：iOS 抬手会补发 mousedown，不得关掉刚弹出的浮窗
    if (rowMenuPop && rowMenuTouch) rowMenuGuard = Date.now() + 600
  }, { passive: true })
  document.addEventListener('pointercancel', lpCancel, { passive: true })
  document.addEventListener('click', (e) => {
    if (!lpFired) return
    lpFired = false
    e.stopPropagation()
    e.preventDefault()
  }, true)
  // 点空白（浮窗 / 行之外）→ 浮窗与展开一并消失
  document.addEventListener('mousedown', (e) => {
    if (!rowMenuPop || Date.now() < rowMenuGuard) return
    if (!rowMenuPop.contains(e.target)) closeRowMenu()
  })
  // 列表滚动 / 窗口尺寸变化：浮窗 fixed 会漂离锚点，直接收（与展开收起同一时机）
  window.addEventListener('scroll', () => { peekPin = null; peekClear(); if (rowMenuPop) closeRowMenu() }, { passive: true, capture: true })
  window.addEventListener('resize', () => { peekPin = null; peekClear(); if (rowMenuPop) closeRowMenu() })

  // 会话行菜单「项 + 动作」唯一实现（2026-10-25）：凡呈现同一会话的行（侧栏 `.sess-item`、
  // work 顶栏会话胶囊 `[data-wkchat]`）共用本 spec，禁止各写一套菜单。
  //   getHash(el)  = 该行对应的会话 hash
  //   withPin(el)  = 该行语境是否提供置顶（仅 work：侧栏行宿主 #wk-body / 顶栏胶囊）
  //   onRename     = 可选，重命名成功后的外部补渲染（如顶栏胶囊标题 renderTopbar）
  // 会话已从列表消失时 items 返回空（不弹菜单）。
  function sessionRowMenuSpec(getHash, withPin, onRename) {
    return {
      items: (el) => {
        const hash = getHash(el)
        if (!hash || !ALL.find((v) => hashOf(v) === hash)) return []
        const pinItems = withPin(el)
          ? [{ a: 'pin', icon: I.dshPin, label: isPinned(hash) ? '取消置顶' : '置顶' }]
          : []
        return [
          ...pinItems,
          { a: 'rename', icon: I.dshEdit, label: '重命名' },
          { a: 'close', icon: I.dshStop, label: '关闭会话', danger: true },
        ]
      },
      pick: (a, el) => {
        const hash = getHash(el)
        if (a === 'pin') togglePin(hash)
        else if (a === 'rename') openSessionRename(hash, onRename)
        else closeSession(hash)
      },
    }
  }
  registerRowMenu({
    sel: '.sess-item',
    key: (el) => el.dataset.hash || null,
    ...sessionRowMenuSpec((el) => el.dataset.hash, (el) => !!el.closest('#wk-body')),
  })

  // ---------- 关闭会话（2026-09-04 三点浮窗新增：语义 = CLI 两次 Ctrl+C）----------
  // 第一击 interrupt（网关按 sessionId 精确路由 → CLI onCancel：回合进行中即打断，空闲为 no-op）；
  // 第二击 POST /gateway/wsession/stop（网关统一优雅停 2026-09-08：shutdown → CLI exit 0 →
  // WT 自动收 tab，3s 树杀兜底；web spawn/终端直开两会话形态同协议）。转录保留磁盘，
  // 侧栏 tab 不消失，仅状态点熄灭。
  async function closeSession(hash) {
    const s = ALL.find((x) => hashOf(x) === hash)
    if (!s) return toast('未找到该会话')
    if (!s.state) return toast('会话未在运行，无需关闭')
    // 第一击 Ctrl+C：先打断当前回合（若空闲，CLI 侧判活未命中本就是 no-op）
    if (gws && gws.readyState === 1) gws.send(JSON.stringify({ type: 'interrupt', sessionId: hash }))
    // 第二击 Ctrl+C：关停会话进程（网关对 web/终端会话统一处理）
    try {
      const res = await fetch(apiUrl('/gateway/wsession/stop'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: hash }),
      })
      const body = await res.json()
      if (!res.ok || !body.ok) {
        toast('会话进程未找到，可能已自行退出')
        return
      }
      s.state = null
      renderRecent()
      // 2026-09-06 收口二轮：关的是当前打开会话 → 立即权威重渲（force 跳过 sig 判同），
      // closeSeg 按 state=null 收口「正在处理/正在思考」，不再等下次刷新。
      if (hash === state.currentHash) refreshSession(true)
      toast('会话已关闭')
    } catch (e) {
      toast('关闭失败：' + (e.message || e))
    }
  }

  // ---------- 重命名弹窗（2026-08-24 DSH 侧栏 rename dialog 移植；2026-09-27 泛化为通用入口）----------
  // 弹窗 DOM 在 index.html（#rename-modal，复用 risk-modal 的 mask/dialog 样式骨架）。本模块只管
  // 表单壳（标题/占位/初值/校验/错误回显），提交语义由调用方以 onSubmit 注入——会话重命名走
  // POST /gateway/session/rename（网关 append custom-title，已停止会话同样生效），文件重命名走
  // POST /gateway/file/rename（work.js 注册），两者共用同一对话框实例，不各建一套弹窗。
  let renameTarget = null // { heading, placeholder, okText, onSubmit }
  const renameModal = $('rename-modal')
  const renameInput = $('rename-input')
  const renameErr = $('rename-error')
  const renameTitle = renameModal.querySelector('.title')
  const renameOk = $('rename-ok')
  function openRenameDialog(opt) {
    renameTarget = opt
    renameTitle.textContent = opt.heading || '重命名'
    renameInput.placeholder = opt.placeholder || '输入新名称'
    renameOk.textContent = opt.okText || '重命名'
    renameInput.value = opt.value || ''
    renameErr.hidden = true
    renameModal.hidden = false
    renameInput.focus()
    renameInput.select()
  }
  function closeRenameDialog() {
    if (!renameModal.hidden) renameModal.hidden = true
    renameTarget = null
  }
  async function confirmRename() {
    if (!renameTarget) return
    let value = renameInput.value.trim()
    if (!value) {
      renameErr.textContent = '名称不能为空'
      renameErr.hidden = false
      return
    }
    try {
      await renameTarget.onSubmit(value)
      closeRenameDialog()
    } catch (e) {
      renameErr.textContent = e.message || String(e)
      renameErr.hidden = false
    }
  }
  // 会话重命名：查不到（列表已刷新掉）才报错；提交成功同步内存标题并重渲列表。
  // onDone（可选）= 本模块之外的标题消费方补渲染（如 work 顶栏胶囊，work-mount.js 传 renderTopbar）。
  function openSessionRename(hash, onDone) {
    const s = ALL.find((x) => hashOf(x) === hash)
    if (!s) return toast('未找到该会话')
    openRenameDialog({
      heading: '重命名会话',
      placeholder: '输入新标题',
      okText: '重命名',
      value: s.title || '',
      onSubmit: async (title) => {
        const res = await fetch(apiUrl('/gateway/session/rename'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: s.id, title }),
        })
        const body = await res.json()
        if (!res.ok || !body.ok) throw new Error(body.error || '重命名失败')
        s.title = title
        renderRecent()
        if (onDone) onDone()
        toast('已重命名为「' + title + '」')
      },
    })
  }
  $('rename-cancel').addEventListener('click', closeRenameDialog)
  $('rename-ok').addEventListener('click', confirmRename)
  $('rename-modal').querySelector('.close').addEventListener('click', closeRenameDialog)
  renameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmRename() }
    if (e.key === 'Escape') { e.preventDefault(); closeRenameDialog() }
  })
  // 点遮罩关闭（与 risk-modal 一致：对话框外判定）
  $('rename-modal').addEventListener('mousedown', (e) => {
    if (!renameModal.hidden && !e.target.closest('.dialog')) closeRenameDialog()
  })

  // 新建 web 会话（2026-08-24 改造：本地可见交互 CLI 窗口，替代 headless 子进程）。
  // 触发方式 = 首页空态输入第一条消息（gwSend 空态分支调用），不再有「新建独立会话」按钮。
  // 网关 spawn 本地可见交互 REPL 窗口（--session-id 预分配）→ CLI 连 /clients 注册 →
  // 网关等注册完成才返回 → 首条消息经 cliClients 精确路由注入 REPL（与本地打字同路径）。
  // 展示走 conversationDisplay 上报 + jsonl 落盘 + SSE 列表刷新（与 CLI 会话一致）。
  // 2026-08-24 防双 spawn：web 会话创建中标志（POST /gateway/wsession 等 CLI 注册最长 20s），
  // 创建期间 gwSend 空态分支再次发送直接忽略，杜绝「每发一条新建一个会话」。
  let webCreating = false
  // 首条消息事务（2026-09-06 根治三态）：值=进行中事务的会话 hash，''=无事务。语义唯一——
  // 「该会话首条乐观 DOM（气泡+proc 折叠）是权威」：renderSession/refreshSession 空 fetch 不洗盘、
  // queue-dock 不渲染（注入中消息不降级「排队中」形态）、真实数据落盘即收口销毁（渲染权威接管）。
  // 旧 pendingFirstSend（pre/hash 双字段+三处守卫+DOM 在场补挂）状态发散已整删：三态=状态源过多
  // +同步 navigate 时序（hash 回填前移 newWebSession 内）+DOM 被当状态存储三者叠加，详见各守卫处。
  let firstSendHash = ''
  // 分层治理 4C（2026-10-10）：engine/live.js 的读取口（写侧仍是尾部 setFirstSendHash）——每次现读，
  // 调用方严禁缓存返回值。
  function getFirstSendHash() { return firstSendHash }
  async function newWebSession(projectLabel, model) {
    if (needToken()) return toast('请先完成 token 验证')
    if (webCreating) return null
    webCreating = true
    toast(projectLabel ? `正在 ${projectLabel} 打开本地 CLI 窗口…` : '正在全局根打开本地 CLI 窗口…')
    try {
      // 2026-10-13 待办 12：首页选的模型随 wsession body.model 下发（池内全名），网关 spawn 时
      // 落 --model 启动参数——CLI 启动即固化会话覆盖，首轮请求即用所选模型（不再事后补投）。
      const body = {}
      if (projectLabel) body.project = projectLabel
      if (model) body.model = model
      const res = await fetch(apiUrl('/gateway/wsession'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await res.json()
      if (!d.hash || !d.id) throw new Error(d.error || 'bad response')
      // 首条消息事务 hash 回填必须在 navigate 之前：navigate 同步 route → renderSession，
      // 守卫（firstSendHash === hash）此刻起生效（回填放 await 续体=跑在 renderSession 之后，
      // 三态截图第②态「加载中…洗掉乐观 DOM」的时序根因）
      if (firstSendHash === '') firstSendHash = d.hash
      // 合成列表条目：子进程刚起 jsonl 可能未落盘，先插入列表保证可导航；SSE 刷新会用真实条目替换。
      // 2026-08-24 用户定案：未指定项目（笔/首页消息发送）→ 会话落全局根（@WrokSpace 散装区，
      // projectScope:'global'）；指定项目 → 该项目组（projectScope:'project'）。不再落启动服务器的项目根。
      const isGlobal = !projectLabel
      ALL.unshift({ id: d.id, file: d.hash + '.jsonl', title: '新会话', state: 'busy', updatedAt: Date.now(), createdAt: Date.now(), synthetic: true, projectScope: isGlobal ? 'global' : 'project', projectLabel: projectLabel || '', messageCount: 0 })
      renderRecent()
      navigate('#/' + encodeURIComponent(d.hash))
      if (isMobile()) setPanel(false)
      return d
    } catch (e) {
      toast('创建独立会话失败: ' + (e.message || e))
      return null
    } finally {
      webCreating = false
    }
  }

  function renderRecent() {
    // 重建前快照展开行（hash + 当前视口矩形）：重建后新节点没有 .expanded，鼠标未动不会重触发
    // mouseenter；且收起后列表变短，光标可能落到相邻行。按下标矩形认回原行（行菜单开着则按 hash 重开）。
    const liftEl = peekSrc || expandedEl
    const prevExpand = liftEl && liftEl.dataset.hash
      ? { hash: liftEl.dataset.hash, rect: liftEl.getBoundingClientRect() }
      : null
    expandClear() // SSE/导航重建列表：展开态随旧节点消亡，先清引用（末尾按线索恢复）
    peekClear()
    // 记录刷新前的会话条目 key（会话哈希 / 项目文件夹名），仅给「新增条目」播放入场动画，
    // 已有条目静默保留，避免每次 SSE 刷新整列重播淡入
    const prevKeys = new Set()
    bodyEl.querySelectorAll('.sess-item, .folder').forEach((el) => {
      const k = el.dataset.hash || el.dataset.f
      if (k) prevKeys.add(k)
    })
    // 保留展开的项目文件夹 + 侧栏滚动位置（2026-08-16：主区导航进管理视图/预览走 route→renderRecent，
    // 重建列表时不重置侧栏状态，避免展开文件夹收起、滚动跳顶）
    const openF = [...bodyEl.querySelectorAll('.folder.open')].map((f) => f.dataset.f)
    const prevTop = bodyEl.scrollTop
    bodyEl.innerHTML = ''
    modeTabsEl.classList.toggle('hidden', state.mode !== 'project')
    recentLabel.textContent = state.mode === 'list' ? '最近' : '最近对话'
    if (state.mode === 'list') renderList()
    else renderProject()
    bodyEl.querySelectorAll('.sess-item, .folder').forEach((el) => {
      const k = el.dataset.hash || el.dataset.f
      if (k && !prevKeys.has(k)) el.classList.add('item-in')
    })
    if (openF.length) {
      for (const f of bodyEl.querySelectorAll('.folder')) {
        if (openF.includes(f.dataset.f)) f.classList.add('open')
      }
    }
    if (prevTop) bodyEl.scrollTop = prevTop
    reliftAfterRebuild(bodyEl, prevExpand)
    renderBubble()
    renderSearch()
  }

  // 列表重建后的统一恢复出口（chat 侧栏 renderRecent / work 下沉区 renderWorkBody 共用；root = 该列表
  // 的滚动容器，prevExpand = 重建前的展开快照，仅 chat 侧提供）。四条线索：
  // ① 触屏长按菜单开着 → 按菜单行标识重新展开（浮窗挂 body 下不受重建影响，行节点需重挂）；
  // ② 触屏点击钉住的延展（peekPin）→ 按 (sel, dataset 键, 值) 找回新节点重开克隆（点击先于 click 导航，
  //    旧节点在重建时已脱离文档，不能在 click 里补）；
  // ③ 行点击触发的导航（reLiftHash）→ 展开被点行——重建后新节点 :hover 不恢复（Chrome 实测）；
  // ④ 纯 hover 重建（无线索）：refreshList 按活动流签名随时整列重建（会话处理中=高频），
  //    光标所在行同样收起了，按最近光标落点恢复。恢复一律直接终态（无动画）。
  function reliftAfterRebuild(root, prevExpand) {
    if (rowMenuPop && rowMenuTouch) { reliftRowMenu(); return }
    if (peekPin && peekPinRestore(root)) return
    if (reLiftHash) {
      const el = [...root.querySelectorAll('.sess-item')].find((x) => x.dataset.hash === reLiftHash)
      reLiftHash = null
      if (el) peekFocus(el)
      return
    }
    if (!mouseXY) return
    // 先按重建前展开矩形认原行：重建后行已收起、列表变短，elementFromPoint 可能落到相邻行。
    if (prevExpand &&
      mouseXY[0] >= prevExpand.rect.left && mouseXY[0] <= prevExpand.rect.right &&
      mouseXY[1] >= prevExpand.rect.top && mouseXY[1] <= prevExpand.rect.bottom) {
      const el = [...root.querySelectorAll('.sess-item')].find((x) => x.dataset.hash === prevExpand.hash)
      if (el) { peekFocus(el); return }
    }
    const hit = document.elementFromPoint(mouseXY[0], mouseXY[1])?.closest('.sess-item')
    if (hit && hit.dataset.hash && root.contains(hit)) peekFocus(hit)
  }
  // 恢复出口：指针型操作走横向延展 clone（与 hover 同一终态）；手指触控只补底色高亮（行高不动）
  function peekFocus(el) { if (canPeek()) peekStart(el); else expandStart(el) }

  // 管理视图（插件/技能预览，Codex 风格）：渲染到主聊天区（侧栏会话列表保持不变）。
  // 插件与技能预览都从「插件」入口进入，顶部插件/技能切换；数据源 = 网关 /gateway/plugins 实时扫描。
  // 重渲保留滚动位置（切换 kind/cat 时内容高度变化，避免 scrollTop 被重置成可见跳动）。
function setFirstSendHash(v) { firstSendHash = v }
  // ---------- 预览页注册的侧栏快捷按钮（2026-09-23） ----------
  // 用途：.claude/preview 页面在 iframe 内运行，可经 postMessage 往 Floria 侧栏折叠带注册自己的
  // 快捷按钮，点击回跳该页做动作（沿用既有 iframe ↔ 宿主 postMessage 通道）。
  // 契约：预览页 → 宿主 parent.postMessage({ type:'floria-rail-register', items:[{id,icon,title}] }, '*')
  //       icon = I 图标表的键（不让预览页自送 SVG——视觉沿用侧栏现成图标，SPEC §6.4「不新增视觉」）
  //       title = 悬浮提示；id 由预览页自定义，点击时原样回传。
  //       宿主 → 预览页 frame.contentWindow.postMessage({ type:'floria-rail-action', id }, '*')
  // 呈现：折叠态 = 复现成 .rail-ico（28px 圆角 8，hover --hover），挂进 #rail-mid；#rail-ext 用
  //       display:contents 不产生盒，子元素与内置四个图标同列同 gap 居中（零新增视觉）。
  // 不变量：注册集属于**当前加载的那份预览文档**——文档换（iframe 换 src / 重建 / 离开预览），
  //        注册集即失效并清空；凭 e.source 精确匹配当前 .preview-frame 才采纳，别处窗口伪报不进来。
  // 状态表 railExtItems + clearRailExt 已迁 feature/preview-frame.js（与本模块只读/写经由它）；
  // 本模块只留桥接与渲染。
  // 按来源窗口反查任一预览帧（卡池化后含隐藏帧）；无匹配返回 null。
  function frameBySource(root, src) {
    if (!src) return null
    for (const el of root.querySelectorAll('.preview-frame')) if (el.contentWindow === src) return el
    return null
  }
  function renderRailExt() {
    const box = $('rail-ext')
    if (!box) return
    box.innerHTML = railExtItems
      .map((it) => `<button class="rail-ico" data-rail-id="${esc(it.id)}" title="${esc(it.title)}">${I[it.icon]}</button>`)
      .join('')
    box.querySelectorAll('.rail-ico').forEach((b) =>
      b.addEventListener('click', () => {
        const f = activePreviewFrame(document)
        if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'floria-rail-action', id: b.dataset.railId }, '*')
      }),
    )
  }
  function bindRailExtBridge() {
    addEventListener('message', (e) => {
      const d = e.data
      if (!d) return
      // 两类申报共用「当前预览帧作证」这一道门（e.source 必须就是 .preview-frame 的 contentWindow）
      const rail = d.type === 'floria-rail-register'
      const cards = d.type === 'floria-cards-register'
      if (!rail && !cards) return
      // 卡池化（2026-10-26）：池内每张卡各一枚帧，申报按来源窗口精确反查（含隐藏帧）。
      // 隐藏帧的申报不入当前表，但缓存到帧上——切回该卡（池内切显隐、无 load）时由 work-preview 恢复。
      const f = frameBySource(document, e.source)
      if (!f) return
      if (cards) {
        // 卡片化二期：预览页实时申报外部卡（同 id 覆盖静态清单项）。字段校验与 preview.json 来源共用
        // engine/ext-decl.js 的同一份过滤器——两条外部输入不给两处各写一套；label 取帧上锚定的项目。
        if (f === activePreviewFrame(document)) registerExtCards(f.dataset.label || '', d.cards, false)
        return
      }
      // 边界校验（外部输入）：id 必为非空串、icon 必是 I 表自有键（含 constructor 之类的原型键不收）
      const items = (Array.isArray(d.items) ? d.items : [])
        .filter((it) => it && typeof it.id === 'string' && it.id && Object.prototype.hasOwnProperty.call(I, it.icon))
        .map((it) => ({ id: it.id, icon: it.icon, title: typeof it.title === 'string' ? it.title : '' }))
      f.__railItems = items
      if (f !== activePreviewFrame(document)) return // 隐藏帧只记账，不改当前侧栏
      setRailExtItems(items)
      renderRailExt()
    })
  }
  bindRailExtBridge()

  // 管理视图统一入口（route 的 mgr 分支 / 侧栏 tab 内切换 / 神经元进出层级）：清会话全局槽后整卡切到 state.mgr。
  function renderMgr() {
    closeMentionPop()
    stopLiveFoldTimer()
    stageRelease()
    state.currentHash = ''
    state.preview = null
    // 2026-09-19 神经 tab 被实时流洗成 chat 根治：管理视图（插件/项目/模型/神经）是「离开会话视图」
    // 的入口之一，必须与 renderHome/openProjectPreview 同款清全局槽——旧实现只清 currentHash 不
    // 清槽，会话 A 的 session-delta 到达时按残留 curUuid 命中守卫 → renderSessionBody 整页重建
    // #messages 把管理视图（如神经元图）洗成会话消息流。清槽清单与不变量见 route.js clearSessionSlots。
    clearSessionSlots()
    // 切卡：同 id 卡复用（卡体整换、滚动层不动 ⇒ 滚动位置天然保持），异 id 卡新建并 .remove() 旧卡
    openCard(state.mgr)
  }

  function renderList() {
    const box = document.createElement('div')
    // 2026-08-25「在一个列表中」堆叠视图：项目会话显示所属项目短编号气泡（Pj16），根会话无气泡
    box.innerHTML = sorted().map((s) => itemHtml(s, true)).join('')
    bindSessionRows(box)
    bodyEl.appendChild(box)
  }

  function renderProject() {
    bodyEl.innerHTML = ''
    if (state.pt === 'projects') {
      const byProject = {}
      // 临时项目（根级时间戳任务区）的会话按全局根对待：不进项目文件夹视图（2026-11-06 用户定案）。
      for (const s of ALL) {
        const label = sessionProjLabel(s)
        if (label) (byProject[label] = byProject[label] || []).push(s)
      }
      const labels = Object.keys(byProject).sort((a, b) => {
        const la = Math.max(0, ...byProject[a].map((s) => s.updatedAt))
        const lb = Math.max(0, ...byProject[b].map((s) => s.updatedAt))
        return lb - la
      })
      if (labels.length === 0) {
        bodyEl.innerHTML = '<div class="no-hit" style="padding:10px">暂无项目会话</div>'
        return
      }
      const box = document.createElement('div')
      box.innerHTML = labels
        .map((label) => {
          const chats = [...byProject[label]].sort(sessCmp)
          // 2026-08-24 项目新建会话：项目文件夹行 + 按钮 → 在指定项目下新建 web 会话
          // （与「笔」新建会话并存，两者指向不同 exe——见 newWebSession 注释）
          return `<div class="folder" data-f="${esc(label)}"><button class="folder-head">
            <span class="chev">▶</span><span class="ficon">${I.folder}</span><span class="fname">${esc(label)}</span>
            <span class="fcount">${chats.length}</span>
            <span class="folder-add" role="button" tabindex="-1" title="在 ${esc(label)} 新建会话">${I.dshPlus}</span></button><div class="folder-body">${chats.map(itemHtml).join('')}</div></div>`
        })
        .join('')
      box.querySelectorAll('.folder-head').forEach((h) => h.addEventListener('click', () => h.parentElement.classList.toggle('open')))
      // 2026-08-24 项目新建会话入口：点击 → 在指定项目新建 web 会话
      // 2026-08-25 改造：与「笔」一致，先到初始化界面（#/ 空态 + 目标项目 chip），
      // 首条消息发送时才真正建会话（gwSend 空态分支带 project 调 newWebSession）。不再直接弹 CLI。
      box.querySelectorAll('.folder-add').forEach((a) =>
        a.addEventListener('click', (e) => {
          e.stopPropagation()
          const f = a.closest('.folder')
          if (f && f.dataset.f) {
            state.newProject = f.dataset.f
            navigate('#/')
            if (isMobile()) setPanel(false)
          }
        }),
      )
      bindSessionRows(box)
      bodyEl.appendChild(box)
    } else {
      const root = ALL.filter((s) => s.projectScope !== 'project')
      const box = document.createElement('div')
      box.innerHTML = root.length ? root.map(itemHtml).join('') : '<div class="no-hit" style="padding:10px">暂无根会话</div>'
      bindSessionRows(box)
      bodyEl.appendChild(box)
    }
  }

  // ---------- 气泡弹层 ----------
  function renderBubble() {
    bubblePop.innerHTML = '<div class="b-head">最近会话</div>' + sorted().slice(0, 5).map(itemHtml).join('')
    bubblePop.querySelectorAll('.sess-item').forEach((b) =>
      b.addEventListener('click', () => {
        navigate('#/' + encodeURIComponent(b.dataset.hash))
        bubblePop.classList.remove('show')
        if (isMobile()) setPanel(false)
      }),
    )
  }

  // ---------- 搜索覆盖层 ----------
  // 2026-10-08 双模式同构（用户定案）：顶栏 🔍 两模式同一个 #panel-search → 本覆盖层，只是**内容按模式限**——
  // chat = 全部会话；work = 限到当前工作项目（state.workProj），既列该项目的会话、也列该项目的文件
  // （点文件 = openWorkFile 进编辑区）。弹窗本体（#search-overlay / renderSearch）两模式共用一份，不另起。
  const searchInWork = () => state.sbMode === 'work' && !!state.workProj
  function openSearch() {
    overlay.classList.add('show')
    sInput.value = ''
    sInput.placeholder = searchInWork() ? '搜索项目内的会话与文件…' : '搜索全部对话…'
    renderSearch()
    // work：文件面的数据源是当前项目文件树（wkTree）；未加载则拉一次后重渲
    if (searchInWork() && !wkTree) loadProjectTree(state.workProj).then(renderSearch)
    setTimeout(() => sInput.focus(), 30)
  }
  // 文件树拍平成「项目内相对路径」；目录只用于拼前缀，q 命中 = 整条路径含子串
  function wkFilePaths(nodes, prefix, q) {
    const out = []
    for (const n of nodes || []) {
      const p = prefix ? `${prefix}/${n.name}` : n.name
      if (n.type === 'dir') out.push(...wkFilePaths(n.children, p, q))
      else if (!q || p.toLowerCase().includes(q)) out.push(p)
    }
    return out
  }
  function renderSearch() {
    const q = sInput.value.trim().toLowerCase()
    const inWork = searchInWork()
    // work 下范围 = 当前工作项目的会话；临时项目（根级时间戳任务区）的范围 = 全局根散装会话
    // （与侧栏聊天列表 / workScopeOk 同一判据，2026-10-30）。
    const inScope = (s) => sessionInWork(s, state.workProj)
    const rows = sorted().filter(
      (s) =>
        (!inWork || inScope(s)) &&
        (!q || s.title.toLowerCase().includes(q) || (s.projectLabel || '').toLowerCase().includes(q)),
    )
    const sessHtml = rows
      .map((s) => {
        // work 下结果已限在同一项目，项目标签无信息量；chat 下保留以区分来源（临时项目归一为全局，无标签）
        const pl = sessionProjLabel(s)
        const prj = !inWork && pl ? `<span class="s-prj">${esc(pl)}</span>` : ''
        return `<div class="s-row" data-hash="${esc(hashOf(s))}"><span class="s-ico">${I.msg}</span><span class="st">${esc(s.title)}</span>${prj}</div>`
      })
      .join('')
    const files = inWork ? wkFilePaths(wkTree, '', q) : []
    const filesHtml = files
      .map((p) => `<div class="s-row" data-wkfile="${esc(p)}"><span class="s-ico">${I.dshFile}</span><span class="st">${esc(p)}</span></div>`)
      .join('')
    // work 下两张内容面（会话 / 文件）各带小标题；chat 只有会话面、不加标题（与原观感一致）
    const html = inWork
      ? (sessHtml ? '<div class="s-sec">会话</div>' + sessHtml : '') + (filesHtml ? '<div class="s-sec">文件</div>' + filesHtml : '')
      : sessHtml
    $('search-results').innerHTML =
      html || `<div class="no-hit">${inWork ? '项目内没有匹配的会话或文件' : '没有匹配的会话'}</div>`
    $('search-results').querySelectorAll('.s-row').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.dataset.wkfile) openWorkFile(b.dataset.wkfile)
        else navigate('#/' + encodeURIComponent(b.dataset.hash))
        overlay.classList.remove('show')
        if (isMobile()) setPanel(false)
      }),
    )
  }

  // ---------- 侧栏开合核 ----------
  // 开合落地唯一实现：钉住态 + 可见态 + #sidebar.open + 折叠清拖拽调宽。recent.js 的 setPanel 委托本核
  // （弹层清理 / 行浮窗 / work 视图浮窗行状态留在其包装层）；卡（neurons/projects）只需「无导航收抽屉」
  // → closePanel（不再横向 import sidebar/recent.js）。真源 = state.panelPinned（悬停唤出只置 panelOpen，
  // 不算「打开」——「侧边栏」开关与 work paneOn 均读 panelPinned）。
  function applyPanelOpen(open, pin) {
    state.panelPinned = !!open && !!pin
    state.panelOpen = open
    sidebar.classList.toggle('open', open)
    // 折叠即清拖拽调宽（2026-09-12）：移除 :root 内联 --panel-w，再展开回默认 280px（不持久化）
    if (!open) document.documentElement.style.removeProperty('--panel-w')
  }
  function closePanel() {
    applyPanelOpen(false)
  }

  // 卡片字段校验（唯一一份）：preview.json 来源在网关已校过一遍，但 postMessage 这条不经过网关，
  // 必须同款再校——两条来源共用本函数，不给两处各写一套。host 只认 view（本版唯一定义的位置）。
  function normExtCards(raw) {
    return (Array.isArray(raw) ? raw : [])
      .filter((c) => c && typeof c === 'object' && !Array.isArray(c))
      .map((c) => ({
        id: typeof c.id === 'string' ? c.id.trim() : '',
        title: typeof c.title === 'string' ? c.title.trim() : '',
        icon: typeof c.icon === 'string' && c.icon ? c.icon : 'plug',
        path: typeof c.path === 'string' ? c.path.trim() : '',
        host: typeof c.host === 'string' ? c.host : '',
        tab: c.tab !== false,
        repo: typeof c.repo === 'string' ? c.repo.trim() : '',
        // 启用态由网关按目录标记下发（缺省 = 启用）；postMessage 来源无此字段 ⇒ 恒启用
        enabled: c.enabled !== false,
      }))
      .filter((c) => /^[a-zA-Z0-9_-]{1,32}$/.test(c.id) && c.title && c.host === 'view' && isExtPath(c.path))
  }
  // 浮窗动作字段校验（2026-09-28，与 normExtCards 同款风格）：preview.json 的 quoteActions 段。
  // 动作是**纯数据**（无 path / host，不指向文件）——宿主只渲染动作行，点击把 id 回发预览页。
  // id 非法 / 重名、title 空 → 丢（不猜不兜底）；icon 缺省 plug。整个 quoteActions 缺失 = 空集。
  function normQuoteActions(raw) {
    const seen = new Set()
    return (Array.isArray(raw) ? raw : [])
      .filter((a) => a && typeof a === 'object' && !Array.isArray(a))
      .map((a) => ({
        id: typeof a.id === 'string' ? a.id.trim() : '',
        title: typeof a.title === 'string' ? a.title.trim() : '',
        icon: typeof a.icon === 'string' && a.icon ? a.icon : 'plug',
      }))
      .filter((a) => {
        if (!/^[a-zA-Z0-9_-]{1,32}$/.test(a.id) || !a.title || seen.has(a.id)) return false
        seen.add(a.id)
        return true
      })
  }
  // 资源路径必须是 preview 目录内的相对文件路径（绝对路径 / 反斜杠 / query / 空段 / `.` `..` 段
  // 一律拒；允许尾随 #片段）。与网关 isPreviewRelPath 同款规则——网关侧挡 preview.json 来源，
  // 这里挡 postMessage 来源，两条外部输入各自守门。
  function isExtPath(p) {
    if (!p || p.startsWith('/') || p.includes('\\') || p.includes('?')) return false
    const i = p.indexOf('#')
    const file = i >= 0 ? p.slice(0, i) : p
    let rel
    try { rel = decodeURIComponent(file) } catch { return false } // 非法 % 序列
    if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.includes('?')) return false
    return rel.split('/').every((s) => s && s !== '.' && s !== '..')
  }
  // 卡页 URL：/preview/<label>/<path>（+token 供未授权设备首链；#片段原样带上，由卡页自我定位）
  function extCardSrc(label, card) {
    const i = card.path.indexOf('#')
    const file = i >= 0 ? card.path.slice(0, i) : card.path
    const frag = i >= 0 ? card.path.slice(i) : ''
    const q = gToken ? '?token=' + encodeURIComponent(gToken) : ''
    return `/preview/${encodeURIComponent(label)}/${file}${q}${frag}`
  }


  // ---------- 表变更 → 侧栏 tab 重渲（回调注入，勿缓存）----------
  // registry 在其模块体中注入 renderMgrTabs（PIECES 保证 registry 排在 ext-runtime 之后）。
  // 缺省 no-op：注入前的表变更不会崩，随后 bootRegistry() 的全量渲染会覆盖最终态。
  let tabRefresh = () => {}
  function setTabRefresh(fn) { tabRefresh = fn }

  // ---------- 运行时外部卡表（卡片化二期）----------
  // 外部（<项目>/.claude/preview/ 申报）卡只活在这里，与第一方 CARDS 分表存放：外部卡没有 mount
  // 代码，只有宿主生成的 iframe 壳（views/cards/ext/ext-card.js，经 setExtCardRenderer 注入）——外部
  // 永不获得在宿主 DOM 执行的能力。
  // id 命名空间 `ext:<label>:<id>`（第一方 id 全是裸词，零撞车）；EXT_LABEL 记录本表属于哪个项目。
  // 两条来源汇入 registerExtCards：①网关 /gateway/preview-cards（preview.json 静态清单，replace=true
  // 整份替换）②预览页 postMessage floria-cards-register（同 id 覆盖 + 追加，页面最了解自己有什么卡）。
  // 生命周期不变量：外部卡集恒属于「当前 .preview-frame 所指项目」——异 label 硬挂载 / 文档重挂即
  // 清（清点收在 feature/preview-frame.js 的 syncExtCards，与 clearRailExt 同点）；**离开预览路由
  // 不清**，否则用户点外部卡 tab 的瞬间卡就被清没了。
  let extRender = null
  function setExtCardRenderer(fn) { extRender = fn }
  let EXT = []
  let EXT_LABEL = ''
  const extTabs = () => EXT // registry 只读取用（合流渲染），增删恒走本件
  // EXT 表所属项目 label（'' = 空表）。registry 据此判「当前是否该项目预览语境」——
  // EXT 恒属当前 .preview-frame 所指项目（生命周期不变量见上），不得无条件进全局 #mgr-tabs。
  const extLabel = () => EXT_LABEL
  const appTabs = () => APP_TABS
  function registerExtCards(label, cards, replace) {
    if (!label) return
    if (replace || EXT_LABEL !== label) { EXT = []; EXT_LABEL = label }
    const list = normExtCards(cards)
    // 网关权威快照（replace=true）落盘：EXT 只活在内存里，刷新即空 ⇒ 不落盘则刷新后
    // 外部卡 tab 缺失、/manage/ext:<label>:<id> 直进无卡可解析（见下方 hydrateExtCards）。
    // postMessage 增量注册不落盘——那是预览页的实时补充，混进快照会让缓存随文档生命周期漂移。
    if (replace) persistExtDecls(label, { cards: list })
    for (const c of list) {
      const id = `ext:${label}:${c.id}`
      EXT = EXT.filter((v) => v.id !== id) // 同 id 覆盖，不改位置语义（后注册者在列表尾）
      EXT.push({
        id,
        title: c.title,
        tip: `${c.title} · ${label}`,
        icon: I[c.icon] ? c.icon : 'plug',
        tab: c.tab,
        mount: (body) => extRender(body, label, c),
      })
    }
    tabRefresh()
  }
  function clearExtCards() {
    if (!EXT.length && !EXT_LABEL) return
    EXT = []
    EXT_LABEL = ''
    tabRefresh()
  }

  // ---------- 外部卡申报的持久化（与 work/管理态同一条 floria-ui-v1 链，分表存 extDecls）----------
  // 真源仍是网关（preview.json）：缓存只是「上次所见」的快照，启动/切项目时先 hydrate 回来让
  // tab 与路由即刻可用，随后 syncExtCards 拉新整份覆盖（feature/preview-frame.js）。无缓存（首次访问）
  // = 空表，照旧等网络清单——不猜不兜底。
  function persistExtDecls(label, patch) {
    if (!label) return
    const d = readUI() || {}
    const all = d.extDecls && typeof d.extDecls === 'object' ? { ...d.extDecls } : {}
    all[label] = { ...(all[label] || {}), ...patch }
    patchUI({ extDecls: all })
  }
  // 缓存 → 运行时表（同步、无网络）。放表而不清表：hydrate 只认「当前该项目」这一份，
  // 异 label 清理仍归 syncExtCards / clearExtCards（不新增第二个清点）。
  function hydrateExtCards(label) {
    if (!label) return
    const d = readUI()
    const e = d && d.extDecls ? d.extDecls[label] : null
    if (!e || typeof e !== 'object') return
    if (Array.isArray(e.cards)) registerExtCards(label, e.cards, true)
    if (Array.isArray(e.quoteActions)) registerQuoteActions(label, e.quoteActions)
  }
  // `ext:<label>:<cardId>` → 缓存恢复。卡 id 不含冒号（normExtCards 正则 [a-zA-Z0-9_-]{1,32}），
  // 故 label = 最后一个冒号之前那段。路由恢复用（刷新直进 /manage/ext:…）。
  function hydrateExtCardId(id) {
    if (typeof id !== 'string' || !id.startsWith('ext:')) return false
    const i = id.lastIndexOf(':')
    if (i < 4) return false
    hydrateExtCards(id.slice(4, i))
    return true
  }

  // ---------- 项目申报的浮窗动作表（2026-09-28）----------
  // preview.json 的 quoteActions 段 → 宿主侧常驻表。选中引用浮窗（inputbar/quote.js）打开时与内置
  // 动作合流渲染。与 EXT 同一份申报来源、同一生命周期与清理点（feature/preview-frame.js syncExtCards /
  // mountPreview 重挂）——不变量：动作表恒属于「当前 .preview-frame 所指项目」。
  // 动作是纯数据、无 mount 代码：点击只把 id 回发预览页（floria-quote-action），执行留在项目页面里。
  // 本版唯一来源 = preview.json 静态段（不做 postMessage 实时注册）。
  let QACTIONS = []
  let QACTIONS_LABEL = ''
  function registerQuoteActions(label, actions) {
    if (!label) return
    QACTIONS = normQuoteActions(actions)
    QACTIONS_LABEL = label
    persistExtDecls(label, { quoteActions: QACTIONS }) // 与 EXT 同一份申报、同一份缓存（同清同存）
  }
  function clearQuoteActions() {
    if (!QACTIONS.length && !QACTIONS_LABEL) return
    QACTIONS = []
    QACTIONS_LABEL = ''
  }
  function quoteActions() {
    return QACTIONS
  }

  // ---------- 应用目录与「已启用的应用」tab（2026-10-10）----------
  // 应用 = 工作区根 <workroot>/.claude/preview/ 里申报的界面单元（preview.json 的 cards 段，经
  // /gateway/preview-cards?label=<全局根> 取回）。**不扫描目录、不自动渲染**：清单只进插件卡的
  // 「应用」列表（第三个 cat），由用户点「+」启用；**已启用**的应用才在侧栏生成 tab（APP_TABS），
  // 点击走 openCard → 注入的 iframe 壳渲染其页（字段校验复用 engine/ext-decl.js，零第二份实现）。
  // 与 EXT 分表：EXT 属于「当前 .preview-frame 所指项目」、进出预览即清（clearExtCards）；
  // 应用 tab 恒属于工作区根，不被任何预览生命周期清理。
  // GLOBAL_LABEL 须与 localGateway.ts findProjects() 的全局根 label **逐字一致**（含 · 与两侧空格）。
  const GLOBAL_LABEL = '全局根 · 散装对话'
  // 工作区根 label 判定（registry 据 state.preview / state.mgr 判「当前语境 = 工作区根」用；GLOBAL_LABEL
  // 本身留本件私有，不外泄裸字符串，避免第二处硬编码 label 漂移）。
  const isGlobalLabel = (l) => l === GLOBAL_LABEL
  // 应用详情的写回链（preview.json 的 repo 字段）要按 label 调 /gateway/file*——取 label 走本出口，
  // 不新增第二处字面量。
  const globalLabel = () => GLOBAL_LABEL
  let APP_CATALOG = [] // 全部可用应用（normExtCards 产物；插件卡「应用」列表数据源）
  let APP_TABS = [] // 已启用的应用 tab（侧栏；openCard 可解析）
  let appSeq = 0

  function appCatalog() {
    return APP_CATALOG
  }
  // 启用态真源 = 卡目录 / 应用目录内的 .disabled 标记（网关随清单下发 enabled），跨浏览器一致。
  // 目录未就绪（无该应用）= 未启用。
  function isAppEnabled(id) {
    const c = APP_CATALOG.find((x) => x.id === id)
    return !!c && c.enabled !== false
  }
  // 启用/停用唯一写口：落盘归网关（POST preview-cards/enable → 卡目录 .disabled），回来后整份刷新
  // 目录并按新表重建 tab。失败抛错交给调用方回滚（不本地先改状态，避免与盘上真值漂移）。
  async function setAppEnabled(id, on) {
    if (typeof id !== 'string' || !id) return false
    const q = gToken ? '?token=' + encodeURIComponent(gToken) : ''
    const res = await fetch('/gateway/preview-cards/enable' + q, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: GLOBAL_LABEL, card: id, enabled: !!on }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || 'HTTP ' + res.status)
    }
    await loadAppCatalog()
    return isAppEnabled(id)
  }
  // 目录 → 侧栏 tab（只取已启用者）。id 加 `app:` 前缀，与第一方裸词 id、EXT 的 `ext:` 零撞车。
  function applyAppTabs() {
    APP_TABS = APP_CATALOG.filter((c) => c.enabled !== false).map((c) => ({
      id: `app:${c.id}`,
      title: c.title,
      tip: `${c.title} · 应用（工作区根）`,
      icon: I[c.icon] ? c.icon : 'plug',
      tab: c.tab,
      mount: (body) => extRender(body, GLOBAL_LABEL, c),
    }))
  }
  // 目录整份替换 + 落缓存快照（刷新即用；与 EXT 同一份缓存结构，key = 全局根 label）。
  function setAppCatalog(cards) {
    APP_CATALOG = normExtCards(cards)
    persistExtDecls(GLOBAL_LABEL, { cards: APP_CATALOG })
    applyAppTabs()
    tabRefresh()
  }
  // 拉取点（唯一）：hideGate 补拉链调一次；断连重连自愈走同点。seq 守卫 = 只有最后一次响应可落目录。
  // 取不到 = 工作区根未申报应用（不猜不兜底，目录照旧为空）。
  function syncGlobalPlugins() {
    const cached = readUI()
    const e = cached && cached.extDecls ? cached.extDecls[GLOBAL_LABEL] : null
    if (e && Array.isArray(e.cards)) setAppCatalog(e.cards) // 缓存快照先落（列表即刻可用）
    else {
      applyAppTabs()
      tabRefresh()
    }
    loadAppCatalog()
  }
  // 拉一次工作区根应用清单（seq 守卫 = 只有最后一次响应可落目录；失败保持现有目录）。
  function loadAppCatalog() {
    const seq = ++appSeq
    return fetch(`/gateway/preview-cards?label=${encodeURIComponent(GLOBAL_LABEL)}${gToken ? '&token=' + encodeURIComponent(gToken) : ''}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((d) => {
        if (seq !== appSeq) return
        setAppCatalog((d && d.cards) || [])
      })
      .catch(() => {})
  }


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

  // ---------- 外部卡片（卡片化二期）----------
  // 用途：项目 `.claude/preview/` 里的界面单元（卡片）被 Floria web 内部调用——preview 在
  // preview.json 的 cards 段静态声明，或由预览页 postMessage 实时注册；宿主只按声明的 host 摆位，
  // **不解释卡片内容**（内容永远跑在它自己的文档里）。声明文件与 backend 段同一份申报表。
  // 渲染 = 一卡一 iframe（`/preview/<label>/<path>`，同源）：preview 保持自包含（自带 css/js/
  // 相对路径），与宿主 DOM/CSS/JS 零互相污染——一期 SPEC-视图卡化 §7「外部插件 = iframe」边界的延续。
  // 契约：preview.json cards（网关 GET /gateway/preview-cards 读出，见 docs/gateway.md §6）
  //       预览页 → 宿主 parent.postMessage({ type:'floria-cards-register', cards:[…] }, '*')
  //       宿主 → 预览页沿用既有 floria-rail-action 通道，本模块不新增回发。

  // 把一张外部卡的卡体写进宿主卡体（调用方 = registry 经 setExtCardRenderer 注入后 openCard 的 mount）
  function mountExtCard(body, label, card) {
    // 同卡重渲（切 kind/cat 或刷新）：旧帧随 innerHTML 拆除前先注销，否则表里留个死项
    const old = body.querySelector('.ext-frame')
    if (old) cardBus.unregisterFrame(old.__cardKey)
    body.innerHTML =
      '<div class="ext-shell">' +
      `<iframe class="ext-frame" title="${esc(card.title)}" data-ext-card="${esc(card.id)}" src="${esc(extCardSrc(label, card))}"></iframe>` +
      '</div>'
    // kind 恒 'ext'：EXT（当前预览项目）与应用（label = 全局根）共用本渲染器，label 已足以区分归属
    cardBus.registerFrame({ kind: 'ext', label, el: body.querySelector('.ext-frame'), id: card.id })
  }
  // 顶层注入：registry 的 EXT/APP 描述符 mount 走 extRender 闭包，外部实现不 import 进 engine。
  setExtCardRenderer(mountExtCard)

  // ---------- 预览卡 ----------
  // 槽位预览卡（openProjectPreview，独占主区）：与 work 右栏「预览态」（sidebar/work.js
  // renderWorkPreview）复用同一份 mountPreview——后端容器 / 静态页两级链只有这一处实现，
  // 在 feature/preview-frame.js。syncExtCards 亦在该件，供 sidebar/work.js 的补拉链调（外部卡申报）。
  const previewCardDef = {
    id: 'preview', title: '预览', tip: '项目预览', icon: 'folder', tab: false,
    mount(body, ctx) { mountPreview(body, ctx.payload.label, ctx.payload.hasPreview) },
  }
  registerCard(previewCardDef)

  // ---------- 插件卡（插件 / 技能 / 应用）----------
  // 每张卡自包含：mount(host, ctx) 只把内容写进交给它的卡体（host = .view-body）；卡内「整卡重渲」
  // （切 kind/cat）走 ctx.rerender() 由单一通道出，不反向依赖 mgr.js。
  // 「应用」cat 的数据源与启停口在 registry（APP_CATALOG / setAppEnabled）——本卡只呈现列表与按钮；
  // 循环 import（registry → 本卡的 pluginsCardDef）是函数级调用，无求值期依赖。
  // refresh 契约：卡外（mgr-data 拉完清单）经 refreshCard('plugins') 局部重渲本网格，不必懂本卡实现。
  // 详情页状态是卡内瞬态（MGR_DETAIL，模块级、不落盘）：切 kind/cat/搜索/刷新均回列表。
  let MGR_DETAIL = null // { kind, key }；key = 名称（插件/技能）或应用 id
  let PLUGINS_CTX = null // 当前挂载 ctx（列表/详情互跳的唯一重渲口）
  let PLUGINS_BODY = null // 当前卡体（网格局部重渲的落点，卡外 refreshCard 也走它）

  const pluginsCardDef = {
    id: 'plugins', title: '插件', tip: '插件 / 技能 / 应用', icon: 'plug', tab: true,
    mount(body, ctx) { PLUGINS_CTX = ctx; PLUGINS_BODY = body; renderMgrPlugins(body, ctx) },
    refresh() { renderMgrGrid() },
  }
  registerCard(pluginsCardDef)

  // 「插件/技能/应用」卡体（id='plugins' 的默认形态，即侧栏第一 tab）
  function renderMgrPlugins(body, ctx) {
    if (MGR_DETAIL) return renderMgrDetail(body, ctx)
    const v = state.mgrView
    const isApps = v.kind === 'apps'
    const kindName = isApps ? '应用' : v.kind === 'skills' ? '技能' : '插件'
    // 不传 sub / foot：插件 tab 不展示「申报说明」「数据源」这类提示文案（2026-11-02 用户定案）。
    MgrUI.browse(body, {
      // 顶层切换＝「插件 / 技能 / 应用」三态：应用与插件/技能同轴，故并入同一段控件（原在公开/个人行）
      kinds: [
        { id: 'plugins', label: '插件' },
        { id: 'skills', label: '技能' },
        { id: 'apps', label: '应用' },
      ],
      kind: v.kind,
      title: kindName,
      search: {
        placeholder: isApps ? '搜索应用…' : v.kind === 'skills' ? '搜索技能…' : '搜索插件…',
        value: v.q,
      },
      // 公开/个人只对「插件 / 技能」轴有意义，应用态不显示该行
      cats: isApps ? [] : [{ id: 'public', label: '公开' }, { id: 'personal', label: '个人' }],
      cat: v.cat,
      onKind(id) { v.kind = id; saveMgrView(); ctx.rerender() },
      onCat(id) { v.cat = id; saveMgrView(); ctx.rerender() },
      onSearch(q) { v.q = q; saveMgrView(); renderMgrGrid() },
      onItem(key) { openDetail(key) },
      onAction(key) { onRowAction(key) },
      onRetry() { loadMgrData(true) },
    })
    renderMgrGrid()
    if (!isApps) loadMgrData(false) // 真实数据：首次进入拉取，刷新按钮 force 重拉（应用目录由 registry 拉）
  }

  // ---------- 列表 ----------
  // 插件/技能/应用卡片网格（按 kind + cat + 搜索词过滤；应用数据源 = registry 的 APP_CATALOG）
  function renderMgrGrid() {
    if (PLUGINS_BODY) MgrUI.grid(PLUGINS_BODY, gridOpts())
  }

  // 网格数据：结构/绑定在包（MgrUI.grid），本函数只做业务过滤与条目映射。
  function gridOpts() {
    const v = state.mgrView
    // 「应用」kind：列出工作区根申报的全部应用，右侧 + / ✓ 切换启用（启用即侧栏出现该应用 tab）
    if (v.kind === 'apps') {
      const q = (v.q || '').trim().toLowerCase()
      const rows = appCatalog().filter((a) => !q || a.title.toLowerCase().includes(q) || a.id.toLowerCase().includes(q))
      return {
        items: rows.map(appItem),
        empty: '没有匹配的应用（工作区根 .claude/preview/preview.json 未申报应用）',
        onItem: openDetail,
        onAction: toggleApp,
      }
    }
    const label = v.kind === 'skills' ? '技能' : '插件'
    if (MGR_LOADING) return { loading: '加载真实清单中…' }
    if (MGR_ERR) return { error: { message: MGR_ERR }, onRetry: () => loadMgrData(true) }
    const src = (MGR && MGR[v.kind] && MGR[v.kind][v.cat]) || []
    const q = (v.q || '').trim().toLowerCase()
    const rows = q ? src.filter((x) => x.n.toLowerCase().includes(q) || (x.d || '').toLowerCase().includes(q)) : src
    return {
      items: rows.map(pluginItem),
      empty: `没有匹配的${label}`,
      onItem: openDetail,
      // 个人行动作位是启停开关（无 action.key 的公开市场行不会调到 onAction）；
      // 网格重渲走本函数，onAction 必须在这里给，否则点了只会 stopPropagation、什么也不发生。
      onAction: onRowAction,
    }
  }

  function openDetail(key) {
    MGR_DETAIL = { kind: state.mgrView.kind, key }
    if (PLUGINS_CTX) PLUGINS_CTX.rerender()
  }

  // 应用卡片：动作位是真开关。图标 = 应用自己申报的 `icon`（preview.json → normExtCards → APP_CATALOG，
  // 见 ext-decl.js）；不按 id 上色块、不取标题首字（2026-10-17 用户定案：模型/神经/本地媒体资源库各用自己的 icon）。
  function appItem(a) {
    const on = isAppEnabled(a.id)
    return {
      key: a.id,
      name: a.title,
      desc: a.path,
      icon: I[a.icon] || '',
      action: { on, key: a.id, title: on ? '已启用（点击停用）' : '未启用（点击启用）' },
    }
  }

  // 插件/技能行：{n 名称, d 描述, v 版本, inst 是否已安装, k 目录名, en 启用态}。
  // 个人（本地已安装）行 = 真开关（key 存在 → MgrUI 走 onAction）；公开市场行无 k，仍是纯状态指示。
  function pluginItem(x) {
    const toggleable = !!x.k
    const on = toggleable ? x.en !== 0 : !!x.inst
    return {
      key: x.n,
      name: x.n,
      desc: x.d || '暂无描述',
      action: toggleable
        ? { on, key: x.n, title: on ? '已启用（点击停用）' : '已停用（点击启用）' }
        : { on, title: x.inst ? '已安装' : '未安装' },
    }
  }

  // 行内动作分发：应用 → 应用启停；插件/技能个人行 → 目录标记启停；其余（公开市场）无动作。
  function onRowAction(key) {
    const v = state.mgrView
    if (v.kind === 'apps') { toggleApp(key); return }
    toggleCustomization(v.kind, key)
  }

  // 按名称找可启停的个人行：先查当前 cat，再兜底遍历该 kind 的全部 cat。
  // 搜索/切 cat 与网格重渲之间可能短暂错位，找不到就明说（不静默 return——静默会让点击看起来毫无反应）。
  function findTogglableRow(kind, key) {
    const groups = (MGR && MGR[kind]) || {}
    const v = state.mgrView
    const order = [v.cat, ...Object.keys(groups).filter((c) => c !== v.cat)]
    for (const cat of order) {
      const arr = groups[cat]
      if (!Array.isArray(arr)) continue
      const hit = arr.find((r) => r.n === key && r.k)
      if (hit) return hit
    }
    return null
  }

  // 插件/技能启停：状态 = 目录内 .disabled 标记（后端 POST /gateway/plugins/enable 落/删）。
  // 先乐观改本地 en 即时反馈，失败回滚并 toast。开关只影响「暴露给 agent」——
  // 停用后不再进命令/技能/agents/hooks/MCP 集，下一条消息即生效（CLI 侧监听标记热刷）。
  async function toggleCustomization(kind, key) {
    const x = findTogglableRow(kind, key)
    if (!x) { toast('未找到该条目（请刷新页面后重试）'); return }
    const next = x.en === 0
    // 同一个安装目录同时出现在「公开」（已安装）与「个人」两份清单里，两份都要同步，
    // 否则切完回个人页看到的还是旧状态。
    const setEn = (val) => {
      const groups = (MGR && MGR[kind]) || {}
      for (const cat of Object.keys(groups)) {
        const arr = groups[cat]
        if (!Array.isArray(arr)) continue
        for (const r of arr) if (r.k === x.k) r.en = val
      }
    }
    setEn(next ? 1 : 0)
    if (MGR_DETAIL) { if (PLUGINS_CTX) PLUGINS_CTX.rerender() } else renderMgrGrid()
    try {
      const res = await fetch(apiUrl('/gateway/plugins/enable'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, name: x.k, enabled: next }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'HTTP ' + res.status)
      }
    } catch (err) {
      setEn(next ? 0 : 1)
      if (MGR_DETAIL) { if (PLUGINS_CTX) PLUGINS_CTX.rerender() } else renderMgrGrid()
      toast('切换失败：' + (err && err.message ? err.message : String(err)))
    }
  }

  // 应用启停：落盘归网关（卡目录 .disabled），回来后按服务端真值重渲；失败 toast、按钮保持原态。
  // 侧栏 tab 由 setAppEnabled 内的目录刷新重建；详情页内切换则整页重渲。
  function toggleApp(key) {
    if (!key) return
    setAppEnabled(key, !isAppEnabled(key))
      .then(() => {
        if (MGR_DETAIL) { if (PLUGINS_CTX) PLUGINS_CTX.rerender(); return }
        renderMgrGrid()
      })
      .catch((e) => toast('切换失败：' + ((e && e.message) || String(e))))
  }

  // ---------- 详情页（卡内子页；返回 = 清 MGR_DETAIL 重渲） ----------
  function detailItem() {
    if (!MGR_DETAIL) return null
    const { kind, key } = MGR_DETAIL
    if (kind === 'apps') {
      const a = appCatalog().find((x) => x.id === key)
      if (!a) return null
      return {
        kind, key, ico: I[a.icon] || '', color: MgrUI.color(a.id), initial: (a.title[0] || '?').toUpperCase(),
        name: a.title, desc: '', ver: '', inst: isAppEnabled(a.id),
        typeLabel: '应用', sourceLabel: '工作区根 .claude/preview 申报',
        path: a.path, appId: a.id, installedLabel: isAppEnabled(a.id) ? '已启用' : '未启用',
        repo: a.repo || '',
      }
    }
    const v = state.mgrView
    const src = (MGR && MGR[kind] && MGR[v.cat]) || []
    const x = src.find((r) => r.n === key)
    if (!x) return null
    const isSkill = kind === 'skills'
    const personal = v.cat === 'personal'
    // 个人行带 k（目录名）= 可启停；状态语义从「已安装」换成「已启用/已停用」。
    const toggleable = !!x.k
    const enabled = toggleable ? x.en !== 0 : !!x.inst
    return {
      kind, key, ico: '', color: MgrUI.color(x.n), initial: (x.n[0] || '?').toUpperCase(),
      name: x.n, desc: x.d || '', ver: x.v || '', inst: enabled, toggleable,
      typeLabel: isSkill ? '技能' : '插件',
      sourceLabel: personal ? '本地已安装' : '公开市场',
      path: personal ? `.claude/${isSkill ? 'skills' : 'plugins'}/${x.k || x.n}` : '',
      installedLabel: toggleable ? (enabled ? '已启用' : '已停用') : (x.inst ? '已安装' : '未安装'),
    }
  }

  function renderMgrDetail(body, ctx) {
    const it = detailItem()
    if (!it) { MGR_DETAIL = null; return renderMgrPlugins(body, ctx) }
    const info = [
      ['类型', it.typeLabel],
      ['来源', it.sourceLabel],
      ['版本', it.ver || '—'],
      ['状态', it.installedLabel],
    ]
    if (it.path) info.push(['位置', it.path])
    // 详情头动作位：应用 = 真开关（key = appId）；个人插件/技能 = 真开关（key = 名称）；
    // 公开市场条目 = 纯状态指示（无 key，不可点）。
    const action = it.appId
      ? { on: it.inst, key: it.appId, title: it.inst ? '已启用（点击停用）' : '未启用（点击启用）' }
      : it.toggleable
        ? { on: it.inst, key: it.name, title: it.inst ? '已启用（点击停用）' : '已停用（点击启用）' }
        : { on: it.inst, title: it.installedLabel }
    MgrUI.detail(body, {
      typeLabel: it.typeLabel,
      name: it.name,
      sub: `${it.typeLabel} · ${it.sourceLabel}`,
      icon: it.ico,
      color: it.color,
      initial: it.initial,
      action,
      desc: it.desc,
      info,
      extraHtml: repoRowHtml(it),
      onBack() { MGR_DETAIL = null; ctx.rerender() },
      onAction(key) { if (it.appId) toggleApp(key); else toggleCustomization(it.kind, key) },
      onMounted(host) { bindRepoEdit(host, it, ctx) },
    })
  }

  // 上游仓库（仅应用）：值可编辑，写回工作区根 .claude/preview/preview.json 的 cards[].repo。
  // 展示为链接只认 http(s)——用户输入的串不得直接进 href（javascript: 等）。业务行 HTML 由本卡负责。
  function repoRowHtml(it) {
    if (!it.appId) return ''
    const safeRepo = /^https?:\/\/[^\s]+$/i.test(it.repo || '') ? it.repo : ''
    return '<div class="mgr-dl-kvrow mgr-repo-row"><dt>上游仓库</dt><dd class="mgr-repo-dd">' +
      (it.repo
        ? (safeRepo
          ? `<a class="mgr-repo-link" href="${esc(safeRepo)}" target="_blank" rel="noopener">${esc(it.repo)}</a>`
          : `<span class="mgr-repo-plain">${esc(it.repo)}</span>`)
        : '<span class="mgr-repo-empty">未填写</span>') +
      `<button class="mgr-repo-edit" type="button">${it.repo ? '修改' : '填写'}</button></dd></div>`
  }

  // 上游仓库编辑：点「填写/修改」就地换输入框；保存 = 读 preview.json（带 ETag 基线）→ 改该卡 repo →
  // /gateway/file/write 写回。冲突（409）不静默覆盖，提示后重渲（用户重新编辑即拿到新基线）。
  function bindRepoEdit(body, it, ctx) {
    const btn = body.querySelector('.mgr-repo-edit')
    if (!btn) return
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const dd = btn.closest('.mgr-repo-dd')
      if (!dd || dd.querySelector('.mgr-repo-in')) return
      dd.innerHTML =
        `<input class="mgr-repo-in" type="text" value="${esc(it.repo || '')}" placeholder="https://github.com/owner/repo" spellcheck="false">` +
        '<button class="mgr-repo-save" type="button">保存</button>' +
        '<button class="mgr-repo-cancel" type="button">取消</button>'
      const inp = dd.querySelector('.mgr-repo-in')
      inp.focus()
      inp.select()
      dd.querySelector('.mgr-repo-cancel').addEventListener('click', () => ctx.rerender())
      const save = async () => {
        const val = inp.value.trim()
        if (val && !/^https?:\/\/[^\s]+$/i.test(val)) { toast('仓库地址需以 http(s):// 开头'); return }
        try {
          await saveAppRepo(it.appId, val)
          // 顺序不可换：syncGlobalPlugins 会先用缓存快照整份替换 APP_CATALOG（旧值），
          // 故本地写入必须落在这之后、重渲之前；网络回包会再整份覆盖为真值（含新 repo）。
          syncGlobalPlugins()
          const a = appCatalog().find((x) => x.id === it.appId)
          if (a) a.repo = val
          toast(val ? '已保存上游仓库' : '已清除上游仓库')
          ctx.rerender()
        } catch (err) {
          toast('保存失败：' + (err && err.message ? err.message : String(err)))
        }
      }
      dd.querySelector('.mgr-repo-save').addEventListener('click', save)
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); save() }
        else if (ev.key === 'Escape') { ev.preventDefault(); ctx.rerender() }
      })
    })
  }

  async function saveAppRepo(id, repo) {
    const label = globalLabel()
    const path = '.claude/preview/preview.json'
    const res = await fetch(apiUrl('/gateway/file?label=' + encodeURIComponent(label) + '&path=' + encodeURIComponent(path)))
    if (!res.ok) throw new Error('读取 preview.json 失败（HTTP ' + res.status + '）')
    const baseMtime = Number(String(res.headers.get('ETag') || '').replace(/"/g, '')) || undefined
    let json
    try { json = JSON.parse(await res.text()) } catch { throw new Error('preview.json 不是合法 JSON') }
    const cards = Array.isArray(json && json.cards) ? json.cards : []
    const card = cards.find((c) => c && typeof c === 'object' && c.id === id)
    if (!card) throw new Error('preview.json 里没有该应用')
    if (repo) card.repo = repo
    else delete card.repo
    const w = await fetch(apiUrl('/gateway/file/write'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, path, content: JSON.stringify(json, null, 2) + '\n', baseMtime }),
    })
    if (!w.ok) {
      const d = await w.json().catch(() => ({}))
      throw new Error(w.status === 409 ? '文件已被他人修改，请重试' : (d.error || 'HTTP ' + w.status))
    }
  }

  // ---------- 会话卡 ----------
  const sessionCardDef = {
    id: 'session', title: '会话', tip: '会话', icon: 'logo', tab: false,
    card: () => sessionCard,
    deactivate: teardownSessionView,
  }
  registerCard(sessionCardDef)

  // ---------- 整卡显隐中枢接线（2026-10-13 card:* 保留动词）----------
  // 执行口 = 既有路由链（navigate → route，与用户点侧栏完全同链）：open = '#preview/<label>'
  // （route 内含 sbMode 强制回 chat、state.preview、openProjectPreview(true) 全套）；close = 回主页
  // （renderHome 清槽）。work 模式的卡片显隐不经此口（work 面板归 sidebar 域），显式报错不静默。
  cardBus.setSlotHost({
    open: (label) => { navigate('#preview/' + encodeURIComponent(label)) },
    close: () => {
      if (state.sbMode === 'work') throw new Error('work 模式的卡片显隐不经宿主槽位口')
      navigate('#/')
    },
  })
  // 项目预览申报表同步（外部卡 卡片化二期 + 浮窗动作 2026-09-28）：两表同属「当前 .preview-frame
  // 所指项目」——与 clearRailExt 同点调用（iframe 换 src / 新文档重挂）。网关侧已按同一份规则校过
  // preview.json，registerExtCards / registerQuoteActions 再校一遍（postMessage 那条不过网关，
  // 两条外部输入共用 engine/ext-decl.js 的同一份过滤器）。**一次请求取两份申报，不新增请求**。
  // seq 守卫：只有最后一次 sync 的响应可以落表（快速连点两个项目时先发的响应可能后到）。
  let extCardsSeq = 0
  // ---------- 预览工作区卡片（2026-10-18）----------
  // 一张卡 = <项目>/.claude/preview/<id>/ 一个目录（元信息 card.json，网关扫描后随同一份
  // /gateway/preview-cards 响应下发 previewCards）。表属于「当前项目」：label 不同即空表，
  // 不沿用上一项目的卡（与 EXT 同一条生命周期不变量）。宿主 tab 条与 iframe 加载都读本表。
  let pvCards = []
  let pvCardsLabel = ''
  let pvCardsReady = false
  let pvHasIndex = false
  let pvIndexEnabled = false
  // 传统单页预览的管理页保留 id：与网关 POST /gateway/preview-cards/enable 的保留键一致
  const PREVIEW_INDEX_CARD_ID = '__index__'
  let pvCardsInflight = null
  let pvCardsInflightLabel = ''
  let pvCardPayloads = [] // [{ label, card, payload }]：卡→卡跳转的交接数据，目标帧 load 时消费一次

  function normPreviewCards(raw) {
    const seen = new Set()
    return (Array.isArray(raw) ? raw : [])
      .filter((c) => c && typeof c === 'object' && !Array.isArray(c))
      .map((c) => ({
        id: typeof c.id === 'string' ? c.id.trim() : '',
        title: typeof c.title === 'string' ? c.title.trim() : '',
        icon: typeof c.icon === 'string' && c.icon ? c.icon : 'plug',
        entry: typeof c.entry === 'string' && c.entry ? c.entry.trim() : 'index.html',
        order: typeof c.order === 'number' && Number.isFinite(c.order) ? c.order : 100,
        default: c.default === true,
        // 启用态 = 卡目录内无 .disabled（网关判定）；停用卡不进 tab / 不挂载，但留在卡表里供管理页启用。
        enabled: c.enabled !== false,
        // 卡级后端声明（网关下发布尔 + 显示名，不下发 cmd/cwd）：有后端卡 /gateway/backend 带 card 拉起。
        hasBackend: c.backend === true,
        backendName: typeof c.backendName === 'string' ? c.backendName : '',
      }))
      .filter((c) => {
        if (!/^[a-zA-Z0-9_-]{1,32}$/.test(c.id) || !c.title || seen.has(c.id)) return false
        seen.add(c.id)
        return true
      })
  }
  function registerPreviewCards(label, cards, hasIndex, indexEnabled) {
    if (!label) return
    pvCards = normPreviewCards(cards)
    pvCardsLabel = label
    pvHasIndex = hasIndex === true
    pvIndexEnabled = pvHasIndex && indexEnabled !== false
    pvCardsReady = true
  }
  // 当前项目的卡表（异 label = 空表，防串项目）。调用方按需 clone，不写回本表。
  function previewCardsFor(label) {
    return label && pvCardsLabel === label ? pvCards : []
  }
  // 已启用的卡（tab 条 / 卡选择 / 切换的唯一数据源）：停用卡只在管理页出现。
  function enabledPreviewCardsFor(label) {
    return previewCardsFor(label).filter((c) => c.enabled)
  }
  // 传统单页预览 .claude/preview/index.html 是否可视（存在且未被停用；与「有已启用卡」并列判可预览）
  function previewHasIndexPage(label) {
    return !!label && pvCardsLabel === label && pvHasIndex && pvIndexEnabled
  }
  // 传统单页预览的管理页条目（保留 id，启停走同一端点）。无该页 → null。
  function previewLegacyIndexCard(label) {
    if (!label || pvCardsLabel !== label || !pvHasIndex) return null
    return {
      id: PREVIEW_INDEX_CARD_ID,
      title: '预览页',
      icon: 'dshFile',
      entry: 'index.html',
      order: -1,
      default: false,
      enabled: pvIndexEnabled,
      hasBackend: false,
      backendName: '',
    }
  }
  function previewCardsReadyFor(label) {
    return !!label && pvCardsLabel === label && pvCardsReady
  }
  function previewPaneCardDef(label, id) {
    return previewCardsFor(label).find((c) => c.id === id) || null
  }
  // 归一化激活卡：命中现有表则原样；否则回落 default（无 default 取排序首张）；无卡表 = ''。
  function previewCardNormId(label, id) {
    const list = enabledPreviewCardsFor(label)
    if (!list.length) return ''
    if (id && list.some((c) => c.id === id)) return id
    const d = list.find((c) => c.default) || list[0]
    return d.id
  }
  // 卡表就绪才返回；未就绪先取一次申报。in-flight 按 label 去重（work 首渲与 mount 同时问只发一次）。
  function ensurePreviewDecls(label, force) {
    if (!label) return Promise.resolve([])
    if (!force && previewCardsReadyFor(label)) return Promise.resolve(previewCardsFor(label))
    if (pvCardsInflight && pvCardsInflightLabel === label) return pvCardsInflight
    const p = syncExtCards(label).then(() => (previewCardsReadyFor(label) ? previewCardsFor(label) : []))
    pvCardsInflight = p
    pvCardsInflightLabel = label
    p.finally(() => {
      if (pvCardsInflight === p) { pvCardsInflight = null; pvCardsInflightLabel = '' }
    })
    return p
  }
  // 卡→卡跳转的交接数据：源卡 postMessage 带 payload 时由宿主暂存，目标帧 load 后随 init 下发一次。
  function setPendingCardPayload(label, card, payload) {
    pvCardPayloads = pvCardPayloads.filter((p) => !(p.label === label && p.card === card))
    pvCardPayloads.push({ label, card, payload })
  }
  function takePendingCardPayload(label, card) {
    const i = pvCardPayloads.findIndex((p) => p.label === label && p.card === card)
    if (i < 0) return null
    const v = pvCardPayloads[i].payload
    pvCardPayloads.splice(i, 1)
    return v
  }
  // 卡页入口 URL 片段（卡目录内 entry，逐段编码；entry 已由网关/前端校验为安全相对路径）
  function cardEntryPath(card) {
    return card.entry.split('/').map(encodeURIComponent).join('/')
  }

  // ---------- 卡池（2026-10-26 用户实报「PDF 卡 / 日志卡切换卡顿」根修）----------
  // 旧行为 = 换卡就换 iframe 的 src ⇒ 整页重载（pdf.js 重新初始化、日志重新拉取），每次切换都在等启动。
  // 新行为 = **同一容器里每张卡一枚 iframe，首次进入才创建，之后切换只切显隐**：页面状态（页码 / 滚动 /
  // 展开项）原样保留，切换瞬时完成。池按卡 id 存在 .preview-body 上（body 随容器重建即整池作废）。
  // 隐藏帧：留在文档里继续接收广播（事实类，如 file-open），但**不可被指令寻址**（cardBus.setFrameActive），
  // 否则同 label 多帧会判「目标卡不唯一」。
  function pvPool(body) {
    if (!body.__pvFrames) body.__pvFrames = new Map()
    return body.__pvFrames
  }
  // 当前显示的那枚预览帧（唯一取处）：池化后 .preview-frame 可能有多枚，一律按显隐取。
  function activePreviewFrame(root) {
    const scope = root || document
    for (const el of scope.querySelectorAll('.preview-frame')) if (!el.hidden) return el
    return null
  }
  // 激活帧变更回调（唯一处）：池内切显隐后宿主据此恢复「该帧自己申报过的」帧工具 / 侧栏按钮 /
  // 卡→卡交接数据——帧没换文档 ⇒ load 不会再触发，这些只能在切显隐这一刻补。
  let pvActiveHook = null
  function setPreviewActiveHook(fn) {
    pvActiveHook = typeof fn === 'function' ? fn : null
  }
  // 池内切显隐（唯一写口）：目标帧亮、其余帧隐，并同步 cardBus 激活态。
  function pvShow(container, key) {
    const body = container.querySelector('.preview-body')
    if (!body) return
    for (const [k, rec] of pvPool(body)) {
      const on = k === key
      rec.el.hidden = !on
      if (rec.overlay && rec.overlay.isConnected) rec.overlay.hidden = !on
      if (rec.el.__cardKey) cardBus.setFrameActive(rec.el.__cardKey, on)
    }
    const rec = pvPool(body).get(key)
    if (rec && pvActiveHook) pvActiveHook(container, rec.el, key)
  }
  // 拆池：换项目 / 容器离场时逐帧注销并清 DOM（旧项目的所有卡一并作废）。
  function pvClear(container) {
    const body = container.querySelector('.preview-body')
    const pool = body ? pvPool(body) : null
    if (pool) {
      for (const rec of pool.values()) {
        if (rec.el && rec.el.__cardKey) cardBus.unregisterFrame(rec.el.__cardKey)
      }
      pool.clear()
    }
    container.innerHTML = ''
  }

  function syncExtCards(label) {
    const seq = ++extCardsSeq
    clearExtCards()
    clearQuoteActions()
    return fetch(`/gateway/preview-cards?label=${encodeURIComponent(label)}${gToken ? '&token=' + encodeURIComponent(gToken) : ''}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((d) => {
        if (seq !== extCardsSeq) return
        registerExtCards(label, d && d.cards, true)
        registerQuoteActions(label, d && d.quoteActions)
        registerPreviewCards(label, d && d.previewCards, d && d.hasIndex, d && d.indexEnabled)
      })
      .catch(() => {
        // 清单拿不到 = 该项目无外部卡/无浮窗动作/无预览卡（空表是正常态，不猜不兜底）
        if (seq === extCardsSeq) registerPreviewCards(label, [], false, false)
      })
  }

  // 项目预览：主聊天区渲染 iframe，替换管理/会话界面；退出预览走侧栏导航（route 统一清心跳）。
  // 预览页加载两级策略（2026-08-19 Web 容器；2026-10-18 删除宿主内置默认页）：
  //  ① preview.json 声明 backend → 网关 /gateway/backend 懒加载 spawn 后端进程，iframe 直连 http://127.0.0.1:<port>/
  //     （并 60s 心跳刷新网关侧 lastActive，防空闲回收误杀）；
  //  ② 有 .claude/preview/ 静态页（hasPreview=true）→ 加载卡目录页；都没有 → 空态占位（不提供的项目不造页）。
  // 项目后端预热：右栏「工具栏」一打开就拉起该项目 backend，免去「点了第一个卡 tab 才开始 spawn」的等待。
  // 与 mountPreview 的 ① 分支同一请求（/gateway/backend 是唯一 spawn 口，未声明 backend 的项目 404 静默）；
  // ensureBackend 自带存活复用与 in-flight 去重，重复调用不会产生第二个进程。
  function warmProjectBackend(label, cardId) {
    if (!label) return
    const q = cardId ? `&card=${encodeURIComponent(cardId)}` : ''
    fetch(`/gateway/backend?label=${encodeURIComponent(label)}${q}${gToken ? '&token=' + encodeURIComponent(gToken) : ''}`)
      .catch(() => {})
  }

  function openProjectPreview(label, hasPreview) {
    // 硬进入（异 label / 帧不在场；软重入不清不重建 shell，见 mountPreview 两级重入说明）：先卸会话视图
    // 再占预览槽——deactivateCard('session') 即 registry 契约出口，给到会话卡自身的 teardown 钩子
    // （停实时计时 + 拆 stage 占位 + 清全局槽 + 复位 currentHash）。本卡不再懂 chat 清理清单。
    const body0 = viewBody('preview')
    if (state.preview !== label || !body0 || !body0.querySelector('.preview-frame')) {
      deactivateCard('session')
      state.preview = label
    }
    openCard('preview', { label, hasPreview })
  }

  // 预览渲染器（两级链的唯一一份实现：后端容器 → 静态 preview）。两个消费方——
  // 槽位预览卡（openProjectPreview，独占主区）与 work 个性化工作区第三栏（sidebar/work.js），
  // 到 iframe 这一层没有第二套代码。
  // 2026-09-04 重挂根修：WS 重连 onopen→hideGate 恢复链（state.preview → route）会重挂 iframe，
  // src 恒回站点根——iPad 后台杀 WS 后回到前台必触发，用户被弹回 Pj15 等站点开始页。
  // 2026-09-17 软重入根治（「打开项目界面有概率跳回 chat」二轮）：旧幂等守卫要求 previewMounted===label，
  // 而无真源时曾记 null → 每次断连重连/门解锁都整区重写 shell + iframe 重载；iOS 上 iframe
  // 二次导航会污染主历史并诱发自发后退，落到 /session/<hash> 即被弹回会话 chat。故两级重入：同 label 且
  // iframe 在场（data-label 锚定）= 软重入——不重写 shell，三级链照跑但 mount 按 iframe 现有 src 校正
  // （同 src 零操作 = 零导航扰动；异 src 只换 src 纠正，覆盖 backend 就绪升级/default 换真源）；
  // 异 label 或 iframe 不在场 = 硬挂载。
  function mountPreview(container, label, hasPreview, cardId) {
    if (!container) return
    // 换项目 = 换源：上一份的帧留不得（软重入 / 卡池只对同 label 成立）
    const prevLabel = container.__pvLabel || ''
    const hard = prevLabel !== label
    // 卡片清单必须就位才能决定 URL（有卡 = 卡目录页，无卡 = 传统 index.html）。
    // 清单未就绪先拉一次申报再重入；ensure 自带 in-flight 去重，这里只防同一容器并行重入。
    if (!previewCardsReadyFor(label)) {
      if (container.__pvWaitLabel === label) return
      container.__pvWaitLabel = label
      ensurePreviewDecls(label, hard).then(() => {
        if (container.__pvWaitLabel === label) container.__pvWaitLabel = ''
        if (container.isConnected) mountPreview(container, label, hasPreview, cardId)
      })
      return
    }
    container.__pvWaitLabel = ''
    // 卡选择只在**已启用**卡里做：停用卡不挂载（点它的 tab 也已在渲染层消失）。
    const list = enabledPreviewCardsFor(label)
    const card = list.length ? (list.find((c) => c.id === cardId) || list.find((c) => c.default) || list[0]) : null
    const cardActual = card ? card.id : ''
    if (hard && prevLabel) {
      // 换项目 = 上一项目的整池帧彻底拆除：逐帧当场注销（不等 isConnected 失格）
      pvClear(container)
    }
    container.__pvLabel = label
    // 预览 iframe 挂在 .preview-body 里（该层由下面的 shell 建立，软重入时原样保留）
    if (!container.querySelector('.preview-body')) {
      container.innerHTML =
        '<div class="preview-shell">' +
        '<div class="preview-body"><div class="preview-loading">正在加载…</div></div>' +
        '</div>'
    }
    // 无后端、无 .claude/preview 静态页 = 该项目没有可视预览：空态占位（宿主不再内置默认页）。
    const mountEmpty = () => {
      if (!container.isConnected) return
      const body = container.querySelector('.preview-body')
      if (!body) return
      clearRailExt() // 旧文档注册的侧栏快捷按钮随文档失效
      pvClear(container) // 池内旧帧一并作废（空态下没有卡可切，留着只会切到已离场的元素）
      container.innerHTML =
        '<div class="preview-shell"><div class="preview-body"><div class="preview-empty">该项目暂无预览</div></div></div>'
      state.previewMounted = label
    }
    const mount = (src, name, already) => {
      // 异步回程守卫：三级链是异步的，回来时容器可能已离场（槽位换卡 / work 关掉预览栏）
      if (!container.isConnected) return
      const body = container.querySelector('.preview-body')
      if (!body) return
      const key = cardActual || ''
      const cur = pvPool(body).get(key)
      if (cur) {
        // 池内已有这张卡：只切显隐，**不重载**（页码/滚动/展开项原样保留 = 切换瞬时）。
        // 异 src（后端直连 → 代理 / 就绪升级）才换 src 纠正，那是真换文档。
        if (cur.el.getAttribute('src') !== src) {
          // 真换文档：旧文档的申报与总线状态一并作废（缓存清空 + loaded 复位，
          // 交接数据必须等新文档 load 再发），否则切显隐那刻会把上一份文档的工具表恢复出来。
          clearRailExt()
          cur.el.__railItems = []
          cur.el.__wkTools = []
          cur.el.__pvLoaded = false
          cur.el.setAttribute('src', src)
          cardBus.registerFrame({ kind: 'preview', label, el: cur.el }) // 同 el 复用 key，重置 ns/ready/cmds
        }
        cur.el.dataset.card = cardActual
        state.previewMounted = label
        pvShow(container, key)
        return
      }
      // 覆盖层遮住后端前端加载时的深色初始化画面（2026-08-20 三轮反馈后定稿 v81）：
      // ① 纯遮罩无指令/按钮（用户「弹出的指令框」= 带指令文字的提示层，已去指令）；
      // ② 文案由 backend name 驱动（可插拔：preview.json backend.name，缺省「项目服务」）；
      // ③ backend 容器 load 后缓冲自动淡出 —— 用户「不点击界面就永远卡转圈，但其实早就启动好了」：
      //    后端已就绪（/gateway/backend 命中）才挂 iframe，load 后 object_info（如 ComfyUI 855 节点）拉取渲染
      //    还需数秒，缓冲 8s 自动淡出（不再永远卡转圈），点击仍可提前关闭（focus iframe 移交内部焦点）。
      // ④ 2026-08-28 生命周期解耦：already=后端进程已在跑（复用/收养）→ 不渲染覆盖层，iframe 直挂秒开
      //    （后端常驻后刷新/重进预览不再见「正在启动」，仅冷启动时显示）。
      clearRailExt() // 新文档重挂 → 清上一份预览页注册的侧栏快捷按钮（不变量见 sidebar/rail-ext.js）
      const loading = body.querySelector('.preview-loading')
      if (loading) loading.remove()
      const frame = document.createElement('iframe')
      frame.className = 'preview-frame'
      frame.title = `${label} 项目主页`
      frame.dataset.label = label
      frame.dataset.card = cardActual
      frame.src = src
      body.appendChild(frame)
      let overlay = null
      if (!already) {
        overlay = document.createElement('div')
        overlay.className = 'preview-overlay'
        overlay.innerHTML =
          '<div class="preview-overlay-spin"></div>' +
          `<div class="preview-overlay-title">正在启动 ${esc(name || '项目服务')}…</div>` +
          '<div class="preview-overlay-sub">首次启动需等待后端就绪，加载完成后将自动进入</div>'
        body.appendChild(overlay)
      }
      pvPool(body).set(key, { el: frame, overlay })
      state.previewMounted = label
      // 挂进卡片总线：预览页（如 Pj18 的 floria-pv）说 `<ns>-cmd`/`<ns>-event` 即被总线认领
      cardBus.registerFrame({ kind: 'preview', label, el: frame })
      pvShow(container, key)
      let autoDismiss = null
      const dismiss = () => {
        if (autoDismiss) { clearTimeout(autoDismiss); autoDismiss = null }
        if (overlay) { overlay.classList.add('done'); setTimeout(() => overlay.remove(), 400) }
      }
      frame.addEventListener('load', () => {
        frame.__pvLoaded = true
        frame.focus()
        // 卡片身份 + 交接数据（卡→卡跳转）：以 dataset 为准（换 src 时闭包里的 card 已过期）。
        // 无卡（传统单页预览）不发，旧页不受影响。
        const liveCard = frame.dataset.card || ''
        if (liveCard) {
          const payload = takePendingCardPayload(label, liveCard)
          try { frame.contentWindow.postMessage({ type: 'floria-wk-card-init', card: liveCard, payload }, '*') } catch { /* 帧已销毁：丢弃 */ }
        }
        if (!overlay) return
        // backend 容器（传了 name）：object_info 拉取渲染需数秒，缓冲后自动淡出；
        // 静态 preview / 默认主页（无 name）：无后端 loading，立即淡出不挡内容
        if (name) autoDismiss = setTimeout(dismiss, 8000)
        else dismiss()
      })
      // 点击关闭（可提前进入）：focus iframe + 移除覆盖层；首次点击把键盘焦点交给 iframe 内部
      if (overlay) overlay.addEventListener('click', () => { frame.focus(); dismiss() })
    }
    // ① Web 容器：backend 优先（/gateway/* 受网关 token 校验）。
    // 卡自己声明了 backend ⇒ 带 card 拉起该卡专属后端；无卡级声明 ⇒ 走项目级 backend（旧链），
    // 项目也没声明则 404 → 静态 preview。
    const cardQ = card && card.hasBackend ? `&card=${encodeURIComponent(card.id)}` : ''
    fetch(`/gateway/backend?label=${encodeURIComponent(label)}${cardQ}${gToken ? '&token=' + encodeURIComponent(gToken) : ''}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((d) => {
        if (!(d && d.url)) throw new Error('no-backend')
        // 2026-08-27 远程端分流：127.0.0.1 直连仅在本机浏览器成立，手机等远程宿主一律改走
        // 网关同源代理 /backend/<label>/（访问票由上一拍 /gateway/backend 响应种下的 HttpOnly cookie 提供）
        const remotePage =
          location.protocol.startsWith('http') && ['127.0.0.1', 'localhost'].indexOf(location.hostname) < 0
        // 卡页 = 卡目录内 entry（默认 index.html）；无卡 = 后端根（传统单页预览）
        const rel = card ? `${encodeURIComponent(card.id)}/${cardEntryPath(card)}` : ''
        mount(remotePage ? `/backend/${encodeURIComponent(label)}/${rel}` : d.url + rel, d.name, !!d.alreadyRunning)
        if (window.__backendHeartbeat) clearInterval(window.__backendHeartbeat)
        window.__backendHeartbeat = setInterval(() => {
          fetch(`/gateway/backend?label=${encodeURIComponent(label)}${cardQ}&token=${encodeURIComponent(gToken || '')}`).catch(() => {})
        }, 60000)
      })
      .catch(() => {
        // ② 静态 preview；项目未申报 preview 目录、或无卡且传统单页被停用 → 空态
        if (!hasPreview || (!card && !previewHasIndexPage(label))) { mountEmpty(); return }
        const previewSrc = card
          ? `/preview/${encodeURIComponent(label)}/${encodeURIComponent(card.id)}/${cardEntryPath(card)}${gToken ? '?token=' + encodeURIComponent(gToken) : ''}`
          : `/preview/${encodeURIComponent(label)}/index.html${gToken ? '?token=' + encodeURIComponent(gToken) : ''}`
        fetch(previewSrc, { method: 'GET' })
          .then((r) => {
            if (!r.ok) throw new Error('HTTP ' + r.status)
            mount(previewSrc)
          })
          .catch(mountEmpty)
      })
  }

  // ---------- 预览页注册的侧栏快捷按钮 · 状态与清点（2026-10-05 自 sidebar/rail-ext.js 迁入）----------
  // 快捷按钮集（floria-rail-register 申报）与外部卡申报同属「当前预览文档」域，故其清点与 EXT 清点
  // 同居本模块；preview-frame 内部（mountPreview 重挂）直接调 clearRailExt（不再横向 import
  // sidebar/rail-ext.js）。桥接与渲染（bindRailExtBridge / renderRailExt）留在 sidebar/rail-ext.js，
  // 经 setRailExtItems 写本表。
  let railExtItems = []
  function setRailExtItems(items) { railExtItems = items }
  function clearRailExt() {
    railExtItems = []
    const box = $('rail-ext')
    if (box) box.innerHTML = ''
  }

  const WK_TOOL_DEFS = []

  function registerWkTool(def) {
    if (!def || typeof def.id !== 'string' || !def.id) return
    const entry = {
      id: def.id,
      title: String(def.title || def.id),
      pane: typeof def.pane === 'string' ? def.pane : '',
      mount: typeof def.mount === 'function' ? def.mount : null,
    }
    const i = WK_TOOL_DEFS.findIndex((t) => t.id === entry.id)
    if (i >= 0) WK_TOOL_DEFS[i] = entry
    else WK_TOOL_DEFS.push(entry)
    renderWkToolTabs()
  }

  // 预览页（iframe）申报的工具 tab（2026-10-07）。与宿主注册 WK_TOOL_DEFS 分离——申报集属于**当前加载
  // 的那份预览文档**，随文档失效（帧换 src / 换项目 / 预览栏拆卸时 clearWkFrameTools，不变量同 rail-ext）。
  // 帧工具**无 pane、无 mount**：它的内容由预览页自管（工具态时宿主保留预览帧在场，只把选中 id 回传帧内，
  // 见 work.js applyPvTab / notifyFrame）。label = 申报时帧锚定的项目，用于换项目即失效。
  const WK_FRAME_TOOLS = []
  let wkFrameToolsLabel = ''

  function registerWkFrameTools(label, tools) {
    wkFrameToolsLabel = label || ''
    WK_FRAME_TOOLS.length = 0
    for (const t of tools) WK_FRAME_TOOLS.push(t)
    renderWkToolTabs()
  }
  function clearWkFrameTools() {
    if (!WK_FRAME_TOOLS.length && !wkFrameToolsLabel) return
    WK_FRAME_TOOLS.length = 0
    wkFrameToolsLabel = ''
    renderWkToolTabs()
  }

  function wkToolDefs() {
    return WK_TOOL_DEFS.concat(WK_FRAME_TOOLS)
  }
  function wkToolDef(id) {
    return WK_TOOL_DEFS.find((t) => t.id === id) || WK_FRAME_TOOLS.find((t) => t.id === id) || null
  }
  // 归一化 tab id：已注册则原样，否则回落首枚（无工具时空串）
  function wkToolNormId(id) {
    if (wkToolDef(id)) return id
    return WK_TOOL_DEFS.length ? WK_TOOL_DEFS[0].id : ''
  }

  // 当前项目有没有可视预览：**已启用**的预览卡（.claude/preview/<id>/card.json）或传统单页
  // .claude/preview/index.html。停用卡不产生预览页签（工具栏胶囊里也不出现、服务器不拉起）。
  // 数据未就绪时（项目列表 / 卡表未到）两项都为假；调用方须用 wkPreviewKnown 区分「已知没有」与「还不知道」。
  function wkPreviewAvailable(label) {
    return !!label && (enabledPreviewCardsFor(label).length > 0 || previewHasIndexPage(label))
  }
  function wkPreviewKnown(label) {
    return !!label && wkProjGroups().length > 0 && previewCardsReadyFor(label)
  }

  // tab 条渲染（唯一口）：预览相关页签只在该项目**确有可视预览**时出现——
  // 有卡 = 每卡一枚（名称取 card.json 的 title，data-wkcard 定址）；无卡但有传统单页 = 单枚「预览」
  // （data-wkpv="" → 回 index.html）；两者皆无 = 不渲染预览页签，只留工具页签（2026-11-02 用户定案）。
  // active 态由 work.js applyPvTab 落（卡 = state.wkPvCard，工具 = state.wkPvTab）。
  // 注：data-wkpv="" 仍被 [data-wkpv] 属性存在选择器命中，故点击委托（work-mount.js）不用改。
  function renderWkToolTabs() {
    const box = $('wk-pv-tabs')
    if (!box) return
    const cards = enabledPreviewCardsFor(state.workProj)
    const head = cards.length
      ? cards.map((c) => `<button type="button" class="wk-pv-tab" data-wkcard="${esc(c.id)}">${esc(c.title)}</button>`).join('')
      : previewHasIndexPage(state.workProj)
        ? '<button type="button" class="wk-pv-tab" data-wkpv="">预览</button>'
        : ''
    const html = head + wkToolDefs().map(
      (t) => `<button type="button" class="wk-pv-tab" data-wkpv="${esc(t.id)}">${esc(t.title)}</button>`,
    ).join('')
    // 本函数会被项目列表落地 / applyPanes / 帧激活反复调用：内容不变不重写 DOM（同 renderWorkBody 口径）。
    if (box.innerHTML !== html) box.innerHTML = html
  }

  // 类名一律 cmt* 前缀：全部模块顶层声明共享一个 IIFE 作用域（见 probe-web-module-scope）。
  let cmtList = []        // 当前项目评论（服务端权威副本）
  let cmtProj = ''        // cmtList 归属项目 label
  let cmtLoaded = false    // cmtList 是否已为 cmtProj 拉取成功
  let cmtLoading = false
  let cmtErr = ''

  // 宿主能力注入（work 侧 / 预处理器侧不反向 import 卡）
  let cmtOpenFile = null
  let cmtEnsurePane = null
  let cmtRefreshMarks = null

  function cmtSetHooks(h) {
    if (!h) return
    if (typeof h.openFile === 'function') cmtOpenFile = h.openFile
    if (typeof h.ensurePane === 'function') cmtEnsurePane = h.ensurePane
    if (typeof h.refreshMarks === 'function') cmtRefreshMarks = h.refreshMarks
  }

  function cmtHookOpenFile(path, id) { if (cmtOpenFile) cmtOpenFile(path, id) }
  function cmtHookEnsurePane() { if (cmtEnsurePane) cmtEnsurePane() }

  // 渲染同步：面板 + 原文标记（work.js 阅读态按 cmtRangesFor 打标的唯一重绘入口）
  function cmtAfterChange() {
    cmtRender()
    if (cmtRefreshMarks) cmtRefreshMarks()
  }

  // 供 work.js 在原文（阅读态）打标记：当前项目内、指定文件的评论行范围（1 基源行号）
  function cmtRangesFor(path) {
    const p = String(path || '').replace(/\\/g, '/')
    if (!p || !cmtProj) return []
    return cmtList
      .filter(
        (c) =>
          c && typeof c === 'object' &&
          String(c.path || '').replace(/\\/g, '/') === p &&
          Number(c.l1) >= 1,
      )
      .map((c) => ({
        id: String(c.id || ''),
        l0: Number(c.l0) || 1,
        l1: Number(c.l1) || Number(c.l0) || 1,
        resolved: !!c.resolved,
      }))
  }

  // 换项目 / 退 work：作废内存副本（下次 cmtLoad 重新拉）
  function cmtInvalidate() {
    cmtList = []
    cmtProj = ''
    cmtLoaded = false
    cmtLoading = false
    cmtErr = ''
    if (cmtRefreshMarks) cmtRefreshMarks() // 换项目：清掉上一项目的原文标记
  }

  function cmtId() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  }
  function cmtFmtTime(iso) {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    const p = (n) => String(n).padStart(2, '0')
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  async function cmtFetch(proj) {
    if (!proj || needToken()) {
      cmtLoading = false
      return
    }
    cmtLoading = true
    cmtErr = ''
    cmtRender()
    try {
      const res = await fetch(apiUrl('/gateway/comments?label=' + encodeURIComponent(proj)))
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '加载失败')
      cmtList = (Array.isArray(data.comments) ? data.comments : []).filter((c) => c && typeof c === 'object' && !Array.isArray(c))
      cmtProj = proj
      cmtLoaded = true
    } catch (e) {
      cmtErr = e.message || String(e)
      cmtLoaded = false
    } finally {
      cmtLoading = false
      cmtAfterChange()
    }
  }

  // 已有当前项目副本就直接用（免重复请求）；换项目才拉
  async function cmtLoad(proj) {
    if (!proj) {
      cmtInvalidate()
      cmtRender()
      return
    }
    if (cmtLoaded && proj === cmtProj) return
    await cmtFetch(proj)
  }

  // 整份回写（唯一写口）：cmtList 当前值 → 服务端。失败 toast 并返回 false（调用方决定是否回滚内存副本）。
  async function cmtSave() {
    const proj = state.workProj
    if (!proj) return false
    try {
      const res = await fetch(apiUrl('/gateway/comments'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: proj, comments: cmtList }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) throw new Error(data.error || '保存失败')
      return true
    } catch (e) {
      toast('评论保存失败：' + (e.message || e))
      return false
    }
  }

  // 内存副本改 → 渲染 → 回写；回写失败回滚（不静默丢改动）
  async function cmtMutate(fn) {
    const prev = cmtList
    fn()
    cmtAfterChange()
    if (!(await cmtSave())) {
      cmtList = prev
      cmtAfterChange()
    }
  }

  // 读口（面板 / 卡 API 只读，不直取可变绑定）
  function cmtState() {
    return {
      list: cmtList,
      proj: cmtProj,
      loading: cmtLoading,
      err: cmtErr,
    }
  }
  function cmtRemove(c) {
    cmtMutate(() => { cmtList = cmtList.filter((x) => x !== c) })
  }
  function cmtToggleResolved(c) {
    cmtMutate(() => { c.resolved = !c.resolved })
  }

  async function cmtAdd(proj, entry) {
    if (!proj) return false
    if (!(cmtLoaded && cmtProj === proj)) await cmtFetch(proj)
    if (cmtProj !== proj) return false
    cmtList.push(entry)
    cmtAfterChange()
    if (!(await cmtSave())) {
      cmtList = cmtList.filter((c) => c !== entry)
      cmtAfterChange()
      return false
    }
    return true
  }

  let cmtPop = null       // 选区「添加评论」浮层

  function cmtClosePop() {
    if (cmtPop) { cmtPop.remove(); cmtPop = null }
  }
  function openCommentComposer(snap) {
    if (!snap || snap.kind !== 'file' || !snap.file) return
    cmtHookEnsurePane() // 落点可见：右栏切到评论 tab（注释提交后立刻在列表里看到）
    cmtClosePop()
    const pop = document.createElement('div')
    pop.className = 'cmt-pop'
    const n0 = Number(snap.l0) || 0
    const n1 = Number(snap.l1) || 0
    const loc = esc(snap.file) + (n0 ? ' · ' + n0 + (n1 && n1 !== n0 ? '-' + n1 : '') + ' 行' : '')
    pop.innerHTML =
      '<div class="cmp-loc">' + loc + '</div>' +
      '<blockquote class="cmp-ex">' + esc(String(snap.text || '').slice(0, 300)) + '</blockquote>' +
      '<textarea class="cmp-in" placeholder="添加评论…" rows="3"></textarea>' +
      '<div class="cmp-bar"><button type="button" class="cmp-cancel">取消</button><button type="button" class="cmp-ok">评论</button></div>'
    document.body.appendChild(pop)
    const r = snap.rect || { left: 0, bottom: 0 }
    const w = pop.offsetWidth
    const h = pop.offsetHeight
    // 越界下限取**可视**视口底（键盘上沿）：innerHeight 是布局视口，键盘在场不缩，按它 clamp 会落进键盘后。
    const vv = window.visualViewport
    const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight
    pop.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - w - 8))) + 'px'
    pop.style.top = Math.round(Math.max(8, Math.min(r.bottom + 6, viewBottom - h - 8))) + 'px'
    const ta = pop.querySelector('.cmp-in')
    ta.focus()
    pop.addEventListener('mousedown', (e) => e.stopPropagation()) // 浮层内按下不算「点外部」
    pop.querySelector('.cmp-cancel').addEventListener('click', cmtClosePop)
    const submit = async () => {
      const body = ta.value.trim()
      if (!body) { ta.focus(); return }
      const entry = {
        id: cmtId(),
        path: snap.file,
        l0: n0,
        l1: n1,
        excerpt: String(snap.text || '').slice(0, 300),
        body,
        author: 'me',
        createdAt: new Date().toISOString(),
        resolved: false,
      }
      cmtClosePop()
      if (await cmtAdd(snap.proj || state.workProj, entry)) toast('已添加评论')
    }
    pop.querySelector('.cmp-ok').addEventListener('click', submit)
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit() }
      else if (e.key === 'Escape') { e.preventDefault(); cmtClosePop() }
    })
    cmtPop = pop
  }

  // 点浮层外 / 滚动 / Esc → 关（fixed 浮层会漂离锚点；与 quote.js 浮窗同策略）。
  // 滚动关闭守护的不变量 = 「锚点漂移」：只有**浮层外**的滚动才让选区滚走、浮层漂离锚点；
  // 浮层内 cmp-in 自己的内容滚动（评论正文超出可见行数后的纵向滚动）不改变锚点关系，
  // 不得关窗——否则输入长评论的瞬间（textarea 内容一滚）浮层即死（capture 监听 window 也收到元素 scroll）。
  document.addEventListener('mousedown', (e) => { if (cmtPop && !cmtPop.contains(e.target)) cmtClosePop() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cmtPop) cmtClosePop() })
  window.addEventListener('scroll', (e) => { if (cmtPop && !cmtPop.contains(e.target)) cmtClosePop() }, { passive: true, capture: true })

  let cmtFilter = 'all'   // 'all' | 'open'（只看未解决）
  let cmtMounted = false

  function cmtCmp(a, b) {
    const pa = String(a.path || '')
    const pb = String(b.path || '')
    if (pa !== pb) return pa < pb ? -1 : 1
    return (Number(a.l0) || 0) - (Number(b.l0) || 0)
  }
  function cmtItemHtml(c) {
    const n0 = Number(c.l0) || 0
    const n1 = Number(c.l1) || 0
    const loc = esc(String(c.path || '')) + (n0 ? ':' + n0 + (n1 && n1 !== n0 ? '-' + n1 : '') : '')
    return '<div class="cmt-item' + (c.resolved ? ' resolved' : '') + '" data-cid="' + esc(String(c.id || '')) + '">' +
      '<div class="cmt-head">' +
        '<button type="button" class="cmt-loc" data-cmtloc="' + esc(String(c.path || '')) + '">' + loc + '</button>' +
        '<span class="cmt-time">' + esc(cmtFmtTime(c.createdAt)) + '</span>' +
      '</div>' +
      (c.excerpt ? '<blockquote class="cmt-ex">' + esc(String(c.excerpt)) + '</blockquote>' : '') +
      '<div class="cmt-text">' + esc(String(c.body || '')) + '</div>' +
      '<div class="cmt-acts">' +
        '<button type="button" data-cmtact="resolve">' + (c.resolved ? '重开' : '解决') + '</button>' +
        '<button type="button" class="danger" data-cmtact="del">删除</button>' +
      '</div>' +
    '</div>'
  }
  function cmtRender() {
    const el = $('wk-cmt')
    if (!el) return
    if (!state.workProj) {
      el.innerHTML = '<div class="cmt-empty">未选择项目</div>'
      return
    }
    const { list: all, loading, err } = cmtState()
    if (loading) {
      el.innerHTML = '<div class="cmt-empty">加载中…</div>'
      return
    }
    if (err) {
      el.innerHTML = '<div class="cmt-empty">' + esc(err) + '</div>'
      return
    }
    const open = all.filter((c) => !c.resolved).length
    const head =
      '<div class="cmt-filters">' +
        '<button type="button" class="cmt-f' + (cmtFilter === 'all' ? ' on' : '') + '" data-cmtf="all">全部 ' + all.length + '</button>' +
        '<button type="button" class="cmt-f' + (cmtFilter === 'open' ? ' on' : '') + '" data-cmtf="open">未解决 ' + open + '</button>' +
      '</div>'
    const list = (cmtFilter === 'open' ? all.filter((c) => !c.resolved) : all).slice().sort(cmtCmp)
    const body = list.length
      ? list.map(cmtItemHtml).join('')
      : '<div class="cmt-empty">' + (all.length ? '没有未解决的评论' : '还没有评论。在文件里选中内容后添加。') + '</div>'
    el.innerHTML = head + '<div class="cmt-list">' + body + '</div>'
  }

  // 面板事件委托（一次）：容器 innerHTML 整体重渲，逐条绑定会被抹掉
  function cmtMount() {
    const el = $('wk-cmt')
    if (!el || cmtMounted) return
    cmtMounted = true
    el.addEventListener('click', (e) => {
      const f = e.target.closest('[data-cmtf]')
      if (f) {
        cmtFilter = f.dataset.cmtf === 'open' ? 'open' : 'all'
        cmtRender()
        return
      }
      const loc = e.target.closest('[data-cmtloc]')
      if (loc) {
        const item = loc.closest('[data-cid]')
        cmtHookOpenFile(loc.dataset.cmtloc, item ? item.dataset.cid : '')
        return
      }
      const act = e.target.closest('[data-cmtact]')
      const item = act && act.closest('[data-cid]')
      if (!item) return
      const c = cmtState().list.find((x) => String(x.id) === item.dataset.cid)
      if (!c) return
      if (act.dataset.cmtact === 'resolve') cmtToggleResolved(c)
      else if (act.dataset.cmtact === 'del') cmtRemove(c)
    })
  }

  // 卡描述符（与 views/cards/* 同构：id/title/命令表）。host pane 卡无槽位 mount，注册面走 ToolCapsule。
  const commentCardDef = {
    id: 'comment',
    title: '评论',
    tip: '项目评论批注',
    icon: 'msg',
    tab: false,
    pane: 'wk-cmt',
    ns: 'floria-comment',
    cmds: ['state', 'locate'],
  }

  // ① ToolCapsule 工具页：打开该页时拉当前项目评论并渲染（cmtMount 幂等，事件委托只绑一次）
  registerWkTool({
    id: 'comments',
    title: commentCardDef.title,
    pane: commentCardDef.pane,
    mount: () => {
      cmtMount()
      cmtLoad(state.workProj)
      cmtRender()
    },
  })

  // ② 公开 API：只读快照，无状态、幂等
  function cmtSnapshot() {
    const { list, proj, loading, err } = cmtState()
    return { project: proj, total: list.length, open: list.filter((c) => !c.resolved).length, loading, error: err }
  }
  cardBus.registerInlineCard({
    instanceId: 'floria-comment',
    ns: commentCardDef.ns,
    cmds: commentCardDef.cmds,
    handlers: {
      state: () => cmtSnapshot(),
      locate: () => ({
        ...cmtSnapshot(),
        comments: cmtState().list.map((c) => ({
          id: String(c.id || ''),
          path: String(c.path || ''),
          l0: Number(c.l0) || 0,
          l1: Number(c.l1) || 0,
          resolved: !!c.resolved,
        })),
      }),
    },
  })


  function projectPickerGroups() {
    return (state.projects || []).filter((g) => g && g.label && g.scope === 'project')
  }

  function createProjectPicker(opts) {
    const { pop, seat, getSelected, allowGlobal, onPick, emptyText, beforeOpen, beforeClose, canOpen } = opts
    const isOpen = () => !!pop && !pop.hidden

    function rowHtml(label, text, isGlobal) {
      const on = (getSelected() || '') === label
      return (
        `<button class="pk-row${on ? ' on' : ''}" data-pk="${esc(label)}" title="${esc(text)}">` +
        `<span class="pk-ico">${isGlobal ? I.pen : I.folder}</span>` +
        `<span class="pk-name">${esc(text)}</span>` +
        (on ? `<span class="pk-check">${I.dshCheck}</span>` : '') +
        `</button>`
      )
    }

    function render() {
      if (!pop) return
      const rows = []
      if (allowGlobal) rows.push(rowHtml('', '全局（默认）', true))
      for (const g of projectPickerGroups()) rows.push(rowHtml(g.label, g.label, false))
      pop.innerHTML = rows.length ? rows.join('') : `<div class="wk-empty">${esc(emptyText || '未发现项目')}</div>`
    }

    async function open() {
      if (canOpen && !canOpen()) return
      // 列表还在途中（切到 work 后立刻点开）就先等它落地——绝不给用户弹空框，也避免弹完不再更新。
      if (beforeOpen) await beforeOpen()
      render()
      pop.hidden = false
    }

    function close() {
      if (beforeClose) beforeClose()
      if (pop) pop.hidden = true
    }
    function toggle() {
      isOpen() ? close() : open()
    }

    if (seat) {
      seat.addEventListener('click', (e) => {
        e.stopPropagation() // 同步：先掐断 document 的收起委托，后面的 await 才不会被它提前关掉
        toggle()
      })
    }
    if (pop) {
      pop.addEventListener('click', (e) => {
        e.stopPropagation()
        const b = e.target.closest('[data-pk]')
        if (!b) return
        close()
        onPick(b.dataset.pk || '')
      })
    }
    return { render, open, close, toggle, isOpen }
  }
  // 项目槽缺省（新项目 / 无槽时用）。**键名 = 槽内键名 = state 上同名 live 字段**
  // （state.workSlots[<label>]，见 core/ui-state.js 与 core/storage.js 的 stashWorkSlot/loadWorkSlot）。
  // 一个键一件事，槽与 live 字段一一对应，不再有两套命名（旧 wkPanes 的 workspace/sidebar 已并入
  // wkPreview/panelPinned，由 loadWork 的迁移一次性折叠）。
  const WORK_SLOT_DEF = {
    wkTab: 'files',        // 侧栏体：'files' 文件树 / 'chat' 会话列表
    wkMainTab: 'chat',     // 下沉区：'chat' 助手 / 'file' 编辑区 / 'plugins' 项目插件页
    wkAssist: true,        // 聊天 tab 是否在场
    wkAssistMode: 'side',  // 助手形态：'side' 靠栏 / 'float' 悬浮卡 / 'slim' 收敛输入栏
    wkAssistH: 430,        // 悬浮卡高度 px
    wkChats: [],           // 顶栏聊天胶囊开放集（会话 hash 或 'new'）
    wkFiles: [],           // 顶栏文件 pill 开放集（项目内相对 POSIX 路径）
    // 该项目**切换前停在哪个会话**（'' = 无活动会话）。**槽专属字段，无同名 live 字段**——
    // 活动会话的真源是路由 state.currentHash，本键只在 stash 那一刻记下它，供切回时作恢复目标
    // （switchWorkProject 返回它，调用方显式 navigate）。不是顶栏开放集，不进 wkChats。
    activeChat: '',
    workFile: '',          // 当前打开的文件（项目内相对路径）
    wkPreview: true,       // 右栏预览列是否在场
    wkPvTab: '',           // 右栏页态：'' = 预览态 / 已注册工具 id
    wkPvCard: '',          // 预览态当前卡 id（'' = 无卡项目的传统单页）
    panelPinned: false,    // 侧栏是否被主动打开（桌面）
  }


  // 「当前 work 面在哪儿」的唯一只读源。kind 区分两种语境：
  //   'project'   = 某个具体工作项目（含它的会话/文件/预览）——**工作区根「全局根 · 散装对话」也是
  //                 一个 project 语境**（待办 #7 收尾：与项目同构，不再是第三态）
  //   'workspace' = 未选中任何项目
  function getWorkContext() {
    const projectKey = state.workProj || ''
    return {
      kind: projectKey ? 'project' : 'workspace',
      projectKey,
      projectLabel: projectKey, // 槽键 = 项目 label（/gateway/sessions 的 groups label）
      mode: state.sbMode, // 'chat' | 'work'
      selectedTab: state.wkTab, // 'files' | 'chat'
    }
  }

  // 槽只读取用（不落 live、不改槽）。无槽返回 null——调用方自己决定回落缺省还是走 def。
  function getWorkProjectSlot(key) {
    return (key && state.workSlots[key]) || null
  }

  // work 顶栏（下沉区 tab 条）该显示什么：**只回答 work 面自己的资源**（聊天胶囊 / 文件 pill /
  // 当前文件），且只取**当前语境那一槽**——这正是「顶栏按项目分家」的落地（待办 #9）。
  // 它绝不回答「哪张管理卡能不能开」——那是 registry 的 isCardAllowedInContext。
  //
  // 读哪一份：**live 就是当前槽的活视图**（不变量 workSlotKey === workProj）——运行期对顶栏开放集的
  // 增删只落在 live（openWorkFile / wkEnsureTab），只有在 stash 那一刻才回写槽；因此问的是「当前那
  // 一槽」时读 live 才准（读槽会读到上一次 stash 的旧值，顶栏滞后一拍）。问**别的**项目（未来跨项目
  // 预览/对账）才落到它自己的槽。空语境（工作区根/无项目）两族皆空。
  function getWorkSurfaceProjection(ctx) {
    const c = ctx || getWorkContext()
    const isLive = c.kind === 'project' && c.projectKey === state.workSlotKey
    const slot = c.kind !== 'project' ? null : (isLive ? state : getWorkProjectSlot(c.projectKey))
    return {
      tab: c.selectedTab,
      chats: slot && Array.isArray(slot.wkChats) ? slot.wkChats.slice() : [],
      files: slot && Array.isArray(slot.wkFiles) ? slot.wkFiles.slice() : [],
      activeFile: slot ? slot.workFile || '' : '',
    }
  }

  // 切工作项目（**唯一口**）：stash 当前槽 → 换 workProj → load 新槽 → 对齐 workSlotKey。
  // 只动状态，不渲染、不导航（调用方按需 renderWorkChrome / applyPanes / renderEditor…），
  // 纯状态函数不碰 DOM，便于探针与复用。
  // **返回目标路由** = 新项目槽上次的活动会话 hash（'' = 该项目没有活动会话 ⇒ 空态首页）；
  // 同 label 重复调用 = 无操作，返回 null（调用方据此不导航）。
  // 「切项目该回哪一屏」由本口一次答清，**不再**交给 enforceWorkScope 统一强制跳 '#/'——那会把
  // 「切项目」与「路由弹回」两种意图混成一条，且空路由被 wkActiveKey 转成 'new' 后由 open-set
  // 兜底并入 ⇒ 每切一次项目凭空多一枚「新对话」胶囊（2026-10-15 根因）。
  function switchWorkProject(label) {
    const key = label || ''
    if (key === state.workSlotKey && key === state.workProj) return null
    stashWorkSlot() // 旧 live 归入它自己的槽（认 workSlotKey，不认新指针）
    state.workProj = key
    loadWorkSlot(key, WORK_SLOT_DEF) // 新项目：有槽恢复（含顶栏开放集/侧栏页/开关），无槽回落缺省
    state.workSlotKey = key
    const s = state.workSlots[key]
    return s && typeof s.activeChat === 'string' ? s.activeChat : ''
  }

  // 语境归一（启动恢复 / 切项目 / 路由恢复共用；**幂等**）。守护的不变量：
  //   workSlotKey === workProj（live 必须镜像当前项目的槽）
  // 不等即漂移——按 workProj 重取槽，把 live 拉回正轨（而不是让两套值并存各自演化）。
  // 槽缺失时同一路径补缺省槽，故「首次进某项目」与「漂移修复」共用一条链，无第二份初始化旁路。
  function reconcileWorkSurface() {
    if (state.workSlotKey !== state.workProj) {
      state.workSlotKey = '' // 强制重取：stash 不该把漂移的 live 写进任何槽
      loadWorkSlot(state.workProj, WORK_SLOT_DEF)
      state.workSlotKey = state.workProj
    } else if (state.workProj && !state.workSlots[state.workProj]) {
      state.workSlots[state.workProj] = { ...WORK_SLOT_DEF, wkChats: [], wkFiles: [] } // 无槽 = 补缺省
    }
  }

  // Floria 侧 CM6 接缝（2026-10-24 收口）：编辑能力全部在 @floria/cm6 包，产物
  // /cm6/floria-cm6.iife.js 先于 app.js 同步加载并挂 window.FloriaCM6。
  // 本件只做两件事：①注入宿主运行时依赖（toast/会话/markdown/esc 等，包内核禁止 import Floria 模块）；
  // ②把包内核符号摊进单 IIFE 共享作用域，其余 Floria 模块按原名取用。
  // 禁在 web-src 内复刻编辑器内核——原 web-src/editor/*.js 已整体移入包。
  if (!window.FloriaCM6) throw new Error('CM6 包未加载（/cm6/floria-cm6.iife.js 须先于 app.js）')
  FloriaCM6.configureEnv({
    toast: (m) => toast(m),
    newSessionProject: () => newSessionProject(),
    fileIcon: (p) => fileIcon(p),
    apiUrl: (p) => apiUrl(p),
    getContext: () => ({
      currentHash: state.currentHash,
      sbMode: state.sbMode,
      workProj: state.workProj,
      curUuid: live.curUuid,
    }),
    findSession: (u) => findSession(u),
    mdHtml: (s) => mdHtml(s),
    messageMd: (c) => messageMd(c),
    selectionMd: (s) => selectionMd(s),
    esc: (s) => esc(s),
  })
  const {
    edCMG, edCmg, cmMathExt,
    editorApiGet, editorApiRegister, editorApiSetActive, editorApiUnregister, editorCommand, makeEditorFacade,
    attachmentUrl, insertAttachmentMarkdown, insertTexImages, isDocumentAttachment, isImageAttachment,
    uploadAttachment, uploadProjectAttachment, edAttImgPlugin, edAttFilePlugin,
    copyRenderedImages, copyRenderedSelection,
    renderMarkdown, toggleTask,
    insertAtCursorCM, surroundExt, toggleTaskLineCM, wrapKeymap, wrapSelectionCM,
    edTaskPlugin, edBlockMarkPlugin,
  } = window.FloriaCM6
  // ---------- work 模式侧栏（Prism 式） ----------
  // 状态源 = engine/state.js 的 sbMode / projects / workspace / workProj / workFile / wkMainTab / wkAssist /
  // wkPreview / wkPvTab / wkPrevW（localStorage floria-ui-v1 持久化，见 saveWork/loadWork）。视图浮层开关
  // （侧边栏）按项目分槽存 state.workSlots，切项目时由 work-context.js switchWorkProject 换槽。
  // 数据源全部是现成端点，本模块零后端改动：
  //   项目列表 → /gateway/sessions 的 groups（sessions.js 顺带存进 state.projects）
  //   文件树   → GET /gateway/project?label=  的 files（walkProjectTree，无固定深度 / 每层 200 / 总预算 8000）
  //   单文件   → GET /gateway/file?label=&path=（只读原始字节，带路径穿越防护 + 4MB 上限）
  // 主区：sbMode=work → #chat-area 加 .work（CSS Grid 三列 = 下沉区 | 分界条 | 右栏卡）。下沉区顶部一条
  // .wk-topbar tab 顶栏（[+] [聊天胶囊×N] [文件 pill×N] [工具栏]）：聊天胶囊 = 开放集 state.wkChats 一会话
  // 一枚（命名 = 会话标题），文件 pill = 开放集 state.wkFiles 一路径一枚（命名 = 项目内相对路径，两族 ×
  // 都关掉；开放集纯运行时、切项目重置）；同一时刻只显一个内容（#session-card = 聊天 / #work-editor =
  // 文件）；右栏（#work-preview，与下沉区同属 #chat-area 三列之一）两态由 state.wkPvTab 定：'' = 预览态
  // （挂项目预览帧）/ 工具 id = 工具态（顶 tab 条 + 该工具 pane，注册表 sidebar/work-tools.js），顶栏
  // 「工具栏」胶囊切这两态（工具态时变「关闭」）。不变量 = 聊天 / 文件 / 右栏 **至少一栏在场**，唯一
  // 判定点 applyPanes。与「管理/预览卡」互斥：route.js 进 mgr/preview 时 setSbMode('chat')。

  const IMG_EXT = /\.(png|jpe?g|webp|gif|svg|bmp|ico|avif)$/i
  const MD_EXT = /\.(md|markdown)$/i
  const WK_SAVE_MS = 1000 // 编辑区自动保存去抖（停止输入后多久落盘）
  // 空路由（currentHash ''）的**激活哨兵键**：只用于「当前激活哪一项」的判定，**绝不进入** state.wkChats
  // ——空对话不占顶栏胶囊（2026-10-17 待办 2；状态源仍只有 state.wkChats 一处）。
  const WK_NEW_TAB = 'new'
  // 侧栏体当前页 = **state.wkTab**（'files' | 'chat'）；2026-10-15 从本文件的模块局部变量提升到
  // state 并随项目入槽（core/ui-state.js / sidebar/work-context.js）——重启不再恒回「文件」。
  // 注（2026-10-15 注册域隔离）：state.wkTab 与 #mgr-tabs 的入表无关——那是 chat 侧栏的行，work 模式下
  // 整块 #chat-panel 隐掉；工作区根应用 tab 的入表判据在 registry.js（按 state.preview / state.mgr 的语境）。
  let wkTree = null        // 当前项目文件树（/gateway/project 的 files）；null = 未加载
  let wkLoading = false
  let wkErr = ''
  const wkOpen = new Set() // 已展开目录（项目内相对路径）
  let edSeq = 0            // 编辑区读取序号：快速连点文件时丢弃迟到的旧响应

  function setSbMode(mode) {
    state.sbMode = mode === 'work' ? 'work' : 'chat'
    applySbMode()
    saveWork()
  }

  // work 模式不变量（唯一判定点）：助手栏只显示工作项目的会话——当前打开的是别的项目的会话时，
  // 回该项目的「新对话」空态（新会话的目标项目由 engine/state.js newSessionProject 收口，seat 只读）。
  // 判据 = **label 唯一命中**（不再硬判 scope==='project'）：工作区根「全局根 · 散装对话」也是一个
  // 工作项目，其会话的 projectLabel 就是该 label，与项目 label 空间不重叠（待办 #7 收尾，2026-10-15）。
  // 调用点 = 进入 work 模式 / 切换工作项目 / 路由渲染会话前（chat/route.js renderSession）。
  // 会话尚未落地（findSession 查无 = 列表未拉或刷新中）时不判——「未知」不等于「别的项目」。
  // 临时项目（根级时间戳任务区）的在辖会话 = 全局根散装会话（它没有自有会话，见 work-files.js 列表口径）。
  function workScopeOk(hash) {
    if (state.sbMode !== 'work' || !state.workProj || !hash) return true
    const s = findSession(hash)
    if (!s) return true
    return sessionInWork(s, state.workProj)
  }
  function enforceWorkScope() {
    if (!workScopeOk(state.currentHash)) navigate('#/')
    renderProjSeat()
  }

  // 模式 tab「空位」定位（唯一处）：把当前 .ms-btn 的矩形以 left/right 内衬写进 .ms-thumb
  // （.mode-switch 是 position:relative，即两钮的 offsetParent，量值可直接用）。
  // 侧栏折叠态下 #panel 虽 width:0，但 .panel-inner 仍持 --panel-w 宽、按钮尺寸不变（只是被 overflow
  // 裁掉），故任何时刻量都有效，无需等侧栏展开再定位。字体异步到位会改字宽 ⇒ 由 mountWork 在
  // document.fonts.ready 后重量一次（那次不带变形动画）。
  // 切换 = 空位「变形 + 位移」（2026-10-06 用户定案）：用 left/right 两个内衬而不是 left/width——
  // 前缘（移动方向上的那条边）给短时长先到、后缘给长时长后到，中途两缘一快一慢 ⇒ 空位被拉长，
  // 到位后收回成目标钮的形状；这就是「变形位移」的读数。方向性 transition 在此按方向写内联。
  // 非切换的定位（初始化 / resize / 字体到位）一律 transition:none —— 否则首帧会播一次滑动。
  // 空位归属（2026-10-06 二轮定案）：**落在非当前模式那侧**——处于的模式在卡片上（.ms-btn.on 回
  // 卡面色），凹下去的那块给另一个模式。位置取 .ms-btn:not(.on)。
  const MS_FAST = '0.16s cubic-bezier(0.2, 0.8, 0.3, 1)'
  const MS_SLOW = '0.30s cubic-bezier(0.3, 1.04, 0.5, 1)'
  let msAtFirst = null // 上一次空位停在哪一侧（null = 尚未定位）
  function positionMsThumb() {
    const sw = $('mode-switch')
    const th = sw && sw.querySelector('.ms-thumb')
    const btns = sw && sw.querySelectorAll('.ms-btn')
    const btn = sw && sw.querySelector('.ms-btn:not(.on)')
    if (!th || !btn || !btns || btns.length < 2) return
    const first = btn === btns[0]
    const moved = msAtFirst !== null && msAtFirst !== first
    if (moved) {
      // 去左侧：前缘 = 左缘 ⇒ left 快、right 慢；去右侧：前缘 = 右缘 ⇒ right 快、left 慢
      th.style.transition = first
        ? `left ${MS_FAST}, right ${MS_SLOW}`
        : `right ${MS_FAST}, left ${MS_SLOW}`
    } else {
      th.style.transition = 'none'
    }
    th.style.left = btn.offsetLeft + 'px'
    th.style.right = sw.clientWidth - btn.offsetLeft - btn.offsetWidth + 'px'
    msAtFirst = first
  }

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

  // 下沉区当前显示的内容（唯一判定）：插件页是独立第三态，与助手形态无关（有项目即在）；
  // 其余：助手靠栏时按 wkMainTab（要看文件且确有文件才给 file，否则回 chat）；助手脱流
  // （float/slim）时它不在下沉格里 ⇒ 有文件顶上来、没有就空。'' = 下沉格空。
  function wkShownTab() {
    if (state.wkMainTab === 'plugins' && state.workProj) return 'plugins'
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
      if (!state.wkAssist && !state.workFile && !state.wkPreview && state.wkMainTab !== 'plugins') {
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
      chatArea.classList.toggle('wk-show-plugins', shown === 'plugins')
      chatArea.classList.toggle('wk-preview', !!state.wkPreview)
      if (shown === 'plugins') mountWorkPlugins() // 内容由 work-plugins 自管（元素不变零写 DOM）
    } else {
      chatArea.classList.remove('wk-show-chat', 'wk-show-file', 'wk-show-plugins', 'wk-preview')
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

  // 预览帧是否需要在场（判定唯一处）：栏在场 且 无宿主 pane 工具遮挡。预览态与帧工具态都要帧在场
  // （帧工具的内容就活在帧里，见 applyPvTab 的 body 显隐规则）；宿主 pane 工具（评论）独占右栏、帧不必挂。
  // renderWorkPreview 的渲入门与 syncWorkExtCards 的补拉门（帧不在场才补拉）都以它为准。
  function wkFrameNeeded() {
    if (!state.wkPreview) return false
    const t = state.wkPvTab ? wkToolDef(state.wkPvTab) : null
    return !t || !t.pane
  }

  // 激活卡（唯一判定）：卡表为空 = ''（传统单页预览 index.html）；否则 state.wkPvCard 命中即用，
  // 未命中回落 default / 排序首张。卡表属当前项目（previewCardsFor 异 label 返回空表）。
  function wkCardNormId(id) {
    return previewCardNormId(state.workProj, id === undefined ? state.wkPvCard : id)
  }

  // 右栏 UI 落地（唯一处，纯渲染、不挂帧）：预览态 → 显 #wk-pv-body、隐全部工具 pane；工具态 → 隐预览帧、
  // 显该注册工具 pane（其余 pane 恒隐）。tab 条随栏在场常驻（预览页签只在项目确有可视预览时渲染）。
  // 顶栏「工具栏」胶囊跟着走：栏不在场 = 「工具栏」+ 插件图标（点它开栏），在场 = 「关闭」+ ✕（点它收栏）。
  // 未注册的 wkPvTab（旧持久化值 / 工具被摘）落成「无 pane 在场」，切一次 tab 即归一。
  function applyPvTab() {
    // tab 条随数据对账：项目列表 / 预览卡表异步落地后，页签集合可能变化（卡出现或消失）。
    renderWkToolTabs()
    // 没有可视预览（无卡、无传统 preview 页）⇒ 预览页态不存在：栏开着时页态归一到首个工具页，
    // 否则 tab 条只剩工具页签、内容区却停在空预览（2026-11-02 用户定案）。仅「已知没有」才归一，
    // 数据未就绪时保持原页态（否则切到有预览的项目会被先归一成评论页）。
    if (state.wkPreview && !state.wkPvTab && wkPreviewKnown(state.workProj) && !wkPreviewAvailable(state.workProj)) {
      const first = wkToolDefs()[0]
      if (first) state.wkPvTab = first.id
    }
    const id = state.wkPvTab
    const tool = id ? wkToolDef(id) : null
    const bar = $('wk-pv-tabs')
    if (bar) bar.hidden = !state.wkPreview
    const cardId = wkCardNormId()
    if (enabledPreviewCardsFor(state.workProj).length) state.wkPvCard = cardId
    // 卡 tab 与工具 tab 互斥高亮：工具态（id 非空）时不亮任何卡；预览态亮当前卡。
    document.querySelectorAll('#work-preview .wk-pv-tab[data-wkcard]').forEach((b) => b.classList.toggle('on', !id && b.dataset.wkcard === cardId))
    document.querySelectorAll('#work-preview .wk-pv-tab[data-wkpv]').forEach((b) => b.classList.toggle('on', b.dataset.wkpv === id))
    for (const t of wkToolDefs()) {
      const el = t.pane ? $(t.pane) : null
      if (el) el.hidden = !tool || t.id !== id
    }
    // 预览帧只在「无工具或宿主 pane 工具」工具态下让位：帧工具（无 pane）内容由预览页自管，
    // 预览帧必须留在场（否则帧被卸载 → 预览页内的面板也一起没了）。
    const body = $('wk-pv-body')
    if (body) body.hidden = !!tool && !!tool.pane
    const cap = $('wk-tb-tool')
    if (!cap) return
    // 临时项目（根级时间戳任务区）不渲染工具栏胶囊（2026-10-30 用户定案）：右栏在 applyPanes 已被收掉，
    // 这里只管胶囊本身显隐。CSS 须显式 `#wk-tb-tool[hidden]{display:none}`——`.wk-tb-pill` 的
    // `display:inline-flex` 会盖掉 UA 的 `[hidden]`。
    cap.hidden = isTempProjLabel(state.workProj)
    const on = state.wkPreview
    cap.classList.toggle('on', on)
    cap.title = on ? '关闭' : '工具栏'
    const ico = cap.querySelector('.wk-tb-ico')
    if (ico) ico.innerHTML = on ? I.dshClose : I.plug
    const nm = cap.querySelector('.wk-tb-name')
    if (nm) nm.textContent = on ? '关闭' : '工具栏'
  }

  // 右栏页态唯一写口（两维一次写）：on = 这一列在不在场；page = 省略则保持当前页，'' = 回预览页，
  // id = 工具页。两个入口一律经此：setPvTab（右栏 tab 条，含首枚「预览」页签）与 setPane('workspace')（顶栏
  // 「工具栏」胶囊，work-files.js）——顶栏不另立链路，故两条入口行为必然同源。
  // 注：page !== '' 时才走 wkToolNormId（未注册 id 会回落到首枚工具，不能拿它表达「回预览态」）。
  // 工具栏一打开就预热该项目后端：卡 tab 首次点击才 spawn 会空等，PDF 卡 / 日志卡切换尤其明显。
  // 预热范围 = 项目级 backend（旧链）+ 每个**已启用且有 backend**的卡（卡级 chain）；
  // 停用卡不预热（工具栏里也没有它的 tab）。走同一 /gateway/backend 口（ensureBackend 存活复用 + in-flight 去重）。
  function warmWorkBackend() {
    const label = state.workProj
    if (!label) return
    const g = wkProjGroups().find((p) => p.label === label)
    if (g && g.hasBackend) warmProjectBackend(label)
    for (const c of enabledPreviewCardsFor(label)) {
      if (c.hasBackend) warmProjectBackend(label, c.id)
    }
  }

  function setPvPane(on, page) {
    state.wkPreview = !!on
    if (!on) state.wkPvTab = ''
    else if (page !== undefined) state.wkPvTab = page === '' ? '' : wkToolNormId(page)
    // 卡表已在时归一激活卡（表未就绪不能归一：会把持久化的卡 id 冲成 ''）；
    // 未就绪由 renderWorkPreview 拉完申报后再归一。
    if (on && enabledPreviewCardsFor(state.workProj).length) state.wkPvCard = wkCardNormId()
    if (on) warmWorkBackend()
    applyPanes()
    if (state.wkPreview) syncPvContent()
    saveWork()
  }

  // 切右栏页态（薄壳）：'' / 未注册 id → 预览态，已注册 id → 工具态。切到工具态顺带确保栏在场
  // （点 tab 就是要看这栏）。落地后补内容：工具态调该工具的 mount（注册表契约），预览态挂预览帧。
  function setPvTab(id) {
    setPvPane(true, id)
  }

  // 切预览卡（唯一口）：卡 tab 点击与「卡→宿主 floria-wk-card-switch」都走此处。
  // 切卡 = 预览页态 + 该卡目录页进 iframe（renderWorkPreview 按 state.wkPvCard 组 URL）。
  // payload = 源卡交接给目标卡的上下文（如编译失败→日志卡要知道哪一篇/哪一次编译），
  // 目标帧 load 后经 floria-wk-card-init 下发；同卡重入不发 load，此处直接投递。
  function setPvCard(id, payload) {
    if (!enabledPreviewCardsFor(state.workProj).length) return
    const next = previewCardNormId(state.workProj, id)
    if (!next) return
    const same = next === state.wkPvCard && !state.wkPvTab && state.wkPreview
    if (!same && payload !== undefined) setPendingCardPayload(state.workProj, next, payload)
    state.wkPreview = true
    state.wkPvTab = ''
    state.wkPvCard = next
    applyPanes()
    syncPvContent()
    saveWork()
    if (same && payload !== undefined) {
      const f = wkFrame()
      if (f && f.contentWindow) {
        try { f.contentWindow.postMessage({ type: 'floria-wk-card-init', card: next, payload }, '*') } catch { /* 帧已销毁：丢弃 */ }
      }
    }
  }

  // 页态落地后的内容补挂（唯一处）：预览态 → renderWorkPreview（挂/复挂预览帧）；工具态 → 该工具
  // 的 mount（无 mount 的工具内容自管，由 pane 元素既有渲染链负责，如评论面板的 cmtLoad/cmtRender）。
  // 每次落地都把「当前帧工具选中 id」回传预览帧（帧工具内容归预览页自管）。
  function syncPvContent() {
    const tool = state.wkPvTab ? wkToolDef(state.wkPvTab) : null
    notifyFrame(tool && !tool.pane ? tool.id : '')
    if (tool) {
      if (tool.mount) tool.mount()
      return
    }
    renderWorkPreview()
  }

  // 宿主 → 预览帧：回传当前选中的帧工具 id（'' = 回到预览页默认态）。发给 work 右栏当前那枚
  // .preview-frame（Pj18 等预览页据此开/关自己的面板）。id 去重（同一选中不重复发）；帧不在场
  // 或 id 未变则跳过，帧重挂/重新申报后由 syncPvContent 再对齐。
  let wkFrameSentId = null
  function notifyFrame(id) {
    if (id === wkFrameSentId) return
    const f = wkFrame()
    if (!f || !f.contentWindow) return
    try { f.contentWindow.postMessage({ type: 'floria-wk-tool-select', id }, '*') } catch { /* 帧已销毁：动作无声丢弃 */ }
    wkFrameSentId = id
  }
  // work 右栏预览帧（唯一取处）：#wk-pv-body 内**当前显示**的那枚 .preview-frame。
  // 卡池化后同容器可能并存多枚帧（隐藏帧留在池里不重载），一切「当前卡」判断必须按显隐取。
  function wkFrame() {
    const body = $('wk-pv-body')
    return body ? activePreviewFrame(body) : null
  }
  // 按来源窗口反查池内预览帧（含隐藏帧）：帧申报只认自己那枚，不取「第一个」（池化后第一个常是隐藏的）。
  function wkFrameBySource(src) {
    const body = $('wk-pv-body')
    if (!body || !src) return null
    for (const el of body.querySelectorAll('.preview-frame')) if (el.contentWindow === src) return el
    return null
  }
  // 池内激活帧变更（preview-frame.pvShow 的唯一回呼）：池内切回不重载 ⇒ load 不会再来一次，
  // 该帧申报过的帧工具 / 侧栏按钮只能从帧上缓存恢复；卡→卡交接数据也只能在此补发。
  // 首次建帧同样会走到这里（缓存为空、payload 留给 load 处理器），故不做新旧区分。
  setPreviewActiveHook((container, el, key) => {
    if (container !== $('wk-pv-body')) return // 槽位预览卡（chat 模式）：不参与 work 右栏的工具/按钮表
    const label = el.dataset.label || ''
    registerWkFrameTools(label, el.__wkTools || [])
    setRailExtItems(el.__railItems || [])
    renderRailExt()
    if (state.wkPvTab && !wkToolDef(state.wkPvTab)) state.wkPvTab = ''
    applyPanes()
    // 换帧 = 选中态必须重发给新帧（wkFrameSentId 的去重只对同一帧成立）
    wkFrameSentId = null
    const tool = state.wkPvTab ? wkToolDef(state.wkPvTab) : null
    notifyFrame(tool && !tool.pane ? tool.id : '')
    // 新帧还没加载完就发 postMessage 会丢；交接数据等 load 处理器消费（它在加载后自会发）。
    if (!el.__pvLoaded) return
    const payload = takePendingCardPayload(label, key)
    if (payload !== null && payload !== undefined) {
      try { el.contentWindow.postMessage({ type: 'floria-wk-card-init', card: key, payload }, '*') } catch { /* 帧已销毁：丢弃 */ }
    }
  })

  // 预览帧挂载（唯一处）：内容渲染一律走 preview-card 的 mountPreview（与槽位预览卡同一份后端容器 /
  // 静态页两级链），本模块只决定「挂哪个项目的、什么时候挂」，不碰 iframe。
  function hasPreviewOf(label) {
    return wkProjGroups().some((g) => g.label === label && g.hasPreview)
  }
  function renderWorkPreview() {
    if (!wkFrameNeeded()) return // 宿主 pane 工具态 / 栏不在场：预览帧不渲染（切回时 syncPvContent 再调）
    const el = $('wk-pv-body')
    if (!el || !state.workProj) return
    // 项目清单未就绪（token/设备门未解锁时 loadSessions 早退 ⇒ state.projects 为空）：此刻 hasPreview
    // 不可信，不挂任何源。等门后补拉的 ensureWork 再入。
    if (!wkProjGroups().length) return
    // 已知该项目没有可视预览（无卡、无传统 preview 页）：不挂任何源——预览页签也不渲染，
    // 页态由 applyPvTab 归一到工具页，正常不会走到这里。
    if (wkPreviewKnown(state.workProj) && !wkPreviewAvailable(state.workProj)) return
    const label = state.workProj
    // 卡表未就绪：先取申报（与外部卡同一请求），落地后重渲 tab 条再挂帧——
    // 不能先挂传统 index.html，再被卡表纠正（那是一次多余的整页导航）。
    if (!previewCardsReadyFor(label)) {
      ensurePreviewDecls(label).then(() => {
        if (state.workProj !== label) return
        renderWkToolTabs()
        applyPvTab()
        renderWorkPreview()
      })
      return
    }
    const cardId = wkCardNormId()
    state.wkPvCard = cardId
    const f = wkFrame()
    if (f && f.dataset.label === label && (f.dataset.card || '') === cardId) {
      // 同项目同卡已亮着：零操作（不重载 = 零导航扰动）。
      return
    }
    clearWkFrameTools() // 帧换文档：上一份预览页申报的工具 tab 失效（不变量同 rail-ext）
    wkFrameSentId = null
    // 建帧 / 池内切显隐都是异步回程，激活帧落地后由 setPreviewActiveHook 统一收尾
    // （见下方 hook：恢复帧工具、侧栏按钮、补发交接数据）。
    mountPreview(el, label, hasPreviewOf(label), cardId)
  }

  // 顶栏 tab 条（唯一渲染口）：[聊天胶囊 × N] [文件 pill × N]（2026-10-12 文件 pill 起多枚并存）。
  // 聊天胶囊 = 开放集 state.wkChats 一条一枚，命名用会话标题（空对话 = 「新对话」）；
  // 文件 pill = 开放集 state.wkFiles 一条一枚，命名用**项目内相对路径**（MATH/main.tex）——不能用
  // baseOf，两本书的 main.tex 会渲染成一模一样的两枚、认不出也切不动；超宽从**左侧**截断（尾部文件名
  // 才是唯一区分段，右截断会把目录段切掉，见 styles.css 的 .wk-tb-name[dir='rtl'] 规则）。
  // active 与下沉区显示同源（wkShownTab）：聊天 = 路由命中项、文件 = state.workFile（故点助手头部
  // 「浮起」后聊天胶囊自然熄、文件 pill 亮）。点文件 pill = openWorkFile（唯一口，含广播）；× 关 tab
  // 由点击委托处理。
  function renderTopbar() {
    const box = $('wk-tb-tabs')
    if (!box) return
    if (state.sbMode !== 'work') { if (box.innerHTML) box.innerHTML = ''; return }
    const shown = wkShownTab()
    const active = wkActiveKey()
    const parts = []
    if (state.wkAssist) {
      for (const key of state.wkChats) {
        const name = esc(wkTabName(key))
        parts.push(`<button class="wk-tb-pill${shown === 'chat' && key === active ? ' on' : ''}" data-wkchat="${esc(key)}" title="${name}"><span class="wk-tb-name">${name}</span><span class="wk-tb-x" title="关闭">×</span></button>`)
      }
    }
    for (const p of state.wkFiles) {
      const on = shown === 'file' && p === state.workFile ? ' on' : ''
      const full = esc(p)
      parts.push(`<button class="wk-tb-pill${on}" data-wkftab="${full}" title="${full}"><span class="wk-tb-ico">${fileIcon(p)}</span><span class="wk-tb-name" dir="rtl"><span dir="ltr">${full}</span></span><span class="wk-tb-x" title="关闭">×</span></button>`)
    }
    const html = parts.join('')
    if (box.innerHTML !== html) box.innerHTML = html
  }

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

  // ---------- 外部卡申报补拉 ----------
  // 与 ensureWork 的树/编辑区补拉同源。预览帧在场时由 renderWorkPreview → mountPreview → syncExtCards
  // 顺带拉；预览帧不在场（宿主 pane 工具态 / 右栏关着）时在此补齐——否则刷新后外部卡 tab 缺失、
  // /manage/ext:… 直进无卡可解析（EXT 是内存表，只落缓存不落盘）。两门互补：帧在场判定 = wkFrameNeeded。
  function syncWorkExtCards() {
    if (state.workProj && !wkFrameNeeded()) syncExtCards(state.workProj)
  }

  function hideWkPops() {
    for (const id of ['wk-proj-pop', 'wk-new-pop']) {
      const el = $(id)
      if (el) el.hidden = true
    }
  }

  function setPane(k, on) {
    if (k === 'sidebar') {
      // 侧栏开合不走「至少保留一栏」判定——那是主区内容的约束，与侧栏无关。
      // pin = 主动打开，鼠标移出侧栏不自动收（悬停预览式收起只属左缘唤出）。行状态真源见 paneOn。
      setPanel(on, { pin: on })
      applyPanes()
      saveWork() // 两开关之一：归档进工作项目的槽
      return
    }
    if (k === 'workspace') {
      // 右栏开/关的**唯一 api**（顶栏「工具栏」胶囊直调此处，见 work-mount.js）：只管在场维，页态归
      // work-preview.js 的 setPvPane。省略 page ⇒ 保持当前页；关栏时 setPvPane 内部顺带回预览态
      // （不留「栏不在场却停在工具态」的悬空页态）。
      // 评论内容不随开关走：cmtLoad/cmtRender 在选项目（selectProject）与事后补拉（ensureWork）
      // 两处恒跑（原文标记也需要它），开关只管这一列的显隐。
      setPvPane(on)
      return
    }
    // 助手开关（浮层已不含助手行；只剩助手头部的 × 走到这里）：关掉后若下沉格再没有别的可显，
    // 由 applyPanes 的不变量兜底（强制留一栏 + toast）。
    if (k === 'assist') {
      state.wkAssist = on
      applyPanes()
      saveWork()
    }
  }

  // ---------- 侧栏渲染 ----------
  // 名字必须全局唯一：全部 web-src 模块体拼进同一个 IIFE 作用域，顶层同名声明会静默互相覆盖
  // （由 `probes/probe-web-module-scope.ts` 看住）。
  // 项目枚举已收口到 feature/project-picker 的 projectPickerGroups（底栏与 work 下拉同源）。
  // 项目列表 = findProjects 中 scope==='project' 的组（Pj 长期项目 + 根级时间戳任务区，一视同仁平铺）。
  // 工作区根「全局根 · 散装对话」不进这份列表（2026-10-30 用户定案：work 项目选择器只给项目，
  // 散装区不占一格；后端仍照旧产出该组，散装会话/笔新建/全局预览不受影响）。
  function wkProjGroups() {
    // 项目枚举只认 state.projects（后端 findProjects）。实现与底栏项目选择器同源：
    // feature/project-picker/project-picker.js 的 projectPickerGroups（唯一判据）。
    return projectPickerGroups()
  }

  // 项目选择器组件实例（与底栏 #proj-pop 同一实现，2026-11-06 同构）：差异只在本处注入——
  // 无「全局（默认）」行、选中 = state.workProj、选中后走 selectProject、打开前补拉项目列表。
  const wkPicker = createProjectPicker({
    pop: $('wk-proj-pop'),
    seat: $('wk-proj-seat'),
    allowGlobal: false,
    emptyText: '未发现项目，点 ⟳ 重试',
    getSelected: () => state.workProj || '',
    beforeOpen: async () => {
      hideWkPops()
      await ensureProjectList()
      renderWorkChrome()
    },
    beforeClose: () => hideWkPops(), // 关下拉同拍收起侧栏里其它浮层（原 seat 点击链语义）
    onPick: (label) => selectProject(label),
  })

  // 项目名 + 底部卡 + 下拉内容 = 同一份 state.projects 的同一次渲染（2026-09-25 修）。
  // 此前下拉内容由 renderWorkProjects 单独在「点开那一刻」渲染一次，而项目列表是 ensureWork 里
  // await loadSessions() 异步落地的——切到 work 后立刻点开就会渲染出 0 项，此后列表到了也不再更新
  // （底部卡显示「7 个项目」、下拉却是空的，就是这个错位）。合并为一条渲染路径后无处可漂移。
  function renderWorkChrome() {
    const lab = document.querySelector('#wk-proj-seat .wk-proj-label')
    if (lab) lab.textContent = state.workProj || '选择项目'
    const ft = $('wk-foot-text')
    if (ft) {
      const n = wkProjGroups().length
      ft.textContent = `${state.workProj || 'Floria'} · ${n} 个项目`
    }
    const seat = $('wk-proj-seat')
    if (seat) seat.classList.toggle('empty', !state.workProj)
    renderWorkProjects()
  }

  // 下拉内容 = 共享项目选择器组件（一张平铺列表：Pj 项目与根级时间戳项目不加分组标题，2026-10-30 定案）。
  function renderWorkProjects() {
    wkPicker.render()
  }

  // tab 行工具区：加号只在聊天 tab 出现（新建聊天）；文件 tab 的加号（新建文件/文件夹）待新建写接口
  // 定案后接入，届时同一按钮按 tab 分派。（原就地过滤 🔍 + #wk-find-row 已并入顶栏统一搜索，2026-10-08）
  function updateWkTools() {
    // tab 高亮唯一同步点（2026-10-21 待办）：state.wkTab 还会被切项目/启动恢复经 loadWorkSlot 改写，
    // 只在点击处理器里同步 class，恢复出来的「文件亮、内容却是聊天」就会错位。renderWorkBody 每次必经此处。
    // 插件页占下沉格时只亮「插件」，文件/聊天 tab 不亮（与 chat 侧栏 mgr-tabs 单态一致）
    const pluginsView = state.wkMainTab === 'plugins' && !!state.workProj // 判据同 wkShownTab
    document.querySelectorAll('.wk-tab').forEach((b) => {
      if (b.hasAttribute('data-wkplugins')) { b.classList.toggle('on', pluginsView); return }
      b.classList.toggle('on', !pluginsView && b.dataset.wktab === state.wkTab)
    })
    const nb = $('wk-new')
    const isChat = state.wkTab === 'chat'
    if (nb) nb.title = isChat ? '新建聊天' : '新建文件'
    const pop = $('wk-new-pop')
    if (pop && state.wkTab !== 'files') pop.hidden = true // 文件菜单只在文件 tab 有意义，切走即收
  }

  // 侧栏体的唯一渲染出口：HTML 全量算好再比对写入。比对是自动对账的必要条件——每 5s 一次无脑重写
  // innerHTML 会让文件树的滚动位置与展开动画反复归零（内容没变就没有重写的理由）。
  function renderWorkBody() {
    const body = $('wk-body')
    if (!body) return
    updateWkTools()
    const html = wkBodyHtml()
    const rebuilt = body.innerHTML !== html
    if (rebuilt) {
      // 重建前先收起展开态：旧行节点随 innerHTML 消亡，引用必须清掉（与 renderRecent 同口径）
      expandClear()
      peekClear()
      body.innerHTML = html
      // 新建的会话行接入统一行协议（点击 → activateSession({source:'work'}) + hover 横向延展），
      // 实现在 recent.js；**只在重建分支接线**——未重写时节点未变，重复接线会让同一节点累积多份监听。
      // 滚动容器 #wk-body 一并传入（滚轮关闭行浮窗的监听挂它）。文件树行同绑延展（同一层，不另起一套）。
      bindSessionRows(body, { source: 'work', root: body })
      bindRowPeek(body, '.wk-row')
      reliftAfterRebuild(body)
    }
  }

  function wkBodyHtml() {
    if (state.wkTab === 'chat') {
      // 列表 = 当前项目下的会话，条目渲染复用 recent.js 的 itemHtml（与侧栏「项目展开」同一份实现，
      // 不另写一套行）；行操作浮窗（右键 / 长按）走 recent.js 的 document 级委托，此处无需接线。
      // 置顶排序（2026-10-18）：wkPins 命中的会话恒排在 sessCmp 之前（组内仍按 sessCmp：
      // 状态在线优先 + 创建时间新→旧）。只作用于 work 侧栏列表，chat 侧栏 renderList/renderProject 不变。
      const pinRank = (s) => (isPinned(hashOf(s)) ? 0 : 1)
      // 临时项目（根级时间戳任务区）没有自有会话：列表改展示**全局根散装会话**（2026-10-30 用户定案）。
      // 判据统一走 core/util.js sessionInWork（临时项目 → 全局会话）；新建会话也落全局根（newSessionProject），故入列的
      // 新会话就在这份列表里，不会「发完就消失」。
      const list = state.workProj
        ? ALL.filter((s) => sessionInWork(s, state.workProj)).sort(
            (a, b) => pinRank(a) - pinRank(b) || sessCmp(a, b),
          )
        : []
      // 新建入口 = tab 行工具区的加号（updateWkTools 控制显隐），列表顶部不再占一行大按钮
      if (!state.workProj) return '<div class="wk-empty">先在上方选择一个项目</div>'
      return list.length
        ? `<div class="wk-chats">${list.map((s) => itemHtml(s, false, true)).join('')}</div>`
        : '<div class="wk-empty">该项目还没有聊天</div>'
    }
    if (!state.workProj) return '<div class="wk-empty">先在上方选择一个项目</div>'
    if (wkLoading) return '<div class="wk-empty">加载中…</div>'
    if (wkErr) return `<div class="wk-empty">${esc(wkErr)}</div>`
    if (!wkTree || !wkTree.length) return '<div class="wk-empty">项目内没有可列出的文件</div>'
    return wkTreeHtml(wkTree, 0, '') || '<div class="wk-empty">项目内没有可列出的文件</div>'
  }

  function wkTreeHtml(nodes, depth, prefix) {
    let h = ''
    for (const n of nodes || []) {
      const p = prefix ? `${prefix}/${n.name}` : n.name
      const pad = `padding-left:${8 + depth * 13}px`
      if (n.type === 'dir') {
        const open = wkOpen.has(p)
        h += `<button class="wk-row dir${open ? ' open' : ''}" data-wkdir="${esc(p)}" draggable="true" style="${pad}" title="${esc(p)}">`
        // 图标 SVG 无自带尺寸，必须落在有 svg 尺寸规则的 slot 里——裸插会取替换元素默认 300×150（巨型图标撑爆行高）
        h += `<span class="wk-chev">${open ? I.dshChevDown : I.dshChevRight}</span><span class="wk-fic">${I.folder}</span>`
        h += `<span class="wk-name">${esc(n.name)}</span></button>`
        if (open) h += wkTreeHtml(n.children, depth + 1, p)
      } else {
        const on = p === state.workFile ? ' on' : ''
        h += `<button class="wk-row file${on}" data-wkfile="${esc(p)}" draggable="true" style="${pad}" title="${esc(p)}">`
        h += `<span class="wk-chec"></span><span class="wk-fic">${I.dshFile}</span>`
        h += `<span class="wk-name">${esc(n.name)}</span></button>`
      }
    }
    return h
  }

  // ---------- 数据 ----------
  // 就地从内存树摘掉一个条目（2026-10-14 待办 12 删除增量更新的渲染源）：按路径段逐层下钻，
  // 末段命中即 splice。wkTree 为 null（树未加载）时静默不动——增量无源可改，交给随后的静默对账。
  function wkTreeRemove(p) {
    if (!wkTree) return
    const parts = p.split('/')
    const walk = (nodes, i) => {
      if (!Array.isArray(nodes)) return
      const idx = nodes.findIndex((n) => n.name === parts[i])
      if (idx < 0) return
      if (i === parts.length - 1) nodes.splice(idx, 1)
      else walk(nodes[idx] && nodes[idx].children, i + 1)
    }
    walk(wkTree, 0)
  }
  // 拖拽移动（2026-10-14 待办 10）：POST /gateway/file/move 成功后，前端把内存里的路径引用一并改指
  // 新址——打开中的文件（workFile）、文件 tab 开放集（wkFiles）、目录展开集（wkOpen）凡落在被移动
  // 子树下的都重写。树本身不手工搬节点：wkTreeRemove 摘旧 + 静默对账 loadProjectTree 补新（与删除
  // 同一条渲染链，不另起第二套搬移逻辑）。
  async function wkTreeMove(from, dir) {
    if (needToken()) return
    const res = await fetch(apiUrl('/gateway/file/move'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: state.workProj, path: from, dir }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) { toast(data.error || `移动失败（${res.status}）`); return }
    const to = dir ? `${dir}/${from.split('/').pop()}` : from.split('/').pop()
    const remap = (p) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p)
    if (state.workFile) state.workFile = remap(state.workFile)
    state.wkFiles = (state.wkFiles || []).map(remap)
    for (const k of [...wkOpen]) {
      const np = remap(k)
      if (np !== k) { wkOpen.delete(k); wkOpen.add(np) }
    }
    wkTreeRemove(from)
    renderEditor()
    applyPanes() // workFile/wkFiles 变更随一次布局落地（内含 saveWork 收口）
    loadProjectTree(state.workProj, true) // 静默对账：新位置入树（失败保旧树）
    toast('已移动到 ' + (dir || '项目根'))
  }
  // silent = 自动对账调用：不置加载态、失败保留旧树（瞬时网络错误不该把已展开的树清成错误页）
  async function loadProjectTree(label, silent) {
    if (!label || needToken()) return
    if (!silent) {
      wkLoading = true
      wkErr = ''
      wkTree = null
      renderWorkBody()
    }
    try {
      const res = await fetch(apiUrl('/gateway/project?label=' + encodeURIComponent(label)))
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || '加载失败')
      wkTree = Array.isArray(data.files) ? data.files : []
    } catch (e) {
      if (silent) return
      wkErr = e.message || String(e)
    } finally {
      if (!silent) wkLoading = false
    }
    renderWorkBody()
  }

  async function selectProject(label) {
    hideWkPops()
    if (!label || label === state.workProj) return
    if (wkEdDirty) await wkEdFlush() // 切项目前 flush 旧项目文件的 pending 编辑
    // 切项目 = stash 旧槽 → 换 workProj → load 新槽（唯一口 work-context.js switchWorkProject）。
    // 旧项目的顶栏开放集/侧栏页/开关归入它自己的槽，新项目从自己的槽恢复——**不再清空**（清空等于把
    // 「切回来恢复」永久做掉，是待办 #9 的根因）。
    const target = switchWorkProject(label) // 返回该项目槽上次的活动会话（'' = 无活动会话）
    wkOpen.clear() // 展开集是纯运行时视图态，不随槽持久化
    renderWorkChrome()
    // 目标路由由切项目这一侧**显式导航**（切项目意图 ≠ 路由弹回）：有上次会话则回它，无则回空态首页。
    // **不写 wkChats**——空态不等于「新对话 tab」（那要用户主动新建）；此处若走 enforceWorkScope 的
    // 无条件 navigate('#/')，空路由会被 open-set 兜底转成 new 并持久化（切项目凭空多新对话胶囊的根因）。
    navigate(target ? '#/' + encodeURIComponent(target) : '#/')
    renderProjSeat() // 新项目的席位（新会话目标项目）随项目换；路由已由上一行定值，不再强制弹回
    saveWork()
    applyPanes() // 再落地两开关（含「至少保留一栏」判定 + 视图浮层行同步 + 顶栏按归一后的路由重渲）
    applySidebarPin() // 侧栏开合按新项目的槽（桌面）
    renderEditor()
    hydrateExtCards(label) // 换项目：外部卡先按缓存即时换槽（tab 不断档），再走下面一次网络清单
    if (state.wkPreview) warmWorkBackend() // 右栏开着就预热新项目后端（工具态不会走下面的 mountPreview）
    renderWorkPreview() // 预览帧跟着换项目（异 label = 换源，mountPreview 内部重建；工具态则早退）
    cmtInvalidate() // 评论按项目分库：旧项目副本作废（下一行 cmtLoad 重拉，评论面板与原文标记共用）
    cmtLoad(label) // 原文标记也需要当前项目的评论（不止评论面板）；拉到后 cmtApplyMarks 自动补标
    cmtRender()
    syncWorkExtCards()
    await loadProjectTree(label)
  }

  // silent = 自动对账（见 workAutoTick）：不收起浮层、不动滚动位置、失败静默
  async function refreshWork(silent) {
    if (!silent) hideWkPops()
    const body = $('wk-body')
    const sc = body ? body.scrollTop : 0
    try {
      await loadSessions()
    } catch {
      /* 列表刷新失败不阻断文件树刷新 */
    }
    renderWorkChrome()
    renderTopbar() // 顶栏与会话列表同拍对账（2026-10-13 待办 13）：wkTabName 按会话标题渲染，
    // SSE 改题/集合变化只会先落到 renderWorkChrome 这条链——缺这口时顶栏胶囊标题要等下一次
    // applyPanes（用户交互）才追上，「更新不及时」的根因即此。innerHTML 比对，未变零写 DOM。
    renderWkToolTabs() // groups 的 hasPreview 可能随磁盘变化（.claude/preview 增删）→ 预览页签同拍对账
    if (state.workProj) await loadProjectTree(state.workProj, silent)
    else renderWorkBody() // 未选项目时列表/空态也要跟上（loadProjectTree 早退不渲染）
    if (body && sc && body.scrollTop !== sc) body.scrollTop = sc
  }

  // ---------- 自动刷新（2026-09-26 取代手动 ⟳） ----------
  // 三条前置：work 模式 + 页面可见 + 已过 token 门。会话列表由 /gateway/events SSE 增量推，
  // 但 work 侧栏的列表/树不在 SSE 的重渲出口里（live.js refreshList 只渲 #recent-body），
  // 所以这里定时对账一次全量，静默无变化即不写 DOM（renderWorkBody 的 HTML 比对）。
  const WK_AUTO_MS = 5000
  let wkAutoT = 0
  function startWorkAuto() {
    if (!wkAutoT) wkAutoT = setInterval(workAutoTick, WK_AUTO_MS)
  }
  function stopWorkAuto() {
    if (wkAutoT) {
      clearInterval(wkAutoT)
      wkAutoT = 0
    }
  }
  async function workAutoTick() {
    if (state.sbMode !== 'work' || document.visibilityState !== 'visible' || needToken()) return
    await refreshWork(true)
  }

  // 项目列表落地（ensureWork / 下拉打开时共用）。needToken 未解锁或网络失败时 state.projects 保持原值。
  async function ensureProjectList() {
    if (state.projects.length) return
    try {
      await loadSessions()
    } catch {
      /* 静默：renderWorkProjects 以空态呈现 */
    }
  }

  // work 模式数据补齐（启动进入 / 门后补拉 / 恢复持久化状态三处共用一条路径）。needToken() 未解锁时
  // loadProjectTree 早退 ⇒ 刷新后恢复的 workProj/workFile 无树、编辑区 401，须由 engine/auth.js hideGate
  // 的「门后补拉」链再调一次（与 mgr/models/neurons 数据同点，见该文件同名注释）。
  async function ensureWork() {
    renderWorkChrome()
    renderWorkBody()
    renderEditor()
    await ensureProjectList()
    renderWorkChrome()
    if (state.workProj && !wkTree && !wkLoading && !wkErr) await loadProjectTree(state.workProj)
    renderWorkPreview() // 挂在 ensureProjectList 之后：hasPreview 来自 groups，先拉列表才知道
    cmtLoad(state.workProj) // 评论恢复态补拉（评论面板与原文标记共用；needToken 未解锁时早退，由门后补拉再调）
    syncWorkExtCards() // 外部卡申报同上：与树/编辑区/评论同一条补拉链
    // 布局落地（tab 显隐 + 列宽 + 顶栏）在本链尾再落一次：ensureWork 是 work 一切事后补拉的唯一口
    // （启动 + token 门解锁后各一次），门/首帧里 DOM 还没量到时这里给第二次落地机会。
    applyPanes()
    cmtRender() // 评论面板空态/加载态跟着工作项目落地（needToken 未解锁时上面 cmtLoad 早退）
  }


  const WPL_KINDS = [
    { id: 'plugins', label: '插件' },
    { id: 'skills', label: '技能' },
    { id: 'apps', label: '应用' },
  ]
  const WPL_VIEW = { kind: 'plugins', q: '' } // 项目侧无公开市场，cat 恒 personal（不进视图态）
  let WPL_DETAIL = null // { kind, key }
  let WPL_BODY = null // 当前 #wk-plugins-pane 元素（重渲落点）
  let WPL_LABEL = '' // WPL_DATA 所属项目
  let WPL_DATA = { plugins: [], skills: [], loaded: false, loading: false, err: '' }
  let WPL_LOADING = false
  let WPL_APPS_WAIT = '' // 已发起卡表申报请求的 label（只防重复挂 then 链）

  // 进入/回到插件页（applyPanes 在下沉区显示插件态时调用）：换项目重置详情与清单；DOM 元素换了才
  // 整页重渲，否则保持现状（搜索焦点 / 滚动位置不因周期对账被重建）。
  function mountWorkPlugins() {
    const body = $('wk-plugins-pane')
    if (!body) { WPL_BODY = null; return }
    const label = state.workProj
    if (!label) {
      body.innerHTML = '<div class="wk-empty">先在上方选择一个项目</div>'
      WPL_BODY = null
      return
    }
    if (WPL_LABEL !== label) {
      WPL_LABEL = label
      WPL_DETAIL = null
      WPL_BODY = null
      WPL_APPS_WAIT = ''
      WPL_DATA = { plugins: [], skills: [], loaded: false, loading: false, err: '' }
    }
    const fresh = WPL_BODY !== body
    WPL_BODY = body
    if (fresh) renderWpl()
    ensureWplData(label)
    ensureWplApps(label)
  }

  // 插件/技能清单（项目维度）
  function ensureWplData(label, force) {
    if (WPL_LOADING) return
    if (!force && WPL_DATA.loaded) return
    WPL_LOADING = true
    WPL_DATA.loading = true
    WPL_DATA.err = ''
    renderWplGrid()
    loadProjectPlugins(label)
      .then((d) => {
        if (WPL_LABEL !== label) return
        WPL_DATA = { plugins: d.plugins, skills: d.skills, loaded: true, loading: false, err: '' }
      })
      .catch((e) => {
        if (WPL_LABEL !== label) return
        WPL_DATA.loading = false
        WPL_DATA.err = (e && e.message) || String(e)
      })
      .finally(() => {
        WPL_LOADING = false
        if (WPL_LABEL === label) renderWpl()
      })
  }

  // 应用清单 = 预览卡申报（与右栏工具栏同一份卡表，含停用卡）；未就绪先取一次申报
  function ensureWplApps(label) {
    if (previewCardsReadyFor(label) || WPL_APPS_WAIT === label) return
    WPL_APPS_WAIT = label
    ensurePreviewDecls(label).then(() => {
      if (WPL_APPS_WAIT === label) WPL_APPS_WAIT = ''
      if (WPL_LABEL === label) renderWplGrid()
    })
  }

  function renderWpl() {
    const body = WPL_BODY
    if (!body) return
    if (WPL_DETAIL) return renderWplDetail()
    const isApps = WPL_VIEW.kind === 'apps'
    MgrUI.browse(body, {
      kinds: WPL_KINDS,
      kind: WPL_VIEW.kind,
      title: isApps ? '应用' : WPL_VIEW.kind === 'skills' ? '技能' : '插件',
      search: {
        placeholder: isApps ? '搜索应用…' : WPL_VIEW.kind === 'skills' ? '搜索技能…' : '搜索插件…',
        value: WPL_VIEW.q,
      },
      cats: isApps ? [] : [{ id: 'personal', label: '个人' }],
      cat: 'personal',
      onKind(id) {
        if (WPL_VIEW.kind === id) return
        WPL_VIEW.kind = id
        WPL_VIEW.q = ''
        WPL_DETAIL = null
        renderWpl()
      },
      onCat() { /* 项目侧只有个人项，无公开/个人切换 */ },
      onSearch(q) { WPL_VIEW.q = q; renderWplGrid() }, // 只重渲网格，不重建壳（输入焦点不丢）
      onItem(key) { WPL_DETAIL = { kind: WPL_VIEW.kind, key }; renderWpl() },
      onAction(key) { if (WPL_VIEW.kind === 'apps') toggleWplApp(key); else toggleWplCustom(WPL_VIEW.kind, key) },
      onRetry() { ensureWplData(WPL_LABEL, true) },
    })
    renderWplGrid()
  }

  function wplRows(kind) {
    return kind === 'skills' ? WPL_DATA.skills : WPL_DATA.plugins
  }

  // 应用清单 = 预览卡（card.json，含停用）+ 传统单页预览（有 .claude/preview/index.html 时一枚）。
  // 后者是既有「预览」页签的来源，同样决定工具栏显隐，故必须在管理页可启停（保留 id '__index__'）。
  function wplApps(label) {
    const list = previewCardsFor(label).slice()
    const legacy = previewLegacyIndexCard(label)
    if (legacy) list.push(legacy)
    return list
  }

  function renderWplGrid() {
    if (!WPL_BODY || WPL_DETAIL) return
    MgrUI.grid(WPL_BODY, wplGridOpts())
  }

  function wplGridOpts() {
    const kind = WPL_VIEW.kind
    const q = WPL_VIEW.q.trim().toLowerCase()
    if (kind === 'apps') {
      const label = WPL_LABEL
      if (!previewCardsReadyFor(label)) return { loading: '加载项目卡片中…' }
      const rows = wplApps(label).filter(
        (c) => !q || c.title.toLowerCase().includes(q) || c.id.toLowerCase().includes(q),
      )
      return {
        items: rows.map(wplAppItem),
        empty: '该项目没有预览卡片或预览页（.claude/preview/<id>/card.json · index.html）',
        onItem: (key) => { WPL_DETAIL = { kind, key }; renderWpl() },
        onAction: (key) => toggleWplApp(key),
      }
    }
    if (WPL_DATA.loading) return { loading: '加载项目清单中…' }
    if (WPL_DATA.err) return { error: { message: WPL_DATA.err }, onRetry: () => ensureWplData(WPL_LABEL, true) }
    const label = kind === 'skills' ? '技能' : '插件'
    const rows = wplRows(kind).filter(
      (x) => !q || String(x.n).toLowerCase().includes(q) || String(x.d || '').toLowerCase().includes(q),
    )
    return {
      items: rows.map(wplItem),
      empty: `该项目还没有已安装的${label}`,
      onItem: (key) => { WPL_DETAIL = { kind, key }; renderWpl() },
      onAction: (key) => toggleWplCustom(kind, key),
    }
  }

  // 插件/技能行：{n 名称, d 描述, v 版本, k 目录名, en 启用态}（后端读取，恒可启停）
  function wplItem(x) {
    const on = x.en !== 0
    return {
      key: x.n,
      name: x.n,
      desc: x.d || '暂无描述',
      action: { on, key: x.n, title: on ? '已启用（点击停用）' : '已停用（点击启用）' },
    }
  }

  // 应用行：卡自身申报的 icon；有卡级后端时副标题标出服务器名（用户据此判断工具栏会拉起谁）
  function wplAppItem(c) {
    return {
      key: c.id,
      name: c.title,
      desc: c.hasBackend ? `服务器 · ${c.backendName || c.id}` : '静态页面',
      icon: I[c.icon] || '',
      action: {
        on: c.enabled,
        key: c.id,
        title: c.enabled ? '已启用（点击停用，工具栏移除并停止拉起）' : '未启用（点击启用并加入工具栏）',
      },
    }
  }

  // 插件/技能启停：先乐观改本地 en 即时反馈，失败回滚 + toast。
  // 必须带 label —— 端点按项目根定位目录（无 label 会落到工作区根的同名插件）。
  async function toggleWplCustom(kind, key) {
    const x = wplRows(kind).find((r) => r.n === key)
    if (!x) { toast('未找到该条目（请刷新页面后重试）'); return }
    const next = x.en === 0
    const prev = x.en
    x.en = next ? 1 : 0
    rerenderWpl()
    try {
      const res = await fetch(apiUrl('/gateway/plugins/enable'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, name: x.k, enabled: next, label: WPL_LABEL }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'HTTP ' + res.status)
      }
    } catch (e) {
      x.en = prev
      rerenderWpl()
      toast('切换失败：' + ((e && e.message) || String(e)))
    }
  }

  // 应用启停：状态 = 卡目录 .disabled（后端落盘）。启停立即对账右栏 tab 条与页态——
  // 停用当前激活卡时 applyPvTab 会归一（没有可视预览则回落工具页）。
  async function toggleWplApp(id) {
    const label = WPL_LABEL
    const c = wplApps(label).find((x) => x.id === id)
    if (!c) { toast('未找到该卡片（请刷新页面后重试）'); return }
    const next = !c.enabled
    // 传统单页预览的条目是派生态（每次渲染重建），不做乐观改写；卡片对象可原地改。
    const derived = id === '__index__'
    if (!derived) {
      c.enabled = next
      rerenderWpl()
      renderWkToolTabs()
      applyPvTab()
    }
    try {
      const res = await fetch(apiUrl('/gateway/preview-cards/enable'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, card: id, enabled: next }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'HTTP ' + res.status)
      }
    } catch (e) {
      if (!derived) {
        c.enabled = !next
        rerenderWpl()
        renderWkToolTabs()
        applyPvTab()
      }
      toast('切换失败：' + ((e && e.message) || String(e)))
      return
    }
    if (WPL_LABEL !== label) return
    // 服务端真值重拉：卡表整份替换后，tab 条 / 激活卡按新表归一
    ensurePreviewDecls(label, true).then(() => {
      if (WPL_LABEL !== label) return
      renderWkToolTabs()
      applyPvTab()
      rerenderWpl()
    })
  }

  function rerenderWpl() {
    if (WPL_DETAIL) renderWplDetail()
    else renderWplGrid()
  }

  // ---------- 详情页（列表 → 卡内子页，返回 = 清详情重渲） ----------
  function wplDetailItem() {
    if (!WPL_DETAIL) return null
    const { kind, key } = WPL_DETAIL
    if (kind === 'apps') {
      const c = wplApps(WPL_LABEL).find((x) => x.id === key)
      if (!c) return null
      const legacy = c.id === '__index__'
      return {
        kind, key,
        ico: I[c.icon] || '',
        color: MgrUI.color(c.id),
        initial: (c.title[0] || '?').toUpperCase(),
        name: c.title,
        desc: legacy
          ? '传统单页预览（.claude/preview/index.html）'
          : c.hasBackend ? `卡级服务器：${c.backendName || c.id}` : '静态预览页（未声明服务器）',
        ver: '',
        enabled: c.enabled,
        typeLabel: '应用',
        sourceLabel: legacy ? '项目传统预览页' : '项目 .claude/preview 卡片',
        path: legacy ? '.claude/preview/index.html' : `.claude/preview/${c.id}`,
      }
    }
    const x = wplRows(kind).find((r) => r.n === key)
    if (!x) return null
    const isSkill = kind === 'skills'
    return {
      kind, key,
      ico: '',
      color: MgrUI.color(x.n),
      initial: (x.n[0] || '?').toUpperCase(),
      name: x.n,
      desc: x.d || '',
      ver: x.v || '',
      enabled: x.en !== 0,
      typeLabel: isSkill ? '技能' : '插件',
      sourceLabel: '项目本地已安装',
      path: `.claude/${isSkill ? 'skills' : 'plugins'}/${x.k || x.n}`,
    }
  }

  function renderWplDetail() {
    const body = WPL_BODY
    if (!body) return
    const it = wplDetailItem()
    if (!it) { WPL_DETAIL = null; renderWpl(); return }
    const info = [
      ['类型', it.typeLabel],
      ['来源', it.sourceLabel],
      ['版本', it.ver || '—'],
      ['状态', it.enabled ? '已启用' : '已停用'],
      ['位置', it.path],
    ]
    MgrUI.detail(body, {
      typeLabel: it.typeLabel,
      name: it.name,
      sub: `${it.typeLabel} · ${it.sourceLabel}`,
      icon: it.ico,
      color: it.color,
      initial: it.initial,
      action: { on: it.enabled, key: it.key, title: it.enabled ? '已启用（点击停用）' : '未启用（点击启用）' },
      desc: it.desc,
      info,
      onBack() { WPL_DETAIL = null; renderWpl() },
      onAction() { if (it.kind === 'apps') toggleWplApp(it.key); else toggleWplCustom(it.kind, it.key) },
    })
  }

  // ---------- 编辑区宿主状态（主区左栏） ----------
  // 所有可编辑文本文件（markdown 与代码/纯文本一视同仁）都是常驻 CodeMirror 6 编辑器：整篇恒可编辑，
  // 无阅读/编辑两态、无模式按钮；markdown 走 Obsidian 式 Live Preview，其余按扩展名加载语言高亮。
  // 真源 = EditorView.state.doc（wkEdText 仅作上次落盘基线）。
  // 保存 = 停止输入 1s 自动（去抖）+ Ctrl+S 立即；写回带 ETag 基线 wkEdMtime，外部改过 → 409，不静默覆盖。
  let wkEdFile = ''     // 已载入编辑缓冲的路径（与 wkEdMeta/wkEdText 同拍）；'' = 未载入
  let wkEdMeta = null   // { isImg, editable, msg? }；null = 未载入
  let wkEdText = ''     // 上次落盘/读入的文件正文（实时真源在编辑器 doc；保存基线）
  let wkEdMtime = null  // 读侧 ETag 解析的 mtime（毫秒），写回冲突基线；null = 无
  let wkEdDirty = false
  let wkEdTimer = 0
  let wkEdSaving = false
  let wkEdConflict = false
  let wkCmtScrollId = '' // 评论面板定位跳转待消费的评论 id（渲染完原文标记后滚到该行）
  let wkEdPendingDoc = null // 待灌入编辑器的新文档（readFile 置位；renderEdBody 消费后清空）

  function fileUrl(p) {
    return apiUrl(`/gateway/file?label=${encodeURIComponent(state.workProj)}&path=${encodeURIComponent(p)}`)
  }

  // ---------- CM6 引擎实例（包内惰性建单 view，跨文件复用） ----------
  const wkEditor = FloriaCM6.createWorkEditor({
    apiUrl: (p) => apiUrl(p),
    getWorkProj: () => state.workProj,
    getWorkFile: () => wkEdFile,
    isEditable: () => !!(wkEdMeta && wkEdMeta.editable),
    mdInlineText: (nodes) => mdInlineText(nodes),
    getCanvasExt: (CM, hlStyle) => wkCvExt(CM, hlStyle),
    onUserEdit: () => { wkEdDirty = true; wkEdState(); wkEdScheduleSave() },
    paste: {
      clipboardFiles: (cd) => clipboardFiles(cd),
      clipboardImageUrls: (html) => clipboardImageUrls(html),
      addImageFiles: (f, t) => addImageFiles(f, t),
      addUploadFiles: (f, t) => addUploadFiles(f, t),
      addImageUrls: (u, t) => addImageUrls(u, t),
    },
  })

  // 当前正文真源文本 = 编辑器文档（无编辑器则回退基线）。
  function wkEdDocText() {
    const view = wkEditor.getView()
    return view ? view.state.doc.toString() : wkEdText
  }
  function wkEdEnsureView() { return wkEditor.ensureView() }
  function wkEdSetLang(path) { wkEditor.setLang(path) }
  function wkEdSetDoc(text) { wkEditor.setDoc(text) }
  // 外部磁盘内容落进编辑器（最小段替换 + 不进 undo 栈 + 不记脏）；false = IME 组合中，调用方下轮重试
  function wkEdApplyRemote(text) { return wkEditor.applyRemote(text) }
  function wkEdApplyMarks(marks) { wkEditor.applyMarks(marks) }
  function wkEdScrollToLine(n) { wkEditor.scrollToLine(n) }
  function wkEdQuoteLines(range) { return wkEditor.quoteLines(range) }
  function wkEdInvalidatePathCache() { wkEditor.invalidatePathCache() }
  function wkEdGetView() { return wkEditor.getView() }

  // 去抖自动保存（冲突未决时暂停，交 Ctrl+S 显式处置，避免覆盖外部改动）。
  // 2026-10-25 补回：CM6 包化（v3.45.0）把本函数连同 updateListener 一起删了，而 onUserEdit 与
  // wkEdSave 结尾仍在调用 ⇒ 每次编辑抛 ReferenceError，自动保存永不排程（iPad 无 Ctrl+S 则完全无法落盘）。
  function wkEdScheduleSave() {
    if (wkEdConflict) return
    if (wkEdTimer) clearTimeout(wkEdTimer)
    wkEdTimer = setTimeout(() => { wkEdTimer = 0; wkEdSave({}) }, WK_SAVE_MS)
  }

  // 参与合并的规模上限：超限直接交回调用方走非模态提示（不在这里做压缩/截断）。
  const WK_MERGE_MAX_LINES = 20000

  function wkMergeSplit(text) {
    return String(text == null ? '' : text).split('\n')
  }

  // 两个变动块是否算冲突。同一起止（含同点插入）＝同一处两边都动 → 冲突；半开区间严格相交也算重叠。
  // 纯插入（be===bs）落在另一侧变动区间的**内部**同样判冲突——插到别人替换掉的段中间无法有序拼接；
  // 落在边界（bs/be 上）则可以，按 bs 排序后先插入再替换即等价。
  function wkBlocksOverlap(x, y) {
    if (x.bs === y.bs && x.be === y.be) return true
    if (x.bs === x.be) return y.bs < x.bs && x.bs < y.be
    if (y.bs === y.be) return x.bs < y.bs && y.bs < x.be
    return Math.max(x.bs, y.bs) < Math.min(x.be, y.be)
  }

  // 区间 [as,ae) 与 [bs,be) 内「两侧都唯一」的行配对，按 b 侧顺序取 a 索引的最长上升子序列（LIS）。
  // 返回 [[ai, bi], …]，用作递归切分的锚点（patience diff 核心）。
  function wkUniqueAnchors(a, as, ae, b, bs, be) {
    const cntA = new Map()
    const posA = new Map()
    for (let i = as; i < ae; i++) {
      cntA.set(a[i], (cntA.get(a[i]) || 0) + 1)
      posA.set(a[i], i)
    }
    const cand = []
    const seenB = new Set()
    for (let j = bs; j < be; j++) {
      const line = b[j]
      if (cntA.get(line) !== 1) continue
      if (seenB.has(line)) continue // b 侧重复出现 → 不是唯一，跳过
      seenB.add(line)
      cand.push([posA.get(line), j])
    }
    if (!cand.length) return []
    // LIS（按 a 索引上升），O(n log n)；tails 存候选下标，prev 回溯配对序列
    const tails = []
    const prev = new Array(cand.length).fill(-1)
    for (let i = 0; i < cand.length; i++) {
      const v = cand[i][0]
      let lo = 0
      let hi = tails.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (cand[tails[mid]][0] < v) lo = mid + 1
        else hi = mid
      }
      if (lo > 0) prev[i] = tails[lo - 1]
      tails[lo] = i
    }
    const seq = []
    for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) seq.push(cand[k])
    return seq.reverse()
  }

  // base → other 的变动块列表：[{bs,be,os,oe,src}]（base 区间 [bs,be) 换成 src[os,oe)）。
  // 显式栈而非递归：极长文件里锚点可能只切掉一行，递归深度会打穿调用栈。
  function wkDiffBlocks(base, other, src) {
    const out = []
    const stack = [[0, base.length, 0, other.length]]
    while (stack.length) {
      let [as, ae, bs, be] = stack.pop()
      while (as < ae && bs < be && base[as] === other[bs]) { as++; bs++ }
      while (as < ae && bs < be && base[ae - 1] === other[be - 1]) { ae--; be-- }
      if (as === ae && bs === be) continue
      if (as === ae || bs === be) {
        out.push({ bs: as, be: ae, os: bs, oe: be, src })
        continue
      }
      const anchors = wkUniqueAnchors(base, as, ae, other, bs, be)
      if (!anchors.length) {
        out.push({ bs: as, be: ae, os: bs, oe: be, src })
        continue
      }
      let pa = as
      let pb = bs
      for (const [ai, bi] of anchors) {
        if (ai > pa || bi > pb) stack.push([pa, ai, pb, bi])
        pa = ai + 1
        pb = bi + 1
      }
      if (pa < ae || pb < be) stack.push([pa, ae, pb, be])
    }
    out.sort((x, y) => x.bs - y.bs || x.be - y.be || x.os - y.os)
    return out
  }

  function wkMerge3(base, local, remote) {
    const b0 = String(base == null ? '' : base)
    const l0 = String(local == null ? '' : local)
    const r0 = String(remote == null ? '' : remote)
    if (l0 === b0) return { ok: true, text: r0 } // 本地无改动：直接取磁盘版
    if (r0 === b0 || r0 === l0) return { ok: true, text: l0 } // 磁盘无改动 / 两侧一致
    const bl = wkMergeSplit(b0)
    const ll = wkMergeSplit(l0)
    const rl = wkMergeSplit(r0)
    if (bl.length > WK_MERGE_MAX_LINES || ll.length > WK_MERGE_MAX_LINES || rl.length > WK_MERGE_MAX_LINES) {
      return { ok: false, reason: 'too-large' }
    }
    const lb = wkDiffBlocks(bl, ll, ll)
    const rb = wkDiffBlocks(bl, rl, rl)
    // 冲突检测：两个块列表各自按 bs 升序且内部不重叠 → 双指针即可
    let i = 0
    let j = 0
    while (i < lb.length && j < rb.length) {
      const x = lb[i]
      const y = rb[j]
      if (wkBlocksOverlap(x, y)) return { ok: false, reason: 'conflict' }
      if (x.be <= y.bs) i++
      else j++
    }
    // 应用：按 base 位置顺序输出，插入块（be===bs）先于同起点的替换块
    const all = lb.concat(rb).sort((x, y) => x.bs - y.bs || x.be - y.be)
    const out = []
    let p = 0
    for (const b of all) {
      while (p < b.bs) out.push(bl[p++])
      for (let k = b.os; k < b.oe; k++) out.push(b.src[k])
      p = b.be
    }
    while (p < bl.length) out.push(bl[p++])
    return { ok: true, text: out.join('\n') }
  }

  // ---------- JSON Canvas 解析 ----------
  // spec 1.0：{nodes:[{id,type:'text'|'group',x,y,width,height,color?,text?}], edges:[{fromNode,
  // fromSide?,toNode,toSide?,toEnd?,label?,color?}]}；Obsidian 扩展 type:'file'|'link'（带 file/url）。
  // color = '1'..'6'（Obsidian 预设色板）或 '#hex'。坏 JSON / 缺 nodes 返 {err}。
  const WKCV_PRESET = { 1: '#e5534b', 2: '#e0823d', 3: '#d4b52c', 4: '#4caf62', 5: '#3fa7c4', 6: '#9a6ff0' }
  function wkCvColor(v) {
    if (!v) return ''
    if (WKCV_PRESET[v]) return WKCV_PRESET[v]
    if (/^#[0-9a-f]{3,8}$/i.test(v)) return v
    return ''
  }
  function wkCvRgba(hex, a) {
    const m = /^#([0-9a-f]{3,8})$/i.exec(hex)
    if (!m) return ''
    let h = m[1]
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
    return `rgba(${r},${g},${b},${a})`
  }
  function wkCvParse(text) {
    let j
    try { j = JSON.parse(text) } catch (e) { return { err: 'JSON 解析失败：' + (e.message || e) } }
    if (!j || !Array.isArray(j.nodes)) return { err: '不是有效的 JSON Canvas（缺 nodes 数组）' }
    const nodes = [], byId = new Map()
    for (const n of j.nodes) {
      if (!n || typeof n.id !== 'string' || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue
      const node = {
        id: n.id,
        type: n.type === 'group' ? 'group' : n.type === 'file' ? 'file' : n.type === 'link' ? 'link' : 'text',
        x: n.x, y: n.y,
        w: Number.isFinite(n.width) ? n.width : 240,
        h: Number.isFinite(n.height) ? n.height : 120,
        color: wkCvColor(n.color),
        text: typeof n.text === 'string' ? n.text : typeof n.file === 'string' ? n.file : typeof n.url === 'string' ? n.url : '',
        label: typeof n.label === 'string' ? n.label : '',
      }
      nodes.push(node)
      byId.set(node.id, node)
    }
    const edges = []
    if (Array.isArray(j.edges)) {
      for (const e of j.edges) {
        if (!e || !byId.has(e.fromNode) || !byId.has(e.toNode)) continue
        edges.push({ from: byId.get(e.fromNode), to: byId.get(e.toNode), fs: e.fromSide || '', ts: e.toSide || '', arrow: e.toEnd !== 'none', label: typeof e.label === 'string' ? e.label : '', color: wkCvColor(e.color) })
      }
    }
    return { nodes, edges, err: '' }
  }
  // 摘要行文案（画布顶栏）：计数 / 空图 / 错误。
  function wkCvSummary(d) {
    if (d.err) return d.err
    if (!d.nodes.length) return '空画布'
    return `${d.nodes.length} 节点 · ${d.edges.length} 连线`
  }

  // ---------- 手势原语（搬自 ComfyUI frontend src/lib/litegraph/src/canvas/reduceGesture.ts、
  // captureGesture.ts、measure.ts；逐行移植，仅把 TS 类型擦掉） ----------
  function wkCvDist2(x1, y1, x2, y2) {
    return (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)
  }
  function wkCvIsInRectangle(x, y, left, top, width, height) {
    return x >= left && y >= top && x < left + width && y < top + height
  }
  function wkCvSnapPoint(pos, snapTo, method) {
    if (!snapTo) return false
    method = method || 'round'
    pos[0] = snapTo * Math[method](pos[0] / snapTo)
    pos[1] = snapTo * Math[method](pos[1] / snapTo)
    return true
  }
  function wkCvOverlapBounding(a, b) {
    const aRight = a[0] + a[2], aBottom = a[1] + a[3]
    const bRight = b[0] + b[2], bBottom = b[1] + b[3]
    return a[0] > bRight || a[1] > bBottom || aRight < b[0] || aBottom < b[1] ? false : true
  }
  function wkCvContainsRect(a, b) {
    const aRight = a[0] + a[2], aBottom = a[1] + a[3]
    const bRight = b[0] + b[2], bBottom = b[1] + b[3]
    const identical = a[0] === b[0] && a[1] === b[1] && aRight === bRight && aBottom === bBottom
    return !identical && a[0] <= b[0] && a[1] <= b[1] && aRight >= bRight && aBottom >= bBottom
  }
  function wkCvWithin(a, b, distance) {
    return wkCvDist2(a.x, a.y, b.x, b.y) <= distance * distance
  }
  const WKCV_IDLE_GESTURE = Object.freeze({ phase: 'idle', lastClick: undefined })
  function wkCvGestureUnchanged(state) {
    return { state, effects: [] }
  }
  function wkCvIsDoubleClick(state) {
    const { lastClick, origin, timeStamp, policy } = state
    if (!lastClick) return false
    const gap = timeStamp - lastClick.timeStamp
    return (
      gap > 0 &&
      gap < policy.doubleClickTime &&
      wkCvWithin(origin, lastClick.position, 3 * policy.maxClickDrift)
    )
  }
  function wkCvReduceIdle(state, event) {
    switch (event.type) {
      case 'down':
        return {
          state: {
            phase: 'pressed',
            origin: event.position,
            timeStamp: event.timeStamp,
            policy: event.policy,
            lastClick: state.lastClick
          },
          effects: []
        }
      case 'move':
      case 'up':
      case 'cancel':
        return wkCvGestureUnchanged(state)
      default:
        return wkCvGestureUnchanged(state)
    }
  }
  function wkCvReducePressed(state, event) {
    const { origin, policy, lastClick } = state
    switch (event.type) {
      case 'move':
        if (wkCvWithin(event.position, origin, policy.maxClickDrift))
          return { state, effects: ['movePress'] }
        return {
          state: { phase: 'dragging', lastClick },
          effects: ['startDrag', 'moveDrag']
        }
      case 'up':
        if (!wkCvWithin(event.position, origin, policy.maxClickDrift))
          return {
            state: { phase: 'idle', lastClick },
            effects: ['startDrag', 'endDrag']
          }
        if (event.acceptsDoubleClick && wkCvIsDoubleClick(state))
          return { state: WKCV_IDLE_GESTURE, effects: ['doubleClick'] }
        return {
          state: {
            phase: 'idle',
            lastClick: { position: origin, timeStamp: state.timeStamp }
          },
          effects: ['click']
        }
      case 'cancel':
        return { state: { phase: 'idle', lastClick }, effects: [] }
      case 'down':
        return wkCvGestureUnchanged(state)
      default:
        return wkCvGestureUnchanged(state)
    }
  }
  function wkCvReduceDragging(state, event) {
    const { lastClick } = state
    switch (event.type) {
      case 'move':
        return { state, effects: ['moveDrag'] }
      case 'up':
        return { state: { phase: 'idle', lastClick }, effects: ['endDrag'] }
      case 'cancel':
        return { state: { phase: 'idle', lastClick }, effects: ['cancelDrag'] }
      case 'down':
        return wkCvGestureUnchanged(state)
      default:
        return wkCvGestureUnchanged(state)
    }
  }
  function wkCvReduceGesture(state, event) {
    switch (state.phase) {
      case 'idle':
        return wkCvReduceIdle(state, event)
      case 'pressed':
        return wkCvReducePressed(state, event)
      case 'dragging':
        return wkCvReduceDragging(state, event)
      default:
        return wkCvGestureUnchanged(state)
    }
  }
  // 对应的 ComfyUI captureGesture.ts：按下即捕获；lostpointercapture（同 pointerId）视为中断。
  function wkCvCaptureGesture(element, pointerId, onInterrupt) {
    function onLostPointerCapture(event) {
      if ('pointerId' in event && event.pointerId === pointerId) onInterrupt()
    }
    element.setPointerCapture(pointerId)
    element.addEventListener('lostpointercapture', onLostPointerCapture)
    return () => {
      element.removeEventListener('lostpointercapture', onLostPointerCapture)
      if (element.hasPointerCapture(pointerId))
        element.releasePointerCapture(pointerId)
    }
  }

  // ---------- 选择意图（搬自 ComfyUI frontend src/core/selection/selectionIntent.ts） ----------
  function wkCvHasToggleModifier(modifiers) {
    return Boolean(modifiers && (modifiers.shiftKey || modifiers.ctrlKey || modifiers.metaKey))
  }
  function wkCvResolveClickSelection(ctx) {
    const { hasItem, isSelected, modifiers, multiSelect, selectOnly, sticky } = ctx
    const toggling = wkCvHasToggleModifier(modifiers)
    if (!hasItem) {
      if (selectOnly) return 'none'
      return !toggling || multiSelect ? 'clear' : 'none'
    }
    const modifying = toggling || multiSelect || selectOnly
    if (!isSelected) return modifying ? 'add' : 'replace'
    if (sticky) return 'none'
    return modifying ? 'remove' : 'replace'
  }
  function wkCvResolveMarqueeSelection(modifiers) {
    if (modifiers.shiftKey) return 'add'
    if (modifiers.altKey) return 'subtract'
    return 'replace'
  }
  function wkCvApplyMarqueeSelection(intent, current, enclosed) {
    switch (intent) {
      case 'add':
        return new Set([...current, ...enclosed])
      case 'subtract':
        return new Set([...current].filter((item) => !enclosed.has(item)))
      case 'replace':
        return new Set(enclosed)
      default:
        return new Set(current)
    }
  }

  // ---------- CanvasPointer（搬自 ComfyUI frontend .../CanvasPointer.ts） ----------
  // 构造时不清状态；down/move/up 调 reduceGesture，回调按 effects 派发。触控板/鼠标识别逐行保留。
  class WkCvCanvasPointer {
    constructor(element) {
      this.element = element
      this.pointerId = undefined
      this.state = WKCV_IDLE_GESTURE
      this.releaseCapture = undefined
      this.isDouble = false
      this.isDown = false
      this.resizeDirection = undefined
      this.clearEventsOnReset = true
      this.eDown = undefined
      this.eMove = undefined
      this.eUp = undefined
      this.detectedDevice = 'mouse'
      this.lastWheelEventTime = 0
      this.hasReceivedWheelEvent = false
      this.bufferedLinuxEvent = undefined
      this.bufferedLinuxEventTime = 0
      this.linuxBufferTimeoutId = undefined
      this._finally = undefined

      this.onDragStart = undefined
      this.onDrag = undefined
      this.onDragEnd = undefined
      this.onDragCancel = undefined
      this.onClick = undefined
      this.onDoubleClick = undefined
    }
    get dragStarted() {
      return this.state.phase === 'dragging'
    }
    static gesturePolicy() {
      return {
        maxClickDrift: WkCvCanvasPointer.maxClickDrift,
        doubleClickTime: WkCvCanvasPointer.doubleClickTime
      }
    }
    get finally() {
      return this._finally
    }
    set finally(value) {
      try {
        if (this._finally) this._finally()
      } finally {
        this._finally = value
      }
    }
    down(e) {
      this.reset()
      this.eDown = e
      this.pointerId = e.pointerId
      this.releaseCapture = wkCvCaptureGesture(this.element, e.pointerId, () =>
        this.reset()
      )
      this.dispatch(
        {
          type: 'down',
          position: { x: e.clientX, y: e.clientY },
          timeStamp: e.timeStamp,
          policy: WkCvCanvasPointer.gesturePolicy()
        },
        e
      )
    }
    move(e) {
      const { eDown } = this
      if (!eDown) return
      if (!(e.buttons & eDown.buttons)) {
        if (this.state.phase !== 'idle') {
          this.eUp = e
          this.dispatch(this.upEvent(e), e)
        }
        this.reset()
        return
      }
      this.eMove = e
      this.dispatch({ type: 'move', position: { x: e.clientX, y: e.clientY } }, e)
    }
    up(e) {
      if (e.button !== (this.eDown && this.eDown.button)) return false
      this.eUp = e
      const effects = this.dispatch(this.upEvent(e), e)
      this.reset()
      return effects.indexOf('endDrag') === -1
    }
    upEvent(e) {
      return {
        type: 'up',
        position: { x: e.clientX, y: e.clientY },
        acceptsDoubleClick: !!this.onDoubleClick
      }
    }
    dispatch(event, e) {
      const { state, effects } = wkCvReduceGesture(this.state, event)
      this.state = state
      const eMove = event.type === 'move' ? e : undefined
      const handlers = {
        click: () => { if (this.onClick) this.onClick(e) },
        doubleClick: () => { if (this.onDoubleClick) this.onDoubleClick(e) },
        startDrag: () => {
          if (this.onDragStart) this.onDragStart(this, eMove)
          delete this.onDragStart
        },
        movePress: () => { if (this.onDrag) this.onDrag(e) },
        moveDrag: () => { if (this.onDrag) this.onDrag(e) },
        endDrag: () => { if (this.onDragEnd) this.onDragEnd(e) },
        cancelDrag: () => { if (this.onDragCancel) this.onDragCancel() }
      }
      for (const effect of effects) handlers[effect]()
      return effects
    }
    isTrackpadGesture(e) {
      const now = performance.now()
      const timeSinceLastEvent = Math.max(0, now - this.lastWheelEventTime)
      this.lastWheelEventTime = now
      if (this._isHighResWheelEvent(e, now)) {
        this.detectedDevice = 'mouse'
      } else if (this._isWithinCooldown(timeSinceLastEvent)) {
        if (this._shouldBufferLinuxEvent(e)) this._bufferLinuxEvent(e, now)
      } else {
        this._updateDeviceMode(e, now)
        this.hasReceivedWheelEvent = true
      }
      return this.detectedDevice === 'trackpad'
    }
    _isHighResWheelEvent(event, now) {
      if (!this.bufferedLinuxEvent || this.bufferedLinuxEventTime <= 0) return false
      const timeSinceBuffer = now - this.bufferedLinuxEventTime
      if (timeSinceBuffer > WkCvCanvasPointer.maxHighResBufferTime) {
        this._clearLinuxBuffer()
        return false
      }
      if (event.deltaX === 0 && this._isLinuxWheelPattern(this.bufferedLinuxEvent.deltaY, event.deltaY)) {
        this._clearLinuxBuffer()
        return true
      }
      return false
    }
    _isWithinCooldown(timeSinceLastEvent) {
      const isFirstEvent = !this.hasReceivedWheelEvent
      const cooldownExpired = timeSinceLastEvent >= WkCvCanvasPointer.trackpadMaxGap
      return !isFirstEvent && !cooldownExpired
    }
    _updateDeviceMode(event, now) {
      if (this._isTrackpadPattern(event)) {
        this.detectedDevice = 'trackpad'
      } else if (this._isMousePattern(event)) {
        this.detectedDevice = 'mouse'
      } else if (this.detectedDevice === 'trackpad' && this._shouldBufferLinuxEvent(event)) {
        this._bufferLinuxEvent(event, now)
      }
    }
    _clearLinuxBuffer() {
      this.bufferedLinuxEvent = undefined
      this.bufferedLinuxEventTime = 0
      if (this.linuxBufferTimeoutId !== undefined) {
        clearTimeout(this.linuxBufferTimeoutId)
        this.linuxBufferTimeoutId = undefined
      }
    }
    _isTrackpadPattern(event) {
      if (event.deltaX !== 0 && event.deltaY !== 0) return true
      if (event.ctrlKey && Math.abs(event.deltaY) < 10) return true
      return false
    }
    _isMousePattern(event) {
      const absoluteDeltaY = Math.abs(event.deltaY)
      if (absoluteDeltaY > 80) return true
      return absoluteDeltaY >= 60 && event.deltaX === 0 && this.detectedDevice === 'mouse'
    }
    _shouldBufferLinuxEvent(event) {
      const absoluteDeltaY = Math.abs(event.deltaY)
      const isInLinuxRange = absoluteDeltaY >= 10 && absoluteDeltaY < 60
      const isVerticalOnly = event.deltaX === 0
      const hasIntegerDelta = Number.isInteger(event.deltaY)
      return this.detectedDevice === 'trackpad' && isInLinuxRange && isVerticalOnly && hasIntegerDelta
    }
    _bufferLinuxEvent(event, now) {
      if (this.linuxBufferTimeoutId !== undefined) clearTimeout(this.linuxBufferTimeoutId)
      this.bufferedLinuxEvent = event
      this.bufferedLinuxEventTime = now
      this.linuxBufferTimeoutId = setTimeout(() => {
        this._clearLinuxBuffer()
      }, WkCvCanvasPointer.maxHighResBufferTime)
    }
    _isLinuxWheelPattern(deltaY1, deltaY2) {
      const absolute1 = Math.abs(deltaY1)
      const absolute2 = Math.abs(deltaY2)
      if (absolute1 === 0 || absolute2 === 0) return false
      if (absolute1 === absolute2) return true
      return absolute1 % absolute2 === 0 || absolute2 % absolute1 === 0
    }
    reset() {
      const { releaseCapture } = this
      this.releaseCapture = undefined
      this.pointerId = undefined
      if (releaseCapture) releaseCapture()
      try {
        if (this.eDown) this.dispatch({ type: 'cancel' }, this.eDown)
      } finally {
        try {
          this.finally = undefined
        } finally {
          delete this.onClick
          delete this.onDoubleClick
          delete this.onDragStart
          delete this.onDrag
          delete this.onDragEnd
          delete this.onDragCancel
          this.isDown = false
          this.isDouble = false
          this.resizeDirection = undefined
          if (this.clearEventsOnReset) {
            this.eDown = undefined
            this.eMove = undefined
            this.eUp = undefined
          }
        }
      }
    }
  }
  WkCvCanvasPointer.doubleClickTime = 300
  WkCvCanvasPointer.maxClickDrift = 6
  WkCvCanvasPointer.trackpadThreshold = 60
  WkCvCanvasPointer.trackpadMaxGap = 500
  WkCvCanvasPointer.maxHighResBufferTime = 10

  // ---------- DragAndScale（搬自 ComfyUI frontend src/lib/litegraph/src/DragAndScale.ts） ----------
  class WkCvDragAndScale {
    constructor(element) {
      this.state = { offset: [0, 0], scale: 1 }
      this.lastState = { offset: [0, 0], scale: 0 }
      this.max_scale = 10
      this.min_scale = 0.1
      this.enabled = true
      this.last_mouse = [0, 0]
      this.visible_area = [0, 0, 0, 0]
      this.element = element
      this.viewportSize = undefined
      this._animationId = 0
      this.onredraw = undefined
      this.onChanged = undefined
    }
    get offset() { return this.state.offset }
    set offset(value) { this.state.offset[0] = value[0]; this.state.offset[1] = value[1] }
    get scale() { return this.state.scale }
    set scale(value) { this.state.scale = value }
    _stateHasChanged() {
      const current = this.state, previous = this.lastState
      return (
        current.scale !== previous.scale ||
        current.offset[0] !== previous.offset[0] ||
        current.offset[1] !== previous.offset[1]
      )
    }
    computeVisibleArea(viewport) {
      const { scale, offset, visible_area } = this
      if (this._stateHasChanged()) {
        if (this.onChanged) this.onChanged(scale, offset)
        this.lastState.scale = this.state.scale
        this.lastState.offset[0] = offset[0]
        this.lastState.offset[1] = offset[1]
      }
      let size = this.getViewportSize()
      let width = size[0], height = size[1]
      let startx = -offset[0]
      let starty = -offset[1]
      if (viewport) {
        startx += viewport[0] / scale
        starty += viewport[1] / scale
        width = viewport[2]
        height = viewport[3]
      }
      const endx = startx + width / scale
      const endy = starty + height / scale
      visible_area[0] = startx
      visible_area[1] = starty
      visible_area[2] = Math.max(0, endx - startx)
      visible_area[3] = Math.max(0, endy - starty)
      return visible_area
    }
    setViewportSize(width, height) {
      this.viewportSize =
        width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)
          ? [width, height]
          : undefined
    }
    invalidateViewportSize() {
      this.viewportSize = undefined
    }
    getViewportSize() {
      const cached = this.viewportSize
      if (cached) return [cached[0], cached[1]]
      const rect = this.element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) return [rect.width, rect.height]
      const dpr = window.devicePixelRatio || 1
      return [this.element.width / dpr, this.element.height / dpr]
    }
    toCanvasContext(ctx) {
      ctx.scale(this.scale, this.scale)
      ctx.translate(this.offset[0], this.offset[1])
    }
    convertOffsetToCanvas(pos) {
      return [
        (pos[0] + this.offset[0]) * this.scale,
        (pos[1] + this.offset[1]) * this.scale
      ]
    }
    convertCanvasToOffset(pos, out) {
      out = out || [0, 0]
      out[0] = pos[0] / this.scale - this.offset[0]
      out[1] = pos[1] / this.scale - this.offset[1]
      return out
    }
    mouseDrag(x, y) {
      this.offset[0] += x / this.scale
      this.offset[1] += y / this.scale
      if (this.onredraw) this.onredraw(this)
    }
    changeScale(value, zooming_center, roundToScaleOne) {
      if (roundToScaleOne === undefined) roundToScaleOne = true
      if (value < this.min_scale) {
        value = this.min_scale
      } else if (value > this.max_scale) {
        value = this.max_scale
      }
      if (value == this.scale) return
      const rect = this.element.getBoundingClientRect()
      zooming_center = zooming_center || [rect.width * 0.5, rect.height * 0.5]
      const normalizedCenter = [zooming_center[0] - rect.x, zooming_center[1] - rect.y]
      const center = this.convertCanvasToOffset(normalizedCenter)
      this.scale = value
      if (roundToScaleOne && Math.abs(this.scale - 1) < 0.01) this.scale = 1
      const new_center = this.convertCanvasToOffset(normalizedCenter)
      const delta_offset = [new_center[0] - center[0], new_center[1] - center[1]]
      this.offset[0] += delta_offset[0]
      this.offset[1] += delta_offset[1]
      if (this.onredraw) this.onredraw(this)
    }
    changeDeltaScale(value, zooming_center) {
      this.changeScale(this.scale * value, zooming_center)
    }
    fitToBounds(bounds, opts) {
      opts = opts || {}
      const zoom = opts.zoom === undefined ? 0.75 : opts.zoom
      const viewport = opts.viewport
      const size =
        this.element.width === 300 && this.element.height === 150
          ? [1920, 1080]
          : this.getViewportSize()
      const width = size[0], height = size[1]
      const rect = viewport || [0, 0, width, height]
      const vx = rect[0], vy = rect[1], vw = rect[2], vh = rect[3]
      if (!(vw > 0) || !(vh > 0)) return
      let targetScale = this.scale
      if (zoom > 0) {
        const targetScaleX = (zoom * vw) / Math.max(bounds[2], 300)
        const targetScaleY = (zoom * vh) / Math.max(bounds[3], 300)
        targetScale = Math.min(targetScaleX, targetScaleY, this.max_scale)
      }
      const targetX = (vx + vw * 0.5) / targetScale - bounds[0] - bounds[2] * 0.5
      const targetY = (vy + vh * 0.5) / targetScale - bounds[1] - bounds[3] * 0.5
      this.offset[0] = targetX
      this.offset[1] = targetY
      this.scale = targetScale
    }
    animateToBounds(bounds, setDirty, opts) {
      opts = opts || {}
      const duration = opts.duration === undefined ? 350 : opts.duration
      const zoom = opts.zoom === undefined ? 0.75 : opts.zoom
      const easing = opts.easing || 'easeInOutQuad'
      const viewport = opts.viewport
      if (!(duration > 0)) throw new RangeError('Duration must be greater than 0')
      const easeFunctions = {
        linear: (t) => t,
        easeInQuad: (t) => t * t,
        easeOutQuad: (t) => t * (2 - t),
        easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t)
      }
      const easeFunction = easeFunctions[easing]
      const startTimestamp = performance.now()
      const size = this.getViewportSize()
      const cw = size[0], ch = size[1]
      const rect = viewport || [0, 0, cw, ch]
      const vx = rect[0], vy = rect[1], vw = rect[2], vh = rect[3]
      if (!(vw > 0) || !(vh > 0)) return
      const startX = this.offset[0]
      const startY = this.offset[1]
      const startX2 = startX - cw / this.scale
      const startY2 = startY - ch / this.scale
      const startScale = this.scale
      let targetScale = startScale
      if (zoom > 0) {
        const targetScaleX = (zoom * vw) / Math.max(bounds[2], 300)
        const targetScaleY = (zoom * vh) / Math.max(bounds[3], 300)
        targetScale = Math.min(targetScaleX, targetScaleY, this.max_scale)
      }
      const scaledWidth = cw / targetScale
      const scaledHeight = ch / targetScale
      const targetX = (vx + vw * 0.5) / targetScale - bounds[0] - bounds[2] * 0.5
      const targetY = (vy + vh * 0.5) / targetScale - bounds[1] - bounds[3] * 0.5
      const targetX2 = targetX - scaledWidth
      const targetY2 = targetY - scaledHeight
      const animate = (timestamp) => {
        const elapsed = timestamp - startTimestamp
        const progress = Math.min(elapsed / duration, 1)
        const easedProgress = easeFunction(progress)
        this.offset[0] = startX + (targetX - startX) * easedProgress
        this.offset[1] = startY + (targetY - startY) * easedProgress
        if (zoom > 0) {
          const currentX2 = startX2 + (targetX2 - startX2) * easedProgress
          const currentY2 = startY2 + (targetY2 - startY2) * easedProgress
          const currentWidth = Math.abs(currentX2 - this.offset[0])
          const currentHeight = Math.abs(currentY2 - this.offset[1])
          this.scale = Math.min(cw / currentWidth, ch / currentHeight)
        }
        setDirty()
        if (progress < 1) {
          this._animationId = requestAnimationFrame(animate)
        } else {
          cancelAnimationFrame(this._animationId)
          this._animationId = 0
        }
      }
      this._animationId = requestAnimationFrame(animate)
    }
    cancelAnimation() {
      if (this._animationId) cancelAnimationFrame(this._animationId)
      this._animationId = 0
    }
    reset() {
      this.scale = 1
      this.offset[0] = 0
      this.offset[1] = 0
    }
  }

  // ---------- 相机 ----------
  // 模块级单份：docChanged 重建 widget 时保留视口与选择。DragAndScale 需要元素做指针锚定，
  // 真实元素每次重建都会换，故用转发壳（永远指向当前舞台 canvas 的 rect / 像素尺寸）。
  const WKCV_GRID = 24
  const WKCV_SNAP = 24
  const WKCV_MIN_SIZE = [40, 30]
  const WKCV_RESIZE_HANDLE = 15
  const WKCV_CLIP_KEY = 'floria.canvas.clipboard'
  let wkCvCamHost = null
  const wkCvCamEl = {
    get width() { return wkCvCamHost ? wkCvCamHost.width : 0 },
    get height() { return wkCvCamHost ? wkCvCamHost.height : 0 },
    getBoundingClientRect() {
      if (wkCvCamHost) return wkCvCamHost.getBoundingClientRect()
      return { x: 0, y: 0, width: 600, height: 400 }
    }
  }
  const wkCvDs = new WkCvDragAndScale(wkCvCamEl)
  let wkCvCamFile = ''
  let wkCvSelFile = ''
  let wkCvSelIds = new Set()

  function wkCvToScreen(x, y) { return wkCvDs.convertOffsetToCanvas([x, y]) }
  function wkCvToWorld(sx, sy) { return wkCvDs.convertCanvasToOffset([sx, sy]) }

  // 节点某侧的锚点（世界坐标）；side 缺省返回 null，由调用方按相对方位就近取。
  function wkCvAnchor(n, side) {
    if (side === 'left') return [n.x, n.y + n.h / 2]
    if (side === 'right') return [n.x + n.w, n.y + n.h / 2]
    if (side === 'top') return [n.x + n.w / 2, n.y]
    if (side === 'bottom') return [n.x + n.w / 2, n.y + n.h]
    return null
  }
  // 连线几何：端点锚 + 出线方向法线。显式 fromSide/toSide 按声明取锚与法线；缺省按两节点中心
  // 连线的主轴取最近侧（水平位移为主取左/右、竖直为主取上/下）。
  const WKCV_SIDE_DIRS = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] }
  function wkCvAnchorDir(n, side, tx, ty) {
    if (side && WKCV_SIDE_DIRS[side]) {
      const p = wkCvAnchor(n, side)
      if (p) return { p, n: WKCV_SIDE_DIRS[side], side }
    }
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2
    if (Math.abs(tx - cx) >= Math.abs(ty - cy)) {
      return tx < cx
        ? { p: [n.x, cy], n: WKCV_SIDE_DIRS.left, side: 'left' }
        : { p: [n.x + n.w, cy], n: WKCV_SIDE_DIRS.right, side: 'right' }
    }
    return ty < cy
      ? { p: [cx, n.y], n: WKCV_SIDE_DIRS.top, side: 'top' }
      : { p: [cx, n.y + n.h], n: WKCV_SIDE_DIRS.bottom, side: 'bottom' }
  }
  function wkCvEdgeGeom(e) {
    const A = wkCvAnchorDir(e.from, e.fs, e.to.x + e.to.w / 2, e.to.y + e.to.h / 2)
    const B = wkCvAnchorDir(e.to, e.ts, e.from.x + e.from.w / 2, e.from.y + e.from.h / 2)
    const a = A.p, b = B.p
    const kA = Math.max(24, Math.abs((b[0] - a[0]) * A.n[0] + (b[1] - a[1]) * A.n[1]) / 2)
    const kB = Math.max(24, Math.abs((b[0] - a[0]) * B.n[0] + (b[1] - a[1]) * B.n[1]) / 2)
    const c1 = [a[0] + A.n[0] * kA, a[1] + A.n[1] * kA]
    const c2 = [b[0] + B.n[0] * kB, b[1] + B.n[1] * kB]
    // 三次贝塞尔 t=0.5：(P0 + 3P1 + 3P2 + P3) / 8（放 label）
    const mx = (a[0] + 3 * c1[0] + 3 * c2[0] + b[0]) / 8
    const my = (a[1] + 3 * c1[1] + 3 * c2[1] + b[1]) / 8
    return { a, c1, c2, b, mx, my, fs: A.side, ts: B.side }
  }
  function wkCvBezierPoint(g, t) {
    const u = 1 - t
    return [
      u * u * u * g.a[0] + 3 * u * u * t * g.c1[0] + 3 * u * t * t * g.c2[0] + t * t * t * g.b[0],
      u * u * u * g.a[1] + 3 * u * u * t * g.c1[1] + 3 * u * t * t * g.c2[1] + t * t * t * g.b[1]
    ]
  }
  function wkCvDistToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
    t = Math.max(0, Math.min(1, t))
    return Math.sqrt(wkCvDist2(px, py, ax + t * dx, ay + t * dy))
  }

  // ---------- 画布绘制（2D context；世界坐标 → 屏幕统一乘相机） ----------
  const WKCV_FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif'
  // 主题色快照（每次重绘读一次；canvas 不认 CSS 变量）
  function wkCvTheme() {
    const cs = getComputedStyle(document.documentElement)
    const g = (n, d) => (cs.getPropertyValue(n) || '').trim() || d
    return {
      bg: g('--bg', '#fff'), text: g('--text', '#222'), text2: g('--text-2', '#555'),
      text3: g('--text-3', '#888'), border: g('--border', '#ddd'), blue: g('--blue', '#4d6bfe'),
    }
  }
  // 文本按像素宽度折行（CJK 可逐字断、拉丁词优先整词）。返回行数组，最多 maxLines 行。
  function wkCvWrap(ctx, text, maxW, maxLines) {
    const out = []
    for (const para of String(text == null ? '' : text).split('\n')) {
      if (out.length >= maxLines) return out
      let line = ''
      let word = ''
      const flushWord = () => { line += word; word = '' }
      for (const ch of para) {
        if (ch === ' ') { flushWord(); line += ch; continue }
        // 拉丁字母数字成词，其它（CJK/标点）逐字
        if (/[A-Za-z0-9_@#$%&*+\-/\\=.:;'"!?()\[\]{}<>]/.test(ch)) { word += ch; continue }
        flushWord()
        if (line && ctx.measureText(line + ch).width > maxW) { out.push(line); line = ''; if (out.length >= maxLines) return out }
        line += ch
      }
      flushWord()
      if (line && ctx.measureText(line).width > maxW) {
        // 整词超宽：逐字硬断
        let cur = ''
        for (const ch of line) {
          if (cur && ctx.measureText(cur + ch).width > maxW) { out.push(cur); cur = ''; if (out.length >= maxLines) return out }
          cur += ch
        }
        line = cur
      }
      if (line || !para) out.push(line)
    }
    return out
  }
  function wkCvRoundRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2))
    ctx.beginPath()
    ctx.moveTo(x + rr, y)
    ctx.lineTo(x + w - rr, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr)
    ctx.lineTo(x + w, y + h - rr)
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
    ctx.lineTo(x + rr, y + h)
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr)
    ctx.lineTo(x, y + rr)
    ctx.quadraticCurveTo(x, y, x + rr, y)
    ctx.closePath()
  }
  // 给解析出的节点挂上 Positionable 形态（搬运代码按 node.pos / node.size / node.boundingRect /
  // node.move / node.children 写；此处只做数据层适配，行为仍由搬来的逻辑驱动）。
  function wkCvAttachNodeApi(node, data) {
    Object.defineProperties(node, {
      pos: {
        get() { return [this.x, this.y] },
        set(v) { this.x = v[0]; this.y = v[1] },
        enumerable: false,
        configurable: true,
      },
      size: {
        get() { return [this.w, this.h] },
        set(v) { this.w = v[0]; this.h = v[1] },
        enumerable: false,
        configurable: true,
      },
      boundingRect: {
        get() { return [this.x, this.y, this.w, this.h] },
        enumerable: false,
        configurable: true,
      },
      children: {
        get() {
          if (this.type !== 'group') return undefined
          return data.nodes.filter((m) => {
            if (m === this || m.type === 'group') return false
            const cx = m.x + m.w / 2, cy = m.y + m.h / 2
            return cx >= this.x && cx <= this.x + this.w && cy >= this.y && cy <= this.y + this.h
          })
        },
        enumerable: false,
        configurable: true,
      },
      pinned: { value: false, enumerable: false, configurable: true },
      move: {
        value(dx, dy) { this.x += dx; this.y += dy },
        enumerable: false,
        configurable: true,
      },
    })
    return node
  }
  // 拖拽集合：搬 ComfyUI utils/collections.ts getDraggedItems / getAllNestedItems ——
  // 无 Ctrl/⌘ 时，拖组同时带上组内成员；按下 Ctrl/⌘ 只移动组本身。
  function wkCvGetDraggedItems(selected, event) {
    const moveGroupOnly = event.ctrlKey || event.metaKey
    if (moveGroupOnly) return new Set(selected)
    const all = new Set()
    const addRecursively = (item) => {
      if (all.has(item) || item.pinned) return
      all.add(item)
      if (item.children) for (const child of item.children) addRecursively(child)
    }
    for (const item of selected) addRecursively(item)
    return all
  }
  function wkCvNewId() {
    return 'wk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  }

  // ---------- 图形编辑（拖动/缩放/连线/增删改；写入 = 原样改写源 JSON 再整篇 dispatch 回编辑器
  // 文档——保留源里本前端不识别的扩展字段，写回后走既有自动保存链落盘。拖动过程只改内存坐标，
  // 手势结束才一次性写文档（一次手势 = 一次编辑 = 一条撤销步）。 ----------
  function wkCvWriteDoc(view, j) {
    try {
      const text = JSON.stringify(j, null, 2) + '\n'
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    } catch { /* 编辑器已销毁（切文件竞速）：丢弃本次手势 */ }
  }
  function wkCvRawNode(raw, id) {
    return (Array.isArray(raw && raw.nodes) ? raw.nodes : []).find((x) => x && x.id === id) || null
  }
  function wkCvReadRaw(text) {
    try { return JSON.parse(text) } catch { return null }
  }
  // 行内编辑（ComfyUI 同构：编辑态 = DOM 覆盖层里的 textarea，画布手势整体关闭）：
  // Enter / blur 提交，Escape 取消，Shift+Enter 换行。写入 = 源 JSON 上已有的那个字段（不新增键）。
  function wkCvOpenEditor(view, root, overlay, data, raw, rect, n) {
    if (root.classList.contains('wk-cv-editing')) return
    root.classList.add('wk-cv-editing')
    const ta = document.createElement('textarea')
    ta.className = 'wk-cv-edit'
    ta.style.left = Math.max(0, rect.x) + 'px'
    ta.style.top = Math.max(0, rect.y) + 'px'
    ta.style.width = Math.max(80, rect.w) + 'px'
    ta.style.height = Math.max(48, rect.h) + 'px'
    const rn = n.isEdge ? null : wkCvRawNode(raw, n.id)
    ta.value = n.isEdge
      ? String(n.label || '')
      : n.type === 'group'
        ? String((rn && rn.label) || '')
        : String((rn && (rn.text ?? rn.file ?? rn.url)) || '')
    overlay.appendChild(ta)
    let done = false
    const close = () => {
      if (done) return
      done = true
      root.classList.remove('wk-cv-editing')
      if (ta.parentElement) ta.parentElement.removeChild(ta)
    }
    const commit = () => {
      if (done) return
      const val = ta.value
      close()
      if (n.isEdge) {
        const idx = (Array.isArray(raw.edges) ? raw.edges : []).findIndex(
          (e) => e && e.fromNode === n.from.id && e.toNode === n.to.id
        )
        if (idx < 0) return
        raw.edges[idx].label = val
      } else {
        const target = wkCvRawNode(raw, n.id)
        if (!target) return
        if (n.type === 'group') target.label = val
        else if ('text' in target) target.text = val
        else if ('file' in target) target.file = val
        else if ('url' in target) target.url = val
      }
      wkCvWriteDoc(view, raw)
    }
    ta.addEventListener('pointerdown', (e) => e.stopPropagation())
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close() }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit() }
    })
    ta.addEventListener('blur', commit)
    ta.focus()
    ta.select()
  }

  // ---------- 画布视图（LGraphCanvas 的 processMouse* 结构；数据层 = JSON Canvas） ----------
  class WkCvGraphView {
    constructor(root, stage, canvas, overlay, view, text) {
      this.root = root
      this.stage = stage
      this.canvas = canvas
      this.overlay = overlay
      this.view = view
      this.text = text
      this.data = wkCvParse(text)
      this.wrapCache = new Map()
      this.pointer = new WkCvCanvasPointer(canvas)
      this.selected = new Set()
      this.dragMoved = new Set()
      this.state = {
        dragging_canvas: false,
        dragging_rectangle: null,
        isDragging: false,
        resizing_node: null,
        node_over: null,
        last_mouse: [0, 0],
        graph_mouse: [0, 0],
        link: null,
      }
      this._spaceKeyHeld = null
      this._lastDragModifiers = { ctrlKey: false, metaKey: false }
      this._lastMousePosition = [0, 0]
      this.dirty_bg = true
      this.dirty_fg = true
      this._raf = 0
      this._destroyed = false
      this.theme = wkCvTheme()

      for (const n of this.data.nodes) wkCvAttachNodeApi(n, this.data)
      this.restoreSelection()
      this.bindEvents()
      this.startRendering()
      this.fitIfNeeded()
    }

    // ---- 选择持久化（docChanged 重建 widget 后恢复；换文件清空） ----
    restoreSelection() {
      if (wkCvSelFile !== state.workFile) {
        wkCvSelFile = state.workFile
        wkCvSelIds = new Set()
      }
      const byId = new Map(this.data.nodes.map((n) => [n.id, n]))
      for (const id of wkCvSelIds) {
        const n = byId.get(id)
        if (n) this.selected.add(n)
      }
    }
    persistSelection() {
      wkCvSelFile = state.workFile
      wkCvSelIds = new Set([...this.selected].filter((n) => n && n.id).map((n) => n.id))
    }

    // ---- 相机 ----
    fitIfNeeded() {
      wkCvCamHost = this.canvas
      // toDOM 返回前 widget 尚未挂进文档，clientWidth/Height 为 0。等 ResizeObserver 报出真实尺寸再取景，
      // 否则会以 1×1 视口算缩放并把相机锁在错误位置（本轮取景由 RO 回调补跑）。
      const cw = this.stage.clientWidth
      const ch = this.stage.clientHeight
      if (cw <= 2 || ch <= 2) return
      wkCvDs.setViewportSize(cw, ch)
      if (wkCvCamFile === state.workFile) return
      wkCvCamFile = state.workFile
      const b = this.bounds()
      if (!b) return
      wkCvDs.animateToBounds(b, () => this.setDirty(true, true), {
        zoom: 0.75,
        viewport: [0, 0, cw, ch],
      })
    }
    bounds() {
      if (!this.data.nodes.length) return null
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const n of this.data.nodes) {
        x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y)
        x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h)
      }
      return [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)]
    }

    // ---- 渲染循环（搬 ComfyUI：持续 rAF + dirty_bgcanvas / dirty_canvas） ----
    startRendering() {
      const loop = () => {
        if (this._destroyed) return
        if (this.dirty_bg) {
          this.paintBackground()
          this.dirty_bg = false
        }
        if (this.dirty_fg) {
          this.paintForeground()
          this.dirty_fg = false
        }
        this._raf = requestAnimationFrame(loop)
      }
      this._raf = requestAnimationFrame(loop)
    }
    setDirty(fg, bg) {
      if (fg) this.dirty_fg = true
      if (bg) this.dirty_bg = true
    }
    resizeCanvas(canvas) {
      const dpr = window.devicePixelRatio || 1
      const cw = Math.max(1, this.stage.clientWidth)
      const ch = Math.max(1, this.stage.clientHeight)
      const pw = Math.round(cw * dpr), ph = Math.round(ch * dpr)
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw
        canvas.height = ph
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cw, ch)
      return { ctx, dpr, cw, ch }
    }
    orderedNodes() {
      const groups = this.data.nodes.filter((n) => n.type === 'group')
      const rest = this.data.nodes.filter((n) => n.type !== 'group')
      return groups.concat(rest)
    }
    visible() {
      return wkCvDs.computeVisibleArea(undefined)
    }
    inView(n, v, margin) {
      margin = margin || 0
      return !(
        n.x + n.w < v[0] - margin ||
        n.y + n.h < v[1] - margin ||
        n.x > v[0] + v[2] + margin ||
        n.y > v[1] + v[3] + margin
      )
    }

    paintBackground() {
      const r = this.resizeCanvas(this.bgCanvas)
      if (!r) return
      const { ctx, cw, ch } = r
      this.theme = wkCvTheme()
      const theme = this.theme
      ctx.fillStyle = theme.bg
      ctx.fillRect(0, 0, cw, ch)
      const k = wkCvDs.scale
      const v = this.visible()

      // 点阵网格：世界 24 单位格；缩得太小时逐级加倍，屏上点距不小于 12px，总点数封顶。
      let step = WKCV_GRID
      while (step * k < 12) step *= 2
      const gx0 = Math.floor(v[0] / step) * step, gy0 = Math.floor(v[1] / step) * step
      const nx = Math.floor(v[2] / step) + 2, ny = Math.floor(v[3] / step) + 2
      const every = Math.max(1, Math.ceil((nx * ny) / 4000))
      ctx.fillStyle = theme.border
      ctx.globalAlpha = 0.55
      let ci = 0
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          if ((ci++ % every) !== 0) continue
          const s = wkCvToScreen(gx0 + ix * step, gy0 + iy * step)
          ctx.beginPath()
          ctx.arc(s[0], s[1], 1.2, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      ctx.globalAlpha = 1

      // 边（世界坐标直接经 ctx 变换绘制：曲线 + 箭头 + 标签）
      const dpr = window.devicePixelRatio || 1
      ctx.save()
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * wkCvDs.offset[0] * k, dpr * wkCvDs.offset[1] * k)
      for (const e of this.data.edges) {
        if (!this.inView(e.from, v, 400) && !this.inView(e.to, v, 400)) continue
        const g = wkCvEdgeGeom(e)
        const selected = this.selected.has(e)
        const col = selected ? theme.blue : e.color || theme.text3
        ctx.strokeStyle = col
        ctx.fillStyle = col
        ctx.lineWidth = (selected ? 2.5 : 1.5) / k
        ctx.beginPath()
        ctx.moveTo(g.a[0], g.a[1])
        ctx.bezierCurveTo(g.c1[0], g.c1[1], g.c2[0], g.c2[1], g.b[0], g.b[1])
        ctx.stroke()
        if (e.arrow && k >= 0.6) {
          // 箭头方向 = 曲线在终点的切线（控制点 c2 → b）
          const ang = Math.atan2(g.b[1] - g.c2[1], g.b[0] - g.c2[0])
          const al = 9 / k, aw = 4.5 / k
          ctx.beginPath()
          ctx.moveTo(g.b[0], g.b[1])
          ctx.lineTo(g.b[0] - al * Math.cos(ang) + aw * Math.sin(ang), g.b[1] - al * Math.sin(ang) - aw * Math.cos(ang))
          ctx.lineTo(g.b[0] - al * Math.cos(ang) - aw * Math.sin(ang), g.b[1] - al * Math.sin(ang) + aw * Math.cos(ang))
          ctx.closePath()
          ctx.fill()
        }
        if (e.label && k >= 0.6) {
          ctx.font = `${11 / k}px ${WKCV_FONT}`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.lineWidth = 3 / k
          ctx.strokeStyle = theme.bg
          ctx.strokeText(e.label, g.mx, g.my)
          ctx.fillStyle = col
          ctx.fillText(e.label, g.mx, g.my)
        }
      }

      // 正在拖出的新连线（ComfyUI LinkConnector.renderLinks 的轻量等价物）
      const link = this.state.link
      if (link) {
        const a = wkCvAnchor(link.node, link.side) || [link.node.x + link.node.w / 2, link.node.y + link.node.h / 2]
        const dir = WKCV_SIDE_DIRS[link.side] || [0, 0]
        const b = link.to
        const dist = Math.max(24, Math.hypot(b[0] - a[0], b[1] - a[1]) / 2)
        const c1 = [a[0] + dir[0] * dist, a[1] + dir[1] * dist]
        ctx.strokeStyle = theme.blue
        ctx.lineWidth = 2 / k
        ctx.setLineDash([6 / k, 5 / k])
        ctx.beginPath()
        ctx.moveTo(a[0], a[1])
        ctx.bezierCurveTo(c1[0], c1[1], b[0], b[1], b[0], b[1])
        ctx.stroke()
        ctx.setLineDash([])
      }
      ctx.restore()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    paintForeground() {
      const r = this.resizeCanvas(this.fgCanvas)
      if (!r) return
      const { ctx, dpr, cw, ch } = r
      const theme = this.theme
      const k = wkCvDs.scale
      const v = this.visible()
      // 搬 ComfyUI _min_font_size_for_lod=8：正文按世界字号 12 计算，屏幕字号 < 8 时进入低质量。
      const lowQuality = 12 * k < 8

      ctx.save()
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * wkCvDs.offset[0] * k, dpr * wkCvDs.offset[1] * k)

      const ordered = this.orderedNodes()
      for (const n of ordered) {
        if (!this.inView(n, v, 40)) continue
        const x = n.x, y = n.y
        const col = n.color || ''
        const isSelected = this.selected.has(n)
        const isHover = this.state.node_over === n
        wkCvRoundRect(ctx, x, y, n.w, n.h, n.type === 'group' ? 10 : 8)
        ctx.fillStyle = col
          ? wkCvRgba(col, n.type === 'group' ? 0.08 : 0.16)
          : (n.type === 'group' ? 'rgba(0,0,0,0)' : wkCvRgba(theme.blue, isSelected ? 0.1 : 0.04))
        ctx.fill()
        ctx.lineWidth = (isSelected || isHover ? 2 : 1) / k
        ctx.strokeStyle = isSelected ? theme.blue : col ? wkCvRgba(col, 0.65) : theme.border
        if (n.type === 'group') ctx.setLineDash([5 / k, 4 / k])
        ctx.stroke()
        ctx.setLineDash([])

        if (n.type === 'group') {
          if (n.label && !lowQuality) {
            ctx.font = `600 12px ${WKCV_FONT}`
            ctx.textAlign = 'left'
            ctx.textBaseline = 'alphabetic'
            ctx.lineWidth = 3 / k
            ctx.strokeStyle = theme.bg
            ctx.strokeText(n.label, x + 2, y - 8 / k)
            ctx.fillStyle = col ? wkCvRgba(col, 0.95) : theme.text2
            ctx.fillText(n.label, x + 2, y - 8 / k)
          }
          continue
        }

        // 正文：按节点宽度折行，超出高度裁掉；折行结果按 (id, 宽, 文本) 缓存。
        if (!lowQuality) {
          const padX = 8, padY = 6
          const maxW = Math.max(10, n.w - padX * 2)
          ctx.save()
          ctx.beginPath()
          ctx.rect(x + padX, y + padY, maxW, Math.max(10, n.h - padY * 2))
          ctx.clip()
          ctx.font = `12px ${WKCV_FONT}`
          ctx.textAlign = 'left'
          ctx.textBaseline = 'top'
          ctx.fillStyle = theme.text
          const lh = 18
          const lines = this.wrapLines(ctx, n, maxW, Math.max(1, Math.ceil((n.h - padY * 2) / lh)))
          for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], x + padX, y + padY + i * lh)
          ctx.restore()
        }

        // 连线锚点（ComfyUI 的 slot 圆点；左侧 = 入、右侧 = 出）
        if (k >= 0.6) {
          ctx.fillStyle = theme.blue
          ctx.globalAlpha = 0.8
          ctx.beginPath(); ctx.arc(x + n.w, y + n.h / 2, 4, 0, Math.PI * 2); ctx.fill()
          ctx.beginPath(); ctx.arc(x, y + n.h / 2, 4, 0, Math.PI * 2); ctx.fill()
          ctx.globalAlpha = 1
        }

        // 选中描边 = strokeShape(selected)：padding 6、alpha 0.8（搬 litegraph draw.ts）
        if (isSelected) {
          const pad = 6
          ctx.globalAlpha = 0.8
          ctx.strokeStyle = theme.blue
          ctx.lineWidth = 2 / k
          wkCvRoundRect(ctx, x - pad, y - pad, n.w + pad * 2, n.h + pad * 2, 8 + pad)
          ctx.stroke()
          ctx.globalAlpha = 1
        }
      }
      ctx.restore()

      // 框选矩形：按 ComfyUI 用屏幕坐标绘制（不随缩放变形）
      const rect = this.state.dragging_rectangle
      const { eDown, eMove } = this.pointer
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (rect) {
        ctx.strokeStyle = theme.blue
        ctx.lineWidth = 1
        if (eDown && eMove) {
          const x = eDown.safeOffsetX
          const y = eDown.safeOffsetY
          ctx.strokeRect(x, y, eMove.safeOffsetX - x, eMove.safeOffsetY - y)
        } else {
          const a = wkCvToScreen(rect[0], rect[1])
          const b = wkCvToScreen(rect[0] + rect[2], rect[1] + rect[3])
          ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1])
        }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    wrapLines(ctx, n, maxW, maxLines) {
      const key = n.id + '|' + Math.round(n.w) + '|' + n.text
      const cached = this.wrapCache.get(key)
      if (cached) return cached
      const lines = wkCvWrap(ctx, n.text, maxW, maxLines)
      if (this.wrapCache.size > 500) this.wrapCache.clear()
      this.wrapCache.set(key, lines)
      return lines
    }

    // ---- 命中测试 ----
    getNodeOnPos(x, y) {
      const ordered = this.orderedNodes()
      for (let i = ordered.length - 1; i >= 0; i--) {
        const n = ordered[i]
        if (x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h) return n
      }
      return undefined
    }
    getEdgeOnPos(x, y) {
      const tol = Math.max(4, 6 / wkCvDs.scale)
      for (const e of this.data.edges) {
        const g = wkCvEdgeGeom(e)
        let px = g.a[0], py = g.a[1]
        for (let i = 1; i <= 24; i++) {
          const p = wkCvBezierPoint(g, i / 24)
          if (wkCvDistToSegment(x, y, px, py, p[0], p[1]) <= tol) return e
          px = p[0]; py = p[1]
        }
      }
      return undefined
    }
    // 节点角 = 缩放把手（ComfyUI findContainingCorner，resizeHandleSize=15）
    findResizeDirection(n, x, y) {
      const r = n.x + n.w, b = n.y + n.h
      if (wkCvIsInRectangle(x, y, n.x, n.y, WKCV_RESIZE_HANDLE, WKCV_RESIZE_HANDLE)) return 'NW'
      if (wkCvIsInRectangle(x, y, r - WKCV_RESIZE_HANDLE, n.y, WKCV_RESIZE_HANDLE, WKCV_RESIZE_HANDLE)) return 'NE'
      if (wkCvIsInRectangle(x, y, n.x, b - WKCV_RESIZE_HANDLE, WKCV_RESIZE_HANDLE, WKCV_RESIZE_HANDLE)) return 'SW'
      if (wkCvIsInRectangle(x, y, r - WKCV_RESIZE_HANDLE, b - WKCV_RESIZE_HANDLE, WKCV_RESIZE_HANDLE, WKCV_RESIZE_HANDLE)) return 'SE'
      return undefined
    }
    bringToFront(n) {
      if (n.type === 'group') return
      const i = this.data.nodes.indexOf(n)
      if (i < 0 || i === this.data.nodes.length - 1) return
      this.data.nodes.splice(i, 1)
      this.data.nodes.push(n)
      this.setDirty(true, true)
    }

    // ---- 选择 ----
    processSelect(item, e, sticky) {
      const intent = wkCvResolveClickSelection({
        hasItem: !!item,
        isSelected: !!item && this.selected.has(item),
        modifiers: e,
        multiSelect: false,
        selectOnly: false,
        sticky: !!sticky,
      })
      switch (intent) {
        case 'clear':
          this.selected.clear()
          break
        case 'add':
          if (item) this.selected.add(item)
          break
        case 'remove':
          if (item) this.selected.delete(item)
          break
        case 'replace':
          this.selected.clear()
          if (item) this.selected.add(item)
          break
        case 'none':
        default:
          return
      }
      this.persistSelection()
      this.setDirty(true, false)
    }
    selectAll() {
      this.selected = new Set([...this.data.nodes, ...this.data.edges])
      this.persistSelection()
      this.setDirty(true, true)
    }
    _normalizeDragRect(rect) {
      const w = Math.abs(rect[2])
      const h = Math.abs(rect[3])
      if (rect[2] < 0) rect[0] -= w
      if (rect[3] < 0) rect[1] -= h
      rect[2] = w
      rect[3] = h
      return rect
    }
    _getItemsInRect(rect) {
      const items = new Set()
      for (const node of this.data.nodes) {
        if (node.type === 'group') {
          if (wkCvContainsRect(rect, node.boundingRect)) items.add(node)
        } else if (wkCvOverlapBounding(rect, node.boundingRect)) {
          items.add(node)
        }
      }
      return items
    }
    _handleMultiSelect(e, dragRect) {
      const normalizedRect = this._normalizeDragRect([dragRect[0], dragRect[1], dragRect[2], dragRect[3]])
      const desired = wkCvApplyMarqueeSelection(
        wkCvResolveMarqueeSelection(e),
        this.selected,
        this._getItemsInRect(normalizedRect)
      )
      this.selected = new Set([...desired].filter((it) => !!it && !it.from))
      this.persistSelection()
      this.setDirty(true, true)
    }
    _setupNodeSelectionDrag(e, pointer, clickTarget) {
      const dragRect = [e.canvasX, e.canvasY, 1, 1]
      pointer.onClick = (eUp) => this.processSelect(clickTarget, eUp)
      pointer.onDragStart = () => { this.state.dragging_rectangle = dragRect }
      // liveSelection=false（ComfyUI 默认）：框选在 drag end 一次性结算。
      pointer.onDragEnd = (upEvent) => this._handleMultiSelect(upEvent, dragRect)
      pointer.finally = () => {
        this.state.dragging_rectangle = null
        this.setDirty(true, true)
      }
    }

    // ---- 指针事件 ----
    adjustMouseEvent(e) {
      const b = this.canvas.getBoundingClientRect()
      e.safeOffsetX = e.clientX - b.left
      e.safeOffsetY = e.clientY - b.top
      e.canvasX = e.safeOffsetX / wkCvDs.scale - wkCvDs.offset[0]
      e.canvasY = e.safeOffsetY / wkCvDs.scale - wkCvDs.offset[1]
    }
    bindEvents() {
      const canvas = this.canvas
      canvas.tabIndex = -1
      this._onDown = (e) => this.processMouseDown(e)
      this._onMove = (e) => this.processMouseMove(e)
      this._onUp = (e) => this.processMouseUp(e)
      this._onWheel = (e) => this.processMouseWheel(e)
      this._onCancel = () => this.processMouseCancel()
      this._onKeyDown = (e) => this.processKey(e)
      this._onKeyUp = (e) => this.processKey(e)
      this._onContext = (e) => e.preventDefault()
      canvas.addEventListener('pointerdown', this._onDown, true)
      canvas.addEventListener('pointermove', this._onMove)
      canvas.addEventListener('pointerup', this._onUp, true)
      canvas.addEventListener('pointercancel', this._onCancel)
      canvas.addEventListener('wheel', this._onWheel, { passive: false })
      canvas.addEventListener('keydown', this._onKeyDown, true)
      canvas.addEventListener('contextmenu', this._onContext)
      document.addEventListener('keyup', this._onKeyUp, true)
    }
    processMouseDown(e) {
      this.adjustMouseEvent(e)
      if (e.isPrimary) this.pointer.down(e)
      this.state.dragging_canvas = false
      const pointer = this.pointer
      const x = e.clientX, y = e.clientY
      const node = this.getNodeOnPos(e.canvasX, e.canvasY)
      const edge = node ? undefined : this.getEdgeOnPos(e.canvasX, e.canvasY)
      this.state.node_over = node || null
      this.state.graph_mouse = [e.canvasX, e.canvasY]
      this.state.last_mouse = [x, y]
      this._lastMousePosition = [e.safeOffsetX, e.safeOffsetY]

      pointer.isDouble = pointer.isDown && e.isPrimary
      pointer.isDown = true
      try { this.canvas.focus({ preventScroll: true }) } catch { this.canvas.focus() }

      if (e.button === 0 && !pointer.isDouble) {
        this._processPrimaryButton(e, node, edge)
      } else if (e.button === 1) {
        this._processMiddleButton(e, node)
      }
      this.setDirty(true, true)
      e.preventDefault()
      e.stopPropagation()
    }
    _processMiddleButton(e, node) {
      const pointer = this.pointer
      pointer.onDragStart = () => { this.state.dragging_canvas = true }
      pointer.finally = () => { this.state.dragging_canvas = false }
    }
    _processPrimaryButton(e, node, edge) {
      const pointer = this.pointer
      const ctrlOrMeta = e.ctrlKey || e.metaKey

      // Ctrl/⌘ + 拖 = 框选（ComfyUI leftMouseClickBehavior === 'panning'）
      if (ctrlOrMeta && !e.altKey) {
        this._setupNodeSelectionDrag(e, pointer, node || edge)
        return
      }
      // 空格持握 = 临时平移（ComfyUI read_only 分支）
      if (this._spaceKeyHeld) {
        pointer.finally = () => { this.state.dragging_canvas = false }
        this.state.dragging_canvas = true
        return
      }

      if (edge) {
        pointer.onClick = (eUp) => this.processSelect(edge, eUp)
        pointer.onDoubleClick = () => this.openEdgeEditor(edge)
        pointer.onDragStart = () => { this.state.dragging_canvas = true }
        pointer.finally = () => { this.state.dragging_canvas = false }
        return
      }
      if (node) {
        this._processNodeClick(e, ctrlOrMeta, node)
        return
      }
      // 空白
      pointer.onDoubleClick = () => this.createNodeAt(e.canvasX, e.canvasY)
      if (!pointer.onDragStart && !pointer.onClick && !pointer.onDrag) {
        // 默认左键平移：拖 = 平移画布；点 = 清空选择
        pointer.onClick = (eUp) => this.processSelect(null, eUp)
        pointer.finally = () => { this.state.dragging_canvas = false }
        this.state.dragging_canvas = true
      }
    }
    _processNodeClick(e, ctrlOrMeta, node) {
      const pointer = this.pointer
      const x = e.canvasX, y = e.canvasY
      pointer.onClick = () => this.processSelect(node, e)
      this.bringToFront(node)

      // 槽位：右侧 = 输出、左侧 = 输入（拖出新连线；ComfyUI 先查 slot 再查 resize）
      const outPos = [node.x + node.w, node.y + node.h / 2]
      if (wkCvIsInRectangle(x, y, outPos[0] - 15, outPos[1] - 10, 30, 20)) {
        this._startLinkDrag(node, 'right', 'input', pointer)
        return
      }
      const inPos = [node.x, node.y + node.h / 2]
      if (wkCvIsInRectangle(x, y, inPos[0] - 15, inPos[1] - 10, 30, 20)) {
        this._startLinkDrag(node, 'left', 'output', pointer)
        return
      }

      pointer.onDoubleClick = () => this.openNodeEditor(node)

      // 缩放把手（ComfyUI：先 onMouseDown 再 resize 再拖动）
      const resizeDirection = this.findResizeDirection(node, x, y)
      if (resizeDirection) {
        pointer.resizeDirection = resizeDirection
        const startBounds = [node.x, node.y, node.w, node.h]
        pointer.onDragStart = () => { this.state.resizing_node = node }
        pointer.onDrag = (eMove) => {
          if (!pointer.dragStarted) return
          const deltaX = eMove.canvasX - x
          const deltaY = eMove.canvasY - y
          const newBounds = [startBounds[0], startBounds[1], startBounds[2], startBounds[3]]
          switch (resizeDirection) {
            case 'NE':
              newBounds[1] = startBounds[1] + deltaY
              newBounds[2] = startBounds[2] + deltaX
              newBounds[3] = startBounds[3] - deltaY
              break
            case 'SE':
              newBounds[2] = startBounds[2] + deltaX
              newBounds[3] = startBounds[3] + deltaY
              break
            case 'SW':
              newBounds[0] = startBounds[0] + deltaX
              newBounds[2] = startBounds[2] - deltaX
              newBounds[3] = startBounds[3] + deltaY
              break
            case 'NW':
              newBounds[0] = startBounds[0] + deltaX
              newBounds[1] = startBounds[1] + deltaY
              newBounds[2] = startBounds[2] - deltaX
              newBounds[3] = startBounds[3] - deltaY
              break
          }
          const min = WKCV_MIN_SIZE
          if (newBounds[2] < min[0]) {
            if (resizeDirection.indexOf('W') !== -1) newBounds[0] = startBounds[0] + startBounds[2] - min[0]
            newBounds[2] = min[0]
          }
          if (newBounds[3] < min[1]) {
            if (resizeDirection.indexOf('N') !== -1) newBounds[1] = startBounds[1] + startBounds[3] - min[1]
            newBounds[3] = min[1]
          }
          node.x = newBounds[0]; node.y = newBounds[1]
          node.w = newBounds[2]; node.h = newBounds[3]
          this.setDirty(true, true)
        }
        const finishResize = () => {
          this.commitNodes([node])
          this.state.resizing_node = null
          this.setDirty(true, true)
        }
        pointer.onDragEnd = finishResize
        pointer.onDragCancel = finishResize
        pointer.finally = () => {
          this.state.resizing_node = null
          pointer.resizeDirection = undefined
        }
        this._setCursor(resizeDirection.toLowerCase() + '-resize')
        return
      }

      // 拖动节点（含多选 / 组带成员）
      pointer.onDragStart = (p) => this._startDraggingItems(node, p, true)
      pointer.onDragEnd = (eUp) => this._processDraggedItems(eUp)
    }
    _setCursor(value) {
      if (this.canvas.style.cursor !== value) this.canvas.style.cursor = value
    }
    _startLinkDrag(node, side, connectingTo, pointer) {
      this.state.link = { node, side, connectingTo, to: this.state.graph_mouse.slice() }
      pointer.onDrag = (eMove) => {
        if (!pointer.dragStarted) return
        this.state.link.to = [eMove.canvasX, eMove.canvasY]
        this.setDirty(false, true)
      }
      pointer.onDragEnd = (eUp) => this._dropLinks(eUp)
      pointer.onDragCancel = () => { this.state.link = null; this.setDirty(false, true) }
      pointer.finally = () => {
        this.state.link = null
        this.setDirty(false, true)
      }
      this.setDirty(false, true)
    }
    // 搬 ComfyUI LinkConnector.dropOnNode：禁止自连；落在节点上就按当前方向建边。
    _dropLinks(eUp) {
      const link = this.state.link
      this.state.link = null
      if (!link) return
      const target = this.getNodeOnPos(eUp.canvasX, eUp.canvasY)
      if (!target || target === link.node) {
        this.setDirty(false, true)
        return
      }
      const raw = wkCvReadRaw(this.text)
      if (!raw) return
      if (!Array.isArray(raw.edges)) raw.edges = []
      // 搬 ComfyUI connectToNode 的既有连接检查：同一对端点不重复建边
      const fromId = link.connectingTo === 'input' ? link.node.id : target.id
      const toId = link.connectingTo === 'input' ? target.id : link.node.id
      if (raw.edges.some((e) => e && e.fromNode === fromId && e.toNode === toId)) {
        this.setDirty(false, true)
        return
      }
      if (link.connectingTo === 'input') {
        raw.edges.push({ fromNode: fromId, toNode: toId, fromSide: link.side, toSide: undefined })
      } else {
        raw.edges.push({ fromNode: fromId, toNode: toId, fromSide: undefined, toSide: link.side })
      }
      wkCvWriteDoc(this.view, raw)
    }
    _startDraggingItems(item, pointer, sticky) {
      pointer.finally = () => {
        this.state.isDragging = false
      }
      pointer.onDragCancel = () => this._processDraggedItems()
      this.processSelect(item, pointer.eDown, sticky)
      this.state.isDragging = true
      this.dragMoved = new Set()
      if (pointer.eDown) {
        this._lastDragModifiers = {
          ctrlKey: pointer.eDown.ctrlKey,
          metaKey: pointer.eDown.metaKey,
        }
      }
    }
    _processDraggedItems(e) {
      // 搬 ComfyUI：Shift（或 alwaysSnapToGrid）在落点吸附到网格
      if (e && e.shiftKey) {
        for (const item of this.dragMoved) {
          if (!item || !item.id) continue
          const pos = [item.x, item.y]
          wkCvSnapPoint(pos, WKCV_SNAP)
          item.x = pos[0]; item.y = pos[1]
        }
      }
      this.commitNodes([...this.dragMoved])
      this.state.isDragging = false
      this.dragMoved = new Set()
      this.setDirty(true, true)
    }
    processMouseMove(e) {
      this.adjustMouseEvent(e)
      const mouse = [e.clientX, e.clientY]
      const delta = [mouse[0] - this.state.last_mouse[0], mouse[1] - this.state.last_mouse[1]]
      this.state.last_mouse = mouse
      this.state.graph_mouse = [e.canvasX, e.canvasY]

      if (e.isPrimary) this.pointer.move(e)

      const pointer = this.pointer
      const dragRect = this.state.dragging_rectangle
      if (dragRect) {
        dragRect[2] = e.canvasX - dragRect[0]
        dragRect[3] = e.canvasY - dragRect[1]
        this.setDirty(true, true)
      } else if (this.state.dragging_canvas) {
        wkCvDs.offset[0] += delta[0] / wkCvDs.scale
        wkCvDs.offset[1] += delta[1] / wkCvDs.scale
        this.setDirty(true, true)
      } else if (!pointer.isDown) {
        // hover：光标形状 + 悬停高亮
        const node = this.getNodeOnPos(e.canvasX, e.canvasY)
        if (this.state.node_over !== (node || null)) {
          this.state.node_over = node || null
          this.setDirty(true, false)
        }
        if (node) {
          const dir = this.findResizeDirection(node, e.canvasX, e.canvasY)
          this._setCursor(dir ? dir.toLowerCase() + '-resize' : 'grab')
        } else if (this.getEdgeOnPos(e.canvasX, e.canvasY)) {
          this._setCursor('pointer')
        } else {
          this._setCursor('grab')
        }
      }

      // 被拖动的项目（ComfyUI：delta / scale，组按 getDraggedItems 带成员）
      if (this.state.isDragging) {
        this._lastDragModifiers = { ctrlKey: e.ctrlKey, metaKey: e.metaKey }
        const allItems = wkCvGetDraggedItems(this.selected, e)
        const deltaX = delta[0] / wkCvDs.scale
        const deltaY = delta[1] / wkCvDs.scale
        for (const item of allItems) {
          if (!item || !item.id) continue
          item.move(deltaX, deltaY)
          this.dragMoved.add(item)
        }
        this.setDirty(true, true)
      }

      e.preventDefault()
    }
    processMouseUp(e) {
      if (!e.isPrimary) return
      this.adjustMouseEvent(e)
      const isClick = this.pointer.up(e)
      if (isClick) {
        this.state.dragging_canvas = false
        e.stopPropagation()
        e.preventDefault()
        return
      }
      this.state.dragging_canvas = false
      if (e.button === 0) {
        this.state.isDragging = false
      }
      this.setDirty(true, true)
      e.stopPropagation()
      e.preventDefault()
    }
    processMouseCancel() {
      this.pointer.reset()
      this.setDirty(true, true)
    }
    // 搬 cofmyfrontend processMouseWheel：默认 mouseWheelScroll='zoom' ⇒ 滚轮=缩放（鼠标步进 ×1.1，
    // 触控板平滑）；Ctrl/⌘ 同样缩放；指针位置为缩放锚点。
    processMouseWheel(e) {
      this.adjustMouseEvent(e)
      let scale = wkCvDs.scale
      const isTrackpad = this.pointer.isTrackpadGesture(e)
      const zoomSpeed = 1.1
      if (isTrackpad) {
        scale *= 1 + e.deltaY * (1 - zoomSpeed) * 0.18
        wkCvDs.changeScale(scale, [e.clientX, e.clientY], false)
      } else {
        if (e.deltaY < 0) scale *= zoomSpeed
        else if (e.deltaY > 0) scale *= 1 / zoomSpeed
        wkCvDs.changeScale(scale, [e.clientX, e.clientY])
      }
      this.setDirty(true, true)
      e.preventDefault()
    }
    // 搬 ComfyUI processKey + 画布命令绑定：空格平移 / Esc / Delete / Ctrl+A / Ctrl+C / Ctrl+V
    processKey(e) {
      if (e.type === 'keyup' && e.key === ' ') {
        const held = this._spaceKeyHeld
        this._spaceKeyHeld = null
        if (held) {
          this.state.dragging_canvas = held.draggingCanvas && this.pointer.isDown
          this._setCursor('grab')
        }
        return
      }
      if (e.target instanceof Element && e.target.localName === 'input') return
      let block_default = false
      if (e.type === 'keydown') {
        if (e.key === ' ') {
          if (!this._spaceKeyHeld) {
            this._spaceKeyHeld = { draggingCanvas: this.state.dragging_canvas }
          }
          this.state.dragging_canvas = this.pointer.isDown
          this._setCursor('grabbing')
          block_default = true
        } else if (e.key === 'Escape') {
          if (this.state.link) {
            this.state.link = null
            this.pointer.reset()
            this.setDirty(false, true)
            e.preventDefault()
            return
          }
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          this.deleteSelected()
          block_default = true
        } else if ((e.ctrlKey || e.metaKey) && !e.altKey) {
          const k = e.key.toLowerCase()
          if (k === 'a') {
            this.selectAll()
            block_default = true
          } else if (k === 'c') {
            this.copySelected()
            block_default = true
          } else if (k === 'v') {
            this.pasteFromClipboard()
            block_default = true
          }
        }
      }
      if (block_default) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }

    // ---- 文档写入 ----
    commitNodes(items) {
      if (!items || !items.length) return
      const raw = wkCvReadRaw(this.text)
      if (!raw) return
      let changed = false
      for (const it of items) {
        if (!it || !it.id) continue
        const r = wkCvRawNode(raw, it.id)
        if (!r) continue
        const x = Math.round(it.x), y = Math.round(it.y)
        const w = Math.max(1, Math.round(it.w)), h = Math.max(1, Math.round(it.h))
        if (r.x !== x || r.y !== y || r.width !== w || r.height !== h) {
          r.x = x; r.y = y; r.width = w; r.height = h
          changed = true
        }
      }
      if (changed) wkCvWriteDoc(this.view, raw)
    }
    // 搬 ComfyUI deleteSelected：节点先 connectInputToOutput（删除后把前驱接给后继），再删除。
    deleteSelected() {
      if (!this.selected.size) return
      const raw = wkCvReadRaw(this.text)
      if (!raw) return
      if (!Array.isArray(raw.edges)) raw.edges = []
      const nodeIds = new Set()
      for (const item of this.selected) {
        if (!item) continue
        if (item.from) {
          // 选中的边直接删
          raw.edges = raw.edges.filter((e) => !(e && e.fromNode === item.from.id && e.toNode === item.to.id))
        } else if (item.id) {
          nodeIds.add(item.id)
        }
      }
      for (const id of nodeIds) {
        const ins = raw.edges.filter((e) => e && e.toNode === id)
        const outs = raw.edges.filter((e) => e && e.fromNode === id)
        for (const a of ins) {
          for (const b of outs) {
            if (!a.fromNode || !b.toNode || a.fromNode === b.toNode) continue
            const exists = raw.edges.some((e) => e && e.fromNode === a.fromNode && e.toNode === b.toNode)
            if (!exists) {
              raw.edges.push({ fromNode: a.fromNode, toNode: b.toNode, fromSide: a.fromSide, toSide: b.toSide })
            }
          }
        }
        raw.edges = raw.edges.filter((e) => e && e.fromNode !== id && e.toNode !== id)
        raw.nodes = raw.nodes.filter((n) => n && n.id !== id)
      }
      this.selected.clear()
      this.persistSelection()
      this.setDirty(true, true)
      wkCvWriteDoc(this.view, raw)
    }
    copySelected() {
      const raw = wkCvReadRaw(this.text)
      if (!raw) return
      const nodes = []
      const ids = new Set()
      for (const item of this.selected) {
        if (!item || !item.id) continue
        const r = wkCvRawNode(raw, item.id)
        if (!r) continue
        nodes.push(JSON.parse(JSON.stringify(r)))
        ids.add(item.id)
      }
      if (!nodes.length) return
      const edges = (Array.isArray(raw.edges) ? raw.edges : [])
        .filter((e) => e && ids.has(e.fromNode) && ids.has(e.toNode))
        .map((e) => JSON.parse(JSON.stringify(e)))
      try {
        localStorage.setItem(WKCV_CLIP_KEY, JSON.stringify({ nodes, edges }))
      } catch { /* 存储不可用：忽略 */ }
    }
    // 搬 ComfyUI pasteFromClipboard：新 id、相对包围盒左上角落到 graph_mouse、选中新项。
    pasteFromClipboard() {
      let clip
      try { clip = JSON.parse(localStorage.getItem(WKCV_CLIP_KEY) || 'null') } catch { return }
      if (!clip || !Array.isArray(clip.nodes) || !clip.nodes.length) return
      const raw = wkCvReadRaw(this.text)
      if (!raw) return
      if (!Array.isArray(raw.edges)) raw.edges = []
      let x0 = Infinity, y0 = Infinity
      for (const n of clip.nodes) {
        x0 = Math.min(x0, Number(n.x) || 0)
        y0 = Math.min(y0, Number(n.y) || 0)
      }
      if (!Number.isFinite(x0)) x0 = 0
      if (!Number.isFinite(y0)) y0 = 0
      const mx = this.state.graph_mouse[0], my = this.state.graph_mouse[1]
      const idMap = new Map()
      const newIds = []
      for (const n of clip.nodes) {
        const id = wkCvNewId()
        const copy = JSON.parse(JSON.stringify(n))
        copy.id = id
        copy.x = (Number(n.x) || 0) - x0 + mx
        copy.y = (Number(n.y) || 0) - y0 + my
        raw.nodes.push(copy)
        idMap.set(n.id, id)
        newIds.push(id)
      }
      for (const e of clip.edges || []) {
        if (!idMap.has(e.fromNode) || !idMap.has(e.toNode)) continue
        const copy = JSON.parse(JSON.stringify(e))
        copy.fromNode = idMap.get(e.fromNode)
        copy.toNode = idMap.get(e.toNode)
        raw.edges.push(copy)
      }
      wkCvSelFile = state.workFile
      wkCvSelIds = new Set(newIds)
      wkCvWriteDoc(this.view, raw)
    }
    // 空白双击 = 新建文本节点（ComfyUI empty-double-click 的搜索框语义在 JSON Canvas 的对应物）
    createNodeAt(x, y) {
      const raw = wkCvReadRaw(this.text)
      if (!raw) return
      const id = wkCvNewId()
      raw.nodes.push({ id, type: 'text', x: Math.round(x), y: Math.round(y), width: 240, height: 120, text: '' })
      wkCvSelFile = state.workFile
      wkCvSelIds = new Set([id])
      wkCvWriteDoc(this.view, raw)
    }
    openNodeEditor(n) {
      const raw = wkCvReadRaw(this.text)
      if (!raw) return
      const s = wkCvToScreen(n.x, n.y)
      wkCvOpenEditor(this.view, this.root, this.overlay, this.data, raw, {
        x: s[0], y: s[1], w: n.w * wkCvDs.scale, h: n.h * wkCvDs.scale,
      }, n)
    }
    openEdgeEditor(edge) {
      const raw = wkCvReadRaw(this.text)
      if (!raw) return
      const g = wkCvEdgeGeom(edge)
      const s = wkCvToScreen(g.mx, g.my)
      wkCvOpenEditor(this.view, this.root, this.overlay, this.data, raw, {
        x: s[0] - 80, y: s[1] - 18, w: 160, h: 36,
      }, { isEdge: true, from: edge.from, to: edge.to, label: edge.label })
    }
    destroy() {
      this._destroyed = true
      if (this._raf) cancelAnimationFrame(this._raf)
      wkCvDs.cancelAnimation()
      const canvas = this.canvas
      canvas.removeEventListener('pointerdown', this._onDown, true)
      canvas.removeEventListener('pointermove', this._onMove)
      canvas.removeEventListener('pointerup', this._onUp, true)
      canvas.removeEventListener('pointercancel', this._onCancel)
      canvas.removeEventListener('wheel', this._onWheel)
      canvas.removeEventListener('keydown', this._onKeyDown, true)
      canvas.removeEventListener('contextmenu', this._onContext)
      document.removeEventListener('keyup', this._onKeyUp, true)
      this.pointer.reset()
      if (wkCvCamHost === canvas) wkCvCamHost = null
      if (this.ro) { this.ro.disconnect(); this.ro = null }
    }
  }

  // ---------- 画布 widget（decoField 的 block replace 宿主；跨行 replace 只允许走 StateField） ----------
  // 必须继承 CM.WidgetType：视图在 DOM 复用/测量/事件路径会调基类方法（compare/estimatedHeight/
  // ignoreEvent/updateDOM 等），普通 class 缺这些方法 ⇒ 首次 docChanged 半更新抛 TypeError，之后每次
  // dispatch 都在破损视图上再抛 ⇒ 编辑区整体报废（连开其它文件也失败）。CM6 包先于 /app.js 加载，
  // 基类在模块求值期可取（edCMG 来自 editor/cm-bridge.js，排在 work-canvas 之前）。
  const WkCvWidgetBase = edCMG.WidgetType
  class WkCvWidget extends WkCvWidgetBase {
    constructor(text) { super(); this.text = text }
    eq() { return false } // doc 变 / 态切时恒重建 DOM（相机/选择在模块级保留）
    toDOM(view) {
      const root = document.createElement('div')
      root.className = 'wk-cv'
      const data = wkCvParse(this.text)
      // 顶栏：摘要 + 「编辑源码」
      const bar = document.createElement('div')
      bar.className = 'wk-cv-bar'
      const cnt = document.createElement('span')
      cnt.className = 'wk-cv-cnt'
      cnt.textContent = data.err || wkCvSummary(data)
      const srcBtn = document.createElement('button')
      srcBtn.className = 'wk-cv-btn'
      srcBtn.type = 'button'
      srcBtn.textContent = '编辑源码'
      srcBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        view.dispatch({ effects: wkCvToggle.of() })
      })
      bar.appendChild(cnt)
      // 操作提示（画布本身没有可见 affordance）
      const hint = document.createElement('span')
      hint.className = 'wk-cv-hint'
      hint.textContent = '拖动移动 · Ctrl/⌘拖动框选 · 双击编辑 · Shift 吸附 · Del 删除 · Ctrl+A/C/V · 滚轮缩放 · 空格平移 · 拖两侧圆点连线'
      bar.appendChild(hint)
      bar.appendChild(srcBtn)
      root.appendChild(bar)
      if (data.err) {
        const bad = document.createElement('div')
        bad.className = 'wk-cv-empty wk-cv-bad'
        bad.textContent = data.err + ' — 点右上「编辑源码」修复'
        root.appendChild(bad)
        return root
      }
      if (!data.nodes.length) {
        const empty = document.createElement('div')
        empty.className = 'wk-cv-empty'
        empty.textContent = '空画布 — 双击空白新建节点，或点右上「编辑源码」写入 JSON Canvas'
        root.appendChild(empty)
        return root
      }
      // ComfyUI 结构：stage（定位锚）里 bg/fg 双 canvas 画一切图形，overlay 是**兄弟**层（只放编辑控件）。
      const stage = document.createElement('div')
      stage.className = 'wk-cv-stage'
      const bg = document.createElement('canvas')
      bg.className = 'wk-cv-canvas wk-cv-bg'
      const canvas = document.createElement('canvas')
      canvas.className = 'wk-cv-canvas wk-cv-fg'
      const overlay = document.createElement('div')
      overlay.className = 'wk-cv-overlay'
      stage.appendChild(bg)
      stage.appendChild(canvas)
      stage.appendChild(overlay)
      root.appendChild(stage)

      const gview = new WkCvGraphView(root, stage, canvas, overlay, view, this.text)
      gview.bgCanvas = bg
      gview.fgCanvas = canvas
      gview.setDirty(true, true)
      this._gview = gview

      // 画布块填满编辑区：CM6 block widget 默认按内容高度排版，而 stage 内只有绝对定位的 canvas，
      // 高度会塌到 min-height（200px）——取景按 200px 高算就没法看。这里以滚动容器可视高给 root
      // 定高（先写高度再读 stage 尺寸，读数强制回流，取景一次到位）。
      const syncHeight = () => {
        const sc = view.scrollDOM
        if (!sc) return
        // 已挂进文档时按「root 顶到滚动容器底」算，自动扣掉 .cm-content 的上下垫；
        // 尚未挂载（toDOM 阶段）先按容器可视高预留，挂载后的 RO 回调再修正。
        const h = root.isConnected
          ? Math.round(sc.getBoundingClientRect().bottom - root.getBoundingClientRect().top - 8)
          : Math.round(sc.clientHeight - 24)
        const px = Math.max(240, h) + 'px'
        if (root.style.height !== px) root.style.height = px
      }
      const layout = () => {
        syncHeight()
        wkCvDs.invalidateViewportSize()
        gview.fitIfNeeded() // 首次拿到真实尺寸时取景；同文件后续只同步视口
        gview.setDirty(true, true)
      }
      const ro = new ResizeObserver(layout)
      ro.observe(stage)
      if (view.scrollDOM) ro.observe(view.scrollDOM)
      layout()
      gview.ro = ro
      this._ro = ro
      return root
    }
    destroy() {
      if (this._gview) { this._gview.destroy(); this._gview = null }
      if (this._ro) { this._ro.disconnect(); this._ro = null }
    }
  }

  // ---------- 源码态的回流入口（首行行前小按钮「图形预览」） ----------
  class WkCvOpenBtn extends WkCvWidgetBase {
    eq(w) { return w instanceof WkCvOpenBtn }
    toDOM(view) {
      const b = document.createElement('button')
      b.className = 'wk-cv-btn wk-cv-open'
      b.type = 'button'
      b.textContent = '图形预览'
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        view.dispatch({ effects: wkCvToggle.of() })
      })
      return b
    }
  }

  // ---------- 扩展组装（wkEdLangExt 对 .canvas 返回它） ----------
  let wkCvToggle = null // StateEffect：图形 ⇄ 源码（wkCvExt 组装时置位；按钮 dispatch 读全局当前值）
  function wkCvExt(CM, hlStyle) {
    const toggle = CM.StateEffect.define()
    wkCvToggle = toggle
    const onField = CM.StateField.define({
      create: () => true, // 默认图形态
      update(v, tr) {
        for (const e of tr.effects) if (e.is(toggle)) return !v
        return v
      },
    })
    // 装饰真源（跨行 block replace 仅 StateField 可为）：图形态 = block replace 覆盖整篇；源码态 =
    // 首行行前「图形预览」按钮。create/update 同一套构造（create 覆盖 setDoc 被同文本跳过的路）。
    const buildDeco = (st) => {
      if (st.field(onField) && st.doc.length > 0) {
        return CM.Decoration.set([CM.Decoration.replace({ widget: new WkCvWidget(st.doc.toString()), block: true }).range(0, st.doc.length)], true)
      }
      return CM.Decoration.set([CM.Decoration.widget({ widget: new WkCvOpenBtn(), side: -1 }).range(0)], true)
    }
    const decoField = CM.StateField.define({
      create: (st) => buildDeco(st),
      update(deco, tr) {
        if (!tr.docChanged && !tr.effects.some((e) => e.is(toggle))) return deco.map(tr.changes)
        return buildDeco(tr.state)
      },
      provide: (f) => CM.EditorView.decorations.from(f),
    })
    // 源码态 JSON 高亮
    return [onField, decoField, CM.json(), CM.syntaxHighlighting(hlStyle)]
  }

  const WK_DOC_MAX_ROWS = 300
  const WK_DOC_MAX_COLS = 60

  function wkDocKind(path) {
    if (/\.xlsx$/i.test(path)) return 'xlsx'
    if (/\.docx$/i.test(path)) return 'docx'
    return ''
  }

  function wkDocUnzip(buf) {
    const F = window.fflate
    if (!F || !F.unzipSync) throw new Error('解压组件未加载（vendor/fflate.js）')
    return F.unzipSync(new Uint8Array(buf))
  }

  function wkDocText(files, name) {
    const b = files[name]
    return b ? new TextDecoder('utf-8').decode(b) : ''
  }

  function wkDocXml(files, name) {
    const s = wkDocText(files, name)
    if (!s) return null
    const d = new DOMParser().parseFromString(s, 'application/xml')
    return d.getElementsByTagName('parsererror').length ? null : d
  }

  function wkDocAll(root, tag) { return root ? Array.from(root.getElementsByTagNameNS('*', tag)) : [] }
  function wkDocKids(el, tag) { return el ? Array.from(el.children).filter((c) => c.localName === tag) : [] }
  function wkDocAttr(el, name) {
    if (!el) return ''
    for (const a of el.attributes) if (a.localName === name || a.name === name) return a.value
    return ''
  }
  // OOXML 开关：元素在场 = 开，val="0/false/off" = 关
  function wkDocOn(el) { return !!el && !/^(0|false|off)$/i.test(wkDocAttr(el, 'val')) }
  // ARGB / RRGGBB → #rrggbb（非法返回空）
  function wkDocRgb(v) {
    const s = String(v || '').replace(/^#/, '')
    const h = s.length === 8 ? s.slice(2) : s
    return /^[0-9a-f]{6}$/i.test(h) ? '#' + h.toLowerCase() : ''
  }

  // ---------- XLSX ----------
  function wkDocNum(raw, xf, styles) {
    const n = Number(raw)
    if (raw === '' || !Number.isFinite(n)) return raw
    const code = (styles.numFmts[xf.numFmtId] || '').replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '')
    if (/%/.test(code)) {
      const d = (code.split('.')[1] || '').replace(/[^0#]/g, '').length
      return (n * 100).toFixed(d) + '%'
    }
    // 纯日期/时间格式（含 y/m/d/h/s，且不含数字占位符）→ 按 1900 日期系统换算
    if (/[ymdhs]/i.test(code) && !/[#0]/.test(code)) {
      const ms = Math.round((n - 25569) * 86400000)
      const d = new Date(ms)
      const p2 = (x) => String(x).padStart(2, '0')
      const date = d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate())
      return /[hs]/i.test(code) ? date + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) : date
    }
    const dec = /\.(0+)/.exec(code)
    if (dec) return n.toFixed(dec[1].length)
    if (/#,##0/.test(code)) return Math.round(n).toLocaleString('en-US')
    return String(n)
  }

  function wkDocParseStyles(files) {
    const doc = wkDocXml(files, 'xl/styles.xml')
    const st = { fonts: [], fills: [], borders: [], xfs: [], numFmts: {} }
    if (!doc) return st
    for (const nf of wkDocAll(doc, 'numFmt')) st.numFmts[wkDocAttr(nf, 'numFmtId')] = wkDocAttr(nf, 'formatCode')
    for (const f of wkDocKids(wkDocAll(doc, 'fonts')[0], 'font')) {
      const color = wkDocKids(f, 'color')[0]
      st.fonts.push({
        b: wkDocKids(f, 'b').some(wkDocOn),
        i: wkDocKids(f, 'i').some(wkDocOn),
        u: wkDocKids(f, 'u').length > 0,
        s: wkDocKids(f, 'strike').length > 0,
        color: wkDocRgb(wkDocAttr(color, 'rgb')),
        sz: Number(wkDocAttr(wkDocKids(f, 'sz')[0], 'val')) || 0,
      })
    }
    for (const f of wkDocKids(wkDocAll(doc, 'fills')[0], 'fill')) {
      const pf = wkDocKids(f, 'patternFill')[0]
      const fg = wkDocKids(pf, 'fgColor')[0]
      st.fills.push(pf && /solid/i.test(wkDocAttr(pf, 'patternType')) && fg ? wkDocRgb(wkDocAttr(fg, 'rgb')) : '')
    }
    for (const b of wkDocKids(wkDocAll(doc, 'borders')[0], 'border')) {
      st.borders.push(['left', 'right', 'top', 'bottom'].some((side) => {
        const e = wkDocKids(b, side)[0]
        const style = wkDocAttr(e, 'style')
        return !!style && style !== 'none'
      }))
    }
    for (const x of wkDocKids(wkDocAll(doc, 'cellXfs')[0], 'xf')) {
      const al = wkDocKids(x, 'alignment')[0]
      st.xfs.push({
        numFmtId: wkDocAttr(x, 'numFmtId') || '0',
        fontId: Number(wkDocAttr(x, 'fontId')) || 0,
        fillId: Number(wkDocAttr(x, 'fillId')) || 0,
        borderId: Number(wkDocAttr(x, 'borderId')) || 0,
        h: wkDocAttr(al, 'horizontal'),
        v: wkDocAttr(al, 'vertical'),
        wrap: /^(1|true)$/i.test(wkDocAttr(al, 'wrapText')),
      })
    }
    return st
  }

  function wkDocShared(files) {
    const doc = wkDocXml(files, 'xl/sharedStrings.xml')
    return wkDocAll(doc, 'si').map((si) => wkDocAll(si, 't').map((t) => t.textContent || '').join(''))
  }

  function wkDocResolve(target) {
    const t = String(target || '').replace(/\\/g, '/')
    const parts = (t.startsWith('/') ? t.slice(1) : 'xl/' + t).split('/')
    const out = []
    for (const p of parts) {
      if (!p || p === '.') continue
      if (p === '..') out.pop()
      else out.push(p)
    }
    return out.join('/')
  }

  function wkDocSheets(files) {
    const wb = wkDocXml(files, 'xl/workbook.xml')
    const rels = wkDocXml(files, 'xl/_rels/workbook.xml.rels')
    const map = {}
    for (const r of wkDocAll(rels, 'Relationship')) map[wkDocAttr(r, 'Id')] = wkDocResolve(wkDocAttr(r, 'Target'))
    return wkDocAll(wb, 'sheet')
      .map((s) => ({ name: wkDocAttr(s, 'name') || 'Sheet', state: wkDocAttr(s, 'state') || 'visible', file: map[wkDocAttr(s, 'id')] || '' }))
      .filter((s) => s.state !== 'hidden' && s.file)
  }

  function wkDocColIndex(ref) {
    let n = 0
    for (const ch of String(ref || '').replace(/\d+$/, '')) n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64)
    return n - 1
  }
  function wkDocColName(i) {
    let s = ''
    for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s
    return s
  }

  function wkDocParseSheet(files, sheet, shared, styles) {
    const doc = wkDocXml(files, sheet.file)
    const root = doc && wkDocAll(doc, 'worksheet')[0]
    const out = { name: sheet.name, cells: {}, merges: {}, covered: new Set(), widths: {}, heights: {}, nrows: 0, ncols: 0, truncated: false }
    if (!root) return out
    // 列宽（Excel 字符宽 → 像素，与 dsh 同式）与隐藏列
    for (const col of wkDocKids(wkDocKids(root, 'cols')[0], 'col')) {
      if (/^(1|true)$/i.test(wkDocAttr(col, 'hidden'))) continue
      const a = Number(wkDocAttr(col, 'min')) - 1
      const b = Number(wkDocAttr(col, 'max')) - 1
      const w = Number(wkDocAttr(col, 'width'))
      if (!Number.isFinite(w) || w <= 0) continue
      for (let i = a; i <= Math.min(b, WK_DOC_MAX_COLS - 1); i++) out.widths[i] = Math.max(18, Math.floor(w < 1 ? w * 12 : w * 7 + 5))
    }
    const rows = wkDocKids(wkDocKids(root, 'sheetData')[0], 'row')
    rows.forEach((row, ri) => {
      const r = Number(wkDocAttr(row, 'r')) - 1 || ri
      const ht = Number(wkDocAttr(row, 'ht'))
      if (Number.isFinite(ht) && ht > 0) out.heights[r] = Math.round(ht * 96 / 72)
      let ci = -1
      for (const c of wkDocKids(row, 'c')) {
        const ref = wkDocAttr(c, 'r')
        ci = ref ? wkDocColIndex(ref) : ci + 1
        if (r >= WK_DOC_MAX_ROWS || ci >= WK_DOC_MAX_COLS) { out.truncated = true; continue }
        out.nrows = Math.max(out.nrows, r + 1)
        out.ncols = Math.max(out.ncols, ci + 1)
        const xi = Number(wkDocAttr(c, 's')) || 0
        const xf = styles.xfs[xi] || { numFmtId: '0', fontId: 0, fillId: 0, borderId: 0 }
        const type = wkDocAttr(c, 't')
        const raw = (wkDocKids(c, 'v')[0] || {}).textContent || ''
        let v = ''
        if (type === 's') v = shared[Number(raw)] || ''
        else if (type === 'inlineStr') v = wkDocAll(c, 't').map((t) => t.textContent || '').join('')
        else if (type === 'b') v = raw === '1' ? 'TRUE' : 'FALSE'
        else if (type === 'str' || type === 'e') v = raw
        else v = wkDocNum(raw, xf, styles)
        out.cells[r + '_' + ci] = { v, style: wkDocCellStyle(xf, styles, /^-?[\d.]+$/.test(v)), raw }
      }
    })
    for (const m of wkDocAll(root, 'mergeCell')) {
      const [a, b] = String(wkDocAttr(m, 'ref')).split(':')
      if (!a || !b) continue
      const r0 = Number(String(a).replace(/^[A-Z]+/i, '')) - 1
      const c0 = wkDocColIndex(a)
      const r1 = Number(String(b).replace(/^[A-Z]+/i, '')) - 1
      const c1 = wkDocColIndex(b)
      if ([r0, c0, r1, c1].some((x) => !Number.isFinite(x))) continue
      out.merges[r0 + '_' + c0] = { rs: Math.max(1, r1 - r0 + 1), cs: Math.max(1, c1 - c0 + 1) }
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (r !== r0 || c !== c0) out.covered.add(r + '_' + c)
      out.nrows = Math.max(out.nrows, r1 + 1)
      out.ncols = Math.max(out.ncols, c1 + 1)
    }
    out.nrows = Math.min(out.nrows, WK_DOC_MAX_ROWS)
    out.ncols = Math.min(out.ncols, WK_DOC_MAX_COLS)
    return out
  }

  function wkDocCellStyle(xf, styles, numeric) {
    const bits = []
    const f = styles.fonts[xf.fontId] || {}
    if (f.b) bits.push('font-weight:600')
    if (f.i) bits.push('font-style:italic')
    if (f.u || f.s) bits.push('text-decoration:' + [f.u ? 'underline' : '', f.s ? 'line-through' : ''].filter(Boolean).join(' '))
    if (f.color) bits.push('color:' + f.color)
    if (f.sz && f.sz >= 20) bits.push('font-size:' + Math.round(f.sz * 96 / 72) + 'px')
    if (styles.fills[xf.fillId]) bits.push('background:' + styles.fills[xf.fillId])
    if (styles.borders[xf.borderId]) bits.push('border:1px solid var(--border)')
    if (xf.wrap) bits.push('white-space:pre-wrap')
    if (xf.h === 'center') bits.push('text-align:center')
    else if (xf.h === 'right') bits.push('text-align:right')
    else if (numeric) bits.push('text-align:right')
    if (xf.v === 'center') bits.push('vertical-align:middle')
    else if (xf.v === 'top') bits.push('vertical-align:top')
    return bits.join(';')
  }

  function wkDocRenderXlsx(body, path, buf) {
    const files = wkDocUnzip(buf)
    const styles = wkDocParseStyles(files)
    const shared = wkDocShared(files)
    const sheets = wkDocSheets(files)
    if (!sheets.length) throw new Error('工作簿没有可预览的工作表')
    const parsed = sheets.map((s) => wkDocParseSheet(files, s, shared, styles))
    const wrap = document.createElement('div')
    wrap.className = 'wk-doc wk-doc-xlsx'
    const bar = document.createElement('div')
    bar.className = 'wk-doc-bar'
    const nm = document.createElement('span')
    nm.className = 'wk-doc-name'
    nm.textContent = String(path).split('/').pop()
    const meta = document.createElement('span')
    meta.className = 'wk-doc-meta'
    meta.textContent = '只读预览 · ' + parsed.length + ' 个工作表'
    bar.append(nm, meta)
    const grid = document.createElement('div')
    grid.className = 'wk-doc-grid'
    const tabs = document.createElement('div')
    tabs.className = 'wk-doc-tabs'
    let active = 0
    const draw = () => {
      const sh = parsed[active]
      grid.textContent = ''
      if (sh.truncated) {
        const note = document.createElement('div')
        note.className = 'wk-doc-note'
        note.textContent = `超出预览上限，仅显示前 ${WK_DOC_MAX_ROWS} 行 / ${WK_DOC_MAX_COLS} 列`
        grid.appendChild(note)
      }
      const table = document.createElement('table')
      table.className = 'wk-doc-table'
      const thead = document.createElement('thead')
      const hrow = document.createElement('tr')
      const corner = document.createElement('th')
      corner.className = 'wk-doc-corner'
      hrow.appendChild(corner)
      for (let c = 0; c < sh.ncols; c++) {
        const th = document.createElement('th')
        th.className = 'wk-doc-ch'
        th.textContent = wkDocColName(c)
        if (sh.widths[c]) th.style.minWidth = sh.widths[c] + 'px'
        hrow.appendChild(th)
      }
      thead.appendChild(hrow)
      table.appendChild(thead)
      const tbody = document.createElement('tbody')
      for (let r = 0; r < sh.nrows; r++) {
        const tr = document.createElement('tr')
        if (sh.heights[r]) tr.style.height = sh.heights[r] + 'px'
        const rh = document.createElement('th')
        rh.className = 'wk-doc-rh'
        rh.textContent = String(r + 1)
        tr.appendChild(rh)
        for (let c = 0; c < sh.ncols; c++) {
          if (sh.covered.has(r + '_' + c)) continue
          const td = document.createElement('td')
          const mg = sh.merges[r + '_' + c]
          if (mg) {
            if (mg.cs > 1) td.colSpan = mg.cs
            if (mg.rs > 1) td.rowSpan = mg.rs
            td.className = 'wk-doc-merged'
          }
          const cell = sh.cells[r + '_' + c]
          if (cell) {
            td.textContent = cell.v
            if (cell.style) td.setAttribute('style', cell.style)
          }
          if (sh.widths[c]) td.style.minWidth = sh.widths[c] + 'px'
          tr.appendChild(td)
        }
        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
      grid.appendChild(table)
      for (const [i, b] of Array.from(tabs.children).entries()) b.classList.toggle('on', i === active)
    }
    parsed.forEach((sh, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'wk-doc-tab'
      b.textContent = sh.name
      b.addEventListener('click', () => { active = i; draw() })
      tabs.appendChild(b)
    })
    wrap.append(bar, grid)
    if (parsed.length > 1) wrap.appendChild(tabs)
    body.textContent = ''
    body.appendChild(wrap)
    draw()
  }

  // ---------- DOCX ----------
  function wkDocDocxStyles(files) {
    const doc = wkDocXml(files, 'word/styles.xml')
    const out = {}
    for (const s of wkDocAll(doc, 'style')) {
      const id = wkDocAttr(s, 'styleId')
      if (id) out[id] = wkDocAttr(wkDocKids(s, 'name')[0], 'val')
    }
    return out
  }

  function wkDocDocxRun(r) {
    const rPr = wkDocKids(r, 'rPr')[0]
    const frag = document.createDocumentFragment()
    const style = []
    if (wkDocKids(rPr, 'b').some(wkDocOn)) style.push('font-weight:600')
    if (wkDocKids(rPr, 'i').some(wkDocOn)) style.push('font-style:italic')
    const u = wkDocKids(rPr, 'u')[0]
    if (u && wkDocAttr(u, 'val') !== 'none') style.push('text-decoration:underline')
    if (wkDocKids(rPr, 'strike').some(wkDocOn)) style.push('text-decoration:line-through')
    const color = wkDocRgb(wkDocAttr(wkDocKids(rPr, 'color')[0], 'rgb'))
    if (color) style.push('color:' + color)
    const sz = Number(wkDocAttr(wkDocKids(rPr, 'sz')[0], 'val'))
    if (Number.isFinite(sz) && sz > 0) style.push('font-size:' + (sz / 2) + 'pt')
    for (const node of Array.from(r.children)) {
      if (node.localName === 't') {
        const span = document.createElement('span')
        if (style.length) span.setAttribute('style', style.join(';'))
        span.textContent = node.textContent || ''
        frag.appendChild(span)
      } else if (node.localName === 'tab') {
        frag.appendChild(document.createTextNode('\u00a0\u00a0\u00a0\u00a0'))
      } else if (node.localName === 'br' || node.localName === 'cr') {
        frag.appendChild(document.createElement('br'))
      }
    }
    return frag
  }

  function wkDocDocxP(p, styles) {
    const pPr = wkDocKids(p, 'pPr')[0]
    const sid = wkDocAttr(wkDocKids(pPr, 'pStyle')[0], 'val')
    const name = String(styles[sid] || '').toLowerCase()
    const h = /^heading\s*([1-6])$/.exec(name) || /^heading([1-6])$/.exec(String(sid).toLowerCase())
    const numbered = !!wkDocKids(pPr, 'numPr')[0]
    const el = document.createElement(h ? 'h' + h[1] : numbered ? 'div' : 'p')
    if (h) el.className = 'wk-doc-h' + h[1]
    else if (numbered) el.className = 'wk-doc-li'
    const jc = wkDocAttr(wkDocKids(pPr, 'jc')[0], 'val')
    if (jc) el.style.textAlign = jc === 'center' ? 'center' : jc === 'right' ? 'right' : jc === 'both' ? 'justify' : 'left'
    for (const node of Array.from(p.children)) {
      if (node.localName === 'r') el.appendChild(wkDocDocxRun(node))
      else if (node.localName === 'hyperlink') for (const r of wkDocKids(node, 'r')) el.appendChild(wkDocDocxRun(r))
    }
    if (!el.textContent && !el.querySelector('br')) el.appendChild(document.createElement('br'))
    return el
  }

  function wkDocDocxTbl(tbl, styles) {
    const table = document.createElement('table')
    table.className = 'wk-doc-dtable'
    for (const tr of wkDocKids(tbl, 'tr')) {
      const row = document.createElement('tr')
      for (const tc of wkDocKids(tr, 'tc')) {
        const td = document.createElement('td')
        const tcPr = wkDocKids(tc, 'tcPr')[0]
        const span = Number(wkDocAttr(wkDocKids(tcPr, 'gridSpan')[0], 'val')) || 1
        if (span > 1) td.colSpan = span
        const fill = wkDocRgb(wkDocAttr(wkDocKids(tcPr, 'shd')[0], 'fill'))
        if (fill) td.style.background = fill
        for (const p of wkDocKids(tc, 'p')) td.appendChild(wkDocDocxP(p, styles))
        row.appendChild(td)
      }
      table.appendChild(row)
    }
    return table
  }

  function wkDocRenderDocx(body, path, buf) {
    const files = wkDocUnzip(buf)
    const doc = wkDocXml(files, 'word/document.xml')
    const root = doc && wkDocAll(doc, 'body')[0]
    if (!root) throw new Error('文档结构缺失（word/document.xml）')
    const styles = wkDocDocxStyles(files)
    const wrap = document.createElement('div')
    wrap.className = 'wk-doc wk-doc-docx'
    const bar = document.createElement('div')
    bar.className = 'wk-doc-bar'
    const nm = document.createElement('span')
    nm.className = 'wk-doc-name'
    nm.textContent = String(path).split('/').pop()
    const meta = document.createElement('span')
    meta.className = 'wk-doc-meta'
    meta.textContent = '只读预览 · Word'
    bar.append(nm, meta)
    const page = document.createElement('div')
    page.className = 'wk-doc-page'
    for (const child of Array.from(root.children)) {
      if (child.localName === 'p') page.appendChild(wkDocDocxP(child, styles))
      else if (child.localName === 'tbl') page.appendChild(wkDocDocxTbl(child, styles))
    }
    wrap.append(bar, page)
    body.textContent = ''
    body.appendChild(wrap)
  }

  // 统一入口：work-editor.readFile 在 PDF/图片分支之后调用（抛错由调用方落「读取失败」）
  function wkDocRender(body, path, buf) {
    const kind = wkDocKind(path)
    if (kind === 'xlsx') return wkDocRenderXlsx(body, path, buf)
    if (kind === 'docx') return wkDocRenderDocx(body, path, buf)
    throw new Error('不支持的文档类型')
  }

  // 渲染基准：pdf.js 视口 scale=1 是 72dpi，浏览器 CSS 像素按 96dpi —— 100% = scale 96/72。
  const WK_PDF_BASE = 96 / 72
  const WK_PDF_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]
  const WK_PDF_V = '593' // 与 index.html/sw.js 的 cache-bust 同值
  let wkPdfLib = null
  let wkPdfGen = 0 // 每次装载自增；迟到的解析结果据此作废
  let wkPdfLive = null // 当前文档的释放函数

  async function wkPdfLoadLib() {
    if (!wkPdfLib) {
      // vendor 文件按 .js 命名（不是 .mjs）：静态路由的 MIME 表只登记 .js = text/javascript，
      // 动态 import 与 module worker 都要求 JS MIME，改扩展名即可避开后端 MIME 表改动。
      const lib = await import('/vendor/pdfjs/pdf.min.js?v=' + WK_PDF_V)
      lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js?v=' + WK_PDF_V
      wkPdfLib = lib
    }
    return wkPdfLib
  }

  // 切走/换文件时调用：作废在途装载并释放当前文档（worker + canvas + 文本层）。
  function wkPdfClose() {
    wkPdfGen++
    if (wkPdfLive) {
      const fn = wkPdfLive
      wkPdfLive = null
      try { fn() } catch { /* 释放失败不影响切文件 */ }
    }
  }

  // 入口：body = #wk-ed-body，buf = ArrayBuffer（原样交给 pdf.js，worker 侧会转移）。
  // restoreTop = 该文件上次的滚动位置（切到别的文件/tab 再切回时由 work-editor.js 传入）。
  async function wkPdfRender(body, path, buf, restoreTop) {
    wkPdfClose()
    const gen = wkPdfGen
    body.innerHTML = '<div class="wk-ed-empty">正在打开 PDF…</div>'
    let lib
    try {
      lib = await wkPdfLoadLib()
    } catch (e) {
      if (gen === wkPdfGen) body.innerHTML = `<div class="wk-ed-empty">PDF 引擎不可用：${esc(e.message || e)}</div>`
      return
    }
    if (gen !== wkPdfGen) return
    const task = lib.getDocument({
      data: new Uint8Array(buf),
      cMapUrl: '/vendor/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      isEvalSupported: false,
      useWorkerFetch: false,
    })
    let doc
    try {
      doc = await task.promise
    } catch (e) {
      if (gen !== wkPdfGen) return
      body.innerHTML = `<div class="wk-ed-empty">PDF 解析失败：${esc(e.message || e)}</div>`
      return
    }
    if (gen !== wkPdfGen) {
      try { doc.destroy() } catch { /* 已作废 */ }
      return
    }
    wkPdfMount(body, path, lib, doc, restoreTop)
  }

  function wkPdfMount(body, path, lib, doc, restoreTop) {
    const scroll = document.createElement('div')
    scroll.className = 'wk-pdf-scroll'
    const pages = document.createElement('div')
    pages.className = 'wk-pdf-pages'
    scroll.appendChild(pages)
    const name = String(path).split('/').pop()

    const wrap = document.createElement('div')
    wrap.className = 'wk-pdf'
    wrap.innerHTML =
      `<div class="wk-pdf-bar">` +
      `<span class="wk-pdf-name" title="${esc(path)}">${esc(name)}</span>` +
      `<span class="wk-pdf-total">${doc.numPages} 页</span>` +
      `<span class="wk-pdf-grow"></span>` +
      `<button type="button" class="wk-pdf-btn" data-pdf="prev" title="上一页">‹</button>` +
      `<input class="wk-pdf-num" inputmode="numeric" value="1" aria-label="页码" />` +
      `<span class="wk-pdf-of">/ ${doc.numPages}</span>` +
      `<button type="button" class="wk-pdf-btn" data-pdf="next" title="下一页">›</button>` +
      `<span class="wk-pdf-sep"></span>` +
      `<button type="button" class="wk-pdf-btn" data-pdf="out" title="缩小">−</button>` +
      `<button type="button" class="wk-pdf-btn wk-pdf-fit on" data-pdf="fit" title="适宽">适宽</button>` +
      `<button type="button" class="wk-pdf-btn" data-pdf="in" title="放大">+</button>` +
      `<span class="wk-pdf-pct">–</span>` +
      `</div>`
    wrap.appendChild(scroll)
    body.textContent = ''
    body.appendChild(wrap)

    const q = (s) => wrap.querySelector(s)
    const pageInput = q('.wk-pdf-num')
    const pctEl = q('.wk-pdf-pct')
    const fitBtn = q('[data-pdf="fit"]')

    const st = {
      zoom: 'fit', // 'fit' | number（1 = 96dpi 的 100%）
      visible: new Set(),
      epochs: 0,
      queue: [],
      queued: new Set(),
      busy: false,
      dead: false,
      tasks: new Set(),
      pages: [], // [{ el, canvas, text, base, state }]
      obs: null,
      obsResize: null,
      cur: 1,
      ready: false, // 首页尺寸到位前不渲染（否则先按 100% 渲一帧再重渲）
    }

    const dispose = () => {
      if (st.dead) return
      st.dead = true
      st.obs?.disconnect()
      st.obsResize?.disconnect()
      st.obs = null
      st.obsResize = null
      for (const t of st.tasks) { try { t.cancel() } catch { /* 已结束 */ } }
      st.tasks.clear()
      st.queue.length = 0
      st.queued.clear()
      // 页面 canvas 主动缩零：iOS 上大画布不释放会随文档残留（dsh 同做法）
      for (const p of st.pages) {
        p.canvas.width = 0
        p.canvas.height = 0
      }
      Promise.resolve().then(() => { try { doc.destroy() } catch { /* 已销毁 */ } })
    }
    wkPdfLive = dispose

    for (let n = 1; n <= doc.numPages; n++) {
      const el = document.createElement('div')
      el.className = 'wk-pdf-page'
      el.dataset.page = String(n)
      el.innerHTML = '<div class="wk-pdf-ph" role="status" aria-label="加载第 ' + n + ' 页"></div>' +
        '<div class="wk-pdf-surface" hidden><canvas class="wk-pdf-canvas" role="img" aria-label="第 ' + n + ' 页"></canvas><div class="textLayer wk-pdf-text"></div></div>'
      pages.appendChild(el)
      st.pages.push({
        el,
        canvas: el.querySelector('canvas'),
        text: el.querySelector('.textLayer'),
        surface: el.querySelector('.wk-pdf-surface'),
        base: 0, // 页面在 scale=96/72 下的 CSS 宽
        h: 0,    // 同基准下的 CSS 高（占位先按真实尺寸排好，滚动恢复才准）
        renderedZoom: 0,
        epoch: -1,
        n,
      })
    }

    // ---- 缩放 ----
    function fitZoom(p0) {
      const avail = scroll.clientWidth - 24
      return p0 && p0.base ? Math.max(0.1, avail / p0.base) : 1
    }
    function zoomValue() {
      const p0 = st.pages[0]
      return st.zoom === 'fit' ? fitZoom(p0) : st.zoom
    }
    // 占位盒按当前缩放落定尺寸：页栈总高与真实排版一致，恢复滚动位置（以及渲染前的观感）才准。
    function applyPageBoxes(zoom) {
      for (const p of st.pages) {
        if (!p.base) continue
        p.el.style.width = Math.round(p.base * zoom) + 'px'
        if (p.h) p.el.style.height = Math.round(p.h * zoom) + 'px'
      }
    }
    function setZoom(z) {
      st.zoom = z
      st.epochs++
      fitBtn.classList.toggle('on', z === 'fit')
      pctEl.textContent = Math.round(zoomValue() * 100) + '%'
      applyPageBoxes(zoomValue())
      // 重渲可见页 + 当前页（其余页在滚入可视区时按新 epoch 渲染）
      const want = new Set(st.visible)
      want.add(st.cur)
      for (const n of want) requestRender(n)
    }
    function stepZoom(dir) {
      const cur = zoomValue()
      if (dir > 0) {
        const next = WK_PDF_STEPS.find((v) => v > cur + 0.001)
        setZoom(next || WK_PDF_STEPS[WK_PDF_STEPS.length - 1])
      } else {
        const lower = WK_PDF_STEPS.filter((v) => v < cur - 0.001)
        setZoom(lower.length ? lower[lower.length - 1] : WK_PDF_STEPS[0])
      }
    }

    // ---- 渲染队列（串行，避免多页同时分配大画布）----
    function requestRender(n) {
      if (st.dead || !st.pages[n - 1]) return
      if (st.queued.has(n)) return
      st.queued.add(n)
      st.queue.push(n)
      void pump()
    }
    async function pump() {
      if (st.busy || st.dead || !st.ready) return
      const n = st.queue.shift()
      if (n == null) return
      st.busy = true
      try { await renderPage(n) } catch { /* 单页失败保留占位（重渲会再试） */ }
      st.busy = false
      st.queued.delete(n)
      if (!st.dead && st.queue.length) void pump()
    }
    async function renderPage(n) {
      const p = st.pages[n - 1]
      const epoch = st.epochs
      st.queued.add(n)
      const page = await doc.getPage(n)
      if (st.dead || epoch !== st.epochs) return
      const baseVp = page.getViewport({ scale: WK_PDF_BASE })
      p.base = baseVp.width
      const zoom = zoomValue()
      if (p.epoch === epoch && Math.abs(p.renderedZoom - zoom) < 0.001) return
      const vp = page.getViewport({ scale: WK_PDF_BASE * zoom })
      const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(16_777_216 / (vp.width * vp.height)))
      p.canvas.width = Math.max(1, Math.floor(vp.width * ratio))
      p.canvas.height = Math.max(1, Math.floor(vp.height * ratio))
      p.canvas.style.width = vp.width + 'px'
      p.canvas.style.height = vp.height + 'px'
      p.surface.style.width = vp.width + 'px'
      const task = page.render({ canvas: p.canvas, viewport: vp, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
      st.tasks.add(task)
      // 文本层（可选文本；容器尺寸与画布一致，CSS 变量告知 pdf.js 当前缩放）
      let textLayer
      try {
        p.text.textContent = ''
        p.text.style.setProperty('--total-scale-factor', String(vp.scale))
        textLayer = new lib.TextLayer({ textContentSource: page.streamTextContent(), container: p.text, viewport: vp })
      } catch { textLayer = null }
      try {
        await Promise.all([task.promise, textLayer ? textLayer.render() : Promise.resolve()])
      } finally {
        st.tasks.delete(task)
        try { page.cleanup() } catch { /* 已销毁 */ }
      }
      if (st.dead || epoch !== st.epochs) return
      p.renderedZoom = zoom
      p.epoch = epoch
      p.surface.hidden = false
      const ph = p.el.querySelector('.wk-pdf-ph')
      if (ph) ph.hidden = true
      p.el.style.width = vp.width + 'px'
      pctEl.textContent = Math.round(zoomValue() * 100) + '%'
    }

    // ---- 可视区懒渲染 + 当前页 ----
    if (typeof IntersectionObserver === 'function') {
      st.obs = new IntersectionObserver((entries) => {
        for (const en of entries) {
          const n = Number(en.target.dataset.page)
          if (en.isIntersecting) {
            st.visible.add(n)
            requestRender(n)
          } else st.visible.delete(n)
        }
        syncCur()
      }, { root: scroll, rootMargin: '100% 0px' })
      for (const p of st.pages) st.obs.observe(p.el)
    } else {
      for (const p of st.pages) requestRender(p.n)
    }
    function syncCur() {
      // 当前页 = 顶部越过滚动口顶沿的最后一页；全在下方则取第一页
      let cur = 1
      const top = scroll.getBoundingClientRect().top
      for (const p of st.pages) {
        if (p.el.getBoundingClientRect().top - top <= 24) cur = p.n
        else break
      }
      if (cur !== st.cur) {
        st.cur = cur
        if (document.activeElement !== pageInput) pageInput.value = String(cur)
      }
    }
    let raf = 0
    scroll.addEventListener('scroll', () => {
      if (raf) return
      raf = requestAnimationFrame(() => { raf = 0; if (!st.dead) syncCur() })
    }, { passive: true })

    function goPage(n) {
      const target = Math.min(doc.numPages, Math.max(1, n | 0))
      const p = st.pages[target - 1]
      if (!p) return
      st.cur = target
      pageInput.value = String(target)
      scroll.scrollTop = p.el.offsetTop - pages.offsetTop
      requestRender(target)
    }

    // ---- 工具条 ----
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pdf]')
      if (!b) return
      const act = b.dataset.pdf
      if (act === 'prev') goPage(st.cur - 1)
      else if (act === 'next') goPage(st.cur + 1)
      else if (act === 'out') stepZoom(-1)
      else if (act === 'in') stepZoom(1)
      else if (act === 'fit') setZoom('fit')
    })
    pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { goPage(Number(pageInput.value)); pageInput.blur() }
    })
    pageInput.addEventListener('blur', () => {
      const n = Number(pageInput.value)
      if (Number.isFinite(n) && n >= 1 && n <= doc.numPages) goPage(n)
      else pageInput.value = String(st.cur)
    })
    // 容器宽度变化（右栏拖宽 / 横竖屏）：适宽态重算；固定比例态也要重算当前页布局
    if (typeof ResizeObserver === 'function') {
      let lastW = scroll.clientWidth
      const ro = new ResizeObserver(() => {
        if (st.dead || scroll.clientWidth === lastW) return
        lastW = scroll.clientWidth
        if (st.zoom === 'fit') setZoom('fit')
        else pctEl.textContent = Math.round(zoomValue() * 100) + '%'
      })
      ro.observe(scroll)
      st.obsResize = ro
    }

    // 首页尺寸 → fit 比例 → 立即渲首页（大文档不因量尺寸而空等）；其余页尺寸后台并行取，
    // 占位盒落成真实尺寸后再写回滚动位置（否则占位高 320px 会把 scrollTop 夹短）。
    void (async () => {
      try {
        const p0 = await doc.getPage(1)
        if (st.dead) return
        const vp = p0.getViewport({ scale: WK_PDF_BASE })
        st.pages[0].base = vp.width
        st.pages[0].h = vp.height
        try { p0.cleanup() } catch { /* 元数据已取到，资源可放 */ }
      } catch { /* 取不到尺寸：按占位高继续 */ }
      if (st.dead) return
      st.ready = true
      setZoom('fit')
      requestRender(1)
      if (!st.dead && st.queue.length) void pump()
      try {
        await Promise.all(st.pages.slice(1).map(async (p) => {
          const page = await doc.getPage(p.n)
          if (st.dead) return
          const vp = page.getViewport({ scale: WK_PDF_BASE })
          p.base = vp.width
          p.h = vp.height
          try { page.cleanup() } catch { /* 同上 */ }
        }))
      } catch { /* 单页取不到尺寸：该页保持占位高 */ }
      if (st.dead) return
      applyPageBoxes(zoomValue())
      if (restoreTop) {
        requestAnimationFrame(() => {
          if (st.dead) return
          scroll.scrollTop = Math.min(restoreTop, Math.max(0, scroll.scrollHeight - scroll.clientHeight))
        })
      }
    })()
  }

  // ---------- 评论标记（原文行打标，2026-10-06；2026-10-07 改编辑器行装饰器） ----------
  // 每条评论的行范围 l0..l1 落成 CodeMirror 行装饰：未解决 .cmt-mark-open / 已解决 .cmt-mark-res。
  function cmtApplyMarks() {
    const view = wkEdGetView()
    if (!view) return
    const marks = cmtRangesFor(state.workFile)
    wkEdApplyMarks(marks)
    if (wkCmtScrollId) {
      const id = wkCmtScrollId
      wkCmtScrollId = ''
      const hit = marks.find((m) => m.id === id)
      if (hit) wkEdScrollToLine(Math.min(hit.l0, view.state.doc.lines))
    }
  }

  // 顶部「保存态」文本落地（唯一写点）：conflict > saving > dirty > 空。传 (txt, cls) 则原样落。
  // 该行不再显示文件名，空态即整行隐藏（.wk-ed-head 的显示与否由这里统一收口）。
  function wkEdState(txt, cls) {
    const el = $('wk-ed-save')
    if (!el) return
    if (txt === undefined) {
      txt = wkEdConflict ? '外部已修改' : wkEdSaving ? '保存中…' : wkEdDirty ? '未保存' : ''
      cls = wkEdConflict ? 'conflict' : wkEdDirty || wkEdSaving ? 'dirty' : ''
    }
    el.textContent = txt || ''
    el.classList.toggle('dirty', cls === 'dirty')
    el.classList.toggle('conflict', cls === 'conflict')
    const head = $('wk-ed-head')
    if (head) head.hidden = !txt
  }

  // 编辑卡的滚动位置按 (项目, 文件) 逐份记忆——「切走」有两种形态，都必须记：①主区「文件 ↔ 聊天」
  // 切换时 #work-editor 变 display:none，不参与布局的元素其滚动容器 scrollTop 被浏览器夹回 0；
  // ②切到另一个文件 tab 再切回来，readFile 换文档、旧 DOM 连同滚动位置一起没了。故捕获点有两处
  // （applyPanes 隐藏前 / openWorkFile 换文件前），恢复点也有两处（重新显示 / 文档重新载入）。
  // 滚动容器两态：CM6 的 scrollDOM / PDF 卡自己的 .wk-pdf-scroll。
  const wkEdScrollMemo = new Map()
  const wkEdScrollKey = () => state.workProj + '\u0000' + state.workFile
  function wkEdScroller() {
    const v = wkEdGetView()
    if (v && v.scrollDOM && v.scrollDOM.isConnected) return v.scrollDOM
    const body = $('wk-ed-body')
    return (body && body.querySelector('.wk-pdf-scroll')) || null
  }
  function wkEdCaptureScroll() {
    const el = wkEdScroller()
    if (!el || !state.workFile) return
    wkEdScrollMemo.set(wkEdScrollKey(), el.scrollTop)
  }
  // 恢复：key 缺省 = 当前 (项目, 文件)。容器取「此刻」的滚动容器而非捕获时那个——换文件后
  // PDF 会重建新的 .wk-pdf-scroll 节点。
  function wkEdRestoreScroll(key) {
    const top = wkEdScrollMemo.get(key || wkEdScrollKey())
    if (!top) return
    // 布局本帧才切回 flex / 文档本帧才灌入，容器高度此刻未必已恢复；下一帧再写，否则 scrollTop 仍被夹到 0。
    requestAnimationFrame(() => {
      const el = wkEdScroller()
      if (el && el.isConnected) el.scrollTop = top
    })
  }

  function renderEditor() {
    const body = $('wk-ed-body')
    if (!body) return
    if (!state.workFile) {
      wkEdReset()
      body.innerHTML = '<div class="wk-ed-empty">从左侧文件树选择一个文件</div>'
      return
    }
    if (!state.workProj) {
      wkEdReset()
      body.innerHTML = '<div class="wk-ed-empty">未选择项目</div>'
      return
    }
    // 返回载入 Promise（新文件/新项目才读盘）：调用方要等「文档真进编辑器」才能定位行（如卡片 src-open 跳行）。
    // 缓存键 = (workProj, workFile) 两维——只比路径会在「两项目存在同名相对路径」（如都开 README.md）时
    // 判为同一文件：切项目后不重读，编辑区留着上个项目的内容（PDF 分支表现为旧 iframe 换「不支持预览」，
    // 文本分支更会被后续自动保存写进新项目同名文件 = 跨项目串台/污染）。项目维度不可省。
    if (wkEdFile !== state.workFile || wkEdProj !== state.workProj) return readFile(state.workFile)
    renderEdBody()
  }

  function wkEdReset() {
    wkLiveReset()
    wkEdFile = ''
    wkEdMeta = null
    wkEdText = ''
    wkEdMtime = null
    wkEdDirty = false
    wkEdConflict = false
    wkEdPendingDoc = null
    wkEdProj = ''
    wkPdfClose()
    if (wkEdGetView()) { wkEdSetLang(''); wkEdSetDoc('') }
    wkEdApplyMarks([])
    if (wkEdTimer) {
      clearTimeout(wkEdTimer)
      wkEdTimer = 0
    }
    wkEdState('')
  }

  function renderEdBody() {
    const body = $('wk-ed-body')
    if (!body || !wkEdMeta) return
    if (wkEdMeta.isImg) {
      body.innerHTML = `<div class="wk-ed-img"><img src="${esc(fileUrl(state.workFile))}" alt="${esc(state.workFile)}" /></div>`
      return
    }
    if (!wkEdMeta.editable) {
      // PDF / Office 的只读视图由 readFile 直渲（wkPdfRender / wkDocRender），本函数**不得**用
      // 「不支持预览」占位覆盖它——否则同一文件重新过一遍 renderEditor（切走再切回、评论重渲）就把
      // 页栈连同滚动位置一起销毁。错误态（413/403/二进制）没有 view 标记，照旧落提示。
      if (wkEdMeta.view) return
      body.innerHTML = `<div class="wk-ed-empty">${esc(wkEdMeta.msg || '不支持预览')}</div>`
      return
    }
    // 可编辑文本（含 md）：常驻 CodeMirror 6 编辑器。把 host 挂回 body 并测量（body 可能被别的渲染重建过
    // 子节点）；仅当 readFile 置了 wkEdPendingDoc（新文件）才换文档 + 热换语言，否则保留编辑器现状
    // （重渲不得用陈旧基线覆盖用户未保存的编辑）。
    wkEditor.attach(body)
    const fresh = wkEdPendingDoc !== null
    if (fresh) {
      wkEdSetLang(state.workFile)
      wkEdSetDoc(wkEdPendingDoc)
      wkEdPendingDoc = null
    }
    wkEditor.measure()
    cmtApplyMarks() // 评论标记：被批注的行加高亮
    wkEdState()
    if (fresh) wkEdRestoreScroll() // 换文件重载 → 写回该文件上次的滚动位置（同文件切回不丢位置）
  }

  let wkEdProj = '' // 当前编辑内容所属项目（缓存键第二维；与 wkEdFile 配对，切项目即失效）

  // 死路径收口：读回 404 = 该路径在盘上已不存在（改名/删除后残留的开放集条目，含持久化恢复的）。
  // 摘出 state.wkFiles（顶栏 pill 的唯一来源），激活项按关 tab 同语义落到右邻/左邻/聊天；
  // 不保留一枚永远「读取失败」的空壳胶囊。**只认 404**——网络错误/413/403 是「读不出内容」而非
  // 「文件没了」，瞬时故障不该吞掉用户打开的视图。
  function wkDropDeadFile(p) {
    const i = state.wkFiles.indexOf(p)
    if (i >= 0) state.wkFiles.splice(i, 1)
    toast('文件不存在：' + p)
    if (state.workFile !== p) { applyPanes(); return }
    const next = state.wkFiles[i] != null ? state.wkFiles[i] : state.wkFiles[i - 1]
    if (next != null) return openWorkFile(next)
    state.workFile = ''
    state.wkMainTab = 'chat'
    renderEditor()
    applyPanes()
  }
  async function readFile(p) {
    const body = $('wk-ed-body')
    if (!body) return
    wkLiveReset() // 新文件的实时同步从不带旧文件的暂停/两次确认态开始
    const seq = ++edSeq
    // 立刻认下新 (proj,path)：并发重渲（切项目那一刻）不得拿旧 wkEdFile 命中缓存渲染上个项目的内容
    wkEdProj = state.workProj
    wkEdFile = ''
    wkEdConflict = false
    wkPdfClose()
    if (IMG_EXT.test(p)) {
      wkEdFile = p
      wkEdMeta = { isImg: true, editable: false }
      wkEdText = ''
      wkEdMtime = null
      renderEdBody()
      return
    }
    // PDF（2026-10-24 改 pdf.js）：读原始字节交给 work-pdf.js 真实渲染（页导航/缩放/文本层，
    // 对齐 dsh 文档预览）。渲染自闭环在分支内（不进 renderEdBody），不占用 wkEdMeta 状态；
    // 网关读侧 4 MB 上限对 PDF 同样生效，超限显式提示。
    if (/\.pdf$/i.test(p)) {
      wkEdFile = p
      wkEdMeta = { isImg: false, editable: false, view: 'pdf' } // view ⇒ 后续 renderEdBody 不覆盖已渲好的页栈
      wkEdText = ''
      wkEdMtime = null
      body.innerHTML = '<div class="wk-ed-empty">读取中…</div>'
      try {
        const res = await fetch(fileUrl(p))
        if (seq !== edSeq) return
        if (!res.ok) {
          if (res.status === 404) return wkDropDeadFile(p)
          wkEdMeta = { isImg: false, editable: false } // 错误态无视图，renderEdBody 落提示
          body.innerHTML =
            '<div class="wk-ed-empty">' +
            esc(res.status === 413 ? 'PDF 超过 4 MB，网关读取上限内不支持预览' : `读取失败（HTTP ${res.status}）`) +
            '</div>'
          return
        }
        const buf = await res.arrayBuffer()
        if (seq !== edSeq) return
        // 该文件上次的滚动位置（切到别的 tab 再切回 = 重新载入，页栈重建后写回）
        await wkPdfRender(body, p, buf, wkEdScrollMemo.get(state.workProj + '\u0000' + p))
      } catch (e) {
        if (seq !== edSeq) return
        body.innerHTML = `<div class="wk-ed-empty">读取失败：${esc(e.message || e)}</div>`
      }
      return
    }
    // Office 只读预览（2026-10-24）：xlsx/docx 二进制包交给 work-doc.js 解包渲染（不走文本分支，
    // 否则 content-type 判成二进制直接「不支持预览」）。网关读侧 4 MB 上限同样生效。
    if (wkDocKind(p)) {
      wkEdFile = p
      wkEdMeta = { isImg: false, editable: false, view: 'doc' } // view ⇒ 后续 renderEdBody 不覆盖已渲好的视图
      wkEdText = ''
      wkEdMtime = null
      body.innerHTML = '<div class="wk-ed-empty">读取中…</div>'
      try {
        const res = await fetch(fileUrl(p))
        if (seq !== edSeq) return
        if (!res.ok) {
          if (res.status === 404) return wkDropDeadFile(p)
          wkEdMeta = { isImg: false, editable: false } // 错误态无视图，renderEdBody 落提示
          body.innerHTML =
            '<div class="wk-ed-empty">' +
            esc(res.status === 413 ? '文件超过 4 MB，网关读取上限内不支持预览' : `读取失败（HTTP ${res.status}）`) +
            '</div>'
          return
        }
        const buf = await res.arrayBuffer()
        if (seq !== edSeq) return
        wkDocRender(body, p, buf)
      } catch (e) {
        if (seq !== edSeq) return
        body.innerHTML = `<div class="wk-ed-empty">读取失败：${esc(e.message || e)}</div>`
      }
      return
    }
    body.innerHTML = '<div class="wk-ed-empty">读取中…</div>'
    try {
      const res = await fetch(fileUrl(p))
      if (seq !== edSeq) return
      if (!res.ok) {
        if (res.status === 404) return wkDropDeadFile(p)
        wkEdFile = p
        wkEdMeta = {
          isImg: false,
          editable: false,
          msg:
            res.status === 413
              ? '文件超过 4 MB，不支持编辑'
              : res.status === 403
                ? '该项目外的路径不可访问'
                : `读取失败（HTTP ${res.status}）`,
        }
        renderEdBody()
        return
      }
      const ct = (res.headers.get('content-type') || '').toLowerCase()
      const looksText = /^text\/|json|javascript|typescript|xml|svg|x-sh|csv|yaml/.test(ct) || MD_EXT.test(p)
      if (!looksText) {
        wkEdFile = p
        wkEdMeta = { isImg: false, editable: false, msg: `二进制文件（${ct || '未知类型'}），不支持预览` }
        renderEdBody()
        return
      }
      const text = await res.text()
      if (seq !== edSeq) return
      const etag = res.headers.get('etag')
      let mtime = etag ? Number(etag.replace(/"/g, '')) : NaN
      if (!Number.isFinite(mtime)) mtime = null
      wkEdFile = p
      wkEdText = text
      wkEdMeta = { isImg: false, editable: true }
      wkEdMtime = mtime
      wkEdDirty = false
      wkEdPendingDoc = text // 新文档灌入编辑器 + 热换语言（renderEdBody 消费）
      renderEdBody()
    } catch (e) {
      if (seq !== edSeq) return
      body.innerHTML = `<div class="wk-ed-empty">读取失败：${esc(e.message || e)}</div>`
    }
  }

  // 强制重拉磁盘版本（冲突「取消」分支 / 需放弃本地改动时用）
  async function wkEdReload() {
    if (!state.workFile) return
    const p = state.workFile
    wkEdFile = ''
    await readFile(p)
  }

  // 切文件 / 切项目 / 退 work 前 flush：把 pending 编辑立即落盘
  async function wkEdFlush() {
    if (wkEdTimer) {
      clearTimeout(wkEdTimer)
      wkEdTimer = 0
    }
    if (!wkEdDirty || wkEdConflict) return
    await wkEdSave({})
  }

  // 保存：默认带 baseMtime（磁盘已变 → 409，不静默覆盖）；force = 无基线强制覆盖。
  // 返回 'ok' | 'clean' | 'conflict' | 'error' | 'busy'：409 不再弹模态，统一标记后交给实时合并链
  // （work-live.js）——无重叠自动三方合并写回，只有真正重叠才落到非模态提示条。
  async function wkEdSave(opts) {
    const force = !!(opts && opts.force)
    if (!state.workFile || !state.workProj) return 'clean'
    if (wkEdSaving) return 'busy'
    if (!wkEdDirty && !force) return 'clean'
    const content = wkEdDocText() // 落盘 payload = 当前真源；**不**写进 wkEdText（那是磁盘基线，三方合并的 base）
    if (wkEdTimer) {
      clearTimeout(wkEdTimer)
      wkEdTimer = 0
    }
    wkEdSaving = true
    wkEdState('保存中…', 'dirty')
    let conflict = false
    try {
      const payload = { label: state.workProj, path: state.workFile, content }
      if (!force && wkEdMtime !== null) payload.baseMtime = wkEdMtime
      const res = await fetch(apiUrl('/gateway/file/write'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.status === 409) conflict = true
      else {
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.ok) throw new Error(data.error || '保存失败')
        if (typeof data.mtime === 'number') wkEdMtime = data.mtime
        wkEdInvalidatePathCache() // 写盘成功 → 路径补全目录缓存失效（新文件/新目录要能补出来）
        wkEdText = content // 写盘成功才推进磁盘基线
        wkEdDirty = wkEdDocText() !== content // 保存期间又改了 → 留脏，下面续排程
      }
    } catch (e) {
      wkEdSaving = false
      wkEdState('保存失败', 'conflict')
      toast('保存失败：' + (e.message || e))
      return 'error'
    }
    wkEdSaving = false
    if (conflict) {
      wkEdConflict = true
      wkEdState('外部已修改', 'conflict')
      wkLiveKick() // 立即走实时合并链：能合就静默合并写回，重叠才提示
      return 'conflict'
    }
    wkEdConflict = false
    wkEdState()
    if (wkEdDirty) wkEdScheduleSave() // 保存期间又改了 → 续排程（wkEdState 先落地「未保存」）
    return 'ok'
  }

  // 打开一个文件（**唯一口**：侧栏文件树行 / 搜索浮窗行 / 顶栏文件 pill / 评论定位 / 预览卡 src-open 全走这里）。
  // 顶栏文件 pill 的多枚开放集由 applyPanes 兜底并入（`wkEnsureFileTab(state.workFile)`），故此处不必另加。
  async function openWorkFile(p) {
    if (!p) return
    if (p !== state.workFile) {
      // 切文件前先记住**旧文件**的滚动位置（键取自此刻仍有效的 state.workFile），再 flush 旧文件编辑
      wkEdCaptureScroll()
      if (wkEdDirty) await wkEdFlush()
    }
    state.workFile = p
    state.wkMainTab = 'file' // 点文件 = 明确要看内容 → 文件 tab 顶上来（不静默什么都不发生）
    saveWork()
    applyPanes()
    renderWorkBody()
    // 「用户打开了某文件」是一条**事实**，广播给当前工作项目的在场卡（Pj18 预览卡据此切到该篇 PDF）；
    // 内容判断（只认 .tex / 目录段推书稿名）由卡片自己定，宿主不替卡做过滤。带 label 限定 = 不跨项目串台。
    // 切激活项（点另一枚 pill）同样走这里 ⇒ 每次都重发一次；卡侧按路径去重，重复广播不会 reload。
    if (state.workProj) cardBus.broadcast({ label: state.workProj }, 'file-open', { path: p })
    await renderEditor() // 等文档真正进编辑器再返回（调用方据此在正确文档上定位行）
  }

  // 关一枚文件 tab（顶栏文件 pill 的 ×，p = 该 pill 的路径）：从开放集 state.wkFiles 移除。关的是
  // **激活项** → 切右邻 / 左邻（落点语义同 wkCloseTab）；一枚不剩 → 清 workFile、下沉格回聊天 tab
  // （「聊天 / 文件 / 预览至少一栏」由 applyPanes 保底）。非激活 tab 没有文档态（单编辑器模型，切前
  // flush），故只有关激活项才需要落盘 pending 编辑——绝不因关 tab 丢改动。
  async function closeWkFile(p) {
    const i = state.wkFiles.indexOf(p)
    if (i < 0) return
    state.wkFiles.splice(i, 1)
    if (p !== state.workFile) { applyPanes(); return } // 关非激活项：只少一枚 pill，文档与路由不动
    if (wkEdDirty) await wkEdFlush()
    const next = state.wkFiles[i] != null ? state.wkFiles[i] : state.wkFiles[i - 1]
    if (next != null) return openWorkFile(next) // 切到邻枚：载入 + 广播 file-open，预览卡跟着切
    state.workFile = ''
    state.wkMainTab = 'chat'
    saveWork()
    renderEditor()
    renderWorkBody()
    applyPanes()
  }

  const WK_LIVE_MS = 500
  let wkLiveT = 0
  let wkLiveBusy = false
  let wkLivePendingMtime = null // 连续两次 HEAD 得到同一个新 mtime 才采纳（防 AI 非原子写读到半截）
  let wkLivePausedKey = ''      // 冲突未处置时的 (proj\path)；换文件自动解除

  function wkLiveKey() {
    return state.workProj + '\n' + state.workFile
  }

  function setWkRemoteNote(text) {
    const el = $('wk-ed-remote')
    if (!el) return
    el.hidden = !text
    const t = el.querySelector('.wk-ed-remote-txt')
    if (t) t.textContent = text || ''
  }

  // 重置探测/暂停态（换文件、切项目、重载、退 work 共用）
  function wkLiveReset() {
    wkLivePendingMtime = null
    wkLivePausedKey = ''
    setWkRemoteNote('')
  }

  function startWorkLive() {
    if (!wkLiveT) wkLiveT = setInterval(() => { wkLiveTick(false) }, WK_LIVE_MS)
  }
  function stopWorkLive() {
    if (wkLiveT) {
      clearInterval(wkLiveT)
      wkLiveT = 0
    }
    wkLiveBusy = false
    wkLiveReset()
  }

  // 立即探测一次（保存 409 后由保存链调用；跳过「两次确认」，冲突处置不能再等一轮）
  function wkLiveKick() {
    wkLiveTick(true)
  }

  async function wkLiveTick(force) {
    if (wkLiveBusy) return
    if (state.sbMode !== 'work' || document.visibilityState !== 'visible' || needToken()) return
    if (!state.workFile || !state.workProj) return
    if (!wkEdMeta || !wkEdMeta.editable) return
    if (wkEdSaving) return
    const key = wkLiveKey()
    // 暂停态挡的是自动轮询；force（保存 409 后的立即重试）必须绕过它，否则冲突后 Ctrl+S 永远不再尝试合并。
    if (wkLivePausedKey === key && !force) return
    if (wkLivePausedKey) {
      // 换文件留下的暂停态：连提示一起清；同文件显式重试：先解暂停，提示留到结果（仍冲突会重写、合并成功才清）
      if (!force) wkLiveReset()
      else { wkLivePausedKey = ''; wkLivePendingMtime = null }
    }
    const proj = state.workProj
    const path = state.workFile
    const seq = edSeq
    wkLiveBusy = true
    try {
      const res = await fetch(fileUrl(path), { method: 'HEAD', cache: 'no-store' })
      if (proj !== state.workProj || path !== state.workFile || seq !== edSeq) return
      if (res.status === 404) {
        // 外部删除：无本地改动 → 与「打开着的文件消失」同语义摘胶囊；有改动则保留内容并提示
        if (wkEdDirty) return wkLiveConflict('文件已在外部删除，编辑器保留你的未保存内容')
        wkLiveReset()
        wkDropDeadFile(path)
        return
      }
      if (!res.ok) {
        wkLivePendingMtime = null // 413/网络错误不是「文件变了」，下轮重试
        return
      }
      const etag = res.headers.get('etag')
      const mtime = etag ? Number(etag.replace(/"/g, '')) : NaN
      if (!Number.isFinite(mtime)) return
      if (mtime === wkEdMtime) {
        wkLivePendingMtime = null
        return
      }
      if (!force) {
        if (wkLivePendingMtime !== mtime) {
          wkLivePendingMtime = mtime
          return // 首次看到新 mtime：等下一轮确认（写盘可能还未完成）
        }
      }
      wkLivePendingMtime = null
      await wkLiveAdopt(proj, path, seq, mtime)
    } catch {
      /* 瞬时网络错误忽略，下轮重试 */
    } finally {
      wkLiveBusy = false
    }
  }

  // 采纳一次外部变更：拉新内容 → 无脏直接换 / 有脏三方合并写回
  async function wkLiveAdopt(proj, path, seq, headMtime) {
    const res = await fetch(fileUrl(path), { cache: 'no-store' })
    if (proj !== state.workProj || path !== state.workFile || seq !== edSeq) return
    if (!res.ok) return
    const text = await res.text()
    if (proj !== state.workProj || path !== state.workFile || seq !== edSeq) return
    const etag = res.headers.get('etag')
    let mtime = etag ? Number(etag.replace(/"/g, '')) : NaN
    if (!Number.isFinite(mtime)) mtime = headMtime
    if (!wkEdDirty) {
      // 无未落盘编辑：最小段替换直接映进编辑器（光标/选区/滚动由 CM 按变更映射）
      if (!wkEdApplyRemote(text)) return // IME 组合中：本轮放弃，下轮重试
      wkEdText = text
      wkEdMtime = mtime
      wkEdConflict = false
      wkEdState('')
      setWkRemoteNote('')
      return
    }
    await wkLiveMergeAndSave(proj, path, seq, text, mtime, 2)
  }

  // 有脏：三方合并（base = 上次磁盘基线 wkEdText）→ 写回；409 = 期间磁盘又变 → 重取重合并
  async function wkLiveMergeAndSave(proj, path, seq, remote, baseMtime, retries) {
    const merged = wkMerge3(wkEdText, wkEdDocText(), remote)
    if (!merged.ok) {
      return wkLiveConflict(
        merged.reason === 'too-large'
          ? '文件改动较大且与本地编辑重叠，已保留本地内容'
          : '文件已在外部更新且与本地编辑重叠，已保留本地内容'
      )
    }
    if (merged.text !== wkEdDocText()) {
      if (!wkEdApplyRemote(merged.text)) return
    }
    wkEdMtime = baseMtime
    const r = await wkEdSave({})
    if (r === 'ok' || r === 'clean') {
      wkLiveReset()
      return
    }
    if (r !== 'conflict' || retries <= 0) {
      return wkLiveConflict('外部改动频繁且与本地编辑重叠，已保留本地内容')
    }
    // 409：磁盘在我们合并期间又变了 → 取最新内容再合一次（base 仍是 wkEdText）
    const res = await fetch(fileUrl(path), { cache: 'no-store' })
    if (!res.ok) return
    const nextRemote = await res.text()
    if (proj !== state.workProj || path !== state.workFile || seq !== edSeq) return
    const etag = res.headers.get('etag')
    let nextMtime = etag ? Number(etag.replace(/"/g, '')) : NaN
    if (!Number.isFinite(nextMtime)) return
    return wkLiveMergeAndSave(proj, path, seq, nextRemote, nextMtime, retries - 1)
  }

  // 非模态提示：保留本地内容，暂停本文件的自动保存与实时同步，等用户显式处置
  function wkLiveConflict(text) {
    wkLivePausedKey = wkLiveKey()
    wkEdConflict = true
    wkEdState('外部已修改', 'conflict')
    setWkRemoteNote(text)
  }

  // 提示条「保留我的版本」：放弃磁盘那次外部改动、以本地内容强制覆盖（原模态的「确定」分支）
  async function wkLiveKeepLocal() {
    if (!state.workFile) return
    wkLiveReset()
    wkEdConflict = false
    await wkEdSave({ force: true })
    wkEdState('')
  }

  // 提示条「载入磁盘版本」：放弃本地编辑，重读磁盘（404 时按文件消失语义收口）
  async function wkLiveTakeRemote() {
    if (!state.workFile) return
    wkLiveReset()
    wkEdDirty = false
    wkEdConflict = false
    await wkEdReload()
    wkEdState('')
  }

  // ---------- 文件 / 目录行操作（2026-09-27：与侧栏会话行同一套右键 / 长按浮窗，见 recent.js registerRowMenu）----------
  // 两个写接口落在网关（POST /gateway/file/rename | /delete），本模块只做「弹出菜单 + 提交 + 刷新树」。
  // 删除 = 移入项目根 .trash/（工作区规范禁止真删），故不设二次确认——.trash/ 本身就是撤销位。
  function baseOf(p) {
    const i = p.lastIndexOf('/')
    return i < 0 ? p : p.slice(i + 1)
  }
  function openFileRename(p) {
    if (!p) return
    openRenameDialog({
      heading: '重命名',
      placeholder: '输入新名称',
      okText: '重命名',
      value: baseOf(p),
      onSubmit: async (name) => {
        const res = await fetch(apiUrl('/gateway/file/rename'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: state.workProj, path: p, name }),
        })
        const data = await res.json()
        if (!res.ok || !data.ok) throw new Error(data.error || '重命名失败')
        // 展开态与编辑区都按旧路径记着，须同步搬到新路径（目录改名 = 整棵子树的路径前缀都变）
        for (const k of [...wkOpen]) {
          if (k === p) { wkOpen.delete(k); wkOpen.add(data.path) }
          else if (k.startsWith(p + '/')) { wkOpen.delete(k); wkOpen.add(data.path + k.slice(p.length)) }
        }
        if (state.workFile === p) state.workFile = data.path
        else if (state.workFile.startsWith(p + '/')) state.workFile = data.path + state.workFile.slice(p.length)
        saveWork()
        await loadProjectTree(state.workProj)
        renderEditor()
        renderWorkBody()
        applyPanes() // 顶栏文件名 pill 跟着新路径重渲
        toast('已重命名为「' + data.name + '」')
      },
    })
  }
  // 「在资源管理器中打开」（2026-10-24）：网关进程在本机，explorer 打开的就是用户桌面。
  // 文件 = 父目录里选中该文件（/select,）；目录 = 直接打开该目录。请求体与删除同构（label + path）。
  async function revealWorkEntry(p) {
    if (!p) return
    try {
      const res = await fetch(apiUrl('/gateway/file/reveal'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: state.workProj, path: p }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) throw new Error(data.error || '打开失败')
    } catch (e) {
      toast('打开失败：' + (e.message || e))
    }
  }
  async function deleteWorkEntry(p) {
    if (!p) return
    try {
      const res = await fetch(apiUrl('/gateway/file/delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: state.workProj, path: p }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || '删除失败')
      if (state.workFile === p || state.workFile.startsWith(p + '/')) state.workFile = ''
      for (const k of [...wkOpen]) if (k === p || k.startsWith(p + '/')) wkOpen.delete(k)
      saveWork()
      // 增量更新（2026-10-14 待办 12）：后端已确认成功，先就地从内存树摘掉该节点重渲（不闪整树、
      // 不置加载态），再后台静默对账一次（HTML 比对，内容一致零写 DOM）。不走非静默 loadProjectTree
      // ——那会把 wkTree 清成「加载中…」整树重建，即用户报的「强制刷新」。
      wkTreeRemove(p)
      renderWorkBody()
      renderEditor()
      applyPanes() // 删掉当前打开的文件 → 文件 tab 退场、下沉格切回聊天/空
      toast('已移入 ' + data.trash)
      loadProjectTree(state.workProj, true)
    } catch (e) {
      toast('删除失败：' + (e.message || e))
    }
  }
  // 目录行归档（2026-11-07）：与项目行归档同语义——打成 <项目根>/.achrives/<名>-<ts>.tar.gz，
  // 原目录移入 <项目根>/.trash/。成功后该子树整体离场，打开集与编辑区按「目录删除」同口径清理。
  async function archiveWorkEntry(p) {
    if (!p) return
    try {
      toast('正在归档「' + baseOf(p) + '」…')
      const res = await fetch(apiUrl('/gateway/file/archive'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: state.workProj, path: p }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) throw new Error(data.error || '归档失败')
      if (state.workFile === p || state.workFile.startsWith(p + '/')) state.workFile = ''
      for (const k of [...wkOpen]) if (k === p || k.startsWith(p + '/')) wkOpen.delete(k)
      saveWork()
      wkTreeRemove(p)
      renderWorkBody()
      renderEditor()
      applyPanes()
      toast('已归档到 ' + data.path + '，原目录移入 ' + data.trash)
      loadProjectTree(state.workProj, true)
    } catch (e) {
      toast('归档失败：' + (e.message || e))
    }
  }
  // 文件 / 目录行菜单「项 + 动作」唯一实现（2026-10-25）：侧栏文件树行 `.wk-row` 与 work 顶栏
  // 文件 pill `[data-wkftab]` 共用本 spec，禁止各写一套菜单。getEntry(el) → { path, dir }。
  // 「下载」仅文件出（2026-10-13 待办 1）：目录整棵打包无既有实现，不新造。
  function fileRowMenuSpec(getEntry) {
    const entryOf = (el) => getEntry(el) || {}
    return {
      items: (el) => {
        const { path, dir } = entryOf(el)
        if (!path) return []
        const head = [
          { a: 'reveal', icon: I.dshExplorer, label: '在资源管理器中打开' },
          { a: 'rename', icon: I.dshEdit, label: '重命名' },
        ]
        const del = { a: 'delete', icon: I.dshStop, label: '删除', danger: true }
        const arc = { a: 'archive', icon: I.dshCompact, label: '归档' }
        return dir
          ? [...head, arc, del]
          : [...head, { a: 'download', icon: I.dshDownload, label: '下载' }, del]
      },
      pick: (a, el) => {
        const { path } = entryOf(el)
        if (a === 'reveal') revealWorkEntry(path)
        else if (a === 'rename') openFileRename(path)
        else if (a === 'archive') archiveWorkEntry(path)
        else if (a === 'download') downloadWorkEntry(path)
        else deleteWorkEntry(path)
      },
    }
  }
  // ---------- 项目行操作（2026-11-06）：长按 / 右键项目下拉行 → 归档（全部项目）/ 删除（仅临时项目） ----------
  // 归档 = 压缩进 <工作区根>/.achrives/<label>-<ts>.tar.gz（tar 顺序流，无 zip 中央索引）+ 原目录移入
  // .trash/；删除 = 临时项目（根级时间戳任务区）目录直接移入 .trash/，不压缩。两口的语义与防护都在
  // 网关（archiveProject / deleteTempProject），前端只做「确认手势 → 提交 → 列表对账」。
  // 与文件删除同口径不设二次确认：.trash/ 是撤销位，归档包在 .achrives 另存一份。
  // 当前工作项目被移走后必须整体退场（不能停在一个已不存在的项目上）：切空槽 + 清打开集 + 回空态首页。
  async function wkAfterProjectGone(label) {
    // 下拉只在「被移走的正是当前工作项目」时收：其余情况保持打开，让用户接着操作别的项目
    // （下拉内容由下面的 renderWorkChrome → renderWorkProjects 就地刷新，被归档的行自然消失）。
    if (state.workProj === label) {
      hideWkPops()
      switchWorkProject('')
      state.workFile = ''
      state.wkFiles = []
      wkOpen.clear()
      wkTree = null
      wkErr = ''
      navigate('#/')
      saveWork()
      renderEditor()
      renderWorkPreview()
      applyPanes()
    }
    await loadSessions()
    renderWorkChrome()
    renderWorkBody()
    renderTopbar()
  }
  async function archiveWorkProject(label) {
    if (!label) return
    try {
      if (state.workProj === label && wkEdDirty) await wkEdFlush() // 未保存编辑先落盘，否则归档包缺最新内容
      toast('正在归档「' + label + '」…')
      const res = await fetch(apiUrl('/gateway/project/archive'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) throw new Error(data.error || '归档失败')
      await wkAfterProjectGone(label)
      toast('已归档到 ' + data.archive)
    } catch (e) {
      toast('归档失败：' + (e.message || e))
    }
  }
  async function deleteWorkProject(label) {
    if (!label || !isTempProjLabel(label)) return
    try {
      const res = await fetch(apiUrl('/gateway/project/delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) throw new Error(data.error || '删除失败')
      await wkAfterProjectGone(label)
      toast('已移入 ' + data.trash)
    } catch (e) {
      toast('删除失败：' + (e.message || e))
    }
  }
  // 项目重命名（2026-11-07）：改的是 <工作区根>/<label> 目录名（label 即项目标识，会话转录在项目内
  // 随目录一起走）。改名后要把「按 label 索引的本地状态」整体搬到新键：project 槽（state.workSlots）
  // 与两个指针（workProj / workSlotKey），以及 chat 侧的 state.newProject；打开集/编辑文件是项目内
  // 相对路径，不受影响。
  async function renameWorkProject(label) {
    if (!label) return
    openRenameDialog({
      heading: '重命名项目',
      placeholder: '输入新项目名',
      okText: '重命名',
      value: label,
      onSubmit: async (name) => {
        if (state.workProj === label && wkEdDirty) await wkEdFlush() // 先落盘，避免丢未保存编辑
        const res = await fetch(apiUrl('/gateway/project/rename'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label, name }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.ok) throw new Error(data.error || '重命名失败')
        const next = data.label
        if (state.workSlots && state.workSlots[label]) {
          state.workSlots[next] = state.workSlots[label]
          delete state.workSlots[label]
        }
        if (state.workProj === label) state.workProj = next
        if (state.workSlotKey === label) state.workSlotKey = next
        if (state.newProject === label) state.newProject = next
        saveWork()
        await loadSessions() // 项目列表 / 会话归属都按新目录重扫
        renderWorkChrome()
        renderWorkBody()
        renderTopbar()
        toast('项目已重命名为「' + next + '」')
      },
    })
  }
  // 项目行菜单项：归档恒有；删除只对临时项目（长期项目走归档，避免误删整棵项目）。
  function projectRowMenuSpec() {
    return {
      items: (el) => {
        const label = el.dataset.pk || ''
        if (!label) return []
        const out = [
          { a: 'rename', icon: I.dshEdit, label: '重命名' },
          { a: 'archive', icon: I.dshCompact, label: '归档' },
        ]
        if (isTempProjLabel(label)) out.push({ a: 'delete', icon: I.dshTrash, label: '删除', danger: true })
        return out
      },
      pick: (a, el) => {
        const label = el.dataset.pk || ''
        if (a === 'rename') renameWorkProject(label)
        else if (a === 'archive') archiveWorkProject(label)
        else if (a === 'delete') deleteWorkProject(label)
      },
    }
  }
  // 文件树行源：文件与目录同一套菜单（目录删除 = 整棵子树进 .trash/）；操作对象 = 行的项目内相对路径。
  // 项目下拉行同一个注册式浮窗（长按 / 右键），项目行的操作对象 = 项目 label。
  function registerWorkRows() {
    registerRowMenu({
      sel: '.wk-row',
      key: (el) => el.dataset.wkfile || el.dataset.wkdir || null,
      ...fileRowMenuSpec((el) => ({ path: el.dataset.wkfile || el.dataset.wkdir || '', dir: !!el.dataset.wkdir })),
    })
    // 项目行由 feature/project-picker 渲染（.pk-row + data-pk）；同一组件也用于底栏 #proj-pop，
    // 但归档只对 work 侧栏项目下拉开放，故选择器限定容器。
    registerRowMenu({
      sel: '#wk-proj-pop .pk-row',
      key: (el) => el.dataset.pk || null,
      ...projectRowMenuSpec(),
    })
  }

  function newWorkChat() {
    // 新会话落在当前 work 项目下（落项目由 engine/state.js newSessionProject 按工作项目解析，此处不写
    // state.newProject——目标项目槽只有一个真源，work 模式读工作项目、chat 模式读该槽）。
    // 不切回 chat 模式：#/ 空态由 renderHome() 渲染进会话卡（非视图卡），work 主区布局照样成立；
    // 模式互斥只对 mgr/preview 两张视图卡生效（route.js 内那一处 setSbMode('chat')）。
    state.wkMainTab = 'chat' // 新建聊天 = 要看聊天 → 聊天 tab 顶上来、助手靠回栏
    state.wkAssist = true
    state.wkAssistMode = 'side'
    navigate('#/') // 空对话只是激活哨兵，不入顶栏开放集（不渲染「新对话」胶囊）
    applyPanes()
    saveWork()
    if (isMobile()) setPanel(false)
  }


  // 新建 / 上传的落点目录（唯一判定）：文件 tab 且有打开文件 → 其父目录（用户当前上下文）；
  // 否则项目根（''）。树浏览无独立「当前目录」态，不引入。
  function wkNewContextDir() {
    if (state.wkTab !== 'files' || !state.workFile) return ''
    const i = state.workFile.lastIndexOf('/')
    return i < 0 ? '' : state.workFile.slice(0, i)
  }

  // 创建文件（isDir=false）/ 文件夹（true）：复用 openRenameDialog 一件两用弹窗（与重命名同模式：
  // onSubmit 抛错 = 错误留在弹窗内、不关窗，可改名重试）。成功后展开落点目录、刷新树；新建文件
  // 直接 openWorkFile（进编辑器 + 顶栏 pill + cardBus 广播，与侧栏点击同一唯一口）。
  // 新建文件不再提供格式下拉：扩展名直接由用户在名称里写（如 `note.md`），无后缀即纯文本文件。
  function wkNewCreate(isDir) {
    if (!state.workProj) return toast('先在上方选择一个项目')
    const dir = wkNewContextDir()
    openRenameDialog({
      heading: isDir ? '新建文件夹' : '新建文件',
      placeholder: '输入名称（可带扩展名，如 note.md）',
      okText: '创建',
      value: '',
      onSubmit: async (name) => {
        const res = await fetch(apiUrl('/gateway/file/create'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: state.workProj, path: dir, name, dir: isDir }),
        })
        const data = await res.json()
        if (!res.ok || !data.ok) throw new Error(data.error || '创建失败')
        if (dir) wkOpen.add(dir)
        await loadProjectTree(state.workProj)
        if (isDir) {
          renderWorkBody()
          toast('已创建「' + data.name + '」')
        } else {
          await openWorkFile(data.path) // 打开 = renderEditor + applyPanes（顶栏 pill）+ 广播，树已刷新
          toast('已创建「' + data.path + '」')
        }
      },
    })
  }

  // 上传文件（withDir=false，可多选）/ 文件夹（withDir=true，webkitdirectory）。「上传文件夹」
  // 按浏览器带出的 webkitRelativePath 保留所选文件夹自身的目录结构（顶层文件夹名随结构落盘，
  // 与桌面 IDE 拖文件夹一致）；逐文件 POST /gateway/file/upload（原始字节直传），全部完成后刷新
  // 树并展开受影响目录。单文件上限 / 同名序号避让都在后端，失败逐条计入结果 toast。
  function wkNewUpload(withDir) {
    if (!state.workProj) return toast('先在上方选择一个项目')
    const inp = document.createElement('input')
    inp.type = 'file'
    inp.multiple = true
    if (withDir) {
      inp.setAttribute('webkitdirectory', '')
      inp.setAttribute('directory', '')
    }
    inp.addEventListener('change', async () => {
      const files = [...(inp.files || [])]
      inp.remove()
      if (!files.length) return
      const base = wkNewContextDir()
      const dirs = new Set() // 受影响目录（成功者）→ 完成后展开
      let okN = 0
      let bad = ''
      for (const f of files) {
        const rel = withDir ? f.webkitRelativePath || f.name : f.name
        const i = rel.lastIndexOf('/')
        const seg = i > 0 ? rel.slice(0, i) : ''
        const target = base && seg ? `${base}/${seg}` : seg || base
        try {
          const res = await fetch(
            apiUrl('/gateway/file/upload?label=' + encodeURIComponent(state.workProj) +
              '&path=' + encodeURIComponent(target) + '&name=' + encodeURIComponent(f.name)),
            { method: 'POST', body: f },
          )
          const data = await res.json().catch(() => ({}))
          if (!res.ok || !data.ok) throw new Error(data.error || 'HTTP ' + res.status)
          okN++
          const k = data.path ? (data.path.lastIndexOf('/') > 0 ? data.path.slice(0, data.path.lastIndexOf('/')) : '') : ''
          if (k) dirs.add(k)
        } catch (e) {
          bad = f.name + '：' + (e.message || e)
        }
      }
      for (const k of dirs) wkOpen.add(k)
      await loadProjectTree(state.workProj)
      if (bad && !okN) toast('上传失败：' + bad)
      else if (bad) toast(`已上传 ${okN} 个，失败：${bad}`)
      else toast(`已上传 ${okN} 个文件`)
    })
    inp.click()
  }

  // #wk-new-pop 四项的唯一分派口（work-mount.js 点击委托调用）。
  function wkNewPick(a) {
    if (a === 'file') wkNewCreate(false)
    else if (a === 'dir') wkNewCreate(true)
    else if (a === 'upload-file') wkNewUpload(false)
    else if (a === 'upload-dir') wkNewUpload(true)
  }

  // 下载超过此大小先弹确认栏（防止误点超大文件把本机/远端流量一次拉满）。
  const WK_DL_CONFIRM_BYTES = 50 * 1024 * 1024

  function wkDlFmtSize(n) {
    if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB'
    if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB'
    if (n >= 1024) return Math.round(n / 1024) + ' KB'
    return n + ' B'
  }

  // 下载确认弹窗（#dl-modal，DOM 在 index.html，样式复用 #rename-modal 的 mask/dialog 骨架）：
  // 返回 Promise<boolean>——确认 true，取消/关闭/点遮罩/Esc 均 false。监听器在收尾时点名移除。
  function wkDlConfirm(name, size) {
    const modal = $('dl-modal')
    const ok = $('dl-ok')
    const cancel = $('dl-cancel')
    const closeBtn = modal.querySelector('.close')
    $('dl-modal-text').textContent = '「' + name + '」约 ' + wkDlFmtSize(size) + '，确定下载？'
    return new Promise((resolve) => {
      let done = false
      function finish(v) {
        if (done) return
        done = true
        modal.hidden = true
        ok.removeEventListener('click', onOk)
        cancel.removeEventListener('click', onCancel)
        closeBtn.removeEventListener('click', onCancel)
        modal.removeEventListener('mousedown', onMask)
        document.removeEventListener('keydown', onKey)
        resolve(v)
      }
      function onOk() { finish(true) }
      function onCancel() { finish(false) }
      function onMask(e) { if (!e.target.closest('.dialog')) finish(false) }
      function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); finish(false) } }
      ok.addEventListener('click', onOk)
      cancel.addEventListener('click', onCancel)
      closeBtn.addEventListener('click', onCancel)
      modal.addEventListener('mousedown', onMask)
      document.addEventListener('keydown', onKey)
      modal.hidden = false
      ok.focus()
    })
  }

  // 下载一个文件（行操作浮窗「下载」项，2026-10-13 待办 1）：走 GET /gateway/file?dl=1
  // （下载语义：不套 4MB 预览上限、Content-Disposition: attachment、服务端流式发送），
  // 导航到带 token 的 URL 由浏览器原生下载管理器接收——不经 blob，任意大小都不占前端内存；
  // attachment 头也让 PDF 等内联类型只下载不预览（旧 blob 方案的「点下载变预览」由此消失）。
  // 先 HEAD 取 Content-Length，超过 WK_DL_CONFIRM_BYTES 弹确认栏。目录不出此项。
  async function downloadWorkEntry(p) {
    if (!p || !state.workProj) return
    const u = fileUrl(p) + '&dl=1'
    try {
      const head = await fetch(u, { method: 'HEAD' })
      if (!head.ok) {
        toast('下载失败（HTTP ' + head.status + '）')
        return
      }
      const size = Number(head.headers.get('Content-Length') || 0)
      if (size > WK_DL_CONFIRM_BYTES && !(await wkDlConfirm(baseOf(p), size))) return
      const a = document.createElement('a')
      a.href = u
      a.download = baseOf(p)
      a.rel = 'noopener'
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      a.remove()
      toast('开始下载「' + baseOf(p) + '」')
    } catch (e) {
      toast('下载失败：' + (e.message || e))
    }
  }
  // ---------- 侧栏开关（2026-10-14 待办 5，取代 2026-10-10 的视图浮层）----------
  // 触发器两处、互斥在场：侧栏展开 = 头部 #wk-view（收起钮）；侧栏折叠 = 标签栏左端的汉堡 #menu-btn
  // （#sidebar.open 的兄弟选择器把汉堡藏起，故任一时刻恰一个可见）。两钮都只直管侧栏常开/常收
  // （与 chat 模式同一语义），不再经 #wk-view-pop 浮层——浮层仅剩「侧边栏」一行，无存在必要。

  // ---------- 事件 ----------
  function mountWork() {
    // 卡片→宿主：预览卡（如 Pj18 的 PDF/LaTeX 卡）点「跳源码」→ `<ns>-event{ev:'src-open'}` → 总线门禁
    // （label 必须是当前工作项目）过后，由本口打开文件并滚到行。载入是异步的（读文件→灌文档），故「开 + 定位」
    // 合成**一个**口交给宿主自己排序——总线不猜「文档何时才算就位」。
    cardBus.setSourceOpener({
      open: async (p, line) => {
        await openWorkFile(p)
        if (line) wkEdScrollToLine(line)
      },
    })
    // work 编辑区对宿主/其它卡的公开动词（2026-10-21）：scroll{path,line} = 打开文件并滚到行。
    // 门禁与 src-open 同口径（只在 work 模式、只认当前工作项目）——「文件内引用跳转仅在 work 模式下」。
    // 路径口径 = 项目根相对 POSIX（与 src-open 一致）；令牌跨项目时带 `<项目 label>/` 前缀，剥掉再用。
    cardBus.registerInlineCard({
      instanceId: 'floria-work',
      ns: 'floria-work',
      cmds: ['scroll', 'locate', 'state'],
      handlers: {
        scroll: async (a) => {
          if (state.sbMode !== 'work' || !state.workProj) throw new Error('仅在 work 模式下可跳转到文件')
          const raw = String((a && a.path) || '').replace(/\\/g, '/')
          if (!raw) throw new Error('缺少文件路径')
          const pre = state.workProj + '/'
          const path = raw.startsWith(pre) ? raw.slice(pre.length) : raw
          const line = Number(a && a.line) || 0
          await openWorkFile(path)
          if (line) wkEdScrollToLine(line)
          return { path, line }
        },
        locate: () => ({ file: state.workFile || '', project: state.workProj || '' }),
        state: () => ({ mode: state.sbMode, project: state.workProj || '', file: state.workFile || '' }),
      },
    })
    registerWorkRows() // 文件树行的右键 / 长按浮窗（与会话行共用 recent.js 的手势委托）
    document.querySelectorAll('#chat-area > .work-gutter').forEach(bindGutter) // 主区一条分界条（下沉区 ↔ 预览）
    // 助手三态：头部工具条的四个图标 + 收敛输入栏的 pill；形态切换统一走 setAssistMode / setPane。
    const bindIco = (id, fn) => {
      const b = $(id)
      if (b) b.addEventListener('click', fn)
    }
    bindIco('wk-assist-pill', () => setAssistMode('float'))
    bindAssistGrip()
    // 主区尺寸变化 → 重锚悬浮卡：ResizeObserver 一把覆盖分界条拖拽、侧栏开合、窗口缩放、栏开关
    // （比 window.resize + 视口算更准：锚栏宽变了就重算，没变就不动）。
    const ro = new ResizeObserver(() => wkReflowAssist())
    ro.observe(chatArea)
    for (const id of ['work-editor', 'work-preview']) {
      const el = $(id)
      if (el) ro.observe(el)
    }
    // 模式 tab 白块：applySbMode 首次定位时字体可能还没到位（字宽变 ⇒ 白块错位），fonts.ready 后重量一次；
    // 窗口宽变同理（面板拖宽不改钮宽，但换字号/系统缩放下会）。
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(positionMsThumb)
    window.addEventListener('resize', positionMsThumb)
    $('wk-new').innerHTML = I.dshPlus
    // 视图开关图标与 chat 的 #panel-collapse 同款（I.collapse，2026-10-10 用户定案：两模式第三槽同图标）
    $('wk-view').innerHTML = I.collapse
    // 顶栏「工具栏」胶囊的图标/文字由 applyPvTab 按「右栏在不在场」写（不在场 = 插件图标 + 「工具栏」，
    // 在场 = ✕ + 「关闭」），此处不预置——applySbMode → applyPanes → applyPvTab 在 mountWork 之后立刻落一次。
    // 右栏工具 tab 的「评论」由评论卡自注册（views/cards/comment/comment-card.js）——宿主不再知道
    // 该工具的存在，只注入它需要的能力回调（下一行起）。
    // 评论卡 ↔ work 解耦：注册回调（点评论定位开文件 / 选区添加评论时切到评论工具页 /
    // 评论增删改后重绘原文标记）
    cmtSetHooks({
      openFile: (p, id) => {
        wkCmtScrollId = id || ''
        openWorkFile(p) // 打开 + 渲染后由 cmtApplyMarks 消费 wkCmtScrollId 滚到被批注行
      },
      ensurePane: () => setPvTab('comments'), // 切评论工具页（含开栏 + 拉内容）
      refreshMarks: cmtApplyMarks,
    })
    // 顶栏三种 pill 的点击一律**直调侧栏那条同一个函数**，不在此自写 state（顶栏不另立链路）。
    // 「工具栏」胶囊 = 右栏整列开/关：调 setPane('workspace', on)（其内落 setPvPane：在场维 + 关栏时
    // 顺带回预览态）。文件 pill（可多枚）= 见下面 data-wkftab 分支（调 openWorkFile / closeWkFile）。
    $('wk-tb-tool').addEventListener('click', () => setPane('workspace', !state.wkPreview))
    // 右栏工具 tab 条：唯一切换口 = setPvTab（渲染 + 内容补挂 + 持久化都在其内）。tab 条由
    // work-tools.js 的 renderWkToolTabs 重渲 → 事件必须委托在容器上（逐钮绑定会被下次重渲抹掉）。
    // 首枚「预览」页签 data-wkpv="" → setPvTab('') → setPvPane(true, '')，经其中 `page === ''` 特判回预览态；
    // 切勿自以为要过 wkToolNormId——它会回落首枚工具（评论），表达不了「回预览」。
    $('wk-pv-tabs').addEventListener('click', (e) => {
      const c = e.target.closest('[data-wkcard]')
      if (c) { setPvCard(c.dataset.wkcard); return } // 卡片 tab：切 iframe 到该卡目录页
      const b = e.target.closest('[data-wkpv]')
      if (b) setPvTab(b.dataset.wkpv)
    })
    // 预览帧 → 宿主：申报本页的工具 tab（Pj18 等预览页把「编译日志」之类挂进工具栏面板）。沿用既有
    // iframe↔宿主通道（同 rail-ext / ext-card），凭 e.source 必须就是 work 右栏当前那枚 .preview-frame
    // 才采纳。字段：{ type:'floria-wk-tool-register', tools:[{ id, title }] }，整份替换（页面最了解自己有什么）。
    // 帧工具的 pane 由预览页自管（宿主只渲 tab + 回传选中 id，见 syncPvContent/notifyFrame）。
    addEventListener('message', (e) => {
      const d = e.data
      if (!d || typeof d !== 'object') return
      // 预览卡 → 宿主顶栏：请求切到另一张卡（2026-10-18 多卡片架构）。门禁同帧工具：
      // e.source 必须就是右栏当前那枚 .preview-frame；目标卡必须在**当前项目**的卡表里，
      // 不在表内整条丢弃（不猜、不跨项目跳）。payload 原样交接给目标卡（load 后 floria-wk-card-init）。
      if (d.type === 'floria-wk-card-switch') {
        const f = wkFrame()
        if (!f || f.contentWindow !== e.source) return
        const want = String(d.card || '')
        if (!enabledPreviewCardsFor(f.dataset.label || '').some((c) => c.id === want)) return
        setPvCard(want, d.payload)
        return
      }
      if (d.type !== 'floria-wk-tool-register') return
      // 卡池化（2026-10-26）：来源按窗口反查池内任一预览帧（含隐藏帧），不取「第一个」。
      const f = wkFrameBySource(e.source)
      if (!f) return
      const tools = (Array.isArray(d.tools) ? d.tools : [])
        .filter((t) => t && typeof t.id === 'string' && t.id)
        .map((t) => ({ id: t.id, title: typeof t.title === 'string' ? t.title : t.id, pane: '', mount: null }))
      // 每帧缓存自己申报的工具表：池内切回（无 load）时由 work-preview 直接恢复，不必等页面再申报。
      f.__wkTools = tools
      if (f !== wkFrame()) return // 隐藏帧只记缓存，不上 tab 条（tab 条恒属当前显示的那张卡）
      // 申报集变了：当前 active 若已不存在（被撤的帧工具）→ 回落预览态；否则照旧。
      if (state.wkPvTab && !wkToolDef(state.wkPvTab)) state.wkPvTab = ''
      wkFrameSentId = null // 帧重挂/重申报 → 强制再回传一次当前选中
      applyPanes()
      notifyFrame(state.wkPvTab && !(wkToolDef(state.wkPvTab) || {}).pane ? state.wkPvTab : '')
    })
    $('wk-tb-tabs').addEventListener('click', (e) => {
      const cap = e.target.closest('[data-wkchat]')
      if (cap) {
        if (e.target.closest('.wk-tb-x')) { wkCloseTab(cap.dataset.wkchat); return } // × = 关这枚 tab
        // 点胶囊 = 明确要看这个会话：助手在场且靠回栏（浮起/收敛先靠回），再切到该会话路由
        state.wkMainTab = 'chat'
        state.wkAssist = true
        state.wkAssistMode = 'side'
        const hash = wkKeyHash(cap.dataset.wkchat)
        if (state.currentHash !== hash) navigate(hash ? '#/' + encodeURIComponent(hash) : '#/')
        applyPanes() // 形态 + 顶栏 active 一并落地（applyWorkCols 内 applyAssistMode 收口）
        saveWork()
        return
      }
      const b = e.target.closest('[data-wkftab]')
      if (!b) return
      const fp = b.dataset.wkftab
      if (e.target.closest('.wk-tb-x')) { closeWkFile(fp); return } // × = 关掉这枚文件 tab
      // 点文件 pill = 明确要看这个文件：调**侧栏文件行那条同一个函数** openWorkFile（载入 + 切下沉区到
      // 编辑卡 renderEditor + cardBus 广播 file-open 让预览卡跟着切）。原先此处自写 wkMainTab+applyPanes，
      // 是顶栏独有的一条残链——预览卡收不到广播，故「侧栏点文件」与「顶栏点 pill」表现不一致。
      openWorkFile(fp)
    })
    // 顶栏胶囊的右键 / 长按浮窗（2026-10-25）：与侧栏行**共用同一份菜单 spec**，不另写菜单项——
    // 会话胶囊复用 recent.js 的 sessionRowMenuSpec（置顶 / 重命名 / 关闭会话，与侧栏会话行完全一致），
    // 文件 pill 复用 work-rows.js 的 fileRowMenuSpec（在资源管理器中打开 / 重命名 / 下载 / 删除，
    // 与文件树文件行完全一致）。顶栏胶囊属 work 语境，故 withPin 恒真；
    // 重命名成功后 renderTopbar 让胶囊标题即时跟上（侧栏行由 renderRecent 自理）。
    registerRowMenu({
      sel: '[data-wkchat]',
      key: (el) => el.dataset.wkchat || null,
      ...sessionRowMenuSpec((el) => wkKeyHash(el.dataset.wkchat), () => true, renderTopbar),
    })
    registerRowMenu({
      sel: '[data-wkftab]',
      key: (el) => el.dataset.wkftab || null,
      ...fileRowMenuSpec((el) => ({ path: el.dataset.wkftab, dir: false })),
    })
    // 收敛输入栏末端的箭头 = 正常底栏发送钮的同一枚图标（单源 core/icons.js，勿在 HTML 内联自绘）
    const wap = document.querySelector('.wap-arrow')
    if (wap) wap.innerHTML = I.dshSend
    const ico = document.querySelector('#wk-proj-seat .wk-proj-ico')
    if (ico) ico.innerHTML = I.folder
    const fic = document.querySelector('.wk-foot-ico')
    if (fic) fic.innerHTML = I.logo

    // 项目选择器的开合与行选择由共享组件 feature/project-picker/project-picker.js 绑定
    // （实例 = work-files.js 的 wkPicker；与底栏 #proj-pop 同一实现，2026-11-06 同构）。
    // 侧栏收起钮：与 chat 的 #panel-collapse 同语义（只管把侧栏收起；再开走折叠态的汉堡）
    $('wk-view').addEventListener('click', (e) => {
      e.stopPropagation()
      setPane('sidebar', false)
    })
    // 加号按 tab 分派：聊天 tab = 直接新建对话；文件 tab = 展开新建菜单（创建/上传，功能待接入）
    $('wk-new').addEventListener('click', (e) => {
      e.stopPropagation() // 同步：先掐断 document 的收起委托，否则菜单刚开就被关掉
      if (state.wkTab !== 'files') {
        newWorkChat()
        return
      }
      const pop = $('wk-new-pop')
      const willShow = pop.hidden
      hideWkPops()
      pop.hidden = !willShow
    })
    $('wk-new-pop').addEventListener('click', (e) => {
      e.stopPropagation()
      const nb = e.target.closest('[data-wknew]')
      if (!nb) return
      $('wk-new-pop').hidden = true
      wkNewPick(nb.dataset.wknew) // 四项接入（2026-10-13）：创建文件/文件夹 + 上传文件/文件夹，实现在 work-tabmenu.js
    })
    document.querySelectorAll('.wk-tab').forEach((b) =>
      b.addEventListener('click', () => {
        // 插件入口（与 chat 侧栏「插件」tab 同位置）：内容仍渲在下沉区第三态
        if (b.hasAttribute('data-wkplugins')) {
          state.wkMainTab = 'plugins'
          state.wkAssist = true
          state.wkAssistMode = 'side'
          renderWorkBody() // 高亮同步（updateWkTools 唯一口）
          applyPanes()
          saveWork()
          return
        }
        state.wkTab = b.dataset.wktab
        // 点文件/聊天 = 离开插件页，下沉区回对应页态（侧栏体切换照旧）
        if (state.wkMainTab === 'plugins') state.wkMainTab = state.wkTab === 'chat' ? 'chat' : 'file'
        renderWorkBody() // 高亮同步在 updateWkTools（唯一口，覆盖点击外的恢复路径）
        applyPanes()
      }),
    )
    // 文件树整块由 innerHTML 重渲 → 事件必须委托在容器上（逐行绑定会被下次重渲抹掉）
    $('wk-body').addEventListener('click', (e) => {
      const d = e.target.closest('[data-wkdir]')
      if (d) {
        const p = d.dataset.wkdir
        if (wkOpen.has(p)) wkOpen.delete(p)
        else wkOpen.add(p)
        renderWorkBody()
        return
      }
      const f = e.target.closest('[data-wkfile]')
      if (f) {
        openWorkFile(f.dataset.wkfile)
        return
      }
      // 会话行（.sess-item）不在本委托里：行行为统一协议见 recent.js（activateSession / bindSessionRows），
      // 接线点在 work-files.js renderWorkBody 的重建分支。此处只留文件树目录/文件 + 拖拽。
    })
    // 文件树拖拽移动（2026-10-14 待办 10，仿 Obsidian）：行 draggable（wkTreeHtml），投放目标 =
    // 目录行（含收起态）与树空白（= 项目根，仅文件 tab）。wkDragPath 记拖动起点，dragover 按
    // 「非自身 / 非其子目录 / 父目录不同」判可落并亮行；落点落定走 wkTreeMove（work-files.js）。
    let wkDragPath = ''
    let wkDndEl = null
    const body = $('wk-body')
    const dropDir = (e) => {
      const row = e.target.closest ? e.target.closest('[data-wkdir]') : null
      return row ? row.dataset.wkdir : state.wkTab === 'files' ? '' : null
    }
    const canDrop = (from, dir) =>
      from !== dir && !dir.startsWith(from + '/') && from.split('/').slice(0, -1).join('/') !== dir
    const dndMark = (el) => {
      if (wkDndEl === el) return
      if (wkDndEl) wkDndEl.classList.remove('wk-dnd')
      wkDndEl = el
      if (el) el.classList.add('wk-dnd')
    }
    body.addEventListener('dragstart', (e) => {
      const row = e.target.closest ? e.target.closest('[data-wkfile],[data-wkdir]') : null
      if (!row) return
      wkDragPath = row.dataset.wkfile || row.dataset.wkdir
      e.dataTransfer.setData('text/plain', wkDragPath)
      e.dataTransfer.effectAllowed = 'move'
    })
    body.addEventListener('dragover', (e) => {
      if (!wkDragPath || state.wkTab !== 'files') return
      const dir = dropDir(e)
      if (dir == null || !canDrop(wkDragPath, dir)) { dndMark(null); return }
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      dndMark(e.target.closest('[data-wkdir]') || body)
    })
    body.addEventListener('dragleave', (e) => {
      if (!body.contains(e.relatedTarget)) dndMark(null)
    })
    body.addEventListener('drop', (e) => {
      const from = wkDragPath
      wkDragPath = ''
      dndMark(null)
      if (!from || state.wkTab !== 'files') return
      const dir = dropDir(e)
      if (dir == null || !canDrop(from, dir)) return
      e.preventDefault()
      wkTreeMove(from, dir)
    })
    body.addEventListener('dragend', () => { wkDragPath = ''; dndMark(null) })
    // 编辑卡左上角文件名只作展示：重命名入口统一在顶栏文件 pill / 侧栏文件行的右键菜单里
    // （2026-10-25 定案，删掉此处点击直调 openFileRename 的旧入口）。
    // 编辑区：Ctrl+S 立即保存（绑在 #work-editor 上；编辑器自身处理其余按键，未消费的键冒泡到此处）
    $('work-editor').addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      if (e.key.toLowerCase() === 's') {
        e.preventDefault()
        wkEdSave({})
      }
    })
    // 外部改动提示条：保留本地（强制覆盖） / 载入磁盘版本（404 时按文件消失语义收口）
    const remoteSave = $('wk-ed-remote-save')
    if (remoteSave) remoteSave.addEventListener('click', () => { wkLiveKeepLocal() })
    const remoteLoad = $('wk-ed-remote-load')
    if (remoteLoad) remoteLoad.addEventListener('click', () => { wkLiveTakeRemote() })
    $('wk-foot').addEventListener('click', () => toast(state.workspace ? `工作区：${state.workspace}` : '工作区路径未知'))
    // 点空白收起两个浮层（浮层与触发按钮之外的点击都算）
    document.addEventListener('click', (e) => {
      // 行浮窗（长按 / 右键菜单）与项目下拉算一组：点菜单项只是对项目做归档/删除，不应连带收起下拉；
      // 收起只认「点项目行选中」与「点这两处浮层之外的空白」。项目真被归档/删除后由 wkAfterProjectGone 统一收。
      const inRowMenu = !!e.target.closest('.row-menu-pop')
      if (!inRowMenu && !e.target.closest('#wk-proj-pop') && !e.target.closest('#wk-proj-seat')) $('wk-proj-pop').hidden = true
      if (!e.target.closest('#wk-new-pop') && !e.target.closest('#wk-new')) $('wk-new-pop').hidden = true
    })
    // 后台标签页不做对账（定时器仍在跑，tick 内自会跳过）；切回前台立刻补一次，不等下一个间隔
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return
      workAutoTick()
      wkLiveTick(false) // 外部改动同步同一时刻补一次，不等下一个 500ms
    })
  }

  // 启动一次：恢复持久化状态 → 绑定事件 → 落地（顺序不可换：绑定要先于 applySbMode 的渲染，
  // 否则 work 面板首个渲染出来的行（文件树/新聊天）没有容器级委托）
  function initWork() {
    loadWork(WORK_SLOT_DEF) // 读盘：恢复模式/当前项目/预览列宽 + 全部项目槽 → 当前槽落到 live
    // 工具栏开合只在本网关进程运行期内保持：网关换了（boot 不同）⇒ 全部项目槽的工具栏复位折叠。
    // 须在 mountWork/applySbMode 之前（它要基于复位后的 live 态落地）。
    resetWorkPreviewOnBoot(gatewayBootAt())
    reconcileWorkSurface() // 语境归一：守护 workSlotKey === workProj（启动/路由恢复共用，幂等）
    // 外部卡申报按缓存即时回填（同步、无网络）：刷新后在门解锁前 tab 就在位，/manage/ext:… 直进也有卡
    // 可解析；权威清单由 ensureWork → syncWorkExtCards 拉新覆盖。必须在 loadWork 之后（要知道工作项目）。
    hydrateExtCards(state.workProj)
    mountWork()
    applySbMode()
  }

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

  // ---------- 上下文占用指示（2026-08-23 dsh ContextMeter 移植）----------
  // 数据来自 /gateway/session 的 context 字段（网关 readSession 提取最后一条 assistant usage，
  // 除以 getContextWindowForModel 窗口）。无数据（无 usage / 无模型窗口）→ hidden。
  // 环形 = 14px/2px 圆环，点击展开 breakdown 面板（headline + ~used/window + 占比条）。
  const ctx = { data: null, open: false }
  const CTX_RADIUS = 5.5
  const CTX_CIRC = 2 * Math.PI * CTX_RADIUS

  // 紧凑 token 计数（dsh formatTokens）：517 / 12.2K / 517K / 1.2M
  function formatTokensCompact(n) {
    const scaled = (v) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
    if (n < 1000) return String(n)
    if (n < 1000000) return scaled(n / 1000) + 'K'
    return scaled(n / 1000000) + 'M'
  }

  function renderCtxMeter(context) {
    ctx.data = context || null
    if (!context || !(context.usedTokens >= 0) || !(context.contextWindow > 0)) {
      ctxMeterEl.hidden = true
      ctx.open = false
      ctxPanelEl.hidden = true
      ctxBtnEl.setAttribute('aria-expanded', 'false')
      return
    }
    const percent = context.percent != null
      ? Math.min(100, Math.max(0, Math.round(context.percent)))
      : Math.min(100, Math.round((context.usedTokens / context.contextWindow) * 100))
    const reading = percent + '%'
    const label = '上下文已用 ' + reading
    const dash = (CTX_CIRC * percent / 100).toFixed(3)
    ctxBtnEl.innerHTML = '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">' +
      '<circle class="ctx-track" cx="7" cy="7" r="' + CTX_RADIUS + '"/>' +
      '<circle class="ctx-fill" cx="7" cy="7" r="' + CTX_RADIUS + '" stroke-dasharray="' + dash + ' ' + CTX_CIRC.toFixed(3) + '" transform="rotate(-90 7 7)"/>' +
      '</svg>'
    ctxBtnEl.title = label
    ctxBtnEl.setAttribute('aria-label', label)
    ctxPanelEl.innerHTML = ctxPanelHtml(context, percent, reading)
    ctxMeterEl.hidden = false
    if (ctx.open) ctxPanelEl.hidden = false
  }

  // dsh ContextMeter panel：headline「上下文已用」+ 百分比（primary）+ ~used/window（figures）+
  // 单段占比条（transcript 无 system/tools/messages 分解，对齐 dsh breakdown 缺失时的单段回落）
  function ctxPanelHtml(context, percent, reading) {
    const figures = '~' + formatTokensCompact(context.usedTokens) + ' / ' + formatTokensCompact(context.contextWindow)
    // 0% 不渲染段（对齐 dsh parts.filter(width>0)：空上下文显示空轨道，不被 .ctx-segment 的 min-width 画出填充）
    const seg = percent > 0 ? '<div class="ctx-segment" style="width:' + percent + '%"></div>' : ''
    return '<div class="ctx-header">' +
      '<span class="ctx-headline">上下文已用</span>' +
      '<span class="ctx-percent">' + reading + '</span>' +
      '<span class="ctx-headline"></span>' +
      '<span class="ctx-figures">' + figures + '</span>' +
      '</div>' +
      '<div class="ctx-bar">' + seg + '</div>'
  }

  function setCtxOpen(open) {
    ctx.open = open
    ctxPanelEl.hidden = !open
    ctxBtnEl.setAttribute('aria-expanded', open ? 'true' : 'false')
  }
  function closeCtxMeter() { if (ctx.open) setCtxOpen(false) }

  // 浮窗外部关闭（对齐 dsh 语义：mousedown 时机 + contains 判断——mousedown 在 DOM 变更前命中目标，
  // 天然免疫 innerHTML 重渲染把被点元素摘除后 e.target.closest() 返回 null 误判「点外关闭」的浮窗闪关/复开）
  document.addEventListener('mousedown', (e) => {
    // 上下文面板：点 #ctx-meter 外（环形按钮除外，其 click toggle 接管开合）= 关闭（dsh ContextMeter pointerdown）
    if (ctx.open && !ctxMeterEl.contains(e.target)) closeCtxMeter()
    // 风险确认门：点对话框外（遮罩）= 取消（dsh Modal 的 mask onClick=onClose）；点对话框内部不触发「点外关闭」
    const rm = $('risk-modal')
    if (!rm.hidden) {
      const dlg = rm.querySelector('.dialog')
      if (dlg && !dlg.contains(e.target)) { closeRiskModal(); return }
    }
    // 命令菜单：点卡片外（+ 按钮除外，其 click toggle 接管开合）= 关闭（dsh PopupSelectView pointerdown capture）。
    // 底栏输入框不算外（2026-10-14 待办 20 返修）：过滤文本就在底栏，点击聚焦/打字不得关掉浮窗
    if (cmd.open && !cmdPop.contains(e.target) && !$('cmd-btn').contains(e.target) && !inputEl.contains(e.target)) closeCmdPop()
    // 模型菜单：点 root 外（模型 trigger 除外，其 click toggle 接管开合）= 关闭（dsh ModelSelect mousedown + rootRef.contains）
    if (msel.open && !modelPop.contains(e.target) && !modelSeatEl.contains(e.target)) closeModelPop()
    // 项目选择器：点 root 外（seat 除外，其 click toggle 接管开合）= 关闭
    if (psel.open && !projPop.contains(e.target) && !projSeatEl.contains(e.target)) closeProjPop()
  })
  // 点击空白关闭弹层（@ 浮窗 / 整理会话 / 最近气泡）
  document.addEventListener('click', (e) => {
    // 输入内 chip 的 × 删除归 composer-cm widget 自有监听（CM 事务删除，DOM 直删会腐蚀 doc）；
    // 此处只管 @ 会话的外点关闭——@ 的弹窗就是工具栏 #cmd-pop（2026-10-25 定案唯一弹窗），
    // 点工具栏内部不关，点外部才收（mousedown 链已先关过一次，这里是幂等兜底）。
    // 用 composedPath 判「点是否落在浮窗内」：行内点击会先触发 cmdSelect 重渲（innerHTML 替换），
    // 冒泡到这里时 e.target 已脱离 DOM，closest('#cmd-pop') 恒为 null ⇒ 误判点外、@ 浮窗刚进视图
    // 就被关掉（2026-10-25 根因）。composedPath 在派发时固定，重渲后仍含原祖先链。
    const inCmdPop = e.composedPath ? e.composedPath().includes(cmdPop) : (e.target.closest && !!e.target.closest('#cmd-pop'))
    if (!inCmdPop) closeMentionPop()
    if (!$('organize-pop').contains(e.target) && !e.target.closest('#recent-more')) $('organize-pop').classList.remove('show')
    if (!bubblePop.contains(e.target)) bubblePop.classList.remove('show')
  })
  // 风险确认门：Escape 关闭（dsh Modal 的 Escape onClose 监听；输入栏 keydown 不覆盖遮罩态）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (ctx.open) closeCtxMeter()
      if (!$('risk-modal').hidden) closeRiskModal()
    }
  })

  // composer（只读；网关模式由下方 gatewayInit 的 gwSend 接管）
  sendBtn.innerHTML = I.dshSend // 2026-08-21 dsh 移植：发送 = dsh IconSendOutline16
  $('cmd-btn').innerHTML = I.dshPlus // 2026-08-21 dsh 移植：+ 按钮 = dsh IconPlusOutline16（命令菜单）
  // 2026-08-28 v137：图片上传入口在 + 浮窗「图片」tab（独立按钮移除）；选完图关浮窗，胶囊显示在输入栏上方
  $('img-file').addEventListener('change', () => {
    addImageFiles(Array.from($('img-file').files || []))
    $('img-file').value = '' // 允许重复选同一文件
    closeCmdPop()
  })
  // 文件上传（2026-09-12）：+ 浮窗「上传文件」行选完 → addUploadFiles 顺序上传落盘，路径回填输入栏
  $('file-upload').addEventListener('change', () => {
    addUploadFiles(Array.from($('file-upload').files || []))
    $('file-upload').value = '' // 允许重复选同一文件
    closeCmdPop()
  })
  // 附件胶囊行（#img-pills）2026-10-16 待办 6 还原：渲染 + × 移除监听收在 inputbar/images.js
  // （renderImgPills 自绑），本模块不挂胶囊事件。正文引用仍是唯一内容真相（editor-attachments）。
  // 底栏 input/paste/keydown 监听已随 CM6 接管（2026-10-14 #17 B 口径）迁入 composer-cm.js 的
  // updateListener / domEventHandlers——#input contenteditable 退役，本模块不再挂输入区事件。
  // 2026-09-06 拖拽上传：文件拖进页面任意处 → 全屏浮层提示，松手入列。只拦 dataTransfer 含 Files 的
  // 拖拽（页面内拖选文字/链接原样不受影响）；dragenter/leave 计数对抗子元素穿越，浮层 pointer-events:none
  // 事件全落 document。2026-10-22：按类型分流——图片走 addImageFiles（缩略图胶囊 + 视觉上行），
  // 其余文件走 addUploadFiles（上传落盘 + 文件胶囊 + 正文链接），此前 filter 只留 image/* 导致非图片拖拽无反应。
  const dropOverlay = $('drop-overlay')
  let dragDepth = 0
  document.addEventListener('dragenter', (e) => {
    if (gateAwait || !e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    dragDepth++
    dropOverlay.hidden = false
  }, true)
  document.addEventListener('dragover', (e) => {
    if (!dragDepth) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, true)
  document.addEventListener('dragleave', () => {
    if (!dragDepth) return
    if (--dragDepth === 0) dropOverlay.hidden = true
  }, true)
  document.addEventListener('drop', (e) => {
    if (!dragDepth) return
    e.preventDefault()
    dragDepth = 0
    dropOverlay.hidden = true
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
    const imgs = files.filter((f) => /^image\//.test(f.type))
    const others = files.filter((f) => !/^image\//.test(f.type))
    if (imgs.length) addImageFiles(imgs)
    if (others.length) addUploadFiles(others)
  }, true)
  // 2026-09-06 纯文本复制：鼠标选中复制走浏览器默认会连 text/html 一起写剪贴板
  // （粘回输入栏/外部富文本编辑器保留背景色等样式），全局拦截 copy 只写 text/plain。
  // 2026-10-09 扩展：消息区选区先还原**原始 md 源码**；2026-10-15 任务D 收口为
  // @floria/cm6 摊出的 copyRenderedSelection（公式块还原 `$…$`/`$$…$$` 源码，整块覆盖用 data-md
  // 原文，块内碎片/非消息区返回 null）→ 回落纯文本。此拦截是全局唯一入口（msg-actions 不再另起 copy 监听）。
  document.addEventListener('copy', (e) => {
    // 上游已处理（如 CodeMirror6 在 contentDOM 自写全文剪贴板并 preventDefault，只 preventDefault 不阻断冒泡）：
    // 此时再用 window.getSelection().toString() 覆盖，只会拿到 CM6 视口内已渲染的行 → 长选区复制被截断。
    if (e.defaultPrevented) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) return
    const text = copyRenderedSelection({ selection: sel }) || sel.toString()
    // 2026-10-16 图片随复制走：选区覆盖到的消息图片写成 text/html（<img src=绝对 URL>）。此前本拦截
    // 只写 text/plain 便 preventDefault ⇒ 复制图片时图片被整个丢掉，「复制 → 粘到底栏」得不到任何图。
    // 两路并存：有文本仍有纯文本（粘成文字），有图片多带 html 分量（粘到底栏 → 拉字节 → 图片胶囊）。
    const html = copyRenderedImages(sel)
    if (!text && !html) return
    if (text) e.clipboardData.setData('text/plain', text)
    if (html) e.clipboardData.setData('text/html', html)
    e.preventDefault()
  })
  // 模型 seat 的 chevron 是静态 DOM（dsh 移植，随 open 翻转），初始塞入 dsh IconChevronDownOutline14
  $('model-seat').querySelector('.chevron').innerHTML = I.dshChevDown
  // 命令菜单 / 模型菜单按钮（2026-08-21 dsh 输入栏移植；controller 定义见下）
  $('cmd-btn').addEventListener('click', () => { if (gateAwait || state.mgr) return; toggleCmdPop() })
  $('model-seat').addEventListener('click', () => { if (gateAwait || state.mgr) return; toggleModelPop() })
  ctxBtnEl.addEventListener('click', () => { if (gateAwait || state.mgr || ctxMeterEl.hidden) return; setCtxOpen(!ctx.open) })
  sendBtn.addEventListener('click', () => {
    if (gateAwait) { gateSubmit(); return } // token 门态：点击发送 = 提交 token
    // 2026-09-05 定案：停止键只在回合进行中且输入栏为空时显示，点击发 interrupt（网关按
    // sessionId 精确路由 → CLI Ctrl+C 同路径）；有内容时显示发送键，点击=发送排队续发
    // （gwSend 无回合态守卫，不打断）。输入中的文字保留在输入栏不丢（打断后可继续编辑发送）。
    if (btnMode === 'stop' && state.currentHash && gws && gws.readyState === 1) {
      gws.send(JSON.stringify({ type: 'interrupt', sessionId: state.currentHash }))
      toast('已发送打断')
      return
    }
    if (!gwSend()) toast('只读查看 · 无法发送')
  })
  // 底栏 keydown（token 门/IME/cmd/msel/mention/退格删 chip/Enter 发送）已迁 composer-cm.js
  // cmOnKeydown（CM domEventHandlers，判定次序逐分支原样保留）。

  // 路由
  // 2026-08-28 pushState 配套：popstate 兜底浏览器前进/后退（navigate 同步 route 后同值跳过）；
  // hashchange 保留为旧 hash 链接/手动改 hash 的兜底（pathname 优先级更高，仅在根路径生效）。
  window.addEventListener('popstate', () => {
    if (lastNavHash !== null && location.pathname === lastNavHash) { setLastNavHash(null); return }
    setLastNavHash(null)
    route()
  })
  window.addEventListener('hashchange', () => {
    if (lastNavHash !== null && location.hash === lastNavHash) { setLastNavHash(null); return }
    setLastNavHash(null)
    route()
  })
  // 展开态头部 floria 头像 = 折叠侧栏按钮（2026-09-02 调整：不再回首页新建会话）
  const logoBtn = document.querySelector('.floria-logo')
  if (logoBtn) logoBtn.addEventListener('click', () => setPanel(false))
  // 两层消息流（2026-09-08 定案；2026-09-09 释放链铲除）：
  // ① 屏幕尺寸变化（旋转/缩放）→ 占位高度跟随新 clientHeight（「占位大小根据屏幕大小计算」）
  window.addEventListener('resize', () => { if (stage.active) stageSync() })
  // ② 用户滚动输入（滚轮/触摸拖拽/鼠标拖滚动条/键盘）一律**只让位、永不摘占位**（2026-09-09
  //    用户定案「为什么还会有释放链这种东西」——占位=真实 DOM 实体，与回合绑定，用户输入不在
  //    其生命周期内；任何一处的 remove 都被实测定性为「死掉」）。触摸链：手势（含惯性，
  //    touchend 后 scroll 静默 500ms 判停）期 touchHold 冻结程序跟随防 WebKit 触摸滚动基准
  //    断裂，静默后 yielded 永久让位；tap（拖拽位移 ≤6px）不让位。stageRelease 仅剩视图级
  //    退出调用（切会话/回首页/管理视图/项目预览）。
  $('chat-scroll').addEventListener('wheel', () => {
    if (stage.active && !stage.touchHold) stage.yielded = true
  }, { passive: true })
  const touchYield = () => {
    if (stage.releaseT) clearTimeout(stage.releaseT)
    stage.releaseT = setTimeout(() => {
      stage.releaseT = null
      stage.touchHold = false
      stage.yielded = true
    }, 500)
  }
  let touchY0 = 0
  let touchY = 0
  $('chat-scroll').addEventListener('touchstart', (e) => {
    stage.touchHold = true
    if (stage.releaseT) { clearTimeout(stage.releaseT); stage.releaseT = null }
    touchY0 = touchY = e.touches[0] ? e.touches[0].clientY : 0
  }, { passive: true })
  $('chat-scroll').addEventListener('touchmove', (e) => {
    touchY = e.touches[0] ? e.touches[0].clientY : touchY
  }, { passive: true })
  $('chat-scroll').addEventListener('touchend', () => {
    if (!stage.touchHold) return
    if (Math.abs(touchY - touchY0) > 6) touchYield() // 拖拽过 = 滚动接管 → 惯性静默后让位
    else stage.touchHold = false // tap：不算滚动操作
  }, { passive: true })
  $('chat-scroll').addEventListener('touchcancel', () => {
    if (stage.touchHold) touchYield() // 系统打断（来电/手势争夺）：按拖拽保守处理
  }, { passive: true })
  $('chat-scroll').addEventListener('scroll', () => {
    if (stage.touchHold) {
      if (stage.releaseT) touchYield() // touchend 后惯性滚动：续期静默窗
      return // 手势中的 scroll 不构成滚动输入信号（与触摸无法从事件本身区分，靠持有窗屏蔽）
    }
    // 非程序滚动（progScrollUntil 窗外）= 用户拖滚动条/键盘滚动 → 只让位，永不摘占位
    if (stage.active && Date.now() >= progScrollUntil) stage.yielded = true
  })
  // 旧体系三类内容几何监听（折叠 toggle 重算/收起 click 接管/图片 load 重算）随动态占位退役：
  // 占位恒定 → 内容收起不再令 scrollTop 越出 maxScroll（无 clamp 闪动），图片异步撑高只改变
  // 跟随目标而跟随每次渲染出口现算（renderSettle→stageSync→stageFollow），无需事件驱动重算。

  // ---------- 网关模式（SubPj2 私有化网关）----------
  // 检测 /gateway/health 返回 mode==='gateway' 即启用：composer 可发、WS 双向、工具审批。
  // 只读查看模式（SubPj1 后端）下本块全部不生效。
  let GATEWAY = false
  let GATEWAY_REVIEW = false // 审阅模式（server.mjs REVIEW_GATEWAY）：health 带 review 标志，token 门不建真 WS 直接走视觉流程
  let HOT_RELOAD = false // 开发审阅热重载（server.mjs HOT_RELOAD）：health 带 hotReload 标志，建 SSE 监听 public 变化自动刷新
  // 本网关进程启动时刻（health.boot）：界面判「同一网关刷新」与「换了网关」的唯一凭据
  // （work 工具栏开合只在同进程内保持，见 work-mount.initWork）。
  let gwBoot = 0
  const gatewayBootAt = () => gwBoot
  let gateAwait = false // token 门态：网关 token 验证通过前锁定为全空白 + 中间输入框
  let gateVerified = false // 网关 token/cookie 已验证（WS onopen 或 REVIEW 直置；声明提前供 needToken 用）
  // 2026-08-28 token 出 URL：gToken 仅作首链/门输入的附加凭据；已授权设备刷新后 gToken 为空，
  // 靠 floria_auth cookie（网关首链时种下）通过校验。URL query token 验证成功后由 hideGate 清除。
  let gToken = new URLSearchParams(location.search).get('token') || ''
  let gws = null
  let reconnectTimer = null

  // 依赖反转（分层治理 4D，2026-10-10）：engine/gateway.js 不再静态 import inputbar/*——
  // 审批卡渲染/审批态读写、发送态同步、@ 提及输入回调一律经 app 启动序列注入的端口访问。
  // 端口内 getter（getTakeover/getApprovalPending）每次现读 feature 模块的可变绑定，调用侧严禁缓存
  // （缓存即与 owner 的实时态脱钩）；端口注入先于 initGateway、且早于 WS 首个 onopen/onmessage。
  let gwApproval = {} // inputbar/approval.js：审批卡渲染 + 审批态读写
  let gwSendPort = {} // inputbar/send.js：syncGwSend
  let gwMention = {} // inputbar/mention.js：onInputChange

  // 安全加固（2026-08-15）：数据接口 URL 统一附加网关 token（query），与 WS 升级校验一致。
  // 2026-08-28 门控条件从「有无 gToken」改为「是否已验证」：cookie 授权设备刷新后直接可拉数据，
  // 未验证（无 cookie 且无首链 token）时请求不发，待 connect 失败回门 / hideGate 解锁后补拉。
  const needToken = () => GATEWAY && !gateVerified
  function apiUrl(path) {
    const q = path.includes('?') ? '&' : '?'
    return path + q + 'token=' + encodeURIComponent(gToken)
  }
  // 模型/思考等级切换（POST /gateway/model：持久化写 settings.json + 广播实时生效）。
  // 2026-10-05 自 inputbar/model-select.js 迁入——网关客户端是 needToken/apiUrl/gToken 的唯一持有者，
  // 卡片与输入栏都经此调用（去卡片→inputbar 横向依赖）。needToken 门：未验证返回 false 由调用方提示。
  async function apiSetModel(body) {
    if (needToken()) return false
    try {
      const res = await fetch(apiUrl('/gateway/model'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return res.ok
    } catch { return false }
  }

  // 卡片公开 API（2026-10-11）：帧能力表经 /ws 上行的唯一发送口。注入进 engine/card-bus.js（总线不
  // import 本件，免 engine 内成环，同 setTabRefresh/setExtCardRenderer 手法）；注入即补报一次，此后
  // 帧表一变 / 卡 ready / 本函数所在的 onopen 各触发一次（总线内 50ms 防抖合并）。
  cardBus.setGatewaySender((m) => {
    if (gws && gws.readyState === 1) gws.send(JSON.stringify(m))
  })

  function gatewayCss() {
    const s = document.createElement('style')
    s.textContent = `
      #send-btn.enabled{opacity:1;cursor:pointer}
      /* 2026-08-21 审批卡：DSH ApprovalPanel 完全移植（warn 语义令牌就地映射）——
         amber 顶部条带[8px 圆点 + 13/18 文字] + 正文[15/24 500 headline + mono 命令] + 右对齐胶囊按钮。
         2026-08-22 composer takeover：审批卡占输入栏，.appr-card 提为全局（去掉 .msg.approval 作用域） */
      .appr-card{overflow:hidden;width:100%;border:1px solid var(--warn-line);border-radius:20px;background:var(--bg);box-shadow:0 4px 12px 0 rgba(0,0,0,.02),0 2px 8px 0 rgba(0,0,0,.04)}
      .appr-strip{display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--warn-bg);color:var(--warn-fg);font-size:13px;line-height:18px}
      .appr-strip .appr-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--warn-fg)}
      /* 2026-09-10 用户定案「审批栏拉到合适高度、不出滑条」：旧定值 200px 让十几行的命令体（Edit 的
         old/new_string 等）恒出滚动条=又丑又要二次滚。改为视口预算——正文吃满自然高度，上限=视口高
         减 260px（黄条带 38 + 按钮行 60 + 底距 22 + 聊天区至少可见 ~140），只有真超屏才滚（真边界，
         非兜底特判）。dvh 后置声明：不支持的引擎落回 vh。 */
      .appr-body{display:flex;flex-direction:column;gap:6px;box-sizing:border-box;max-height:calc(100vh - 260px);max-height:calc(100dvh - 260px);overflow-y:auto;padding:12px 16px 0}
      .appr-headline{color:var(--text);font-size:15px;font-weight:500;line-height:24px}
      /* 2026-09-10 正文由「原样 JSON.stringify」改按工具语义渲染（approval.js prettyToolInput）：
         外层只做容器；等宽/折行下沉到字段值 .ak-v、块 .appr-pre、diff 各行——避免整块继承等宽把
         中文字段标签也变等宽。Edit=红/绿两段文本 diff（.appr-diff-*），其余=标签+值列表（.appr-kv）。 */
      .appr-input{color:var(--text-2);font-size:13px;line-height:20px}
      .appr-kvs{display:flex;flex-direction:column;gap:6px}
      .appr-kv{display:flex;gap:8px;font-size:13px;line-height:20px}
      .appr-kv .ak-l{flex:none;min-width:52px;color:var(--text-3)}
      .appr-kv .ak-v{color:var(--text);font-family:var(--mono);word-break:break-all;white-space:pre-wrap;overflow-wrap:anywhere}
      .appr-file{margin-bottom:2px;color:var(--text);font-family:var(--mono);font-size:13px;line-height:20px;word-break:break-all;overflow-wrap:anywhere}
      .appr-meta{margin-bottom:2px;color:var(--text-3);font-size:12px;line-height:18px}
      .appr-pre{margin:0;padding:10px 12px;border-radius:10px;background:var(--field-2);color:var(--ink);font-family:var(--mono);font-size:12.5px;line-height:19px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
      /* ExitPlanMode 计划正文的 Markdown 作用域（approval.js prettyToolInput → mdHtml）：
         审批卡不在 .msg/.done-think 内，故 mdHtml 产出的块级标签在此重新给样式，语义对齐 styles.css 同名规则。 */
      .appr-md{color:var(--text);font-size:13px;line-height:20px;word-break:break-word}
      .appr-md p{margin:4px 0}
      .appr-md h1,.appr-md h2,.appr-md h3,.appr-md h4{margin:12px 0 4px;font-weight:700;color:var(--text);line-height:1.4}
      .appr-md h1{font-size:16px}.appr-md h2{font-size:15px}.appr-md h3{font-size:14px}.appr-md h4{font-size:13px}
      .appr-md ul,.appr-md ol{margin:4px 0;padding-left:20px}
      .appr-md li{margin:2px 0}
      .appr-md blockquote{border-left:3px solid var(--border);margin:4px 0;padding:2px 10px;color:var(--text-2)}
      .appr-md hr{border:none;border-top:1px solid var(--border);margin:8px 0}
      .appr-md a{color:var(--text);text-decoration:underline;text-underline-offset:2px}
      .appr-md code{background:var(--border-soft);padding:2px 6px;border-radius:4px;font-family:var(--mono);font-size:12px}
      /* .code-block 系列（2026-10-10）已收口到 styles.css 的「.appr-md .code-block」作用域（含头栏/换行/hljs），
         此处不再重复——注入样式晚于 <link> 会盖掉新设计（旧绝对定位 .code-lang 等）。 */
      .appr-md .md-table{margin:6px 0;overflow-x:auto}
      .appr-md .md-table table{border-collapse:collapse;font-size:12.5px;width:100%}
      .appr-md .md-table th,.appr-md .md-table td{border:1px solid var(--border);padding:5px 9px;text-align:left;white-space:normal;word-break:break-word}
      .appr-md .md-table th{background:var(--rail-bg);font-weight:600}
      .appr-diff{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:10px;overflow:hidden}
      .appr-diff-h{padding:5px 10px;background:var(--field-2);color:var(--text-3);font-size:11px;line-height:16px;font-weight:600}
      .appr-diff-b{margin:0;padding:8px 10px;font-family:var(--mono);font-size:12.5px;line-height:19px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
      .appr-diff-b.old{background:var(--danger-soft);color:var(--danger-fg)}
      .appr-diff-b.new{background:var(--ok-soft);color:var(--ok-fg)}
      .appr-btns{display:flex;justify-content:flex-end;gap:8px;padding:14px 16px}
      .appr-btns button{height:32px;padding:0 16px;border-radius:999px;font-size:13px;font-weight:500;line-height:18px;cursor:pointer;border:1px solid var(--border);background:var(--bg);color:var(--text-2)}
      .appr-btns button:disabled{opacity:.5;cursor:default}
      .appr-deny:hover:not(:disabled){background:var(--danger-soft);color:var(--danger-fg);border-color:transparent}
      .appr-allow{border:none!important;background:#4176e6!important;color:#fff!important}
      .appr-allow:hover:not(:disabled){background:#679efe!important}
      /* 2026-08-30 提问卡 DSH QuestionComposer 对齐：eyebrow+右上折叠/×；编号方块选项（label+描述
         同行）；自由输入行；底部 <N/M> 翻题导航+跳过本题+下一题/提交；整卡可折叠为一行。
         qa-card 走中性边框（不继承审批卡黄色警示边），配色守 floria 浅色主题。 */
      .appr-card.qa-card{border-color:var(--border)}
      .qa-top{display:flex;align-items:center;gap:10px;padding:12px 16px 0}
      /* 折叠钮最左 / 标题（眉标+问题）居中 / × 最右：中段 .qa-head 吃满 flex 并居中，
         两端 22px 图标等宽 ⇒ 标题真正居中。 */
      .qa-head{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;gap:8px}
      .qa-eyebrow{flex:none;color:var(--text-3);font-size:12px;line-height:16px;font-weight:500}
      .qa-title-sm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);font-size:13px;line-height:18px}
      .qa-fold{flex:none;width:22px;height:22px;display:flex;align-items:center;justify-content:center;color:var(--text-3);cursor:pointer;border-radius:6px}
      .qa-fold:hover{background:var(--hover);color:var(--text)}
      .qa-fold svg{width:14px;height:14px;transform:rotate(180deg)}
      .qa-collapsed .qa-fold svg{transform:none}
      .qa-x{flex:none;width:22px;height:22px;display:flex;align-items:center;justify-content:center;color:var(--text-3);cursor:pointer;border-radius:6px}
      .qa-x:hover{background:var(--danger-soft);color:var(--danger-fg)}
      .qa-x svg{width:11px;height:11px}
      .qa-main{display:flex;flex-direction:column;gap:10px;padding:6px 16px 14px}
      .qa-title{color:var(--text);font-size:15px;font-weight:600;line-height:22px}
      .qa-opts{display:flex;flex-direction:column;gap:6px;max-height:40vh;overflow-y:auto}
      .qa-opt{display:flex;align-items:flex-start;gap:10px;padding:9px 12px;border:1px solid var(--border);border-radius:12px;background:var(--bg);text-align:left;cursor:pointer;color:var(--text)}
      .qa-opt:hover{border-color:#4176e6;background:var(--accent-hover)}
      .qa-opt.sel{border-color:#4176e6;background:var(--accent-sel)}
      .qa-opt .qa-num{flex:none;min-width:20px;height:20px;padding:0 5px;border-radius:6px;background:var(--hover);color:var(--text-2);font-size:12px;font-weight:500;line-height:20px;text-align:center;box-sizing:border-box}
      .qa-opt.sel .qa-num{background:#4176e6;color:#fff}
      .qa-opt .qa-copy{flex:1;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:14px;line-height:20px}
      .qa-opt .qa-label{color:var(--text)}
      .qa-opt .qa-desc{color:var(--text-2);font-size:12px;line-height:18px}
      .qa-multi-hint{color:var(--text-3);font-size:11px;font-weight:400;margin-left:4px}
      .qa-inputrow{display:flex;align-items:center;gap:8px;height:38px;padding:0 12px;margin-bottom:-4px;border:1px solid var(--border);border-radius:12px;background:var(--bg)}
      /* 2026-09-26 撤聚焦强调：.qa-inputrow:focus-within 曾与 .qa-opt.sel 视觉同款 ⇒ 单选点选项后
         再点输入框就「两处高亮」。聚焦不再单独表态，点输入行即 pickText 上 .sel（选中态唯一）。 */
      .qa-inputrow.sel{border-color:#4176e6;background:var(--accent-sel)}
      .qa-input-ico{flex:none;width:14px;height:14px;color:var(--text-3);display:flex;align-items:center;justify-content:center}
      .qa-input-ico svg{width:14px;height:14px}
      .qa-inputrow .qa-input{flex:1;height:34px;border:none;outline:none;background:transparent;color:var(--text);font-size:14px;font-family:inherit}
      .qa-inputrow .qa-input::placeholder{color:var(--text-3)}
      .qa-foot{display:flex;align-items:center;justify-content:space-between;gap:10px}
      .qa-nav{display:flex;align-items:center;gap:6px}
      .qa-nav-btn{width:24px;height:24px;display:flex;align-items:center;justify-content:center;border:none;background:transparent;color:var(--text-2);cursor:pointer;border-radius:6px;padding:0}
      .qa-nav-btn:hover:not(.off){background:var(--hover);color:var(--text)}
      .qa-nav-btn.off{opacity:.35;cursor:default}
      .qa-nav-btn svg{width:14px;height:14px}
      .qa-nav-btn.prev svg{transform:rotate(180deg)}
      .qa-nav-pos{color:var(--text-2);font-size:12px;line-height:16px;min-width:32px;text-align:center}
      .qa-foot-btns{display:flex;gap:8px}
      .qa-foot-btns button{height:32px;padding:0 16px;border-radius:999px;font-size:13px;font-weight:500;line-height:18px;cursor:pointer;border:1px solid var(--border);background:var(--bg);color:var(--text-2)}
      .qa-foot-btns button:disabled{opacity:.5;cursor:default}
      .qa-skip:hover:not(:disabled){background:var(--hover);color:var(--text)}
      /* 2026-08-30 间距对齐（用户「最下一行到边界 vs 最上一行到边界差别很大」）：空状态行不吃空间
         （.appr-state padding 0 16px 12px + qa-main gap 10px 使脚行到卡底 ≈36px，眉行到卡顶仅 12px）；
         折叠单行卡 qa-top 底垫 0→12px（原底部贴边不对称）。
         2026-09-08 :empty 隐藏全局化——普通审批卡同样漏挂（用户实测「按钮距卡底太远」=空 state
         行仍吃 12px 底垫，与 .appr-btns padding-bottom 14px 叠成 26px），qa-card 特例并入。 */
      .appr-state:empty{display:none}
      .qa-collapsed .qa-top{padding:12px 16px}
      /* 2026-08-26 任务 A2：审批增强——原因说明/被拒路径/「记住此规则」建议多选 */
      .appr-desc{color:var(--text-2);font-size:13px;line-height:20px}
      .appr-path{display:flex;gap:6px;align-items:flex-start;color:var(--text-2);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:18px;word-break:break-all}
      .appr-path .ap-l{flex:none;color:#999}
      .appr-sugs{display:flex;flex-direction:column;gap:6px;padding:2px 0 0}
      .appr-sug{display:flex;align-items:flex-start;gap:9px;padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--bg);text-align:left;cursor:pointer;color:var(--text);font-size:13px;line-height:19px}
      .appr-sug:hover{border-color:#4176e6;background:var(--accent-hover)}
      .appr-sug.sel{border-color:#4176e6;background:var(--accent-sel)}
      .appr-sug .as-box{flex:none;width:15px;height:15px;margin-top:2px;border-radius:4px;border:1.5px solid var(--border);box-sizing:border-box}
      .appr-sug.sel .as-box{border-color:#4176e6;background:#4176e6}
      .appr-sug.sel .as-box::after{content:'';display:block;width:4px;height:7px;margin:1px auto 0;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
      .appr-sug .as-copy{flex:1}
      .appr-sug .as-title{color:var(--text);font-size:13px;line-height:19px}
      .appr-sug .as-sub{color:var(--text-2);font-size:11.5px;line-height:16px}
      /* 2026-08-26 P0 审批确认送达：提交中（busy）/失败重试状态行 */
      .appr-btns button.busy{opacity:.55;cursor:wait}
      .appr-state{display:flex;align-items:center;gap:8px;padding:0 16px 12px;font-size:12px;line-height:18px}
      .appr-state .as-wait{color:var(--text-3)}
      .appr-state .as-err{color:#d25f4a}
      .appr-state .appr-retry{height:26px;padding:0 12px;border-radius:999px;font-size:12px;font-weight:500;line-height:18px;cursor:pointer;border:1px solid var(--border);background:var(--bg);color:var(--text-1)}
      .appr-state .appr-retry:hover{background:var(--hover)}`
    document.head.appendChild(s)
  }

  // ---------- 上下文项目（工具栏项目隔离的唯一来源）----------
  // 会话态 = 该会话所属项目；非会话态 = 目标项目（`newSessionProject()`，work 模式即工作项目）。
  // 空串 = 全局上下文（无项目归属）→ 文件从工作区根起、技能取便携根全局、会话不设隔离。
  function pickHome() {
    const s = state.currentHash ? findSession(state.currentHash) : null
    if (s) return sessionProjLabel(s)
    return newSessionProject() || ''
  }
  // 会话隔离判据（2026-11-07 用户定案）：home = 调用方算好的 `pickHome()`（列表循环里只算一次）。
  //  - 有项目上下文 → **严格**只给该项目的会话（sessionProjLabel 是项目归属的唯一真源）；
  //  - 全局上下文（home 为空）→ **不设隔离**，所有项目的会话都可被引用/搜索（用户明确的例外）。
  function sessionInScope(s, home) {
    if (!home) return true
    return sessionProjLabel(s) === home
  }
  // ---------- 目录 / 文件引用（2026-09-26）：@ 浮窗与 + 工具栏共用的一组「逐级浏览」状态 ----------
  // 数据源 = GET /gateway/fs?path=<相对工作区根的子路径>（只读单层；网关侧复用 listOneLevel，跳过隐藏项
  // 与重型目录、目录在前、单层不设条数上限）。pick.path 是**相对工作区根**的当前层路径，'' = 根——与 chip 上行的
  // 路径同基准（用户定案：相对全局根）。令牌形态 [@目录:路径] / [@文件:路径] 见 core/mention-syntax.js。
  // entries: null=未加载；[]=空目录；[TreeNode…]=已加载。seq 丢弃迟到的旧响应（快速连点目录）。
  // searchOff：搜索/浏览模式开关（2026-10-14 待办 20）——false 且查询非空 = 递归搜索模式（范围 = pickAll.root）；
  // 下钻/返回目录后翻 true（回到层内浏览），浮窗重开（refreshPick）复位 false。
  const pick = { path: '', entries: null, loading: false, err: '', seq: 0, searchOff: false, q: '' }
  // 递归清单（待办 20 的数据层）：BFS 逐层 /gateway/fs（每层分批并发，层间 await）。
  // **扫描根 = pickAll.root = 当前上下文项目目录（pickHome）**，只有全局上下文才是工作区根——
  // 搜索范围与层内浏览同基准，检索不跨项目（2026-11-07 用户实报「在 Pj8 工作，工具栏检索串项目」：
  // 此前根恒为 ''，一次搜索把其它项目的同名文件全列出来）。
  // 不设深度/目录数/条目数上限——当前项目内任意深度都能命中（2026-10-25 用户定案：截断过于严重，
  // 应显示全部）。隐藏目录与 node_modules/dist/.git 等仍由网关侧跳过。
  // 浮窗每次打开经 refreshPick 重置重建（目录内容是外部可变状态，不跨打开缓存）。
  // items 是**流式**清单：BFS 每扫完一批目录就并进去（用户边打边出结果，不必等全量跑完），
  // done=true 才表示跑完整轮。浮窗打开即预热（refreshPick），打字时通常已可用。
  const pickAll = { items: [], done: false, busy: false, seq: 0, err: '', onProgress: null, root: '' }
  const PICK_FS_CONCURRENCY = 24

  function pickParent() {
    const p = pick.path
    const i = p.lastIndexOf('/')
    return i < 0 ? '' : p.slice(0, i)
  }
  function pickLabel() {
    // 搜索模式（2026-10-14 待办 20）：文件组标题提示结果口径（层内浏览则照旧标当前层）。
    // 范围写进标题（= pickAll.root，即当前上下文项目；全局 = 工作区根），用户一眼能看出没跨项目。
    if (pick.q && !pick.searchOff) {
      const scope = pickAll.root || '工作区根'
      return scope + (pickAll.done ? ' · 搜索' : ' · 搜索中…')
    }
    if (pick.loading) return '加载中…'
    if (pick.err) return '加载失败'
    return pick.path || '工作区根'
  }
  // 构建项目内递归清单（幂等；构建期间 busy 挡重入，seq 丢弃被 refreshPick 作废的旧轮）。
  // 完成不自行重渲——由调用方的 after 回调负责（浮窗还开着才重渲）。
  async function ensurePickAll() {
    if (pickAll.done || pickAll.busy) return
    pickAll.busy = true
    const seq = ++pickAll.seq
    const seed = pickAll.root
    let layer = [seed]
    const seen = new Set()
    let rootErr = ''
    try {
      while (layer.length) {
        const next = []
        // 分批并发：整层一次打出去会在目录多的工作区形成数百并发请求（本地网关也能被拖慢）
        for (let i = 0; i < layer.length; i += PICK_FS_CONCURRENCY) {
          const batchItems = []
          const batchDirs = []
          await Promise.all(
            layer.slice(i, i + PICK_FS_CONCURRENCY).map(async (p) => {
              try {
                const r = await fetch(apiUrl('/gateway/fs?path=' + encodeURIComponent(p)))
                const data = await r.json()
                if (!r.ok || !data || !Array.isArray(data.entries)) {
                  // 扫描根失败 = 整份清单不可信（空结果会谎报「无匹配」）：记错并作废本轮，浮窗重开再试。
                  if (p === seed) rootErr = (data && data.error) || `索引失败：${seed || '工作区根'}`
                  return
                }
                for (const e of data.entries) {
                  const cp = p ? `${p}/${e.name}` : e.name
                  batchItems.push({ ptype: e.type === 'dir' ? 'dir' : 'file', name: e.name, path: cp, mtime: e.mtime || 0 })
                  if (e.type === 'dir' && !seen.has(cp)) {
                    seen.add(cp)
                    batchDirs.push(cp)
                  }
                }
              } catch (e) {
                /* 子层失败跳过，不拖垮整轮（扫描根失败另记） */
                if (p === seed) rootErr = e.message || `索引失败：${seed || '工作区根'}`
              }
            }),
          )
          if (seq !== pickAll.seq) return
          // 流式并进清单：本批结果立刻可被 pickItems 检索到，并立刻重渲一次浮窗。
          pickAll.items.push(...batchItems)
          next.push(...batchDirs)
          if (pickAll.onProgress) pickAll.onProgress()
        }
        layer = next
      }
    } finally {
      if (seq === pickAll.seq) {
        pickAll.busy = false
        pickAll.done = !rootErr
        if (rootErr) { pickAll.items = []; pickAll.err = rootErr }
        else pickAll.err = ''
        // 收尾也要重渲一次：否则尾部「搜索中…」会一直挂着（pickSearchKick 只在未开跑时挂 .then）
        if (pickAll.onProgress) pickAll.onProgress()
      }
    }
  }
  // 搜索模式的异步补拉口（两个浮窗的渲染函数各调一次）：查询非空且处于搜索模式、清单未建 →
  // 建清单，完成后浮窗仍开着才重渲。
  function pickSearchKick(re) {
    // 清单流式产出：构建期间每批都回调（有结果立刻显示）；err 非空 = 上一轮根层失败，
    // 不随每次按键重试（会变成按键风暴），等浮窗重开 refreshPick 复位。
    if (pick.q && !pick.searchOff && !pickAll.done && !pickAll.busy && !pickAll.err) {
      pickAll.onProgress = re
      ensurePickAll().then(() => { if (pickAll.onProgress) pickAll.onProgress() }).catch(() => {})
    }
  }
  // 加载某一层（path 相对工作区根）。完成后由调用方重渲自己的浮窗（本函数不碰 DOM）。
  async function loadPickPath(path) {
    const seq = ++pick.seq
    pick.path = String(path || '')
    pick.loading = true
    pick.err = ''
    try {
      const res = await fetch(apiUrl('/gateway/fs?path=' + encodeURIComponent(pick.path)))
      const data = await res.json()
      if (seq !== pick.seq) return false
      if (!res.ok || data.error) throw new Error(data.error || '加载失败')
      pick.entries = Array.isArray(data.entries) ? data.entries : []
    } catch (e) {
      if (seq !== pick.seq) return false
      pick.entries = null
      pick.err = e.message || String(e)
    } finally {
      if (seq === pick.seq) pick.loading = false
    }
    return seq === pick.seq
  }
  // 当前层的可选条目 / 递归搜索结果（2026-10-14 待办 20）。
  // q 为空或已下钻（searchOff）= 原层内浏览：上级目录行 + 当前层全部（按 q 过滤后同样全列）。
  // q 非空且未下钻 = 递归搜索：**当前上下文项目内**的递归清单（pickAll，根 = pickAll.root）
  // 按名称过滤，命中多少列多少（不截断）；不再扫到别的项目。
  // 清单未就绪时文件组暂空（其余组照常），pickSearchKick 建完重渲补上。
  // 「上级目录」只取决于「当前是不是工作区根」，与**这一层的内容**无关——故加载中/加载失败时它照样在，
  // 否则某一层拉不到（目录已删/端点失败）就退不回去，整个文件组成死层。条目本身不塞假行。
  function pickItems(q) {
    const ql = (q || '').trim().toLowerCase()
    pick.q = ql
    const items = []
    if (ql && !pick.searchOff) {
      for (const e of pickAll.items) {
        if (!e.name.toLowerCase().includes(ql)) continue
        items.push({ kind: 'path', ptype: e.ptype, name: e.name, path: e.path, glob: true, t: e.mtime || 0 })
      }
      return items
    }
    if (pick.path) items.push({ kind: 'pathup', name: '上级目录', path: pickParent() })
    if (pick.loading || !pick.entries) return items
    for (const e of pick.entries) {
      if (ql && !String(e.name).toLowerCase().includes(ql)) continue
      const p = pick.path ? `${pick.path}/${e.name}` : e.name
      items.push({ kind: 'path', ptype: e.type === 'dir' ? 'dir' : 'file', name: e.name, path: p, t: e.mtime || 0 })
    }
    return items
  }
  // 目录项进入下一层 / 上级目录返回（两个浮窗的选择入口共用同一处判定）。下钻 = 用户已明确
  // 「要看这个位置」→ 翻回层内浏览模式（此后 q 只做层内过滤，不再全局搜）。
  function pickEnter(it) {
    pick.searchOff = true
    return loadPickPath(it.path)
  }
  // 浮窗打开时定位到当前上下文项目并加载该层（不缓存：目录内容是外部可变状态，缓存会让新建的文件不可见）。
  // **每次打开都回到项目层**（同 @ 浮窗每次打开重置 q/sel）——打开是新的一轮手势，不是接着上次浏览的位置；
  // 层内下钻/返回由 pickEnter 自己拉，走同一处 loadPickPath。
  function refreshPick(after) {
    pick.entries = null // 立刻清旧层：否则换项目后先闪一帧上一个项目的条目（在途请求由 loadPickPath 的 seq 作废）
    pick.err = ''
    pick.q = '' // 查询/层级同属上一轮手势：不复位会先渲一帧旧查询结果（两个浮窗共用本状态）
    pick.path = ''
    pick.searchOff = false // 浮窗重开 = 新一轮手势：回到递归搜索模式（待办 20；范围见 pickAll.root）
    pickAll.items = [] // 递归清单随打开重建（目录内容外部可变，不跨打开缓存；在途轮由 seq 作废）
    pickAll.done = false
    pickAll.err = ''
    pickAll.seq++
    // 搜索根与层内浏览同基准（pickHome：会话所属项目 / work 工作项目；空串 = 全局 → 工作区根）。
    // 搜索只扫这一棵子树，不再跨项目（2026-11-07 用户实报「在 Pj8 工作，工具栏检索串项目」）。
    pickAll.root = pickHome()
    // 作废在途轮时必须同步释放 busy：旧轮 finally 见 seq 不符只跳过写回、不会复位 busy，
    // 否则下一次输入永远起不了新轮（文件搜索整组空白）
    pickAll.busy = false
    // 打开即预热递归清单（不等用户打出查询词才开始扫：早开始早出结果）。
    // 流式批回调与层加载共用 after（渲染点已判 cmd.open）。
    pickAll.onProgress = after || null
    ensurePickAll().catch(() => {})
    loadPickPath(pickAll.root).then((ok) => { if (ok && after) after() })
  }
  // ---------- @ 提及（2026-08-15）：输入 @ 弹出同一工具栏（2026-09-18 会话区提前），选中插入内联 chip ----------
  // 消息文本中 chip 序列化为 [插件:名称] / [会话:名称] 令牌（CLI 终端渲染为 [名称]，遥测端渲染为 chip；
  // 令牌保留 kind 供两端差异化渲染 + 未来插件激活扩展）。
  // @ 提及 icon（2026-09-28 换 dsh v0.2.0-rc.1 产品图标集，16 描线/currentColor；旧 24 手绘那套作废）。
  // 语义与 dsh 一致：会话=ChatLines、插件=PluginPinwheel、技能=Skill、目录=FolderClose、文件=Browse
  // ——与 + 浮窗行图标同源（同一批 I.* 常量），两处不得分叉。会话/文件两枚随 chip 构造器下移 core/mention-syntax.js。
  const MENTION_PLUGIN_ICON = I.dshPlugin
  const MENTION_SKILL_ICON = I.dshSkill
  const MENTION_DIR_ICON = I.dshFolder
  const MENTION_UP_ICON = I.dshUp
  // CM6 接管后 sentinel（零宽 DOM 锚）退役：@ 查询锚点 = doc 位置 anchor（'@' 所在 pos）
  let mention = { open: false, anchor: 0, q: '', items: [], sel: 0 }

  function mentionChipIcon(kind, ptype) {
    if (kind === 'session') return MENTION_SESSION_ICON
    if (kind === 'path' || kind === 'filepick' || kind === 'imgpick') return ptype === 'dir' ? MENTION_DIR_ICON : MENTION_FILE_ICON
    if (kind === 'skill') return MENTION_SKILL_ICON
    return MENTION_PLUGIN_ICON
  }
  // 输入栏内联 chip 的 HTML（@ 插入与 + 工具栏追加共用一份，勿各写一套）
  // 路径 chip 只显示末段文件名，全路径进 title（与消息气泡 mentionChipHtml 同口径）。
  // 展示不带 @ 前缀（2026-10-26 与消息气泡同步：@ 只是唤出手势，不属文件名）。
  function mentionChipInner(kind, name, ptype) {
    const full = kind === 'path' ? unescapeMentionPath(name) : name
    const base = kind === 'path' ? String(full).split('/').pop() : full
    const title = kind === 'path' && base !== full ? ` title="${esc(full)}"` : ''
    return `<span class="m-ic">${mentionChipIcon(kind, ptype)}</span><span class="m-nm"${title}>${esc(base)}</span>`
  }
  function buildMentionChip(kind, name, sid, ptype) {
    const chip = document.createElement('span')
    chip.className = 'mention'
    chip.contentEditable = 'false'
    chip.dataset.kind = kind
    chip.dataset.name = name
    if (kind === 'session' && sid) chip.dataset.sid = sid
    if (kind === 'path') chip.dataset.ptype = ptype === 'dir' ? 'dir' : 'file'
    chip.innerHTML = mentionChipInner(kind, name, ptype)
    return chip
  }

  // chip HTML 构造器（mentionChipHtml / quote*ChipHtml）与令牌正则、splitSessionToken 已下移
  // core/mention-syntax.js（core 叶子，供 core/markdown.js 与本源共用，断开 core→feature 成环）。

  // 引用 chip → 消息文本。两条链的落地形态刻意不同（用户定案 2026-09-28）：
  //  文件引用 = 只给位置，模型自己 Read；
  //  回复引用 = 原文必须进消息——回复不属于任何文件，没有位置可查。原文包在令牌块里（`QUOTE_REPLY_BODY_RE`），
  //  渲染层整块剥掉只留锚点令牌 → 胶囊。首尾不留多余换行（留了会撑出多余行距，2026-09-28 用户实报「自带一个换行」）。
  function refToken(d) {
    if (d.rkind === 'pdf') {
      const p = refPath(d.file, d.proj)
      const loc = d.p0 ? `#p${d.p0}${d.p1 && d.p1 !== d.p0 ? '-' + d.p1 : ''}` : ''
      return `[@引用PDF:${p}${loc}]\n${String(d.quote || '')}\n[/引用PDF]`
    }
    if (d.rkind !== 'file') {
      const title = String(d.title || '本会话').replace(/[\]|\r\n]/g, ' ').trim() || '本会话'
      return `[@引用回复:${d.idx || 0}|${title}]\n${String(d.quote || '')}\n[/引用回复]`
    }
    const p = refPath(d.file, d.proj)
    return d.l0 ? `[@引用:${p}#L${d.l0}-${d.l1}]` : `[@引用:${p}]`
  }

  // 引用路径基准 = 模型能直接 Read 的形式：会话启动根（模型 cwd）就是该 work 项目本身时用项目内
  // 相对路径；否则带项目 label（工作区相对——会话开在别的项目下时仍指向同一文件）。cwd 未知同样带 label。
  function refPath(file, proj) {
    const cwd = String(sessionCwd || '').replace(/\\/g, '/').replace(/\/+$/, '')
    if (proj && cwd.split('/').pop() === proj) return file
    return proj ? proj + '/' + file : file
  }

  // 引用**原文块**在气泡里的形态（2026-10-21 用户定案）：原文并进锚点令牌的第三个字段（百分号编码），
  // 由 core/mention-syntax.js 的 chip 构造器渲染成「图标 + 原文」的蓝色引用胶囊（不再有 blockquote 的
  // margin/padding = 与正文上下对齐，也不再显示「引用自…第 N 条回复」标签）。模型侧原文不动（令牌块原样上行）。
  // **折叠后不补换行**（2026-10-24 用户实报「引用发送后后面总有莫名其妙的换行」）：胶囊是行内元素，
  // 用户话术紧接其后自然流动；补 `\n` 会被 mdHtml 拆成下一段并落 `<br>`，表现为「引用后凭空换行」。
  // 三个渲染入口（messages.js userBodyHtml / approval.js renderTransient 的 bodyText 与队列 txt）共用本收口。
  const quoteBodiesAsMarkdown = foldQuoteBodies

  // 实时回显的用户消息：把令牌转 chip（与离线 messagesHtml 的 mdInline 一致）
  function renderUserText(text) {
    return esc(text)
      .replace(MENTION_PLUGIN_RE, (_, n) => mentionChipHtml('plugin', n))
      .replace(MENTION_SESSION_RE, (_, n) => mentionChipHtml('session', n))
      .replace(MENTION_PATH_RE, (_, t, p) => mentionChipHtml('path', p, t === '目录' ? 'dir' : 'file'))
      .replace(QUOTE_REF_RE, (_, p, a, b) => quoteRefChipHtml(p, a, b))
      .replace(QUOTE_REPLY_RE, (_, i, t, b) => quoteReplyChipHtml(i, t, b))
      .replace(QUOTE_PDF_RE, (_, p, a, b, q) => quotePdfChipHtml(p, a, b, q))
  }

  // 序列化 = CM doc 原文（2026-10-14 CM6 接管）：令牌文本本就是序列化形态、chip 是它的装饰视图。
  // 例外（2026-10-24）：引用原文在底栏 doc 里是折叠单行令牌（chip 即所见），发送时还原成
  // 「锚点行 + 原文 + 收尾行」的块形态——模型读到的必须是原文，不是百分号编码。
  function serializeInput() {
    return unfoldQuoteBodies(composerDocText())
  }

  // 复位 @ 数据态（不碰 DOM、不开关工具栏）：@ 关闭链与工具栏关闭链共用同一处，避免两套状态漂移。
  function resetMention() {
    mention.open = false
    mention.anchor = 0
    mention.q = ''
    mention.items = []
    mention.sel = 0
  }

  function closeMentionPop() {
    const wasOpen = mention.open
    resetMention()
    // 工具栏是 @ 与 + 的唯一弹窗（2026-10-25 用户定案）：@ 态结束必须把工具栏一起收起，
    // 否则会留下一个没有 @ 锚点却仍按 + 模式渲染的弹窗。closeCmdPop 不会回调本函数（只调 resetMention）。
    // 只在「@ 态确实开着」时才碰 cmd（composer 初始 mount 会在 commands.js 之前调本函数，
    // 此时 cmd 尚处 TDZ；wasOpen=false 短路即避开）。
    if (wasOpen && cmd.mentionMode) closeCmdPop()
    return wasOpen
  }

  function openMentionPopAtCaret() {
    if (!cmView) return
    mention.open = true
    mention.anchor = cmView.state.selection.main.from - 1 // '@' 的 doc 位置（composer onInputMention 判定后调）
    mention.sel = 0
    mention.q = ''
    // 输入 @ 不另立浮窗，直接唤起同一个 + 工具栏并进入 mention 模式（打开/加载/重渲统一在
    // commands.js 的 openCmdPopMention；本件只维护 @ 的锚点与查询词）。
    openCmdPopMention()
  }

  // 条目落地的唯一入口（点击与回车共用）：目录/上级=下钻重渲；文件=插 chip；会话/技能=插 chip。
  function selectMentionItem(it) {
    if (it.kind === 'pathup' || (it.kind === 'path' && it.ptype === 'dir')) {
      pickEnter(it).then(() => { if (cmd.open && cmd.mentionMode) renderCmdPop() })
      return
    }
    // 已上传附件（待办 6）：把正文 md 引用原文写回 doc（与自动插入同一形态，CM 行内直渲）。
    // kind=attref（images.js uploadedMentionItems 唯一产出）；imgpick/filepick 只作首屏上传动作行。
    if (it.kind === 'attref') {
      const pos = cmView ? cmView.state.selection.main.from : mention.anchor
      composerReplaceRange(mention.anchor, pos, it.md + ' ')
      closeMentionPop()
      syncGwSend()
      return
    }
    if (it.kind === 'path') insertMention('path', it.path, '', 'file')
    else insertMention(it.kind, it.name, it.sid)
  }

  // 键盘移动/选择：@ 模式与 + 模式共用同一个工具栏列表（cmd.items/cmd.active），直接转调 commands.js。
  // CM 键盘链先判 cmd.isOpen()，mention 分支只在理论上兜底——保持薄转调，不另存一份高亮状态。
  function moveMentionSel(d) {
    if (cmd.open && cmd.mentionMode) cmdMove(d)
  }

  function selectMention() {
    if (cmd.open && cmd.mentionMode) { cmdSelect(); return }
    const it = mention.items[mention.sel]
    if (it) selectMentionItem(it)
  }

  // 选中项 → 令牌 + 尾随空格替换 @查询区间（[mention.anchor, 光标]），光标到空格后。sid 仅会话
  // chip 有（寻址键，序列化为 `[会话:标题|sid]`；插件/技能无 sid）。
  function insertMention(kind, name, sid, ptype) {
    const token = kind === 'session'
      ? (sid ? `[会话:${name}|${sid}]` : `[会话:${name}]`)
      : kind === 'path'
        ? mentionPathToken(name, ptype)
        : `[插件:${name}]`
    const pos = cmView ? cmView.state.selection.main.from : mention.anchor
    composerReplaceRange(mention.anchor, pos, token + ' ')
    closeMentionPop()
    syncGwSend()
  }

  // doc/选区变化：检测 @ 触发 / 维护已打开的 @查询（光标前是 @ 则开浮窗）。锚点 = '@' 的 doc 位置
  function onInputMention() {
    if (!GATEWAY || gateAwait || state.mgr || !cmView) { closeMentionPop(); return }
    const st = cmView.state
    const pos = st.selection.main.from
    // IME 组合期（中文键盘敲字母即进入组合）：组合中的 doc 文本是**临时拼音/候选**，
    // 选区也不可信——拿它过滤会把浮窗筛空并按「无结果」关掉，或按选区判定误杀。
    // 组合期一律不判不动（不开、不更新查询、不关），等 compositionend 上屏后的 doc 事务
    // 走正常判定。`composing` 是 CM6 EditorView 的真实组合态字段（旧写法 compositionStarted
    // 根本不存在 ⇒ 守卫恒为假，查询词跟着组合中的临时文本乱跳）。组合结束由 onCompositionEnd
    // 再按最终 doc 判定一次，避免末次事务缺失时浮窗停在空查询的旧结果上。
    if (cmView.composing) return
    if (st.selection.main.from !== st.selection.main.to || !st.selection.main.empty) { if (mention.open) closeMentionPop(); return }
    if (mention.open) {
      const between = st.doc.sliceString(mention.anchor, pos)
      if (pos <= mention.anchor || /[\n\r]/.test(between)) { closeMentionPop(); return }
      const q = between.slice(1)
      if (q !== mention.q) { mention.q = q; if (cmd.open) renderCmdPop() }
      return
    }
    if (pos > 0 && st.doc.sliceString(pos - 1, pos) === '@') openMentionPopAtCaret()
  }
  function onInputChange() { syncGwSend(); onInputMention() }
  // IME 组合结束：CM 在 compositionend 后可能不再派发 doc/selection 事务（组合文本已在组合期
  // 进 doc），此时 @ 查询词仍是组合期旧值 ⇒ 浮窗停在空查询的全量列表。延后一拍按最终 doc 重判。
  function onCompositionEnd() {
    if (!cmView) return
    setTimeout(() => { if (cmView) onInputMention() }, 0)
  }

  // cmView = 包内 composer 视图的共享镜像：mention.js 等模块直接读它（旧实现由本件声明）。
  // 包实例在 mount() 建视图，之后只有 ensure()；此处保持同步，勿改成局部变量。
  let cmView = null
  const composer = FloriaCM6.createComposer({
    parent: $('cm-host'),
    setInputEl: (el) => { inputEl = el },
    toast,
    send: () => gwSend(),
    gate: {
      isAwait: () => gateAwait,
      submit: () => gateSubmit(),
    },
    cmd: {
      isOpen: () => cmd.open,
      move: (d) => cmdMove(d),
      select: () => cmdSelect(),
      close: () => closeCmdPop(),
      render: () => renderCmdPop(),
    },
    model: {
      isOpen: () => msel.open,
      escape: () => modelEscape(),
      move: (d) => mselMove(d),
    },
    mention: {
      isOpen: () => mention.open,
      move: (d) => moveMentionSel(d),
      select: () => selectMention(),
      close: () => closeMentionPop(),
      update: () => onInputMention(),
      compositionEnd: () => onCompositionEnd(),
    },
    chips: {
      build: (kind, name, sid, ptype) => buildMentionChip(kind, name, sid, ptype),
      splitSession: (v) => splitSessionToken(v),
      fileIcon: (p) => fileIcon(p),
      iconReply: I.msg,
      esc: (s) => esc(s),
      decodeQuoteBody: (s) => decodeQuoteBody(s),
      foldQuoteBodies: (t) => foldQuoteBodies(t),
    },
    paste: {
      clipboardFiles: (cd) => clipboardFiles(cd),
      clipboardImageUrls: (html) => clipboardImageUrls(html),
      addImageFiles: (f) => addImageFiles(f),
      addUploadFiles: (f) => addUploadFiles(f),
      addImageUrls: (u) => addImageUrls(u),
    },
    docChanged: () => syncGwSend(),
  })
  composer.mount()
  cmView = composer.getView()

  // ---------- 公开 API（接缝不变，转调包实例） ----------
  function composerDocText() { return composer.docText() }
  function composerSetText(text) { composer.setText(text) }
  function composerAppendToken(text) { composer.appendToken(text) }
  function composerAppendRef(token) { composer.appendRef(token) }
  function composerAppendText(text) { composer.appendText(text) }
  function composerReplaceRange(from, to, ins) { composer.replaceRange(from, to, ins) }
  function composerFocus() { composer.focus() }
  function composerBlur() { composer.blur() }
  function composerSetEditable(on) { composer.setEditable(on) }
  function composerPlaceholder(text) { composer.placeholder(text) }

  // ---------- 命令菜单 + 模型选择（2026-08-21 dsh 输入栏逻辑移植）----------
  // ⚠️ 数据源 = 本地内置展示数据（⚠️ 非 dsh 真实注册表、非网关接口）：
  // 网关暂无 /gateway/commands 与 /gateway/models，命令列表/模型目录先本地内置供 UI 审阅——
  // 命令 = floria(Claude Code) 真实斜杠命令（claim=带参数/bare=直接执行/risk=需确认门），
  // 模型目录 = 真实 Claude 模型（对齐 dsh ModelDirectory：provider 分组 + reasoning.defaultEffort/efforts[]）。
  // 待网关接口就绪后替换数据源，交互逻辑不变。
  const MOCK_COMMANDS = [
    { name: 'compact', desc: '压缩当前会话上下文', claim: true },
    { name: 'model', desc: '切换模型', claim: true },
    { name: 'permission', desc: '调整权限模式', claim: true },
    { name: 'plan', desc: '进入计划模式', claim: true },
    { name: 'rename', desc: '重命名会话', claim: true },
    { name: 'resume', desc: '继续子代理会话', claim: true },
    { name: 'retry', desc: '重试上一条消息', bare: true },
    { name: 'status', desc: '会话状态', bare: true },
    { name: 'skills', desc: '查看可用技能', bare: true },
    { name: 'plugins', desc: '查看插件清单', bare: true },
  ]
  // 推理等级（全局：Off/Low/High/Max，对齐 CLI effortValue 语义；Off=不发送 effort 参数。2026-08-22 由 per-model reasoning 改为全局）
  const EFFORT_LEVELS = [
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max' },
  ]
  // 模型目录（真实凭据池，与 floria MGR 模型 tab 同源）：2026-08-29 直接切模型自动切供应商 →
  // 全池模型可选（items 内 src 以「凭据池」开头的行，跨商直选由网关自动切供应商）；回落 providerModels → items。
  // 2026-08-22 取代 MOCK_MODEL_DIR（anthropic 上游）。
  function modelDir() {
    const pool = ((MODELS && Array.isArray(MODELS.items) ? MODELS.items : []) || [])
      .filter(it => it && typeof it.src === 'string' && it.src.startsWith('凭据池') && it.v)
      .map(it => String(it.v))
    const raw = pool.length
      ? pool
      : ((MODELS && Array.isArray(MODELS.providerModels) && MODELS.providerModels.length)
        ? MODELS.providerModels
        : ((MODELS && Array.isArray(MODELS.items) ? MODELS.items : []).map(it => String(it.v)).filter(Boolean)))
    const seen = new Set()
    const out = []
    for (const id of raw) {
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
    return out
  }
  // 当前选中模型（本地状态；首次 /gateway/models 加载后与凭据池 activeModel/provider/effortLevel 对齐）
  // 2026-08-24 模型 web/CLI 同步：MODEL_CUR 持久化 localStorage（刷新恢复），并按 /gateway/session 上报的
  // 会话实际模型（CLI reportCurrentModel）校准——每会话 override 只在 CLI 内存，web 不持久化会回落
  // 凭据池默认 activeModel 造成「CLI 用 vision-exp / web 显示 flash」不一致。
  const MODEL_KEY = 'floria-model-v1'
  function loadModelCur() {
    try {
      const raw = localStorage.getItem(MODEL_KEY)
      if (!raw) return null
      const o = JSON.parse(raw)
      if (o && typeof o === 'object' && typeof o.model === 'string' && o.model) return o
    } catch { /* 存储不可用忽略 */ }
    return null
  }
  function saveModelCur() {
    try {
      // 2026-09-19：ts 同时回写 MODEL_CUR（不只写 localStorage）——applySessionModel 的「切换前在途
      // 快照」判定要比 modelTs < MODEL_CUR.ts，ts 只落盘不进内存则内存版恒无 ts，判定失效。
      MODEL_CUR.ts = Date.now()
      localStorage.setItem(MODEL_KEY, JSON.stringify({ provider: MODEL_CUR.provider, model: MODEL_CUR.model, effortLevel: MODEL_CUR.effortLevel, ts: MODEL_CUR.ts }))
    } catch { /* 存储不可用忽略 */ }
  }
  let MODEL_CUR = loadModelCur() || { provider: '', model: '', effortLevel: undefined }
  // 用户本次会话内主动切换过模型 → 不再被 /gateway/session 旧上报覆盖（切换会话时重置）。避免
  // POST /gateway/model 尚未落地前的一次刷新把刚切的选择回滚成旧值。
  let modelUserPicked = false
  // 2026-11-06 会话隔离（B）：主动切模型的判定只对「当时那个会话」成立。旧守卫用全局
  // modelUserPicked + MODEL_CUR.ts（localStorage 跨会话持久化）→ 切到另一个会话时，该会话后端
  // 上报的模型（modelTs 早于上次切换时刻）被当成「在途旧快照」丢弃，座停在上一会话的模型。
  let modelPickedHash = ''
  // 首页（新会话）模型选择（2026-10-11 定案）：全局默认模型不再由 web 调整——唯一入口 = 直接改
  // 凭据池 credentials.json（agent 侧）。首页选的模型只作用于**这一次新建的会话**：记入本槽，
  // 发送首条消息时随会话级切换（POST /gateway/model 带 sessionId，见 send.js 空态分支）落到新会话，
  // 消费即清；回首页且无待定选择时 seat 回落凭据池全局默认（syncSeatToGlobalDefault）。
  let newSessionModel = ''
  function getNewSessionModel() { return newSessionModel }
  function setNewSessionModel(v) { newSessionModel = typeof v === 'string' ? v : '' }
  // 用 CLI 上报的会话实际模型校准模型 seat（2026-10-10 分层治理 4B 自 engine/sessions.js 反转迁入：
  // 「校准 seat」是输入栏行为，归 feature 层——engine 不再 import feature，故本函数随状态同处）。
  // 网关的每会话模型是权威源（CLI 上报即真，见 reportCurrentModel），web 一律采纳；唯一例外是
  // **切换前的在途快照**——用户刚在 web 切过（modelUserPicked）且这条上报的时刻早于那次切换
  // （modelTs < 本地 ts）→ 它是切换前发出的旧数据，采纳会把刚做的选择回滚（用户反馈「web 保留了
  // 上一个」）。旧实现用 modelUserPicked 一票否决整页会话剩余时间，CLI 侧后续切模型永远进不来
  // → 弃用，改为时间戳比较；一旦采纳过一次上报（外部真相落定）即解除防回滚标记，恢复常态跟随。
  function applySessionModel(model, modelTs) {
    if (!model) return
    // 写 modelUserPicked 一律走 setModelUserPicked（ESM 导入绑定只读，直接赋值 esbuild 直接报错）
    if (MODEL_CUR.model === model) { setModelUserPicked(false); return }
    if (
      modelUserPicked &&
      modelPickedHash === (state.currentHash || '') &&
      typeof modelTs === 'number' &&
      typeof MODEL_CUR.ts === 'number' &&
      modelTs < MODEL_CUR.ts
    ) return
    setModelUserPicked(false)
    setModelCur({ ...MODEL_CUR, model })
    saveModelCur()
    renderModelSeat()
  }
  // 命令菜单状态（对齐 dsh PopupState：open/status/options/search/active/submitting/confirming/acknowledged/error）
  // 2026-09-09 二轮定案：去 tab 单页分组（上传/技能/引用会话/指令堆放一页）；items=渲染时平铺条目（键盘索引基准）
  // mentionMode = 本弹窗由输入 @ 唤起（2026-10-25 用户定案：工具栏是 @ 与 + 的唯一弹窗）。
  // 该模式下查询词取 mention.q（@ 后到光标的文本）、结果扁平按时间混排、选中写回 @ 锚点；
  // 非 mention 模式（= + 打开）才走入口视图与首屏。
  const cmd = { open: false, view: '', mentionMode: false, status: 'pending', items: [], active: 0, prevActive: 0, submitting: false, confirming: null, acknowledged: false, error: null }
  // 模型菜单状态（对齐 dsh ModelSelect Pane：root | model | effort）
  const msel = { open: false, pane: 'root', active: 0 }
  const cmdPop = $('cmd-pop')
  const modelPop = $('model-pop')
  const modelSeatEl = $('model-seat')

  // ---- 项目选择器（2026-09-02；2026-11-06 与 work 侧栏同构）----
  // 实现 = feature/project-picker/project-picker.js（唯一真源），数据源 = state.projects（后端 findProjects），
  // 与 work 下拉同源同 UI；本处只注入差异：含「全局（默认）」行、选中 = 当前会话归属 / state.newProject、
  // 选定后写 state.newProject（与侧栏项目「+」同链路：首条消息发送时 /gateway/wsession 带 project →
  // 会话落该项目根）。全局行=清回默认（同 chip X）。仅初始界面显示（CSS：#empty-hint 内才 display:flex）。
  const projPop = $('proj-pop')
  const projSeatEl = $('proj-seat')
  projSeatEl.querySelector('.projIco').innerHTML = I.folder
  projSeatEl.querySelector('.chevron').innerHTML = I.dshChevDown
  // seat 只读的两个态：①会话态（工作文件夹 = 该会话所属项目）②work 模式且已选工作项目——在项目中
  // 工作就只能在该项目建会话，目标项目不可改（唯一判定点，seat 渲染与点击守卫共用）。
  function projSeatLocked() {
    return !!state.currentHash || (state.sbMode === 'work' && !!state.workProj)
  }
  const projPicker = createProjectPicker({
    pop: projPop,
    seat: projSeatEl,
    allowGlobal: true,
    canOpen: () => !projSeatLocked(),
    beforeOpen: () => {
      // 打开前收起同一位置上的其它浮层（命令菜单 / 模型菜单 / @ 提及），与原 seat 点击链同口径。
      if (cmd.open) closeCmdPop()
      if (msel.open) closeModelPop()
      closeMentionPop()
    },
    getSelected: () =>
      state.currentHash ? sessionProjLabel(findSession(state.currentHash)) : newSessionProject() || '',
    onPick: (label) => {
      state.newProject = label || null
      renderProjSeat()
    },
  })
  // 对外只读的弹层状态（ctx-meter 的外点关闭用）；开/关语义统一收在组件里。
  const psel = { get open() { return projPicker.isOpen() } }
  function renderProjSeat() {
    const locked = projSeatLocked()
    // 锁定态收口：已展开的选择层即刻收起——否则切到 work 模式（或进会话）时残留的浮层仍可点，
    // 选中的目标项目在锁定态根本不生效，读起来像「改了没反应」。
    if (locked) closeProjPop()
    const s = state.currentHash ? findSession(state.currentHash) : null
    const label = state.currentHash
      ? (s && sessionProjLabel(s) || '全局')
      : (newSessionProject() || '全局')
    projSeatEl.querySelector('.projLabel').textContent = label
    projSeatEl.title = locked ? '工作文件夹：' + label : (newSessionProject() ? '目标项目：' + newSessionProject() : '目标项目：全局（默认）')
    projSeatEl.classList.toggle('locked', locked)
  }
  function renderProjPop() { projPicker.render() }
  function openProjPop() { projPicker.open() }
  function closeProjPop() { projPicker.close() }

  // 逐命令字形（同 dsh ui-commands presentation.ts 的 HOST_FACES 语义：每个内置命令各有图标，
  // 不是整列共用一个「+」）。表外命令回落 dshPlus。字形来源与说明见 core/icons.js 同段注释。
  const CMD_ICON = {
    compact: I.dshCompact,
    model: I.dshSliders,
    permission: I.dshShield,
    plan: I.dshPlan,
    rename: I.dshEditOutline,
    resume: I.dshPlay,
    retry: I.dshRefresh,
    status: I.dshGauge,
    skills: MENTION_SKILL_ICON,
    plugins: MENTION_PLUGIN_ICON,
  }
  // ---------- 条目分组（+ 工具栏入口视图的唯一真源）----------
  // 搜索结果**不分组也不截断**（2026-10-25 用户定案：@ 唤起同一工具栏、扁平按时间排列）；
  // groupOf 只服务 + 工具栏的入口视图（每类一屏）与首屏两组（上传 / 浏览）。
  const GROUP_OF = { imgpick: '上传', filepick: '上传', attref: '上传', session: '聊天', plugin: '技能', skill: '技能', path: '文件', pathup: '文件', pathwait: '文件' }
  function groupOf(it) {
    return GROUP_OF[it.kind] || '指令'
  }
  // 「+」浮窗的入口视图（2026-10-25 用户定案：扁平分组的工具栏太乱，改为入口形式——首屏只列
  // 上传动作 + 四类入口，点进某一类后展示该类**全部**条目，不截断；底栏有查询词时退回跨类搜索）。
  const CMD_VIEWS = [
    { view: 'session', name: '会话', desc: '引用一个会话', icon: MENTION_SESSION_ICON },
    { view: 'file', name: '文件', desc: '浏览工作区文件与目录', icon: I.dshFolder },
    { view: 'skill', name: '技能', desc: '引用插件或技能', icon: MENTION_SKILL_ICON },
    { view: 'cmd', name: '指令', desc: '运行斜杠命令', icon: I.dshPlus },
  ]
  // 过滤查询唯一来源 = 底栏输入框文本（2026-10-14 待办 20 返修）：弃独立搜索框——旧框每次 input 都
  // innerHTML 重渲并**重建框自身**，IME 组合期被打断 = 中文打不进；底栏文本驱动则渲染只碰浮窗，
  // 底栏 contenteditable 原样不动，中文 IME 正常。命令前缀 / 由 cmdEntries 剥。
  function barQuery() {
    return serializeInput().trim()
  }

  // 弹窗的统一条目源（@ 模式与 + 工具栏搜索共用；+ 的入口视图另走 cmdEntries）。
  // **全局搜索 = 扁平列表**（2026-10-25 用户定案：不做类别隔离），按时间倒序混排：
  // 会话 updatedAt / 文件目录 mtime（/gateway/fs 返回）/ 本次上传（now）；无时间字段的技能与指令 t=0 稳定排末尾。
  // **空查询 / 已下钻 = 浏览**：保留数据层既有顺序（上传 → 近 48h 会话 → 技能 → 当前层），不做时间排序。
  function mentionItems(q) {
    const ql = (q || '').trim().toLowerCase()
    const match = (s) => !ql || String(s || '').toLowerCase().includes(ql)
    const globalSearch = !!ql && !pick.searchOff
    const now = Date.now()
    const items = []
    // 「上传」组（待办 6）：本次上传的附件（图片/文件），选中插回正文 md 引用。属于「刚刚发生」，时间取 now。
    for (const u of uploadedMentionItems()) if (match(u.name)) items.push({ ...u, t: now })
    // 会话：**空查询**只给近 48h 建议（免浮窗一开就几百条）；**有查询词**时搜全量——标题检索必须与
    // 侧栏一致，不能因会话旧于 48h 就查不到（2026-10-17 用户实测：侧栏有「202610131215-有机随想」，
    // 输入 @2026101312 却只剩文件命中）。
    // 项目隔离 = sessionInScope：有项目上下文只给该项目的会话；全局上下文不设隔离（2026-11-07 定案）。
    // home 只算一次（每条会话都重算 pickHome 会做 N 次 findSession）。
    const home = pickHome()
    const cutoff = now - 48 * 3600 * 1000
    for (const s of ALL) {
      if (!sessionInScope(s, home)) continue
      if (!globalSearch && s.updatedAt < cutoff) continue
      // sid = 会话转录文件名主干，与会话间协作的寻址键同源（engine/sessions.js hashOf = 路由 hash）
      if (match(s.title || '')) items.push({ kind: 'session', name: s.title || '未命名会话', sid: hashOf(s), desc: relTime(s.updatedAt), t: s.updatedAt })
    }
    // 当前项目自己的技能（项目根 .claude/skills）：与 + 工具栏技能组同源，行尾标项目编号。
    const proj = home
    // 已停用（en === 0）的自定义件不进 @ 提及：停用后 agent 侧也不暴露，入口需一致。
    for (const s of projSkillsOf(proj).list) if (s.en !== 0 && (match(s.n) || match(s.d))) items.push({ kind: 'skill', name: s.n, desc: s.d, proj, t: 0 })
    if (MGR) {
      // 技能只给当前项目自己的（有项目上下文时不再混便携根全局技能）；
      // 插件是便携根安装件、无项目归属，两种上下文都列。
      for (const p of (MGR.plugins && MGR.plugins.personal) || []) if (p.en !== 0 && match(p.n)) items.push({ kind: 'plugin', name: p.n, desc: p.d, t: 0 })
      if (!proj) for (const s of (MGR.skills && MGR.skills.personal) || []) if (s.en !== 0 && match(s.n)) items.push({ kind: 'skill', name: s.n, desc: s.d, t: 0 })
    }
    items.push(...pickItems(q))
    if (globalSearch) items.sort((a, b) => (b.t || 0) - (a.t || 0))
    return items
  }

  // 会话行（会话入口与搜索共用）：sid = 会话间协作的寻址键，两个路口径必须一致（同 @ 提及链）。
  function cmdSessionRows(match, grp) {
    const out = []
    const home = pickHome()
    for (const s of [...ALL].sort((a, b) => b.updatedAt - a.updatedAt)) {
      // 项目隔离与 @ 提及共用 sessionInScope（有项目只给本项目；全局不设限制）。
      if (!sessionInScope(s, home)) continue
      if (match && !match(s.title || '')) continue
      out.push({ kind: 'session', name: s.title || '未命名会话', sid: hashOf(s), desc: relTime(s.updatedAt), grp })
    }
    return out
  }
  // 行尾项目标记：项目 label 取编号前缀（`Pj8-工作区机械臂设计` → `Pj8`），无编号则整串。
  function projTag(label) {
    const m = /^((?:Sub)?Pj\d+)/i.exec(String(label || ''))
    return m ? m[1] : String(label || '')
  }
  // 技能行 = 插件 + 技能（MGR 同源）+ **当前项目自己的技能**（项目根 .claude/skills，行尾标项目名）。
  // 项目判定与 + 浮窗文件组同一处（pickHome：会话所属项目 / work 工作项目，空串 = 无项目上下文）。
  function cmdSkillRows(match, grp) {
    const out = []
    const proj = pickHome()
    // 技能按上下文项目隔离——有项目上下文只列该项目根 .claude/skills，
    // 不再混入便携根全局技能（MGR.skills.personal 只服务无项目上下文的全局态）。
    // 已停用（en === 0）的自定义件不列：停用即不暴露给 agent，入口同步收口。
    if (proj) {
      for (const s of projSkillsOf(proj).list) if (s.en !== 0 && (!match || match(s.n) || match(s.d))) out.push({ kind: 'skill', name: s.n, desc: s.d, grp, proj })
    } else if (MGR) {
      for (const s of (MGR.skills && MGR.skills.personal) || []) if (s.en !== 0 && (!match || match(s.n) || match(s.d))) out.push({ kind: 'skill', name: s.n, desc: s.d, grp })
    }
    // 插件是便携根安装件、无项目归属，两种上下文都列（与技能不同源，不算「混入」）
    if (!MGR) return out
    for (const p of (MGR.plugins && MGR.plugins.personal) || []) if (p.en !== 0 && (!match || match(p.n) || match(p.d))) out.push({ kind: 'plugin', name: p.n, desc: p.d, grp })
    return out
  }
  // 文件索引（pickAll）流式进度只影响「正在展示文件结果」的视图（文件视图 / @ 跨类搜索）；
  // 其余视图（技能/会话/指令/首屏）不因索引进度整块重渲。
  function pickProgressRenders() {
    return cmd.view === 'file' || (cmd.mentionMode && !cmd.view && !!mention.q.trim())
  }
  // 文件清单是流式产出的（BFS 每批即并入）：跑完且零命中才报「无匹配」，未跑完就在尾部挂
  // 「搜索中…」——有命中照常列出，用户不必干等全量索引。base = 推入搜索结果前的行数（文件视图无「返回」行）。
  function pushSearchState(items, base) {
    if (pickAll.err) { items.push({ kind: 'pathwait', name: '索引失败', desc: pickAll.err }); return }
    if (!pickAll.done) { items.push({ kind: 'pathwait', name: '搜索中…', desc: '正在索引 ' + (pickAll.root || '工作区根') }); return }
    if (items.length === (base || 0)) items.push({ kind: 'pathwait', name: '无匹配结果', desc: '' })
  }
  function cmdEntries() {
    // 查询词：@ 模式 = @ 后到光标的文本；+ 模式 = 底栏全文（剥掉可能的前导 /）。
    const q = (cmd.mentionMode ? mention.q : barQuery()).trim().toLowerCase().replace(/^\//, '')
    const match = (s) => !q || String(s || '').toLowerCase().includes(q)
    const items = []
    // 范围判据（2026-10-25 用户定案）：**进了某一类视图 = 查询只在该类里搜**；没进视图时
    // @ 后有查询词 = 跨类扁平全局搜索（不按类隔离、按时间混排）。只输入 @ 而无查询词 =
    // 等价于唤出工具栏首屏（与 + 一致）。+ 模式底栏文本只过滤当前入口视图，从不触发全局搜索。
    if (cmd.view) {
      // 文件视图不叠「导航/返回」（2026-11-05 用户定案）：它自带「上级目录」，两行同图标上箭头 + 两个分组标题
      // 看着像两栏叠在一起；文件视图的退出走 Esc / 点浮窗外（pathup 行同时承担层内上行）。
      if (cmd.view !== 'file') items.push({ kind: 'back', name: '返回', grp: '导航' })
      if (cmd.view === 'session') items.push(...cmdSessionRows(match, '会话'))
      else if (cmd.view === 'skill') items.push(...cmdSkillRows(match, '技能'))
      // 指令分支必须带花括号：`else if (…) for (…) if (…) push()` 后面再跟 `else if` 会把
      // 它吸附给内层 if（悬垂 else），文件视图分支永远不执行（2026-10-25 根因：@ 点「文件」只剩「返回」）。
      else if (cmd.view === 'cmd') {
        for (const o of MOCK_COMMANDS) if (match(o.name) || match(o.desc)) items.push({ kind: 'cmd', name: o.name, desc: o.desc, ref: o, grp: '指令' })
      }
      // 文件视图：有查询词 = 只搜文件（同一条项目文件清单，不含会话/技能）；空查询 = 层内浏览。
      else if (cmd.view === 'file') {
        if (q) {
          const base = items.length
          items.push(...pickItems(q))
          pushSearchState(items, base)
          pickSearchKick(() => { if (cmd.open) renderCmdPop() })
        } else items.push(...pickItems('').filter((it) => it.kind === 'pathup' || match(it.name)))
      }
      return items
    }
    if (cmd.mentionMode && q) {
      items.push(...mentionItems(q))
      pushSearchState(items)
      pickSearchKick(() => { if (cmd.open) renderCmdPop() }) // 清单未跑完 → 流式补渲
      return items
    }
    // 首屏入口：两个上传动作 + 已上传附件的引用行 + 四类入口
    items.push({ kind: 'imgpick', name: pendingImages.length ? '继续选择图片…' : '选择图片…', desc: pendingImages.length ? `已选 ${pendingImages.length}/9 · 自动压缩` : '一次最多 9 张，自动压缩', grp: '上传' })
    items.push({ kind: 'filepick', name: '上传文件…', desc: '任意类型可多选 · 存入 file-cache/（按会话）', grp: '上传' })
    // 已上传附件的引用行（2026-11-01 根因）：此前只有 @ 后**再输查询词**才经 mentionItems 列出，
    // 首屏看不到刚传的图 → 用户实测「上传的图片 @ 这个渲染缺失」。数据源与 @ 搜索同一份
    // （images.js uploadedMentionItems），只列行不渲缩略图（2026-10-22 定案：缩略图只在底栏胶囊）。
    items.push(...uploadedMentionItems().map((it) => ({ ...it, desc: it.attKind === 'img' ? '插入图片引用' : '插入文件引用', grp: '上传' })))
    // 首屏四个入口是导航不是数据：底栏有文字也不过滤（否则「有文字点 +」会只剩上传两行，像坏了）
    for (const v of CMD_VIEWS) items.push({ kind: 'entry', view: v.view, name: v.name, desc: v.desc, icon: v.icon, grp: '浏览' })
    return items
  }
  function currentChoice() {
    const id = MODEL_CUR.model || (MODELS && (MODELS.activeModel || (MODELS.model ? String(MODELS.model) : ''))) || ''
    if (!id) return null
    return { model: { id, name: id } }
  }
  // 推理等级名（全局；effortLevel 未设置 = Off / 无 off 档模型显示「默认」）
  function effLabel() {
    const eff = MODEL_CUR.effortLevel
    if (eff === undefined || eff === null) return modelEffortLevels()?.includes('off') ? 'Off' : '默认'
    const level = EFFORT_LEVELS.find(e => e.id === eff)
    return level ? level.name : String(eff)
  }
  // 当前模型的官方思考等级清单（2026-09-18：凭据池 effortLevels 声明经 /gateway/models 下发；
  // 未声明返回 null → 回退固定 Off+Low/High/Max）。渲染与选择一律以此为准，不写死档位。
  const EFFORT_LABELS = { off: 'Off', low: 'Low', medium: 'Medium', high: 'High', max: 'Max', ultra: 'Ultra' }
  function modelEffortLevels() {
    const id = MODEL_CUR.model
    if (!id || !MODELS || !Array.isArray(MODELS.items)) return null
    const it = MODELS.items.find(x => x && x.v === id)
    return it && Array.isArray(it.effortLevels) && it.effortLevels.length ? it.effortLevels.map(String) : null
  }
  function renderModelSeat() {
    // 显示源 = currentChoice()（MODEL_CUR.model，用户切换后即时更新），不用 MODELS.model 缓存——
    // 否则切换后仍显示初次加载的旧模型（用户反馈「输入栏没同步最新模型」）。
    const c = currentChoice()
    const name = c ? c.model.name : '选择模型'
    const eff = MODEL_CUR.effortLevel != null ? effLabel() : ''
    // dsh ModelSelect trigger：.triggerLabel=模型名 + .triggerEffort=推理等级（无则隐藏）+ 静态 .chevron（随 open 翻转）
    const label = modelSeatEl.querySelector('.triggerLabel')
    const effort = modelSeatEl.querySelector('.triggerEffort')
    if (label) label.textContent = name
    if (effort) { if (eff) { effort.textContent = eff; effort.hidden = false } else effort.hidden = true }
    modelSeatEl.title = eff ? `${name} · ${eff}` : name
    modelSeatEl.dataset.real = c ? '1' : ''
    // 真实配置尚未拉取且未过 token 门 → 懒加载一次（成功后重渲触发座，静默失败保留占位）。
    // 2026-08-25 加 !MODELS_ERR 门：loadModelsData 的 finally 现在会回调 renderModelSeat，
    // 若不加失败门，加载失败后（MODELS 仍 null、loading 已复位）此处会立即再触发 → 无限重试循环。
    // 失败后不再自动重试，改由 hideGate 显式 loadModelsData(true) / mgr 视图重试钮驱动。
    if (!c && !needToken() && !MODELS_LOADING && !MODELS && !MODELS_ERR) {
      loadModelsData(false).then(() => renderModelSeat()).catch(() => {})
    }
  }
  // ---- 每会话思考等级（2026-11-06，C）----
  // 档位归属 = 会话，不归属 web 全局：显示源只有两个——① 该会话后端上报值（/gateway/session.effort，
  // CLI 落地后经 /gateway/model-report 回报）；② 无上报时回落 /gateway/models 的全局默认 effortLevel。
  // 切会话绝不再沿用上一会话的档位（旧实现只有一个 MODEL_CUR.effortLevel 槽 + localStorage，
  // 切会话座显示停在上一会话，且改档广播给全部会话）。
  let reportedEffort // 该会话最近一次上报档位：undefined=未上报，null=明确 Off，其它=档位名
  function globalEffortLevel() {
    return MODELS && MODELS.effortLevel != null ? String(MODELS.effortLevel) : undefined
  }
  // 按 reportedEffort + 全局默认重算 seat 档位（MODELS 晚到 / 切会话后各调一次）
  function syncEffortSeat() {
    const v = reportedEffort === undefined ? globalEffortLevel() : reportedEffort == null ? undefined : String(reportedEffort)
    if (MODEL_CUR.effortLevel === v) return
    setModelCur({ ...MODEL_CUR, effortLevel: v })
    renderModelSeat()
  }
  // 会话载入点（renderSession 首载 / 刷新回程 / 首页复位）传入后端上报值；undefined = 该会话无上报。
  // 无参调用 = 数据源（MODELS 全局默认）晚到，按最近上报值重算一次，不改变归属。
  function applySessionEffort(effort) {
    if (arguments.length) reportedEffort = effort === undefined ? undefined : effort == null ? null : String(effort)
    syncEffortSeat()
  }
  // 回首页（无会话）且无待定新会话选择 → seat 显示源回落凭据池全局默认（web 不再改全局默认）
  function syncSeatToGlobalDefault() {
    // 回首页 = 离开会话：档位回到全局默认（会话档位不跨会话残留在座上）
    reportedEffort = undefined
    syncEffortSeat()
    if (state.currentHash || newSessionModel) return
    const g = MODELS && (MODELS.activeModel || (MODELS.model ? String(MODELS.model) : ''))
    if (!g) return
    const prov = MODELS.activeProvider || MODEL_CUR.provider
    if (MODEL_CUR.model === g && MODEL_CUR.provider === prov) return
    setModelCur({ ...MODEL_CUR, model: g, provider: prov })
    saveModelCur()
    renderModelSeat()
  }
  function toggleModelPop() {
    if (msel.open) { closeModelPop(); return }
    if (cmd.open) closeCmdPop()
    closeMentionPop()
    msel.open = true
    msel.pane = 'root'
    msel.active = 0
    renderModelPop()
    if (!isTouch()) composerFocus() // 焦点留输入栏：方向键/ESC 走 keydown；触屏跳过防 iOS 弹键盘
  }
  function closeModelPop() {
    if (!msel.open) return
    msel.open = false
    modelPop.hidden = true
    modelSeatEl.querySelector('.chevron')?.classList.remove('open')
  }
  function modelEscape() {
    if (msel.pane !== 'root') { msel.pane = 'root'; msel.active = 0; renderModelPop() } else closeModelPop()
  }
  // 当前面板的可导航行（root=两 cell；model=凭据池模型按 provider 序；effort=Off + Low/High/Max）
  function mselRows() {
    if (msel.pane === 'model') {
      const rows = []
      for (const id of modelDir()) rows.push({ kind: 'model', id })
      return rows
    }
    if (msel.pane === 'effort') {
      // 官方档位动态渲染（2026-09-18）：有 effortLevels 声明=按声明逐档渲染（off→undefined 语义）；
      // 未声明=回退固定 Off + Low/High/Max。
      const levels = modelEffortLevels()
      if (levels) {
        return levels.map(id => ({ kind: 'effort', effort: id === 'off' ? undefined : id, label: EFFORT_LABELS[id] || id }))
      }
      const rows = [{ kind: 'effort', effort: undefined, label: 'Off' }]
      for (const e of EFFORT_LEVELS) rows.push({ kind: 'effort', effort: e.id, label: e.name })
      return rows
    }
    return [{ kind: 'cell', cell: 'model' }, { kind: 'cell', cell: 'effort' }]
  }
  function mselMove(d) {
    const n = mselRows().length
    if (!n) return
    msel.active = (msel.active + d + n) % n
    renderModelPop()
  }
  function renderModelPop() {
    if (!msel.open) return
    let html = ''
    if (msel.pane === 'root') {
      // dsh root 面板：Model / Effort 两行 cell（label + value + 右 chevron），无返回按钮（dsh 用 Escape 退级）
      const c = currentChoice()
      const mname = c ? c.model.name : '—'
      const ename = effLabel() || '—'
      html += `<button type="button" class="cell"><span class="cellLabel">模型</span><span class="cellValue">${esc(mname)}</span><span class="cellChevron">${I.dshChevRight}</span></button>`
      html += `<button type="button" class="cell"><span class="cellLabel">推理等级</span><span class="cellValue">${esc(ename)}</span><span class="cellChevron">${I.dshChevRight}</span></button>`
    } else if (msel.pane === 'model') {
      // dsh model 面板：.groups > .group[.groupTitle + .option×]，check 尾勾；分组按凭据池供应商（与 MGR 模型 tab 同判据）
      const ids = modelDir()
      if (!ids.length) {
        html += `<div class="empty">暂无模型</div>`
      } else {
        html += `<div class="groups">`
        const groups = []
        for (const id of ids) {
          // 2026-08-29 全池可选：优先用网关下发的真实归属供应商标签（items[].provider），缺失再走启发式前缀判定
          const it = ((MODELS && MODELS.items) || []).find(x => x && x.v === id)
          const p = (it && it.provider) || modelProviderOf(it || { k: id, v: id })
          let g = groups.find((x) => x.provider === p)
          if (!g) { g = { provider: p, items: [] }; groups.push(g) }
          g.items.push(id)
        }
        let idx = 0
        const curId = currentChoice()?.model.id
        for (const g of groups) {
          html += `<div class="group"><div class="groupTitle">${esc(g.provider)}</div>`
          for (const id of g.items) {
            const on = idx === msel.active ? ' on' : ''
            const selected = id === curId
            html += `<button type="button" class="option${on}" data-idx="${idx}" role="menuitemradio" aria-checked="${selected}"><span class="optionCopy"><span class="modelName">${esc(id)}</span></span><span class="check">${selected ? I.dshCheck : ''}</span></button>`
            idx++
          }
          html += `</div>`
        }
        html += `</div>`
      }
    } else if (msel.pane === 'effort') {
      // dsh effort 面板：扁平 option 列表（Off + Low/High/Max，无 groups 包裹）
      let idx = 0
      const curEff = MODEL_CUR.effortLevel
      for (const r of mselRows()) {
        const on = idx === msel.active ? ' on' : ''
        // Off 项只在「未显式选择等级」时勾选；具体等级按当前显式值匹配
        const selected = r.effort === undefined ? curEff === undefined : curEff === r.effort
        html += `<button type="button" class="option${on}" data-idx="${idx}" role="menuitemradio" aria-checked="${selected}"><span class="optionCopy"><span class="modelName">${esc(r.label)}</span></span><span class="check">${selected ? I.dshCheck : ''}</span></button>`
        idx++
      }
    }
    modelPop.innerHTML = html
    modelPop.hidden = false
    modelSeatEl.querySelector('.chevron')?.classList.add('open')
    // cell/option 点击不再需要 stopPropagation：外部关闭已改 mousedown+contains（mousedown 在重渲染前命中目标，
    // innerHTML 摘除节点不再误判「点外关闭」，dsh ModelSelect 同语义）
    modelPop.querySelectorAll('.cell').forEach((b, i) => b.addEventListener('click', () => { msel.pane = i === 0 ? 'model' : 'effort'; msel.active = 0; renderModelPop() }))
    modelPop.querySelectorAll('.option').forEach(b => b.addEventListener('click', () => { msel.active = +b.dataset.idx; mselChoose() }))
    const on = modelPop.querySelector('.option.on')
    if (on) on.scrollIntoView({ block: 'nearest' })
  }
  // 2026-10-05 apiSetModel 迁 engine/gateway.js（网关客户端唯一持有 needToken/apiUrl；卡片去 inputbar 依赖）。
  function mselChoose() {
    const row = mselRows()[msel.active]
    if (!row) return
    if (msel.pane === 'model') {
      const id = row.id
      if (MODEL_CUR.model === id) { closeModelPop(); return }
      const it = ((MODELS && MODELS.items) || []).find(x => x && (x.v === id || x.k === id))
      // 2026-08-29 直接切模型自动切供应商：MODEL_CUR.provider 同步真实归属（网关侧按会话绑定供应商）
      const prevEff = MODEL_CUR.effortLevel
      MODEL_CUR = { ...MODEL_CUR, model: id, provider: (it && it.provider) || MODEL_CUR.provider }
      // 切模型校验档位（2026-10-14 待办#7 补缺）：新模型有官方档位声明且当前档不在其中（例：从
      // DeepSeek 切 GLM 时残留 off，GLM 声明无 off）→ 清回「默认」，避免座显/菜单展示无效档；
      // 有会话时随切换下发改档（'off' 语义 = 网关 delete settings.effortLevel），与 effort 面板同链。
      const lv = modelEffortLevels()
      if (lv && prevEff != null && !lv.includes(prevEff)) {
        MODEL_CUR.effortLevel = undefined
        reportedEffort = undefined
        // 与 effort 面板同链同形：'off' = 网关清档；会话内必须带 sessionId（C：只清本会话，
        // 不得写全局 settings.json / 影响其它会话）
        void apiSetModel({ effortLevel: 'off', ...(state.currentHash ? { sessionId: state.currentHash } : {}) })
      }
      modelUserPicked = true // 2026-08-24：本次会话内主动切换，防止 /gateway/session 旧上报回滚
      modelPickedHash = state.currentHash || '' // 2026-11-06：防回滚只对「切换发生时所在会话」生效
      saveModelCur() // 2026-08-24：持久化，刷新后恢复
      renderModelSeat()
      closeModelPop()
      // 2026-09-10 会话级供应商绑定：有会话 → 会话级覆盖（网关随路由下发该模型归属供应商，
      // 目标 CLI 进程内绑定 baseUrl/key，只影响本会话）。
      // 2026-10-11 定案：首页（/新会话）不再写全局默认池（未传 defaultModel 即不下发 POST）——
      // 全局默认只由凭据池 credentials.json 决定（agent 直接改文件）；首页选中的模型记入
      // newSessionModel 待定槽，发送首条消息时随新会话做会话级切换（send.js），只影响那一次新建的会话。
      const home = !state.currentHash
      if (home) {
        setNewSessionModel(id)
        toast(`新会话将使用 ${id}（仅本次）`)
        return
      }
      void apiSetModel({ model: id, sessionId: state.currentHash })
        .then(ok => toast(ok ? `模型已切换为 ${id}` : '切换失败 · 目标会话未在线或网关未连接'))
    } else if (msel.pane === 'effort') {
      const eff = row.effort === undefined ? undefined : row.effort
      if (MODEL_CUR.effortLevel === eff) { closeModelPop(); return }
      MODEL_CUR = { ...MODEL_CUR, effortLevel: eff }
      saveModelCur() // 2026-08-24：持久化推理等级（仅作首页/刷新前的暂存；会话内真源 = 网关上报）
      renderModelSeat()
      closeModelPop()
      // 2026-11-06 每会话思考等级（C）：会话内带 sessionId → 网关只精确路由到本会话（不广播、
      // 不写全局 settings.json）；首页（无会话）= 全局默认，写盘供新会话继承，不影响已开会话。
      // Off（清除等级）发 'off'，网关据此让 CLI effortValue=undefined。
      const hash = state.currentHash
      // 会话内不再把「后端未上报」当成覆盖值：本地的主动选择即本会话当前档位，回载前以此为准
      reportedEffort = eff === undefined ? null : eff
      const payload = eff === undefined
        ? { effortLevel: 'off', ...(hash ? { sessionId: hash } : {}) }
        : { effortLevel: eff, ...(hash ? { sessionId: hash } : {}) }
      void apiSetModel(payload).then(ok => toast(ok ? `推理等级已切换为 ${row.label}` : (hash ? '切换失败 · 目标会话未在线' : '切换失败 · 网关未连接')))
    }
  }
  renderModelSeat() // 初始渲染模型 seat（trigger 显示当前模型名 · 推理等级）

function setModelCur(v) { MODEL_CUR = v }
function setModelUserPicked(v) { modelUserPicked = v }
  // 弹窗的**唯一开链**（2026-10-25 用户定案：输入 @ 触发与底栏点 + 完全同一条链路，不另写）。
  // mentionMode 只决定查询词来源（@ 后文本 vs 底栏全文）；有无查询词由 cmdEntries 判：
  // 无词 = 首屏入口（与 + 一致），有词且在 @ 模式 = 扁平全局搜索。
  function openCmdPop(mentionMode) {
    const fresh = !cmd.open
    if (msel.open) closeModelPop()
    if (!mentionMode) closeMentionPop()
    cmd.open = true
    cmd.mentionMode = !!mentionMode
    cmd.view = '' // 每次打开都回首屏入口（手势起点一致）
    cmd.status = 'ready'
    cmd.active = 0
    cmd.confirming = null
    cmd.acknowledged = false
    cmd.error = null
    renderCmdPop()
    // 2026-11-06 D 弹层互斥：工具栏打开即收起任务浮窗（renderTaskDock 见工具栏在场整窗让位；
    // 此时 cmdPop.hidden 已被上方 renderCmdPop 置 false，判据生效）。关闭回程由 closeCmdPop 恢复。
    renderTaskDock()
    // 过滤在底栏打字（待办 20 返修）：焦点回底栏，用户继续输入列表即变；触屏不抢焦点（iOS 弹键盘，
    // 与旧搜索框同一处置——用户自己点输入框唤起）。@ 唤起时光标本就在底栏，不重复聚焦。
    if (!mentionMode && !isTouch()) composerFocus()
    if (fresh) {
      // 首次打开确保技能清单/目录层已加载（异步），加载完用当前状态重渲
      loadMgrData().then(() => { if (cmd.open) renderCmdPop() }).catch(() => {})
      // 当前项目自己的技能（按 label 缓存，同一项目只拉一次）：落地后重渲技能组。
      ensureProjectSkills(pickHome()).then(() => { if (cmd.open) renderCmdPop() }).catch(() => {})
      refreshPick(() => { if (cmd.open && pickProgressRenders()) renderCmdPop() })
    }
  }
  function openCmdPopMention() { openCmdPop(true) }
  function toggleCmdPop() {
    if (cmd.open) { closeCmdPop(); return }
    openCmdPop(false)
  }
  function closeCmdPop() {
    if (!cmd.open) { cmd.mentionMode = false; return }
    cmd.open = false
    cmd.mentionMode = false
    cmd.confirming = null
    cmd.acknowledged = false
    cmdPop.hidden = true
    // 2026-11-06 D：工具栏收起 → 任务浮窗重新按本会话清单渲染（互斥解除，恢复收敛/展开态）
    renderTaskDock()
    // @ 锚点/查询词随弹窗一起复位（resetMention 只碰数据，不回调本函数，无环）
    resetMention()
    const rm = $('risk-modal')
    if (!rm.hidden) closeRiskModal()
  }
  function renderCmdPop() {
    if (!cmd.open) return
    // dsh confirmation gate：确认态下命令卡隐藏，改由全屏 RiskConfirmation 模态接管
    if (cmd.confirming) { cmdPop.hidden = true; renderRiskModal(); return }
    // 单页分组渲染（无 tab）：四组行列表；已选附件缩略图不在本浮窗重复显示（见下）。
    // 独立搜索框已退役（2026-10-14 待办 20 返修）：过滤文本 = 底栏输入框，列表随底栏
    // 打字自动变化（ctx-meter 在底栏 input 事件里调 renderCmdPop）。
    cmd.items = cmdEntries()
    // 视图切换/查询变化后条目数会变：高亮下标夹回合法区间，否则回车会选中 undefined。
    cmd.active = Math.min(cmd.active, Math.max(0, cmd.items.length - 1))
    // 滚动位置跨重渲保持（2026-11-05 根因）：列表在文件索引流式进度/数据落地时会整体重渲，
    // 旧实现每次 innerHTML 重建 .viewport（scrollTop 归零）+ 无条件 scrollIntoView 高亮行（多为第 0 行）
    // ⇒ 用户拖条/滚轮后立刻被打回顶部，表现为「根本划不动」。现在搬运旧滚动量，
    // 且只有**高亮行真的变了**（键盘/点击导航）才把它滚进视野。
    const prevVp = cmdPop.querySelector('.viewport')
    const keepTop = prevVp ? prevVp.scrollTop : 0
    const prevActive = cmd.prevActive
    let html = ''
    if (cmd.error !== null) {
      html += `<div class="error" role="alert"><span class="errorText">${esc(cmd.error)}</span>${cmd.status === 'failed' ? `<button type="button" class="retry">重试</button>` : ''}</div>`
    } else {
      // 待发附件的唯一可见回显 = 底栏 `#img-pills`（inputbar/images.js renderImgPills）；
      // 本浮窗只做选择/上传入口，不再重复渲染缩略图（2026-10-22 用户实测：同一批图在浮窗与底栏各出现一次）。
      // 搜索结果（@ 后有查询词）= 扁平时间线，不印分组标题（用户定案「不隔离」）；@ 无词/+ 模式 = 入口视图分组。
      // 未进视图的跨类搜索才是扁平时间线；进了某类视图仍按组显示（导航行与该类标题）。
      const flat = cmd.mentionMode && !cmd.view && !!mention.q.trim()
      let lastGrp = ''
      html += `<div role="listbox" class="viewport">${cmd.items.map((it, i) => {
        const g = it.grp || groupOf(it)
        const grp = g === '文件' ? '文件 · ' + pickLabel() : g
        // 「返回」行不单立分组标题（2026-11-06 D）：视图内此前先印「导航」再印该类标题，
        // 两条上箭头/分组叠在顶部像重复了一栏；返回行随该视图的标题下呈现即可。
        const gh = flat || it.kind === 'back' || grp === lastGrp ? '' : `<div class="grp">${esc(grp)}</div>`
        if (it.kind !== 'back') lastGrp = grp
        const on = i === cmd.active ? ' rowActive' : ''
        const ico = it.kind === 'entry' ? it.icon : it.kind === 'back' ? MENTION_UP_ICON : it.kind === 'attref' ? (it.attKind === 'img' ? I.dshImage : I.dshPaperclip) : it.kind === 'imgpick' ? I.dshImage : it.kind === 'filepick' ? I.dshPaperclip : it.kind === 'plugin' ? MENTION_PLUGIN_ICON : it.kind === 'skill' ? MENTION_SKILL_ICON : it.kind === 'session' ? MENTION_SESSION_ICON : it.kind === 'pathup' ? MENTION_UP_ICON : it.kind === 'path' ? mentionChipIcon('path', it.ptype) : it.kind === 'pathwait' ? mentionChipIcon('path', 'file') : (CMD_ICON[it.name] || I.dshPlus)
        const label = it.kind === 'cmd' ? `/${it.name}` : it.name
        const detail = it.kind === 'path' ? it.path : it.desc
        const tag = it.proj ? `<span class="projTag">${esc(projTag(it.proj))}</span>` : ''
        return gh + `<button type="button" role="option" aria-selected="${i === cmd.active}" class="row${on}" data-idx="${i}"><span class="rowIco">${ico}</span><span class="label">${esc(label)}</span>${detail ? `<span class="detail">${esc(detail)}</span>` : ''}${tag}</button>`
      }).join('')}</div>`
    }
    cmdPop.innerHTML = html
    cmdPop.hidden = false
    cmdPop.querySelectorAll('.row').forEach(b => b.addEventListener('click', () => { cmd.active = +b.dataset.idx; cmdSelect() }))
    cmdPop.querySelector('.retry')?.addEventListener('click', () => { cmd.error = null; cmd.status = 'ready'; renderCmdPop() })
    const vp = cmdPop.querySelector('.viewport')
    if (vp) vp.scrollTop = keepTop
    if (cmd.active !== prevActive) {
      const on = cmdPop.querySelector('.row.rowActive')
      if (on) on.scrollIntoView({ block: 'nearest' })
    }
    cmd.prevActive = cmd.active
  }
  // 风险确认门（dsh RiskConfirmation + Modal 移植）：全屏遮罩 + 居中对话框，checkbox 勾选后才可确认
  function renderRiskModal() {
    const o = cmd.confirming
    if (!o) { const m = $('risk-modal'); if (!m.hidden) m.hidden = true; return }
    const rm = $('risk-modal')
    rm.innerHTML = `
      <div class="mask"></div>
      <div class="dialog" role="dialog" aria-modal="true" aria-label="执行 /${esc(o.name)}？">
        <div class="header">
          <h2 class="title">执行 /${esc(o.name)}？</h2>
          <button type="button" class="close" aria-label="关闭">${I.dshClose}</button>
        </div>
        <div class="body">
          <div class="warning">${I.dshWarn}<p>${esc(o.risk)}</p></div>
          <label class="acknowledgement"><input type="checkbox" ${cmd.acknowledged ? 'checked' : ''}/><span>我已了解该操作的风险</span></label>
        </div>
        <div class="footer">
          <button type="button" class="button outline">取消</button>
          <button type="button" class="button primary" ${cmd.acknowledged ? '' : 'disabled'}>确认执行</button>
        </div>
      </div>`
    rm.hidden = false
    const cb = rm.querySelector('.acknowledgement input')
    if (cb) cb.addEventListener('change', () => { cmdAck(cb.checked) })
    // 无需 stopPropagation：外部关闭已改 mousedown+contains（mousedown 在重渲染前命中目标），不再误判（dsh Modal 同语义）
    rm.querySelector('.mask')?.addEventListener('click', () => closeRiskModal())
    rm.querySelector('.close')?.addEventListener('click', () => closeRiskModal())
    rm.querySelector('.outline')?.addEventListener('click', () => closeRiskModal())
    rm.querySelector('.primary')?.addEventListener('click', () => cmdConfirm())
  }
  // 取消确认：清除确认态、恢复命令列表（dsh cancelConfirmation：确认卡关闭、列表重显）
  function closeRiskModal() {
    const rm = $('risk-modal')
    rm.hidden = true
    rm.innerHTML = ''
    cmd.confirming = null
    cmd.acknowledged = false
    renderCmdPop()
  }
  function cmdMove(d) {
    const n = cmd.items.length
    if (!n) return
    cmd.active = (cmd.active + d + n) % n
    renderCmdPop()
  }
  // 统一选择分发（2026-09-09 二轮）：图片行=选图（选完 img-file change 关浮窗）；技能/会话=chip 追加输入栏；
  // 命令=原链（risk→确认门 / settle→写入输入栏）
  function cmdSelect() {
    const it = cmd.items[cmd.active]
    if (!it || cmd.submitting) return
    // 入口视图导航（两个模式共用，必须先于 @ 落地判：否则 @ 里点「文件」会被当成插入 [插件:文件] 胶囊）：
    // 入口行 = 进入该类（此后查询词只在该类里搜）；返回行 = 回首屏。
    if (it.kind === 'entry') { cmd.view = it.view; cmd.active = 0; renderCmdPop(); return }
    if (it.kind === 'back') { cmd.view = ''; cmd.active = 0; renderCmdPop(); return }
    // @ 模式：所有条目都落地到 @ 锚点（含上传附件写回正文、目录下钻重渲）——统一走 mention.js，
    // 与 + 模式的「追加到输入栏末尾」刻意不同（@ 是就地替换查询）。
    if (cmd.mentionMode) { if (it.kind !== 'pathwait') selectMentionItem(it); return }
    if (it.kind === 'imgpick') { $('img-file').click(); return }
    if (it.kind === 'filepick') { $('file-upload').click(); return }
    // 已上传附件引用行（+ 模式）：引用原文追加到输入栏末尾（@ 模式走上方的 selectMentionItem 就地替换）。
    if (it.kind === 'attref') { composerAppendText(it.md + ' '); closeCmdPop(); return }
    if (it.kind === 'pathwait') return // 占位行不可选（清单未就绪）
    // 下钻/返回必须走 pickEnter：它同时把 searchOff 翻回层内浏览模式；只调 loadPickPath 会让
    // pickItems 继续按全局搜索分支渲染，点目录看起来「没反应」。
    if (it.kind === 'pathup' || (it.kind === 'path' && it.ptype === 'dir')) {
      pickEnter(it).then(() => { if (cmd.open) renderCmdPop() })
      return
    }
    if (it.kind === 'path') { appendMentionChip('path', it.path, '', 'file'); closeCmdPop(); return }
    if (it.kind === 'skill' || it.kind === 'plugin') { appendMentionChip('plugin', it.name); closeCmdPop(); return }
    if (it.kind === 'session') { appendMentionChip('session', it.name, it.sid); closeCmdPop(); return }
    const o = it.ref
    if (o.risk) { cmd.confirming = o; cmd.acknowledged = false; renderCmdPop(); return }
    cmdSettle(o)
  }
  // 浮窗直选落地（无 @ 光标锚点）：令牌追加到输入栏末尾 + 尾随空格，光标到末尾（CM6 接管后
  // chip = doc 令牌文本的装饰视图，composerAppendToken 落 doc 即成 chip）。
  function appendMentionChip(kind, name, sid, ptype) {
    const token = kind === 'session'
      ? (sid ? `[会话:${name}|${sid}]` : `[会话:${name}]`)
      : kind === 'path'
        ? mentionPathToken(name, ptype)
        : `[插件:${name}]`
    composerAppendToken(token)
    syncGwSend()
  }
  function cmdAck(v) { cmd.acknowledged = v; renderCmdPop() }
  function cmdConfirm() {
    if (!cmd.confirming || !cmd.acknowledged) return
    const o = cmd.confirming
    cmd.confirming = null
    cmd.acknowledged = false
    cmdSettle(o)
  }
  // 选择落地：把命令文本写入输入栏（claim 带参数提示 / bare 直接插入），回车发送由 CLI 端执行；本地展示同闭环
  function cmdSettle(o) {
    setInputText(o.claim ? `/${o.name} ` : `/${o.name}`)
    closeCmdPop()
    composerFocus()
    toast(`命令已写入输入栏：/${o.name}（回车发送）`)
  }
  // CM6 接管后 = doc 全文替换（composerSetText 内含 readOnly 阀 + 触发 updateListener → syncGwSend）
  function setInputText(text) {
    composerSetText(text)
    syncGwSend()
  }

  // ---- 模型选择（dsh ModelSelect 移植：trigger 显示「模型名 · 推理等级」，root 两行 Model/Effort 各自 drill）----
  // 当前选中模型 id：本地 MODEL_CUR 优先，未同步时回落 MODELS 的 activeModel/model（凭据池同源）
  function setConn(on, label) {
    setConnUp(!!on) // 2026-09-07 运行态计时行「连接中断」标注的数据源
    const b = $('floria-conn')
    if (!b) return
    // 浅灰小字紧跟 Floria 品牌名后；on/off 仅控制文案（已连接/未连接/连接中…），颜色统一浅灰
    b.textContent = label || (on ? '已连接' : '未连接')
  }

  function scrollBottom() {
    // 占位在场（回合展示期）→ 两层跟随接管（让位/手势中由 stageFollow 自判）；否则普通吸底
    if (stage.active) { stageFollow(); return }
    const sc = messagesEl.closest('#chat-scroll')
    progScroll()
    sc.style.scrollBehavior = 'auto'
    sc.scrollTop = sc.scrollHeight
    sc.style.scrollBehavior = ''
  }

  // ---- 两层消息流（2026-09-08 定案）：层1=真实消息流，层2=静态占位块 .pin-stage ----
  // 占位块由回合开启消息唤出（web 乐观气泡 / CLI 端权威新 user 消息），挂 #messages 流末
  // （后续内容插它前面）。高度（2026-09-09 用户定案「过于大」根修）= max(0, 视口高 −
  // paddingBottom − 内容脚印)：脚印 footprint=内容底−气泡贴顶位，占位只补足「贴顶视角下
  // 内容底到可视区底的余量」——可视区=clientHeight 扣常驻 padding-bottom 142px（docked
  // 输入栏悬浮预留，不扣则占位铺到输入栏底下多一条）；新回合脚印只含开启气泡（气泡钉在
  // 历史末尾），占位≈满屏减一气泡属几何必然。公式恰好保证贴顶位可达，空白永不越出可视区。
  // **脚印实时读取（2026-09-10 用户实测「乐观气泡被滑到屏幕外」根修）**：原「诞生快照
  // 锁定（lockFoot），绝不随内容变化」使诞生后任何内容增长（图片异步撑高 / 折叠体变高 /
  // 回复正文变长）都 1:1 变成额外可滚动余量（maxScroll = padTop + 贴顶位 + 增长量）——
  // 内容尚未超一屏时滚到底即可把开启气泡推出视口顶。改实时后不变量：内容未超一屏时
  // scrollHeight ≡ 一屏、maxScroll ≡ 贴顶位（滚动极限=气泡贴顶），内容增长/收起都不改变
  // 滚动范围（收起不骤减的旧目标同样成立——占位实时变大对冲，scrollHeight 恒定）；超过
  // 一屏占位归零、自然转内容底跟随。resize 换视口高随实时读数自动重算。
  // 占位块恒定在场（回合结束不自动撤；内容变化只改高度不改去留）；**用户滚动输入永不摘占位**
  // （2026-09-09 用户定案「为什么还会有释放链这种东西」——滚轮/触摸/拖滚动条一律只让位跟随），
  // 拆收仅发生在离开会话视图（切会话/回首页/管理视图/项目预览，stageRelease 的全部调用点）。
  // 跟随吸底目标=真实内容底（占位起点贴视口底）：内容未满一屏时视口停在开启气泡贴顶位、
  // 内容在下方生长；超过一屏后平滑转入内容底跟随、气泡自然上滑出视口顶——无 sticky 驻留
  // （旧 pin 体系 pinReserveApply/临时让位/settleCheck 轮询/劈开补丁全链退役）。
  // 占位高度实时对冲内容增减 → 未超一屏时 scrollHeight 恒定，任何内容收起（折叠收起等）都
  // 不会令 scrollTop 越出 maxScroll → 历史收起闪动/clamp 补丁不再需要。
  // key=回合开启消息标识（'optimistic'=乐观气泡在场 | 'idx:ts'=权威 user）；
  // bubble=贴顶驻留参照气泡。
  // touchHold=触摸手势持有中（含惯性）：手势进行中程序滚动/删除占位 = scrollHeight 骤减 =
  // WebKit 触摸滚动基准断裂（2026-09-08 用户实测「iPad 滑动就死」）→ 持有期冻结程序跟随。
  // yielded=用户滚动输入（滚轮/触摸/滚动条/键盘）后跟随永久让位（用户已接管视口；stageStart 复位）。
  const stage = { active: false, key: null, el: null, bubble: null, touchHold: false, releaseT: null, yielded: false }
  // 程序滚动窗口：此时刻前的 scroll 事件不算用户操作（跟随/动画自身写入 scrollTop 会触发 scroll）
  let progScrollUntil = 0
  function progScroll() { progScrollUntil = Date.now() + 80 }

  // 元素顶边在滚动内容坐标系中的 y（贴视口顶对应的 scrollTop）。旧体系 msg-pin 是 sticky，
  // 吸附时 offsetTop 变吸附位须用兄弟几何推算；新体系无 sticky，offsetTop 恒自然流位可直接用。
  function topInScroll(el) {
    const sc = $('chat-scroll')
    const padTop = parseFloat(getComputedStyle(sc).paddingTop) || 0
    return Math.max(0, el.offsetTop - sc.offsetTop - padTop)
  }

  // ---------- chat 卡片公开 API（2026-10-21）----------
  // 消息流对宿主/其它卡只暴露标准动词：scroll{line} = 滚到第 line 条消息（1-based `.msg` 文档序，
  // 与引用令牌「第 N 条回复」同源）；locate/state 只读。引用胶囊点击一律经 cardBus.callCard 驱动
  // （chat/messages/msg-actions.js 的委托），不直取本模块内部滚动状态——跨卡只走公开信道。
  function scrollToMsgLine(n) {
    const list = [...messagesEl.querySelectorAll('.msg')]
    const i = Math.floor(Number(n) || 0) - 1
    const el = list[i]
    if (!el) throw new Error(`没有第 ${n} 条消息（共 ${list.length} 条）`)
    stage.yielded = true // 用户主动跳转 = 接管视口：进行中的回合跟随让位（同 turn-rail 导航语义）
    progScroll()
    $('chat-scroll').scrollTo({ top: topInScroll(el), behavior: 'smooth' })
    return { line: i + 1, total: list.length }
  }
  cardBus.registerInlineCard({
    instanceId: 'floria-chat',
    ns: 'floria-chat',
    cmds: ['scroll', 'locate', 'state'],
    handlers: {
      scroll: (a) => scrollToMsgLine(a && a.line),
      locate: () => ({ messages: messagesEl.querySelectorAll('.msg').length }),
      state: () => ({ mode: state.sbMode || 'chat', messages: messagesEl.querySelectorAll('.msg').length }),
    },
  })

  // 拆收：撤占位块+清状态。仅视图级退出触发（切会话 renderSession/回首页 renderHome/
  // 管理视图 renderMgr/项目预览 openProjectPreview）——用户滚动输入不进入此函数（2026-09-09
  // 释放链铲除定案，滚动输入只让位）。remove 瞬间 scrollHeight 骤减一屏，浏览器 clamp 把
  // scrollTop 拉回合法值——视口在内容区则纹丝不动，内容连续零跳动（无需手动补偿）。
  function stageRelease() {
    if (stage.releaseT) { clearTimeout(stage.releaseT); stage.releaseT = null }
    stage.touchHold = false
    stage.yielded = false
    if (stage.el) stage.el.remove()
    stage.el = null
    stage.active = false
    stage.key = null
    stage.bubble = null
  }

  // pinned 跟随：scrollTop = max(开启气泡贴顶位, 内容底位)。
  // 内容未满一屏时贴顶位更大 → 视口停在气泡贴顶处、折叠体/回复在下方生长（占位垫底）；
  // 内容超过一屏后内容底位反超 → 平滑转入内容底跟随（最新内容贴视口底），气泡自然上滑出视口顶。
  // 两视角在贴顶位处无缝衔接，无需 sticky（占位高度随内容实时对冲，贴顶位即滚动极限）。
  // bubble 失联（换皮窗口）时退化为纯内容底。
  // 无动画窗：跟随是几何的纯函数，谁写 scrollTop 都落在同一落点（幂等），无需互斥。
  function stageFollow() {
    // touchHold：手势中程序滚动=基准断裂；yielded：用户滚动输入后已接管视口，跟随永久让位
    if (!stage.active || stage.touchHold || stage.yielded) return
    const sc = $('chat-scroll')
    const stageEl = stage.el
    if (!stageEl || !stageEl.isConnected) return
    const padBot = parseFloat(getComputedStyle(sc).paddingBottom) || 0
    const contentBottom = Math.max(0, topInScroll(stageEl) - sc.clientHeight + padBot)
    const t0 = stage.bubble && stage.bubble.isConnected ? topInScroll(stage.bubble) : 0
    const max = sc.scrollHeight - sc.clientHeight
    progScroll()
    sc.style.scrollBehavior = 'auto'
    sc.scrollTop = Math.min(Math.max(t0, contentBottom), Math.max(0, max))
    sc.style.scrollBehavior = ''
  }

  // 唤出（回合开启）：占位块挂/复用（stageSync）+ 按跟随几何同帧就位（stageFollow）。
  // 2026-09-11「发送新消息界面短暂跳到上一条消息」根治——09-09「占位初始高=乐观气泡同高，
  // rAF 750ms 拉伸到目标高」的动画窗铲除：初值取气泡高 = 占位先缩后长，scrollHeight 在同一
  // 事务内先塌，浏览器按缩后的 max 钳 scrollTop（首帧就画在内容底 = 上一回合尾部），再由
  // rAF 逐帧抬到贴顶位——用户看到的就是「跳到上一条消息」再滑回。占位高度是几何的纯函数
  // （参照气泡定了，终态就定了），没有中间态可言：写终态 + 同帧归位，浏览器只绘一帧、那一帧
  // 即终态。不变量：占位块至多一个（#messages 流末）、占位高度唯一写入者=stageSync。
  function stageStart(bubbleEl, key) {
    stage.active = true
    stage.key = key
    stage.bubble = bubbleEl
    if (stage.releaseT) { clearTimeout(stage.releaseT); stage.releaseT = null }
    stage.touchHold = false
    stage.yielded = false
    // 脚印无需重置：实时读取（stageSync 每趟按当前几何量），换参照气泡即自动跟随新几何
    stageSync()
  }

  // 回合权威锚解析（2026-09-11「发送后短暂跳到上一条消息」二轮根修）：注入开段回合
  // （injected user → user:null 切段，messagesHtml 切段定案）在 DOM 无 data-t="u" 开启气泡
  // ——注入气泡以 data-t="g…" 织在段折叠体 done-body 内（data-g=自身消息索引）。因此凡以
  // 「末条 data-t="u"」为参照的回落，在注入开段回合命中的必是**上一回合**气泡。锚=引导气泡
  // 所属段折叠（details.done-fold[data-m]）：user:null 段的段首元素即折叠体，折叠顶=回合顶=
  // 乐观气泡原位；段内若另有 data-t="u"（回合由真实 user 开段、引导系中途织入）则仍取开启
  // 气泡（段顶=气泡顶）。
  function guideTurnAnchor(guideEl) {
    const fold = guideEl.closest('details.done-fold[data-m]')
    if (!fold) return null
    return messagesEl.querySelector(`[data-m="${fold.dataset.m}"][data-t="u"]`) || fold
  }

  // 乐观吸收后的同回合锚：最新回合由注入开启还是真实 user 开启，以文档序判——最新引导气泡
  // 在末条开启气泡之后 ⇔ 注入开段（该回合没有 data-t="u"）→ 取其折叠锚；否则（无引导/
  // dequeue 落盘开段/引导织在更早回合）→ 末条开启气泡（dequeue 接管帧原行为）。禁止回落
  // 上一回合参照（=本缺陷：吸收帧参照回退上一回合 → 重钉上一条消息）。
  function absorbTurnAnchor() {
    const users = messagesEl.querySelectorAll('[data-t="u"]')
    const lastUser = users.length ? users[users.length - 1] : null
    const guides = messagesEl.querySelectorAll('.msg.user[data-t^="g"]')
    const lastGuide = guides.length ? guides[guides.length - 1] : null
    if (lastGuide && (!lastUser || (lastUser.compareDocumentPosition(lastGuide) & Node.DOCUMENT_POSITION_FOLLOWING))) {
      return guideTurnAnchor(lastGuide) || lastUser
    }
    return lastUser
  }

  // 渲染权威出口对账：整页重建洗掉占位块/气泡失联 → 重挂（流末）+ 气泡重定位 + 高度校准，
  // 然后按跟随几何归位。占位高度 = max(0, clientHeight − paddingBottom − 当前脚印)
  // （脚印 = 占位块顶 − 气泡贴顶位，**实时读取**；clientHeight 含常驻 padding-bottom 142px
  // （docked 输入栏悬浮预留），不扣则占位铺到输入栏底下；扣除后空白恰铺到输入栏上沿，
  // 未超一屏时 maxScroll ≡ 贴顶位）。高度唯一写入者=本函数（几何纯函数，无动画窗/无第二写入者）。
  function stageSync() {
    if (!stage.active) return
    const sc = $('chat-scroll')
    let el = stage.el && stage.el.isConnected ? stage.el : messagesEl.querySelector('.pin-stage')
    if (!el) {
      el = document.createElement('div')
      el.className = 'pin-stage'
      messagesEl.appendChild(el)
    }
    stage.el = el
    // 气泡参照找回——必须在脚印/高度计算之前（实时脚印 = 占位块顶 − 气泡顶，参照物缺席则
    // 无法量）。参照物定义=本回合开启用户消息，按精度递降定位：乐观期=暂态区最后一条
    // .msg.user；乐观项已被吸收（注入落盘/落盘接管，暂态区气泡移除）→ absorbTurnAnchor
    // 移交**同一回合**的权威锚（注入开段=段折叠顶，落盘开段=数据区开启气泡），禁止回落
    // 上一回合。
    if (!stage.bubble || !stage.bubble.isConnected) {
      if (stage.key === 'optimistic') {
        const zone = document.getElementById('live-zone')
        const els = zone ? zone.querySelectorAll('.msg.user') : []
        stage.bubble = (els.length ? els[els.length - 1] : null) || absorbTurnAnchor()
      } else {
        // 2026-09-09 跳动主根根修：stage.key 存 sig（"idx:ts"，防索引复用错位），但渲染权威
        // 气泡 data-m=段起始索引（纯数字）——整页重建后按 sig 原样匹配 data-m 恒落空 → bubble
        // 永久失联 → stageFollow t0 退化 0、落点从贴顶位瞬移内容底（差近一屏）=每回合首帧刷新
        // 必跳。修=取 sig 索引部分（":" 前）匹配 data-m；sig 防错位语义保留在 key 本体。
        stage.bubble = stage.key ? messagesEl.querySelector(`[data-m="${String(stage.key).split(':')[0]}"][data-t="u"]`) : null
      }
      if (stage.bubble && !stage.bubble.isConnected) stage.bubble = null
    }
    const padBot = parseFloat(getComputedStyle(sc).paddingBottom) || 0
    const t0 = stage.bubble ? topInScroll(stage.bubble) : null
    // 参照气泡两端皆缺（重建窗口内）不写高——占位高度连续性优先（写 0 = scrollHeight 骤减
    // = 视口钳制跳变）。
    if (t0 != null) {
      el.style.height = Math.max(0, sc.clientHeight - padBot - Math.max(0, topInScroll(el) - t0)) + 'px'
    }
    stageFollow()
  }

  // 追加到 #messages 末尾；插入点取暂态区 #live-zone（其子元素恒为消息流最末尾段）或两层占位
  // .pin-stage 之前（占位块恒为最后一个元素，否则预留空白会出现在消息中间）。2026-09-07 两区
  // 重构：权威内容永远插在暂态区之前——暂态区（气泡/主张折叠/排队区）恒贴底，不再与增量插入
  // 竞争文档序（「排队消息渲染到上一行」根因的结构性消除）。
  function msgAppend(el) {
    messagesEl.insertBefore(el, document.getElementById('live-zone') || messagesEl.querySelector('.pin-stage'))
    return el
  }

  function appendMsg(html) {
    const div = document.createElement('div')
    div.innerHTML = html
    const el = div.firstElementChild
    el.classList.add('msg-in')
    msgAppend(el)
    scrollBottom()
  }

  // 2026-08-30 共同后端定案（接力文档清单#4②③）→ 2026-09-07 两区重构收编：回合中发送的乐观
  // = 排队区成员（对齐 CLI 语义：回合运行中入队，终端只显示队列预览）；回合间隙发送 = 新回合
  // 开启主张（开启气泡 + 「正在处理」主张折叠，renderTransient 统一渲染于 #live-zone 暂态区）。
  // 生命周期：发送 → 乐观主张/排队成员 → CLI 注入（injected 出现）或 dequeue 落盘（user 出现）
  // → absorbPending 文本吸收移除（渲染权威接管）；权威 done-live[data-m] 在场 → 主张降级
  // （renderTransient 同趟：主张折叠不渲染、气泡项按排队成员渲染）。
  let pendingUserMsgs = []
  // 分层治理 4C（2026-10-10）：engine/live.js 的读取口（写侧仍是下方 setPendingUserMsgs）——
  // 每次现读可变绑定，调用方严禁缓存返回值。
  function getPendingUserMsgs() { return pendingUserMsgs }
  function addUser(text, imgs, files) {
    // 审批卡在场时发送消息不撤卡（2026-10-24 实测 bug：消息照发，但卡被 clearTakeover 洗掉、
    // 审批状态仍阻塞在 CLI 侧 ⇒ 用户无处作答）。审批卡只由回执/CLI 侧操作/切会话撤除
    // （approval-confirmed / approval-dismiss / route.js 切会话），发送不参与其生命周期。
    if (takeover !== 'approval') clearTakeover() // 其余残留 takeover 照旧清掉
    // 任何 done-live 折叠在场（权威或本区乐观主张）= 回合运行中 → 排队成员；否则本次发送是
    // 「新回合开启主张」。主张至多一个：主张折叠在场时后续发送恒为 dock 成员。
    const hasLive = !!messagesEl.querySelector('details.done-fold.done-live')
    pendingUserMsgs.push({ hash: state.currentHash, text, imgs: imgs || [], files: files || [], baseTs: live.lastDataTs || 0, form: hasLive ? 'dock' : 'bubble', claimTs: Date.now() })
    renderTransient()
    // 两层消息流：乐观开启气泡唤出占位（排队成员/dock 不唤——会话处理中发送不打断当前展示，
    // 2026-09-08 定案「只有处于结束状态的会话发送乐观气泡才唤出占位」）。气泡取暂态区最后
    // 开启气泡（主张至多一个=它），key='optimistic'，落盘接管后由 hasNewUser 链换权威 key。
    if (!hasLive) {
      const zone = document.getElementById('live-zone')
      const els = zone ? zone.querySelectorAll('.msg.user') : []
      if (els.length) stageStart(els[els.length - 1], 'optimistic')
    }
    scrollBottom() // 发送后跟随下滑（占位在场=两层跟随，动画期不抢）
  }
  // 吸收：当前会话 jsonl 已出现该文本（单条落盘或 drainCommandQueue 多条合并成一条，join 后
  // includes 命中）→ 真实气泡已由渲染权威接管，不再重插；其它会话的 pending 保留（切回时处理）。
  // 2026-08-29 误吸收根治：只认「本条 pending 插入时刻之后落盘」（timestamp > baseTs）的真实消息
  // ——短文本（如「继续」）极易被历史 user 文本 includes 命中，误吸收后乐观气泡被整页重建洗掉、
  // 真实气泡尚未落盘 → 消息静默消失。baseTs 取自渲染权威末条 timestamp（服务端时钟，两端设备无关）。
  function absorbPending(messages) {
    if (!pendingUserMsgs.length) return
    const cur = state.currentHash
    if (!cur) return
    const before = pendingUserMsgs.length
    pendingUserMsgs = pendingUserMsgs.filter((p) => {
      if (p.hash !== cur) return true
      // 吸收信号（2026-08-30 定案弃「文本 includes」单启发式的第一步）：injected 出现
      // （role:'user'+injected，isRealUser 命中）= 注入已发生，渲染权威折叠体内气泡接管；
      // dequeue 落盘 user 出现 = 开启气泡接管。baseTs 防历史文本误吸（教训见下）。
      const newer = messages.filter((m) => isRealUser(m) && (!p.baseTs || (m.timestamp || 0) > p.baseTs))
      const realTexts = newer.map((m) => m.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join(''))
      return !realTexts.some((t) => t.includes(p.text))
    })
    if (pendingUserMsgs.length !== before) renderTransient()
  }
  // 刷新两段式根治（2026-09-08）：队列快照的队首项在回合间隙（权威 done-live 不在场）= CLI
  // 空闲入队即消费的瞬态——即将出队开新回合，应渲染为乐观开启主张（气泡+主张折叠）而非
  // 「排队中」（此前刷新撞上「已入队未落盘」窗口：dock 先出「排队中」、气泡+折叠体等落盘
  // +SSE 往返后才出现）。统一收编为 form='bubble'，形态由 renderTransient 按 authLive 自动
  // 定（在场→降级 dock 成员 = 真排队；不在场→气泡 = 即将开回合），非队首项恒走 remote
  // （真排队）。收编项落盘后走 absorbPending 文本接管 / 接管帧同位换皮 / claimStartTs 计时
  // 移交——乐观链全部现成。首载回程/防抖回程/queue-state SSE 三入口统一调用；同文本已
  // 收编或本地已发（dock 项）幂等跳过/原地升级，不产生第二份。
  function queueClaimAdopt(items) {
    const cur = state.currentHash
    if (!cur || (firstSendHash && firstSendHash === cur)) return // 首条消息事务期乐观 DOM 自理
    const head = items && items[0]
    if (!head || typeof head.content !== 'string' || !head.content) return
    const local = pendingUserMsgs.find((p) => p.hash === cur && p.text === head.content)
    if (local) {
      if (local.form === 'dock') { local.form = 'bubble'; local.claimTs = Date.now() }
      return
    }
    pendingUserMsgs.push({ hash: cur, text: head.content, imgs: [], baseTs: live.lastDataTs || 0, form: 'bubble', claimTs: Date.now() })
  }
  // ---- 暂态区（2026-09-07 两区重构）：#live-zone = 数据区与 .pin-stage 之间的唯一暂态容器，
  //      承载三类乐观/运行态元素——回合开启气泡、回合开启主张折叠（「正在处理」）、置底排队区。
  //      生命周期对齐根治：此前三类元素各自为政（气泡直插数据区、proc 折叠独立变量+计时器、
  //      dock 独立挂载），整页重建洗掉一部分、增量路径洗不掉另一部分 → 「正在处理」幻影折叠
  //      残留 / 排队区插到新落盘消息上一行（首段无锚点时 delta 追加越过 dock）。现一切暂态 DOM
  //      由 pendingUserMsgs + live.queueRemote 单一状态源整体重建，每条渲染路径（整页/增量/
  //      queue-state SSE/发送）末尾都跑 renderTransient 对账：
  //      ① 权威 done-live[data-m] 折叠在场（回合实际运行中）→ 本区不持回合开启主张（主张折叠
  //        不渲染、气泡项降级为排队成员）；主张折叠无 data-m，判定不会自匹配。
  //      ② 吸收：absorbPending 文本命中（落盘接管）→ 项移除，区随趟收敛。
  //      ③ 全空 → 容器整体摘除（主张计时随停）。
function setPendingUserMsgs(v) { pendingUserMsgs = v }
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
        return '<div class="msg user msg-in" data-t="u">' + (bodyInner ? '<div class="body">' + bodyInner + '</div>' : '') + imgsHtml + filesHtml + (bodyInner ? '<div class="msg-actions"><button class="msg-copy" title="复制" aria-label="复制">' + ICON_COPY + '</button></div>' : '') + '</div>'
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
      return (plan.trim() ? `<div class="appr-md">${mdHtml(plan)}</div>` : '') + restHtml
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
        <div class="appr-strip"><span class="appr-dot"></span>需要批准${zh ? ' · ' + esc(zh) : ''}${a.toolName ? '（' + esc(a.toolName) + '）' : ''}</div>
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

function setTakeover(v) { takeover = v }
function setTurnLive(v) { turnLive = v }
function setBtnModeSet(v) { btnMode = v }
function setApprovalPending(v) { approvalPending = v }
  function deviceHint() {
    return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 ? 'iPad' : ''
  }

  function connect() {
    if (GATEWAY_REVIEW) {
      // 审阅模式（bun 编译 exe）：node:http 的 upgrade 握手在 bun 下 101 无法送达客户端、
      // WS onopen 永不触发，token 门会卡在「正在验证」。审阅模式 token 非空即视为通过，
      // 不建真 WS，直接走视觉流程（视频过渡 → 趴栏 → 空态）。正式网关（无 review 标志）不受影响。
      gateVerified = true
      setConn(true, '已连接')
      gatePlayTransition()
      return
    }
    if (gws) { gws.close() }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const hint = deviceHint()
    gws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(gToken)}${hint ? '&device=' + encodeURIComponent(hint) : ''}`)
    gws.onopen = () => {
      setConn(true, '已连接')
      gateVerified = true
      if (gateAwait) gatePlayTransition() // 门流程：播过渡视频（白板拉伸成输入栏/角色转正趴栏），ended 后 hideGate
      else hideGate() // URL 带 token 直连（无门）：验证通过直接解锁
      noteWsOpen() // SSE 监督者联动（2026-10-14 GPT 定案②）：WS 恢复即强制重建 SSE（半开下行唯一复活信号，重建后 hello 全量对账）
      gwSendPort.syncGwSend()
      cardBus.reportCaps() // 卡片能力表：连上/重连即补报（网关侧随连接断开已摘表，重连必须重报）
      gwApproval.sendSubscribe() // 2026-08-30 pending 重放：连上/重连即订阅当前会话（补切会话时 WS 尚未就绪的场景）
    }
    gws.onclose = () => {
      setConn(false, '未连接')
      noteWsClosed() // SSE 监督者联动：WS 断 → 关 SSE（上行已死，下行单独维持无意义），随 WS 重链统一重建
      // 2026-08-18 修复：token 未验证成功即断开（URL token 过期——网关重启/换新 token、或门内输入错误）
      // 一律回 token 门重输，避免静默卡在空态、后续数据请求带着无效 token 全 401。
      if (!gateVerified) {
        // 2026-08-28 设备配对：未授权/未验证 → 回门显示请求码（PC /server auth add 后自动进入）
        toast(gateAwait ? '设备尚未授权：请在 PC 运行 /server auth add <请求码>' : '设备未授权：请在 PC 运行 /server auth add <门上请求码>')
        showGate()
      } else {
        // 2026-08-26 修复：已通过 token 验证的会话断连后自动重连，否则 sockets=0 导致
        // 审批卡/提问卡永远送不到 floria（用户必等不到审批）。重连由 onopen 恢复即可，不再回 token 门。
        clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(connect, 4000)
      }
      gws = null
      gwSendPort.syncGwSend()
    }
    gws.onerror = () => setConn(false, '连接失败')
    gws.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      // 2026-08-23 web 独立会话：approval 带 session_id，仅当匹配当前会话才消费
      // （多个独立会话并行运行，其它会话的流不干扰当前视图）。
      // 2026-09-07：out 流分支删除——网关从不投递 out（实时流走 SSE 会话上报+jsonl，定案），
      // 原 handleLine 直连 CLI 流式渲染链（streamText/procThink/实时变更卡）随之整体退役。
      if (msg.type === 'approval') {
        if (msg.session_id && msg.session_id !== state.currentHash) return
        gwApproval.renderApproval(msg)
      } else if (msg.type === 'approval-confirmed') {
        // 2026-08-26 P0 审批确认送达：CLI 已处理回执 → 关卡 + 提示（不再 send 后立即清卡）
        if (msg.session_id && msg.session_id !== state.currentHash) return
        const ap = gwApproval.getApprovalPending()
        if (ap && ap.requestId === msg.requestId) {
          const wasAllow = ap.allowed
          gwApproval.setApprovalPending(null)
          gwApproval.clearTakeover()
          gwApproval.addSystem(wasAllow ? '已允许该工具调用' : '已拒绝该工具调用')
        }
      } else if (msg.type === 'approval-rejected') {
        // 2026-08-26 P0：目标 CLI 不在线 → 保留卡片 + 可见错误 + 重试
        if (msg.session_id && msg.session_id !== state.currentHash) return
        const ap = gwApproval.getApprovalPending()
        if (ap && ap.requestId === msg.requestId) {
          gwApproval.showApprovalError('审批未送达目标，请重试', msg.requestId, ap.allowed, ap.qa, ap.perms)
        }
      } else if (msg.type === 'approval-dismiss') {
        // 2026-08-24 审批双操作（web 与 CLI 均可）：CLI 终端/窗口已先操作 → 撤掉 floria 审批卡
        if (msg.session_id && msg.session_id !== state.currentHash) return
        if (gwApproval.getApprovalPending()) { gwApproval.setApprovalPending(null) }
        if (gwApproval.getTakeover() === 'approval') gwApproval.clearTakeover()
      } else if (msg.type === 'card-call') {
        // 卡片公开 API（2026-10-11）agent→卡：网关 POST /gateway/card-call 下行至此 → 总线查帧表、
        // 翻成卡的 `<ns>-cmd`，ack 由总线经 card-result 原路回网关。本件只做收发，不懂卡。
        cardBus.handleGatewayCall(msg)
      } else if (msg.type === 'status') gwApproval.addSystem(msg.state)
    }
  }

  // ---- token 门（2026-08-15；2026-08-17 SubPj3 复刻：白板内 token 表单 → 视频过渡 → 趴栏+胶囊+台面输入栏）----
  // 输入 token 回车 → connect()（WS 服务端验证）→ onopen 置 gateVerified → 白板内表单淡出 + 过渡视频
  // （白板拉伸成输入栏/角色转正趴栏）→ ended → 阶段3 趴栏+胶囊淡入 → 停留后 hideGate() 进空态
  // （空态同趴栏 stage，位置一致无缝）。token 错误（onclose 未验证）→ 回门重输。
  // gateVerified 声明已提前到网关模式区（2026-08-28：needToken 依赖）。
  let finishGateTimer = null // 阶段3 停留后 hideGate 的定时器
  let hideGateTimer = null // gate-screen 淡出后隐藏的定时器（hideGate 不再硬切）
  const gateScreen = $('gate-screen')
  const gTok = $('g-token'), gVid = $('g-video'), gNewImg = $('g-new')
  const gCard = $('g-card')

  // 依赖反转（分层治理 4D，2026-10-10）：engine/auth.js 不再静态 import chat/sidebar/inputbar——
  // token 门解锁（hideGate）后的界面重渲、数据补拉、发送态同步一律经 app 启动序列注入的端口访问
  // （端口在 boot 同步块内接线，早于 detectorGateway→initGateway→showGate/hideGate 首次调用）。
  let authUi = {} // 解锁后界面出口：chat/route.js 的 route + inputbar/mention.js 的 closeMentionPop + sidebar/recent.js 的 renderRecent
  let authData = {} // 解锁后数据补拉：sidebar/mgr-data.js 的 loadMgrData/loadModelsData + sidebar/work.js 的 ensureWork
  let authSend = {} // inputbar/send.js：syncGwSend

  // ---------- 设备认证配对（2026-08-28，浏览器侧完全删除 token 授权链） ----------
  // 门态显示设备请求码（localStorage 持久，同一设备恒定），轮询 /gateway/activate?code=：
  // PC 端 /server auth add <请求码> 后网关名单命中 → 种 floria_auth cookie → 下轮轮询 200 →
  // connect()（cookie 直过）→ onopen → gateVerified → gatePlayTransition。无自动转正、无 token。
  let pairTimer = null
  function deviceCode() {
    let c = ''
    try { c = localStorage.getItem('floria-device-code') || '' } catch { /* 忽略 */ }
    if (!/^[a-f0-9]{8}$/.test(c)) {
      const b = new Uint8Array(4)
      crypto.getRandomValues(b)
      c = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
      try { localStorage.setItem('floria-device-code', c) } catch { /* 忽略 */ }
    }
    return c
  }
  function pairStart() {
    pairStop()
    $('g-pair-code').textContent = deviceCode().replace(/(..)(..)(..)(..)/, '$1 $2 $3 $4')
    pairTimer = setInterval(pairPollOnce, 2500)
  }
  function pairStop() {
    if (pairTimer) { clearInterval(pairTimer); pairTimer = null }
  }
  async function pairPollOnce() {
    try {
      const hint = deviceHint()
      const res = await fetch('/gateway/activate?code=' + encodeURIComponent(deviceCode()) + (hint ? '&device=' + encodeURIComponent(hint) : ''))
      if (!res.ok) return false
      pairStop()
      connect() // cookie 已种，WS 直过 → onopen → gatePlayTransition
      return true
    } catch { return false }
  }

  function showGate() {
    authUi.closeMentionPop()
    setGateAwait(true)
    setGateVerified(false)
    document.body.classList.add('token-gate')
    // token 门态输入栏必须回到 chat 空态位（位置一致），防 hash 残留会话导致 docked 到底部
    inputWrap.classList.remove('docked')
    chatArea.classList.remove('in-session')
    // 重置门到阶段1：举白板 + 白板内 token 表单
    // 平滑浮现：先置透明再移除 fade-out（强制 reflow 让 transition 生效）→ 淡入
    clearTimeout(hideGateTimer)
    gateScreen.classList.add('fade-out')
    gateScreen.hidden = false
    void gateScreen.offsetWidth
    gateScreen.classList.remove('fade-out')
    clearTimeout(finishGateTimer)
    gVid.pause(); gVid.currentTime = 0
    gVid.classList.remove('show', 'fade-out')
    gTok.classList.remove('fade-out')
    gNewImg.classList.remove('show')
    gCard.classList.remove('hide', 'shake')
    pairStart() // 显示设备请求码 + 启动激活轮询
    authSend.syncGwSend()
  }
  function gatePlayTransition() {
    // 阶段1 → 阶段2：白板内表单淡出，过渡视频淡入播放（视频首帧≈举白板图，无缝衔接）
    gCard.classList.add('hide')
    gTok.classList.add('fade-out')
    gVid.classList.add('show')
    gVid.currentTime = 0
    gVid.playbackRate = 1.5 // 过渡视频提速（用户「动画播放快一点」）
    const p = gVid.play()
    if (p && p.catch) p.catch(finishGate) // 视频不可播（不支持 webm/mp4）→ 直接进空态
  }
  function finishGate() {
    if (!gateVerified) return
    // 阶段2 → 阶段3：视频淡出，趴栏图淡入；停留片刻后 hideGate（空态同趴栏 stage，无缝）
    gVid.classList.add('fade-out')
    gVid.classList.remove('show')
    gNewImg.classList.add('show')
    clearTimeout(finishGateTimer)
    finishGateTimer = setTimeout(hideGate, 300)
  }
  gVid.addEventListener('ended', finishGate)

  function hideGate() {
    setGateAwait(false)
    pairStop() // 退出门态：停止配对激活轮询
    document.body.classList.remove('token-gate')
    // 2026-08-28 token 出 URL：正式网关验证通过即清除 URL query token（凭据已入 floria_auth
    // cookie 票证，刷新/收藏都是干净地址）；REVIEW 模式保留写回（server.mjs 仍按 query 校验）。
    try {
      const u = new URL(location.href)
      if (GATEWAY_REVIEW) u.searchParams.set('token', gToken)
      else u.searchParams.delete('token')
      history.replaceState(null, '', u.pathname + u.search + u.hash)
    } catch { /* 忽略 */ }
    gVid.pause()
    composerPlaceholder('输入消息，Enter 发送') // 占位符复位（token 提示 → 正常输入）
    // gate-screen 淡出后隐藏，与空态（同款渐变背景）交叉过渡 → 切换平滑浮现，不做硬切
    gateScreen.classList.add('fade-out')
    clearTimeout(hideGateTimer)
    hideGateTimer = setTimeout(() => {
      gateScreen.hidden = true
      gateScreen.classList.remove('fade-out')
    }, 280)
    authSend.syncGwSend()
    // token 门锁定态跳过的数据加载，解锁后补拉（SSE 重连 + 会话列表/当前会话）
    // 2026-08-18 修复：loadSessions 只填 ALL 不渲染，门后首次拉取后侧栏一直空——
    // 后续 SSE hello→refreshList 因 sig===listSig 短路跳过渲染；须在数据落地后显式渲染侧栏
    //（renderRecent 保留展开文件夹+滚动位置，幂等）。
    loadSessions().then(() => {
      // 刷新直进 /session/<hash>：boot 时会话列表未就绪，route() 的 resolve 落空，
      // currentHash 暂存 → 补拉列表落地后重 resolve（renderSession/refreshSession/SSE 全链全长）。
      // 2026-08-30 改定案（刷新保留当前界面，boot 不再强制回首页）后本恢复链成为刷新直进的唯一落地路径：
      // 「无真实消息气泡」才整页重渲（占位行也是 .msg → 旧判定 .msg 对占位恒假，列表落地即残留）；
      // 列表就绪仍找不到 → route() 渲染真实「会话不存在或已删除」（此时 needToken 已 false）。
      if (state.currentHash) {
        const sess = findSession(state.currentHash)
        if (sess) {
          state.currentHash = hashOf(sess)
          if (!messagesEl.querySelector('.msg:not(.msg-system)')) authUi.route()
        } else {
          authUi.route()
        }
      }
      authUi.renderRecent()
      // work 模式数据补拉：boot 的 initWork→ensureWork 撞上 needToken()（token 未就绪）早退，
      // 刷新后恢复的 workProj/workFile 会停在无树 / 编辑区 401 的状态；此处与 mgr 同点补拉。
      if (state.sbMode === 'work') authData.ensureWork()
    })
    // 应用目录补拉（2026-10-10）：工作区根 .claude/preview 申报的应用清单 + 已启用侧栏 tab。
    // boot 时 token 未就绪会取空，故与 loadSessions 同点补拉；断连重连自愈走同点（hideGate 即恢复口）。
    syncGlobalPlugins()
    initLive()
    // 恢复当前界面（gToken 已就绪）：预览态重挂 iframe、管理视图补拉数据、会话态增量刷新
    if (state.preview) authUi.route()
    else if (state.mgr) authData.loadMgrData(true)
    else {
      refreshSession()
      // 2026-08-25 首页/会话态补拉模型数据：初始 renderModelSeat 时 GATEWAY 尚未就绪、
      // token 空 → /gateway/models 401，MODELS 恒 null，seat 一直显示「选择模型」（用户反馈「看不到模型」）。
      // hideGate 解锁后 token 已就绪 → 补拉一次，finally 内 renderModelSeat 刷新输入栏模型名。
      authData.loadModelsData(true).catch(() => {})
    }
  }
  async function gateSubmit() {
    // 门态回车/点击发送 = 手动重试一次配对激活（平时 2.5s 自动轮询；授权后数秒内自动进入）
    await pairPollOnce()
  }
  // 白板内 token 表单：回车提交（无发送按钮）—— 设备配对版已移除输入框，此绑定随 #g-token-input 删除

function setAuthPorts(p) { authUi = p.ui; authData = p.data; authSend = p.send }
  // ---------- 视觉上行内部态 ----------
  // pendingImages: {content(base64 无前缀), mediaType, filename, dataUrl, attName?, attRel?}。发送时文本拼
  // [Image #N] 占位 + images 随 'send' 上行 → 网关透传 → CLI gatewayClient 构造 pastedContents（不落盘、
  // 执行时 resize）。attName/attRel = 同次上传落盘后的文件名与引用键（落盘失败则无，胶囊照显、@ 不可引用）。
  let pendingImages = []
  function clearPendingImages() {
    pendingImages = []
    renderImgPills()
    syncGwSend()
  }
  // pendingFiles: {name, rel, abs, size}（落盘文件）。发送时文本拼 [文件:<路径>] 占位随消息上行
  // （CLI 端即普通文本，模型按路径 Read）；正文里的 `[名](file-cache/…)` 链接是同一次上传的引用表达。
  let pendingFiles = []
  function clearPendingFiles() {
    pendingFiles = []
    renderImgPills()
    syncGwSend()
  }
  // ---------- 附件胶囊行（#img-pills）：pending* 的可见回显（待办 6 还原）----------
  // 图片缩略图 + 文件卡同轨（CSS 见 styles.css #img-pills），× 从 pending* 数组摘除并重渲。
  // 一次绑定（dataset.bound）防重复挂监听；元素可能随后才入 DOM，故 renderImgPills 每次调用都补绑。
  function onPillRemove(e) {
    const b = e.target && e.target.closest ? e.target.closest('.img-x') : null
    if (!b) return
    if (b.dataset.i != null && b.dataset.i !== '') pendingImages.splice(+b.dataset.i, 1)
    else if (b.dataset.f != null && b.dataset.f !== '') pendingFiles.splice(+b.dataset.f, 1)
    renderImgPills()
    syncGwSend()
  }
  function renderImgPills() {
    const box = $('img-pills')
    if (!box) return
    if (box.dataset.bound !== '1') { box.dataset.bound = '1'; box.addEventListener('click', onPillRemove) }
    if (!pendingImages.length && !pendingFiles.length) {
      box.hidden = true
      box.textContent = ''
      return
    }
    box.hidden = false
    box.innerHTML =
      pendingImages
        .map((p, i) => `<span class="img-pill"><img src="${p.dataUrl}" alt="${esc(p.filename)}"/><button class="img-x" data-i="${i}" type="button" aria-label="移除">×</button></span>`)
        .join('') +
      pendingFiles
        .map((f, i) => `<span class="file-pill" title="${esc(f.abs)}"><span class="fp-ico">${fileIcon(f.name)}</span><span class="fp-name">${esc(f.name)}</span><button class="img-x" data-f="${i}" type="button" aria-label="移除">×</button></span>`)
        .join('')
  }
  // @ 浮窗「上传」组的数据源（mention.js / commands.js 消费）：本次上传、可被正文引用的附件。
  // 形态 = {kind:'attref', attKind:'img'|'file', name, md}——md 即选中后写回 doc 的正文引用原文
  // （与自动插入同一形态）。kind 与首屏两个**上传动作行**（commands.js 的 imgpick/filepick）分开：
  // 动作行点开文件选择器，本行是「引用已上传件」，两者语义不同，不可共用一个 kind。
  function uploadedMentionItems() {
    const out = []
    for (const p of pendingImages) {
      if (p.attRel) out.push({ kind: 'attref', attKind: 'img', name: p.attName, md: `![${p.attName}](${encodeURI(p.attRel)})` })
    }
    for (const f of pendingFiles) out.push({ kind: 'attref', attKind: 'file', name: f.name, md: `[${f.name}](${encodeURI(f.rel)})` })
    return out
  }
  // 编码：≤1.5MB 且 png/jpg/webp 直传原 base64（截图文字不重压）；否则 canvas 重编码 jpeg
  // （长边 ≤1568 对齐 API 推荐输入、质量 0.85），把手机照片压到几百 KB 再走 WS。
  function encodeImg(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => {
        const dataUrl = String(r.result)
        if (file.size <= 1536 * 1024 && /^image\/(png|jpe?g|webp)$/.test(file.type)) {
          const mediaType = file.type === 'image/jpg' ? 'image/jpeg' : file.type
          return resolve({ content: dataUrl.split(',')[1], mediaType, filename: file.name || '图片', dataUrl })
        }
        const img = new Image()
        img.onload = () => {
          const MAX = 1568
          const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight))
          const w = Math.max(1, Math.round(img.naturalWidth * scale))
          const h = Math.max(1, Math.round(img.naturalHeight * scale))
          const cv = document.createElement('canvas')
          cv.width = w
          cv.height = h
          cv.getContext('2d').drawImage(img, 0, 0, w, h)
          const out = cv.toDataURL('image/jpeg', 0.85)
          resolve({ content: out.split(',')[1], mediaType: 'image/jpeg', filename: (file.name || '图片').replace(/\.[^.]+$/, '') + '.jpg', dataUrl: out })
        }
        img.onerror = () => reject(new Error('decode failed'))
        img.src = dataUrl
      }
      r.onerror = () => reject(new Error('read failed'))
      r.readAsDataURL(file)
    })
  }
  // 图片附件（粘贴/拖拽/+ 浮窗）：视觉上行 base64 入列（胶囊缩略图）+ 原文件上传落盘（时间戳名）。
  // 正文引用按 target 分：composer 不插（只进胶囊）；work 插 `![名](file-cache/…)`（CM 行内直渲）。
  // 落盘失败时视觉上行仍有效（无 attName、@ 不可引用，发送链 [Image #N] 照旧上行）。
  // target = editorCommand 落点 id（'composer' 底栏 / 'work' 编辑卡片），缺省底栏
  // filePath = work 编辑卡片当前文件相对路径（kernel paste 钩子传入；缺省读 state.workFile）。
  // 编辑卡片图片粘贴按扩展名分流（2026-11-02）：`.tex` → 落 <tex 目录>/image/ + `\includegraphics`；
  // `.md`/`.markdown` → 原 md 引用链；**其它扩展名不响应图片粘贴**（不落 file-cache、不插引用）。
  async function addImageFiles(files, target, filePath) {
    const tgtEd = target || 'composer'
    const toComposer = tgtEd === 'composer'
    const workPath = String(filePath || state.workFile || '')
    const isTex = !toComposer && /\.tex$/i.test(workPath)
    const isMd = !toComposer && /\.(md|markdown)$/i.test(workPath)
    const texNames = []
    for (const f of files) {
      if (!/^image\//.test(f.type)) continue
      // 张数上限只约束底栏发送链（pendingImages 是发送态）；编辑卡正文引用不占名额
      if (toComposer && pendingImages.length >= 9) { toast('一次最多 9 张图片'); break }
      let enc
      try { enc = await encodeImg(f) } catch { toast('图片读取失败'); continue }
      // 模块化分流（2026-10-21 待办）：work 编辑卡 = 只落盘 + 写正文引用，**不写底栏 pending/胶囊**。
      // 旧实现无论 target 都 push pendingImages + renderImgPills，导致编辑卡粘贴的图串进底栏胶囊行。
      if (!toComposer) {
        if (isTex) {
          // tex 图片落 tex 所在目录的 image/（网关递归建目录、同名 -1/-2 去重），正文插 includegraphics
          const slash = Math.max(workPath.lastIndexOf('/'), workPath.lastIndexOf('\\'))
          const dir = slash >= 0 ? workPath.slice(0, slash) : ''
          const att = await uploadProjectAttachment(f, state.workProj, dir ? dir + '/image' : 'image')
          if (att) texNames.push(att.name)
          continue
        }
        if (!isMd) continue // 编辑卡片仅 md / tex 响应图片粘贴
        const att = await uploadAttachment(f)
        if (att) insertAttachmentMarkdown(tgtEd, att)
        continue
      }
      const att = await uploadAttachment(f)
      if (att) { enc.attName = att.name; enc.attRel = att.rel } // @ 浮窗可引用的键（落盘成功才有）
      pendingImages.push(enc)
      // 底栏（composer）上传 = 只进胶囊行待发，**不自动往输入框正文插引用**（2026-10-16 待办 2：
      // 「不要自动在正文渲染，被图片胶囊劫持」）。
      renderImgPills()
    }
    if (texNames.length) insertTexImages(tgtEd, texNames) // 多张按原顺序，各一行 includegraphics
    if (toComposer) syncGwSend()
  }
  // 文件附件（+ 浮窗「上传文件」/粘贴）：上传落盘 → pendingFiles 入列（发送侧 [文件:占位] 自动相对化）
  // + 原文插 `[名](file-cache/…)` 文件名链接。落盘跟随会话（与粘贴图片同目录）：sid=当前会话（存量/
  // 已开）；首页尚无会话时 project=<workProj|newSessionProject()>——与 gwSend 首送建会话的归属参数同源，
  // 保证「上传落点的项目根 = 消息会话启动根」；两者皆无 → 网关自身根。
  async function addUploadFiles(files, target) {
    const tgtEd = target || 'composer'
    const toComposer = tgtEd === 'composer'
    for (const f of files) {
      toast('正在上传 ' + (f.name || '文件') + '…')
      const att = await uploadAttachment(f)
      if (!att) continue
      // 同 addImageFiles：底栏 = 只进附件胶囊行（不插正文，正文引用仅 @ 上传组显式选择时才写）；
      // 编辑卡 = 只写正文链接（不串底栏胶囊）。
      if (toComposer) { pendingFiles.push(att); renderImgPills() }
      else insertAttachmentMarkdown(tgtEd, att)
      toast('已上传 ' + att.name)
    }
    if (toComposer) syncGwSend()
  }

// ---------- 剪贴板取图（2026-10-16：复制→粘到底栏成胶囊）----------
// 取剪贴板文件：cd.files 与 cd.items(kind==='file') 的并集。截图/从网页或别的应用复制的**位图**
// 只落在 items（异步 getAsFile），cd.files 为空——旧实现只读 cd.files，故这类粘贴走不到
// addImageFiles，胶囊行「完全不显示」（用户实测）。files 非空时以 files 为准（items 是其镜像，去重）。
function clipboardFiles(cd) {
  if (!cd) return []
  const files = Array.from(cd.files || [])
  if (files.length) return files
  const out = []
  for (const it of Array.from(cd.items || [])) {
    if (!it || it.kind !== 'file') continue
    const f = it.getAsFile()
    if (f) out.push(f)
  }
  return out
}
// 从剪贴板 text/html 里取**同源** <img> 的 URL（pathname+search）：消息区选中图片复制时
// editor-clipboard.copyRenderedImages 写的就是 `<img src="/gateway/file-cache/…">`。
// 只认同源（跨域取不到字节、data: 无意义）→ 交给 addImageUrls 拉回字节。
function clipboardImageUrls(html) {
  const s = String(html || '')
  if (!s || !/<img\b/i.test(s)) return []
  let doc
  try { doc = new DOMParser().parseFromString(s, 'text/html') } catch { return [] }
  const out = []
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const raw = img.getAttribute('src') || ''
    if (!raw || /^data:/i.test(raw)) continue
    let u
    try { u = new URL(raw, location.href) } catch { continue }
    if (u.origin !== location.origin) continue
    out.push(u.pathname + u.search)
  }
  return out
}
// 把同源图片 URL 拉回字节 → 合成 File → 复用 addImageFiles（编码/落盘/胶囊全链同路，
// 不另起一套）。取不到的图静默跳过（降级为「少一张」而非整次粘贴失败）。
async function addImageUrls(urls, target) {
  const list = Array.from(urls || [])
  if (!list.length) return
  const files = []
  for (const u of list) {
    try {
      const r = await fetch(u, { credentials: 'same-origin' })
      if (!r.ok) continue
      const b = await r.blob()
      if (!/^image\//.test(b.type)) continue
      const ext = (b.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
      files.push(new File([b], 'clipboard.' + ext, { type: b.type }))
    } catch { /* 跳过取不到的图 */ }
  }
  if (files.length) await addImageFiles(files, target)
}

  async function gwSend() {
    if (!GATEWAY) return false
    closeMentionPop()
    let text = serializeInput().trim()
    const imgs = pendingImages.slice()
    const files = pendingFiles.slice()
    if (!text && !imgs.length && !files.length) { composerFocus(); return true }
    if (!gws || gws.readyState !== 1) { toast('未连接，无法发送'); return true }
    // 2026-08-28 图片占位：[Image #N] 与 pastedContents id 一一对应。
    // 2026-09-02 防撞根修：id 由本端分配全会话唯一（从已用最大 imageId+1 起，对齐 CLI
    // getInitialPasteId 语义），随 images 显式上行——CLI pastedContentsFromImages 尊重显式 id。
    // 原恒从 1 起：同会话第二条带图消息互覆 file-cache 字节 → 历史图错图。
    if (imgs.length) {
      const base = live.maxImgId || 0
      imgs.forEach((im, i) => { im.id = base + 1 + i })
      live.maxImgId = base + imgs.length
      const ph = imgs.map((im) => `[Image #${im.id}]`).join(' ')
      text = text ? text + ' ' + ph : ph
    }
    const imgPayload = imgs.length
      ? { images: imgs.map(p => ({ id: p.id, content: p.content, mediaType: p.mediaType, filename: p.filename })) }
      : {}
    // 2026-08-24 首页空态首条消息触发：未在具体会话（#/ 空态）输入第一条消息
    // → 先创建 web 会话（网关 spawn 本地可见 CLI 窗口，返回后 CLI 已连 /clients），
    // 再进会话发送首条消息。web 会话 = 本地可见交互 CLI 窗口（用户本地也可直接操作）。
    // 2026-08-25 项目「+」先到初始化界面：state.newProject 有值 → 建会话时带上 project 落到该项目组；
    // 用完即清（正常进会话后 currentHash 已设置，不再进此分支）。
    // 2026-08-24 防双 spawn：创建期间（POST /gateway/wsession 等 CLI 注册，最长 20s）置 webCreating，
    // 期间再发送直接忽略（否则每发一条都新建一个会话）；创建完成后 currentHash 已由 navigate 设置。
    if (!state.currentHash) {
      if (webCreating) { toast('正在创建会话，请稍候…'); return true }
      const tgt = newSessionProject() // work 模式 = 工作项目（seat 只读，见 state.newSessionProject）
      const prevNew = state.newProject // 回滚用：清的是「目标项目」这一个槽，work 模式压根不读它
      state.newProject = null // 消费即清：目标项目一次性，下一次回默认全局
      // 首页模型选择（2026-10-11）：待定槽消费即清，失败回滚时还原（同 newProject 一次性语义）。
      // 它只作用于本次新建会话——随建会话请求下发，网关 spawn 时落 --model 启动参数（见 newWebSession），
      // 不改全局默认（全局默认唯一入口 = 凭据池 credentials.json，见 model-select.js 注释）。
      const prevModel = getNewSessionModel()
      setNewSessionModel('')
      // 丝滑过渡（2026-08-30）：不等 wsession 返回（spawn CLI 窗口+注册常 >1s，期间空态冻结
      // 是「不丝滑」根源）——发送瞬间即进会话视觉：输入栏 FLIP 沉底 + 趴栏淡出 + 首条消息
      // 乐观上屏（气泡+正在处理折叠）。pre 标记 + hash 暂空：renderSession 创建中不洗
      // 「加载中…」、fetch 空时不重复上屏；创建失败整体回滚空态（还原输入文本与图片胶囊）。
      // 丝滑过渡（2026-08-30）：不等 wsession 返回（spawn CLI 窗口+注册常 >1s，期间空态冻结
      // 是「不丝滑」根源）——发送瞬间即进会话视觉：输入栏 FLIP 沉底 + 趴栏淡出 + 首条消息
      // 乐观上屏（气泡+正在处理折叠）。首条消息事务（firstSendHash）由 newWebSession 在
      // navigate 之前回填，创建失败回滚空态（还原输入文本与图片胶囊）。
      flipInput(false)
      addUser(text, imgs, files)
      composerSetText('')
      syncGwSend()
      const d = await newWebSession(tgt || undefined, prevModel || undefined)
      if (!d || !d.hash) {
        setFirstSendHash('') // 事务终止：创建失败，乐观 DOM 随下方空态回滚一并清空
        setPendingUserMsgs(pendingUserMsgs.filter((p) => p.hash)) // 丢弃无归属（hash=''）的乐观项
        messagesEl.innerHTML = ''
        renderTransient() // 暂态区对账：空主张 → 摘区/停主张计时/turnLive 复位
        flipInput(true) // 回滚空态（FLIP 滑回 stage，docked/in-session 一并移除）
        composerSetText(text)
        syncGwSend()
        state.newProject = prevNew
        setNewSessionModel(prevModel)
        composerFocus()
        return true
      }
      clearPendingImages()
      clearPendingFiles()
      // newWebSession 已回填 firstSendHash（navigate 之前）并 navigate 进会话（renderSession
      // 设置 currentHash + 拉历史）：首条消息事务生效——乐观开启气泡/主张折叠是权威 DOM，等真实
      // 数据落盘接管；期间队列快照不渲、空 fetch 不洗盘（守卫见 renderSession/refreshSession）。
      // 2026-09-12 相对占位：新会话 cwd 由 wsession 响应带回（与 spawn cwd 同源
      // webSessionProjectRoot）——jsonl 落盘前会话记录尚不存在，响应带回是首条消息唯一 cwd 源。
      // 乐观文本不含文件占位（absorb 为 includes 子串匹配仍命中）；落盘文本带相对占位。
      if (d.cwd) setSessionCwd(d.cwd)
      // 首页选的模型（2026-10-13 待办 12 根修）：已随 newWebSession 的 wsession body.model 下发，
      // 网关 spawn 时落 --model 启动参数——CLI 启动即固化会话覆盖（先于一切帧与消息），首轮请求
      // 即用所选模型。旧「建会话后 apiSetModel 补投」链退役：wsession 自 2026-09-06 异步化（预分配
      // sid 立即返回、spawn+注册后台进行），补投时目标 CLI 尚未注册 → routeToClient 恒 miss 400，
      // 「启动后仍用默认模型」即此竞速；--model 从出生固化，无时序问题。
      const fph = files.map((f) => `[文件:${relUploadPath(f.abs)}]`).join(' ')
      const sendText = fph ? (text ? text + ' ' + fph : fph) : text
      gws.send(JSON.stringify({ type: 'send', text: sendText, sessionId: d.hash, ...imgPayload }))
      // 主张折叠已由 addUser → renderTransient 上屏（事务期乐观 DOM 是权威），此处无需再挂
      return true
    }
    if (!inputWrap.classList.contains('docked')) {
      // 先入会话态（输入栏沉底、滚动区留底边距），再追加/钉顶消息，保证钉顶位置计算基于最终布局
      mountInput('chat') // 输入栏从空态 stage 移回 #chat-area 沉底
      inputWrap.classList.add('docked')
      chatArea.classList.add('in-session')
    }
    // 2026-09-12 文件占位：[文件:<会话 cwd 相对路径>]，与图片占位同模式——消息文本原样上行
    // （CLI/模型端按 cwd 解析读文件），web 渲染层剥占位出文件卡片（userFilesHtml）。
    if (files.length) {
      const fph = files.map((f) => `[文件:${relUploadPath(f.abs)}]`).join(' ')
      text = text ? text + ' ' + fph : fph
    }
    addUser(text, imgs, files)
    // 2026-08-17 网关独立化：带当前会话 hash，网关按 sessionId 精确路由给对应 CLI 进程
    // （未在具体会话时 currentHash 为 null → 字段省略，网关广播兜底）
    gws.send(JSON.stringify({ type: 'send', text, sessionId: state.currentHash || undefined, ...imgPayload }))
    // 2026-09-07 两区重构：乐观「正在处理」主张折叠由 renderTransient 从 pendingUserMsgs
    // 统一渲染（回合间隙发送 = 开启主张气泡+主张折叠；回合运行中 = 排队成员，不开折叠）——
    // 原 procOpen 直挂 DOM 链退役（幻影折叠根源：proc 变量跨整页重建悬挂，收养/幂等皆失灵）。
    composerSetText('')
    clearPendingImages()
    clearPendingFiles()
    syncGwSend()
    return true
  }

  function syncGwSend() {
    // 2026-09-05 定案：回合进行中输入栏有内容（文本/图/文件）→ 显示发送键（点击=排队续发不打断）；
    // 输入栏为空才显示停止键（打断）。空闲态恒发送键、按输入内容点亮。
    const hasContent = serializeInput().trim().length > 0 || pendingImages.length > 0 || pendingFiles.length > 0
    setBtnMode(turnLive && !hasContent ? 'stop' : 'send')
    const on = turnLive || (GATEWAY && gws && gws.readyState === 1 && hasContent)
    sendBtn.classList.toggle('enabled', on)
    // md 就地渲染链（mdPreviewRefresh）随 CM6 接管退役：live preview 输入即渲染，无换层刷新口
  }

  // 2026-09-12 文件占位相对化（用户定案「使用相对路径」）：[文件:<会话 cwd 相对路径>]——CLI/模型
  // Read 按会话启动根解析即得文件；落盘同轮定案改跟随会话（上传带 sid/project，网关按会话根落盘）
  // → 同会话上传+发送恒为 <配置根>/file-cache/<会话id>/<名> 的 cwd 相对形；跨会话/跨目录按 B 的 cwd
  // 相对化。Windows 大小写不敏感、\ / 通用；跨盘符无法相对 → 原样绝对路径
  // （物理上唯一正确表示）。cwd 未知（异常旧记录）同退绝对路径——不是兜底分支，是「无 cwd 就无法相对化」的诚实表示。
  function relPath(fromDir, toPath) {
    const seg = (p) => String(p).replace(/\//g, '\\').split('\\').filter((s) => s.length > 0)
    const a = seg(fromDir)
    const b = seg(toPath)
    if (a[0] && b[0] && /^[a-z]:$/i.test(a[0]) && /^[a-z]:$/i.test(b[0]) && a[0].toLowerCase() !== b[0].toLowerCase()) return toPath
    let i = 0
    while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++
    return '../'.repeat(Math.max(0, a.length - i)) + b.slice(i).join('/')
  }
  function relUploadPath(abs) {
    return sessionCwd ? relPath(sessionCwd, abs) : abs
  }


  // 依赖反转（分层治理 4A，2026-10-10）：engine 不得静态 import feature。可视区变矮后要重算的
  // 「两层消息流占位/跟随」是 chat/stage.js 的 stageSync，改由 app 启动序列经 setViewportAdapter 注入；
  // 未注入时为空操作（initViewport 之前必已注入，见 app.js 启动序列的依赖接线段）。
  // 变量名不能叫 stageSync——拼接后全模块共享同一 IIFE 作用域，会与 chat/stage.js 的 function 声明重名。
  let stageSyncFn = () => {}

  // ---------- 键盘弹出适配（v6：普通文档流 + sticky 壳，不猜不补）----------
  // 不变量（用户定案）：键盘弹出时壳体 / 侧栏 / 顶栏 / 消息流的**位置与尺寸全不变**，只有输入栏
  // 抬到键盘上沿之上（22px 内缩保留）。
  //
  // 布局边界（参照普通站点的做法，见 styles.css 键盘节）：html/body 是**普通文档流**，键盘 reveal
  // 需要滚动时由浏览器滚文档，`#app` 用 `position: sticky; top` 钉在滚动口顶部 —— 粘附在滚动机制
  // 内部拿掉位移，主线程不参与。历史三条失败路线均已退役，勿复活：
  //   ① `body{position:fixed}`：fixed 挂布局视口，WebKit 平移可视视口时整块被顶走（实测 top 0→−427）；
  //   ② 变矮 / 合成位移反向补偿：pan 由 UI 进程动画、WebContent 读到的 vv 量滞后 ⇒ 必回弹；
  //   ③ focusin 预测键盘高（记忆 / 冷启动猜高 / 保持窗）：reveal 发生与否不由输入栏位置决定，
  //      实测仍被平移，且首次冷启动无历史值——确定性补丁解决不了不确定性行为。
  // 本模块只做两件事：把**实测**的键盘上沿换成输入栏的 `--kb-lift`，以及给底栏子件量 `--bar-room`。

  // 输入栏需抬起多少（纯几何，探针直测本函数，勿复制公式）。两个入参都在**屏坐标**：
  // visibleBottom = visualViewport.height（键盘上沿在屏上的 y），naturalBottom = 输入栏自然落位底边。
  // naturalBottom 必须由调用方加回**已施加**的 lift 再传入（rect 已含该位移）：不 add-back 就会
  // 把「自己制造的上移」当成自然位置，逐帧互相抵消 ⇒ 自激振荡。
  function kbLift(visibleBottom, naturalBottom) {
    return Math.max(0, Math.round(naturalBottom - visibleBottom))
  }

  // 坐标模型可信判据（纯函数，探针直测）：只验证 scale≈1。
  // 不再要求 scrollY 与 vv.offsetTop 相等：iPadOS 的不同 Safari/WebView 版本可能把 reveal
  // 反映在布局滚动、visualViewport 平移，或两者之一上。输入栏 rect 与 vv.height 都是屏坐标，
  // 因此 lift 的几何并不需要猜是哪条滚动通道；拒绝通道不一致会让真正的 iPad 路径直接失效。
  function kbModelVerified(scale) {
    if (!isFinite(scale) || Math.abs(scale - 1) > 0.01) return false
    return true
  }

  // 弹层可用高度（纯几何，探针直测本函数，勿复制公式）：底栏上沿在 **app 内** 的布局 y − 呼吸常量。
  // barTop 由两个 rect 相减得来（底栏 rect 与 #app rect），壳体定位在哪个布局坐标里都会自动抵消，
  // 量到的恒是「底栏上沿离 app 顶边多远」；app 顶边即屏顶，故它就是屏上可用高度。
  function popRoom(barTop, margin) {
    return Math.max(0, Math.round(barTop - margin))
  }

  // 焦点是否落在输入栏内 = 键盘可能在场（只有此时才抬）。预览 iframe 内的焦点不属于输入栏，
  // 不会触发任何位移（那里键盘由页面自己处理）。
  function composerHasFocus(el) {
    const wrap = document.getElementById('input-wrap')
    return !!(wrap && el && wrap.contains(el))
  }

  // 弹层顶部呼吸余量：一并吃下「弹层底距锚点 4~10px 的 gap」+ 与可视区顶的留白（常量在量算侧，
  // 故 --bar-room 已直接是「弹层可安全占用的高度」，消费点不必各自再减间距）
  const BAR_ROOM_MARGIN = 20

  let lastSig = ''         // 上一次写入的 {lift, armed} 指纹：恒等则零写，并作为抖动收敛环的停止判据
  let settleRaf = 0
  let appliedLift = 0      // 当前已施加在输入栏上的抬升量（add-back 用，必须与 DOM 一致）
  let armed = false        // 焦点在输入栏内 = 键盘可能在场；只有此时才抬，失焦立即交还

  // 写视觉变量（同步段与延迟段共用）：读可视视口与输入栏 rect → 写 --kb-lift / kb-open。
  // 只写样式属性（唯一一次布局读取 = 输入栏 rect），返回 = 抬升 / 布防是否有变化。
  function applyGeometry() {
    const vv = window.visualViewport
    if (!vv) return false
    const verified = kbModelVerified(vv.scale)
    const wrap = document.getElementById('input-wrap')
    let lift = 0
    if (armed && wrap && verified) {
      // 读在写之前：rect 反映的是上一帧施加的 appliedLift，故加回去才是「自然落位」的底边
      lift = kbLift(vv.height, wrap.getBoundingClientRect().bottom + appliedLift)
    }
    const sig = lift + '/' + (armed ? 1 : 0)
    if (sig === lastSig) return false
    lastSig = sig
    appliedLift = lift
    document.documentElement.style.setProperty('--kb-lift', lift + 'px')
    // 键盘期关掉 0.55s 过渡：抬升必须与键盘同帧；失焦后恢复过渡，落回才有缓动
    document.body.classList.toggle('kb-open', armed)
    return true
  }

  // 同步段：与视觉变化同帧（事件回调内直调，接合可视视口上顶 / 键盘起落）
  function syncKeyboard() {
    applyGeometry()   // 同任务内先落一次（把「写完到下一帧」的空窗压到最小）
    scheduleSettle()
    wakePin()         // 再挂收敛环，续跟后续帧
  }

  // 延迟段（rAF 合帧）：弹层余量实测 + 消息流占位/跟随按新几何重算
  function settle() {
    if (settleRaf) { cancelAnimationFrame(settleRaf); settleRaf = 0 } // 直接调用时撤销在途帧，保幂等
    const vv = window.visualViewport
    if (!vv) return
    // 二次应用：事件后一帧 vv.height/滚动量可能才落定，同步段拿到的是中间态；此帧以最终值重算一次
    // （applyGeometry 幂等，值未变即零写）。
    applyGeometry()
    const wrap = document.getElementById('input-wrap')
    const app = document.getElementById('app')
    // 底栏上方可视余量（底栏子件的弹层收口唯一出口）：两个 rect 相减 = 底栏上沿在 app 内的 y，
    // app 与底栏同在一个坐标空间，差里自动抵消 ⇒ 量到的与滚动口径无关；app 顶边即屏顶，
    // 故该值直接就是「底栏上沿离屏顶多远」（含键盘在场的抬升，弹层自动跟着收）。
    if (wrap && app) {
      const barTop = wrap.getBoundingClientRect().top - app.getBoundingClientRect().top
      const barRoom = popRoom(barTop, BAR_ROOM_MARGIN)
      document.documentElement.style.setProperty('--bar-room', barRoom + 'px')
      // composer 遮罩（#composer-mask）高度基准：底栏自身布局高（offsetHeight，不含 FLIP 期间施加
      // 在 #input-wrap 上的内联 scale 变换）。多行输入 / 接管卡长高时 ResizeObserver(wrap) → settle
      // 即重量，渐隐带的上沿随之贴住底栏新上沿。隐藏态高度为 0，不写（保留上次真值，遮罩本就不可见）。
      const barH = wrap.offsetHeight
      if (barH > 0) document.documentElement.style.setProperty('--bar-h', barH + 'px')
    }
    stageSyncFn() // 可视区变矮 → 两层消息流占位/跟随按新几何重算（与 window resize 同口径）
  }

  function scheduleSettle() { if (!settleRaf) settleRaf = requestAnimationFrame(settle) }

  // 抖动收敛环（openchamber useMobileViewportPin 的 pinTracker 同法）：Safari 在键盘动画期间
  // 可能不派发 visualViewport 事件，只靠事件会让输入栏停在中间某帧。键盘在场的整段时间里逐帧复算
  // （只写样式属性 + 一次 rect 读取），几何连续 1s 不变才停 —— 键盘起落期帧帧对齐，静止期不耗电。
  let pinRaf = 0, pinTimer = 0, pinUntil = 0
  function pinTick() {
    pinRaf = 0
    // 几何变了才排量算段：#chat-scroll 是 scroll-behavior:smooth，逐帧空转的 stageSync 会给
    // 消息流反复重定滚动目标（视觉上像列表自己在弹）——没变化就不碰。
    if (applyGeometry()) { pinUntil = performance.now() + 1000; scheduleSettle() }
    if (performance.now() >= pinUntil) {
      // 已静止：降级为低频巡检（键盘仍可能在打字后长高，如候选词条增高）
      if (armed) pinTimer = setTimeout(wakePin, 250)
      return
    }
    pinRaf = requestAnimationFrame(pinTick)
  }
  function wakePin() {
    clearTimeout(pinTimer); pinTimer = 0
    pinUntil = performance.now() + 1000
    if (!pinRaf) pinRaf = requestAnimationFrame(pinTick)
  }

  // 启动注册（app.js 启动序列调用）；无 visualViewport（旧浏览器）时零行为
  function initViewport() {
    const vv = window.visualViewport
    if (!vv) return
    vv.addEventListener('resize', syncKeyboard)
    vv.addEventListener('scroll', syncKeyboard) // 缩放/平移改变可视区，同样要同帧重算
    // 布防 / 撤防：只有焦点在输入栏内才抬（键盘在场 ⇔ 焦点在输入栏），失焦立即交还。
    // 焦点在输入栏内部挪动（正文框↔附件/发送等可聚焦子件）不算撤离：relatedTarget 仍在栏内即保持。
    document.addEventListener('focusin', (e) => {
      if (!composerHasFocus(e.target)) return
      if (armed) return   // 栏内换焦点：已布防，不重来
      armed = true
      // 不预判键盘高、不抢在 reveal 前写位移：抬升只按实测 vv 收敛（`syncKeyboard` → `applyGeometry`）。
      syncKeyboard()
    }, true)
    document.addEventListener('focusout', (e) => {
      if (!composerHasFocus(e.target)) return
      if (composerHasFocus(e.relatedTarget)) return
      armed = false
      syncKeyboard()
    }, true)
    // 键盘 reveal 在 iOS 上走的是**文档滚动**（scrollY），它改变可视底 ⇒ window scroll 是几何输入，
    // 不是唤醒信号（DSHA 同口径：screen-space 量随滚动变，必须重算）。
    window.addEventListener('scroll', syncKeyboard)
    window.addEventListener('orientationchange', syncKeyboard)
    // 底栏自身「尺寸」类变化（多行长高 / 接管卡换高 / 窗口缩放的回流）同样要重量：--bar-room 取自
    // 底栏在 app 内的位置，只挂 vv 事件会漏掉这些帧。写入的只是上限变量，不回改底栏盒模型
    // → 观察者自触发一次即收敛（幂等，非回环）。
    const wrap = document.getElementById('input-wrap')
    if (wrap) {
      new ResizeObserver(scheduleSettle).observe(wrap)
      // 「位移」类变化 ResizeObserver 看不到（观察者只报尺寸）：键盘收起 --kb-lift 回 0、
      // 空态↔会话态迁移都让 #input-wrap 的 top/transform 走 0.55s 过渡，而 settle 在事件后一帧读 rect，
      // 拿到的是动画中间值 —— 此时量出的 --bar-room 是「收起前」的小值，且其后不再有任何事件重量 ⇒
      // 值被钉死，底栏子件弹层上限 min(设计上限, --bar-room) 随之永久卡小、内容被 overflow 截断。
      // 守护不变量 = --bar-room 恒对应底栏**到位**后的位置；过渡结束即到位，故此刻重量一次。
      // 只听 end：中断（transitioncancel）只会由新的 --kb-lift/几何改动引起，那条路已各自排了 settle。
      wrap.addEventListener('transitionend', (e) => { if (e.target === wrap) scheduleSettle() })
    }
    syncKeyboard()
    settle() // 启动首帧也立即对齐（启动无在途动画，不必等下一帧）
  }
function setViewportAdapter(a) { stageSyncFn = a.syncStage }
  function initGateway() {
    gatewayCss()
    // 连接状态徽章已改为 Floria 品牌名后的浅灰小字（index.html #floria-conn），不再动态建 #conn-badge。
    // 空态图标不隐藏：进会话时的隐藏由 #chat-area.in-session 的 CSS 承担，
    // 永久 display:none 会让首页图标只在网关检测完成前瞬间可见、刷新即消失。
    // 输入区启用/占位/输入监听已随 CM6 接管归 composer-cm.js（updateListener 汇流 syncGwSend + onInputMention）
    composerPlaceholder('输入消息，Enter 发送')
    setConn(false, '连接中…')
    // 2026-08-28 token 出 URL：统一先 connect()——已授权设备（floria_auth cookie）WS 直接通过进空态；
    // 未授权（无 cookie 无首链 token）WS 被拒 → onclose 回 token 门。REVIEW 模式仍要求 URL 带 token。
    if (GATEWAY_REVIEW) { if (gToken) connect(); else showGate() }
    else connect()
    gwSendPort.syncGwSend()
  }

  async function detectGateway() {
    try {
      const res = await fetch('/gateway/health')
      if (!res.ok) return
      const d = await res.json()
      if (d.mode === 'gateway') GATEWAY = true
      if (d.review) GATEWAY_REVIEW = true
      if (d.hotReload) HOT_RELOAD = true
      if (typeof d.boot === 'number') gwBoot = d.boot
    } catch { /* 非网关环境（静态托管）忽略 */ }
  }

function setGateAwait(v) { gateAwait = v }
function setGateVerified(v) { gateVerified = v }
function forceWsReconnect() {
  clearTimeout(reconnectTimer)
  if (gws) { try { gws.close() } catch { /* 已断忽略 */ } }
}
function setGatewayPorts(p) { gwApproval = p.approval; gwSendPort = p.send; gwMention = p.mention }
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

  const RAIL_PROMPT_MAX = 50 // 预览提示词封顶（与 dsh 一致）
  const RAIL_RESP_MAX = 120 // 预览回复封顶
  const RAIL_ACTIVE_BAND = 0.4 // 视口上 40% 带内最后一个锚 = 当前轮
  const RAIL_NARROW = 640 // 窄于此宽隐藏刻度（手机竖屏；平板竖屏 768–834 保留）
  const RAIL_BUILD = 'rail-t5-2026.10.05' // 构建标记：dataset.build 可核验跑的是哪版
  const RAIL_TOUCH_GUARD = 600 // 触屏后忽略「兼容鼠标 hover」事件的窗口（ms）——webkit 触摸完必补发一条 pointermove:mouse

  let railItems = [] // [{ key, el, prompt, response }]（文档序）
  let railKeys = '' // 结构指纹（各轮 key 拼接）：变化才重建刻度
  let railActiveIdx = -1
  let railPreviewKey = null // 预览锚定轮次 key（跨重建保稳）
  let railTimer = null
  let railLastTick = 0
  let railPtrTouch = false // 最近一次 pointerdown 的真实指针类型（click.pointerType 在 webkit 恒 mouse，不可用）
  let railTouchAt = 0 // 最近一次触屏交互时刻：用于屏蔽紧随其后的兼容鼠标 hover 事件
  let railScrub = false // 触屏滑动进行中（pointerdown 起、pointerup 止）

  // 元素正文（优先 .body，滤掉 who/图片/文件标签文本）
  function railText(el) {
    const body = el.querySelector('.body') || el
    return String(body.textContent || '').replace(/\s+/g, ' ').trim()
  }
  function railClip(s, max) {
    return s.length > max ? s.slice(0, max) + '…' : s
  }

  // 采集已提交轮次：锚=[data-t="u"][data-m]（data-m 排除 #live-zone 乐观气泡）；回复=其后同轮
  // 最后一个非空 [data-t="a"]。轮次<2 由调用方隐藏。
  function railCollect() {
    const out = []
    if (!messagesEl) return out
    const seq = messagesEl.querySelectorAll('[data-t="u"][data-m], [data-t="a"][data-m]')
    let cur = null
    for (const el of seq) {
      if (el.closest('#live-zone')) continue
      if (el.getAttribute('data-t') === 'u') {
        cur = { key: el.getAttribute('data-m'), el, prompt: railClip(railText(el), RAIL_PROMPT_MAX), response: '' }
        out.push(cur)
      } else if (cur) {
        const t = railClip(railText(el), RAIL_RESP_MAX)
        if (t) cur.response = t
      }
    }
    return out
  }

  // nav 单例：动态创建（index.html 不用改），追加到**会话卡 #session-card**——它是 chat 的组件，
  // 必须与会话卡同生共死。#chat-area 卡片化后是共享槽，切到管理/预览卡时只隐藏会话卡、挂在槽上的
  // 野兄弟不受影响（z-index 7 会压在别的卡上 = 串卡）。
  function railNav() {
    let nav = document.getElementById('turn-rail')
    if (nav && nav.isConnected) return nav
    const host = document.getElementById('session-card')
    if (!host) return null
    nav = document.createElement('nav')
    nav.id = 'turn-rail'
    nav.className = 'turn-rail'
    nav.dataset.build = RAIL_BUILD
    nav.setAttribute('aria-label', '轮次导航')
    nav.hidden = true
    nav.innerHTML = '<div class="tr-scroller"><div class="tr-marks"></div></div>'
      + '<div class="tr-preview" hidden><div class="tr-prompt"></div><div class="tr-resp" hidden></div></div>'
    host.appendChild(nav)
    railBind(nav)
    return nav
  }

  // 手指坐标下的刻度（触屏 implicit pointer capture：pointermove 的 e.target 恒为起手刻度，
  // 必须用 elementFromPoint 取手指当前压住的刻度）。
  function railMarkAt(nav, x, y) {
    const el = document.elementFromPoint(x, y)
    const m = el && el.closest ? el.closest('.tr-mark') : null
    return m && nav.contains(m) ? m : null
  }

  // 轨道不滚动（刻度 flex 均分压进一屏），滑动纯逐格预览、不产生任何轨道位移。

  function railBind(nav) {
    // 真实指针类型只看 pointerdown（capture）：click.pointerType 在 webkit 恒 mouse，判不出触屏。
    // 触屏起手即进入滑动态并亮起指下刻度的预览。
    nav.addEventListener('pointerdown', (e) => {
      railPtrTouch = e.pointerType === 'touch'
      if (!railPtrTouch) return
      railTouchAt = Date.now()
      railScrub = true
      const m = e.target.closest ? e.target.closest('.tr-mark') : null
      if (m) railSetPreview(nav, m.dataset.key)
    }, true)
    // 鼠标悬停唤卡：pointermove + pointerover 双触发（刻度重建/内容刷新后光标静止其上，pointerover 仍能唤出）。
    // 触屏走滑动分支。另须屏蔽触屏后紧接的兼容鼠标事件：webkit 触摸完必补发一条 pointerType=mouse 的
    // pointermove（实测 …pointerup:touch → click:mouse → pointermove:mouse），不挡会在跳转后又把预览卡亮回来。
    const onHover = (e) => {
      if (e.pointerType === 'touch' || railScrub) return
      if (Date.now() - railTouchAt < RAIL_TOUCH_GUARD) return
      const m = e.target.closest ? e.target.closest('.tr-mark') : null
      if (m) railSetPreview(nav, m.dataset.key)
    }
    nav.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch') { onHover(e); return }
      if (!railScrub) return
      const m = railMarkAt(nav, e.clientX, e.clientY)
      if (m) railSetPreview(nav, m.dataset.key) // 手指不在刻度上时保留上一格（滑过空隙不闪断）
    })
    nav.addEventListener('pointerover', onHover)
    // 鼠标离开轨收起预览；触屏的 pointerleave（pointerup 后补发）不收——触屏卡由「松开/点轨外」收。
    nav.addEventListener('pointerleave', (e) => { if (e.pointerType === 'touch') return; railSetPreview(nav, null) })
    // 触屏松开 = 跳到当前预览轮（滑动手势的落点）。
    nav.addEventListener('pointerup', (e) => {
      if (e.pointerType !== 'touch' || !railScrub) return
      railScrub = false
      const key = railPreviewKey
      if (key != null) { railSetPreview(nav, null); railJump(key) }
    })
    // 手势被系统打断（来电/多指等）＝取消，不跳。
    nav.addEventListener('pointercancel', (e) => {
      if (e.pointerType !== 'touch') return
      railScrub = false
      railSetPreview(nav, null)
    })
    nav.addEventListener('click', (e) => {
      if (railPtrTouch) return // 触屏跳转已由 pointerup 完成，忽略 webkit 补发的兼容 click
      const m = e.target.closest ? e.target.closest('.tr-mark') : null
      if (m) railJump(m.dataset.key)
    })
    // 点轨外任意处收回预览卡（鼠标 pointerleave 已收；触屏起手在轨外时须显式收）。
    document.addEventListener('pointerdown', (e) => {
      if (nav.contains(e.target)) return
      railSetPreview(nav, null)
    }, true)
  }

  // 当前轮：视口上 RAIL_ACTIVE_BAND 带内最后一个锚
  function railActiveFromScroll() {
    const sc = document.getElementById('chat-scroll')
    if (!sc || !railItems.length) return -1
    const band = sc.scrollTop + sc.clientHeight * RAIL_ACTIVE_BAND
    let idx = 0
    for (let i = 0; i < railItems.length; i++) {
      if (topInScroll(railItems[i].el) <= band) idx = i
      else break
    }
    return idx
  }

  function railPreviewIndex() {
    return railPreviewKey == null ? -1 : railItems.findIndex((it) => it.key === railPreviewKey)
  }

  // 只标态（不整重建）——滚动/预览/内容刷新都走此路。轨道不滚动，无「保持刻度可见」位移逻辑。
  function railPaint(nav) {
    const marks = nav.querySelectorAll('.tr-mark')
    const pIdx = railPreviewIndex()
    marks.forEach((m, i) => {
      m.classList.toggle('tr-active', i === railActiveIdx)
      m.classList.toggle('tr-hot', i === pIdx) // 注意：类名不可用 tr-preview——那是预览卡自己的类，撞名会让刻度按钮命中卡片样式
    })
  }

  // 刻度 DOM 仅在轮次集合变化时重建；建完不 paint（由 railRefresh 统一 paint）
  function railRender(nav, items) {
    const marks = nav.querySelector('.tr-marks')
    marks.textContent = ''
    items.forEach((it, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'tr-mark'
      b.dataset.key = it.key
      b.setAttribute('aria-label', `跳到第 ${i + 1} 轮`)
      marks.appendChild(b)
    })
  }

  // 预览卡：内容 + 垂直居中于该刻度（钳在轨内）
  function railShowPreview(nav, key) {
    const pv = nav.querySelector('.tr-preview')
    const idx = key == null ? -1 : railItems.findIndex((it) => it.key === key)
    const marks = nav.querySelectorAll('.tr-mark')
    if (idx < 0 || !marks[idx]) { pv.hidden = true; return }
    const item = railItems[idx]
    pv.hidden = false
    pv.querySelector('.tr-prompt').textContent = item.prompt || `第 ${idx + 1} 轮`
    const resp = pv.querySelector('.tr-resp')
    resp.textContent = item.response || ''
    resp.hidden = !item.response
    const scroller = nav.querySelector('.tr-scroller')
    const center = marks[idx].offsetTop + marks[idx].offsetHeight / 2 - scroller.scrollTop
    const ph = pv.offsetHeight
    const maxTop = Math.max(0, scroller.clientHeight - ph)
    pv.style.top = Math.max(0, Math.min(maxTop, center - ph / 2)) + 'px'
  }

  function railSetPreview(nav, key) {
    if (key === railPreviewKey) { railShowPreview(nav, railPreviewKey); return }
    railPreviewKey = key
    railPaint(nav)
    railShowPreview(nav, key)
  }

  function railJump(key) {
    const idx = railItems.findIndex((it) => it.key === key)
    const item = railItems[idx]
    if (!item) return
    const sc = document.getElementById('chat-scroll')
    if (!sc) return
    stage.yielded = true // 用户导航=接管视口，停止 stage 跟随（同滚动输入）
    sc.scrollTo({ top: topInScroll(item.el), behavior: 'smooth' })
    railActiveIdx = idx
    const nav = document.getElementById('turn-rail')
    if (nav) railPaint(nav)
  }

  function railRefresh() {
    const nav = railNav()
    if (!nav) return
    const area = document.getElementById('chat-area')
    const inSession = !!area && area.classList.contains('in-session') && !area.classList.contains('work')
    railItems = railCollect()
    if (!inSession || railItems.length < 2 || window.innerWidth <= RAIL_NARROW) {
      nav.hidden = true
      railKeys = ''
      railActiveIdx = -1
      railPreviewKey = null
      railShowPreview(nav, null)
      return
    }
    nav.hidden = false
    const keys = railItems.map((it) => it.key).join('\u0001')
    if (keys !== railKeys) {
      railKeys = keys
      railRender(nav, railItems) // 只有轮次集合变了才销毁重建刻度
    }
    railActiveIdx = railActiveFromScroll()
    railPaint(nav)
    railShowPreview(nav, railPreviewKey) // 内容刷新时同步预览文本（刻度未动，光标不移也不丢卡）
  }

  // 变更驱动：#messages 整页重建/增量 append/流式文本 → 节流重算。
  // 用节流而非 debounce：连续流式下 mutation 间隔 < 阈值，debounce 会一直重置、轨道定型不动；
  // 节流保证每 ~150ms 至少刷一次，且因「结构未变不重建」，刷新本身零刻度抖动。
  function railSchedule() {
    if (railTimer != null) return
    const wait = Math.max(0, 150 - (Date.now() - railLastTick))
    railTimer = setTimeout(() => {
      railTimer = null
      railLastTick = Date.now()
      railRefresh()
    }, wait)
  }

  const railObs = new MutationObserver(railSchedule)

  function railInit() {
    const nav = railNav()
    if (!nav) return
    if (messagesEl) railObs.observe(messagesEl, { childList: true, subtree: true, characterData: true })
    const sc = document.getElementById('chat-scroll')
    if (sc) {
      let ticking = false
      sc.addEventListener('scroll', () => {
        if (ticking) return
        ticking = true
        requestAnimationFrame(() => {
          ticking = false
          const n = document.getElementById('turn-rail')
          if (!n || n.hidden || !railItems.length) return
          const idx = railActiveFromScroll()
          if (idx === railActiveIdx) return
          railActiveIdx = idx
          railPaint(n)
        })
      }, { passive: true })
    }
    window.addEventListener('resize', railRefresh)
    railRefresh()
  }
  railInit()

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
})()
