// 工具栏条目层（2026-11-07 工具栏模块化切割自 inputbar/mention.js + inputbar/commands.js；唯一手改处，web/app.js 为生成物）
// 只负责「查询词 → 条目数组」：@ 扁平搜索、+ 的分组入口视图、文件结果；不碰 DOM，渲染归 commands.js。

import { I } from '../../core/icons.js'
import { relTime } from '../../core/markdown.js'
import { sessionProjLabel } from '../../core/util.js'
import { hashOf } from '../../engine/sessions.js'
import { ALL } from '../../engine/state.js'
import { MGR, projSkillsOf } from '../../sidebar/mgr-data.js'
import { pendingImages, uploadedMentionItems } from '../images.js'
import { MENTION_PLUGIN_ICON, MENTION_SESSION_ICON, MENTION_SKILL_ICON, mention, toolbarQueryText } from '../mention.js'
import { MOCK_COMMANDS, cmd } from '../commands.js'
import { pick, pickAll, pickItems, pickSearchKick } from './pick.js'
import { matchScore, pickHome, sessionOwn, sortSessions } from './scope.js'
/* @module inputbar/toolbar/entries.js */
  // ---------- 条目分组（+ 工具栏入口视图的唯一真源）----------
  // 搜索结果**不分组也不截断**（2026-10-25 用户定案：@ 唤起同一工具栏、扁平按时间排列）；
  // groupOf 只服务 + 工具栏的入口视图（每类一屏）与首屏两组（上传 / 浏览）。
  const GROUP_OF = { imgpick: '上传', filepick: '上传', attref: '上传', session: '聊天', plugin: '技能', skill: '技能', path: '文件', pathup: '文件', pathref: '文件', pathwait: '文件' }
  function groupOf(it) {
    return GROUP_OF[it.kind] || '指令'
  }
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
    // 剥离已落地的 chip 令牌：令牌不是检索词，夹在 q 里会让「底栏有引用件时」所有搜索零命中。
    return toolbarQueryText()
  }

  // 弹窗的统一条目源（@ 模式与 + 工具栏搜索共用；+ 的入口视图另走 cmdEntries）。
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
    // 会话：**空查询/层内**只给近 48h 建议（免浮窗一开就几百条）；**有查询词**时搜全量——标题检索必须与
    // 侧栏一致，不能因会话旧于 48h 就查不到（2026-10-17 用户实测：侧栏有「202610131215-有机随想」，
    // 输入 @2026101312 却只剩文件命中）。
    // **不按项目隔离**（2026-11-08 用户定案）：全项目会话都可被 @ 引用；排序 = 匹配度优先、
    // 同分本项目会话在前、再按更新时间倒序（scope.js 的 sortSessions）。跨项目结果行尾标项目编号。
    const home = pickHome()
    const cutoff = now - 48 * 3600 * 1000
    const sessions = []
    for (const s of ALL) {
      if (!globalSearch && s.updatedAt < cutoff) continue
      if (match(s.title || '')) sessions.push(s)
    }
    for (const s of sortSessions(sessions, globalSearch ? q : '', home)) {
      const own = sessionOwn(s, home)
      // sid = 会话转录文件名主干，与会话间协作的寻址键同源（engine/sessions.js hashOf = 路由 hash）
      items.push({ kind: 'session', name: s.title || '未命名会话', sid: hashOf(s), desc: relTime(s.updatedAt), t: s.updatedAt, own, proj: own ? '' : sessionProjLabel(s) })
    }
    // 当前项目自己的技能（项目根 .claude/skills）：与 + 工具栏技能组同源，行尾标项目编号。
    const proj = home
    // 启用态只控制会话启动时是否加载（agent 可见面）；@ 入口不受它约束——停用件照常可搜可插，
    // 用户主动 @ 即视为显式指定该项（用户定案）。
    for (const s of projSkillsOf(proj).list) if (match(s.n) || match(s.d)) items.push({ kind: 'skill', name: s.n, desc: s.d, proj, t: 0 })
    if (MGR) {
      // 技能只给当前项目自己的（有项目上下文时不再混便携根全局技能）；
      // 插件是便携根安装件、无项目归属，两种上下文都列。
      for (const p of (MGR.plugins && MGR.plugins.personal) || []) if (match(p.n)) items.push({ kind: 'plugin', name: p.n, desc: p.d, t: 0 })
      if (!proj) for (const s of (MGR.skills && MGR.skills.personal) || []) if (match(s.n)) items.push({ kind: 'skill', name: s.n, desc: s.d, t: 0 })
    }
    items.push(...pickItems(q))
    // 跨类搜索排序（2026-11-08 用户定案）：匹配度优先；同分本项目会话在前；再按时间倒序。
    if (globalSearch) {
      for (const it of items) it.ms = matchScore(it.name, ql)
      items.sort((a, b) => (b.ms || 0) - (a.ms || 0) || (b.own || 0) - (a.own || 0) || (b.t || 0) - (a.t || 0))
    }
    return items
  }

  // 会话行（会话入口与搜索共用）：sid = 会话间协作的寻址键，两个路口径必须一致（同 @ 提及链）。
  // 不按项目隔离（2026-11-08 用户定案）：匹配度优先 → 本项目在前 → 时间倒序，均走 scope.js 的 sortSessions。
  function cmdSessionRows(q, grp) {
    const out = []
    const home = pickHome()
    const ql = String(q || '').trim().toLowerCase()
    const rows = ALL.filter((s) => !ql || String(s.title || '').toLowerCase().includes(ql))
    for (const s of sortSessions(rows, ql, home)) {
      const own = sessionOwn(s, home)
      out.push({ kind: 'session', name: s.title || '未命名会话', sid: hashOf(s), desc: relTime(s.updatedAt), grp, own, proj: own ? '' : sessionProjLabel(s) })
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
    // 技能按上下文项目隔离——有项目上下文只列该项目根 .claude/skills，
    // 不再混入便携根全局技能（MGR.skills.personal 只服务无项目上下文的全局态）。
    // 启用态只控制会话加载，不约束入口：停用件照常列（用户可主动选用，见 mentionItems 同条）。
    if (proj) {
      for (const s of projSkillsOf(proj).list) if (!match || match(s.n) || match(s.d)) out.push({ kind: 'skill', name: s.n, desc: s.d, grp, proj })
    } else if (MGR) {
      for (const s of (MGR.skills && MGR.skills.personal) || []) if (!match || match(s.n) || match(s.d)) out.push({ kind: 'skill', name: s.n, desc: s.d, grp })
    }
    // 插件是便携根安装件、无项目归属，两种上下文都列（与技能不同源，不算「混入」）
    if (!MGR) return out
    for (const p of (MGR.plugins && MGR.plugins.personal) || []) if (!match || match(p.n) || match(p.d)) out.push({ kind: 'plugin', name: p.n, desc: p.d, grp })
    return out
  }
  // 文件索引（pickAll）流式进度只影响「正在展示文件结果」的视图（文件视图 / @ 跨类搜索）；
  // 其余视图（技能/会话/指令/首屏）不因索引进度整块重渲。
  function pickProgressRenders() {
    return cmd.view === 'file' || (cmd.mentionMode && !cmd.view && !!mention.q.trim())
  }
  // 文件清单是流式产出的（BFS 每批即并入）：跑完且零命中才报「无匹配」，未跑完就在尾部挂
  // 「搜索中…」——有命中照常列出，用户不必干等全量索引。base = 推入搜索结果前的行数（文件视图无「返回」行）。
  function pushSearchState(items, base) {
    if (pickAll.err) { items.push({ kind: 'pathwait', name: '索引失败', desc: pickAll.err }); return }
    if (!pickAll.done) { items.push({ kind: 'pathwait', name: '搜索中…', desc: '正在索引 ' + (pickAll.root || '工作区根') }); return }
    if (items.length === (base || 0)) items.push({ kind: 'pathwait', name: '无匹配结果', desc: '' })
  }
  // 浮窗滚动量保持的「同一屏」判据：模式 / 视图 / 查询词 / 当前浏览层任一变化 = 换了一屏，
  // 旧 scrollTop 必须作废（否则新屏带着上一屏的滚动量，分组标题被顶上裁掉半截）。
  function cmdViewKey() {
    const q = (cmd.mentionMode ? mention.q : toolbarQueryText()).toLowerCase()
    return `${cmd.mentionMode ? '@' : '+'}|${cmd.view || ''}|${q}|${pick.path}|${pick.searchOff ? 'browse' : 'search'}`
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
      if (cmd.view === 'session') items.push(...cmdSessionRows(q, '会话'))
      else if (cmd.view === 'skill') items.push(...cmdSkillRows(match, '技能'))
      // 指令分支必须带花括号：`else if (…) for (…) if (…) push()` 后面再跟 `else if` 会把
      // 它吸附给内层 if（悬垂 else），文件视图分支永远不执行（2026-10-25 根因：@ 点「文件」只剩「返回」）。
      else if (cmd.view === 'cmd') {
        for (const o of MOCK_COMMANDS) if (match(o.name) || match(o.desc)) items.push({ kind: 'cmd', name: o.name, desc: o.desc, ref: o, grp: '指令' })
      }
      // 文件视图：有查询词 = 只搜文件（同一条项目文件清单，不含会话/技能）；空查询 = 层内浏览。
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
