// 项目选择器（唯一实现，2026-11-06）：work 侧栏 #wk-proj-pop 与底栏输入栏 #proj-pop 共用一个组件。
// 同构点 = 数据源（state.projects 的 scope==='project' 组）、行 UI、开关与选中语义；
// 差异只由调用方注入：容器（尺寸/位置在 CSS）、是否含「全局（默认）」行、选中取哪个状态、
// 选中后做什么、打开前是否补拉列表。
// 数据不变量：项目列表唯一来源 = state.projects（后端 findProjects），**禁止再由会话列表反推**——
// 旧底栏 projList 由 ALL 派生，只出「有会话的项目」，与 work 下拉的项目数对不上（2026-11-06 根因）。
import { esc } from '../../core/util.js'
import { I } from '../../core/icons.js'
import { state, ALL } from '../../engine/state.js'
/* @module feature/project-picker/project-picker.js */

  // 项目排序（2026-11-12 用户定案）：按该项目「最新一次会话的时间」降序，无会话的项目排末尾
  // （保持 findProjects 的目录枚举序）。时间取会话 updatedAt（最近活跃），缺省回退 createdAt。
  function projectLatestAt() {
    const at = new Map()
    for (const s of ALL) {
      const label = s.projectLabel
      if (!label) continue
      const t = s.updatedAt || s.createdAt || 0
      if (!(at.get(label) >= t)) at.set(label, t)
    }
    return at
  }

  function projectPickerGroups() {
    const at = projectLatestAt()
    return (state.projects || [])
      .filter((g) => g && g.label && g.scope === 'project')
      .sort((a, b) => (at.get(b.label) || 0) - (at.get(a.label) || 0))
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
