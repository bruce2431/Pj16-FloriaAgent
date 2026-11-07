// 工具栏项目隔离唯一判据（2026-11-07 工具栏模块化切割自 inputbar/mention.js；唯一手改处，web/app.js 为生成物）
// @ 提及与 + 工具栏的「会话 / 技能 / 文件」三类范围一律从这里取，禁止调用点自写比较。

import { findSession } from '../../engine/sessions.js'
import { newSessionProject, sessionProjLabel } from '../../core/util.js'
import { state } from '../../engine/state.js'
/* @module inputbar/toolbar/scope.js */
  // ---------- 上下文项目（工具栏项目隔离的唯一来源）----------
  // 会话态 = 该会话所属项目；非会话态 = 目标项目（`newSessionProject()`，work 模式即工作项目）。
  // 空串 = 全局上下文（无项目归属）→ 文件从工作区根起、技能取便携根全局、会话不设隔离。
  function pickHome() {
    const s = state.currentHash ? findSession(state.currentHash) : null
    if (s) return sessionProjLabel(s)
    return newSessionProject() || ''
  }
  // 会话隔离判据（2026-11-07 用户定案）：home = 调用方算好的 `pickHome()`（列表循环里只算一次）。
  //  - 有项目上下文 → **严格**只给该项目的会话（sessionProjLabel 是项目归属的唯一真源）；
  //  - 全局上下文（home 为空）→ **不设隔离**，所有项目的会话都可被引用/搜索（用户明确的例外）。
  function sessionInScope(s, home) {
    if (!home) return true
    return sessionProjLabel(s) === home
  }
