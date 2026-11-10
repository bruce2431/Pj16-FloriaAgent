// 编辑卡外部改动实时同步（Obsidian 式）：0.5s HEAD 探测当前文件 mtime → 无脏直接换内容、
// 有脏走行级三方合并（work-merge.js）后写回；只有真正重叠才给非模态提示条。
// 真源始终是磁盘：AI/外部编辑器写文件后编辑器随之呈现，不再需要手动重开。
/* @module sidebar/work/work-live.js */

  const WK_LIVE_MS = 500
  let wkLiveT = 0
  let wkLiveBusy = false
  let wkLivePendingMtime = null // 连续两次 HEAD 得到同一个新 mtime 才采纳（防 AI 非原子写读到半截）
  let wkLivePausedKey = ''      // 冲突未处置时的 (proj\path)；换文件自动解除
  let wkLiveKickPending = false // 探测在途时收到的立即重试请求：本轮收尾后补跑，不丢（保存 409 后的合并不能等下一轮）

  function wkLiveKey() {
    return state.workProj + '\n' + state.workFile
  }

  function setWkRemoteNote(text) {
    const el = $('wk-ed-remote')
    if (!el) return
    el.hidden = !text
    const t = el.querySelector('.wk-ed-remote-txt')
    if (t) t.textContent = text || ''
  }

  // 重置探测/暂停态（换文件、切项目、重载、退 work 共用）
  function wkLiveReset() {
    wkLivePendingMtime = null
    wkLivePausedKey = ''
    wkLiveKickPending = false
    setWkRemoteNote('')
  }

  function startWorkLive() {
    if (!wkLiveT) wkLiveT = setInterval(() => { wkLiveTick(false) }, WK_LIVE_MS)
  }
  function stopWorkLive() {
    if (wkLiveT) {
      clearInterval(wkLiveT)
      wkLiveT = 0
    }
    wkLiveBusy = false
    wkLiveReset()
  }

  // 立即探测一次（保存 409 后由保存链调用；跳过「两次确认」，冲突处置不能再等一轮）
  function wkLiveKick() {
    // 探测在途：记下待办，由 finally 补跑——否则 409 后的强制合并会被静默丢弃，白等一轮轮询
    if (wkLiveBusy) {
      wkLiveKickPending = true
      return
    }
    wkLiveTick(true)
  }

  async function wkLiveTick(force) {
    if (wkLiveBusy) return
    if (state.sbMode !== 'work' || document.visibilityState !== 'visible' || needToken()) return
    if (!state.workFile || !state.workProj) return
    if (!wkEdMeta || !wkEdMeta.editable) return
    if (wkEdSaving) return
    const key = wkLiveKey()
    // 暂停态挡的是自动轮询；force（保存 409 后的立即重试）必须绕过它，否则冲突后 Ctrl+S 永远不再尝试合并。
    if (wkLivePausedKey === key && !force) return
    if (wkLivePausedKey) {
      // 换文件留下的暂停态：连提示一起清；同文件显式重试：先解暂停，提示留到结果（仍冲突会重写、合并成功才清）
      if (!force) wkLiveReset()
      else { wkLivePausedKey = ''; wkLivePendingMtime = null }
    }
    const proj = state.workProj
    const path = state.workFile
    const seq = edSeq
    wkLiveBusy = true
    try {
      const res = await fetch(fileUrl(path), { method: 'HEAD', cache: 'no-store' })
      if (proj !== state.workProj || path !== state.workFile || seq !== edSeq) return
      if (res.status === 404) {
        // 外部删除：无本地改动 → 与「打开着的文件消失」同语义摘胶囊；有改动则保留内容并提示
        if (wkEdDirty) return wkLiveConflict('文件已在外部删除，编辑器保留你的未保存内容')
        wkLiveReset()
        wkDropDeadFile(path)
        return
      }
      if (!res.ok) {
        wkLivePendingMtime = null // 413/网络错误不是「文件变了」，下轮重试
        return
      }
      const etag = res.headers.get('etag')
      const mtime = etag ? Number(etag.replace(/"/g, '')) : NaN
      if (!Number.isFinite(mtime)) return
      if (mtime === wkEdMtime) {
        wkLivePendingMtime = null
        return
      }
      if (!force) {
        if (wkLivePendingMtime !== mtime) {
          wkLivePendingMtime = mtime
          return // 首次看到新 mtime：等下一轮确认（写盘可能还未完成）
        }
      }
      wkLivePendingMtime = null
      await wkLiveAdopt(proj, path, seq, mtime)
    } catch {
      /* 瞬时网络错误忽略，下轮重试 */
    } finally {
      wkLiveBusy = false
      if (wkLiveKickPending) {
        wkLiveKickPending = false
        wkLiveTick(true)
      }
    }
  }

  // 采纳一次外部变更：拉新内容 → 无脏直接换 / 有脏三方合并写回
  async function wkLiveAdopt(proj, path, seq, headMtime) {
    // 探测期间自动保存在途：它的写盘会推进基线/磁盘 mtime，此刻采纳会基于旧基线，交给下一轮重判
    if (wkEdSaving) return
    const res = await fetch(fileUrl(path), { cache: 'no-store' })
    if (proj !== state.workProj || path !== state.workFile || seq !== edSeq) return
    if (!res.ok) return
    const text = await res.text()
    if (proj !== state.workProj || path !== state.workFile || seq !== edSeq) return
    const etag = res.headers.get('etag')
    let mtime = etag ? Number(etag.replace(/"/g, '')) : NaN
    if (!Number.isFinite(mtime)) mtime = headMtime
    if (!wkEdDirty) {
      // 无未落盘编辑：最小段替换直接映进编辑器（光标/选区/滚动由 CM 按变更映射）
      if (!wkEdApplyRemote(text)) return // IME 组合中：本轮放弃，下轮重试
      wkEdText = text
      wkEdMtime = mtime
      wkEdConflict = false
      wkEdState('')
      setWkRemoteNote('')
      return
    }
    await wkLiveMergeAndSave(proj, path, seq, text, mtime, 2)
  }

  // 有脏：三方合并（base = 上次磁盘基线 wkEdText）→ 写回；409 = 期间磁盘又变 → 重取重合并
  async function wkLiveMergeAndSave(proj, path, seq, remote, baseMtime, retries) {
    // 在途保存会让 base/磁盘再变：跳过本轮，下一轮重新取远端重合并（不能在这里判冲突）
    if (wkEdSaving) return
    const merged = wkMerge3(wkEdText, wkEdDocText(), remote)
    if (!merged.ok) {
      return wkLiveConflict(
        merged.reason === 'too-large'
          ? '文件改动较大且与本地编辑重叠，已保留本地内容'
          : '文件已在外部更新且与本地编辑重叠，已保留本地内容'
      )
    }
    if (merged.text !== wkEdDocText()) {
      if (!wkEdApplyRemote(merged.text)) return
      // 合并结果是必须落盘的本地内容：程序性 dispatch 不记脏，这里按「与磁盘基线是否一致」补脏，
      // 否则并发保存刚好在合并前落盘时，这次合并会被 wkEdSave 判成 clean 而静默丢失。
      wkEdDirty = wkEdDocText() !== wkEdText
    }
    wkEdMtime = baseMtime
    const r = await wkEdSave({})
    if (r === 'ok' || r === 'clean') {
      wkLiveReset()
      return
    }
    // busy = 另一笔保存在途（紧随其后的自动保存会带上本次合并内容），不是冲突，下一轮重判
    if (r === 'busy') return
    if (r !== 'conflict' || retries <= 0) {
      return wkLiveConflict('外部改动频繁且与本地编辑重叠，已保留本地内容')
    }
    // 409：磁盘在我们合并期间又变了 → 取最新内容再合一次（base 仍是 wkEdText）
    const res = await fetch(fileUrl(path), { cache: 'no-store' })
    if (!res.ok) return
    const nextRemote = await res.text()
    if (proj !== state.workProj || path !== state.workFile || seq !== edSeq) return
    const etag = res.headers.get('etag')
    let nextMtime = etag ? Number(etag.replace(/"/g, '')) : NaN
    if (!Number.isFinite(nextMtime)) return
    return wkLiveMergeAndSave(proj, path, seq, nextRemote, nextMtime, retries - 1)
  }

  // 非模态提示：保留本地内容，暂停本文件的自动保存与实时同步，等用户显式处置
  function wkLiveConflict(text) {
    wkLivePausedKey = wkLiveKey()
    wkEdConflict = true
    wkEdState('外部已修改', 'conflict')
    setWkRemoteNote(text)
  }

  // 提示条「保留我的版本」：放弃磁盘那次外部改动、以本地内容强制覆盖（原模态的「确定」分支）
  async function wkLiveKeepLocal() {
    if (!state.workFile) return
    wkLiveReset()
    wkEdConflict = false
    await wkEdSave({ force: true })
    wkEdState('')
  }

  // 提示条「载入磁盘版本」：放弃本地编辑，重读磁盘（404 时按文件消失语义收口）
  async function wkLiveTakeRemote() {
    if (!state.workFile) return
    wkLiveReset()
    wkEdDirty = false
    wkEdConflict = false
    await wkEdReload()
    wkEdState('')
  }
