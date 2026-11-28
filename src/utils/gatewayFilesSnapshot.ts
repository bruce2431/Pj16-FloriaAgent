/**
 * web 摘要浮层数据源（与 usage-state 同链：CLI 算、网关只传输）：
 * - files = 上下文文件（FileStateCache 的键，与 /files 命令同源）
 * - changed = 本会话文件变更（转录 toolUseResult 聚合，与 /diff 回合视图同一套抽取规则）
 * 路径统一转成相对 cwd，web 直接展示。整份快照无状态，重连补发一次即可。
 */
import { relative } from 'path'
import { collectChangedFiles } from '../hooks/useTurnDiffs.js'
import type { Message } from '../types/message.js'
import { cacheKeys, type FileStateCache } from './fileStateCache.js'

export type FilesStateChanged = {
  path: string
  added: number
  removed: number
  isNew: boolean
}

export type FilesState = {
  files: string[]
  changed: FilesStateChanged[]
}

function toRelative(cwd: string, p: string): string {
  // Windows 相对路径回退为 /（与消息流文件 chip / @ 提及同一写法）
  return (relative(cwd, p) || '.').replace(/\\/g, '/')
}

export function buildFilesState(
  messages: readonly Message[],
  readFileState: FileStateCache,
  cwd: string,
): FilesState {
  const files = cacheKeys(readFileState).map((p) => toRelative(cwd, p))
  files.sort((a, b) => a.localeCompare(b))
  const changed = collectChangedFiles(messages)
    .map((c) => ({
      path: toRelative(cwd, c.filePath),
      added: c.linesAdded,
      removed: c.linesRemoved,
      isNew: c.isNewFile,
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
  return { files, changed }
}
