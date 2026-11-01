// 键盘弹出适配（移动端）——唯一真源 visualViewport（本文件是手改处，web/app.js 为生成物）
/* @module engine/viewport.js */

  // 依赖反转（分层治理 4A，2026-10-10）：engine 不得静态 import feature。可视区变矮后要重算的
  // 「两层消息流占位/跟随」是 chat/stage.js 的 stageSync，改由 app 启动序列经 setViewportAdapter 注入；
  // 未注入时为空操作（initViewport 之前必已注入，见 app.js 启动序列的依赖接线段）。
  // 变量名不能叫 stageSync——拼接后全模块共享同一 IIFE 作用域，会与 chat/stage.js 的 function 声明重名。
  let stageSyncFn = () => {}

  // ---------- 键盘弹出适配（v6：普通文档流 + sticky 壳，不猜不补）----------
  // 不变量（用户定案）：键盘弹出时壳体 / 侧栏 / 顶栏 / 消息流的**位置与尺寸全不变**，只有输入栏
  // 抬到键盘上沿之上（22px 内缩保留）。
  //
  // 布局边界（参照普通站点的做法，见 styles.css 键盘节）：html/body 是**普通文档流**，键盘 reveal
  // 需要滚动时由浏览器滚文档，`#app` 用 `position: sticky; top` 钉在滚动口顶部 —— 粘附在滚动机制
  // 内部拿掉位移，主线程不参与。历史三条失败路线均已退役，勿复活：
  //   ① `body{position:fixed}`：fixed 挂布局视口，WebKit 平移可视视口时整块被顶走（实测 top 0→−427）；
  //   ② 变矮 / 合成位移反向补偿：pan 由 UI 进程动画、WebContent 读到的 vv 量滞后 ⇒ 必回弹；
  //   ③ focusin 预测键盘高（记忆 / 冷启动猜高 / 保持窗）：reveal 发生与否不由输入栏位置决定，
  //      实测仍被平移，且首次冷启动无历史值——确定性补丁解决不了不确定性行为。
  // 本模块只做两件事：把**实测**的键盘上沿换成输入栏的 `--kb-lift`，以及给底栏子件量 `--bar-room`。

  // 输入栏需抬起多少（纯几何，探针直测本函数，勿复制公式）。两个入参都在**屏坐标**：
  // visibleBottom = visualViewport.height（键盘上沿在屏上的 y），naturalBottom = 输入栏自然落位底边。
  // naturalBottom 必须由调用方加回**已施加**的 lift 再传入（rect 已含该位移）：不 add-back 就会
  // 把「自己制造的上移」当成自然位置，逐帧互相抵消 ⇒ 自激振荡。
  function kbLift(visibleBottom, naturalBottom) {
    return Math.max(0, Math.round(naturalBottom - visibleBottom))
  }

  // 坐标模型可信判据（纯函数，探针直测）：只验证 scale≈1。
  // 不再要求 scrollY 与 vv.offsetTop 相等：iPadOS 的不同 Safari/WebView 版本可能把 reveal
  // 反映在布局滚动、visualViewport 平移，或两者之一上。输入栏 rect 与 vv.height 都是屏坐标，
  // 因此 lift 的几何并不需要猜是哪条滚动通道；拒绝通道不一致会让真正的 iPad 路径直接失效。
  function kbModelVerified(scale) {
    if (!isFinite(scale) || Math.abs(scale - 1) > 0.01) return false
    return true
  }

  // 弹层可用高度（纯几何，探针直测本函数，勿复制公式）：底栏上沿在 **app 内** 的布局 y − 呼吸常量。
  // barTop 由两个 rect 相减得来（底栏 rect 与 #app rect），壳体定位在哪个布局坐标里都会自动抵消，
  // 量到的恒是「底栏上沿离 app 顶边多远」；app 顶边即屏顶，故它就是屏上可用高度。
  function popRoom(barTop, margin) {
    return Math.max(0, Math.round(barTop - margin))
  }

  // 焦点是否落在输入栏内 = 键盘可能在场（只有此时才抬）。预览 iframe 内的焦点不属于输入栏，
  // 不会触发任何位移（那里键盘由页面自己处理）。
  function composerHasFocus(el) {
    const wrap = document.getElementById('input-wrap')
    return !!(wrap && el && wrap.contains(el))
  }

  // 弹层顶部呼吸余量：一并吃下「弹层底距锚点 4~10px 的 gap」+ 与可视区顶的留白（常量在量算侧，
  // 故 --bar-room 已直接是「弹层可安全占用的高度」，消费点不必各自再减间距）
  const BAR_ROOM_MARGIN = 20

  let lastSig = ''         // 上一次写入的 {lift, armed} 指纹：恒等则零写，并作为抖动收敛环的停止判据
  let settleRaf = 0
  let appliedLift = 0      // 当前已施加在输入栏上的抬升量（add-back 用，必须与 DOM 一致）
  let armed = false        // 焦点在输入栏内 = 键盘可能在场；只有此时才抬，失焦立即交还

  // 写视觉变量（同步段与延迟段共用）：读可视视口与输入栏 rect → 写 --kb-lift / kb-open。
  // 只写样式属性（唯一一次布局读取 = 输入栏 rect），返回 = 抬升 / 布防是否有变化。
  function applyGeometry() {
    const vv = window.visualViewport
    if (!vv) return false
    const verified = kbModelVerified(vv.scale)
    const wrap = document.getElementById('input-wrap')
    let lift = 0
    if (armed && wrap && verified) {
      // 读在写之前：rect 反映的是上一帧施加的 appliedLift，故加回去才是「自然落位」的底边
      lift = kbLift(vv.height, wrap.getBoundingClientRect().bottom + appliedLift)
    }
    const sig = lift + '/' + (armed ? 1 : 0)
    if (sig === lastSig) return false
    lastSig = sig
    appliedLift = lift
    document.documentElement.style.setProperty('--kb-lift', lift + 'px')
    // 键盘期关掉 0.55s 过渡：抬升必须与键盘同帧；失焦后恢复过渡，落回才有缓动
    document.body.classList.toggle('kb-open', armed)
    return true
  }

  // 同步段：与视觉变化同帧（事件回调内直调，接合可视视口上顶 / 键盘起落）
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
    // 二次应用：事件后一帧 vv.height/滚动量可能才落定，同步段拿到的是中间态；此帧以最终值重算一次
    // （applyGeometry 幂等，值未变即零写）。
    applyGeometry()
    const wrap = document.getElementById('input-wrap')
    const app = document.getElementById('app')
    // 底栏上方可视余量（底栏子件的弹层收口唯一出口）：两个 rect 相减 = 底栏上沿在 app 内的 y，
    // app 与底栏同在一个坐标空间，差里自动抵消 ⇒ 量到的与滚动口径无关；app 顶边即屏顶，
    // 故该值直接就是「底栏上沿离屏顶多远」（含键盘在场的抬升，弹层自动跟着收）。
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
  // 可能不派发 visualViewport 事件，只靠事件会让输入栏停在中间某帧。键盘在场的整段时间里逐帧复算
  // （只写样式属性 + 一次 rect 读取），几何连续 1s 不变才停 —— 键盘起落期帧帧对齐，静止期不耗电。
  let pinRaf = 0, pinTimer = 0, pinUntil = 0
  function pinTick() {
    pinRaf = 0
    // 几何变了才排量算段：#chat-scroll 是 scroll-behavior:smooth，逐帧空转的 stageSync 会给
    // 消息流反复重定滚动目标（视觉上像列表自己在弹）——没变化就不碰。
    if (applyGeometry()) { pinUntil = performance.now() + 1000; scheduleSettle() }
    if (performance.now() >= pinUntil) {
      // 已静止：降级为低频巡检（键盘仍可能在打字后长高，如候选词条增高）
      if (armed) pinTimer = setTimeout(wakePin, 250)
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
    vv.addEventListener('scroll', syncKeyboard) // 缩放/平移改变可视区，同样要同帧重算
    // 布防 / 撤防：只有焦点在输入栏内才抬（键盘在场 ⇔ 焦点在输入栏），失焦立即交还。
    // 焦点在输入栏内部挪动（正文框↔附件/发送等可聚焦子件）不算撤离：relatedTarget 仍在栏内即保持。
    document.addEventListener('focusin', (e) => {
      if (!composerHasFocus(e.target)) return
      if (armed) return   // 栏内换焦点：已布防，不重来
      armed = true
      // 不预判键盘高、不抢在 reveal 前写位移：抬升只按实测 vv 收敛（`syncKeyboard` → `applyGeometry`）。
      syncKeyboard()
    }, true)
    document.addEventListener('focusout', (e) => {
      if (!composerHasFocus(e.target)) return
      if (composerHasFocus(e.relatedTarget)) return
      armed = false
      syncKeyboard()
    }, true)
    // 键盘 reveal 在 iOS 上走的是**文档滚动**（scrollY），它改变可视底 ⇒ window scroll 是几何输入，
    // 不是唤醒信号（DSHA 同口径：screen-space 量随滚动变，必须重算）。
    window.addEventListener('scroll', syncKeyboard)
    window.addEventListener('orientationchange', syncKeyboard)
    // 底栏自身「尺寸」类变化（多行长高 / 接管卡换高 / 窗口缩放的回流）同样要重量：--bar-room 取自
    // 底栏在 app 内的位置，只挂 vv 事件会漏掉这些帧。写入的只是上限变量，不回改底栏盒模型
    // → 观察者自触发一次即收敛（幂等，非回环）。
    const wrap = document.getElementById('input-wrap')
    if (wrap) {
      new ResizeObserver(scheduleSettle).observe(wrap)
      // 「位移」类变化 ResizeObserver 看不到（观察者只报尺寸）：键盘收起 --kb-lift 回 0、
      // 空态↔会话态迁移都让 #input-wrap 的 top/transform 走 0.55s 过渡，而 settle 在事件后一帧读 rect，
      // 拿到的是动画中间值 —— 此时量出的 --bar-room 是「收起前」的小值，且其后不再有任何事件重量 ⇒
      // 值被钉死，底栏子件弹层上限 min(设计上限, --bar-room) 随之永久卡小、内容被 overflow 截断。
      // 守护不变量 = --bar-room 恒对应底栏**到位**后的位置；过渡结束即到位，故此刻重量一次。
      // 只听 end：中断（transitioncancel）只会由新的 --kb-lift/几何改动引起，那条路已各自排了 settle。
      wrap.addEventListener('transitionend', (e) => { if (e.target === wrap) scheduleSettle() })
    }
    syncKeyboard()
    settle() // 启动首帧也立即对齐（启动无在途动画，不必等下一帧）
  }
// —— 跨模块写入口（切割脚本生成）——
export function setViewportAdapter(a) { stageSyncFn = a.syncStage }

export { initViewport, kbLift, kbModelVerified, popRoom }
