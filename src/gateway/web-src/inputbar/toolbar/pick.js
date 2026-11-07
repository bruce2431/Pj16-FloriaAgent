// 工具栏文件层（2026-11-07 工具栏模块化切割自 inputbar/mention.js；唯一手改处，web/app.js 为生成物）
// 纯数据层：逐级浏览 + 项目内递归索引；不碰 DOM，重渲由调用方回调负责。

import { apiUrl } from '../../engine/gateway.js'
import { pickHome } from './scope.js'
/* @module inputbar/toolbar/pick.js */
  // ---------- 目录 / 文件引用（2026-09-26）：@ 浮窗与 + 工具栏共用的一组「逐级浏览」状态 ----------
  // 数据源 = GET /gateway/fs?path=<相对工作区根的子路径>（只读单层；网关侧复用 listOneLevel，跳过隐藏项
  // 与重型目录、目录在前、单层不设条数上限）。pick.path 是**相对工作区根**的当前层路径，'' = 根——与 chip 上行的
  // 路径同基准（用户定案：相对全局根）。令牌形态 [@目录:路径] / [@文件:路径] 见 core/mention-syntax.js。
  // entries: null=未加载；[]=空目录；[TreeNode…]=已加载。seq 丢弃迟到的旧响应（快速连点目录）。
  // searchOff：搜索/浏览模式开关（2026-10-14 待办 20）——false 且查询非空 = 递归搜索模式（范围 = pickAll.root）；
  // 下钻/返回目录后翻 true（回到层内浏览），浮窗重开（refreshPick）复位 false。
  const pick = { path: '', entries: null, loading: false, err: '', seq: 0, searchOff: false, q: '' }
  // 递归清单（待办 20 的数据层）：BFS 逐层 /gateway/fs（每层分批并发，层间 await）。
  // **扫描根 = pickAll.root = 当前上下文项目目录（pickHome）**，只有全局上下文才是工作区根——
  // 搜索范围与层内浏览同基准，检索不跨项目（2026-11-07 用户实报「在 Pj8 工作，工具栏检索串项目」：
  // 此前根恒为 ''，一次搜索把其它项目的同名文件全列出来）。
  // 不设深度/目录数/条目数上限——当前项目内任意深度都能命中（2026-10-25 用户定案：截断过于严重，
  // 应显示全部）。隐藏目录与 node_modules/dist/.git 等仍由网关侧跳过。
  // 浮窗每次打开经 refreshPick 重置重建（目录内容是外部可变状态，不跨打开缓存）。
  // items 是**流式**清单：BFS 每扫完一批目录就并进去（用户边打边出结果，不必等全量跑完），
  // done=true 才表示跑完整轮。浮窗打开即预热（refreshPick），打字时通常已可用。
  const pickAll = { items: [], done: false, busy: false, seq: 0, err: '', onProgress: null, root: '' }
  const PICK_FS_CONCURRENCY = 24

  function pickParent() {
    const p = pick.path
    const i = p.lastIndexOf('/')
    return i < 0 ? '' : p.slice(0, i)
  }
  function pickLabel() {
    // 搜索模式（2026-10-14 待办 20）：文件组标题提示结果口径（层内浏览则照旧标当前层）。
    // 范围写进标题（= pickAll.root，即当前上下文项目；全局 = 工作区根），用户一眼能看出没跨项目。
    if (pick.q && !pick.searchOff) {
      const scope = pickAll.root || '工作区根'
      return scope + (pickAll.done ? ' · 搜索' : ' · 搜索中…')
    }
    if (pick.loading) return '加载中…'
    if (pick.err) return '加载失败'
    return pick.path || '工作区根'
  }
  // 构建项目内递归清单（幂等；构建期间 busy 挡重入，seq 丢弃被 refreshPick 作废的旧轮）。
  // 完成不自行重渲——由调用方的 after 回调负责（浮窗还开着才重渲）。
  async function ensurePickAll() {
    if (pickAll.done || pickAll.busy) return
    pickAll.busy = true
    const seq = ++pickAll.seq
    const seed = pickAll.root
    let layer = [seed]
    const seen = new Set()
    let rootErr = ''
    try {
      while (layer.length) {
        const next = []
        // 分批并发：整层一次打出去会在目录多的工作区形成数百并发请求（本地网关也能被拖慢）
        for (let i = 0; i < layer.length; i += PICK_FS_CONCURRENCY) {
          const batchItems = []
          const batchDirs = []
          await Promise.all(
            layer.slice(i, i + PICK_FS_CONCURRENCY).map(async (p) => {
              try {
                const r = await fetch(apiUrl('/gateway/fs?path=' + encodeURIComponent(p)))
                const data = await r.json()
                if (!r.ok || !data || !Array.isArray(data.entries)) {
                  // 扫描根失败 = 整份清单不可信（空结果会谎报「无匹配」）：记错并作废本轮，浮窗重开再试。
                  if (p === seed) rootErr = (data && data.error) || `索引失败：${seed || '工作区根'}`
                  return
                }
                for (const e of data.entries) {
                  const cp = p ? `${p}/${e.name}` : e.name
                  batchItems.push({ ptype: e.type === 'dir' ? 'dir' : 'file', name: e.name, path: cp, mtime: e.mtime || 0 })
                  if (e.type === 'dir' && !seen.has(cp)) {
                    seen.add(cp)
                    batchDirs.push(cp)
                  }
                }
              } catch (e) {
                /* 子层失败跳过，不拖垮整轮（扫描根失败另记） */
                if (p === seed) rootErr = e.message || `索引失败：${seed || '工作区根'}`
              }
            }),
          )
          if (seq !== pickAll.seq) return
          // 流式并进清单：本批结果立刻可被 pickItems 检索到，并立刻重渲一次浮窗。
          pickAll.items.push(...batchItems)
          next.push(...batchDirs)
          if (pickAll.onProgress) pickAll.onProgress()
        }
        layer = next
      }
    } finally {
      if (seq === pickAll.seq) {
        pickAll.busy = false
        pickAll.done = !rootErr
        if (rootErr) { pickAll.items = []; pickAll.err = rootErr }
        else pickAll.err = ''
        // 收尾也要重渲一次：否则尾部「搜索中…」会一直挂着（pickSearchKick 只在未开跑时挂 .then）
        if (pickAll.onProgress) pickAll.onProgress()
      }
    }
  }
  // 搜索模式的异步补拉口（两个浮窗的渲染函数各调一次）：查询非空且处于搜索模式、清单未建 →
  // 建清单，完成后浮窗仍开着才重渲。
  function pickSearchKick(re) {
    // 清单流式产出：构建期间每批都回调（有结果立刻显示）；err 非空 = 上一轮根层失败，
    // 不随每次按键重试（会变成按键风暴），等浮窗重开 refreshPick 复位。
    if (pick.q && !pick.searchOff && !pickAll.done && !pickAll.busy && !pickAll.err) {
      pickAll.onProgress = re
      ensurePickAll().then(() => { if (pickAll.onProgress) pickAll.onProgress() }).catch(() => {})
    }
  }
  // 加载某一层（path 相对工作区根）。完成后由调用方重渲自己的浮窗（本函数不碰 DOM）。
  async function loadPickPath(path) {
    const seq = ++pick.seq
    pick.path = String(path || '')
    pick.loading = true
    pick.err = ''
    try {
      const res = await fetch(apiUrl('/gateway/fs?path=' + encodeURIComponent(pick.path)))
      const data = await res.json()
      if (seq !== pick.seq) return false
      if (!res.ok || data.error) throw new Error(data.error || '加载失败')
      pick.entries = Array.isArray(data.entries) ? data.entries : []
    } catch (e) {
      if (seq !== pick.seq) return false
      pick.entries = null
      pick.err = e.message || String(e)
    } finally {
      if (seq === pick.seq) pick.loading = false
    }
    return seq === pick.seq
  }
  // 当前层的可选条目 / 递归搜索结果（2026-10-14 待办 20）。
  // q 为空或已下钻（searchOff）= 原层内浏览：上级目录行 + 当前层全部（按 q 过滤后同样全列）。
  // q 非空且未下钻 = 递归搜索：**当前上下文项目内**的递归清单（pickAll，根 = pickAll.root）
  // 按名称过滤，命中多少列多少（不截断）；不再扫到别的项目。
  // 清单未就绪时文件组暂空（其余组照常），pickSearchKick 建完重渲补上。
  // 「上级目录」只取决于「当前是不是工作区根」，与**这一层的内容**无关——故加载中/加载失败时它照样在，
  // 否则某一层拉不到（目录已删/端点失败）就退不回去，整个文件组成死层。条目本身不塞假行。
  function pickItems(q) {
    const ql = (q || '').trim().toLowerCase()
    pick.q = ql
    const items = []
    if (ql && !pick.searchOff) {
      for (const e of pickAll.items) {
        if (!e.name.toLowerCase().includes(ql)) continue
        items.push({ kind: 'path', ptype: e.ptype, name: e.name, path: e.path, glob: true, t: e.mtime || 0 })
      }
      return items
    }
    if (pick.path) items.push({ kind: 'pathup', name: '上级目录', path: pickParent() })
    if (pick.loading || !pick.entries) return items
    for (const e of pick.entries) {
      if (ql && !String(e.name).toLowerCase().includes(ql)) continue
      const p = pick.path ? `${pick.path}/${e.name}` : e.name
      items.push({ kind: 'path', ptype: e.type === 'dir' ? 'dir' : 'file', name: e.name, path: p, t: e.mtime || 0 })
    }
    return items
  }
  // 目录项进入下一层 / 上级目录返回（两个浮窗的选择入口共用同一处判定）。下钻 = 用户已明确
  // 「要看这个位置」→ 翻回层内浏览模式（此后 q 只做层内过滤，不再全局搜）。
  function pickEnter(it) {
    pick.searchOff = true
    return loadPickPath(it.path)
  }
  // 浮窗打开时定位到当前上下文项目并加载该层（不缓存：目录内容是外部可变状态，缓存会让新建的文件不可见）。
  // **每次打开都回到项目层**（同 @ 浮窗每次打开重置 q/sel）——打开是新的一轮手势，不是接着上次浏览的位置；
  // 层内下钻/返回由 pickEnter 自己拉，走同一处 loadPickPath。
  function refreshPick(after) {
    pick.entries = null // 立刻清旧层：否则换项目后先闪一帧上一个项目的条目（在途请求由 loadPickPath 的 seq 作废）
    pick.err = ''
    pick.q = '' // 查询/层级同属上一轮手势：不复位会先渲一帧旧查询结果（两个浮窗共用本状态）
    pick.path = ''
    pick.searchOff = false // 浮窗重开 = 新一轮手势：回到递归搜索模式（待办 20；范围见 pickAll.root）
    pickAll.items = [] // 递归清单随打开重建（目录内容外部可变，不跨打开缓存；在途轮由 seq 作废）
    pickAll.done = false
    pickAll.err = ''
    pickAll.seq++
    // 搜索根与层内浏览同基准（pickHome：会话所属项目 / work 工作项目；空串 = 全局 → 工作区根）。
    // 搜索只扫这一棵子树，不再跨项目（2026-11-07 用户实报「在 Pj8 工作，工具栏检索串项目」）。
    pickAll.root = pickHome()
    // 作废在途轮时必须同步释放 busy：旧轮 finally 见 seq 不符只跳过写回、不会复位 busy，
    // 否则下一次输入永远起不了新轮（文件搜索整组空白）
    pickAll.busy = false
    // 打开即预热递归清单（不等用户打出查询词才开始扫：早开始早出结果）。
    // 流式批回调与层加载共用 after（渲染点已判 cmd.open）。
    pickAll.onProgress = after || null
    ensurePickAll().catch(() => {})
    loadPickPath(pickAll.root).then((ok) => { if (ok && after) after() })
  }
