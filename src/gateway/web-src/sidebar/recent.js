// 侧栏 recent + 行操作（标题展开/内嵌菜单/归档/关闭/重命名）（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { route, navigate, renderSession } from '../chat/route.js'
import { deviceHint } from '../engine/auth.js'
import { gws, needToken, apiUrl } from '../engine/gateway.js'
import { I } from '../core/icons.js'
import { refreshList, refreshSession } from '../engine/live.js'
import { hashOf } from '../engine/sessions.js'
import { bodyEl, sidebar, bubblePop, recentLabel, modeTabsEl, state, ALL } from '../engine/state.js'
import { esc, toast, isMobile } from '../core/util.js'
import { applyPanelOpen } from '../engine/panel.js'
import { savePins, saveWork } from '../core/storage.js'
import { gwSend } from '../inputbar/send.js'
import { renderBubble, renderSearch } from './bubble-search.js'
import { renderList, renderProject } from './mgr.js'
/* @module sidebar/recent.js */
  // ---------- 侧栏 ----------
  // 开合唯一入口。opt.pin 只在打开时有意义：钉住 = 鼠标移出侧栏不自动收（汉堡/抽屉把手点击），
  // 不钉 = 预览式（左缘悬停唤出）。收起一律清钉住态，避免上一轮的钉住 residual 影响下次悬停。
  // 钉住态挂 state.panelPinned（跨模块真源）。pin 可由 menu-btn/panel-collapse/scrim 任一处翻转。
  function setPanel(open, opt) {
    applyPanelOpen(open, !!(opt && opt.pin)) // 状态落地唯一核（engine/panel.js）：钉住态 + 可见态 + #sidebar.open + 调宽复位
    // 展开/折叠侧栏时关闭相关弹层
    bubblePop.classList.remove('show')
    $('organize-pop').classList.remove('show')
    if (!open) { closeRowMenu(); peekClear() } // 不变量：侧栏收起 ⇒ 挂在它里面的行浮窗/延展层一并收
    // （2026-10-14 待办 5：视图浮层退役，原 syncPaneRows 行状态链删除）
  }
  // 悬停预览的收口：鼠标离开侧栏且未钉住 → 收起。钉住态（汉堡打开）鼠标怎么走都不收；
  // 侧栏折叠时宽度 0，本事件不会触发。行浮窗挂在 #sidebar 内（见 openRowMenu），指针移到浮窗上
  // 不算离开侧栏，故悬停预览下浮窗可用。
  sidebar.addEventListener('mouseleave', () => { if (!state.panelPinned) setPanel(false) })

  // ---------- 侧栏拖拽调宽（2026-09-12）：仅桌面展开态生效（#panel-resizer 由 CSS 按
  // #sidebar.open + ≥721px 门控显示，pointerdown 再复核 .open 双保险）。拖动改 :root 内联
  // --panel-w——#sidebar 与 .panel-inner 的宽消费同一变量，主区靠 flex 跟随；不持久化，
  // setPanel(false) 清内联值。拖拽中 body.sb-resizing 关宽度过渡即时跟手。
  {
    const rz = $('panel-resizer')
    const clampW = (x) => Math.max(232, Math.min(560, window.innerWidth - 120, x))
    rz.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !sidebar.classList.contains('open')) return
      rz.setPointerCapture(e.pointerId)
      rz.classList.add('dragging')
      document.body.classList.add('sb-resizing')
      e.preventDefault()
    })
    rz.addEventListener('pointermove', (e) => {
      if (!rz.classList.contains('dragging')) return
      document.documentElement.style.setProperty('--panel-w', `${Math.round(clampW(e.clientX))}px`)
    })
    const release = () => {
      if (!rz.classList.contains('dragging')) return
      rz.classList.remove('dragging')
      document.body.classList.remove('sb-resizing')
    }
    rz.addEventListener('pointerup', release)
    rz.addEventListener('pointercancel', release)
  }

  // 项目编号提取（2026-08-25）：projectLabel 如 'Pj16-CodeAgent构建' → 短编号 'Pj16'；
  // 命中 Pj<数字> 前缀取前缀，否则回落完整 label（个别非 Pj 命名项目也能区分）。
  function projIdOf(label) {
    const m = /^Pj\d+/.exec(label || '')
    return m ? m[0] : label || ''
  }

  // ---------- work 侧栏会话置顶（2026-10-18）----------
  // 状态源 = state.wkPins（core/ui-state.js，经独立写口 savePins 持久化——不进 saveWork 整包，
  // 免得别的标签页保存布局时用旧内存态把新置顶覆盖回去）。**只在 work 侧栏渲染**：
  // 排序与行内图钉标记都由 work 列表出口（work-files.js wkBodyHtml）消费；chat 侧栏列表不读、
  // 菜单项也只对 #wk-body 内的行出现。置顶/取消置顶的唯一写口 = togglePin。
  function isPinned(hash) {
    return !!hash && state.wkPins.includes(hash)
  }
  function togglePin(hash) {
    if (!hash) return
    state.wkPins = isPinned(hash)
      ? state.wkPins.filter((h) => h !== hash)
      : state.wkPins.concat(hash)
    savePins()
    renderWorkBody() // 列表唯一渲染出口（work-files.js）：重排 + 图钉标记一次落地
    toast(isPinned(hash) ? '已置顶' : '已取消置顶')
  }

  function itemHtml(s, showProj, showPin) {
    const on = hashOf(s) === state.currentHash
    // 会话状态点：busy=绿（正在运行）· waiting=橘（等待用户）· idle=红（运行暂停/已完成）· 无=透明（CLI 未打开）
    const dotCls = s.state === 'busy' ? ' st-busy' : s.state === 'waiting' ? ' st-ask' : s.state === 'idle' ? ' st-wait' : ''
    // 2026-08-25 项目会话编号气泡（仅「在一个列表中」堆叠视图，renderList 传 showProj=true）：
    // 平铺时项目会话混在根会话里，用短编号（Pj16）标识所属项目；项目文件夹视图已有文件夹名，不重复显示。
    const projTag = showProj && s.projectScope === 'project' && s.projectLabel
      ? `<span class="w-tag" title="${esc(s.projectLabel)}">${esc(projIdOf(s.projectLabel))}</span>` : ''
    // 2026-09-26 行操作入口 = 右键（桌面）/ 长按（触屏）唤出浮窗，三点按钮已删除（见 openRowMenu）
    // 置顶标记只在调用方显式要求时渲染（work 侧栏传 true）——chat 侧栏即使同一会话已置顶也不出图钉
    const pinIco = showPin && isPinned(hashOf(s)) ? `<span class="pin-ico" title="已置顶">${I.dshPin}</span>` : ''
    return `<button class="sess-item${on ? ' on' : ''}" data-hash="${esc(hashOf(s))}" title="${esc(s.file)}">
      <span class="dot${dotCls}"></span>${pinIco}<span class="title">${esc(s.title)}</span>${projTag}</button>`
  }

  // ---------- 真触屏判定（2026-09-05）：iPadOS Safari 桌面模式报 hover:hover+pointer:fine（与 macOS
  // 全同），CSS @media 骗不过 → 「hover 才显」规则（folder-add 等）在 iPad 上生效，
  // 触发 iOS「hover 改变布局 → 首击只应用 hover 吞 click」双击（笔按钮实测首击选中二击才跳转）。
  // 判定 = hover:none（手机）或 MacIntel+多点触控（iPad，与 deviceHint 同式）→ body.touch，
  // CSS 对触屏恒显这些元素（见 styles.css body.touch 段），hover 展开同步禁用。
  const IS_TOUCH_DEVICE =
    matchMedia('(hover: none)').matches ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  if (IS_TOUCH_DEVICE) document.body.classList.add('touch')

  // ---------- 行标题展开：桌面横向延展 / 触屏长按换行（2026-10-21）----------
  // 桌面 hover = body 下挂一份 fixed 克隆（.row-peek，pointer-events:none）：真实行始终留在列表流中，
  // 滚动链不被破坏（2026-10-19 fixed 真行导致 iPad 侧栏滑不动的根因）；克隆按 max-content 向右延展，
  // 长标题/长路径不再是「向下换行把后面的行推走」（用户待办：水平延展，而不是向下拓宽）。
  // 触屏长按仍用 .expanded 换行（无 hover，浮窗与展开同生同灭）；会话行与文件树行（.wk-row）共用本层。
  // 判据按**事件指针类型**而非设备（2026-10-21 返修）：iPad 桌面模式谎报 hover:hover，但接了触控板/鼠标时
  // pointerType='mouse' 真实有悬停，旧 IS_TOUCH_DEVICE 一刀切会让这类设备退回垂直换行（实报截图正是它）；
  // 手指触控（'touch'）没有 hover：**点击/长按该行时也横向延展**（2026-10-21 用户定案：
  // iPad 点 tab 拓宽、电脑鼠标悬浮拓宽），同样只出克隆、行高不变。
  let lastPointerType = 'mouse'
  const canPeek = () => lastPointerType !== 'touch'
  // 触屏点击后的延展锚：行点击常触发导航/列表重建（克隆随旧节点清掉），重建后按 (sel,dataset 键,值) 找回并重开。
  let peekPin = null
  let peekEl = null
  let peekSrc = null
  function peekClear() {
    if (peekEl) { peekEl.remove(); peekEl = null }
    peekSrc = null
  }
  function peekStart(el) {
    // 高度不变量：克隆按原行矩形落位、标题恒单行（.row-peek .title nowrap），行高与列表流都不变。
    // 是否允许由调用方决定（hover 绑 pointerType；长按菜单直调 force）。
    if (!el || peekSrc === el) return
    peekClear()
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return
    const c = el.cloneNode(true)
    c.classList.add('row-peek')
    c.removeAttribute('id')
    c.setAttribute('aria-hidden', 'true')
    c.style.left = Math.round(r.left) + 'px'
    c.style.top = Math.round(r.top) + 'px'
    c.style.height = Math.round(r.height) + 'px'
    c.style.minWidth = Math.round(r.width) + 'px'
    c.style.maxWidth = Math.max(120, window.innerWidth - r.left - 8) + 'px'
    document.body.appendChild(c)
    peekEl = c
    peekSrc = el
  }
  // 行的稳定标识（触屏重开后认回同一行）：会话 hash / 文件 wkfile / 目录 wkdir。
  function peekPinOf(el, sel) {
    for (const k of ['hash', 'wkfile', 'wkdir']) {
      if (typeof el.dataset[k] === 'string' && el.dataset[k]) return { sel, k, v: el.dataset[k] }
    }
    return null
  }
  function peekPinRestore(root) {
    if (!peekPin || !root) return false
    const el = [...root.querySelectorAll(peekPin.sel)].find((x) => x.dataset[peekPin.k] === peekPin.v)
    if (!el) return false
    peekStart(el)
    return true
  }
  function bindRowPeek(root, sel) {
    if (!root || !sel) return
    root.querySelectorAll(sel).forEach((el) => {
      el.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') peekStart(el) })
      el.addEventListener('pointerleave', peekClear)
      // 触屏点击/长按：按下即拓宽（click 在导航重建之后才到，那时旧节点已脱离文档，故落在 pointerdown）。
      el.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch') return
        lastPointerType = 'touch'
        peekPin = peekPinOf(el, sel)
        peekStart(el)
      })
    })
  }
  let expandedEl = null
  let reLiftHash = null // 行点击触发的导航：renderRecent 重建后按 hash 重新展开被点行（用后即清）
  let mouseXY = null // 最近光标落点：列表重建后按落点恢复 hover 展开（页面加载前 null 不误开）
  function expandClear() {
    if (expandedEl) { expandedEl.classList.remove('expanded'); expandedEl = null }
  }
  function expandStart(el) {
    if (!el || !el.classList.contains('sess-item') || expandedEl === el) return
    expandClear()
    el.classList.add('expanded')
    expandedEl = el
  }
  document.addEventListener('pointermove', (e) => {
    mouseXY = [e.clientX, e.clientY]
    lastPointerType = e.pointerType || 'mouse'
  }, { passive: true, capture: true })
  // 触屏点空白/点别的行 = 收起上一枚延展（无 pointerleave 可依赖）；点在当前行上则保留给行自己的 pointerdown。
  document.addEventListener('pointerdown', (e) => {
    lastPointerType = e.pointerType || 'mouse'
    if (e.pointerType !== 'touch') { peekPin = null; return }
    if (peekPin && e.target.closest && e.target.closest(peekPin.sel)) return
    peekPin = null
    peekClear()
  }, { capture: true })
  // 滚轮到达列表 = 菜单外交互（浮窗 fixed 会漂离锚点），一并收口；展开态本身不随滚动还原。
  // 监听按行所在滚动容器挂，每容器只挂一次（重复挂 = 同一次滚轮触发多遍）。
  const expandBoundRoots = new WeakSet()
  function expandBindRoot(root) {
    if (!root || expandBoundRoots.has(root)) return
    expandBoundRoots.add(root)
    root.addEventListener('wheel', () => { peekClear(); if (rowMenuPop) closeRowMenu() }, { passive: false })
  }
  // expandRoot = 行所在的滚动容器（chat = #recent-body；work 下沉区 = #wk-body）。
  function bindSessExpand(root, expandRoot) {
    // 逐事件按 pointerType 分流（见上）：触控板/鼠标 → peek，手指长按 → openRowMenu 直调 expandStart。
    bindRowPeek(root, '.sess-item')
    expandBindRoot(expandRoot || bodyEl)
  }

  // ---------- 会话行协议（2026-10-15 统一 Chat/Work 会话行生命周期）----------
  // `.sess-item` 在 chat 侧栏（#recent-body / 项目管理卡列表）与 work 下沉区（#wk-body 里的 .wk-chats）
  // 各渲一份，**行 HTML 本来就是同一份实现（itemHtml）**——行为也必须同源。回归根因：work 侧只在
  // #wk-body 容器上委托了一段「改 wkMainTab/wkAssist + navigate」，既没接本文件的点击语义（reLiftHash
  // 恢复展开 / 移动端收侧栏），也没接 hover 展开 ⇒ 同一行两模式表现分叉（展开不一致 / 选中滞后 / 点了
  // 像没反应）。协议两个出口，谁拥有行谁接线：
  //   activateSession(hash, { source })  —— 会话激活唯一口
  //   bindSessionRows(root, { source })  —— 行行为唯一接线口（点击 → activateSession + hover 展开）
  // 接线点 = 行节点**新建后**（innerHTML 重写分支里）：chat 侧 renderList/renderProject（mgr.js）/
  // work 侧 renderWorkBody（work-files.js）。

  // 会话激活唯一口。source='work' 才落 work 页面态（顶栏胶囊 + 聊天栏顶上来）——那是「在下沉区点行」
  // 的语义；chat 侧栏点行不该改 work 布局。导航 / 移动端收侧栏两模式一致。
  function activateSession(hash, opts = {}) {
    if (!hash) return
    if (opts.source === 'work') {
      wkEnsureTab(hash) // 显式打开一个会话 = 顶栏占一枚胶囊
      // 点会话 = 明确要看这个会话：聊天 tab 顶上来（否则文件 tab 占着格，看着像「点了没反应」）
      state.wkMainTab = 'chat'
      state.wkAssist = true
      state.wkAssistMode = 'side'
    }
    // 已在该会话内：不 navigate（route→ 重建整列换节点，展开态随旧节点消亡，需按 hash 恢复）
    if (hash !== state.currentHash) {
      reLiftHash = hash // 重建后恢复被点行展开（新节点 :hover 不恢复）
      navigate('#/' + encodeURIComponent(hash))
    }
    if (opts.source === 'work') { applyPanes(); saveWork() } // 新胶囊 + active 落地
    if (isMobile()) setPanel(false)
  }

  // 行行为接线（点击 + hover 展开）。**只在行节点新建后调用**：节点未变时重复调用会让同一节点累积
  // 多份监听。opts.root = 行所在滚动容器（滚轮关闭行浮窗的监听挂它）；缺省 #recent-body。
  function bindSessionRows(root, opts = {}) {
    if (!root) return
    root.querySelectorAll('.sess-item').forEach((b) =>
      b.addEventListener('click', () => activateSession(b.dataset.hash, opts)))
    bindSessExpand(root, opts.root || bodyEl)
  }

  // ---------- 行操作浮窗（2026-09-26：三点按钮删除，改右键 / 长按唤出；2026-09-27 泛化为注册式）----------
  // 两个入口：桌面右键（contextmenu）、触屏长按（pointerdown 计时 480ms）。浮窗是 document.body 下
  // 独立 fixed 卡片（脱出 #recent-body / #wk-body 这类 overflow 裁剪容器），落位在被操作行近旁
  // （长按：行左下）/ 指针处（右键），越界翻折 + clamp 回视口。长按同时展开该行标题（触屏不绑
  // hover，故 expandStart 直调）——展开与浮窗同生同灭：点两者之外任意空白（mousedown / pointerdown）→
  // closeRowMenu 一并还原。菜单不切换当前选中项：操作对象由行的 dataset 显式携带。
  //
  // 泛化（2026-09-27）：本模块只负责「唤出手势 + 浮窗 DOM + 会话行展开联动」，不认具体是哪种行。
  // 谁拥有行谁注册：registerRowMenu({ sel, key, items, pick })，items(el) 返回菜单项
  // [{a,icon,label,danger?}]（空数组 = 该行无菜单，右键保留浏览器默认），pick(a, el) 执行动作。
  const rowMenuSources = []
  function registerRowMenu(src) { rowMenuSources.push(src) }
  function rowMenuHit(target) {
    for (const src of rowMenuSources) {
      const el = target.closest(src.sel)
      if (el) return { src, el }
    }
    return null
  }
  let rowMenuPop = null
  let rowMenuTouch = false // 长按开启：展开由本浮窗负责，关闭时必须显式收起（触屏无 mouseleave 自然回位）
  let rowMenuGuard = 0 // 长按抬手会补发 mousedown，短时守卫防「刚弹出就被自己关掉」
  let rowMenuSrc = null // 当前浮窗的行源 + 行标识：列表重建后按此恢复展开（见 reliftRowMenu）
  let rowMenuKey = null
  function openRowMenu(hit, x, y, rowEl) {
    closeRowMenu()
    peekClear() // 延展克隆与浮窗同锚点，先收 clone 再弹菜单
    if (!hit) return
    const items = hit.src.items(hit.el)
    if (!items || !items.length) return
    rowMenuTouch = !!rowEl
    rowMenuGuard = Date.now() + 600
    const pop = document.createElement('div')
    pop.className = 'row-menu-pop'
    pop.innerHTML = items
      .map(
        (it) =>
          `<button type="button" class="rm-item${it.danger ? ' rm-danger' : ''}" data-a="${esc(it.a)}">` +
          `${it.icon || ''}<span>${esc(it.label)}</span></button>`,
      )
      .join('')
    // 宿主 = 行所属的 #sidebar（行属于侧栏时），否则 document.body（如 #bubble-pop 里的会话行）。
    // 挂在 #sidebar 内是本浮窗与「侧栏悬停预览」共存的前提：#sidebar 的 mouseleave 是收起侧栏的
    // 唯一入口，浮窗若是 body 子节点，指针从行移到浮窗上就等于「离开侧栏」→ 侧栏连带浮窗一起收。
    // .row-menu-pop 是 position:fixed，无 transform 祖先时仍以视口定位，故宿主变更不影响落点。
    const host = hit.el.closest('#sidebar') || document.body
    host.appendChild(pop)
    // 期望落点 = 行左下（长按）/ 指针右下（右键），越界翻折回视口内
    const r = rowEl ? rowEl.getBoundingClientRect() : null
    let lx = r ? r.left + 8 : x
    let ly = r ? r.bottom + 4 : y
    const w = pop.offsetWidth
    const h = pop.offsetHeight
    // 越界下限取**可视**视口底（键盘上沿）：innerHeight 是布局视口，键盘在场不缩，按它 clamp 会落进键盘后。
    const vv = window.visualViewport
    const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight
    lx = Math.max(8, Math.min(lx, window.innerWidth - w - 8))
    ly = Math.max(8, Math.min(ly, viewBottom - h - 8))
    pop.style.left = Math.round(lx) + 'px'
    pop.style.top = Math.round(ly) + 'px'
    pop.addEventListener('click', (e) => {
      const b = e.target.closest('.rm-item')
      if (!b) return
      const src = hit.src
      closeRowMenu()
      src.pick(b.dataset.a, hit.el)
    })
    pop.addEventListener('contextmenu', (e) => e.preventDefault()) // 浮窗上右键不弹浏览器菜单
    rowMenuPop = pop
    rowMenuSrc = hit.src
    rowMenuKey = hit.src.key(hit.el)
    // 长按同样只做横向延展（高度不变）：expandStart 只留底色高亮，标题不换行（CSS 已改），
    // 完整标题由 peek 克隆单行展示；菜单关闭时一并收。
    if (rowEl) { expandStart(rowEl); peekStart(rowEl) }
  }
  function closeRowMenu() {
    if (rowMenuPop) { rowMenuPop.remove(); rowMenuPop = null }
    // 展开还原：桌面右键场景鼠标仍在该行则保留展开（几何判定而非 :hover——鼠标未动时 :hover 判定不稳）。
    if (!rowMenuTouch && expandedEl && mouseXY) {
      const r = expandedEl.getBoundingClientRect()
      if (mouseXY[0] >= r.left && mouseXY[0] <= r.right && mouseXY[1] >= r.top && mouseXY[1] <= r.bottom) return
    }
    expandClear()
    if (rowMenuTouch) peekClear() // 长按的延展与浮窗同生同灭（桌面 hover 克隆仍由 mouseleave 管理）
  }
  // 列表重建后恢复：浮窗锚定的旧节点已被换掉（innerHTML 重渲），按 (行源, 行标识) 找新节点补展开。
  // 由各列表的渲染出口在重渲后调用（recent.js renderRecent / work.js renderWorkBody）。
  function reliftRowMenu() {
    if (!rowMenuPop || !rowMenuTouch || !rowMenuSrc || rowMenuKey == null) return
    const el = [...document.querySelectorAll(rowMenuSrc.sel)].find((x) => rowMenuSrc.key(x) === rowMenuKey)
    if (el) { expandStart(el); peekStart(el) }
  }
  // 桌面右键：只认已注册的行（其它区域保留浏览器默认菜单）
  document.addEventListener('contextmenu', (e) => {
    const hit = rowMenuHit(e.target)
    if (!hit || !hit.src.items(hit.el).length) return
    e.preventDefault()
    openRowMenu(hit, e.clientX, e.clientY)
  })
  // 触屏长按：480ms 未移动即触发（展开 + 浮窗）；移动 >8px / 抬手 / 取消即作废。长按后抬手若
  // 补发 click（误导航），在 capture 阶段吞掉——它先于元素自身的 click 处理器到达。
  let lpTimer = 0
  let lpFired = false
  let lpHit = null
  let lpXY = null
  const lpCancel = () => { clearTimeout(lpTimer); lpTimer = 0; lpHit = null }
  document.addEventListener('pointerdown', (e) => {
    lpFired = false
    // 浮窗开着时，落在浮窗与行之外的按下 = 明确的关闭意图，即刻收口（触屏抬手补发的 mousedown
    // 没有配套的新 pointerdown，故不受此支路影响，只受 rowMenuGuard 约束）
    if (rowMenuPop && !rowMenuPop.contains(e.target) && !rowMenuHit(e.target)) { closeRowMenu(); return }
    if (e.pointerType !== 'touch') return
    const hit = rowMenuHit(e.target)
    if (!hit || !hit.src.items(hit.el).length) return
    lpHit = hit
    lpXY = [e.clientX, e.clientY]
    clearTimeout(lpTimer)
    lpTimer = setTimeout(() => {
      lpTimer = 0
      const h = lpHit
      if (!h) return
      lpFired = true
      // 480ms 悬停期内列表可能整列重建（refreshList 按活动流签名随时重渲，处理中 2-3 次/秒），
      // 此时捕获的节点已成孤儿：getBoundingClientRect 归零 ⇒ 落点被 clamp 到视口左上角。
      // 不变量「浮窗与展开锚定现役节点」——按 (行源, 行标识) 重解析；行已消失（删除/换视图）则放弃。
      let el = h.el
      if (!el.isConnected) {
        const key = h.src.key(el)
        if (key == null) return
        el = [...document.querySelectorAll(h.src.sel)].find((x) => h.src.key(x) === key) || null
        if (!el) return
      }
      openRowMenu({ src: h.src, el }, 0, 0, el)
    }, 480)
  }, { passive: true })
  document.addEventListener('pointermove', (e) => {
    if (!lpTimer || !lpXY) return
    if (Math.abs(e.clientX - lpXY[0]) > 8 || Math.abs(e.clientY - lpXY[1]) > 8) lpCancel()
  }, { passive: true })
  document.addEventListener('pointerup', () => {
    lpCancel()
    // 长按抬手发生在守卫之后（长按更久）时续期：iOS 抬手会补发 mousedown，不得关掉刚弹出的浮窗
    if (rowMenuPop && rowMenuTouch) rowMenuGuard = Date.now() + 600
  }, { passive: true })
  document.addEventListener('pointercancel', lpCancel, { passive: true })
  document.addEventListener('click', (e) => {
    if (!lpFired) return
    lpFired = false
    e.stopPropagation()
    e.preventDefault()
  }, true)
  // 点空白（浮窗 / 行之外）→ 浮窗与展开一并消失
  document.addEventListener('mousedown', (e) => {
    if (!rowMenuPop || Date.now() < rowMenuGuard) return
    if (!rowMenuPop.contains(e.target)) closeRowMenu()
  })
  // 列表滚动 / 窗口尺寸变化：浮窗 fixed 会漂离锚点，直接收（与展开收起同一时机）
  window.addEventListener('scroll', () => { peekPin = null; peekClear(); if (rowMenuPop) closeRowMenu() }, { passive: true, capture: true })
  window.addEventListener('resize', () => { peekPin = null; peekClear(); if (rowMenuPop) closeRowMenu() })

  // 会话行菜单「项 + 动作」唯一实现（2026-10-25）：凡呈现同一会话的行（侧栏 `.sess-item`、
  // work 顶栏会话胶囊 `[data-wkchat]`）共用本 spec，禁止各写一套菜单。
  //   getHash(el)  = 该行对应的会话 hash
  //   withPin(el)  = 该行语境是否提供置顶（仅 work：侧栏行宿主 #wk-body / 顶栏胶囊）
  //   onRename     = 可选，重命名成功后的外部补渲染（如顶栏胶囊标题 renderTopbar）
  // 会话已从列表消失时 items 返回空（不弹菜单）。
  function sessionRowMenuSpec(getHash, withPin, onRename) {
    return {
      items: (el) => {
        const hash = getHash(el)
        if (!hash || !ALL.find((v) => hashOf(v) === hash)) return []
        const pinItems = withPin(el)
          ? [{ a: 'pin', icon: I.dshPin, label: isPinned(hash) ? '取消置顶' : '置顶' }]
          : []
        return [
          ...pinItems,
          { a: 'rename', icon: I.dshEdit, label: '重命名' },
          { a: 'close', icon: I.dshStop, label: '关闭会话', danger: true },
        ]
      },
      pick: (a, el) => {
        const hash = getHash(el)
        if (a === 'pin') togglePin(hash)
        else if (a === 'rename') openSessionRename(hash, onRename)
        else closeSession(hash)
      },
    }
  }
  registerRowMenu({
    sel: '.sess-item',
    key: (el) => el.dataset.hash || null,
    ...sessionRowMenuSpec((el) => el.dataset.hash, (el) => !!el.closest('#wk-body')),
  })

  // ---------- 关闭会话（2026-09-04 三点浮窗新增：语义 = CLI 两次 Ctrl+C）----------
  // 第一击 interrupt（网关按 sessionId 精确路由 → CLI onCancel：回合进行中即打断，空闲为 no-op）；
  // 第二击 POST /gateway/wsession/stop（网关统一优雅停 2026-09-08：shutdown → CLI exit 0 →
  // WT 自动收 tab，3s 树杀兜底；web spawn/终端直开两会话形态同协议）。转录保留磁盘，
  // 侧栏 tab 不消失，仅状态点熄灭。
  async function closeSession(hash) {
    const s = ALL.find((x) => hashOf(x) === hash)
    if (!s) return toast('未找到该会话')
    if (!s.state) return toast('会话未在运行，无需关闭')
    // 第一击 Ctrl+C：先打断当前回合（若空闲，CLI 侧判活未命中本就是 no-op）
    if (gws && gws.readyState === 1) gws.send(JSON.stringify({ type: 'interrupt', sessionId: hash }))
    // 第二击 Ctrl+C：关停会话进程（网关对 web/终端会话统一处理）
    try {
      const res = await fetch(apiUrl('/gateway/wsession/stop'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: hash }),
      })
      const body = await res.json()
      if (!res.ok || !body.ok) {
        toast('会话进程未找到，可能已自行退出')
        return
      }
      s.state = null
      renderRecent()
      // 2026-09-06 收口二轮：关的是当前打开会话 → 立即权威重渲（force 跳过 sig 判同），
      // closeSeg 按 state=null 收口「正在处理/正在思考」，不再等下次刷新。
      if (hash === state.currentHash) refreshSession(true)
      toast('会话已关闭')
    } catch (e) {
      toast('关闭失败：' + (e.message || e))
    }
  }

  // ---------- 重命名弹窗（2026-08-24 DSH 侧栏 rename dialog 移植；2026-09-27 泛化为通用入口）----------
  // 弹窗 DOM 在 index.html（#rename-modal，复用 risk-modal 的 mask/dialog 样式骨架）。本模块只管
  // 表单壳（标题/占位/初值/校验/错误回显），提交语义由调用方以 onSubmit 注入——会话重命名走
  // POST /gateway/session/rename（网关 append custom-title，已停止会话同样生效），文件重命名走
  // POST /gateway/file/rename（work.js 注册），两者共用同一对话框实例，不各建一套弹窗。
  let renameTarget = null // { heading, placeholder, okText, onSubmit }
  const renameModal = $('rename-modal')
  const renameInput = $('rename-input')
  const renameErr = $('rename-error')
  const renameTitle = renameModal.querySelector('.title')
  const renameOk = $('rename-ok')
  function openRenameDialog(opt) {
    renameTarget = opt
    renameTitle.textContent = opt.heading || '重命名'
    renameInput.placeholder = opt.placeholder || '输入新名称'
    renameOk.textContent = opt.okText || '重命名'
    renameInput.value = opt.value || ''
    renameErr.hidden = true
    renameModal.hidden = false
    renameInput.focus()
    renameInput.select()
  }
  function closeRenameDialog() {
    if (!renameModal.hidden) renameModal.hidden = true
    renameTarget = null
  }
  async function confirmRename() {
    if (!renameTarget) return
    let value = renameInput.value.trim()
    if (!value) {
      renameErr.textContent = '名称不能为空'
      renameErr.hidden = false
      return
    }
    try {
      await renameTarget.onSubmit(value)
      closeRenameDialog()
    } catch (e) {
      renameErr.textContent = e.message || String(e)
      renameErr.hidden = false
    }
  }
  // 会话重命名：查不到（列表已刷新掉）才报错；提交成功同步内存标题并重渲列表。
  // onDone（可选）= 本模块之外的标题消费方补渲染（如 work 顶栏胶囊，work-mount.js 传 renderTopbar）。
  function openSessionRename(hash, onDone) {
    const s = ALL.find((x) => hashOf(x) === hash)
    if (!s) return toast('未找到该会话')
    openRenameDialog({
      heading: '重命名会话',
      placeholder: '输入新标题',
      okText: '重命名',
      value: s.title || '',
      onSubmit: async (title) => {
        const res = await fetch(apiUrl('/gateway/session/rename'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: s.id, title }),
        })
        const body = await res.json()
        if (!res.ok || !body.ok) throw new Error(body.error || '重命名失败')
        s.title = title
        renderRecent()
        if (onDone) onDone()
        toast('已重命名为「' + title + '」')
      },
    })
  }
  $('rename-cancel').addEventListener('click', closeRenameDialog)
  $('rename-ok').addEventListener('click', confirmRename)
  $('rename-modal').querySelector('.close').addEventListener('click', closeRenameDialog)
  renameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmRename() }
    if (e.key === 'Escape') { e.preventDefault(); closeRenameDialog() }
  })
  // 点遮罩关闭（与 risk-modal 一致：对话框外判定）
  $('rename-modal').addEventListener('mousedown', (e) => {
    if (!renameModal.hidden && !e.target.closest('.dialog')) closeRenameDialog()
  })

  // 新建 web 会话（2026-08-24 改造：本地可见交互 CLI 窗口，替代 headless 子进程）。
  // 触发方式 = 首页空态输入第一条消息（gwSend 空态分支调用），不再有「新建独立会话」按钮。
  // 网关 spawn 本地可见交互 REPL 窗口（--session-id 预分配）→ CLI 连 /clients 注册 →
  // 网关等注册完成才返回 → 首条消息经 cliClients 精确路由注入 REPL（与本地打字同路径）。
  // 展示走 conversationDisplay 上报 + jsonl 落盘 + SSE 列表刷新（与 CLI 会话一致）。
  // 2026-08-24 防双 spawn：web 会话创建中标志（POST /gateway/wsession 等 CLI 注册最长 20s），
  // 创建期间 gwSend 空态分支再次发送直接忽略，杜绝「每发一条新建一个会话」。
  let webCreating = false
  // 首条消息事务（2026-09-06 根治三态）：值=进行中事务的会话 hash，''=无事务。语义唯一——
  // 「该会话首条乐观 DOM（气泡+proc 折叠）是权威」：renderSession/refreshSession 空 fetch 不洗盘、
  // queue-dock 不渲染（注入中消息不降级「排队中」形态）、真实数据落盘即收口销毁（渲染权威接管）。
  // 旧 pendingFirstSend（pre/hash 双字段+三处守卫+DOM 在场补挂）状态发散已整删：三态=状态源过多
  // +同步 navigate 时序（hash 回填前移 newWebSession 内）+DOM 被当状态存储三者叠加，详见各守卫处。
  let firstSendHash = ''
  // 分层治理 4C（2026-10-10）：engine/live.js 的读取口（写侧仍是尾部 setFirstSendHash）——每次现读，
  // 调用方严禁缓存返回值。
  function getFirstSendHash() { return firstSendHash }
  async function newWebSession(projectLabel, model) {
    if (needToken()) return toast('请先完成 token 验证')
    if (webCreating) return null
    webCreating = true
    toast(projectLabel ? `正在 ${projectLabel} 打开本地 CLI 窗口…` : '正在全局根打开本地 CLI 窗口…')
    try {
      // 2026-10-13 待办 12：首页选的模型随 wsession body.model 下发（池内全名），网关 spawn 时
      // 落 --model 启动参数——CLI 启动即固化会话覆盖，首轮请求即用所选模型（不再事后补投）。
      const body = {}
      if (projectLabel) body.project = projectLabel
      if (model) body.model = model
      const res = await fetch(apiUrl('/gateway/wsession'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await res.json()
      if (!d.hash || !d.id) throw new Error(d.error || 'bad response')
      // 首条消息事务 hash 回填必须在 navigate 之前：navigate 同步 route → renderSession，
      // 守卫（firstSendHash === hash）此刻起生效（回填放 await 续体=跑在 renderSession 之后，
      // 三态截图第②态「加载中…洗掉乐观 DOM」的时序根因）
      if (firstSendHash === '') firstSendHash = d.hash
      // 合成列表条目：子进程刚起 jsonl 可能未落盘，先插入列表保证可导航；SSE 刷新会用真实条目替换。
      // 2026-08-24 用户定案：未指定项目（笔/首页消息发送）→ 会话落全局根（@WrokSpace 散装区，
      // projectScope:'global'）；指定项目 → 该项目组（projectScope:'project'）。不再落启动服务器的项目根。
      const isGlobal = !projectLabel
      ALL.unshift({ id: d.id, file: d.hash + '.jsonl', title: '新会话', state: 'busy', updatedAt: Date.now(), createdAt: Date.now(), synthetic: true, projectScope: isGlobal ? 'global' : 'project', projectLabel: projectLabel || '', messageCount: 0 })
      renderRecent()
      navigate('#/' + encodeURIComponent(d.hash))
      if (isMobile()) setPanel(false)
      return d
    } catch (e) {
      toast('创建独立会话失败: ' + (e.message || e))
      return null
    } finally {
      webCreating = false
    }
  }

  function renderRecent() {
    // 重建前快照展开行（hash + 当前视口矩形）：重建后新节点没有 .expanded，鼠标未动不会重触发
    // mouseenter；且收起后列表变短，光标可能落到相邻行。按下标矩形认回原行（行菜单开着则按 hash 重开）。
    const liftEl = peekSrc || expandedEl
    const prevExpand = liftEl && liftEl.dataset.hash
      ? { hash: liftEl.dataset.hash, rect: liftEl.getBoundingClientRect() }
      : null
    expandClear() // SSE/导航重建列表：展开态随旧节点消亡，先清引用（末尾按线索恢复）
    peekClear()
    // 记录刷新前的会话条目 key（会话哈希 / 项目文件夹名），仅给「新增条目」播放入场动画，
    // 已有条目静默保留，避免每次 SSE 刷新整列重播淡入
    const prevKeys = new Set()
    bodyEl.querySelectorAll('.sess-item, .folder').forEach((el) => {
      const k = el.dataset.hash || el.dataset.f
      if (k) prevKeys.add(k)
    })
    // 保留展开的项目文件夹 + 侧栏滚动位置（2026-08-16：主区导航进管理视图/预览走 route→renderRecent，
    // 重建列表时不重置侧栏状态，避免展开文件夹收起、滚动跳顶）
    const openF = [...bodyEl.querySelectorAll('.folder.open')].map((f) => f.dataset.f)
    const prevTop = bodyEl.scrollTop
    bodyEl.innerHTML = ''
    modeTabsEl.classList.toggle('hidden', state.mode !== 'project')
    recentLabel.textContent = state.mode === 'list' ? '最近' : '最近对话'
    if (state.mode === 'list') renderList()
    else renderProject()
    bodyEl.querySelectorAll('.sess-item, .folder').forEach((el) => {
      const k = el.dataset.hash || el.dataset.f
      if (k && !prevKeys.has(k)) el.classList.add('item-in')
    })
    if (openF.length) {
      for (const f of bodyEl.querySelectorAll('.folder')) {
        if (openF.includes(f.dataset.f)) f.classList.add('open')
      }
    }
    if (prevTop) bodyEl.scrollTop = prevTop
    reliftAfterRebuild(bodyEl, prevExpand)
    renderBubble()
    renderSearch()
  }

  // 列表重建后的统一恢复出口（chat 侧栏 renderRecent / work 下沉区 renderWorkBody 共用；root = 该列表
  // 的滚动容器，prevExpand = 重建前的展开快照，仅 chat 侧提供）。四条线索：
  // ① 触屏长按菜单开着 → 按菜单行标识重新展开（浮窗挂 body 下不受重建影响，行节点需重挂）；
  // ② 触屏点击钉住的延展（peekPin）→ 按 (sel, dataset 键, 值) 找回新节点重开克隆（点击先于 click 导航，
  //    旧节点在重建时已脱离文档，不能在 click 里补）；
  // ③ 行点击触发的导航（reLiftHash）→ 展开被点行——重建后新节点 :hover 不恢复（Chrome 实测）；
  // ④ 纯 hover 重建（无线索）：refreshList 按活动流签名随时整列重建（会话处理中=高频），
  //    光标所在行同样收起了，按最近光标落点恢复。恢复一律直接终态（无动画）。
  function reliftAfterRebuild(root, prevExpand) {
    if (rowMenuPop && rowMenuTouch) { reliftRowMenu(); return }
    if (peekPin && peekPinRestore(root)) return
    if (reLiftHash) {
      const el = [...root.querySelectorAll('.sess-item')].find((x) => x.dataset.hash === reLiftHash)
      reLiftHash = null
      if (el) peekFocus(el)
      return
    }
    if (!mouseXY) return
    // 先按重建前展开矩形认原行：重建后行已收起、列表变短，elementFromPoint 可能落到相邻行。
    if (prevExpand &&
      mouseXY[0] >= prevExpand.rect.left && mouseXY[0] <= prevExpand.rect.right &&
      mouseXY[1] >= prevExpand.rect.top && mouseXY[1] <= prevExpand.rect.bottom) {
      const el = [...root.querySelectorAll('.sess-item')].find((x) => x.dataset.hash === prevExpand.hash)
      if (el) { peekFocus(el); return }
    }
    const hit = document.elementFromPoint(mouseXY[0], mouseXY[1])?.closest('.sess-item')
    if (hit && hit.dataset.hash && root.contains(hit)) peekFocus(hit)
  }
  // 恢复出口：指针型操作走横向延展 clone（与 hover 同一终态）；手指触控只补底色高亮（行高不动）
  function peekFocus(el) { if (canPeek()) peekStart(el); else expandStart(el) }

  // 管理视图（插件/技能预览，Codex 风格）：渲染到主聊天区（侧栏会话列表保持不变）。
  // 插件与技能预览都从「插件」入口进入，顶部插件/技能切换；数据源 = 网关 /gateway/plugins 实时扫描。
  // 重渲保留滚动位置（切换 kind/cat 时内容高度变化，避免 scrollTop 被重置成可见跳动）。
// —— 跨模块写入口（切割脚本生成）——
export function setFirstSendHash(v) { firstSendHash = v }

export {
  IS_TOUCH_DEVICE,
  activateSession,
  bindRowPeek,
  bindSessionRows,
  bindSessExpand,
  closeRenameDialog,
  closeRowMenu,
  closeSession,
  confirmRename,
  expandClear,
  expandStart,
  firstSendHash,
  isPinned,
  itemHtml,
  mouseXY,
  newWebSession,
  openRenameDialog,
  openSessionRename,
  peekClear,
  projIdOf,
  registerRowMenu,
  reLiftHash,
  reliftAfterRebuild,
  reliftRowMenu,
  renameErr,
  renameInput,
  renameModal,
  renameTarget,
  renderRecent,
  rowMenuPop,
  sessionRowMenuSpec,
  setPanel,
  togglePin,
  webCreating,
}
