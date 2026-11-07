// 卡片上游仓库与版本（插件卡「应用」详情共用：work 项目卡片页 + chat 全局应用页）。
// 版本由网关 /gateway/repo-version 从上游拉取（Release → tag → package.json 回退），前端只做缓存展示。
// 仓库写回按卡片来源分两条：preview.json 应用 → 工作区根 preview.json 的 cards[].repo；
// card.json 卡片 → 该项目 .claude/preview/<id>/card.json 顶层 repo。唯一手改处，web/app.js 为生成物。

import { apiUrl } from '../engine/gateway.js'
import { esc, toast } from '../core/util.js'
/* @module feature/card-repo.js */

  const VERSION_TTL_MS = 5 * 60 * 1000
  const versionCache = new Map() // repo → { version, at }
  const versionPending = new Map() // repo → Promise

  const repoKey = (repo) => String(repo || '').trim()

  // 已缓存的版本（同步取；未拉过返回 ''）
  function cachedRepoVersion(repo) {
    const hit = versionCache.get(repoKey(repo))
    return hit ? hit.version : ''
  }

  // 拉一次上游版本（按 repo 去重、5 分钟缓存）。完成后回调 onDone（调用方据此就地刷新版本行）。
  function ensureRepoVersion(repo, onDone) {
    const key = repoKey(repo)
    if (!key) return
    const hit = versionCache.get(key)
    if (hit && Date.now() - hit.at < VERSION_TTL_MS) return
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

  // 仓库变更后作废旧版本，下一次打开详情重新拉
  function invalidateRepoVersion(repo) {
    versionCache.delete(repoKey(repo))
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

  // 信息表末尾的「上游仓库」业务行（值可编辑）。只把 http(s) 渲成链接，用户输入不直进 href。
  function repoRowHtml(repo) {
    const safeRepo = /^https?:\/\/[^\s]+$/i.test(repo || '') ? repo : ''
    return '<div class="mgr-dl-kvrow mgr-repo-row"><dt>上游仓库</dt><dd class="mgr-repo-dd">' +
      (repo
        ? (safeRepo
          ? `<a class="mgr-repo-link" href="${esc(safeRepo)}" target="_blank" rel="noopener">${esc(repo)}</a>`
          : `<span class="mgr-repo-plain">${esc(repo)}</span>`)
        : '<span class="mgr-repo-empty">未填写</span>') +
      `<button class="mgr-repo-edit" type="button">${repo ? '修改' : '填写'}</button></dd></div>`
  }

  // 就地编辑：填写/修改 → 输入框 → 保存调 saveRepo(val)（落盘），完成后 done() 整页重渲。
  // 冲突/失败一律 toast，不静默覆盖。
  function bindRepoEdit(body, opts) {
    const it = opts || {}
    const btn = body.querySelector('.mgr-repo-edit')
    if (!btn) return
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const dd = btn.closest('.mgr-repo-dd')
      if (!dd || dd.querySelector('.mgr-repo-in')) return
      dd.innerHTML =
        `<input class="mgr-repo-in" type="text" value="${esc(it.repo || '')}" placeholder="https://github.com/owner/repo" spellcheck="false">` +
        '<button class="mgr-repo-save" type="button">保存</button>' +
        '<button class="mgr-repo-cancel" type="button">取消</button>'
      const inp = dd.querySelector('.mgr-repo-in')
      inp.focus()
      inp.select()
      dd.querySelector('.mgr-repo-cancel').addEventListener('click', () => it.done && it.done())
      const save = async () => {
        const val = inp.value.trim()
        if (val && !/^https?:\/\/[^\s]+$/i.test(val)) { toast('仓库地址需以 http(s):// 开头'); return }
        try {
          await it.save(val)
          invalidateRepoVersion(val)
          toast(val ? '已保存上游仓库' : '已清除上游仓库')
          if (it.done) it.done()
        } catch (err) {
          toast('保存失败：' + (err && err.message ? err.message : String(err)))
        }
      }
      dd.querySelector('.mgr-repo-save').addEventListener('click', save)
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); save() }
        else if (ev.key === 'Escape') { ev.preventDefault(); if (it.done) it.done() }
      })
    })
  }

  // 读 JSON 文件 + mtime 基线（写回冲突检测用）
  async function readJsonFile(label, path) {
    const res = await fetch(apiUrl('/gateway/file?label=' + encodeURIComponent(label) + '&path=' + encodeURIComponent(path)))
    if (!res.ok) throw new Error('读取 ' + path + ' 失败（HTTP ' + res.status + '）')
    const baseMtime = Number(String(res.headers.get('ETag') || '').replace(/"/g, '')) || undefined
    let json
    try { json = JSON.parse(await res.text()) } catch { throw new Error(path + ' 不是合法 JSON') }
    return { json, baseMtime }
  }

  async function writeJsonFile(label, path, json, baseMtime) {
    const w = await fetch(apiUrl('/gateway/file/write'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, path, content: JSON.stringify(json, null, 2) + '\n', baseMtime }),
    })
    if (!w.ok) {
      const d = await w.json().catch(() => ({}))
      throw new Error(w.status === 409 ? '文件已被他人修改，请重试' : (d.error || 'HTTP ' + w.status))
    }
  }

  // preview.json 应用：写 cards[].repo
  async function savePreviewJsonRepo(label, id, repo) {
    const path = '.claude/preview/preview.json'
    const { json, baseMtime } = await readJsonFile(label, path)
    const cards = Array.isArray(json && json.cards) ? json.cards : []
    const card = cards.find((c) => c && typeof c === 'object' && c.id === id)
    if (!card) throw new Error('preview.json 里没有该应用')
    if (repo) card.repo = repo
    else delete card.repo
    await writeJsonFile(label, path, json, baseMtime)
  }

  // card.json 卡片：写 <卡目录>/card.json 顶层 repo（其余字段原样保留）
  async function saveCardJsonRepo(label, cardId, repo) {
    const path = `.claude/preview/${cardId}/card.json`
    const { json, baseMtime } = await readJsonFile(label, path)
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('card.json 结构非法')
    if (repo) json.repo = repo
    else delete json.repo
    await writeJsonFile(label, path, json, baseMtime)
  }

export {
  bindRepoEdit,
  cachedRepoVersion,
  ensureRepoVersion,
  fillVersionRow,
  invalidateRepoVersion,
  repoRowHtml,
  saveCardJsonRepo,
  savePreviewJsonRepo,
}
