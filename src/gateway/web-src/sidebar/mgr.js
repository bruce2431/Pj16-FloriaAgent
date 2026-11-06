// 侧栏管理视图编排（2026-10-01 卡片化二期：卡内容已迁 views/cards/*-card.js，本文件只留编排与
// 侧栏列表/项目树；唯一手改处，web/app.js 为生成物）
// 2026-09-23 视图卡化：视图内容写进交给它的卡体——卡由 engine/registry.js 的槽位管理，分发改成
// 查表（openCard(state.mgr)），四段 if 链与空 .mgr-top 占位一并退场。

import { clearSessionSlots, navigate } from '../chat/route.js'
import { stageRelease } from '../chat/stage.js'
import { I } from '../core/icons.js'
import { stopLiveFoldTimer } from '../engine/live.js'
import { sessCmp, sorted } from '../engine/sessions.js'
import { ALL, bodyEl, state } from '../engine/state.js'
import { esc, isMobile, sessionProjLabel } from '../core/util.js'
import { closeMentionPop } from '../inputbar/mention.js'
import { openCard } from '../engine/registry.js'
import { bindSessionRows, itemHtml, setPanel } from './recent.js'
/* @module sidebar/mgr.js */
  // 管理视图统一入口（route 的 mgr 分支 / 侧栏 tab 内切换 / 神经元进出层级）：清会话全局槽后整卡切到 state.mgr。
  function renderMgr() {
    closeMentionPop()
    stopLiveFoldTimer()
    stageRelease()
    state.currentHash = ''
    state.preview = null
    // 2026-09-19 神经 tab 被实时流洗成 chat 根治：管理视图（插件/项目/模型/神经）是「离开会话视图」
    // 的入口之一，必须与 renderHome/openProjectPreview 同款清全局槽——旧实现只清 currentHash 不
    // 清槽，会话 A 的 session-delta 到达时按残留 curUuid 命中守卫 → renderSessionBody 整页重建
    // #messages 把管理视图（如神经元图）洗成会话消息流。清槽清单与不变量见 route.js clearSessionSlots。
    clearSessionSlots()
    // 切卡：同 id 卡复用（卡体整换、滚动层不动 ⇒ 滚动位置天然保持），异 id 卡新建并 .remove() 旧卡
    openCard(state.mgr)
  }

  function renderList() {
    const box = document.createElement('div')
    // 2026-08-25「在一个列表中」堆叠视图：项目会话显示所属项目短编号气泡（Pj16），根会话无气泡
    box.innerHTML = sorted().map((s) => itemHtml(s, true)).join('')
    bindSessionRows(box)
    bodyEl.appendChild(box)
  }

  function renderProject() {
    bodyEl.innerHTML = ''
    if (state.pt === 'projects') {
      const byProject = {}
      // 临时项目（根级时间戳任务区）的会话按全局根对待：不进项目文件夹视图（2026-11-06 用户定案）。
      for (const s of ALL) {
        const label = sessionProjLabel(s)
        if (label) (byProject[label] = byProject[label] || []).push(s)
      }
      const labels = Object.keys(byProject).sort((a, b) => {
        const la = Math.max(0, ...byProject[a].map((s) => s.updatedAt))
        const lb = Math.max(0, ...byProject[b].map((s) => s.updatedAt))
        return lb - la
      })
      if (labels.length === 0) {
        bodyEl.innerHTML = '<div class="no-hit" style="padding:10px">暂无项目会话</div>'
        return
      }
      const box = document.createElement('div')
      box.innerHTML = labels
        .map((label) => {
          const chats = [...byProject[label]].sort(sessCmp)
          // 2026-08-24 项目新建会话：项目文件夹行 + 按钮 → 在指定项目下新建 web 会话
          // （与「笔」新建会话并存，两者指向不同 exe——见 newWebSession 注释）
          return `<div class="folder" data-f="${esc(label)}"><button class="folder-head">
            <span class="chev">▶</span><span class="ficon">${I.folder}</span><span class="fname">${esc(label)}</span>
            <span class="fcount">${chats.length}</span>
            <span class="folder-add" role="button" tabindex="-1" title="在 ${esc(label)} 新建会话">${I.dshPlus}</span></button><div class="folder-body">${chats.map(itemHtml).join('')}</div></div>`
        })
        .join('')
      box.querySelectorAll('.folder-head').forEach((h) => h.addEventListener('click', () => h.parentElement.classList.toggle('open')))
      // 2026-08-24 项目新建会话入口：点击 → 在指定项目新建 web 会话
      // 2026-08-25 改造：与「笔」一致，先到初始化界面（#/ 空态 + 目标项目 chip），
      // 首条消息发送时才真正建会话（gwSend 空态分支带 project 调 newWebSession）。不再直接弹 CLI。
      box.querySelectorAll('.folder-add').forEach((a) =>
        a.addEventListener('click', (e) => {
          e.stopPropagation()
          const f = a.closest('.folder')
          if (f && f.dataset.f) {
            state.newProject = f.dataset.f
            navigate('#/')
            if (isMobile()) setPanel(false)
          }
        }),
      )
      bindSessionRows(box)
      bodyEl.appendChild(box)
    } else {
      const root = ALL.filter((s) => s.projectScope !== 'project')
      const box = document.createElement('div')
      box.innerHTML = root.length ? root.map(itemHtml).join('') : '<div class="no-hit" style="padding:10px">暂无根会话</div>'
      bindSessionRows(box)
      bodyEl.appendChild(box)
    }
  }

export {
  renderList,
  renderMgr,
  renderProject,
}
