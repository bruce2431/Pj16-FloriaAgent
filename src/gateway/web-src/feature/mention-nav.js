// @ 提及 / 引用 chip 的点击派发器（2026-11-08）：chip 的**唯一业务落点**。
// 三层分工：core/mention-syntax.js 只给链接凭据（data-mjump/data-mname/…）+ CM6 包只透传点击
// （H.chips.activate(spec)）+ 消息区/输入栏只做事件委托；本件把两者归一成 target，解析路径所属项目、
// 准备上下文（work 模式 / 工作项目），再经**卡片公开 API**（engine/card-bus.js）驱动目标卡。
// 跳转目标：会话 → chat 卡 open{sid}（切会话）；文件 → work 卡 scroll{path,line}（work 打开 + 定位行）；
// 目录 → work 卡 reveal{path}（文件树展开并定位）；插件/技能 → 插件卡 openDetail{name}，全局没有时
// 落到当前项目的 work 插件页；引用（qjump）保持原行为（reply → chat scroll；file → work scroll）。
// 依赖方向：feature → engine/core 与同层 sidebar（setSbMode / selectProject 为共享 IIFE 内的函数声明）。
import { cardBus } from '../engine/card-bus.js'
import { apiUrl } from '../engine/gateway.js'
import { ALL, state } from '../engine/state.js'
import { findSession, hashOf, loadSessions } from '../engine/sessions.js'
import { splitSessionToken, unescapeMentionPath } from '../core/mention-syntax.js'
import { sessionProjLabel, toast } from '../core/util.js'
import { setSbMode } from '../sidebar/work.js'
/* @module feature/mention-nav.js */

  const MENTION_NAV_CARD_TIMEOUT = 15000

  // ---------- chip / CM6 spec → target ----------
  function mentionTargetFromChip(el) {
    if (!el || !el.dataset) return null
    const q = el.dataset.qjump
    if (q === 'reply') return { kind: 'reply', idx: Number(el.dataset.qidx) || 0 }
    if (q === 'file') return { kind: 'ref', path: el.dataset.qpath || '', line: Number(el.dataset.ql0) || 0 }
    const m = el.dataset.mjump
    if (m === 'session') {
      const t = splitSessionToken(el.dataset.mname || '')
      return { kind: 'session', title: t.title, sid: t.sid }
    }
    if (m === 'path') {
      return { kind: 'path', ptype: el.dataset.mptype === 'dir' ? 'dir' : 'file', path: el.dataset.mname || '' }
    }
    if (m === 'plugin') return { kind: 'plugin', name: el.dataset.mname || '' }
    return null
  }

  // CM6 token spec（SubPj4 composer 的 CM_TOKENS 产物）：session{name='标题|sid'}、path{ptype,name}、
  // plugin{name}、ref{rkind,file,l0,idx}。att（上传附件）不是链接，调用方已排除。
  function mentionTargetFromSpec(spec) {
    if (!spec || typeof spec !== 'object') return null
    if (spec.kind === 'session') {
      const t = splitSessionToken(spec.name || '')
      return { kind: 'session', title: t.title, sid: t.sid }
    }
    if (spec.kind === 'path') {
      return { kind: 'path', ptype: spec.ptype === 'dir' ? 'dir' : 'file', path: spec.name || '' }
    }
    if (spec.kind === 'plugin') return { kind: 'plugin', name: spec.name || '' }
    if (spec.kind === 'ref') {
      if (spec.rkind === 'reply') return { kind: 'reply', idx: Number(spec.idx) || 0 }
      return { kind: 'ref', path: spec.file || '', line: Number(spec.l0) || 0 }
    }
    return null
  }

  // ---------- 路径 → 项目 + 项目内相对路径 ----------
  function mentionProjectLabels() {
    const out = []
    for (const g of state.projects || []) if (g && g.label && g.scope === 'project') out.push(g.label)
    return out
  }

  // 当前会话所属项目（chat 侧判据 = sessionProjLabel；work 侧回落工作项目）。
  function mentionCurrentProject() {
    const s = findSession(state.currentHash)
    const lab = s ? sessionProjLabel(s) : ''
    return lab || state.workProj || ''
  }

  // 路径口径与 @ 提及一致（inputbar/mention.js refPath）：会话 cwd 就是项目本身时是项目内相对路径，
  // 跨项目时带 `<项目 label>/` 前缀。解析 = 归一分隔符 + 剥工作区根 + 按**最长项目 label 前缀**匹配
  // （避免 Pj1 误命中 Pj10-*）；无项目前缀时归到当前会话项目。
  function resolveMentionPath(raw) {
    let full = unescapeMentionPath(raw).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (!full) throw new Error('缺少路径')
    const ws = String(state.workspace || '').replace(/\\/g, '/').replace(/\/+$/, '')
    if (ws && full.startsWith(ws + '/')) full = full.slice(ws.length + 1)
    let best = ''
    for (const l of mentionProjectLabels()) {
      if ((full === l || full.startsWith(l + '/')) && l.length > best.length) best = l
    }
    if (best) return { project: best, rel: full === best ? '' : full.slice(best.length + 1) }
    const cur = mentionCurrentProject()
    if (!cur) throw new Error('无法确定该路径所属项目：' + full)
    return { project: cur, rel: full }
  }

  // 切到 work 模式并选中目标项目（树/预览等补拉由 selectProject 自己完成；同项目时保持现状）。
  async function ensureMentionWork(project) {
    if (!project) throw new Error('无法确定目标项目')
    if (!state.projects.length) {
      try { await loadSessions() } catch { /* 拉取失败仍可试切（selectProject 会导航） */ }
    }
    if (state.sbMode !== 'work') setSbMode('work')
    if (state.workProj !== project) await selectProject(project)
    if (state.workProj !== project) throw new Error('切换到项目失败：' + project)
  }

  // ---------- 卡片调用 ----------
  async function callMentionCard(target, cmd, args, timeoutMs) {
    const ack = await cardBus.callCard(target, cmd, args, { timeoutMs: timeoutMs || MENTION_NAV_CARD_TIMEOUT })
    if (ack && ack.ok === false) throw new Error(ack.error || '跳转失败')
    return ack ? ack.result : null
  }

  // 会话寻址：优先令牌自带的 sid；旧消息（无 sid）按标题精确匹配列表，重名则显式报错不猜。
  function resolveSessionSid(t) {
    if (t.sid) return t.sid
    const title = String(t.title || '').trim()
    if (!title) return ''
    const hits = ALL.filter((s) => String(s.title || '') === title)
    if (hits.length === 1) return hashOf(hits[0])
    if (hits.length > 1) throw new Error('存在多个同名会话，无法定位：' + title)
    return ''
  }

  async function activateSessionChip(t) {
    const sid = resolveSessionSid(t)
    if (!sid) throw new Error('找不到会话：' + (t.title || t.sid || ''))
    await callMentionCard({ instanceId: 'floria-chat' }, 'open', { sid })
  }

  // 插件/技能：先查全局（工作区根）管理卡；没有再看当前项目的插件页（项目自带插件/技能）。
  async function activatePluginChip(name) {
    const n = String(name || '').trim()
    if (!n) throw new Error('缺少插件名称')
    const ack = await cardBus.callCard({ instanceId: 'floria-plugins' }, 'openDetail', { name: n }, { timeoutMs: 20000 })
    if (ack && ack.ok) return ack.result
    const project = state.workProj || mentionCurrentProject()
    if (!project) throw new Error((ack && ack.error) || ('未找到插件/技能：' + n))
    await ensureMentionWork(project)
    await callMentionCard({ instanceId: 'floria-work-plugins' }, 'openDetail', { name: n }, 20000)
  }

  // ---------- 唯一入口 ----------
  async function runMentionTarget(t) {
    if (t.kind === 'session') return activateSessionChip(t)
    if (t.kind === 'reply') return callMentionCard({ instanceId: 'floria-chat' }, 'scroll', { line: t.idx })
    if (t.kind === 'plugin') return activatePluginChip(t.name)
    if (t.kind === 'ref') {
      // 引用 chip 保持原行为：不自动切模式/项目，卡内门禁失败由 toast 呈现
      return callMentionCard({ instanceId: 'floria-work' }, 'scroll', { path: t.path, line: t.line || 0 })
    }
    if (t.kind === 'path') {
      const r = resolveMentionPath(t.path)
      await ensureMentionWork(r.project)
      if (t.ptype === 'dir') return callMentionCard({ instanceId: 'floria-work' }, 'reveal', { path: r.rel })
      return callMentionCard({ instanceId: 'floria-work' }, 'scroll', { path: r.rel, line: t.line || 0 })
    }
  }

  // 消息内文件引用 chip 的「在资源管理器中打开」（dsh 文件卡同形）：复用 work 文件树同一条
  // `/gateway/file/reveal`（网关侧 shell API 打开 + 置顶），不新增后端。路径口径同 chip 跳转：
  // 按项目 label 前缀解析，文件=父目录选中、目录=直接打开。
  async function revealMentionPath(raw) {
    const r = resolveMentionPath(raw)
    const res = await fetch(apiUrl('/gateway/file/reveal'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: r.project, path: r.rel }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) throw new Error((data && data.error) || '打开失败')
  }

  async function activateMentionReveal(raw) {
    try { await revealMentionPath(raw) } catch (e) { toast((e && e.message) || String(e)) }
  }

  async function activateMention(target) {
    if (!target) return
    try {
      await runMentionTarget(target)
    } catch (e) {
      toast((e && e.message) || String(e))
    }
  }
