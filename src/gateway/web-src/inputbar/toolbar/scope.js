// 工具栏范围与排序唯一判据（2026-11-07 工具栏模块化切割自 inputbar/mention.js；唯一手改处，web/app.js 为生成物）
// 「会话」检索**不按项目隔离**（2026-11-08 用户定案）：全项目会话都可被引用，排序 = 匹配度优先、
// 同分本项目会话在前、再按更新时间倒序。技能/文件仍按 pickHome 收口（见 entries.js / pick.js）。

import { findSession } from '../../engine/sessions.js'
import { newSessionProject, sessionProjLabel } from '../../core/util.js'
import { state } from '../../engine/state.js'
/* @module inputbar/toolbar/scope.js */
  // ---------- 上下文项目（技能/文件范围的唯一来源）----------
  // 会话态 = 该会话所属项目；非会话态 = 目标项目（`newSessionProject()`，work 模式即工作项目）。
  // 空串 = 全局上下文（无项目归属）→ 文件从工作区根起、技能取便携根全局。
  function pickHome() {
    const s = state.currentHash ? findSession(state.currentHash) : null
    if (s) return sessionProjLabel(s)
    return newSessionProject() || ''
  }
  // ---------- 匹配度（排序唯一判据）----------
  // 档位：精确 > 前缀 > 词边界（空格/连字符/下划线/斜杠/点/中英括号之后）> 子串；
  // 同档内命中位置越靠前分越高。0 = 不匹配（调用方已过滤）。
  function matchScore(text, q) {
    const t = String(text || '').toLowerCase()
    const ql = String(q || '').trim().toLowerCase()
    if (!ql) return 0
    const i = t.indexOf(ql)
    if (i < 0) return 0
    const tier = t === ql ? 4 : i === 0 ? 3 : /[\s\-_/.·|[\]()（）【】]/.test(t[i - 1]) ? 2 : 1
    return tier * 100000 - Math.min(i, 99999)
  }
  // 会话是否属当前上下文项目（同分排序用）。
  function sessionOwn(s, home) {
    return home && sessionProjLabel(s) === home ? 1 : 0
  }
  // 会话排序：匹配度 → 本项目优先 → 更新时间倒序。q 为空 = 无匹配度，仅「本项目优先 + 时间」。
  function sortSessions(list, q, home) {
    const ql = String(q || '').trim().toLowerCase()
    const key = new Map()
    for (const s of list) {
      key.set(s, { score: ql ? matchScore(s.title, ql) : 0, own: sessionOwn(s, home), t: s.updatedAt || 0 })
    }
    return list.slice().sort((a, b) => {
      const ka = key.get(a)
      const kb = key.get(b)
      return kb.score - ka.score || kb.own - ka.own || kb.t - ka.t
    })
  }
