// 会话摘要浮层（2026-11-28）：chat 模式右上角圆钮「摘要」+ 弹出卡片。
// 数据 = CLI files-state 快照（上下文文件 / 变更文件；网关只做传输，见 gatewayFilesSnapshot.ts）。
// 有文件数据才出现；work 模式与 token 门隐藏（CSS 门）。行内文件 = 消息流同款 md 链接 chip
// （图标 + 文本，点击走 feature/mention-nav 的既有派发），不另写一套渲染。
import { I } from '../core/icons.js'
import { mdInlineText } from '../core/markdown.js'
/* @module chat/summary.js */
  const summaryRoot = $('summary-root')
  const summaryBtn = $('summary-btn')
  const summaryPop = $('summary-pop')

  summaryBtn.innerHTML = I.dshPlan
  summaryBtn.addEventListener('click', () => {
    if (summaryRoot.hidden) return
    const open = summaryPop.hidden
    summaryPop.hidden = !open
    summaryBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
  })
  // 点卡片外任意处 / Esc 收起（与 ctx 面板同交互口径）
  document.addEventListener('mousedown', (e) => {
    if (summaryPop.hidden || summaryRoot.contains(e.target)) return
    closeSummary()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !summaryPop.hidden) closeSummary()
  })

  function closeSummary() {
    summaryPop.hidden = true
    summaryBtn.setAttribute('aria-expanded', 'false')
  }

  // md 链接 URL 侧编码（与插入侧同口径）：空格/括号/#/?/% 会拆坏 `[文](url)` 或 parseFileLink，
  // 一律百分号编码；展示文本仍用原始路径。
  function mdUrlPath(p) {
    return p
      .replace(/%/g, '%25')
      .replace(/ /g, '%20')
      .replace(/\(/g, '%28')
      .replace(/\)/g, '%29')
      .replace(/#/g, '%23')
      .replace(/\?/g, '%3F')
  }

  // 行 = md 文件链接 chip（`[`路径`](路径)` → mention-chip + file-icon，点击交 mention-nav）。
  function fileRowHtml(p) {
    return '<div class="summary-row">' + mdInlineText('[' + '`' + p + '`' + '](' + mdUrlPath(p) + ')') + '</div>'
  }

  function changedRowHtml(c) {
    const stat = c.isNew
      ? '<span class="chg-add">新增</span>'
      : '<span class="chg-add">+' + (Number(c.added) || 0) + '</span> <span class="chg-del">-' + (Number(c.removed) || 0) + '</span>'
    return '<div class="summary-row">' + mdInlineText('[' + '`' + c.path + '`' + '](' + mdUrlPath(c.path) + ')') + '<span class="summary-stat">' + stat + '</span></div>'
  }

  function groupHtml(title, rows) {
    if (!rows.length) return ''
    return '<div class="summary-group-title">' + title + '</div>' + rows.join('')
  }

  // 侧边聊天分组（用户定案：渲染代码保留、暂不启用 → 不产出任何 DOM）。
  const SIDE_CHAT_ENABLED = false
  function sideChatGroupHtml() {
    return SIDE_CHAT_ENABLED ? groupHtml('侧边聊天', []) : ''
  }

  // 快照整份替换：null / 两列表皆空 → 圆钮与浮层整体隐藏。
  function renderSummary(fs) {
    const files = fs && Array.isArray(fs.files) ? fs.files.filter((p) => typeof p === 'string' && p) : []
    const changed = fs && Array.isArray(fs.changed) ? fs.changed.filter((c) => c && typeof c.path === 'string' && c.path) : []
    if (!files.length && !changed.length) {
      summaryRoot.hidden = true
      summaryPop.hidden = true
      summaryPop.innerHTML = ''
      summaryBtn.setAttribute('aria-expanded', 'false')
      return
    }
    summaryRoot.hidden = false
    summaryPop.innerHTML =
      groupHtml('上下文文件', files.map(fileRowHtml)) +
      groupHtml('变更文件', changed.map(changedRowHtml)) +
      sideChatGroupHtml()
  }

export { renderSummary }
