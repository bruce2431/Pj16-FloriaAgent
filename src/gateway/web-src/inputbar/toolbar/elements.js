// 元素声明数据层（2026-11-13；唯一手改处，web/app.js 为生成物）
// 数据源 = GET /gateway/mention-elements?label=<项目>（无 label = 便携根 preview，全局上下文）。
// 声明来自预览页（preview.json 顶层 elements[] + 各卡 card.json 的 elements[]），网关扫描校验；
// 本层只取数与缓存，不解释元素语义（selectMentionItem 按声明 insert 落地）。

import { needToken, apiUrl } from '../../engine/gateway.js'
/* @module inputbar/toolbar/elements.js */
  // 按上下文缓存（'' = 全局）：{list, title, icon, loaded, loading, err}。同一 label 只发一次请求，
  // 在途复用同一 Promise，失败记 err 并在下次调用时重试——与 mgr-data 的项目技能缓存同范式。
  // title / icon = 预览页声明的入口名与图标（preview.json 的 elementsTitle / elementsIcon），
  // 空串由消费点回落「元素」/ chip。
  const PROJ_ELEMENTS = new Map()
  function projElementsOf(label) {
    const key = label || ''
    let r = PROJ_ELEMENTS.get(key)
    if (!r) {
      r = { list: [], title: '', icon: '', loaded: false, loading: false, err: '' }
      PROJ_ELEMENTS.set(key, r)
    }
    return r
  }
  // 卡启用态变化后丢弃该上下文的缓存：元素清单随声明卡启用态变（停用即不再下发），
  // 下次打开「+」/ @ 时重拉，入口随之下线或上线。
  function invalidateProjectElements(label) {
    PROJ_ELEMENTS.delete(label || '')
  }
  // 卡/应用启停成功后由写口广播（engine/ext-runtime.js 与 work-plugins.js 派发）：
  // 元素清单随声明卡启用态变，缓存必须同拍作废，否则入口会在停用后继续出现。
  if (typeof window !== 'undefined') {
    window.addEventListener('floria-cards-changed', (e) => {
      invalidateProjectElements((e && e.detail && e.detail.label) || '')
    })
  }
  function ensureProjectElements(label) {
    const r = projElementsOf(label)
    if (r.loaded || r.loading || needToken()) return Promise.resolve(r.list)
    r.loading = true
    r.err = ''
    const qs = label ? '?label=' + encodeURIComponent(label) : ''
    return fetch(apiUrl('/gateway/mention-elements' + qs))
      .then((res) => res.json())
      .then((data) => {
        if (!data || !Array.isArray(data.elements)) throw new Error((data && data.error) || 'bad response')
        r.list = data.elements
        r.title = typeof data.title === 'string' ? data.title : ''
        r.icon = typeof data.icon === 'string' ? data.icon : ''
        r.loaded = true
        return r.list
      })
      .catch((e) => {
        r.err = (e && e.message) || String(e)
        return r.list
      })
      .then((list) => {
        r.loading = false
        return list
      })
  }

export { ensureProjectElements, invalidateProjectElements, projElementsOf }
