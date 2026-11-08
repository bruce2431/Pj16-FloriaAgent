// work 插件页（下沉区第三态，入口 = 侧栏 tab 行第三枚「插件」，与 chat 侧栏插件 tab 同位）：管理**项目自己的**插件 / 技能 / 应用
// （2026-11-07 用户定案：不在侧栏渲染——侧栏太窄，mgr 栅格在下沉区才够宽）。
// 结构与样式一律走 @floria/web 的 mgr 组件族（core/mgr-ui.js），本件只提供数据、过滤与启停：
//   - 插件 / 技能：项目根 .claude/{plugins,skills} 的已安装个人项，启停 = 目录内 .disabled（同一端点）。
//   - 应用：项目 .claude/preview/<id>/card.json 的预览卡（含停用卡），启停 = 卡目录 .disabled，
//     直接决定 work 右栏工具栏的预览页签与「打开工具栏即拉起哪些卡服务器」。
// 无公开市场：项目侧只列已安装项，cat 恒「个人」。

import { I } from '../../core/icons.js'
import { MgrUI } from '../../core/mgr-ui.js'
import { toast } from '../../core/util.js'
import { apiUrl } from '../../engine/gateway.js'
import { state } from '../../engine/state.js'
import { loadProjectPlugins } from '../mgr-data.js'
import { ensurePreviewDecls, previewCardsFor, previewCardsReadyFor, previewLegacyIndexCard } from '../../feature/preview-frame.js'
import { renderWkToolTabs } from '../work-tools.js'
import { cardBus } from '../../engine/card-bus.js'
import { cachedRepoVersion, ensureRepoVersion, fillVersionRow, renderRepoIntro, repoRowHtml } from '../../feature/card-repo.js'

/* @module sidebar/work/work-plugins.js */

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
  let WPL_PROMISE = null // 在途加载（ensureWplData 返回它：调用方可等清单落地再查条目）
  let WPL_APPS_WAIT = '' // 已发起卡表申报请求的 label（只防重复挂 then 链）

  // 卡公开 API（@ 插件/技能 chip 的项目侧兜底落点）：openDetail{name} = 切到插件页并打开该条目详情。
  cardBus.registerInlineCard({
    instanceId: 'floria-work-plugins',
    ns: 'floria-work-plugins',
    cmds: ['openDetail'],
    handlers: { openDetail: (a) => openWorkPluginDetail(a && a.name) },
  })

  async function openWorkPluginDetail(name) {
    const n = String(name || '').trim()
    if (!n) throw new Error('缺少插件名称')
    const label = state.workProj
    if (!label) throw new Error('没有工作项目')
    // 先让插件页挂进下沉区（applyPanes → mountWorkPlugins 设 WPL_LABEL 并起加载），再等清单落地查条目。
    state.wkMainTab = 'plugins'
    state.wkAssist = true
    state.wkAssistMode = 'side'
    applyPanes()
    await ensureWplData(label)
    for (const kind of ['plugins', 'skills']) {
      const hit = wplRows(kind).find((r) => r && r.n === n)
      if (!hit) continue
      WPL_VIEW.kind = kind
      WPL_VIEW.q = ''
      WPL_DETAIL = { kind, key: n }
      renderWpl()
      return { kind, name: n }
    }
    throw new Error('项目里没有该插件/技能：' + n)
  }

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

  // 插件/技能清单（项目维度）：返回 Promise（在途复用同一份）——openWorkPluginDetail 要等清单落地才能查条目。
  function ensureWplData(label, force) {
    if (WPL_LOADING) return WPL_PROMISE || Promise.resolve(WPL_DATA)
    if (!force && WPL_DATA.loaded) return Promise.resolve(WPL_DATA)
    WPL_LOADING = true
    WPL_DATA.loading = true
    WPL_DATA.err = ''
    renderWplGrid()
    WPL_PROMISE = loadProjectPlugins(label)
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
        WPL_PROMISE = null
        if (WPL_LABEL === label) renderWpl()
      })
    return WPL_PROMISE
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
        ver: legacy ? '' : cachedRepoVersion(c.repo || ''),
        enabled: c.enabled,
        typeLabel: '应用',
        sourceLabel: legacy ? '项目传统预览页' : '项目 .claude/preview 卡片',
        path: legacy ? '.claude/preview/index.html' : `.claude/preview/${c.id}`,
        // 上游仓库只属于 card.json 卡片（传统单页没有卡片元信息，不展示）
        card: legacy ? null : c,
        repo: legacy ? '' : (c.repo || ''),
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
      // sub = 市场条目的仓库内子目录（git-subdir / 市场自带 ./plugins/x）：README 取子目录那份，仓库级版本不适用。
      ver: x.sub ? '' : (cachedRepoVersion(x.repo) || x.v || ''),
      repo: x.repo || '',
      sub: x.sub || '',
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
    // 应用卡片只留「类型 / 版本 + 上游仓库」；状态、来源与位置不展示（用户定案）。
    const info = [['类型', it.typeLabel]]
    if (it.kind !== 'apps') info.push(['来源', it.sourceLabel])
    info.push(['版本', it.ver || '—'])
    if (it.kind !== 'apps') {
      info.push(['状态', it.enabled ? '已启用' : '已停用'])
      info.push(['位置', it.path])
    }
    MgrUI.detail(body, {
      typeLabel: it.typeLabel,
      name: it.name,
      sub: it.kind === 'apps' ? it.typeLabel : `${it.typeLabel} · ${it.sourceLabel}`,
      icon: it.ico,
      color: it.color,
      initial: it.initial,
      action: { on: it.enabled, key: it.key, title: it.enabled ? '已启用（点击停用）' : '未启用（点击启用）' },
      desc: it.desc,
      info,
      extraHtml: repoRowHtml(it.repo),
      onBack() { WPL_DETAIL = null; renderWpl() },
      onAction() { if (it.kind === 'apps') toggleWplApp(it.key); else toggleWplCustom(it.kind, it.key) },
      onMounted(host) {
        // 介绍排在信息表下方：有上游仓库时渲染 README，否则回退卡片自带 desc。
        renderRepoIntro(host, it.repo, it.desc, it.sub)
        if (!it.repo || it.sub) return
        fillVersionRow(host, it.repo)
        ensureRepoVersion(it.repo, () => {
          if (WPL_DETAIL && WPL_DETAIL.key === it.key) fillVersionRow(host, it.repo)
        })
      },
    })
  }

export {
  mountWorkPlugins,
}
