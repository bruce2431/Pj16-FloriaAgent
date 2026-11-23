/**
 * SessionSearch 的模型可见说明（纯文本英文，参照 ToolSearch 风格）。
 * 范围与分工必须说死：只搜本项目最近 10 个标题；跨项目靠用户 @ 令牌给 sid。
 */

export const SESSION_SEARCH_DESCRIPTION = 'Find a recent session in this project by title; returns its sid for SessionSend'

export function getSessionSearchPrompt(): string {
  return `Find a session in this project by title and return its sid for \`SessionSend\`.

Scope is fixed: the 10 most recently updated sessions in this session's own project (a global-root session uses the global scratch area). Only titles are matched, case-insensitive substring; transcripts and other projects are not searched. For another project, the user must expose the sid via an \`[@session:title|sid]\` token.

\`query\` is a keyword from the title, not a sentence. The receipt lists matching sid, title, update time, and state; with no match it lists the current 10 candidates — retry with another keyword instead of guessing a sid. Read-only; it performs no external action.`
}
