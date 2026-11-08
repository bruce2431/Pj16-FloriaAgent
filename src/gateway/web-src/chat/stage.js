// 消息流 stage 跟读定位 + 滚动（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { absorbPending } from './messages.js'
import { renderHome, renderSession } from './route.js'
import { messagesEl, live, state } from '../engine/state.js'
import { cardBus } from '../engine/card-bus.js'
import { renderTransient } from '../inputbar/approval.js'
import { activateSession } from '../sidebar/recent.js'
/* @module chat/stage.js */
  function scrollBottom() {
    // 占位在场（回合展示期）→ 两层跟随接管（让位/手势中由 stageFollow 自判）；否则普通吸底
    if (stage.active) { stageFollow(); return }
    const sc = messagesEl.closest('#chat-scroll')
    progScroll()
    sc.style.scrollBehavior = 'auto'
    sc.scrollTop = sc.scrollHeight
    sc.style.scrollBehavior = ''
  }

  // ---- 两层消息流（2026-09-08 定案）：层1=真实消息流，层2=静态占位块 .pin-stage ----
  // 占位块由回合开启消息唤出（web 乐观气泡 / CLI 端权威新 user 消息），挂 #messages 流末
  // （后续内容插它前面）。高度（2026-09-09 用户定案「过于大」根修）= max(0, 视口高 −
  // paddingBottom − 内容脚印)：脚印 footprint=内容底−气泡贴顶位，占位只补足「贴顶视角下
  // 内容底到可视区底的余量」——可视区=clientHeight 扣常驻 padding-bottom 142px（docked
  // 输入栏悬浮预留，不扣则占位铺到输入栏底下多一条）；新回合脚印只含开启气泡（气泡钉在
  // 历史末尾），占位≈满屏减一气泡属几何必然。公式恰好保证贴顶位可达，空白永不越出可视区。
  // **脚印实时读取（2026-09-10 用户实测「乐观气泡被滑到屏幕外」根修）**：原「诞生快照
  // 锁定（lockFoot），绝不随内容变化」使诞生后任何内容增长（图片异步撑高 / 折叠体变高 /
  // 回复正文变长）都 1:1 变成额外可滚动余量（maxScroll = padTop + 贴顶位 + 增长量）——
  // 内容尚未超一屏时滚到底即可把开启气泡推出视口顶。改实时后不变量：内容未超一屏时
  // scrollHeight ≡ 一屏、maxScroll ≡ 贴顶位（滚动极限=气泡贴顶），内容增长/收起都不改变
  // 滚动范围（收起不骤减的旧目标同样成立——占位实时变大对冲，scrollHeight 恒定）；超过
  // 一屏占位归零、自然转内容底跟随。resize 换视口高随实时读数自动重算。
  // 占位块恒定在场（回合结束不自动撤；内容变化只改高度不改去留）；**用户滚动输入永不摘占位**
  // （2026-09-09 用户定案「为什么还会有释放链这种东西」——滚轮/触摸/拖滚动条一律只让位跟随），
  // 拆收仅发生在离开会话视图（切会话/回首页/管理视图/项目预览，stageRelease 的全部调用点）。
  // 跟随吸底目标=真实内容底（占位起点贴视口底）：内容未满一屏时视口停在开启气泡贴顶位、
  // 内容在下方生长；超过一屏后平滑转入内容底跟随、气泡自然上滑出视口顶——无 sticky 驻留
  // （旧 pin 体系 pinReserveApply/临时让位/settleCheck 轮询/劈开补丁全链退役）。
  // 占位高度实时对冲内容增减 → 未超一屏时 scrollHeight 恒定，任何内容收起（折叠收起等）都
  // 不会令 scrollTop 越出 maxScroll → 历史收起闪动/clamp 补丁不再需要。
  // key=回合开启消息标识（'optimistic'=乐观气泡在场 | 'idx:ts'=权威 user）；
  // bubble=贴顶驻留参照气泡。
  // touchHold=触摸手势持有中（含惯性）：手势进行中程序滚动/删除占位 = scrollHeight 骤减 =
  // WebKit 触摸滚动基准断裂（2026-09-08 用户实测「iPad 滑动就死」）→ 持有期冻结程序跟随。
  // yielded=用户滚动输入（滚轮/触摸/滚动条/键盘）后跟随永久让位（用户已接管视口；stageStart 复位）。
  const stage = { active: false, key: null, el: null, bubble: null, touchHold: false, releaseT: null, yielded: false }
  // 程序滚动窗口：此时刻前的 scroll 事件不算用户操作（跟随/动画自身写入 scrollTop 会触发 scroll）
  let progScrollUntil = 0
  function progScroll() { progScrollUntil = Date.now() + 80 }

  // 元素顶边在滚动内容坐标系中的 y（贴视口顶对应的 scrollTop）。旧体系 msg-pin 是 sticky，
  // 吸附时 offsetTop 变吸附位须用兄弟几何推算；新体系无 sticky，offsetTop 恒自然流位可直接用。
  function topInScroll(el) {
    const sc = $('chat-scroll')
    const padTop = parseFloat(getComputedStyle(sc).paddingTop) || 0
    return Math.max(0, el.offsetTop - sc.offsetTop - padTop)
  }

  // ---------- chat 卡片公开 API（2026-10-21）----------
  // 消息流对宿主/其它卡只暴露标准动词：scroll{line} = 滚到第 line 条消息（1-based `.msg` 文档序，
  // 与引用令牌「第 N 条回复」同源）；locate/state 只读。引用胶囊点击一律经 cardBus.callCard 驱动
  // （chat/messages/msg-actions.js 的委托），不直取本模块内部滚动状态——跨卡只走公开信道。
  function scrollToMsgLine(n) {
    const list = [...messagesEl.querySelectorAll('.msg')]
    const i = Math.floor(Number(n) || 0) - 1
    const el = list[i]
    if (!el) throw new Error(`没有第 ${n} 条消息（共 ${list.length} 条）`)
    stage.yielded = true // 用户主动跳转 = 接管视口：进行中的回合跟随让位（同 turn-rail 导航语义）
    progScroll()
    $('chat-scroll').scrollTo({ top: topInScroll(el), behavior: 'smooth' })
    return { line: i + 1, total: list.length }
  }
  cardBus.registerInlineCard({
    instanceId: 'floria-chat',
    ns: 'floria-chat',
    cmds: ['open', 'scroll', 'locate', 'state'],
    handlers: {
      // open{sid} = 切到该会话（@ 会话 chip 的跳转落点）；sid = 转录文件名主干，与路由 hash 同源。
      open: async (a) => {
        const sid = String((a && a.sid) || '')
        if (!sid) throw new Error('缺少会话 id')
        activateSession(sid)
        return { sid }
      },
      scroll: (a) => scrollToMsgLine(a && a.line),
      locate: () => ({ messages: messagesEl.querySelectorAll('.msg').length }),
      state: () => ({ mode: state.sbMode || 'chat', messages: messagesEl.querySelectorAll('.msg').length }),
    },
  })

  // 拆收：撤占位块+清状态。仅视图级退出触发（切会话 renderSession/回首页 renderHome/
  // 管理视图 renderMgr/项目预览 openProjectPreview）——用户滚动输入不进入此函数（2026-09-09
  // 释放链铲除定案，滚动输入只让位）。remove 瞬间 scrollHeight 骤减一屏，浏览器 clamp 把
  // scrollTop 拉回合法值——视口在内容区则纹丝不动，内容连续零跳动（无需手动补偿）。
  function stageRelease() {
    if (stage.releaseT) { clearTimeout(stage.releaseT); stage.releaseT = null }
    stage.touchHold = false
    stage.yielded = false
    if (stage.el) stage.el.remove()
    stage.el = null
    stage.active = false
    stage.key = null
    stage.bubble = null
  }

  // pinned 跟随：scrollTop = max(开启气泡贴顶位, 内容底位)。
  // 内容未满一屏时贴顶位更大 → 视口停在气泡贴顶处、折叠体/回复在下方生长（占位垫底）；
  // 内容超过一屏后内容底位反超 → 平滑转入内容底跟随（最新内容贴视口底），气泡自然上滑出视口顶。
  // 两视角在贴顶位处无缝衔接，无需 sticky（占位高度随内容实时对冲，贴顶位即滚动极限）。
  // bubble 失联（换皮窗口）时退化为纯内容底。
  // 无动画窗：跟随是几何的纯函数，谁写 scrollTop 都落在同一落点（幂等），无需互斥。
  function stageFollow() {
    // touchHold：手势中程序滚动=基准断裂；yielded：用户滚动输入后已接管视口，跟随永久让位
    if (!stage.active || stage.touchHold || stage.yielded) return
    const sc = $('chat-scroll')
    const stageEl = stage.el
    if (!stageEl || !stageEl.isConnected) return
    const padBot = parseFloat(getComputedStyle(sc).paddingBottom) || 0
    const contentBottom = Math.max(0, topInScroll(stageEl) - sc.clientHeight + padBot)
    const t0 = stage.bubble && stage.bubble.isConnected ? topInScroll(stage.bubble) : 0
    const max = sc.scrollHeight - sc.clientHeight
    progScroll()
    sc.style.scrollBehavior = 'auto'
    sc.scrollTop = Math.min(Math.max(t0, contentBottom), Math.max(0, max))
    sc.style.scrollBehavior = ''
  }

  // 唤出（回合开启）：占位块挂/复用（stageSync）+ 按跟随几何同帧就位（stageFollow）。
  // 2026-09-11「发送新消息界面短暂跳到上一条消息」根治——09-09「占位初始高=乐观气泡同高，
  // rAF 750ms 拉伸到目标高」的动画窗铲除：初值取气泡高 = 占位先缩后长，scrollHeight 在同一
  // 事务内先塌，浏览器按缩后的 max 钳 scrollTop（首帧就画在内容底 = 上一回合尾部），再由
  // rAF 逐帧抬到贴顶位——用户看到的就是「跳到上一条消息」再滑回。占位高度是几何的纯函数
  // （参照气泡定了，终态就定了），没有中间态可言：写终态 + 同帧归位，浏览器只绘一帧、那一帧
  // 即终态。不变量：占位块至多一个（#messages 流末）、占位高度唯一写入者=stageSync。
  function stageStart(bubbleEl, key) {
    stage.active = true
    stage.key = key
    stage.bubble = bubbleEl
    if (stage.releaseT) { clearTimeout(stage.releaseT); stage.releaseT = null }
    stage.touchHold = false
    stage.yielded = false
    // 脚印无需重置：实时读取（stageSync 每趟按当前几何量），换参照气泡即自动跟随新几何
    stageSync()
  }

  // 回合权威锚解析（2026-09-11「发送后短暂跳到上一条消息」二轮根修）：注入开段回合
  // （injected user → user:null 切段，messagesHtml 切段定案）在 DOM 无 data-t="u" 开启气泡
  // ——注入气泡以 data-t="g…" 织在段折叠体 done-body 内（data-g=自身消息索引）。因此凡以
  // 「末条 data-t="u"」为参照的回落，在注入开段回合命中的必是**上一回合**气泡。锚=引导气泡
  // 所属段折叠（details.done-fold[data-m]）：user:null 段的段首元素即折叠体，折叠顶=回合顶=
  // 乐观气泡原位；段内若另有 data-t="u"（回合由真实 user 开段、引导系中途织入）则仍取开启
  // 气泡（段顶=气泡顶）。
  function guideTurnAnchor(guideEl) {
    const fold = guideEl.closest('details.done-fold[data-m]')
    if (!fold) return null
    return messagesEl.querySelector(`[data-m="${fold.dataset.m}"][data-t="u"]`) || fold
  }

  // 乐观吸收后的同回合锚：最新回合由注入开启还是真实 user 开启，以文档序判——最新引导气泡
  // 在末条开启气泡之后 ⇔ 注入开段（该回合没有 data-t="u"）→ 取其折叠锚；否则（无引导/
  // dequeue 落盘开段/引导织在更早回合）→ 末条开启气泡（dequeue 接管帧原行为）。禁止回落
  // 上一回合参照（=本缺陷：吸收帧参照回退上一回合 → 重钉上一条消息）。
  function absorbTurnAnchor() {
    const users = messagesEl.querySelectorAll('[data-t="u"]')
    const lastUser = users.length ? users[users.length - 1] : null
    const guides = messagesEl.querySelectorAll('.msg.user[data-t^="g"]')
    const lastGuide = guides.length ? guides[guides.length - 1] : null
    if (lastGuide && (!lastUser || (lastUser.compareDocumentPosition(lastGuide) & Node.DOCUMENT_POSITION_FOLLOWING))) {
      return guideTurnAnchor(lastGuide) || lastUser
    }
    return lastUser
  }

  // 渲染权威出口对账：整页重建洗掉占位块/气泡失联 → 重挂（流末）+ 气泡重定位 + 高度校准，
  // 然后按跟随几何归位。占位高度 = max(0, clientHeight − paddingBottom − 当前脚印)
  // （脚印 = 占位块顶 − 气泡贴顶位，**实时读取**；clientHeight 含常驻 padding-bottom 142px
  // （docked 输入栏悬浮预留），不扣则占位铺到输入栏底下；扣除后空白恰铺到输入栏上沿，
  // 未超一屏时 maxScroll ≡ 贴顶位）。高度唯一写入者=本函数（几何纯函数，无动画窗/无第二写入者）。
  function stageSync() {
    if (!stage.active) return
    const sc = $('chat-scroll')
    let el = stage.el && stage.el.isConnected ? stage.el : messagesEl.querySelector('.pin-stage')
    if (!el) {
      el = document.createElement('div')
      el.className = 'pin-stage'
      messagesEl.appendChild(el)
    }
    stage.el = el
    // 气泡参照找回——必须在脚印/高度计算之前（实时脚印 = 占位块顶 − 气泡顶，参照物缺席则
    // 无法量）。参照物定义=本回合开启用户消息，按精度递降定位：乐观期=暂态区最后一条
    // .msg.user；乐观项已被吸收（注入落盘/落盘接管，暂态区气泡移除）→ absorbTurnAnchor
    // 移交**同一回合**的权威锚（注入开段=段折叠顶，落盘开段=数据区开启气泡），禁止回落
    // 上一回合。
    if (!stage.bubble || !stage.bubble.isConnected) {
      if (stage.key === 'optimistic') {
        const zone = document.getElementById('live-zone')
        const els = zone ? zone.querySelectorAll('.msg.user') : []
        stage.bubble = (els.length ? els[els.length - 1] : null) || absorbTurnAnchor()
      } else {
        // 2026-09-09 跳动主根根修：stage.key 存 sig（"idx:ts"，防索引复用错位），但渲染权威
        // 气泡 data-m=段起始索引（纯数字）——整页重建后按 sig 原样匹配 data-m 恒落空 → bubble
        // 永久失联 → stageFollow t0 退化 0、落点从贴顶位瞬移内容底（差近一屏）=每回合首帧刷新
        // 必跳。修=取 sig 索引部分（":" 前）匹配 data-m；sig 防错位语义保留在 key 本体。
        stage.bubble = stage.key ? messagesEl.querySelector(`[data-m="${String(stage.key).split(':')[0]}"][data-t="u"]`) : null
      }
      if (stage.bubble && !stage.bubble.isConnected) stage.bubble = null
    }
    const padBot = parseFloat(getComputedStyle(sc).paddingBottom) || 0
    const t0 = stage.bubble ? topInScroll(stage.bubble) : null
    // 参照气泡两端皆缺（重建窗口内）不写高——占位高度连续性优先（写 0 = scrollHeight 骤减
    // = 视口钳制跳变）。
    if (t0 != null) {
      el.style.height = Math.max(0, sc.clientHeight - padBot - Math.max(0, topInScroll(el) - t0)) + 'px'
    }
    stageFollow()
  }

  // 追加到 #messages 末尾；插入点取暂态区 #live-zone（其子元素恒为消息流最末尾段）或两层占位
  // .pin-stage 之前（占位块恒为最后一个元素，否则预留空白会出现在消息中间）。2026-09-07 两区
  // 重构：权威内容永远插在暂态区之前——暂态区（气泡/主张折叠/排队区）恒贴底，不再与增量插入
  // 竞争文档序（「排队消息渲染到上一行」根因的结构性消除）。
  function msgAppend(el) {
    messagesEl.insertBefore(el, document.getElementById('live-zone') || messagesEl.querySelector('.pin-stage'))
    return el
  }

  function appendMsg(html) {
    const div = document.createElement('div')
    div.innerHTML = html
    const el = div.firstElementChild
    el.classList.add('msg-in')
    msgAppend(el)
    scrollBottom()
  }

  // 2026-08-30 共同后端定案（接力文档清单#4②③）→ 2026-09-07 两区重构收编：回合中发送的乐观
  // = 排队区成员（对齐 CLI 语义：回合运行中入队，终端只显示队列预览）；回合间隙发送 = 新回合
  // 开启主张（开启气泡 + 「正在处理」主张折叠，renderTransient 统一渲染于 #live-zone 暂态区）。
  // 生命周期：发送 → 乐观主张/排队成员 → CLI 注入（injected 出现）或 dequeue 落盘（user 出现）
  // → absorbPending 文本吸收移除（渲染权威接管）；权威 done-live[data-m] 在场 → 主张降级
  // （renderTransient 同趟：主张折叠不渲染、气泡项按排队成员渲染）。
export {
  appendMsg,
  msgAppend,
  progScroll,
  progScrollUntil,
  scrollBottom,
  stage,
  stageFollow,
  stageRelease,
  stageStart,
  stageSync,
  topInScroll,
}
