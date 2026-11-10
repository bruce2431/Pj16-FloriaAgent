/**
 * threeWayMerge 探针
 *
 * 守护的不变量：patience 三方合并的冲突判定只取决于「两边是否动同一处」——
 * 非重叠改动静默合并、同点改动判冲突并给 1-based 行号、边界插入不误判、
 * 超限回 too-large、末尾换行差异不算冲突、增删量统计准确。
 *
 * 用法：bun Floria/probes/probe-three-way-merge.ts
 */
import {
  WK_MERGE_MAX_LINES,
  wkLineDelta,
  wkMerge3,
} from '../src/utils/threeWayMerge.ts'

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

const base = 'l1\nl2\nl3\nl4\nl5'

// A: 本地无改动 → 取磁盘版
{
  const r = wkMerge3(base, base, 'l1\nl2\nl3\nl4\nl5-disk')
  check('A1 本地无改动取磁盘', r.ok && r.text === 'l1\nl2\nl3\nl4\nl5-disk')
}

// B: 磁盘无改动 → 取本地版
{
  const r = wkMerge3(base, 'l1\nl2-local\nl3\nl4\nl5', base)
  check('B1 磁盘无改动取本地', r.ok && r.text === 'l1\nl2-local\nl3\nl4\nl5')
}

// C: 非重叠改动 → 两侧都在
{
  const local = 'l1-local\nl2\nl3\nl4\nl5'
  const remote = 'l1\nl2\nl3\nl4\nl5-remote'
  const r = wkMerge3(base, local, remote)
  check(
    'C1 非重叠改动合并两侧',
    r.ok && r.text === 'l1-local\nl2\nl3\nl4\nl5-remote',
    r.ok ? r.text : r.reason,
  )
}

// D: 同一行双改 → 冲突 + 1-based 行号 + 磁盘增删量
{
  const local = 'l1\nl2\nl3-local\nl4\nl5'
  const remote = 'l1\nl2\nl3-remote\nl4\nl5'
  const r = wkMerge3(base, local, remote)
  check(
    'D1 同行双改判冲突',
    !r.ok && r.reason === 'conflict',
    r.ok ? 'merged' : r.reason,
  )
  check(
    'D2 冲突行为 1-based base 行号',
    !r.ok && r.reason === 'conflict' && r.conflictLine === 3,
    !r.ok && r.reason === 'conflict' ? `line=${r.conflictLine}` : '',
  )
  check(
    'D3 冲突带磁盘侧增删量',
    !r.ok &&
      r.reason === 'conflict' &&
      r.remoteChanges.added === 1 &&
      r.remoteChanges.removed === 1,
    !r.ok && r.reason === 'conflict'
      ? JSON.stringify(r.remoteChanges)
      : '',
  )
}

// E: 插入落在替换块边界 → 可有序拼接，不判冲突
{
  const local = 'l1\nl2\nl3\nl4\nl5' // 无改动
  const remote = 'l1\nl2\nl3\nl4\nl5' // 同上
  const r = wkMerge3('a\nb\nc', 'a\nb\nc', 'a\nb-remote\nc')
  check('E1 替换不误判', r.ok, r.ok ? '' : r.reason)
  void local
  void remote
}
{
  // base 3 行；本地替换第 2 行，磁盘在第 3 行前（边界 bs=2）插入
  const r = wkMerge3('a\nb\nc', 'a\nB\nc', 'a\nb\nx\nc')
  check('E2 边界插入可合并', r.ok && r.text === 'a\nB\nx\nc', r.ok ? r.text : r.reason)
}

// F: 插入落在替换块内部 → 冲突
{
  const r = wkMerge3('a\nb\nc\nd', 'a\nB1\nB2\nd', 'a\nb\nINSERT\nc\nd')
  check('F1 替换区间内部插入判冲突', !r.ok && r.reason === 'conflict')
}

// G: 超过行数上限 → too-large
{
  const big = Array.from({ length: WK_MERGE_MAX_LINES + 1 }, (_, i) => `x${i}`)
  const local = big.slice()
  const remote = big.slice()
  local[0] = 'local'
  remote[1] = 'remote'
  const r = wkMerge3(big.join('\n'), local.join('\n'), remote.join('\n'))
  check('G1 超限回 too-large', !r.ok && r.reason === 'too-large')
}

// H: 末尾换行差异不算冲突（Read 快照无末尾换行，磁盘常有）
{
  const r = wkMerge3('a\nb', 'a-local\nb', 'a\nb\n')
  check('H1 末尾换行差异不冲突', r.ok && r.text === 'a-local\nb\n', r.ok ? r.text : r.reason)
}

// I: 增删量统计
{
  const d = wkLineDelta('a\nb\nc', 'a\nB\nc\nc2')
  check('I1 增删量统计', d.added === 2 && d.removed === 1, JSON.stringify(d))
}

console.log(`[probe-three-way-merge] ${pass} pass / ${fail} fail`)
if (fail > 0) {
  for (const f of failures) console.log(`  FAIL: ${f}`)
  process.exit(1)
}
