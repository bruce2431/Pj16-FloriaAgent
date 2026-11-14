// 元素声明数据层（2026-11-13；唯一手改处，web/app.js 为生成物）
// 数据源 = GET /gateway/mention-elements?label=<项目>（无 label = 便携根 preview，全局上下文）。
// 声明来自预览页（preview.json 顶层 elements[] + 各卡 card.json 的 elements[]），网关扫描校验；
// 本层只取数与缓存，不解释元素语义（selectMentionItem 按声明 insert 落地）。

import { needToken, apiUrl } from '../../engine/gateway.js'
/* @module inputbar/toolbar/elements.js */
  // 按上下文缓存（'' = 全局）：{list, title, loaded, loading, err}。同一 label 只发一次请求，
  // 在途复用同一 Promise，失败记 err 并在下次调用时重试——与 mgr-data 的项目技能缓存同范式。
  // title = 预览页声明的入口名（preview.json 的 elementsTitle），空串由消费点回落「元素」。
  const PROJ_ELEMENTS = new Map()
  function projElementsOf(label) {
    const key = label || ''
    let r = PROJ_ELEMENTS.get(key)
    if (!r) {
      r = { list: [], title: '', loaded: false, loading: false, err: '' }
      PROJ_ELEMENTS.set(key, r)
    }
    return r
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

export { ensureProjectElements, projElementsOf }
