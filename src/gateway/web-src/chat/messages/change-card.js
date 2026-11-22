// 文件变更汇总卡片（+N/-N）：路径归一/增删解析/聚合/渲染 + 折叠事件委托
import { sessionCwd } from '../../engine/sessions.js'
import { messagesEl } from '../../engine/state.js'
import { changesCardHtml } from '../../core/delivery-ui.js'
import { openChangedFile } from '../../feature/mention-nav.js'
import { toast } from '../../core/util.js'
/* @module chat/messages/change-card.js */
  // ---- 文件变更汇总卡片（Codex 风格：+N 绿 / -N 红）----
  // 数据源（2026-08-23 起）：源码 conversationDisplay.ts 在 tool_result 块上输出结构化
  // fileChange {filePath, added, removed}（权威数字 = 源码 diff.ts sumLinesChanged，由
  // Edit/Write 工具写入文本后缀 `(+N -M)`），前端直接消费字段。
  // parseFileChange 正则反解仅作旧网关/离线数据兜底，新 exe 部署后可删。
  function baseName(p) {
    const s = String(p || '').replace(/\\/g, '/')
    return s.split('/').pop() || s
  }
  // 相对启动根路径显示（2026-08-29）：路径在会话启动根（sessionCwd）下 → 剥前缀显示相对路径
  // （如 src/gateway/web/app.js）；不在根下/未知 cwd → 回退文件名。仅显示层，聚合 key 仍用绝对路径。
  function relFromCwd(p) {
    const norm = String(p || '').replace(/\\/g, '/')
    const root = String(sessionCwd || '').replace(/\\/g, '/').replace(/\/+$/, '') + '/'
    if (root.length > 1 && norm.toLowerCase().startsWith(root.toLowerCase())) {
      return norm.slice(root.length) || baseName(norm)
    }
    return baseName(norm)
  }
  // 从 tool_result 文本提取文件路径与增删行数（Edit/Write 统一格式）——旧网关兜底
  function parseFileChange(text) {
    if (!text) return null
    const t = String(text).trim()
    const m = /\([+-](\d+)\s*[+-](\d+)\)\s*\.?\s*$/.exec(t)
    if (!m) return null
    let path = null
    const fm = /The file\s+(.+?)\s+has been updated/.exec(t)
    if (fm) path = fm[1]
    else {
      const cm = /File created successfully at:\s+(.+?)\s*\(/.exec(t)
      if (cm) path = cm[1]
    }
    if (!path) return null
    // 文本句读可能落在路径尾部（「...questions.md. (+19 -0)」），剥掉尾部句点再当路径用。
    return { path: path.trim().replace(/[.。]+$/, ''), added: Number(m[1]), removed: Number(m[2]) }
  }
  // 归一化为聚合用的 {path, added, removed} 形态（结构化 fileChange 用 filePath 命名）
  function normalizeFileChange(fc) {
    if (!fc) return null
    if (fc.path != null) return { path: fc.path, added: fc.added || 0, removed: fc.removed || 0 }
    if (fc.filePath != null) return { path: fc.filePath, added: fc.added || 0, removed: fc.removed || 0 }
    return null
  }
  function mergeChanges(map, fc) {
    const prev = map.get(fc.path)
    map.set(fc.path, prev ? { added: prev.added + fc.added, removed: prev.removed + fc.removed } : { added: fc.added, removed: fc.removed })
  }
  function renderChangeCardHtml(changes, key) {
    if (!changes || !changes.size) return ''
    // 视觉与折叠结构归 @floria/web 的 delivery 组件族（changesCardHtml）；本处只把聚合结果
    // 归一为展示用相对路径数组。key 可选（messagesHtml 段尾传入 s.key）→ 带 data-m/data-t 供
    // 增量重建定位删除；实时行不带 key（无 data-m，属消息流外手动追加，不受增量删除影响）。
    const files = []
    for (const [path, c] of changes) files.push({ path: relFromCwd(path), abs: path, added: c.added, removed: c.removed })
    return `<div class="msg change-card"${key != null ? ` data-m="${key}" data-t="c"` : ''}>${changesCardHtml(files)}</div>`
  }

  // ---- 文件变更汇总卡片：历史/实时统一由 messagesHtml 段尾 seg.changes 数据驱动渲染
  //     （从 transcript 的 tool_result.fileChange 重建，切会话/刷新不丢）。原 WS out 实时内联行/
  //     commitLiveChangeCard 链随 WS out 流退役删除（网关从不投递 out，2026-09-07 定案）----
  // 卡片右上角隐藏按钮：点击切换列表收起/展开（事件委托，innerHTML 重建不受影响）
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-chg-toggle]') : null
    if (!btn || !messagesEl.contains(btn)) return
    const card = btn.closest('.chg')
    if (!card) return
    const open = card.classList.toggle('open')
    const total = card.querySelectorAll('.chg-row').length
    btn.textContent = open ? '收起' : `全部 ${total} 个文件`
  })

  // 变更卡文件行（或单文件标题行）点击 → chat 模式经侧边浏览器打开「编辑标签页」；work 模式走 work 卡。
  // data-chg-abs 是改动记录的原始路径（绝对或相对启动根），优先用它；缺失时回退展示路径（按当前项目解析）。
  function runChangedFile(el) {
    const raw = el.dataset.chgAbs || el.dataset.chgPath
    if (!raw) return
    openChangedFile(raw).catch((e) => toast((e && e.message) || String(e)))
  }
  // 鼠标 = pointerdown 即触发（与 @ 提及行同一范式）：消息区随 SSE 整块重渲（engine/live.js 的
  // messagesEl.innerHTML = …），若重渲落在按下与抬起之间，浏览器把 click 派发给两元素的共同祖先，
  // 行上的委托收不到 ⇒ 第一下白点、要点两次。按下态直接命中当前行，免疫重渲；同一手势随后的
  // click 由 pressed 标志吞掉（detail>0 = 真实指针手势），键盘 Enter/Space 与触屏仍走 click。
  let pressedRow = false
  document.addEventListener('pointerdown', (e) => {
    pressedRow = false
    if (e.pointerType !== 'mouse' || e.button !== 0) return
    const el = e.target && e.target.closest ? e.target.closest('[data-chg-path]') : null
    if (!el || !messagesEl.contains(el) || e.target.closest('[data-chg-toggle]')) return
    pressedRow = true
    runChangedFile(el)
  })
  document.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-chg-path]') : null
    if (!el || !messagesEl.contains(el) || e.target.closest('[data-chg-toggle]')) { pressedRow = false; return }
    if (pressedRow && e.detail > 0) { pressedRow = false; return }
    pressedRow = false
    runChangedFile(el)
  })
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const el = e.target && e.target.closest ? e.target.closest('[data-chg-path]') : null
    if (!el || !messagesEl.contains(el)) return
    e.preventDefault()
    runChangedFile(el)
  })

