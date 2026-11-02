/**
 * cogname.ts — p7 Community→Cog2 社群命名（LLM 起名，2026-09-16 移植）
 *
 * 对照 Python 基线 pipline/p7-cog_abstract.py：
 *   输入 l1.cog/{cog_graph.json, community.json} + l2.mem/mem.db（证据片段）
 *   输出 l1.cog/cog2.json —— 读侧 retriever cognitionRoute 概念层（name×2/desc×1
 *   关键词打分）+ embedCogCache（`${name} ${description}` 向量）+ neuron_list 的
 *   cog2_count 全部消费此文件；记录字段形状照真身库 cog2.json 1:1。
 *
 * 与 Python 的两处有意偏离（定案）：
 *   1. 规模/密度硬门（size 2~6、density ≥0.3）不用——本库社群本就 >6，是否「异质到
 *      不该命名」交给命名模型判断（prompt 保留 name=null 拒绝语义）；只尊重
 *      community.min_group_size（单节点不成群）。
 *   2. 密钥不进 config.yaml（NSCs 旧 config 的 api_key 已被抹成 x，示范了密钥入库
 *      的下场）：config 只声明 llm.provider/model/temperature/thinking，凭据单源 =
 *      全局根 credentials.json providers.<provider>（与 WebSearch 同一惯例）。
 *      llm.thinking 原样透传进请求体（Anthropic 协议字段），用于压低思考预算：
 *      {type: enabled, budget_tokens: N} 越小思考越少，{type: disabled} 可直关闭
 *      （deepseek-flash 经 /anthropic 端点实测两者都吃，且与 temperature 并存不报错）。
 */

import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigError, cfgGet, cfgRequired, resolveNeuronPath } from './config.js'
import { readMemories } from './db.js'
import { nowStampCompact, readJson, readYaml, writeJsonAtomic } from './coggraph.js'
import { loadCredentials } from '../../utils/credentials/pool.js'
import { resolveProtocolFetch } from '../../services/api/protocol-fetch.js'

/** 每成员证据片段上限（取 true_memories 对应条目的 blocks[0] 检索锚头部） */
const EVIDENCE_HEAD = 60
const LLM_ATTEMPTS = 3
const LLM_RETRY_WAIT_MS = 30_000 // 429 限频等待（账户级速率限制，连发重试只会加重）
const LLM_INTER_WAIT_MS = 30_000 // 社群间节奏（连发 6 请求必触发 1302；注入 llmCall 的探针路径不等待）
const LLM_MAX_TOKENS = 2000 // glm-4.6 经 anthropic 端点回 thinking 块且计入输出预算，500 会被思考吃光截断 JSON
const LLM_TIMEOUT_MS = 120_000

type LlmCall = (system: string, user: string) => Promise<string>

/** 命名运行可选项：注入式 LLM（探针零网络）+ 进度回调（真跑活性） */
export interface NameOpts {
  llmCall?: LlmCall
  onProgress?: (msg: string) => void
}

interface MemberCtx {
  id: string
  query: string
  role: string
  core_score: number
  evidence: string[]
}

interface CommunityCtx {
  size: number
  density: number
  members: MemberCtx[]
  edges: Array<{ from: string; to: string; w: number; jt: number }>
}

export interface NameCommunitiesResult {
  status: 'ok' | 'error'
  resolution?: string
  named?: number
  rejected?: number
  failed?: number
  names?: Array<{ name: string; confidence: number; size: number; description: string }>
  failures?: string[]
  message: string
}

function snippet(text: string, head: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, head)
}

function buildPrompt(ctx: CommunityCtx): string {
  const membersText = ctx.members
    .map(m => {
      const ev = m.evidence.length ? ` 证据：${m.evidence.join(' / ')}` : ''
      return `  - ${m.id}: ${m.query} (角色=${m.role})${ev}`
    })
    .join('\n')
  const edgesText = ctx.edges.length
    ? `\n\n社区内部连接（weight>0）:\n${ctx.edges.map(e => `  - ${e.from} → ${e.to} (w=${e.w}, jt=${e.jt})`).join('\n')}`
    : ''
  return `以下社区已通过检索共现和社区检测验证。

成员:
${membersText}${edgesText}

任务: 判断是否存在稳定上位概念，有则命名，无则返回 null。

硬约束:
- 名称 ≤12字，描述 ≤80字
- 禁止宽泛领域词: 功能、界面、机制、系统、模块、问题、情况、优化、实现、处理
- 名称应描述事件模式或行为状态关系，非领域分类
- 若只能给出领域分类而不能给出具体模式，返回 name=null

输出 JSON:
{"name": "名称或null", "confidence": 0.0~1.0, "description": "描述", "reason": "判断理由"}`
}

/** 提取 LLM 输出中的 JSON 对象（容忍 ``` 围栏与前后缀文字，对照 p7 正则语义） */
function extractJson(text: string): Record<string, unknown> | null {
  let content = text.trim()
  if (content.startsWith('```')) {
    const parts = content.split('```')
    content = (parts[1] ?? content).trim()
    if (content.startsWith('json')) content = content.slice(4).trim()
  }
  const m = /\{[^{}]*\}/s.exec(content)
  try {
    return JSON.parse(m ? m[0] : content) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 校验 LLM 输出（对照 p7 validate_output）：name=null 是合法拒绝，不是失败 */
function validate(result: Record<string, unknown>): { ok: boolean; rejected: boolean; msg: string } {
  if (!('name' in result)) return { ok: false, rejected: false, msg: '缺少 name 字段' }
  const name = result.name
  if (name === null || name === 'null' || name === '') {
    return { ok: true, rejected: true, msg: String(result.reason ?? '') }
  }
  if (typeof name !== 'string' || name.length > 30) {
    return { ok: false, rejected: false, msg: `名称无效或过长: ${String(name).slice(0, 40)}` }
  }
  const conf = Number(result.confidence ?? 0)
  if (!Number.isFinite(conf) || conf < 0 || conf > 1) {
    return { ok: false, rejected: false, msg: `confidence 无效: ${String(result.confidence)}` }
  }
  return { ok: true, rejected: false, msg: '' }
}

/** 从 config llm 段 + credentials.json 解析出 Anthropic 协议的单次调用器 */
function resolveLlm(neuronPath: string): { system: string; call: LlmCall } {
  const cfgPath = join(neuronPath, 'config.yaml')
  const cfg = readYaml(cfgPath)
  const ctx = `config.yaml: ${cfgPath}`
  const providerName = String(cfgRequired(cfg, 'llm.provider', ctx))
  const model = String(cfgRequired(cfg, 'llm.model', ctx))
  const temperature = Number(cfgGet(cfg, 'llm.temperature', 0.3))
  // 可选：低思考档。缺失则不传该字段（保持端点默认行为）
  const thinking = cfgGet(cfg, 'llm.thinking')

  const creds = loadCredentials()
  const provider = creds.providers[providerName]
  if (!provider) {
    throw new ConfigError(`credentials.json 无 provider '${providerName}'（llm.provider=${providerName}）`)
  }
  const key = provider.keys[provider.activeKeyIndex ?? 0]?.value
  if (!key) throw new ConfigError(`provider '${providerName}' 无可用 key`)
  const baseUrl = provider.baseUrl
  if (!baseUrl) throw new ConfigError(`provider '${providerName}' 无 baseUrl`)

  // provider 声明的协议决定走哪条 fetch：anthropic（缺省）→ 原始 fetch 直发
  // /v1/messages；openai-chat → 适配器翻译成 Chat Completions。判定单源 =
  // services/api/protocol-fetch.ts。
  const doFetch =
    resolveProtocolFetch({
      protocol: provider.protocol ?? 'anthropic',
      baseUrl,
      apiKey: key,
    }) ?? fetch

  return {
    system: '你是一个概念抽象模块。直接输出 JSON，不要包含任何推理过程或其他文字。',
    call: async (system, user) => {
      const resp = await doFetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
        body: JSON.stringify({
          model,
          max_tokens: LLM_MAX_TOKENS,
          temperature,
          ...(thinking && typeof thinking === 'object' ? { thinking } : {}),
          system,
          messages: [{ role: 'user', content: user }],
        }),
      })
      if (!resp.ok) {
        throw new Error(`LLM HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
      }
      const data = (await resp.json()) as { content?: Array<{ type: string; text?: string }> }
      const text = (data.content ?? [])
        .filter(b => b.type === 'text' && b.text)
        .map(b => b.text as string)
        .join('')
      if (!text.trim()) throw new Error('LLM 返回空内容')
      return text
    },
  }
}

/** 社群命名（显式目录版）——重写 l1.cog/cog2.json（旧文件 .bak） */
export async function nameCommunitiesInDir(
  neuronPath: string,
  opts?: NameOpts,
): Promise<NameCommunitiesResult> {
  const cfgPath = join(neuronPath, 'config.yaml')
  const cfg = readYaml(cfgPath)
  const ctx = `config.yaml: ${cfgPath}`
  const resKeyName = String(cfgRequired(cfg, 'abstraction.default_resolution', ctx))
  const minGroupSize = Number(cfgGet(cfg, 'community.min_group_size', 2))

  const graphPath = join(neuronPath, 'l1.cog', 'cog_graph.json')
  const commPath = join(neuronPath, 'l1.cog', 'community.json')
  const cog2Path = join(neuronPath, 'l1.cog', 'cog2.json')

  const comm = readJson<
    Record<
      string,
      {
        resolution?: number
        communities?: Array<{
          members: Array<{ id: string; query: string; role: string; core_score: number }>
          size: number
          density: number
        }>
      }
    >
  >(commPath)
  if (!comm || !comm[resKeyName]) {
    return { status: 'error', message: `community.json 无 ${resKeyName}，请先运行 detect_communities` }
  }
  const graph = readJson<{
    nodes?: Array<{ id: string; query: string; true_memories?: string[] }>
    edges?: Array<{ source: string; target: string; weight: number; jt: number }>
  }>(graphPath)
  if (!graph) return { status: 'error', message: 'cog_graph.json 不存在，请先运行 build_graph' }

  const commData = comm[resKeyName]!
  const targets = (commData.communities ?? []).filter(c => c.size >= minGroupSize)

  let llm: { system: string; call: LlmCall }
  try {
    llm = opts?.llmCall ? { system: '', call: opts.llmCall } : resolveLlm(neuronPath)
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) }
  }

  // mem 证据：memory_id → blocks[0]（检索锚）头部
  const memById = new Map(
    readMemories(join(neuronPath, 'l2.mem', 'mem.db')).map(e => [e.memory_id, e.blocks[0] ?? '']),
  )
  const nodeById = new Map((graph.nodes ?? []).map(nd => [nd.id, nd]))

  const records: Array<Record<string, unknown>> = []
  const names: NonNullable<NameCommunitiesResult['names']> = []
  const failures: string[] = []
  let rejected = 0
  const stamp = nowStampCompact()

  for (const [ci, c] of targets.entries()) {
    if (ci > 0 && !opts?.llmCall) {
      opts?.onProgress?.(`  间隔 ${LLM_INTER_WAIT_MS / 1000}s（限频节奏）`)
      await new Promise(r => setTimeout(r, LLM_INTER_WAIT_MS))
    }
    const label = c.members.map(m => m.query.slice(0, 12)).join(' | ')
    opts?.onProgress?.(`社群 ${ci + 1}/${targets.length} size=${c.size} [${label}] 命名中…`)
    const ids = new Set(c.members.map(m => m.id))
    const communityCtx: CommunityCtx = {
      size: c.size,
      density: c.density,
      members: c.members.map(m => {
        const node = nodeById.get(m.id)
        const evidence = (node?.true_memories ?? [])
          .map(mid => memById.get(mid) ?? '')
          .filter(Boolean)
          .slice(0, 2)
          .map(t => snippet(t, EVIDENCE_HEAD))
        return { id: m.id, query: m.query, role: m.role, core_score: m.core_score, evidence }
      }),
      edges: (graph.edges ?? [])
        .filter(e => ids.has(e.source) && ids.has(e.target) && e.weight > 0)
        .map(e => ({ from: e.source, to: e.target, w: Number(e.weight.toFixed(4)), jt: Number(e.jt.toFixed(4)) })),
    }

    let result: Record<string, unknown> | null = null
    let lastErr: unknown = null
    for (let i = 0; i < LLM_ATTEMPTS && !result; i++) {
      try {
        const text = await llm.call(llm.system, buildPrompt(communityCtx))
        result = extractJson(text)
        if (!result) throw new Error('输出无法解析为 JSON')
      } catch (e) {
        lastErr = e
        if (i < LLM_ATTEMPTS - 1) {
          const rateLimited = e instanceof Error && e.message.startsWith('LLM HTTP 429')
          opts?.onProgress?.(
            `  ${rateLimited ? '429 限频' : '调用失败'}，${LLM_RETRY_WAIT_MS / 1000}s 后重试`,
          )
          await new Promise(r => setTimeout(r, LLM_RETRY_WAIT_MS))
        }
      }
    }
    if (!result) {
      failures.push(
        `size=${c.size} [${label}] LLM 失败: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      )
      continue
    }
    const verdict = validate(result)
    if (!verdict.ok) {
      failures.push(`size=${c.size} [${label}] 校验失败: ${verdict.msg}`)
      continue
    }
    if (verdict.rejected) {
      rejected++
      failures.push(`size=${c.size} [${label}] 模型拒绝: ${verdict.msg.slice(0, 60)}`)
      continue
    }

    records.push({
      cog2_id: `C${stamp}_${String(records.length + 1).padStart(2, '0')}`,
      name: result.name,
      confidence: Number(result.confidence ?? 0.5),
      description: String(result.description ?? ''),
      members: c.members.map(m => m.id),
      member_names: c.members.map(m => m.query),
      community_size: c.size,
      community_density: c.density,
      resolution: commData.resolution ?? null,
      reason: String(result.reason ?? ''),
    })
    names.push({
      name: String(result.name),
      confidence: Number(result.confidence ?? 0),
      size: c.size,
      description: String(result.description ?? ''),
    })
  }

  if (existsSync(cog2Path)) copyFileSync(cog2Path, `${cog2Path}.bak`)
  writeJsonAtomic(cog2Path, {
    resolution: commData.resolution ?? null,
    generated_at: new Date().toISOString(),
    cog2_records: records,
  })

  return {
    status: 'ok',
    resolution: resKeyName,
    named: records.length,
    rejected,
    failed: failures.length - rejected,
    names,
    failures,
    message: `cog2.json ${records.length} 条（${targets.length} 社群：named ${records.length} / rejected ${rejected} / failed ${failures.length - rejected}）`,
  }
}

/** 社群命名（注册名 → resolveNeuronPath） */
export async function nameCommunities(
  neuronId: string,
  cwd?: string,
  opts?: NameOpts,
): Promise<NameCommunitiesResult> {
  let neuronPath: string
  try {
    neuronPath = resolveNeuronPath(neuronId, cwd)
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) }
  }
  return nameCommunitiesInDir(neuronPath, opts)
}
