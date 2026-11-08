// 右栏页态内容补挂 + 侧栏（项目选择/项目列表/文件树/自动对账/数据补齐）与其渲染。（拆自 sidebar/work.js，纯搬迁零行为变更；符号经单 IIFE 共享作用域可见）
import { sessionInWork } from '../../core/util.js'
import { createProjectPicker, projectPickerGroups } from '../../feature/project-picker/project-picker.js'
import { bindRowPeek, isPinned, peekClear } from '../recent.js'
import { cmtInvalidate, cmtLoad } from '../../feature/comment/comment-data.js'
import { cmtRender } from '../../feature/comment/comment-panel.js'
/* @module sidebar/work/work-files.js */

  // ---------- 外部卡申报补拉 ----------
  // 与 ensureWork 的树/编辑区补拉同源。预览帧在场时由 renderWorkPreview → mountPreview → syncExtCards
  // 顺带拉；预览帧不在场（宿主 pane 工具态 / 右栏关着）时在此补齐——否则刷新后外部卡 tab 缺失、
  // /manage/ext:… 直进无卡可解析（EXT 是内存表，只落缓存不落盘）。两门互补：帧在场判定 = wkFrameNeeded。
  function syncWorkExtCards() {
    if (state.workProj && !wkFrameNeeded()) syncExtCards(state.workProj)
  }

  function hideWkPops() {
    for (const id of ['wk-proj-pop', 'wk-new-pop']) {
      const el = $(id)
      if (el) el.hidden = true
    }
  }

  function setPane(k, on) {
    if (k === 'sidebar') {
      // 侧栏开合不走「至少保留一栏」判定——那是主区内容的约束，与侧栏无关。
      // pin = 主动打开，鼠标移出侧栏不自动收（悬停预览式收起只属左缘唤出）。行状态真源见 paneOn。
      setPanel(on, { pin: on })
      applyPanes()
      saveWork() // 两开关之一：归档进工作项目的槽
      return
    }
    if (k === 'workspace') {
      // 右栏开/关的**唯一 api**（顶栏「工具栏」胶囊直调此处，见 work-mount.js）：只管在场维，页态归
      // work-preview.js 的 setPvPane。省略 page ⇒ 保持当前页；关栏时 setPvPane 内部顺带回预览态
      // （不留「栏不在场却停在工具态」的悬空页态）。
      // 评论内容不随开关走：cmtLoad/cmtRender 在选项目（selectProject）与事后补拉（ensureWork）
      // 两处恒跑（原文标记也需要它），开关只管这一列的显隐。
      setPvPane(on)
      return
    }
    // 助手开关（浮层已不含助手行；只剩助手头部的 × 走到这里）：关掉后若下沉格再没有别的可显，
    // 由 applyPanes 的不变量兜底（强制留一栏 + toast）。
    if (k === 'assist') {
      state.wkAssist = on
      applyPanes()
      saveWork()
    }
  }

  // ---------- 侧栏渲染 ----------
  // 名字必须全局唯一：全部 web-src 模块体拼进同一个 IIFE 作用域，顶层同名声明会静默互相覆盖
  // （由 `probes/probe-web-module-scope.ts` 看住）。
  // 项目枚举已收口到 feature/project-picker 的 projectPickerGroups（底栏与 work 下拉同源）。
  // 项目列表 = findProjects 中 scope==='project' 的组（Pj 长期项目 + 根级时间戳任务区，一视同仁平铺）。
  // 工作区根「全局根 · 散装对话」不进这份列表（2026-10-30 用户定案：work 项目选择器只给项目，
  // 散装区不占一格；后端仍照旧产出该组，散装会话/笔新建/全局预览不受影响）。
  function wkProjGroups() {
    // 项目枚举只认 state.projects（后端 findProjects）。实现与底栏项目选择器同源：
    // feature/project-picker/project-picker.js 的 projectPickerGroups（唯一判据）。
    return projectPickerGroups()
  }

  // 项目选择器组件实例（与底栏 #proj-pop 同一实现，2026-11-06 同构）：差异只在本处注入——
  // 无「全局（默认）」行、选中 = state.workProj、选中后走 selectProject、打开前补拉项目列表。
  const wkPicker = createProjectPicker({
    pop: $('wk-proj-pop'),
    seat: $('wk-proj-seat'),
    allowGlobal: false,
    emptyText: '未发现项目，点 ⟳ 重试',
    getSelected: () => state.workProj || '',
    beforeOpen: async () => {
      hideWkPops()
      await ensureProjectList()
      renderWorkChrome()
    },
    beforeClose: () => hideWkPops(), // 关下拉同拍收起侧栏里其它浮层（原 seat 点击链语义）
    onPick: (label) => selectProject(label),
  })

  // 项目名 + 底部卡 + 下拉内容 = 同一份 state.projects 的同一次渲染（2026-09-25 修）。
  // 此前下拉内容由 renderWorkProjects 单独在「点开那一刻」渲染一次，而项目列表是 ensureWork 里
  // await loadSessions() 异步落地的——切到 work 后立刻点开就会渲染出 0 项，此后列表到了也不再更新
  // （底部卡显示「7 个项目」、下拉却是空的，就是这个错位）。合并为一条渲染路径后无处可漂移。
  function renderWorkChrome() {
    const lab = document.querySelector('#wk-proj-seat .wk-proj-label')
    if (lab) lab.textContent = state.workProj || '选择项目'
    const ft = $('wk-foot-text')
    if (ft) {
      const n = wkProjGroups().length
      ft.textContent = `${state.workProj || 'Floria'} · ${n} 个项目`
    }
    const seat = $('wk-proj-seat')
    if (seat) seat.classList.toggle('empty', !state.workProj)
    renderWorkProjects()
  }

  // 下拉内容 = 共享项目选择器组件（一张平铺列表：Pj 项目与根级时间戳项目不加分组标题，2026-10-30 定案）。
  function renderWorkProjects() {
    wkPicker.render()
  }

  // tab 行工具区：加号只在聊天 tab 出现（新建聊天）；文件 tab 的加号（新建文件/文件夹）待新建写接口
  // 定案后接入，届时同一按钮按 tab 分派。（原就地过滤 🔍 + #wk-find-row 已并入顶栏统一搜索，2026-10-08）
  function updateWkTools() {
    // tab 高亮唯一同步点（2026-10-21 待办）：state.wkTab 还会被切项目/启动恢复经 loadWorkSlot 改写，
    // 只在点击处理器里同步 class，恢复出来的「文件亮、内容却是聊天」就会错位。renderWorkBody 每次必经此处。
    // 插件页占下沉格时只亮「插件」，文件/聊天 tab 不亮（与 chat 侧栏 mgr-tabs 单态一致）
    const pluginsView = state.wkMainTab === 'plugins' && !!state.workProj // 判据同 wkShownTab
    document.querySelectorAll('.wk-tab').forEach((b) => {
      if (b.hasAttribute('data-wkplugins')) { b.classList.toggle('on', pluginsView); return }
      b.classList.toggle('on', !pluginsView && b.dataset.wktab === state.wkTab)
    })
    const nb = $('wk-new')
    const isChat = state.wkTab === 'chat'
    if (nb) nb.title = isChat ? '新建聊天' : '新建文件'
    const pop = $('wk-new-pop')
    if (pop && state.wkTab !== 'files') pop.hidden = true // 文件菜单只在文件 tab 有意义，切走即收
  }

  // 侧栏体的唯一渲染出口：HTML 全量算好再比对写入。比对是自动对账的必要条件——每 5s 一次无脑重写
  // innerHTML 会让文件树的滚动位置与展开动画反复归零（内容没变就没有重写的理由）。
  function renderWorkBody() {
    const body = $('wk-body')
    if (!body) return
    updateWkTools()
    const html = wkBodyHtml()
    const rebuilt = body.innerHTML !== html
    if (rebuilt) {
      // 重建前先收起展开态：旧行节点随 innerHTML 消亡，引用必须清掉（与 renderRecent 同口径）
      expandClear()
      peekClear()
      body.innerHTML = html
      // 新建的会话行接入统一行协议（点击 → activateSession({source:'work'}) + hover 横向延展），
      // 实现在 recent.js；**只在重建分支接线**——未重写时节点未变，重复接线会让同一节点累积多份监听。
      // 滚动容器 #wk-body 一并传入（滚轮关闭行浮窗的监听挂它）。文件树行同绑延展（同一层，不另起一套）。
      bindSessionRows(body, { source: 'work', root: body })
      bindRowPeek(body, '.wk-row')
      reliftAfterRebuild(body)
    }
  }

  function wkBodyHtml() {
    if (state.wkTab === 'chat') {
      // 列表 = 当前项目下的会话，条目渲染复用 recent.js 的 itemHtml（与侧栏「项目展开」同一份实现，
      // 不另写一套行）；行操作浮窗（右键 / 长按）走 recent.js 的 document 级委托，此处无需接线。
      // 置顶排序（2026-10-18）：wkPins 命中的会话恒排在 sessCmp 之前（组内仍按 sessCmp：
      // 状态在线优先 + 创建时间新→旧）。只作用于 work 侧栏列表，chat 侧栏 renderList/renderProject 不变。
      const pinRank = (s) => (isPinned(hashOf(s)) ? 0 : 1)
      // 临时项目（根级时间戳任务区）没有自有会话：列表改展示**全局根散装会话**（2026-10-30 用户定案）。
      // 判据统一走 core/util.js sessionInWork（临时项目 → 全局会话）；新建会话也落全局根（newSessionProject），故入列的
      // 新会话就在这份列表里，不会「发完就消失」。
      const list = state.workProj
        ? ALL.filter((s) => sessionInWork(s, state.workProj)).sort(
            (a, b) => pinRank(a) - pinRank(b) || sessCmp(a, b),
          )
        : []
      // 新建入口 = tab 行工具区的加号（updateWkTools 控制显隐），列表顶部不再占一行大按钮
      if (!state.workProj) return '<div class="wk-empty">先在上方选择一个项目</div>'
      return list.length
        ? `<div class="wk-chats">${list.map((s) => itemHtml(s, false, true)).join('')}</div>`
        : '<div class="wk-empty">该项目还没有聊天</div>'
    }
    if (!state.workProj) return '<div class="wk-empty">先在上方选择一个项目</div>'
    if (wkLoading) return '<div class="wk-empty">加载中…</div>'
    if (wkErr) return `<div class="wk-empty">${esc(wkErr)}</div>`
    if (!wkTree || !wkTree.length) return '<div class="wk-empty">项目内没有可列出的文件</div>'
    return wkTreeHtml(wkTree, 0, '') || '<div class="wk-empty">项目内没有可列出的文件</div>'
  }

  function wkTreeHtml(nodes, depth, prefix) {
    let h = ''
    for (const n of nodes || []) {
      const p = prefix ? `${prefix}/${n.name}` : n.name
      const pad = `padding-left:${8 + depth * 13}px`
      if (n.type === 'dir') {
        const open = wkOpen.has(p)
        h += `<button class="wk-row dir${open ? ' open' : ''}" data-wkdir="${esc(p)}" draggable="true" style="${pad}" title="${esc(p)}">`
        // 图标 SVG 无自带尺寸，必须落在有 svg 尺寸规则的 slot 里——裸插会取替换元素默认 300×150（巨型图标撑爆行高）
        h += `<span class="wk-chev">${open ? I.dshChevDown : I.dshChevRight}</span><span class="wk-fic">${I.folder}</span>`
        h += `<span class="wk-name">${esc(n.name)}</span></button>`
        if (open) h += wkTreeHtml(n.children, depth + 1, p)
      } else {
        const on = p === state.workFile ? ' on' : ''
        h += `<button class="wk-row file${on}" data-wkfile="${esc(p)}" draggable="true" style="${pad}" title="${esc(p)}">`
        h += `<span class="wk-chec"></span><span class="wk-fic">${I.dshFile}</span>`
        h += `<span class="wk-name">${esc(n.name)}</span></button>`
      }
    }
    return h
  }

  // ---------- 数据 ----------
  // 就地从内存树摘掉一个条目（2026-10-14 待办 12 删除增量更新的渲染源）：按路径段逐层下钻，
  // 末段命中即 splice。wkTree 为 null（树未加载）时静默不动——增量无源可改，交给随后的静默对账。
  function wkTreeRemove(p) {
    if (!wkTree) return
    const parts = p.split('/')
    const walk = (nodes, i) => {
      if (!Array.isArray(nodes)) return
      const idx = nodes.findIndex((n) => n.name === parts[i])
      if (idx < 0) return
      if (i === parts.length - 1) nodes.splice(idx, 1)
      else walk(nodes[idx] && nodes[idx].children, i + 1)
    }
    walk(wkTree, 0)
  }
  // 拖拽移动（2026-10-14 待办 10）：POST /gateway/file/move 成功后，前端把内存里的路径引用一并改指
  // 新址——打开中的文件（workFile）、文件 tab 开放集（wkFiles）、目录展开集（wkOpen）凡落在被移动
  // 子树下的都重写。树本身不手工搬节点：wkTreeRemove 摘旧 + 静默对账 loadProjectTree 补新（与删除
  // 同一条渲染链，不另起第二套搬移逻辑）。
  async function wkTreeMove(from, dir) {
    if (needToken()) return
    const res = await fetch(apiUrl('/gateway/file/move'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: state.workProj, path: from, dir }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) { toast(data.error || `移动失败（${res.status}）`); return }
    const to = dir ? `${dir}/${from.split('/').pop()}` : from.split('/').pop()
    const remap = (p) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p)
    if (state.workFile) state.workFile = remap(state.workFile)
    state.wkFiles = (state.wkFiles || []).map(remap)
    for (const k of [...wkOpen]) {
      const np = remap(k)
      if (np !== k) { wkOpen.delete(k); wkOpen.add(np) }
    }
    wkTreeRemove(from)
    renderEditor()
    applyPanes() // workFile/wkFiles 变更随一次布局落地（内含 saveWork 收口）
    loadProjectTree(state.workProj, true) // 静默对账：新位置入树（失败保旧树）
    toast('已移动到 ' + (dir || '项目根'))
  }
  // silent = 自动对账调用：不置加载态、失败保留旧树（瞬时网络错误不该把已展开的树清成错误页）
  async function loadProjectTree(label, silent) {
    if (!label || needToken()) return
    if (!silent) {
      wkLoading = true
      wkErr = ''
      wkTree = null
      renderWorkBody()
    }
    try {
      const res = await fetch(apiUrl('/gateway/project?label=' + encodeURIComponent(label)))
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || '加载失败')
      wkTree = Array.isArray(data.files) ? data.files : []
    } catch (e) {
      if (silent) return
      wkErr = e.message || String(e)
    } finally {
      if (!silent) wkLoading = false
    }
    renderWorkBody()
  }

  async function selectProject(label) {
    hideWkPops()
    if (!label || label === state.workProj) return
    if (wkEdDirty) await wkEdFlush() // 切项目前 flush 旧项目文件的 pending 编辑
    // 切项目 = stash 旧槽 → 换 workProj → load 新槽（唯一口 work-context.js switchWorkProject）。
    // 旧项目的顶栏开放集/侧栏页/开关归入它自己的槽，新项目从自己的槽恢复——**不再清空**（清空等于把
    // 「切回来恢复」永久做掉，是待办 #9 的根因）。
    const target = switchWorkProject(label) // 返回该项目槽上次的活动会话（'' = 无活动会话）
    wkOpen.clear() // 展开集是纯运行时视图态，不随槽持久化
    renderWorkChrome()
    // 目标路由由切项目这一侧**显式导航**（切项目意图 ≠ 路由弹回）：有上次会话则回它，无则回空态首页。
    // **不写 wkChats**——空态不等于「新对话 tab」（那要用户主动新建）；此处若走 enforceWorkScope 的
    // 无条件 navigate('#/')，空路由会被 open-set 兜底转成 new 并持久化（切项目凭空多新对话胶囊的根因）。
    navigate(target ? '#/' + encodeURIComponent(target) : '#/')
    renderProjSeat() // 新项目的席位（新会话目标项目）随项目换；路由已由上一行定值，不再强制弹回
    saveWork()
    applyPanes() // 再落地两开关（含「至少保留一栏」判定 + 视图浮层行同步 + 顶栏按归一后的路由重渲）
    applySidebarPin() // 侧栏开合按新项目的槽（桌面）
    renderEditor()
    hydrateExtCards(label) // 换项目：外部卡先按缓存即时换槽（tab 不断档），再走下面一次网络清单
    if (state.wkPreview) warmWorkBackend() // 右栏开着就预热新项目后端（工具态不会走下面的 mountPreview）
    renderWorkPreview() // 预览帧跟着换项目（异 label = 换源，mountPreview 内部重建；工具态则早退）
    cmtInvalidate() // 评论按项目分库：旧项目副本作废（下一行 cmtLoad 重拉，评论面板与原文标记共用）
    cmtLoad(label) // 原文标记也需要当前项目的评论（不止评论面板）；拉到后 cmtApplyMarks 自动补标
    cmtRender()
    syncWorkExtCards()
    await loadProjectTree(label)
  }

  // 目录定位（@ 目录 chip 的跳转落点，经 work 卡 reveal 命令调用）：逐段展开祖先、切到文件 tab 渲染，
  // 再按 data-wkdir 精确比较定位行（不拼 CSS 选择器，路径里的引号/方括号不参与解析）。
  // 目录不在树中 → 抛错（卡回 ok:false，派发器 toast），不静默停在别处。
  async function revealWorkDir(rel) {
    const label = state.workProj
    if (!label) throw new Error('没有工作项目')
    const dir = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (!wkTree) await loadProjectTree(label, true)
    if (!wkTree) throw new Error('文件树尚未加载')
    if (dir) {
      const parts = dir.split('/')
      let nodes = wkTree
      let prefix = ''
      for (const seg of parts) {
        const hit = (nodes || []).find((n) => n && n.type === 'dir' && n.name === seg)
        if (!hit) throw new Error('目录不在项目树中：' + dir)
        prefix = prefix ? prefix + '/' + seg : seg
        wkOpen.add(prefix) // 祖先与目标自身一起展开
        nodes = hit.children
      }
    } else {
      wkOpen.clear() // 项目根：收起全部，回到树的根视图
    }
    state.wkTab = 'files'
    renderWorkBody()
    applyPanes()
    const body = $('wk-body')
    let row = null
    if (body) {
      for (const el of body.querySelectorAll('[data-wkdir]')) {
        if (el.dataset.wkdir === dir) { row = el; break }
      }
    }
    if (row) {
      row.scrollIntoView({ block: 'center' })
      row.classList.add('wk-hit')
      setTimeout(() => { if (row.isConnected) row.classList.remove('wk-hit') }, 1400)
    }
    return { path: dir, found: !!row }
  }

  // silent = 自动对账（见 workAutoTick）：不收起浮层、不动滚动位置、失败静默
  async function refreshWork(silent) {
    if (!silent) hideWkPops()
    const body = $('wk-body')
    const sc = body ? body.scrollTop : 0
    try {
      await loadSessions()
    } catch {
      /* 列表刷新失败不阻断文件树刷新 */
    }
    renderWorkChrome()
    renderTopbar() // 顶栏与会话列表同拍对账（2026-10-13 待办 13）：wkTabName 按会话标题渲染，
    // SSE 改题/集合变化只会先落到 renderWorkChrome 这条链——缺这口时顶栏胶囊标题要等下一次
    // applyPanes（用户交互）才追上，「更新不及时」的根因即此。innerHTML 比对，未变零写 DOM。
    renderWkToolTabs() // groups 的 hasPreview 可能随磁盘变化（.claude/preview 增删）→ 预览页签同拍对账
    if (state.workProj) await loadProjectTree(state.workProj, silent)
    else renderWorkBody() // 未选项目时列表/空态也要跟上（loadProjectTree 早退不渲染）
    if (body && sc && body.scrollTop !== sc) body.scrollTop = sc
  }

  // ---------- 自动刷新（2026-09-26 取代手动 ⟳） ----------
  // 三条前置：work 模式 + 页面可见 + 已过 token 门。会话列表由 /gateway/events SSE 增量推，
  // 但 work 侧栏的列表/树不在 SSE 的重渲出口里（live.js refreshList 只渲 #recent-body），
  // 所以这里定时对账一次全量，静默无变化即不写 DOM（renderWorkBody 的 HTML 比对）。
  const WK_AUTO_MS = 5000
  let wkAutoT = 0
  function startWorkAuto() {
    if (!wkAutoT) wkAutoT = setInterval(workAutoTick, WK_AUTO_MS)
  }
  function stopWorkAuto() {
    if (wkAutoT) {
      clearInterval(wkAutoT)
      wkAutoT = 0
    }
  }
  async function workAutoTick() {
    if (state.sbMode !== 'work' || document.visibilityState !== 'visible' || needToken()) return
    await refreshWork(true)
  }

  // 项目列表落地（ensureWork / 下拉打开时共用）。needToken 未解锁或网络失败时 state.projects 保持原值。
  async function ensureProjectList() {
    if (state.projects.length) return
    try {
      await loadSessions()
    } catch {
      /* 静默：renderWorkProjects 以空态呈现 */
    }
  }

  // work 模式数据补齐（启动进入 / 门后补拉 / 恢复持久化状态三处共用一条路径）。needToken() 未解锁时
  // loadProjectTree 早退 ⇒ 刷新后恢复的 workProj/workFile 无树、编辑区 401，须由 engine/auth.js hideGate
  // 的「门后补拉」链再调一次（与 mgr/models/neurons 数据同点，见该文件同名注释）。
  async function ensureWork() {
    renderWorkChrome()
    renderWorkBody()
    renderEditor()
    await ensureProjectList()
    renderWorkChrome()
    if (state.workProj && !wkTree && !wkLoading && !wkErr) await loadProjectTree(state.workProj)
    renderWorkPreview() // 挂在 ensureProjectList 之后：hasPreview 来自 groups，先拉列表才知道
    cmtLoad(state.workProj) // 评论恢复态补拉（评论面板与原文标记共用；needToken 未解锁时早退，由门后补拉再调）
    syncWorkExtCards() // 外部卡申报同上：与树/编辑区/评论同一条补拉链
    // 布局落地（tab 显隐 + 列宽 + 顶栏）在本链尾再落一次：ensureWork 是 work 一切事后补拉的唯一口
    // （启动 + token 门解锁后各一次），门/首帧里 DOM 还没量到时这里给第二次落地机会。
    applyPanes()
    cmtRender() // 评论面板空态/加载态跟着工作项目落地（needToken 未解锁时上面 cmtLoad 早退）
  }

