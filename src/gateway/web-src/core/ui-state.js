// 界面状态纯数据（2026-10-10 自 engine/state.js 下移为 core 叶子）：无依赖的对象字面量，供任意层读写。
// 原先 core/{char,util,storage} 直连 engine/state.js 取 state ⇒ 3 条 core→engine 逆向边；state 下沉为
// core 叶子后这些边归 core→core。engine/state.js 转出本模块的 state（全库 import 路径零改）。
// 唯一手改处，web/app.js 为生成物。

/* @module core/ui-state.js */
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

export { state }
