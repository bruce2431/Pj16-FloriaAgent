/* 编辑卡片 · 纯组件（零控制台依赖，由浏览器/宿主渲染）
 *
 * 对照 dsh = deepseek-ai/deepseek-harness 的 ui-deliverables changes-review：
 * 只读的轮次变更查看器 —— 每轮一个「第 N 轮改动」标签，文件头显示路径与 +N / -N，
 * 正文按统一 diff hunk 渲染；并排（默认，两列同步滚动）/ 统一两种视图，可选自动换行。
 *
 * 数据契约：
 *   GET <dataUrl>[?label=<项目 label>&path=<项目相对或绝对路径>&session=<会话 id>] → {
 *     ok, file: { path, display }, content?, note?, rounds: [{
 *       turn, label?, added, deleted,
 *       hunks: [{ oldStart, oldLines, newStart, newLines, lines: [' ctx', '-old', '+new'] }]
 *     }]
 *   }
 *   带 path+session 时由后端按 Floria .claude/file-history 生成「最新一轮」对比。
 *
 * 公开面：
 *   window.UIDesignEditCard = { mount }
 *   mount(root, { dataUrl, label, path, session, ns, onEvent }) → controller
 *   controller：openFile({label, path, session}) / load() / select(turn) / setView('diff'|'file') /
 *               setSplit(bool) / setWrap(bool) / state() / dispatch(cmd, args) / destroy()
 *   命令：fileopen{label?, path, session, dataUrl?} / load / select / view{view} / split / wrap / state
 *   快捷键：Alt+Z 切换自动换行（不设工具按钮）
 *   宿主信封（iframe 内）：parent → <ns>-cmd {cmd, args}；回收 <ns>-event {ev:'ack', cmd, ok, result|error}
 */
(function (global) {
  'use strict'

  var DEFAULT_NS = 'floria-edit-card'
  var DEFAULT_DATA_API = '/api/rounds'
  /** 每轮最多渲染的 diff 行数（对照 dsh FileDiff.MAX_RENDERED_LINES）。 */
  var MAX_RENDERED_LINES = 5000

  /** 路径末段（文件名），供 document.title = 侧边浏览器 tab 标题：归一分隔符、剥尾部行号后缀。 */
  function fileTitleOf(p) {
    var s = String(p || '').replace(/\\/g, '/').replace(/:\d+(?:-\d+)?$/, '').replace(/\/+$/, '')
    var at = s.lastIndexOf('/')
    return at >= 0 ? s.slice(at + 1) : s
  }

  var ICONS = {
    split: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.6"/><path d="M8 2.6v10.8"/></svg>'
  }

  function mount(root, options) {
    if (!root) throw new Error('mount 需要根节点')
    var doc = root.ownerDocument
    var win = doc.defaultView || global
    var opts = options || {}
    var ns = opts.ns || DEFAULT_NS
    var dataUrl = opts.dataUrl === undefined ? DEFAULT_DATA_API : String(opts.dataUrl || '')
    var onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : function () {}
    var destroyed = false

    var state = {
      file: null,
      rounds: [],
      turn: 0,
      split: false,
      wrap: false,
      view: 'diff',
      content: '',
      note: '',
      label: typeof opts.label === 'string' ? opts.label : '',
      path: typeof opts.path === 'string' ? opts.path : '',
      session: typeof opts.session === 'string' ? opts.session : '',
      busy: false,
      failure: ''
    }

    root.classList.add('ec-root')
    root.innerHTML = [
      '<div class="ec-head">',
      '  <span class="ec-file"><span class="ec-file-name"></span></span>',
      '  <div class="ec-rounds"></div>',
      '  <span class="ec-counts"><span class="ec-added"></span><span class="ec-deleted"></span></span>',
      '  <span class="ec-tools">',
      '    <button type="button" class="ec-tool" data-tool="split" title="切换并排 / 统一视图" aria-label="切换并排 / 统一视图">' + ICONS.split + '</button>',
      '  </span>',
      '</div>',
      '<div class="ec-body"></div>',
      '<p class="ec-status" hidden></p>'
    ].join('\n')

    var roundsBar = root.querySelector('.ec-rounds')
    var fileName = root.querySelector('.ec-file-name')
    var addedEl = root.querySelector('.ec-added')
    var deletedEl = root.querySelector('.ec-deleted')
    var body = root.querySelector('.ec-body')
    var statusEl = root.querySelector('.ec-status')
    var btnSplit = root.querySelector('[data-tool="split"]')

    // ---------- 纯函数（对照 dsh FileDiff） ----------
    function esc(v) {
      return String(v).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
      })
    }
    function currentRound() {
      return state.rounds[state.turn] || null
    }
    function hunkHeader(h) {
      return '@@ -' + h.oldStart + ',' + h.oldLines + ' +' + h.newStart + ',' + h.newLines + ' @@'
    }
    /** 一个 hunk 的逐行编号：上下文两侧都计，删除只计旧侧，新增只计新侧。 */
    function hunkRows(h) {
      var oldNo = h.oldStart
      var newNo = h.newStart
      var rows = []
      for (var i = 0; i < h.lines.length; i++) {
        var raw = h.lines[i]
        var kind = raw.charAt(0)
        var text = raw.slice(1)
        if (kind === '+') rows.push({ kind: 'add', old: undefined, now: newNo++, text: text })
        else if (kind === '-') rows.push({ kind: 'del', old: oldNo++, now: undefined, text: text })
        else rows.push({ kind: 'context', old: oldNo++, now: newNo++, text: text })
      }
      return rows
    }
    /** 并排配对：每段连续删除与随后连续新增逐行对齐，上下文两侧同现。 */
    function splitRows(h) {
      var rows = []
      var dels = []
      var adds = []
      function flush() {
        var n = Math.max(dels.length, adds.length)
        for (var at = 0; at < n; at++) rows.push({ left: dels[at], right: adds[at] })
        dels = []
        adds = []
      }
      var flat = hunkRows(h)
      for (var i = 0; i < flat.length; i++) {
        var row = flat[i]
        if (row.kind === 'del') dels.push({ no: row.old, text: row.text, kind: 'del' })
        else if (row.kind === 'add') adds.push({ no: row.now, text: row.text, kind: 'add' })
        else {
          flush()
          rows.push({
            left: { no: row.old, text: row.text, kind: 'context' },
            right: { no: row.now, text: row.text, kind: 'context' }
          })
        }
      }
      flush()
      return rows
    }
    /** 截到 MAX_RENDERED_LINES 行，末尾 hunk 按需缩短（对照 dsh renderedHunks）。 */
    function renderedHunks(hunks) {
      var budget = MAX_RENDERED_LINES
      var kept = []
      for (var i = 0; i < hunks.length; i++) {
        var h = hunks[i]
        if (budget === 0) break
        if (h.lines.length <= budget) {
          kept.push(h)
          budget -= h.lines.length
        } else {
          kept.push({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: h.lines.slice(0, budget) })
          budget = 0
        }
      }
      return { hunks: kept, truncated: hunks.some(function (h, at) { return kept[at] !== h }) }
    }
    function cellHtml(cell) {
      if (!cell) return '<span class="ec-cell ec-empty"><span class="ec-no"></span><span class="ec-text"></span></span>'
      return '<span class="ec-cell ec-' + cell.kind + '"><span class="ec-no">' + cell.no +
        '</span><span class="ec-text">' + (cell.text === '' ? '\u00a0' : esc(cell.text)) + '</span></span>'
    }

    // ---------- 渲染 ----------
    function renderRounds() {
      if (!state.rounds.length) {
        roundsBar.hidden = true
        roundsBar.innerHTML = ''
        return
      }
      roundsBar.hidden = false
      var html = []
      for (var i = 0; i < state.rounds.length; i++) {
        var label = state.rounds[i].label || ('第 ' + state.rounds[i].turn + ' 轮改动')
        html.push('<button type="button" class="ec-round' + (i === state.turn ? ' on' : '') +
          '" data-turn="' + i + '">' + esc(label) + '</button>')
      }
      roundsBar.innerHTML = html.join('')
      Array.prototype.forEach.call(roundsBar.querySelectorAll('.ec-round'), function (b) {
        b.addEventListener('click', function () { select(Number(b.getAttribute('data-turn'))) })
      })
    }

    /** 文件视图：只读展示当前磁盘内容（行号 + 等宽正文）。 */
    function renderFileView() {
      body.setAttribute('data-view', 'file')
      body.removeAttribute('data-wrap')
      if (!state.content) {
        body.innerHTML = '<p class="ec-note">' + esc(state.note || '当前数据源不提供文件内容') + '</p>'
        return
      }
      var lines = state.content.replace(/\r\n?/g, '\n').split('\n')
      var total = lines.length
      var count = Math.min(total, MAX_RENDERED_LINES)
      var html = []
      if (total > count) html.push('<p class="ec-note">仅渲染前 ' + count + ' / ' + total + ' 行</p>')
      html.push('<div class="ec-file-body">')
      for (var i = 0; i < count; i++) {
        html.push('<div class="ec-fline"><span class="ec-no">' + (i + 1) + '</span><span class="ec-text">' +
          (lines[i] === '' ? '\u00a0' : esc(lines[i])) + '</span></div>')
      }
      html.push('</div>')
      body.innerHTML = html.join('')
    }

    function renderBody() {
      var round = currentRound()
      if (state.busy) { body.innerHTML = ''; return }
      if (state.failure) { body.innerHTML = ''; return }
      if (state.view === 'file') { renderFileView(); return }
      // 没有既往版本（无可对比备份）时不摆提示，直接按只读文件内容渲染。
      if (!round) { renderFileView(); return }
      if (!round.hunks.length) { body.innerHTML = '<p class="ec-note">' + esc(state.note || '该轮没有文本改动') + '</p>'; return }

      var hasAdd = round.hunks.some(function (h) { return h.lines.some(function (l) { return l.charAt(0) === '+' }) })
      var hasDel = round.hunks.some(function (h) { return h.lines.some(function (l) { return l.charAt(0) === '-' }) })
      var split = state.split && !(hasAdd !== hasDel)
      var view = renderedHunks(round.hunks)
      var hunks = view.hunks
      var html = []
      if (view.truncated) html.push('<p class="ec-note">仅渲染前 ' + MAX_RENDERED_LINES + ' 行改动</p>')

      if (split && !state.wrap) {
        html.push('<div class="ec-columns" data-view="split">')
        ;['left', 'right'].forEach(function (side) {
          html.push('<div class="ec-column" data-side="' + side + '">')
          for (var i = 0; i < hunks.length; i++) {
            var h = hunks[i]
            html.push('<section class="ec-hunk"><div class="ec-hunk-head">' + esc(hunkHeader(h)) + '</div>')
            var rows = splitRows(h)
            for (var at = 0; at < rows.length; at++) {
              var cell = rows[at][side]
              var kind = cell ? cell.kind : 'empty'
              html.push('<div class="ec-sline ec-' + kind + '"><span class="ec-no">' + (cell ? cell.no : '') +
                '</span><span class="ec-text">' + (!cell || cell.text === '' ? '\u00a0' : esc(cell.text)) + '</span></div>')
            }
            html.push('</section>')
          }
          html.push('</div>')
        })
        html.push('</div>')
        body.innerHTML = html.join('')
        body.setAttribute('data-view', 'split')
        body.removeAttribute('data-wrap')
        bindColumnScroll()
        return
      }

      if (split) {
        for (var s = 0; s < hunks.length; s++) {
          var hs = hunks[s]
          html.push('<section class="ec-hunk"><div class="ec-hunk-head">' + esc(hunkHeader(hs)) + '</div>')
          var paired = splitRows(hs)
          for (var p = 0; p < paired.length; p++) {
            html.push('<div class="ec-srow">' + cellHtml(paired[p].left) + cellHtml(paired[p].right) + '</div>')
          }
          html.push('</section>')
        }
        body.innerHTML = html.join('')
        body.setAttribute('data-view', 'split')
        body.setAttribute('data-wrap', '')
        return
      }

      for (var u = 0; u < hunks.length; u++) {
        var hu = hunks[u]
        html.push('<section class="ec-hunk"><div class="ec-hunk-head">' + esc(hunkHeader(hu)) + '</div>')
        var lines = hunkRows(hu)
        for (var r = 0; r < lines.length; r++) {
          var row = lines[r]
          html.push('<div class="ec-line ec-' + row.kind + '">' +
            '<span class="ec-no">' + (row.old === undefined ? '' : row.old) + '</span>' +
            '<span class="ec-no">' + (row.now === undefined ? '' : row.now) + '</span>' +
            '<span class="ec-sign">' + (row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ') + '</span>' +
            '<span class="ec-text">' + (row.text === '' ? '\u00a0' : esc(row.text)) + '</span></div>')
        }
        html.push('</section>')
      }
      body.innerHTML = html.join('')
      body.setAttribute('data-view', 'unified')
      if (state.wrap) body.setAttribute('data-wrap', '')
      else body.removeAttribute('data-wrap')
    }

    var offsets = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } }
    function bindColumnScroll() {
      var left = body.querySelector('.ec-column[data-side="left"]')
      var right = body.querySelector('.ec-column[data-side="right"]')
      if (!left || !right) return
      function follow(side) {
        return function () {
          var self = side === 'left' ? left : right
          var other = side === 'left' ? right : left
          var peer = side === 'left' ? 'right' : 'left'
          var axes = [['scrollLeft', 'x'], ['scrollTop', 'y']]
          for (var i = 0; i < axes.length; i++) {
            var value = self[axes[i][0]]
            if (offsets[side][axes[i][1]] === value) continue
            offsets[side][axes[i][1]] = value
            other[axes[i][0]] = value
            offsets[peer][axes[i][1]] = other[axes[i][0]]
          }
        }
      }
      left.addEventListener('scroll', follow('left'))
      right.addEventListener('scroll', follow('right'))
    }

    function render() {
      var round = currentRound()
      renderRounds()
      fileName.textContent = state.file ? (state.file.display || state.file.path) : ''
      addedEl.textContent = round ? '+' + round.added : ''
      deletedEl.textContent = round ? '-' + round.deleted : ''
      btnSplit.setAttribute('aria-pressed', state.split ? 'true' : 'false')
      root.setAttribute('data-view', state.view)
      statusEl.hidden = !(state.busy || state.failure)
      statusEl.textContent = state.failure ? state.failure : state.busy ? '正在读取改动…' : ''
      renderBody()
    }

    function snapshot() {
      var round = currentRound()
      return {
        ns: ns,
        file: state.file ? state.file.path : '',
        label: state.label,
        path: state.path,
        session: state.session,
        view: state.view,
        rounds: state.rounds.length,
        turn: round ? round.turn : 0,
        split: state.split,
        wrap: state.wrap,
        added: round ? round.added : 0,
        deleted: round ? round.deleted : 0,
        contentLines: state.content ? state.content.split('\n').length : 0,
        busy: state.busy,
        failure: state.failure || null
      }
    }

    // ---------- 数据 ----------
    function emit(ev, data) {
      var payload = data || {}
      try { onEvent(ev, payload) } catch (_e) { /* 宿主回调异常不影响组件 */ }
      sendToHost({ type: ns + '-event', ev: ev, data: payload })
    }
    function sendToHost(message) {
      if (win.parent === win) return
      try { win.parent.postMessage(message, '*') } catch (_e) { /* 忽略跨源发送失败 */ }
    }

    function load() {
      if (!dataUrl) {
        state.failure = '未配置数据接口'
        state.busy = false
        render()
        return Promise.resolve({ ok: false, error: state.failure })
      }
      state.busy = true
      state.failure = ''
      var url = dataUrl
      if (state.path) {
        url += (url.indexOf('?') >= 0 ? '&' : '?') + 'path=' + encodeURIComponent(state.path)
        if (state.session) url += '&session=' + encodeURIComponent(state.session)
        if (state.label) url += '&label=' + encodeURIComponent(state.label)
      }
      render()
      // 同源宿主（Floria 网关）鉴权走 floria_auth cookie，必须带凭据；跨源部署时同源凭据策略自然不发送。
      return win.fetch(url, { cache: 'no-store', credentials: 'same-origin' })
        .then(function (res) { return res.json() })
        .then(function (data) {
          if (!data || data.ok === false) throw new Error((data && data.error) || '读取改动失败')
          if (!Array.isArray(data.rounds)) throw new Error('响应缺少 rounds')
          state.file = data.file && typeof data.file === 'object' ? data.file : null
          state.rounds = data.rounds
          state.turn = data.rounds.length ? data.rounds.length - 1 : 0
          state.content = typeof data.content === 'string' ? data.content : ''
          state.note = typeof data.note === 'string' ? data.note : ''
          state.busy = false
          render()
          emit('loaded', { file: state.file, path: state.path, session: state.session, rounds: data.rounds.length })
          return { ok: true, state: snapshot() }
        })
        .catch(function (err) {
          state.busy = false
          state.failure = '读取改动失败：' + String((err && err.message) || err)
          state.rounds = []
          state.content = ''
          state.note = ''
          render()
          emit('load-failed', { error: state.failure })
          return { ok: false, error: state.failure }
        })
    }

    /** FileOpen：设置目标文件与会话，拉取该会话的「最新一轮」历史对比。 */
    function openFile(args) {
      var path = args && typeof args.path === 'string' ? args.path.trim() : ''
      if (!path) return { ok: false, error: 'fileopen 需要 path' }
      if (args && typeof args.dataUrl === 'string' && args.dataUrl) dataUrl = args.dataUrl
      if (args && typeof args.label === 'string') state.label = args.label.trim()
      state.path = path
      // tab 标题 = 文件 basename（openFile 即生效；后续读取失败也不改回，宿主可稳定回读）
      if (doc.title !== undefined) doc.title = fileTitleOf(path) || '编辑标签页'
      state.session = args && typeof args.session === 'string' ? args.session.trim() : ''
      state.view = 'diff'
      state.rounds = []
      state.turn = 0
      emit('fileopen', { label: state.label, path: state.path, session: state.session })
      return load()
    }

    function select(turn) {
      if (!state.rounds.length) return { ok: false, error: '没有可选的轮次' }
      if (typeof turn !== 'number' || turn < 0 || turn >= state.rounds.length) return { ok: false, error: '轮次超出范围' }
      state.turn = turn
      state.view = 'diff'
      render()
      emit('round', { turn: state.rounds[turn].turn })
      return { ok: true, state: snapshot() }
    }

    function setView(view) {
      if (view !== 'diff' && view !== 'file') return { ok: false, error: 'view 只能是 diff / file' }
      state.view = view
      render()
      emit('view', { view: state.view })
      return { ok: true, state: snapshot() }
    }

    function setSplit(enabled) {
      state.split = !!enabled
      render()
      emit('split', { enabled: state.split })
      return { ok: true, state: snapshot() }
    }

    function setWrap(enabled) {
      state.wrap = !!enabled
      render()
      emit('wrap', { enabled: state.wrap })
      return { ok: true, state: snapshot() }
    }

    var COMMANDS = {
      fileopen: function (a) { return openFile(a) },
      load: function () { return load() },
      select: function (a) { return select(a && a.turn) },
      view: function (a) { return setView(a && a.view) },
      split: function (a) { return setSplit(a && a.enabled) },
      wrap: function (a) { return setWrap(a && a.enabled) },
      state: function () { return snapshot() }
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

    // ---------- 绑定 ----------
    function onTool(e) {
      var tool = e.currentTarget.getAttribute('data-tool')
      if (tool === 'split') setSplit(!state.split)
    }
    /** Alt+Z 切换自动换行（VS Code 惯例）：焦点在卡内或 body 时生效，AltGr/组合键不劫持。 */
    function onKeyDown(e) {
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      if (e.code !== 'KeyZ' && e.key !== 'z' && e.key !== 'Z' && e.key !== 'Ω') return
      var t = e.target
      var tag = t && t.tagName ? t.tagName : ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return
      e.preventDefault()
      setWrap(!state.wrap)
    }
    function onMessage(e) {
      var d = e.data
      if (!d || d.type !== ns + '-cmd') return
      if (e.source !== win.parent) return
      dispatch(d.cmd, d.args).then(function (res) {
        sendToHost({ type: ns + '-event', ev: 'ack', cmd: d.cmd, ok: res.ok, result: res.result, error: res.error })
      })
    }

    btnSplit.addEventListener('click', onTool)
    win.addEventListener('message', onMessage)
    doc.addEventListener('keydown', onKeyDown)

    render()
    load()
    if (win.parent !== win) sendToHost({ type: ns + '-event', ev: 'ready', data: { ns: ns, cmds: Object.keys(COMMANDS), state: snapshot() } })

    return {
      openFile: function (args) { return dispatch('fileopen', args) },
      load: function () { return dispatch('load') },
      select: function (turn) { return dispatch('select', { turn: turn }) },
      setView: function (view) { return dispatch('view', { view: view }) },
      setSplit: function (enabled) { return dispatch('split', { enabled: enabled }) },
      setWrap: function (enabled) { return dispatch('wrap', { enabled: enabled }) },
      state: function () { return snapshot() },
      dispatch: dispatch,
      destroy: function () {
        if (destroyed) return
        destroyed = true
        win.removeEventListener('message', onMessage)
        doc.removeEventListener('keydown', onKeyDown)
        root.innerHTML = ''
        root.classList.remove('ec-root')
      }
    }
  }

  global.UIDesignEditCard = { mount: mount }
})(typeof window !== 'undefined' ? window : this)
