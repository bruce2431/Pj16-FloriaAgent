// 附件链（统一上传服务）：上传（粘贴/拖拽/+ 浮窗）→ POST /gateway/upload（原始字节），
// 网关按槽位决定落点与正文引用，响应 reference 为空 = 该类型没有正文槽位（会话附件）。
// 命名（时间戳 / -1/-2）与引用语法全在网关，本前端**不判扩展名、不拼目录、不拼引用**：
//   ① 上传 → ② response.reference 非空则插正文 → ③ scope=session 进附件胶囊行（待发）。
// **正文引用落点按 target 分**：
//   · 底栏 composer：图片进附件胶囊行（`#img-pills`，视觉上行必须有缩略图回显）；文件**不进胶囊**，
//     直接以路径引用令牌（`[@文件:路径]`）插进输入框正文——文件在正文里就是一枚可点 chip。
//   · work 编辑卡：插正文引用（图片 `![名](file-cache/…)` 行内直渲 editor-attachments、文件同链）——
//     编辑卡是文档面，正文引用即内容；该文件类型没有文档槽位时网关回落 session 并带 fallback 标记。
//   · @ 浮窗「上传」组：把本次已上传附件插回正文（mention.js 消费 uploadedMentionItems）——正文引用此路可达。
// 发送链不变量原样保留：pendingImages/pendingFiles 仍是发送链内部态（send.js 消费：[Image #N] 占位 +
// images base64 视觉上行 / [文件:占位] 相对化上行），与正文是否插引用无关。
import { toast, esc } from '../core/util.js'
import { syncGwSend } from './send.js'
import { mentionPathToken } from '../core/mention-syntax.js'
import { composerAppendToken } from './composer-cm.js'
/* @module inputbar/images.js */
  // ---------- 视觉上行内部态 ----------
  // pendingImages: {content(base64 无前缀), mediaType, filename, dataUrl, attName?, attRel?}。发送时文本拼
  // [Image #N] 占位 + images 随 'send' 上行 → 网关透传 → CLI gatewayClient 构造 pastedContents（不落盘、
  // 执行时 resize）。attName/attRel = 同次上传落盘后的文件名与引用键（落盘失败则无，胶囊照显、@ 不可引用）。
  let pendingImages = []
  function clearPendingImages() {
    pendingImages = []
    renderImgPills()
    syncGwSend()
  }
  // pendingFiles: {name, rel, abs, size}（落盘文件）。发送时文本拼 [文件:<路径>] 占位随消息上行
  // （CLI 端即普通文本，模型按路径 Read）。
  let pendingFiles = []
  function clearPendingFiles() {
    pendingFiles = []
    syncGwSend()
  }
  // ---------- 附件胶囊行（#img-pills）：待发图片的可见回显（待办 6 还原）----------
  // 只有图片缩略图（文件走正文引用 chip，不再出文件卡），× 从 pendingImages 摘除并重渲。
  // 一次绑定（dataset.bound）防重复挂监听；元素可能随后才入 DOM，故 renderImgPills 每次调用都补绑。
  function onPillRemove(e) {
    const b = e.target && e.target.closest ? e.target.closest('.img-x') : null
    if (!b) return
    if (b.dataset.i != null && b.dataset.i !== '') pendingImages.splice(+b.dataset.i, 1)
    renderImgPills()
    syncGwSend()
  }
  function renderImgPills() {
    const box = $('img-pills')
    if (!box) return
    if (box.dataset.bound !== '1') { box.dataset.bound = '1'; box.addEventListener('click', onPillRemove) }
    if (!pendingImages.length) {
      box.hidden = true
      box.textContent = ''
      return
    }
    box.hidden = false
    box.innerHTML = pendingImages
      .map((p, i) => `<span class="img-pill"><img src="${p.dataUrl}" alt="${esc(p.filename)}"/><button class="img-x" data-i="${i}" type="button" aria-label="移除">×</button></span>`)
      .join('')
  }
  // @ 浮窗「上传」组的数据源（mention.js / commands.js 消费）：本次上传、可被正文引用的附件。
  // 形态 = {kind:'attref', attKind:'img'|'file', name, md}——md 即选中后写回 doc 的正文引用原文
  // （与自动插入同一形态）。kind 与首屏两个**上传动作行**（commands.js 的 imgpick/filepick）分开：
  // 动作行点开文件选择器，本行是「引用已上传件」，两者语义不同，不可共用一个 kind。
  function uploadedMentionItems() {
    const out = []
    for (const p of pendingImages) {
      if (p.attRel) out.push({ kind: 'attref', attKind: 'img', name: p.attName, md: `![${p.attName}](${encodeURI(p.attRel)})` })
    }
    for (const f of pendingFiles) out.push({ kind: 'attref', attKind: 'file', name: f.name, md: `[${f.name}](${encodeURI(f.rel)})` })
    return out
  }
  // 编码：≤1.5MB 且 png/jpg/webp 直传原 base64（截图文字不重压）；否则 canvas 重编码 jpeg
  // （长边 ≤1568 对齐 API 推荐输入、质量 0.85），把手机照片压到几百 KB 再走 WS。
  function encodeImg(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => {
        const dataUrl = String(r.result)
        if (file.size <= 1536 * 1024 && /^image\/(png|jpe?g|webp)$/.test(file.type)) {
          const mediaType = file.type === 'image/jpg' ? 'image/jpeg' : file.type
          return resolve({ content: dataUrl.split(',')[1], mediaType, filename: file.name || '图片', dataUrl })
        }
        const img = new Image()
        img.onload = () => {
          const MAX = 1568
          const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight))
          const w = Math.max(1, Math.round(img.naturalWidth * scale))
          const h = Math.max(1, Math.round(img.naturalHeight * scale))
          const cv = document.createElement('canvas')
          cv.width = w
          cv.height = h
          cv.getContext('2d').drawImage(img, 0, 0, w, h)
          const out = cv.toDataURL('image/jpeg', 0.85)
          resolve({ content: out.split(',')[1], mediaType: 'image/jpeg', filename: (file.name || '图片').replace(/\.[^.]+$/, '') + '.jpg', dataUrl: out })
        }
        img.onerror = () => reject(new Error('decode failed'))
        img.src = dataUrl
      }
      r.onerror = () => reject(new Error('read failed'))
      r.readAsDataURL(file)
    })
  }
  // 图片附件（粘贴/拖拽/+ 浮窗）：视觉上行 base64 入列（胶囊缩略图）+ 原文件上传（网关命名/落点）。
  // 正文引用按 target 分：composer 不插（只进胶囊）；work 插网关返回的 reference（槽位决定语法）。
  // 落盘失败时视觉上行仍有效（无 attName、@ 不可引用，发送链 [Image #N] 照旧上行）。
  // target = editorCommand 落点 id（'composer' 底栏 / 'work' 编辑卡片），缺省底栏
  // filePath = work 编辑卡片当前文件相对路径（kernel paste 钩子显式传入；composer 传空）。
  async function addImageFiles(files, target, filePath) {
    const tgtEd = target || 'composer'
    const toComposer = tgtEd === 'composer'
    const workPath = String(filePath || '')
    for (const f of files) {
      if (!/^image\//.test(f.type)) continue
      // 张数上限只约束底栏发送链（pendingImages 是发送态）；编辑卡正文引用不占名额
      if (toComposer && pendingImages.length >= 9) { toast('一次最多 9 张图片'); break }
      let enc
      try { enc = await encodeImg(f) } catch { toast('图片读取失败'); continue }
      // work 编辑卡 = 只落盘 + 写正文引用，**不写底栏 pending/胶囊**（旧实现会把编辑卡图片串进胶囊行）。
      const att = await uploadFile(f, { kind: 'image', workFile: toComposer ? '' : workPath })
      if (toComposer) {
        if (att) { enc.attName = att.name; enc.attRel = att.relativePath } // @ 浮窗可引用的键
        pendingImages.push(enc)
        // 底栏（composer）上传 = 只进胶囊行待发，**不自动往输入框正文插引用**。
        renderImgPills()
        continue
      }
      if (!att) continue
      if (att.reference) insertUploadReference(tgtEd, att)
      else toast(att.fallback
        ? '当前文件类型未配置正文上传槽位，已作为会话附件保存'
        : '已作为会话附件保存（该槽位无正文引用）')
    }
    if (toComposer) syncGwSend()
  }
  // 文件附件（+ 浮窗「上传文件」/粘贴）：上传 → 底栏把路径引用 chip 插进正文（不再出文件胶囊）；
  // 编辑卡插网关返回的 reference（文档槽位没有该类型时回落 session 并 toast）。
  async function addUploadFiles(files, target, filePath) {
    const tgtEd = target || 'composer'
    const toComposer = tgtEd === 'composer'
    const workPath = String(filePath || '')
    for (const f of files) {
      toast('正在上传 ' + (f.name || '文件') + '…')
      const att = await uploadFile(f, { kind: 'file', workFile: toComposer ? '' : workPath })
      if (!att) continue
      if (toComposer) {
        // 底栏文件 = 正文里的一枚路径引用 chip（可点跳转、可右键），上传本身与落盘不变。
        composerAppendToken(mentionPathToken(att.relativePath, 'file'))
      } else if (att.reference) {
        insertUploadReference(tgtEd, att)
      } else {
        toast(att.fallback
          ? '当前文件类型未配置正文上传槽位，已作为会话附件保存'
          : '已作为会话附件保存（该槽位无正文引用）')
      }
      toast('已上传 ' + att.name)
    }
    if (toComposer) syncGwSend()
  }

// ---------- 剪贴板取图（2026-10-16：复制→粘到底栏成胶囊）----------
// 取剪贴板文件：cd.files 与 cd.items(kind==='file') 的并集。截图/从网页或别的应用复制的**位图**
// 只落在 items（异步 getAsFile），cd.files 为空——旧实现只读 cd.files，故这类粘贴走不到
// addImageFiles，胶囊行「完全不显示」（用户实测）。files 非空时以 files 为准（items 是其镜像，去重）。
function clipboardFiles(cd) {
  if (!cd) return []
  const files = Array.from(cd.files || [])
  if (files.length) return files
  const out = []
  for (const it of Array.from(cd.items || [])) {
    if (!it || it.kind !== 'file') continue
    const f = it.getAsFile()
    if (f) out.push(f)
  }
  return out
}
// 从剪贴板 text/html 里取**同源** <img> 的 URL（pathname+search）：消息区选中图片复制时
// editor-clipboard.copyRenderedImages 写的就是 `<img src="/gateway/file-cache/…">`。
// 只认同源（跨域取不到字节、data: 无意义）→ 交给 addImageUrls 拉回字节。
function clipboardImageUrls(html) {
  const s = String(html || '')
  if (!s || !/<img\b/i.test(s)) return []
  let doc
  try { doc = new DOMParser().parseFromString(s, 'text/html') } catch { return [] }
  const out = []
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const raw = img.getAttribute('src') || ''
    if (!raw || /^data:/i.test(raw)) continue
    let u
    try { u = new URL(raw, location.href) } catch { continue }
    if (u.origin !== location.origin) continue
    out.push(u.pathname + u.search)
  }
  return out
}
// 把同源图片 URL 拉回字节 → 合成 File → 复用 addImageFiles（编码/落盘/胶囊全链同路，
// 不另起一套）。取不到的图静默跳过（降级为「少一张」而非整次粘贴失败）。
async function addImageUrls(urls, target, filePath) {
  const list = Array.from(urls || [])
  if (!list.length) return
  const files = []
  for (const u of list) {
    try {
      const r = await fetch(u, { credentials: 'same-origin' })
      if (!r.ok) continue
      const b = await r.blob()
      if (!/^image\//.test(b.type)) continue
      const ext = (b.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
      files.push(new File([b], 'clipboard.' + ext, { type: b.type }))
    } catch { /* 跳过取不到的图 */ }
  }
  if (files.length) await addImageFiles(files, target, filePath)
}

export {
  addImageFiles,
  addImageUrls,
  addUploadFiles,
  clearPendingImages,
  clearPendingFiles,
  clipboardFiles,
  clipboardImageUrls,
  encodeImg,
  pendingImages,
  pendingFiles,
  renderImgPills,
  uploadedMentionItems,
}
