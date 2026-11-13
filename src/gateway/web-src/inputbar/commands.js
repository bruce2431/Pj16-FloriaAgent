// 命令菜单 + 项目 seat + 风险确认门（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）
// 2026-11-07 工具栏模块化：条目层（toolbar/entries.js）、文件层（toolbar/pick.js）、项目隔离（toolbar/scope.js）
// 已切出；本件只留弹窗外壳（打开/关闭/渲染/导航/落地）与项目 seat。

import { I } from '../core/icons.js'
import { findSession } from '../engine/sessions.js'
import { state } from '../engine/state.js'
import { esc, toast, isTouch, newSessionProject, sessionProjLabel } from '../core/util.js'
import { createProjectPicker } from '../feature/project-picker/project-picker.js'
import { MENTION_PLUGIN_ICON, MENTION_SESSION_ICON, MENTION_SKILL_ICON, MENTION_UP_ICON, closeMentionPop, enterMentionDir, mention, mentionChipIcon, openMentionPopPlus, resetMention, selectMentionItem } from './mention.js'
import { MODEL_CUR, closeModelPop } from './model-select.js'
import { syncGwSend } from './send.js'
import { renderTaskDock } from './approval.js'
import { ensureProjectSkills, loadMgrData, MODELS } from '../sidebar/mgr-data.js'
import { cmdEntries, cmdViewKey, groupOf, pickProgressRenders, projTag } from './toolbar/entries.js'
import { ensureProjectElements } from './toolbar/elements.js'
import { pickEnter, pickLabel, refreshPick } from './toolbar/pick.js'
import { pickHome } from './toolbar/scope.js'
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
  // 工具栏是 @ 与「+」的唯一弹窗（2026-10-25/2026-11-08 用户定案）：两种手势都在底栏留一个锚点
  // （@ 的位置 / + 点击时的光标位置），此后输入的文本即查询词，结果扁平混排、选中替换该区间。
  const cmd = { open: false, view: '', status: 'pending', items: [], active: 0, prevActive: 0, submitting: false, confirming: null, acknowledged: false, error: null, vpKey: '' }
  // 模型菜单状态（对齐 dsh ModelSelect Pane：root | model | effort）
  const msel = { open: false, pane: 'root', active: 0 }
  const cmdPop = $('cmd-pop')
  const modelPop = $('model-pop')
  const modelSeatEl = $('model-seat')

  // ---- 项目选择器（2026-09-02；2026-11-06 与 work 侧栏同构）----
  // 实现 = feature/project-picker/project-picker.js（唯一真源），数据源 = state.projects（后端 findProjects），
  // 与 work 下拉同源同 UI；本处只注入差异：含「全局（默认）」行、选中 = 当前会话归属 / state.newProject、
  // 选定后写 state.newProject（与侧栏项目「+」同链路：首条消息发送时 /gateway/wsession 带 project →
  // 会话落该项目根）。全局行=清回默认（同 chip X）。仅初始界面显示（CSS：#empty-hint 内才 display:flex）。
  const projPop = $('proj-pop')
  const projSeatEl = $('proj-seat')
  projSeatEl.querySelector('.projIco').innerHTML = I.folder
  projSeatEl.querySelector('.chevron').innerHTML = I.dshChevDown
  // seat 只读的两个态：①会话态（工作文件夹 = 该会话所属项目）②work 模式且已选工作项目——在项目中
  // 工作就只能在该项目建会话，目标项目不可改（唯一判定点，seat 渲染与点击守卫共用）。
  function projSeatLocked() {
    return !!state.currentHash || (state.sbMode === 'work' && !!state.workProj)
  }
  const projPicker = createProjectPicker({
    pop: projPop,
    seat: projSeatEl,
    allowGlobal: true,
    canOpen: () => !projSeatLocked(),
    beforeOpen: () => {
      // 打开前收起同一位置上的其它浮层（命令菜单 / 模型菜单 / @ 提及），与原 seat 点击链同口径。
      if (cmd.open) closeCmdPop()
      if (msel.open) closeModelPop()
      closeMentionPop()
    },
    getSelected: () =>
      state.currentHash ? sessionProjLabel(findSession(state.currentHash)) : newSessionProject() || '',
    onPick: (label) => {
      state.newProject = label || null
      renderProjSeat()
    },
  })
  // 对外只读的弹层状态（ctx-meter 的外点关闭用）；开/关语义统一收在组件里。
  const psel = { get open() { return projPicker.isOpen() } }
  function renderProjSeat() {
    const locked = projSeatLocked()
    // 锁定态收口：已展开的选择层即刻收起——否则切到 work 模式（或进会话）时残留的浮层仍可点，
    // 选中的目标项目在锁定态根本不生效，读起来像「改了没反应」。
    if (locked) closeProjPop()
    const s = state.currentHash ? findSession(state.currentHash) : null
    const label = state.currentHash
      ? (s && sessionProjLabel(s) || '全局')
      : (newSessionProject() || '全局')
    projSeatEl.querySelector('.projLabel').textContent = label
    projSeatEl.title = locked ? '工作文件夹：' + label : (newSessionProject() ? '目标项目：' + newSessionProject() : '目标项目：全局（默认）')
    projSeatEl.classList.toggle('locked', locked)
  }
  function renderProjPop() { projPicker.render() }
  function openProjPop() { projPicker.open() }
  function closeProjPop() { projPicker.close() }

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

/* @module inputbar/commands.js #3 */
  // 弹窗的**唯一开链**：输入 @ 与点「+」完全同一条（锚点与查询词由 mention.js 维护）。
  // 有无查询词由 cmdEntries 判：无词 = 首屏入口，有词 = 扁平全局搜索。
  function openCmdPop() {
    const fresh = !cmd.open
    if (msel.open) closeModelPop()
    cmd.open = true
    cmd.view = '' // 每次打开都回首屏入口（手势起点一致）
    cmd.status = 'ready'
    cmd.active = 0
    cmd.confirming = null
    cmd.acknowledged = false
    cmd.error = null
    renderCmdPop()
    // 2026-11-06 D 弹层互斥：工具栏打开即收起任务浮窗（renderTaskDock 见工具栏在场整窗让位；
    // 此时 cmdPop.hidden 已被上方 renderCmdPop 置 false，判据生效）。关闭回程由 closeCmdPop 恢复。
    renderTaskDock()
    // 过滤在底栏打字（待办 20 返修）：焦点回底栏，用户继续输入列表即变；触屏不抢焦点（iOS 弹键盘，
    // 与旧搜索框同一处置——用户自己点输入框唤起）。@ 唤起时光标本就在底栏，不重复聚焦。
    if (fresh && !isTouch()) composerFocus()
    if (fresh) {
      // 首次打开确保技能清单/目录层已加载（异步），加载完用当前状态重渲
      loadMgrData().then(() => { if (cmd.open) renderCmdPop() }).catch(() => {})
      // 当前项目自己的技能（按 label 缓存，同一项目只拉一次）：落地后重渲技能组。
      ensureProjectSkills(pickHome()).then(() => { if (cmd.open) renderCmdPop() }).catch(() => {})
      // 预览页声明的元素（同按上下文缓存）：落地后首屏决定是否出现「元素」入口。
      ensureProjectElements(pickHome()).then(() => { if (cmd.open) renderCmdPop() }).catch(() => {})
      refreshPick(() => { if (cmd.open && pickProgressRenders()) renderCmdPop() })
    }
  }
  function openCmdPopMention() { openCmdPop() }
  function toggleCmdPop() {
    if (cmd.open) { closeCmdPop(); return }
    openMentionPopPlus()
  }
  function closeCmdPop() {
    if (!cmd.open) { resetMention(); return }
    cmd.open = false
    cmd.confirming = null
    cmd.acknowledged = false
    cmdPop.hidden = true
    // 收起即清内容：`.viewport` 连同其 scrollTop 一起消失，下次开窗从顶部起（不把上一轮的
    // 滚动量搬进新一屏——那会让首个分组标题被裁掉半截，用户实报「工具栏又有重叠」）。
    cmdPop.innerHTML = ''
    cmd.vpKey = ''
    // 2026-11-06 D：工具栏收起 → 任务浮窗重新按本会话清单渲染（互斥解除，恢复收敛/展开态）
    renderTaskDock()
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
    // 独立搜索框已退役（2026-10-14 待办 20 返修）：过滤文本 = 底栏输入框，列表随底栏
    // 打字自动变化（ctx-meter 在底栏 input 事件里调 renderCmdPop）。
    cmd.items = cmdEntries()
    // 视图切换/查询变化后条目数会变：高亮下标夹回合法区间，否则回车会选中 undefined。
    cmd.active = Math.min(cmd.active, Math.max(0, cmd.items.length - 1))
    // 滚动位置跨重渲保持（2026-11-05 根因）：列表在文件索引流式进度/数据落地时会整体重渲，
    // 旧实现每次 innerHTML 重建 .viewport（scrollTop 归零）+ 无条件 scrollIntoView 高亮行（多为第 0 行）
    // ⇒ 用户拖条/滚轮后立刻被打回顶部，表现为「根本划不动」。现在搬运旧滚动量，
    // 且只有**高亮行真的变了**（键盘/点击导航）才把它滚进视野。
    // 只在「同一屏」内搬运滚动量：视图/查询/浏览层变了就归零（见 cmdViewKey）。
    const vpKey = cmdViewKey()
    const prevVp = cmdPop.querySelector('.viewport')
    const keepTop = prevVp && cmd.vpKey === vpKey ? prevVp.scrollTop : 0
    const prevActive = cmd.prevActive
    let html = ''
    if (cmd.error !== null) {
      html += `<div class="error" role="alert"><span class="errorText">${esc(cmd.error)}</span>${cmd.status === 'failed' ? `<button type="button" class="retry">重试</button>` : ''}</div>`
    } else {
      // 待发附件的唯一可见回显 = 底栏 `#img-pills`（inputbar/images.js renderImgPills）；
      // 本浮窗只做选择/上传入口，不再重复渲染缩略图（2026-10-22 用户实测：同一批图在浮窗与底栏各出现一次）。
      // 搜索结果（@ 后有查询词）= 扁平时间线，不印分组标题（用户定案「不隔离」）；@ 无词/+ 模式 = 入口视图分组。
      // 未进视图的跨类搜索才是扁平时间线；进了某类视图仍按组显示（导航行与该类标题）。
      const flat = !cmd.view && !!mention.q.trim()
      let lastGrp = ''
      html += `<div role="listbox" class="viewport">${cmd.items.map((it, i) => {
        const g = it.grp || groupOf(it)
        const grp = g === '文件' ? '文件 · ' + pickLabel() : g
        // 「返回」行不单立分组标题（2026-11-06 D）：视图内此前先印「导航」再印该类标题，
        // 两条上箭头/分组叠在顶部像重复了一栏；返回行随该视图的标题下呈现即可。
        const gh = flat || it.kind === 'back' || grp === lastGrp ? '' : `<div class="grp">${esc(grp)}</div>`
        if (it.kind !== 'back') lastGrp = grp
        const on = i === cmd.active ? ' rowActive' : ''
        const ico = it.kind === 'entry' ? it.icon : it.kind === 'element' ? (I[it.el.icon] || I.chip) : it.kind === 'back' ? MENTION_UP_ICON :it.kind === 'attref' ? (it.attKind === 'img' ? I.dshImage : I.dshPaperclip) : it.kind === 'imgpick' ? I.dshImage : it.kind === 'filepick' ? I.dshPaperclip : it.kind === 'plugin' ? MENTION_PLUGIN_ICON : it.kind === 'skill' ? MENTION_SKILL_ICON : it.kind === 'session' ? MENTION_SESSION_ICON : it.kind === 'pathup' ? MENTION_UP_ICON : it.kind === 'path' ? mentionChipIcon('path', it.ptype, it.path) : it.kind === 'pathwait' ? mentionChipIcon('path', 'file', '') : (CMD_ICON[it.name] || I.dshPlus)
        const label = it.kind === 'cmd' ? `/${it.name}` : it.name
        const detail = it.kind === 'path' ? it.path : it.desc
        const tag = it.proj ? `<span class="projTag">${esc(projTag(it.proj))}</span>` : ''
        // 目录行行尾「进入目录」（与 dsh 同形）：点行 = 引用该目录，点这枚按钮 / 按 Tab = 下钻。
        // 按钮必须是 span 而非 button（行本身就是 button，HTML 禁嵌套 button）。
        const dirBtn = it.kind === 'path' && it.ptype === 'dir'
          ? `<span class="dirEnter" data-direnter role="button" title="进入该目录（Tab）"><span class="de-k">进入目录</span><kbd>Tab</kbd><span class="de-c">›</span></span>`
          : ''
        return gh + `<button type="button" role="option" aria-selected="${i === cmd.active}" class="row${on}" data-idx="${i}"><span class="rowIco">${ico}</span><span class="label">${esc(label)}</span>${detail ? `<span class="detail">${esc(detail)}</span>` : ''}${tag}${dirBtn}</button>`
      }).join('')}</div>`
    }
    cmdPop.innerHTML = html
    cmdPop.hidden = false
    // 行选中：鼠标走 pointerdown（按下即选），触摸/键盘仍走 click。
    // 文件搜索是流式索引，进度批次会整块重渲 `.viewport`（行 DOM 全部替换）；若重渲恰好落在
    // 按下与抬起之间，浏览器把 click 派发给两元素的**共同祖先**，行监听收不到 ⇒ 第一下白点，
    // 用户只能再点一次（实报「文件艾特时候需要双击」）。按下态命中当前元素，免疫重渲。
    // 触摸不提前选：手指按下可能是在滑列表，抬手才该定格。pressed 吃掉同一手势随后的 click
    // （行未被替换时），键盘 click（detail=0，无 pointerdown）照常生效。
    cmdPop.querySelectorAll('.row').forEach((b) => {
      let pressed = false
      const choose = () => { cmd.active = +b.dataset.idx; cmdSelect() }
      // 行尾「进入目录」：与行点选分开（同一个委托里判落点），鼠标按下即进、触摸抬手进。
      const enterDir = () => { cmd.active = +b.dataset.idx; cmdEnterDir() }
      b.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return
        pressed = true
        if (e.target.closest('[data-direnter]')) enterDir()
        else choose()
      })
      b.addEventListener('click', (e) => {
        if (pressed) { pressed = false; return }
        if (e.target.closest('[data-direnter]')) enterDir()
        else choose()
      })
    })
    cmdPop.querySelector('.retry')?.addEventListener('click', () => { cmd.error = null; cmd.status = 'ready'; renderCmdPop() })
    const vp = cmdPop.querySelector('.viewport')
    if (vp) vp.scrollTop = keepTop
    cmd.vpKey = vpKey
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
    if (it.kind === 'imgpick') { $('img-file').click(); return }
    if (it.kind === 'filepick') { $('file-upload').click(); return }
    if (it.kind === 'pathwait') return // 占位行不可选（清单未就绪）
    // 指令行：风险命令走确认门，其余直接写入输入栏执行。
    if (it.kind === 'cmd') {
      const o = it.ref
      if (o.risk) { cmd.confirming = o; cmd.acknowledged = false; renderCmdPop(); return }
      cmdSettle(o)
      return
    }
    // 其余条目统一落地到锚点（@ 位置 / + 点击时的光标），替换已输入的查询区间：
    // 目录下钻重渲、目录/文件/会话/技能/插件插 chip、上传附件把正文引用写回。
    selectMentionItem(it)
  }
  // 进入目录（行尾按钮 / Tab 键共用）：只对目录行生效，非目录行不动（Tab 不该把会话/技能当目录钻）。
  function cmdEnterDir() {
    const it = cmd.items[cmd.active]
    if (!it || !enterMentionDir(it)) return false
    return true
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
  EFFORT_LEVELS,
  MOCK_COMMANDS,
  closeCmdPop,
  closeProjPop,
  closeRiskModal,
  cmd,
  cmdAck,
  cmdConfirm,
  cmdEnterDir,
  cmdMove,
  cmdPop,
  cmdSelect,
  cmdSettle,
  modelPop,
  modelSeatEl,
  msel,
  openProjPop,
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
