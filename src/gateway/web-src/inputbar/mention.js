// @ 提及浮窗 + 输入变化入口（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { messagesHtml, addUser } from '../chat/messages.js'
import { GATEWAY, gateAwait, apiUrl } from '../engine/gateway.js'
import { I } from '../core/icons.js'
import { mdInline, relTime } from '../core/markdown.js'
import { MENTION_FILE_ICON, MENTION_PATH_RE, MENTION_PLUGIN_RE, MENTION_SESSION_ICON, MENTION_SESSION_RE, QUOTE_PDF_RE, QUOTE_REF_RE, QUOTE_REPLY_RE, foldQuoteBodies, mentionChipHtml, mentionPathToken, quotePdfChipHtml, quoteRefChipHtml, quoteReplyChipHtml, splitSessionToken, unfoldQuoteBodies, unescapeMentionPath } from '../core/mention-syntax.js'
import { findSession, sessionCwd } from '../engine/sessions.js'
import { inputEl, state } from '../engine/state.js'
import { esc, newSessionProject } from '../core/util.js'
import { syncGwSend } from './send.js'
import { uploadedMentionItems } from './images.js'
import { MGR } from '../sidebar/mgr-data.js'
/* @module inputbar/mention.js */
  // ---------- @ 提及（2026-08-15）：输入 @ 弹出「近48h 会话 + 插件/技能」浮窗（2026-09-18 会话区提前），选中插入内联 chip ----------
  // 消息文本中 chip 序列化为 [插件:名称] / [会话:名称] 令牌（CLI 终端渲染为 [名称]，遥测端渲染为 chip；
  // 令牌保留 kind 供两端差异化渲染 + 未来插件激活扩展）。
  // @ 提及 icon（2026-09-28 换 dsh v0.2.0-rc.1 产品图标集，16 描线/currentColor；旧 24 手绘那套作废）。
  // 语义与 dsh 一致：会话=ChatLines、插件=PluginPinwheel、技能=Skill、目录=FolderClose、文件=Browse
  // ——与 + 浮窗行图标同源（同一批 I.* 常量），两处不得分叉。会话/文件两枚随 chip 构造器下移 core/mention-syntax.js。
  const MENTION_PLUGIN_ICON = I.dshPlugin
  const MENTION_SKILL_ICON = I.dshSkill
  // ---------- 目录 / 文件引用（2026-09-26）：@ 浮窗与 + 工具栏共用的一组「逐级浏览工作区根」状态 ----------
  // 数据源 = GET /gateway/fs?path=<相对工作区根的子路径>（只读单层；网关侧复用 listOneLevel，跳过隐藏项
  // 与重型目录、目录在前、单层不设条数上限）。pick.path 是**相对工作区根**的当前层路径，'' = 根——与 chip 上行的
  // 路径同基准（用户定案：相对全局根）。令牌形态 [@目录:路径] / [@文件:路径] 见 core/mention-syntax.js。
  // 引用原文块 ⇄ 折叠令牌的解析与编码统一在 core/mention-syntax.js（唯一真源：气泡/底栏共用）。
  const MENTION_DIR_ICON = I.dshFolder
  const MENTION_UP_ICON = I.dshUp
  // CM6 接管后 sentinel（零宽 DOM 锚）退役：@ 查询锚点 = doc 位置 anchor（'@' 所在 pos）
  let mention = { open: false, anchor: 0, q: '', items: [], sel: 0 }
  // entries: null=未加载；[]=空目录；[TreeNode…]=已加载。seq 丢弃迟到的旧响应（快速连点目录）。
  // searchOff：搜索/浏览模式开关（2026-10-14 待办 20）——false 且查询非空 = 全局搜索模式；
  // 下钻/返回目录后翻 true（回到层内浏览），浮窗重开（refreshPick）复位 false。
  const pick = { path: '', entries: null, loading: false, err: '', seq: 0, searchOff: false, q: '' }
  // 全工作区递归清单（待办 20 的数据层）：BFS 逐层 /gateway/fs（每层分批并发，层间 await）。
  // 不设深度/目录数/条目数上限——搜索要能命中工作区任意深度的文件（2026-10-25 用户定案：
  // 截断过于严重，应显示全部）。隐藏目录与 node_modules/dist/.git 等仍由网关侧跳过。
  // 浮窗每次打开经 refreshPick 重置重建（目录内容是外部可变状态，不跨打开缓存）。
  // items 是**流式**清单：BFS 每扫完一批目录就并进去（用户边打边出结果，不必等全量跑完），
  // done=true 才表示跑完整轮。浮窗打开即预热（refreshPick），打字时通常已可用。
  const pickAll = { items: [], done: false, busy: false, seq: 0, err: '', onProgress: null }
  const PICK_FS_CONCURRENCY = 24

  // ---------- 条目分组（+ 工具栏入口视图的唯一真源）----------
  // 搜索结果**不分组也不截断**（2026-10-25 用户定案：@ 唤起同一工具栏、扁平按时间排列）；
  // groupOf 只服务 + 工具栏的入口视图（每类一屏）与首屏两组（上传 / 浏览）。
  const GROUP_OF = { imgpick: '上传', filepick: '上传', attref: '上传', session: '聊天', plugin: '技能', skill: '技能', path: '文件', pathup: '文件', pathwait: '文件' }
  function groupOf(it) {
    return GROUP_OF[it.kind] || '指令'
  }

  // ---------- 目录 / 文件浏览（数据层；两个浮窗共用，渲染各自负责） ----------
  // 文件组的落点 = 当前上下文项目目录（用户定案「先显示本项目的文件」）：会话态取该会话所属项目，
  // 非会话态取目标项目（`newSessionProject()`——work 模式即工作项目）。空串 = 无项目上下文 → 从工作区根起。
  function pickHome() {
    const s = state.currentHash ? findSession(state.currentHash) : null
    if (s) return s.projectScope === 'project' && s.projectLabel ? s.projectLabel : ''
    return newSessionProject() || ''
  }
  function pickParent() {
    const p = pick.path
    const i = p.lastIndexOf('/')
    return i < 0 ? '' : p.slice(0, i)
  }
  function pickLabel() {
    // 搜索模式（2026-10-14 待办 20）：文件组标题提示结果口径（层内浏览则照旧标当前层）
    if (pick.q && !pick.searchOff) return pickAll.done ? '工作区全局搜索' : '全局搜索…'
    if (pick.loading) return '加载中…'
    if (pick.err) return '加载失败'
    return pick.path || '工作区根'
  }
  // 构建全工作区递归清单（幂等；构建期间 busy 挡重入，seq 丢弃被 refreshPick 作废的旧轮）。
  // 完成不自行重渲——由调用方的 after 回调负责（浮窗还开着才重渲）。
  async function ensurePickAll() {
    if (pickAll.done || pickAll.busy) return
    pickAll.busy = true
    const seq = ++pickAll.seq
    let layer = ['']
    const seen = new Set()
    let rootErr = ''
    try {
      while (layer.length) {
        const next = []
        // 分批并发：整层一次打出去会在目录多的工作区形成数百并发请求（本地网关也能被拖慢）
        for (let i = 0; i < layer.length; i += PICK_FS_CONCURRENCY) {
          const batchItems = []
          const batchDirs = []
          await Promise.all(
            layer.slice(i, i + PICK_FS_CONCURRENCY).map(async (p) => {
              try {
                const r = await fetch(apiUrl('/gateway/fs?path=' + encodeURIComponent(p)))
                const data = await r.json()
                if (!r.ok || !data || !Array.isArray(data.entries)) {
                  // 根层失败 = 整份清单不可信（空结果会谎报「无匹配」）：记错并作废本轮，浮窗重开再试。
                  if (!p) rootErr = (data && data.error) || '工作区索引失败'
                  return
                }
                for (const e of data.entries) {
                  const cp = p ? `${p}/${e.name}` : e.name
                  batchItems.push({ ptype: e.type === 'dir' ? 'dir' : 'file', name: e.name, path: cp, mtime: e.mtime || 0 })
                  if (e.type === 'dir' && !seen.has(cp)) {
                    seen.add(cp)
                    batchDirs.push(cp)
                  }
                }
              } catch (e) {
                /* 子层失败跳过，不拖垮整轮（根层失败另记） */
                if (!p) rootErr = e.message || '工作区索引失败'
              }
            }),
          )
          if (seq !== pickAll.seq) return
          // 流式并进清单：本批结果立刻可被 pickItems 检索到，并立刻重渲一次浮窗。
          pickAll.items.push(...batchItems)
          next.push(...batchDirs)
          if (pickAll.onProgress) pickAll.onProgress()
        }
        layer = next
      }
    } finally {
      if (seq === pickAll.seq) {
        pickAll.busy = false
        pickAll.done = !rootErr
        if (rootErr) { pickAll.items = []; pickAll.err = rootErr }
        else pickAll.err = ''
        // 收尾也要重渲一次：否则尾部「搜索中…」会一直挂着（pickSearchKick 只在未开跑时挂 .then）
        if (pickAll.onProgress) pickAll.onProgress()
      }
    }
  }
  // 搜索模式的异步补拉口（两个浮窗的渲染函数各调一次）：查询非空且处于搜索模式、清单未建 →
  // 建清单，完成后浮窗仍开着才重渲。
  function pickSearchKick(re) {
    // 清单流式产出：构建期间每批都回调（有结果立刻显示）；err 非空 = 上一轮根层失败，
    // 不随每次按键重试（会变成按键风暴），等浮窗重开 refreshPick 复位。
    if (pick.q && !pick.searchOff && !pickAll.done && !pickAll.busy && !pickAll.err) {
      pickAll.onProgress = re
      ensurePickAll().then(() => { if (pickAll.onProgress) pickAll.onProgress() }).catch(() => {})
    }
  }
  // 加载某一层（path 相对工作区根）。完成后由调用方重渲自己的浮窗（本函数不碰 DOM）。
  async function loadPickPath(path) {
    const seq = ++pick.seq
    pick.path = String(path || '')
    pick.loading = true
    pick.err = ''
    try {
      const res = await fetch(apiUrl('/gateway/fs?path=' + encodeURIComponent(pick.path)))
      const data = await res.json()
      if (seq !== pick.seq) return false
      if (!res.ok || data.error) throw new Error(data.error || '加载失败')
      pick.entries = Array.isArray(data.entries) ? data.entries : []
    } catch (e) {
      if (seq !== pick.seq) return false
      pick.entries = null
      pick.err = e.message || String(e)
    } finally {
      if (seq === pick.seq) pick.loading = false
    }
    return seq === pick.seq
  }
  // 当前层的可选条目 / 全局搜索结果（2026-10-14 待办 20）。
  // q 为空或已下钻（searchOff）= 原层内浏览：上级目录行 + 当前层全部（按 q 过滤后同样全列）。
  // q 非空且未下钻 = 全局搜索：跨工作区递归清单（pickAll）按名称过滤，命中多少列多少（不截断）。
  // 清单未就绪时文件组暂空（其余组照常），pickSearchKick 建完重渲补上。
  // 「上级目录」只取决于「当前是不是工作区根」，与**这一层的内容**无关——故加载中/加载失败时它照样在，
  // 否则某一层拉不到（目录已删/端点失败）就退不回去，整个文件组成死层。条目本身不塞假行。
  function pickItems(q) {
    const ql = (q || '').trim().toLowerCase()
    pick.q = ql
    const items = []
    if (ql && !pick.searchOff) {
      for (const e of pickAll.items) {
        if (!e.name.toLowerCase().includes(ql)) continue
        items.push({ kind: 'path', ptype: e.ptype, name: e.name, path: e.path, glob: true, t: e.mtime || 0 })
      }
      return items
    }
    if (pick.path) items.push({ kind: 'pathup', name: '上级目录', path: pickParent() })
    if (pick.loading || !pick.entries) return items
    for (const e of pick.entries) {
      if (ql && !String(e.name).toLowerCase().includes(ql)) continue
      const p = pick.path ? `${pick.path}/${e.name}` : e.name
      items.push({ kind: 'path', ptype: e.type === 'dir' ? 'dir' : 'file', name: e.name, path: p, t: e.mtime || 0 })
    }
    return items
  }
  // 目录项进入下一层 / 上级目录返回（两个浮窗的选择入口共用同一处判定）。下钻 = 用户已明确
  // 「要看这个位置」→ 翻回层内浏览模式（此后 q 只做层内过滤，不再全局搜）。
  function pickEnter(it) {
    pick.searchOff = true
    return loadPickPath(it.path)
  }
  function mentionChipIcon(kind, ptype) {
    if (kind === 'session') return MENTION_SESSION_ICON
    if (kind === 'path' || kind === 'filepick' || kind === 'imgpick') return ptype === 'dir' ? MENTION_DIR_ICON : MENTION_FILE_ICON
    if (kind === 'skill') return MENTION_SKILL_ICON
    return MENTION_PLUGIN_ICON
  }
  // 输入栏内联 chip 的 HTML（@ 插入与 + 工具栏追加共用一份，勿各写一套）
  // 路径 chip 只显示末段文件名，全路径进 title（与消息气泡 mentionChipHtml 同口径）。
  // 展示不带 @ 前缀（2026-10-26 与消息气泡同步：@ 只是唤出手势，不属文件名）。
  function mentionChipInner(kind, name, ptype) {
    const full = kind === 'path' ? unescapeMentionPath(name) : name
    const base = kind === 'path' ? String(full).split('/').pop() : full
    const title = kind === 'path' && base !== full ? ` title="${esc(full)}"` : ''
    return `<span class="m-ic">${mentionChipIcon(kind, ptype)}</span><span class="m-nm"${title}>${esc(base)}</span>`
  }
  function buildMentionChip(kind, name, sid, ptype) {
    const chip = document.createElement('span')
    chip.className = 'mention'
    chip.contentEditable = 'false'
    chip.dataset.kind = kind
    chip.dataset.name = name
    if (kind === 'session' && sid) chip.dataset.sid = sid
    if (kind === 'path') chip.dataset.ptype = ptype === 'dir' ? 'dir' : 'file'
    chip.innerHTML = mentionChipInner(kind, name, ptype)
    return chip
  }

  // chip HTML 构造器（mentionChipHtml / quote*ChipHtml）与令牌正则、splitSessionToken 已下移
  // core/mention-syntax.js（core 叶子，供 core/markdown.js 与本源共用，断开 core→feature 成环）。

  // 引用 chip → 消息文本。两条链的落地形态刻意不同（用户定案 2026-09-28）：
  //  文件引用 = 只给位置，模型自己 Read；
  //  回复引用 = 原文必须进消息——回复不属于任何文件，没有位置可查。原文包在令牌块里（`QUOTE_REPLY_BODY_RE`），
  //  渲染层整块剥掉只留锚点令牌 → 胶囊。首尾不留多余换行（留了会撑出多余行距，2026-09-28 用户实报「自带一个换行」）。
  function refToken(d) {
    if (d.rkind === 'pdf') {
      const p = refPath(d.file, d.proj)
      const loc = d.p0 ? `#p${d.p0}${d.p1 && d.p1 !== d.p0 ? '-' + d.p1 : ''}` : ''
      return `[@引用PDF:${p}${loc}]\n${String(d.quote || '')}\n[/引用PDF]`
    }
    if (d.rkind !== 'file') {
      const title = String(d.title || '本会话').replace(/[\]|\r\n]/g, ' ').trim() || '本会话'
      return `[@引用回复:${d.idx || 0}|${title}]\n${String(d.quote || '')}\n[/引用回复]`
    }
    const p = refPath(d.file, d.proj)
    return d.l0 ? `[@引用:${p}#L${d.l0}-${d.l1}]` : `[@引用:${p}]`
  }

  // 引用路径基准 = 模型能直接 Read 的形式：会话启动根（模型 cwd）就是该 work 项目本身时用项目内
  // 相对路径；否则带项目 label（工作区相对——会话开在别的项目下时仍指向同一文件）。cwd 未知同样带 label。
  function refPath(file, proj) {
    const cwd = String(sessionCwd || '').replace(/\\/g, '/').replace(/\/+$/, '')
    if (proj && cwd.split('/').pop() === proj) return file
    return proj ? proj + '/' + file : file
  }

  // 引用**原文块**在气泡里的形态（2026-10-21 用户定案）：原文并进锚点令牌的第三个字段（百分号编码），
  // 由 core/mention-syntax.js 的 chip 构造器渲染成「图标 + 原文」的蓝色引用胶囊（不再有 blockquote 的
  // margin/padding = 与正文上下对齐，也不再显示「引用自…第 N 条回复」标签）。模型侧原文不动（令牌块原样上行）。
  // **折叠后不补换行**（2026-10-24 用户实报「引用发送后后面总有莫名其妙的换行」）：胶囊是行内元素，
  // 用户话术紧接其后自然流动；补 `\n` 会被 mdHtml 拆成下一段并落 `<br>`，表现为「引用后凭空换行」。
  // 三个渲染入口（messages.js userBodyHtml / approval.js renderTransient 的 bodyText 与队列 txt）共用本收口。
  const quoteBodiesAsMarkdown = foldQuoteBodies

  // 实时回显的用户消息：把令牌转 chip（与离线 messagesHtml 的 mdInline 一致）
  function renderUserText(text) {
    return esc(text)
      .replace(MENTION_PLUGIN_RE, (_, n) => mentionChipHtml('plugin', n))
      .replace(MENTION_SESSION_RE, (_, n) => mentionChipHtml('session', n))
      .replace(MENTION_PATH_RE, (_, t, p) => mentionChipHtml('path', p, t === '目录' ? 'dir' : 'file'))
      .replace(QUOTE_REF_RE, (_, p, a, b) => quoteRefChipHtml(p, a, b))
      .replace(QUOTE_REPLY_RE, (_, i, t, b) => quoteReplyChipHtml(i, t, b))
      .replace(QUOTE_PDF_RE, (_, p, a, b, q) => quotePdfChipHtml(p, a, b, q))
  }

  // 序列化 = CM doc 原文（2026-10-14 CM6 接管）：令牌文本本就是序列化形态、chip 是它的装饰视图。
  // 例外（2026-10-24）：引用原文在底栏 doc 里是折叠单行令牌（chip 即所见），发送时还原成
  // 「锚点行 + 原文 + 收尾行」的块形态——模型读到的必须是原文，不是百分号编码。
  function serializeInput() {
    return unfoldQuoteBodies(composerDocText())
  }

  // 复位 @ 数据态（不碰 DOM、不开关工具栏）：@ 关闭链与工具栏关闭链共用同一处，避免两套状态漂移。
  function resetMention() {
    mention.open = false
    mention.anchor = 0
    mention.q = ''
    mention.items = []
    mention.sel = 0
  }

  function closeMentionPop() {
    const wasOpen = mention.open
    resetMention()
    // 工具栏是 @ 与 + 的唯一弹窗（2026-10-25 用户定案）：@ 态结束必须把工具栏一起收起，
    // 否则会留下一个没有 @ 锚点却仍按 + 模式渲染的弹窗。closeCmdPop 不会回调本函数（只调 resetMention）。
    // 只在「@ 态确实开着」时才碰 cmd（composer 初始 mount 会在 commands.js 之前调本函数，
    // 此时 cmd 尚处 TDZ；wasOpen=false 短路即避开）。
    if (wasOpen && cmd.mentionMode) closeCmdPop()
    return wasOpen
  }

  function openMentionPopAtCaret() {
    if (!cmView) return
    mention.open = true
    mention.anchor = cmView.state.selection.main.from - 1 // '@' 的 doc 位置（composer onInputMention 判定后调）
    mention.sel = 0
    mention.q = ''
    // 输入 @ 不另立浮窗，直接唤起同一个 + 工具栏并进入 mention 模式（打开/加载/重渲统一在
    // commands.js 的 openCmdPopMention；本件只维护 @ 的锚点与查询词）。
    openCmdPopMention()
  }

  // 浮窗打开时定位到当前上下文项目并加载该层（不缓存：目录内容是外部可变状态，缓存会让新建的文件不可见）。
  // **每次打开都回到项目层**（同 @ 浮窗每次打开重置 q/sel）——打开是新的一轮手势，不是接着上次浏览的位置；
  // 层内下钻/返回由 pickEnter 自己拉，走同一处 loadPickPath。
  function refreshPick(after) {
    pick.entries = null // 立刻清旧层：否则换项目后先闪一帧上一个项目的条目（在途请求由 loadPickPath 的 seq 作废）
    pick.err = ''
    pick.q = '' // 查询/层级同属上一轮手势：不复位会先渲一帧旧查询结果（两个浮窗共用本状态）
    pick.path = ''
    pick.searchOff = false // 浮窗重开 = 新一轮手势：回到全局搜索模式（待办 20）
    pickAll.items = [] // 递归清单随打开重建（目录内容外部可变，不跨打开缓存；在途轮由 seq 作废）
    pickAll.done = false
    pickAll.err = ''
    pickAll.seq++
    // 作废在途轮时必须同步释放 busy：旧轮 finally 见 seq 不符只跳过写回、不会复位 busy，
    // 否则下一次输入永远起不了新轮（文件搜索整组空白）
    pickAll.busy = false
    // 打开即预热全局清单（不等用户打出查询词才开始扫：全量约 1500 个目录请求，早开始早出结果）。
    // 流式批回调与层加载共用 after（渲染点已判 cmd.open）。
    pickAll.onProgress = after || null
    ensurePickAll().catch(() => {})
    loadPickPath(pickHome()).then((ok) => { if (ok && after) after() })
  }

  // 弹窗的统一条目源（@ 模式与 + 工具栏搜索共用；+ 的入口视图另走 commands.js 的 cmdEntries）。
  // **全局搜索 = 扁平列表**（2026-10-25 用户定案：不做类别隔离），按时间倒序混排：
  // 会话 updatedAt / 文件目录 mtime（/gateway/fs 返回）/ 本次上传（now）；无时间字段的技能与指令 t=0 稳定排末尾。
  // **空查询 / 已下钻 = 浏览**：保留数据层既有顺序（上传 → 近 48h 会话 → 技能 → 当前层），不做时间排序。
  function mentionItems(q) {
    const ql = (q || '').trim().toLowerCase()
    const match = (s) => !ql || String(s || '').toLowerCase().includes(ql)
    const globalSearch = !!ql && !pick.searchOff
    const now = Date.now()
    const items = []
    // 「上传」组（待办 6）：本次上传的附件（图片/文件），选中插回正文 md 引用。属于「刚刚发生」，时间取 now。
    for (const u of uploadedMentionItems()) if (match(u.name)) items.push({ ...u, t: now })
    // 会话：**空查询**只给近 48h 建议（免浮窗一开就几百条）；**有查询词**时搜全量——标题检索必须与
    // 侧栏一致，不能因会话旧于 48h 就查不到（2026-10-17 用户实测：侧栏有「202610131215-有机随想」，
    // 输入 @2026101312 却只剩文件命中）。
    const cutoff = now - 48 * 3600 * 1000
    for (const s of ALL) {
      if (!globalSearch && s.updatedAt < cutoff) continue
      // sid = 会话转录文件名主干，与会话间协作的寻址键同源（engine/sessions.js hashOf = 路由 hash）
      if (match(s.title || '')) items.push({ kind: 'session', name: s.title || '未命名会话', sid: hashOf(s), desc: relTime(s.updatedAt), t: s.updatedAt })
    }
    if (MGR) {
      for (const p of (MGR.plugins && MGR.plugins.personal) || []) if (match(p.n)) items.push({ kind: 'plugin', name: p.n, desc: p.d, t: 0 })
      for (const s of (MGR.skills && MGR.skills.personal) || []) if (match(s.n)) items.push({ kind: 'skill', name: s.n, desc: s.d, t: 0 })
    }
    items.push(...pickItems(q))
    if (globalSearch) items.sort((a, b) => (b.t || 0) - (a.t || 0))
    return items
  }

  // 条目落地的唯一入口（点击与回车共用）：目录/上级=下钻重渲；文件=插 chip；会话/技能=插 chip。
  function selectMentionItem(it) {
    if (it.kind === 'pathup' || (it.kind === 'path' && it.ptype === 'dir')) {
      pickEnter(it).then(() => { if (cmd.open && cmd.mentionMode) renderCmdPop() })
      return
    }
    // 已上传附件（待办 6）：把正文 md 引用原文写回 doc（与自动插入同一形态，CM 行内直渲）。
    // kind=attref（images.js uploadedMentionItems 唯一产出）；imgpick/filepick 只作首屏上传动作行。
    if (it.kind === 'attref') {
      const pos = cmView ? cmView.state.selection.main.from : mention.anchor
      composerReplaceRange(mention.anchor, pos, it.md + ' ')
      closeMentionPop()
      syncGwSend()
      return
    }
    if (it.kind === 'path') insertMention('path', it.path, '', 'file')
    else insertMention(it.kind, it.name, it.sid)
  }

  // 键盘移动/选择：@ 模式与 + 模式共用同一个工具栏列表（cmd.items/cmd.active），直接转调 commands.js。
  // CM 键盘链先判 cmd.isOpen()，mention 分支只在理论上兜底——保持薄转调，不另存一份高亮状态。
  function moveMentionSel(d) {
    if (cmd.open && cmd.mentionMode) cmdMove(d)
  }

  function selectMention() {
    if (cmd.open && cmd.mentionMode) { cmdSelect(); return }
    const it = mention.items[mention.sel]
    if (it) selectMentionItem(it)
  }

  // 选中项 → 令牌 + 尾随空格替换 @查询区间（[mention.anchor, 光标]），光标到空格后。sid 仅会话
  // chip 有（寻址键，序列化为 `[会话:标题|sid]`；插件/技能无 sid）。
  function insertMention(kind, name, sid, ptype) {
    const token = kind === 'session'
      ? (sid ? `[会话:${name}|${sid}]` : `[会话:${name}]`)
      : kind === 'path'
        ? mentionPathToken(name, ptype)
        : `[插件:${name}]`
    const pos = cmView ? cmView.state.selection.main.from : mention.anchor
    composerReplaceRange(mention.anchor, pos, token + ' ')
    closeMentionPop()
    syncGwSend()
  }

  // doc/选区变化：检测 @ 触发 / 维护已打开的 @查询（光标前是 @ 则开浮窗）。锚点 = '@' 的 doc 位置
  function onInputMention() {
    if (!GATEWAY || gateAwait || state.mgr || !cmView) { closeMentionPop(); return }
    const st = cmView.state
    const pos = st.selection.main.from
    // IME 组合期（中文键盘敲字母即进入组合）：组合中的 doc 文本是**临时拼音/候选**，
    // 选区也不可信——拿它过滤会把浮窗筛空并按「无结果」关掉，或按选区判定误杀。
    // 组合期一律不判不动（不开、不更新查询、不关），等 compositionend 上屏后的 doc 事务
    // 走正常判定。`composing` 是 CM6 EditorView 的真实组合态字段（旧写法 compositionStarted
    // 根本不存在 ⇒ 守卫恒为假，查询词跟着组合中的临时文本乱跳）。组合结束由 onCompositionEnd
    // 再按最终 doc 判定一次，避免末次事务缺失时浮窗停在空查询的旧结果上。
    if (cmView.composing) return
    if (st.selection.main.from !== st.selection.main.to || !st.selection.main.empty) { if (mention.open) closeMentionPop(); return }
    if (mention.open) {
      const between = st.doc.sliceString(mention.anchor, pos)
      if (pos <= mention.anchor || /[\n\r]/.test(between)) { closeMentionPop(); return }
      const q = between.slice(1)
      if (q !== mention.q) { mention.q = q; if (cmd.open) renderCmdPop() }
      return
    }
    if (pos > 0 && st.doc.sliceString(pos - 1, pos) === '@') openMentionPopAtCaret()
  }
  function onInputChange() { syncGwSend(); onInputMention() }
  // IME 组合结束：CM 在 compositionend 后可能不再派发 doc/selection 事务（组合文本已在组合期
  // 进 doc），此时 @ 查询词仍是组合期旧值 ⇒ 浮窗停在空查询的全量列表。延后一拍按最终 doc 重判。
  function onCompositionEnd() {
    if (!cmView) return
    setTimeout(() => { if (cmView) onInputMention() }, 0)
  }

export {
  MENTION_PATH_RE,
  MENTION_PLUGIN_ICON,
  MENTION_PLUGIN_RE,
  MENTION_SESSION_ICON,
  MENTION_SESSION_RE,
  MENTION_SKILL_ICON,
  MENTION_UP_ICON,
  QUOTE_PDF_RE,
  QUOTE_REF_RE,
  QUOTE_REPLY_RE,
  buildMentionChip,
  groupOf,
  closeMentionPop,
  insertMention,
  loadPickPath,
  mention,
  mentionChipHtml,
  mentionChipIcon,
  mentionItems,
  moveMentionSel,
  onCompositionEnd,
  onInputChange,
  onInputMention,
  openMentionPopAtCaret,
  pick,
  pickAll,
  pickEnter,
  pickHome,
  pickItems,
  pickLabel,
  pickSearchKick,
  quotePdfChipHtml,
  quoteRefChipHtml,
  quoteReplyChipHtml,
  refreshPick,
  renderUserText,
  resetMention,
  selectMention,
  selectMentionItem,
  serializeInput,
  quoteBodiesAsMarkdown,
}
