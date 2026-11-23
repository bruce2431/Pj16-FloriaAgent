/**
 * probe-session-model.ts（2026-10-13，WS5 待办 12/14 自测）
 *
 * 验证「会话模型经 --model 启动参数落地」三段链路的改动完整性：
 *   ① 运行时断言：resolveSendMode（纯函数、零 import，真源码直跑）——model 字段归属判定。
 *   ② 静态断言：各改动文件的关键锚点（regex），网关/CLI/前端三层逐一核对；
 *      网关 handler 与 spawn 参数组装配值为静态断言（localGateway.ts 模块级副作用重，
 *      import 即初始化网关状态；且网关 HTTP 端到端验证不许触碰用户在跑的实网关）。
 *
 * 运行：bun probes/probe-session-model.ts（在 Floria/ 内）。exit 0 = 全过。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSendMode } from '../src/utils/sessionAddressing.ts'

const here = dirname(fileURLToPath(import.meta.url))
// 统一 normalize CRLF → LF：各文件换行风格不一（gatewayClient.ts 等为 CRLF），断言一律在归一文本上跑
const src = (rel: string): string => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n')

let pass = 0
let fail = 0
function ok(name: string, cond: boolean): void {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}`)
  }
}

// ── ① 运行时：resolveSendMode 的 model 归属（真源码） ─────────────────────────
console.log('[1] resolveSendMode（运行时）')
{
  const nw = resolveSendMode({ new_session: true, project: 'Pj16-CodeAgent构建', model: ' glm-5.3-flash ' })
  ok('new_session+model → kind=new 且 model 已 trim 透传', nw.kind === 'new' && nw.kind === 'new' && (nw as { model?: string }).model === 'glm-5.3-flash')
  const nwNoModel = resolveSendMode({ new_session: true, project: 'Pj16-CodeAgent构建' })
  ok('new_session 不带 model → kind=new 无 model 字段', nwNoModel.kind === 'new' && !((nwNoModel as { model?: string }).model))
  const toWithModel = resolveSendMode({ to: '某会话', model: 'glm-5.3-flash' })
  ok('to+model → invalid（model 仅 new_session 有效）', toWithModel.kind === 'invalid')
  const nsWithTo = resolveSendMode({ new_session: true, project: 'p', to: 'x', model: 'm' })
  ok('new_session 与 to 互斥仍优先拒绝', nsWithTo.kind === 'invalid')
  const noProject = resolveSendMode({ new_session: true, model: 'm' })
  ok('new_session 缺 project → invalid（先于 model 归属）', noProject.kind === 'invalid')
  const existing = resolveSendMode({ to: '某会话' })
  ok('to 寻址不带 model → kind=existing', existing.kind === 'existing')
}

// ── ② 静态：网关侧（localGateway.ts） ────────────────────────────────────────
console.log('[2] localGateway.ts（启动模型表 + spawn --model + 两帧校验）')
{
  const g = src('src/gateway/localGateway.ts')
  ok('启动模型表落盘件 sessionmodels.json', g.includes("join(gatewayDir(), 'sessionmodels.json')"))
  ok('persist/load/record 三件齐备', g.includes('function persistSessionModelLaunch') && g.includes('function loadSessionModelLaunch') && g.includes('function recordSessionModelLaunch'))
  ok('写入点①：/gateway/model 路由成功后 recordSessionModelLaunch(sessionId, model, provider)', /routeToClient\(sessionId, \{ type: 'model', value: model, provider: modelProvider \}\)\)\s*\{\s*[\s\S]*?if \(sessionId\) recordSessionModelLaunch\(sessionId, model, modelProvider \?\? undefined\)/.test(g))
  ok('写入点②：model-report 落值同帧 recordSessionModelLaunch(sid, model)', /sessionModels\.set\(sid, \{ model, updatedAt: modelTs \}\)[\s\S]{0,400}?recordSessionModelLaunch\(sid, model\)/.test(g))
  ok('spawnWebSession 签名含 opts?: { model?: string }', g.includes('opts?: { model?: string }'))
  ok('显式模型 > 启动模型表（仅 resume 查表）+ args.push(--model)', g.includes("opts?.model?.trim() || (resume ? sessionModelLaunch.get(sid)?.model : undefined)") && g.includes("args.push('--model', launchModel)"))
  ok('spawn 日志带 model 字段', g.includes('model=${launchModel ?? \'(默认)\'}'))
  ok('wsession：body.model 经 findModelProvider 校验', /launchModel: string \| undefined[\s\S]*?findModelProvider\(m\)[\s\S]*?不在凭据池任何供应商模型清单中/.test(g))
  ok('wsession：spawnWebSession 透传 { model: launchModel }', g.includes('spawnWebSession(resume, project, sid, launchModel ? { model: launchModel } : undefined)'))
  ok('session-create：读 m.model + findModelProvider 校验', g.includes('const modelRaw = typeof m.model === \'string\' && m.model.trim() ? m.model.trim() : \'\'') && /else if \(modelRaw && !findModelProvider\(modelRaw\)\) reply\(false, `model "\$\{modelRaw\}" 不在凭据池任何供应商模型清单中`\)/.test(g))
  ok('session-create：spawnWebSession(undefined, project, newSid, { model: modelRaw })', g.includes('spawnWebSession(undefined, project, newSid, modelRaw ? { model: modelRaw } : undefined)'))
  ok('网关启动 loadSessionModelLaunch()', /adoptWebSessions\(\)\s*\n\s*loadTurnEndAt\(\)[\s\S]*?loadSessionModelLaunch\(\)/.test(g))
}

// ── ③ 静态：CLI 启动段（main.tsx）provider 绑定 ─────────────────────────────
console.log('[3] main.tsx（--model 启动口 provider 配对）')
{
  const m = src('src/main.tsx')
  ok('import findModelProvider + setSessionProviderOverride', m.includes("import { findModelProvider, getActiveModel, setSessionProviderOverride } from './utils/credentials/pool.js'"))
  ok('启动段：findModelProvider(effectiveModel) → setSessionProviderOverride（先于 setMainLoopModelOverride）', /const bootModelProvider = effectiveModel \? findModelProvider\(effectiveModel\) : null;\s*\n\s*if \(bootModelProvider\) \{\s*\n\s*setSessionProviderOverride\(bootModelProvider\);\s*\n\s*\}\s*\n\s*setMainLoopModelOverride\(effectiveModel\);/.test(m))
}

// ── ④ 静态：工具链（SessionSendTool / gatewayClient / sessionAddressing） ────
console.log('[4] session_send 带模型（工具 → 帧 → 网关）')
{
  const t = src('src/tools/SessionSendTool/SessionSendTool.ts')
  ok('schema 有 model 可选字段', t.includes("model: z\n      .string()\n      .optional()"))
  ok('validateInput：findModelProvider 早失败校验', /mode\.kind === 'new' && mode\.model && !findModelProvider\(mode\.model\)/.test(t))
  ok('call：createSessionAndSend(project, text, self, mode.model)', t.includes('createSessionAndSend(project, input.text, self, mode.model)'))
  const c = src('src/utils/gatewayClient.ts')
  ok('createSessionAndSend 第 4 参 model + 帧透传', c.includes('  model?: string,\n): Promise<SessionMessageResult> {') && c.includes('...(model && model.trim() ? { model: model.trim() } : {}),'))
  const a = src('src/utils/sessionAddressing.ts')
  ok('SendMode new 分支带 model', a.includes('{ kind: \'new\'; project: string; model?: string }'))
  ok('resolveSendMode：to 寻址带 model → invalid', a.includes("error: 'model 仅在 new_session: true 时有效（发给已有会话的模型由目标会话自己决定）'"))
  const p = src('src/tools/SessionSendTool/prompt.ts')
  ok('prompt.ts 说明 model 参数', p.includes('Optional \\`model\\`') && p.includes('applies only to new sessions'))
}

// ── ⑤ 静态：前端链（send.js / recent.js）+ cache-bust ───────────────────────
console.log('[5] 前端：待定模型随 wsession 下发（补投链退役）')
{
  const send = src('src/gateway/web-src/inputbar/send.js')
  ok('send.js：待定模型传 newWebSession', send.includes('newWebSession(tgt || undefined, prevModel || undefined)'))
  ok('send.js：apiSetModel 补投已退役（无 import、无调用；注释提及不算）', !/import \{[^}]*apiSetModel/.test(send) && !send.includes('await apiSetModel') && !send.includes('apiSetModel({'))
  const recent = src('src/gateway/web-src/sidebar/recent.js')
  ok('recent.js：newWebSession(projectLabel, model) + body.model', recent.includes('async function newWebSession(projectLabel, model)') && recent.includes('if (model) body.model = model'))
  const sw = src('src/gateway/web/sw.js')
  const html = src('src/gateway/web/index.html')
  const mm = sw.match(/const CACHE = 'floria-v(\d+)'/)
  const vv = mm && mm[1]
  ok('cache-bust 三处同号（sw.js CACHE == index.html styles.css?v= == app.js?v=）', !!vv && html.includes('/styles.css?v=' + vv) && html.includes('/app.js?v=' + vv))
}

console.log(`\n${pass} 过 / ${fail} 败`)
process.exit(fail ? 1 : 0)
