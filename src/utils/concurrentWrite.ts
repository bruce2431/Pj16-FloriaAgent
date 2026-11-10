/**
 * 并发写协作策略：快照完整性判定 + 归一化比较 + 三方合并 + 文案格式化。
 *
 * 语义边界（照抄 docs/core.md 的口径，改前先看文档）：
 * - 行尾差异（CRLF/LF）、文件 BOM、末尾换行差异**永远不算并发修改**。
 * - 合并前统一归一为 LF 且去 BOM；回写时 BOM 由调用方决定
 *   （Edit = 跟随磁盘，Write = 跟随模型给出的内容）。
 * - 非 UTF-8（检测为 utf16le 等）只允许 Edit 重放，禁止三方合并。
 * - 只有完整快照可作合并 base（source ∈ read/tool-write/seed，未截断、未局部读）。
 *
 * 残余竞态：本模块只做同步计算，读盘与写盘之间的窗口由调用方保持无 await；
 * 仍可能被外部进程在窗口内覆盖，本轮不引入跨进程锁（无 CAS 原语，外部编辑器
 * 也不参与锁协议）。被覆盖内容可由 fileHistoryTrackEdit 的备份找回。
 */

import { describeFileModifier } from './fileModifierRegistry.js'
import type { FileState } from './fileStateCache.js'
import {
  WK_MERGE_MAX_LINES,
  wkMerge3,
  type LineDelta,
  type Merge3Result,
} from './threeWayMerge.js'

export { describeFileModifier }

const BOM = '\uFEFF'

/** 去 UTF-8/UTF-16 解码后残留的 BOM 字符。 */
export function stripUtf8Bom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export function hasUtf8Bom(text: string): boolean {
  return text.charCodeAt(0) === 0xfeff
}

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * 比较用归一化：去 BOM、CRLF→LF、去末尾换行。
 * 只用于「磁盘是否真的被改过」的判定，不用于合并结果。
 */
export function normalizeForCompare(text: string): string {
  return normalizeLineEndings(stripUtf8Bom(text)).replace(/\n+$/, '')
}

export function readSnapshotMatchesDisk(
  snapshot: string,
  disk: string,
): boolean {
  return normalizeForCompare(snapshot) === normalizeForCompare(disk)
}

/**
 * 缓存条目是否能充当三方合并的 base。
 * Read 全量读会把 offset 记为 1（或 0）；局部读必带 limit，截断读带 truncated。
 */
export function isCompleteReadSnapshot(
  state: FileState | undefined,
): boolean {
  if (!state) return false
  if (state.isPartialView || state.truncated) return false
  if (
    state.source !== 'read' &&
    state.source !== 'tool-write' &&
    state.source !== 'seed'
  ) {
    return false
  }
  if (state.limit !== undefined) return false
  if (state.offset === undefined) return true
  return state.offset === 0 || state.offset === 1
}

export type MergePolicyResult =
  | Merge3Result
  | { ok: false; reason: 'unsupported-encoding' }

/**
 * 策略层三方合并：仅 UTF-8；三侧归一（去 BOM、LF）后交给 wkMerge3。
 * 成功返回的 text 为 LF、无 BOM，回写格式由调用方还原。
 */
export function mergeTextWithPolicy(args: {
  base: string
  local: string
  remote: string
  encoding: BufferEncoding
}): MergePolicyResult {
  if (args.encoding !== 'utf8') {
    return { ok: false, reason: 'unsupported-encoding' }
  }
  const norm = (text: string) => normalizeLineEndings(stripUtf8Bom(text))
  return wkMerge3(norm(args.base), norm(args.local), norm(args.remote))
}

export type ConcurrentChangeReason =
  | 'conflict'
  | 'too-large'
  | 'no-merge-base'
  | 'unsupported-encoding'

export function formatConcurrentChangeError(opts: {
  reason: ConcurrentChangeReason
  modifier?: string
  conflictLine?: number
  remoteChanges?: LineDelta
}): string {
  const who = describeFileModifier(opts.modifier)
  switch (opts.reason) {
    case 'conflict': {
      const delta = opts.remoteChanges
        ? ` (+${opts.remoteChanges.added} -${opts.remoteChanges.removed})`
        : ''
      const line = opts.conflictLine ? ` at line ${opts.conflictLine}` : ''
      return `File was modified on disk by ${who}${delta}, overlapping your change${line}. Re-read the file and retry.`
    }
    case 'too-large':
      return `File was modified on disk by ${who}. It is too large to merge automatically (over ${WK_MERGE_MAX_LINES} lines). Re-read the file and retry.`
    case 'no-merge-base':
      return `File was modified on disk by ${who}, but there is no complete snapshot to merge from (partial read, truncated read, or injected content). Re-read the whole file and retry.`
    case 'unsupported-encoding':
      return `File was modified on disk by ${who}. Automatic merging is only available for UTF-8 files. Re-read the file and retry.`
  }
}

export function formatConcurrentMergeNote(opts: {
  modifier?: string
  changes: LineDelta
}): string {
  const who = describeFileModifier(opts.modifier)
  return `merged with concurrent changes by ${who} (+${opts.changes.added} -${opts.changes.removed})`
}
