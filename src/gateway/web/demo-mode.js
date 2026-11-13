/* 离线演示模式（?demo=1）：供预览卡以 iframe 内嵌真实前端时使用。
   作用：health 报非 gateway ⇒ 前端不建 WS、不启 token 门；fetch 垫片把网关数据请求换成
   demo-data.js 的静态数据；SSE 用空实现顶替。页面骨架 / 样式 / 组件布局仍是真实前端。 */
(function () {
  if (!/[?&]demo=1(&|$)/.test(location.search)) return
  const D = window.FLORIA_DEMO_DATA
  if (!D) return
  window.__FLORIA_DEMO__ = true

  // 演示帧与真实 UI 同源：localStorage 共享。用内存实现顶替，避免卡内切模式/主题改写用户真实界面状态。
  try {
    const mem = new Map()
    const fake = {
      getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : null),
      setItem: (k, v) => { mem.set(String(k), String(v)) },
      removeItem: (k) => { mem.delete(String(k)) },
      clear: () => mem.clear(),
      key: (i) => [...mem.keys()][i] ?? null,
      get length() { return mem.size },
    }
    Object.defineProperty(window, 'localStorage', { value: fake, configurable: true })
    Object.defineProperty(window, 'sessionStorage', { value: fake, configurable: true })
  } catch { /* 不可覆盖则忽略（状态可能外溢，界面仍可用） */ }

  const json = (body) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

  function reply(url) {
    const p = url.pathname
    if (p === '/gateway/health') return { ok: true, mode: 'demo', boot: 0 }
    if (p === '/gateway/sessions') return D.sessions
    if (p === '/gateway/session') return D.session
    if (p === '/gateway/models') return D.models
    if (p === '/gateway/project') return D.project
    if (p === '/gateway/preview-cards') return D.previewCards
    if (p === '/gateway/plugins') return D.plugins
    if (p === '/gateway/mention-elements') return { label: '', elements: [] }
    if (p === '/gateway/comments') return { comments: [] }
    if (p === '/gateway/fs') return { files: [], dirs: [] }
    if (p.startsWith('/gateway/')) return {}
    return undefined
  }

  const realFetch = window.fetch.bind(window)
  window.fetch = function (input, init) {
    let url
    try {
      url = new URL(typeof input === 'string' ? input : input.url, location.origin)
    } catch {
      return realFetch(input, init)
    }
    if (!url.pathname.startsWith('/gateway/')) return realFetch(input, init)
    const body = reply(url)
    return Promise.resolve(json(body === undefined ? {} : body))
  }

  // 后端实时信道：演示态无服务端，空实现顶替（前端已有 ?demo 守卫不再调用，双保险）。
  window.EventSource = class EventSource {
    constructor() { this.readyState = 0 }
    close() {}
    addEventListener() {}
    removeEventListener() {}
  }
  window.WebSocket = class WebSocket {
    constructor() { this.readyState = 3 }
    send() {}
    close() {}
  }
})()
