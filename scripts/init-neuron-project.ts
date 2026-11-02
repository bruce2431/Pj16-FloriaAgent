/**
 * 全项目神经元初始化 + LOG.md 迁移（2026-09-18）
 *
 * 把 Neuron-Pj16 的三层库模式铺到工作区全部项目：
 *   <项目>/.claude/neturon/neurons/Neuron-PjN/
 *     ├── config.yaml            （Pj16 模板：person.id=PJN + 项目专属 should_search/add_memory）
 *     ├── l1.cog/precog.db       （空）
 *     ├── l2.mem/mem.db          （LOG 条目 → memories；块级向量在 block_vectors 列）
 *     ├── l2.mem/                （无 npy：向量随行存 mem.db，rebuildVectors 填充）
 *     └── l3.raw/LOG/LOG.md + message.db（原项目根 LOG.md 真移动进来 + 每条目一行 messages）
 *
 * 惯例照 Pj16（20260910152816 项目神经元初始化 + 09-15 blocks 标准定案）：
 *   - memory_id={ID}_MEM_{YYYYMMDD}_{HHMMSS}[_seq]；message_id={ID}LOG_{...}（同 _seq 对齐）
 *   - revelant[0] = raw message_id，其后为条目内反引号文件路径（相对项目根）
 *   - mem source='LOG'；raw source='LOG.md'；blocks 按库 blocks.max_chars(300) 切分、去时间戳头
 *   - LOG.md 真移动进 raw 层（项目根不再有 LOG.md）——沿用 Pj16「真移动」定案
 *
 * 用法：bun init-neuron-project.ts [PjN ...]   （无参=全部；幂等：已完成库跳过）
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  countMemories,
  countMessages,
  insertMemory,
  openDb,
  readMemoryVectors,
  type MemEntry,
} from '../src/tools/neturon/db.ts'
import { rebuildVectors, splitBlock } from '../src/tools/neturon/memwriter.ts'
import { getGlobalRoot } from '../src/tools/neturon/config.ts'

const here = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(here, '..', '..', '..') // Floria/scripts → Floria → Pj16 → @WrokSpace
const MODEL_CACHE = join(getGlobalRoot(), 'cache', 'models')
const MAX_CHARS = 300

interface Proj {
  dir: string
  id: string
  hint: string
}

const PROJECTS: Proj[] = [
  // Pj1 与 Pj12（HEISM）已归档离盘（2026-09-18 核实），无项目目录即无神经元落位，不列
  { dir: 'Pj5-Fe2O3-NiO异质结DFT计算', id: 'PJ5', hint: 'Fe₂O₃-NiO 异质结 DFT/VASP 计算与超算上机' },
  { dir: 'Pj11-LoRAMoE的混合专家架构', id: 'PJ11', hint: 'LoRAMoE 混合专家架构与 RAG 记忆库' },
  { dir: 'Pj13-RAG综述论文', id: 'PJ13', hint: 'RAG 综述论文与 PDF 精读预览前端' },
  { dir: 'Pj14-艺术作品创作', id: 'PJ14', hint: 'AI 动画制作与 ComfyUI 预览工作台' },
  { dir: 'Pj15-本地媒体资源库', id: 'PJ15', hint: '0zijun 本地媒体资源库前端与录入管线' },
  { dir: 'Pj17-DSH', id: 'PJ17', hint: 'dsh（deepseek-harness）插件开发' },
  { dir: 'Pj18-LaTex论文书写', id: 'PJ18', hint: '个性化 LaTeX 论文预览网页' },
]

// ── config.yaml（Pj16 模板裁剪；只保有真实读取方的键） ─────────────────────────

function configYaml(p: Proj): string {
  return `# Neuron-${p.dir} 配置 — 项目神经元（LOG 历史条目 + 后续 remember 活写入）
# 模板照 Neuron-Pj16（2026-09-18 全项目神经元化铺开）；只保有真实读取方的键

person:
  id: "${p.id}"

memory:
  model_name: "BAAI/bge-small-zh-v1.5"

ranking:
  # 读取方：retriever.ts（w_cos 语义相似 + w_kw 关键词命中）
  fact:
    w_cos: 0.60
    w_kw: 0.40

precog:
  default_top_k: 10
  # consumed 记录的回收期（天）；pre 永不清（新节点入口 + 待标注队列）
  ttl_days: 90

# blocks 标准（写入侧硬约束，读取方：memwriter.buildEntry）
# BGE 编码是静默丢尾——超过模型位置上限 512 token 的部分完全不进向量。故每个
# block 必须 ≤ max_chars，超长由 buildEntry 就近切分；块多且短能让 max-sim
# 各块独立投票、最匹配的块决定命中（条目 cos = max_r cos(q, block_r)）。文案式约定见 prompts.add_memory。
blocks:
  max_chars: ${MAX_CHARS}

# 全链纯标注驱动，文本（query/keywords/blocks）不参与任何判据
cog:
  # 节点归并判据：jaccard(true 集) ≥ merge_threshold
  merge_threshold: 0.50
  # 边权：w_true_assoc·jt + w_revelant·rv（无文本项、无 no_jt 地板）
  w_true_assoc: 0.40
  w_revelant: 0.45

edge_filter:
  # 纯 rv 边（无 jt 支撑）的降权：rv/(jt+rv) > ratio 即 ×weight
  rv_penalty:
    ratio_threshold: 0.6
    weight: 0.5

community:
  resolutions: [0.5, 0.8, 1.0, 1.5, 2.0]
  # 只把 size ≥ min_group_size 的社群写入 community.json（单节点不写群）
  min_group_size: 2
  core_score_min: 0.25
  concept_core_max: 0.08

abstraction:
  # 读取方：retriever.ts（读侧反查社群用哪个分辨率）
  default_resolution: "resolution_1.5"

prompts:
  should_search: |
    涉及 ${p.dir}（${p.hint}）的历史改动、定案、产出与根因排查时检索此库。命中后按 memory_id 时间线读 blocks，注意 LOG 是只追加日志、后条可能修正前条，确认结论是否已被后续条目取代；revelant 首元素是该条目在 raw 层（l3.raw/LOG/message.db）的 message_id，原文全文见 l3.raw/LOG/LOG.md，其余为相关文件路径（相对项目根），可循证细读，不要凭单条旧记忆下结论。
  # remember 写入时注入的库个性约定（读取方：remember.ts fillRule）
  add_memory: |
    本库是 ${p.dir} 的项目知识库（改动 / 定案 / 根因 / 踩坑）。写之前先想清：这条未来被谁检索、用来回答什么？想不清就不写。

    1. content：写清「做了什么 / 怎么做的 / 结果」，结论前置。
    2. blocks：检索的真正载体——每条 block 独立编码成单位向量、随行存 mem.db；条目命中取各块与查询 cos 的最大值（max-sim，最匹配的块决定命中）。规矩：
       · 块数 ≥ 2，一块一件事（一个定案 / 一处根因 / 一次改动）。
       · 单块 ≤ ${MAX_CHARS} 字（约 180 token，安全落 bge-small-zh 512 上限内）；超长按 ；。 先切好再写。
         ⚠️ 超长块是静默丢尾：超出 512 token 的部分完全不进向量，尾部内容检索不到。
       · block[0] 是检索锚：写成查询形自然语句 + 关键标识（功能名 / 文件路径 / 参数名 / 报错原文）。
       · 按 ；。 主切；【标签】前缀并入首块；块内不嵌时间戳（时间在 memory_id 与正文里）。
       · 禁纯工具名块（没有语义信息，命中不了自然问句）。
    3. source 必填：写实来源（会话 jsonl 相对路径 / 用户口述 / 实测脚本路径）。
    4. revelant：放可追溯引用不放内容。首元素 = 该条在 raw 层（l3.raw/LOG/message.db）的 message_id
       （仅 LOG 迁移条目有），其余为相关文件路径（相对项目根）。
    5. core_file：只存 {name, path} 引用，完整脚本先落盘再引路径，不要贴全文。
    6. 纠错用 action=update（supersede，旧条目自动废弃不删除），不要新写一条并存。

# 社群命名 LLM（读取方：cogname.ts，neuron_cog action=name_communities）
# 密钥不在本文件存（单源 = 全局根 credentials.json providers.<provider>）
llm:
  provider: "glm"
  model: "glm-5.3-flash"
  temperature: 0.3
`
}

// ── LOG 解析（宽松适配 7 项目的头部格式变体） ─────────────────────────────────

// 头部：可选前导标记（- * | 空白）+ [YYYY-MM-DD{空格|-}HH:MM[:SS]] + 可选冒号
const HEAD_RE = /^\s*[-*|]*\s*\[(\d{4})-(\d{2})-(\d{2})[ \-](\d{1,2}):(\d{2})(?::(\d{2}))?\](\s*[:：])?/

interface ParsedEntry {
  ts: string // 'YYYY-MM-DD HH:MM:SS'
  rawText: string // 原文条目（raw 层 content）
  body: string // 去时间戳头后的正文（blocks 源）
}

interface CurEntry {
  ts: string
  firstLine: string
  rest: string
  cont: string[]
}

function parseLog(md: string): ParsedEntry[] {
  const lines = md.split(/\r?\n/)
  const out: ParsedEntry[] = []
  let cur: CurEntry | null = null
  const flush = (c: CurEntry | null) => {
    if (!c) return
    const body = [c.rest, ...c.cont].join('\n').trim()
    if (body) out.push({ ts: c.ts, rawText: [c.firstLine, ...c.cont].join('\n'), body })
  }
  let fm = lines[0]?.trim() === '---' // YAML frontmatter
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (fm) {
      if (line.trim() === '---') fm = false
      continue
    }
    const m = HEAD_RE.exec(line)
    if (m) {
      flush(cur)
      cur = null
      const y = m[1]!
      const mo = m[2]!
      const d = m[3]!
      const h = m[4]!.padStart(2, '0')
      const mi = m[5]!
      const s = (m[6] ?? '00').padStart(2, '0')
      cur = {
        ts: `${y}-${mo}-${d} ${h}:${mi}:${s}`,
        firstLine: line,
        rest: line.slice(m[0].length).trimStart(),
        cont: [],
      }
      continue
    }
    if (!line.trim()) continue // 空行 = 排版分隔，条目不因空行截断
    if (/^\s*#{1,6}\s/.test(line) || /^---+\s*$/.test(line) || /^\s*>/.test(line)) continue // 标题/分隔线/导语
    if (cur) cur.cont.push(line) // 非空非头部行 = 续行归并
    // 无 current 的游离行（首个条目之前的导语）跳过
  }
  flush(cur)
  return out
}

// ── 反引号文件路径提取（revelant 证据指针） ───────────────────────────────────

const EXT_RE =
  /\.(py|js|mjs|cjs|ts|tsx|jsx|html|htm|css|scss|json|jsonl|md|txt|sh|bat|ps1|tex|ipynb|xlsx|csv|yaml|yml|toml|cif|xsd|png|jpg|jpeg|webp|mp4|m4a)$/i

function extractPaths(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(/`([^`\n]{3,150})`/g)) {
    const s = m[1]!.trim()
    if (s.length < 4 || /\s/.test(s)) continue
    if (/^https?:/i.test(s)) continue
    if (!EXT_RE.test(s) && !/[\\/]/.test(s)) continue
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= 12) break
  }
  return out
}

// ── 同秒条目 _seq 分配（raw 与 mem 共用同一 seq，保持一一对齐） ────────────────

function seqAllocator() {
  const used = new Map<string, number>()
  return (base: string): string => {
    const n = used.get(base) ?? 0
    used.set(base, n + 1)
    return n === 0 ? base : `${base}_${String(n).padStart(2, '0')}`
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

const only = process.argv.slice(2)
const targets = only.length
  ? PROJECTS.filter(p =>
      only.some(a => p.dir.startsWith(a) || p.id.toLowerCase() === a.toLowerCase()),
    )
  : PROJECTS

let totalRaw = 0
let fail = 0

for (const p of targets) {
  const projRoot = join(WORKSPACE, p.dir)
  const logPath = join(projRoot, 'LOG.md')
  const neuron = join(projRoot, '.claude', 'neturon', 'neurons', `Neuron-${p.dir}`)
  const rawDir = join(neuron, 'l3.raw', 'LOG')
  const rawDb = join(rawDir, 'message.db')
  const memDb = join(neuron, 'l2.mem', 'mem.db')
  try {
    if (!existsSync(projRoot)) {
      console.log(`SKIP ${p.id}: 项目目录不存在`)
      continue
    }
    if (existsSync(rawDb) || existsSync(join(rawDir, 'LOG.md'))) {
      console.log(`SKIP ${p.id}: 已初始化`)
      continue
    }

    mkdirSync(neuron, { recursive: true })
    writeFileSync(join(neuron, 'config.yaml'), configYaml(p), 'utf-8')
    openDb(join(neuron, 'l1.cog', 'precog.db'))

    if (!existsSync(logPath)) {
      // 骨架库（无 LOG.md，只建空三层，等活写入）
      openDb(memDb)
      console.log(`OK ${p.id}（${p.dir}）：骨架库建成（无 LOG.md，不迁移），向量留待首条写入`)
      continue
    }

    const md = readFileSync(logPath, 'utf-8')
    const origSize = statSync(logPath).size
    const entries = parseLog(md)
    if (!entries.length) throw new Error('LOG 解析出 0 条条目，拒绝迁移')

    // raw 层：每条目一行 messages
    mkdirSync(rawDir, { recursive: true })
    const db = openDb(rawDb)
    const nextSeq = seqAllocator()
    const ins = db.query(
      'INSERT INTO messages (message_id, source, sender, content, media, quote, forward) VALUES (?,?,?,?,?,?,?)',
    )
    const memRows: MemEntry[] = []
    for (const e of entries) {
      const compact = e.ts.slice(0, 10).replace(/-/g, '') + '_' + e.ts.slice(11).replace(/:/g, '')
      const rawId = nextSeq(`${p.id}LOG_${compact}`)
      ins.run([rawId, 'LOG.md', null, e.rawText, null, null, null])
      const memId = `${p.id}_MEM_${rawId.slice(`${p.id}LOG_`.length)}`
      memRows.push({
        memory_id: memId,
        revelant: [rawId, ...extractPaths(e.rawText)],
        blocks: splitBlock(e.body, MAX_CHARS),
        source: 'LOG',
        core_file: null,
        supersedes: null,
        deprecated_by: null,
      })
    }
    db.close()

    // mem 层
    openDb(memDb)
    for (const row of memRows) insertMemory(memDb, row)

    // LOG.md 真移动进 raw 层
    renameSync(logPath, join(rawDir, 'LOG.md'))
    const movedSize = statSync(join(rawDir, 'LOG.md')).size
    if (movedSize !== origSize) throw new Error(`移动后大小不一致 ${origSize} -> ${movedSize}`)

    // 向量收口：逐条重编码 blocks 写入 mem.db（与行同表）
    const { dim } = await rebuildVectors(neuron, memRows, MODEL_CACHE)

    // 校验：raw ≡ mem；每条非空 blocks 的向量长度 ≡ n_blocks×dim
    const nRaw = countMessages(rawDb)
    const nMem = countMemories(memDb)
    const vecs = readMemoryVectors(memDb)
    for (const r of memRows) {
      const nb = r.blocks.length
      if (!nb) continue
      const v = vecs.get(r.memory_id)
      if (!v || v.length !== nb * dim) throw new Error(`向量缺失/长度不符: ${r.memory_id}`)
    }
    if (!(nRaw === entries.length && nMem === entries.length)) {
      throw new Error(`计数不一致 raw=${nRaw} mem=${nMem} entries=${entries.length}`)
    }
    const blocks = memRows.reduce((a, r) => a + r.blocks.length, 0)
    console.log(
      `OK ${p.id}（${p.dir}）：${entries.length} 条 / ${blocks} 块 / ${dim} 维 / LOG.md 已迁 raw（${origSize} B）`,
    )
    totalRaw += nRaw
  } catch (e) {
    fail++
    console.error(`FAIL ${p.id}（${p.dir}）：${(e as Error).message}`)
  }
}

console.log(`\n完成：raw ${totalRaw} 条 / 失败 ${fail}`)
process.exit(fail ? 1 : 0)
