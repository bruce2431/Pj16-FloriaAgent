// 插件卡（管理视图「插件」tab：顶层三态 插件 / 技能 / 应用）（2026-10-01 卡片化：自 sidebar/mgr.js 迁出；
// 2026-10-10 增「应用」kind——工作区根申报的界面单元，点 + 启用；唯一手改处，web/app.js 为生成物）
// 2026-10-30 列表改 Codex 风格：动作位统一细线图标（未安装 + / 已安装 ✓），点整卡进入卡内详情页。
// 2026-11-01 页面壳/搜索/分类/卡片/动作位/详情头抽进 @floria/web 的 mgr 组件族（core/mgr-ui.js 接缝）：
// 本卡只提供数据、过滤与启停，结构一律由包渲染；禁止在卡内复刻 mgr 结构与样式。

import { I } from '../../../core/icons.js'
import { MgrUI } from '../../../core/mgr-ui.js'
import { state } from '../../../engine/state.js'
import { esc, toast } from '../../../core/util.js'
import { saveMgrView } from '../../../core/storage.js'
import { MGR, MGR_ERR, MGR_LOADING, loadMgrData } from '../../../sidebar/mgr-data.js'
import { registerCard } from '../../../engine/registry.js'
import { appCatalog, globalLabel, isAppEnabled, setAppEnabled, syncGlobalPlugins } from '../../../engine/ext-runtime.js'
import { apiUrl } from '../../../engine/gateway.js'
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
      onAction(key) { toggleApp(key) },
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

  // 插件/技能行：{n 名称, d 描述, v 版本, inst 是否已安装}；动作位是纯状态指示（点击落到卡身、进详情）。
  function pluginItem(x) {
    return {
      key: x.n,
      name: x.n,
      desc: x.d || '暂无描述',
      action: { on: !!x.inst, title: x.inst ? '已安装' : '未安装' },
    }
  }

  // 应用启停：启用态只影响本网格（侧栏 tab 由 setAppEnabled 内 renderMgrTabs 刷新）；详情页内切换则整页重渲。
  function toggleApp(key) {
    if (!key) return
    setAppEnabled(key, !isAppEnabled(key))
    if (MGR_DETAIL) { if (PLUGINS_CTX) PLUGINS_CTX.rerender(); return }
    renderMgrGrid()
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
    return {
      kind, key, ico: '', color: MgrUI.color(x.n), initial: (x.n[0] || '?').toUpperCase(),
      name: x.n, desc: x.d || '', ver: x.v || '', inst: !!x.inst,
      typeLabel: isSkill ? '技能' : '插件',
      sourceLabel: personal ? '本地已安装' : '公开市场',
      path: personal ? `.claude/${isSkill ? 'skills' : 'plugins'}/${x.n}` : '',
      installedLabel: x.inst ? '已安装' : '未安装',
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
    // 详情头动作位：应用 = 真开关（key = appId）；插件/技能 = 状态指示（无 key，不可点）。
    const action = it.appId
      ? { on: it.inst, key: it.appId, title: it.inst ? '已启用（点击停用）' : '未启用（点击启用）' }
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
      onAction(key) { toggleApp(key) },
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

export {
  pluginsCardDef,
}
