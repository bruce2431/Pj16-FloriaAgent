// 键盘弹出适配（移动端）——唯一真源 visualViewport（本文件是手改处，web/app.js 为生成物）
/* @module engine/viewport.js */

  // 依赖反转（分层治理 4A，2026-10-10）：engine 不得静态 import feature。可视区变矮后要重算的
  // 「两层消息流占位/跟随」是 chat/stage.js 的 stageSync，改由 app 启动序列经 setViewportAdapter 注入；
  // 未注入时为空操作（initViewport 之前必已注入，见 app.js 启动序列的依赖接线段）。
  // 变量名不能叫 stageSync——拼接后全模块共享同一 IIFE 作用域，会与 chat/stage.js 的 function 声明重名。
  let stageSyncFn = () => {}

  // ---------- 键盘弹出适配（2026-11-01 重构：壳体跟随可视视口）----------
  // 不变量（用户定案）：键盘弹出时**顶部不动、应用变矮到底栏贴键盘上沿**，不整页上移。
  // 几何：L = html clientHeight（布局视口，移动端键盘不缩它）；浏览器为露出被聚焦元素会移动画面，
  // 位移落在两条**互斥**通道之一，随平台变：
  //   iOS / iPadOS：上顶**可视视口**（vv.offsetTop > 0）；
  //   另有平台滚**布局视口**（window.scrollY > 0）。
  // **只有 offsetTop 进公式**：壳体是 `body{position:fixed}`，布局滚动（scrollY）不移动 fixed 元素
  // ——那份位移对本应用**视觉上不存在**；把它补进 top 就等于凭空把壳体往下推一个键盘高，
  // 而浏览器一收滚动再推回 0 = 可见的「回弹」。所以 pan = max(0, vv.offsetTop) 单通道。
  // 修法（行业通行做法，MDN VisualViewport「simulate position: device-fixed」/ openchamber /
  // DSHA composer-keyboard-lift）：壳体直接**定位到可视视口矩形**——`body{position:fixed}` 取
  //   height = vv.height，top = pan（把可视视口那份上顶在布局坐标里补回来）。
  // 于是屏幕坐标恒等于 [0, vv.height]：顶边钉在屏顶，底边钉在键盘上沿。
  // **纯可视视口派生**：appH/pan 只由 visualViewport 算出，不含任何自引用量（不读 #app
  // 自身 rect、不用恒等式），故不存在「写样式→改测量→再写样式」的回环——这正是旧整页平移方案
  // 抖动的根因（DSHA 记录：rect 已含自己施加的位移，不把已施加量加回去就会自激振荡）。
  // 相位：--app-h / --app-pan / kb-open 全部在事件回调里**同步**写（只写样式属性，不读布局）；
  // 「弹层余量实测 + stageSync 占位重算」走 rAF 合帧。
  // 底栏子件（三轮，用户「底栏的子部件也要适配」）：底栏上所有向上弹出的子件（@提及 / 命令菜单 /
  // 任务浮窗 / 项目·模型·上下文弹层）都贴在栏体上沿外展开，旧写法上限是 vh 或定值——vh 是布局
  // 视口，键盘在场不缩，键盘越高弹层上半截越落在可视区外（够不着）。统一出口 = settle 实测写
  // --bar-room（纯几何 popRoom），子件一律 max-height: min(<设计上限>, var(--bar-room, <设计上限>))：
  // 键盘起落、底栏多行长高、空态↔会话态迁移全由这一条量算吸收，弹层不再各自复刻视口公式。
  // 以**底栏上沿**量 = 对所有子件都是安全上界（栏内 chip 系锚点更低、实际可用更多；取本值只会
  // 让内容多滚一点，绝不越出可视区）。
  // 纯几何（探针直测本函数，勿复制公式）：L/vvH/vvTop/scale/kbActive
  //   → { appH 壳体高, pan 壳体在布局坐标里的下移量 }。
  // `kbActive` = 键盘在场闩锁（见 applyGeometry），由调用方维护；无键盘/捏合缩放时原样返回
  // { appH: L, pan: 0 }（fail-open：不动壳体）。
  function kbGeometry(L, vvH, vvTop, scale, kbActive) {
    // 捏合缩放不是键盘：scale≠1 时 vv 同样变矮，必须排除（否则缩放会误当键盘缩壳）
    if (!kbActive || scale > 1.01) return { appH: L, pan: 0 }
    if (!(vvH > 0) || vvH >= L) return { appH: L, pan: 0 }   // 键盘未在场
    // 只有可视视口上顶需要补（见文件头几何段）：壳体是 fixed，scrollY 不影响它的屏幕位置。
    const pan = Math.max(0, vvTop)
    return { appH: Math.round(vvH), pan: Math.round(pan) }
  }

  // 弹层可用高度（纯几何，探针直测本函数，勿复制公式）：底栏上沿在 **app 内** 的布局 y − 呼吸常量。
  // barTop 由两个 rect 相减得来（底栏 rect 与 #app rect），壳体定位在哪个布局坐标里都会自动抵消，
  // 量到的恒是「底栏上沿离 app 顶边多远」；app 顶边即屏顶，故它就是屏上可用高度。
  function popRoom(barTop, margin) {
    return Math.max(0, Math.round(barTop - margin))
  }

  // 编辑中判定：只有文本输入在场才会弹键盘（非文本聚焦不应触发任何位移）。
  // （2026-09-19）补「焦点在子框架内」：项目预览的站点页面跑在 .preview-frame 里，焦点进入 iframe
  // 文档时父文档 activeElement 就是那个 <iframe> 元素本身（浏览器标准行为，实测 parent activeElement
  // === 'IFRAME'）。旧判定只认 INPUT/TEXTAREA → 预览 iframe 内打字恒 editing=false → kbGeometry 直接
  // 返回 {0,0}：键盘上顶无人锚回、#chat-scroll 也不为键盘让位，整个界面随每次输入被顶起再弹回。
  // iframe 在场即算编辑中——位移量仍由可视视口实测得出，无键盘时 kb/pan 天然为 0，放宽判定不引入空位移。
  function isEditing() {
    const el = document.activeElement
    if (!el) return false
    if (el.tagName === 'IFRAME') return true
    return !!(el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
  }

  // 弹层顶部呼吸余量：一并吃下「弹层底距锚点 4~10px 的 gap」+ 与可视区顶的留白（常量在量算侧，
  // 故 --bar-room 已直接是「弹层可安全占用的高度」，消费点不必各自再减间距）
  const BAR_ROOM_MARGIN = 20

  let lastGeom = ''   // 上一次写入的 {appH,pan} 指纹：恒等则零写，并作为抖动收敛环的停止判据
  let settleRaf = 0

  // 键盘在场闩锁：`editing` 会在键盘动画期间瞬断（焦点在 contenteditable 与 body 之间倒手、
  // 点候选条/工具条都可能让 activeElement 短暂离开输入面）。若几何直接吃瞬时 `editing`，
  // 壳体就「缩→弹回满高→再缩」= 可见回弹。判据改为**键盘在场即保持**：一次「编辑中 + vv 变矮」
  // 即置位，直到 vv.height 回到布局视口高（键盘收起）或出现捏合缩放才复位。
  // 不变量：kbUp ⇔ 键盘正在场；它只由可视视口测量驱动，焦点瞬断不改写它。
  let kbUp = false

  // 应用段（同步段与延迟段共用）：读可视视口 → 写 --app-h / --app-pan / kb-open。
  // 纯写样式属性，不读元素布局（不触发布局）；返回值 = 几何是否变化。
  function applyGeometry() {
    const vv = window.visualViewport
    if (!vv) return false
    const root = document.documentElement
    const L = root.clientHeight
    if (vv.scale > 1.01 || vv.height >= L) kbUp = false          // 捏合 / 键盘收起 → 解除
    else if (isEditing() && vv.height > 0) kbUp = true           // 编辑中且可视视口变矮 → 键盘在场
    const { appH, pan } = kbGeometry(L, vv.height, vv.offsetTop, vv.scale, kbUp)
    const sig = appH + '/' + pan
    if (sig !== lastGeom) {
      lastGeom = sig
      root.style.setProperty('--app-h', appH + 'px')
      root.style.setProperty('--app-pan', pan + 'px')
      document.body.classList.toggle('kb-open', appH < root.clientHeight)
      return true
    }
    return false
  }

  // 同步段：与视觉变化同帧（事件回调内直调，接合视觉视口上顶/键盘起落）
  function syncKeyboard() {
    applyGeometry()   // 同任务内先落一次（把「写完到下一帧」的空窗压到最小）
    scheduleSettle()
    wakePin()         // 再挂收敛环，续跟后续帧
  }

  // 延迟段（rAF 合帧）：弹层余量实测 + 消息流占位/跟随按新几何重算
  function settle() {
    if (settleRaf) { cancelAnimationFrame(settleRaf); settleRaf = 0 } // 直接调用时撤销在途帧，保幂等
    const vv = window.visualViewport
    if (!vv) return
    // 二次应用：事件后一帧可视视口分量（尤其 iPad 那条 scrollY 通道）可能才落定，同步段拿到的是
    // 中间态；此帧以最终值重算一次，把 --app-h/--app-pan 收敛到位（applyGeometry 幂等，值未变即零写）。
    applyGeometry()
    const wrap = document.getElementById('input-wrap')
    const app = document.getElementById('app')
    // 底栏上方可视余量（底栏子件的弹层收口唯一出口）：两个 rect 相减 = 底栏上沿在 app 内的布局 y，
    // 壳体定位与浏览器施加的上顶/滚动在差里全部抵消 ⇒ 量到的与位移口径无关；app 顶边即屏顶，
    // 故该值直接就是「底栏上沿离屏顶多远」。
    if (wrap && app) {
      const barTop = wrap.getBoundingClientRect().top - app.getBoundingClientRect().top
      const barRoom = popRoom(barTop, BAR_ROOM_MARGIN)
      document.documentElement.style.setProperty('--bar-room', barRoom + 'px')
      // composer 遮罩（#composer-mask）高度基准：底栏自身布局高（offsetHeight，不含 FLIP 期间施加
      // 在 #input-wrap 上的内联 scale 变换）。多行输入 / 接管卡长高时 ResizeObserver(wrap) → settle
      // 即重量，渐隐带的上沿随之贴住底栏新上沿。隐藏态高度为 0，不写（保留上次真值，遮罩本就不可见）。
      const barH = wrap.offsetHeight
      if (barH > 0) document.documentElement.style.setProperty('--bar-h', barH + 'px')
    }
    stageSyncFn() // 可视区变矮 → 两层消息流占位/跟随按新几何重算（与 window resize 同口径）
  }

  function scheduleSettle() { if (!settleRaf) settleRaf = requestAnimationFrame(settle) }

  // 抖动收敛环（openchamber useMobileViewportPin 的 pinTracker 同法）：Safari 在键盘动画期间
  // 可能不派发 visualViewport 事件，只靠事件会让壳体停在中间某帧。键盘在场的整段时间里逐帧复算
  // （只写样式属性，零布局读取），几何连续 1s 不变才停 —— 键盘起落期帧帧对齐，静止期不耗电。
  let pinRaf = 0, pinTimer = 0, pinUntil = 0
  function pinTick() {
    pinRaf = 0
    // 几何变了才排量算段：#chat-scroll 是 scroll-behavior:smooth，逐帧空转的 stageSync 会给
    // 消息流反复重定滚动目标（视觉上像列表自己在弹）——没变化就不碰。
    if (applyGeometry()) { pinUntil = performance.now() + 1000; scheduleSettle() }
    if (performance.now() >= pinUntil) {
      // 已静止：降级为低频巡检（键盘仍可能在打字后长高，如候选词条增高）
      if (document.body.classList.contains('kb-open')) pinTimer = setTimeout(wakePin, 250)
      return
    }
    pinRaf = requestAnimationFrame(pinTick)
  }
  function wakePin() {
    clearTimeout(pinTimer); pinTimer = 0
    pinUntil = performance.now() + 1000
    if (!pinRaf) pinRaf = requestAnimationFrame(pinTick)
  }

  // 启动注册（app.js 启动序列调用）；无 visualViewport（旧浏览器）时零行为
  function initViewport() {
    const vv = window.visualViewport
    if (!vv) return
    vv.addEventListener('resize', syncKeyboard)
    vv.addEventListener('scroll', syncKeyboard) // 缩放/上顶改变 offsetTop，同样要同帧重算
    // 布局滚动不作为几何输入（fixed 壳体免疫），但某些平台键盘上顶只伴随 window 滚动事件、
    // 不派 vv 事件 —— 这里只当**唤醒信号**（重算仍只读 visualViewport），无害且覆盖事件缺口。
    window.addEventListener('scroll', syncKeyboard)
    window.addEventListener('orientationchange', syncKeyboard)
    // 底栏自身「尺寸」类变化（多行长高 / 接管卡换高 / 窗口缩放的回流）同样要重量：--bar-room 取自
    // 底栏在 app 内的位置，只挂 vv 事件会漏掉这些帧。写入的只是上限变量，不回改底栏盒模型
    // → 观察者自触发一次即收敛（幂等，非回环）。
    const wrap = document.getElementById('input-wrap')
    if (wrap) {
      new ResizeObserver(scheduleSettle).observe(wrap)
      // 「位移」类变化 ResizeObserver 看不到（观察者只报尺寸）：键盘收起 --app-h 回满、空态↔会话态迁移
      // 都让 #input-wrap 的 top/transform 走 0.55s 过渡，而 settle 在事件后一帧读 rect，拿到的是动画
      // 中间值 —— 此时量出的 --bar-room 是「收起前」的小值，且其后不再有任何事件重量 ⇒ 值被钉死，
      // 底栏子件弹层上限 min(设计上限, --bar-room) 随之永久卡小、内容被 overflow 截断。
      // 守护不变量 = --bar-room 恒对应底栏**到位**后的位置；过渡结束即到位，故此刻重量一次。
      // 只听 end：中断（transitioncancel）只会由新的 --app-h/几何改动引起，那条路已各自排了 settle。
      wrap.addEventListener('transitionend', (e) => { if (e.target === wrap) scheduleSettle() })
    }
    syncKeyboard()
    settle() // 启动首帧也立即对齐（启动无在途动画，不必等下一帧）
  }
// —— 跨模块写入口（切割脚本生成）——
export function setViewportAdapter(a) { stageSyncFn = a.syncStage }

export { initViewport, kbGeometry, popRoom }
