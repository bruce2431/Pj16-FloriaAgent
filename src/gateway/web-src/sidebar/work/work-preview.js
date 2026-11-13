import { isTempProjLabel } from '../../core/util.js'
import { activePreviewFrame, enabledPreviewCardsFor, setPreviewActiveHook, setRailExtItems, takePendingCardPayload, warmProjectBackend } from '../../feature/preview-frame.js'
import { renderRailExt } from '../rail-ext.js'
// 右栏预览与工具页态：预览帧挂载 renderWorkPreview / 页态唯一写口 setPvPane（setPvTab 与侧栏 api setPane('workspace') 是它的入口）/ 顶栏「工具栏」胶囊（#wk-tb-tool）+ tab 条渲染。（拆自 sidebar/work.js，纯搬迁零行为变更；符号经单 IIFE 共享作用域可见）
/* @module sidebar/work/work-preview.js */

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
  // 右缘抽屉把手只在栏不在场时显示（插件图标 +「工具栏」，点它开栏）；栏在场时把手整体不渲染——
  // 收起不走按钮，只靠把分界条拖窄到收敛阈值（见 work-assist.js bindGutter）。
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
  // 「工具栏」胶囊 #wk-tb-tool，work-files.js）——不另立链路，故两条入口行为必然同源。
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
    const was = state.wkPreview
    state.wkPreview = !!on
    // 列宽状态不跨开合：关闭即清零回默认，打开（关→开）也写一次——两边都成立才算「打开必是默认大小」。
    if (!on) {
      state.wkPrevW = wkDefaultPrevW()
      state.wkPvTab = ''
    } else {
      if (!was) state.wkPrevW = wkDefaultPrevW()
      if (page !== undefined) state.wkPvTab = page === '' ? '' : wkToolNormId(page)
    }
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

