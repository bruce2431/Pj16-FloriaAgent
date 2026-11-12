// 卡片公开 API 总线（2026-10-11）：帧实例表 + 命令通道（卡↔宿主）+ 跨卡 broker（卡↔卡）+ 能力表上报
// （供 agent 查询/调用）。权威设计 = Neuron-Pj18 的 `l3.raw/files/卡片公开API设想_v1.md`：
// 三层模型（传输 / 契约 / 中介）——**宿主是唯一 broker**；iframe 之间不共享 window、跨源拿不到对方
// contentWindow ⇒ 卡片永远只认识 `parent` 一个对象（浏览器物理约束 = 鉴权天然边界），故「卡↔卡」一律
// 经宿主转译，且**不给卡片加 token**。
// 信封（`<ns>` = 卡片自定义命名空间，Pj18 = `floria-pv`；宿主从消息 type 前缀推导，不要求卡额外申报）：
//   宿主→卡  { type:'<ns>-cmd', cmd, ...参数平铺 }              ← 指令：只发给一张卡，恒有 ack
//   宿主→卡  { type:'<ns>-broadcast', ev, ...数据 }             ← 事实：发给所有匹配的在场卡，无 ack
//   卡→宿主  { type:'<ns>-event', ev, ...数据 }   ← ack 也走此处（ev:'ack'，用 cmd 配对）
//   卡↔卡    { type:'floria-card-call', callId, target, cmd, args } / { type:'floria-card-result', callId, ok, ... }
// 约定（同设想文档 §3）：① 每条命令恒回一条 ack；② 未注册命令回 ok:false 不静默；③ 命令无状态、幂等
// 优先，长动作卡内等完再 ack，宿主只做超时兜底；④ 命令里不塞身份（权限判断全在宿主）。
// 宿主保留动词（2026-10-13 整卡显隐 API 化）：`card:open` / `card:close` / `card:delete`（close 与 delete
// 同义 = 隐藏）是**总线保留前缀**，卡自定义命令不得申报（同 floria-card-call/-result 的保留段）。语义 =
// 整卡显隐（宿主槽位/路由层），与卡内组件级标准动词（卡实现的 close/delete/open、scroll{line}、locate——
// 走既有 <ns>-cmd 转发）正交。执行口 = setSlotHost 注入：中枢是**既有路由/槽位**（sidebar 驱动的现状源），
// API 只是又一条驱动同源的通道——无双真相；card:open 的对象（未显示的卡）不在帧表，按 label 走路由链。
// 本件是 engine 层契约：**永不 import views/feature/sidebar**——外部能力（WS 发送、打开源文件）一律走
// 回调注入（同 setTabRefresh / setExtCardRenderer 手法）。唯一顶层名 `cardBus`（单 IIFE 拼接，避免与
// 既有 20+ 模块顶层名撞车）。唯一手改处，web/app.js 为生成物。

import { state } from './state.js'
import { toast } from '../core/util.js'
/* @module engine/card-bus.js */

const cardBus = (function () {
  // ---------- 帧实例表 ----------
  // key = `<kind>:<label>:<id>`（preview 帧 id 为自增序，ext 卡 id 取 card.id）；反向查「来源窗口」用
  // 遍历 el.contentWindow（帧数 <10，比维护 Window 反向索引更不容易失效：iframe 换 src 后 WindowProxy
  // 身份不变，而 contentWindow 需惰性现读）。
  const frames = new Map()
  let seq = 0

  // 帧状态：ns/cmds 由卡片第一条 `<ns>-*` 消息与 ready 事件确定；busy+queue = 每帧串行队列
  // （串行是 ack 用 cmd 配对的必要前提：并发两条同 cmd 无法区分，串行天然规避）。
  function resetFrame(f) {
    f.ns = ''
    f.cmds = []
    f.ready = false
    f.latestState = null
    f.updatedAt = Date.now()
  }

  function registerFrame(rec) {
    if (!rec || !rec.el) return ''
    for (const [k, f] of frames) {
      if (f.el === rec.el) { resetFrame(f); scheduleCaps(); return k } // 软重入换 src：复用 key、清卡态
    }
    const kind = rec.kind || 'frame'
    const label = typeof rec.label === 'string' ? rec.label : ''
    // id = 卡自身的稳定标识（ext 卡取 card.id）；缺省取自增序。同 kind+label 已被占（同项目的槽预览与
    // work 栏并存）时加 `#seq` 后缀保唯一——否则整键覆盖会连带把先者的注销键也改指过去。
    const base = `${kind}:${label}:${rec.id ? String(rec.id) : String(++seq)}`
    const key = frames.has(base) ? `${base}#${++seq}` : base
    frames.set(key, {
      key, kind, label, el: rec.el, ns: '', cmds: [], ready: false, latestState: null,
      handlers: null, busy: false, queue: [], timer: null, updatedAt: Date.now(), active: true,
    })
    rec.el.__cardKey = key // 反向键：DOM 被拆的挂点（preview-frame 换 label）据此注销，不必另存表
    scheduleCaps()
    return key
  }

  function unregisterFrame(key) {
    const f = frames.get(key)
    if (!f) return
    if (f.timer) clearTimeout(f.timer)
    for (const job of f.queue.splice(0)) job.resolve({ ok: false, error: '卡片已离场' })
    frames.delete(key)
    scheduleCaps()
  }

  // 第一方 inline 卡（无 iframe）：直接挂表，命令走 handlers 直调
  function registerInlineCard(rec) {
    if (!rec || typeof rec !== 'object') return ''
    const key = rec.instanceId || `inline:${rec.label || ''}:${rec.ns || 'card'}`
    frames.set(key, {
      key, kind: 'inline', label: rec.label || '', el: null, ns: rec.ns || '',
      cmds: Array.isArray(rec.cmds) ? rec.cmds.map(String) : [], ready: true, latestState: null,
      handlers: rec.handlers && typeof rec.handlers === 'object' ? rec.handlers : {},
      busy: false, queue: [], timer: null, updatedAt: Date.now(), active: true,
    })
    scheduleCaps()
    return key
  }

  const frameBySource = (src) => {
    if (!src) return null
    for (const f of frames.values()) if (f.el && f.el.contentWindow === src) return f
    return null
  }

  const describe = (t) =>
    [t.label ? `项目=${t.label}` : '', t.ns ? `ns=${t.ns}` : '', t.instanceId ? `实例=${t.instanceId}` : '']
      .filter(Boolean).join(' ') || '(未指定)'

  // 在场 = 帧仍挂在文档里**且处于激活态**。iframe 卡随宿主卡片 DOM 被拆（换 label / 退卡）即失格——以元素
  // isConnected 为准，不要求每个拆除点都记得注销（漏注销只会留个不可达表项，不会让 agent 打到一个已死的帧上）。
  // active（2026-10-26 卡池）：work 右栏多卡并行时同时挂着多枚 iframe，只有当前显示的那枚可寻址——
  // 隐藏帧留在池里仅为「切回不重载」，不参与 resolveTarget/listCaps，否则同 label 多帧会判「目标卡不唯一」。
  const isLive = (f) => !!f.handlers || !!(f.el && f.el.isConnected && f.active !== false)
  const liveFrames = () => [...frames.values()].filter(isLive)
  // 广播面 = 所有仍挂着的帧（含隐藏帧）：「事实类」通知必须让后台卡保持同步（隐藏的 PDF 卡也要跟上
  // 用户新打开的文件），与「指令类」的可寻址面刻意分家。
  const attachedFrames = () => [...frames.values()].filter((f) => f.handlers || (f.el && f.el.isConnected))
  // 卡池切显隐的唯一写口：work 右栏换卡时对旧帧调 off、新帧调 on（registerFrame 缺省 active=true）。
  function setFrameActive(key, on) {
    const f = frames.get(key)
    if (!f || f.handlers) return
    const next = on !== false
    if (f.active === next) return
    f.active = next
    scheduleCaps()
  }

  // 寻址：instanceId 最精确；否则按 label 过滤。ns 只用于构造命令信封，不作筛选键（卡 ready 前宿主
  // 尚不知其 ns，用它筛选会让未就绪的卡不可达）。命中 0/多 → 报错，不猜不兜底。
  function resolveTarget(t) {
    const target = t && typeof t === 'object' ? t : {}
    let list = liveFrames()
    if (target.instanceId) list = list.filter((f) => f.key === target.instanceId)
    else if (target.label) list = list.filter((f) => f.label === target.label)
    if (!list.length) return { error: `目标卡不在场：${describe(target)}` }
    if (list.length > 1) {
      return { error: `目标卡不唯一：${describe(target)}`, candidates: list.map((f) => f.key) }
    }
    return { frame: list[0] }
  }

  // ---------- 宿主保留动词（card:*，整卡显隐，2026-10-13）----------
  // `card:open` / `card:close` / `card:delete`（同义）由总线自答、不发给卡：执行口 slotHost 由宿主侧
  // （feature/preview-frame.js）注入——open = 路由链 '#preview/<label>'（与用户点侧栏项目预览同链），
  // close = 回主页（renderHome 清槽）。card:open 的对象（未显示的卡）不在帧表、不可帧寻址，故按
  // args.label 寻址；card:close/delete 先按 target 验证该卡在场（不在场显式报错，绝不静默退别的卡），
  // inline 卡无宿主槽位显式报错。slotHost 未注入 = 显隐中枢未接，报错不静默。
  let slotHost = null
  function setSlotHost(o) {
    slotHost = o && typeof o.open === 'function' && typeof o.close === 'function' ? o : null
  }
  function callSlotVerb(t, cmd, args) {
    if (!slotHost) return Promise.resolve({ ok: false, error: '宿主未接入显隐中枢（setSlotHost 未注入）' })
    if (cmd === 'card:open') {
      const label = args && typeof args.label === 'string' ? args.label.trim() : ''
      if (!label) return Promise.resolve({ ok: false, error: 'card:open 需要 args.label（项目 label）' })
      return Promise.resolve()
        .then(() => slotHost.open(label))
        .then(
          () => ({ ok: true, result: { card: 'preview', label } }),
          (e) => ({ ok: false, error: String((e && e.message) || e) }),
        )
    }
    const r = resolveTarget(t)
    if (r.error) return Promise.resolve({ ok: false, error: r.error })
    if (r.frame.handlers) return Promise.resolve({ ok: false, error: 'inline 卡无宿主槽位，不支持 card:close/card:delete' })
    return Promise.resolve()
      .then(() => slotHost.close())
      .then(
        () => ({ ok: true, result: { hidden: true } }),
        (e) => ({ ok: false, error: String((e && e.message) || e) }),
      )
  }

  // ---------- 命令通道（卡↔宿主）----------
  // 恒 resolve 一个 ack 对象（**不 reject**：与 gatewayClient 的 sendSessionMessage 同口径，调用方按
  // ok 判成败）；超时由宿主兜底，长动作由卡自己等完再 ack。
  function callCard(target, cmd, args, opts) {
    // 宿主保留动词（整卡显隐）先行分流：总线自答，不发给卡
    if (cmd === 'card:open' || cmd === 'card:close' || cmd === 'card:delete') return callSlotVerb(target, cmd, args)
    const r = resolveTarget(target)
    if (r.error) return Promise.resolve({ ok: false, error: r.error })
    const f = r.frame
    if (f.handlers) return callInline(f, cmd, args)
    if (!f.ns) return Promise.resolve({ ok: false, error: `卡片未就绪（未收到 ready）：${f.key}` })
    const timeoutMs = opts && Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 8000
    return new Promise((resolve) => {
      f.queue.push({ cmd, args: args || {}, resolve, timeoutMs })
      pumpFrame(f)
    })
  }

  function callInline(f, cmd, args) {
    const h = f.handlers[cmd]
    if (typeof h !== 'function') return Promise.resolve({ ok: false, error: `未注册的命令 ${cmd}` })
    try {
      return Promise.resolve(h(args)).then(
        (result) => ({ ok: true, result }),
        (err) => ({ ok: false, error: String((err && err.message) || err) }),
      )
    } catch (err) {
      return Promise.resolve({ ok: false, error: String((err && err.message) || err) })
    }
  }

  function pumpFrame(f) {
    if (f.busy || !f.queue.length) return
    const job = f.queue[0]
    if (!f.el || !f.el.contentWindow) { finishFrame(f, { ok: false, error: '卡片帧已销毁' }); return }
    f.busy = true
    f.timer = setTimeout(() => finishFrame(f, { ok: false, error: `命令超时（${job.timeoutMs}ms）：${cmdLabel(f, job.cmd)}` }), job.timeoutMs)
    try {
      f.el.contentWindow.postMessage({ type: `${f.ns}-cmd`, cmd: job.cmd, ...job.args }, '*')
    } catch {
      finishFrame(f, { ok: false, error: '卡片帧已销毁' })
    }
  }

  const cmdLabel = (f, cmd) => `${f.ns}/${cmd}`

  // 当前在途命令出队（成功/失败/超时都走此处），驱动队列下一拍
  function finishFrame(f, ack) {
    if (!f.busy) return
    if (f.timer) { clearTimeout(f.timer); f.timer = null }
    f.busy = false
    const job = f.queue.shift()
    if (job) job.resolve(ack)
    pumpFrame(f)
  }

  // ---------- 事件订阅（供 feature 层消费卡片上报）----------
  const eventSubs = []
  function addCardEventListener(fn) { if (typeof fn === 'function') eventSubs.push(fn) }
  function emitEvent(ev, data, frame) {
    for (const fn of eventSubs) { try { fn(ev, data, frame) } catch { /* 订阅方异常不打断总线 */ } }
  }

  // ---------- 卡↔卡 broker ----------
  // 别的卡要驱动目标卡，只能对 parent 说 floria-card-call（它拿不到对方的 contentWindow）；
  // 宿主查表转译，ack 原路带回。目标不在场**显式报错、绝不打开/启动它**（避免 agent/卡把用户界面弹来弹去）。
  function routeCardCall(srcFrame, d) {
    const callId = d.callId
    const reply = (payload) => {
      if (!srcFrame.el || !srcFrame.el.contentWindow) return
      try { srcFrame.el.contentWindow.postMessage({ type: 'floria-card-result', callId, ...payload }, '*') } catch { /* 帧已销毁：回执无声丢弃 */ }
    }
    const target = d.target || {}
    const r = resolveTarget(target)
    if (r.error) { reply({ ok: false, error: r.error, candidates: r.candidates }); return }
    if (r.frame.key === srcFrame.key) { reply({ ok: false, error: '卡片不能调用自身' }); return }
    callCard(target, d.cmd, d.args).then((ack) => reply(ack))
  }

  // ---------- 标准事件：src-open（卡内点击 → 宿主打开源文件并滚到行）----------
  // path 口径 = 项目根相对 POSIX（与 /gateway/file?label=&path= 同口径）。门禁：只认「当前工作项目」
  // 的帧——否则一个预览页能把编辑器切到别的项目文件去（跨项目越权）。
  // 「开 + 定位」只给宿主**一个**口 open(path, line)：载入是异步的（读文件 → 灌编辑器），何时能定位是
  // 宿主自己的时序，总线不揣测（旧写法 open() 完就滚，会滚在尚未换掉的上一份文档上）。
  let sourceOpener = null
  let sourceMarker = null
  function handleSrcOpen(f, d) {
    if (!sourceOpener) return
    const path = typeof d.path === 'string' ? d.path : ''
    if (!path) return
    if (state.sbMode !== 'work' || !state.workProj || f.label !== state.workProj) {
      toast('该卡片不属于当前工作项目，已忽略跳转请求')
      return
    }
    const n = Number(d.line)
    Promise.resolve(sourceOpener.open(path, Number.isFinite(n) && n > 0 ? n : 0))
      .catch(() => { /* 文件打不开：静默（编辑器自会提示） */ })
  }

  // 上报色值的安全白名单：hex(#rgb/#rgba/#rrggbb/#rrggbbaa) / 具名色 / rgb|rgba|hsl|hsla(数值)。
  // color 会进 line 元素的 CSS 变量，必须在边界挡掉 ; / url( / 表达式等注入面。
  const SRC_MARK_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s]+\))$/
  // 标准事件：src-mark（编译日志卡上报报错行 → 宿主在编辑区标红）。门禁与 src-open 同口径
  // （只在 work 模式、只认当前工作项目的帧）；与 src-open 不同，越界/无效一律**静默忽略**——
  // 报错标记是辅助信息，不应因别的项目日志卡打扰当前用户。
  function handleSrcMark(f, d) {
    if (!sourceMarker) return
    const path = typeof d.path === 'string' ? d.path : ''
    if (!path) return
    if (state.sbMode !== 'work' || !state.workProj || f.label !== state.workProj) return
    // 归一化：只保留 l0/l1 均为有限数字且 l0<=l1 的条目（1 基行号）；去重/上限 50 由上报侧保证。
    // 每条可带 color（自定义标记色）与 msg（悬停文案）：color 非法/缺省 = 空串 ⇒ 渲染侧回落默认红。
    const marks = (Array.isArray(d.marks) ? d.marks : [])
      .filter((m) => m && typeof m === 'object')
      .map((m) => ({
        l0: Number(m.l0),
        l1: Number(m.l1),
        msg: typeof m.msg === 'string' ? m.msg : '',
        color: typeof m.color === 'string' && SRC_MARK_COLOR_RE.test(m.color.trim()) ? m.color.trim() : '',
      }))
      .filter((m) => Number.isFinite(m.l0) && Number.isFinite(m.l1) && m.l0 <= m.l1)
    Promise.resolve(sourceMarker.mark(path, marks)).catch(() => { /* 标红失败：静默 */ })
  }

  // ---------- 宿主→卡 广播（一事实、多收听者）----------
  // 与命令的区别：广播是**事实**（如「用户打开了某文件」），无配对 ack、不指定单一收件人；命令是**指令**、
  // 只发给一张卡且恒有 ack。发送前仍按目标（label/ns/instanceId）筛一遍在场帧，避免跨项目串台。
  // 帧的 ns 由卡自己在 `ready` 里申报，发送时逐帧翻译成 `<ns>-broadcast`——**调用方不必知道卡的命名空间**
  // （与 callCard 拼 `<ns>-cmd` 同一手法）。迟到入场的帧由 ready 时补发（见 onCardEvent），故宿主侧
  // 「先开文件、后挂帧」不丢事实。
  const lastNotes = new Map() // ev → { target, data }
  function broadcast(target, ev, data) {
    const t = target && typeof target === 'object' ? target : {}
    const payload = data && typeof data === 'object' ? data : {}
    lastNotes.set(String(ev), { target: t, data: payload })
    for (const f of attachedFrames()) sendNote(f, t, ev, payload)
  }
  function matchesTarget(f, t) {
    if (t.instanceId && f.key !== t.instanceId) return false
    if (t.ns && f.ns !== t.ns) return false
    if (t.label && f.label !== t.label) return false
    return true
  }
  // 只发 iframe 帧：inline 卡没有 window，广播无落点（需要时另开 handlers 口，勿在此伪造）
  function sendNote(f, t, ev, data) {
    if (!f.el || !f.el.contentWindow || !f.ns || !matchesTarget(f, t)) return
    try { f.el.contentWindow.postMessage({ type: `${f.ns}-broadcast`, ev, ...data }, '*') } catch { /* 帧已销毁：丢弃 */ }
  }
  function replayNotes(f) {
    for (const [ev, rec] of lastNotes) sendNote(f, rec.target, ev, rec.data)
  }

  // ---------- 单一 message 分发 ----------
  // 与既有 5 条 addEventListener('message')（rail-ext / quote / work-mount / msg-actions / ctx-meter）
  // **并存**：那些 handler 对未知 d.type 早退，互不干扰。本件只认卡片 API 信封（<ns>-cmd 的回执、
  // <ns>-event、floria-card-call），双门禁：来源窗口必须命中已注册帧，否则一律丢弃。
  function onMessage(e) {
    const d = e.data
    if (!d || typeof d !== 'object' || typeof d.type !== 'string') return
    if (d.type === 'floria-card-call') {
      const src = frameBySource(e.source)
      if (src) routeCardCall(src, d)
      return
    }
    if (d.type.slice(-6) !== '-event') return
    const f = frameBySource(e.source)
    if (!f) return // 非已注册帧的来源（含别的窗口伪报）不采纳
    const ns = d.type.slice(0, -6)
    if (ns && f.ns !== ns) { f.ns = ns; f.updatedAt = Date.now() }
    onCardEvent(f, d)
  }

  function onCardEvent(f, d) {
    const ev = d.ev
    if (ev === 'ack') {
      // 串行队列下，在途命令恒为 queue[0]；cmd 不符者不配对（防卡异步乱序回执串台）
      if (f.busy && f.queue[0] && (d.cmd === undefined || d.cmd === f.queue[0].cmd)) {
        finishFrame(f, d.ok === false ? { ok: false, error: d.error || '命令失败' } : { ok: true, result: d.result })
      }
      return
    }
    if (ev === 'ready') {
      f.ready = true
      if (typeof d.ns === 'string' && d.ns) f.ns = d.ns
      if (Array.isArray(d.cmds)) f.cmds = d.cmds.map(String)
      f.updatedAt = Date.now()
      scheduleCaps()
      emitEvent('ready', d, f)
      // 迟到入场的帧补发最近广播（ns 此刻才确定）：「用户先开了文件、预览帧后挂」不丢事实
      replayNotes(f)
      return
    }
    if (ev === 'state') { f.latestState = d; f.updatedAt = Date.now() }
    if (ev === 'src-open') { handleSrcOpen(f, d); return }
    if (ev === 'src-mark') { handleSrcMark(f, d); return }
    emitEvent(ev, d, f)
  }

  // ---------- 能力表 + 上报（agent 侧据此路由）----------
  const listCaps = () =>
    liveFrames().map((f) => ({
      label: f.label, instanceId: f.key, kind: f.kind, ns: f.ns, cmds: f.cmds, ready: f.ready,
    }))

  let gatewaySender = null
  let capsTimer = null
  function scheduleCaps() {
    if (capsTimer) return
    capsTimer = setTimeout(() => { capsTimer = null; reportCaps() }, 50)
  }
  function reportCaps() {
    if (!gatewaySender) return
    try { gatewaySender({ type: 'card-caps', caps: listCaps() }) } catch { /* 未连接：下次表变或 onopen 再报 */ }
  }
  // WS 发送端口由 engine/gateway.js 注入（避免 engine 内成环），注入即补报一次
  function setGatewaySender(fn) {
    gatewaySender = typeof fn === 'function' ? fn : null
    if (gatewaySender) reportCaps()
  }
  function setSourceOpener(o) {
    sourceOpener = o && typeof o.open === 'function' ? o : null
  }
  function setSourceMarker(o) {
    sourceMarker = o && typeof o.mark === 'function' ? o : null
  }

  // ---------- agent 指令入口（gateway.js 的 gws.onmessage 调）----------
  // agent 经网关 POST /gateway/card-call → WS 下行 {type:'card-call'} → 此处 → 目标卡 → ack → WS 上行
  // {type:'card-result'} 回网关 resolve。卡片侧对此全程无感（零改动）。
  function handleGatewayCall(msg) {
    const callId = msg && msg.callId
    callCard(msg && msg.target, msg && msg.cmd, msg && msg.args, { timeoutMs: msg && msg.timeoutMs }).then((ack) => {
      if (!gatewaySender) return
      try {
        gatewaySender({ type: 'card-result', callId, ok: ack.ok !== false, result: ack.result, error: ack.error })
      } catch { /* 连接已断：网关侧按超时收口 */ }
    })
  }

  addEventListener('message', onMessage)

  return {
    addCardEventListener,
    broadcast,
    callCard,
    frames: liveFrames,
    handleGatewayCall,
    listCaps,
    registerFrame,
    registerInlineCard,
    reportCaps,
    setFrameActive,
    setGatewaySender,
    setSlotHost,
    setSourceOpener,
    setSourceMarker,
    unregisterFrame,
  }
})()

export {
  cardBus,
}
