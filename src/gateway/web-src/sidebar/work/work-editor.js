// 编辑区渲染与读写：原文评论标记 / renderEditor / 读文件 / 自动保存 / 冲突处置 / 开关文件。（拆自 sidebar/work.js，纯搬迁零行为变更；符号经单 IIFE 共享作用域可见）
import { wkPdfClose, wkPdfRender } from './work-pdf.js'
import { cmtRangesFor } from '../../feature/comment/comment-data.js'
/* @module sidebar/work/work-editor.js */
  // ---------- 评论标记（原文行打标，2026-10-06；2026-10-07 改编辑器行装饰器） ----------
  // 每条评论的行范围 l0..l1 落成 CodeMirror 行装饰：未解决 .cmt-mark-open / 已解决 .cmt-mark-res。
  function cmtApplyMarks() {
    const view = wkEdGetView()
    if (!view) return
    const marks = cmtRangesFor(state.workFile)
    wkEdApplyMarks(marks)
    if (wkCmtScrollId) {
      const id = wkCmtScrollId
      wkCmtScrollId = ''
      const hit = marks.find((m) => m.id === id)
      if (hit) wkEdScrollToLine(Math.min(hit.l0, view.state.doc.lines))
    }
  }

  // 顶部「保存态」文本落地（唯一写点）：conflict > saving > dirty > 空。传 (txt, cls) 则原样落。
  // 该行不再显示文件名，空态即整行隐藏（.wk-ed-head 的显示与否由这里统一收口）。
  function wkEdState(txt, cls) {
    const el = $('wk-ed-save')
    if (!el) return
    if (txt === undefined) {
      txt = wkEdConflict ? '外部已修改' : wkEdSaving ? '保存中…' : wkEdDirty ? '未保存' : ''
      cls = wkEdConflict ? 'conflict' : wkEdDirty || wkEdSaving ? 'dirty' : ''
    }
    el.textContent = txt || ''
    el.classList.toggle('dirty', cls === 'dirty')
    el.classList.toggle('conflict', cls === 'conflict')
    const head = $('wk-ed-head')
    if (head) head.hidden = !txt
  }

  // 编辑卡的滚动位置按 (项目, 文件) 逐份记忆——「切走」有两种形态，都必须记：①主区「文件 ↔ 聊天」
  // 切换时 #work-editor 变 display:none，不参与布局的元素其滚动容器 scrollTop 被浏览器夹回 0；
  // ②切到另一个文件 tab 再切回来，readFile 换文档、旧 DOM 连同滚动位置一起没了。故捕获点有两处
  // （applyPanes 隐藏前 / openWorkFile 换文件前），恢复点也有两处（重新显示 / 文档重新载入）。
  // 滚动容器两态：CM6 的 scrollDOM / PDF 卡自己的 .wk-pdf-scroll。
  const wkEdScrollMemo = new Map()
  const wkEdScrollKey = () => state.workProj + '\u0000' + state.workFile
  function wkEdScroller() {
    const v = wkEdGetView()
    if (v && v.scrollDOM && v.scrollDOM.isConnected) return v.scrollDOM
    const body = $('wk-ed-body')
    return (body && body.querySelector('.wk-pdf-scroll')) || null
  }
  function wkEdCaptureScroll() {
    const el = wkEdScroller()
    if (!el || !state.workFile) return
    wkEdScrollMemo.set(wkEdScrollKey(), el.scrollTop)
  }
  // 恢复：key 缺省 = 当前 (项目, 文件)。容器取「此刻」的滚动容器而非捕获时那个——换文件后
  // PDF 会重建新的 .wk-pdf-scroll 节点。
  function wkEdRestoreScroll(key) {
    const top = wkEdScrollMemo.get(key || wkEdScrollKey())
    if (!top) return
    // 布局本帧才切回 flex / 文档本帧才灌入，容器高度此刻未必已恢复；下一帧再写，否则 scrollTop 仍被夹到 0。
    requestAnimationFrame(() => {
      const el = wkEdScroller()
      if (el && el.isConnected) el.scrollTop = top
    })
  }

  function renderEditor() {
    const body = $('wk-ed-body')
    if (!body) return
    if (!state.workFile) {
      wkEdReset()
      body.innerHTML = '<div class="wk-ed-empty">从左侧文件树选择一个文件</div>'
      return
    }
    if (!state.workProj) {
      wkEdReset()
      body.innerHTML = '<div class="wk-ed-empty">未选择项目</div>'
      return
    }
    // 返回载入 Promise（新文件/新项目才读盘）：调用方要等「文档真进编辑器」才能定位行（如卡片 src-open 跳行）。
    // 缓存键 = (workProj, workFile) 两维——只比路径会在「两项目存在同名相对路径」（如都开 README.md）时
    // 判为同一文件：切项目后不重读，编辑区留着上个项目的内容（PDF 分支表现为旧 iframe 换「不支持预览」，
    // 文本分支更会被后续自动保存写进新项目同名文件 = 跨项目串台/污染）。项目维度不可省。
    if (wkEdFile !== state.workFile || wkEdProj !== state.workProj) return readFile(state.workFile)
    renderEdBody()
  }

  function wkEdReset() {
    wkLiveReset()
    wkEdFile = ''
    wkEdMeta = null
    wkEdText = ''
    wkEdMtime = null
    wkEdDirty = false
    wkEdConflict = false
    wkEdPendingDoc = null
    wkEdProj = ''
    wkPdfClose()
    if (wkEdGetView()) { wkEdSetLang(''); wkEdSetDoc('') }
    wkEdApplyMarks([])
    if (wkEdTimer) {
      clearTimeout(wkEdTimer)
      wkEdTimer = 0
    }
    wkEdState('')
  }

  function renderEdBody() {
    const body = $('wk-ed-body')
    if (!body || !wkEdMeta) return
    if (wkEdMeta.isImg) {
      body.innerHTML = `<div class="wk-ed-img"><img src="${esc(fileUrl(state.workFile))}" alt="${esc(state.workFile)}" /></div>`
      return
    }
    if (!wkEdMeta.editable) {
      // PDF / Office 的只读视图由 readFile 直渲（wkPdfRender / wkDocRender），本函数**不得**用
      // 「不支持预览」占位覆盖它——否则同一文件重新过一遍 renderEditor（切走再切回、评论重渲）就把
      // 页栈连同滚动位置一起销毁。错误态（413/403/二进制）没有 view 标记，照旧落提示。
      if (wkEdMeta.view) return
      body.innerHTML = `<div class="wk-ed-empty">${esc(wkEdMeta.msg || '不支持预览')}</div>`
      return
    }
    // 可编辑文本（含 md）：常驻 CodeMirror 6 编辑器。把 host 挂回 body 并测量（body 可能被别的渲染重建过
    // 子节点）；仅当 readFile 置了 wkEdPendingDoc（新文件）才换文档 + 热换语言，否则保留编辑器现状
    // （重渲不得用陈旧基线覆盖用户未保存的编辑）。
    wkEditor.attach(body)
    const fresh = wkEdPendingDoc !== null
    if (fresh) {
      wkEdSetLang(state.workFile)
      wkEdSetDoc(wkEdPendingDoc)
      wkEdPendingDoc = null
    }
    wkEditor.measure()
    cmtApplyMarks() // 评论标记：被批注的行加高亮
    wkEdState()
    if (fresh) wkEdRestoreScroll() // 换文件重载 → 写回该文件上次的滚动位置（同文件切回不丢位置）
  }

  let wkEdProj = '' // 当前编辑内容所属项目（缓存键第二维；与 wkEdFile 配对，切项目即失效）

  // 死路径收口：读回 404 = 该路径在盘上已不存在（改名/删除后残留的开放集条目，含持久化恢复的）。
  // 摘出 state.wkFiles（顶栏 pill 的唯一来源），激活项按关 tab 同语义落到右邻/左邻/聊天；
  // 不保留一枚永远「读取失败」的空壳胶囊。**只认 404**——网络错误/413/403 是「读不出内容」而非
  // 「文件没了」，瞬时故障不该吞掉用户打开的视图。
  function wkDropDeadFile(p) {
    const i = state.wkFiles.indexOf(p)
    if (i >= 0) state.wkFiles.splice(i, 1)
    toast('文件不存在：' + p)
    if (state.workFile !== p) { applyPanes(); return }
    const next = state.wkFiles[i] != null ? state.wkFiles[i] : state.wkFiles[i - 1]
    if (next != null) return openWorkFile(next)
    state.workFile = ''
    state.wkMainTab = 'chat'
    renderEditor()
    applyPanes()
  }
  async function readFile(p) {
    const body = $('wk-ed-body')
    if (!body) return
    wkLiveReset() // 新文件的实时同步从不带旧文件的暂停/两次确认态开始
    const seq = ++edSeq
    // 立刻认下新 (proj,path)：并发重渲（切项目那一刻）不得拿旧 wkEdFile 命中缓存渲染上个项目的内容
    wkEdProj = state.workProj
    wkEdFile = ''
    wkEdConflict = false
    wkPdfClose()
    if (IMG_EXT.test(p)) {
      wkEdFile = p
      wkEdMeta = { isImg: true, editable: false }
      wkEdText = ''
      wkEdMtime = null
      renderEdBody()
      return
    }
    // PDF（2026-10-24 改 pdf.js）：读原始字节交给 work-pdf.js 真实渲染（页导航/缩放/文本层，
    // 对齐 dsh 文档预览）。渲染自闭环在分支内（不进 renderEdBody），不占用 wkEdMeta 状态；
    // 网关读侧 4 MB 上限对 PDF 同样生效，超限显式提示。
    if (/\.pdf$/i.test(p)) {
      wkEdFile = p
      wkEdMeta = { isImg: false, editable: false, view: 'pdf' } // view ⇒ 后续 renderEdBody 不覆盖已渲好的页栈
      wkEdText = ''
      wkEdMtime = null
      body.innerHTML = '<div class="wk-ed-empty">读取中…</div>'
      try {
        const res = await fetch(fileUrl(p))
        if (seq !== edSeq) return
        if (!res.ok) {
          if (res.status === 404) return wkDropDeadFile(p)
          wkEdMeta = { isImg: false, editable: false } // 错误态无视图，renderEdBody 落提示
          body.innerHTML =
            '<div class="wk-ed-empty">' +
            esc(res.status === 413 ? 'PDF 超过 4 MB，网关读取上限内不支持预览' : `读取失败（HTTP ${res.status}）`) +
            '</div>'
          return
        }
        const buf = await res.arrayBuffer()
        if (seq !== edSeq) return
        // 该文件上次的滚动位置（切到别的 tab 再切回 = 重新载入，页栈重建后写回）
        await wkPdfRender(body, p, buf, wkEdScrollMemo.get(state.workProj + '\u0000' + p))
      } catch (e) {
        if (seq !== edSeq) return
        body.innerHTML = `<div class="wk-ed-empty">读取失败：${esc(e.message || e)}</div>`
      }
      return
    }
    // Office 只读预览（2026-10-24）：xlsx/docx 二进制包交给 work-doc.js 解包渲染（不走文本分支，
    // 否则 content-type 判成二进制直接「不支持预览」）。网关读侧 4 MB 上限同样生效。
    if (wkDocKind(p)) {
      wkEdFile = p
      wkEdMeta = { isImg: false, editable: false, view: 'doc' } // view ⇒ 后续 renderEdBody 不覆盖已渲好的视图
      wkEdText = ''
      wkEdMtime = null
      body.innerHTML = '<div class="wk-ed-empty">读取中…</div>'
      try {
        const res = await fetch(fileUrl(p))
        if (seq !== edSeq) return
        if (!res.ok) {
          if (res.status === 404) return wkDropDeadFile(p)
          wkEdMeta = { isImg: false, editable: false } // 错误态无视图，renderEdBody 落提示
          body.innerHTML =
            '<div class="wk-ed-empty">' +
            esc(res.status === 413 ? '文件超过 4 MB，网关读取上限内不支持预览' : `读取失败（HTTP ${res.status}）`) +
            '</div>'
          return
        }
        const buf = await res.arrayBuffer()
        if (seq !== edSeq) return
        wkDocRender(body, p, buf)
      } catch (e) {
        if (seq !== edSeq) return
        body.innerHTML = `<div class="wk-ed-empty">读取失败：${esc(e.message || e)}</div>`
      }
      return
    }
    body.innerHTML = '<div class="wk-ed-empty">读取中…</div>'
    try {
      const res = await fetch(fileUrl(p))
      if (seq !== edSeq) return
      if (!res.ok) {
        if (res.status === 404) return wkDropDeadFile(p)
        wkEdFile = p
        wkEdMeta = {
          isImg: false,
          editable: false,
          msg:
            res.status === 413
              ? '文件超过 4 MB，不支持编辑'
              : res.status === 403
                ? '该项目外的路径不可访问'
                : `读取失败（HTTP ${res.status}）`,
        }
        renderEdBody()
        return
      }
      const ct = (res.headers.get('content-type') || '').toLowerCase()
      const looksText = /^text\/|json|javascript|typescript|xml|svg|x-sh|csv|yaml/.test(ct) || MD_EXT.test(p)
      if (!looksText) {
        wkEdFile = p
        wkEdMeta = { isImg: false, editable: false, msg: `二进制文件（${ct || '未知类型'}），不支持预览` }
        renderEdBody()
        return
      }
      const text = await res.text()
      if (seq !== edSeq) return
      const etag = res.headers.get('etag')
      let mtime = etag ? Number(etag.replace(/"/g, '')) : NaN
      if (!Number.isFinite(mtime)) mtime = null
      wkEdFile = p
      wkEdText = text
      wkEdMeta = { isImg: false, editable: true }
      wkEdMtime = mtime
      wkEdDirty = false
      wkEdPendingDoc = text // 新文档灌入编辑器 + 热换语言（renderEdBody 消费）
      renderEdBody()
    } catch (e) {
      if (seq !== edSeq) return
      body.innerHTML = `<div class="wk-ed-empty">读取失败：${esc(e.message || e)}</div>`
    }
  }

  // 强制重拉磁盘版本（冲突「取消」分支 / 需放弃本地改动时用）
  async function wkEdReload() {
    if (!state.workFile) return
    const p = state.workFile
    wkEdFile = ''
    await readFile(p)
  }

  // 切文件 / 切项目 / 退 work 前 flush：把 pending 编辑立即落盘
  async function wkEdFlush() {
    if (wkEdTimer) {
      clearTimeout(wkEdTimer)
      wkEdTimer = 0
    }
    if (!wkEdDirty || wkEdConflict) return
    await wkEdSave({})
  }

  // 保存：默认带 baseMtime（磁盘已变 → 409，不静默覆盖）；force = 无基线强制覆盖。
  // 返回 'ok' | 'clean' | 'conflict' | 'error' | 'busy'：409 不再弹模态，统一标记后交给实时合并链
  // （work-live.js）——无重叠自动三方合并写回，只有真正重叠才落到非模态提示条。
  async function wkEdSave(opts) {
    const force = !!(opts && opts.force)
    if (!state.workFile || !state.workProj) return 'clean'
    if (wkEdSaving) return 'busy'
    if (!wkEdDirty && !force) return 'clean'
    const content = wkEdDocText() // 落盘 payload = 当前真源；**不**写进 wkEdText（那是磁盘基线，三方合并的 base）
    if (wkEdTimer) {
      clearTimeout(wkEdTimer)
      wkEdTimer = 0
    }
    wkEdSaving = true
    wkEdState('保存中…', 'dirty')
    let conflict = false
    try {
      const payload = {
        label: state.workProj,
        path: state.workFile,
        content,
        // 归因：CLI 撞车时能说出「web editor / 哪个 web 会话改的」（网关只做格式校验）。
        sid: state.currentHash || '',
      }
      if (!force && wkEdMtime !== null) payload.baseMtime = wkEdMtime
      const res = await fetch(apiUrl('/gateway/file/write'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.status === 409) conflict = true
      else {
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.ok) throw new Error(data.error || '保存失败')
        if (typeof data.mtime === 'number') wkEdMtime = data.mtime
        wkEdInvalidatePathCache() // 写盘成功 → 路径补全目录缓存失效（新文件/新目录要能补出来）
        wkEdText = content // 写盘成功才推进磁盘基线
        wkEdDirty = wkEdDocText() !== content // 保存期间又改了 → 留脏，下面续排程
      }
    } catch (e) {
      wkEdSaving = false
      wkEdState('保存失败', 'conflict')
      toast('保存失败：' + (e.message || e))
      return 'error'
    }
    wkEdSaving = false
    if (conflict) {
      wkEdConflict = true
      wkEdState('外部已修改', 'conflict')
      wkLiveKick() // 立即走实时合并链：能合就静默合并写回，重叠才提示
      return 'conflict'
    }
    wkEdConflict = false
    wkEdState()
    if (wkEdDirty) wkEdScheduleSave() // 保存期间又改了 → 续排程（wkEdState 先落地「未保存」）
    return 'ok'
  }

  // 打开一个文件（**唯一口**：侧栏文件树行 / 搜索浮窗行 / 顶栏文件 pill / 评论定位 / 预览卡 src-open 全走这里）。
  // 顶栏文件 pill 的多枚开放集由 applyPanes 兜底并入（`wkEnsureFileTab(state.workFile)`），故此处不必另加。
  async function openWorkFile(p) {
    if (!p) return
    if (p !== state.workFile) {
      // 切文件前先记住**旧文件**的滚动位置（键取自此刻仍有效的 state.workFile），再 flush 旧文件编辑
      wkEdCaptureScroll()
      if (wkEdDirty) await wkEdFlush()
    }
    state.workFile = p
    state.wkMainTab = 'file' // 点文件 = 明确要看内容 → 文件 tab 顶上来（不静默什么都不发生）
    saveWork()
    applyPanes()
    renderWorkBody()
    // 「用户打开了某文件」是一条**事实**，广播给当前工作项目的在场卡（Pj18 预览卡据此切到该篇 PDF）；
    // 内容判断（只认 .tex / 目录段推书稿名）由卡片自己定，宿主不替卡做过滤。带 label 限定 = 不跨项目串台。
    // 切激活项（点另一枚 pill）同样走这里 ⇒ 每次都重发一次；卡侧按路径去重，重复广播不会 reload。
    if (state.workProj) cardBus.broadcast({ label: state.workProj }, 'file-open', { path: p })
    await renderEditor() // 等文档真正进编辑器再返回（调用方据此在正确文档上定位行）
  }

  // 关一枚文件 tab（顶栏文件 pill 的 ×，p = 该 pill 的路径）：从开放集 state.wkFiles 移除。关的是
  // **激活项** → 切右邻 / 左邻（落点语义同 wkCloseTab）；一枚不剩 → 清 workFile、下沉格回聊天 tab
  // （「聊天 / 文件 / 预览至少一栏」由 applyPanes 保底）。非激活 tab 没有文档态（单编辑器模型，切前
  // flush），故只有关激活项才需要落盘 pending 编辑——绝不因关 tab 丢改动。
  async function closeWkFile(p) {
    const i = state.wkFiles.indexOf(p)
    if (i < 0) return
    state.wkFiles.splice(i, 1)
    if (p !== state.workFile) { applyPanes(); return } // 关非激活项：只少一枚 pill，文档与路由不动
    if (wkEdDirty) await wkEdFlush()
    const next = state.wkFiles[i] != null ? state.wkFiles[i] : state.wkFiles[i - 1]
    if (next != null) return openWorkFile(next) // 切到邻枚：载入 + 广播 file-open，预览卡跟着切
    state.workFile = ''
    state.wkMainTab = 'chat'
    saveWork()
    renderEditor()
    renderWorkBody()
    applyPanes()
  }
