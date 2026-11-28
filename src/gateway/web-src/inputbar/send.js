// 发送编排（gwSend/syncGwSend）（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { pendingUserMsgs, addUser } from '../chat/messages.js'
import { navigate, mountInput, flipInput, renderSession } from '../chat/route.js'
import { stage } from '../chat/stage.js'
import { GATEWAY, gws } from '../engine/gateway.js'
import { refreshSession } from '../engine/live.js'
import { chatArea, messagesEl, inputWrap, inputEl, sendBtn, state, live } from '../engine/state.js'
import { toast, newSessionProject } from '../core/util.js'
import { sessionCwd, setSessionCwd } from '../engine/sessions.js'
import { renderTransient, turnLive, setBtnMode } from './approval.js'
import { pendingImages, pendingFiles, clearPendingImages, clearPendingFiles } from './images.js'
import { serializeInput, closeMentionPop } from './mention.js'
import { webCreating, firstSendHash, newWebSession } from '../sidebar/recent.js'
import { getNewSessionModel, setNewSessionModel, getNewSessionProvider, setNewSessionProvider } from './model-select.js'
/* @module inputbar/send.js */
  async function gwSend() {
    if (!GATEWAY) return false
    closeMentionPop()
    let text = serializeInput().trim()
    const imgs = pendingImages.slice()
    const files = pendingFiles.slice()
    if (!text && !imgs.length && !files.length) { composerFocus(); return true }
    if (!gws || gws.readyState !== 1) { toast('未连接，无法发送'); return true }
    // 2026-08-28 图片占位：[Image #N] 与 pastedContents id 一一对应。
    // 2026-09-02 防撞根修：id 由本端分配全会话唯一（从已用最大 imageId+1 起，对齐 CLI
    // getInitialPasteId 语义），随 images 显式上行——CLI pastedContentsFromImages 尊重显式 id。
    // 原恒从 1 起：同会话第二条带图消息互覆 file-cache 字节 → 历史图错图。
    if (imgs.length) {
      const base = live.maxImgId || 0
      imgs.forEach((im, i) => { im.id = base + 1 + i })
      live.maxImgId = base + imgs.length
      const ph = imgs.map((im) => `[Image #${im.id}]`).join(' ')
      text = text ? text + ' ' + ph : ph
    }
    const imgPayload = imgs.length
      ? { images: imgs.map(p => ({ id: p.id, content: p.content, mediaType: p.mediaType, filename: p.filename })) }
      : {}
    // 2026-08-24 首页空态首条消息触发：未在具体会话（#/ 空态）输入第一条消息
    // → 先创建 web 会话（网关 spawn 本地可见 CLI 窗口，返回后 CLI 已连 /clients），
    // 再进会话发送首条消息。web 会话 = 本地可见交互 CLI 窗口（用户本地也可直接操作）。
    // 2026-08-25 项目「+」先到初始化界面：state.newProject 有值 → 建会话时带上 project 落到该项目组；
    // 用完即清（正常进会话后 currentHash 已设置，不再进此分支）。
    // 2026-08-24 防双 spawn：创建期间（POST /gateway/wsession 等 CLI 注册，最长 20s）置 webCreating，
    // 期间再发送直接忽略（否则每发一条都新建一个会话）；创建完成后 currentHash 已由 navigate 设置。
    if (!state.currentHash) {
      if (webCreating) { toast('正在创建会话，请稍候…'); return true }
      const tgt = newSessionProject() // work 模式 = 工作项目（seat 只读，见 state.newSessionProject）
      const prevNew = state.newProject // 回滚用：清的是「目标项目」这一个槽，work 模式压根不读它
      state.newProject = null // 消费即清：目标项目一次性，下一次回默认全局
      // 首页模型选择（2026-10-11）：待定槽消费即清，失败回滚时还原（同 newProject 一次性语义）。
      // 它只作用于本次新建会话——随建会话请求下发，网关 spawn 时落 --model 启动参数（见 newWebSession），
      // 不改全局默认（全局默认唯一入口 = 凭据池 credentials.json，见 model-select.js 注释）。
      const prevModel = getNewSessionModel()
      const prevProvider = getNewSessionProvider()
      setNewSessionModel('')
      setNewSessionProvider('')
      // 丝滑过渡（2026-08-30）：不等 wsession 返回（spawn CLI 窗口+注册常 >1s，期间空态冻结
      // 是「不丝滑」根源）——发送瞬间即进会话视觉：输入栏 FLIP 沉底 + 趴栏淡出 + 首条消息
      // 乐观上屏（气泡+正在处理折叠）。pre 标记 + hash 暂空：renderSession 创建中不洗
      // 「加载中…」、fetch 空时不重复上屏；创建失败整体回滚空态（还原输入文本与图片胶囊）。
      // 丝滑过渡（2026-08-30）：不等 wsession 返回（spawn CLI 窗口+注册常 >1s，期间空态冻结
      // 是「不丝滑」根源）——发送瞬间即进会话视觉：输入栏 FLIP 沉底 + 趴栏淡出 + 首条消息
      // 乐观上屏（气泡+正在处理折叠）。首条消息事务（firstSendHash）由 newWebSession 在
      // navigate 之前回填，创建失败回滚空态（还原输入文本与图片胶囊）。
      flipInput(false)
      addUser(text, imgs, files)
      composerSetText('')
      syncGwSend()
      const d = await newWebSession(tgt || undefined, prevModel || undefined, prevProvider || undefined)
      if (!d || !d.hash) {
        setFirstSendHash('') // 事务终止：创建失败，乐观 DOM 随下方空态回滚一并清空
        setPendingUserMsgs(pendingUserMsgs.filter((p) => p.hash)) // 丢弃无归属（hash=''）的乐观项
        messagesEl.innerHTML = ''
        renderTransient() // 暂态区对账：空主张 → 摘区/停主张计时/turnLive 复位
        flipInput(true) // 回滚空态（FLIP 滑回 stage，docked/in-session 一并移除）
        composerSetText(text)
        syncGwSend()
        state.newProject = prevNew
        setNewSessionModel(prevModel)
        setNewSessionProvider(prevProvider)
        composerFocus()
        return true
      }
      clearPendingImages()
      clearPendingFiles()
      // newWebSession 已回填 firstSendHash（navigate 之前）并 navigate 进会话（renderSession
      // 设置 currentHash + 拉历史）：首条消息事务生效——乐观开启气泡/主张折叠是权威 DOM，等真实
      // 数据落盘接管；期间队列快照不渲、空 fetch 不洗盘（守卫见 renderSession/refreshSession）。
      // 2026-09-12 相对占位：新会话 cwd 由 wsession 响应带回（与 spawn cwd 同源
      // webSessionProjectRoot）——jsonl 落盘前会话记录尚不存在，响应带回是首条消息唯一 cwd 源。
      // 乐观文本不含文件占位（absorb 为 includes 子串匹配仍命中）；落盘文本带相对占位。
      if (d.cwd) setSessionCwd(d.cwd)
      // 首页选的模型（2026-10-13 待办 12 根修）：已随 newWebSession 的 wsession body.model 下发，
      // 网关 spawn 时落 --model 启动参数——CLI 启动即固化会话覆盖（先于一切帧与消息），首轮请求
      // 即用所选模型。旧「建会话后 apiSetModel 补投」链退役：wsession 自 2026-09-06 异步化（预分配
      // sid 立即返回、spawn+注册后台进行），补投时目标 CLI 尚未注册 → routeToClient 恒 miss 400，
      // 「启动后仍用默认模型」即此竞速；--model 从出生固化，无时序问题。
      const fph = files.map((f) => `[文件:${relUploadPath(f.abs)}]`).join(' ')
      const sendText = fph ? (text ? text + ' ' + fph : fph) : text
      gws.send(JSON.stringify({ type: 'send', text: sendText, sessionId: d.hash, ...imgPayload }))
      // 主张折叠已由 addUser → renderTransient 上屏（事务期乐观 DOM 是权威），此处无需再挂
      return true
    }
    if (!inputWrap.classList.contains('docked')) {
      // 先入会话态（输入栏沉底、滚动区留底边距），再追加/钉顶消息，保证钉顶位置计算基于最终布局
      mountInput('chat') // 输入栏从空态 stage 移回 #chat-area 沉底
      inputWrap.classList.add('docked')
      chatArea.classList.add('in-session')
    }
    // 2026-09-12 文件占位：[文件:<会话 cwd 相对路径>]，与图片占位同模式——消息文本原样上行
    // （CLI/模型端按 cwd 解析读文件），web 渲染层剥占位出文件卡片（userFilesHtml）。
    if (files.length) {
      const fph = files.map((f) => `[文件:${relUploadPath(f.abs)}]`).join(' ')
      text = text ? text + ' ' + fph : fph
    }
    addUser(text, imgs, files)
    // 2026-08-17 网关独立化：带当前会话 hash，网关按 sessionId 精确路由给对应 CLI 进程
    // （未在具体会话时 currentHash 为 null → 字段省略，网关广播兜底）
    gws.send(JSON.stringify({ type: 'send', text, sessionId: state.currentHash || undefined, ...imgPayload }))
    // 2026-09-07 两区重构：乐观「正在处理」主张折叠由 renderTransient 从 pendingUserMsgs
    // 统一渲染（回合间隙发送 = 开启主张气泡+主张折叠；回合运行中 = 排队成员，不开折叠）——
    // 原 procOpen 直挂 DOM 链退役（幻影折叠根源：proc 变量跨整页重建悬挂，收养/幂等皆失灵）。
    composerSetText('')
    clearPendingImages()
    clearPendingFiles()
    syncGwSend()
    return true
  }

  function syncGwSend() {
    // 2026-09-05 定案：回合进行中输入栏有内容（文本/图/文件）→ 显示发送键（点击=排队续发不打断）；
    // 输入栏为空才显示停止键（打断）。空闲态恒发送键、按输入内容点亮。
    const hasContent = serializeInput().trim().length > 0 || pendingImages.length > 0 || pendingFiles.length > 0
    setBtnMode(turnLive && !hasContent ? 'stop' : 'send')
    const on = turnLive || (GATEWAY && gws && gws.readyState === 1 && hasContent)
    sendBtn.classList.toggle('enabled', on)
    // md 就地渲染链（mdPreviewRefresh）随 CM6 接管退役：live preview 输入即渲染，无换层刷新口
  }

  // 2026-09-12 文件占位相对化（用户定案「使用相对路径」）：[文件:<会话 cwd 相对路径>]——CLI/模型
  // Read 按会话启动根解析即得文件；落盘同轮定案改跟随会话（上传带 sid/project，网关按会话根落盘）
  // → 同会话上传+发送恒为 <配置根>/file-cache/<会话id>/<名> 的 cwd 相对形；跨会话/跨目录按 B 的 cwd
  // 相对化。Windows 大小写不敏感、\ / 通用；跨盘符无法相对 → 原样绝对路径
  // （物理上唯一正确表示）。cwd 未知（异常旧记录）同退绝对路径——不是兜底分支，是「无 cwd 就无法相对化」的诚实表示。
  function relPath(fromDir, toPath) {
    const seg = (p) => String(p).replace(/\//g, '\\').split('\\').filter((s) => s.length > 0)
    const a = seg(fromDir)
    const b = seg(toPath)
    if (a[0] && b[0] && /^[a-z]:$/i.test(a[0]) && /^[a-z]:$/i.test(b[0]) && a[0].toLowerCase() !== b[0].toLowerCase()) return toPath
    let i = 0
    while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++
    return '../'.repeat(Math.max(0, a.length - i)) + b.slice(i).join('/')
  }
  function relUploadPath(abs) {
    return sessionCwd ? relPath(sessionCwd, abs) : abs
  }

export {
  gwSend,
  syncGwSend,
}
