/**
 * 会话寻址（2026-09-18）—— SessionSend 的 to（sid）→ 目标会话，解析唯一出口。
 * 发现入口归 SessionSearch（本会话所在项目最近 10 个标题 → sid）；跨项目 sid 由用户 @ 令牌提供。
 *
 * **2026-09-18 用户定案：撤除「暴露即授权」门**（前身为 sessionExposure.ts）。
 *   原设计（09-15）：只有被 @ 提及（或来过件）的会话可发，授权集合由上下文扫描派生——
 *   压缩会把令牌卷走、恢复只能靠用户手工重新 @（旧头注释自证）。实测一次真实卡线
 *   （目标会话离线 + 压缩丢授权叠加）后定案：机制性摩擦 > 收益，授权门整体移除——
 *   可发会话目录内**任何**会话；@ 提及仅存 UI 引用语义（往消息里塞会话 chip），不再承担授权。
 *   ⚠️ 移除后「非必要不通信」（全局 CLAUDE.md 通信约束节 + 工具说明）成为**唯一刹车**；
 *   实测出现 agent 对喷 → 回头补硬护栏（限频/审批）。
 *
 * **本模块保持纯函数、零 import**——目录（GET /gateway/sessions 归一形态）与本会话 sid
 * 由调用方注入（SessionSendTool 的 checkPermissions 与 call 各解析一次，见该文件头注）。
 * 解析不猜不兜底：sid 整串精确命中；未找到/自环/空 → error 原文回给模型。
 * 2026-11-23：标题寻址分支移除（发现归 SessionSearch），跨项目目标走用户 @ 令牌的 sid。
 *
 * 2026-09-20：发送模式判定（resolveSendMode：existing / new / invalid）同样收在本模块——
 * 「发给已有会话」与「拉起新会话」的分岔必须是单一出口，否则工具 schema、权限门与执行点
 * 三处各判一次必然漂移。
 */

/** 会话目录项（网关 /gateway/sessions 归一后的形态，sid = 转录文件名主干）。
 *  2026-11-23（SessionSearch）：补项目归属与活动元数据——Search 按 projectLabel 圈定候选、
 *  按 updatedAt 排序；SessionSend 的 sid 寻址只用 sid/title，新增字段均为可选、零影响。 */
export type KnownSession = {
  sid: string
  title: string
  projectLabel?: string
  projectScope?: string
  updatedAt?: number
  state?: string | null
}

export type ResolvedSessionTarget = { sid: string; title: string }

/** 解析结果：target 与 error 恰一非空（不静默兜底） */
export type TargetResolution = { target: ResolvedSessionTarget | null; error: string | null }

/**
 * to → 目标会话（2026-11-23 收窄为**只认 sid**）。
 * 判据：trim 后与目录 sid 整串精确命中；未命中 / 指向本会话自己 / 空 → error。
 * 标题寻址已移除：发现入口唯一归 SessionSearch（当前项目最近 10 个标题），跨项目目标由
 * 用户 `[@会话:标题|sid]` 令牌或 new_session 回执提供 sid；不猜、不做标题全等/前缀匹配。
 * 仍查目录一次：sid 合法性（存在、非自身）必须在执行点校验，不能只依赖投递回执。
 */
export function resolveSessionTargetBySid(
  dir: readonly KnownSession[],
  to: string,
  selfSid: string,
): TargetResolution {
  const q = to.trim()
  if (!q) return { target: null, error: '目标 sid 为空' }
  const hit = dir.find(s => s.sid === q)
  if (!hit) {
    return {
      target: null,
      error: `会话 sid「${q}」未找到（可能已删除；当前项目的会话可用 SessionSearch 查，其它项目请让用户 @ 会话提供 sid）`,
    }
  }
  if (hit.sid === selfSid) return { target: null, error: '目标指向本会话自己，已拒绝' }
  return { target: { sid: hit.sid, title: hit.title }, error: null }
}

/**
 * 发送模式（2026-09-20 新增「拉起新会话」）——工具入参 → 该走哪条链路的唯一判定出口。
 *   existing = 发给目录内已有会话（to）；
 *   new      = 拉起一个全新会话并投递首条消息（new_session + project，project 必填）；
 *   invalid  = 形状拒绝。**不猜不兜底**：不把「to 空」当新建、不把「new_session 无 project」
 *              回落全局根——语义冲突与缺参一律原样报给模型（与 resolveSessionTarget 同一立场）。
 * project 的 label 是否真实存在由调用方查目录校验（本模块保持纯函数、零 import）。
 */
export type SendMode =
  | { kind: 'existing'; to: string }
  | { kind: 'new'; project: string; model?: string }
  | { kind: 'invalid'; error: string }

export function resolveSendMode(input: {
  to?: string
  new_session?: boolean
  project?: string
  /** 2026-10-13（待办 14）：新会话指定模型（池内全名）。仅 new_session 形态有效；
   *  是否 ∈ 凭据池由调用方校验（本模块保持纯函数、零 import），此处只做形状归属判定。 */
  model?: string
}): SendMode {
  const to = (input.to ?? '').trim()
  const project = (input.project ?? '').trim()
  const model = (input.model ?? '').trim()
  if (input.new_session === true) {
    if (to) {
      return {
        kind: 'invalid',
        error: 'new_session 与 to 互斥：新会话尚无目标可寻址，请只填 new_session + project',
      }
    }
    if (!project) {
      return {
        kind: 'invalid',
        error: 'new_session 必须指定 project（新会话落在哪个项目）',
      }
    }
    return { kind: 'new', project, ...(model ? { model } : {}) }
  }
  if (project) {
    return {
      kind: 'invalid',
      error: 'project 仅在 new_session: true 时有效（发给已有会话请用 to 寻址）',
    }
  }
  if (model) {
    return {
      kind: 'invalid',
      error: 'model 仅在 new_session: true 时有效（发给已有会话的模型由目标会话自己决定）',
    }
  }
  if (!to) {
    return {
      kind: 'invalid',
      error: 'to 不能为空（要新建会话请设 new_session: true 并指定 project）',
    }
  }
  return { kind: 'existing', to }
}
