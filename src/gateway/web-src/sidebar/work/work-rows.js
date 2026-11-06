// 文件 / 目录行操作（重命名 / 删除浮窗）与新建聊天 newWorkChat。（拆自 sidebar/work.js，纯搬迁零行为变更；符号经单 IIFE 共享作用域可见）
import { isTempProjLabel } from '../../core/util.js'
/* @module sidebar/work/work-rows.js */

  // ---------- 文件 / 目录行操作（2026-09-27：与侧栏会话行同一套右键 / 长按浮窗，见 recent.js registerRowMenu）----------
  // 两个写接口落在网关（POST /gateway/file/rename | /delete），本模块只做「弹出菜单 + 提交 + 刷新树」。
  // 删除 = 移入项目根 .trash/（工作区规范禁止真删），故不设二次确认——.trash/ 本身就是撤销位。
  function baseOf(p) {
    const i = p.lastIndexOf('/')
    return i < 0 ? p : p.slice(i + 1)
  }
  function openFileRename(p) {
    if (!p) return
    openRenameDialog({
      heading: '重命名',
      placeholder: '输入新名称',
      okText: '重命名',
      value: baseOf(p),
      onSubmit: async (name) => {
        const res = await fetch(apiUrl('/gateway/file/rename'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: state.workProj, path: p, name }),
        })
        const data = await res.json()
        if (!res.ok || !data.ok) throw new Error(data.error || '重命名失败')
        // 展开态与编辑区都按旧路径记着，须同步搬到新路径（目录改名 = 整棵子树的路径前缀都变）
        for (const k of [...wkOpen]) {
          if (k === p) { wkOpen.delete(k); wkOpen.add(data.path) }
          else if (k.startsWith(p + '/')) { wkOpen.delete(k); wkOpen.add(data.path + k.slice(p.length)) }
        }
        if (state.workFile === p) state.workFile = data.path
        else if (state.workFile.startsWith(p + '/')) state.workFile = data.path + state.workFile.slice(p.length)
        saveWork()
        await loadProjectTree(state.workProj)
        renderEditor()
        renderWorkBody()
        applyPanes() // 顶栏文件名 pill 跟着新路径重渲
        toast('已重命名为「' + data.name + '」')
      },
    })
  }
  // 「在资源管理器中打开」（2026-10-24）：网关进程在本机，explorer 打开的就是用户桌面。
  // 文件 = 父目录里选中该文件（/select,）；目录 = 直接打开该目录。请求体与删除同构（label + path）。
  async function revealWorkEntry(p) {
    if (!p) return
    try {
      const res = await fetch(apiUrl('/gateway/file/reveal'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: state.workProj, path: p }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) throw new Error(data.error || '打开失败')
    } catch (e) {
      toast('打开失败：' + (e.message || e))
    }
  }
  async function deleteWorkEntry(p) {
    if (!p) return
    try {
      const res = await fetch(apiUrl('/gateway/file/delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: state.workProj, path: p }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || '删除失败')
      if (state.workFile === p || state.workFile.startsWith(p + '/')) state.workFile = ''
      for (const k of [...wkOpen]) if (k === p || k.startsWith(p + '/')) wkOpen.delete(k)
      saveWork()
      // 增量更新（2026-10-14 待办 12）：后端已确认成功，先就地从内存树摘掉该节点重渲（不闪整树、
      // 不置加载态），再后台静默对账一次（HTML 比对，内容一致零写 DOM）。不走非静默 loadProjectTree
      // ——那会把 wkTree 清成「加载中…」整树重建，即用户报的「强制刷新」。
      wkTreeRemove(p)
      renderWorkBody()
      renderEditor()
      applyPanes() // 删掉当前打开的文件 → 文件 tab 退场、下沉格切回聊天/空
      toast('已移入 ' + data.trash)
      loadProjectTree(state.workProj, true)
    } catch (e) {
      toast('删除失败：' + (e.message || e))
    }
  }
  // 文件 / 目录行菜单「项 + 动作」唯一实现（2026-10-25）：侧栏文件树行 `.wk-row` 与 work 顶栏
  // 文件 pill `[data-wkftab]` 共用本 spec，禁止各写一套菜单。getEntry(el) → { path, dir }。
  // 「下载」仅文件出（2026-10-13 待办 1）：目录整棵打包无既有实现，不新造。
  function fileRowMenuSpec(getEntry) {
    const entryOf = (el) => getEntry(el) || {}
    return {
      items: (el) => {
        const { path, dir } = entryOf(el)
        if (!path) return []
        const head = [
          { a: 'reveal', icon: I.dshExplorer, label: '在资源管理器中打开' },
          { a: 'rename', icon: I.dshEdit, label: '重命名' },
        ]
        const del = { a: 'delete', icon: I.dshStop, label: '删除', danger: true }
        return dir ? [...head, del] : [...head, { a: 'download', icon: I.dshDownload, label: '下载' }, del]
      },
      pick: (a, el) => {
        const { path } = entryOf(el)
        if (a === 'reveal') revealWorkEntry(path)
        else if (a === 'rename') openFileRename(path)
        else if (a === 'download') downloadWorkEntry(path)
        else deleteWorkEntry(path)
      },
    }
  }
  // ---------- 项目行操作（2026-11-06）：长按 / 右键项目下拉行 → 归档（全部项目）/ 删除（仅临时项目） ----------
  // 归档 = 压缩进 <工作区根>/.achrives/<label>-<ts>.tar.gz（tar 顺序流，无 zip 中央索引）+ 原目录移入
  // .trash/；删除 = 临时项目（根级时间戳任务区）目录直接移入 .trash/，不压缩。两口的语义与防护都在
  // 网关（archiveProject / deleteTempProject），前端只做「确认手势 → 提交 → 列表对账」。
  // 与文件删除同口径不设二次确认：.trash/ 是撤销位，归档包在 .achrives 另存一份。
  // 当前工作项目被移走后必须整体退场（不能停在一个已不存在的项目上）：切空槽 + 清打开集 + 回空态首页。
  async function wkAfterProjectGone(label) {
    // 下拉只在「被移走的正是当前工作项目」时收：其余情况保持打开，让用户接着操作别的项目
    // （下拉内容由下面的 renderWorkChrome → renderWorkProjects 就地刷新，被归档的行自然消失）。
    if (state.workProj === label) {
      hideWkPops()
      switchWorkProject('')
      state.workFile = ''
      state.wkFiles = []
      wkOpen.clear()
      wkTree = null
      wkErr = ''
      navigate('#/')
      saveWork()
      renderEditor()
      renderWorkPreview()
      applyPanes()
    }
    await loadSessions()
    renderWorkChrome()
    renderWorkBody()
    renderTopbar()
  }
  async function archiveWorkProject(label) {
    if (!label) return
    try {
      if (state.workProj === label && wkEdDirty) await wkEdFlush() // 未保存编辑先落盘，否则归档包缺最新内容
      toast('正在归档「' + label + '」…')
      const res = await fetch(apiUrl('/gateway/project/archive'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) throw new Error(data.error || '归档失败')
      await wkAfterProjectGone(label)
      toast('已归档到 ' + data.archive)
    } catch (e) {
      toast('归档失败：' + (e.message || e))
    }
  }
  async function deleteWorkProject(label) {
    if (!label || !isTempProjLabel(label)) return
    try {
      const res = await fetch(apiUrl('/gateway/project/delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) throw new Error(data.error || '删除失败')
      await wkAfterProjectGone(label)
      toast('已移入 ' + data.trash)
    } catch (e) {
      toast('删除失败：' + (e.message || e))
    }
  }
  // 项目行菜单项：归档恒有；删除只对临时项目（长期项目走归档，避免误删整棵项目）。
  function projectRowMenuSpec() {
    return {
      items: (el) => {
        const label = el.dataset.pk || ''
        if (!label) return []
        const out = [{ a: 'archive', icon: I.dshCompact, label: '归档' }]
        if (isTempProjLabel(label)) out.push({ a: 'delete', icon: I.dshTrash, label: '删除', danger: true })
        return out
      },
      pick: (a, el) => {
        const label = el.dataset.pk || ''
        if (a === 'archive') archiveWorkProject(label)
        else if (a === 'delete') deleteWorkProject(label)
      },
    }
  }
  // 文件树行源：文件与目录同一套菜单（目录删除 = 整棵子树进 .trash/）；操作对象 = 行的项目内相对路径。
  // 项目下拉行同一个注册式浮窗（长按 / 右键），项目行的操作对象 = 项目 label。
  function registerWorkRows() {
    registerRowMenu({
      sel: '.wk-row',
      key: (el) => el.dataset.wkfile || el.dataset.wkdir || null,
      ...fileRowMenuSpec((el) => ({ path: el.dataset.wkfile || el.dataset.wkdir || '', dir: !!el.dataset.wkdir })),
    })
    // 项目行由 feature/project-picker 渲染（.pk-row + data-pk）；同一组件也用于底栏 #proj-pop，
    // 但归档只对 work 侧栏项目下拉开放，故选择器限定容器。
    registerRowMenu({
      sel: '#wk-proj-pop .pk-row',
      key: (el) => el.dataset.pk || null,
      ...projectRowMenuSpec(),
    })
  }

  function newWorkChat() {
    // 新会话落在当前 work 项目下（落项目由 engine/state.js newSessionProject 按工作项目解析，此处不写
    // state.newProject——目标项目槽只有一个真源，work 模式读工作项目、chat 模式读该槽）。
    // 不切回 chat 模式：#/ 空态由 renderHome() 渲染进会话卡（非视图卡），work 主区布局照样成立；
    // 模式互斥只对 mgr/preview 两张视图卡生效（route.js 内那一处 setSbMode('chat')）。
    state.wkMainTab = 'chat' // 新建聊天 = 要看聊天 → 聊天 tab 顶上来、助手靠回栏
    state.wkAssist = true
    state.wkAssistMode = 'side'
    navigate('#/') // 空对话只是激活哨兵，不入顶栏开放集（不渲染「新对话」胶囊）
    applyPanes()
    saveWork()
    if (isMobile()) setPanel(false)
  }

