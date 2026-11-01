// 气泡弹层 + 搜索覆盖层（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { navigate } from '../chat/route.js'
import { I } from '../core/icons.js'
import { hashOf, sorted } from '../engine/sessions.js'
import { bubblePop, overlay, sInput, state } from '../engine/state.js'
import { esc, isMobile, isTempProjLabel } from '../core/util.js'
import { setPanel, itemHtml } from './recent.js'
/* @module sidebar/bubble-search.js */
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
    const temp = isTempProjLabel(state.workProj)
    const inScope = (s) => (temp ? s.projectScope === 'global' : s.projectScope === 'project' && s.projectLabel === state.workProj)
    const rows = sorted().filter(
      (s) =>
        (!inWork || inScope(s)) &&
        (!q || s.title.toLowerCase().includes(q) || (s.projectLabel || '').toLowerCase().includes(q)),
    )
    const sessHtml = rows
      .map((s) => {
        // work 下结果已限在同一项目，项目标签无信息量；chat 下保留以区分来源
        const prj = !inWork && s.projectScope === 'project' ? `<span class="s-prj">${esc(s.projectLabel)}</span>` : ''
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

export {
  openSearch,
  renderBubble,
  renderSearch,
}
