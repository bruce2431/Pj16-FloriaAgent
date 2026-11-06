// 实时同步（SSE 监听 jsonl 变化）（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { hideGate } from './auth.js'
import { setChar } from '../core/char.js'
import { needToken, apiUrl, setConn, forceWsReconnect } from './gateway.js'
import { hashOf, findSession, listSigOf, applyTurnEndAt, fetchMessages, withSynthetic } from './sessions.js'
import { messagesEl, inputEl, bodyEl, state, ALL, live, connUp } from './state.js'
import { toast } from '../core/util.js'
/* @module engine/live.js */

  // 依赖反转（分层治理 4B，2026-10-10）：engine 不静态 import feature。「CLI 上报模型 → 校准模型 seat」
  // 是输入栏行为（inputbar/model-select.js 的 applySessionModel），改由 app 启动序列经此钩子注入；
  // 未注入时为空操作（initLive 之前必已注入，见 app.js 依赖接线段）。两处调用＝SSE model 事件与
  // 会话全量刷新（refreshSession）。
  let onSessionModel = () => {}
  // 2026-11-06 每会话思考等级（C）：与模型同一条注入钩子——实时刷新回程把该会话上报的档位
  // 交给 feature 层（model-select.js 的 applySessionEffort），座显只看本会话，不串档。
  let onSessionEffort = () => {}

  // 依赖反转（分层治理 4C，2026-10-10）：engine/live.js 不再静态 import chat/inputbar/sidebar——
  // 渲染出口、暂态/stage、可变状态一律经 app 启动序列注入的端口对象访问。端口内的 getter
  // （getLastSegInfo/getCharNote/getPendingUserMsgs/getTakeover/getFirstSendHash）每次调用现读 feature
  // 模块的可变绑定，调用侧严禁缓存返回值（缓存即与 owner 的实时状态脱钩）；写侧只在需要时调端口回调。
  // 端口注入先于 initLive（app.js 依赖接线段），故此处空对象占位即可，无需兜底分支。
  let liveMsgPort = {}   // chat/messages.js 的读基元 + 可变渲染态读取口（isRealUser/fmtDur/messagesHtml/…）
  let liveUiPort = {}    // 渲染/暂态/导航出口（renderTransient/renderSettle/renderRecent/renderTaskDock/…）
  let liveStagePort = {} // 两层消息流 stage（stage 对象 + stageStart）
  let liveStatePort = {} // 可变状态读写口（takeover/firstSendHash/pendingUserMsgs）

  // ---------- 实时同步（阶段1：SSE 监听 jsonl 变化，自动刷新会话/列表）----------
  // 兼容：刷新只替换 messagesEl 内层，折叠开合（含网关实时折叠）与滚动位置尽量保留；
  // 只读视图下最后一段「处理中（尚无回复）」的已处理折叠默认展开，回复落地后自动收起。

  // 前端资产版本自愈（2026-09-17）：守护不变量 = 运行中的前端代码 = 网关当前资产版本。
  // 换 exe/新构建后旧标签页只重连 WS/SSE、不重载 JS（代码还是页面加载时那份），修复永远
  // 送达不了常开标签页（三轮「修复没生效」实报的交付根因）。hello（每次 SSE 建连/重连都发）
  // 时拉服务器 sw.js 的 CACHE 版本与页面加载时基线比对：漂移即自动刷新（输入栏有内容则只
  // 提示不强刷，不毁用户正在输入的内容）。重载后新基线同版本 → 无回环。
  let bootSwVer = null
  async function checkAssetFresh() {
    try {
      const res = await fetch('/sw.js', { cache: 'no-store' })
      const m = /CACHE\s*=\s*'([^']+)'/.exec(await res.text())
      if (!m) return
      if (bootSwVer == null) { bootSwVer = m[1]; return }
      if (m[1] === bootSwVer) return
      bootSwVer = m[1]
      if (serializeInput().trim()) { toast('前端有新版本，请手动刷新页面'); return }
      toast('前端已更新，正在刷新…')
      setTimeout(() => location.reload(), 800)
    } catch { /* 离线等瞬时失败忽略，下次 hello 再对 */ }
  }

  // ——SSE 连接监督者（2026-10-14 GPT 定案第一阶段①②④）——
  // 不变量：下行 SSE 的生命周期由监督者统一编排，与 WS 心跳链联动——WS open → 强制重建 SSE
  //（重建后 hello → refreshSession 全量对账，重建瞬间丢的 delta 由快照覆盖）；WS close →
  // 关 SSE 一并等 WS 重连。SSE 自身活性由双侧检测：服务端 15s 命名 heartbeat（localGateway
  // startSseHeartbeat），客户端 watchdog 45s 无任何数据 → 重建 SSE（容忍丢 2 次心跳）；连续
  // 3 次重建失败判「网关不可达」→ 触发 WS 重连链（onclose → 4s → onopen → noteWsOpen 重建 SSE）。
  // generation（esGen）防旧连接晚到事件污染新状态：每次重建/关闭 +1，旧代回调整帧丢弃。
  let esGen = 0
  let lastSseDataAt = 0 // 任何下行数据（含 heartbeat）到达时刻 = watchdog 基点（不分会话/类型，监督者只管链路活性）
  let sseFailStreak = 0
  let watchdogTimer = null
  const SSE_WATCHDOG_MS = 45_000 // 45s 无任何数据（15s 心跳 ×3 窗口）
  const SSE_RECONNECT_DELAY_MS = 3000

  function closeEs() {
    if (live.es) { try { live.es.close() } catch { /* 已断忽略 */ } live.es = null }
  }

  function rebuildEs() {
    if (!('EventSource' in window)) return
    if (needToken()) return // token 门锁定态：不建 SSE（避免 401 重连刷屏，hideGate 解锁后再建）
    closeEs()
    esGen++
    const gen = esGen
    lastSseDataAt = Date.now()
    const es = new EventSource(apiUrl('/gateway/events'))
    live.es = es
    es.onmessage = (e) => {
      if (gen !== esGen) return // 旧代连接的晚到事件：整帧丢弃
      sseFailStreak = 0
      lastSseDataAt = Date.now()
      handleSseMessage(e)
    }
    // heartbeat 是命名事件（event: heartbeat），EventSource 走 addEventListener，不进 onmessage
    es.addEventListener('heartbeat', () => {
      if (gen !== esGen) return
      sseFailStreak = 0
      lastSseDataAt = Date.now()
    })
    es.onerror = () => {
      if (gen !== esGen) return
      closeEs()
      sseFailStreak++
      if (sseFailStreak >= 3) { sseFailStreak = 0; forceWsReconnect() }
      setTimeout(() => { if (gen === esGen) rebuildEs() }, SSE_RECONNECT_DELAY_MS)
    }
  }

  // watchdog（GPT 定案④）：查「长时间没收到任何数据」——TCP 半开（无 FIN/RST）时 onerror 不
  // 触发，唯一客户端侧观测手段是数据断流。与服务端 heartbeat 的写入错误/背压检测不可互替。
  function startSseWatchdog() {
    if (watchdogTimer) return
    watchdogTimer = setInterval(() => {
      if (!live.es) return // 重建窗/已移交 WS 重连链，不重复计数
      if (Date.now() - lastSseDataAt <= SSE_WATCHDOG_MS) return
      lastSseDataAt = Date.now()
      sseFailStreak++
      if (sseFailStreak >= 3) { sseFailStreak = 0; forceWsReconnect(); return }
      rebuildEs()
    }, 5000)
    watchdogTimer.unref?.()
  }

  // 监督者联动口（gateway.js WS onopen/onclose 调用）
  function noteWsOpen() { sseFailStreak = 0; rebuildEs() } // WS 重连成功 = SSE 复活信号：强制换新连接（hello 全量对账）
  function noteWsClosed() { closeEs(); esGen++ } // WS 断开：SSE 一并关，待 WS 重链后统一重建

  // 启动入口（app.js 启动序列 + hideGate 解锁后调用）。已在监督态（live.es 在场 = watchdog 已启）不重复；
  // 否则建连 + 启 watchdog。此后 SSE 重建/联动一律走监督者（noteWsOpen/noteWsClosed/rebuildEs）。
  function initLive() {
    if (!('EventSource' in window)) return
    if (live.es) return // 防重建（hideGate 每次 WS 重连都会跑）：重复 new 泄漏旧 SSE 连接+事件双发
    rebuildEs()
    startSseWatchdog()
  }

  function handleSseMessage(e) {
    let ev
    try { ev = JSON.parse(e.data) } catch { return }
    if (ev.type === 'hello') { refreshList(); refreshSession(); checkAssetFresh() }
    else if (ev.type === 'activity') {
        // 状态点翻转即时刷新（网关 /gateway/activity 群发，2026-08-29）。
        // 2026-09-07 断连感知：state=null（CLI /clients 断开 → 网关 detach 群发）= 会话进程
        // 断开 → 该会话状态点立即熄（不等 600ms 防抖重拉），当前打开的会话立即收口运行态
        //（「正在思考/正在处理」停表），不再冻结在断流前的最后快照上假绿假转。
        if (ev.state == null && typeof ev.session === 'string') {
          const s = ALL.find((x) => hashOf(x) === ev.session)
          if (s && s.state) { s.state = null; liveUiPort.renderRecent() }
          if (ev.session === live.curUuid) refreshSession(true)
        }
        // 2026-09-07 状态恢复对称刷新：state 由真空恢复（CLI 重连重报/60s 心跳补报——网关重启
        // 清 sessionActivity 后的空窗）时，当前会话视图同样立即重渲。否则真空窗里的误收口
        // （state=null 被 closeSeg 判「进程不在线」→ 活回合冻结成「已处理」停表）要等下一次
        // jsonl 落盘才翻回，glm 长思考期可达十几分钟（Pj5 会话重启实证）。不变量：当前会话
        // 视图状态显示收敛到网关最新 state，null↔非 null 两向同治。
        else if (typeof ev.session === 'string' && ev.session === live.curUuid) refreshSession()
        refreshList()
      }
      else if (ev.type === 'session-down') {
        // 2026-09-07 进程退出显式告知：detach 且 pid 已死（非重连窗）→ 网关群发。收口运行态
        // + toast 指路（转录在磁盘，列表点开即 resume 重开，积压消息自动补投）。
        if (typeof ev.session === 'string') {
          const s = ALL.find((x) => hashOf(x) === ev.session)
          if (s && s.state) { s.state = null; liveUiPort.renderRecent() }
          if (ev.session === live.curUuid) refreshSession(true)
          toast('会话进程已退出，可从列表点开重开（转录已保留）')
        }
      }
      else if (ev.type === 'session-up') {
        // 2026-09-07 会话进程回归（/clients 注册成功）：刷新列表与当前会话；状态点恢复由
        // CLI 注册后的 activity 上报/60s 心跳随后到达，网关不代答状态。
        refreshList()
        if (ev.session === live.curUuid) refreshSession()
      }
      else if (ev.type === 'turn-beat') {
        // 2026-09-07 僵死感知：引擎增量心跳（CLI setResponseLength → gatewayClient 4s 节流）
        // → 记 per-session 最后活性时刻。bindLiveFoldTimer tick 对账：运行态持续而 beat 缺席
        // 或落后超阈值 = 引擎无真实进展（进程/WS 活但 query 链僵死）→ 计时行标「无响应」。
        if (typeof ev.session === 'string') live.turnBeat.set(ev.session, Date.now())
      }
      else if (ev.type === 'queue-state') {
        // 2026-08-30 队列快照增量（清单#2/#4）：CLI commandQueue 变化 → 网关 SSE 群发（事件体
        // 直接带 items 全量快照）→ 当前会话置底排队区即时重渲，不等 400ms 防抖的 refreshSession。
        if (live.curUuid && ev.session === live.curUuid) {
          live.queueRemote = Array.isArray(ev.items) ? ev.items : []
          liveMsgPort.queueClaimAdopt(live.queueRemote) // 队首主张收编（同回程入口：CLI 端/另一端入队的瞬态同样立即主张化）
          liveUiPort.renderTransient() // 暂态区对账重渲（2026-09-07 收编：远端快照更新与气泡/主张折叠同趟对账）
        }
      }
      else if (ev.type === 'task-state') {
        // 2026-09-10 任务浮窗链：CLI TodoV2 清单快照（useTasksV2 单源出口）→ 网关 SSE 群发
        //（事件体直接带 tasks 全量快照）→ 底栏任务浮窗即时重渲，不等 gss 防抖的 refreshSession。
        // 空数组 = 清单清空/隐藏 → 浮窗整体不出现（与 CLI「tasks.length===0 → null」同一判定）。
        if (live.curUuid && ev.session === live.curUuid) {
          live.tasks = Array.isArray(ev.tasks) ? ev.tasks : []
          liveUiPort.renderTaskDock()
        }
      }
      else if (ev.type === 'model') {
        // 2026-09-19 模型实时校准（用户「CLI 切了模型、web 底栏不动」）：CLI 每会话实际模型变化 →
        // 网关 /gateway/model-report 落值后 SSE 群发（事件体带 model + modelTs）。此前 web 只能等
        // 下一次 /gateway/session 拉取才校准，会话空闲时长时间不来 → 底栏停在旧模型。
        // 仅当前会话采纳（其它会话的模型变化与本会话底栏无关），冲突判定见 applySessionModel。
        if (live.curUuid && ev.session === live.curUuid) onSessionModel(ev.model, ev.modelTs)
      }
      else if (ev.type === 'session-delta') {
        // 2026-09-08 事件流统一 P1（方案 20260908135557）：引擎变化 delta 直达——CLI 过滤投影
        //（filterConversationForDisplay 权威单源）的「锚点 + 其后整体替换」增量（anchorSid =
        // 分歧点前一条的稳定键，messages = 分歧点起的尾部；append/末条 blocks 更新/段收口统一
        // 此编码，幂等）。
        // 2026-09-10 协议根修：CLI 侧输入是 capRenderedMessages 的 200 条尾部窗口、本地是全量
        // 投影，两侧长度与 normalizeMessages 派生的 uuid 规则都不同——旧「数字坐标 base +
        // 长度拼接」在长会话下恒被判「历史截断」拒收 → 全量对账风暴 → 回合中零更新（Bash/Edit
        // 零提示实证）。改以内容标识 sid 定位锚点，长度差异不再参与判定。
        // seq 每会话单调：连续 → 应用进本地基线走 renderSessionBody（与全量对账同一渲染出口，
        // absorbPending/renderTransient/钉顶/计时不变量同源）；重复忽略；gap/无基线/无锚点 →
        // refreshSession(true) 全量对账重建基线（分布式流缺失恢复标准形态，对账源 = /gateway/
        // session，display 链 P1 存活）。本回调同步执行无 await，无切会话写穿窗口。
        if (ev.session !== live.curUuid) return
        if (typeof ev.seq !== 'number' || !Number.isInteger(ev.seq) || ev.seq <= 0) return
        if (live.deltaSeq == null) { refreshSession(true); return }
        if (ev.seq <= live.deltaSeq) return
        if (ev.seq !== live.deltaSeq + 1) { refreshSession(true); return }
        if (!Array.isArray(ev.messages) || !ev.messages.length) return
        const cur = Array.isArray(live.localMessages) ? live.localMessages : null
        const anchor = typeof ev.anchorSid === 'string' ? ev.anchorSid : ''
        if (!cur || !anchor) { refreshSession(true); return }
        const idx = cur.findIndex((m) => m && m.sid === anchor)
        // 塌缩防护（不变量）：CLI 恒发 ≤200 条尾部窗口，锚点 = 分歧点前一条 → 锚点之后的本地
        // 条目必然落在投影窗口量级内。超出 512（窗口 200 的保守余量，含跨轮多次 delta 前移）
        // = CLI state 塌缩/失步瞬态（压缩边界/reactive compact），此时应用会截断已提交历史
        //（2026-09-09 录屏实证：web 数组被切到仅剩一条用户消息）→ 走对账链，不应用。
        if (idx === -1 || cur.length - idx - 1 > 512) { refreshSession(true); return }
        live.localMessages = cur.slice(0, idx + 1).concat(ev.messages)
        live.deltaSeq = ev.seq
        renderSessionBody(live.localMessages, { force: false, hash: state.currentHash })
      }
      else if (ev.type === 'compact-state') {
        // 2026-09-04 压缩实时态（queue-state 同款链）：CLI onCompactProgress → 网关 SSE 群发。
        // 压缩进行中 jsonl 零写入 → SSE 'updated' 不来，本事件是「正在压缩」唯一实时源。
        // Map 按会话 uuid 存到达时刻（render 侧 5min TTL 防 compact_end 丢失后卡死），结束即删。
        if (typeof ev.session === 'string') {
          if (ev.active) live.compactFlags.set(ev.session, Date.now())
          else live.compactFlags.delete(ev.session)
          if (ev.session === live.curUuid) refreshSession()
        }
      }
      else if (ev.type === 'turn-state') {
        // 2026-09-06 打断收口链：CLI onCancel → 网关 SSE（compact-state 同款链）。打断后 jsonl
        // 零写入 → SSE 'updated' 不来，本事件是「回合被中止」唯一实时源——记 per-session 时刻
        // （closeSeg 以「段末落盘 ts < 该时刻」判 finished 收口「已处理」），jsonl 永无该回合回复
        // → 无 TTL（防重建后运行态复活）。jsonl 无变化 sig 不变 → refreshSession(true) 强制重渲。
        if (typeof ev.session === 'string' && ev.live === false) {
          live.turnEndFlags.set(ev.session, Date.now())
          if (ev.session === live.curUuid) {
            live.streamText = '' // 2026-09-08 流式字符通道：回合中止 = 暂态收口（CLI 已 streamClear 同发，双端确定性）
            refreshSession(true)
          }
        }
      }
      else if (ev.type === 'stream-text') {
        // 2026-09-08 流式字符通道：CLI 引擎流式 delta（thinking/text，onUpdateLength 单路累积
        // 100ms 合帧全文快照）→ 运行态状态显示行（.think-state）后/乐观主张折叠体内流式预览。
        // 纯显示暂态：不进 localMessages 权威基线、不落盘；空串 = 块边界/消息落盘清除（权威
        // delta 随后接管）。applyStreamPreview 直写 textContent，不走整页重建；重渲洗 DOM 后由
        // renderSessionBody 出口重挂恢复。
        if (ev.session === live.curUuid) {
          live.streamText = typeof ev.text === 'string' ? ev.text : ''
          applyStreamPreview()
        }
      }
      else if (ev.type === 'restored') {
        // 2026-09-06 撤回链：CLI auto-restore（web 打断且无 meaningful 响应）→ 文本回填本端输入栏
        // + 对话流摘该条开启气泡（jsonl 不删，渲染按 flag 永久跳过该 user——无 TTL 防气泡复活）。
        // 打断时输入栏必空（停止键只在输入栏空时显示，v213 定案），有内容时不覆盖（同 CLI 守卫语义）。
        // 撤回动画（同日二轮，用户反馈瞬间消失生硬）：气泡先塌缩淡出再重渲——定位 = body 文本
        // 匹配 restored 文本的最后一个 user 气泡（打断撤回时队列必空 = 流尾气泡）；找不到直接重渲。
        if (typeof ev.session === 'string' && typeof ev.text === 'string') {
          live.restoredFlags.set(ev.session, { ts: Date.now(), text: ev.text })
          if (ev.session === live.curUuid) {
            // 撤回 = 该条乐观主张一并作废（jsonl 永无该 user，absorbPending 永不命中）——
            // 不同步丢弃 pending 项，renderTransient 会让主张气泡/折叠复活（幻影回流）。
            const t0 = ev.text.trim()
            const pend0 = liveStatePort.getPendingUserMsgs()
            const n0 = pend0.length
            liveStatePort.setPendingUserMsgs(pend0.filter((p) => {
              const inCur = p.hash === state.currentHash || (p.hash === '' && liveStatePort.getFirstSendHash() === state.currentHash)
              if (!inCur) return true
              return String(p.text || '').replace(/\s*\[Image #\d+\]/g, '').trim() !== t0
            }))
            if (liveStatePort.getPendingUserMsgs().length !== n0) liveUiPort.renderTransient()
            if (!serializeInput().trim()) {
              composerSetText(ev.text)
              liveUiPort.syncGwSend()
              composerFocus()
            }
            const t = ev.text.trim()
            const bubbles = [...messagesEl.querySelectorAll('.msg.user[data-t="u"]')].filter(el => (el.querySelector('.body')?.textContent || '').trim() === t)
            const el = bubbles[bubbles.length - 1]
            if (el && !el.classList.contains('msg-out')) {
              el.style.maxHeight = el.scrollHeight + 'px'
              void el.offsetHeight // 强制 reflow：让 max-height 初值生效后再过渡到 0
              el.classList.add('msg-out')
              setTimeout(() => { el.remove(); refreshSession(true) }, 360)
            } else {
              refreshSession(true)
            }
          }
        }
      }
      else if (ev.type === 'ws-failed') {
        // 2026-09-06 wsession 异步化失败链：后台 spawn/注册失败（含 20s 注册超时）→ 网关 SSE 群发。
        // 收尾不留静默：清首条事务 + 移除合成列表条目 + toast 报错；当前正看该会话 → 回首页。
        if (typeof ev.session === 'string') {
          if (liveStatePort.getFirstSendHash() === ev.session) liveStatePort.setFirstSendHash('')
          setAll(ALL.filter((s) => hashOf(s) !== ev.session))
          liveUiPort.renderRecent()
          toast('web 会话启动失败：' + (ev.error || '未知错误'))
          if (state.currentHash === ev.session) liveUiPort.navigate('#/')
        }
      }
      else if (ev.type === 'updated') {
        if (ev.hash === state.currentHash) refreshSession()
        refreshList()
      }
  }

  function refreshList() {
    if (live.listT) return
    live.listT = setTimeout(async () => {
      live.listT = null
      if (needToken()) return // token 门锁定态
      try {
        const res = await fetch(apiUrl('/gateway/sessions'))
        const data = await res.json()
        if (!Array.isArray(data.sessions)) return
        applyTurnEndAt(data.sessions) // sig 短路前恢复：turnEndAt 新增不改 listSig，不能被短路跳过
        const sig = listSigOf(data.sessions)
        if (sig === live.listSig) return
        live.listSig = sig
        // 保留展开中的项目文件夹
        const openF = [...bodyEl.querySelectorAll('.folder.open')].map((f) => f.dataset.f)
        setAll(withSynthetic(data.sessions))
        applyTurnEndAt(ALL)
        liveUiPort.renderRecent()
        if (openF.length) {
          for (const f of bodyEl.querySelectorAll('.folder')) {
            if (openF.includes(f.dataset.f)) f.classList.add('open')
          }
        }
      } catch { /* 瞬时错误忽略 */ }
    }, 600)
  }

  // 2026-08-24 回合进行中探测（refreshSession 处理折叠抑制窗用）：末段是否仍处理中。
  // 复刻 messagesHtml closeSeg 的 finished 判定——末条 assistant 纯文本回复（无 tool_use）= 回合结束；
  // 刚发的真实用户消息 / thinking / tool_use / tool_result / 其余 = 处理中（等待回复）。
  // system/progress/attachment 等非内容记录跳过（jsonl 末尾常有 progress 尾巴）。仅此一处轻量判定，
  // 数据渲染权威仍在 messagesHtml；折叠关闭后交回下方整页数据渲染一次性出最终态。
  function segIsProcessing(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'system' || m.role === 'progress' || m.role === 'attachment') continue
      if (liveMsgPort.isRealUser(m)) return true // 刚发的用户消息（assistant 回复未到）= 处理中
      if (m.role === 'assistant') {
        // 2026-08-26：stopReason 精确判定（stop_reason=null 的旁白/工具=处理中，end_turn/stop_sequence=结束）；
        // 字段缺失（旧数据 undefined）回落旧启发式
        if (m.stopReason !== undefined) return !liveMsgPort.isEndStop(m.stopReason)
        const hasText = m.blocks.some((b) => b.kind === 'text' && b.text && b.text.trim())
        const hasTool = m.blocks.some((b) => b.kind === 'tool_use')
        return !(hasText && !hasTool)
      }
      return true
    }
    return false
  }

  // 回退快照防御（2026-09-11 三诊根治「发送瞬间跳到上一条消息」真主链）：全量快照必须单调
  // 前进。网关 /gateway/session = 磁盘 jsonl 全量 + CLI 异步上报窗口合并（localGateway.ts
  // mergeDisplayMessages），回合开启时序窗内两源都可能短暂落后（dequeue 落盘前 / display 缓冲
  // 重建期）→ 同一会话先后两次 fetch 可能拿到「已渲染内容消失」的回退快照（20260911203904
  // 录像三态实证：回合4权威渲染在屏 → 0.1s 后被旧快照整页重建洗掉 → hasNewUser 在回退数据上
  // 把上一回合误判为「新用户消息」stageStart 重钉 =「跳到上一条消息」；随后 delta gap 强制对账
  // 撞上空窗，force 绕过下方空 fetch 守卫整页清空 = 空白窗口）。回退快照一律整帧丢弃：不渲染、
  // 不重写 localMessages/deltaSeq 基线、不碰 cwd/模型/队列/任务槽，等下一条 SSE/落盘触发的新
  // 快照自然恢复。合法重渲（撤回/turn-state 收口）ts 持平放行；压缩收口 summary ts 前进放行；
  // 首载/切会话基线为 null 无从回退放行。
  function snapshotStale(local, incoming) {
    if (!Array.isArray(local) || !local.length) return false
    if (!Array.isArray(incoming) || !incoming.length) return true
    const maxTs = (msgs) => {
      let t = 0
      for (const m of msgs) {
        const ts = m && m.timestamp
        if (typeof ts === 'number' && ts > t) t = ts
      }
      return t
    }
    const cur = maxTs(local)
    const next = maxTs(incoming)
    return next > 0 && cur > 0 && next < cur
  }

  function refreshSession(force) {
    const hash = state.currentHash
    if (!hash) return
    if (live.sessT) return
    live.sessT = setTimeout(async () => {
      live.sessT = null
      if (state.currentHash !== hash) return
      const s = findSession(hash)
      if (!s) return
      try {
        const { messages, context, model, modelTs, effort, cwd, queued, tasks, file, deltaSeq } = await fetchMessages(s.id)
        // 2026-08-30 串会话根治：会话校验只在 await 前做过一次 → fetch 回程期间用户切到其它
        // 会话时，本响应（A 的整份消息/cwd/模型/上下文/队列快照）会写穿全部全局槽并把 A 的
        // 历史 innerHTML 整页渲染进新会话 DOM（CLI 单进程单会话无此异步边界，web 必须在每个
        // 异步边界重验身份）。await 后已切走 → 本响应整体作废。
        if (state.currentHash !== hash) return
        // 回退快照防御（snapshotStale）：必须先于一切副作用与基线赋值——旧快照哪怕被下方
        // 空 fetch 守卫挡住不渲染，基线（localMessages/deltaSeq）也已被静默回写，后续 delta
        // 判 gap 反复触发强制对账（回退风暴）。丢弃 = 本响应整体作废。
        if (snapshotStale(live.localMessages, messages)) return
        setSessionCwd(cwd)
        // 2026-08-30 队列快照：jsonl 文件名（uuid）供 SSE queue-state 会话匹配；queued 交排队区
        live.curUuid = file ? file.replace(/\.jsonl$/, '') : live.curUuid
        live.queueRemote = queued
        // 2026-09-10 任务浮窗首载/刷新：与 SSE task-state 增量同构（全量快照 → 整窗重渲）
        live.tasks = tasks
        liveUiPort.renderTaskDock()
        onSessionModel(model, modelTs) // 2026-08-24：实时刷新同样按 CLI 上报模型校准 seat（注入的钩子）
        onSessionEffort(effort) // 2026-11-06 思考等级同链：缺键 = 该会话没改过档，null = 明确 Off
        liveUiPort.renderCtxMeter(context)
        // 2026-09-08 事件流统一 P1（方案 20260908135557）：全量回程 = 权威快照，重置本地 delta
        // 基线（localMessages 副本 + 网关 seq 记账）。此后 session-delta SSE 按「尾部替换」增量
        // 演进副本；fetch 回程是基线唯一重置点（单源），gap/失步由本函数全量对账恢复。
        live.localMessages = messages
        live.deltaSeq = deltaSeq
        renderSessionBody(messages, { force, hash, adoptQueue: queued })
      } catch { /* 瞬时错误忽略 */ }
    }, 400)
  }

  // 渲染统一出口（2026-09-08 事件流统一 P1 提取；方案 §5.5「应用 delta 后同样走既有出口对账」）：
  // 全量对账（refreshSession fetch 回程）与 session-delta 增量应用共用同一条渲染路径——首条消息
  // 事务收口/接管帧、absorbPending、暂态区对账、sig 幂等判定、增量末段替换或整页重建、计时/钉顶/
  // 滚动全部同源，渲染不变量不因入口分叉（状态源不增加）。opts.adoptQueue 仅全量回程携带
  //（queued 载荷驱动的队首主张收编；delta 路径无 queued 载荷，queue-state SSE 自有入口）。
  function renderSessionBody(messages, opts) {
    const { force, hash, adoptQueue } = opts
    // 首条消息事务收口（2026-09-06）：本会话真实数据已落盘（SSE 接管起点）→ 销毁事务，
    // queue-dock 恢复正常渲染。与 renderSession fetch 回程的收口同一判定、双入口对称。
    // 接管帧（用户「两个状态的『正在处理』定位不同」根治）：乐观气泡/proc 折叠无 data-m，
    // stampMsgIn 的 prev 采集命中不了 → 接管重建把同位真实元素判「新增」重播 fadeup
    //（气泡+「正在处理」跳变重现）→ txTakeover 帧跳过 stampMsgIn（同位换皮不是新增）；
    // 乐观 proc 计时起点（发送瞬间 T0）早于落盘 user ts（异步化后消息经暂存补投）→
    // 移交 live.txProcStart 供 bindLiveFoldTimer 续算，「正在处理 Xs」跨接管连续不回跳。
    let txTakeover = false
    // 接管帧判定（2026-09-07 推广）：乐观开启气泡在屏（无 data-m 的 data-t="u"——真实渲染恒带
    // data-m、引导气泡另带 data-g，无 data-m 的 user 气泡只可能是乐观 DOM）即乐观权威期，
    // 不再只认 firstSendHash（web 新建事务）：CLI 启动会话的 web 首条消息同样经「乐观气泡→
    // 落盘接管」同位换皮，漏判则真实气泡被 stampMsgIn 判「新增」重播 fadeup = 闪动。
    if (messages.length > 0 && (liveStatePort.getFirstSendHash() === hash || messagesEl.querySelector('[data-t="u"]:not([data-m])'))) {
      txTakeover = true
      for (const p of liveStatePort.getPendingUserMsgs()) if (p.hash === '') p.hash = hash // 事务归属落定：'' 项归入本会话（吸收判定依赖 p.hash===cur）
      live.txProcStart = liveUiPort.claimStartTs()
      if (liveStatePort.getFirstSendHash() === hash) liveStatePort.setFirstSendHash('')
    }
    live.lastDataTs = (messages.length && messages[messages.length - 1].timestamp) || live.lastDataTs
    // 2026-09-02 排队图 id 防撞：扫描当前会话 display 已用最大 imageId（CLI getInitialPasteId
    // 同法），gwSend 分配 id 从 max+1 起——同会话多条带图消息 id 互不复用，file-cache 字节
    // 不再互覆（原恒从 1 起，第二条覆盖第一条 → 历史图错图）。
    // 2026-09-16 单调不回卷根修：视图（localMessages）在压缩归档/delta 重写窗口会丢历史块，
    // 清零重扫会把 maxImgId 回卷 → 下张图复用旧 id → CLI storeImage('w') 覆写字节 + 网关
    // max-age=86400 把首次取到的旧字节钉在该 URL 上 = 新图显示成旧图（b5bd1265 实证 A/B/C
    // 三图全 1 号互覆）。id 不复用是分配器不变量，不依赖视图完整：重扫只增不减（跨会话切回
    // 基准偏高无害，file-cache 按会话分目录，id 只需会话内唯一）。
    for (const m of messages) {
      for (const b of m.blocks || []) {
        if (b.kind === 'image' && typeof b.imageId === 'number' && b.imageId > live.maxImgId) live.maxImgId = b.imageId
      }
    }
    // 2026-08-29 待落盘乐观消息吸收判定：jsonl 已出现该文本（单条落盘或 drainCommandQueue
    // 多条合并成一条，join 后 includes 命中）→ 真实气泡已由渲染权威接管，不再重插
    liveMsgPort.absorbPending(messages)
    if (adoptQueue) liveMsgPort.queueClaimAdopt(adoptQueue) // 队首主张收编（刷新两段式根治，形态由 renderTransient 按 authLive 定）
    liveUiPort.renderTransient() // 暂态区对账重渲（吸收变化/远端快照更新后；权威重建后由下方再渲带降级判定）
    const last = messages.length ? messages[messages.length - 1] : null
    const sig = messages.length + ':' + (last ? (last.timestamp || '') : '') + ':' + (last && last.blocks.length ? last.blocks[last.blocks.length - 1].kind : '')
    // 新增用户消息检测（实时同步的钉顶触发点）：末尾真实用户消息索引/时间变了 = 新回合。
    // 注入引导消息（injected:true）不触发钉顶（用户定案：引导消息不钉顶，钉顶只属于新回合开启消息）
    let lastU = -1
    for (let i = messages.length - 1; i >= 0; i--) if (liveMsgPort.isRealUser(messages[i]) && !messages[i].injected) { lastU = i; break }
    const uSig = lastU >= 0 ? lastU + ':' + (messages[lastU].timestamp || '') : ''
    const hasNewUser = live.lastUserSig !== '' && uSig && uSig !== live.lastUserSig
    // 基线推进规则（2026-09-08 二轮根修）：无新回合（含 lastUserSig==='' 的基线补齐）→ 直接
    // 跟随；hasNewUser 帧不在此推进——钉顶触发未命中气泡时保留旧基线 = 下帧 hasNewUser 仍真
    // = 重试，直到气泡在屏命中才随 pinnedUserSig 一并推进（见下方触发块）。v261 注释宣称
    // 「未命中保留重试」，但此处无条件推进使 hasNewUser 下帧即假、重试永不发生。
    if (uSig && !hasNewUser) live.lastUserSig = uSig
    // 2026-08-26 定案：处理中段实时重建。原 2026-08-24 抑制逻辑（回合进行中跳过整页 innerHTML 重建）
    // 假设实时折叠由 WS out 增量填充——但网关从不给 web 发 out 消息（实时流走 SSE：conversationDisplay
    // 上报 + jsonl + 列表刷新），WS out 是死代码 → 处理中折叠一直空白（用户反馈「完全没有渲染，并且也不同步」）。
    // 现改为：回合未结束（数据在增长或 segIsProcessing）→ 照常整页重建，messagesHtml 对处理中段走
    // liveFoldBody 只渲染一个工具折叠行（「正在运行：<当前工具>」轮转；400ms 去抖已限频，SSE 逐条写入时最多 ~2.5 次/秒）；
    // 回合结束（末段回复落地）→ 关掉空 proc 折叠交回下方数据渲染一次性出最终态（已处理时长/回复/变更卡）。
    // 2026-09-06 空 fetch 不洗盘：发送瞬间乐观气泡（data-t="u"）/乐观折叠已上屏，jsonl 尚未
    // 落盘的窗口期 SSE 触发 refreshSession 拿到空 messages → 整页重建把乐观气泡洗成
    // 空白消息区，落盘后才恢复（用户实测「刷新两次+空态一闪」根因；原空态占位行 2026-09-07 移除）。
    // 消息区已有内容且数据为空 = 落盘窗口，跳过本次渲染保留乐观 DOM，等真实数据接管。
    // force 例外：restored 撤回链靠重渲收口（含空态），必须放行。
    if (!force && !messages.length && messagesEl.querySelector('[data-m], [data-t="u"], details')) return
    if (sig === live.curSig && !force) return // force=true：turn-state/restored 等运行态信号到达，jsonl 无新落盘也强制重渲收口
    live.curSig = sig
    const sc = $('chat-scroll')
    const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 80
    // 2026-08-26 增量重建根治：SSE 实时推送只追加/改写尾部「处理中段」，历史消息不变。
    // 对处理中末段只替换该段 DOM（applySegDelta，头部保留）→ 消除每次推送整页 innerHTML
    // 重建的闪烁，且 tool-running 光泽动画不再被重建打断（2.6s 扫光能完整播放）。
    // 条件：上次渲染存在 + 消息数只增不减（SSE 纯追加；回退/压缩等减少则整页）+ 有处理中末段。
    // 回复落地（段结束）/新回合/消息数减少 → 整页重建一次（低频，带「已处理」收拢可接受）。
    // 2026-09-18 卡顿根治（增量帧省历史段渲染）：原实现每帧无条件全量 messagesHtml 序列化整个
    // 会话，而历史段自上轮渲染以来内容不变、增量路径只消费末段 html——长会话下每条 session-delta
    //（引擎变化合帧最高 ~10 次/秒）都付 MB 级字符串拼接 + md 全文重解析 = 主线程卡顿主根。改惰性
    // 两段式：先 lazy 切段（历史段只切段不生成 HTML，O(N) 轻量；末段真渲染产出本轮 lastSegInfo/
    // charNote）→ 判定可增量直接 applySegDelta（历史段零渲染成本）；不可增量（切段边界/回合收口/
    // 锚点缺失）再跑全量渲染付全额——行为与原等价，全量频次=切段边界（低频）。
    liveMsgPort.messagesHtml(messages, true)
    // 2026-08-29 吞消息根治：末条真实用户消息（常为刚落盘的引导消息）气泡若不在 DOM（中间段
    // 新增，乐观气泡已被洗掉），增量路径只贴末段永远补不上 → 强制整页重建一次补齐；气泡在位
    // 后续轮次恢复增量（只多一次整页，折叠开合/入场动画已有恢复机制）。
    let lastRealUser = -1
    for (let i = messages.length - 1; i >= 0; i--) if (liveMsgPort.isRealUser(messages[i])) { lastRealUser = i; break }
    // 2026-08-29 引导消息折叠链：引导消息气泡 data-m=段 key ≠ 自身索引 → 额外带 data-g=自身索引，
    // 此处一并查（否则引导消息在末段时 userBubbleMissing 恒真 → 每次 SSE 都整页重建）
    const userBubbleMissing = lastRealUser >= 0 && !messagesEl.querySelector(`[data-m="${lastRealUser}"][data-t="u"], [data-g="${lastRealUser}"]`)
    const segInfo = liveMsgPort.getLastSegInfo() // 现读（不得缓存跨帧）：本轮 messagesHtml 刚产出的末段信息
    const canDelta = !userBubbleMissing && live.lastMsgLen != null && messages.length >= live.lastMsgLen && segInfo && segInfo.processing && segInfo.html
    live.lastMsgLen = messages.length
    if (canDelta) {
      applySegDelta(segInfo)
      liveUiPort.renderTransient() // 增量末段替换后暂态区对账（权威 done-live 复判 → 乐观主张降级/移除）
    } else {
      const html = liveMsgPort.messagesHtml(messages)
      // 折叠开合恢复改用**结构稳定键**（2026-09-11 根治）：原实现按 querySelectorAll('details')
      // 的数组下标采集/回填，注释假定「索引稳定」——但整页重建时 details 序列本就会变：处理中段的
      // liveFoldBody 尾组数随工具增长、think-row 数随思考块增长、回合收口时处理中段转已完成段
      // （liveFoldBody 多组 → groupTools 合并组）。下标错位会把旧 done-fold 的 open 赋给新 tool-fold，
      // 工具折叠体**莫名自动展开**（用户实测「没点开，自己就这么大」）。
      // 键 = 宿主段(data-m|data-t) + 主类名 + 段内同类序号：跨类型错配彻底消除（思考展开态不会再
      // 灌给工具折叠）；同类内序号偏移只在同段同类折叠增删时发生（后果轻，回落默认收起）。
      const foldKey = (d) => {
        const cls = d.className.split(' ')[0]
        if (d.dataset.m) return `@${d.dataset.m}|${d.dataset.t || ''}|${cls}`
        const host = d.closest('[data-m]')
        const scope = host || messagesEl
        const idx = [...scope.querySelectorAll('details.' + cls)].indexOf(d)
        return `${host ? host.dataset.m + '|' + (host.dataset.t || '') : 'root'}|${cls}#${idx}`
      }
      const openState = new Map([...messagesEl.querySelectorAll('details')].map((d) => [foldKey(d), d.open]))
      const doneLivePrev = new Set([...messagesEl.querySelectorAll('details')].filter((d) => d.classList.contains('done-live')).map(foldKey))
      // 采集刷新前的消息 key（data-m|data-t），重建后只给新增块播放入场动画
      const prevMsgs = new Set([...messagesEl.querySelectorAll('[data-m]')].map((e) => e.dataset.m + '|' + (e.dataset.t || '')))
      // img 换血（2026-09-18 内存峰值/闪烁根治）：整页 innerHTML 重建全部节点 → 全部 <img> 重建且
      // file-cache private,no-cache 每张必回源（网络风暴 + 全图重新解码 = 回合边界卡顿峰值 +
      // 「先塌后弹」闪烁）。src 相同的图内容不变 → 重建前按 src 采池，重建后同 src 换回旧节点
      //（池 shift 支持同 src 多图），零回源零重解码；池剩余节点随 GC 回收。
      const imgPools = new Map()
      for (const im of messagesEl.querySelectorAll('img')) {
        const k = im.getAttribute('src')
        if (!k) continue
        let pool = imgPools.get(k)
        if (!pool) { pool = []; imgPools.set(k, pool) }
        pool.push(im)
      }
      messagesEl.innerHTML = html
      for (const im of messagesEl.querySelectorAll('img')) {
        const pool = imgPools.get(im.getAttribute('src'))
        if (pool && pool.length) im.replaceWith(pool.shift())
      }
      if (!txTakeover) liveMsgPort.stampMsgIn(prevMsgs) // 接管帧不播入场动画（同位换皮，见上方事务收口注释）
      // 已存在的折叠恢复刷新前状态（覆盖 messagesHtml 对处理中折叠的默认 open，避免折叠后被刷新强制弹开）；
      // 处理中折叠（done-live）回复落地 → 自动收起（对齐「回复落地后收起」设计，短回复占位得以重新补回）；
      // 用户手动展开的「已处理」折叠照常恢复。新增折叠（索引越界）保留默认：处理中展开、已处理收起
      ;[...messagesEl.querySelectorAll('details')].forEach((d) => {
        const k = foldKey(d)
        if (!openState.has(k)) return // 新增折叠（键不在旧集）保留 HTML 默认：处理中展开、已处理收起
        const finishedNow = doneLivePrev.has(k) && !d.classList.contains('done-live')
        // 无正文回合（data-nobody）收口时不自动折叠——保留过程证据（对齐 dsh 轮次过程折叠）
        d.open = finishedNow ? !!d.dataset.nobody : openState.get(k)
      })
      // 2026-08-30 乐观改排队区（清单#4③）→ 2026-09-07 暂态区收编：整页重建洗掉 #live-zone
      // → renderTransient 从状态整体重建（气泡/折叠/排队区恒定顺序挂回 pin-stage 之前）
      liveUiPort.renderTransient()
    }
    // 2026-09-11 ④ 只读提问卡接管已移除（见 route.js 同处注）：提问态由消息流紧凑工具行表达，
    // 此处只保留审批卡保护——交互式逐题审批卡占据输入栏时不得被 clearTakeover 洗掉。
    if (liveStatePort.getTakeover() !== 'approval') liveStatePort.clearTakeover()
    setChar(liveMsgPort.getCharNote()) // 只读 SSE：按末段最近工具/处理状态切形象
    bindLiveFoldTimer(messages)
    applyStreamPreview() // 2026-09-08 流式字符通道：重渲洗 DOM 后重挂流式预览暂态（streamText 内存态恢复）
    liveUiPort.syncTurnLive() // 2026-09-04 打断按钮：SSE 刷新整页/增量重建后校准（回合收口→还原发送键）
    if (hasNewUser && uSig !== live.pinnedUserSig) {
      // 真正的新用户消息 → 回合开启唤出（两层消息流）：占位按跟随几何同帧就位。
      // pinnedUserSig 防重复：迟到的刷新不会再重钉上一回合。
      // 命中才推进 lastUserSig/pinnedUserSig（配合上方基线推进规则=真实可重试）。
      const el = messagesEl.querySelector(`[data-m="${lastU}"][data-t="u"]`)
      if (el) {
        live.lastUserSig = uSig // 命中才推进（配合上方基线推进规则=真实可重试）
        live.pinnedUserSig = uSig
        // 换 key 帧必须走 stageStart 换参照气泡（脚印随参照实时量取，2026-09-10 起无诞生快照）：
        // 乐观气泡唤出的占位在场 → 接管帧同回合延续；CLI 端发起的新回合（web 观察）同样在此
        // 唤出。2026-09-11 起无动画窗（smooth 分支退役）——两条路径同一落点，不再分叉。
        liveStagePort.stageStart(el, uSig)
      }
    } else {
      liveUiPort.renderSettle() // 无新回合：占位在场时对账（重挂/校准/跟随归位），未激活零开销
    }
    // 占位在场=两层跟随接管（stageFollow/动画期已自带让位逻辑）；
    // 否则保留原有「原本在底部就跟着吸底」行为
    if (!liveStagePort.stage.active) {
      sc.style.scrollBehavior = 'auto'
      if (atBottom) sc.scrollTop = sc.scrollHeight
      sc.style.scrollBehavior = ''
    }
  }

  // 增量重建（2026-08-26）：只替换「处理中末段」的 DOM，头部历史消息保留不动（不整页 innerHTML，
  // 消除闪烁 + tool-running 光泽动画不被重建打断）。info = lastSegInfo {key, html, prev, processing}：
  // 先删旧末段全部节点（data-m=key，含用户消息/折叠/回复/变更卡），新段节点按 prev 锚点
  // （该段输出前的最后一个 data-m 元素）插回原位；无锚点（末段即首条）则追加到末尾。
  function applySegDelta(info) {
    const key = String(info.key)
    // 增量替换状态保持（2026-09-18「状态行更新/旁白行新增→界面跳动」根治）：段替换以段为粒度
    // 整段换血，段内有两类 HTML 再生不出来的状态——
    // ① details 开合态（段折叠用户手动关上 / tool-fold 用户手动展开）：按 HTML 默认值重建
    //    （处理中=open、tool-fold=收起）意味着每次状态行更新/旁白行新增都把折叠态拍回默认 =
    //    整段高度每增量跳一次。全量重建路径已按 foldKey 恢复开合（2026-09-11 定案「用户手动
    //    展开的折叠照常恢复」），增量路径同受此不变量约束——此处按同一键语义捕获并恢复
    //    （键不在旧集的新增折叠保留 HTML 默认：处理中展开、工具行收起）。
    // ② 用户气泡及其图片：气泡在段内不变（who/图/文件/复制钮落盘后皆静态），重建节点令 imgs
    //    重新请求/解码（file-cache no-cache 必回源 → 至少一帧 0 高塌缩再回弹）= 每增量先塌后弹
    //    的跳动。DOM 已有同 key 气泡时保留旧节点、丢弃新段气泡节点只换其余（气泡=段首元素，
    //    其余部分删后插回流末锚点前=文档序不变；处理中段恒为末段，旧气泡与流末锚点之间不存在
    //    他段节点）。
    const oldNodes = [...messagesEl.querySelectorAll(`[data-m="${key}"]`)]
    const foldKeyOf = (d) => {
      const cls = d.className.split(' ')[0]
      if (d.dataset.m) return `@${d.dataset.m}|${d.dataset.t || ''}|${cls}`
      const host = d.closest('[data-m]')
      const scope = host || messagesEl
      const idx = [...scope.querySelectorAll('details.' + cls)].indexOf(d)
      return `${host ? host.dataset.m + '|' + (host.dataset.t || '') : 'root'}|${cls}#${idx}`
    }
    const prevOpen = new Map()
    for (const n of oldNodes) {
      for (const d of (n.matches('details') ? [n] : []).concat([...n.querySelectorAll('details')])) {
        prevOpen.set(foldKeyOf(d), d.open)
      }
    }
    const tmp = document.createElement('div')
    tmp.innerHTML = info.html
    const frag = document.createDocumentFragment()
    for (const n of [...tmp.children]) frag.appendChild(n)
    const oldBubble = oldNodes.find((n) => n.matches('[data-t="u"]'))
    const newBubble = [...frag.children].find((n) => n.matches('[data-t="u"]')) || null
    const keepBubble = !!(oldBubble && newBubble && oldBubble.isConnected)
    if (keepBubble) newBubble.remove()
    // img 换血（2026-09-18「旁白消息的图片仍闪」根治）：段内除段首用户气泡外的节点（尤其
    // 引导气泡 data-t="g<gi>"——上传图片经排队注入后正是落在这里，与旁白行同段）每帧重建，
    // 新 <img> 到 paint 时尚未解码（file-cache private,no-cache 必回源）= 至少一帧 0 高塌缩
    // 再回弹。与全量重建路径同一不变量：已落盘图片字节不可变 → 同 src 的旧节点直接换回，
    // 零回源零重解码。只从「本次将被删除」的节点采池——保留的旧气泡节点不动（引导气泡与
    // 用户气泡可能同 src，采走会让保留气泡丢图）。
    const imgsOf = (n) => (n.matches('img') ? [n] : []).concat([...n.querySelectorAll('img')])
    const imgPools = new Map()
    for (const n of oldNodes) {
      if (keepBubble && n === oldBubble) continue
      for (const im of imgsOf(n)) {
        const k = im.getAttribute('src')
        if (!k) continue
        let pool = imgPools.get(k)
        if (!pool) { pool = []; imgPools.set(k, pool) }
        pool.push(im)
      }
    }
    for (const n of oldNodes) if (!(keepBubble && n === oldBubble)) n.remove()
    const inserted = [...frag.children]
    let anchor = null
    if (info.prev) {
      // 同 data-t 多元素时（如多轮 end_turn 的多个 reply 气泡、同 key 多 fold）取文档序最后一个
      // = 段尾精确锚点（碎片化交错渲染 2026-08-29：prev.type 语义=段尾最后元素）
      const nodes = messagesEl.querySelectorAll(`[data-m="${info.prev.key}"][data-t="${info.prev.type}"]`)
      anchor = nodes.length ? nodes[nodes.length - 1] : null
    }
    // 插入点恒避让暂态区与 .pin-stage（暂态区子元素/两层占位必须是流末）：段尾无后继或无锚点
    //（首段处理中）时都插到 #live-zone 之前——否则新段节点越过暂态区/落到占位块后面，
    // 占位错位到内容中间持续到刷新（2026-08-28 钉顶占位突然死亡根因一；2026-09-07 排队区
    // 插到新消息上一行同根因，暂态区结构化消除）。气泡保留旧节点时同样插流末锚点前
    //（见上：旧行为按 prev 锚点插会把新折叠体插到保留气泡之前，文档序颠倒）。
    const zone = document.getElementById('live-zone')
    const spacer = messagesEl.querySelector('.pin-stage')
    const tail = zone || spacer
    let ref = tail
    if (!keepBubble && anchor && anchor.isConnected) {
      let after = anchor.nextSibling
      while (after && after.nodeType !== 1) after = after.nextSibling
      ref = after || tail
    }
    messagesEl.insertBefore(frag, ref)
    // 同 src 的新 <img> 换回旧节点（见上方「img 换血」；此时新图尚未解码，换回即沿用已解码位图）
    for (const n of inserted) {
      for (const im of imgsOf(n)) {
        const pool = imgPools.get(im.getAttribute('src'))
        if (pool && pool.length) im.replaceWith(pool.shift())
      }
    }
    // ① 开合态恢复（仅旧集已有的折叠；新增折叠不在集内=保留 HTML 默认）
    for (const n of inserted) {
      for (const d of (n.matches('details') ? [n] : []).concat([...n.querySelectorAll('details')])) {
        const k = foldKeyOf(d)
        if (prevOpen.has(k)) d.open = prevOpen.get(k)
      }
    }
  }

  // 处理中折叠的「正在处理」实时计时（历史/SSE 路径）：末段尚无回复 = 处理中，
  // 从该段最后一个真实用户消息时间起跳字，回复落地后下轮刷新换成「已处理 X」并停表。
  let liveFoldTimer = null
  function stopLiveFoldTimer() {
    if (liveFoldTimer) { clearInterval(liveFoldTimer); liveFoldTimer = null }
  }
  // （2026-10-14 收口：90s 静默探测 probeCurStall/lastCurSseAt/#claim-fold 探测分支已随 SSE
  // 根治第一阶段删除——SSE 活性判定下沉到连接监督者 watchdog + 服务端 heartbeat，见文件头。）
  function bindLiveFoldTimer(messages) {
    stopLiveFoldTimer()
    const fold = messagesEl.querySelector('details.done-fold.done-live[data-m]') // 权威折叠（data-m）；乐观主张折叠在暂态区无 data-m，不参与
    if (!fold) return
    let t1 = live.txProcStart || 0
    live.txProcStart = 0 // 读取即清：移交起点只服务接管帧这一跳（残留会污染其它会话/回合的计时）
    if (!t1) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        // 注入引导消息（injected:true）不重置计时——「已处理」时长 = 从段开启消息起算，不打断（用户定案）
        if (liveMsgPort.isRealUser(m) && !m.injected && m.timestamp) {
          t1 = m.timestamp
          break
        }
      }
    }
    if (!t1) return
    const sum = fold.querySelector('summary')
    const tick = () => {
      if (!fold.isConnected) { stopLiveFoldTimer(); return }
      // SSE 活性监督已下沉到连接监督者（watchdog/heartbeat，见文件头）；此处只剩计时与状态对账。
      const sec = Math.round((Date.now() - t1) / 1000)
      // 僵死/断连对账（每秒 tick 无残留状态，信号恢复即自动消失）：
      // ① beat = 引擎最后产出增量的时刻（turn-beat SSE）。落后 ≥150s（beat 缺席则从本折叠
      //    计时起点起算）= query 链僵死或长任务无输出 → 标「无响应」。2026-09-08 判定统一：
      //    与 claimTick 同规则，删掉「beat 缺席即标」的短路——纯工具回合（bash 长跑零增量）/
      //    回合切换后 beat 窗口/旧 exe CLI（不发 beat）整回合误标「无响应」（未上屏先挂标实证）。
      // ② connUp = 网关 WS 在线（setConn 维护）。断开（网关死/网络断）→ 标「连接中断」，
      //    此前断流后计时行冻结假转（09-07 Pj5 断流残影实证），用户无从分辨。
      // 回合基线（2026-09-08 无响应误标根治）：turnBeat 是 per-session 永续 Map，上回合残留
      // beat（早于本段开启消息 t1）对新回合毫无意义——回合切换后的静默期（乐观窗口/首响前）
      // 拿旧值算出 staleSec≥150 会立即误标「无响应 X 分」（12:42 实测：正在处理 5s 并挂无响应
      // 2m59s）。beat 早于 t1 视同缺席，从本折叠起点 sec 起算，与本判定设计语义对齐。
      const rawBeat = live.curUuid ? live.turnBeat.get(live.curUuid) || 0 : 0
      const beatAt = rawBeat >= t1 ? rawBeat : 0
      const staleSec = beatAt ? Math.round((Date.now() - beatAt) / 1000) : sec
      // ③ 2026-09-11 已知阻塞原因不算「无响应」：审批卡在场（回合阻塞在等用户作答）/ 工具在飞
      // （引擎阻塞在等工具结果）都是合法阻塞，引擎无产出是预期——beat 自然不会增长。
      // 红标语义 = 「引擎无产出**且无已知阻塞原因**」；纯工具期与审批同等豁免（用户实测
      // 「正在运行时候怎么会无响应呢」，案例=长跑命令 3m33s 被误标）。工具判据取 DOM 运行态标记
      // .tool-line.tool-running——running 分支 summary 与 toolCurHtml 两条出口同款类，单一判据。
      const awaitingApproval = liveStatePort.getTakeover() === 'approval'
      const toolRunning = !!fold.querySelector('.tool-line.tool-running')
      // ④ 2026-09-18 用户定案：无响应降为**最底层优先级**——状态行有任意状态在场（正在思考/
      // 正在生成/正在压缩/正在运行）即不判，仅当无任何状态时才允许红标。压缩期误标实证根修：
      // 压缩是一次大 LLM 调用，零增量产出 → beat 恒停超 150s 被判「无响应」，且单状态槽挤掉
      // 「正在压缩」。状态判据 = .think-state 的 data-label（messages.js vacuumOf 单源渲染，
      // 压缩实证档 compact-state 同源 TTL 5min）；stEl 查询提前至此，下方计时复用同一节点。
      const stEl = fold.querySelector('.think-state')
      const hasStatus = !!(stEl && (stEl.dataset.label || '').trim())
      // 单状态槽（2026-09-11 用户定案「一次应该只有一个状态」）：红标在场时它**独占**状态槽——
      // stEl 所在状态显示行挂 .is-flagged，styles.css 隐去同行 .think-state（含并发尾缀「并思考」）
      // 与 .think-stream（流式预览=引擎产出的暂态，引擎无产出即过期，留着与红标互相打脸）。
      // 信号恢复即整行复原（每秒重算，无残留态）。
      // 豁免规则（审批等待/工具在飞/任意状态在场 = 已知阻塞或已有状态表达）→ 本帧不参与僵死
      // 判定，传 0 表达「判据不适用」；阈值与文案由 messages.js statusFlags/STALE_SEC 单源构造
      // （优先级：连接中断 > 无响应，无响应为最底层）。
      const flags = liveMsgPort.statusFlags(connUp, awaitingApproval || toolRunning || hasStatus ? 0 : staleSec)
      // 两行各自独立跳字（2026-09-09 用户定案「折叠顶只留正在处理/已处理，状态标识归工具行层」；
      // 二轮定案：工具调用行=折叠体，状态显示行是其内暂态层 .fold-state——有工具组并入 summary
      // 同行、无工具组独立行，动画展示不留存）：① 折叠顶 summary 恒「正在处理 + d-dur 总时长」；
      // ② 思考/压缩状态 .think-state 落 .fold-state 暂态层，tick 原地续「 Ns」（2026-09-18 分隔点
      // 全撤：用户定案状态行不用「·」，空格分隔）。全程节点级
      // textContent 更新、不 innerHTML 重建——重建会每秒重启扫光动画并洗掉 applyStreamPreview
      // 挂的流式预览节点。
      // 状态行文本节点独立（2026-09-11）：.think-state 首子节点恒为 .t-ico 行首槽（与工具行同款
      // 16px 槽 + 5px gap，文字左缘同基准）——整节点 textContent 赋值会连图标槽一并洗掉，槽一没
      // 文字左缘即回跳（用户实测的「跳动」），故 tick 只写 .ts-text 文本节点。
      if (stEl) {
        // 文案由 messages.js vacuumLabel 单一映射后写进 data-label（含并发尾缀「并思考」形态）；
        // tick 只补计时，不复刻 mode→label 映射（旧实现在此处重复一份三元链，改文案要改两处）。
        const label = stEl.dataset.label || ''
        const ts = Number(stEl.dataset.ts) || 0
        const dsec = ts ? Math.max(0, Math.round((Date.now() - ts) / 1000)) : 0
        stEl.querySelector('.ts-text').textContent = label && ts ? `${label} ${liveMsgPort.fmtDur(dsec)}` : label
      }
      const durEl = sum.querySelector('.d-dur')
      if (durEl) durEl.textContent = ' ' + liveMsgPort.fmtDur(sec)
      // 僵死/断连红标独立对账（原地，信号恢复即自动消失）；宿主=状态显示行 .fold-state（有工具组时
      // 在工具行 summary 内、无工具组时段尾独立行）或 done-body 尾（乐观主张折叠），不上折叠顶
      // summary（同上定案：折叠顶不留状态标识字样）
      let flEl = fold.querySelector('.d-flags')
      if (!flEl) {
        flEl = document.createElement('span')
        flEl.className = 'd-flags'
        const fhost = stEl ? stEl.parentElement : fold.querySelector('.done-body')
        if (!fhost) return
        fhost.appendChild(flEl)
      }
      if (flEl.innerHTML !== flags) flEl.innerHTML = flags // 值不变不重写：每秒空写会打断子动画并触发无谓样式重算（2026-09-18 卡顿小刀）
      // 状态槽独占判定（同帧、同一判据 flags 非空）：宿主是状态显示行 .fold-state 时才挂标
      //（回退宿主 .done-body 里本就没有 .think-state，无需隐）。信号恢复 → 摘标 = 状态文字复原。
      const frow = flEl.parentElement
      if (frow && frow.classList.contains('fold-state')) frow.classList.toggle('is-flagged', !!flags)
    }
    tick()
    liveFoldTimer = setInterval(tick, 1000)
  }

  // 2026-09-08 流式字符通道：把 live.streamText 挂到状态显示行 .fold-state 内（权威段体工具行
  // summary 内暂态层 / 段尾独立行 / 乐观主张折叠 #claim-fold 的 done-body 内，2026-09-09 定案
  // 起不再进任何折叠顶 summary——折叠顶只留「正在处理/已处理」字样）。单行 rtl 保尾（.think-stream 样式，v151 .ch-file 同款技巧），
  // JS 截 200 字符防 DOM 膨胀。无状态显示行在场且无主张折叠 = 不显示（内存保留，状态显示行渲染出
  // 来后由下一帧/renderSessionBody 出口带出）；text 空 = 移除暂态节点。
  // 清除信号：stream-text ''（块边界/消息落盘）、turn-state live:false（打断）、切会话清槽。
  function applyStreamPreview() {
    const old = messagesEl.querySelector('.think-stream')
    const text = live.streamText || ''
    if (!text) { if (old) old.remove(); return }
    let host = null
    let anchor = null
    const stEl = messagesEl.querySelector('details.done-fold.done-live .think-state')
    if (stEl) { anchor = stEl; host = stEl.parentElement }
    else {
      const claim = document.getElementById('claim-fold')
      if (claim) host = claim.querySelector('.done-body')
    }
    if (!host) { if (old) old.remove(); return }
    // 流式预览与状态文字同挂 .fold-state 暂态层一行（2026-09-09 定案：与工具行同一行）；已有节点全
    // host 查找复用（行内 d-flags 与流式预览共存，anchor.nextElementSibling 判定会误判成
    // 需重建 → 孤儿残留），只在缺节点时插入到状态文字之后（claim 路径 anchor 空则追加体尾）。
    let el = host.querySelector(':scope > .think-stream')
    if (!el) {
      el = document.createElement('span')
      el.className = 'think-stream'
      if (anchor) anchor.after(el); else host.appendChild(el)
    }
    el.textContent = text.length > 200 ? '…' + text.slice(-200) : text
  }

// —— 跨模块写入口（切割脚本生成）——
export function setLiveModelHook(fn) { onSessionModel = fn }
export function setLiveEffortHook(fn) { onSessionEffort = fn }
// 分层治理 4C（2026-10-10）：feature 端口注入（app 启动序列调用一次，须先于 initLive）。
export function setLivePorts(p) { liveMsgPort = p.msg; liveUiPort = p.ui; liveStagePort = p.stage; liveStatePort = p.state }

export {
  applySegDelta,
  applyStreamPreview,
  bindLiveFoldTimer,
  initLive,
  liveFoldTimer,
  noteWsClosed,
  noteWsOpen,
  refreshList,
  refreshSession,
  renderSessionBody,
  segIsProcessing,
  stopLiveFoldTimer,
}
