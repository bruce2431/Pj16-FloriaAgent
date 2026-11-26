#!/usr/bin/env bun
/**
 * probe-quote-ref —— 选中文本引用（quote）链的结构不变量
 *
 * 链路：编辑区/消息流选中 → **松开鼠标**唤出浮窗（inputbar/quote.js；右键不拦）→ 引用 chip 落进输入栏
 * → serializeInput 出令牌 → 消息回显成同族胶囊。不变量：
 *  - 唤出手势：document mouseup（主键）+ 快照；**不得**再拦 contextmenu（浏览器原生菜单要留）；
 *  - 发送唯一口：浮窗的两个动作都必须经 inputbar/send.js 的 gwSend，不得自建 ws 发送；
 *  - chip 类名复用：引用 chip 必须是 `.mention`（× 删除与退格删除由 ctx-meter.js 的既有委托按此类处理）；
 *  - 令牌互斥：QUOTE_REF_RE 只认「引用」，MENTION_PATH_RE 只认「目录|文件」，两者不得互相吞；
 *  - 回显成对：renderUserText（乐观态）与 mdInline（落盘态）两个入口都要接 QUOTE_REF_RE；
 *  - 行号唯一来源 = 编辑器/DOM：非 md 编辑区纯文本走 Range 字符偏移、markdown 预览走 data-l 行锚；
 *    md 编辑区（CodeMirror 6 Live Preview）走编辑器文档 posAtDOM 反查源行号（wkEdQuoteLines）
 *    （**不得**拿渲染后的选中文本回查原文——格式符已丢，跨格式符边界必然找不到）；
 *  - 引用原文块只给模型看：回复/PDF 两族原文包在令牌块里，三个渲染入口渲染前必须剥块（气泡里只剩胶囊）；
 *  - PDF 引用（第三族）：位置 = 路径 + 页码，原文同样进消息；QUOTE_PDF_RE 与 QUOTE_REF_RE /
 *    QUOTE_REPLY_RE / MENTION_PATH_RE 四族互斥；
 *  - 项目申报动作（preview.json `quoteActions`）：纯数据（无 path/host），与内置行合流、同 id 内置优先，
 *    点击只回发 id（宿主不代执行）；动作表与 EXT 卡同一申报来源/生命周期（一次请求取两份申报）；
 *  - 预览桥：floria-quote-open / -close（预览页自报）/ -action（宿主回发），**门 = e.source 必须是当前
 *    .preview-frame 的 contentWindow**（按 e.source 反查帧，不取第一个）；坐标 = 帧内视口 + 帧偏移；
 *  - cache-bust 同值：sw.js 的 CACHE 版本与 index.html 的 ?v= 必须一致（只 bump 一处 = 老资源常驻）。
 */
import { existsSync, readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..')
const SRC = resolve(ROOT, 'src/gateway/web-src')
const WEB = resolve(ROOT, 'src/gateway/web')

let pass = 0
let fail = 0
const ok = (m: string) => { pass++; console.log(`PASS  ${m}`) }
const bad = (m: string) => { fail++; console.log(`FAIL  ${m}`) }

// EOL 归一：Windows 编辑链把工作区源码写成 CRLF（bundle-web-modules.ts 也在读取处归一），
// 而本探针大量按 `\n` 锚定抽源码正则 —— 不归一化会把「行尾风格」误判成「代码缺失」
// （2026-09-28 实红：QUOTE_*_RE / chip 函数全抽不出，连带整块断言被跳过，115→96 条）。
const read = (p: string) => readFileSync(p, 'utf-8').replace(/\r\n/g, '\n')

// 从源码里按花括号配平剥出一个函数（供探针 new Function 跑真身；比正则/固定缩进切片稳）
const fnSlice = (src: string, name: string) => {
  const i = src.indexOf(`function ${name}(`)
  if (i < 0) return ''
  let d = 0
  for (let k = src.indexOf('{', i); k >= 0 && k < src.length; k++) {
    if (src[k] === '{') d++
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1) }
  }
  return ''
}

// ---- 1. quote.js 存在且两个动作齐 ----
const QUOTE = resolve(SRC, 'inputbar/quote.js')
const q = existsSync(QUOTE) ? read(QUOTE) : ''
if (!existsSync(QUOTE)) {
  bad('缺少 src/gateway/web-src/inputbar/quote.js')
} else {
  ok('inputbar/quote.js 在盘')
  for (const fn of ['quoteSnapOf', 'openQuotePop', 'closeQuotePop', 'insertRefChip', 'quoteStash', 'quoteSendNow']) {
    if (new RegExp(`function ${fn}\\(`).test(q)) ok(`quote.js 定义 ${fn}()`)
    else bad(`quote.js 缺 ${fn}()`)
  }
  if (q.includes('await gwSend()')) ok('立即发送走唯一发送口 gwSend()')
  else bad('quoteSendNow 未走 gwSend()（自建发送链？）')
  if (!/gws\s*\.\s*send\(/.test(q)) ok('quote.js 不自建 ws 发送（gws.send 零命中）')
  else bad('quote.js 直接 gws.send —— 绕开了 gwSend 唯一发送口')
  // CM6 接管（2026-10-14 #17）：输入栏胶囊 = 引用令牌（refToken）进 doc 的原子装饰视图，不再是 DOM chip。
  if (/composerAppendRef\(refToken\(\{/.test(q)) ok('引用胶囊 = refToken 进 doc + CM6 原子装饰（.mention ref 类由装饰渲染）')
  else bad('引用胶囊未走 composerAppendRef(refToken(...)) —— CM6 接管后形态不对')
  if (!q.includes('wkEdText')) ok('quote.js 不再依赖编辑区原文缓存（行号唯一来源 = DOM）')
  else bad('quote.js 仍读 wkEdText —— 原文缓存已退役（应改走 data-l 行锚）')
  // 唤出手势（2026-09-28 用户定案）：松开鼠标那一刻；右键保留浏览器原生菜单
  if (/document\.addEventListener\('mouseup'/.test(q) && /if \(e\.button !== 0\) return/.test(q)) ok('唤出 = document mouseup（主键）')
  else bad('quote.js 未按 mouseup 唤出（用户定案：松开鼠标那一刻）')
  if (!/addEventListener\('contextmenu'/.test(q) && !/e\.preventDefault\(\)/.test(q.split('---------- 4.')[1] || '')) ok('不拦 contextmenu（浏览器原生菜单照旧）')
  else bad('quote.js 仍拦 contextmenu —— 用户要求保留原生右键菜单')
  if (/quoteSkipNextUp/.test(q)) ok('「点浮窗外关窗」的 mouseup 被消费（不会关掉又立刻重开）')
  else bad('缺 quoteSkipNextUp 守卫 —— 关窗后紧随的 mouseup 会把浮窗重开')
  // 「使用 AI 编辑」后光标必须落在胶囊之后（用户定案 2026-09-28：接着打字是给这条引用的说明）
  if (/function quoteStash\(snap\)[\s\S]{0,200}composerFocus\(\)/.test(q) && /composerAppendRef\(refToken/.test(q)) ok('「使用 AI 编辑」后光标落胶囊之后（composerAppendRef 落块尾 + composerFocus）')
  else bad('quoteStash 未把光标落到胶囊后 —— 打字会插在胶囊前面')
}

// ---- 2. 拼接器登记 + 执行序在启动序列之前 ----
const bundler = read(resolve(ROOT, 'scripts/bundle-web-modules.ts'))
// 2026-10-07 拼接器换 schema：顺序 = PIECES 数组下标（旧 ranges 假行号已删）。
const at = (f: string, p: number) =>
  bundler.search(new RegExp(`file:\\s*'${f.replace(/\./g, '\\.')}',\\s*part:\\s*${p}\\b`))
const entry = at('inputbar/quote.js', 1)
if (entry >= 0) {
  ok(`拼接器已登记 inputbar/quote.js（PIECES 第 ${entry} 位）`)
  // 启动序列 = __app__ part 2（PIECES 恒居末）。顶层事件委托须排在它之前。
  const boot = at('__app__', 2)
  if (boot >= 0 && entry < boot) ok(`quote.js 排在启动序列（PIECES 第 ${boot} 位）之前——顶层事件委托先于启动注册`)
  else bad(`quote.js 位次 ${entry} 晚于启动序列 ${boot}`)
} else {
  bad('拼接器 PIECES 未登记 inputbar/quote.js（新模块不会进 app.js）')
}

// ---- 3. 令牌正则：从源码抽真身来测（不在探针里复刻）----
// 令牌正则/chip 已下移 core/mention-syntax.js（cbcad75 分层治理，core←feature 断环）；mention.js 只余
// 浮窗/回显/stripQuoteBodies/refToken 并 re-export 令牌。两件拼接后仍是「整族源码」，reOf/fnSlice 照旧命中。
const mention = read(resolve(SRC, 'core/mention-syntax.js')) + '\n' + read(resolve(SRC, 'inputbar/mention.js'))
const reOf = (name: string) => {
  const m = mention.match(new RegExp(`const ${name} = (\\/.*\\/[a-z]*)\\n`))
  if (!m) return null
  // eslint-disable-next-line no-new-func
  return new Function(`return ${m[1]}`)() as RegExp
}
const QRE = reOf('QUOTE_REF_RE')
const MRE = reOf('MENTION_PATH_RE')
if (QRE && MRE) {
  ok('从源码抽出 QUOTE_REF_RE / MENTION_PATH_RE 真身')
  const hit = (re: RegExp, s: string) => { re.lastIndex = 0; return re.exec(s) }
  const m1 = hit(QRE, '[@引用:Floria/src/x.ts#L12-20]')
  if (m1 && m1[1] === 'Floria/src/x.ts' && m1[2] === '12' && m1[3] === '20') ok('带行号令牌解析：路径 + 起止行')
  else bad(`带行号令牌解析异常：${JSON.stringify(m1 && m1.slice(1))}`)
  const m2 = hit(QRE, '前文 [@引用:src/a b.md] 后文')
  if (m2 && m2[1] === 'src/a b.md' && m2[2] === undefined) ok('无行号令牌解析：整段作路径、行号为空')
  else bad(`无行号令牌解析异常：${JSON.stringify(m2 && m2.slice(1))}`)
  if (!hit(QRE, '[@文件:src/x.ts]')) ok('QUOTE_REF_RE 不吞 [@文件:] 路径 chip（互斥）')
  else bad('QUOTE_REF_RE 吞掉了 [@文件:] 令牌')
  if (!hit(MRE, '[@引用:src/x.ts#L1-2]')) ok('MENTION_PATH_RE 不吞 [@引用:] 令牌（互斥）')
  else bad('MENTION_PATH_RE 吞掉了 [@引用:] 令牌')
  // 回复引用令牌：`[@引用回复:<第N条>|<标题>]`
  const RRE = reOf('QUOTE_REPLY_RE')
  if (RRE) {
    ok('从源码抽出 QUOTE_REPLY_RE 真身')
    const r1 = hit(RRE, '前文 [@引用回复:12|引用文本功能] 后文')
    if (r1 && r1[1] === '12' && r1[2] === '引用文本功能') ok('回复引用令牌解析：序号 + 会话标题')
    else bad(`回复引用令牌解析异常：${JSON.stringify(r1 && r1.slice(1))}`)
    if (!hit(QRE, '[@引用回复:12|引用文本功能]')) ok('QUOTE_REF_RE 不吞 [@引用回复:] 令牌（互斥）')
    else bad('QUOTE_REF_RE 吞掉了 [@引用回复:] 令牌')
    if (!hit(RRE, '[@引用:src/x.ts#L1-2]')) ok('QUOTE_REPLY_RE 不吞 [@引用:] 令牌（互斥）')
    else bad('QUOTE_REPLY_RE 吞掉了 [@引用:] 令牌')
  } else {
    bad('未能从 mention.js 抽出 QUOTE_REPLY_RE')
  }
} else {
  bad('未能从 mention.js 抽出 QUOTE_REF_RE / MENTION_PATH_RE')
}

// ---- 4. 序列化分支 + 回显成对 ----
// CM6 接管（2026-10-14）：序列化 = doc 原文（serializeInput 退化为 composerDocText()，令牌块自承载
// 原文语义，不再有 k==='ref' 的拼接分支）。
if (/function serializeInput\(\)\s*\{\s*return composerDocText\(\)/.test(mention)) ok('serializeInput = composerDocText()（doc 单真源，令牌块自承载）')
else bad('serializeInput 未退化到 composerDocText（引用序列化形态不对）')
if (/rkind !== 'file'/.test(mention) && /\[@引用回复:\$\{/.test(mention)) ok('refToken：回复引用出原文 + 锚点令牌')
else bad('refToken 的回复引用分支缺失/形态变了')
if (/return fileLinkMarkdown\(refPath\(d\.file, d\.proj\), d\.l0, d\.l1\)/.test(mention)) ok('refToken：文件引用回归 md 行内链接（行范围进 URL，不含原文）')
else bad('refToken 的文件引用分支未回归 md 行内链接')
if (/\.replace\(QUOTE_REF_RE/.test(mention)) ok('renderUserText 接 QUOTE_REF_RE（乐观态回显）')
else bad('renderUserText 未接 QUOTE_REF_RE')
if (/\.replace\(QUOTE_REPLY_RE/.test(mention)) ok('renderUserText 接 QUOTE_REPLY_RE（乐观态回显）')
else bad('renderUserText 未接 QUOTE_REPLY_RE')
const md = read(resolve(SRC, 'core/markdown.js'))
// 公式文法唯一真源（core/math-spec.js，2026-10-15 待办 11）：markdown.js 的 extractMath 消费 MATH_SRC_*，
// §9 跑真身 mdHtml 时必须同源注入（否则 extractMath 未定义、整件抛）。
const specSrc2 = read(resolve(SRC, 'core/math-spec.js'))
const specCut = specSrc2.search(/^export \{/m)
const specBody = (specCut >= 0 ? specSrc2.slice(0, specCut) : specSrc2).split('\n').filter((l) => !/^\s*import\s/.test(l)).join('\n')
const mathSpec = new Function(`${specBody}\nreturn { MATH_SRC_BLOCK_DOLLAR, MATH_SRC_BLOCK_BRACKET, MATH_SRC_INLINE_PAREN, MATH_SRC_INLINE_DOLLAR, mathInlineOk }`)() as Record<string, unknown>
if (!mathSpec.MATH_SRC_BLOCK_DOLLAR || typeof mathSpec.mathInlineOk !== 'function') { console.error('❌ 未能装载 core/math-spec.js 真源'); process.exit(1) }
if (/\.replace\(QUOTE_REF_RE/.test(md)) ok('mdInline 接 QUOTE_REF_RE（落盘态回显）')
else bad('mdInline 未接 QUOTE_REF_RE')
if (/\.replace\(QUOTE_REPLY_RE/.test(md)) ok('mdInline 接 QUOTE_REPLY_RE（落盘态回显）')
else bad('mdInline 未接 QUOTE_REPLY_RE')

// 原文块剥离函数真身（§4c 与 §9 共用）：QUOTE_REPLY_BODY_RE / QUOTE_PDF_BODY_RE 是模块级常量，须注入
const QRBODY = reOf('QUOTE_REPLY_BODY_RE')
const QPBODY = reOf('QUOTE_PDF_BODY_RE')
const stripBodySrc = fnSlice(mention, 'stripQuoteBodies')
// eslint-disable-next-line no-new-func
const stripBody = (QRBODY && QPBODY && stripBodySrc ? new Function('QUOTE_REPLY_BODY_RE', 'QUOTE_PDF_BODY_RE', `${stripBodySrc}\nreturn stripQuoteBodies`)(QRBODY, QPBODY) : null) as ((t: string) => string) | null

// ---- 4b. 回复引用：真身 refToken 的**首尾不得带换行**（用户实报「文本的引用自带一个换行」）----
{
  const rtSrc = fnSlice(mention, 'refToken')
  if (!rtSrc) bad('未能剥出 refToken 函数体')
  else {
    // eslint-disable-next-line no-new-func
    const rt = new Function('refPath', `${rtSrc}\nreturn refToken`)((f: string) => f) as (d: Record<string, unknown>) => string
    const tok = rt({ rkind: 'reply', quote: '第一行\n第二行', title: '引用文本功能', idx: 12 })
    const want = '[@引用回复:12|引用文本功能]\n第一行\n第二行\n[/引用回复]'
    if (tok === want) ok('回复引用令牌形态：锚点令牌 + 原文块（/引用回复 收尾）')
    else bad(`回复引用令牌形态变了：${JSON.stringify(tok)}`)
    if (!tok.startsWith('\n') && !tok.endsWith('\n')) ok('回复引用令牌首尾无换行（不自带空行）')
    else bad('回复引用令牌首尾仍带换行')
    // 标题内的 `]` / `|` / 换行是令牌结构字符：必须被替换掉，否则令牌碎裂
    const t2 = rt({ rkind: 'reply', quote: 'x', title: 'a]b|c\nd', idx: 3 })
    if (t2 === '[@引用回复:3|a b c d]\nx\n[/引用回复]') ok('标题内结构字符（] | 换行）已归一，令牌不碎裂')
    else bad(`标题未归一：${JSON.stringify(t2)}`)
  }
}

// ---- 4c. 原文块只给模型看：渲染前必须剥掉（用户实报「为什么文本信息也在气泡里」）----
{
  const bodyReSrc = mention.match(/const QUOTE_REPLY_BODY_RE = (\/[^\n]*\/g)/)
  const pdfReSrc = mention.match(/const QUOTE_PDF_BODY_RE = (\/[^\n]*\/g)/)
  const stripSrc = fnSlice(mention, 'stripQuoteBodies')
  if (!bodyReSrc || !pdfReSrc || !stripSrc) bad('缺 QUOTE_REPLY_BODY_RE / QUOTE_PDF_BODY_RE / stripQuoteBodies')
  else if (!stripBody) bad('stripQuoteBodies 真身未能装载')
  else {
    const strip = stripBody
    const wrapped = '[@引用回复:12|引用文本功能]\n第一行\n第二行\n[/引用回复]'
    const out = strip(wrapped)
    if (out === '[@引用回复:12|引用文本功能]') ok('stripQuoteBodies：回复原文块压回单一锚点令牌（气泡里不出现原文）')
    else bad(`stripQuoteBodies 回复块形态变了：${JSON.stringify(out)}`)
    const mixed = '看这段：' + wrapped + ' 就这样'
    if (strip(mixed) === '看这段：[@引用回复:12|引用文本功能] 就这样') ok('块外正文字节不动（只吃引用块本身）')
    else bad(`stripQuoteBodies 吃掉了块外正文：${JSON.stringify(strip(mixed))}`)
    if (strip(out) === out) ok('stripQuoteBodies 幂等（裸令牌不受影响）')
    else bad('stripQuoteBodies 非幂等')
    // PDF 引用块：同族手法——整块压回单令牌（PDF 原文同样只给模型看）
    const pdfWrapped = '[@引用PDF:Pj13/paper.pdf#p7]\n第七页原文\n[/引用PDF]'
    const pOut = strip(pdfWrapped)
    if (pOut === '[@引用PDF:Pj13/paper.pdf#p7]') ok('stripQuoteBodies：PDF 原文块压回单一锚点令牌')
    else bad(`stripQuoteBodies PDF 块形态变了：${JSON.stringify(pOut)}`)
    // 三个渲染入口都要过这一刀（漏一个 = 该路径仍把原文摆进气泡）
    const messages = read(resolve(SRC, 'chat/messages/msg-actions.js'))
    const approval = read(resolve(SRC, 'inputbar/approval.js'))
    if (/export \{[^}]*stripQuoteBodies,/.test(mention)) ok('mention.js 导出 stripQuoteBodies')
    else bad('mention.js 未导出 stripQuoteBodies')
    if (/import \{[^}]*stripQuoteBodies[^}]*\} from '[^']*inputbar\/mention\.js'/.test(messages) && /stripQuoteBodies\(txt\)/.test(messages)) ok('messages.js 落盘气泡渲染前剥原文块')
    else bad('messages.js 未剥原文块 —— 原文仍会出现在气泡里')
    if ((approval.match(/stripQuoteBodies\(/g) || []).length >= 2) ok('approval.js 乐观气泡 + 排队项两处都剥')
    else bad('approval.js 漏剥（乐观气泡或排队项）')
    if (!/stripQuoteReplyBody/.test(mention) && !/stripQuoteReplyBody/.test(messages) && !/stripQuoteReplyBody/.test(approval)) ok('旧名 stripQuoteReplyBody 已全链退役（单一剥块入口）')
    else bad('仍有 stripQuoteReplyBody 残留（双入口）')
  }
}

// ---- 4d. PDF 引用令牌（第三族，2026-09-28）：路径 + 页码，与既有三族互斥 ----
{
  const PRE = reOf('QUOTE_PDF_RE')
  if (!PRE) bad('未能从 mention.js 抽出 QUOTE_PDF_RE')
  else {
    const hit = (re: RegExp, s: string) => { re.lastIndex = 0; return re.exec(s) }
    const m1 = hit(PRE, '[@引用PDF:Pj13/paper.pdf#p7]')
    if (m1 && m1[1] === 'Pj13/paper.pdf' && m1[2] === '7' && m1[3] === undefined) ok('PDF 令牌解析：路径 + 单页')
    else bad(`PDF 单页令牌解析异常：${JSON.stringify(m1 && m1.slice(1))}`)
    const m2 = hit(PRE, '[@引用PDF:Pj13/paper.pdf#p7-9]')
    if (m2 && m2[1] === 'Pj13/paper.pdf' && m2[2] === '7' && m2[3] === '9') ok('PDF 令牌解析：跨页 s-e')
    else bad(`PDF 跨页令牌解析异常：${JSON.stringify(m2 && m2.slice(1))}`)
    const m3 = hit(PRE, '[@引用PDF:Pj13/paper.pdf]')
    if (m3 && m3[1] === 'Pj13/paper.pdf' && m3[2] === undefined) ok('PDF 令牌解析：无页码退化路径')
    else bad(`PDF 无页码令牌解析异常：${JSON.stringify(m3 && m3.slice(1))}`)
    const QRE2 = reOf('QUOTE_REF_RE')
    const RRE2 = reOf('QUOTE_REPLY_RE')
    const MRE2 = reOf('MENTION_PATH_RE')
    if (QRE2 && !hit(QRE2, '[@引用PDF:a.pdf#p1]')) ok('QUOTE_REF_RE 不吞 [@引用PDF:] 令牌（互斥）')
    else bad('QUOTE_REF_RE 吞掉了 [@引用PDF:] 令牌')
    if (RRE2 && !hit(RRE2, '[@引用PDF:a.pdf#p1]')) ok('QUOTE_REPLY_RE 不吞 [@引用PDF:] 令牌（互斥）')
    else bad('QUOTE_REPLY_RE 吞掉了 [@引用PDF:] 令牌')
    if (MRE2 && !hit(MRE2, '[@引用PDF:a.pdf#p1]')) ok('MENTION_PATH_RE 不吞 [@引用PDF:] 令牌（互斥）')
    else bad('MENTION_PATH_RE 吞掉了 [@引用PDF:] 令牌')
    if (!hit(PRE, '[@引用:src/x.ts#L1-2]')) ok('QUOTE_PDF_RE 不吞 [@引用:] 令牌（互斥）')
    else bad('QUOTE_PDF_RE 吞掉了 [@引用:] 令牌')
  }
  // refToken 的 pdf 分支（2026-11-26 用户定案「文件相关的引用全部回归 md」）：
  // 引用块原文 + 来源行内链接（路径#p页码），首尾无换行
  const rtSrc = fnSlice(mention, 'refToken')
  if (rtSrc) {
    // refToken 的 pdf/file 分支依赖 mention-syntax 的三个序列化口，真身一并注入
    const seqSrc = ['escapeMentionPath', 'mentionPathToken', 'fileLinkMarkdown', 'pdfLinkMarkdown', 'quoteBlockMarkdown']
      .map((n) => fnSlice(mention, n)).join('\n')
    // eslint-disable-next-line no-new-func
    const rt = new Function('refPath', `${seqSrc}\n${rtSrc}\nreturn refToken`)((f: string) => f) as (d: Record<string, unknown>) => string
    const tok = rt({ rkind: 'pdf', file: 'paper.pdf', quote: '第七页原文', p0: 7, p1: 7 })
    if (tok === '> 第七页原文\n\n[`paper.pdf · 第 7 页`](paper.pdf#p7)') ok('refToken：PDF 引用 = 引用块原文 + 来源 md 链接（页码进 URL）')
    else bad(`PDF refToken 形态变了：${JSON.stringify(tok)}`)
    const tok2 = rt({ rkind: 'pdf', file: 'paper.pdf', quote: 'x', p0: 7, p1: 9 })
    if (tok2.endsWith('[`paper.pdf · 第 7-9 页`](paper.pdf#p7-9)')) ok('refToken：PDF 跨页页码 s-e')
    else bad(`PDF 跨页链接形态变了：${JSON.stringify(tok2)}`)
    if (!tok.startsWith('\n') && !tok.endsWith('\n')) ok('PDF 引用首尾无换行')
    else bad('PDF 引用首尾带换行')
    // 文件引用：行范围只进 URL（chip 显示名 名:12-20 由 fileLinkLabel/mdInline 统一拼）
    const f1 = rt({ rkind: 'file', file: 'src/x.ts', l0: 12, l1: 20 })
    if (f1 === '[`x.ts`](src/x.ts#L12-20)') ok('refToken：文件引用 = md 行内链接（行范围进 URL）')
    else bad(`文件引用 refToken 形态变了：${JSON.stringify(f1)}`)
    const f2 = rt({ rkind: 'file', file: 'src/x.ts' })
    if (f2 === '[`x.ts`](src/x.ts)') ok('refToken：无行号文件引用 = 纯 md 行内链接')
    else bad(`无行号文件引用形态变了：${JSON.stringify(f2)}`)
  } else {
    bad('未能剥出 refToken 函数体（PDF 分支）')
  }
  // 回显成对：renderUserText + mdInline 都要接 QUOTE_PDF_RE
  if (/\.replace\(QUOTE_PDF_RE/.test(mention)) ok('renderUserText 接 QUOTE_PDF_RE（乐观态回显）')
  else bad('renderUserText 未接 QUOTE_PDF_RE')
  if (/\.replace\(QUOTE_PDF_RE/.test(md)) ok('mdInline 接 QUOTE_PDF_RE（落盘态回显）')
  else bad('mdInline 未接 QUOTE_PDF_RE')
}

// ---- 4e. 项目申报的浮窗动作（2026-09-28）：纯数据表 + 与内置行合流 ----
{
  // 浮窗动作表宿主已迁 views/registry.js → engine/ext-runtime.js（视图卡分层治理，views/ 仅余 cards/）
  const registry = read(resolve(SRC, 'engine/ext-runtime.js'))
  const extDecl = read(resolve(SRC, 'engine/ext-decl.js'))   // 申报规范化：normQuoteActions（ext-card → engine/ext-decl 分层治理）
  const preview = read(resolve(SRC, 'feature/preview-frame.js'))  // syncExtCards 宿主（views/cards/preview → feature/preview-frame）
  if (/function normQuoteActions\(/.test(extDecl) && /function registerQuoteActions\(/.test(registry) && /function quoteActions\(/.test(registry)) ok('动作表：ext-decl.normQuoteActions + ext-runtime.registerQuoteActions/quoteActions 齐')
  else bad('动作表缺失（normQuoteActions / registerQuoteActions / quoteActions）')
  if (/export \{[^}]*normQuoteActions,/.test(extDecl) || /normQuoteActions,/.test(extDecl)) ok('ext-decl.js 导出 normQuoteActions')
  else bad('ext-decl.js 未导出 normQuoteActions')
  if (/export \{[^}]*registerQuoteActions[\s\S]*?quoteActions/.test(registry) || (/registerQuoteActions/.test(registry.split('export {')[1] || '') && /quoteActions/.test(registry.split('export {')[1] || ''))) ok('registry.js 导出 registerQuoteActions / quoteActions')
  else bad('registry.js 未导出动作表接口')
  // 一次请求取两份申报：syncExtCards 同一 then 里落两张表，且清理点一致
  if (/clearQuoteActions\(\)/.test(preview) && /registerQuoteActions\(label, d && d\.quoteActions\)/.test(preview)) ok('previewCard.syncExtCards 同点取两份申报（不新增请求）')
  else bad('previewCard.syncExtCards 未同步动作表')
  if (/clearExtCards\(\)[\s\S]{0,80}clearQuoteActions\(\)/.test(preview)) ok('EXT 卡与动作表同点清理（生命周期一致）')
  else bad('动作表未与 EXT 卡同点清理（会残留上个项目动作）')
  // 动作 = 纯数据：normQuoteActions 不得带 path / host
  const nq = fnSlice(extDecl, 'normQuoteActions')
  if (nq && !/\bpath\b/.test(nq) && !/\bhost\b/.test(nq) && /\/\^\[a-zA-Z0-9_-\]\{1,32\}\$\//.test(nq)) ok('normQuoteActions：纯数据（无 path/host），id 白名单 + 去重')
  else bad('normQuoteActions 形态变了（应纯数据、id 白名单）')
  // quote.js 合流：内置行恒在 + 申报行追加 + 同 id 内置优先
  if (/function quoteActionRows\(/.test(q) && /QUOTE_BUILTIN_ID = 'ai-edit'/.test(q) && /a\.id !== QUOTE_BUILTIN_ID/.test(q)) ok('quote.js 动作合流：内置「使用 AI 编辑」恒在，同 id 申报行被略过')
  else bad('quote.js 动作合流缺失/形态变了')
  if (/function quoteRunAction\(/.test(q) && /postMessage\(\{ type: 'floria-quote-action', id \}/.test(q)) ok('申报动作点击只回发 id（宿主不代执行）')
  else bad('quoteRunAction 未按「只回发 id」落地')
  if (/id === QUOTE_BUILTIN_ID\) quoteStash\(snap\)/.test(q) && /else quoteRunAction\(id, snap\)/.test(q)) ok('动作分发：内置走 quoteStash，申报走 quoteRunAction')
  else bad('动作分发链断裂')
}

// ---- 4f. 项目预览桥（floria-quote-open / -close / -action）----
{
  if (/const QUOTE_FRAME_SEL = '\.preview-frame'/.test(q)) ok('桥：预览帧选择器常量化')
  else bad('桥缺少预览帧选择器')
  if (/function quoteFrameBySource\(/.test(q) && /el\.contentWindow === src/.test(q)) ok('桥按 e.source 反查帧（不取第一个 .preview-frame）')
  else bad('桥未按 e.source 反查帧 —— 多帧在场会认错帧')
  if (/function quoteFrameRect\(/.test(q) && /frame\.getBoundingClientRect\(\)/.test(q)) ok('桥做坐标换算（帧内视口坐标 + 帧偏移）')
  else bad('桥缺坐标换算 —— 浮窗落点会漂')
  if (/window\.addEventListener\('message', quoteBridgeOnMessage\)/.test(q)) ok('桥挂 message 监听')
  else bad('桥未挂 message 监听')
  if (/d\.type !== 'floria-quote-open' && d\.type !== 'floria-quote-close'/.test(q)) ok('桥只认 floria-quote-open / -close 两类')
  else bad('桥的入口类型判定形态变了')
  if (/!frame\) return/.test(q)) ok('桥门：非当前预览帧的输入一律不理（e.source 守门）')
  else bad('桥缺守门 —— 任意窗口都能开浮窗')
  if (/kind: 'pdf'/.test(q) && /proj: frame\.dataset\.label/.test(q)) ok('桥落地为 pdf 引用（proj 取帧 data-label）')
  else bad('桥落地的引用形态变了')
  // 一次性：项目申报来源开窗后，浮窗动作能回发（frame 必须随快照留存；快照恒以实参传递，无模块级状态）
  if (/const w = snap && snap\.frame/.test(q)) ok('回发锚点（frame）随快照留存')
  else bad('快照的 frame 未留存 —— 申报动作无处回发')
}

// ---- 4g. 触屏 = iOS 原生选中菜单（2026-10-02：撤掉自绘选中引擎，消除双框）----
// 根因：宿主自绘选中栏与 iOS 系统菜单并存（双框）；且程序化选区压不住 iOS 原生选择手势（pointerdown 是
// passive，480ms 抢跑拦不住）⇒ 触屏一律回归原生。quote.js 的 mouseup 由 IS_TOUCH_DEVICE 直接早退，触屏
// 不再弹宿主浮窗（PDF 预览页的 postMessage 桥是另一条来源，不受此门影响）。
{
  if (!existsSync(resolve(SRC, 'inputbar/quote-touch.js'))) ok('触屏自绘引擎 quote-touch.js 已删（不再程序化接管选区）')
  else bad('inputbar/quote-touch.js 仍在盘 —— 触屏自绘选中栏会与系统菜单双框')
  if (/import \{ IS_TOUCH_DEVICE \} from '\.\.\/sidebar\/recent\.js'/.test(q)) ok('quote.js 引入 IS_TOUCH_DEVICE（触屏门）')
  else bad('quote.js 未引入 IS_TOUCH_DEVICE —— 触屏守卫无处落')
  if (/if \(IS_TOUCH_DEVICE\) return/.test(q)) ok('quote.js mouseup 触屏早退（触屏不再弹宿主浮窗，回归 iOS 原生）')
  else bad('quote.js 缺触屏早退守卫 —— 触屏抬手合成 mouseup 会弹出浮窗，与系统菜单双框')
  if (!/quoteTouchOwnsSelection/.test(q)) ok('旧触屏让位守卫已清（无残留引用）')
  else bad('quote.js 仍引用 quoteTouchOwnsSelection —— 该函数已随 quote-touch.js 删除')
  if (!bundler.includes("inputbar/quote-touch.js")) ok('拼接器已移除 quote-touch.js 登记')
  else bad('拼接器仍登记 quote-touch.js')
  // 快照单一构造入口（与触屏无关，随原 4g 块保留）
  if (/function quoteSnapOfRange\(/.test(q) && /function quoteSnapOf\(\)/.test(q) && !/let quoteSnap\b/.test(q)) ok('快照单一入口 quoteSnapOfRange(range)；模块级 quoteSnap 状态源已删')
  else bad('快照链仍双源（quoteSnapOfRange 缺失 / 或模块级 quoteSnap 状态残留）')
}

// ---- 4h. 网关侧：preview.json 的 quoteActions 段（W1）----
{
  const gw = read(resolve(SRC, '../localGateway.ts'))
  if (/interface PreviewQuoteAction/.test(gw) && /function readPreviewQuoteActions\(/.test(gw)) ok('网关：PreviewQuoteAction + readPreviewQuoteActions 齐')
  else bad('网关缺 quoteActions 读取（PreviewQuoteAction / readPreviewQuoteActions）')
  if (/quoteActions: readPreviewQuoteActions\(cDir\)/.test(gw)) ok('preview-cards 端点响应并入 quoteActions（一次请求取两份申报）')
  else bad('端点未并入 quoteActions')
  if (/\/\^\[a-zA-Z0-9_-\]\{1,32\}\$\//.test(gw) && /icon: typeof a\.icon === 'string'/.test(gw)) ok('网关侧同样校验 id 白名单 + icon 缺省')
  else bad('网关侧字段校验缺失')
}

// ---- 5. 编辑区行号唯一来源 = CodeMirror 文档（所有可编辑文本文件统一编辑器）----
// 反例（已根治）：拿「渲染后的选中文本」回查原文——渲染把 `**`/`` ` ``/链接等格式符丢了，
// 选中一旦跨在格式符边界上 indexOf 必然 -1 ⇒ 行号丢失。
// 2026-10-07：编辑区统一为 CodeMirror 6（md 走 Live Preview、其余按扩展名高亮），行号不再来自渲染期
// data-l 行锚或纯文本字符偏移，而由编辑器文档经 posAtDOM 反查（work.js wkEdQuoteLines）。
// work 家族（2026-10-13 God Module 拆分）：work.js + sidebar/work/*.js 拼接读取（wkEdQuoteLines 已下移 work/work-cm.js）
const WORK_DIR2 = resolve(SRC, 'sidebar/work')
const work = [read(resolve(SRC, 'sidebar/work.js')), ...readdirSync(WORK_DIR2).filter((f) => f.endsWith('.js')).map((f) => read(resolve(WORK_DIR2, f)))].join('\n')
if (/function wkEdQuoteLines\(range\)/.test(work) && /posAtDOM\(/.test(work) && /lineAt\(/.test(work)) ok('work.js：选区行号 = CodeMirror posAtDOM → 源行号（wkEdQuoteLines）')
else bad('work.js 缺 wkEdQuoteLines —— 选区 → 行号链断开')
if (!/mdHtml\([^)]*data-l/.test(work)) ok('work.js 不再经 mdHtml 落行锚（编辑区已改 CodeMirror）')
else bad('work.js 仍在 mdHtml 传行锚 —— 旧渲染路径未清')
if (/function mdHtml\(src\)/.test(md)) ok('mdHtml 已收单参（lineAttr 行锚子系统移除）')
else bad('mdHtml 仍带 lineAttr —— 旧行锚子系统未清')
if (!/data-l0|const la = \(n\)|const lr = \(a, b\)|para\.push\(lw\(|codeNums/.test(md)) ok('markdown.js 无 la/lr/lw/行锚残留')
else bad('markdown.js 仍留行锚 la/lr/lw/codeNums')
if (/wkEdQuoteLines\(range\)/.test(q)) ok('quote.js 调 wkEdQuoteLines（同一 IIFE 作用域按名调用）')
else bad('quote.js 未接 wkEdQuoteLines —— 编辑区引用取不到行号')
if (/body\.querySelector\('\.wk-ed-cm'\)/.test(q)) ok('quote.js 编辑器分支以 .wk-ed-cm 判定（CodeMirror 宿主在场）')
else bad('quote.js 未以 .wk-ed-cm 判定编辑器分支')
if (!/QUOTE_LINE_ATTR|quoteLineOf|pre\.wk-code|data-l0|\bdata-l\b/.test(q)) ok('quote.js 已删 DOM 行锚 / 纯文本偏移旧路径（编辑器唯一来源）')
else bad('quote.js 仍留 DOM 行锚 / 纯文本偏移旧路径')
if (!/indexOf\(text\)/.test(q)) ok('quote.js 已删「渲染文本回查原文」的启发式')
else bad('quote.js 仍在用 indexOf 回查原文（跨格式符必失败）')

// ---- 6. 样式 ----
const css = read(resolve(WEB, 'styles.css'))
for (const sel of ['.quote-pop', '.qp-row', '.qp-bar', '.qp-send', '.mention.ref', '.mention-chip.m-ref', '.qp-row .qp-ic']) {
  if (css.includes(sel)) ok(`styles.css 含 ${sel}`)
  else bad(`styles.css 缺 ${sel}`)
}
// 触屏自绘选中栏样式已随引擎撤除（2026-10-02）
if (!/\.quote-bar|\.qb-item|\.qh-knob/.test(css)) ok('触屏选中栏/柄样式已清（.quote-bar/.qb-item/.qh-knob 无残留）')
else bad('styles.css 仍留触屏选中栏/柄样式 —— 自绘引擎已撤但样式残留')
// 2026-10-06 撤销「浅色硬编码」定案：浮窗随夜晚模式令牌化（背景/文字用 --bg/--ink 主题变量）。
if (/\.quote-pop \{[\s\S]*?background: var\(--bg\);/.test(css)) ok('.quote-pop 随主题令牌化（--bg/--ink，兼容黑夜反转）')
else bad('.quote-pop 未跟随主题变量 —— 与令牌化定案不符')
if (css.includes('.qp-tab')) bad('styles.css 仍留 .qp-tab —— tab 条已被竖排菜单取代')
else ok('旧 tab 条样式已删（无遗留）')
// 聚焦指示载体 = 整行描边，不用浏览器默认 focus ring（全局 2px outline + 6px 圆角与输入行不齐）
if (/\.quote-pop \.qp-in:focus-visible \{ outline: none; \}/.test(css)) ok('输入行的默认 focus ring 已关（蓝色矩形错位根因）')
else bad('未关 .qp-in 的默认 focus ring —— 蓝色矩形仍会错位')
if (/\.qp-bar:focus-within \{ border-color: #4176e6; \}/.test(css)) ok('聚焦指示落在整行（.qp-bar:focus-within 描边变色）')
else bad('缺 .qp-bar:focus-within —— 关掉 ring 后焦点态就不可见了')

// ---- 7. cache-bust 三处同值 ----
const sw = read(resolve(WEB, 'sw.js'))
const html = read(resolve(WEB, 'index.html'))
// 只认被打包的三个静态入口（styles.css / app.js）——index.html 里另有素材版本号（如 state-newchat.webp?v=2），
// 与 SW 缓存版本无关，混进来会误报。
const swVer = sw.match(/const CACHE = 'floria-v(\d+)'/)
const htmlVers = [...html.matchAll(/\/(?:styles\.css|app\.js)\?v=(\d+)/g)].map((m) => m[1])
const uniq = [...new Set(htmlVers)]
if (swVer && uniq.length === 1 && uniq[0] === swVer[1]) ok(`cache-bust 同值：sw v${swVer[1]} = index.html ?v=${uniq[0]}（${htmlVers.length} 处）`)
else bad(`cache-bust 不一致：sw=${swVer && swVer[1]} / index.html=${uniq.join(',')}`)

// ---- 8. 产物侧复核 ----
const APP = resolve(WEB, 'app.js')
if (existsSync(APP)) {
  const app = read(APP)
  if (app.includes('---------- 选中引用（quote）----------')) ok('产物 app.js 已内嵌 quote 段')
  else bad('产物 app.js 未内嵌 quote 段（未重新构建？）')
  if (!app.includes('触屏程序化选中（quote-touch）')) ok('产物 app.js 已无 quote-touch 段（自绘引擎已撤）')
  else bad('产物 app.js 仍内嵌 quote-touch 段（未重新构建？）')
} else {
  bad('缺少产物 src/gateway/web/app.js')
}

// ---- 9. 行锚功能性验证：跑**真身** mdHtml（剥 import/export，注入 esc 与令牌桩）----
// 只验「锚 = 源行号」这一件事；mdInline 的令牌替换用桩（本探针已在别处验其真身）。
{
  const escStub = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const never = /(?!)/g
  // 真身 quoteReplyChipHtml（icon 用桩）+ 真身 QUOTE_REPLY_RE：回复引用令牌 → 胶囊走完整链
  const replyChipSrc = fnSlice(mention, 'quoteReplyChipHtml')
  const QREPLY = reOf('QUOTE_REPLY_RE')
  // eslint-disable-next-line no-new-func
  const replyChip = (replyChipSrc && QREPLY ? new Function('MENTION_SESSION_ICON', `${replyChipSrc}\nreturn quoteReplyChipHtml`)('<i></i>') : null) as ((i: string, t: string) => string) | null
  // 真身 quotePdfChipHtml（icon 用桩）+ 真身 QUOTE_PDF_RE：PDF 令牌 → 胶囊走完整链
  const pdfChipSrc = fnSlice(mention, 'quotePdfChipHtml')
  const QPDF = reOf('QUOTE_PDF_RE')
  // eslint-disable-next-line no-new-func
  const pdfChip = (pdfChipSrc && QPDF ? new Function('MENTION_FILE_ICON', `${pdfChipSrc}\nreturn quotePdfChipHtml`)('<i></i>') : null) as ((p: string, a?: string, b?: string) => string) | null
  if (!replyChip || !QREPLY) bad('未能剥出真身 quoteReplyChipHtml / QUOTE_REPLY_RE')
  if (!pdfChip || !QPDF) bad('未能剥出真身 quotePdfChipHtml / QUOTE_PDF_RE')
  let html = ''
  try {
    const body = md.replace(/^import .*$/gm, '').replace(/^export \{[\s\S]*?^\}$/m, '')
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      'esc', 'MENTION_PATH_RE', 'MENTION_PLUGIN_RE', 'MENTION_SESSION_RE', 'QUOTE_REF_RE', 'QUOTE_REPLY_RE', 'QUOTE_PDF_RE',
      'mentionChipHtml', 'quoteRefChipHtml', 'quoteReplyChipHtml', 'quotePdfChipHtml',
      'MATH_SRC_BLOCK_DOLLAR', 'MATH_SRC_BLOCK_BRACKET', 'MATH_SRC_INLINE_PAREN', 'MATH_SRC_INLINE_DOLLAR', 'mathInlineOk',
      `${body}\nreturn mdHtml`,
    )
    const render = fn(
      escStub, never, never, never, never, QREPLY || never, QPDF || never, (k: string, v: string) => v, (p: string) => p, replyChip || ((p: string) => p), pdfChip || ((p: string) => p),
      mathSpec.MATH_SRC_BLOCK_DOLLAR, mathSpec.MATH_SRC_BLOCK_BRACKET, mathSpec.MATH_SRC_INLINE_PAREN, mathSpec.MATH_SRC_INLINE_DOLLAR, mathSpec.mathInlineOk,
    ) as (s: string, a?: string) => string
    const src = '# 标题\n\n**加粗**：正文\n第二行\n\n- 项一\n- 项二\n\n```\ncode1\ncode2\n```\n'
    html = render(src)
    if (!/data-l/.test(html)) ok('mdHtml 输出零行锚（行锚子系统已随 CodeMirror 改造移除）')
    else bad('mdHtml 仍落 data-l —— 旧行锚子系统未清')
    // data-md（2026-10-09 复制链）在块级元素上挂原文，故片段断言只看可见 HTML（剔除 data-md 属性）
    const vis = html.replace(/ data-md="[^"]*"/g, '')
    const frags = ['<h1>标题</h1>', '<strong>加粗</strong>', '<li>项一</li>', '<div class="code-block', '<pre><code>code1']
    let okAll = true
    for (const f of frags) if (!vis.includes(f)) { okAll = false; bad(`mdHtml 未渲染 ${f}`) }
    if (okAll) ok('mdHtml 结构渲染完好（标题/加粗/列表/代码块）')
    // 回复引用全链：真身 refToken 出「锚点 + 原文块」→ stripQuoteReplyBody 剥块 → 渲染成胶囊。
    // 气泡里既不得有原文，也不得裸露令牌（用户实报「为什么文本信息也在气泡里」）。
    const wrapped = '[@引用回复:12|引用文本功能]\n原文一句\n原文二句\n[/引用回复]'
    const stripped = stripBody ? stripBody(wrapped + '\n补充一句') : wrapped
    const h2 = render(stripped)
    if (!h2.includes('原文一句') && !h2.includes('原文二句')) ok('原文块不出现在气泡里（模型侧 payload 已剥）')
    else bad(`原文仍出现在气泡里：${JSON.stringify(h2)}`)
    if (h2.includes('补充一句')) ok('引用块之后的正文照常渲染')
    else bad(`块外正文被吞：${JSON.stringify(h2)}`)
    if (h2.includes('mention-chip m-ref') && h2.includes('引用自「引用文本功能」· 第 12 条回复')) ok('回复引用锚点渲染成胶囊（与文件引用同族）')
    else bad(`回复引用未渲染成胶囊：${JSON.stringify(h2)}`)
    // 令牌裸露只看可见 HTML：data-md（复制用原文）合法保留了令牌源码，不算裸露
    const h2vis = h2.replace(/ data-md="[^"]*"/g, '')
    if (!h2vis.includes('[@引用回复:')) ok('令牌已被消费（可见文本不裸露，data-md 保留源码供复制）')
    else bad('令牌裸露在消息里（渲染入口漏接？）')
    // PDF 引用全链：真身 refToken 出「路径#页码 + 原文块」→ stripQuoteBodies 剥块 → 渲染成胶囊
    const pdfStripped = stripBody ? stripBody('[@引用PDF:Pj13/paper.pdf#p7]\n第七页原文\n[/引用PDF]') : ''
    const h3 = render(pdfStripped)
    if (!h3.includes('第七页原文')) ok('PDF 原文块不出现在气泡里（模型侧 payload 已剥）')
    else bad(`PDF 原文仍出现在气泡里：${JSON.stringify(h3)}`)
    if (h3.includes('mention-chip m-ref') && h3.includes('引用自 paper.pdf · 第 7 页')) ok('PDF 引用令牌渲染成胶囊（与文件/回复引用同族）')
    else bad(`PDF 引用未渲染成胶囊：${JSON.stringify(h3)}`)
    const h3vis = h3.replace(/ data-md="[^"]*"/g, '')
    if (!h3vis.includes('[@引用PDF:')) ok('PDF 令牌已被消费（可见文本不裸露，data-md 保留源码供复制）')
    else bad('PDF 令牌裸露在消息里（渲染入口漏接？）')
  } catch (e) {
    bad(`mdHtml 真身调用失败：${(e as Error).message}`)
  }
}

console.log(`\n${pass}/${fail}`)
process.exit(fail === 0 ? 0 : 1)
