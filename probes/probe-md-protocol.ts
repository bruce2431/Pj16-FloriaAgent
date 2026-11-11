// probe-md-protocol.ts —— 源码-渲染-复制协议结构不变量（2026-10-15 组2：待办 10/11/13/15/16）
//
// 锁的是「同一份能力只落一处」的协议，而非某个函数的具体写法：
//   #10 任务列表 → core/markdown.js 产**真** <input type=checkbox>（非 CSS 伪元素），data-md 仍挂整行原文；
//   #11 数学文法唯一真源 = core/math-spec.js，消息流 + 两条 CM6 链共用（禁第二套正则）；
//   #13/#6 附件 = 原文 md 引用（内容唯一真相）；底栏 #img-pills 胶囊行 2026-10-16 还原为 pending* 回显 + @ 上传组；
//   #2 任务行 TaskMarker → editor/task-list.js 真 <input>；#4 选中敲 * ` _ ~ → surroundExt 包裹；
//   #5 contentEdges 用 TreeWalker 取内容文本节点（禁 firstChild 盲降）；
//   #15 包裹 = editor/editor-transactions 的 CM6 事务（禁直接改 DOM），两宿主共用一张 keymap；
//   #16 复制 = editor/editor-clipboard 门面收敛到 core/markdown.js 的 data-md 链。
// 运行：BUN="F:/@WrokSpace/.tools/bun/bun.exe"; "$BUN" probes/probe-md-protocol.ts

import { readFileSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')
// CM6 内核在独立包（SubPj4-CodeMirror6开发），结构断言读包源码
const PKG = resolve(ROOT, '../SubPj4-CodeMirror6开发/src')
const readPkg = (p: string) => readFileSync(resolve(PKG, p), 'utf8')

let pass = 0
let fail = 0
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  PASS  ${m}`) } else { fail++; console.log(`  FAIL  ${m}`) } }

// ---------- 功能面：core/markdown.js 任务列表（#10） ----------
const mkSrc = read('src/gateway/web-src/core/markdown.js')
const specSrc = read('src/gateway/web-src/core/math-spec.js')
const strip = (src: string) => {
  const raw = src.replace(/\r\n/g, '\n')
  const at = raw.search(/^export \{/m)
  const noExport = at >= 0 ? raw.slice(0, at) : raw
  return noExport.split('\n').filter((l) => !/^\s*import\s/.test(l)).join('\n')
}
const spec = new Function(`${strip(specSrc)}\nreturn { MATH_SRC_BLOCK_DOLLAR, MATH_SRC_BLOCK_BRACKET, MATH_SRC_INLINE_PAREN, MATH_SRC_INLINE_DOLLAR, mathInlineOk }`)() as Record<string, unknown>
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as Record<string, string>)[c])
const never = /$^/g
const factory = new Function(
  'esc', 'MENTION_PATH_RE', 'MENTION_PLUGIN_RE', 'MENTION_SESSION_RE', 'QUOTE_PDF_RE', 'QUOTE_REF_RE', 'QUOTE_REPLY_RE',
  'mentionChipHtml', 'quotePdfChipHtml', 'quoteRefChipHtml', 'quoteReplyChipHtml',
  'MATH_SRC_BLOCK_DOLLAR', 'MATH_SRC_BLOCK_BRACKET', 'MATH_SRC_INLINE_PAREN', 'MATH_SRC_INLINE_DOLLAR', 'mathInlineOk', 'window',
  `${strip(mkSrc)}\nreturn { mdHtml, mdInline }`,
)
const chip = () => ''
const { mdHtml } = factory(
  esc, never, never, never, never, never, never, chip, chip, chip, chip,
  spec.MATH_SRC_BLOCK_DOLLAR, spec.MATH_SRC_BLOCK_BRACKET, spec.MATH_SRC_INLINE_PAREN, spec.MATH_SRC_INLINE_DOLLAR, spec.mathInlineOk,
  {},
) as { mdHtml: (s: string) => string; mdInline: (s: string) => string }

const u = mdHtml('- [ ] 待办甲\n- [x] 待办乙\n- [X] 待办丙\n- 普通项')
ok(/<input type="checkbox" class="md-task-checkbox"[^>]*>/.test(u), '#10 任务项产真 <input type=checkbox>（非伪元素）')
ok(/data-task-line="1"[^>]* disabled>/.test(u) && !/data-task-line="1"[^>]*checked/.test(u), '#10 `[ ]` 未勾选态 + disabled 只读')
ok((u.match(/checked/g) || []).length === 2, '#10 `[x]` 与 `[X]` count=2 均 checked')
ok(/<li data-md="- \[ \] 待办甲">/.test(u), '#10 data-md 仍挂整行原文（复制口径不变）')
ok(/<li data-md="- \[x\] 待办乙">/.test(u), '#10 checked 行 data-md 亦为原文 `[x]`')
ok(/<li data-md="- 普通项">普通项<\/li>/.test(u), '#10 非任务列表项不产 checkbox')
const o = mdHtml('1. [ ] 有序任务\n2. [x] 收尾')
ok((o.match(/class="md-task-checkbox"/g) || []).length === 2, '#10 有序列表同支持（ol 内 checkbox）')

// ---------- 结构面 ----------
const md = mkSrc
ok(/import \{[^}]*MATH_SRC_BLOCK_DOLLAR[^}]*\} from '\.\/math-spec\.js'/.test(md) && /import \{[^}]*mathInlineOk[^}]*\} from '\.\/math-spec\.js'/.test(md), '#11 markdown.js 从 core/math-spec.js 取文法（非自带正则）')
ok(/new RegExp\(MATH_SRC_BLOCK_DOLLAR, 'g'\)/.test(md) && /new RegExp\(MATH_SRC_INLINE_PAREN, 'g'\)/.test(md), '#11 extractMath 逐条消费 MATH_SRC_*（块级先于行内）')
ok(!/\\\$\\\$\(\[\\s\\S\]\+\?\)/.test(md), '#11 markdown.js 无第二套公式正则（文法只在 math-spec）')

const cmspec = read('src/gateway/web-src/core/math-spec.js')
for (const k of ['MATH_SRC_BLOCK_DOLLAR', 'MATH_SRC_BLOCK_BRACKET', 'MATH_SRC_INLINE_PAREN', 'MATH_SRC_INLINE_DOLLAR', 'mathInlineOk', 'MATH_EXTRACT_ORDER']) {
  ok(new RegExp(`export \\{[^}]*${k}`).test(cmspec) || cmspec.includes(k), `#11 math-spec.js 涵盖 ${k}`)
}
const cmMath = readPkg('kernel/cm-math.js')
ok(/from '\.\/math-spec\.js'/.test(cmMath), '#11 包内 cm-math 从包内 math-spec 取文法')
ok(/cmMathScan/.test(cmMath) && /InlineCode/.test(cmMath) && /FencedCode/.test(cmMath), '#11 cm-math.js 扫公式跳过代码区间')
ok(/cmMathExt/.test(cmMath) && /export \{ cmMathExt \}/.test(cmMath), '#11 cm-math.js 导出 cmMathExt（两宿主共用一份）')
// 文法单真源跨仓校验：包内 copy 必须与 Floria core/math-spec.js 逐字同源（分隔符正则源串）
const pkgSpec = readPkg('kernel/math-spec.js')
for (const k of ['MATH_SRC_BLOCK_DOLLAR', 'MATH_SRC_INLINE_PAREN', 'MATH_SRC_INLINE_DOLLAR', 'mathInlineOk']) {
  const line = (src: string) => (src.match(new RegExp(`^.*${k} = .*$`, 'm')) || [''])[0]
  ok(!!line(pkgSpec) && line(pkgSpec) === line(cmspec), `#11 包内 math-spec 与 core/math-spec 同源（${k}）`)
}
// 光标邻近退化判据须与 vendor live-markdown `cn` 同款=**闭区间**（`a.from<=to && a.to>=from`）——
// 开区间会漏掉光标落在公式边界（紧邻 `$` 前/后）的退化（2026-10-15 实报：「$…$ 临近不退化为源码」）。
ok(/r\.from <= to && r\.to >= from/.test(cmMath), '#11 cm-math 选区命中=闭区间（与 vendor cn 同款，边界光标即退化）')
ok(!/r\.from < to && r\.to > from/.test(cmMath), '#11 cm-math 无开区间残留（开区间漏边界态=根因）')

const composer = readPkg('hosts/composer.js')
const workcm = readPkg('hosts/work-cm.js')
const mention = read('src/gateway/web-src/inputbar/mention.js')
ok(/cmMathExt\(CM\)/.test(composer), '#11 底栏挂 cmMathExt')
ok(/cmMathExt\(CM\)/.test(workcm), '#11 work 编辑区挂 cmMathExt')

// #15 包裹 / #16 复制：命令层唯一
const tr = readPkg('kernel/editor-transactions.js')
const api = readPkg('kernel/editor-api.js')
const clip = readPkg('kernel/editor-clipboard.js')
ok(/function wrapSelectionCM\(/.test(tr) && /changeByRange/.test(tr), '#15 包裹 = CM6 changeByRange 事务（不改 DOM）')
ok(/Mod-b/.test(tr) && /Mod-i/.test(tr) && /Mod-e/.test(tr), '#15 wrapKeymap 含 Mod-b/i/e')
ok(/const ED_EDITORS = new Map\(\)/.test(api) && /function editorCommand\(/.test(api), '#15/#16 editor-api 注册表 + editorCommand 调度')
ok(/makeEditorFacade/.test(api) && /toggleTask\(line, checked\)/.test(api), '#15/#10 facade 暴露 wrapSelection/toggleTask')
ok(/selectionMd\(selection\)/.test(clip) && /edEnv\(\)/.test(clip), '#16 复制门面经 env 注入消费 markdown.js data-md 链')
ok(/wrapKeymap\(\)/.test(composer) && /wrapKeymap\(\)/.test(workcm), '#15 两宿主共用 wrapKeymap')
ok(/makeEditorFacade\(\{ id: 'composer'/.test(composer) && /makeEditorFacade\(\{ id: 'work'/.test(workcm), '#15/#16 两宿主注册 facade')
ok(!/contenteditable|execCommand/.test(tr + api), '#15 命令层无 execCommand/contenteditable 直改')

// #13 附件 = 原文引用，无底栏胶囊
const imgs = read('src/gateway/web-src/inputbar/images.js')
const ctxm = read('src/gateway/web-src/inputbar/ctx-meter.js')
const idx = read('src/gateway/web/index.html')
ok(/insertAttachmentMarkdown\(/.test(imgs), '#13 images.js 上传后插原文 md 引用')
ok(/function renderImgPills\(/.test(imgs) && /uploadedMentionItems/.test(imgs), '#6 images.js 胶囊行还原 + @ 上传组数据源')
ok(/<div id="img-pills"/.test(idx) && /\$\('img-pills'\)/.test(imgs), '#6 #img-pills 元素在 index.html、images.js 有活引用')
ok(/uploadedMentionItems/.test(mention) && /imgpick/.test(mention), '#6 mention.js 消费「上传」组（imgpick/filepick）')
const tasklist = readPkg('kernel/task-list.js')
ok(/edTaskPlugin/.test(tasklist) && /TaskMarker/.test(tasklist) && /toggleTaskLineCM/.test(tasklist), '#2 task-list.js TaskMarker → 真 input 写回源码')
ok(/function contentEdges\(/.test(mkSrc) && /createTreeWalker/.test(mkSrc), '#5 contentEdges 改 TreeWalker（不做 firstChild 盲降）')
ok(/copyRenderedSelection/.test(ctxm) && !/selectionMd\b/.test(ctxm.match(/import[^\n]*/g)?.join('\n') || ''), '#16 ctx-meter 复制走 editor-clipboard 门面')
const attach = readPkg('kernel/editor-attachments.js')
ok(/!\[[^\]]*\]\(/.test(attach) && /\[[^\]]*\]\(/.test(attach), '#13 图片 `![]()` / 文件 `[]()` 两种引用形态')
ok(/edAttImgPlugin/.test(attach), '#13 图片引用行内直渲（edAttImgPlugin）')

// 拼接注册 + 样式
const bundle = read('scripts/bundle-web-modules.ts')
for (const f of ['core/math-spec.js', 'editor/cm-bridge.js']) {
  ok(bundle.includes(`file: '${f}'`), `bundle 注册 ${f}`)
}
const css = read('src/gateway/web/styles.css')
ok(/\.md-task-checkbox \{/.test(css), '#10 styles.css 有 .md-task-checkbox')
ok(/\.cm-task-checkbox \{/.test(css) && /#img-pills \{/.test(css), '#2/#6 styles.css 有 .cm-task-checkbox 与 #img-pills 胶囊样式')
ok(/\.cm-att-img/.test(css), '#13 styles.css 有 .cm-att-img（行内图片）')

console.log(`\n[probe-md-protocol] PASS=${pass} FAIL=${fail}`)
process.exit(fail ? 1 : 0)
