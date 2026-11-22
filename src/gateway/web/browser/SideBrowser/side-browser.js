/* 侧边浏览器卡 · 纯组件（零控制台依赖，定稿后可整体迁入目标项目）
 *
 * 浏览器只做浏览器：
 * - 标签页按网址计：open{url} 新开一个标签页；地址栏、起始页搜索/常用地址都在当前标签内导航；
 *   每个标签页有独立 iframe 与历史，前进 / 后退 / 刷新只作用于当前标签；
 * - 标签页可逐个 × 关闭，关掉最后一个时自动补一个起始页标签；
 * - 起始页（Edge 式）= 居中搜索栏 + 常用地址，移植自 SubPj5 app/，去掉仅该应用可用的「项目文件」。
 *
 * 对照 dsh = deepseek-ai/deepseek-harness 的 packages/client/ui-sidebar-browser：
 * - 地址白名单只收 http / https；无 scheme 补 https；拒绝 file:、data:、blob:、内嵌凭据、
 *   应用自身 origin、超过 16 KB 的地址；
 * - iframe 载体 + 固定 sandbox；
 * - 导航状态机 empty / loading / known / unknown：受控 revision 的第一次 load 视为 known，
 *   第二次及以后视为页面自行跳转、地址不可读 → unknown；
 * - 每个标签页有界应用历史 100 条；
 * - 不读取卡片配置、不做检查点恢复、不提供沙箱开关。
 *
 * 内部页（Config/tabs.json，2026-11-22）：
 * - 宿主可选传 configUrl（相对 Config/ 的路径，如 '/browser/Config/tabs.json'）；配置只声明内部页
 *   { pages: [{ id, title, url, ns?, openCmd? }] }，url 相对 Config/ 解析且不得越出该目录；
 * - `page{id, payload?}` 打开/复用该页标签页：iframe 加载同源页面，页面 ready 后把 payload 作为
 *   `<ns>-cmd {cmd: openCmd || 'fileopen', args: payload}` 发给它（幂等，重复调用只是重发）；
 * - 内部页不受 open/load 的 http(s) 白名单约束，也不放宽它；外部网址仍只走 open。
 *
 * 公开面：
 *   window.UIDesignSideBrowser = { mount, parseAddress, snapshotApi, MAX_URL_LENGTH, MAX_HISTORY, WEB_SANDBOX }
 *   mount(root, options) → controller
 *   controller 方法：open(url?) / load(url) / page(id, payload?) / back() / forward() / reload() /
 *                    close() / state() / dispatch(cmd, args) / destroy()
 *   宿主信封（iframe 内）：parent → <ns>-cmd {cmd, args}；回收 <ns>-event {ev:'ack', cmd, ok, result|error}
 *   内部页 → 组件：子 frame 的 <pageNs>-event（ready / ack），按 frame 对应标签页过滤。
 */
(function (global) {
  'use strict'

  var MAX_URL_LENGTH = 16 * 1024
  var MAX_HISTORY = 100
  var DEFAULT_WIDTH = 420
  var MIN_WIDTH = 220
  var WEB_SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox'
  var DEFAULT_NS = 'floria-side-browser'
  var INTERNAL_SANDBOX = 'allow-scripts allow-same-origin allow-forms'
  var DEFAULT_CONFIG_URL = ''

  var REASONS = {
    empty: '请输入网址',
    invalid: '网址格式无效',
    protocol: '只支持 http / https 地址',
    credentials: '地址不能包含用户名或密码',
    'application-origin': '不能打开应用自身地址'
  }

  var ICONS = {
    back: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.2 5.2 8 10 12.8"/></svg>',
    forward: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.2 10.8 8 6 12.8"/></svg>',
    reload: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.55"/><path d="M13 2.6v3h-3"/></svg>',
    go: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.4 8h9.2"/><path d="M9.2 4.4 12.8 8l-3.6 3.6"/></svg>',
    external: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.2 3.4H3.4v9.2h9.2V9.8"/><path d="M9.4 3.4h3.2v3.2"/><path d="M12.6 3.4 7.6 8.4"/></svg>',
    mag: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.6"/><path d="m10.5 10.5 3 3"/></svg>',
    x: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="m4.6 4.6 6.8 6.8M11.4 4.6l-6.8 6.8"/></svg>'
  }

  /** 起始页常用地址（与 SubPj5 独立浏览器 app/ 的起始页一致，去掉仅该应用可用的「项目文件」）。 */
  var SHORTCUTS = [
    { name: 'DeepSeek', url: 'https://chat.deepseek.com/', color: '#4d6bfe' },
    { name: 'GitHub', url: 'https://github.com/', color: '#24292f', mark: 'G' },
    { name: 'ChatGPT', url: 'https://chatgpt.com/', color: '#10a37f' },
    { name: 'floria 网关', url: 'http://127.0.0.1:8124/', color: '#7c5cff' }
  ]

  /** 起始页搜索：网址原样/补 https，其它词走 Bing（与 app/ 的 smartHref 同规则）。 */
  function startHref(input) {
    var s = String(input == null ? '' : input).trim()
    if (s === '') return ''
    if (/^https?:\/\//i.test(s)) return s
    if (!/\s/.test(s) && /[\/.]/.test(s)) return s
    return 'https://www.bing.com/search?q=' + encodeURIComponent(s)
  }

  /**
   * 地址解析（与 dsh url.ts 的 allowlist 同规则）。
   * @param {string} input 地址栏 / 类型化打开输入
   * @param {string} [applicationOrigin] 需要拒绝的宿主 origin；空 = 不检查
   * @returns {{ok:true,target:{url:string,title:string}}|{ok:false,reason:string}}
   */
  function parseAddress(input, applicationOrigin) {
    var trimmed = String(input == null ? '' : input).trim()
    if (trimmed === '') return { ok: false, reason: 'empty' }
    if (trimmed.length > MAX_URL_LENGTH) return { ok: false, reason: 'invalid' }
    var explicitScheme = /^[A-Za-z][A-Za-z\d+.-]*:(?!\d+(?:[/?#]|$))/.test(trimmed)
    var candidate = explicitScheme ? trimmed : 'https://' + trimmed
    var url
    try { url = new URL(candidate) } catch (_invalid) { return { ok: false, reason: 'invalid' } }
    if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' }
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      if (applicationOrigin) {
        try {
          if (url.origin === new URL(applicationOrigin).origin) return { ok: false, reason: 'application-origin' }
        } catch (_unusableOrigin) { /* 不可用的应用 origin 不授予目标访问权，也不拦截 */ }
      }
      return { ok: true, target: { url: url.href, title: url.hostname } }
    }
    return { ok: false, reason: 'protocol' }
  }

  /**
   * 在宿主要素内挂载侧边浏览器卡。
   * @param {HTMLElement} root 宿主容器
   * @param {object} [options] { ns, open, appOrigin, onEvent }（open = 初始展开）
   * @returns {object} controller
   */
  function mount(root, options) {
    if (!root) throw new Error('mount 需要根节点')
    var doc = root.ownerDocument
    var win = doc.defaultView || global
    var opts = options || {}
    var ns = opts.ns || DEFAULT_NS
    var appOrigin = opts.appOrigin || ''
    var onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : function () {}
    var destroyed = false

    var state = {
      open: !!opts.open,
      width: DEFAULT_WIDTH,
      active: 0,
      tabs: [],
      pages: []
    }

    var tabSeq = 0
    var draftDirty = false

    // ---------- 内部页配置（Config/tabs.json） ----------
    var configUrl = typeof opts.configUrl === 'string' ? opts.configUrl : DEFAULT_CONFIG_URL
    var configBase = configUrl ? configUrl.replace(/[^/]*$/, '') : ''
    var configPromise = null
    function loadPages() {
      if (!configUrl) return Promise.resolve([])
      if (configPromise) return configPromise
      configPromise = win.fetch(configUrl, { cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error('配置文件读取失败（HTTP ' + res.status + '）')
          return res.json()
        })
        .then(function (data) {
          var list = Array.isArray(data && data.pages) ? data.pages : []
          var pages = []
          for (var i = 0; i < list.length; i++) {
            var p = list[i]
            if (!p || typeof p.id !== 'string' || !p.id || typeof p.url !== 'string' || !p.url) continue
            var resolved
            try { resolved = new URL(p.url, configBase ? new URL(configBase, win.location.href).href : win.location.href) } catch (_bad) { continue }
            // 只允许 Config 目录内的同源页面：拒绝跨源、越出 Config 根、带凭据的地址。
            if (resolved.origin !== win.location.origin) continue
            if (configBase && resolved.href.indexOf(new URL(configBase, win.location.href).href) !== 0) continue
            if (resolved.username || resolved.password) continue
            pages.push({
              id: p.id,
              title: typeof p.title === 'string' && p.title ? p.title : p.id,
              url: resolved.href,
              ns: typeof p.ns === 'string' && p.ns ? p.ns : p.id,
              openCmd: typeof p.openCmd === 'string' && p.openCmd ? p.openCmd : 'fileopen'
            })
          }
          state.pages = pages
          return pages
        })
        .catch(function (err) {
          emit('config-failed', { error: String((err && err.message) || err) })
          return []
        })
      return configPromise
    }
    if (configUrl) loadPages()

    function blankTab() {
      return {
        id: ++tabSeq,
        title: '',
        entries: [],
        index: -1,
        revision: 0,
        nav: { status: 'empty', revision: 0 },
        failure: '',
        loadError: false,
        frame: null,
        page: null,
        pageKey: '',
        pageReady: false,
        pageWaiters: [],
        pagePending: null
      }
    }
    state.tabs.push(blankTab())

    // ---------- DOM ----------
    root.classList.add('sb-root')
    root.innerHTML = [
      '<div class="sb-card" hidden>',
      '  <div class="sb-grip" title="拖动调整宽度，拖到最窄收起" aria-hidden="true"></div>',
      '  <div class="sb-tabs"></div>',
      '  <form class="sb-bar" autocomplete="off">',
      '    <button type="button" class="sb-tool" data-act="back" title="后退" aria-label="后退">' + ICONS.back + '</button>',
      '    <button type="button" class="sb-tool" data-act="forward" title="前进" aria-label="前进">' + ICONS.forward + '</button>',
      '    <button type="button" class="sb-tool" data-act="reload" title="重新加载" aria-label="重新加载">' + ICONS.reload + '</button>',
      '    <div class="sb-addr">',
      '      <input class="sb-input" type="text" spellcheck="false" aria-label="网址" placeholder="输入 http / https 地址">',
      '      <span class="sb-flag" hidden>URL 已变化</span>',
      '      <button type="submit" class="sb-tool sb-go" title="前往" aria-label="前往">' + ICONS.go + '</button>',
      '    </div>',
      '    <button type="button" class="sb-tool" data-act="external" title="在系统浏览器打开" aria-label="在系统浏览器打开">' + ICONS.external + '</button>',
      '  </form>',
      '  <div class="sb-alert" role="alert" hidden></div>',
      '  <div class="sb-stage">',
      '    <div class="sb-empty">',
      '      <div class="sb-start">',
      '        <form class="sb-start-search" autocomplete="off">',
      '          <span class="sb-start-mag">' + ICONS.mag + '</span>',
      '          <input class="sb-start-input" type="text" spellcheck="false" placeholder="搜索或输入 Web 地址" aria-label="搜索或输入 Web 地址">',
      '          <button class="sb-start-go" type="submit">打开</button>',
      '        </form>',
      '        <div class="sb-start-grid"></div>',
      '      </div>',
      '    </div>',
      '    <div class="sb-loading" hidden>正在加载…</div>',
      '  </div>',
      '</div>'
    ].join('\n')

    var card = root.querySelector('.sb-card')
    var grip = root.querySelector('.sb-grip')
    var tabBar = root.querySelector('.sb-tabs')
    var form = root.querySelector('.sb-bar')
    var input = root.querySelector('.sb-input')
    var flag = root.querySelector('.sb-flag')
    var btnBack = root.querySelector('[data-act="back"]')
    var btnForward = root.querySelector('[data-act="forward"]')
    var btnReload = root.querySelector('[data-act="reload"]')
    var btnExternal = root.querySelector('[data-act="external"]')
    var alertEl = root.querySelector('.sb-alert')
    var stage = root.querySelector('.sb-stage')
    var empty = root.querySelector('.sb-empty')
    var startBox = root.querySelector('.sb-start')
    var startForm = root.querySelector('.sb-start-search')
    var startInput = root.querySelector('.sb-start-input')
    var startGrid = root.querySelector('.sb-start-grid')
    var loadingEl = root.querySelector('.sb-loading')

    // ---------- 状态读写 ----------
    function activeTab() { return state.tabs[state.active] }
    function currentTarget(tab) {
      tab = tab || activeTab()
      return tab.index < 0 ? undefined : tab.entries[tab.index]
    }
    function currentUrl(tab) {
      var t = currentTarget(tab)
      return t ? t.url : ''
    }
    function canGoBack(tab) {
      return tab.nav.status !== 'unknown' && tab.index > 0
    }
    function canGoForward(tab) {
      return tab.nav.status !== 'unknown' && tab.index >= 0 && tab.index < tab.entries.length - 1
    }
    function snapshot() {
      var tab = activeTab()
      var t = currentTarget(tab)
      return {
        ns: ns,
        open: state.open,
        width: state.width,
        status: tab.nav.status,
        url: t ? t.url : '',
        title: t ? t.title : tab.title,
        canGoBack: canGoBack(tab),
        canGoForward: canGoForward(tab),
        loading: tab.nav.status === 'loading',
        failure: tab.failure || null,
        loadError: tab.loadError,
        historyLength: tab.entries.length,
        historyIndex: tab.index,
        active: tab.id,
        page: tab.page || '',
        pages: state.pages.map(function (p) { return { id: p.id, title: p.title } }),
        tabs: state.tabs.map(function (x) {
          return { id: x.id, title: x.title, url: currentUrl(x), active: x.id === tab.id }
        })
      }
    }
    function emit(ev, data) {
      var payload = data || {}
      try { onEvent(ev, payload) } catch (_e) { /* 宿主回调异常不影响组件 */ }
      sendToHost({ type: ns + '-event', ev: ev, data: payload })
    }
    function sendToHost(message) {
      if (win.parent === win) return
      try { win.parent.postMessage(message, '*') } catch (_e) { /* 忽略跨源发送失败 */ }
    }

    // ---------- 起始页 ----------
    function escapeHtml(value) {
      return String(value).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
      })
    }
    /** 起始页常用地址块；点击交给地址校验后加载。 */
    function renderStartTiles() {
      var html = []
      SHORTCUTS.forEach(function (s) {
        var mark = s.mark || String(s.name).slice(0, 1).toUpperCase()
        html.push('<button type="button" class="sb-start-tile" title="' + escapeHtml(s.url) + '" data-url="' + escapeHtml(s.url) + '">' +
          '<span class="sb-start-mark' + (s.color ? ' tinted' : '') + '"' + (s.color ? ' style="--tile:' + s.color + '"' : '') + '>' + escapeHtml(mark) + '</span>' +
          '<span class="sb-start-name">' + escapeHtml(s.name) + '</span></button>')
      })
      startGrid.innerHTML = html.join('')
    }

    // ---------- 标签页 ----------
    function tabLabel(tab) {
      var t = currentTarget(tab)
      return tab.title || (t && t.title) || '新标签页'
    }
    function renderTabs() {
      var html = []
      state.tabs.forEach(function (t, i) {
        var label = tabLabel(t)
        var url = currentUrl(t)
        html.push('<span class="sb-tabwrap">')
        html.push('<button type="button" class="sb-tab' + (i === state.active ? ' on' : '') + '" data-tab="' + i + '"' +
          (url ? ' title="' + escapeHtml(url) + '"' : '') + '>' + escapeHtml(label) + '</button>')
        html.push('<button type="button" class="sb-tab-x" data-close="' + i +
          '" title="关闭标签页" aria-label="关闭 ' + escapeHtml(label) + '">' + ICONS.x + '</button>')
        html.push('</span>')
      })
      tabBar.innerHTML = html.join('')
      Array.prototype.forEach.call(tabBar.querySelectorAll('.sb-tab'), function (b) {
        b.addEventListener('click', function () { switchTab(parseInt(b.getAttribute('data-tab'), 10)) })
      })
      Array.prototype.forEach.call(tabBar.querySelectorAll('.sb-tab-x'), function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation()
          closeTab(parseInt(b.getAttribute('data-close'), 10))
        })
      })
    }
    function switchTab(at) {
      if (!(at >= 0 && at < state.tabs.length) || at === state.active) return
      state.open = true
      state.active = at
      draftDirty = false
      sync()
      emit('tab-switch', { id: activeTab().id })
    }
    /** 关闭一个标签页；关掉最后一个时自动补一个起始页标签。 */
    function closeTab(at) {
      if (!(at >= 0 && at < state.tabs.length)) return snapshot()
      var tab = state.tabs[at]
      if (tab.frame && tab.frame.parentNode) tab.frame.parentNode.removeChild(tab.frame)
      state.tabs.splice(at, 1)
      if (!state.tabs.length) state.tabs.push(blankTab())
      if (at < state.active) state.active -= 1
      else if (at === state.active) state.active = Math.min(at, state.tabs.length - 1)
      draftDirty = false
      sync()
      emit('tab-close', { id: tab.id })
      return snapshot()
    }

    // ---------- 渲染 ----------
    /** 同源文档注入「不显示滑条」样式：滚动仍可用，只是不画滚动条。跨源文档无法注入，保留页面自身滚动条。 */
    var NO_SCROLLBAR_CSS = 'html,body{scrollbar-width:none!important;-ms-overflow-style:none!important}' +
      'html::-webkit-scrollbar,body::-webkit-scrollbar,html *::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}'
    function hideFrameScrollbars(frame) {
      try {
        var inner = frame.contentDocument
        if (!inner || !inner.documentElement) return
        var tag = inner.getElementById('sb-no-scrollbar')
        if (!tag) {
          tag = inner.createElement('style')
          tag.id = 'sb-no-scrollbar'
          ;(inner.head || inner.documentElement).appendChild(tag)
        }
        tag.textContent = NO_SCROLLBAR_CSS
      } catch (_crossOrigin) { /* 跨源文档无法注入 */ }
    }

    function renderFrame(tab, target, revision) {
      if (tab.frame && tab.frame.parentNode) tab.frame.parentNode.removeChild(tab.frame)
      var frame = doc.createElement('iframe')
      frame.className = 'sb-frame'
      frame.title = target.title
      frame.referrerPolicy = 'no-referrer'
      frame.setAttribute('sandbox', tab.page ? INTERNAL_SANDBOX : WEB_SANDBOX)
      frame.hidden = tab !== activeTab()
      frame.src = target.url
      frame.addEventListener('load', function () {
        hideFrameScrollbars(frame)
        handleLoaded(tab, revision)
      })
      frame.addEventListener('error', function () { handleFailed(tab, revision) })
      stage.appendChild(frame)
      tab.frame = frame
    }

    function sync() {
      if (destroyed) return
      var tab = activeTab()
      var t = currentTarget(tab)
      var unknown = tab.nav.status === 'unknown'
      card.hidden = !state.open
      card.style.width = state.width + 'px'
      btnBack.disabled = !canGoBack(tab)
      btnForward.disabled = !canGoForward(tab)
      btnReload.disabled = !t
      btnExternal.disabled = unknown || !t
      if (!draftDirty) input.value = t ? t.url : ''
      flag.hidden = !unknown
      var alertText = tab.failure ? (REASONS[tab.failure] || '地址无效')
        : tab.loadError ? '页面加载失败（目标站点可能拒绝嵌入或网络不可达）' : ''
      alertEl.hidden = !alertText
      alertEl.textContent = alertText
      state.tabs.forEach(function (x) { if (x.frame) x.frame.hidden = x !== tab })
      empty.hidden = !!tab.frame
      var loading = tab.nav.status === 'loading'
      startBox.hidden = loading
      loadingEl.hidden = !loading
      root.setAttribute('data-status', tab.nav.status)
      root.setAttribute('data-open', state.open ? '1' : '0')
      renderTabs()
    }

    // ---------- 导航 ----------
    function beginLoad(tab, target) {
      var revision = ++tab.revision
      tab.nav = { status: 'loading', revision: revision }
      tab.failure = ''
      tab.loadError = false
      tab.title = target.title || ''
      draftDirty = false
      renderFrame(tab, target, revision)
      sync()
      emit('navigate', { url: target.url, tab: tab.id })
    }

    function beginNavigate(tab, target) {
      tab.entries = tab.entries.slice(0, tab.index + 1).concat([target])
      if (tab.entries.length > MAX_HISTORY) tab.entries.splice(0, tab.entries.length - MAX_HISTORY)
      tab.index = tab.entries.length - 1
      beginLoad(tab, target)
    }

    function loadUrl(value) {
      var tab = activeTab()
      var parsed = parseAddress(value, appOrigin)
      if (!parsed.ok) {
        tab.failure = parsed.reason
        sync()
        emit('blocked', { reason: parsed.reason, input: String(value == null ? '' : value), tab: tab.id })
        return { ok: false, error: REASONS[parsed.reason] || '地址无效', reason: parsed.reason }
      }
      var t = currentTarget(tab)
      if (t && t.url === parsed.target.url) beginLoad(tab, t)
      else beginNavigate(tab, parsed.target)
      return { ok: true, state: snapshot() }
    }

    function handleLoaded(tab, revision) {
      if (destroyed || revision !== tab.nav.revision) return
      if (tab.nav.status === 'loading') {
        tab.nav = { status: 'known', revision: revision }
        try {
          var innerDoc = tab.frame && tab.frame.contentDocument
          var title = innerDoc && String(innerDoc.title || '').trim()
          if (title) tab.title = title
        } catch (_crossOrigin) { /* 跨源页面沿用域名标题 */ }
        sync()
        emit('loaded', { url: currentUrl(tab), tab: tab.id })
      } else if (tab.nav.status === 'known') {
        tab.nav = { status: 'unknown', revision: revision }
        sync()
        emit('unknown', { url: currentUrl(tab), tab: tab.id })
      }
    }

    function handleFailed(tab, revision) {
      if (destroyed || revision !== tab.nav.revision) return
      tab.loadError = true
      sync()
      emit('failed', { url: currentUrl(tab), tab: tab.id })
    }

    // ---------- 命令 ----------
    /** open{url} = 新开一个标签页并加载；open{} = 只展开卡片，不新建也不导航。 */
    function openTab(url) {
      state.open = true
      if (!url) {
        sync()
        emit('open', { url: null, tab: activeTab().id })
        return snapshot()
      }
      var parsed = parseAddress(url, appOrigin)
      if (!parsed.ok) {
        var tab = activeTab()
        tab.failure = parsed.reason
        sync()
        emit('blocked', { reason: parsed.reason, input: String(url), tab: tab.id })
        return { ok: false, error: REASONS[parsed.reason] || '地址无效', reason: parsed.reason }
      }
      var next = blankTab()
      state.tabs.push(next)
      state.active = state.tabs.length - 1
      beginNavigate(next, parsed.target)
      emit('open', { url: parsed.target.url, tab: next.id })
      return snapshot()
    }

    function closeCard() {
      state.open = false
      sync()
      emit('close', {})
      return snapshot()
    }

    // ---------- 内部页（Config/tabs.json → page{id,payload}） ----------
    function tabBySource(src) {
      for (var i = 0; i < state.tabs.length; i++) {
        var t = state.tabs[i]
        if (t.frame && t.frame.contentWindow === src) return t
      }
      return null
    }
    function pageKeyOf(page, payload) {
      return page.id + '|' + ((payload && payload.label) || '') + '|' + ((payload && payload.session) || '')
    }
    function pageUrl(page, payload) {
      var url = page.url
      var query = []
      for (var k in payload || {}) {
        var v = payload[k]
        if (v === undefined || v === null || (typeof v !== 'string' && typeof v !== 'number')) continue
        query.push(encodeURIComponent(k) + '=' + encodeURIComponent(v))
      }
      // 宿主主题随 URL 传给内部页（内部页跨 frame 读父文档可能失败/时序不稳，这里给确定值）
      var theme = 'light'
      try { if (doc.documentElement.getAttribute('data-theme') === 'dark') theme = 'dark' } catch (_e) { /* 忽略 */ }
      query.push('theme=' + theme)
      if (!query.length) return url
      return url + (url.indexOf('?') >= 0 ? '&' : '?') + query.join('&')
    }
    /** 首次把 payload 交给内部页（页面 ready 后发），后续重复调用即重发（幂等）。 */
    function askPage(tab, page, payload) {
      var args = payload && typeof payload === 'object' ? payload : {}
      var cmd = page.openCmd
      var send = function () {
        return new Promise(function (resolve) {
          if (!tab.frame || !tab.frame.contentWindow) return resolve({ ok: false, error: '内部页未就绪' })
          var timer = setTimeout(function () {
            if (tab.pagePending && tab.pagePending.cmd === cmd) {
              tab.pagePending = null
              resolve({ ok: false, error: '内部页响应超时' })
            }
          }, 15000)
          tab.pagePending = {
            cmd: cmd,
            resolve: function (r) { clearTimeout(timer); resolve(r) },
          }
          try {
            tab.frame.contentWindow.postMessage({ type: page.ns + '-cmd', cmd: cmd, args: args }, '*')
          } catch (err) {
            tab.pagePending = null
            clearTimeout(timer)
            resolve({ ok: false, error: String((err && err.message) || err) })
          }
        })
      }
      if (tab.pageReady) return send()
      return new Promise(function (resolve) {
        var settled = false
        var timer = setTimeout(function () {
          if (settled) return
          settled = true
          resolve({ ok: false, error: '内部页加载超时' })
        }, 15000)
        tab.pageWaiters.push(function () {
          if (settled) return
          settled = true
          clearTimeout(timer)
          send().then(resolve)
        })
      })
    }
    /** ack 后回读内部页 document.title：编辑页标题随文件变化，tabs.json 的静态标题只作占位。 */
    function refreshPageTitle(tab) {
      var innerDoc = tab.frame && tab.frame.contentDocument
      var title = innerDoc && String(innerDoc.title || '').trim()
      if (!title) return
      tab.title = title
      sync()
    }
    function openPage(id, payload) {
      var pid = String(id == null ? '' : id).trim()
      if (!pid) return Promise.resolve({ ok: false, error: 'page 需要 id' })
      return loadPages().then(function (pages) {
        var page = null
        for (var i = 0; i < pages.length; i++) if (pages[i].id === pid) { page = pages[i]; break }
        if (!page) return { ok: false, error: 'Config 未声明内部页：' + pid }
        var key = pageKeyOf(page, payload)
        var tab = null
        for (var j = 0; j < state.tabs.length; j++) if (state.tabs[j].pageKey === key) { tab = state.tabs[j]; break }
        if (!tab) {
          tab = blankTab()
          tab.page = page.id
          tab.pageKey = key
          tab.title = page.title
          var target = { url: pageUrl(page, payload), title: page.title }
          tab.entries = [target]
          tab.index = 0
          state.tabs.push(tab)
          state.active = state.tabs.length - 1
          beginLoad(tab, target)
        } else {
          state.open = true
          state.active = state.tabs.indexOf(tab)
          sync()
        }
        state.open = true
        emit('page', { id: page.id, tab: tab.id })
        return askPage(tab, page, payload).then(function (r) {
          if (r.ok !== false) refreshPageTitle(tab)
          return r.ok === false ? r : snapshot()
        })
      })
    }

    function back() {
      var tab = activeTab()
      if (!canGoBack(tab)) return snapshot()
      tab.index -= 1
      beginLoad(tab, tab.entries[tab.index])
      return snapshot()
    }

    function forward() {
      var tab = activeTab()
      if (!canGoForward(tab)) return snapshot()
      tab.index += 1
      beginLoad(tab, tab.entries[tab.index])
      return snapshot()
    }

    function reload() {
      var tab = activeTab()
      var t = currentTarget(tab)
      if (!t) { sync(); return snapshot() }
      beginLoad(tab, t)
      return snapshot()
    }

    function external() {
      var tab = activeTab()
      var t = currentTarget(tab)
      if (!t || tab.nav.status === 'unknown') return
      try { win.open(t.url, '_blank', 'noopener,noreferrer') } catch (_e) { /* 弹窗被拦截 */ }
    }

    var COMMANDS = {
      open: function (a) { return openTab(a && a.url) },
      load: function (a) {
        if (!a || !a.url) return { ok: false, error: 'load 需要 url' }
        state.open = true
        var r = loadUrl(a.url)
        sync()
        return r.ok === false ? r : snapshot()
      },
      back: function () { return back() },
      forward: function () { return forward() },
      reload: function () { return reload() },
      page: function (a) { return openPage(a && a.id, a && a.payload) },
      close: function () { return closeCard() },
      state: function () { return snapshot() },
      locate: function () { return snapshot() }
    }

    function dispatch(cmd, args) {
      var fn = COMMANDS[cmd]
      if (!fn) return Promise.resolve({ ok: false, error: '未注册的命令 ' + cmd })
      return Promise.resolve().then(function () {
        return fn(args || {})
      }).then(function (r) {
        if (r && r.ok === false) return { ok: false, error: r.error || '命令失败', result: r }
        return { ok: true, result: r === undefined ? null : r }
      }).catch(function (err) {
        return { ok: false, error: String((err && err.message) || err) }
      })
    }

    // ---------- 边缘拖拽：调宽 / 拖到最窄收起 ----------
    var drag = null
    function onGripDown(e) {
      if (e.button !== 0) return
      e.preventDefault()
      drag = { x: e.clientX, width: card.getBoundingClientRect().width, root: root.clientWidth || 0, prevWidth: state.width }
      grip.classList.add('sb-dragging')
      if (doc.body) doc.body.classList.add('sb-resizing')
      try { grip.setPointerCapture(e.pointerId) } catch (_e) { /* 老浏览器忽略 */ }
    }
    function onGripMove(e) {
      if (!drag) return
      var max = Math.max(MIN_WIDTH, drag.root - 4)
      var next = Math.max(120, Math.min(max, drag.width + (drag.x - e.clientX)))
      state.width = Math.round(next)
      card.style.width = state.width + 'px'
    }
    function onGripUp(e) {
      if (!drag) return
      var prevWidth = drag.prevWidth
      drag = null
      grip.classList.remove('sb-dragging')
      if (doc.body) doc.body.classList.remove('sb-resizing')
      try { grip.releasePointerCapture(e.pointerId) } catch (_e) { /* 忽略 */ }
      if (state.width < MIN_WIDTH) {
        state.width = previousWidth(prevWidth)
        closeCard()
        return
      }
      sync()
      emit('resize', { width: state.width })
    }
    function previousWidth(value) {
      return value >= MIN_WIDTH ? value : DEFAULT_WIDTH
    }

    // ---------- 事件绑定 ----------
    function onSubmit(e) {
      e.preventDefault()
      state.open = true
      draftDirty = false
      loadUrl(input.value)
    }
    function onInput() { draftDirty = true }
    function onStartSubmit(e) {
      e.preventDefault()
      var href = startHref(startInput.value)
      if (!href) return
      state.open = true
      startInput.value = ''
      loadUrl(href)
    }
    function onStartTile(e) {
      var node = e.target
      while (node && node !== startGrid && !(node.getAttribute && node.getAttribute('data-url'))) node = node.parentNode
      if (!node || !node.getAttribute) return
      var url = node.getAttribute('data-url')
      if (!url) return
      state.open = true
      loadUrl(url)
    }
    function onBack() { back() }
    function onForward() { forward() }
    function onReload() { reload() }
    function onExternal() { external() }
    function onMessage(e) {
      var d = e.data
      if (!d || typeof d.type !== 'string') return
      // 宿主 → 组件（仅 parent 来源）
      if (d.type === ns + '-cmd') {
        if (e.source !== win.parent) return
        dispatch(d.cmd, d.args).then(function (res) {
          sendToHost({ type: ns + '-event', ev: 'ack', cmd: d.cmd, ok: res.ok, result: res.result, error: res.error })
        })
        return
      }
      // 内部页 → 组件（按 frame 定位标签页，避免跨页串消息）
      var tab = tabBySource(e.source)
      if (!tab || !tab.page) return
      var suffix = '-event'
      if (d.type.slice(-suffix.length) !== suffix) return
      if (d.ev === 'ready') {
        tab.pageReady = true
        var waiters = tab.pageWaiters.splice(0)
        for (var i = 0; i < waiters.length; i++) { try { waiters[i]() } catch (_e) { /* 忽略单个 */ } }
        sendToHost({ type: ns + '-event', ev: 'page-ready', data: { page: tab.page, tab: tab.id } })
        return
      }
      if (d.ev === 'ack' && tab.pagePending && tab.pagePending.cmd === d.cmd) {
        var pending = tab.pagePending
        tab.pagePending = null
        pending.resolve(d.ok === false ? { ok: false, error: d.error || '命令失败' } : { ok: true, result: d.result })
        return
      }
      sendToHost({ type: ns + '-event', ev: 'page-event', data: { page: tab.page, ev: d.ev, data: d.data } })
    }

    grip.addEventListener('pointerdown', onGripDown)
    grip.addEventListener('pointermove', onGripMove)
    grip.addEventListener('pointerup', onGripUp)
    grip.addEventListener('pointercancel', onGripUp)
    form.addEventListener('submit', onSubmit)
    input.addEventListener('input', onInput)
    startForm.addEventListener('submit', onStartSubmit)
    startGrid.addEventListener('click', onStartTile)
    btnBack.addEventListener('click', onBack)
    btnForward.addEventListener('click', onForward)
    btnReload.addEventListener('click', onReload)
    btnExternal.addEventListener('click', onExternal)
    win.addEventListener('message', onMessage)

    renderStartTiles()
    sync()
    if (win.parent !== win) sendToHost({ type: ns + '-event', ev: 'ready', data: { ns: ns, state: snapshot() } })

    return {
      open: function (url) { var r = openTab(url); return Promise.resolve({ ok: !(r && r.ok === false), result: r, error: r && r.ok === false ? r.error : undefined }) },
      load: function (url) { return dispatch('load', { url: url }) },
      page: function (id, payload) { return dispatch('page', { id: id, payload: payload }) },
      back: function () { return dispatch('back') },
      forward: function () { return dispatch('forward') },
      reload: function () { return dispatch('reload') },
      close: function () { return dispatch('close') },
      state: function () { return snapshot() },
      dispatch: dispatch,
      destroy: function () {
        if (destroyed) return
        destroyed = true
        win.removeEventListener('message', onMessage)
        state.tabs.forEach(function (x) {
          if (x.frame && x.frame.parentNode) x.frame.parentNode.removeChild(x.frame)
          x.frame = null
        })
        root.innerHTML = ''
        root.classList.remove('sb-root')
        root.removeAttribute('data-status')
        root.removeAttribute('data-open')
      }
    }
  }

  /** 暴露给宿主的命令清单（宿主可据此生成调用入口）。 */
  function snapshotApi() {
    return [
      { cmd: 'open', args: { url: 'https://example.com/' } },
      { cmd: 'load', args: { url: 'https://example.com/' } },
      { cmd: 'back', args: {} },
      { cmd: 'forward', args: {} },
      { cmd: 'reload', args: {} },
      { cmd: 'page', args: { id: 'edit', payload: { path: 'README.md', session: '<会话 id>' } } },
      { cmd: 'close', args: {} },
      { cmd: 'state', args: {} },
      { cmd: 'locate', args: {} }
    ]
  }

  global.UIDesignSideBrowser = {
    mount: mount,
    parseAddress: parseAddress,
    snapshotApi: snapshotApi,
    MAX_URL_LENGTH: MAX_URL_LENGTH,
    MAX_HISTORY: MAX_HISTORY,
    WEB_SANDBOX: WEB_SANDBOX,
    REASONS: REASONS
  }
})(typeof window !== 'undefined' ? window : this)
