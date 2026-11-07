// @ 提及浮窗 + 输入变化入口（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）
// 2026-11-07 工具栏模块化：项目隔离（toolbar/scope.js）、文件层（toolbar/pick.js）、条目层（toolbar/entries.js）
// 已切出；本件只留 @ 的生命周期（锚点/查询词/落地）与 chip 构造/序列化。

import { GATEWAY, gateAwait } from '../engine/gateway.js'
import { I } from '../core/icons.js'
import { MENTION_FILE_ICON, MENTION_PATH_RE, MENTION_PLUGIN_RE, MENTION_SESSION_ICON, MENTION_SESSION_RE, QUOTE_PDF_RE, QUOTE_REF_RE, QUOTE_REPLY_RE, foldQuoteBodies, mentionChipHtml, mentionPathToken, quotePdfChipHtml, quoteRefChipHtml, quoteReplyChipHtml, splitSessionToken, unfoldQuoteBodies, unescapeMentionPath } from '../core/mention-syntax.js'
import { sessionCwd } from '../engine/sessions.js'
import { state } from '../engine/state.js'
import { esc } from '../core/util.js'
import { syncGwSend } from './send.js'
import { cmd, closeCmdPop, renderCmdPop } from './commands.js'
import { pickEnter } from './toolbar/pick.js'
/* @module inputbar/mention.js */
  // ---------- @ 提及（2026-08-15）：输入 @ 弹出同一工具栏（2026-09-18 会话区提前），选中插入内联 chip ----------
  // 消息文本中 chip 序列化为 [插件:名称] / [会话:名称] 令牌（CLI 终端渲染为 [名称]，遥测端渲染为 chip；
  // 令牌保留 kind 供两端差异化渲染 + 未来插件激活扩展）。
  // @ 提及 icon（2026-09-28 换 dsh v0.2.0-rc.1 产品图标集，16 描线/currentColor；旧 24 手绘那套作废）。
  // 语义与 dsh 一致：会话=ChatLines、插件=PluginPinwheel、技能=Skill、目录=FolderClose、文件=Browse
  // ——与 + 浮窗行图标同源（同一批 I.* 常量），两处不得分叉。会话/文件两枚随 chip 构造器下移 core/mention-syntax.js。
  const MENTION_PLUGIN_ICON = I.dshPlugin
  const MENTION_SKILL_ICON = I.dshSkill
  const MENTION_DIR_ICON = I.dshFolder
  const MENTION_UP_ICON = I.dshUp
  // CM6 接管后 sentinel（零宽 DOM 锚）退役：@ 查询锚点 = doc 位置 anchor（'@' 所在 pos）
  let mention = { open: false, anchor: 0, q: '', items: [], sel: 0 }

  function mentionChipIcon(kind, ptype) {
    if (kind === 'session') return MENTION_SESSION_ICON
    if (kind === 'path' || kind === 'filepick' || kind === 'imgpick') return ptype === 'dir' ? MENTION_DIR_ICON : MENTION_FILE_ICON
    if (kind === 'skill') return MENTION_SKILL_ICON
    return MENTION_PLUGIN_ICON
  }
  // 输入栏内联 chip 的 HTML（@ 插入与 + 工具栏追加共用一份，勿各写一套）
  // 路径 chip 只显示末段文件名，全路径进 title（与消息气泡 mentionChipHtml 同口径）。
  // 展示不带 @ 前缀（2026-10-26 与消息气泡同步：@ 只是唤出手势，不属文件名）。
  function mentionChipInner(kind, name, ptype) {
    const full = kind === 'path' ? unescapeMentionPath(name) : name
    const base = kind === 'path' ? String(full).split('/').pop() : full
    const title = kind === 'path' && base !== full ? ` title="${esc(full)}"` : ''
    return `<span class="m-ic">${mentionChipIcon(kind, ptype)}</span><span class="m-nm"${title}>${esc(base)}</span>`
  }
  function buildMentionChip(kind, name, sid, ptype) {
    const chip = document.createElement('span')
    chip.className = 'mention'
    chip.contentEditable = 'false'
    chip.dataset.kind = kind
    chip.dataset.name = name
    if (kind === 'session' && sid) chip.dataset.sid = sid
    if (kind === 'path') chip.dataset.ptype = ptype === 'dir' ? 'dir' : 'file'
    chip.innerHTML = mentionChipInner(kind, name, ptype)
    return chip
  }

  // chip HTML 构造器（mentionChipHtml / quote*ChipHtml）与令牌正则、splitSessionToken 已下移
  // core/mention-syntax.js（core 叶子，供 core/markdown.js 与本源共用，断开 core→feature 成环）。

  // 引用 chip → 消息文本。两条链的落地形态刻意不同（用户定案 2026-09-28）：
  //  文件引用 = 只给位置，模型自己 Read；
  //  回复引用 = 原文必须进消息——回复不属于任何文件，没有位置可查。原文包在令牌块里（`QUOTE_REPLY_BODY_RE`），
  //  渲染层整块剥掉只留锚点令牌 → 胶囊。首尾不留多余换行（留了会撑出多余行距，2026-09-28 用户实报「自带一个换行」）。
  function refToken(d) {
    if (d.rkind === 'pdf') {
      const p = refPath(d.file, d.proj)
      const loc = d.p0 ? `#p${d.p0}${d.p1 && d.p1 !== d.p0 ? '-' + d.p1 : ''}` : ''
      return `[@引用PDF:${p}${loc}]\n${String(d.quote || '')}\n[/引用PDF]`
    }
    if (d.rkind !== 'file') {
      const title = String(d.title || '本会话').replace(/[\]|\r\n]/g, ' ').trim() || '本会话'
      return `[@引用回复:${d.idx || 0}|${title}]\n${String(d.quote || '')}\n[/引用回复]`
    }
    const p = refPath(d.file, d.proj)
    return d.l0 ? `[@引用:${p}#L${d.l0}-${d.l1}]` : `[@引用:${p}]`
  }

  // 引用路径基准 = 模型能直接 Read 的形式：会话启动根（模型 cwd）就是该 work 项目本身时用项目内
  // 相对路径；否则带项目 label（工作区相对——会话开在别的项目下时仍指向同一文件）。cwd 未知同样带 label。
  function refPath(file, proj) {
    const cwd = String(sessionCwd || '').replace(/\\/g, '/').replace(/\/+$/, '')
    if (proj && cwd.split('/').pop() === proj) return file
    return proj ? proj + '/' + file : file
  }

  // 引用**原文块**在气泡里的形态（2026-10-21 用户定案）：原文并进锚点令牌的第三个字段（百分号编码），
  // 由 core/mention-syntax.js 的 chip 构造器渲染成「图标 + 原文」的蓝色引用胶囊（不再有 blockquote 的
  // margin/padding = 与正文上下对齐，也不再显示「引用自…第 N 条回复」标签）。模型侧原文不动（令牌块原样上行）。
  // **折叠后不补换行**（2026-10-24 用户实报「引用发送后后面总有莫名其妙的换行」）：胶囊是行内元素，
  // 用户话术紧接其后自然流动；补 `\n` 会被 mdHtml 拆成下一段并落 `<br>`，表现为「引用后凭空换行」。
  // 三个渲染入口（messages.js userBodyHtml / approval.js renderTransient 的 bodyText 与队列 txt）共用本收口。
  const quoteBodiesAsMarkdown = foldQuoteBodies

  // 实时回显的用户消息：把令牌转 chip（与离线 messagesHtml 的 mdInline 一致）
  function renderUserText(text) {
    return esc(text)
      .replace(MENTION_PLUGIN_RE, (_, n) => mentionChipHtml('plugin', n))
      .replace(MENTION_SESSION_RE, (_, n) => mentionChipHtml('session', n))
      .replace(MENTION_PATH_RE, (_, t, p) => mentionChipHtml('path', p, t === '目录' ? 'dir' : 'file'))
      .replace(QUOTE_REF_RE, (_, p, a, b) => quoteRefChipHtml(p, a, b))
      .replace(QUOTE_REPLY_RE, (_, i, t, b) => quoteReplyChipHtml(i, t, b))
      .replace(QUOTE_PDF_RE, (_, p, a, b, q) => quotePdfChipHtml(p, a, b, q))
  }

  // 序列化 = CM doc 原文（2026-10-14 CM6 接管）：令牌文本本就是序列化形态、chip 是它的装饰视图。
  // 例外（2026-10-24）：引用原文在底栏 doc 里是折叠单行令牌（chip 即所见），发送时还原成
  // 「锚点行 + 原文 + 收尾行」的块形态——模型读到的必须是原文，不是百分号编码。
  function serializeInput() {
    return unfoldQuoteBodies(composerDocText())
  }

  // 复位 @ 数据态（不碰 DOM、不开关工具栏）：@ 关闭链与工具栏关闭链共用同一处，避免两套状态漂移。
  function resetMention() {
    mention.open = false
    mention.anchor = 0
    mention.q = ''
    mention.items = []
    mention.sel = 0
  }

  function closeMentionPop() {
    const wasOpen = mention.open
    resetMention()
    // 工具栏是 @ 与 + 的唯一弹窗（2026-10-25 用户定案）：@ 态结束必须把工具栏一起收起，
    // 否则会留下一个没有 @ 锚点却仍按 + 模式渲染的弹窗。closeCmdPop 不会回调本函数（只调 resetMention）。
    // 只在「@ 态确实开着」时才碰 cmd（composer 初始 mount 会在 commands.js 之前调本函数，
    // 此时 cmd 尚处 TDZ；wasOpen=false 短路即避开）。
    if (wasOpen && cmd.mentionMode) closeCmdPop()
    return wasOpen
  }

  function openMentionPopAtCaret() {
    if (!cmView) return
    mention.open = true
    mention.anchor = cmView.state.selection.main.from - 1 // '@' 的 doc 位置（composer onInputMention 判定后调）
    mention.sel = 0
    mention.q = ''
    // 输入 @ 不另立浮窗，直接唤起同一个 + 工具栏并进入 mention 模式（打开/加载/重渲统一在
    // commands.js 的 openCmdPopMention；本件只维护 @ 的锚点与查询词）。
    openCmdPopMention()
  }

  // 条目落地的唯一入口（点击与回车共用）：目录/上级=下钻重渲；文件=插 chip；会话/技能=插 chip。
  function selectMentionItem(it) {
    if (it.kind === 'pathup' || (it.kind === 'path' && it.ptype === 'dir')) {
      pickEnter(it).then(() => { if (cmd.open && cmd.mentionMode) renderCmdPop() })
      return
    }
    // 已上传附件（待办 6）：把正文 md 引用原文写回 doc（与自动插入同一形态，CM 行内直渲）。
    // kind=attref（images.js uploadedMentionItems 唯一产出）；imgpick/filepick 只作首屏上传动作行。
    if (it.kind === 'attref') {
      const pos = cmView ? cmView.state.selection.main.from : mention.anchor
      composerReplaceRange(mention.anchor, pos, it.md + ' ')
      closeMentionPop()
      syncGwSend()
      return
    }
    if (it.kind === 'path') insertMention('path', it.path, '', 'file')
    else insertMention(it.kind, it.name, it.sid)
  }

  // 键盘移动/选择：@ 模式与 + 模式共用同一个工具栏列表（cmd.items/cmd.active），直接转调 commands.js。
  // CM 键盘链先判 cmd.isOpen()，mention 分支只在理论上兜底——保持薄转调，不另存一份高亮状态。
  function moveMentionSel(d) {
    if (cmd.open && cmd.mentionMode) cmdMove(d)
  }

  function selectMention() {
    if (cmd.open && cmd.mentionMode) { cmdSelect(); return }
    const it = mention.items[mention.sel]
    if (it) selectMentionItem(it)
  }

  // 选中项 → 令牌 + 尾随空格替换 @查询区间（[mention.anchor, 光标]），光标到空格后。sid 仅会话
  // chip 有（寻址键，序列化为 `[会话:标题|sid]`；插件/技能无 sid）。
  function insertMention(kind, name, sid, ptype) {
    const token = kind === 'session'
      ? (sid ? `[会话:${name}|${sid}]` : `[会话:${name}]`)
      : kind === 'path'
        ? mentionPathToken(name, ptype)
        : `[插件:${name}]`
    const pos = cmView ? cmView.state.selection.main.from : mention.anchor
    composerReplaceRange(mention.anchor, pos, token + ' ')
    closeMentionPop()
    syncGwSend()
  }

  // doc/选区变化：检测 @ 触发 / 维护已打开的 @查询（光标前是 @ 则开浮窗）。锚点 = '@' 的 doc 位置
  function onInputMention() {
    if (!GATEWAY || gateAwait || state.mgr || !cmView) { closeMentionPop(); return }
    const st = cmView.state
    const pos = st.selection.main.from
    // IME 组合期（中文键盘敲字母即进入组合）：组合中的 doc 文本是**临时拼音/候选**，
    // 选区也不可信——拿它过滤会把浮窗筛空并按「无结果」关掉，或按选区判定误杀。
    // 组合期一律不判不动（不开、不更新查询、不关），等 compositionend 上屏后的 doc 事务
    // 走正常判定。`composing` 是 CM6 EditorView 的真实组合态字段（旧写法 compositionStarted
    // 根本不存在 ⇒ 守卫恒为假，查询词跟着组合中的临时文本乱跳）。组合结束由 onCompositionEnd
    // 再按最终 doc 判定一次，避免末次事务缺失时浮窗停在空查询的旧结果上。
    if (cmView.composing) return
    if (st.selection.main.from !== st.selection.main.to || !st.selection.main.empty) { if (mention.open) closeMentionPop(); return }
    if (mention.open) {
      const between = st.doc.sliceString(mention.anchor, pos)
      if (pos <= mention.anchor || /[\n\r]/.test(between)) { closeMentionPop(); return }
      const q = between.slice(1)
      if (q !== mention.q) { mention.q = q; if (cmd.open) renderCmdPop() }
      return
    }
    if (pos > 0 && st.doc.sliceString(pos - 1, pos) === '@') openMentionPopAtCaret()
  }
  function onInputChange() { syncGwSend(); onInputMention() }
  // IME 组合结束：CM 在 compositionend 后可能不再派发 doc/selection 事务（组合文本已在组合期
  // 进 doc），此时 @ 查询词仍是组合期旧值 ⇒ 浮窗停在空查询的全量列表。延后一拍按最终 doc 重判。
  function onCompositionEnd() {
    if (!cmView) return
    setTimeout(() => { if (cmView) onInputMention() }, 0)
  }

export {
  MENTION_PATH_RE,
  MENTION_PLUGIN_ICON,
  MENTION_PLUGIN_RE,
  MENTION_SESSION_ICON,
  MENTION_SESSION_RE,
  MENTION_SKILL_ICON,
  MENTION_UP_ICON,
  QUOTE_PDF_RE,
  QUOTE_REF_RE,
  QUOTE_REPLY_RE,
  buildMentionChip,
  closeMentionPop,
  insertMention,
  mention,
  mentionChipHtml,
  mentionChipIcon,
  moveMentionSel,
  onCompositionEnd,
  onInputChange,
  onInputMention,
  openMentionPopAtCaret,
  quotePdfChipHtml,
  quoteRefChipHtml,
  quoteReplyChipHtml,
  renderUserText,
  resetMention,
  selectMention,
  selectMentionItem,
  serializeInput,
  quoteBodiesAsMarkdown,
}
