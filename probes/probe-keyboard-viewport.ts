// probe-keyboard-viewport.ts —— 「壳体原地不动，只抬输入栏」不变量探针（只读）
// 定案（2026-11-01 用户拍板）：键盘弹出时应用**不被顶起也不变矮**，只有输入栏随键盘上移；
// 侧栏/顶栏/消息流位置与高度都不变，被键盘盖住的是它们自己的底部。
// 实现 = 三个由 visualViewport 派生的纯量：
//   lift = max(0, 输入栏自然底边 − vv.height)     纯**屏坐标**；只有输入栏消费（--kb-lift）
//   --bar-room = popRoom(底栏上沿在 app 内的 y)    底栏子件弹层高度上界
//   可信判据 kbModelVerified(scale)：scale≈1，否则 lift=0；不假设 iPad reveal 使用哪条滚动通道
// **壳体零写入**：html/body 是普通文档流，键盘 reveal 的滚动由 #app 的 position:sticky 消化；
// 主线程不写 body/#app 的位置，也没有键盘高预测（记忆 / 冷启动猜高 / 保持窗全部退役）。
// 历史三条失败路线（body fixed / 变矮补偿 / focusin 预抬）均不得复活：都已证明追不上 WebKit 的 pan。
// **布局视口量（clientHeight/100dvh/innerHeight）不进算式**：rect 与 vv.height 同属可视坐标。
// **add-back 必须**：rect 已含上一帧施加的 lift，比较前加回去，否则「写→测→写」自激振荡。
// 断言分两类：① 源码/产物结构（唯一真源接线、CSS 消费点、版本同步）；
// ② 行为真值表——几何函数 kbLift / kbModelVerified / popRoom 从 web-src 源码**提取**（非手抄）。
// 用法：bun run ./probe-keyboard-viewport.ts   （输出 pass/fail，末行 N/M）

const SRC = `${import.meta.dir}/../src/gateway/web-src`
const WEB = `${import.meta.dir}/../src/gateway/web`

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = '') {
  if (cond) pass++
  else fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : '  ← ' + detail}`)
}

const viewportJs = await Bun.file(`${SRC}/engine/viewport.js`).text()
const appSrc = await Bun.file(`${SRC}/app.js`).text()
const css = await Bun.file(`${WEB}/styles.css`).text()
const appJs = await Bun.file(`${WEB}/app.js`).text()
const swJs = await Bun.file(`${WEB}/sw.js`).text()
const indexHtml = await Bun.file(`${WEB}/index.html`).text()
const bundler = await Bun.file(`${import.meta.dir}/../scripts/bundle-web-modules.ts`).text()

// ---------- 函数体按大括号配对提取 ----------
function body(file: string, header: string): string {
  const i = file.indexOf(header)
  if (i < 0) return ''
  let d = 0
  let started = false
  for (let j = i; j < file.length; j++) {
    const c = file[j]
    if (c === '{') { d++; started = true }
    else if (c === '}') { d--; if (started && d === 0) return file.slice(i, j + 1) }
  }
  return ''
}

// ---------- ① 拼接表接线（新模块必须进表，否则不被拼进产物） ----------
ok('A1 bundle-web-modules 表含 engine/viewport.js', /file:\s*'engine\/viewport\.js'/.test(bundler))
ok('A1 viewport 段排在启动序列之前（顶层 let 先于 initViewport 调用）',
  (() => {
    const at = (f: string, p: number) =>
      bundler.search(new RegExp(`file:\\s*'${f.replace(/\./g, '\\.')}',\\s*part:\\s*${p}\\b`))
    const vp = at('engine/viewport.js', 1)
    const boot = at('__app__', 2)
    return vp >= 0 && boot >= 0 && vp < boot
  })())

// ---------- ② 唯一真源与消费点 ----------
ok('A2 启动序列调 initViewport（紧随 initLive，中间是依赖接线）', (() => {
  const i = appSrc.indexOf('initLive()')
  const j = appSrc.indexOf('initViewport()')
  return i >= 0 && j > i && /setViewportAdapter\(\{ syncStage: stageSync \}\)/.test(appSrc.slice(i, j))
})())
ok('A3 applyGeometry 消费 visualViewport（同步段与延迟段的唯一出口）', /window\.visualViewport/.test(body(viewportJs, 'function applyGeometry()')))
ok('A3 抬升量只用屏坐标：kbLift(vv.height, 输入栏自然底边)（布局视口量一律不进算式）', (() => {
  const b = body(viewportJs, 'function applyGeometry()')
  return /kbLift\(vv\.height, wrap\.getBoundingClientRect\(\)\.bottom \+ appliedLift\)/.test(b) &&
    !/kbLift\([^)]*innerHeight/.test(b) && !/clientHeight|100dvh/.test(b)
})(), '混入布局视口量 = 历次回弹的来源')
// 壳体零位移：iOS 的 reveal 不做补偿（vg 量滞后必回弹），交给 sticky 在滚动机制内部消化。
ok('A3 壳体零位移：全库无 --app-pan（不做可视视口 pan 的反向补偿）',
  !/--app-pan/.test(viewportJs) && !/--app-pan/.test(css))
ok('A3 键盘高度预测全部退役（记忆 / 冷启动猜高 / 保持窗 / focusin 预写位移）',
  !/kbMemKey|readKbHeight|writeKbHeight|guessKbHeight|LIFT_FLOOR_MS|liftFloorUntil/.test(viewportJs) &&
    !/floria\.kb:/.test(viewportJs))
ok('A3 focusin 只布防（不预测、不预写 --kb-lift；抬升只由实测 vv 驱动）', (() => {
  const b = body(viewportJs, "document.addEventListener('focusin'")
  return /armed = true/.test(b) && /syncKeyboard\(\)/.test(b) &&
    !/setProperty\(/.test(b) && !/readKbHeight|guessKbHeight/.test(b)
})(), 'focusin 里又出现键盘高预测？')
ok('A3 抬升走布局：消费点是 top/calc，不是 transform（避免额外合成层与 fixed 后代基准漂移）',
  /#input-wrap\.docked \{[^}]*top:\s*calc\(100% - 22px - var\(--kb-lift, 0px\)\);/.test(css) &&
    /#empty-hint #input-wrap \{[^}]*top:\s*calc\(76\.75% - var\(--kb-lift, 0px\)\);/.test(css) &&
    !/translate\([^)]*var\(--kb-lift/.test(css))
ok('A3 布防判据 = 焦点在 #input-wrap 内（不再靠 activeElement 猜编辑态，预览 iframe 不触发）',
  /function composerHasFocus\(el\)/.test(viewportJs) && /wrap\.contains\(el\)/.test(viewportJs) &&
    !/function isEditing\(/.test(viewportJs))
// add-back：rect 反映的是已施加的 lift，不加回去就等于拿「自己制造的上移」当自然位置 ⇒ 自激振荡。
ok('A3 add-back：自然底边 = 输入栏 rect.bottom + 已施加的 lift',
  /kbLift\(vv\.height, wrap\.getBoundingClientRect\(\)\.bottom \+ appliedLift\)/.test(viewportJs) &&
    /let appliedLift = 0/.test(viewportJs) && /appliedLift = lift/.test(viewportJs))
ok('A3 未布防（焦点不在输入栏）时抬升恒为 0（fail-open：不动输入栏）', (() => {
  const b = body(viewportJs, 'function applyGeometry()')
  return /let lift = 0/.test(b) && /if \(armed && wrap && verified\)/.test(b)
})(), 'applyGeometry 的 lift 分支被改写？')
// 坐标模型不可信（捏合缩放）时归零；iPad 两种 reveal 通道都允许。
ok('A3b 模型不可信时 fail-open：仅 scale≠1 → lift 0（兼容 iPad 两种 reveal 通道）',
  /function kbModelVerified\(scale\)/.test(viewportJs) &&
    /Math\.abs\(scale - 1\) > 0\.01/.test(viewportJs) &&
    /kbModelVerified\(vv\.scale\)/.test(viewportJs) &&
    !/CHANNEL_TOLERANCE/.test(viewportJs))
ok('A3b 布防/撤防走 focusin/focusout 捕获段；relatedTarget 仍在栏内不算撤离',
  /document\.addEventListener\('focusin', \(e\) => \{[\s\S]{0,200}?armed = true/.test(viewportJs) &&
    /document\.addEventListener\('focusout', \(e\) => \{[\s\S]{0,200}?composerHasFocus\(e\.relatedTarget\)[\s\S]{0,120}?armed = false/.test(viewportJs))
ok('A3 壳体不再收高：appH / --app-h 全套退役（键盘不缩壳）',
  !/appH/.test(viewportJs) && !/--app-h/.test(viewportJs) && !/--app-h/.test(css))
ok('A3 旧整页平移变量全部退役（--kb / --kb-total / lastTotal 均已删除）',
  !/--kb-total|setProperty\('--kb'|lastTotal/.test(viewportJs))
ok('A3 不再有「浏览器位移归零」迎战代码（scrollTo 已删）', !/scrollTo\(/.test(viewportJs))
ok('A3 键盘在场重算消息流占位几何（注入的 syncStage；engine 不 import feature）',
  /stageSyncFn\(\)/.test(viewportJs) && /export function setViewportAdapter/.test(viewportJs) &&
    !/^import .*from '\.\.\/(chat|inputbar|sidebar|feature)\//m.test(viewportJs))

// ---------- ②b 相位与收敛 ----------
ok('A4 监听器直挂同步段（resize/scroll 同帧写几何）',
  /vv\.addEventListener\('resize', syncKeyboard\)/.test(viewportJs) && /vv\.addEventListener\('scroll', syncKeyboard\)/.test(viewportJs))
ok('A4 window scroll 是几何输入（iOS 键盘 reveal 走文档滚动，改变可视底 ⇒ 必须重算）',
  /window\.addEventListener\('scroll', syncKeyboard\)/.test(viewportJs))
// 同步段唯一允许的布局读取 = 输入栏 rect（add-back 必需，读在写之前）；不得再有其他布局读。
ok('A4 同步段只有一次 rect 读取（add-back 用），无 offset* 一类额外布局读', (() => {
  const syncBody = body(viewportJs, 'function applyGeometry()')
  const rects = (syncBody.match(/getBoundingClientRect/g) || []).length
  return syncBody.length > 0 && rects === 1 && !/offsetHeight|offsetWidth/.test(syncBody)
})(), 'applyGeometry 布局读取点被改写？')
// Safari 键盘动画期间可能漏发 vv 事件：只靠事件会让输入栏停在中间帧。收敛环逐帧复算，静止 1s 后
// 降为 250ms 巡检（openchamber pinTracker 同法）。
ok('A4 抖动收敛环在场（rAF 逐帧复算 + 静止后低频巡检）',
  /requestAnimationFrame\(pinTick\)/.test(viewportJs) && /setTimeout\(wakePin, 250\)/.test(viewportJs) &&
    /pinUntil = performance\.now\(\) \+ 1000/.test(viewportJs))
ok('A4 仅「量算 + 占位重算」走 rAF 合帧',
  /requestAnimationFrame\(settle\)/.test(viewportJs) && /stageSyncFn\(\)/.test(body(viewportJs, 'function settle()')))
ok('A4 弹层余量输入位移无关（rect 相减得 app 内布局 y）',
  /wrap\.getBoundingClientRect\(\)\.top - app\.getBoundingClientRect\(\)\.top/.test(body(viewportJs, 'function settle()')))

// ---------- ③ CSS 消费点 ----------
ok('B1 壳体 = 普通文档流里的 sticky 卡（body 不再 fixed，避免被可视视口平移整块带走）', (() => {
  const bodyBlock = /^body \{[^}]*\}/m.exec(css)?.[0] ?? ''
  const appBlock = /^#app \{[^}]*\}/m.exec(css)?.[0] ?? ''
  return !/position: fixed;/.test(bodyBlock) && !/inset: 0;/.test(bodyBlock) &&
    /position: sticky;/.test(appBlock) && /top: 1px;/.test(appBlock) &&
    /height: calc\(100dvh - 2px\);/.test(appBlock) &&
    !/var\(--kb-lift/.test(appBlock)
})(), '壳体规则被改写？（fixed 根壳 = iOS 平移可视视口时整页顶起的来源）')
ok('B1 文档可滚 + 关橡皮筋（html overflow-y:auto + overscroll-behavior:none）',
  /^html \{[^}]*overflow-y: auto;[^}]*overscroll-behavior: none;/m.test(css))
ok('B1 触屏设备才有滚动余量（body::after 一屏高，桌面不出现可滚空白页）',
  /@media \(hover: none\) and \(pointer: coarse\) \{\s*body::after \{[^}]*height: 100dvh;/m.test(css))
ok('B1 整页平移本体已删除（#app 无 translateY 键盘规则）', !/body\.kb-open #app \{[^}]*transform/.test(css))
ok('B1 #app 恒无 transform（fixed 后代基准稳定；壳体不做任何键盘期位移）', (() => {
  const block = /^#app \{[^}]*\}/m.exec(css)?.[0] ?? ''
  return !/transform:/.test(block)
})(), '#app 一旦带 transform，内部 fixed 后代就改基准')
ok('B1 消息流不再收 --kb-total', !/#chat-scroll \{[^}]*margin-top:\s*var\(--kb-total/.test(css) && !/--kb-total/.test(css))
ok('B1 docked 底栏 = 钉 app 底边 22px + 随键盘抬 var(--kb-lift)（走布局 top）',
  /#input-wrap\.docked \{[^}]*top:\s*calc\(100% - 22px - var\(--kb-lift, 0px\)\);[^}]*transform: translate\(-50%, -100%\)/.test(css))
ok('B1 空态底栏 = 台面中心锚 + 随键盘抬 var(--kb-lift)（走布局 top，落点相对立绘不变）',
  /#empty-hint #input-wrap \{[^}]*top:\s*calc\(76\.75% - var\(--kb-lift, 0px\)\);[^}]*transform: translate\(-50%, -50%\)/.test(css))
ok('B1 键盘在场底栏不做缓动（否则整程拖尾在键盘后）', /body\.kb-open #input-wrap \{\s*transition: none; \}/.test(css))
ok('B1 #empty-hint 自身不含任何位移/收缩（背景层不参与）',
  !/#empty-hint \{[^}]*var\(--kb/.test(css))
ok('B1 work 顶栏不再为键盘让位', !/body\.kb-open #chat-area\.work/.test(css))
ok('B1 消息流占位随抬升补齐（底栏被抬多少，padding-bottom 补多少）',
  (css.match(/padding-bottom: calc\((?:142|140)px \+ var\(--kb-lift, 0px\)\)/g) || []).length === 2)
ok('B1 composer 渐隐带跟随抬升（bottom = --kb-lift）',
  /#composer-mask \{[^}]*bottom: var\(--kb-lift, 0px\)/.test(css))

// ---------- ③b 覆盖层（搜索层/风险门/重命名弹窗）：遮罩 ≡ 壳体，底部让出抬升量 ----------
// 选择器形态两种都认：独占规则（#id {）或与共用壳合写（:is(#rename-modal, #dl-modal) {）。
const selOf = (id: string) => `(?:#${id}|:is\\(#${id}, #dl-modal\\))`
for (const [name, id] of [['搜索层', 'search-overlay'], ['风险门', 'risk-modal'], ['重命名弹窗', 'rename-modal']] as const) {
  const re = new RegExp(`${selOf(id)} \\{[^}]*position: absolute;[^}]*top: 0; right: 0; bottom: 0; left: 0;`)
  ok(`B2 ${name} #${id} 在 app 壳体内 absolute inset（遮罩 = 壳体）`, re.test(css))
  ok(`B2 ${name} 不再 position:fixed 挂视口（会随键盘漂走）`, !new RegExp(`${selOf(id)} \\{[^}]*position: fixed`).test(css))
  ok(`B2 ${name} 底部让出键盘高度（对话框居中在键盘上方的可视区）`,
    new RegExp(`${selOf(id)} \\{[^}]*--kb-lift`).test(css), '未消费 --kb-lift')
}
ok('B2 全屏浮层（图片灯箱/拖放层/toast）改 absolute 随壳体',
  /#img-lightbox \{ position: absolute;/.test(css) && /#drop-overlay \{\s*position: absolute;/.test(css) &&
    /\.toast \{\s*position: absolute;/.test(css))
const appOpen = indexHtml.indexOf('<div id="app">')
const appShellEnd = indexHtml.indexOf('<!-- 聊天气泡弹层')
ok('B2 三件覆盖层的 DOM 真在 #app 内（不靠 CSS 假装）',
  appOpen >= 0 && appShellEnd > appOpen &&
    ['search-overlay', 'risk-modal', 'rename-modal'].every((id) => {
      const k = indexHtml.indexOf(`id="${id}"`)
      return k > appOpen && k < appShellEnd
    }))
ok('B2 对话框高度上限用容器百分比（vh=布局视口，键盘在场会溢出可视区）',
  !/max-height: calc\(100vh - 48px\)/.test(css) && !/max-height: 74vh/.test(css))
for (const id of ['rename-modal', 'risk-modal'] as const) {
  const block = new RegExp(`${selOf(id)} \\.dialog \\{[^}]*\\}`).exec(css)?.[0] ?? ''
  ok(`B2 对话框 #${id} 上限 = 容器内容盒（不得再 calc(100% - 48px) 双扣 padding）`,
    /max-height: 100%/.test(block) && !/max-height: calc\(100% - 48px\)/.test(block))
}

// ---------- ③c 底栏子件（向上弹出的弹层）：上限一律收 --bar-room ----------
ok('B3 余量 = 底栏上沿(rect 相减得 app 内布局 y) − 呼吸常量',
  /popRoom\(barTop, BAR_ROOM_MARGIN\)/.test(viewportJs) &&
    /barTop = wrap\.getBoundingClientRect\(\)\.top - app\.getBoundingClientRect\(\)\.top/.test(viewportJs) &&
    /setProperty\('--bar-room', barRoom \+ 'px'\)/.test(viewportJs))
ok('B3 底栏自身几何变化（多行长高/接管卡换高/空态↔会话态迁移）也触发重量',
  /new ResizeObserver\(scheduleSettle\)\.observe\(wrap\)/.test(viewportJs))
ok('B3 底栏位移类变化（过渡驱动）在过渡结束时重量 —— 否则 --bar-room 量到动画中间值被永久卡小',
  /wrap\.addEventListener\('transitionend', \(e\) => \{ if \(e\.target === wrap\) scheduleSettle\(\) \}\)/.test(viewportJs))
const BAR_POPS: [string, RegExp][] = [
  // #mention-pop 已并入 #cmd-pop（同一浮窗承载 @ 提及与命令菜单），只测合流后那一条。
  ['命令菜单 #cmd-pop', /#cmd-pop \{[^}]*max-height: min\(380px, var\(--bar-room, 380px\)\)/],
  ['命令菜单/模型弹层（手机档）', /#cmd-pop, #model-pop \{ max-height: min\(300px, var\(--bar-room, 300px\)\); \}/],
  ['任务浮窗 #task-dock .td-panel', /#task-dock \.td-panel \{[^}]*max-height: min\(40vh, 460px, var\(--bar-room, 460px\)\)/],
  ['项目选择弹层 #proj-pop', /#proj-pop \{[^}]*max-height: min\(320px, var\(--bar-room, 320px\)\)/],
  ['模型·推理弹层 #model-pop', /#model-pop \{[^}]*max-height: min\(360px, var\(--bar-room, 360px\)\)/],
  ['上下文面板 #ctx-panel', /#ctx-panel \{[^}]*max-height: min\(240px, var\(--bar-room, 240px\)\)/],
]
for (const [name, re] of BAR_POPS) ok(`B3 ${name} 上限收 --bar-room`, re.test(css), '回归裸定值/vh 上限即越出可视区')
ok('B3 唯一真源导出 kbLift / kbModelVerified / popRoom（探针直测，消费者不各自复刻公式）',
  /export \{ initViewport, kbLift, kbModelVerified, popRoom \}/.test(viewportJs))
ok('B3 底栏弹层不再有布局视口口径的 vh 上限残留（键盘在场不缩）',
  !/min\(360px, calc\(100vh - 96px\)\)/.test(css))

// ---------- ③d 其余视口口径消费点：一律取 visualViewport，不取布局视口 ----------
const noInnerHeight: [string, string][] = [
  ['sidebar/work/work-assist.js', await Bun.file(`${SRC}/sidebar/work/work-assist.js`).text()],
  ['sidebar/recent.js', await Bun.file(`${SRC}/sidebar/recent.js`).text()],
  ['inputbar/quote.js', await Bun.file(`${SRC}/inputbar/quote.js`).text()],
  ['feature/comment/comment-composer.js', await Bun.file(`${SRC}/feature/comment/comment-composer.js`).text()],
]
for (const [name, src] of noInnerHeight) {
  ok(`B4 ${name} 不以 window.innerHeight 作可视边界（键盘在场不缩）`,
    /window\.visualViewport/.test(src) && !/(?<!fallback:\s)window\.innerHeight\s*[-*+]/.test(src))
}

// ---------- ④ 产物与版本同步 ----------
ok('C1 产物 app.js 含定义与调用点', ['function kbLift(', 'function kbModelVerified(', 'function composerHasFocus(', 'function syncKeyboard(', 'function settle(', 'function initViewport(', 'initViewport()'].every((s) => appJs.includes(s)))
ok('C1 产物 app.js 未引用模块 import 语法（拼接已剥壳）', !/^\s*import .*viewport\.js/m.test(appJs))
ok('C1 产物 app.js 不含已退役的壳体补偿（kbVisibleBottom / --app-l / --app-pan 零残留）',
  !/kbVisibleBottom|--app-l|--app-pan/.test(appJs))
ok('C1 产物 app.js 不含键盘高预测（kbMemKey / readKbHeight / guessKbHeight / LIFT_FLOOR_MS）',
  !/kbMemKey|readKbHeight|guessKbHeight|LIFT_FLOOR_MS/.test(appJs))
const swV = /const CACHE = 'floria-v(\d+)'/.exec(swJs)?.[1]
const appV = /\/app\.js\?v=(\d+)/.exec(indexHtml)?.[1]
ok('C2 sw CACHE 与 index.html app.js ?v= 同步', !!swV && swV === appV, `sw=v${swV} app=v${appV}`)
ok('C2 index.html 引用 styles.css 且带 cache-bust', /\/styles\.css\?v=\d+/.test(indexHtml))

// ---------- ⑤ 行为真值表：几何函数从 web-src 源码提取 ----------
const klBody = body(viewportJs, 'function kbLift(')
ok('D3 kbLift 可从源码提取', klBody.length > 0, 'viewport.js 函数签名被改写？')
const lift = klBody ? (new Function(`return ${klBody}`)() as (vb: number, nb: number) => number) : null
if (lift) {
  // [名称, 键盘上沿, 输入栏自然底边, 期望抬升]
  const T2: [string, number, number, number][] = [
    ['输入栏底边恰在键盘上沿：不抬', 634, 634, 0],
    ['底边在键盘上沿之下 66px：抬 66', 634, 700, 66],
    ['底边本就在上沿之上：不抬（负重叠钳 0）', 634, 600, 0],
    ['无键盘（上沿=布局底，底栏 22px 内缩）：不抬', 834, 812, 0],
    ['子像素取整', 634.4, 700.6, 66],
    ['极小负重叠：钳到 0 不产生负位移', 634, 633.4, 0],
  ]
  let wrong2 = 0
  for (const [name, vb, nb, want] of T2) {
    const got = lift(vb, nb)
    if (got !== want) wrong2++
    ok(`D3 ${name}`, got === want, `期望 ${want} 实得 ${got}`)
  }
  ok('D3 抬升量真值行全部一致', wrong2 === 0, `${wrong2} 行不符`)
  // add-back 收敛：把抬升施加后再测（rect 含 lift），加回去应回到同一个自然底边 ⇒ 一步收敛不漂移。
  // 屏坐标模型：键盘上沿 = vv.height，直接取常量，不经任何布局视口量。
  {
    const vb = 534                              // 键盘上沿在屏上的 y
    const natural = 812                         // 无键盘时的输入栏自然底边
    let applied = 0
    const seq: number[] = []
    for (let i = 0; i < 3; i++) {
      const rectBottom = natural - applied      // DOM 里 rect 已含已施加的 lift
      applied = lift(vb, rectBottom + applied)  // 加回去 = 自然底边
      seq.push(applied)
    }
    ok('D4 add-back 一步收敛：连续三帧抬升量恒定（不自激振荡）',
      seq[0] === 278 && seq[1] === 278 && seq[2] === 278, `实得 ${seq.join(',')}`)
  }
}

// ---------- ⑤b 行为真值表：弹层余量函数（同样从源码提取） ----------
const prBody = body(viewportJs, 'function popRoom(')
ok('D5 popRoom 可从源码提取', prBody.length > 0, 'viewport.js 函数签名被改写？')
if (prBody) {
  const popRoom = new Function(`return ${prBody}`)() as (barTop: number, margin: number) => number
  // [名称, 底栏上沿在 app 内的布局 y, 呼吸常量, 期望余量]
  const T3: [string, number, number, number][] = [
    ['无键盘：底栏上沿 700、呼吸 20 → 680', 700, 20, 680],
    ['键盘在场（底栏被抬到 480）、呼吸 20 → 460', 480, 20, 460],
    ['余量被吃光：钳到 0（不产生负 max-height）', 10, 20, 0],
    ['底栏落在屏顶之上：钳到 0', 8, 20, 0],
    ['子像素取整', 480.6, 20, 461],
  ]
  let wrong3 = 0
  for (const [name, barTop, margin, want] of T3) {
    const got = popRoom(barTop, margin)
    if (got !== want) wrong3++
    ok(`D5 ${name}`, got === want, `期望 ${want} 实得 ${got}`)
  }
  ok('D5 弹层余量真值行全部一致', wrong3 === 0, `${wrong3} 行不符`)
}

// ---------- ⑤c 行为真值表：坐标模型可信判据（模型不可信时 fail-open 抬升归 0） ----------
const mvBody = body(viewportJs, 'function kbModelVerified(')
ok('D6 kbModelVerified 可从源码提取', mvBody.length > 0, 'viewport.js 函数签名被改写？')
if (mvBody) {
  const verify = new Function(`return (${mvBody})`)() as (scale: number, scrollY: number, offsetTop: number) => boolean
  // [名称, scale, scrollY, offsetTop, 期望]
  const T4: [string, number, number, number, boolean][] = [
    ['scale=1、两通道一致（iOS 键盘期 scrollY=offsetTop=417）→ 可信', 1, 417, 417, true],
    ['无滚动无偏移（未弹键盘）→ 可信', 1, 0, 0, true],
    ['scale=1、两通道分离（iPad 另一种 reveal 路径）→ 仍可信', 1, 417, 0, true],
    ['捏合放大 scale=1.5 → 不可信（屏坐标不可比）', 1.5, 0, 0, false],
    ['scale 非有限值 → 不可信', NaN, 0, 0, false],
  ]
  let wrong4 = 0
  for (const [name, scale, sy, ot, want] of T4) {
    const got = verify(scale, sy, ot)
    if (got !== want) wrong4++
    ok(`D7 ${name}`, got === want, `期望 ${want} 实得 ${got}`)
  }
  ok('D7 坐标模型判据真值行全部一致', wrong4 === 0, `${wrong4} 行不符`)
}

console.log(`\n${pass}/${fail}`)
process.exit(fail ? 1 : 0)
