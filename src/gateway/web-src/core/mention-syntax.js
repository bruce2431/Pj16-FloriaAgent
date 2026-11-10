// @ 提及 / 引用令牌的纯符号层（2026-10-10 自 inputbar/mention.js 下移为 core 叶子）：6 个令牌正则 +
// splitSessionToken + 4 个 chip-html 构造器 + 其所需的 2 个图标常量。core/markdown.js 渲染内联 chip 只
// 需此层——原先直连 inputbar/mention.js 使 core→feature 成环（SCC 27 模块），本层断开该边。
// 纯函数、无状态、无连接、无订阅（§12 core 叶子准入）：可被任意层依赖。唯一手改处，web/app.js 为生成物。

import { I, fileIcon } from './icons.js'
import { esc } from './util.js'
/* @module core/mention-syntax.js */
  const MENTION_PLUGIN_RE = /\[插件:([^\]]+)\]/g
  const MENTION_SESSION_RE = /\[会话:([^\]]+)\]/g
  // @ 提及 icon（2026-09-28 换 dsh v0.2.0-rc.1 产品图标集，16 描线/currentColor；旧 24 手绘那套作废）。
  // 语义与 dsh 一致：会话=ChatLines、插件=PluginPinwheel、技能=Skill、目录=FolderClose、文件=Browse
  // ——与 + 浮窗行图标同源（同一批 I.* 常量），两处不得分叉。
  const MENTION_SESSION_ICON = I.dshChat
  // 目录 / 文件引用令牌（2026-09-26）：令牌 [@目录:路径] / [@文件:路径] 与上传附件占位 [文件:<路径>]
  // 刻意不同名：后者会被 messages.js 的附件卡片链（userFilesHtml/userBodyHtml）剥走，同名会吞掉 @ chip。
  // 路径里允许出现 `]`（Windows 文件名唯一禁用的是 `\ / : * ? " < > |`），而 `]` 正是令牌收口符 ⇒
  // 不转义会把令牌提前截断（2026-10-25 用户实报：`[@文件:…_[1617+第5组+…] 1(1).pdf]` 只渲前半截，
  // 后面 `1(1).pdf]` 裸露成黑字）。转义符用 `\`（Windows 路径不可能含它）：`\`→`\\`、`]`→`\]`。
  // 正则 `(?:[^\]\\\n]|\\.)+` 认两种字符；旧令牌不含反斜杠 ⇒ 同一正则原样兼容，不引入双语法。
  const MENTION_PATH_RE = /\[@(目录|文件):((?:[^\]\\\n]|\\.)+)\]/g
  // 选中引用令牌（2026-09-28，inputbar/quote.js 产出）：`[@引用:<路径>#L12-L20]`——**只给位置**，
  // 模型自己 Read 该文件（与 `[文件:]` 上传占位、`[@文件:]` 路径 chip 都不同名，三者互不吞）。
  // 无行号（拿不到原文行偏移的文件）退化为 `[@引用:<路径>]`。MENTION_PATH_RE 只认「目录|文件」，
  // 不会抢「引用」。
  const QUOTE_REF_RE = /\[@引用:([^\]#]+?)(?:#L(\d+)-L?(\d+))?\]/g
  // 回复引用令牌（2026-09-28，同由 inputbar/quote.js 产出）：回复不属于任何文件、没有位置可查 ⇒
  // **原文必须进消息**（模型直接读到，以普通正文给出），进令牌的只是**锚点行**——`[@引用回复:<第N条>|<标题>]`。
  // 2026-10-21 起渲染侧（inputbar/mention.js quoteBodiesAsMarkdown）把原文块折成令牌的**第三个字段**
  // `[@引用回复:<第N条>|<标题>|<百分号编码原文>]`：气泡里「图标 + 原文」合成一枚蓝色引用胶囊（用户定案：
  // 不要「引用自…」字样，用引用的真实文本替换）。百分号编码是必需的——mdInline 在令牌替换之前先跑
  // 粗体/斜体/代码/链接/裸 URL，原文若原样夹带这些记号会被就地改写（*、~、反引号、括号等）。
  // 第三段省略 = 旧消息/纯锚点，退回来源标签形态。形态与 `[@引用:]`、`[@目录|文件:]` 互不吞。
  const QUOTE_REPLY_RE = /\[@引用回复:(\d+)\|([^\]|]*)(?:\|([^\]]*))?\]/g
  // PDF 引用令牌（2026-09-28，同由 inputbar/quote.js 经 floria-quote-open 产出）：`[@引用PDF:<路径>#p7]`。
  // PDF **没有行号**（Read 工具用 pages 参数，>10 页必须传），故位置粒度 = **路径 + 页码**（跨页 `#p7-9`，
  // 无页码退化纯路径）——与 `[@引用:]`（行号语义）刻意分家，混用会误导模型。
  // 第三段同回复引用 = 渲染侧折进来的百分号编码原文（2026-10-21）；省略 = 纯锚点。
  const QUOTE_PDF_RE = /\[@引用PDF:([^\]#|]+?)(?:#p(\d+)(?:-p?(\d+))?)?(?:\|([^\]]*))?\]/g
  const MENTION_FILE_ICON = I.dshFile

  // 令牌形态解析（会话令牌可带 sid：`标题|sid`，@ 提及 chip 序列化产出，CLI 侧按它精确寻址——
  // 见 src/utils/sessionAddressing.ts）。渲染一律只显示标题，sid 是给工具用的寻址键。
  function splitSessionToken(v) {
    const i = String(v).indexOf('|')
    return i >= 0 ? { title: String(v).slice(0, i), sid: String(v).slice(i + 1) } : { title: String(v), sid: '' }
  }

  // 路径令牌的转义/解码 + 唯一序列化口（@ 插入与「+」直选共用，禁各自拼字符串）。
  // 解码只认 `\X` → `X`：序列化侧保证反斜杠本身也成对转义，故不会误吞真实字符。
  function escapeMentionPath(p) {
    return String(p == null ? '' : p).replace(/\\/g, '\\\\').replace(/\]/g, '\\]')
  }
  function unescapeMentionPath(p) {
    return String(p == null ? '' : p).replace(/\\(.)/g, '$1')
  }
  function mentionPathToken(p, ptype) {
    return `[@${ptype === 'dir' ? '目录' : '文件'}:${escapeMentionPath(p)}]`
  }

  // chip HTML（name 为已转义文本：mdInline/addUser 入口已 esc，这里不再二次转义）
  // 消息内渲染=透明胶囊（无图标），仅保留名称文本（用户要求「只要一个白色浮窗似的胶囊」→ 透明胶囊）
  // 路径 chip 额外包一层 .mc-t：长路径在胶囊内省略号收口（inline-flex 直挂文本无法 text-overflow）
  // 2026-10-24 用户定案「发送后的引用 UI 要与底栏一致」：气泡侧三种 chip（路径/会话/插件）
  // 一律 = 图标 + 蓝字（与底栏 .mention 同构），不再有边框胶囊/等宽灰字/无图标形态。
  function mentionChipHtml(kind, name, ptype) {
    if (kind === 'path') {
      // chip 只显示**末段文件名**，全路径进 title：长路径前缀会把真正要看的文件名挤出可视区
      // （2026-10-25 用户实测：宽 180px 的胶囊只剩「@20261013120000-形…」）。
      const full = unescapeMentionPath(name)
      const base = full.split('/').pop()
      // 展示不带头部 @（2026-10-26 用户定案「引用的文本应该过滤掉艾特这个字符」）：
      // @ 只是输入侧唤出提及的手势字符，落地文本里它既不参与令牌解析也不属文件名。
      const label = base
      const icon = ptype === 'dir' ? I.dshFolder : fileIcon(full)
      // data-m* = 链接凭据（2026-11-08 单击跳转）：path/name 为令牌原文（name 已 esc），
      // 派发器 feature/mention-nav.js 据此解析项目与相对路径，不在渲染层做业务判断。
      // data-mreveal = 「在资源管理器中打开」按钮（dsh 文件引用卡同形）：目录=直接打开该目录，
      // 文件=打开所在目录并选中——落点仍是 `/gateway/file/reveal`，与 work 文件树同一链路。
      return `<span class="mention-chip m-path" title="${full}" data-mjump="path" data-mname="${name}" data-mptype="${ptype === 'dir' ? 'dir' : 'file'}"><span class="mc-ic">${icon}</span><span class="mc-t">${label}</span><span class="mc-act" role="button" title="在资源管理器中打开" data-mreveal="${name}">${I.dshFolder}</span></span>`
    }
    if (kind === 'session') {
      const title = splitSessionToken(name).title
      return `<span class="mention-chip m-session" data-mjump="session" data-mname="${name}"><span class="mc-ic">${MENTION_SESSION_ICON}</span><span class="mc-t">${title}</span></span>`
    }
    return `<span class="mention-chip m-plugin" data-mjump="plugin" data-mname="${name}"><span class="mc-ic">${I.dshPlugin}</span><span class="mc-t">${name}</span></span>`
  }

  // 引用原文编码（2026-10-21）：原文要挤进令牌的一行字段，必须先抹掉会被 mdInline 预处理的记号
  // （粗体/斜体 `*`、删除线 `~`、行内代码反引号、图片/链接括号、裸 URL 的 `:/`、以及会被 esc 改写的 `'`）。
  // encodeURIComponent 本身不含 `'()*!~`，逐个补编码；解码失败（旧令牌/手改文本）原样返回，不丢内容。
  const quoteEscChars = /['()*!~]/g
  function encodeQuoteBody(s) {
    return encodeURIComponent(String(s == null ? '' : s))
      .replace(quoteEscChars, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  }
  function decodeQuoteBody(s) {
    const raw = String(s == null ? '' : s)
    if (!raw) return ''
    try { return decodeURIComponent(raw) } catch (_) { return raw }
  }

  // ---------- 引用原文块 ⇄ 折叠令牌（唯一真源）----------
  // 块形态（模型侧/旧消息）：`[@引用回复:idx|标题]\n原文\n[/引用回复]`。
  // 折叠形态（渲染侧/底栏 doc）：`[@引用回复:idx|标题|<百分号编码原文>]`——单行，可整体装饰成一枚胶囊。
  // 底栏 doc 存折叠形态（chip 即所见），**发送时 unfoldQuoteBodies 还原块形态**，模型读到的仍是原文。
  const QUOTE_REPLY_BODY_RE = /\[@引用回复:(\d+)\|([^\]]*)\]([\s\S]*?)\[\/引用回复\]/g
  const QUOTE_PDF_BODY_RE = /(\[@引用PDF:[^\]]*\])([\s\S]*?)\[\/引用PDF\]/g
  const QUOTE_REPLY_FOLDED_RE = /\[@引用回复:(\d+)\|([^\]|\n]*)\|([^\]\n]*)\]/g
  const QUOTE_PDF_FOLDED_RE = /\[@引用PDF:([^\]|]+)\|([^\]\n]*)\]/g
  // 块 → 折叠。收尾令牌不保证独占一行（退格/编辑会把它与正文并到同行），故用非贪婪全量捕获。
  // **折叠后严禁补换行**（2026-10-24 用户实报「引用发送后后面总有莫名其妙的换行」）：mdHtml 按行
  // 拆段、行间落 <br>，块形态里锚点/原文/收尾三行只服务于模型；渲染侧整块折成一枚行内胶囊，
  // 用户话术必须紧接胶囊流动（补 \n 会变成紧跟在胶囊后的额外 <br>）。
  function foldQuoteBodies(text) {
    const clean = (body) => String(body == null ? '' : body).replace(/^\s+|\s+$/g, '')
    const withBody = (token, body) => token.replace(/\]$/, '|' + encodeQuoteBody(clean(body)) + ']')
    return String(text || '')
      .replace(QUOTE_REPLY_BODY_RE, (m, idx, title, body) => withBody(`[@引用回复:${idx}|${title}]`, body))
      .replace(QUOTE_PDF_BODY_RE, (m, token, body) => withBody(token, body))
  }
  // 折叠 → 块（发送口）：底栏 doc 的折叠胶囊在这里还原成模型可读的原文块。
  function unfoldQuoteBodies(text) {
    return String(text || '')
      .replace(QUOTE_REPLY_FOLDED_RE, (m, idx, title, bodyEnc) => {
        const body = decodeQuoteBody(bodyEnc)
        return body ? `[@引用回复:${idx}|${title}]\n${body}\n[/引用回复]` : m
      })
      .replace(QUOTE_PDF_FOLDED_RE, (m, token, bodyEnc) => {
        const body = decodeQuoteBody(bodyEnc)
        return body ? `${token}\n${body}\n[/引用PDF]` : m
      })
  }

  // 选中引用的消息内形态（透明胶囊 + 文件图标 + 「引用自 <文件名>」，与输入栏内 .mention.ref 同族观感）。
  // path 来自已 esc 的文本（mdInline/renderUserText 入口已整体转义），此处不再二次转义。
  // data-qjump/q* = 点击跳转凭据（chat/messages/msg-actions.js 委托 → 卡片公开 API）。
  function quoteRefChipHtml(path, l0, l1) {
    const name = String(path).split('/').pop()
    const range = l0 ? ':' + l0 + (l1 && l1 !== l0 ? '-' + l1 : '') : ''
    return `<span class="mention-chip m-ref" data-qjump="file" data-qpath="${path}" data-ql0="${l0 || ''}" title="${path}${range}（work 模式下点击打开）"><span class="mc-ic">${fileIcon(path)}</span><span class="mc-t">引用自 ${name}${range}</span></span>`
  }
  // 回复引用的消息内形态（2026-10-21 用户定案）：**图标跟随引用的真实文本**，不再显示「引用自…第 N 条回复」；
  // 文本沿用 .m-ref 的蓝色，data-qidx = 第 N 条（1-based .msg 文档序，与令牌同源），点击经 chat 卡片 scroll 跳转。
  // 原文来自编码字段 → 此处解码后必须 esc 一次（其余 chip 入参已由渲染入口整段转义，唯此段是解码产物）。
  function quoteReplyChipHtml(idx, title, bodyEnc) {
    const t = String(title || '').trim() || '本会话'
    const where = `引用自「${t}」· 第 ${idx} 条回复`
    const n = Number(idx) || 0
    const body = decodeQuoteBody(bodyEnc)
    if (body) {
      return `<span class="mention-chip m-ref m-quote" data-qjump="reply" data-qidx="${n}" title="${where}（点击跳转）"><span class="mc-ic">${MENTION_SESSION_ICON}</span><span class="mc-t">${esc(body)}</span></span>`
    }
    return `<span class="mention-chip m-ref" data-qjump="reply" data-qidx="${n}" title="${where}"><span class="mc-ic">${MENTION_SESSION_ICON}</span><span class="mc-t">${where}</span></span>`
  }
  // PDF 引用的消息内形态：同样「图标 + 真实原文」（蓝色）；位置（文件/页码）退到 title 提示，不再占正文。
  // 位置粒度 = 路径 + 页码（跨页「第 s-e 页」，无页码退化为仅文件名）。
  function quotePdfChipHtml(path, p0, p1, bodyEnc) {
    const name = String(path).split('/').pop()
    const pages = p0 ? ' · 第 ' + p0 + (p1 && p1 !== p0 ? '-' + p1 : '') + ' 页' : ''
    const where = `引用自 ${name}${pages}`
    const body = decodeQuoteBody(bodyEnc)
    if (body) {
      return `<span class="mention-chip m-ref m-quote" title="${where}"><span class="mc-ic">${fileIcon(path)}</span><span class="mc-t">${esc(body)}</span></span>`
    }
    return `<span class="mention-chip m-ref" title="${where}"><span class="mc-ic">${fileIcon(path)}</span><span class="mc-t">${where}</span></span>`
  }

export {
  MENTION_FILE_ICON,
  MENTION_PATH_RE,
  MENTION_PLUGIN_RE,
  MENTION_SESSION_ICON,
  MENTION_SESSION_RE,
  QUOTE_PDF_RE,
  QUOTE_REF_RE,
  QUOTE_REPLY_RE,
  decodeQuoteBody,
  encodeQuoteBody,
  escapeMentionPath,
  foldQuoteBodies,
  mentionChipHtml,
  mentionPathToken,
  quotePdfChipHtml,
  quoteRefChipHtml,
  quoteReplyChipHtml,
  splitSessionToken,
  unfoldQuoteBodies,
  unescapeMentionPath,
}
