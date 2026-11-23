import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import { jsonParse } from '../../utils/slowOperations.js'
import type { Input, SessionSearchOutput } from './SessionSearchTool.js'

/** 工具行：只显示关键词（候选/命中明细在结果消息里）。 */
export function renderToolUseMessage(input: Partial<Input>): React.ReactNode {
  return typeof input.query === 'string' && input.query ? `🔎 会话搜索 ${input.query}` : null
}

export function renderToolResultMessage(
  content: SessionSearchOutput | string,
  _progressMessages: unknown,
  { verbose: _verbose }: { verbose: boolean },
): React.ReactNode {
  const result: SessionSearchOutput =
    typeof content === 'string' ? jsonParse(content) : content
  return (
    <MessageResponse>
      <Text dimColor>{result.message}</Text>
    </MessageResponse>
  )
}
