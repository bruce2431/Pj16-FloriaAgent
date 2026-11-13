// 基础工具（HTML 转义 / toast / 设备判定 / 新会话落项目）（2026-10-07 自 engine/state.js 拆出；唯一手改处，web/app.js 为生成物）

import { state } from './ui-state.js'
/* @module core/util.js */
  // ---------- 工具 ----------
  // 一元素一所有者：本模块自持 #toast 句柄（原取 engine/state.js ⇒ core→engine 逆向边）。
  const toastEl = $('toast')
  let timer = null

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))


/* @module core/util.js #2 */
  function toast(msg) {
    toastEl.textContent = msg
    toastEl.hidden = false
    clearTimeout(timer)
    timer = setTimeout(() => (toastEl.hidden = true), 2600)
  }

  // 临时项目 = 根级时间戳任务区（`<YYYYMMDDHHMMSS>-名称`，后端 findProjects 一并产出为 scope='project'）。
  // 它不承载自有会话与预览：work 模式下聊天列表展示**全局根散装会话**、右缘抽屉把手不渲染、新建会话也落
  // 全局根（2026-10-30 用户定案）。判据只认 label 形态这一条，不新增 scope 值。
  const TEMP_PROJ_RE = /^\d{8,14}-/
  const isTempProjLabel = (label) => TEMP_PROJ_RE.test(label || '')

  // 会话的项目归属（chat 侧栏唯一判据，2026-11-06 用户定案）：临时项目 label 下的会话按**全局根**对待（''）。
  // 根级时间戳任务区只是 work 的文件树入口，不是可归属的会话项目——chat 侧栏不识别它、也不显示项目标签；
  // work 侧栏与底栏项目选择器不走本函数（那里临时项目仍需可选，见 feature/project-picker/）。
  const sessionProjLabel = (s) =>
    s && s.projectScope === 'project' && s.projectLabel && !isTempProjLabel(s.projectLabel) ? s.projectLabel : ''

  // 会话是否属于某工作项目的辖内（work 侧唯一判据）：临时项目（根级时间戳任务区）的在辖会话 =
  // 全局根散装会话（它不承载自有会话）；普通项目 = projectLabel 命中。
  const sessionInWork = (s, workProj) =>
    isTempProjLabel(workProj) ? !!s && s.projectScope === 'global' : !!s && s.projectLabel === workProj

  // 新会话的落项目（唯一真源）：work 模式 = 「在项目中工作」，目标项目恒 = 工作项目（state.workProj）；
  // 其余情况 = chat 侧栏/初始界面选的 state.newProject（null = 全局）。所有建会话/上传的落项目判定
  // 都读本函数——写死 state.newProject 的消费点会在 work 模式下漏掉工作项目（会话落到全局）。
  // 临时项目例外：返回空串（= 全局根），否则新会话带临时项目 label，会从「展示全局会话」的列表里消失。
  function newSessionProject() {
    if (state.sbMode !== 'work' || !state.workProj) return state.newProject
    return isTempProjLabel(state.workProj) ? '' : state.workProj
  }

  // 手机端（≤720px）：侧栏为全屏抽屉，选择会话后自动收起
  const isMobile = () => window.matchMedia('(max-width: 720px)').matches
  // 纯触屏设备（iPad/iPhone Safari）：打开弹层时不得程序化聚焦输入框——iOS 会因此弹出系统键盘
  // （2026-08-28：+ 命令菜单搜索框 / 模型菜单回填输入栏焦点均被识别为文本输入；桌面不受影响，方向键导航保留）
  const isTouch = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches

export {
  esc,
  isMobile,
  isTempProjLabel,
  isTouch,
  newSessionProject,
  sessionInWork,
  sessionProjLabel,
  toast,
}
