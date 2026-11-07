// 事件绑定（mountWork）与启动一次（initWork）。（拆自 sidebar/work.js，纯搬迁零行为变更；符号经单 IIFE 共享作用域可见）
import { enabledPreviewCardsFor } from '../../feature/preview-frame.js'
import { gatewayBootAt } from '../../engine/gateway.js'
import { resetWorkPreviewOnBoot } from '../../core/storage.js'
/* @module sidebar/work/work-mount.js */
  // ---------- 侧栏开关（2026-10-14 待办 5，取代 2026-10-10 的视图浮层）----------
  // 触发器两处、互斥在场：侧栏展开 = 头部 #wk-view（收起钮）；侧栏折叠 = 标签栏左端的汉堡 #menu-btn
  // （#sidebar.open 的兄弟选择器把汉堡藏起，故任一时刻恰一个可见）。两钮都只直管侧栏常开/常收
  // （与 chat 模式同一语义），不再经 #wk-view-pop 浮层——浮层仅剩「侧边栏」一行，无存在必要。

  // ---------- 事件 ----------
  function mountWork() {
    // 卡片→宿主：预览卡（如 Pj18 的 PDF/LaTeX 卡）点「跳源码」→ `<ns>-event{ev:'src-open'}` → 总线门禁
    // （label 必须是当前工作项目）过后，由本口打开文件并滚到行。载入是异步的（读文件→灌文档），故「开 + 定位」
    // 合成**一个**口交给宿主自己排序——总线不猜「文档何时才算就位」。
    cardBus.setSourceOpener({
      open: async (p, line) => {
        await openWorkFile(p)
        if (line) wkEdScrollToLine(line)
      },
    })
    // work 编辑区对宿主/其它卡的公开动词（2026-10-21）：scroll{path,line} = 打开文件并滚到行。
    // 门禁与 src-open 同口径（只在 work 模式、只认当前工作项目）——「文件内引用跳转仅在 work 模式下」。
    // 路径口径 = 项目根相对 POSIX（与 src-open 一致）；令牌跨项目时带 `<项目 label>/` 前缀，剥掉再用。
    cardBus.registerInlineCard({
      instanceId: 'floria-work',
      ns: 'floria-work',
      cmds: ['scroll', 'locate', 'state'],
      handlers: {
        scroll: async (a) => {
          if (state.sbMode !== 'work' || !state.workProj) throw new Error('仅在 work 模式下可跳转到文件')
          const raw = String((a && a.path) || '').replace(/\\/g, '/')
          if (!raw) throw new Error('缺少文件路径')
          const pre = state.workProj + '/'
          const path = raw.startsWith(pre) ? raw.slice(pre.length) : raw
          const line = Number(a && a.line) || 0
          await openWorkFile(path)
          if (line) wkEdScrollToLine(line)
          return { path, line }
        },
        locate: () => ({ file: state.workFile || '', project: state.workProj || '' }),
        state: () => ({ mode: state.sbMode, project: state.workProj || '', file: state.workFile || '' }),
      },
    })
    registerWorkRows() // 文件树行的右键 / 长按浮窗（与会话行共用 recent.js 的手势委托）
    document.querySelectorAll('#chat-area > .work-gutter').forEach(bindGutter) // 主区一条分界条（下沉区 ↔ 预览）
    // 助手三态：头部工具条的四个图标 + 收敛输入栏的 pill；形态切换统一走 setAssistMode / setPane。
    const bindIco = (id, fn) => {
      const b = $(id)
      if (b) b.addEventListener('click', fn)
    }
    bindIco('wk-assist-pill', () => setAssistMode('float'))
    bindAssistGrip()
    // 主区尺寸变化 → 重锚悬浮卡：ResizeObserver 一把覆盖分界条拖拽、侧栏开合、窗口缩放、栏开关
    // （比 window.resize + 视口算更准：锚栏宽变了就重算，没变就不动）。
    const ro = new ResizeObserver(() => wkReflowAssist())
    ro.observe(chatArea)
    for (const id of ['work-editor', 'work-preview']) {
      const el = $(id)
      if (el) ro.observe(el)
    }
    // 模式 tab 白块：applySbMode 首次定位时字体可能还没到位（字宽变 ⇒ 白块错位），fonts.ready 后重量一次；
    // 窗口宽变同理（面板拖宽不改钮宽，但换字号/系统缩放下会）。
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(positionMsThumb)
    window.addEventListener('resize', positionMsThumb)
    $('wk-new').innerHTML = I.dshPlus
    // 视图开关图标与 chat 的 #panel-collapse 同款（I.collapse，2026-10-10 用户定案：两模式第三槽同图标）
    $('wk-view').innerHTML = I.collapse
    // 顶栏「工具栏」胶囊的图标/文字由 applyPvTab 按「右栏在不在场」写（不在场 = 插件图标 + 「工具栏」，
    // 在场 = ✕ + 「关闭」），此处不预置——applySbMode → applyPanes → applyPvTab 在 mountWork 之后立刻落一次。
    // 右栏工具 tab 的「评论」由评论卡自注册（views/cards/comment/comment-card.js）——宿主不再知道
    // 该工具的存在，只注入它需要的能力回调（下一行起）。
    // 评论卡 ↔ work 解耦：注册回调（点评论定位开文件 / 选区添加评论时切到评论工具页 /
    // 评论增删改后重绘原文标记）
    cmtSetHooks({
      openFile: (p, id) => {
        wkCmtScrollId = id || ''
        openWorkFile(p) // 打开 + 渲染后由 cmtApplyMarks 消费 wkCmtScrollId 滚到被批注行
      },
      ensurePane: () => setPvTab('comments'), // 切评论工具页（含开栏 + 拉内容）
      refreshMarks: cmtApplyMarks,
    })
    // 顶栏三种 pill 的点击一律**直调侧栏那条同一个函数**，不在此自写 state（顶栏不另立链路）。
    // 「工具栏」胶囊 = 右栏整列开/关：调 setPane('workspace', on)（其内落 setPvPane：在场维 + 关栏时
    // 顺带回预览态）。文件 pill（可多枚）= 见下面 data-wkftab 分支（调 openWorkFile / closeWkFile）。
    $('wk-tb-tool').addEventListener('click', () => setPane('workspace', !state.wkPreview))
    // 右栏工具 tab 条：唯一切换口 = setPvTab（渲染 + 内容补挂 + 持久化都在其内）。tab 条由
    // work-tools.js 的 renderWkToolTabs 重渲 → 事件必须委托在容器上（逐钮绑定会被下次重渲抹掉）。
    // 首枚「预览」页签 data-wkpv="" → setPvTab('') → setPvPane(true, '')，经其中 `page === ''` 特判回预览态；
    // 切勿自以为要过 wkToolNormId——它会回落首枚工具（评论），表达不了「回预览」。
    $('wk-pv-tabs').addEventListener('click', (e) => {
      const c = e.target.closest('[data-wkcard]')
      if (c) { setPvCard(c.dataset.wkcard); return } // 卡片 tab：切 iframe 到该卡目录页
      const b = e.target.closest('[data-wkpv]')
      if (b) setPvTab(b.dataset.wkpv)
    })
    // 预览帧 → 宿主：申报本页的工具 tab（Pj18 等预览页把「编译日志」之类挂进工具栏面板）。沿用既有
    // iframe↔宿主通道（同 rail-ext / ext-card），凭 e.source 必须就是 work 右栏当前那枚 .preview-frame
    // 才采纳。字段：{ type:'floria-wk-tool-register', tools:[{ id, title }] }，整份替换（页面最了解自己有什么）。
    // 帧工具的 pane 由预览页自管（宿主只渲 tab + 回传选中 id，见 syncPvContent/notifyFrame）。
    addEventListener('message', (e) => {
      const d = e.data
      if (!d || typeof d !== 'object') return
      // 预览卡 → 宿主顶栏：请求切到另一张卡（2026-10-18 多卡片架构）。门禁同帧工具：
      // e.source 必须就是右栏当前那枚 .preview-frame；目标卡必须在**当前项目**的卡表里，
      // 不在表内整条丢弃（不猜、不跨项目跳）。payload 原样交接给目标卡（load 后 floria-wk-card-init）。
      if (d.type === 'floria-wk-card-switch') {
        const f = wkFrame()
        if (!f || f.contentWindow !== e.source) return
        const want = String(d.card || '')
        if (!enabledPreviewCardsFor(f.dataset.label || '').some((c) => c.id === want)) return
        setPvCard(want, d.payload)
        return
      }
      if (d.type !== 'floria-wk-tool-register') return
      // 卡池化（2026-10-26）：来源按窗口反查池内任一预览帧（含隐藏帧），不取「第一个」。
      const f = wkFrameBySource(e.source)
      if (!f) return
      const tools = (Array.isArray(d.tools) ? d.tools : [])
        .filter((t) => t && typeof t.id === 'string' && t.id)
        .map((t) => ({ id: t.id, title: typeof t.title === 'string' ? t.title : t.id, pane: '', mount: null }))
      // 每帧缓存自己申报的工具表：池内切回（无 load）时由 work-preview 直接恢复，不必等页面再申报。
      f.__wkTools = tools
      if (f !== wkFrame()) return // 隐藏帧只记缓存，不上 tab 条（tab 条恒属当前显示的那张卡）
      // 申报集变了：当前 active 若已不存在（被撤的帧工具）→ 回落预览态；否则照旧。
      if (state.wkPvTab && !wkToolDef(state.wkPvTab)) state.wkPvTab = ''
      wkFrameSentId = null // 帧重挂/重申报 → 强制再回传一次当前选中
      applyPanes()
      notifyFrame(state.wkPvTab && !(wkToolDef(state.wkPvTab) || {}).pane ? state.wkPvTab : '')
    })
    $('wk-tb-tabs').addEventListener('click', (e) => {
      const cap = e.target.closest('[data-wkchat]')
      if (cap) {
        if (e.target.closest('.wk-tb-x')) { wkCloseTab(cap.dataset.wkchat); return } // × = 关这枚 tab
        // 点胶囊 = 明确要看这个会话：助手在场且靠回栏（浮起/收敛先靠回），再切到该会话路由
        state.wkMainTab = 'chat'
        state.wkAssist = true
        state.wkAssistMode = 'side'
        const hash = wkKeyHash(cap.dataset.wkchat)
        if (state.currentHash !== hash) navigate(hash ? '#/' + encodeURIComponent(hash) : '#/')
        applyPanes() // 形态 + 顶栏 active 一并落地（applyWorkCols 内 applyAssistMode 收口）
        saveWork()
        return
      }
      const b = e.target.closest('[data-wkftab]')
      if (!b) return
      const fp = b.dataset.wkftab
      if (e.target.closest('.wk-tb-x')) { closeWkFile(fp); return } // × = 关掉这枚文件 tab
      // 点文件 pill = 明确要看这个文件：调**侧栏文件行那条同一个函数** openWorkFile（载入 + 切下沉区到
      // 编辑卡 renderEditor + cardBus 广播 file-open 让预览卡跟着切）。原先此处自写 wkMainTab+applyPanes，
      // 是顶栏独有的一条残链——预览卡收不到广播，故「侧栏点文件」与「顶栏点 pill」表现不一致。
      openWorkFile(fp)
    })
    // 顶栏胶囊的右键 / 长按浮窗（2026-10-25）：与侧栏行**共用同一份菜单 spec**，不另写菜单项——
    // 会话胶囊复用 recent.js 的 sessionRowMenuSpec（置顶 / 重命名 / 关闭会话，与侧栏会话行完全一致），
    // 文件 pill 复用 work-rows.js 的 fileRowMenuSpec（在资源管理器中打开 / 重命名 / 下载 / 删除，
    // 与文件树文件行完全一致）。顶栏胶囊属 work 语境，故 withPin 恒真；
    // 重命名成功后 renderTopbar 让胶囊标题即时跟上（侧栏行由 renderRecent 自理）。
    registerRowMenu({
      sel: '[data-wkchat]',
      key: (el) => el.dataset.wkchat || null,
      ...sessionRowMenuSpec((el) => wkKeyHash(el.dataset.wkchat), () => true, renderTopbar),
    })
    registerRowMenu({
      sel: '[data-wkftab]',
      key: (el) => el.dataset.wkftab || null,
      ...fileRowMenuSpec((el) => ({ path: el.dataset.wkftab, dir: false })),
    })
    // 收敛输入栏末端的箭头 = 正常底栏发送钮的同一枚图标（单源 core/icons.js，勿在 HTML 内联自绘）
    const wap = document.querySelector('.wap-arrow')
    if (wap) wap.innerHTML = I.dshSend
    const ico = document.querySelector('#wk-proj-seat .wk-proj-ico')
    if (ico) ico.innerHTML = I.folder
    const fic = document.querySelector('.wk-foot-ico')
    if (fic) fic.innerHTML = I.logo

    // 项目选择器的开合与行选择由共享组件 feature/project-picker/project-picker.js 绑定
    // （实例 = work-files.js 的 wkPicker；与底栏 #proj-pop 同一实现，2026-11-06 同构）。
    // 侧栏收起钮：与 chat 的 #panel-collapse 同语义（只管把侧栏收起；再开走折叠态的汉堡）
    $('wk-view').addEventListener('click', (e) => {
      e.stopPropagation()
      setPane('sidebar', false)
    })
    // 加号按 tab 分派：聊天 tab = 直接新建对话；文件 tab = 展开新建菜单（创建/上传，功能待接入）
    $('wk-new').addEventListener('click', (e) => {
      e.stopPropagation() // 同步：先掐断 document 的收起委托，否则菜单刚开就被关掉
      if (state.wkTab !== 'files') {
        newWorkChat()
        return
      }
      const pop = $('wk-new-pop')
      const willShow = pop.hidden
      hideWkPops()
      pop.hidden = !willShow
    })
    $('wk-new-pop').addEventListener('click', (e) => {
      e.stopPropagation()
      const nb = e.target.closest('[data-wknew]')
      if (!nb) return
      $('wk-new-pop').hidden = true
      wkNewPick(nb.dataset.wknew) // 四项接入（2026-10-13）：创建文件/文件夹 + 上传文件/文件夹，实现在 work-tabmenu.js
    })
    document.querySelectorAll('.wk-tab').forEach((b) =>
      b.addEventListener('click', () => {
        // 插件入口（与 chat 侧栏「插件」tab 同位置）：内容仍渲在下沉区第三态
        if (b.hasAttribute('data-wkplugins')) {
          state.wkMainTab = 'plugins'
          state.wkAssist = true
          state.wkAssistMode = 'side'
          renderWorkBody() // 高亮同步（updateWkTools 唯一口）
          applyPanes()
          saveWork()
          return
        }
        state.wkTab = b.dataset.wktab
        // 点文件/聊天 = 离开插件页，下沉区回对应页态（侧栏体切换照旧）
        if (state.wkMainTab === 'plugins') state.wkMainTab = state.wkTab === 'chat' ? 'chat' : 'file'
        renderWorkBody() // 高亮同步在 updateWkTools（唯一口，覆盖点击外的恢复路径）
        applyPanes()
      }),
    )
    // 文件树整块由 innerHTML 重渲 → 事件必须委托在容器上（逐行绑定会被下次重渲抹掉）
    $('wk-body').addEventListener('click', (e) => {
      const d = e.target.closest('[data-wkdir]')
      if (d) {
        const p = d.dataset.wkdir
        if (wkOpen.has(p)) wkOpen.delete(p)
        else wkOpen.add(p)
        renderWorkBody()
        return
      }
      const f = e.target.closest('[data-wkfile]')
      if (f) {
        openWorkFile(f.dataset.wkfile)
        return
      }
      // 会话行（.sess-item）不在本委托里：行行为统一协议见 recent.js（activateSession / bindSessionRows），
      // 接线点在 work-files.js renderWorkBody 的重建分支。此处只留文件树目录/文件 + 拖拽。
    })
    // 文件树拖拽移动（2026-10-14 待办 10，仿 Obsidian）：行 draggable（wkTreeHtml），投放目标 =
    // 目录行（含收起态）与树空白（= 项目根，仅文件 tab）。wkDragPath 记拖动起点，dragover 按
    // 「非自身 / 非其子目录 / 父目录不同」判可落并亮行；落点落定走 wkTreeMove（work-files.js）。
    let wkDragPath = ''
    let wkDndEl = null
    const body = $('wk-body')
    const dropDir = (e) => {
      const row = e.target.closest ? e.target.closest('[data-wkdir]') : null
      return row ? row.dataset.wkdir : state.wkTab === 'files' ? '' : null
    }
    const canDrop = (from, dir) =>
      from !== dir && !dir.startsWith(from + '/') && from.split('/').slice(0, -1).join('/') !== dir
    const dndMark = (el) => {
      if (wkDndEl === el) return
      if (wkDndEl) wkDndEl.classList.remove('wk-dnd')
      wkDndEl = el
      if (el) el.classList.add('wk-dnd')
    }
    body.addEventListener('dragstart', (e) => {
      const row = e.target.closest ? e.target.closest('[data-wkfile],[data-wkdir]') : null
      if (!row) return
      wkDragPath = row.dataset.wkfile || row.dataset.wkdir
      e.dataTransfer.setData('text/plain', wkDragPath)
      e.dataTransfer.effectAllowed = 'move'
    })
    body.addEventListener('dragover', (e) => {
      if (!wkDragPath || state.wkTab !== 'files') return
      const dir = dropDir(e)
      if (dir == null || !canDrop(wkDragPath, dir)) { dndMark(null); return }
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      dndMark(e.target.closest('[data-wkdir]') || body)
    })
    body.addEventListener('dragleave', (e) => {
      if (!body.contains(e.relatedTarget)) dndMark(null)
    })
    body.addEventListener('drop', (e) => {
      const from = wkDragPath
      wkDragPath = ''
      dndMark(null)
      if (!from || state.wkTab !== 'files') return
      const dir = dropDir(e)
      if (dir == null || !canDrop(from, dir)) return
      e.preventDefault()
      wkTreeMove(from, dir)
    })
    body.addEventListener('dragend', () => { wkDragPath = ''; dndMark(null) })
    // 编辑卡左上角文件名只作展示：重命名入口统一在顶栏文件 pill / 侧栏文件行的右键菜单里
    // （2026-10-25 定案，删掉此处点击直调 openFileRename 的旧入口）。
    // 编辑区：Ctrl+S 立即保存（绑在 #work-editor 上；编辑器自身处理其余按键，未消费的键冒泡到此处）
    $('work-editor').addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      if (e.key.toLowerCase() === 's') {
        e.preventDefault()
        wkEdSave({})
      }
    })
    // 外部改动提示条：保留本地（强制覆盖） / 载入磁盘版本（404 时按文件消失语义收口）
    const remoteSave = $('wk-ed-remote-save')
    if (remoteSave) remoteSave.addEventListener('click', () => { wkLiveKeepLocal() })
    const remoteLoad = $('wk-ed-remote-load')
    if (remoteLoad) remoteLoad.addEventListener('click', () => { wkLiveTakeRemote() })
    $('wk-foot').addEventListener('click', () => toast(state.workspace ? `工作区：${state.workspace}` : '工作区路径未知'))
    // 点空白收起两个浮层（浮层与触发按钮之外的点击都算）
    document.addEventListener('click', (e) => {
      // 行浮窗（长按 / 右键菜单）与项目下拉算一组：点菜单项只是对项目做归档/删除，不应连带收起下拉；
      // 收起只认「点项目行选中」与「点这两处浮层之外的空白」。项目真被归档/删除后由 wkAfterProjectGone 统一收。
      const inRowMenu = !!e.target.closest('.row-menu-pop')
      if (!inRowMenu && !e.target.closest('#wk-proj-pop') && !e.target.closest('#wk-proj-seat')) $('wk-proj-pop').hidden = true
      if (!e.target.closest('#wk-new-pop') && !e.target.closest('#wk-new')) $('wk-new-pop').hidden = true
    })
    // 后台标签页不做对账（定时器仍在跑，tick 内自会跳过）；切回前台立刻补一次，不等下一个间隔
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return
      workAutoTick()
      wkLiveTick(false) // 外部改动同步同一时刻补一次，不等下一个 500ms
    })
  }

  // 启动一次：恢复持久化状态 → 绑定事件 → 落地（顺序不可换：绑定要先于 applySbMode 的渲染，
  // 否则 work 面板首个渲染出来的行（文件树/新聊天）没有容器级委托）
  function initWork() {
    loadWork(WORK_SLOT_DEF) // 读盘：恢复模式/当前项目/预览列宽 + 全部项目槽 → 当前槽落到 live
    // 工具栏开合只在本网关进程运行期内保持：网关换了（boot 不同）⇒ 全部项目槽的工具栏复位折叠。
    // 须在 mountWork/applySbMode 之前（它要基于复位后的 live 态落地）。
    resetWorkPreviewOnBoot(gatewayBootAt())
    reconcileWorkSurface() // 语境归一：守护 workSlotKey === workProj（启动/路由恢复共用，幂等）
    // 外部卡申报按缓存即时回填（同步、无网络）：刷新后在门解锁前 tab 就在位，/manage/ext:… 直进也有卡
    // 可解析；权威清单由 ensureWork → syncWorkExtCards 拉新覆盖。必须在 loadWork 之后（要知道工作项目）。
    hydrateExtCards(state.workProj)
    mountWork()
    applySbMode()
  }

