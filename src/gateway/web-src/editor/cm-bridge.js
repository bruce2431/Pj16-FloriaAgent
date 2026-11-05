// Floria ↔ @floria/cm6 接缝（编辑器内核唯一真源 = 包；本件只注入宿主依赖 + 摊名字）。
/* @module editor/cm-bridge.js */
  // Floria 侧 CM6 接缝（2026-10-24 收口）：编辑能力全部在 @floria/cm6 包，产物
  // /cm6/floria-cm6.iife.js 先于 app.js 同步加载并挂 window.FloriaCM6。
  // 本件只做两件事：①注入宿主运行时依赖（toast/会话/markdown/esc 等，包内核禁止 import Floria 模块）；
  // ②把包内核符号摊进单 IIFE 共享作用域，其余 Floria 模块按原名取用。
  // 禁在 web-src 内复刻编辑器内核——原 web-src/editor/*.js 已整体移入包。
  if (!window.FloriaCM6) throw new Error('CM6 包未加载（/cm6/floria-cm6.iife.js 须先于 app.js）')
  FloriaCM6.configureEnv({
    toast: (m) => toast(m),
    newSessionProject: () => newSessionProject(),
    fileIcon: (p) => fileIcon(p),
    apiUrl: (p) => apiUrl(p),
    getContext: () => ({
      currentHash: state.currentHash,
      sbMode: state.sbMode,
      workProj: state.workProj,
      curUuid: live.curUuid,
    }),
    findSession: (u) => findSession(u),
    mdHtml: (s) => mdHtml(s),
    messageMd: (c) => messageMd(c),
    selectionMd: (s) => selectionMd(s),
    esc: (s) => esc(s),
  })
  const {
    edCMG, edCmg, cmMathExt,
    editorApiGet, editorApiRegister, editorApiSetActive, editorApiUnregister, editorCommand, makeEditorFacade,
    attachmentUrl, insertAttachmentMarkdown, insertTexImages, isDocumentAttachment, isImageAttachment,
    uploadAttachment, uploadProjectAttachment, edAttImgPlugin, edAttFilePlugin,
    copyRenderedImages, copyRenderedSelection,
    renderMarkdown, toggleTask,
    insertAtCursorCM, surroundExt, toggleTaskLineCM, wrapKeymap, wrapSelectionCM,
    edTaskPlugin, edBlockMarkPlugin,
  } = window.FloriaCM6
