#!/usr/bin/env bun
/**
 * probe-comment-marks —— 评论「原文标记」结构不变量（2026-10-06，2026-10-07 改编辑器装饰器）
 *
 * 目标：评论不只列在右栏，还要**落回原文**——被批注的行在编辑区有可见标记。
 * 结构锁点（只读源码，不启 DOM）：
 *   1) feature/comment/comment-data.js 是标记的唯一数据源：导出 cmtRangesFor（按 path + l0/l1），
 *      评论增删改后经 cmtAfterChange 回调 refreshMarks 让 work.js 重绘标记。
 *   2) 编辑区（所有可编辑文本文件）恒为 CodeMirror 6：work.js 渲染末尾调 cmtApplyMarks，
 *      经 wkEdCmtEffect → StateField → Decoration.line 把命中行加 .cmt-mark / .cmt-mark-res。
 *   3) 定位回跳：面板点定位 → openFile(path, id) → work.js 记 wkCmtScrollId →
 *      渲染完经 wkEdScrollToLine → EditorView.scrollIntoView 滚到该行 + 闪标。
 *   4) styles.css 有对应样式；cache-bust 两处同值。
 */
import { readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')
// work 家族（2026-10-13）：`sidebar/work.js` 的 God Module 纯搬迁拆分后，CM6 编辑器 / 渲染 / 挂载分居
// `sidebar/work/*.js`——断言锁的是「整族源码」的结构不变量，搬迁只是函数换文件、语义不变，故按族拼接读取。
const WORK_DIR = 'src/gateway/web-src/sidebar/work'
const work = [
  'src/gateway/web-src/sidebar/work.js',
  ...readdirSync(resolve(ROOT, WORK_DIR))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `${WORK_DIR}/${f}`),
].map(read).join('\n')
// CM6 编辑器引擎已收口到兄弟包 @floria/cm6（#71）：宿主内部（装饰器/语言 compartment/高亮/HR/表格渲染）
// 在包内 `hosts/work-cm.js`，断言锁包源码；Floria 侧只剩适配转调。
const workPkg = read('../SubPj4-CodeMirror6开发/src/hosts/work-cm.js')

let pass = 0
let fail = 0
const ok = (m: string) => {
  pass++
  console.log(`PASS  ${m}`)
}
const bad = (m: string) => {
  fail++
  console.log(`FAIL  ${m}`)
}

const cmt = read('src/gateway/web-src/feature/comment/comment-data.js')
const cmtPanel = read('src/gateway/web-src/views/cards/comment/comment-panel.js')
const md = read('src/gateway/web-src/core/markdown.js')
const css = read('src/gateway/web/styles.css')
const bundle = read('scripts/bundle-web-modules.ts')
const idx = read('src/gateway/web/index.html')
const sw = read('src/gateway/web/sw.js')

// ---- 1. feature/comment/comment-data.js：标记数据源 + 变更回调 ----
if (/function cmtRangesFor\(/.test(cmt)) ok('comment-data.js 导出 cmtRangesFor（按文件路径给评论行范围）')
else bad('comment-data.js 缺 cmtRangesFor —— 原文标记无数据源')
if (/cmtRangesFor,/.test(cmt)) ok('comment-data.js 的 cmtRangesFor 已 export（work.js 可 import）')
else bad('comment-data.js 未导出 cmtRangesFor')
if (/function cmtAfterChange\(/.test(cmt) && /cmtRefreshMarks\(\)/.test(cmt)) ok('cmtAfterChange 回调 refreshMarks（评论变更 → 原文标记重绘）')
else bad('comment-data.js 缺 cmtAfterChange/refreshMarks 回调 —— 增删评论后原文标记不更新')
if (/refreshMarks: /.test(cmt) || /h\.refreshMarks/.test(cmt)) ok('cmtSetHooks 接受 refreshMarks（与 work.js 解耦注册）')
else bad('cmtSetHooks 未接 refreshMarks')
if (/cmtHookOpenFile\(loc\.dataset\.cmtloc, item \? item\.dataset\.cid : ''\)/.test(cmtPanel)) ok('面板定位把评论 id 一并交给 openFile 钩子（回跳能滚到该行）')
else bad('面板定位未传评论 id')

// ---- 2. work.js：编辑器行装饰器打标 ----
if (/import \{[^}]*cmtRangesFor[^}]*\} from '\.\.\/feature\/comment\/comment-data\.js'/.test(work)) ok('work.js import cmtRangesFor（标记单一数据源）')
else bad('work.js 未 import cmtRangesFor')
if (/function cmtApplyMarks\(/.test(work)) ok('work.js 定义 cmtApplyMarks（把评论行范围送进编辑器装饰器）')
else bad('work.js 缺 cmtApplyMarks')
if (/function buildCmtDeco\(marks, st\)/.test(workPkg) && /Decoration\.line\(\{ class: 'cmt-mark ' \+ \(m\.resolved/.test(workPkg)) ok('评论标记 = Decoration.line（升序 + 未解决/已解决两态类）')
else bad('评论标记未接编辑器行装饰器')
if (/cmtEffect\.of\(/.test(workPkg) && /e\.is\(cmtEffect\)/.test(workPkg)) ok('标记经 StateEffect → StateField 落装饰（applyMarks → cmtEffect）')
else bad('评论标记未接 StateEffect/StateField')
if (/cmtEffect\.of\(cmtMarks\)/.test(workPkg) && /view\.dispatch/.test(workPkg)) ok('applyMarks 经 view.dispatch 送标记（无 DOM [data-l] 走法）')
else bad('applyMarks 未走编辑器 dispatch')
if (/function scrollToLine\(n\)/.test(workPkg) && /CM\.EditorView\.scrollIntoView/.test(workPkg)) ok('定位回跳：scrollToLine → scrollIntoView + 闪标')
else bad('缺定位回跳（scrollToLine）')
if (/cmtApplyMarks\(\) \/\/ 评论标记/.test(work)) ok('阅读态渲染末尾调用 cmtApplyMarks')
else bad('阅读态渲染未调 cmtApplyMarks')
if (/refreshMarks: cmtApplyMarks/.test(work)) ok('mountWork 注册 refreshMarks 钩子（评论变更 → 重绘标记）')
else bad('mountWork 未注册 refreshMarks')
if (/wkCmtScrollId/.test(work) && /view\.state\.doc\.lines/.test(work)) ok('定位回跳：wkCmtScrollId 消费时行号夹取 + scrollIntoView')
else bad('缺定位回跳滚动')
if (/cmtLoad\(state\.workProj\) \/\/ 评论恢复态补拉/.test(work) && /cmtLoad\(label\) \/\/ 原文标记也需要当前项目的评论/.test(work)) ok('ensureWork / selectProject 恒拉评论（原文标记不只评论 tab 才需要）')
else bad('原文标记场景未恒拉评论数据')

// ---- 3. 编辑区统一为 CodeMirror 6（所有可编辑文本文件；两态已撤） ----
if (/CM\.EditorView\.lineWrapping/.test(workPkg)) ok('编辑器启用 lineWrapping（长行按窗口软换行）')
else bad('编辑器缺 lineWrapping —— 长行不换行')
if (/langComp = new CM\.Compartment\(\)/.test(workPkg) && /function setLang\(path\)/.test(workPkg)) ok('语言 compartment（按扩展名热换语言扩展）')
else bad('缺语言 compartment / setLang')
// base=markdownLanguage 自身即 commonmark.configure([GFM,…])（GFM 已含 Table）⇒ 不另传 extensions，语法树照常有 Table 节点
if (/function langExt\(path\)/.test(workPkg) && /CM\.markdown\(\{ base: CM\.markdownLanguage \}\)/.test(workPkg)) ok('langExt：md 走 Live Preview 全套（base=markdownLanguage 自带 GFM 表格），其余按扩展名取语言包')
else bad('langExt 未接 markdown / 语言包')
if (/function hrPlugin\(\)/.test(workPkg) && /Decoration\.line\(\{ class: 'wk-ed-hr' \}\)/.test(workPkg) && /hrPlugin\(\)/.test(workPkg)) ok('hrPlugin：HorizontalRule 行走行装饰（库 styleMap 无此项）')
else bad('缺 HorizontalRule（---）渲染插件')
if (/\.wk-ed-hr-hide \{/.test(css) && /\.cm-line\.wk-ed-hr::after/.test(css)) ok('styles.css 有 .wk-ed-hr / .wk-ed-hr-hide 样式')
else bad('styles.css 缺水平线样式')
// 代码块 widget 换行口径：库 <pre> 是 UA white-space:pre + overflow:auto（不换行），与光标入块后的源码态
// （.cm-line，break-spaces）不一致 ⇒ 宿主覆盖为 pre-wrap，统一到 EditorView.lineWrapping 口径
if (/#work-editor \.cm-codeblock-widget pre \{[^}]*white-space: pre-wrap/.test(css) && /#work-editor \.cm-codeblock-widget \{[^}]*var\(--field-2\)/.test(css)) ok('styles.css 代码块 widget 按窗口软换行（pre-wrap）+ 项目令牌底/边（库 hsl(--muted) 假设失效）')
else bad('代码块 widget 仍不换行（库 pre 的 white-space:pre 未覆盖）或未用项目令牌')
// cm6 库补丁（兄弟包 SubPj4-CodeMirror6开发/patches/）：行内标记（**加粗** 等）显隐按**父节点范围**判定
const libPatch = read('../SubPj4-CodeMirror6开发/patches/codemirror-live-markdown@0.5.1-alpha.1.patch')
if (/INLINE_REVEAL_PARENTS/.test(libPatch) && /revealNode\.from/.test(libPatch)) ok('vendored 库补丁：行内标记显隐按父节点范围（光标落在内容中间即整块显码）')
else bad('vendored 库缺行内显隐补丁（**加粗** 仍需光标贴 * 才显码）')
// 表格单元格 md 渲染：库 TableWidget.toDOM 原为 th/td `textContent=`（纯文本，格内 md 原样吐出）；
// 补丁加可注钩子 setTableCellRenderer → work.js 注入 core/markdown.js 的 mdInlineText
if (/function mdInlineText\(s\)/.test(md) && /CM\.setTableCellRenderer\(H\.mdInlineText\)/.test(workPkg) && /setTableCellRenderer/.test(libPatch) && /renderTableCell/.test(libPatch)) ok('表格单元格 md 渲染：库补 setTableCellRenderer 钩子 + 宿主注入 mdInlineText（格内 **粗体**/`代码`/链接正常渲染）')
else bad('表格单元格内 md 未渲染（库仍 textContent 直出）')
if (/buildHlStyle/.test(workPkg) && /HighlightStyle\.define/.test(workPkg)) ok('代码高亮 = HighlightStyle（tag → --hl-* CSS 变量，日夜随动）')
else bad('代码高亮未接 HighlightStyle')
if (!/wkCodeHtml|wk-ed-ta|wk-ed-hl|state\.wkEdit|applyEdMode/.test(work)) ok('work.js 无两态残留（textarea 编辑 / 阅读态 / 模式按钮全清）')
else bad('work.js 仍有两态残留（wkCodeHtml / wk-ed-ta / wk-ed-hl / state.wkEdit / applyEdMode）')
if (/bodyEl\.replaceChildren\(hostEl\)/.test(workPkg) && /wkEditor\.attach\(body\)/.test(work)) ok('renderEdBody：可编辑文本一律挂 CodeMirror 宿主')
else bad('renderEdBody 未统一挂 CodeMirror 宿主')

// ---- 4. 样式 + 拼接注册 + cache-bust ----
if (/\.cmt-mark \{/.test(css) && /\.cmt-mark-res \{/.test(css) && /\.cmt-flash \{/.test(css)) ok('styles.css 有 .cmt-mark / .cmt-mark-res / .cmt-flash')
else bad('styles.css 缺评论标记样式')
// 主题令牌已迁 UI 基础包 @floria/web（2026-10-24）：--hl-* 在包 theme.css，宿主样式留在 styles.css
const webTheme = read('src/gateway/web/webui/floria-web.css')
if (/--hl-kw:/.test(webTheme) && /\.wk-ed-cm \{/.test(css)) ok('基础包 floria-web.css 有 --hl-* 高亮令牌 + styles.css 有 .wk-ed-cm 宿主样式')
else bad('缺 --hl-* 令牌（应在 webui/floria-web.css）/ .wk-ed-cm 样式')
if (/feature\/comment\/comment-data\.js/.test(bundle) && /views\/cards\/comment\/comment-panel\.js/.test(bundle) && /feature\/comment\/comment-composer\.js/.test(bundle) && /views\/cards\/comment\/comment-card\.js/.test(bundle)) ok('bundle-web-modules 已注册评论四件（data/composer/panel/card）')
else bad('bundle-web-modules 未注册完整评论四件')
const vCss = /styles\.css\?v=(\d+)/.exec(idx)?.[1]
const vApp = /app\.js\?v=(\d+)/.exec(idx)?.[1]
const vSw = /floria-v(\d+)/.exec(sw)?.[1]
if (vCss && vCss === vApp && vCss === vSw) ok(`cache-bust 三处同值（styles/app/sw = v${vSw}）`)
else bad(`cache-bust 不一致：styles=v${vCss} app=v${vApp} sw=v${vSw}`)

console.log(`\n${pass}/${fail}`)
process.exit(fail === 0 ? 0 : 1)
