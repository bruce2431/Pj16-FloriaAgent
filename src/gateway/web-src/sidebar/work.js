// work 模式侧栏 + 主区编辑区（2026-09-25，参考 Prism）（唯一手改处，web/app.js 为生成物）

import { navigate } from '../chat/route.js'
import { needToken, apiUrl } from '../engine/gateway.js'
import { I } from '../core/icons.js'
import { ALL, chatArea, sessionCard, state } from '../engine/state.js'
import { esc, isMobile, sessionInWork, toast } from '../core/util.js'
import { saveWork } from '../core/storage.js'
import { loadSessions, sessCmp, findSession } from '../engine/sessions.js'
import { currentCardId } from '../engine/registry.js'
import { hydrateExtCards } from '../engine/ext-runtime.js'
import { itemHtml, openRenameDialog, registerRowMenu, reliftRowMenu, sessionRowMenuSpec, setPanel } from './recent.js'
import { cmtInvalidate, cmtLoad, cmtRangesFor, cmtSetHooks } from '../feature/comment/comment-data.js'
import { cmtRender } from '../feature/comment/comment-panel.js'
import { renderProjSeat } from '../inputbar/commands.js'
import { mountPreview, syncExtCards } from '../feature/preview-frame.js'
import { cardBus } from '../engine/card-bus.js'
import { clearWkFrameTools, registerWkFrameTools, registerWkTool, wkToolDef, wkToolDefs, wkToolNormId } from './work-tools.js'
/* @module sidebar/work.js */
  // ---------- work 模式侧栏（Prism 式） ----------
  // 状态源 = engine/state.js 的 sbMode / projects / workspace / workProj / workFile / wkMainTab / wkAssist /
  // wkPreview / wkPvTab / wkPrevW（localStorage floria-ui-v1 持久化，见 saveWork/loadWork）。视图浮层开关
  // （侧边栏）按项目分槽存 state.workSlots，切项目时由 work-context.js switchWorkProject 换槽。
  // 数据源全部是现成端点，本模块零后端改动：
  //   项目列表 → /gateway/sessions 的 groups（sessions.js 顺带存进 state.projects）
  //   文件树   → GET /gateway/project?label=  的 files（walkProjectTree，无固定深度 / 每层 200 / 总预算 8000）
  //   单文件   → GET /gateway/file?label=&path=（只读原始字节，带路径穿越防护 + 4MB 上限）
  // 主区：sbMode=work → #chat-area 加 .work（CSS Grid 三列 = 下沉区 | 分界条 | 右栏卡）。下沉区顶部一条
  // .wk-topbar tab 顶栏（[+] [聊天胶囊×N] [文件 pill×N]）：聊天胶囊 = 开放集 state.wkChats 一会话
  // 一枚（命名 = 会话标题），文件 pill = 开放集 state.wkFiles 一路径一枚（命名 = 项目内相对路径，两族 ×
  // 都关掉；开放集纯运行时、切项目重置）；同一时刻只显一个内容（#session-card = 聊天 / #work-editor =
  // 文件）；右栏（#work-preview，与下沉区同属 #chat-area 三列之一）两态由 state.wkPvTab 定：'' = 预览态
  // （挂项目预览帧）/ 工具 id = 工具态（顶 tab 条 + 该工具 pane，注册表 sidebar/work-tools.js）。
  // 右栏开合 = 顶栏「工具栏」胶囊 #wk-tb-tool；也可把分界条拖窄到收敛阈值。不变量 = 聊天 / 文件 / 右栏 **至少一栏在场**，唯一
  // 判定点 applyPanes。与「管理/预览卡」互斥：route.js 进 mgr/preview 时 setSbMode('chat')。

  const IMG_EXT = /\.(png|jpe?g|webp|gif|svg|bmp|ico|avif)$/i
  const MD_EXT = /\.(md|markdown)$/i
  const WK_SAVE_MS = 1000 // 编辑区自动保存去抖（停止输入后多久落盘）
  // 空路由（currentHash ''）的**激活哨兵键**：只用于「当前激活哪一项」的判定，**绝不进入** state.wkChats
  // ——空对话不占顶栏胶囊（2026-10-17 待办 2；状态源仍只有 state.wkChats 一处）。
  const WK_NEW_TAB = 'new'
  // 侧栏体当前页 = **state.wkTab**（'files' | 'chat'）；2026-10-15 从本文件的模块局部变量提升到
  // state 并随项目入槽（core/ui-state.js / sidebar/work-context.js）——重启不再恒回「文件」。
  // 注（2026-10-15 注册域隔离）：state.wkTab 与 #mgr-tabs 的入表无关——那是 chat 侧栏的行，work 模式下
  // 整块 #chat-panel 隐掉；工作区根应用 tab 的入表判据在 registry.js（按 state.preview / state.mgr 的语境）。
  let wkTree = null        // 当前项目文件树（/gateway/project 的 files）；null = 未加载
  let wkLoading = false
  let wkErr = ''
  const wkOpen = new Set() // 已展开目录（项目内相对路径）
  let edSeq = 0            // 编辑区读取序号：快速连点文件时丢弃迟到的旧响应

  function setSbMode(mode) {
    state.sbMode = mode === 'work' ? 'work' : 'chat'
    applySbMode()
    saveWork()
  }

  // work 模式不变量（唯一判定点）：助手栏只显示工作项目的会话——当前打开的是别的项目的会话时，
  // 回该项目的「新对话」空态（新会话的目标项目由 engine/state.js newSessionProject 收口，seat 只读）。
  // 判据 = **label 唯一命中**（不再硬判 scope==='project'）：工作区根「全局根 · 散装对话」也是一个
  // 工作项目，其会话的 projectLabel 就是该 label，与项目 label 空间不重叠（待办 #7 收尾，2026-10-15）。
  // 调用点 = 进入 work 模式 / 切换工作项目 / 路由渲染会话前（chat/route.js renderSession）。
  // 会话尚未落地（findSession 查无 = 列表未拉或刷新中）时不判——「未知」不等于「别的项目」。
  // 临时项目（根级时间戳任务区）的在辖会话 = 全局根散装会话（它没有自有会话，见 work-files.js 列表口径）。
  function workScopeOk(hash) {
    if (state.sbMode !== 'work' || !state.workProj || !hash) return true
    const s = findSession(hash)
    if (!s) return true
    return sessionInWork(s, state.workProj)
  }
  function enforceWorkScope() {
    if (!workScopeOk(state.currentHash)) navigate('#/')
    renderProjSeat()
  }

  // 模式 tab「空位」定位（唯一处）：把当前 .ms-btn 的矩形以 left/right 内衬写进 .ms-thumb
  // （.mode-switch 是 position:relative，即两钮的 offsetParent，量值可直接用）。
  // 侧栏折叠态下 #panel 虽 width:0，但 .panel-inner 仍持 --panel-w 宽、按钮尺寸不变（只是被 overflow
  // 裁掉），故任何时刻量都有效，无需等侧栏展开再定位。字体异步到位会改字宽 ⇒ 由 mountWork 在
  // document.fonts.ready 后重量一次（那次不带变形动画）。
  // 切换 = 空位「变形 + 位移」（2026-10-06 用户定案）：用 left/right 两个内衬而不是 left/width——
  // 前缘（移动方向上的那条边）给短时长先到、后缘给长时长后到，中途两缘一快一慢 ⇒ 空位被拉长，
  // 到位后收回成目标钮的形状；这就是「变形位移」的读数。方向性 transition 在此按方向写内联。
  // 非切换的定位（初始化 / resize / 字体到位）一律 transition:none —— 否则首帧会播一次滑动。
  // 空位归属（2026-10-06 二轮定案）：**落在非当前模式那侧**——处于的模式在卡片上（.ms-btn.on 回
  // 卡面色），凹下去的那块给另一个模式。位置取 .ms-btn:not(.on)。
  const MS_FAST = '0.16s cubic-bezier(0.2, 0.8, 0.3, 1)'
  const MS_SLOW = '0.30s cubic-bezier(0.3, 1.04, 0.5, 1)'
  let msAtFirst = null // 上一次空位停在哪一侧（null = 尚未定位）
  function positionMsThumb() {
    const sw = $('mode-switch')
    const th = sw && sw.querySelector('.ms-thumb')
    const btns = sw && sw.querySelectorAll('.ms-btn')
    const btn = sw && sw.querySelector('.ms-btn:not(.on)')
    if (!th || !btn || !btns || btns.length < 2) return
    const first = btn === btns[0]
    const moved = msAtFirst !== null && msAtFirst !== first
    if (moved) {
      // 去左侧：前缘 = 左缘 ⇒ left 快、right 慢；去右侧：前缘 = 右缘 ⇒ right 快、left 慢
      th.style.transition = first
        ? `left ${MS_FAST}, right ${MS_SLOW}`
        : `right ${MS_FAST}, left ${MS_SLOW}`
    } else {
      th.style.transition = 'none'
    }
    th.style.left = btn.offsetLeft + 'px'
    th.style.right = sw.clientWidth - btn.offsetLeft - btn.offsetWidth + 'px'
    msAtFirst = first
  }
export {
  applySbMode,
  enforceWorkScope,
  ensureWork,
  initWork,
  setSbMode,
  syncWorkTabs,
  workScopeOk,
}
