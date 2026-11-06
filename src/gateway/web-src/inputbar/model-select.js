// 模型选择（状态/seat/menu）（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { hideGate } from '../engine/auth.js'
import { needToken, apiSetModel } from '../engine/gateway.js'
import { I } from '../core/icons.js'
import { inputEl, state } from '../engine/state.js'
import { esc, toast, isTouch } from '../core/util.js'
import { EFFORT_LEVELS, cmd, msel, modelPop, modelSeatEl, closeCmdPop } from './commands.js'
import { closeMentionPop } from './mention.js'
import { MGR, MODELS, MODELS_LOADING, MODELS_ERR, loadModelsData, modelProviderOf } from '../sidebar/mgr-data.js'
/* @module inputbar/model-select.js */
  function modelDir() {
    const pool = ((MODELS && Array.isArray(MODELS.items) ? MODELS.items : []) || [])
      .filter(it => it && typeof it.src === 'string' && it.src.startsWith('凭据池') && it.v)
      .map(it => String(it.v))
    const raw = pool.length
      ? pool
      : ((MODELS && Array.isArray(MODELS.providerModels) && MODELS.providerModels.length)
        ? MODELS.providerModels
        : ((MODELS && Array.isArray(MODELS.items) ? MODELS.items : []).map(it => String(it.v)).filter(Boolean)))
    const seen = new Set()
    const out = []
    for (const id of raw) {
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
    return out
  }
  // 当前选中模型（本地状态；首次 /gateway/models 加载后与凭据池 activeModel/provider/effortLevel 对齐）
  // 2026-08-24 模型 web/CLI 同步：MODEL_CUR 持久化 localStorage（刷新恢复），并按 /gateway/session 上报的
  // 会话实际模型（CLI reportCurrentModel）校准——每会话 override 只在 CLI 内存，web 不持久化会回落
  // 凭据池默认 activeModel 造成「CLI 用 vision-exp / web 显示 flash」不一致。
  const MODEL_KEY = 'floria-model-v1'
  function loadModelCur() {
    try {
      const raw = localStorage.getItem(MODEL_KEY)
      if (!raw) return null
      const o = JSON.parse(raw)
      if (o && typeof o === 'object' && typeof o.model === 'string' && o.model) return o
    } catch { /* 存储不可用忽略 */ }
    return null
  }
  function saveModelCur() {
    try {
      // 2026-09-19：ts 同时回写 MODEL_CUR（不只写 localStorage）——applySessionModel 的「切换前在途
      // 快照」判定要比 modelTs < MODEL_CUR.ts，ts 只落盘不进内存则内存版恒无 ts，判定失效。
      MODEL_CUR.ts = Date.now()
      localStorage.setItem(MODEL_KEY, JSON.stringify({ provider: MODEL_CUR.provider, model: MODEL_CUR.model, effortLevel: MODEL_CUR.effortLevel, ts: MODEL_CUR.ts }))
    } catch { /* 存储不可用忽略 */ }
  }
  let MODEL_CUR = loadModelCur() || { provider: '', model: '', effortLevel: undefined }
  // 用户本次会话内主动切换过模型 → 不再被 /gateway/session 旧上报覆盖（切换会话时重置）。避免
  // POST /gateway/model 尚未落地前的一次刷新把刚切的选择回滚成旧值。
  let modelUserPicked = false
  // 2026-11-06 会话隔离（B）：主动切模型的判定只对「当时那个会话」成立。旧守卫用全局
  // modelUserPicked + MODEL_CUR.ts（localStorage 跨会话持久化）→ 切到另一个会话时，该会话后端
  // 上报的模型（modelTs 早于上次切换时刻）被当成「在途旧快照」丢弃，座停在上一会话的模型。
  let modelPickedHash = ''
  // 首页（新会话）模型选择（2026-10-11 定案）：全局默认模型不再由 web 调整——唯一入口 = 直接改
  // 凭据池 credentials.json（agent 侧）。首页选的模型只作用于**这一次新建的会话**：记入本槽，
  // 发送首条消息时随会话级切换（POST /gateway/model 带 sessionId，见 send.js 空态分支）落到新会话，
  // 消费即清；回首页且无待定选择时 seat 回落凭据池全局默认（syncSeatToGlobalDefault）。
  let newSessionModel = ''
  function getNewSessionModel() { return newSessionModel }
  function setNewSessionModel(v) { newSessionModel = typeof v === 'string' ? v : '' }
  // 用 CLI 上报的会话实际模型校准模型 seat（2026-10-10 分层治理 4B 自 engine/sessions.js 反转迁入：
  // 「校准 seat」是输入栏行为，归 feature 层——engine 不再 import feature，故本函数随状态同处）。
  // 网关的每会话模型是权威源（CLI 上报即真，见 reportCurrentModel），web 一律采纳；唯一例外是
  // **切换前的在途快照**——用户刚在 web 切过（modelUserPicked）且这条上报的时刻早于那次切换
  // （modelTs < 本地 ts）→ 它是切换前发出的旧数据，采纳会把刚做的选择回滚（用户反馈「web 保留了
  // 上一个」）。旧实现用 modelUserPicked 一票否决整页会话剩余时间，CLI 侧后续切模型永远进不来
  // → 弃用，改为时间戳比较；一旦采纳过一次上报（外部真相落定）即解除防回滚标记，恢复常态跟随。
  function applySessionModel(model, modelTs) {
    if (!model) return
    // 写 modelUserPicked 一律走 setModelUserPicked（ESM 导入绑定只读，直接赋值 esbuild 直接报错）
    if (MODEL_CUR.model === model) { setModelUserPicked(false); return }
    if (
      modelUserPicked &&
      modelPickedHash === (state.currentHash || '') &&
      typeof modelTs === 'number' &&
      typeof MODEL_CUR.ts === 'number' &&
      modelTs < MODEL_CUR.ts
    ) return
    setModelUserPicked(false)
    setModelCur({ ...MODEL_CUR, model })
    saveModelCur()
    renderModelSeat()
  }
  // 命令菜单状态（对齐 dsh PopupState：open/status/options/search/active/submitting/confirming/acknowledged/error）
  // 2026-09-09 二轮定案：去 tab 单页分组（上传/技能/引用会话/指令堆放一页）；items=渲染时平铺条目（键盘索引基准）

/* @module inputbar/model-select.js #2 */
  function currentChoice() {
    const id = MODEL_CUR.model || (MODELS && (MODELS.activeModel || (MODELS.model ? String(MODELS.model) : ''))) || ''
    if (!id) return null
    return { model: { id, name: id } }
  }
  // 推理等级名（全局；effortLevel 未设置 = Off / 无 off 档模型显示「默认」）
  function effLabel() {
    const eff = MODEL_CUR.effortLevel
    if (eff === undefined || eff === null) return modelEffortLevels()?.includes('off') ? 'Off' : '默认'
    const level = EFFORT_LEVELS.find(e => e.id === eff)
    return level ? level.name : String(eff)
  }
  // 当前模型的官方思考等级清单（2026-09-18：凭据池 effortLevels 声明经 /gateway/models 下发；
  // 未声明返回 null → 回退固定 Off+Low/High/Max）。渲染与选择一律以此为准，不写死档位。
  const EFFORT_LABELS = { off: 'Off', low: 'Low', medium: 'Medium', high: 'High', max: 'Max', ultra: 'Ultra' }
  function modelEffortLevels() {
    const id = MODEL_CUR.model
    if (!id || !MODELS || !Array.isArray(MODELS.items)) return null
    const it = MODELS.items.find(x => x && x.v === id)
    return it && Array.isArray(it.effortLevels) && it.effortLevels.length ? it.effortLevels.map(String) : null
  }
  function renderModelSeat() {
    // 显示源 = currentChoice()（MODEL_CUR.model，用户切换后即时更新），不用 MODELS.model 缓存——
    // 否则切换后仍显示初次加载的旧模型（用户反馈「输入栏没同步最新模型」）。
    const c = currentChoice()
    const name = c ? c.model.name : '选择模型'
    const eff = MODEL_CUR.effortLevel != null ? effLabel() : ''
    // dsh ModelSelect trigger：.triggerLabel=模型名 + .triggerEffort=推理等级（无则隐藏）+ 静态 .chevron（随 open 翻转）
    const label = modelSeatEl.querySelector('.triggerLabel')
    const effort = modelSeatEl.querySelector('.triggerEffort')
    if (label) label.textContent = name
    if (effort) { if (eff) { effort.textContent = eff; effort.hidden = false } else effort.hidden = true }
    modelSeatEl.title = eff ? `${name} · ${eff}` : name
    modelSeatEl.dataset.real = c ? '1' : ''
    // 真实配置尚未拉取且未过 token 门 → 懒加载一次（成功后重渲触发座，静默失败保留占位）。
    // 2026-08-25 加 !MODELS_ERR 门：loadModelsData 的 finally 现在会回调 renderModelSeat，
    // 若不加失败门，加载失败后（MODELS 仍 null、loading 已复位）此处会立即再触发 → 无限重试循环。
    // 失败后不再自动重试，改由 hideGate 显式 loadModelsData(true) / mgr 视图重试钮驱动。
    if (!c && !needToken() && !MODELS_LOADING && !MODELS && !MODELS_ERR) {
      loadModelsData(false).then(() => renderModelSeat()).catch(() => {})
    }
  }
  // ---- 每会话思考等级（2026-11-06，C）----
  // 档位归属 = 会话，不归属 web 全局：显示源只有两个——① 该会话后端上报值（/gateway/session.effort，
  // CLI 落地后经 /gateway/model-report 回报）；② 无上报时回落 /gateway/models 的全局默认 effortLevel。
  // 切会话绝不再沿用上一会话的档位（旧实现只有一个 MODEL_CUR.effortLevel 槽 + localStorage，
  // 切会话座显示停在上一会话，且改档广播给全部会话）。
  let reportedEffort // 该会话最近一次上报档位：undefined=未上报，null=明确 Off，其它=档位名
  function globalEffortLevel() {
    return MODELS && MODELS.effortLevel != null ? String(MODELS.effortLevel) : undefined
  }
  // 按 reportedEffort + 全局默认重算 seat 档位（MODELS 晚到 / 切会话后各调一次）
  function syncEffortSeat() {
    const v = reportedEffort === undefined ? globalEffortLevel() : reportedEffort == null ? undefined : String(reportedEffort)
    if (MODEL_CUR.effortLevel === v) return
    setModelCur({ ...MODEL_CUR, effortLevel: v })
    renderModelSeat()
  }
  // 会话载入点（renderSession 首载 / 刷新回程 / 首页复位）传入后端上报值；undefined = 该会话无上报。
  // 无参调用 = 数据源（MODELS 全局默认）晚到，按最近上报值重算一次，不改变归属。
  function applySessionEffort(effort) {
    if (arguments.length) reportedEffort = effort === undefined ? undefined : effort == null ? null : String(effort)
    syncEffortSeat()
  }
  // 回首页（无会话）且无待定新会话选择 → seat 显示源回落凭据池全局默认（web 不再改全局默认）
  function syncSeatToGlobalDefault() {
    // 回首页 = 离开会话：档位回到全局默认（会话档位不跨会话残留在座上）
    reportedEffort = undefined
    syncEffortSeat()
    if (state.currentHash || newSessionModel) return
    const g = MODELS && (MODELS.activeModel || (MODELS.model ? String(MODELS.model) : ''))
    if (!g) return
    const prov = MODELS.activeProvider || MODEL_CUR.provider
    if (MODEL_CUR.model === g && MODEL_CUR.provider === prov) return
    setModelCur({ ...MODEL_CUR, model: g, provider: prov })
    saveModelCur()
    renderModelSeat()
  }
  function toggleModelPop() {
    if (msel.open) { closeModelPop(); return }
    if (cmd.open) closeCmdPop()
    closeMentionPop()
    msel.open = true
    msel.pane = 'root'
    msel.active = 0
    renderModelPop()
    if (!isTouch()) composerFocus() // 焦点留输入栏：方向键/ESC 走 keydown；触屏跳过防 iOS 弹键盘
  }
  function closeModelPop() {
    if (!msel.open) return
    msel.open = false
    modelPop.hidden = true
    modelSeatEl.querySelector('.chevron')?.classList.remove('open')
  }
  function modelEscape() {
    if (msel.pane !== 'root') { msel.pane = 'root'; msel.active = 0; renderModelPop() } else closeModelPop()
  }
  // 当前面板的可导航行（root=两 cell；model=凭据池模型按 provider 序；effort=Off + Low/High/Max）
  function mselRows() {
    if (msel.pane === 'model') {
      const rows = []
      for (const id of modelDir()) rows.push({ kind: 'model', id })
      return rows
    }
    if (msel.pane === 'effort') {
      // 官方档位动态渲染（2026-09-18）：有 effortLevels 声明=按声明逐档渲染（off→undefined 语义）；
      // 未声明=回退固定 Off + Low/High/Max。
      const levels = modelEffortLevels()
      if (levels) {
        return levels.map(id => ({ kind: 'effort', effort: id === 'off' ? undefined : id, label: EFFORT_LABELS[id] || id }))
      }
      const rows = [{ kind: 'effort', effort: undefined, label: 'Off' }]
      for (const e of EFFORT_LEVELS) rows.push({ kind: 'effort', effort: e.id, label: e.name })
      return rows
    }
    return [{ kind: 'cell', cell: 'model' }, { kind: 'cell', cell: 'effort' }]
  }
  function mselMove(d) {
    const n = mselRows().length
    if (!n) return
    msel.active = (msel.active + d + n) % n
    renderModelPop()
  }
  function renderModelPop() {
    if (!msel.open) return
    let html = ''
    if (msel.pane === 'root') {
      // dsh root 面板：Model / Effort 两行 cell（label + value + 右 chevron），无返回按钮（dsh 用 Escape 退级）
      const c = currentChoice()
      const mname = c ? c.model.name : '—'
      const ename = effLabel() || '—'
      html += `<button type="button" class="cell"><span class="cellLabel">模型</span><span class="cellValue">${esc(mname)}</span><span class="cellChevron">${I.dshChevRight}</span></button>`
      html += `<button type="button" class="cell"><span class="cellLabel">推理等级</span><span class="cellValue">${esc(ename)}</span><span class="cellChevron">${I.dshChevRight}</span></button>`
    } else if (msel.pane === 'model') {
      // dsh model 面板：.groups > .group[.groupTitle + .option×]，check 尾勾；分组按凭据池供应商（与 MGR 模型 tab 同判据）
      const ids = modelDir()
      if (!ids.length) {
        html += `<div class="empty">暂无模型</div>`
      } else {
        html += `<div class="groups">`
        const groups = []
        for (const id of ids) {
          // 2026-08-29 全池可选：优先用网关下发的真实归属供应商标签（items[].provider），缺失再走启发式前缀判定
          const it = ((MODELS && MODELS.items) || []).find(x => x && x.v === id)
          const p = (it && it.provider) || modelProviderOf(it || { k: id, v: id })
          let g = groups.find((x) => x.provider === p)
          if (!g) { g = { provider: p, items: [] }; groups.push(g) }
          g.items.push(id)
        }
        let idx = 0
        const curId = currentChoice()?.model.id
        for (const g of groups) {
          html += `<div class="group"><div class="groupTitle">${esc(g.provider)}</div>`
          for (const id of g.items) {
            const on = idx === msel.active ? ' on' : ''
            const selected = id === curId
            html += `<button type="button" class="option${on}" data-idx="${idx}" role="menuitemradio" aria-checked="${selected}"><span class="optionCopy"><span class="modelName">${esc(id)}</span></span><span class="check">${selected ? I.dshCheck : ''}</span></button>`
            idx++
          }
          html += `</div>`
        }
        html += `</div>`
      }
    } else if (msel.pane === 'effort') {
      // dsh effort 面板：扁平 option 列表（Off + Low/High/Max，无 groups 包裹）
      let idx = 0
      const curEff = MODEL_CUR.effortLevel
      for (const r of mselRows()) {
        const on = idx === msel.active ? ' on' : ''
        // Off 项只在「未显式选择等级」时勾选；具体等级按当前显式值匹配
        const selected = r.effort === undefined ? curEff === undefined : curEff === r.effort
        html += `<button type="button" class="option${on}" data-idx="${idx}" role="menuitemradio" aria-checked="${selected}"><span class="optionCopy"><span class="modelName">${esc(r.label)}</span></span><span class="check">${selected ? I.dshCheck : ''}</span></button>`
        idx++
      }
    }
    modelPop.innerHTML = html
    modelPop.hidden = false
    modelSeatEl.querySelector('.chevron')?.classList.add('open')
    // cell/option 点击不再需要 stopPropagation：外部关闭已改 mousedown+contains（mousedown 在重渲染前命中目标，
    // innerHTML 摘除节点不再误判「点外关闭」，dsh ModelSelect 同语义）
    modelPop.querySelectorAll('.cell').forEach((b, i) => b.addEventListener('click', () => { msel.pane = i === 0 ? 'model' : 'effort'; msel.active = 0; renderModelPop() }))
    modelPop.querySelectorAll('.option').forEach(b => b.addEventListener('click', () => { msel.active = +b.dataset.idx; mselChoose() }))
    const on = modelPop.querySelector('.option.on')
    if (on) on.scrollIntoView({ block: 'nearest' })
  }
  // 2026-10-05 apiSetModel 迁 engine/gateway.js（网关客户端唯一持有 needToken/apiUrl；卡片去 inputbar 依赖）。
  function mselChoose() {
    const row = mselRows()[msel.active]
    if (!row) return
    if (msel.pane === 'model') {
      const id = row.id
      if (MODEL_CUR.model === id) { closeModelPop(); return }
      const it = ((MODELS && MODELS.items) || []).find(x => x && (x.v === id || x.k === id))
      // 2026-08-29 直接切模型自动切供应商：MODEL_CUR.provider 同步真实归属（网关侧按会话绑定供应商）
      const prevEff = MODEL_CUR.effortLevel
      MODEL_CUR = { ...MODEL_CUR, model: id, provider: (it && it.provider) || MODEL_CUR.provider }
      // 切模型校验档位（2026-10-14 待办#7 补缺）：新模型有官方档位声明且当前档不在其中（例：从
      // DeepSeek 切 GLM 时残留 off，GLM 声明无 off）→ 清回「默认」，避免座显/菜单展示无效档；
      // 有会话时随切换下发改档（'off' 语义 = 网关 delete settings.effortLevel），与 effort 面板同链。
      const lv = modelEffortLevels()
      if (lv && prevEff != null && !lv.includes(prevEff)) {
        MODEL_CUR.effortLevel = undefined
        reportedEffort = undefined
        // 与 effort 面板同链同形：'off' = 网关清档；会话内必须带 sessionId（C：只清本会话，
        // 不得写全局 settings.json / 影响其它会话）
        void apiSetModel({ effortLevel: 'off', ...(state.currentHash ? { sessionId: state.currentHash } : {}) })
      }
      modelUserPicked = true // 2026-08-24：本次会话内主动切换，防止 /gateway/session 旧上报回滚
      modelPickedHash = state.currentHash || '' // 2026-11-06：防回滚只对「切换发生时所在会话」生效
      saveModelCur() // 2026-08-24：持久化，刷新后恢复
      renderModelSeat()
      closeModelPop()
      // 2026-09-10 会话级供应商绑定：有会话 → 会话级覆盖（网关随路由下发该模型归属供应商，
      // 目标 CLI 进程内绑定 baseUrl/key，只影响本会话）。
      // 2026-10-11 定案：首页（/新会话）不再写全局默认池（未传 defaultModel 即不下发 POST）——
      // 全局默认只由凭据池 credentials.json 决定（agent 直接改文件）；首页选中的模型记入
      // newSessionModel 待定槽，发送首条消息时随新会话做会话级切换（send.js），只影响那一次新建的会话。
      const home = !state.currentHash
      if (home) {
        setNewSessionModel(id)
        toast(`新会话将使用 ${id}（仅本次）`)
        return
      }
      void apiSetModel({ model: id, sessionId: state.currentHash })
        .then(ok => toast(ok ? `模型已切换为 ${id}` : '切换失败 · 目标会话未在线或网关未连接'))
    } else if (msel.pane === 'effort') {
      const eff = row.effort === undefined ? undefined : row.effort
      if (MODEL_CUR.effortLevel === eff) { closeModelPop(); return }
      MODEL_CUR = { ...MODEL_CUR, effortLevel: eff }
      saveModelCur() // 2026-08-24：持久化推理等级（仅作首页/刷新前的暂存；会话内真源 = 网关上报）
      renderModelSeat()
      closeModelPop()
      // 2026-11-06 每会话思考等级（C）：会话内带 sessionId → 网关只精确路由到本会话（不广播、
      // 不写全局 settings.json）；首页（无会话）= 全局默认，写盘供新会话继承，不影响已开会话。
      // Off（清除等级）发 'off'，网关据此让 CLI effortValue=undefined。
      const hash = state.currentHash
      // 会话内不再把「后端未上报」当成覆盖值：本地的主动选择即本会话当前档位，回载前以此为准
      reportedEffort = eff === undefined ? null : eff
      const payload = eff === undefined
        ? { effortLevel: 'off', ...(hash ? { sessionId: hash } : {}) }
        : { effortLevel: eff, ...(hash ? { sessionId: hash } : {}) }
      void apiSetModel(payload).then(ok => toast(ok ? `推理等级已切换为 ${row.label}` : (hash ? '切换失败 · 目标会话未在线' : '切换失败 · 网关未连接')))
    }
  }
  renderModelSeat() // 初始渲染模型 seat（trigger 显示当前模型名 · 推理等级）

// —— 跨模块写入口（切割脚本生成）——
export function setModelCur(v) { MODEL_CUR = v }
export function setModelUserPicked(v) { modelUserPicked = v }

export {
  MODEL_CUR,
  MODEL_KEY,
  applySessionEffort,
  applySessionModel,
  closeModelPop,
  currentChoice,
  effLabel,
  loadModelCur,
  modelDir,
  modelEscape,
  modelUserPicked,
  getNewSessionModel,
  setNewSessionModel,
  syncSeatToGlobalDefault,
  mselChoose,
  mselMove,
  mselRows,
  renderModelPop,
  renderModelSeat,
  saveModelCur,
  toggleModelPop,
}
