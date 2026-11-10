// 消息区交互与用户气泡内容：复制/用量弹层/图表/大图 lightbox + userBodyHtml/图片/文件卡片 + 时长与旁白渲染
import { mdHtml, messageMd, toggleCodeWrap } from '../../core/markdown.js'
import { I, fileIcon } from '../../core/icons.js'
import { esc, toast } from '../../core/util.js'
import { messagesEl, live, state } from '../../engine/state.js'
import { findSession } from '../../engine/sessions.js'
import { quoteBodiesAsMarkdown } from '../../inputbar/mention.js'
import { activateMention, activateMentionReveal, mentionTargetFromChip } from '../../feature/mention-nav.js'
import { ICON_COPY, writeClipboard } from './usage.js'
/* @module chat/messages/msg-actions.js */
  // 消息复制（2026-10-09 定案：复制「原始 markdown 源码」，非渲染文本）：data-md 的生产与消费同处
  // core/markdown.js（mdAttr 挂载 / messageMd·selectionMd 消费），此处只做「复制按钮点击 → writeClipboard」。
  // 复制按钮 = 该条消息 .body 内全部块级 data-md 按序拼接（折叠体/操作条不在 .body 内，天然排除）；
  // 选区复制（含纯文本降级）由全局唯一的 copy 拦截在 inputbar/ctx-meter.js 承载（勿在此另起监听）。
  function messageCopyText(msgEl) {
    return messageMd(msgEl.querySelector('.body'))
  }
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.msg-copy') : null
    if (!btn || !messagesEl.contains(btn) || btn.classList.contains('copied')) return
    const msgEl = btn.closest('.msg')
    if (!msgEl) return
    const text = messageCopyText(msgEl)
    if (!text) return
    writeClipboard(text).then((ok) => {
      if (!ok) { toast('复制失败'); return }
      btn.classList.add('copied')
      btn.innerHTML = I.dshCheck
      btn.title = '已复制'
      btn.setAttribute('aria-label', '已复制')
      setTimeout(() => {
        if (!btn.isConnected) return
        btn.classList.remove('copied')
        btn.innerHTML = ICON_COPY
        btn.title = '复制'
        btn.setAttribute('aria-label', '复制')
      }, 1000)
    })
  })

  // 提及 / 引用 chip 点击跳转（2026-11-08 统一）：chip 自带链接凭据（data-mjump = 会话/文件/目录/插件，
  // data-qjump = 回复/文件引用），业务落点全部收口到 feature/mention-nav.js；本处只做「消息区内」委托与
  // 拖选误触守卫。目标卡不在场/门禁不过时由派发器 toast，不静默。
  document.addEventListener('click', (e) => {
    const chip = e.target && e.target.closest ? e.target.closest('.mention-chip') : null
    if (!chip || !messagesEl.contains(chip)) return
    // 文件 chip 行尾「在资源管理器中打开」按钮（先于整枚 chip 的跳转判定）：只开目录，不改路由。
    const act = e.target.closest('[data-mreveal]')
    if (act) {
      e.preventDefault()
      e.stopPropagation()
      activateMentionReveal(act.dataset.mreveal)
      return
    }
    if (!chip.dataset.qjump && !chip.dataset.mjump) return
    // 拖选文本的收尾 click 落在 chip 上不算「点链接」——用户是在选字，不是在跳转
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed && String(sel).trim()) return
    const target = mentionTargetFromChip(chip)
    if (!target) return
    e.preventDefault()
    e.stopPropagation()
    activateMention(target)
  })

  // 围栏代码块头栏按钮（2026-10-10；同 msg-copy 的委托+反馈模式）：复制 = 读本块 pre>code.textContent
  // （高亮只包 hljs-* span、不改文本，textContent 即原始代码）；换行 = toggleCodeWrap（全页现有块同步 + 持久化）。
  document.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target : null
    if (!el) return
    if (el.closest('.cb-wrap')) { toggleCodeWrap(); return }
    const btn = el.closest('.cb-copy')
    if (!btn || btn.classList.contains('copied')) return
    const block = btn.closest('.code-block')
    const codeEl = block && block.querySelector('pre > code')
    const text = codeEl ? codeEl.textContent : ''
    if (!text) return
    writeClipboard(text).then((ok) => {
      if (!ok) { toast('复制失败'); return }
      const prev = btn.innerHTML
      btn.classList.add('copied')
      btn.innerHTML = I.dshCheck
      setTimeout(() => { if (!btn.isConnected) return; btn.classList.remove('copied'); btn.innerHTML = prev }, 1000)
    })
  })

  // 用量明细弹层（DSH 回复操作条「用量 X tok」按钮 → 点击弹出面板）：单开互斥（开本关它），点外区关闭。
  // 面板 .usage-pop 在 .msg-actions 内、与 .msg-usage 同属 .msg；按钮 aria-expanded 同步。
  function closeUsagePops(except) {
    messagesEl.querySelectorAll('.usage-pop:not([hidden])').forEach((p) => {
      if (p === except) return
      p.hidden = true
      const b = p.parentElement && p.parentElement.querySelector('.msg-usage')
      if (b) b.setAttribute('aria-expanded', 'false')
    })
  }
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.msg-usage') : null
    if (btn && messagesEl.contains(btn)) {
      const pop = btn.parentElement && btn.parentElement.querySelector('.usage-pop')
      if (!pop) return
      const open = pop.hidden
      closeUsagePops(pop)
      pop.hidden = !open
      btn.setAttribute('aria-expanded', open ? 'true' : 'false')
      return
    }
    if (e.target && e.target.closest && e.target.closest('.usage-pop')) return
    closeUsagePops(null)
  })

  // ---- 嵌入式图表（```chart 围栏，渲染链见 core/markdown.js）----
  // 「源码」切换（事件委托，innerHTML 重建不受影响）：.chart-embed.as-src 切 iframe ↔ 原文
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.chart-src') : null
    if (!btn || !messagesEl.contains(btn)) return
    const box = btn.closest('.chart-embed')
    if (!box) return
    btn.textContent = box.classList.toggle('as-src') ? '图表' : '源码'
  })

  // 高度自适应：sandbox iframe（opaque origin）内 BOOT 量 body/documentElement scrollHeight 上报
  // __chartH；按 e.source 精确匹配本页 .chart-frame 才采纳（其它窗口/preview iframe 伪造不进来），
  // 高度上限交给 CSS max-height，超出内部滚动。宽度变化（如侧栏拖宽）→ 内容高变 → 内部 ResizeObserver 重报，闭环。
  addEventListener('message', (e) => {
    const h = e.data && e.data.__chartH
    if (typeof h !== 'number' || !isFinite(h) || h <= 0) return
    for (const f of document.querySelectorAll('iframe.chart-frame')) {
      if (f.contentWindow !== e.source) continue
      const nh = Math.round(h)
      if (Math.abs((parseFloat(f.style.height) || 0) - nh) > 1) f.style.height = nh + 'px'
      return
    }
  })

  // 压缩/自动摘要标记：转录里压缩会把「会话续接」记成 user|text（后端已映射 role:'system'，
  // 标签「会话续接（自动摘要）」）。命中它 = 当前回合被压缩打断，但 agent 仍在干活——
  // 不应把它当成回合结束，否则「正在处理」被强收成「已处理」、后续思考/工具拆成断开的新段。
  // ⚠️ 存活代码勿删（2026-08-27 P2 复核纠正审查报告§C 结论）：shouldShowUserMessage 只剔 isMeta，
  // 而 isCompactSummary 续接记录不带 isMeta、conversationDisplay 亦无专门剔除 → 经网关 display /
  // 磁盘兜底同样以 role:'user' 到达前端；处理中命中即驱动 liveFoldBody 真空态「正在压缩会话中……」行，
  // 已收尾时静默吞行。英/中双正则分别兜官方原文与离线标签两种形态。
  const CONTINUED_RE = /This session is being continued from a previous conversation/i
  function isContinuationMsg(m) {
    if (m.role !== 'system' && m.role !== 'user') return false
    return m.blocks.some((b) => b.kind === 'text' && (CONTINUED_RE.test(b.text) || b.text.includes('会话续接')))
  }

  // 真实用户消息（带文本/图片，非纯工具回包）：开新段/新回合检测/处理中计时共用。
  // 合成 user（后台任务通知/对话中断等）已由源码 shouldShowUserMessage 剔除（A/B 路径）、
  // 离线路径由 server.mjs readSession 映射为 role:'system'（C 路径）——前端无需再判系统注入
  // 文本（isSynthText/SYNTH_RE 已于 2026-08-23 删除，见交接文档任务 1）。
  // 跨会话来件的来源行（2026-09-15 会话间协作）：气泡外一行灰字标识来自哪个会话。
  // 来源由 CLI 投影给定（DisplayMessage.fromSession，正文里的 `<session-message from=…>` 包装
  // 已在 conversationDisplay 剥离）——前端不解析包装、不复刻判据。无该字段 = 本地用户输入，
  // 渲染与本地消息完全一致（用户定案：气泡本体形态不变，只有气泡外多一行小字）。
  // 位置：插在 .body 之前（DOM 序 = 视觉上方），.msg 是列向 flex → 在文档流里占位（不做绝对定位，
  // 不参与气泡高度计算），故对既有高度/滚动占位（stageSync 贴顶位）零影响。
  function whoHtml(m) {
    const f = m && m.fromSession
    if (!f || !f.title) return ''
    return `<div class="who">来自 会话：${esc(String(f.title))}</div>`
  }

  function isRealUser(m) {
    if (m.role !== 'user') return false
    return m.blocks.some((b) => (b.kind === 'text' && b.text && b.text.trim()) || b.kind === 'image')
  }

  // 回合终止性 stopReason（2026-08-31）：官方 end_turn 之外，第三方商正常终止可能返回
  // 'stop_sequence'（CLI 未配置 stop_sequence 参数，纯文本回复即自然结束；jsonl 实证其后无
  // assistant 记录 = CLI 已按回合结束收尾）。只认 end_turn 会把这类已完成的回合刷新后误判
  // 「正在处理」重新计时、回复沉进折叠体（实测 2471f361/6f1f48fb）。'tool_use'/null 仍=处理中。
  function isEndStop(sr) {
    return sr === 'end_turn' || sr === 'stop_sequence'
  }

  // 用户气泡正文（2026-08-30 图片渲染，用户定案：图在气泡外）：
  // 带 imageId 的 image 块 → 气泡只出文本（剥掉文本里已渲染图的 [Image #N] 占位），
  // 图由 userImgsHtml 渲染在气泡框外；字节走网关 GET /gateway/file-cache/<会话uuid>/<id>?sid=<会话hash>
  // （复用 CLI processUserInput storeImages 落盘的 <项目根>/.claude/file-cache，display JSON 不塞 base64）。
  // 无 imageId（旧记录）→ 回落 [图片] 占位/纯文本；图已落盘后被清（会话重启
  // cleanupOldFileCaches 清非当前会话缓存）→ userImgsHtml onerror 出 [Image #N] 裸文本。
  function userBodyHtml(m) {
    const ids = []
    for (const b of m.blocks) if (b.kind === 'image' && b.imageId) ids.push(b.imageId)
    let txt = m.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('')
    // [Image #N] 是 web 发送端内部令牌（占位 ↔ pastedContents id ↔ file-cache 文件名 ↔ 图片块
    // imageId 同源），**永不上屏：无条件全剥**。旧「只剥有 image 块对应的那几个 id」在链上任何一处
    // 少一张图时（网关曾按 ≤4 张静默截断；non-vision 模型 CLI 丢弃 image 块同理）多出的占位会漏成
    // 消息裸文本（用户实测 [Image #5] [Image #6] [Image #7]）。对应图片本体由 userImgsHtml 依图片块
    // imageId（无图片块时回落文本占位）另行渲染，与剥除无关、不重影。
    txt = txt.replace(/\s*\[Image #\d+\]/g, '')
    // 文件占位（2026-09-12 文件上传）：[文件:<绝对路径>] 剥出渲染成文件卡片（userFilesHtml）
    txt = txt.replace(/\s*\[文件:[^\]]*\]/g, '')
    // 引用原文块 → 锚点胶囊 + 原文引用块（2026-10-21：原文照样显示，不再剥掉）
    txt = quoteBodiesAsMarkdown(txt)
    const hasImg = m.blocks.some((b) => b.kind === 'image')
    return mdHtml(hasImg && !ids.length && !txt.trim() ? '[图片]' : txt)
  }

  // 文本里的 [Image #N] 占位（web 发送端拼的内部令牌）→ id 列表。CLI 落盘文件名即 N
  // （storeImages 按 pastedContents id 命名），故凭占位即可拼出 file-cache URL。
  function textImageIds(m) {
    const txt = m.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('')
    const out = []
    txt.replace(/\[Image #(\d+)\]/g, (_, n) => { out.push(Number(n)); return '' })
    return out
  }

  // 图片容器（用户 2026-08-30 定案：渲染在气泡外）：.msg 内、.body 后——.msg 无背景，
  // 视觉即气泡正下方右侧。图未落盘（404）→ onerror 替换为 [Image #N] 裸文本，不出破图
  //（用户定案「会话重启后图片不留盘，就仅渲染裸文本就好了」）。
  // id 来源两路：image 块 imageId（vision 模型，CLI 把图附进 content）；无 image 块时回落
  // 文本占位符（non-vision 模型，CLI 丢弃 image 块但 storeImages 仍无条件落盘）——保证
  // 「模型忽略图片」不等于「界面不显示图片」，切换识图模型后同一路径即正常可用。
  function userImgsHtml(m) {
    const ids = []
    for (const b of m.blocks) if (b.kind === 'image' && b.imageId) ids.push(b.imageId)
    if (!ids.length) ids.push(...textImageIds(m))
    if (!ids.length) return ''
    // 取字节的基址由网关按 sid → project → 网关自身根 解析。sid = currentHash，**首屏早期它可能还是
    // 路由里的短 uuid（会话列表未拉到时 resolveSessionHash 原样透传）**，解不出启动根 → 落到网关自身
    // 根，全局会话（jsonl 在工作区根）的图因此 404、onerror 变 [Image #N] 裸文本（用户实测）。
    // 故同时带上会话自带 projectLabel（项目会话=项目名 / 全局=「全局根 · 散装对话」），网关按 label
    // 解析到会话启动根——与 /gateway/file 取 AI 生成图是同一口径，不再依赖 currentHash 是否已归一。
    const s = findSession(live.curUuid)
    const q = []
    if (state.currentHash) q.push('sid=' + encodeURIComponent(state.currentHash))
    if (s && s.projectLabel) q.push('project=' + encodeURIComponent(s.projectLabel))
    const qs = q.length ? '?' + q.join('&') : ''
    const imgs = ids.map((id) => `<img class="msg-img" loading="lazy" alt="图片" data-ph="[Image #${id}]" onerror="this.replaceWith(document.createTextNode(this.dataset.ph))" src="/gateway/file-cache/${live.curUuid || ''}/${id}${qs}">`).join('')
    return `<div class="msg-imgs">${imgs}</div>`
  }

  // 文件卡片（2026-09-12 文件上传，用户定案「像图片一样有对应的 UI」）：与图片同构——消息文本里
  // 的 [文件:<落盘绝对路径>] 占位剥出渲染成气泡外下方文件卡片（图标+文件名，title=完整路径，
  // 点击复制路径供粘贴他用）。文件落 file-cache/<会话id>/（与粘贴图片同目录，随会话清理），
  // 卡片形态与图片的 404/裸文本回落不共用。
  function fileCardsHtml(paths) {
    const cards = paths.map((p) => {
      const name = String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
      return `<span class="msg-file" role="button" data-path="${esc(p)}" title="${esc(p)}">${fileIcon(name)}<span class="mf-name">${esc(name)}</span></span>`
    }).join('')
    return `<div class="msg-files">${cards}</div>`
  }
  function userFilesHtml(m) {
    const txt = m.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('')
    const paths = []
    txt.replace(/\[文件:([^\]]+)\]/g, (_, p) => { paths.push(p.trim()); return '' })
    return paths.length ? fileCardsHtml(paths) : ''
  }
  // 文件卡片点击 = 复制落盘路径（事件委托，innerHTML 重建不受影响）
  document.addEventListener('click', (e) => {
    const c = e.target && e.target.closest ? e.target.closest('.msg-file') : null
    if (!c || !messagesEl.contains(c)) return
    writeClipboard(c.dataset.path || '').then((ok) => toast(ok ? '已复制路径' : '复制失败'))
  })

  // 大图预览 lightbox（2026-08-30 用户定案：单击缩略图看大图）：单例覆盖层，
  // src 复用缩略图同 URL（网关 Cache-Control private 1d，字节已缓存零请求）；
  // 点击任意处 / Esc 关闭。事件委托 document 级绑一次，覆盖历史/实时/SSE 全渲染路径。
  function ensureLightbox() {
    let lb = document.getElementById('img-lightbox')
    if (lb) return lb
    lb = document.createElement('div')
    lb.id = 'img-lightbox'
    lb.innerHTML = '<img alt="大图预览">'
    lb.addEventListener('click', () => lb.classList.remove('on'))
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') lb.classList.remove('on') })
    document.body.appendChild(lb)
    return lb
  }
  // 除消息内缩略图外，底栏附件胶囊缩略图（`.img-pill`）也走同链——复用单例 lightbox（禁另起一套），
  // 胶囊 dataUrl 直接作 src（本地无请求）。（2026-10-16：胶囊点击大图预览）
  // 注意：`.img-pill img` 恒 `pointer-events:none`（点击落在包裹层），故匹配 `.img-pill` 再取内层 img；
  // 且须排除 `.img-x`（移除钮）——它也在 `.img-pill` 内，命中则只移除不开预览。
  // 编辑面内联小图（`.cm-att-img`：底栏 @ 引用图 / work 编辑卡上传图，editor-attachments.edAttImgPlugin
  // 渲成 `<span class="cm-att-img"><img>`）同链——此前只认 `.msg-img` ⇒ 编辑面点小图无反应（2026-10-16
  // 用户实测「发送出来的小图可以、编辑面里的不行」）。widget `ignoreEvent()===true` ⇒ 点击直达 document。
  document.addEventListener('click', (e) => {
    const t = e.target
    if (!t || !t.closest) return
    let src = ''
    const mimg = t.closest('.msg-img')
    if (mimg) src = mimg.currentSrc || mimg.src
    else {
      const aimg = t.closest('.cm-att-img')
      if (aimg) {
        const im = aimg.querySelector('img')
        if (im) src = im.currentSrc || im.src
      } else if (!t.closest('.img-x')) {
        const pill = t.closest('.img-pill')
        const im = pill && pill.querySelector('img')
        if (im) src = im.currentSrc || im.src
      }
    }
    if (!src) return
    const lb = ensureLightbox()
    lb.querySelector('img').src = src
    lb.classList.add('on')
  })

  // 已处理时长：10m 50s 风格
  function fmtDur(sec) {
    if (!(sec > 0)) return ''
    if (sec < 60) return sec + 's'
    const m = Math.floor(sec / 60)
    const s = sec % 60
    if (m < 60) return s ? m + 'm ' + s + 's' : m + 'm'
    const h = Math.floor(m / 60)
    return h + 'h ' + (m % 60) + 'm'
  }

  // 思考/旁白文本：无气泡框，浅灰小字（收在「已处理」折叠区内）
  function processTextHtml(text) {
    return `<div class="done-think md-scope">${mdHtml(text)}</div>`
  }

