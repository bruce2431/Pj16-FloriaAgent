// 命令菜单 + 项目 seat + 风险确认门（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { I } from '../core/icons.js'
import { relTime } from '../core/markdown.js'
import { mentionPathToken } from '../core/mention-syntax.js'
import { findSession, hashOf } from '../engine/sessions.js'
import { inputEl, state, ALL } from '../engine/state.js'
import { esc, toast, isTouch, newSessionProject } from '../core/util.js'
import { pendingImages, uploadedMentionItems } from './images.js'
import { MENTION_PLUGIN_ICON, MENTION_SESSION_ICON, MENTION_SKILL_ICON, MENTION_UP_ICON, buildMentionChip, closeMentionPop, groupOf, mention, mentionChipIcon, mentionItems, pick, pickAll, pickEnter, pickHome, pickItems, pickLabel, pickSearchKick, refreshPick, resetMention, selectMentionItem, serializeInput } from './mention.js'
import { MODEL_CUR, closeModelPop } from './model-select.js'
import { syncGwSend } from './send.js'
import { MGR, ensureProjectSkills, loadMgrData, MODELS, projSkillsOf } from '../sidebar/mgr-data.js'
/* @module inputbar/commands.js */
  // ---------- 命令菜单 + 模型选择（2026-08-21 dsh 输入栏逻辑移植）----------
  // ⚠️ 数据源 = 本地内置展示数据（⚠️ 非 dsh 真实注册表、非网关接口）：
  // 网关暂无 /gateway/commands 与 /gateway/models，命令列表/模型目录先本地内置供 UI 审阅——
  // 命令 = floria(Claude Code) 真实斜杠命令（claim=带参数/bare=直接执行/risk=需确认门），
  // 模型目录 = 真实 Claude 模型（对齐 dsh ModelDirectory：provider 分组 + reasoning.defaultEffort/efforts[]）。
  // 待网关接口就绪后替换数据源，交互逻辑不变。
  const MOCK_COMMANDS = [
    { name: 'compact', desc: '压缩当前会话上下文', claim: true },
    { name: 'model', desc: '切换模型', claim: true },
    { name: 'permission', desc: '调整权限模式', claim: true },
    { name: 'plan', desc: '进入计划模式', claim: true },
    { name: 'rename', desc: '重命名会话', claim: true },
    { name: 'resume', desc: '继续子代理会话', claim: true },
    { name: 'retry', desc: '重试上一条消息', bare: true },
    { name: 'status', desc: '会话状态', bare: true },
    { name: 'skills', desc: '查看可用技能', bare: true },
    { name: 'plugins', desc: '查看插件清单', bare: true },
  ]
  // 推理等级（全局：Off/Low/High/Max，对齐 CLI effortValue 语义；Off=不发送 effort 参数。2026-08-22 由 per-model reasoning 改为全局）
  const EFFORT_LEVELS = [
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max' },
  ]
  // 模型目录（真实凭据池，与 floria MGR 模型 tab 同源）：2026-08-29 直接切模型自动切供应商 →
  // 全池模型可选（items 内 src 以「凭据池」开头的行，跨商直选由网关自动切供应商）；回落 providerModels → items。
  // 2026-08-22 取代 MOCK_MODEL_DIR（anthropic 上游）。

/* @module inputbar/commands.js #2 */
  // mentionMode = 本弹窗由输入 @ 唤起（2026-10-25 用户定案：工具栏是 @ 与 + 的唯一弹窗）。
  // 该模式下查询词取 mention.q（@ 后到光标的文本）、结果扁平按时间混排、选中写回 @ 锚点；
  // 非 mention 模式（= + 打开）才走入口视图与首屏。
  const cmd = { open: false, view: '', mentionMode: false, status: 'pending', items: [], active: 0, prevActive: 0, submitting: false, confirming: null, acknowledged: false, error: null }
  // 「+」浮窗的入口视图（2026-10-25 用户定案：扁平分组的工具栏太乱，改为入口形式——首屏只列
  // 上传动作 + 四类入口，点进某一类后展示该类**全部**条目，不截断；底栏有查询词时退回跨类搜索）。
  const CMD_VIEWS = [
    { view: 'session', name: '会话', desc: '引用一个会话', icon: MENTION_SESSION_ICON },
    { view: 'file', name: '文件', desc: '浏览工作区文件与目录', icon: I.dshFolder },
    { view: 'skill', name: '技能', desc: '引用插件或技能', icon: MENTION_SKILL_ICON },
    { view: 'cmd', name: '指令', desc: '运行斜杠命令', icon: I.dshPlus },
  ]
  // 过滤查询唯一来源 = 底栏输入框文本（2026-10-14 待办 20 返修）：弃独立搜索框——旧框每次 input 都
  // innerHTML 重渲并**重建框自身**，IME 组合期被打断 = 中文打不进；底栏文本驱动则渲染只碰浮窗，
  // 底栏 contenteditable 原样不动，中文 IME 正常。命令前缀 / 由 cmdEntries 剥。
  function barQuery() {
    return serializeInput().trim()
  }
  // 模型菜单状态（对齐 dsh ModelSelect Pane：root | model | effort）
  const msel = { open: false, pane: 'root', active: 0 }
  const cmdPop = $('cmd-pop')
  const modelPop = $('model-pop')
  const modelSeatEl = $('model-seat')

  // ---- 项目选择器（2026-09-02）：初始界面工具行 + 右侧切换目标项目 ----
  // 数据源=侧栏项目同款（ALL 按 projectLabel 分组派生，最近活跃降序）；选中=state.newProject
  // （与侧栏项目「+」同链路：首条消息发送时 /gateway/wsession 带 project → 会话落该项目根）。
  // 全局行=清回默认（同 chip X）。仅初始界面显示（CSS：#empty-hint 内才 display:flex）。
  const psel = { open: false }
  const projPop = $('proj-pop')
  const projSeatEl = $('proj-seat')
  projSeatEl.querySelector('.projIco').innerHTML = I.folder
  projSeatEl.querySelector('.chevron').innerHTML = I.dshChevDown
  function projList() {
    const byProject = {}
    for (const s of ALL) if (s.projectScope === 'project' && s.projectLabel) (byProject[s.projectLabel] = byProject[s.projectLabel] || []).push(s)
    return Object.keys(byProject).sort((a, b) => {
      const la = Math.max(0, ...byProject[a].map((s) => s.updatedAt))
      const lb = Math.max(0, ...byProject[b].map((s) => s.updatedAt))
      return lb - la
    })
  }
  // seat 只读的两个态：①会话态（工作文件夹 = 该会话所属项目）②work 模式且已选工作项目——在项目中
  // 工作就只能在该项目建会话，目标项目不可改（唯一判定点，seat 渲染与点击守卫共用）。
  function projSeatLocked() {
    return !!state.currentHash || (state.sbMode === 'work' && !!state.workProj)
  }
  function renderProjSeat() {
    const locked = projSeatLocked()
    // 锁定态收口：已展开的选择层即刻收起——否则切到 work 模式（或进会话）时残留的浮层仍可点，
    // 选中的目标项目在锁定态根本不生效，读起来像「改了没反应」。
    if (locked) closeProjPop()
    const s = state.currentHash ? findSession(state.currentHash) : null
    const label = state.currentHash
      ? (s && s.projectScope === 'project' && s.projectLabel ? s.projectLabel : '全局')
      : (newSessionProject() || '全局')
    projSeatEl.querySelector('.projLabel').textContent = label
    projSeatEl.title = locked ? '工作文件夹：' + label : (newSessionProject() ? '目标项目：' + newSessionProject() : '目标项目：全局（默认）')
    projSeatEl.classList.toggle('locked', locked)
  }
  function renderProjPop() {
    if (!psel.open) return
    const rows = ['<div class="row" data-p=""><span class="pIco">' + I.pen + '</span><span class="pLabel">全局（默认）</span>' + (state.newProject ? '' : '<span class="check">' + I.dshCheck + '</span>') + '</div>']
    for (const l of projList()) {
      rows.push('<div class="row" data-p="' + esc(l) + '" title="' + esc(l) + '"><span class="pIco">' + I.folder + '</span><span class="pLabel">' + esc(l) + '</span>' + (state.newProject === l ? '<span class="check">' + I.dshCheck + '</span>' : '') + '</div>')
    }
    projPop.innerHTML = rows.join('')
    projPop.querySelectorAll('.row').forEach((r) =>
      r.addEventListener('click', () => {
        state.newProject = r.dataset.p || null
        renderProjSeat()
        closeProjPop()
      }))
    projPop.hidden = false
  }
  function openProjPop() {
    if (cmd.open) closeCmdPop()
    if (msel.open) closeModelPop()
    closeMentionPop()
    psel.open = true
    renderProjPop()
  }
  function closeProjPop() {
    if (!psel.open) return
    psel.open = false
    projPop.hidden = true
  }
  projSeatEl.addEventListener('click', () => {
    if (projSeatLocked()) return // 锁定态：工作文件夹标识只读，不弹选择层
    psel.open ? closeProjPop() : openProjPop()
  })

  // 逐命令字形（同 dsh ui-commands presentation.ts 的 HOST_FACES 语义：每个内置命令各有图标，
  // 不是整列共用一个「+」）。表外命令回落 dshPlus。字形来源与说明见 core/icons.js 同段注释。
  const CMD_ICON = {
    compact: I.dshCompact,
    model: I.dshSliders,
    permission: I.dshShield,
    plan: I.dshPlan,
    rename: I.dshEditOutline,
    resume: I.dshPlay,
    retry: I.dshRefresh,
    status: I.dshGauge,
    skills: MENTION_SKILL_ICON,
    plugins: MENTION_PLUGIN_ICON,
  }

  // ---- 命令菜单（dsh PopupSelectController 移植：open→加载一次→本地过滤→高亮→选择→确认门）----
  // 2026-09-09 二轮：统一条目 = 图片选择行（恒首位）+ 技能（MGR.skills.personal，/gateway/plugins）
  // + 近 48h 会话（同 @ 提及链）+ 命令（MOCK_COMMANDS）；搜索滤 name/desc（图片行恒显）。
  // 会话行（会话入口与搜索共用）：sid = 会话间协作的寻址键，两个路口径必须一致（同 @ 提及链）。
  function cmdSessionRows(match, grp) {
    const out = []
    for (const s of [...ALL].sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (match && !match(s.title || '')) continue
      out.push({ kind: 'session', name: s.title || '未命名会话', sid: hashOf(s), desc: relTime(s.updatedAt), grp })
    }
    return out
  }
  // 行尾项目标记：项目 label 取编号前缀（`Pj8-工作区机械臂设计` → `Pj8`），无编号则整串。
  function projTag(label) {
    const m = /^((?:Sub)?Pj\d+)/i.exec(String(label || ''))
    return m ? m[1] : String(label || '')
  }
  // 技能行 = 插件 + 技能（MGR 同源）+ **当前项目自己的技能**（项目根 .claude/skills，行尾标项目名）。
  // 项目判定与 + 浮窗文件组同一处（pickHome：会话所属项目 / work 工作项目，空串 = 无项目上下文）。
  function cmdSkillRows(match, grp) {
    const out = []
    const proj = pickHome()
    const ps = projSkillsOf(proj)
    if (ps.list.length) {
      for (const s of ps.list) if (!match || match(s.n) || match(s.d)) out.push({ kind: 'skill', name: s.n, desc: s.d, grp, proj })
    }
    if (!MGR) return out
    for (const p of (MGR.plugins && MGR.plugins.personal) || []) if (!match || match(p.n) || match(p.d)) out.push({ kind: 'plugin', name: p.n, desc: p.d, grp })
    for (const s of (MGR.skills && MGR.skills.personal) || []) if (!match || match(s.n) || match(s.d)) out.push({ kind: 'skill', name: s.n, desc: s.d, grp })
    return out
  }
  // 全局文件清单是流式产出的（BFS 每批即并入）：跑完且零命中才报「无匹配」，未跑完就在尾部挂
  // 「搜索中…」——有命中照常列出，用户不必干等全量索引。base = 推入搜索结果前的行数（文件视图无「返回」行）。
  // 文件索引（pickAll）流式进度只影响「正在展示文件结果」的视图（文件视图 / @ 跨类搜索）；
  // 其余视图（技能/会话/指令/首屏）不因索引进度整块重渲。
  function pickProgressRenders() {
    return cmd.view === 'file' || (cmd.mentionMode && !cmd.view && !!mention.q.trim())
  }
  function pushSearchState(items, base) {
    if (pickAll.err) { items.push({ kind: 'pathwait', name: '索引失败', desc: pickAll.err }); return }
    if (!pickAll.done) { items.push({ kind: 'pathwait', name: '搜索中…', desc: '正在索引工作区' }); return }
    if (items.length === (base || 0)) items.push({ kind: 'pathwait', name: '无匹配结果', desc: '' })
  }
  function cmdEntries() {
    // 查询词：@ 模式 = @ 后到光标的文本；+ 模式 = 底栏全文（剥掉可能的前导 /）。
    const q = (cmd.mentionMode ? mention.q : barQuery()).trim().toLowerCase().replace(/^\//, '')
    const match = (s) => !q || String(s || '').toLowerCase().includes(q)
    const items = []
    // 范围判据（2026-10-25 用户定案）：**进了某一类视图 = 查询只在该类里搜**；没进视图时
    // @ 后有查询词 = 跨类扁平全局搜索（不按类隔离、按时间混排）。只输入 @ 而无查询词 =
    // 等价于唤出工具栏首屏（与 + 一致）。+ 模式底栏文本只过滤当前入口视图，从不触发全局搜索。
    if (cmd.view) {
      // 文件视图不叠「导航/返回」（2026-11-05 用户定案）：它自带「上级目录」，两行同图标上箭头 + 两个分组标题
      // 看着像两栏叠在一起；文件视图的退出走 Esc / 点浮窗外（pathup 行同时承担层内上行）。
      if (cmd.view !== 'file') items.push({ kind: 'back', name: '返回', grp: '导航' })
      if (cmd.view === 'session') items.push(...cmdSessionRows(match, '会话'))
      else if (cmd.view === 'skill') items.push(...cmdSkillRows(match, '技能'))
      // 指令分支必须带花括号：`else if (…) for (…) if (…) push()` 后面再跟 `else if` 会把
      // 它吸附给内层 if（悬垂 else），文件视图分支永远不执行（2026-10-25 根因：@ 点「文件」只剩「返回」）。
      else if (cmd.view === 'cmd') {
        for (const o of MOCK_COMMANDS) if (match(o.name) || match(o.desc)) items.push({ kind: 'cmd', name: o.name, desc: o.desc, ref: o, grp: '指令' })
      }
      // 文件视图：有查询词 = 只搜文件（同一条全局文件清单，不含会话/技能）；空查询 = 层内浏览。
      else if (cmd.view === 'file') {
        if (q) {
          const base = items.length
          items.push(...pickItems(q))
          pushSearchState(items, base)
          pickSearchKick(() => { if (cmd.open) renderCmdPop() })
        } else items.push(...pickItems('').filter((it) => it.kind === 'pathup' || match(it.name)))
      }
      return items
    }
    if (cmd.mentionMode && q) {
      items.push(...mentionItems(q))
      pushSearchState(items)
      pickSearchKick(() => { if (cmd.open) renderCmdPop() }) // 清单未跑完 → 流式补渲
      return items
    }
    // 首屏入口：两个上传动作 + 已上传附件的引用行 + 四类入口
    items.push({ kind: 'imgpick', name: pendingImages.length ? '继续选择图片…' : '选择图片…', desc: pendingImages.length ? `已选 ${pendingImages.length}/9 · 自动压缩` : '一次最多 9 张，自动压缩', grp: '上传' })
    items.push({ kind: 'filepick', name: '上传文件…', desc: '任意类型可多选 · 存入 file-cache/（按会话）', grp: '上传' })
    // 已上传附件的引用行（2026-11-01 根因）：此前只有 @ 后**再输查询词**才经 mentionItems 列出，
    // 首屏看不到刚传的图 → 用户实测「上传的图片 @ 这个渲染缺失」。数据源与 @ 搜索同一份
    // （images.js uploadedMentionItems），只列行不渲缩略图（2026-10-22 定案：缩略图只在底栏胶囊）。
    items.push(...uploadedMentionItems().map((it) => ({ ...it, desc: it.attKind === 'img' ? '插入图片引用' : '插入文件引用', grp: '上传' })))
    // 首屏四个入口是导航不是数据：底栏有文字也不过滤（否则「有文字点 +」会只剩上传两行，像坏了）
    for (const v of CMD_VIEWS) items.push({ kind: 'entry', view: v.view, name: v.name, desc: v.desc, icon: v.icon, grp: '浏览' })
    return items
  }
  // 弹窗的**唯一开链**（2026-10-25 用户定案：输入 @ 触发与底栏点 + 完全同一条链路，不另写）。
  // mentionMode 只决定查询词来源（@ 后文本 vs 底栏全文）；有无查询词由 cmdEntries 判：
  // 无词 = 首屏入口（与 + 一致），有词且在 @ 模式 = 扁平全局搜索。
  function openCmdPop(mentionMode) {
    const fresh = !cmd.open
    if (msel.open) closeModelPop()
    if (!mentionMode) closeMentionPop()
    cmd.open = true
    cmd.mentionMode = !!mentionMode
    cmd.view = '' // 每次打开都回首屏入口（手势起点一致）
    cmd.status = 'ready'
    cmd.active = 0
    cmd.confirming = null
    cmd.acknowledged = false
    cmd.error = null
    renderCmdPop()
    // 过滤在底栏打字（待办 20 返修）：焦点回底栏，用户继续输入列表即变；触屏不抢焦点（iOS 弹键盘，
    // 与旧搜索框同一处置——用户自己点输入框唤起）。@ 唤起时光标本就在底栏，不重复聚焦。
    if (!mentionMode && !isTouch()) composerFocus()
    if (fresh) {
      // 首次打开确保技能清单/目录层已加载（异步），加载完用当前状态重渲
      loadMgrData().then(() => { if (cmd.open) renderCmdPop() }).catch(() => {})
      // 当前项目自己的技能（按 label 缓存，同一项目只拉一次）：落地后重渲技能组。
      ensureProjectSkills(pickHome()).then(() => { if (cmd.open) renderCmdPop() }).catch(() => {})
      refreshPick(() => { if (cmd.open && pickProgressRenders()) renderCmdPop() })
    }
  }
  function openCmdPopMention() { openCmdPop(true) }
  function toggleCmdPop() {
    if (cmd.open) { closeCmdPop(); return }
    openCmdPop(false)
  }
  function closeCmdPop() {
    if (!cmd.open) { cmd.mentionMode = false; return }
    cmd.open = false
    cmd.mentionMode = false
    cmd.confirming = null
    cmd.acknowledged = false
    cmdPop.hidden = true
    // @ 锚点/查询词随弹窗一起复位（resetMention 只碰数据，不回调本函数，无环）
    resetMention()
    const rm = $('risk-modal')
    if (!rm.hidden) closeRiskModal()
  }
  function renderCmdPop() {
    if (!cmd.open) return
    // dsh confirmation gate：确认态下命令卡隐藏，改由全屏 RiskConfirmation 模态接管
    if (cmd.confirming) { cmdPop.hidden = true; renderRiskModal(); return }
    // 单页分组渲染（无 tab）：四组行列表；已选附件缩略图不在本浮窗重复显示（见下）。
    // 独立搜索框已退役（2026-10-14 待办 20 返修）：过滤文本 = 底栏输入框（barQuery），列表随底栏
    // 打字自动变化（ctx-meter 在底栏 input 事件里调 renderCmdPop）。
    cmd.items = cmdEntries()
    // 视图切换/查询变化后条目数会变：高亮下标夹回合法区间，否则回车会选中 undefined。
    cmd.active = Math.min(cmd.active, Math.max(0, cmd.items.length - 1))
    // 滚动位置跨重渲保持（2026-11-05 根因）：列表在文件索引流式进度/数据落地时会整体重渲，
    // 旧实现每次 innerHTML 重建 .viewport（scrollTop 归零）+ 无条件 scrollIntoView 高亮行（多为第 0 行）
    // ⇒ 用户拖条/滚轮后立刻被打回顶部，表现为「根本划不动」。现在搬运旧滚动量，
    // 且只有**高亮行真的变了**（键盘/点击导航）才把它滚进视野。
    const prevVp = cmdPop.querySelector('.viewport')
    const keepTop = prevVp ? prevVp.scrollTop : 0
    const prevActive = cmd.prevActive
    let html = ''
    if (cmd.error !== null) {
      html += `<div class="error" role="alert"><span class="errorText">${esc(cmd.error)}</span>${cmd.status === 'failed' ? `<button type="button" class="retry">重试</button>` : ''}</div>`
    } else {
      // 待发附件的唯一可见回显 = 底栏 `#img-pills`（inputbar/images.js renderImgPills）；
      // 本浮窗只做选择/上传入口，不再重复渲染缩略图（2026-10-22 用户实测：同一批图在浮窗与底栏各出现一次）。
      // 搜索结果（@ 后有查询词）= 扁平时间线，不印分组标题（用户定案「不隔离」）；@ 无词/+ 模式 = 入口视图分组。
      // 未进视图的跨类搜索才是扁平时间线；进了某类视图仍按组显示（导航行与该类标题）。
      const flat = cmd.mentionMode && !cmd.view && !!mention.q.trim()
      let lastGrp = ''
      html += `<div role="listbox" class="viewport">${cmd.items.map((it, i) => {
        const g = it.grp || groupOf(it)
        const grp = g === '文件' ? '文件 · ' + pickLabel() : g
        const gh = flat || grp === lastGrp ? '' : `<div class="grp">${esc(grp)}</div>`
        lastGrp = grp
        const on = i === cmd.active ? ' rowActive' : ''
        const ico = it.kind === 'entry' ? it.icon : it.kind === 'back' ? MENTION_UP_ICON : it.kind === 'attref' ? (it.attKind === 'img' ? I.dshImage : I.dshPaperclip) : it.kind === 'imgpick' ? I.dshImage : it.kind === 'filepick' ? I.dshPaperclip : it.kind === 'plugin' ? MENTION_PLUGIN_ICON : it.kind === 'skill' ? MENTION_SKILL_ICON : it.kind === 'session' ? MENTION_SESSION_ICON : it.kind === 'pathup' ? MENTION_UP_ICON : it.kind === 'path' ? mentionChipIcon('path', it.ptype) : it.kind === 'pathwait' ? mentionChipIcon('path', 'file') : (CMD_ICON[it.name] || I.dshPlus)
        const label = it.kind === 'cmd' ? `/${it.name}` : it.name
        const detail = it.kind === 'path' ? it.path : it.desc
        const tag = it.proj ? `<span class="projTag">${esc(projTag(it.proj))}</span>` : ''
        return gh + `<button type="button" role="option" aria-selected="${i === cmd.active}" class="row${on}" data-idx="${i}"><span class="rowIco">${ico}</span><span class="label">${esc(label)}</span>${detail ? `<span class="detail">${esc(detail)}</span>` : ''}${tag}</button>`
      }).join('')}</div>`
    }
    cmdPop.innerHTML = html
    cmdPop.hidden = false
    cmdPop.querySelectorAll('.row').forEach(b => b.addEventListener('click', () => { cmd.active = +b.dataset.idx; cmdSelect() }))
    cmdPop.querySelector('.retry')?.addEventListener('click', () => { cmd.error = null; cmd.status = 'ready'; renderCmdPop() })
    const vp = cmdPop.querySelector('.viewport')
    if (vp) vp.scrollTop = keepTop
    if (cmd.active !== prevActive) {
      const on = cmdPop.querySelector('.row.rowActive')
      if (on) on.scrollIntoView({ block: 'nearest' })
    }
    cmd.prevActive = cmd.active
  }
  // 风险确认门（dsh RiskConfirmation + Modal 移植）：全屏遮罩 + 居中对话框，checkbox 勾选后才可确认
  function renderRiskModal() {
    const o = cmd.confirming
    if (!o) { const m = $('risk-modal'); if (!m.hidden) m.hidden = true; return }
    const rm = $('risk-modal')
    rm.innerHTML = `
      <div class="mask"></div>
      <div class="dialog" role="dialog" aria-modal="true" aria-label="执行 /${esc(o.name)}？">
        <div class="header">
          <h2 class="title">执行 /${esc(o.name)}？</h2>
          <button type="button" class="close" aria-label="关闭">${I.dshClose}</button>
        </div>
        <div class="body">
          <div class="warning">${I.dshWarn}<p>${esc(o.risk)}</p></div>
          <label class="acknowledgement"><input type="checkbox" ${cmd.acknowledged ? 'checked' : ''}/><span>我已了解该操作的风险</span></label>
        </div>
        <div class="footer">
          <button type="button" class="button outline">取消</button>
          <button type="button" class="button primary" ${cmd.acknowledged ? '' : 'disabled'}>确认执行</button>
        </div>
      </div>`
    rm.hidden = false
    const cb = rm.querySelector('.acknowledgement input')
    if (cb) cb.addEventListener('change', () => { cmdAck(cb.checked) })
    // 无需 stopPropagation：外部关闭已改 mousedown+contains（mousedown 在重渲染前命中目标），不再误判（dsh Modal 同语义）
    rm.querySelector('.mask')?.addEventListener('click', () => closeRiskModal())
    rm.querySelector('.close')?.addEventListener('click', () => closeRiskModal())
    rm.querySelector('.outline')?.addEventListener('click', () => closeRiskModal())
    rm.querySelector('.primary')?.addEventListener('click', () => cmdConfirm())
  }
  // 取消确认：清除确认态、恢复命令列表（dsh cancelConfirmation：确认卡关闭、列表重显）
  function closeRiskModal() {
    const rm = $('risk-modal')
    rm.hidden = true
    rm.innerHTML = ''
    cmd.confirming = null
    cmd.acknowledged = false
    renderCmdPop()
  }
  function cmdMove(d) {
    const n = cmd.items.length
    if (!n) return
    cmd.active = (cmd.active + d + n) % n
    renderCmdPop()
  }
  // 统一选择分发（2026-09-09 二轮）：图片行=选图（选完 img-file change 关浮窗）；技能/会话=chip 追加输入栏；
  // 命令=原链（risk→确认门 / settle→写入输入栏）
  function cmdSelect() {
    const it = cmd.items[cmd.active]
    if (!it || cmd.submitting) return
    // 入口视图导航（两个模式共用，必须先于 @ 落地判：否则 @ 里点「文件」会被当成插入 [插件:文件] 胶囊）：
    // 入口行 = 进入该类（此后查询词只在该类里搜）；返回行 = 回首屏。
    if (it.kind === 'entry') { cmd.view = it.view; cmd.active = 0; renderCmdPop(); return }
    if (it.kind === 'back') { cmd.view = ''; cmd.active = 0; renderCmdPop(); return }
    // @ 模式：所有条目都落地到 @ 锚点（含上传附件写回正文、目录下钻重渲）——统一走 mention.js，
    // 与 + 模式的「追加到输入栏末尾」刻意不同（@ 是就地替换查询）。
    if (cmd.mentionMode) { if (it.kind !== 'pathwait') selectMentionItem(it); return }
    if (it.kind === 'imgpick') { $('img-file').click(); return }
    if (it.kind === 'filepick') { $('file-upload').click(); return }
    // 已上传附件引用行（+ 模式）：引用原文追加到输入栏末尾（@ 模式走上方的 selectMentionItem 就地替换）。
    if (it.kind === 'attref') { composerAppendText(it.md + ' '); closeCmdPop(); return }
    if (it.kind === 'pathwait') return // 占位行不可选（清单未就绪）
    // 下钻/返回必须走 pickEnter：它同时把 searchOff 翻回层内浏览模式；只调 loadPickPath 会让
    // pickItems 继续按全局搜索分支渲染，点目录看起来「没反应」。
    if (it.kind === 'pathup' || (it.kind === 'path' && it.ptype === 'dir')) {
      pickEnter(it).then(() => { if (cmd.open) renderCmdPop() })
      return
    }
    if (it.kind === 'path') { appendMentionChip('path', it.path, '', 'file'); closeCmdPop(); return }
    if (it.kind === 'skill' || it.kind === 'plugin') { appendMentionChip('plugin', it.name); closeCmdPop(); return }
    if (it.kind === 'session') { appendMentionChip('session', it.name, it.sid); closeCmdPop(); return }
    const o = it.ref
    if (o.risk) { cmd.confirming = o; cmd.acknowledged = false; renderCmdPop(); return }
    cmdSettle(o)
  }
  // 浮窗直选落地（无 @ 光标锚点）：令牌追加到输入栏末尾 + 尾随空格，光标到末尾（CM6 接管后
  // chip = doc 令牌文本的装饰视图，composerAppendToken 落 doc 即成 chip）。
  function appendMentionChip(kind, name, sid, ptype) {
    const token = kind === 'session'
      ? (sid ? `[会话:${name}|${sid}]` : `[会话:${name}]`)
      : kind === 'path'
        ? mentionPathToken(name, ptype)
        : `[插件:${name}]`
    composerAppendToken(token)
    syncGwSend()
  }
  function cmdAck(v) { cmd.acknowledged = v; renderCmdPop() }
  function cmdConfirm() {
    if (!cmd.confirming || !cmd.acknowledged) return
    const o = cmd.confirming
    cmd.confirming = null
    cmd.acknowledged = false
    cmdSettle(o)
  }
  // 选择落地：把命令文本写入输入栏（claim 带参数提示 / bare 直接插入），回车发送由 CLI 端执行；本地展示同闭环
  function cmdSettle(o) {
    setInputText(o.claim ? `/${o.name} ` : `/${o.name}`)
    closeCmdPop()
    composerFocus()
    toast(`命令已写入输入栏：/${o.name}（回车发送）`)
  }
  // CM6 接管后 = doc 全文替换（composerSetText 内含 readOnly 阀 + 触发 updateListener → syncGwSend）
  function setInputText(text) {
    composerSetText(text)
    syncGwSend()
  }

  // ---- 模型选择（dsh ModelSelect 移植：trigger 显示「模型名 · 推理等级」，root 两行 Model/Effort 各自 drill）----
  // 当前选中模型 id：本地 MODEL_CUR 优先，未同步时回落 MODELS 的 activeModel/model（凭据池同源）
export {
  CMD_GROUP,
  EFFORT_LEVELS,
  MOCK_COMMANDS,
  appendMentionChip,
  closeCmdPop,
  closeProjPop,
  closeRiskModal,
  cmd,
  cmdAck,
  cmdConfirm,
  cmdEntries,
  cmdMove,
  cmdPop,
  cmdSelect,
  cmdSettle,
  modelPop,
  modelSeatEl,
  msel,
  openProjPop,
  projList,
  projSeatLocked,
  projPop,
  projSeatEl,
  psel,
  renderCmdPop,
  renderProjPop,
  renderProjSeat,
  renderRiskModal,
  setInputText,
  toggleCmdPop,
}
