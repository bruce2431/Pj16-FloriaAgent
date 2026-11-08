// web 前端模块拼接器：src/gateway/web-src/（ESM 模块源码，唯一手改处）→ src/gateway/web/app.js（单 IIFE 产物）。
// 不用 Bun.build：打包器按依赖图重排模块执行序，而本代码顶层执行代码（事件绑定/DOM 初始化）依赖原 IIFE
// 物理行序（重排 → TDZ 崩溃，2026-09-10 首跑实证）；且原 IIFE 顶部的 `const $`（区间外声明）会被切割丢失。
// 本拼接器按 PIECES 表的执行序把各切片段拼回单 IIFE——顺序 = 产物物理序，语义保真；
// 产物与切割前原版的 diff 应仅含：setter 函数行 + MANUAL 改写行（等价性可 diff 验证）。
// web/app.js 是生成物勿手改；产物文件名/引用不变（?v= cache-bust、sw CORE、gen-web-assets 全链零改动）。

const WEB_SRC = './src/gateway/web-src'
const OUT = './src/gateway/web/app.js'

// 拼接执行序：自顶向下 = 产物中自上而下的物理顺序。每项 = 一个切片段：
//   file = 模块路径（'__app__' = 入口 web-src/app.js）；part = 段序号（1 起）。
// 同一文件可出现多次（多段）——本表先后即该文件内各段的先后（切片按 part 升序检索 marker）。
// 每段首行恒为该文件内的唯一 marker 注释：`/* @module <file> */`（part 1）/ `/* @module <file> #<n> */`
// （part n>1）；marker 在切片时剥离，不进产物。段边界 = 下一段 marker 行前一行的分隔空行。
// 改顺序 = 挪本表行；改分段 = 动源文件里的 marker（增删普通行不破坏定位）。
const PIECES: { file: string; part: number }[] = [
  { file: 'core/icons.js', part: 1 },
  // 管理页通用 UI 接缝（@floria/web 的 mgr 组件族）：与 icons 同属包接缝，须先于全部消费方
  // （views/cards/plugins/plugins-card.js 等）；缺包抛错，不在 Floria 内复刻结构。
  { file: 'core/mgr-ui.js', part: 1 },
  { file: 'sidebar/mgr-data.js', part: 1 },
  // 界面状态纯数据（core/ui-state.js，2026-10-10 自 engine/state.js 下移）须先于 engine/state.js 与
  // core/{util,storage}.js（三件均 import 它）。
  { file: 'core/ui-state.js', part: 1 },
  // 元素/状态（engine/state.js）与持久化（core/storage.js）、工具（core/util.js）在产物中交错：
  // 三件自原 IIFE 的不同区段切出（util 的 `function toast` 在原版位于 markdown 之后），须保原物理序。
  { file: 'engine/state.js', part: 1 },
  { file: 'core/storage.js', part: 1 },
  { file: 'engine/state.js', part: 2 },
  { file: 'core/util.js', part: 1 },
  { file: 'core/char.js', part: 1 },
  // @ 提及/引用令牌纯符号层（2026-10-10 自 inputbar/mention.js 下移）：core/markdown.js 渲染内联 chip 只依赖
  // 此层（断开 core→feature 成环）；只依赖 core/icons.js，须排在其后、core/markdown.js 之前。
  { file: 'core/mention-syntax.js', part: 1 },
  // 数学公式文法唯一真源（core/math-spec.js，2026-10-15 待办 11）：消息流 extractMath 与 CM6 插件
  // （editor/cm-math.js）共用同一套分隔符正则与行内判据，禁任一条链自带第二套。须先于两者。
  { file: 'core/math-spec.js', part: 1 },
  { file: 'core/markdown.js', part: 1 },
  { file: 'core/util.js', part: 2 },
  // 卡片公开 API 总线（engine/card-bus.js，唯一顶层名 cardBus）：只依赖 engine/state.js + core/util.js，
  // 自身无 import 上层；各挂点（ext-card / preview-frame / gateway / work-mount）在本行之后 ⇒ 排此即足。
  { file: 'engine/card-bus.js', part: 1 },
  { file: 'engine/sessions.js', part: 1 },
  { file: 'engine/live.js', part: 1 },
  { file: 'chat/route.js', part: 1 },
  // 消息渲染拆分（2026-10-08 纯搬迁，保原物理序）：原 chat/messages.js 段1 切为 6 件；
  // 原节 2 切为 chat/messages/transient.js（见下方 stage.js 之后）。各件先后 = 原段内物理序。
  { file: 'chat/messages.js', part: 1 },
  { file: 'chat/messages/change-card.js', part: 1 },
  { file: 'chat/messages/msg-actions.js', part: 1 },
  { file: 'chat/messages/icons.js', part: 1 },
  { file: 'chat/messages/usage.js', part: 1 },
  { file: 'chat/messages/renderer.js', part: 1 },
  { file: 'sidebar/recent.js', part: 1 },
  { file: 'sidebar/rail-ext.js', part: 1 },
  { file: 'sidebar/mgr.js', part: 1 },
  { file: 'sidebar/bubble-search.js', part: 1 },
  // 侧栏开合核（2026-10-05 自 recent.js 抽出）：模块内全为函数声明，顶层无执行码。
  { file: 'engine/panel.js', part: 1 },
  // 分层治理（2026-10-10）：外部申报纯校验（engine/ext-decl.js）与卡契约注册表（engine/registry.js）
  // 下沉到 engine 层——engine 永不 import views，渲染实现留在 views/feature。registry 顶层 `let CARDS=[]`
  // + 契约 registerCard；各卡模块顶层自注册（registerCard(def)）⇒ registry 须物理排在各卡之前（TDZ），
  // 故此处不再「卡在 registry 之前」（旧 views/registry.js 已删）。
  { file: 'engine/ext-decl.js', part: 1 },
  // Phase 5（2026-10-10）：外部卡运行时（EXT/APP_TABS/QACTIONS + 申报缓存）自 registry.js 拆出——
  // registry 顶层 `setTabRefresh(renderMgrTabs)` 注入本件的重渲回调 ⇒ 本件须排在 registry 之前（TDZ）。
  { file: 'engine/ext-runtime.js', part: 1 },
  { file: 'engine/registry.js', part: 1 },
  // 卡片上游仓库与版本（feature/card-repo.js）：插件卡「应用」详情与 work 插件页共用；只依赖
  // core/util（esc/toast）与 engine/gateway（apiUrl，调用期取用），须排在两处消费方之前。
  { file: 'feature/card-repo.js', part: 1 },
  // 视图卡组件（2026-10-01 卡片化二期）：一模块一卡，各卡顶层 registerCard 自注册入 engine/registry。
  { file: 'views/cards/ext/ext-card.js', part: 1 },
  { file: 'views/cards/preview/preview-card.js', part: 1 },
  { file: 'views/cards/plugins/plugins-card.js', part: 1 },
  { file: 'views/cards/session/session-card.js', part: 1 },
  // 项目预览帧 + 外部卡申报同步 + 侧栏快捷按钮状态（feature/preview-frame.js，2026-10-10 自
  // views/cards/{preview,ext} 与 sidebar/rail-ext 迁入）：三级链渲染实现 + 「当前预览文档」域状态归
  // feature 层（engine 契约只做表编排）。须在 work.js 之前（work 预览态复用 mountPreview）。
  { file: 'feature/preview-frame.js', part: 1 },
  // work 工具页注册表（右栏工具态的水平标签栏）：纯函数声明 + 顶层 const WK_TOOL_DEFS，须在 work.js
  // 之前（其 mountWork 调 registerWkTool，applyPvTab 调 wkToolDefs/wkToolDef/wkToolNormId）。
  { file: 'sidebar/work-tools.js', part: 1 },
  // 评论卡（2026-10-24 卡片化）：卡目录自包含 = 描述符/注册面 + 卡私有面板组件（views/cards/comment/）；
  // 跨卡/宿主共享的实现归 feature/comment/（数据层、选区浮层——work.js 原文标记与 inputbar/quote.js 也要用）。
  // 依赖链 = work-tools.js（registerWkTool）与 card-bus.js（registerInlineCard）⇒ 须排在其后；
  // 执行序 = 数据 → 浮层 → 面板 → 卡，只有 comment-card 在顶层注册（其余只有声明）。
  { file: 'feature/comment/comment-data.js', part: 1 },
  { file: 'feature/comment/comment-composer.js', part: 1 },
  { file: 'views/cards/comment/comment-panel.js', part: 1 },
  { file: 'views/cards/comment/comment-card.js', part: 1 },
  // 项目选择器（2026-11-06）：work 侧栏 #wk-proj-pop 与底栏 #proj-pop 共用的唯一实现；
  // 数据源 = state.projects（后端 findProjects），消费方 commands.js / work-files.js 均在其后。
  { file: 'feature/project-picker/project-picker.js', part: 1 },
  // work 视图项目槽缺省（WORK_SLOT_DEF，2026-10-10 自 engine/state.js 下移为 work 领域值）：须在 work 侧栏
  // 各件之前（work-mount.js 的 initWork 调 loadWork(WORK_SLOT_DEF)、work-context.js 的 loadWorkSlot 同用）。
  { file: 'sidebar/work-state.js', part: 1 },
  // work 语境唯一源 + 项目槽切换（2026-10-15 待办 #5/#8/#9 根治）：getWorkContext()/switchWorkProject()/
  // reconcileWorkSurface()。顶层仅函数声明（共享 IIFE 内提升），须排在 work-state.js 之后（其 import 面用到
  // WORK_SLOT_DEF）。调用方 = work-files.js 的 selectProject、work-mount.js 的 initWork。
  { file: 'sidebar/work-context.js', part: 1 },
  // CM6 接缝（2026-10-24）：编辑器内核整体移入 @floria/cm6 包（/cm6/floria-cm6.iife.js 先于 app.js
  // 载入，挂 window.FloriaCM6）。本件注入宿主依赖并把内核符号摊进共享作用域（transactions/api/markdown/
  // attachments/clipboard/cm-math/task-list/block-mark 均来自包）；宿主（composer-cm / work-cm）在此后调用。
  { file: 'editor/cm-bridge.js', part: 1 },
  // work 模式侧栏（2026-10-08 纯搬迁拆分，保原物理序）：原 sidebar/work.js 单段切为门面 + 8 件 work/*；
  // 门面 sidebar/work.js 承原 import 面与 export 块（外部 import './sidebar/work.js' 路径不变），
  // 其余按职责切块——各件先后 = 原段内物理序。依赖 views/registry.js 的 showCard 与 engine/state.js 的 state/chatArea/#work-*。
  { file: 'sidebar/work.js', part: 1 },
  { file: 'sidebar/work/work-layout.js', part: 1 },
  { file: 'sidebar/work/work-preview.js', part: 1 },
  { file: 'sidebar/work/work-assist.js', part: 1 },
  { file: 'sidebar/work/work-files.js', part: 1 },
  // work 插件 tab（2026-11-07）：项目插件/技能/应用管理，数据走 mgr-data.loadProjectPlugins + 预览卡表；
  // 启停后要刷新工具栏 tab 条与页态（applyPvTab / renderWkToolTabs），故排在 work-preview 之后。
  { file: 'sidebar/work/work-plugins.js', part: 1 },
  { file: 'sidebar/work/work-cm.js', part: 1 },
  // 行级三方合并纯函数（2026-10-25 编辑卡实时同步）：被 work-live.js 调用，无宿主依赖。
  { file: 'sidebar/work/work-merge.js', part: 1 },
  // JSON Canvas 图形预览（2026-10-13）：wkCvExt 由 work-cm.js 的 wkEdLangExt 在扩展名为 .canvas 时调用，
  // 故须排在 work-cm.js 之后（函数声明提升，序位按依赖就近）。
  { file: 'sidebar/work/work-canvas.js', part: 1 },
  // Office 只读预览（2026-10-24 待办 4）：xlsx/docx 解包渲染，wkDocRender 由 work-editor.readFile 调用
  // （函数声明提升，序位按依赖就近；解压依赖页面先加载的 vendor/fflate.js）。
  { file: 'sidebar/work/work-doc.js', part: 1 },
  // PDF 预览（2026-10-24）：wkPdfRender/wkPdfClose 由 work-editor.readFile 调用；引擎 vendor
  // 经动态 import 懒加载（/vendor/pdfjs/），本件只承载工具条/页栈/懒渲染逻辑。
  { file: 'sidebar/work/work-pdf.js', part: 1 },
  { file: 'sidebar/work/work-editor.js', part: 1 },
  // 编辑卡外部改动实时同步（2026-10-25）：读 work-editor 的 wkEd* 状态 + work-merge 的 wkMerge3，
  // 启停由 work-layout.applySbMode 调用（函数声明提升，序位按依赖就近）。
  { file: 'sidebar/work/work-live.js', part: 1 },
  { file: 'sidebar/work/work-rows.js', part: 1 },
  // work「+」新建菜单接入（创建文件/文件夹 + 上传文件/文件夹）+ 行「下载」（2026-10-13）：
  // wkNewPick / downloadWorkEntry 被 work-rows.js 与 work-mount.js 调用，排两者之间
  // （拼接后单 IIFE 函数声明提升，序位按语义就近）。
  { file: 'sidebar/work/work-tabmenu.js', part: 1 },
  { file: 'sidebar/work/work-mount.js', part: 1 },
  // @ 提及 / 引用 chip 的点击派发器（2026-11-08）：唯一业务落点，经 cardBus 调各卡公开命令。
  // 顶层只有函数声明（消费方 msg-actions / composer-cm 早于本行也只按运行时调用），
  // 须排在 work 各件之后（其解析路径/切项目依赖 setSbMode / selectProject）。
  { file: 'feature/mention-nav.js', part: 1 },
  // 入口（web-src/app.js）：事件绑定段（同区段原含会话壳）与启动序列段。
  { file: '__app__', part: 1 },
  { file: 'inputbar/ctx-meter.js', part: 1 },
  // 网关客户端（engine/gateway.js）四段：定义段 / 在线态 setConn / connect / initGateway，原 IIFE 分处四地。
  { file: 'engine/gateway.js', part: 1 },
  // 工具栏三层（2026-11-07 模块化：项目隔离 / 文件层 / 条目层自 mention.js + commands.js 切出）：
  // scope 只有函数声明；pick 另有顶层 `const pick/pickAll` 两块状态，须先于 mention.js 与 commands.js 初始化；
  // entries 的 `const GROUP_OF/CMD_VIEWS` 供 commands.js#3 的渲染用，故排在 commands.js 中间段之后。
  { file: 'inputbar/toolbar/scope.js', part: 1 },
  { file: 'inputbar/toolbar/pick.js', part: 1 },
  { file: 'inputbar/mention.js', part: 1 },
  // CM6 接管底栏（2026-10-14 #17 B 口径）：须在 mention.js 后（挂载读 #cm-host / inputEl 已声明；
  // 运行期函数跨 IIFE 提升，序位按 eval 期依赖就近）。
  { file: 'inputbar/composer-cm.js', part: 1 },
  // 命令菜单与模型选择两件在产物中交错（原 IIFE 物理序）。
  { file: 'inputbar/commands.js', part: 1 },
  { file: 'inputbar/model-select.js', part: 1 },
  { file: 'inputbar/commands.js', part: 2 },
  { file: 'inputbar/toolbar/entries.js', part: 1 },
  { file: 'inputbar/model-select.js', part: 2 },
  { file: 'inputbar/commands.js', part: 3 },
  { file: 'engine/gateway.js', part: 2 },
  { file: 'chat/stage.js', part: 1 },
  // 原 chat/messages.js 段2（暂存补投/排队主张）纯搬迁为独立模块。
  { file: 'chat/messages/transient.js', part: 1 },
  { file: 'inputbar/approval.js', part: 1 },
  { file: 'engine/auth.js', part: 1 },
  { file: 'engine/gateway.js', part: 3 },
  { file: 'engine/auth.js', part: 2 },
  { file: 'engine/auth.js', part: 3 },
  { file: 'inputbar/images.js', part: 1 },
  { file: 'inputbar/send.js', part: 1 },
  // 键盘适配（engine/viewport.js）须在启动序列之前（initViewport 调用时模块顶层 let 已初始化）。
  { file: 'engine/viewport.js', part: 1 },
  { file: 'engine/gateway.js', part: 4 },
  // 选中文本引用浮窗（顶层立即注册 contextmenu/mousedown 委托）与轮次导航轨（顶层立即 railInit），
  // 均须排在启动序列之前。
  { file: 'inputbar/quote.js', part: 1 },
  { file: 'chat/turn-rail.js', part: 1 },
  // 启动序列（入口第二段）恒居末：异步引导链最后执行。
  { file: '__app__', part: 2 },
]

// ---------- 读取模块文件并剥离切割壳（头注释/import/setter 注释/export 块） ----------
async function loadModuleBodies(): Promise<Map<string, string[]>> {
  const bodies = new Map<string, string[]>()
  for (const file of [...new Set(PIECES.map((p) => p.file))]) {
    const path = file === '__app__' ? `${WEB_SRC}/app.js` : `${WEB_SRC}/${file}`
    // CRLF 归一（2026-09-16 实证：Windows 编辑链会把工作区源码写成 CRLF，\r 残留撞首行锚点防呆）
    const lines = (await Bun.file(path).text()).replace(/\r\n/g, '\n').split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()

    // 剥切割壳（emit 结构=cut-web-modules.ts 304-314 取证）：/*块*/（仅入口件）→ 0 缩进 // 标题 →
    // （有 import 才有的）1 空行 → import 行 →（仅入口件）import 后多 1 空行。body 首行 = 模块首段 marker。
    let i = 0
    if (lines[i]?.startsWith('/*')) { while (i < lines.length && !lines[i].includes('*/')) i++; i++ }
    while (i < lines.length && /^\/\//.test(lines[i])) i++
    if (lines[i]?.trim() === '' && /^import /.test(lines[i + 1] ?? '')) i++
    while (i < lines.length && /^import /.test(lines[i])) i++
    if (file === '__app__' && lines[i]?.trim() === '') i++
    if (i === lines.length) throw new Error(`${file}: 区间内容为空`)

    // 尾界=切割壳 marker（setterBlock 注释行 / export { 行）首现处，body=头尾之间全量（末段至 body 尾）。
    let end = lines.length
    for (let j = i; j < lines.length; j++) {
      if (/^\/\/ —— 跨模块写入口/.test(lines[j]) || /^export \{/.test(lines[j])) { end = j; break }
    }
    bodies.set(file, lines.slice(i, end))
    const setters: string[] = []
    const tail = lines.slice(end)
    for (let j = 0; j < tail.length; j++) {
      if (!/^export function \w+\(/.test(tail[j])) continue
      // 多行函数按花括号配平整段收（尾段 `// —— 跨模块写入口` 之后不再有 body 责任，2026-10-14
      // forceWsReconnect 漏拼事故：旧口径只收 `set\w+` 单行，非 set 前缀的多行 export function 被截体）
      let depth = 0
      let k = j
      for (; k < tail.length; k++) {
        for (const ch of tail[k]) {
          if (ch === '{') depth++
          else if (ch === '}') depth--
        }
        if (depth <= 0 && k >= j) break
      }
      setters.push(...tail.slice(j, k + 1).map((ln) => ln.replace(/^export /, '')))
      j = k
    }
    bodies.set(file + '::setters', setters)
  }
  return bodies
}

// marker 文本（唯一、稳定：不依赖模块内的业务注释；增删普通行不破坏）
const markerOf = (file: string, part: number) => (part === 1 ? `/* @module ${file} */` : `/* @module ${file} #${part} */`)

// ---------- 按 marker 切片 ----------
// 每段 = marker 行之后到「下一段 marker 前一行的分隔空行」（回吐该空行）；末段至 body 尾。
function slicePieces(file: string, body: string[]): string[][] {
  const parts = PIECES.filter((p) => p.file === file).map((p) => p.part)
  const idx: number[] = []
  for (const part of parts) {
    const marker = markerOf(file, part)
    const hits: number[] = []
    for (let j = 0; j < body.length; j++) if (body[j] === marker) hits.push(j)
    if (hits.length !== 1) throw new Error(`${file} marker「${marker}」在文件内命中 ${hits.length} 次（应恰为 1）`)
    idx.push(hits[0])
  }
  for (let n = 1; n < idx.length; n++) {
    if (idx[n] <= idx[n - 1]) throw new Error(`${file} marker 顺序颠倒（part ${parts[n]} 未在 part ${parts[n - 1]} 之后）`)
    if (body[idx[n] - 1]?.trim() !== '') throw new Error(`${file} marker「${markerOf(file, parts[n])}」前缺分隔空行`)
  }
  const out: string[][] = []
  for (let n = 0; n < parts.length; n++) {
    const from = idx[n] + 1
    const to = n < parts.length - 1 ? idx[n + 1] - 1 : body.length
    out.push(body.slice(from, to))
  }
  return out
}

// ---------- 主流程 ----------
const bodies = await loadModuleBodies()
const segs = new Map<string, string[]>()
const lastOfFile = new Map<string, number>()
for (const p of PIECES) lastOfFile.set(p.file, p.part)
for (const file of [...new Set(PIECES.map((p) => p.file))]) {
  const sliced = slicePieces(file, bodies.get(file)!)
  PIECES.filter((p) => p.file === file).forEach((p, i) => segs.set(`${file}#${p.part}`, sliced[i]))
}
const pieces: string[][] = []
for (const p of PIECES) {
  const lines = [...segs.get(`${p.file}#${p.part}`)!]
  // setter 跟随定义模块的最后一段之后（切割时 setterBlock 位置=模块尾）
  if (p.part === lastOfFile.get(p.file)) lines.push(...(bodies.get(p.file + '::setters') ?? []))
  pieces.push(lines)
}

// 骨架：原版头注释（1-7 行）+ IIFE 开 + use strict + 顶部 `const $`（原 11 行，切割区间外，必须注回）
const appLines = (await Bun.file(`${WEB_SRC}/app.js`).text()).replace(/\r\n/g, '\n').split('\n')
const head = appLines.slice(0, 7)
if (!head[0].startsWith('/* floria')) throw new Error('web-src/app.js 头注释被改动？前 7 行应为原版权头')

const out: string[] = [...head, '(() => {', "  'use strict'", '', '  const $ = (id) => document.getElementById(id)', '']
for (const p of pieces) out.push(...p)
out.push('})()')

// 产物自检（2026-10-15 事故：work-context.js 把 `/* @module */` marker 写在 import 之前，剥壳阶段
// `while (/^import /)` 没吃到那三行 ⇒ app.js 带裸 `import {...}` ⇒ 浏览器整包解析失败、界面卡死）。
// 两道门：①输出不得含顶层 import/export（切割壳不变量：import/export 必须写在 marker 之前 / 尾段）；
// ②整包必须能被 JS 解析器吃下（不靠人眼）。构建即部署，产物坏 = 界面直接白。
for (let n = 0; n < out.length; n++) {
  if (/^\s*(import|export)\s/.test(out[n]))
    throw new Error(`产物第 ${n + 1} 行残留顶层 import/export「${out[n].trim().slice(0, 48)}」——模块切割壳未剥离（import 必须写在 /* @module */ marker 之前，export 块在尾段）`)
}
const bundled = out.join('\n') + '\n'
try {
  new Bun.Transpiler({ loader: 'js' }).transformSync(bundled)
} catch (e) {
  throw new Error(`产物 JS 解析失败（app.js 会整包不执行）：${(e as Error).message}`)
}
await Bun.write(OUT, bundled)
console.log(`[bundle-web] ${pieces.length} 个区间拼回 → ${OUT}（${out.length + 1} 行）`)
