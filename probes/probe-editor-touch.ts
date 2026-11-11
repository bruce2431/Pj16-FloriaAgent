#!/usr/bin/env bun
/**
 * probe-editor-touch —— 触屏（iPad/iOS）编辑区手势修复结构不变量（2026-10-13，WS2 待办 6）
 *
 * 现象：iPad 上 work 编辑区文字不可见 / 无法上划。根因链：iOS Safari 把 contenteditable
 * （CM6 .cm-content 自带 -webkit-user-modify）落在 flex 滚动容器（.cm-scroller 默认 display:flex
 * !important）里的触摸滑动当作文本选择手势而非滚动，手势冒泡到 body（overflow:hidden）⇒ 滚动失灵。
 * 结构锁点（styles.css 现状断言）：
 *   1) .wk-ed-cm .cm-scroller / .cm-content 显式 touch-action: pan-x pan-y（把 pan 手势还给滚动容器，
 *      ViperIDE/Obsidian 移动端通行修法）+ overscroll-behavior: contain（防穿透 body 橡皮筋）。
 *   2) 滚动唯一化：.wk-ed-body:has(> .wk-ed-cm) overflow hidden（编辑器恒 height:100% 填满外层，
 *      消灭「外层 .wk-ed-body + 内层 .cm-scroller」双滚动歧义；图片分支不受影响）。
 *   3) vendored CM6 基线未动：.cm-scroller 默认仍只有 overflowX:auto（垂直滚动语义来自本表显式声明）。
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')

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

const css = read('src/gateway/web/styles.css')
// CM6 基线现在来自兄弟包 SubPj4-CodeMirror6开发（@floria/cm6 内联 @codemirror/view），不再有 vendored live-markdown.js
const vendor = read('../SubPj4-CodeMirror6开发/node_modules/@codemirror/view/dist/index.js')

// ---- 1. 手势显式声明 ----
const block = css.match(/\.wk-ed-cm \.cm-scroller,\s*\.wk-ed-cm \.cm-content \{[^}]*\}/)
if (block && /touch-action:\s*pan-x pan-y/.test(block[0])) ok('编辑器滚动容器/内容显式 touch-action: pan-x pan-y')
else bad('缺 touch-action: pan-x pan-y —— iOS 触摸滚动语义未归还')
if (block && /overscroll-behavior:\s*contain/.test(block[0])) ok('overscroll-behavior: contain（防穿透 body 橡皮筋）')
else bad('缺 overscroll-behavior: contain')
if (block && /-webkit-overflow-scrolling:\s*touch/.test(block[0])) ok('-webkit-overflow-scrolling: touch（旧 WebView 惯性滚动）')
else bad('缺 -webkit-overflow-scrolling: touch')

// ---- 2. 滚动唯一化 ----
if (/\.wk-ed-body:has\(> \.wk-ed-cm\) \{ overflow: hidden; \}/.test(css)) ok('编辑器在场时外层 .wk-ed-body 滚动关死（滚动唯一化到 .cm-scroller）')
else bad('外层双滚动歧义未消除（.wk-ed-body 仍可滚）')
if (/\.wk-ed-body \{ flex: 1; min-height: 0; overflow: auto; position: relative; \}/.test(css)) ok('图片分支基线未被改动（.wk-ed-body 仍 overflow:auto）')
else bad('.wk-ed-body 基线规则被改 —— 图片滚动分支受影响')

// ---- 3. vendored 库基线（对照：不靠改库，全部在项目 CSS 层修） ----
if (/"\.cm-scroller":\s*\{[^}]*overflowX:\s*"auto"/.test(vendor) && !/"\.cm-scroller":\s*\{[^}]*overflowY/.test(vendor)) ok('CM6 基线未动（.cm-scroller 默认仅 overflowX:auto）')
else bad('CM6 库 .cm-scroller 基线漂移 —— 需重新核对本修复的前提')

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
