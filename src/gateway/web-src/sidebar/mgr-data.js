// 管理视图数据源（插件/技能清单 + 模型配置/供应商判定）（2026-09-10 web-src 模块化切割自 app.js v287；
// 2026-10-10 模型卡删除后 MODELS 一族只服务输入栏模型 seat，应用目录改由 engine/registry.js 持有；
// 唯一手改处，web/app.js 为生成物）

import { hideGate } from '../engine/auth.js'
import { needToken, apiUrl } from '../engine/gateway.js'
import { loadModelCur, saveModelCur, MODEL_CUR, renderModelSeat } from '../inputbar/model-select.js'
import { state } from '../engine/state.js'
import { refreshCard } from '../engine/registry.js'
/* @module sidebar/mgr-data.js */
  // ---------- 管理视图数据源（2026-08-15 起接后端 /gateway/plugins：真实已安装插件/技能 + 官方市场） ----------
  // 结构镜像后端返回：{ plugins:{personal,public}, skills:{personal,public} }，每项 {n, d, v, inst}。
  // 首次进入管理视图 fetch，刷新按钮 force 重新拉取；失败显示错误 + 重试（不回落假数据）。
  let MGR = null
  let MGR_LOADING = false
  let MGR_ERR = ''
  async function loadMgrData(force) {
    if (MGR && !force) return MGR
    if (needToken()) return null // token 门锁定态：不发起数据请求（hideGate 解锁后刷新）
    MGR_LOADING = true
    MGR_ERR = ''
    refreshCard('plugins')
    try {
      const res = await fetch(apiUrl('/gateway/plugins'))
      const data = await res.json()
      if (!data || !data.plugins || !data.skills) throw new Error(data.error || 'bad response')
      MGR = data
    } catch (e) {
      MGR_ERR = e.message || String(e)
    } finally {
      MGR_LOADING = false
      refreshCard('plugins')
    }
    return MGR
  }
  // 项目级技能清单（GET /gateway/plugins?label=<项目>）：项目根 .claude/skills/*/SKILL.md 的 frontmatter，
  // 返回 [{n, d, inst}]。与 MGR（便携根清单）分离——按项目 label 各自缓存，切项目不串。
  async function loadProjectSkills(label) {
    if (!label) return []
    const res = await fetch(apiUrl('/gateway/plugins?label=' + encodeURIComponent(label)))
    const data = await res.json()
    if (!data || !Array.isArray(data.skills)) throw new Error((data && data.error) || 'bad response')
    return data.skills
  }
  // 项目技能按 label 的进程内缓存（+ 工具栏与 @ 搜索共用一份）：{list, loaded, loading, err}。
  // ensureProjectSkills 同一 label 只发一次请求（在途期间复用同一 Promise），失败记 err 并在下次调用时重试。
  const PROJ_SKILLS = new Map()
  function projSkillsOf(label) {
    if (!label) return { list: [], loaded: true, loading: false, err: '' }
    let r = PROJ_SKILLS.get(label)
    if (!r) { r = { list: [], loaded: false, loading: false, err: '' }; PROJ_SKILLS.set(label, r) }
    return r
  }
  function ensureProjectSkills(label) {
    const r = projSkillsOf(label)
    if (!label || r.loaded || r.loading) return Promise.resolve(r.list)
    r.loading = true
    r.err = ''
    return loadProjectSkills(label)
      .then((list) => { r.list = list; r.loaded = true; return r.list })
      .catch((e) => { r.err = (e && e.message) || String(e); return r.list })
      .then((list) => { r.loading = false; return list })
  }
  // 模型配置数据源（/gateway/models：便携根 settings.json 的 model + 模型类环境变量；只读展示）
  let MODELS = null
  let MODELS_LOADING = false
  let MODELS_ERR = ''
  async function loadModelsData(force) {
    if (MODELS && !force) return MODELS
    if (needToken()) return null // token 门锁定态：不发起数据请求
    MODELS_LOADING = true
    MODELS_ERR = ''
    try {
      const res = await fetch(apiUrl('/gateway/models'))
      const data = await res.json()
      if (!data || !('model' in data)) throw new Error(data.error || 'bad response')
      MODELS = data
      // 与凭据池真实状态对齐（CLI 同源）：provider=activeProvider；effortLevel=settings.effortLevel。
      // model 优先级分两态（2026-09-19 修正「CLI 已切、web 底栏保留上一个」）：
      //   会话内（state.currentHash 非空）：本地 MODEL_CUR 最高——它由 /gateway/session（CLI 上报）
      //     与 SSE model 事件写入，是本会话的权威值；localStorage(saved) 是上次刷新残留，最低。
      //     旧实现把 saved 放最高，刷新即用陈旧值压掉网关真实模型（用户看到的「保留上一个」）。
      //   非会话态（列表/home）：无会话权威，按网关 activeModel → 便携根 settings.model → saved。
      const saved = loadModelCur()
      const inSession = !!state.currentHash
      setModelCur({
        provider: data.activeProvider || (saved ? saved.provider : '') || MODEL_CUR.provider,
        model: inSession
          ? MODEL_CUR.model || data.activeModel || (data.model ? String(data.model) : '') || (saved && saved.model) || ''
          : data.activeModel || (data.model ? String(data.model) : '') || (saved && saved.model) || MODEL_CUR.model,
        // effortLevel 只认网关真值（settings.json 落盘态）：网关返回 null/缺省 = 未设置 →
        // undefined（CLI 同源显示默认）。**不回落 localStorage**——陈旧 saved 会让座显报低档
        // 而 CLI 实际跑默认档（2026-10-24 用户实报「web 显示 low、CLI 是 high」的根因）。
        effortLevel: data.effortLevel != null ? String(data.effortLevel) : undefined,
      })
      saveModelCur()
    } catch (e) {
      // 2026-08-25 竞态防护：若期间已有一次成功加载（如 hideGate 用新 token 补拉已先落地），
      // 此陈旧失败（典型：gate 前空 token 的 401）不覆盖已就绪数据，避免把成功态又标成错误。
      if (!MODELS) MODELS_ERR = e.message || String(e)
    } finally {
      MODELS_LOADING = false
      renderModelSeat() // 2026-08-25 模型数据落地后刷新输入栏模型 seat（含 hideGate 补拉场景）
    }
    return MODELS
  }
  // 色块取色（mgrColor）已随管理页通用 UI 收进 @floria/web 包（mgr.color），本层不再持有第二份调色板。
  // 供应商判定（2026-10-05 自 views/cards/models/models-card.js 迁入数据层——模型卡与输入栏模型菜单
  // 共用唯一一份；卡片去兄弟子系统横向依赖后经此取用）。key 优先（模型类环境变量名带供应商前缀），
  // 通用 model 键或未命中则按模型串前缀。
  const MODEL_PROVIDER_KEYS = [
    [/^ANTHROPIC_/, 'Claude · Anthropic'],
    [/^OPENAI_/, 'OpenAI'],
    [/^GEMINI_/, 'Google Gemini'],
    [/^DEEPSEEK_/, 'DeepSeek'],
    [/^QWEN_/, 'Qwen · 通义千问'],
    [/^DASHSCOPE_/, 'Qwen · 通义千问'],
    [/^GLM_/, '智谱 GLM'],
    [/^MOONSHOT_/, 'Moonshot Kimi'],
    [/^OPENROUTER_/, 'OpenRouter'],
  ]
  function modelProviderOf(it) {
    const k = String(it.k || '')
    const v = String(it.v || '')
    if (k !== 'model') {
      for (const [re, name] of MODEL_PROVIDER_KEYS) if (re.test(k)) return name
    }
    const vl = v.toLowerCase()
    if (vl.startsWith('claude')) return 'Claude · Anthropic'
    if (vl.startsWith('deepseek')) return 'DeepSeek'
    if (vl.startsWith('qwen')) return 'Qwen · 通义千问'
    if (vl.startsWith('gpt') || vl.startsWith('o1') || vl.startsWith('o3')) return 'OpenAI'
    if (vl.startsWith('gemini')) return 'Google Gemini'
    if (vl.startsWith('glm')) return '智谱 GLM'
    if (vl.startsWith('moonshot') || vl.includes('kimi')) return 'Moonshot Kimi'
    if (vl.includes('doubao')) return '字节豆包'
    return '自定义 / 其他'
  }

export {
  MGR,
  MGR_ERR,
  MGR_LOADING,
  MODELS,
  MODELS_ERR,
  MODELS_LOADING,
  loadMgrData,
  ensureProjectSkills,
  loadModelsData,
  loadProjectSkills,
  modelProviderOf,
  projSkillsOf,
}
