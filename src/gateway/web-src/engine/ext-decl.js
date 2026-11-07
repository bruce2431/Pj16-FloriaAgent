// 外部卡 / 浮窗动作申报的纯校验与 URL 构造（2026-10-10 自 views/cards/ext/ext-card.js 下移为 engine 层）：
// 纯字符串/数据函数（无 DOM、无状态、无订阅），供 engine/registry.js（外部卡 / 应用 tab 的表编排）与
// feature/preview-frame.js（申报同步）共用——渲染实现（iframe 壳 mountExtCard）留在 views，
// 契约链路归 engine，engine 永不 import views。extCardSrc 取网关 token（engine→engine 合法）。
// 唯一手改处，web/app.js 为生成物。

import { gToken } from './gateway.js'
/* @module engine/ext-decl.js */
  // 卡片字段校验（唯一一份）：preview.json 来源在网关已校过一遍，但 postMessage 这条不经过网关，
  // 必须同款再校——两条来源共用本函数，不给两处各写一套。host 只认 view（本版唯一定义的位置）。
  function normExtCards(raw) {
    return (Array.isArray(raw) ? raw : [])
      .filter((c) => c && typeof c === 'object' && !Array.isArray(c))
      .map((c) => ({
        id: typeof c.id === 'string' ? c.id.trim() : '',
        title: typeof c.title === 'string' ? c.title.trim() : '',
        icon: typeof c.icon === 'string' && c.icon ? c.icon : 'plug',
        path: typeof c.path === 'string' ? c.path.trim() : '',
        host: typeof c.host === 'string' ? c.host : '',
        tab: c.tab !== false,
        repo: typeof c.repo === 'string' ? c.repo.trim() : '',
        // 启用态由网关按目录标记下发（缺省 = 启用）；postMessage 来源无此字段 ⇒ 恒启用
        enabled: c.enabled !== false,
      }))
      .filter((c) => /^[a-zA-Z0-9_-]{1,32}$/.test(c.id) && c.title && c.host === 'view' && isExtPath(c.path))
  }
  // 浮窗动作字段校验（2026-09-28，与 normExtCards 同款风格）：preview.json 的 quoteActions 段。
  // 动作是**纯数据**（无 path / host，不指向文件）——宿主只渲染动作行，点击把 id 回发预览页。
  // id 非法 / 重名、title 空 → 丢（不猜不兜底）；icon 缺省 plug。整个 quoteActions 缺失 = 空集。
  function normQuoteActions(raw) {
    const seen = new Set()
    return (Array.isArray(raw) ? raw : [])
      .filter((a) => a && typeof a === 'object' && !Array.isArray(a))
      .map((a) => ({
        id: typeof a.id === 'string' ? a.id.trim() : '',
        title: typeof a.title === 'string' ? a.title.trim() : '',
        icon: typeof a.icon === 'string' && a.icon ? a.icon : 'plug',
      }))
      .filter((a) => {
        if (!/^[a-zA-Z0-9_-]{1,32}$/.test(a.id) || !a.title || seen.has(a.id)) return false
        seen.add(a.id)
        return true
      })
  }
  // 资源路径必须是 preview 目录内的相对文件路径（绝对路径 / 反斜杠 / query / 空段 / `.` `..` 段
  // 一律拒；允许尾随 #片段）。与网关 isPreviewRelPath 同款规则——网关侧挡 preview.json 来源，
  // 这里挡 postMessage 来源，两条外部输入各自守门。
  function isExtPath(p) {
    if (!p || p.startsWith('/') || p.includes('\\') || p.includes('?')) return false
    const i = p.indexOf('#')
    const file = i >= 0 ? p.slice(0, i) : p
    let rel
    try { rel = decodeURIComponent(file) } catch { return false } // 非法 % 序列
    if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.includes('?')) return false
    return rel.split('/').every((s) => s && s !== '.' && s !== '..')
  }
  // 卡页 URL：/preview/<label>/<path>（+token 供未授权设备首链；#片段原样带上，由卡页自我定位）
  function extCardSrc(label, card) {
    const i = card.path.indexOf('#')
    const file = i >= 0 ? card.path.slice(0, i) : card.path
    const frag = i >= 0 ? card.path.slice(i) : ''
    const q = gToken ? '?token=' + encodeURIComponent(gToken) : ''
    return `/preview/${encodeURIComponent(label)}/${file}${q}${frag}`
  }

export {
  extCardSrc,
  isExtPath,
  normExtCards,
  normQuoteActions,
}
