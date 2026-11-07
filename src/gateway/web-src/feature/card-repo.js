// 卡片上游仓库与版本（插件卡「应用」详情共用：work 项目卡片页 + chat 全局应用页）。
// 仓库是卡片元信息（preview.json cards[].repo / card.json 顶层 repo），详情页只读展示；
// 版本由网关 /gateway/repo-version 从上游拉取（Release → tag → package.json → 最新提交）。
// 唯一手改处，web/app.js 为生成物。

import { apiUrl } from '../engine/gateway.js'
import { esc } from '../core/util.js'
import { mdHtml } from '../core/markdown.js'
/* @module feature/card-repo.js */

  const VERSION_TTL_MS = 5 * 60 * 1000
  // 空结果（仓库不可访问/暂无版本）短缓存：网关换新或仓库补 tag 后重开详情即重拉，不卡满 5 分钟。
  const VERSION_EMPTY_TTL_MS = 30 * 1000
  const versionCache = new Map() // repo → { version, at }
  const versionPending = new Map() // repo → Promise

  const repoKey = (repo) => String(repo || '').trim()

  // 已缓存的版本（同步取；未拉过返回 ''）
  function cachedRepoVersion(repo) {
    const hit = versionCache.get(repoKey(repo))
    return hit ? hit.version : ''
  }

  // 拉一次上游版本（按 repo 去重）。完成后回调 onDone（调用方据此就地刷新版本行）。
  function ensureRepoVersion(repo, onDone) {
    const key = repoKey(repo)
    if (!key) return
    const hit = versionCache.get(key)
    if (hit && Date.now() - hit.at < (hit.version ? VERSION_TTL_MS : VERSION_EMPTY_TTL_MS)) return
    const pending = versionPending.get(key)
    if (pending) {
      if (onDone) pending.then(onDone)
      return
    }
    const p = fetch(apiUrl('/gateway/repo-version?repo=' + encodeURIComponent(key)))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((d) => { versionCache.set(key, { version: String((d && d.version) || ''), at: Date.now() }) })
      .catch(() => { versionCache.set(key, { version: '', at: Date.now() }) })
      .finally(() => { versionPending.delete(key) })
    versionPending.set(key, p)
    p.then(() => { if (onDone) onDone() })
  }

  // MgrUI.detail 的信息表由包渲染，无版本行句柄：按 dt 文字找到「版本」行就地回填。
  function fillVersionRow(body, repo) {
    const v = cachedRepoVersion(repo)
    if (!v || !body) return false
    for (const row of body.querySelectorAll('.mgr-dl-kvrow')) {
      const dt = row.querySelector('dt')
      if (dt && dt.textContent === '版本') {
        const dd = row.querySelector('dd')
        if (dd) { dd.textContent = v; return true }
      }
    }
    return false
  }

  // 信息表末尾的「上游仓库」只读行。只把 http(s) 渲成链接，用户输入不直进 href。
  function repoRowHtml(repo) {
    const safeRepo = /^https?:\/\/[^\s]+$/i.test(repo || '') ? repo : ''
    return '<div class="mgr-dl-kvrow mgr-repo-row"><dt>上游仓库</dt><dd class="mgr-repo-dd">' +
      (repo
        ? (safeRepo
          ? `<a class="mgr-repo-link" href="${esc(safeRepo)}" target="_blank" rel="noopener">${esc(repo)}</a>`
          : `<span class="mgr-repo-plain">${esc(repo)}</span>`)
        : '<span class="mgr-repo-empty">未填写</span>') +
      '</dd></div>'
  }

  // ---------- 上游 README（应用详情「介绍」，排在信息表下方） ----------
  const README_TTL_MS = 10 * 60 * 1000
  const README_EMPTY_TTL_MS = 60 * 1000
  const readmeCache = new Map() // repo → { text, name, at }
  const readmePending = new Map()

  // README 里的相对图片 / 相对链接换成 raw / blob 绝对地址（md 渲染只放行 http(s) 图片；
  // 相对链接在页面基址下会指向宿主路径，必须补成仓库内的 blob 地址）。
  function resolveReadmeAssets(text, repo) {
    const m = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/i.exec(repo || '')
    if (!m) return text
    const base = `https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/`
    const blob = `https://github.com/${m[1]}/${m[2]}/blob/HEAD/`
    return String(text)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (all, alt, src) => {
        if (/^(https?:)?\/\//i.test(src) || /^data:/i.test(src)) return all
        return `![${alt}](${base}${src.replace(/^\.?\//, '')})`
      })
      .replace(/(^|[^!])\[([^\]]*)\]\(([^)\s]+)\)/g, (all, pre, label, href) => {
        if (/^(https?:)?\/\//i.test(href) || /^(#|data:|mailto:)/i.test(href)) return all
        return `${pre}[${label}](${blob}${href.replace(/^\.?\//, '')})`
      })
  }

  // ---------- README 裸 HTML 兼容 ----------
  // GitHub 的 README 常用块级 HTML 排版（居中段落、徽章、图片表格）；纯 markdown 渲染会把标签整体转义成文本。
  // 按 GFM 口径切块：行首是白名单标签即进入 HTML 块，到空行止；块内按白名单标签/属性净化后直出，
  // 其余行仍交 mdHtml。相对 src/href 改写成 raw / blob 绝对地址。
  const README_TAGS = new Set(['p', 'div', 'span', 'center', 'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'code', 'pre',
    'a', 'img', 'picture', 'source', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
    'details', 'summary', 'kbd', 'figure', 'figcaption', 'video', 'audio'])
  const README_ATTRS = new Set(['href', 'src', 'alt', 'title', 'width', 'height', 'align', 'colspan', 'rowspan', 'target', 'rel', 'controls', 'type', 'start', 'media'])
  // 这些标签整棵丢弃（不是剥壳）：带执行/加载副作用，或会破坏页面布局。
  const README_DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'option', 'meta', 'link', 'base', 'svg', 'math', 'template'])
  const README_HTML_START = /^<([a-z][a-z0-9]*)\b/i

  function readmeRepoBase(repo) {
    const m = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/i.exec(repo || '')
    if (!m) return null
    return {
      raw: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/`,
      blob: `https://github.com/${m[1]}/${m[2]}/blob/HEAD/`,
    }
  }

  const readmeUrlOk = (u) => /^(https?:\/\/|#|\/|\.{0,2}\/)/i.test(u || '')

  // 白名单净化：未知标签剥壳留内容，危险标签整棵删；属性只留白名单且禁 on*；相对地址补仓库基址。
  // align 在标准模式对 p/div 无效，转成等价 text-align（表格单元格同样生效）。
  function sanitizeReadmeHtml(html, repo) {
    const base = readmeRepoBase(repo)
    const doc = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html')
    const cleanAttrs = (el) => {
      let align = ''
      for (const at of Array.from(el.attributes)) {
        const name = at.name.toLowerCase()
        const value = at.value
        if (!README_ATTRS.has(name) || name.startsWith('on')) { el.removeAttribute(at.name); continue }
        if (name === 'align') { align = value; el.removeAttribute('align'); continue }
        if (name !== 'href' && name !== 'src') continue
        if (!readmeUrlOk(value)) { el.removeAttribute(name); continue }
        if (/^https?:\/\//i.test(value) || value.startsWith('#')) continue
        if (!base) { el.removeAttribute(name); continue }
        const rel = value.replace(/^\.?\//, '').replace(/^\//, '')
        el.setAttribute(name, (name === 'src' ? base.raw : base.blob) + rel)
      }
      if (align) el.setAttribute('style', `text-align:${/^(center|right)$/i.test(align) ? align.toLowerCase() : 'left'}`)
    }
    const walk = (parent) => {
      for (const el of Array.from(parent.children)) {
        const tag = el.tagName.toLowerCase()
        if (README_DROP.has(tag)) { el.remove(); continue }
        if (!README_TAGS.has(tag)) {
          const kids = Array.from(el.childNodes)
          el.replaceWith(...kids)
          for (const n of kids) if (n.nodeType === 1) { cleanAttrs(n); walk(n) }
          continue
        }
        cleanAttrs(el)
        walk(el)
      }
    }
    walk(doc.body)
    return doc.body.innerHTML
  }

  // README 全文 → HTML：HTML 块直出（净化 + 绝对化），markdown 段交 mdHtml（图片同样绝对化）。
  function readmeToHtml(text, repo) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
    let out = ''
    let md = []
    let block = null
    const flushMd = () => { if (md.length) { out += mdHtml(resolveReadmeAssets(md.join('\n'), repo)); md = [] } }
    const flushBlock = () => { if (block) { out += sanitizeReadmeHtml(block.join('\n'), repo); block = null } }
    for (const line of lines) {
      if (block) {
        // GFM：HTML 块遇空行结束（空行本身回给 markdown 分段，保持段间距）
        if (!line.trim()) { flushBlock(); md.push(line) } else block.push(line)
        continue
      }
      const m = README_HTML_START.exec(line.trim())
      const tag = m ? m[1].toLowerCase() : ''
      if (tag && README_TAGS.has(tag)) { flushMd(); block = [line]; continue }
      md.push(line)
    }
    flushBlock()
    flushMd()
    return out
  }

  // sub = 仓库内子目录（市场 git-subdir / 市场自带条目）；与 repo 一起构成缓存键。
  function ensureRepoReadme(repo, sub, onDone) {
    const key = repoKey(repo)
    if (!key) return
    const cacheKey = sub ? `${key}::${sub}` : key
    const hit = readmeCache.get(cacheKey)
    if (hit && Date.now() - hit.at < (hit.text ? README_TTL_MS : README_EMPTY_TTL_MS)) return
    const pending = readmePending.get(cacheKey)
    if (pending) {
      if (onDone) pending.then(onDone)
      return
    }
    const p = fetch(apiUrl('/gateway/repo-readme?repo=' + encodeURIComponent(key) + (sub ? '&path=' + encodeURIComponent(sub) : '')))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((d) => { readmeCache.set(cacheKey, { text: String((d && d.text) || ''), name: String((d && d.name) || ''), at: Date.now() }) })
      .catch(() => { readmeCache.set(cacheKey, { text: '', name: '', at: Date.now() }) })
      .finally(() => { readmePending.delete(cacheKey) })
    readmePending.set(cacheKey, p)
    p.then(() => { if (onDone) onDone() })
  }

  let readmeStyleReady = false
  function ensureReadmeStyle() {
    if (readmeStyleReady) return
    readmeStyleReady = true
    const st = document.createElement('style')
    st.textContent = [
      '.mgr-readme-sec { margin-top: 28px; }',
      '.mgr-readme-body { margin-top: 12px; font-size: 14px; line-height: 1.8; color: var(--text); word-break: break-word; }',
      '.mgr-readme-body h1,.mgr-readme-body h2,.mgr-readme-body h3,.mgr-readme-body h4 { margin: 18px 0 8px; font-weight: 700; line-height: 1.4; color: var(--text); }',
      '.mgr-readme-body h1 { font-size: 22px; } .mgr-readme-body h2 { font-size: 18px; } .mgr-readme-body h3 { font-size: 15px; }',
      '.mgr-readme-body p { margin: 8px 0; }',
      '.mgr-readme-body ul,.mgr-readme-body ol { margin: 8px 0; padding-left: 1.5em; }',
      '.mgr-readme-body a { color: var(--blue); text-decoration: none; } .mgr-readme-body a:hover { text-decoration: underline; }',
      '.mgr-readme-body code { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; background: var(--active); border-radius: 4px; padding: 1px 5px; }',
      '.mgr-readme-body pre { margin: 10px 0; padding: 12px; background: var(--active); border-radius: 8px; overflow-x: auto; }',
      '.mgr-readme-body pre code { background: none; padding: 0; }',
      '.mgr-readme-body img { max-width: 100%; height: auto; border-radius: 8px; }',
      '.mgr-readme-body table { border-collapse: collapse; font-size: 13px; margin: 10px 0; }',
      '.mgr-readme-body th,.mgr-readme-body td { border: 1px solid var(--border); padding: 5px 9px; text-align: left; }',
      '.mgr-readme-body th { background: var(--rail-bg); font-weight: 600; }',
      '.mgr-readme-empty { margin-top: 12px; font-size: 13px; color: var(--text-2); }',
    ].join('\n')
    document.head.appendChild(st)
  }

  // 信息表（.mgr-dl-sec）之后追加「介绍」段并渲染 README；顶部原有介绍段删除（介绍下移）。
  // repo 为空 / 拉取失败时回退为卡片自带 desc，再没有则说明暂无。
  function renderRepoIntro(host, repo, fallbackDesc, sub) {
    if (!host) return
    const pane = host.querySelector('.mgr-detail') || host
    const topDesc = pane.querySelector('.mgr-dl-desc')
    if (topDesc) topDesc.remove()
    let sec = pane.querySelector('.mgr-readme-sec')
    if (!sec) {
      sec = document.createElement('div')
      sec.className = 'mgr-dl-sec mgr-readme-sec'
      const info = pane.querySelector('.mgr-dl-sec')
      if (info && info.parentNode) info.parentNode.insertBefore(sec, info.nextSibling)
      else pane.appendChild(sec)
    }
    const paint = () => {
      if (!sec.isConnected) return
      const hit = readmeCache.get(sub ? `${repoKey(repo)}::${sub}` : repoKey(repo))
      const text = hit ? hit.text : ''
      if (text) {
        const body = sec.querySelector('.mgr-readme-body') || sec.appendChild(document.createElement('div'))
        body.className = 'mgr-readme-body'
        body.innerHTML = readmeToHtml(text, repo)
      }
      const empty = sec.querySelector('.mgr-readme-empty')
      if (!text) {
        const msg = hit ? (fallbackDesc || '暂无介绍。') : '读取 README…'
        if (!empty) {
          const d = document.createElement('div')
          d.className = 'mgr-readme-empty'
          sec.appendChild(d)
        }
        sec.querySelector('.mgr-readme-empty').textContent = msg
      } else if (empty) empty.remove()
    }
    ensureReadmeStyle()
    sec.innerHTML = '<h3 class="mgr-dl-sech">介绍</h3>'
    paint()
    if (!repoKey(repo)) return
    ensureRepoReadme(repo, sub, paint)
  }

export {
  cachedRepoVersion,
  ensureRepoVersion,
  fillVersionRow,
  repoRowHtml,
  renderRepoIntro,
}
