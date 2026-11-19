// 消息渲染基元：工具行/概括折叠/真空状态行（liveFoldBody）+ 状态行判定 + 文件变更判定辅助（子模块见 chat/messages/*）
import { setAttachmentResolver, setImageSrcResolver } from '../core/markdown.js'
import { esc } from '../core/util.js'
import { findSession } from '../engine/sessions.js'
import { live, state } from '../engine/state.js'
import { fmtDur } from './messages/msg-actions.js'
import { toolIcon } from './messages/icons.js'
/* @module chat/messages.js */
  // ---------- 消息渲染 ----------
  // AI 生成图取图 URL 解析（2026-10-03）：模型输出 ![](code)（code = 该项目根 .claude/images/ 下的文件名），
  // 把代号拼成网关取图 URL——复用 GET /gateway/file?label=<会话 label>&path=<相对路径>。
  // label 直接取会话自带 projectLabel：项目会话=<项目名>、全局根会话=「全局根 · 散装对话」；
  // 网关按 label 把全局项解析到工作区根，故全局会话同样能取图（不再按 scope 筛）。
  // 无 label（会话未找到）→ 返回 null，渲染层保留原文（不兜底）。label 取法同 inputbar/mention.js。
  setImageSrcResolver((code) => {
    const s = findSession(live.curUuid)
    const label = s ? (s.projectLabel || '') : ''
    return label ? `/gateway/file?label=${encodeURIComponent(label)}&path=${encodeURIComponent('.claude/images/' + code)}` : null
  })
  // 附件引用取图（2026-10-24 统一 file-cache）：正文里的 `![](file-cache/<会话id>/x.png)` 是网关签发的
  // rel（基址 = 会话启动根/.claude/file-cache），取字节走 GET /gateway/file-cache/<会话id>/<名>?sid=——
  // dir/uuid 无法区分项目，必须带上当前会话 sid 供网关解出项目根。
  setAttachmentResolver((code) => {
    const sid = state.currentHash
    return `/gateway/${code}` + (sid ? `?sid=${encodeURIComponent(sid)}` : '')
  })
  // 工具名 → 中文动作（弱化行展示，不单独成气泡）
  const TOOL_NAMES = {
    Read: '阅读', Edit: '编辑', Write: '写入', Grep: '搜索', Glob: '查找文件',
    Bash: '运行命令', WebFetch: '抓取网页', WebSearch: '搜索网页',
    NotebookEdit: '编辑笔记', TaskCreate: '创建任务', TaskUpdate: '更新任务',
    TaskGet: '查询任务', Agent: '委派 Agent', Skill: '调用技能', TodoWrite: '更新待办',
    AskUserQuestion: '提问',
  }
  // MCP 工具名 → 短显示名（沿用源码 mcpInfoFromString 的 split('__') 解析约定：
  // mcp__<server>__<tool> 取 tool 段；仅显示层用，权限匹配仍走原始名）。无 tool 段退回 server 名。
  function mcpShortName(name) {
    const parts = name.split('__')
    if (parts[0] !== 'mcp' || !parts[1]) return null
    return parts.slice(2).join('__') || parts[1]
  }
  // 工具块元信息：英文名 + 中文动作 + 详情（命令/路径/搜索词等）
  function toolMeta(block) {
    const name = block.name || 'tool'
    const zh = TOOL_NAMES[name] || mcpShortName(name) || name
    const inp = block.input && typeof block.input === 'object' ? block.input : null
    const detail = inp ? (inp.file_path || inp.filePath || inp.query || inp.pattern || inp.command || inp.toolName || inp.path || '') : ''
    return { name, zh, detail: typeof detail === 'string' && detail ? String(detail).slice(0, 120) : '' }
  }
  // 工具状态行两级展开（用户需求：展开看调用详情，再次点击看更详细的输入和输出）：
  //   一级 = summary 点击 → 入参逐项 + 输出前缀预览；
  //   二级 = 详情内的「输入与输出」折叠 → 完整入参 JSON + 完整输出（限高滚动）。
  // 用嵌套 <details> 承载：开合态由 live.js 的 foldKey 机制（段 + 首个类名 + 段内同类序号）
  // 在全量/增量重建后自动保留，不需要额外状态存储。
  const TOOL_ARG_CLIP = 300 // 一级单个参数值上限
  const TOOL_OUT_PREVIEW_CLIP = 600 // 一级输出预览上限
  const TOOL_JSON_CLIP = 8000 // 二级入参 JSON 上限
  const TOOL_RESULT_CLIP = 20000 // 二级输出上限（pre 内滚动）
  function clipText(s, max) {
    const t = s == null ? '' : String(s)
    return t.length > max ? t.slice(0, max) + `\n…（已截断，原长 ${t.length} 字）` : t
  }
  function argValue(v) {
    if (typeof v === 'string') return v
    try { return JSON.stringify(v) } catch { return String(v) }
  }
  function toolStepHtml(block, result, running) {
    const t = toolMeta(block)
    const inp = block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input : null
    const argRows = inp
      ? Object.keys(inp).map((k) => `<div class="tool-arg"><span class="ta-k">${esc(k)}</span><span class="ta-v">${esc(clipText(argValue(inp[k]), TOOL_ARG_CLIP))}</span></div>`).join('')
      : ''
    const argsHtml = argRows || '<div class="tool-arg"><span class="ta-v">（无参数）</span></div>'
    const out = typeof result === 'string' ? result : ''
    const outPre = out
      ? `<pre class="tool-out-pre">${esc(clipText(out, TOOL_OUT_PREVIEW_CLIP))}</pre>`
      : (running ? '' : '<div class="tool-out-pre ta-empty">（无输出）</div>')
    const jsonText = block.input != null ? clipText(JSON.stringify(block.input, null, 2), TOOL_JSON_CLIP) : '（无参数）'
    const outFull = out ? clipText(out, TOOL_RESULT_CLIP) : (running ? '（运行中，尚无输出）' : '（无输出）')
    const ioHtml = `<details class="tool-io"><summary>输入与输出</summary><div class="tool-io-body"><div class="tool-io-h">输入</div><pre class="tool-pre">${esc(jsonText)}</pre><div class="tool-io-h">输出</div><pre class="tool-pre">${esc(outFull)}</pre></div></details>`
    const sum = `<summary class="tool-line${running ? ' tool-running' : ''}" data-name="${esc(t.name)}"><span class="t-ico">${toolIcon(t.name)}</span><span class="tl-text">${esc(t.zh)}${t.detail ? ' ' + esc(t.detail) : ''}</span></summary>`
    return `<details class="tool-step">${sum}<div class="tool-step-body"><div class="tool-args">${argsHtml}</div>${outPre}${ioHtml}</div></details>`
  }
  // result = 对应 tool_result 文本（未完成/未拿到时 undefined）；running = 实时段运行态行
  function toolLine(block, result) {
    return toolStepHtml(block, result, false)
  }
  // 提问在消息流里的紧凑行（DSH 工具行语义）：icon + 「提问」+ 状态（等待回答 / 已回答）。
  // 2026-09-11 ④ 用户定案移除只读提问卡（`questionCardHtml` 静态不可交互的输入栏接管卡，
  // 「有一个静态的提问卡不可交互的…直接移除就好」）——AskUserQuestion 在 web 只留本紧凑行，
  // 作答在 CLI 窗口；web 可交互提问走 CLI 经审批链下发的 question 分支（renderQuestionApproval）。
  function askLineHtml(answered) {
    return `<span class="tool-line" data-name="AskUserQuestion"><span class="t-ico">${toolIcon('AskUserQuestion')}</span>提问 ${answered ? '已回答' : '等待回答'}</span>`
  }
  // 工具类型 → 概括短语（连续工具折叠的 summary 标签）
  const TOOL_VERB = {
    Read: '阅读了文件', Glob: '查找了文件', Grep: '搜索了代码',
    Bash: '运行了命令', WebFetch: '查看了网页', WebSearch: '搜索了网页',
    Edit: '编辑了文件', Write: '写入文件', NotebookEdit: '编辑了文件',
    Agent: '委派了子代理', Skill: '调用了技能', TodoWrite: '更新了待办',
    TaskCreate: '创建了任务', TaskUpdate: '更新了任务', TaskGet: '查询了任务',
    AskUserQuestion: '提出了问题',
  }
  // 一组工具的概括标签：去重保序 + 「、」/「并」连接，如「编辑了文件并运行了命令（3）」
  function toolFoldLabel(tools) {
    const verbs = []
    for (const t of tools) {
      const v = TOOL_VERB[t.name] || t.zh || '调用了工具'
      if (!verbs.includes(v)) verbs.push(v)
    }
    const label = verbs.length <= 1 ? (verbs[0] || '调用了工具') : verbs.slice(0, -1).join('、') + '并' + verbs[verbs.length - 1]
    return `${label}（${tools.length}）`
  }
  // 把段内 items（think/text/guide/tool 对象）渲染为 done-body 内部 HTML：
  // 连续 tool 合并成一个可展开折叠（默认收起省空间），思考/旁白/引导气泡原位穿插显示（与动作关联）。
  // 2026-08-30 恢复（工具行折叠回归）：v163 stackBody 重写把 groupTools/liveFoldBody 连同折叠
  // 一起删除（用户实测「工具行折叠的功能消失了」，对照 182358 正常版 diff 定位），本函数原样取回；
  // running 判定改用 done 标（现行 items 约定），供被打断段（closeSeg(false)）未完成工具亮 tf-dot。
  function groupTools(items) {
    let html = ''
    let group = []
    const flush = () => {
      if (!group.length) return
      const rows = group.map((g) => g.html).join('')
      const running = group.some((g) => !g.done)
      html += `<details class="tool-fold"${running ? ' data-state="running"' : ''}><summary>${running ? '<span class="tf-dot"></span>' : ''}<span class="tf-label">${esc(toolFoldLabel(group))}</span></summary><div class="tool-fold-body">${rows}</div></details>`
      group = []
    }
    for (const it of items) {
      if (!it || !it.html) continue // 占位/置空的块（reply 占位、被过滤的思考）
      if (it.kind === 'tool') { group.push(it); continue }
      flush()
      html += it.html
    }
    flush()
    return html
  }
  // 「状态行」归属判定（纯函数；2026-09-11 并发复合态根治——探针 probe-concurrent-status 跑本函数真实实现）。
  // 状态行（正在思考/正在生成/正在压缩）表述的是「引擎仍在产出」这一事实，**与「工具在飞」正交**。
  // 旧式把两者绑成互斥（busyOk 含 `!s.pendingTools.length`）→「模型边跑工具边继续产出」的真并发态被压成
  // 二选一，随内容块起点来回翻（用户实测「左侧 search 在闪」；CLI 侧同源判据 MessageRow.isActiveCollapsedGroup
  // 的 `isLoading && !hasContentAfter` 亦按内容块重算）。分档判据即不变量：
  //   ① 无工具在飞 + 无待答提问 + 回合未收口 → 回合未收口即引擎必然在产出（推断成立；原 busyOk 语义原样保留）；
  //   ② 有工具在飞 → 引擎是否仍在产出**不可推断**（工具跑完后引擎可能已收工等结果）→ 取证据 turn-beat 新鲜度：
  //      （此取证只约束**推断档** think/generating；压缩态是 CLI 显式上报的**实证**，自带证据，故判定序在其先，
  //       不受「工具在飞」约束——压缩与工具互斥是巧合而非不变量，把实证挂到推断之后正是本次要根除的互斥绑定。）
  //      REPL setResponseLength 内容增长分支 → notifyTurnBeat（4s 节流；thinking/text/工具参数三类 delta 全汇聚
  //      于此，= messages.ts onUpdateLength 的三处调用点）。新鲜 = 真并发 → 状态行与「正在运行：<工具>」同 summary
  //      并存（liveFoldBody 的 stateAppend 构造期拼接天然支持两行并存，无新渲染分支）。
  // 阈值 6s = 节流窗 4s + 2s 抖动余量；生产流中途 >6s 无 delta 属停摆，归 150s 无响应红标另管（live.js tick）。
  // beat 早于本回合起点视同缺席（上回合残留 beat 对新回合无意义）——与 live.js tick 的回合基线 clamp 同规则。
  const BEAT_FRESH_MS = 6000
  function vacuumOf(s, processing, live, now) {
    if (!processing) return null
    if (s.lastAsk && s.lastAsk.answer == null) return null
    // 压缩实时态（2026-09-04 queue-state 同款链）：压缩进行中 jsonl 零写入（boundary+summary 同毫秒落盘
    // 于结束时刻）→ lastStep 停在 'result'，CLI onCompactProgress → 网关 compact-state SSE 到达即强制压缩态
    // （TTL 5min 防 compact_end 丢失卡死）；结束回退思考态逻辑。显式实证，先于工具在飞取证。
    const cfTs = live.compactFlags.get(live.curUuid)
    if (s.lastStep === 'compact' || (cfTs && now - cfTs < 300000)) return 'compact'
    if (s.pendingTools.length > 0) {
      const beatAt = live.curUuid ? (live.turnBeat.get(live.curUuid) || 0) : 0
      const turnStart = (s.user && s.user.timestamp) || s.startTs || 0
      if (!(beatAt >= turnStart && now - beatAt < BEAT_FRESH_MS)) return null
    }
    // 行为分级文本（2026-09-10 用户定案「根据行为确定状态显示行文本」）：思考落盘/流式、工具结果刚回、
    // 段刚开 → 'think'「正在思考」；旁白已落盘、引擎产出下一动作（典型=生成 tool_use 参数 3~14s）
    // → 'generating'「正在生成」。
    return s.lastStep === 'text' ? 'generating' : 'think'
  }
  // 状态行文案（唯一映射源，2026-09-11 并发复合态定案）：join=false = 独立状态行全称
  // （正在思考/正在生成/正在压缩会话中……）；join=true = 并发尾缀，接在「正在运行：<工具> · <detail>」
  // 之后成同一行同一句（用户原话「思考和搜索同时进行就显示正在搜索xxx并思考」）。
  // 文案经 data-label 落到 DOM，live.js tick 只读该字段补计时，不在第二处复刻 mode→label 映射。
  function vacuumLabel(mode, join) {
    if (mode === 'compact') return join ? '并压缩中' : '正在压缩会话中……'
    if (mode === 'generating') return join ? '并生成' : '正在生成'
    return join ? '并思考' : '正在思考'
  }
  // 僵死/断连红标阈值：引擎最后产出（turn-beat）落后该秒数 = 无产出（live.js tick / approval.js
  // claimTick 同基准，两处共用本常量，不再各写 150）。
  const STALE_SEC = 150
  // 红标文案（唯一构造源，两处 tick 共用）。【2026-09-11 单状态槽定案】用户定案「一次应该只有一个
  // 状态，现在是无响应，应该只有无响应」——红标不再是状态文字旁的**注解**（旧形态前置分隔符「·」，
  // 与状态文字并排 ⇒ 实测出现「正在思考 · 2m57s · 无响应 2m51s」两个状态同时在场），而是状态槽的
  // **唯一占用者**：有红标时调用方给宿主状态行挂 .is-flagged（styles.css 隐去同行 .think-state/
  // .think-stream），故文案不带前导「·」。优先级：连接中断（链路断，一切产出不可信）> 无响应（链路
  // 活而引擎无产出）。staleSec<=0 = 本帧无僵死判定（调用方按各自豁免规则传 0：审批等待/工具在飞）。
  function statusFlags(connUp, staleSec) {
    return (connUp ? '' : '<span class="d-stale">连接中断</span>')
      + (staleSec >= STALE_SEC ? '<span class="d-stale">无响应 ' + fmtDur(staleSec) + '</span>' : '')
  }
  // 实时（处理中）段体（2026-08-26 用户定案：一个工具调用轮次只渲染一个工具折叠行）：
  // 有工具在运行 → summary 显示「正在运行：<当前工具>」+ 光泽扫动，点开看全部工具步明细
  // （已完成行 + 当前运行行）；全部完成 → 折叠概括（与已处理段同形态）。
  // 【状态显示行落位（2026-09-09 用户定案两轮：①「折叠顶只留正在处理/已处理，状态标识
  // 与工具调用行在一起」；②二轮澄清「工具调用行本质=折叠体，子 DOM 分两类——tf-label 工具
  // 概括留存；正在思考/压缩/断连等标识显示动画但不留存」）】：状态显示行 .fold-state（扫光
  // 文字 + data-ts 起点，bindLiveFoldTimer 每秒原地补「· Ns」，流式预览/无响应红标同层）并入
  // 尾部工具折叠行 summary——四轮定案（2026-09-09）真空态并入时折叠顶只留状态显示行、不带已处理
  // 概括（「正在思考时不应再有『运行了命令（N）』」，两状态同行并存=图二实测反例；工具明细
  // 点开折叠仍在）；无状态并入时 summary=toolFoldLabel——单宿主单实例，不复现
  // 09-08 前双轨（尾组 label 原位替换+独立兜底行）的随机命中；折叠顶 summary 恒「正在处理」
  // 不轮转（v267 的 summary 轮转方案废弃）。
  // 思考永不独立成行（if (it.kind === 'think') continue）。引导气泡（kind 'guide'）按非 tool
  // 项原样穿插，打断工具组时组照常收口。
  function liveFoldBody(items, vacuumState, vacuumStart) {
    let html = ''
    let tools = []
    // 状态显示行并入走构造期拼接（2026-09-09 三轮根治）：stateAppend 仅循环后那次
    // flushTools 生效（旁白打断的收口组不带）；v275 的 sumEnd 字符偏移回切废弃——偏移漏算
    // `<details class="tool-fold"><summary>` 前缀 33 字符，插入点前错 33 字符把
    // <span class="tf-label"> 切碎成 `pan class="tf-label">` 纯文本漏出。
    let stateAppend = ''
    let stateMerged = false
    // 状态显示行原子件（唯一构造点）：join=false + withIcon=true → 独立状态行（行首图标槽）；
    // join=true → 并发尾缀，无独立图标（同一行已有工具图标，避免第二个图标槽=视觉堆叠）。
    const stateSpan = (join, withIcon) => {
      const label = vacuumLabel(vacuumState, join)
      return `<span class="think-state${join ? ' ts-join' : ''}" data-ts="${vacuumStart || ''}" data-mode="${vacuumState}" data-label="${esc(label)}">${withIcon ? `<span class="t-ico">${THINK_ICON}</span>` : ''}<span class="ts-text">${esc(label)}</span></span>`
    }
    const flushTools = (isTail) => {
      if (!tools.length) return
      const rows = tools.map((g) => (g.kind === 'tool' && g.done) ? g.html : toolCurHtml(g.block)).join('')
      const running = tools.filter((g) => g.kind === 'tool' && !g.done)
      let sumInner
      if (running.length) {
        // 并发复合态（2026-09-11 用户定案）：状态并入同一行成「正在运行：<工具> · <detail> 并思考」。
        // 旧并列实现把工具行与状态行当 summary 的两个 flex 兄弟，而行容器 .fold-state 是 flex:1 1 0
        // （flex-basis 0 + min-width 0）→ 尺寸只看剩余空间、不看内容：nowrap 的工具文本吃满整行后
        // .fold-state 只剩 ~0.8px，其内无 white-space 规则的短标签逐字换行成竖列（N×22px）→ summary
        // 撑成 ~90px 高的空灰块（受控浏览器实测 summary 716×90、.fold-state 0.8×88、字号 14px）。
        // 根治：唯一行容器 .fold-state 同时承载「运行行（可收缩，.tl-text 省略号收尾）+ 状态尾缀（原子）」，
        // 收缩压力落在工具文本上、尾缀恒完整 → 几何上不可能再出现逐字换行。
        const cur = toolMeta(running[running.length - 1].block)
        const runLine = `<span class="tool-line tool-running" data-name="${esc(cur.name)}"><span class="t-ico">${toolIcon(cur.name)}</span><span class="tl-text">正在运行：${esc(cur.zh)}${cur.detail ? ' ' + esc(cur.detail) : ''}</span></span>`
        if (isTail && vacuumState) {
          sumInner = `<span class="fold-state">${runLine}${stateSpan(true, false)}</span>`
          stateAppend = '' // 已并入本行，防下方 ${stateAppend} 二次追加
          stateMerged = true
        } else {
          sumInner = runLine
        }
      } else if (stateAppend) {
        // 真空态（正在思考/生成/压缩）并入：折叠顶只留状态显示行、不带已处理概括（2026-09-09 四轮定案
        // 「正在思考时不应再有『运行了命令（N）』」，两状态同行并存=图二实测反例）；工具明细点开折叠仍在
        sumInner = ''
      } else {
        sumInner = `<span class="tf-label">${esc(toolFoldLabel(tools))}</span>`
      }
      html += `<details class="tool-fold"><summary>${sumInner}${stateAppend}</summary><div class="tool-fold-body">${rows}</div></details>`
      if (stateAppend) stateMerged = true
      stateAppend = ''
      tools = []
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (!it || !it.html) continue // 占位/置空的块（reply 占位、被过滤的思考）
      if (it.kind === 'think') continue // 思考永不独立成行（真空态=工具行内 .fold-state 状态显示行）
      if (it.kind === 'tool') { tools.push(it); continue } // 完成/运行中的工具都进当前组 → 统一成一个折叠行
      flushTools(false) // 中途被旁白/文本/引导气泡打断的工具组按普通折叠收口（非段尾，不并状态行）
      html += it.html
    }
    // 状态显示行（真空态；2026-09-09 二轮定案：工具调用行=折叠体，tf-label 留存、状态标识暂态不
    // 留存）：有尾部工具组 → .fold-state 暂态层构造期并入其 summary（label 后同一行）；
    // 尾部无工具组（纯思考真空/末尾是旁白）→ 段尾独立行。计时起点=段内最后一条落盘记录时刻。
    let stateInner = ''
    if (vacuumState) {
      // 行首图标槽（2026-09-11 用户定案）：独立状态行与工具行共享同一行首几何（16px 槽 + 5px gap，
      // 图标复用 DSH IconThinkOutline14 原子图标）——同一宿主行在「正在运行：<工具>」⇄「正在思考/
      // 生成/压缩」之间切换时文字左缘零位移（此前状态行无槽，文字回跳 21px = 用户实测「跳动」）。
      // 文本另置 .ts-text 子节点：live.js tick 只更新该节点（整节点 textContent 会连图标槽一起
      // 洗掉 → 槽消失、回跳依旧）。
      stateInner = stateSpan(false, true)
      stateAppend = `<span class="fold-state">${stateInner}</span>`
    }
    // 尾部工具组恒收口（2026-09-10 根治）：旧实现 flushTools() 只写在 vacuumState 分支内，而当时的
    // 判定式含 `!pendingTools.length`（工具在飞恒假）→ vacuumState=null → 该分支不进 → 尾部工具组
    // 整组不产出（无中断项调 flushTools）。实证（受控浏览器页面自采样，前台 Bash 20s 窗口）：
    // .tool-running=0、.tool-fold 数恒定不长、状态行亦空 → 处理中段体整段空白；工具结果
    // 回来那一帧才借真空态 flush 长出折叠行 = 用户实测「工具行只在跑完后才出现 / read、search 更是
    // 根本没有」。收口后 flushTools 内 running 分支（`正在运行：<工具>`）成为可达出口——正是术语
    // 定案里「状态行 = 正在思考/正在生成/正在压缩/正在运行:工具」的一次性实时动画位。不变量：
    // 处理中段的尾部工具组恒有渲染出口，段体空白只允许发生在「无工具且无真空态」的瞬态。
    // 2026-09-11 并发复合态：vacuumState 与 pendingTools 解耦后，「有工具在飞 + 引擎仍在产出」时
    // stateAppend 非空，且被尾组 running 分支取走、并成一行一句（见上方 running 分支注）——
    // 尾组无运行行时 stateAppend 仍走下面普通并存路径（`${sumInner}${stateAppend}`）。
    flushTools(true)
    if (vacuumState && !stateMerged) html += `<div class="fold-state">${stateInner}</div>`
    return html
  }
  // 当前正在运行的工具步（实时段专用）：复用原灰色工具行（tool-line）的 inline 形态，仅加 .tool-running
  // 光泽扫动标识运行态（无蓝点、无 <details> 提示行、无输入 JSON，用户 2026-08-26 定案）。
  function toolCurHtml(block) {
    return toolStepHtml(block, undefined, true)
  }

export {
  CHEV,
  CONTINUED_RE,
  ICON_API,
  ICON_BROWSE,
  ICON_CHECKLIST,
  ICON_COPY,
  ICON_EDIT,
  ICON_GLOBE,
  ICON_SEARCH,
  ICON_SKILL,
  ICON_SPARKLE,
  THINK_CHEV,
  THINK_ICON,
  TOOL_ICONS,
  TOOL_NAMES,
  TOOL_VERB,
  absorbPending,
  addUser,
  askLineHtml,
  baseName,
  charNote,
  ensureLightbox,
  fmtDur,
  getCharNote,
  getLastSegInfo,
  getPendingUserMsgs,
  groupTools,
  isContinuationMsg,
  isEndStop,
  isRealUser,
  lastSegInfo,
  liveFoldBody,
  mcpShortName,
  mergeChanges,
  messageCopyText,
  messagesHtml,
  normalizeFileChange,
  parseFileChange,
  pendingUserMsgs,
  processTextHtml,
  queueClaimAdopt,
  relFromCwd,
  setPendingUserMsgs,
  renderChangeCardHtml,
  stampMsgIn,
  statusFlags,
  thinkRowHtml,
  toolCurHtml,
  toolFoldLabel,
  toolIcon,
  toolLine,
  toolMeta,
  userBodyHtml,
  userImgsHtml,
  userFilesHtml,
  fileCardsHtml,
  writeClipboard,
}
