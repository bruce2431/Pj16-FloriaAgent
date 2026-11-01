// probe-keyboard-viewport.ts —— 「键盘只变矮、顶部不动」不变量探针（只读）
// 定案：移动端（iPad/手机）底栏聚焦弹键盘时，浏览器为露出焦点元素会移动画面（可视视口上顶
// vv.offsetTop；另有平台滚布局视口 window.scrollY）。修法 = 壳体（body）直接定位到**可视视口矩形**：
//   height = vv.height，top = pan = max(0, vv.offsetTop)
// ⇒ 屏幕坐标恒为 [0, 键盘上沿]，顶部不动、底部贴键盘；两个量只由 visualViewport 派生，不含自引用量
// ⇒ 不存在「写样式→改测量→再写样式」的回环（旧整页平移方案抖动的根因）。
// **布局滚动（scrollY）不进公式**：壳体 fixed，布局滚动不移动它；把它补进 top = 凭空下推 ⇒ 回弹。
// 断言分两类：① 源码/产物结构（唯一真源接线、CSS 消费点、版本同步）；
// ② 行为真值表——几何函数 kbGeometry / popRoom 从 web-src 源码**提取**（非手抄），喂真实维度组合。
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
ok('A3 几何输入 = 布局视口高、可视视口高/上顶、缩放、键盘在场（布局滚动不入公式）',
  /kbGeometry\(L,\s*vv\.height,\s*vv\.offsetTop,\s*vv\.scale,\s*kbUp\)/.test(viewportJs))
// 壳体 fixed ⇒ 布局滚动（scrollY）不移动它，补进 top 只会凭空下推（浏览器收滚动时即回弹）。
ok('A3 pan 只取可视视口上顶（max(0, vvTop)），scrollY 不进几何',
  /const pan = Math\.max\(0, vvTop\)/.test(viewportJs) && !/kbGeometry\([^)]*scrollY/.test(viewportJs))
ok('A3 壳体高 = 可视视口高（键盘上沿），位移 = pan',
  /return \{ appH: Math\.round\(vvH\), pan: Math\.round\(pan\) \}/.test(viewportJs))
// 键盘在场闩锁：焦点瞬断（键盘动画期 activeElement 在输入面与 body 间倒手）不得让壳体弹回满高。
ok('A3 键盘在场闩锁：由 vv 测量置位/复位，几何吃闩锁不吃瞬时 editing',
  /let kbUp = false/.test(viewportJs) &&
    /vv\.height >= L\) kbUp = false/.test(viewportJs) &&
    /isEditing\(\) && vv\.height > 0\) kbUp = true/.test(viewportJs) &&
    /kbGeometry\(L, vv\.height, vv\.offsetTop, vv\.scale, kbUp\)/.test(viewportJs))
ok('A3 无键盘/非编辑/缩放时 fail-open（{ appH: L, pan: 0 }）',
  (viewportJs.match(/return \{ appH: L, pan: 0 \}/g) || []).length >= 2)
// 旧整页平移整套已退役：再出现任一个都意味着双轨。
ok('A3 旧整页平移变量全部退役（--kb / --kb-total / lastTotal 均已删除）',
  !/--kb-total|setProperty\('--kb'|lastTotal/.test(viewportJs))
ok('A3 不再有「浏览器位移归零」迎战代码（scrollTo 已删）', !/scrollTo\(/.test(viewportJs))
ok('A3 键盘在场重算消息流占位几何（注入的 syncStage；engine 不 import feature）',
  /stageSyncFn\(\)/.test(viewportJs) && /export function setViewportAdapter/.test(viewportJs) &&
    !/^import .*from '\.\.\/(chat|inputbar|sidebar|feature)\//m.test(viewportJs))

// ---------- ②b 相位与收敛 ----------
ok('A4 监听器直挂同步段（resize/scroll 同帧写几何）',
  /vv\.addEventListener\('resize', syncKeyboard\)/.test(viewportJs) && /vv\.addEventListener\('scroll', syncKeyboard\)/.test(viewportJs))
ok('A4 window scroll 仅作唤醒信号（重算只读 vv，布局滚动不进几何）',
  /window\.addEventListener\('scroll', syncKeyboard\)/.test(viewportJs))
ok('A4 同步段内不读元素布局（getBoundingClientRect/offset* 会强制布局）', (() => {
  const syncBody = body(viewportJs, 'function applyGeometry()')
  const layoutReads = [...syncBody.matchAll(/([\w.$]+)\.offsetTop/g)].map((m) => m[1]).filter((s) => s !== 'vv')
  return syncBody.length > 0 && !/getBoundingClientRect|offsetHeight|offsetWidth/.test(syncBody) && layoutReads.length === 0
})())
// Safari 键盘动画期间可能漏发 vv 事件：只靠事件会让壳体停在中间帧。收敛环逐帧复算，静止 1s 后
// 降为 250ms 巡检（openchamber pinTracker 同法）。
ok('A4 抖动收敛环在场（rAF 逐帧复算 + 静止后低频巡检）',
  /requestAnimationFrame\(pinTick\)/.test(viewportJs) && /setTimeout\(wakePin, 250\)/.test(viewportJs) &&
    /pinUntil = performance\.now\(\) \+ 1000/.test(viewportJs))
ok('A4 仅「量算 + 占位重算」走 rAF 合帧',
  /requestAnimationFrame\(settle\)/.test(viewportJs) && /stageSyncFn\(\)/.test(body(viewportJs, 'function settle()')))
ok('A4 弹层余量输入位移无关（rect 相减得 app 内布局 y）',
  /wrap\.getBoundingClientRect\(\)\.top - app\.getBoundingClientRect\(\)\.top/.test(body(viewportJs, 'function settle()')))

// ---------- ③ CSS 消费点 ----------
ok('B1 壳体 = position:fixed + top:--app-pan + height:--app-h + box-sizing:border-box', (() => {
  const block = /^body \{[^}]*\}/m.exec(css)?.[0] ?? ''
  return /position: fixed;/.test(block) && /top: var\(--app-pan, 0px\);/.test(block) &&
    /height: var\(--app-h, 100dvh\);/.test(block) && /box-sizing: border-box;/.test(block)
})(), '壳体规则被改写？')
ok('B1 文档不可滚（html overflow:hidden + overscroll-behavior:none，无橡皮筋回弹）',
  /^html \{[^}]*overflow: hidden;[^}]*overscroll-behavior: none;/m.test(css))
ok('B1 整页平移本体已删除（#app 无 translateY 键盘规则）', !/body\.kb-open #app \{[^}]*transform/.test(css))
ok('B1 #app 本体恒无 transform（fixed 后代基准稳定）', !/^#app \{[^}]*transform:/m.test(css))
ok('B1 消息流不再收 --kb-total（壳体变矮即自动收窄）',
  !/#chat-scroll \{[^}]*margin-top:\s*var\(--kb-total/.test(css) && !/--kb-total/.test(css))
ok('B1 docked 底栏钉 app 底边 22px（不再自补位移）',
  /#input-wrap\.docked \{[^}]*top:\s*calc\(100% - 22px\);[^}]*transform: translate\(-50%, -100%\)/.test(css) &&
    !/#input-wrap\.docked \{[^}]*var\(--kb/.test(css))
ok('B1 空态底栏随台面比例走（--kb-lift 退役，不再单独抬）',
  /#empty-hint #input-wrap \{[^}]*transform:\s*translate\(-50%, -50%\)/.test(css) &&
    !/--kb-lift/.test(css) && !/--kb-lift/.test(viewportJs))
ok('B1 键盘在场底栏不做缓动（否则整程拖尾在键盘后）', /body\.kb-open #input-wrap \{\s*transition: none; \}/.test(css))
ok('B1 #empty-hint 自身不含任何位移/收缩（背景层不参与）',
  !/#empty-hint \{[^}]*var\(--kb/.test(css))
ok('B1 work 顶栏不再为键盘让位（壳体已收，双让位会压扁编辑区）',
  !/body\.kb-open #chat-area\.work/.test(css))

// ---------- ③b 覆盖层（搜索层/风险门/重命名弹窗）：遮罩 ≡ 壳体 ≡ 可视窗 ----------
// 选择器形态两种都认：独占规则（#id {）或与共用壳合写（:is(#rename-modal, #dl-modal) {）。
const selOf = (id: string) => `(?:#${id}|:is\\(#${id}, #dl-modal\\))`
for (const [name, id] of [['搜索层', 'search-overlay'], ['风险门', 'risk-modal'], ['重命名弹窗', 'rename-modal']] as const) {
  const re = new RegExp(`${selOf(id)} \\{[^}]*position: absolute;[^}]*top: 0; right: 0; bottom: 0; left: 0;`)
  ok(`B2 ${name} #${id} 在 app 壳体内 absolute inset（遮罩 = 壳体 = 可视窗）`, re.test(css))
  ok(`B2 ${name} 不再 position:fixed 挂视口（会随键盘漂走）`, !new RegExp(`${selOf(id)} \\{[^}]*position: fixed`).test(css))
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

// ---------- ③c 底栏子件（向上弹出的七个弹层）：上限一律收 --bar-room ----------
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
ok('B3 唯一真源导出 popRoom（探针直测，消费者不各自复刻公式）',
  /export \{ initViewport, kbGeometry, popRoom \}/.test(viewportJs))
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
ok('C1 产物 app.js 含定义与调用点', ['function kbGeometry(', 'function syncKeyboard(', 'function settle(', 'function initViewport(', 'initViewport()'].every((s) => appJs.includes(s)))
ok('C1 产物 app.js 未引用模块 import 语法（拼接已剥壳）', !/^\s*import .*viewport\.js/m.test(appJs))
ok('C1 产物 app.js 含「焦点在子框架内」判定（预览 iframe 内输入，构建须同步）', /tagName === 'IFRAME'/.test(appJs))
const swV = /const CACHE = 'floria-v(\d+)'/.exec(swJs)?.[1]
const appV = /\/app\.js\?v=(\d+)/.exec(indexHtml)?.[1]
ok('C2 sw CACHE 与 index.html app.js ?v= 同步', !!swV && swV === appV, `sw=v${swV} app=v${appV}`)
ok('C2 index.html 引用 styles.css 且带 cache-bust', /\/styles\.css\?v=\d+/.test(indexHtml))

// ---------- ⑤ 行为真值表：几何函数从 web-src 源码提取 ----------
const geoBody = body(viewportJs, 'function kbGeometry(')
ok('D1 kbGeometry 可从源码提取', geoBody.length > 0, 'viewport.js 函数签名被改写？')
if (geoBody) {
  const kbGeometry = new Function(`return ${geoBody}`)() as (L: number, vvH: number, vvTop: number, scale: number, editing: boolean) => { appH: number; pan: number }
  // [名称, L, vvH, vvTop, scale, editing, 期望 appH, 期望 pan]
  // appH = 壳体高（键盘上沿到屏顶）；pan = 壳体在布局坐标里的下移量 = **可视视口**上顶量。
  const T: [string, number, number, number, number, boolean, number, number][] = [
    ['桌面/未聚焦：全高可视视口 → 满屏零位移', 834, 834, 0, 1, false, 834, 0],
    ['聚焦瞬间键盘未起：仍满屏零位移', 834, 834, 0, 1, true, 834, 0],
    ['iPad 键盘 300、无上顶：壳体 534、pan 0', 834, 534, 0, 1, true, 534, 0],
    ['iOS 键盘 300 + 上顶 100：壳体 534、pan 100', 834, 534, 100, 1, true, 534, 100],
    ['上顶吃掉全部空缺：壳体 272、pan 562', 834, 272, 562, 1, true, 272, 562],
    ['上顶超过键盘高：pan 仍取实测 700', 834, 272, 700, 1, true, 272, 700],
    ['安卓（布局视口同步缩）：appH = L 不缩壳', 534, 534, 0, 1, true, 534, 0],
    ['捏合缩放（非编辑）：不缩壳', 834, 500, 0, 1, false, 834, 0],
    ['捏合缩放（编辑中，scale=2）：不误判为键盘', 834, 417, 120, 2, true, 834, 0],
    ['scale 轻微数值噪声（1.005）仍按键盘处理', 834, 534, 0, 1.005, true, 534, 0],
    ['异常：可视视口高于布局视口 → 不缩壳', 834, 900, 0, 1, true, 834, 0],
    ['异常：offsetTop 为负 → pan 夹到 0', 834, 534, -5, 1, true, 534, 0],
    ['布局滚动（scrollY≠0）不参与几何：fixed 壳体免疫', 834, 534, 0, 1, true, 534, 0],
    ['子像素取整：vvH 533.6 → 534、pan 299.6 → 300', 834, 533.6, 299.6, 1, true, 534, 300],
  ]
  let wrong = 0
  for (const [name, L, vvH, vvTop, scale, editing, appH, pan] of T) {
    const got = kbGeometry(L, vvH, vvTop, scale, editing)
    if (got.appH !== appH || got.pan !== pan) wrong++
    ok(`D2 ${name}`, got.appH === appH && got.pan === pan, `期望 appH=${appH}/pan=${pan} 实得 appH=${got.appH}/pan=${got.pan}`)
  }
  ok('D3 全部真值行一致', wrong === 0, `${wrong} 行不符`)
}

// ---------- ⑤b 行为真值表：弹层余量函数（同样从源码提取） ----------
const prBody = body(viewportJs, 'function popRoom(')
ok('D4 popRoom 可从源码提取', prBody.length > 0, 'viewport.js 函数签名被改写？')
if (prBody) {
  const popRoom = new Function(`return ${prBody}`)() as (barTop: number, margin: number) => number
  // [名称, 底栏上沿在 app 内的布局 y, 呼吸常量, 期望余量]
  const T2: [string, number, number, number][] = [
    ['无键盘：底栏上沿 700、呼吸 20 → 680', 700, 20, 680],
    ['键盘在场：底栏上沿在 app 内 480、呼吸 20 → 460', 480, 20, 460],
    ['余量被吃光：钳到 0（不产生负 max-height）', 10, 20, 0],
    ['底栏落在屏顶之上：钳到 0', 8, 20, 0],
    ['子像素取整', 480.6, 20, 461],
  ]
  let wrong2 = 0
  for (const [name, barTop, margin, want] of T2) {
    const got = popRoom(barTop, margin)
    if (got !== want) wrong2++
    ok(`D5 ${name}`, got === want, `期望 ${want} 实得 ${got}`)
  }
  ok('D5 弹层余量真值行全部一致', wrong2 === 0, `${wrong2} 行不符`)
}

// ---------- ⑤c 行为真值表：编辑中判定（项目预览 iframe 内输入必须算「编辑中」） ----------
const ieBody = body(viewportJs, 'function isEditing()')
ok('D6 isEditing 可从源码提取', ieBody.length > 0, 'viewport.js 函数签名被改写？')
if (ieBody) {
  const withDoc = new Function('document', `return (${ieBody})`) as (d: { activeElement: unknown }) => () => boolean
  const run = (active: unknown) => withDoc({ activeElement: active })()
  const T3: [string, unknown, boolean][] = [
    ['焦点在预览 iframe 内输入（父文档 activeElement=IFRAME）→ 编辑中', { tagName: 'IFRAME' }, true],
    ['INPUT 聚焦 → 编辑中', { tagName: 'INPUT' }, true],
    ['TEXTAREA 聚焦 → 编辑中', { tagName: 'TEXTAREA' }, true],
    ['contentEditable 元素聚焦 → 编辑中', { tagName: 'DIV', isContentEditable: true }, true],
    ['按钮等非文本聚焦 → 非编辑中（不触发位移）', { tagName: 'BUTTON' }, false],
    ['无焦点（activeElement=null）→ 非编辑中', null, false],
  ]
  let wrong3 = 0
  for (const [name, active, want] of T3) {
    const got = run(active)
    if (got !== want) wrong3++
    ok(`D7 ${name}`, got === want, `期望 ${want} 实得 ${got}`)
  }
  ok('D7 编辑中判定真值行全部一致', wrong3 === 0, `${wrong3} 行不符`)
}

console.log(`\n${pass}/${fail}`)
process.exit(fail ? 1 : 0)
