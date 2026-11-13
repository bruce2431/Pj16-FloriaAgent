// 应用 / 预览卡 / 外部卡图标的唯一解析处（2026-11-13）：icon 字段两种形态——
//   ① @floria/web 图标表键（`I[名]`，既有写法，内置表仍是唯一视觉真源）；
//   ② 声明文件所在目录内的相对图片路径（logo.svg / icons/logo.png，svg/png/jpg/jpeg/webp/gif/ico）。
// 都不命中回落 plug。外部申报（preview.json / card.json / postMessage）可能在未授权设备被读到，
// 因此这里对路径做与 isExtPath 同款的白名单校验：禁绝对路径、反斜杠、协议、query/片段、`.`/`..` 段。
import { I } from './icons.js'
/* @module core/icon-spec.js */
  const ICON_EXT_RE = /\.(svg|png|jpe?g|webp|gif|ico)$/i
  function isIconPath(spec) {
    if (typeof spec !== 'string' || !spec || spec.length > 200) return false
    if (!ICON_EXT_RE.test(spec)) return false
    if (spec.startsWith('/') || spec.includes('\\') || spec.includes('?') || spec.includes('#')) return false
    if (spec.includes(':')) return false
    return spec.split('/').every((s) => s && s !== '.' && s !== '..')
  }
  // 图标 HTML：表键 → 现成 SVG 字符串；相对图片 → <img class="app-ico">（base = /preview/<label>/<目录>/）。
  // 空 spec / 非法路径 → plug。
  function iconHtml(spec, base) {
    if (typeof spec === 'string' && Object.prototype.hasOwnProperty.call(I, spec) && I[spec]) return I[spec]
    if (isIconPath(spec) && typeof base === 'string' && base) {
      const src = base + spec.split('/').map(encodeURIComponent).join('/')
      return `<img class="app-ico" src="${src}" alt="">`
    }
    return I.plug
  }
  // preview.json 卡（path 相对 preview 根）→ 图标目录前缀：与卡页同目录。
  function iconBaseFor(label, relPath) {
    if (!label) return ''
    const raw = typeof relPath === 'string' ? relPath : ''
    const i = raw.indexOf('#')
    const file = i >= 0 ? raw.slice(0, i) : raw
    const segs = file.split('/')
    segs.pop() // 去掉文件名，保留其所在目录
    const dir = segs.filter(Boolean).map(encodeURIComponent).join('/')
    return `/preview/${encodeURIComponent(label)}/${dir ? dir + '/' : ''}`
  }
  // card.json 卡（目录即卡）→ 图标目录前缀。
  function iconBaseForCardDir(label, cardId) {
    if (!label || !cardId) return ''
    return `/preview/${encodeURIComponent(label)}/${encodeURIComponent(cardId)}/`
  }

export {
  iconBaseFor,
  iconBaseForCardDir,
  iconHtml,
  isIconPath,
}
