// 项目预览帧 + 外部卡申报同步 + 侧栏快捷按钮状态（2026-10-10 自 views/cards/{preview,ext} 下移为
// feature 层）：渲染实现（iframe 三级链）与「当前预览文档」域的状态清点同属 feature，engine 契约
// （registry/ext-decl）只做表编排——engine 永不 import views。唯一手改处，web/app.js 为生成物。

import { gToken } from '../engine/gateway.js'
import { state } from '../engine/state.js'
import { esc } from '../core/util.js'
import { deactivateCard, openCard, viewBody } from '../engine/registry.js'
import { clearExtCards, clearQuoteActions, registerExtCards, registerQuoteActions } from '../engine/ext-runtime.js'
import { cardBus } from '../engine/card-bus.js'
import { navigate } from '../chat/route.js'
/* @module feature/preview-frame.js */
  // ---------- 整卡显隐中枢接线（2026-10-13 card:* 保留动词）----------
  // 执行口 = 既有路由链（navigate → route，与用户点侧栏完全同链）：open = '#preview/<label>'
  // （route 内含 sbMode 强制回 chat、state.preview、openProjectPreview(true) 全套）；close = 回主页
  // （renderHome 清槽）。work 模式的卡片显隐不经此口（work 面板归 sidebar 域），显式报错不静默。
  cardBus.setSlotHost({
    open: (label) => { navigate('#preview/' + encodeURIComponent(label)) },
    close: () => {
      if (state.sbMode === 'work') throw new Error('work 模式的卡片显隐不经宿主槽位口')
      navigate('#/')
    },
  })
  // 项目预览申报表同步（外部卡 卡片化二期 + 浮窗动作 2026-09-28）：两表同属「当前 .preview-frame
  // 所指项目」——与 clearRailExt 同点调用（iframe 换 src / 新文档重挂）。网关侧已按同一份规则校过
  // preview.json，registerExtCards / registerQuoteActions 再校一遍（postMessage 那条不过网关，
  // 两条外部输入共用 engine/ext-decl.js 的同一份过滤器）。**一次请求取两份申报，不新增请求**。
  // seq 守卫：只有最后一次 sync 的响应可以落表（快速连点两个项目时先发的响应可能后到）。
  let extCardsSeq = 0
  // ---------- 预览工作区卡片（2026-10-18）----------
  // 一张卡 = <项目>/.claude/preview/<id>/ 一个目录（元信息 card.json，网关扫描后随同一份
  // /gateway/preview-cards 响应下发 previewCards）。表属于「当前项目」：label 不同即空表，
  // 不沿用上一项目的卡（与 EXT 同一条生命周期不变量）。宿主 tab 条与 iframe 加载都读本表。
  let pvCards = []
  let pvCardsLabel = ''
  let pvCardsReady = false
  let pvHasIndex = false
  let pvIndexEnabled = false
  // 传统单页预览的管理页保留 id：与网关 POST /gateway/preview-cards/enable 的保留键一致
  const PREVIEW_INDEX_CARD_ID = '__index__'
  let pvCardsInflight = null
  let pvCardsInflightLabel = ''
  let pvCardPayloads = [] // [{ label, card, payload }]：卡→卡跳转的交接数据，目标帧 load 时消费一次

  function normPreviewCards(raw) {
    const seen = new Set()
    return (Array.isArray(raw) ? raw : [])
      .filter((c) => c && typeof c === 'object' && !Array.isArray(c))
      .map((c) => ({
        id: typeof c.id === 'string' ? c.id.trim() : '',
        title: typeof c.title === 'string' ? c.title.trim() : '',
        icon: typeof c.icon === 'string' && c.icon ? c.icon : 'plug',
        entry: typeof c.entry === 'string' && c.entry ? c.entry.trim() : 'index.html',
        order: typeof c.order === 'number' && Number.isFinite(c.order) ? c.order : 100,
        default: c.default === true,
        // 启用态 = 卡目录内无 .disabled（网关判定）；停用卡不进 tab / 不挂载，但留在卡表里供管理页启用。
        enabled: c.enabled !== false,
        // 卡级后端声明（网关下发布尔 + 显示名，不下发 cmd/cwd）：有后端卡 /gateway/backend 带 card 拉起。
        hasBackend: c.backend === true,
        backendName: typeof c.backendName === 'string' ? c.backendName : '',
      }))
      .filter((c) => {
        if (!/^[a-zA-Z0-9_-]{1,32}$/.test(c.id) || !c.title || seen.has(c.id)) return false
        seen.add(c.id)
        return true
      })
  }
  function registerPreviewCards(label, cards, hasIndex, indexEnabled) {
    if (!label) return
    pvCards = normPreviewCards(cards)
    pvCardsLabel = label
    pvHasIndex = hasIndex === true
    pvIndexEnabled = pvHasIndex && indexEnabled !== false
    pvCardsReady = true
  }
  // 当前项目的卡表（异 label = 空表，防串项目）。调用方按需 clone，不写回本表。
  function previewCardsFor(label) {
    return label && pvCardsLabel === label ? pvCards : []
  }
  // 已启用的卡（tab 条 / 卡选择 / 切换的唯一数据源）：停用卡只在管理页出现。
  function enabledPreviewCardsFor(label) {
    return previewCardsFor(label).filter((c) => c.enabled)
  }
  // 传统单页预览 .claude/preview/index.html 是否可视（存在且未被停用；与「有已启用卡」并列判可预览）
  function previewHasIndexPage(label) {
    return !!label && pvCardsLabel === label && pvHasIndex && pvIndexEnabled
  }
  // 传统单页预览的管理页条目（保留 id，启停走同一端点）。无该页 → null。
  function previewLegacyIndexCard(label) {
    if (!label || pvCardsLabel !== label || !pvHasIndex) return null
    return {
      id: PREVIEW_INDEX_CARD_ID,
      title: '预览页',
      icon: 'dshFile',
      entry: 'index.html',
      order: -1,
      default: false,
      enabled: pvIndexEnabled,
      hasBackend: false,
      backendName: '',
    }
  }
  function previewCardsReadyFor(label) {
    return !!label && pvCardsLabel === label && pvCardsReady
  }
  function previewPaneCardDef(label, id) {
    return previewCardsFor(label).find((c) => c.id === id) || null
  }
  // 归一化激活卡：命中现有表则原样；否则回落 default（无 default 取排序首张）；无卡表 = ''。
  function previewCardNormId(label, id) {
    const list = enabledPreviewCardsFor(label)
    if (!list.length) return ''
    if (id && list.some((c) => c.id === id)) return id
    const d = list.find((c) => c.default) || list[0]
    return d.id
  }
  // 卡表就绪才返回；未就绪先取一次申报。in-flight 按 label 去重（work 首渲与 mount 同时问只发一次）。
  function ensurePreviewDecls(label, force) {
    if (!label) return Promise.resolve([])
    if (!force && previewCardsReadyFor(label)) return Promise.resolve(previewCardsFor(label))
    if (pvCardsInflight && pvCardsInflightLabel === label) return pvCardsInflight
    const p = syncExtCards(label).then(() => (previewCardsReadyFor(label) ? previewCardsFor(label) : []))
    pvCardsInflight = p
    pvCardsInflightLabel = label
    p.finally(() => {
      if (pvCardsInflight === p) { pvCardsInflight = null; pvCardsInflightLabel = '' }
    })
    return p
  }
  // 卡→卡跳转的交接数据：源卡 postMessage 带 payload 时由宿主暂存，目标帧 load 后随 init 下发一次。
  function setPendingCardPayload(label, card, payload) {
    pvCardPayloads = pvCardPayloads.filter((p) => !(p.label === label && p.card === card))
    pvCardPayloads.push({ label, card, payload })
  }
  function takePendingCardPayload(label, card) {
    const i = pvCardPayloads.findIndex((p) => p.label === label && p.card === card)
    if (i < 0) return null
    const v = pvCardPayloads[i].payload
    pvCardPayloads.splice(i, 1)
    return v
  }
  // 卡页入口 URL 片段（卡目录内 entry，逐段编码；entry 已由网关/前端校验为安全相对路径）
  function cardEntryPath(card) {
    return card.entry.split('/').map(encodeURIComponent).join('/')
  }

  // ---------- 卡池（2026-10-26 用户实报「PDF 卡 / 日志卡切换卡顿」根修）----------
  // 旧行为 = 换卡就换 iframe 的 src ⇒ 整页重载（pdf.js 重新初始化、日志重新拉取），每次切换都在等启动。
  // 新行为 = **同一容器里每张卡一枚 iframe，首次进入才创建，之后切换只切显隐**：页面状态（页码 / 滚动 /
  // 展开项）原样保留，切换瞬时完成。池按卡 id 存在 .preview-body 上（body 随容器重建即整池作废）。
  // 隐藏帧：留在文档里继续接收广播（事实类，如 file-open），但**不可被指令寻址**（cardBus.setFrameActive），
  // 否则同 label 多帧会判「目标卡不唯一」。
  function pvPool(body) {
    if (!body.__pvFrames) body.__pvFrames = new Map()
    return body.__pvFrames
  }
  // 当前显示的那枚预览帧（唯一取处）：池化后 .preview-frame 可能有多枚，一律按显隐取。
  function activePreviewFrame(root) {
    const scope = root || document
    for (const el of scope.querySelectorAll('.preview-frame')) if (!el.hidden) return el
    return null
  }
  // 激活帧变更回调（唯一处）：池内切显隐后宿主据此恢复「该帧自己申报过的」帧工具 / 侧栏按钮 /
  // 卡→卡交接数据——帧没换文档 ⇒ load 不会再触发，这些只能在切显隐这一刻补。
  let pvActiveHook = null
  function setPreviewActiveHook(fn) {
    pvActiveHook = typeof fn === 'function' ? fn : null
  }
  // 池内切显隐（唯一写口）：目标帧亮、其余帧隐，并同步 cardBus 激活态。
  function pvShow(container, key) {
    const body = container.querySelector('.preview-body')
    if (!body) return
    for (const [k, rec] of pvPool(body)) {
      const on = k === key
      rec.el.hidden = !on
      if (rec.overlay && rec.overlay.isConnected) rec.overlay.hidden = !on
      if (rec.el.__cardKey) cardBus.setFrameActive(rec.el.__cardKey, on)
    }
    const rec = pvPool(body).get(key)
    if (rec && pvActiveHook) pvActiveHook(container, rec.el, key)
  }
  // 拆池：换项目 / 容器离场时逐帧注销并清 DOM（旧项目的所有卡一并作废）。
  function pvClear(container) {
    const body = container.querySelector('.preview-body')
    const pool = body ? pvPool(body) : null
    if (pool) {
      for (const rec of pool.values()) {
        if (rec.el && rec.el.__cardKey) cardBus.unregisterFrame(rec.el.__cardKey)
      }
      pool.clear()
    }
    container.innerHTML = ''
  }

  function syncExtCards(label) {
    const seq = ++extCardsSeq
    clearExtCards()
    clearQuoteActions()
    return fetch(`/gateway/preview-cards?label=${encodeURIComponent(label)}${gToken ? '&token=' + encodeURIComponent(gToken) : ''}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((d) => {
        if (seq !== extCardsSeq) return
        registerExtCards(label, d && d.cards, true)
        registerQuoteActions(label, d && d.quoteActions)
        registerPreviewCards(label, d && d.previewCards, d && d.hasIndex, d && d.indexEnabled)
      })
      .catch(() => {
        // 清单拿不到 = 该项目无外部卡/无浮窗动作/无预览卡（空表是正常态，不猜不兜底）
        if (seq === extCardsSeq) registerPreviewCards(label, [], false, false)
      })
  }

  // 项目预览：主聊天区渲染 iframe，替换管理/会话界面；退出预览走侧栏导航（route 统一清心跳）。
  // 预览页加载两级策略（2026-08-19 Web 容器；2026-10-18 删除宿主内置默认页）：
  //  ① preview.json 声明 backend → 网关 /gateway/backend 懒加载 spawn 后端进程，iframe 直连 http://127.0.0.1:<port>/
  //     （并 60s 心跳刷新网关侧 lastActive，防空闲回收误杀）；
  //  ② 有 .claude/preview/ 静态页（hasPreview=true）→ 加载卡目录页；都没有 → 空态占位（不提供的项目不造页）。
  // 项目后端预热：右栏「工具栏」一打开就拉起该项目 backend，免去「点了第一个卡 tab 才开始 spawn」的等待。
  // 与 mountPreview 的 ① 分支同一请求（/gateway/backend 是唯一 spawn 口，未声明 backend 的项目 404 静默）；
  // ensureBackend 自带存活复用与 in-flight 去重，重复调用不会产生第二个进程。
  function warmProjectBackend(label, cardId) {
    if (!label) return
    const q = cardId ? `&card=${encodeURIComponent(cardId)}` : ''
    fetch(`/gateway/backend?label=${encodeURIComponent(label)}${q}${gToken ? '&token=' + encodeURIComponent(gToken) : ''}`)
      .catch(() => {})
  }

  function openProjectPreview(label, hasPreview) {
    // 硬进入（异 label / 帧不在场；软重入不清不重建 shell，见 mountPreview 两级重入说明）：先卸会话视图
    // 再占预览槽——deactivateCard('session') 即 registry 契约出口，给到会话卡自身的 teardown 钩子
    // （停实时计时 + 拆 stage 占位 + 清全局槽 + 复位 currentHash）。本卡不再懂 chat 清理清单。
    const body0 = viewBody('preview')
    if (state.preview !== label || !body0 || !body0.querySelector('.preview-frame')) {
      deactivateCard('session')
      state.preview = label
    }
    openCard('preview', { label, hasPreview })
  }

  // 预览渲染器（两级链的唯一一份实现：后端容器 → 静态 preview）。两个消费方——
  // 槽位预览卡（openProjectPreview，独占主区）与 work 个性化工作区第三栏（sidebar/work.js），
  // 到 iframe 这一层没有第二套代码。
  // 2026-09-04 重挂根修：WS 重连 onopen→hideGate 恢复链（state.preview → route）会重挂 iframe，
  // src 恒回站点根——iPad 后台杀 WS 后回到前台必触发，用户被弹回 Pj15 等站点开始页。
  // 2026-09-17 软重入根治（「打开项目界面有概率跳回 chat」二轮）：旧幂等守卫要求 previewMounted===label，
  // 而无真源时曾记 null → 每次断连重连/门解锁都整区重写 shell + iframe 重载；iOS 上 iframe
  // 二次导航会污染主历史并诱发自发后退，落到 /session/<hash> 即被弹回会话 chat。故两级重入：同 label 且
  // iframe 在场（data-label 锚定）= 软重入——不重写 shell，三级链照跑但 mount 按 iframe 现有 src 校正
  // （同 src 零操作 = 零导航扰动；异 src 只换 src 纠正，覆盖 backend 就绪升级/default 换真源）；
  // 异 label 或 iframe 不在场 = 硬挂载。
  function mountPreview(container, label, hasPreview, cardId) {
    if (!container) return
    // 换项目 = 换源：上一份的帧留不得（软重入 / 卡池只对同 label 成立）
    const prevLabel = container.__pvLabel || ''
    const hard = prevLabel !== label
    // 卡片清单必须就位才能决定 URL（有卡 = 卡目录页，无卡 = 传统 index.html）。
    // 清单未就绪先拉一次申报再重入；ensure 自带 in-flight 去重，这里只防同一容器并行重入。
    if (!previewCardsReadyFor(label)) {
      if (container.__pvWaitLabel === label) return
      container.__pvWaitLabel = label
      ensurePreviewDecls(label, hard).then(() => {
        if (container.__pvWaitLabel === label) container.__pvWaitLabel = ''
        if (container.isConnected) mountPreview(container, label, hasPreview, cardId)
      })
      return
    }
    container.__pvWaitLabel = ''
    // 卡选择只在**已启用**卡里做：停用卡不挂载（点它的 tab 也已在渲染层消失）。
    const list = enabledPreviewCardsFor(label)
    const card = list.length ? (list.find((c) => c.id === cardId) || list.find((c) => c.default) || list[0]) : null
    const cardActual = card ? card.id : ''
    if (hard && prevLabel) {
      // 换项目 = 上一项目的整池帧彻底拆除：逐帧当场注销（不等 isConnected 失格）
      pvClear(container)
    }
    container.__pvLabel = label
    // 预览 iframe 挂在 .preview-body 里（该层由下面的 shell 建立，软重入时原样保留）
    if (!container.querySelector('.preview-body')) {
      container.innerHTML =
        '<div class="preview-shell">' +
        '<div class="preview-body"><div class="preview-loading">正在加载…</div></div>' +
        '</div>'
    }
    // 无后端、无 .claude/preview 静态页 = 该项目没有可视预览：空态占位（宿主不再内置默认页）。
    const mountEmpty = () => {
      if (!container.isConnected) return
      const body = container.querySelector('.preview-body')
      if (!body) return
      clearRailExt() // 旧文档注册的侧栏快捷按钮随文档失效
      pvClear(container) // 池内旧帧一并作废（空态下没有卡可切，留着只会切到已离场的元素）
      container.innerHTML =
        '<div class="preview-shell"><div class="preview-body"><div class="preview-empty">该项目暂无预览</div></div></div>'
      state.previewMounted = label
    }
    const mount = (src, name, already) => {
      // 异步回程守卫：三级链是异步的，回来时容器可能已离场（槽位换卡 / work 关掉预览栏）
      if (!container.isConnected) return
      const body = container.querySelector('.preview-body')
      if (!body) return
      const key = cardActual || ''
      const cur = pvPool(body).get(key)
      if (cur) {
        // 池内已有这张卡：只切显隐，**不重载**（页码/滚动/展开项原样保留 = 切换瞬时）。
        // 异 src（后端直连 → 代理 / 就绪升级）才换 src 纠正，那是真换文档。
        if (cur.el.getAttribute('src') !== src) {
          // 真换文档：旧文档的申报与总线状态一并作废（缓存清空 + loaded 复位，
          // 交接数据必须等新文档 load 再发），否则切显隐那刻会把上一份文档的工具表恢复出来。
          clearRailExt()
          cur.el.__railItems = []
          cur.el.__wkTools = []
          cur.el.__pvLoaded = false
          cur.el.setAttribute('src', src)
          cardBus.registerFrame({ kind: 'preview', label, el: cur.el }) // 同 el 复用 key，重置 ns/ready/cmds
        }
        cur.el.dataset.card = cardActual
        state.previewMounted = label
        pvShow(container, key)
        return
      }
      // 覆盖层遮住后端前端加载时的深色初始化画面（2026-08-20 三轮反馈后定稿 v81）：
      // ① 纯遮罩无指令/按钮（用户「弹出的指令框」= 带指令文字的提示层，已去指令）；
      // ② 文案由 backend name 驱动（可插拔：preview.json backend.name，缺省「项目服务」）；
      // ③ backend 容器 load 后缓冲自动淡出 —— 用户「不点击界面就永远卡转圈，但其实早就启动好了」：
      //    后端已就绪（/gateway/backend 命中）才挂 iframe，load 后 object_info（如 ComfyUI 855 节点）拉取渲染
      //    还需数秒，缓冲 8s 自动淡出（不再永远卡转圈），点击仍可提前关闭（focus iframe 移交内部焦点）。
      // ④ 2026-08-28 生命周期解耦：already=后端进程已在跑（复用/收养）→ 不渲染覆盖层，iframe 直挂秒开
      //    （后端常驻后刷新/重进预览不再见「正在启动」，仅冷启动时显示）。
      clearRailExt() // 新文档重挂 → 清上一份预览页注册的侧栏快捷按钮（不变量见 sidebar/rail-ext.js）
      const loading = body.querySelector('.preview-loading')
      if (loading) loading.remove()
      const frame = document.createElement('iframe')
      frame.className = 'preview-frame'
      frame.title = `${label} 项目主页`
      frame.dataset.label = label
      frame.dataset.card = cardActual
      frame.src = src
      body.appendChild(frame)
      let overlay = null
      if (!already) {
        overlay = document.createElement('div')
        overlay.className = 'preview-overlay'
        overlay.innerHTML =
          '<div class="preview-overlay-spin"></div>' +
          `<div class="preview-overlay-title">正在启动 ${esc(name || '项目服务')}…</div>` +
          '<div class="preview-overlay-sub">首次启动需等待后端就绪，加载完成后将自动进入</div>'
        body.appendChild(overlay)
      }
      pvPool(body).set(key, { el: frame, overlay })
      state.previewMounted = label
      // 挂进卡片总线：预览页（如 Pj18 的 floria-pv）说 `<ns>-cmd`/`<ns>-event` 即被总线认领
      cardBus.registerFrame({ kind: 'preview', label, el: frame })
      pvShow(container, key)
      let autoDismiss = null
      const dismiss = () => {
        if (autoDismiss) { clearTimeout(autoDismiss); autoDismiss = null }
        if (overlay) { overlay.classList.add('done'); setTimeout(() => overlay.remove(), 400) }
      }
      frame.addEventListener('load', () => {
        frame.__pvLoaded = true
        frame.focus()
        // 卡片身份 + 交接数据（卡→卡跳转）：以 dataset 为准（换 src 时闭包里的 card 已过期）。
        // 无卡（传统单页预览）不发，旧页不受影响。
        const liveCard = frame.dataset.card || ''
        if (liveCard) {
          const payload = takePendingCardPayload(label, liveCard)
          try { frame.contentWindow.postMessage({ type: 'floria-wk-card-init', card: liveCard, payload }, '*') } catch { /* 帧已销毁：丢弃 */ }
        }
        if (!overlay) return
        // backend 容器（传了 name）：object_info 拉取渲染需数秒，缓冲后自动淡出；
        // 静态 preview / 默认主页（无 name）：无后端 loading，立即淡出不挡内容
        if (name) autoDismiss = setTimeout(dismiss, 8000)
        else dismiss()
      })
      // 点击关闭（可提前进入）：focus iframe + 移除覆盖层；首次点击把键盘焦点交给 iframe 内部
      if (overlay) overlay.addEventListener('click', () => { frame.focus(); dismiss() })
    }
    // ① Web 容器：backend 优先（/gateway/* 受网关 token 校验）。
    // 卡自己声明了 backend ⇒ 带 card 拉起该卡专属后端；无卡级声明 ⇒ 走项目级 backend（旧链），
    // 项目也没声明则 404 → 静态 preview。
    const cardQ = card && card.hasBackend ? `&card=${encodeURIComponent(card.id)}` : ''
    fetch(`/gateway/backend?label=${encodeURIComponent(label)}${cardQ}${gToken ? '&token=' + encodeURIComponent(gToken) : ''}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((d) => {
        if (!(d && d.url)) throw new Error('no-backend')
        // 2026-08-27 远程端分流：127.0.0.1 直连仅在本机浏览器成立，手机等远程宿主一律改走
        // 网关同源代理 /backend/<label>/（访问票由上一拍 /gateway/backend 响应种下的 HttpOnly cookie 提供）
        const remotePage =
          location.protocol.startsWith('http') && ['127.0.0.1', 'localhost'].indexOf(location.hostname) < 0
        // 卡页 = 卡目录内 entry（默认 index.html）；无卡 = 后端根（传统单页预览）
        const rel = card ? `${encodeURIComponent(card.id)}/${cardEntryPath(card)}` : ''
        mount(remotePage ? `/backend/${encodeURIComponent(label)}/${rel}` : d.url + rel, d.name, !!d.alreadyRunning)
        if (window.__backendHeartbeat) clearInterval(window.__backendHeartbeat)
        window.__backendHeartbeat = setInterval(() => {
          fetch(`/gateway/backend?label=${encodeURIComponent(label)}${cardQ}&token=${encodeURIComponent(gToken || '')}`).catch(() => {})
        }, 60000)
      })
      .catch(() => {
        // ② 静态 preview；项目未申报 preview 目录、或无卡且传统单页被停用 → 空态
        if (!hasPreview || (!card && !previewHasIndexPage(label))) { mountEmpty(); return }
        const previewSrc = card
          ? `/preview/${encodeURIComponent(label)}/${encodeURIComponent(card.id)}/${cardEntryPath(card)}${gToken ? '?token=' + encodeURIComponent(gToken) : ''}`
          : `/preview/${encodeURIComponent(label)}/index.html${gToken ? '?token=' + encodeURIComponent(gToken) : ''}`
        fetch(previewSrc, { method: 'GET' })
          .then((r) => {
            if (!r.ok) throw new Error('HTTP ' + r.status)
            mount(previewSrc)
          })
          .catch(mountEmpty)
      })
  }

  // ---------- 预览页注册的侧栏快捷按钮 · 状态与清点（2026-10-05 自 sidebar/rail-ext.js 迁入）----------
  // 快捷按钮集（floria-rail-register 申报）与外部卡申报同属「当前预览文档」域，故其清点与 EXT 清点
  // 同居本模块；preview-frame 内部（mountPreview 重挂）直接调 clearRailExt（不再横向 import
  // sidebar/rail-ext.js）。桥接与渲染（bindRailExtBridge / renderRailExt）留在 sidebar/rail-ext.js，
  // 经 setRailExtItems 写本表。
  let railExtItems = []
  function setRailExtItems(items) { railExtItems = items }
  function clearRailExt() {
    railExtItems = []
    const box = $('rail-ext')
    if (box) box.innerHTML = ''
  }

export {
  activePreviewFrame,
  clearRailExt,
  enabledPreviewCardsFor,
  ensurePreviewDecls,
  mountPreview,
  openProjectPreview,
  previewHasIndexPage,
  previewLegacyIndexCard,
  previewPaneCardDef,
  previewCardNormId,
  previewCardsFor,
  previewCardsReadyFor,
  railExtItems,
  setPendingCardPayload,
  setPreviewActiveHook,
  setRailExtItems,
  syncExtCards,
  takePendingCardPayload,
  warmProjectBackend,
}
