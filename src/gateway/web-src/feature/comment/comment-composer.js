// 评论卡 · 选区「添加评论」浮层（quote.js 的「添加评论」行 → 这里）。
// 浮层是评论卡自己的输入面：位置锚定选区快照，提交走卡数据层 cmtAdd（唯一写口）。

import { esc, toast } from '../../core/util.js'
import { state } from '../../engine/state.js'
import { cmtAdd, cmtHookEnsurePane, cmtId } from './comment-data.js'
/* @module feature/comment/comment-composer.js */
  let cmtPop = null       // 选区「添加评论」浮层

  function cmtClosePop() {
    if (cmtPop) { cmtPop.remove(); cmtPop = null }
  }
  function openCommentComposer(snap) {
    if (!snap || snap.kind !== 'file' || !snap.file) return
    cmtHookEnsurePane() // 落点可见：右栏切到评论 tab（注释提交后立刻在列表里看到）
    cmtClosePop()
    const pop = document.createElement('div')
    pop.className = 'cmt-pop'
    const n0 = Number(snap.l0) || 0
    const n1 = Number(snap.l1) || 0
    const loc = esc(snap.file) + (n0 ? ' · ' + n0 + (n1 && n1 !== n0 ? '-' + n1 : '') + ' 行' : '')
    pop.innerHTML =
      '<div class="cmp-loc">' + loc + '</div>' +
      '<blockquote class="cmp-ex">' + esc(String(snap.text || '').slice(0, 300)) + '</blockquote>' +
      '<textarea class="cmp-in" placeholder="添加评论…" rows="3"></textarea>' +
      '<div class="cmp-bar"><button type="button" class="cmp-cancel">取消</button><button type="button" class="cmp-ok">评论</button></div>'
    document.body.appendChild(pop)
    const r = snap.rect || { left: 0, bottom: 0 }
    const w = pop.offsetWidth
    const h = pop.offsetHeight
    // 越界下限取**可视**视口底（键盘上沿）：innerHeight 是布局视口，键盘在场不缩，按它 clamp 会落进键盘后。
    const vv = window.visualViewport
    const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight
    pop.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - w - 8))) + 'px'
    pop.style.top = Math.round(Math.max(8, Math.min(r.bottom + 6, viewBottom - h - 8))) + 'px'
    const ta = pop.querySelector('.cmp-in')
    ta.focus()
    pop.addEventListener('mousedown', (e) => e.stopPropagation()) // 浮层内按下不算「点外部」
    pop.querySelector('.cmp-cancel').addEventListener('click', cmtClosePop)
    const submit = async () => {
      const body = ta.value.trim()
      if (!body) { ta.focus(); return }
      const entry = {
        id: cmtId(),
        path: snap.file,
        l0: n0,
        l1: n1,
        excerpt: String(snap.text || '').slice(0, 300),
        body,
        author: 'me',
        createdAt: new Date().toISOString(),
        resolved: false,
      }
      cmtClosePop()
      if (await cmtAdd(snap.proj || state.workProj, entry)) toast('已添加评论')
    }
    pop.querySelector('.cmp-ok').addEventListener('click', submit)
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit() }
      else if (e.key === 'Escape') { e.preventDefault(); cmtClosePop() }
    })
    cmtPop = pop
  }

  // 点浮层外 / 滚动 / Esc → 关（fixed 浮层会漂离锚点；与 quote.js 浮窗同策略）。
  // 滚动关闭守护的不变量 = 「锚点漂移」：只有**浮层外**的滚动才让选区滚走、浮层漂离锚点；
  // 浮层内 cmp-in 自己的内容滚动（评论正文超出可见行数后的纵向滚动）不改变锚点关系，
  // 不得关窗——否则输入长评论的瞬间（textarea 内容一滚）浮层即死（capture 监听 window 也收到元素 scroll）。
  document.addEventListener('mousedown', (e) => { if (cmtPop && !cmtPop.contains(e.target)) cmtClosePop() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cmtPop) cmtClosePop() })
  window.addEventListener('scroll', (e) => { if (cmtPop && !cmtPop.contains(e.target)) cmtClosePop() }, { passive: true, capture: true })

export {
  cmtClosePop,
  openCommentComposer,
}
