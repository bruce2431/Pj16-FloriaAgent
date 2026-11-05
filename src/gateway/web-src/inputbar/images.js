// 附件链（2026-10-15 待办 13 改造；2026-10-16 待办 6 还原胶囊行；2026-10-16 待办 2 收口底栏口径）。
// 上传（粘贴/拖拽/+ 浮窗）→ 落盘（POST /gateway/file-cache：<项目根>/.claude/file-cache/<会话>/，与粘贴图片同目录；
// 落盘名 = 原名主体 + 时间戳 + 原扩展名）。网关返回 rel（`file-cache/<会话id>/<名>`）作为引用唯一键。
// **正文引用落点按 target 分**（2026-10-16 待办 2 定案）：
//   · 底栏 composer：**只进附件胶囊行**（`#img-pills`），不自动往输入框正文插 md 引用——胶囊即待发表达。
//   · work 编辑卡：插正文引用（图片 `![名](file-cache/…)` 行内直渲 editor-attachments.edAttImgPlugin、
//     文件 `[名](file-cache/…)` 链接）——编辑卡是文档面，正文引用即内容。
//   · @ 浮窗「上传」组：把本次已上传附件插回正文（mention.js 消费 uploadedMentionItems）——正文引用此路可达。
// 发送链不变量原样保留：pendingImages/pendingFiles 仍是发送链内部态（send.js 消费：[Image #N] 占位 +
// images base64 视觉上行 / [文件:占位] 相对化上行），与正文是否插引用无关。
import { toast, esc } from '../core/util.js'
import { I, fileIcon } from '../core/icons.js'
import { syncGwSend } from './send.js'
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
  // （CLI 端即普通文本，模型按路径 Read）；正文里的 `[名](file-cache/…)` 链接是同一次上传的引用表达。
  let pendingFiles = []
  function clearPendingFiles() {
    pendingFiles = []
    renderImgPills()
    syncGwSend()
  }
  // ---------- 附件胶囊行（#img-pills）：pending* 的可见回显（待办 6 还原）----------
  // 图片缩略图 + 文件卡同轨（CSS 见 styles.css #img-pills），× 从 pending* 数组摘除并重渲。
  // 一次绑定（dataset.bound）防重复挂监听；元素可能随后才入 DOM，故 renderImgPills 每次调用都补绑。
  function onPillRemove(e) {
    const b = e.target && e.target.closest ? e.target.closest('.img-x') : null
    if (!b) return
    if (b.dataset.i != null && b.dataset.i !== '') pendingImages.splice(+b.dataset.i, 1)
    else if (b.dataset.f != null && b.dataset.f !== '') pendingFiles.splice(+b.dataset.f, 1)
    renderImgPills()
    syncGwSend()
  }
  function renderImgPills() {
    const box = $('img-pills')
    if (!box) return
    if (box.dataset.bound !== '1') { box.dataset.bound = '1'; box.addEventListener('click', onPillRemove) }
    if (!pendingImages.length && !pendingFiles.length) {
      box.hidden = true
      box.textContent = ''
      return
    }
    box.hidden = false
    box.innerHTML =
      pendingImages
        .map((p, i) => `<span class="img-pill"><img src="${p.dataUrl}" alt="${esc(p.filename)}"/><button class="img-x" data-i="${i}" type="button" aria-label="移除">×</button></span>`)
        .join('') +
      pendingFiles
        .map((f, i) => `<span class="file-pill" title="${esc(f.abs)}"><span class="fp-ico">${fileIcon(f.name)}</span><span class="fp-name">${esc(f.name)}</span><button class="img-x" data-f="${i}" type="button" aria-label="移除">×</button></span>`)
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
  // 图片附件（粘贴/拖拽/+ 浮窗）：视觉上行 base64 入列（胶囊缩略图）+ 原文件上传落盘（时间戳名）。
  // 正文引用按 target 分：composer 不插（只进胶囊）；work 插 `![名](file-cache/…)`（CM 行内直渲）。
  // 落盘失败时视觉上行仍有效（无 attName、@ 不可引用，发送链 [Image #N] 照旧上行）。
  // target = editorCommand 落点 id（'composer' 底栏 / 'work' 编辑卡片），缺省底栏
  // filePath = work 编辑卡片当前文件相对路径（kernel paste 钩子传入；缺省读 state.workFile）。
  // 编辑卡片图片粘贴按扩展名分流（2026-11-02）：`.tex` → 落 <tex 目录>/image/ + `\includegraphics`；
  // `.md`/`.markdown` → 原 md 引用链；**其它扩展名不响应图片粘贴**（不落 file-cache、不插引用）。
  async function addImageFiles(files, target, filePath) {
    const tgtEd = target || 'composer'
    const toComposer = tgtEd === 'composer'
    const workPath = String(filePath || state.workFile || '')
    const isTex = !toComposer && /\.tex$/i.test(workPath)
    const isMd = !toComposer && /\.(md|markdown)$/i.test(workPath)
    const texNames = []
    for (const f of files) {
      if (!/^image\//.test(f.type)) continue
      // 张数上限只约束底栏发送链（pendingImages 是发送态）；编辑卡正文引用不占名额
      if (toComposer && pendingImages.length >= 9) { toast('一次最多 9 张图片'); break }
      let enc
      try { enc = await encodeImg(f) } catch { toast('图片读取失败'); continue }
      // 模块化分流（2026-10-21 待办）：work 编辑卡 = 只落盘 + 写正文引用，**不写底栏 pending/胶囊**。
      // 旧实现无论 target 都 push pendingImages + renderImgPills，导致编辑卡粘贴的图串进底栏胶囊行。
      if (!toComposer) {
        if (isTex) {
          // tex 图片落 tex 所在目录的 image/（网关递归建目录、同名 -1/-2 去重），正文插 includegraphics
          const slash = Math.max(workPath.lastIndexOf('/'), workPath.lastIndexOf('\\'))
          const dir = slash >= 0 ? workPath.slice(0, slash) : ''
          const att = await uploadProjectAttachment(f, state.workProj, dir ? dir + '/image' : 'image')
          if (att) texNames.push(att.name)
          continue
        }
        if (!isMd) continue // 编辑卡片仅 md / tex 响应图片粘贴
        const att = await uploadAttachment(f)
        if (att) insertAttachmentMarkdown(tgtEd, att)
        continue
      }
      const att = await uploadAttachment(f)
      if (att) { enc.attName = att.name; enc.attRel = att.rel } // @ 浮窗可引用的键（落盘成功才有）
      pendingImages.push(enc)
      // 底栏（composer）上传 = 只进胶囊行待发，**不自动往输入框正文插引用**（2026-10-16 待办 2：
      // 「不要自动在正文渲染，被图片胶囊劫持」）。
      renderImgPills()
    }
    if (texNames.length) insertTexImages(tgtEd, texNames) // 多张按原顺序，各一行 includegraphics
    if (toComposer) syncGwSend()
  }
  // 文件附件（+ 浮窗「上传文件」/粘贴）：上传落盘 → pendingFiles 入列（发送侧 [文件:占位] 自动相对化）
  // + 原文插 `[名](file-cache/…)` 文件名链接。落盘跟随会话（与粘贴图片同目录）：sid=当前会话（存量/
  // 已开）；首页尚无会话时 project=<workProj|newSessionProject()>——与 gwSend 首送建会话的归属参数同源，
  // 保证「上传落点的项目根 = 消息会话启动根」；两者皆无 → 网关自身根。
  async function addUploadFiles(files, target) {
    const tgtEd = target || 'composer'
    const toComposer = tgtEd === 'composer'
    for (const f of files) {
      toast('正在上传 ' + (f.name || '文件') + '…')
      const att = await uploadAttachment(f)
      if (!att) continue
      // 同 addImageFiles：底栏 = 只进附件胶囊行（不插正文，正文引用仅 @ 上传组显式选择时才写）；
      // 编辑卡 = 只写正文链接（不串底栏胶囊）。
      if (toComposer) { pendingFiles.push(att); renderImgPills() }
      else insertAttachmentMarkdown(tgtEd, att)
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
async function addImageUrls(urls, target) {
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
  if (files.length) await addImageFiles(files, target)
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
