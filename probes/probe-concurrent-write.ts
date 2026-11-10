/**
 * concurrentWrite 探针
 *
 * 守护的不变量：行尾/BOM/末尾换行差异不算并发修改；只有完整快照可作合并 base；
 * 非 UTF-8 拒绝合并（只允许 Edit 重放）；归因与错误/合并文案口径统一。
 *
 * 用法：bun Floria/probes/probe-concurrent-write.ts
 */
import type { FileState } from '../src/utils/fileStateCache.ts'
import {
  describeFileModifier,
  formatConcurrentChangeError,
  formatConcurrentMergeNote,
  isCompleteReadSnapshot,
  mergeTextWithPolicy,
  normalizeForCompare,
  readSnapshotMatchesDisk,
} from '../src/utils/concurrentWrite.ts'

let pass = 0
let fail = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass += 1
    return
  }
  fail += 1
  failures.push(`${name}${detail ? ` —— ${detail}` : ''}`)
}

const state = (over: Partial<FileState>): FileState => ({
  content: 'a\nb',
  timestamp: 0,
  offset: 1,
  limit: undefined,
  source: 'read',
  ...over,
})

// A: 归一化比较
check(
  'A1 BOM/CRLF/末尾换行不算修改',
  readSnapshotMatchesDisk('a\nb', '\uFEFFa\r\nb\r\n'),
)
check('A2 真实内容差异仍判修改', !readSnapshotMatchesDisk('a\nb', 'a\nB'))
check(
  'A3 归一化只去末尾换行',
  normalizeForCompare('\uFEFFa\r\n\r\nb\r\n') === 'a\n\nb',
)

// B: 完整快照判定
check('B1 Read 全量（offset=1）完整', isCompleteReadSnapshot(state({})))
check(
  'B2 seed（offset undefined）完整',
  isCompleteReadSnapshot(state({ source: 'seed', offset: undefined })),
)
check(
  'B3 tool-write 完整',
  isCompleteReadSnapshot(state({ source: 'tool-write' })),
)
check(
  'B4 局部读（带 limit）不完整',
  !isCompleteReadSnapshot(state({ limit: 20 })),
)
check(
  'B5 offset 非首行不完整',
  !isCompleteReadSnapshot(state({ offset: 3 })),
)
check(
  'B6 截断读不完整',
  !isCompleteReadSnapshot(state({ truncated: true })),
)
check(
  'B7 partialView 不完整',
  !isCompleteReadSnapshot(state({ isPartialView: true })),
)
check(
  'B8 notebook/attachment 不当 base',
  !isCompleteReadSnapshot(state({ source: 'notebook' })) &&
    !isCompleteReadSnapshot(state({ source: 'attachment' })),
)
check('B9 无 source 不完整', !isCompleteReadSnapshot(state({ source: undefined })))
check('B10 无条目不完整', !isCompleteReadSnapshot(undefined))

// C: 合并策略
{
  const r = mergeTextWithPolicy({
    base: 'a\nb\nc',
    local: '\uFEFFa\r\nB\r\nc',
    remote: 'a\nb\nc-disk',
    encoding: 'utf8',
  })
  check(
    'C1 UTF-8 归一后合并',
    r.ok && r.text === 'a\nB\nc-disk',
    r.ok ? JSON.stringify(r.text) : r.reason,
  )
  const bad = mergeTextWithPolicy({
    base: 'a',
    local: 'b',
    remote: 'c',
    encoding: 'utf16le',
  })
  check(
    'C2 UTF-16 拒绝合并',
    !bad.ok && bad.reason === 'unsupported-encoding',
  )
}

// D: 归因
check('D1 web 写者', describeFileModifier('web') === 'the web editor')
check(
  'D2 会话归因',
  describeFileModifier('abc123') === 'session abc123',
)
check('D3 无归因', describeFileModifier(undefined) === 'another process')

// E: 文案
{
  const msg = formatConcurrentChangeError({
    reason: 'conflict',
    modifier: 'web',
    conflictLine: 12,
    remoteChanges: { added: 3, removed: 1 },
  })
  check(
    'E1 冲突文案含写者/行号/增删量',
    msg.includes('the web editor') &&
      msg.includes('line 12') &&
      msg.includes('+3 -1'),
    msg,
  )
  const note = formatConcurrentMergeNote({
    modifier: 'sid-1',
    changes: { added: 2, removed: 0 },
  })
  check(
    'E2 合并文案含写者/增删量',
    note.includes('session sid-1') && note.includes('+2 -0'),
    note,
  )
  const big = formatConcurrentChangeError({ reason: 'too-large' })
  check('E3 too-large 文案', big.includes('too large'))
  const nb = formatConcurrentChangeError({ reason: 'no-merge-base' })
  check('E4 no-merge-base 文案', nb.includes('no complete snapshot'))
  const enc = formatConcurrentChangeError({ reason: 'unsupported-encoding' })
  check('E5 编码文案', enc.includes('UTF-8'))
}

console.log(`[probe-concurrent-write] ${pass} pass / ${fail} fail`)
if (fail > 0) {
  for (const f of failures) console.log(`  FAIL: ${f}`)
  process.exit(1)
}
