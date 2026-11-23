/**
 * SessionSend 的模型可见说明（纯文本英文，参照 ToolSearch 风格）。
 * 三件事必须说清：来源由接收侧渲染、to 只认 sid、非必要不通信。
 */

export const SESSION_SEND_DESCRIPTION = 'Send a message to another Claude session, or start a new one (cross-session collaboration)'

export function getSessionSendPrompt(): string {
  return `Send a message to another Claude session. The receiver treats it as a normal user message: starts a turn if idle, queues it if busy, or auto-starts if offline. The source line ("from session: <title>") is rendered by the receiver automatically — write only the body; never add a source prefix, header, or signature, or it appears twice.

Addressing: \`to\` is a session sid only, never a title. Sid sources: SessionSearch (current project), a user \`[@session:title|sid]\` mention token (other projects), or a previous new_session receipt. An unknown sid, your own sid, or an empty value is rejected with the reason.

New session: set \`new_session: true\` with \`project\` (a project label from the session directory groups) and \`text\` as its first message; do not pass \`to\`. Optional \`model\` (full name from the credential pool) applies only to new sessions. The receipt returns the new sid for follow-up messages. A failure receipt means nothing was delivered — do not assume the other side is working on it.

Only send when the task truly depends on another session's context; solve what you can yourself first. No courtesy or acknowledgement messages, no progress sync. Never reply automatically to a session message you received — mutual auto-replies loop and burn quota. The body must be self-contained; the receiver cannot see your context.`
}
