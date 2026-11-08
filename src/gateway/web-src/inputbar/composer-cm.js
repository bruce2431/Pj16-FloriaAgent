// CM6 接管底栏输入框（2026-10-24 收口到 @floria/cm6 包：本件只剩宿主适配）。
// **doc 单真源 = EditorState.doc**：序列化令牌原文直接进 doc，包内扫描插件按令牌起止加原子 replace
// 装饰渲成 chip。接缝签名与语义冻结：composerDocText = doc.toString()、composerSetText = 全文替换——
// 消费链（send/mention/quote/commands/ctx-meter/live）只认这两口。
// 包产物 /cm6/floria-cm6.iife.js 先于 app.js 同步加载（window.FloriaCM6），编辑器逻辑零复制。
import { activateMention, mentionTargetFromSpec } from '../feature/mention-nav.js'
/* @module inputbar/composer-cm.js */
  // cmView = 包内 composer 视图的共享镜像：mention.js 等模块直接读它（旧实现由本件声明）。
  // 包实例在 mount() 建视图，之后只有 ensure()；此处保持同步，勿改成局部变量。
  let cmView = null
  const composer = FloriaCM6.createComposer({
    parent: $('cm-host'),
    setInputEl: (el) => { inputEl = el },
    toast,
    send: () => gwSend(),
    gate: {
      isAwait: () => gateAwait,
      submit: () => gateSubmit(),
    },
    cmd: {
      isOpen: () => cmd.open,
      move: (d) => cmdMove(d),
      select: () => cmdSelect(),
      close: () => closeCmdPop(),
      render: () => renderCmdPop(),
    },
    model: {
      isOpen: () => msel.open,
      escape: () => modelEscape(),
      move: (d) => mselMove(d),
    },
    mention: {
      isOpen: () => mention.open,
      move: (d) => moveMentionSel(d),
      select: () => selectMention(),
      close: () => closeMentionPop(),
      update: () => onInputMention(),
      compositionEnd: () => onCompositionEnd(),
    },
    chips: {
      build: (kind, name, sid, ptype) => buildMentionChip(kind, name, sid, ptype),
      splitSession: (v) => splitSessionToken(v),
      fileIcon: (p) => fileIcon(p),
      iconReply: I.msg,
      esc: (s) => esc(s),
      decodeQuoteBody: (s) => decodeQuoteBody(s),
      foldQuoteBodies: (t) => foldQuoteBodies(t),
      // chip 点击 → 统一派发器（会话/文件/目录/插件/引用各自的跳转落点只由 feature/mention-nav.js 决定）
      activate: (spec) => activateMention(mentionTargetFromSpec(spec)),
    },
    paste: {
      clipboardFiles: (cd) => clipboardFiles(cd),
      clipboardImageUrls: (html) => clipboardImageUrls(html),
      addImageFiles: (f) => addImageFiles(f),
      addUploadFiles: (f) => addUploadFiles(f),
      addImageUrls: (u) => addImageUrls(u),
    },
    docChanged: () => syncGwSend(),
  })
  composer.mount()
  cmView = composer.getView()

  // ---------- 公开 API（接缝不变，转调包实例） ----------
  function composerDocText() { return composer.docText() }
  function composerSetText(text) { composer.setText(text) }
  function composerAppendToken(text) { composer.appendToken(text) }
  function composerAppendRef(token) { composer.appendRef(token) }
  function composerAppendText(text) { composer.appendText(text) }
  function composerReplaceRange(from, to, ins) { composer.replaceRange(from, to, ins) }
  function composerFocus() { composer.focus() }
  function composerBlur() { composer.blur() }
  function composerSetEditable(on) { composer.setEditable(on) }
  function composerPlaceholder(text) { composer.placeholder(text) }

export {
  composerAppendRef,
  composerAppendText,
  composerAppendToken,
  composerBlur,
  composerDocText,
  composerFocus,
  composerPlaceholder,
  composerReplaceRange,
  composerSetEditable,
  composerSetText,
}
