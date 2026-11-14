// 外部卡运行时 + 应用目录 + 浮窗动作表（2026-10-10 分层治理 Phase 5 自 engine/registry.js 拆出）
// 职责：所有「项目/工作区根申报」的运行时数据与生命周期——EXT（项目外部卡表）、APP_TABS（已启用应用
// tab）、QACTIONS（项目申报浮窗动作）、三者共同的 floria-ui-v1 缓存快照（extDecls 分表）。
// 与 engine/registry.js 的分界：registry 只做「卡表编排 + 槽位切换」的第一方契约，本件只做外部申报的
// 取回/校验结果落表/缓存读写，**不认识 CARDS、不做槽位**——两张表在 registry 的查询点合流
// （cardOf / renderMgrTabs 经下方 extTabs()/appTabs() 只读取用）。依赖方向单向：registry → 本件，
// 本件不 import registry（表变更后的重渲经 setTabRefresh 注入的回调触发，同 setExtCardRenderer 手法）。

import { iconBaseFor } from '../core/icon-spec.js'
import { gToken } from './gateway.js'
import { patchUI, readUI } from '../core/storage.js'
import { normExtCards, normQuoteActions } from './ext-decl.js'
/* @module engine/ext-runtime.js */

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
        // icon 原值透传（表键或 preview 内相对图片路径），渲染收口 core/icon-spec.js 的 iconHtml
        icon: c.icon,
        iconBase: iconBaseFor(label, c.path),
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
    // 启用态变了 ⇒ 依赖「卡启用」的自声明能力（@ 元素清单等）同拍作废缓存。
    try { window.dispatchEvent(new CustomEvent('floria-cards-changed', { detail: { label: GLOBAL_LABEL } })) } catch {}
    return isAppEnabled(id)
  }
  // 目录 → 侧栏 tab（只取已启用者）。id 加 `app:` 前缀，与第一方裸词 id、EXT 的 `ext:` 零撞车。
  function applyAppTabs() {
    APP_TABS = APP_CATALOG.filter((c) => c.enabled !== false).map((c) => ({
      id: `app:${c.id}`,
      title: c.title,
      tip: `${c.title} · 应用（工作区根）`,
      icon: c.icon,
      iconBase: iconBaseFor(GLOBAL_LABEL, c.path),
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

export {
  appCatalog,
  appTabs,
  clearExtCards,
  clearQuoteActions,
  extLabel,
  extTabs,
  globalLabel,
  hydrateExtCardId,
  hydrateExtCards,
  isAppEnabled,
  isGlobalLabel,
  quoteActions,
  registerExtCards,
  registerQuoteActions,
  setAppEnabled,
  setExtCardRenderer,
  setTabRefresh,
  syncGlobalPlugins,
}
