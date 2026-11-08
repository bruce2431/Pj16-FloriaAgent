// 消息流渲染器：messagesHtml 切段/折叠/增量锚点 + 思考行 + 入场动画标记
import { mdHtml } from '../../core/markdown.js'
import { toolToChar } from '../../core/char.js'
import { esc } from '../../core/util.js'
import { findSession } from '../../engine/sessions.js'
import { live, messagesEl } from '../../engine/state.js'
import { toolMeta, toolLine, askLineHtml, groupTools, liveFoldBody, vacuumOf } from '../messages.js'
import { isContinuationMsg, isRealUser, isEndStop, whoHtml, userBodyHtml, userImgsHtml, userFilesHtml, fmtDur, processTextHtml } from './msg-actions.js'
import { renderChangeCardHtml } from './change-card.js'
import { usageButtonHtml, fmtClock, ICON_COPY } from './usage.js'
import { CHEV } from './icons.js'
/* @module chat/messages/renderer.js */
  function thinkRowHtml(text, running) {
    const t = String(text || '')
    if (!t.trim()) return ''
    // 2026-08-26 任务 D 定案：思考块收起时**不显示思考正文摘要**（用户「思考过程未折叠」反馈——
    // 摘要「思考 先说明：触发。」直接暴露内部推理）。summary 只留「思考」标题 + 运行态扫光，
    // 点开才看全文。删除 thinkSummary 摘要（运行中 latestLine / 完成后 firstLine 语义一并废弃）。
    return `<details class="think-row" data-state="${running ? 'running' : 'ok'}"><summary><span class="tr-leading" aria-hidden="true"><span class="tr-ico">${THINK_ICON}</span><span class="tr-chev">${THINK_CHEV}</span></span><span class="tr-title">思考</span></summary><div class="tr-body md-scope">${mdHtml(t)}</div></details>`
  }

  // 入场动画标记：对比刷新前的顶层消息 key 集合，只给「本次新增」的块加 .msg-in，
  // 已存在的块静默保留（视觉无缝），避免整体 innerHTML 重建时整屏重播动画造成强刷感。
  // key = data-m|data-t（段起始消息索引 | 块类型：u=用户 a=回复 f=独立处理折叠 s=系统）。
  // prev 为空（首屏加载）时全部淡入并带轻微 stagger，让会话打开更有层次。
  function stampMsgIn(prev) {
    let n = 0
    messagesEl.querySelectorAll('[data-m]').forEach((el) => {
      const k = el.dataset.m + '|' + (el.dataset.t || '')
      if (!prev.has(k)) {
        el.classList.add('msg-in')
        el.style.animationDelay = Math.min(n * 22, 330) + 'ms'
        n++
      }
    })
  }

  // messagesHtml 渲染时记录的末段形象（只读 SSE 路径）：末段仍在处理中且段内最近有工具调用
  // → 按该工具选形象（读/搜=3、写/编=2、执行/插件/命令=4）；回复已发布/空闲 → 默认 1
  let charNote = 1
  // 增量重建（2026-08-26）：messagesHtml 记录「最后一个被 closeSeg 的段」的 key/html/前驱锚点/处理中标志，
  // refreshSession 对处理中末段只替换该段 DOM（applySegDelta），头部历史消息保留不动——消除整页重建闪烁。
  let lastSegInfo = null
  // 分层治理 4C（2026-10-10）：engine/live.js 的只读读取口——经端口注入调用，每次现读可变绑定，
  // 调用方严禁缓存返回值（缓存即与渲染实时态脱钩）。
  function getCharNote() { return charNote }
  function getLastSegInfo() { return lastSegInfo }

  // lazy（2026-09-18 web 卡顿根治）：true = 惰性两段式——切段循环照跑（桶分配 O(N) 轻量）但
  // 历史段不生成 HTML（think/ask/tool/reply 行的 html 置空）、closeSeg 只封存不渲染（按渲染同序
  // 静态推进 lastNode 供末段 prev 锚点链）；仅末段（isFinal）真渲染并在入口补齐置空行。调用方
  // live.js renderSessionBody 增量帧据此把「每帧全会话 MB 级序列化」降为「O(N) 切段 + 末段渲染」；
  // 判定不可增量时再跑一次全量（lazy=false）付全额，行为与原等价。
  function messagesHtml(messages, lazy) {
    // 按「用户消息 → AI 处理 → 回复」切段：
    // 真实 user 消息开新段；assistant/tool 的 thinking 与 tool_use 归入「已处理」折叠，
    // 段内最后一个带文本的 assistant 消息 = 回复（主内容），其余文本（过程旁白）也折进去。
    // role:'system'（后端已把合成/系统注入标成 system）= 无发布者的居中提示，独立一行。
    let html = ''
    let seg = null
    lastSegInfo = null // 每次渲染重置：仅记录本次被 closeSeg 的最后一个段
    let lastNode = null // 最近输出的 data-m 元素 {key, type}（供增量重建定位插入锚点）
    // 兜底：最后一条真实用户消息的时间（供「系统消息打断后」无 user 的末段计时/展示时长）；
    // 注入引导消息（injected）不计入——计时起点不打断（单折叠定稿）
    let lastUserTs = 0
    for (const m of messages) if (isRealUser(m) && !m.injected && m.timestamp) lastUserTs = m.timestamp
    // 引导消息按 pos 织进 items 流（从后往前插避免下标位移）；guides 按 push 序天然 pos 升序。
    // A 方案（用户 2026-08-29 定案）：处理中/完成态均为顶层完整用户气泡，原位保留。
    function weave(items, guides, s) {
      if (!guides || !guides.length) return items
      const out = items.slice()
      for (let gi = guides.length - 1; gi >= 0; gi--) {
        const g = guides[gi]
        const gbody = userBodyHtml(g.m)
        out.splice(Math.min(g.pos, out.length), 0, {
          kind: 'guide', gi,
          html: `<div class="msg user" data-m="${s.key}" data-t="g${gi}"${g.i != null ? ` data-g="${g.i}"` : ''}>${whoHtml(g.m)}${gbody ? `<div class="body md-scope">${gbody}</div>` : ''}${userImgsHtml(g.m)}${userFilesHtml(g.m)}</div>`, // 引导气泡不带复制按钮（用户 2026-08-30 定案）；纯图无文本不出空气泡（2026-09-07 空气炮根修）
        })
      }
      return out
    }
    // end_turn 正式回复气泡（流内 reply 项用，形态与原 reply 特判渲染一致）
    // 2026-10-04 还原 dsh 回复操作条：复制按钮之后依次「用量 X tok」按钮（点击弹出本轮 token 明细面板）+ 时间（HH:MM）。
    // 均置于 .msg-actions 内 → messageCopyText 剔除 `.msg-actions` 时一并排除，不污染复制文本。
    function replyBubbleHtml(key, text, usage, ts, model) {
      const clock = fmtClock(ts)
      const useBtn = usage ? usageButtonHtml(usage, model) : ''
      const meta = `${useBtn}${clock ? `<span class="msg-time">${clock}</span>` : ''}`
      return `<div class="msg assistant" data-m="${key}" data-t="a"><div class="body md-scope"><div class="blocks">${mdHtml(text)}</div><div class="msg-actions"><button class="msg-copy" title="复制" aria-label="复制">${ICON_COPY}</button>${meta}</div></div></div>`
    }
    function closeSeg(isFinal) {
      if (!seg) return
      const s = seg
      seg = null
      const segPrev = lastNode // 该段输出前的最后一个 data-m 元素（增量重建插入锚点）
      // 2026-09-06 打断收口：回合被中止后 jsonl 零写入（永远不会有 end_turn 回复），数据形态与
      // 「正在处理」不可区分——收口判定靠两持久信号，任一命中即强制按「已处理」收口，不再挂
      // 「正在处理/正在思考」无限计时（用户实测 2h26m 挂死根修）：
      // ① 会话进程不在线（state=null，网关按存活 pid 判定）= 不可能在处理：封死进程退出/关闭
      //    会话（直接 taskkill 零 onCancel）/崩溃路径；
      // ② turnEndAt（网关权威时刻：turn-state SSE 实时 + /gateway/sessions 首载恢复，无 TTL）
      //    晚于段末落盘 ts = 该回合已被中止：封死打断后刷新丢前端内存标记路径。
      const turnEnded = (() => {
        const sess = findSession(live.curUuid)
        if (sess && !sess.state) return true
        const te = live.turnEndFlags.get(live.curUuid)
        return !!(te && (s.lastTs || (s.user && s.user.timestamp) || 0) < te)
      })()
      const processing = isFinal && !s.finished && !turnEnded // 最后一段且末尾还没收到纯文本回复 = 处理中
      // 末段仍在处理中（未出正式回复）且段内最近有工具调用 → 按该工具选形象；否则（回复已发布/空闲）默认 1
      if (isFinal) charNote = (!(s.finished || turnEnded) && s.lastTool) ? toolToChar(s.lastTool) : 1
      // 惰性收口（2026-09-18）：非末段不渲染——历史段 DOM/内容自上轮以来不变，增量路径只消费
      // 末段 html。按渲染同序静态推进 lastNode（u→f→a→c）供末段 prev 锚点链；节点存在性与渲染
      // 路径等价：u=有开启气泡；f=非 reply 项非空（groupTools/liveFoldBody 有行必有折叠，skip 段
      // processing 恒 false）；a=每条 reply 项；c=变更卡。texts 回填（重 markdown）一并跳过。
      if (lazy && !isFinal) {
        if (s.user) lastNode = { key: s.key, type: 'u' }
        let nFold = s.guides ? s.guides.length : 0
        for (const it of s.items) if (it.kind !== 'reply') nFold++
        if (nFold) lastNode = { key: s.key, type: 'f' }
        for (const it of s.items) if (it.kind === 'reply') lastNode = { key: s.key, type: 'a' }
        if (s.changes && s.changes.size) lastNode = { key: s.key, type: 'c' }
        return
      }
      // 旁白 text 原位回填（与其后的动作交错，不再统一沉到段尾）；正式回复（end_turn）已在切段时
      // 气泡化（reply 项 → 折叠体外），不进 texts
      for (const t of s.texts) s.items[t.idx].html = processTextHtml(t.text)
      // 惰性帧渲染段补生成（2026-09-18）：lazy 切段置空的行在此补齐（仅末段真渲染会走到）。
      // ask 按吸附后的 answer 终态生成（切段时 false 缓存失效）；tool 行 html 恒为完成行基线
      //（toolLine 产物，运行态由 flushTools 按改写分派 toolCurHtml，与原切段即生成等价）。
      if (lazy) {
        for (const it of s.items) {
          if (it.html) continue
          if (it.kind === 'think') it.html = thinkRowHtml(it.text, false)
          else if (it.kind === 'ask') it.html = askLineHtml(it.answer != null)
          else if (it.kind === 'reply') it.html = replyBubbleHtml(s.key, it.text, it.usage, it.ts, it.model)
          else if (it.kind === 'tool') it.html = toolLine(it.block)
        }
      }
      // 思考行不做 running 态回填（思考永不独立成行：真空态=liveFoldBody 工具行内 .fold-state
      // 状态显示行，2026-09-09 用户定案「状态标识与工具调用行在一起」，v267 summary 轮转方案废弃）

      let segHtml = ''
      if (s.user) {
        const m = s.user
        // 纯图消息（文本剥 [Image #N] 占位后为空）不出 .body 空气泡，复制按钮同去（无文本可复制；
        // 乐观气泡同构同去防接管帧形态跳变）——2026-09-07 空气炮根修
        const ubody = userBodyHtml(m)
        segHtml += `<div class="msg user" data-m="${s.key}" data-t="u">${whoHtml(m)}${ubody ? `<div class="body md-scope">${ubody}</div>` : ''}${userImgsHtml(m)}${userFilesHtml(m)}${ubody ? `<div class="msg-actions"><button class="msg-copy" title="复制" aria-label="复制">${ICON_COPY}</button></div>` : ''}</div>`
        lastNode = { key: s.key, type: 'u' }
      }

      // 2026-08-29 最终定案（用户）：开启消息渲染一个折叠体，旁白/工具调用行/思考/引导消息
      // 都作为折叠体内部的元素（思考/旁白/引导原位穿插，连续工具折叠概括——liveFoldBody/groupTools），end_turn 正式
      // 回复是唯一折叠体外元素（「已处理 X」+回复）。顺序与 CLI 线性序一致（网关已把回合中
      // 引导重定位回 enqueue 位置并打 guide 标——「回复跑到引导上面」的顺序颠倒已根治）。
      const woven = weave(s.items, s.guides, s)
      const foldItems = []
      const flowParts = []
      for (const it of woven) {
        if (it.kind === 'reply') flowParts.push({ html: it.html, type: 'a' })
        else foldItems.push(it)
      }

      // 「正在思考/正在生成/正在压缩」状态行（2026-08-27 机制沿用；2026-09-11 判定收敛为纯函数 vacuumOf）。
      // 【真空窗口实锤（ff7dc1c2 转录逐行计时）】CLI 按块流式落盘：旁白 text 落盘后 LLM 生成 Edit 的
      // tool_use 参数 3~14s——期间 jsonl 零写入、turn-beat 仍随 delta 持续 → 旧白名单判定（result/thinking
      // 才亮 think，text 不亮）使状态显示行整段真空数秒（用户实测「编辑文件时短暂真空期」）。text 落盘与
      // thinking 落盘语义相同（回合未收口、无工具运行 = 引擎在产出），判定不再按尾动作类型区分；
      // lastStep=null（段刚开、首条记录未落盘）同样亮态。提问 ask 不亮态（提问卡接管输入栏即状态，
      // 2026-09-09 定案维持）。thinking 流式期间 jsonl 零写入 → SSE 不触发，web 保持本次渲染的思考态
      // 直到落盘轮转。判定细则与「工具在飞时以 turn-beat 取证」见 vacuumOf。
      const vacuumState = vacuumOf(s, processing, live, Date.now())
      // 思考/压缩态计时起点：段内最后一条落盘记录的时刻（真空期从那时开始）；尚无记录退回段 user 时间
      const vacuumStart = s.lastTs || (s.user && s.user.timestamp) || 0
      // 处理中（实时）段 = liveFoldBody（单工具折叠行轮转 + 真空态段尾状态显示行，2026-09-09 定案
      // 状态标识与工具行同一行）；已处理/被打断段 = groupTools（连续工具合并概括折叠，思考/旁白/
      // 引导原位穿插）。2026-08-30 恢复 182358 形态（v163 stackBody 重写误删工具折叠，用户实测
      // 「工具行折叠的功能消失」退回）。处理中恒渲染（即使空体——刚发消息乐观折叠语义）；完成态空体跳过。
      const bodyHtml = processing ? liveFoldBody(foldItems, vacuumState, vacuumStart) : groupTools(foldItems)
      if (bodyHtml || processing) {
        // dur 计时（CLI spinner 对应物）：t1=段开启消息 ts（开启消息/新回合段首引导），endTs=回复落盘 ts/段末 ts
        const t1 = (s.user && s.user.timestamp) || s.startTs || (isFinal ? lastUserTs : 0)
        const endTs = s.replyTs || s.lastTs
        const dur = !processing && t1 && endTs ? fmtDur(Math.round((endTs - t1) / 1000)) : ''
        // 处理状态行：summary「正在处理 + 总时长」（处理中）/ 终态词 + 摘要计数 + 时长（完成）。
        // 借鉴 dsh 轮次过程折叠（TurnProcessNodeView）三处：
        //  ①终态词区分「已处理 / 已停止」（dsh aborted 用 message.stopped；「处理失败」需后端 end reason，暂缺）；
        //  ②摘要计数（工具调用/提问，0 值省略；dsh 三段式 messageCount/toolCallCount/subagentCount）；
        //  ③无面向用户正文的回合默认展开、收口不自动折叠（dsh「关闭时没有最终正文的轮次保留全部过程证据」）。
        // 真空期（思考/生成/压缩）状态显示行仍由 liveFoldBody 并入尾组 summary，无响应红标挂暂态层。
        const totalSec = processing && t1 ? Math.max(0, Math.round((Date.now() - t1) / 1000)) : 0
        const hasBody = flowParts.length > 0 // 折叠体外是否有面向用户的最终正文（reply 项）
        // 无正文且非正常终止（end_turn/stop_sequence）= 被打断/被新消息取代 → 「已停止」（dsh aborted 语义）
        const stopped = !processing && !hasBody && s.finished !== 1
        const nTool = foldItems.reduce((n, it) => n + (it.kind === 'tool' ? 1 : 0), 0)
        const nAsk = foldItems.reduce((n, it) => n + (it.kind === 'ask' ? 1 : 0), 0)
        const cntParts = []
        if (nTool) cntParts.push(nTool + ' 次工具调用')
        if (nAsk) cntParts.push(nAsk + ' 次提问')
        const cnt = !processing && !stopped && cntParts.length ? `<span class="d-count">${cntParts.join(' · ')}</span>` : ''
        const stateHtml = processing
          ? `正在处理<span class="d-dur"> ${fmtDur(totalSec)}</span>`
          : stopped
            ? '已停止'
            : `已处理${cnt}${dur ? `<span class="d-dur"> ${dur}</span>` : ''}`
        // 无正文回合默认展开（data-nobody 供 live.js 增量重建时抑制收口自动折叠）
        const openWhenIdle = !hasBody
        segHtml += `<details class="done-fold${processing ? ' done-live' : ''}" data-m="${s.key}" data-t="f"${processing || openWhenIdle ? ' open' : ''}${!processing && openWhenIdle ? ' data-nobody="1"' : ''}><summary><span class="d-chev">${CHEV}</span>${processing ? '<span class="df-dot"></span>' : ''}${stateHtml}</summary><div class="done-body">${bodyHtml}</div></details>`
        lastNode = { key: s.key, type: 'f' }
      }
      // 流内项（按落盘序）：引导气泡 + 回复气泡（data-t 精确值供下段 prev 锚点查询命中）
      for (const p of flowParts) {
        segHtml += p.html
        lastNode = { key: s.key, type: p.type }
      }

      // 段末文件变更汇总卡片（回合内 Edit/Write 的真实增删行数）
      if (s.changes && s.changes.size) {
        segHtml += renderChangeCardHtml(s.changes, s.key)
        lastNode = { key: s.key, type: 'c' }
      }
      html += segHtml
      lastSegInfo = { key: s.key, html: segHtml, prev: segPrev, processing }
    }

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (isContinuationMsg(m)) {
        // 压缩/自动摘要标记（2026-08-27 二轮修正）：不再产生任何可见行——曾以 note 吸进折叠或
        // 居中系统提示，都会打断实时工具折叠行的展示（用户实测）。现在处理中段记 lastStep=
        // 'compact'，由 liveFoldBody 纯空窗兜底附加闪烁「正在压缩会话中……」状态显示行
        // （与「正在思考」同机制）；段间/已完成则静默吞行——数据层不剔 isCompactSummary 续接记录，拦截必须留。
        if (seg && !seg.finished) seg.lastStep = 'compact'
        continue
      }
      if (m.role === 'system') {
        // 无发布者的系统提示：中断当前段并居中展示
        closeSeg(false)
        const txt = m.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('\n').trim()
        html += `<div class="msg system" data-m="s${i}" data-t="s">${esc(txt || '系统消息')}</div>`
        lastNode = { key: 's' + i, type: 's' }
        continue
      }
      if (isRealUser(m)) {
        // 2026-08-30 共同后端定案（接力文档清单#4①）：切段由语义事件驱动——injected:true
        // （queued_command attachment 注入，filterConversationForDisplay 权威输出）= 回合中
        // 引导 → 归当前未收尾段 guides（weave 织入折叠体内部，记 pos=织入 items 流的下标）。
        // 无未收尾段的孤儿注入 → 不开新回合段（user:null，引导为折叠体首元素，兜底防吞）。
        // 非 injected 真实 user = dequeue 消费落盘的开启消息 → 永远开新段并立即计时。
        // 原「段未收尾到来的真实 user 一律吸 guides」启发式删除——它是排队消息被渲染成
        // 引导气泡的根因（102156 二轮实测），排队语义现由置底排队区承担。
        if (m.injected === true) {
          if (seg && !seg.finished) {
            if (!seg.guides) seg.guides = []
            seg.guides.push({ m, i, pos: seg.items.length })
            if (m.timestamp) seg.lastTs = m.timestamp
            continue
          }
          closeSeg(false)
          seg = { user: null, guides: [{ m, i, pos: 0 }], items: [], texts: [], lastTs: m.timestamp || null, startTs: m.timestamp || 0, key: i, thinks: [], lastTool: null, lastAsk: null, pendingTools: [], changes: new Map(), lastStep: null }
          continue
        }
        closeSeg(false)
        // 2026-09-06 撤回链：restoredFlags 命中该 user（落盘早于标记时刻且文本一致）→ 渲染层跳过
        // ——jsonl 不删（CLI rewind 只动内存+换 conversationId），气泡由渲染权威按标记永久不渲染。
        const rst = live.restoredFlags.get(live.curUuid)
        let userSkipped = false
        if (rst && (m.timestamp || 0) <= rst.ts) {
          const ut = (m.blocks || []).filter((b) => b.kind === 'text').map((b) => b.text).join('')
          if (ut.trim() === rst.text.trim()) userSkipped = true
        }
        seg = { user: userSkipped ? null : m, guides: [], items: [], texts: [], lastTs: null, startTs: m.timestamp || 0, key: i, thinks: [], lastTool: null, lastAsk: null, pendingTools: [], changes: new Map(), lastStep: null } // lastStep=段尾最新动作类型（thinking/tool/result/ask/text），真空期「正在思考」占位判定用
        continue
      }
      if (!seg) seg = { user: null, guides: [], items: [], texts: [], lastTs: null, startTs: m.timestamp || 0, key: i, thinks: [], lastTool: null, lastAsk: null, pendingTools: [], changes: new Map(), lastStep: null }
      const hasText = m.blocks.some((b) => b.kind === 'text' && b.text && b.text.trim())
      const hasTool = m.blocks.some((b) => b.kind === 'tool_use')
      for (const b of m.blocks) {
        // 思考块进 items 并记索引（s.thinks 供处理中段 running 态定位）；单块放行由数据层保证
        //（prompt 全剔/transcript 单全局/prompt-tail-think 尾巴单块），前端不再二次折叠（P2 删留尾兜底）
        if (b.kind === 'thinking') { seg.thinks.push(seg.items.length); seg.items.push({ kind: 'think', text: b.text, html: lazy ? '' : thinkRowHtml(b.text, false) }); seg.lastStep = 'thinking' } // 思考块：lastStep='thinking'（旁白走 text 分支，严格分流）
        else if (b.kind === 'text' && hasTool && b.text && b.text.trim()) {
          // 工具消息里的旁白文本：按块原位插入 items（保持 content 数组顺序——旁白在其对应工具调用之上），
          // 不统一沉到段尾；纯文本消息（无 tool_use）仍在循环后整体追加（保持同消息多 text 块拼接为一条的语义）。
          // end_turn/stop_sequence 正式回复（理论不带 tool_use，防御分支）→ 流内 reply 气泡，不进 texts
          if (isEndStop(m.stopReason)) {
            seg.items.push({ kind: 'reply', html: lazy ? '' : replyBubbleHtml(seg.key, b.text, m.usage, m.timestamp, m.model), text: b.text, usage: m.usage, model: m.model, ts: m.timestamp })
            seg.replyTs = m.timestamp
          } else {
            seg.items.push({ kind: 'text', html: '', text: b.text })
            seg.texts.push({ text: b.text, ts: m.timestamp, idx: seg.items.length - 1 })
          }
          seg.lastStep = 'text' // 工具消息内旁白 ≠ 思考
        }
        else if (b.kind === 'tool_use') {
          if (b.name === 'AskUserQuestion') {
            // 提问块 → DSH 风格提问卡（答案由后续 tool_result 文本吸附）
            const it = { kind: 'ask', name: 'AskUserQuestion', zh: '提问', input: b.input, answer: null, html: lazy ? '' : askLineHtml(false) }
            seg.items.push(it)
            seg.lastAsk = it
            seg.lastStep = 'ask'
          } else {
            const t = toolMeta(b); seg.items.push({ kind: 'tool', html: lazy ? '' : toolLine(b), block: b, name: t.name, zh: t.zh }); seg.lastTool = b.name; seg.pendingTools.push(seg.items.length - 1); seg.lastStep = 'tool' // 待完成工具队列（FIFO：连续多个 tool_use 全部登记，tool_result 按序逐个标记 done）
          }
        }
        else if (b.kind === 'tool_result') {
          // 文件变更（2026-08-23 起）：源码 conversationDisplay.ts 输出结构化 fileChange（Edit/Write
          // 真实增删行数，权威 = diff.ts sumLinesChanged），优先消费；parseFileChange 正则反解仅作
          // 旧网关/旧数据兜底（新 exe 部署后可删）。聚合文件变更 → 段末汇总卡片
          const fc = normalizeFileChange(b.fileChange) || parseFileChange(b.text); if (fc) mergeChanges(seg.changes, fc)
          // 2026-08-26 实时折叠：该工具步已收到结果 → 标记 done，groupTools/liveFoldBody 对完成的工具步
          // 显示为普通文本行（「当这一步工具调用完成后，折叠为文本」，不再显示「正在运行」）
          if (seg.pendingTools.length) { const pi = seg.pendingTools.shift(); seg.items[pi].done = true }
          seg.lastStep = 'result'
          // AskUserQuestion 答案关联：最近的未回答提问卡吸附该 tool_result 文本并标出所选
          if (seg.lastAsk && seg.lastAsk.answer == null && b.text) {
            seg.lastAsk.answer = String(b.text)
            seg.lastAsk.html = askLineHtml(true) // 已答 → 「提问 · 已回答」
          }
        }
      }
      if (hasText && !hasTool) {
        // 纯文本消息：end_turn/stop_sequence 正式回复 → 流内 assistant 气泡（reply 项，B 缺陷根治：end_turn 后
        // 继续有工具调用时回复不再被沉进折叠体；多轮 end_turn 各自原位气泡）。旧数据无 stopReason
        // 字段 → 纯文本=回复（与现行 finished 启发式同口径迁移）。其余为过程旁白 → 占位进 items，
        // closeSeg 时原位填充。
        const text = m.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('')
        if (m.stopReason === undefined || isEndStop(m.stopReason)) {
          seg.items.push({ kind: 'reply', html: lazy ? '' : replyBubbleHtml(seg.key, text, m.usage, m.timestamp, m.model), text, usage: m.usage, model: m.model, ts: m.timestamp })
          seg.replyTs = m.timestamp
        } else {
          seg.items.push({ kind: 'text', html: '', text })
          seg.texts.push({ text, ts: m.timestamp, idx: seg.items.length - 1 })
        }
        seg.lastStep = 'text' // 纯文本旁白/回复（无 tool_use 的消息）≠ 思考
      }
      // finished = 段已收尾判定。2026-08-26 起优先用 stopReason（源码 conversationDisplay 新增，
      // 'end_turn'/'stop_sequence' = 正式回复 = 回合结束（stop_sequence=第三方商正常终止，
      // 2026-08-31 补）；'tool_use'/null = 处理中，旁白/工具步保持「正在处理」）——
      // 精确区分「过程旁白纯文本」与「正式回复」，根治旁白中段误判成已处理（实时折叠闪「已处理」）。
      // 注意：stopReason=null（旁白，JSON 保留 null）也要算「处理中」；仅字段缺失（旧数据 undefined）回落
      // 旧启发式：纯文本回复（无 tool_use）= 收尾。
      if (m.role === 'assistant') {
        seg.finished = m.stopReason !== undefined ? (isEndStop(m.stopReason) ? 1 : 0) : (hasText && !m.blocks.some((b) => b.kind === 'tool_use') ? 1 : 0)
      }
      if (m.timestamp) seg.lastTs = m.timestamp
    }
    // 末尾待答提问在消息流里由紧凑行表达（askLineHtml「提问 · 等待回答」，见 b.name==='AskUserQuestion' 分支）；
    // 2026-09-11 ④ 起不再向上报 pendingAskInput（只读接管卡已移除，见 askLineHtml 注释）。
    closeSeg(true)
    // 2026-09-07 用户定案：空会话不再渲染「暂无 user/assistant 记录」占位行——该界面让会话
    // 出现「空态/内容态」两种视觉状态；移除后空会话消息区即纯空白，状态统一。
    return html
  }

