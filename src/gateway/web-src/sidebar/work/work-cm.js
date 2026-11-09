// 编辑区 CodeMirror 引擎适配层：CM6 能力全在 @floria/cm6 包（window.FloriaCM6.createWorkEditor），
// 本件只保留宿主状态（文件/脏态/保存基线/评论面板）并把包实例包装成既有 wkEd* 符号，供 work-editor.js 等调用。
/* @module sidebar/work/work-cm.js */
  // ---------- 编辑区宿主状态（主区左栏） ----------
  // 所有可编辑文本文件（markdown 与代码/纯文本一视同仁）都是常驻 CodeMirror 6 编辑器：整篇恒可编辑，
  // 无阅读/编辑两态、无模式按钮；markdown 走 Obsidian 式 Live Preview，其余按扩展名加载语言高亮。
  // 真源 = EditorView.state.doc（wkEdText 仅作上次落盘基线）。
  // 保存 = 停止输入 1s 自动（去抖）+ Ctrl+S 立即；写回带 ETag 基线 wkEdMtime，外部改过 → 409，不静默覆盖。
  let wkEdFile = ''     // 已载入编辑缓冲的路径（与 wkEdMeta/wkEdText 同拍）；'' = 未载入
  let wkEdMeta = null   // { isImg, editable, msg? }；null = 未载入
  let wkEdText = ''     // 上次落盘/读入的文件正文（实时真源在编辑器 doc；保存基线）
  let wkEdMtime = null  // 读侧 ETag 解析的 mtime（毫秒），写回冲突基线；null = 无
  let wkEdDirty = false
  let wkEdTimer = 0
  let wkEdSaving = false
  let wkEdConflict = false
  let wkCmtScrollId = '' // 评论面板定位跳转待消费的评论 id（渲染完原文标记后滚到该行）
  let wkEdPendingDoc = null // 待灌入编辑器的新文档（readFile 置位；renderEdBody 消费后清空）

  function fileUrl(p) {
    return apiUrl(`/gateway/file?label=${encodeURIComponent(state.workProj)}&path=${encodeURIComponent(p)}`)
  }

  // ---------- CM6 引擎实例（包内惰性建单 view，跨文件复用） ----------
  const wkEditor = FloriaCM6.createWorkEditor({
    apiUrl: (p) => apiUrl(p),
    getWorkProj: () => state.workProj,
    getWorkFile: () => wkEdFile,
    isEditable: () => !!(wkEdMeta && wkEdMeta.editable),
    mdInlineText: (nodes) => mdInlineText(nodes),
    getCanvasExt: (CM, hlStyle) => wkCvExt(CM, hlStyle),
    onUserEdit: () => { wkEdDirty = true; wkEdState(); wkEdScheduleSave() },
    paste: {
      clipboardFiles: (cd) => clipboardFiles(cd),
      clipboardImageUrls: (html) => clipboardImageUrls(html),
      addImageFiles: (f, t, wf) => addImageFiles(f, t, wf),
      addUploadFiles: (f, t, wf) => addUploadFiles(f, t, wf),
      addImageUrls: (u, t, wf) => addImageUrls(u, t, wf),
    },
  })

  // 当前正文真源文本 = 编辑器文档（无编辑器则回退基线）。
  function wkEdDocText() {
    const view = wkEditor.getView()
    return view ? view.state.doc.toString() : wkEdText
  }
  function wkEdEnsureView() { return wkEditor.ensureView() }
  function wkEdSetLang(path) { wkEditor.setLang(path) }
  function wkEdSetDoc(text) { wkEditor.setDoc(text) }
  // 外部磁盘内容落进编辑器（最小段替换 + 不进 undo 栈 + 不记脏）；false = IME 组合中，调用方下轮重试
  function wkEdApplyRemote(text) { return wkEditor.applyRemote(text) }
  function wkEdApplyMarks(marks) { wkEditor.applyMarks(marks) }
  function wkEdScrollToLine(n) { wkEditor.scrollToLine(n) }
  function wkEdQuoteLines(range) { return wkEditor.quoteLines(range) }
  function wkEdInvalidatePathCache() { wkEditor.invalidatePathCache() }
  function wkEdGetView() { return wkEditor.getView() }

  // 去抖自动保存（冲突未决时暂停，交 Ctrl+S 显式处置，避免覆盖外部改动）。
  // 2026-10-25 补回：CM6 包化（v3.45.0）把本函数连同 updateListener 一起删了，而 onUserEdit 与
  // wkEdSave 结尾仍在调用 ⇒ 每次编辑抛 ReferenceError，自动保存永不排程（iPad 无 Ctrl+S 则完全无法落盘）。
  function wkEdScheduleSave() {
    if (wkEdConflict) return
    if (wkEdTimer) clearTimeout(wkEdTimer)
    wkEdTimer = setTimeout(() => { wkEdTimer = 0; wkEdSave({}) }, WK_SAVE_MS)
  }
