// 工具栏条目层（2026-11-07 工具栏模块化切割自 inputbar/mention.js + inputbar/commands.js；唯一手改处，web/app.js 为生成物）
// 只负责「查询词 → 条目数组」：@ 扁平搜索、+ 的分组入口视图、文件结果；不碰 DOM，渲染归 commands.js。

import { I } from '../../core/icons.js'
import { relTime } from '../../core/markdown.js'
import { sessionProjLabel } from '../../core/util.js'
import { hashOf } from '../../engine/sessions.js'
import { ALL } from '../../engine/state.js'
import { MGR, projSkillsOf } from '../../sidebar/mgr-data.js'
import { pendingImages, uploadedMentionItems } from '../images.js'
import { MENTION_PLUGIN_ICON, MENTION_SESSION_ICON, MENTION_SKILL_ICON, mention } from '../mention.js'
import { MOCK_COMMANDS, cmd } from '../commands.js'
import { projElementsOf } from './elements.js'
import { pick, pickAll, pickItems, pickSearchKick } from './pick.js'
import { matchScore, pickHome, sessionOwn, sortSessions } from './scope.js'
/* @module inputbar/toolbar/entries.js */
  // ---------- 条目分组（+ 工具栏入口视图的唯一真源）----------
  // 搜索结果**不分组也不截断**（2026-10-25 用户定案：@ 唤起同一工具栏、扁平按时间排列）；
  // groupOf 只服务 + 工具栏的入口视图（每类一屏）与首屏两组（上传 / 浏览）。
  const GROUP_OF = { imgpick: '上传', filepick: '上传', attref: '上传', session: '聊天', plugin: '技能', skill: '技能', path: '文件', pathup: '文件', pathwait: '文件' }
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
  // 元素入口只在当前上下文确有声明时出现（2026-11-13）：声明来自预览页（preview.json / card.json
  // 的 elements[]），网关扫描；无声明时首屏保持原样，不留空入口。
  // 入口名与下钻分组名由声明决定（preview.json 的 elementsTitle），未声明回落「元素」。
  function elementTitle() {
    return projElementsOf(pickHome()).title || '元素'
  }
  function cmdViews() {
    const out = CMD_VIEWS.slice()
    if (projElementsOf(pickHome()).list.length) {
      out.push({ view: 'element', name: elementTitle(), desc: '引用' + elementTitle() + '（预览页声明）', icon: I.chip })
    }
    return out
  }
  // 过滤查询唯一来源 = 锚点（`@` 位置 / 「+」点击时的光标）到光标的文本 = `mention.q`。
  // 弃独立搜索框（2026-10-14 待办 20 返修）：旧框每次 input 都 innerHTML 重渲并**重建框自身**，
  // IME 组合期被打断 = 中文打不进；底栏文本驱动则渲染只碰浮窗，中文 IME 正常。
  // 命令前缀 / 由本函数剥。
  function cmdQuery() {
    return mention.q.trim().toLowerCase().replace(/^\//, '')
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
    // 技能 = 当前项目自己的（项目根 .claude/skills，行尾标项目编号）+ 便携根全局技能，两种上下文都列：
    // 技能是跨项目通用能力，项目没有自己的技能时（如 Pj18）入口不能空着。同名时项目件优先、不重复列。
    const proj = home
    // 启用态只控制会话启动时是否加载（agent 可见面）；@ 入口不受它约束——停用件照常可搜可插，
    // 用户主动 @ 即视为显式指定该项（用户定案）。
    const skillNames = new Set()
    for (const s of projSkillsOf(proj).list) {
      if (!match(s.n) && !match(s.d)) continue
      skillNames.add(s.n)
      items.push({ kind: 'skill', name: s.n, desc: s.d, proj, t: 0 })
    }
    if (MGR) {
      // 插件是便携根安装件、无项目归属，两种上下文都列。
      for (const p of (MGR.plugins && MGR.plugins.personal) || []) if (match(p.n)) items.push({ kind: 'plugin', name: p.n, desc: p.d, t: 0 })
      for (const s of (MGR.skills && MGR.skills.personal) || []) {
        if (skillNames.has(s.n) || (!match(s.n) && !match(s.d))) continue
        items.push({ kind: 'skill', name: s.n, desc: s.d, t: 0 })
      }
    }
    // 元素 = 当前上下文的预览声明（2026-11-13，与「+ → 元素」同源）：@ 搜索可直接命中。
    const elGrp = elementTitle()
    for (const el of projElementsOf(home).list) {
      if (!match(el.name) && !match(el.desc)) continue
      items.push({ kind: 'element', name: el.name, desc: el.desc, el, grp: elGrp, t: 0 })
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
  // 技能行 = 插件（便携根）+ 便携根全局技能 + **当前项目自己的技能**（项目根 .claude/skills，行尾标项目名）。
  // 项目判定与 + 浮窗文件组同一处（pickHome：会话所属项目 / work 工作项目，空串 = 无项目上下文）。
  // 技能两种上下文都列（跨项目通用能力，项目没有自己的技能时入口不能空着）；同名时项目件优先。
  function cmdSkillRows(match, grp) {
    const out = []
    const proj = pickHome()
    const seen = new Set()
    // 启用态只控制会话加载，不约束入口：停用件照常列（用户可主动选用，见 mentionItems 同条）。
    if (proj) {
      for (const s of projSkillsOf(proj).list) {
        if (match && !match(s.n) && !match(s.d)) continue
        seen.add(s.n)
        out.push({ kind: 'skill', name: s.n, desc: s.d, grp, proj })
      }
    }
    if (!MGR) return out
    for (const s of (MGR.skills && MGR.skills.personal) || []) {
      if (seen.has(s.n) || (match && !match(s.n) && !match(s.d))) continue
      out.push({ kind: 'skill', name: s.n, desc: s.d, grp })
    }
    // 插件是便携根安装件、无项目归属，两种上下文都列（与技能不同源）
    for (const p of (MGR.plugins && MGR.plugins.personal) || []) if (!match || match(p.n) || match(p.d)) out.push({ kind: 'plugin', name: p.n, desc: p.d, grp })
    return out
  }
  // 元素行 = 当前上下文（pickHome，'' = 全局预览根）的预览声明；选中后按声明 insert 落地，
  // 前端不解释元素语义。数据层与 @ 跨类搜索同源（toolbar/elements.js 的 projElementsOf）。
  function cmdElementRows(match, grp) {
    const out = []
    for (const el of projElementsOf(pickHome()).list) {
      if (match && !match(el.name) && !match(el.desc)) continue
      out.push({ kind: 'element', name: el.name, desc: el.desc, el, grp })
    }
    return out
  }
  // 文件索引（pickAll）流式进度只影响「正在展示文件结果」的视图（文件视图 / @ 跨类搜索）；
  // 其余视图（技能/会话/指令/首屏）不因索引进度整块重渲。
  function pickProgressRenders() {
    if (cmd.view === 'file') return true
    if (cmd.view) return false
    return !!cmdQuery()
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
    return `${cmd.view || ''}|${cmdQuery()}|${pick.path}|${pick.searchOff ? 'browse' : 'search'}`
  }
  function cmdEntries() {
    const q = cmdQuery()
    const match = (s) => !q || String(s || '').toLowerCase().includes(q)
    const items = []
    // 范围判据（2026-10-25 用户定案）：**进了某一类视图 = 查询只在该类里搜**；没进视图时
    // 锚点后有查询词 = 跨类扁平全局搜索。无查询词 = 首屏入口（@ 刚打出 / 刚点 + 都是这一态）。
    if (cmd.view) {
      // 文件视图不叠「导航/返回」（2026-11-05 用户定案）：它自带「上级目录」，两行同图标上箭头 + 两个分组标题
      // 看着像两栏叠在一起；文件视图的退出走 Esc / 点浮窗外（pathup 行同时承担层内上行）。
      if (cmd.view !== 'file') items.push({ kind: 'back', name: '返回', grp: '导航' })
      if (cmd.view === 'session') items.push(...cmdSessionRows(q, '会话'))
      else if (cmd.view === 'skill') items.push(...cmdSkillRows(match, '技能'))
      else if (cmd.view === 'element') items.push(...cmdElementRows(match, elementTitle()))
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
    if (q) {
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
    for (const v of cmdViews()) items.push({ kind: 'entry', view: v.view, name: v.name, desc: v.desc, icon: v.icon, grp: '浏览' })
    return items
  }
