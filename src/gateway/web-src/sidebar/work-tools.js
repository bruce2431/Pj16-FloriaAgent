// work 工具页注册表（2026-10-07，参考 Prism；2026-10-12 单链路：开合归胶囊、页态归本 tab 条）：
// work 右栏（#work-preview）顶部水平标签栏的登记处。**右栏开/关 = 顶栏胶囊直调侧栏 api
// setPane('workspace', on)（唯一动作，见 work-mount.js）**；**显示哪一页 = 本 tab 条**
// （预览页签只在项目确有可视预览时出现，其后是已注册工具）；active 与页态共用一个状态源 state.wkPvTab
// （'' = 预览页，工具 id = 工具页）。右栏在场时 tab 条常驻（applyPvTab 按 wkPreview 显隐）。
// 任何模块可调 registerWkTool({ id, title, pane, mount }) 挂一枚工具 tab——本表只做「注册 → 按序渲 tab →
// 交调用方切内容」，不写任何工具内容（与 engine/registry.js 视图卡同思路）。
//   内置：'comments' 评论（views/cards/comment/comment-card.js 自注册，渲染进 #wk-cmt）；外部注册 = 任意模块调
//   registerWkTool 追加，注册序即 tab 序。
// 契约：tab = <button class="wk-pv-tab" data-wkpv="<id>">（点击委托挂在 work.js 的 #wk-pv-tabs 容器上，
// 本表重渲不清事件）；active 态与 pane 互斥显隐由 work.js applyPvTab 唯一落。
// pane = 该工具内容所在元素 id；未注册工具的 pane 恒隐（applyPvTab 按 active id 判定）。
// 另收预览页（iframe）经 postMessage 申报的「帧工具」——无 pane/mount，内容由预览页自管（见下方
// registerWkFrameTools；宿主 → 帧回传选中 id 见 work.js notifyFrame）。

import { esc } from '../core/util.js'
import { state } from '../engine/state.js'
import { enabledPreviewCardsFor, previewHasIndexPage } from '../feature/preview-frame.js'
/* @module sidebar/work-tools.js */
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

export {
  clearWkFrameTools,
  registerWkFrameTools,
  registerWkTool,
  renderWkToolTabs,
  wkToolDef,
  wkToolDefs,
  wkToolNormId,
}
