/**
 * fileModifierRegistry 探针（2026-09-18）
 *
 * 守护的不变量：跨进程文件修改归因——写入方 record 后，另一「会话」（模拟=直插他 sid 行）
 * 能在 mtime 撞车路径上查到写入方 sid；sinceTs 过滤生效。
 *
 * 用法：bun Floria/probes/probe-file-modifier-registry.ts（cwd 须为 Pj16 项目根，
 * 注册表落 <项目根>/.claude/file-mods.jsonl）。探针行键为本探针专属 tmp 路径，
 * 与真实文件永不匹配，留在注册表内无害（超量由压缩重写回收），故不做删行清理
 * （整文件重写在多会话并发追加下有丢行竞态，不值）。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  fileModifierSuffix,
  findFileModifier,
  recordFileModifier,
} from '../src/utils/fileModifierRegistry.ts'

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

const registry = resolve('.claude', 'file-mods.jsonl')
const probeTarget = resolve('.claude', `probe-fm-target-${Date.now()}.tmp`)
const key =
  process.platform === 'win32' ? probeTarget.toLowerCase() : probeTarget

// A: record 落一行（本进程 sid = randomUUID 默认值）
recordFileModifier(probeTarget)
check('A1 注册表文件已生成', existsSync(registry))
const recorded = readFileSync(registry, 'utf8')
  .split('\n')
  .some(line => {
    try {
      const e = JSON.parse(line) as { p?: string; sid?: string }
      return e.p === key && typeof e.sid === 'string' && e.sid.length > 0
    } catch {
      return false
    }
  })
check('A2 record 写入带 sid 行', recorded)

// B: 模拟另一会话写入 → 归因命中他 sid（最新行优先）
const foreignSid = 'probe-foreign-sid-0000'
appendFileSync(
  registry,
  JSON.stringify({ p: key, sid: foreignSid, ts: Date.now() }) + '\n',
  'utf8',
)
const got = findFileModifier(probeTarget, 0)
check('B 他会话 sid 归因命中', got === foreignSid, `got=${String(got)}`)

// C: sinceTs 晚于全部条目 → 无归因
check(
  'C sinceTs 过滤生效',
  findFileModifier(probeTarget, Date.now() + 60_000) === undefined,
)

// D: 未记录路径 → 无归因
check(
  'D 未记录路径不误报',
  findFileModifier(resolve('.claude', 'never-recorded.tmp'), 0) === undefined,
)

// E: 旧行（无 w 字段）仍按 CLI 会话归因
const legacyTarget = resolve('.claude', `probe-fm-legacy-${Date.now()}.tmp`)
const legacyKey =
  process.platform === 'win32' ? legacyTarget.toLowerCase() : legacyTarget
appendFileSync(
  registry,
  JSON.stringify({ p: legacyKey, sid: 'legacy-sid', ts: Date.now() }) + '\n',
  'utf8',
)
check(
  'E 旧行兼容按 session 归因',
  findFileModifier(legacyTarget, 0) === 'legacy-sid',
)

// F: 本会话自己的写入不算「他人修改」
const ownTarget = resolve('.claude', `probe-fm-own-${Date.now()}.tmp`)
recordFileModifier(ownTarget)
check('F 本会话写入跳过', findFileModifier(ownTarget, 0) === undefined)

// G: web 写者单独归因，且不回落 CLI sid
const webTarget = resolve('.claude', `probe-fm-web-${Date.now()}.tmp`)
const webKey =
  process.platform === 'win32' ? webTarget.toLowerCase() : webTarget
appendFileSync(
  registry,
  JSON.stringify({ p: webKey, w: 'web', sid: '', ts: Date.now() }) + '\n',
  'utf8',
)
check('G1 web 写者归因', findFileModifier(webTarget, 0) === 'web')
check(
  'G2 web 文案',
  fileModifierSuffix(webTarget, 0) === ' (last modified by the web editor)',
  fileModifierSuffix(webTarget, 0),
)

// H: projectRoot 选项改写落点（网关进程用自己的 cwd 会写错项目）
const customRoot = join(tmpdir(), `probe-fm-root-${Date.now()}`)
const customTarget = join(customRoot, 'src', 'x.ts')
recordFileModifier(customTarget, { projectRoot: customRoot })
check(
  'H1 projectRoot 指定注册表落点',
  existsSync(join(customRoot, '.claude', 'file-mods.jsonl')),
)
check(
  'H2 projectRoot 读侧一致',
  findFileModifier(customTarget, 0, { projectRoot: customRoot }) === undefined, // 本会话写入，仍跳过
)

console.log(`[probe-file-modifier-registry] ${pass} pass / ${fail} fail`)
if (fail > 0) {
  for (const f of failures) console.log(`  FAIL: ${f}`)
  process.exit(1)
}
