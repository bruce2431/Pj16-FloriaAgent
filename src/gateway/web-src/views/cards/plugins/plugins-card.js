// 插件卡（管理视图「插件」tab：顶层三态 插件 / 技能 / 应用）（2026-10-01 卡片化：自 sidebar/mgr.js 迁出；
// 2026-10-10 增「应用」kind——工作区根申报的界面单元，点 + 启用；唯一手改处，web/app.js 为生成物）
// 2026-10-30 列表改 Codex 风格：动作位统一细线图标（未安装 + / 已安装 ✓），点整卡进入卡内详情页。
// 2026-11-01 页面壳/搜索/分类/卡片/动作位/详情头抽进 @floria/web 的 mgr 组件族（core/mgr-ui.js 接缝）：
// 本卡只提供数据、过滤与启停，结构一律由包渲染；禁止在卡内复刻 mgr 结构与样式。

import { I } from '../../../core/icons.js'
import { MgrUI } from '../../../core/mgr-ui.js'
import { state } from '../../../engine/state.js'
import { toast } from '../../../core/util.js'
import { saveMgrView } from '../../../core/storage.js'
import { MGR, MGR_ERR, MGR_LOADING, loadMgrData } from '../../../sidebar/mgr-data.js'
import { registerCard } from '../../../engine/registry.js'
import { cardBus } from '../../../engine/card-bus.js'
import { navigate } from '../../../chat/route.js'
import { appCatalog, isAppEnabled, setAppEnabled } from '../../../engine/ext-runtime.js'
import { apiUrl } from '../../../engine/gateway.js'
import {
  cachedRepoVersion,
  ensureRepoVersion,
  fillVersionRow,
  renderRepoIntro,
  repoRowHtml,
} from '../../../feature/card-repo.js'
/* @module views/cards/plugins/plugins-card.js */
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

  // 卡公开 API（@ 插件/技能 chip 的跳转落点）：openDetail{name} = 打开该条目的详情页。
  // 名字命中顺序固定（插件先于技能、个人先于公开）——令牌不区分插件与技能，顺序即语义。
  // 全局清单里没有 → 抛错（调用方据此回落到当前项目的 work 插件页）。
  cardBus.registerInlineCard({
    instanceId: 'floria-plugins',
    ns: 'floria-plugins',
    cmds: ['openDetail'],
    handlers: { openDetail: (a) => openPluginDetailByName(a && a.name) },
  })

  function findMgrEntry(name) {
    for (const kind of ['plugins', 'skills']) {
      const groups = (MGR && MGR[kind]) || {}
      for (const cat of ['personal', 'public']) {
        const arr = groups[cat]
        if (!Array.isArray(arr)) continue
        const row = arr.find((x) => x && x.n === name)
        if (row) return { kind, cat }
      }
    }
    return null
  }

  // 完成信号 = loadMgrData 返回；先落视图态（kind/cat）再导航——route 的 loadMgrView 会按持久化态重建，
  // 故 saveMgrView 必须先于 navigate。已在该页时只重渲（不重建壳）。
  async function openPluginDetailByName(name) {
    const n = String(name || '').trim()
    if (!n) throw new Error('缺少插件名称')
    await loadMgrData(false)
    const hit = findMgrEntry(n)
    if (!hit) throw new Error('未找到插件/技能：' + n)
    state.mgrView.kind = hit.kind
    state.mgrView.cat = hit.cat
    state.mgrView.q = ''
    saveMgrView()
    MGR_DETAIL = { kind: hit.kind, key: n }
    if (state.mgr !== 'plugins') navigate('#mgr/plugins')
    if (PLUGINS_CTX) PLUGINS_CTX.rerender()
    return { kind: hit.kind, name: n }
  }

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
      const on = isAppEnabled(a.id)
      return {
        kind, key, ico: I[a.icon] || '', color: MgrUI.color(a.id), initial: (a.title[0] || '?').toUpperCase(),
        name: a.title, desc: '', ver: cachedRepoVersion(a.repo), inst: on,
        typeLabel: '应用', sourceLabel: '工作区根 .claude/preview 申报',
        app: a, installedLabel: on ? '已启用' : '未启用',
        repo: a.repo || '',
      }
    }
    const v = state.mgrView
    const src = (MGR && MGR[kind] && MGR[kind][v.cat]) || []
    const x = src.find((r) => r.n === key)
    if (!x) return null
    const isSkill = kind === 'skills'
    const personal = v.cat === 'personal'
    // 个人行带 k（目录名）= 可启停；状态语义从「已安装」换成「已启用/已停用」。
    const toggleable = !!x.k
    const enabled = toggleable ? x.en !== 0 : !!x.inst
    const repo = x.repo || ''
    // sub = 市场条目的仓库内子目录（git-subdir / 市场自带 ./plugins/x）；README 取子目录里的那份。
    const sub = x.sub || ''
    return {
      kind, key, ico: '', color: MgrUI.color(x.n), initial: (x.n[0] || '?').toUpperCase(),
      name: x.n, desc: x.d || '', ver: sub ? '' : (cachedRepoVersion(repo) || x.v || ''), inst: enabled, toggleable,
      repo, sub,
      typeLabel: isSkill ? '技能' : '插件',
      sourceLabel: personal ? '本地已安装' : '公开市场',
      path: personal ? `.claude/${isSkill ? 'skills' : 'plugins'}/${x.k || x.n}` : '',
      installedLabel: toggleable ? (enabled ? '已启用' : '已停用') : (x.inst ? '已安装' : '未安装'),
    }
  }

  function renderMgrDetail(body, ctx) {
    const it = detailItem()
    if (!it) { MGR_DETAIL = null; return renderMgrPlugins(body, ctx) }
    // 应用卡片只留「类型 / 版本 + 上游仓库」；状态、来源与位置不展示（用户定案）。
    const info = [['类型', it.typeLabel]]
    if (!it.app) info.push(['来源', it.sourceLabel])
    info.push(['版本', it.ver || '—'])
    if (!it.app) {
      info.push(['状态', it.installedLabel])
      if (it.path) info.push(['位置', it.path])
    }
    // 详情头动作位：应用 = 真开关（key = 应用 id）；个人插件/技能 = 真开关（key = 名称）；
    // 公开市场条目 = 纯状态指示（无 key，不可点）。
    const action = it.app
      ? { on: it.inst, key: it.key, title: it.inst ? '已启用（点击停用）' : '未启用（点击启用）' }
      : it.toggleable
        ? { on: it.inst, key: it.name, title: it.inst ? '已启用（点击停用）' : '已停用（点击启用）' }
        : { on: it.inst, title: it.installedLabel }
    MgrUI.detail(body, {
      typeLabel: it.typeLabel,
      name: it.name,
      sub: it.app ? it.typeLabel : `${it.typeLabel} · ${it.sourceLabel}`,
      icon: it.ico,
      color: it.color,
      initial: it.initial,
      action,
      desc: it.desc,
      info,
      extraHtml: repoRowHtml(it.repo),
      onBack() { MGR_DETAIL = null; ctx.rerender() },
      onAction(key) { if (it.app) toggleApp(key); else toggleCustomization(it.kind, key) },
      onMounted(host) {
        const live = it
        // 介绍排在信息表下方：有上游仓库时渲染 README，否则回退卡片自带 desc。
        renderRepoIntro(host, live.repo, live.desc, live.sub)
        if (!live.repo || live.sub) return
        fillVersionRow(host, live.repo)
        ensureRepoVersion(live.repo, () => {
          if (MGR_DETAIL && MGR_DETAIL.key === live.key) fillVersionRow(host, live.repo)
        })
      },
    })
  }

export {
  pluginsCardDef,
}
