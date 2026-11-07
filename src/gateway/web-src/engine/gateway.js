// 网关模式（WS 连接/发送状态/连接初始化）（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { deviceHint, showGate, gatePlayTransition, hideGate } from './auth.js'
import { inputEl, setConnUp, state } from './state.js'
import { toast } from '../core/util.js'
import { cardBus } from './card-bus.js'
import { noteWsOpen, noteWsClosed } from './live.js' // SSE 连接监督者联动口（循环引用可用：ESM 函数声明提升，调用都在运行期回调内）
/* @module engine/gateway.js */
  // ---------- 网关模式（SubPj2 私有化网关）----------
  // 检测 /gateway/health 返回 mode==='gateway' 即启用：composer 可发、WS 双向、工具审批。
  // 只读查看模式（SubPj1 后端）下本块全部不生效。
  let GATEWAY = false
  let GATEWAY_REVIEW = false // 审阅模式（server.mjs REVIEW_GATEWAY）：health 带 review 标志，token 门不建真 WS 直接走视觉流程
  let HOT_RELOAD = false // 开发审阅热重载（server.mjs HOT_RELOAD）：health 带 hotReload 标志，建 SSE 监听 public 变化自动刷新
  // 本网关进程启动时刻（health.boot）：界面判「同一网关刷新」与「换了网关」的唯一凭据
  // （work 工具栏开合只在同进程内保持，见 work-mount.initWork）。
  let gwBoot = 0
  const gatewayBootAt = () => gwBoot
  let gateAwait = false // token 门态：网关 token 验证通过前锁定为全空白 + 中间输入框
  let gateVerified = false // 网关 token/cookie 已验证（WS onopen 或 REVIEW 直置；声明提前供 needToken 用）
  // 2026-08-28 token 出 URL：gToken 仅作首链/门输入的附加凭据；已授权设备刷新后 gToken 为空，
  // 靠 floria_auth cookie（网关首链时种下）通过校验。URL query token 验证成功后由 hideGate 清除。
  let gToken = new URLSearchParams(location.search).get('token') || ''
  let gws = null
  let reconnectTimer = null

  // 依赖反转（分层治理 4D，2026-10-10）：engine/gateway.js 不再静态 import inputbar/*——
  // 审批卡渲染/审批态读写、发送态同步、@ 提及输入回调一律经 app 启动序列注入的端口访问。
  // 端口内 getter（getTakeover/getApprovalPending）每次现读 feature 模块的可变绑定，调用侧严禁缓存
  // （缓存即与 owner 的实时态脱钩）；端口注入先于 initGateway、且早于 WS 首个 onopen/onmessage。
  let gwApproval = {} // inputbar/approval.js：审批卡渲染 + 审批态读写
  let gwSendPort = {} // inputbar/send.js：syncGwSend
  let gwMention = {} // inputbar/mention.js：onInputChange

  // 安全加固（2026-08-15）：数据接口 URL 统一附加网关 token（query），与 WS 升级校验一致。
  // 2026-08-28 门控条件从「有无 gToken」改为「是否已验证」：cookie 授权设备刷新后直接可拉数据，
  // 未验证（无 cookie 且无首链 token）时请求不发，待 connect 失败回门 / hideGate 解锁后补拉。
  const needToken = () => GATEWAY && !gateVerified
  function apiUrl(path) {
    const q = path.includes('?') ? '&' : '?'
    return path + q + 'token=' + encodeURIComponent(gToken)
  }
  // 模型/思考等级切换（POST /gateway/model：持久化写 settings.json + 广播实时生效）。
  // 2026-10-05 自 inputbar/model-select.js 迁入——网关客户端是 needToken/apiUrl/gToken 的唯一持有者，
  // 卡片与输入栏都经此调用（去卡片→inputbar 横向依赖）。needToken 门：未验证返回 false 由调用方提示。
  async function apiSetModel(body) {
    if (needToken()) return false
    try {
      const res = await fetch(apiUrl('/gateway/model'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return res.ok
    } catch { return false }
  }

  // 卡片公开 API（2026-10-11）：帧能力表经 /ws 上行的唯一发送口。注入进 engine/card-bus.js（总线不
  // import 本件，免 engine 内成环，同 setTabRefresh/setExtCardRenderer 手法）；注入即补报一次，此后
  // 帧表一变 / 卡 ready / 本函数所在的 onopen 各触发一次（总线内 50ms 防抖合并）。
  cardBus.setGatewaySender((m) => {
    if (gws && gws.readyState === 1) gws.send(JSON.stringify(m))
  })

  function gatewayCss() {
    const s = document.createElement('style')
    s.textContent = `
      #send-btn.enabled{opacity:1;cursor:pointer}
      /* 2026-08-21 审批卡：DSH ApprovalPanel 完全移植（warn 语义令牌就地映射）——
         amber 顶部条带[8px 圆点 + 13/18 文字] + 正文[15/24 500 headline + mono 命令] + 右对齐胶囊按钮。
         2026-08-22 composer takeover：审批卡占输入栏，.appr-card 提为全局（去掉 .msg.approval 作用域） */
      .appr-card{overflow:hidden;width:100%;border:1px solid var(--warn-line);border-radius:20px;background:var(--bg);box-shadow:0 4px 12px 0 rgba(0,0,0,.02),0 2px 8px 0 rgba(0,0,0,.04)}
      .appr-strip{display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--warn-bg);color:var(--warn-fg);font-size:13px;line-height:18px}
      .appr-strip .appr-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--warn-fg)}
      /* 2026-09-10 用户定案「审批栏拉到合适高度、不出滑条」：旧定值 200px 让十几行的命令体（Edit 的
         old/new_string 等）恒出滚动条=又丑又要二次滚。改为视口预算——正文吃满自然高度，上限=视口高
         减 260px（黄条带 38 + 按钮行 60 + 底距 22 + 聊天区至少可见 ~140），只有真超屏才滚（真边界，
         非兜底特判）。dvh 后置声明：不支持的引擎落回 vh。 */
      .appr-body{display:flex;flex-direction:column;gap:6px;box-sizing:border-box;max-height:calc(100vh - 260px);max-height:calc(100dvh - 260px);overflow-y:auto;padding:12px 16px 0}
      .appr-headline{color:var(--text);font-size:15px;font-weight:500;line-height:24px}
      /* 2026-09-10 正文由「原样 JSON.stringify」改按工具语义渲染（approval.js prettyToolInput）：
         外层只做容器；等宽/折行下沉到字段值 .ak-v、块 .appr-pre、diff 各行——避免整块继承等宽把
         中文字段标签也变等宽。Edit=红/绿两段文本 diff（.appr-diff-*），其余=标签+值列表（.appr-kv）。 */
      .appr-input{color:var(--text-2);font-size:13px;line-height:20px}
      .appr-kvs{display:flex;flex-direction:column;gap:6px}
      .appr-kv{display:flex;gap:8px;font-size:13px;line-height:20px}
      .appr-kv .ak-l{flex:none;min-width:52px;color:var(--text-3)}
      .appr-kv .ak-v{color:var(--text);font-family:var(--mono);word-break:break-all;white-space:pre-wrap;overflow-wrap:anywhere}
      .appr-file{margin-bottom:2px;color:var(--text);font-family:var(--mono);font-size:13px;line-height:20px;word-break:break-all;overflow-wrap:anywhere}
      .appr-meta{margin-bottom:2px;color:var(--text-3);font-size:12px;line-height:18px}
      .appr-pre{margin:0;padding:10px 12px;border-radius:10px;background:var(--field-2);color:var(--ink);font-family:var(--mono);font-size:12.5px;line-height:19px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
      /* ExitPlanMode 计划正文的 Markdown 作用域（approval.js prettyToolInput → mdHtml）：
         审批卡不在 .msg/.done-think 内，故 mdHtml 产出的块级标签在此重新给样式，语义对齐 styles.css 同名规则。 */
      .appr-md{color:var(--text);font-size:13px;line-height:20px;word-break:break-word}
      .appr-md p{margin:4px 0}
      .appr-md h1,.appr-md h2,.appr-md h3,.appr-md h4{margin:12px 0 4px;font-weight:700;color:var(--text);line-height:1.4}
      .appr-md h1{font-size:16px}.appr-md h2{font-size:15px}.appr-md h3{font-size:14px}.appr-md h4{font-size:13px}
      .appr-md ul,.appr-md ol{margin:4px 0;padding-left:20px}
      .appr-md li{margin:2px 0}
      .appr-md blockquote{border-left:3px solid var(--border);margin:4px 0;padding:2px 10px;color:var(--text-2)}
      .appr-md hr{border:none;border-top:1px solid var(--border);margin:8px 0}
      .appr-md a{color:var(--text);text-decoration:underline;text-underline-offset:2px}
      .appr-md code{background:var(--border-soft);padding:2px 6px;border-radius:4px;font-family:var(--mono);font-size:12px}
      /* .code-block 系列（2026-10-10）已收口到 styles.css 的「.appr-md .code-block」作用域（含头栏/换行/hljs），
         此处不再重复——注入样式晚于 <link> 会盖掉新设计（旧绝对定位 .code-lang 等）。 */
      .appr-md .md-table{margin:6px 0;overflow-x:auto}
      .appr-md .md-table table{border-collapse:collapse;font-size:12.5px;width:100%}
      .appr-md .md-table th,.appr-md .md-table td{border:1px solid var(--border);padding:5px 9px;text-align:left;white-space:normal;word-break:break-word}
      .appr-md .md-table th{background:var(--rail-bg);font-weight:600}
      .appr-diff{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:10px;overflow:hidden}
      .appr-diff-h{padding:5px 10px;background:var(--field-2);color:var(--text-3);font-size:11px;line-height:16px;font-weight:600}
      .appr-diff-b{margin:0;padding:8px 10px;font-family:var(--mono);font-size:12.5px;line-height:19px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
      .appr-diff-b.old{background:var(--danger-soft);color:var(--danger-fg)}
      .appr-diff-b.new{background:var(--ok-soft);color:var(--ok-fg)}
      .appr-btns{display:flex;justify-content:flex-end;gap:8px;padding:14px 16px}
      .appr-btns button{height:32px;padding:0 16px;border-radius:999px;font-size:13px;font-weight:500;line-height:18px;cursor:pointer;border:1px solid var(--border);background:var(--bg);color:var(--text-2)}
      .appr-btns button:disabled{opacity:.5;cursor:default}
      .appr-deny:hover:not(:disabled){background:var(--danger-soft);color:var(--danger-fg);border-color:transparent}
      .appr-allow{border:none!important;background:#4176e6!important;color:#fff!important}
      .appr-allow:hover:not(:disabled){background:#679efe!important}
      /* 2026-08-30 提问卡 DSH QuestionComposer 对齐：eyebrow+右上折叠/×；编号方块选项（label+描述
         同行）；自由输入行；底部 <N/M> 翻题导航+跳过本题+下一题/提交；整卡可折叠为一行。
         qa-card 走中性边框（不继承审批卡黄色警示边），配色守 floria 浅色主题。 */
      .appr-card.qa-card{border-color:var(--border)}
      .qa-top{display:flex;align-items:center;gap:10px;padding:12px 16px 0}
      /* 折叠钮最左 / 标题（眉标+问题）居中 / × 最右：中段 .qa-head 吃满 flex 并居中，
         两端 22px 图标等宽 ⇒ 标题真正居中。 */
      .qa-head{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;gap:8px}
      .qa-eyebrow{flex:none;color:var(--text-3);font-size:12px;line-height:16px;font-weight:500}
      .qa-title-sm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);font-size:13px;line-height:18px}
      .qa-fold{flex:none;width:22px;height:22px;display:flex;align-items:center;justify-content:center;color:var(--text-3);cursor:pointer;border-radius:6px}
      .qa-fold:hover{background:var(--hover);color:var(--text)}
      .qa-fold svg{width:14px;height:14px;transform:rotate(180deg)}
      .qa-collapsed .qa-fold svg{transform:none}
      .qa-x{flex:none;width:22px;height:22px;display:flex;align-items:center;justify-content:center;color:var(--text-3);cursor:pointer;border-radius:6px}
      .qa-x:hover{background:var(--danger-soft);color:var(--danger-fg)}
      .qa-x svg{width:11px;height:11px}
      .qa-main{display:flex;flex-direction:column;gap:10px;padding:6px 16px 14px}
      .qa-title{color:var(--text);font-size:15px;font-weight:600;line-height:22px}
      .qa-opts{display:flex;flex-direction:column;gap:6px;max-height:40vh;overflow-y:auto}
      .qa-opt{display:flex;align-items:flex-start;gap:10px;padding:9px 12px;border:1px solid var(--border);border-radius:12px;background:var(--bg);text-align:left;cursor:pointer;color:var(--text)}
      .qa-opt:hover{border-color:#4176e6;background:var(--accent-hover)}
      .qa-opt.sel{border-color:#4176e6;background:var(--accent-sel)}
      .qa-opt .qa-num{flex:none;min-width:20px;height:20px;padding:0 5px;border-radius:6px;background:var(--hover);color:var(--text-2);font-size:12px;font-weight:500;line-height:20px;text-align:center;box-sizing:border-box}
      .qa-opt.sel .qa-num{background:#4176e6;color:#fff}
      .qa-opt .qa-copy{flex:1;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:14px;line-height:20px}
      .qa-opt .qa-label{color:var(--text)}
      .qa-opt .qa-desc{color:var(--text-2);font-size:12px;line-height:18px}
      .qa-multi-hint{color:var(--text-3);font-size:11px;font-weight:400;margin-left:4px}
      .qa-inputrow{display:flex;align-items:center;gap:8px;height:38px;padding:0 12px;margin-bottom:-4px;border:1px solid var(--border);border-radius:12px;background:var(--bg)}
      /* 2026-09-26 撤聚焦强调：.qa-inputrow:focus-within 曾与 .qa-opt.sel 视觉同款 ⇒ 单选点选项后
         再点输入框就「两处高亮」。聚焦不再单独表态，点输入行即 pickText 上 .sel（选中态唯一）。 */
      .qa-inputrow.sel{border-color:#4176e6;background:var(--accent-sel)}
      .qa-input-ico{flex:none;width:14px;height:14px;color:var(--text-3);display:flex;align-items:center;justify-content:center}
      .qa-input-ico svg{width:14px;height:14px}
      .qa-inputrow .qa-input{flex:1;height:34px;border:none;outline:none;background:transparent;color:var(--text);font-size:14px;font-family:inherit}
      .qa-inputrow .qa-input::placeholder{color:var(--text-3)}
      .qa-foot{display:flex;align-items:center;justify-content:space-between;gap:10px}
      .qa-nav{display:flex;align-items:center;gap:6px}
      .qa-nav-btn{width:24px;height:24px;display:flex;align-items:center;justify-content:center;border:none;background:transparent;color:var(--text-2);cursor:pointer;border-radius:6px;padding:0}
      .qa-nav-btn:hover:not(.off){background:var(--hover);color:var(--text)}
      .qa-nav-btn.off{opacity:.35;cursor:default}
      .qa-nav-btn svg{width:14px;height:14px}
      .qa-nav-btn.prev svg{transform:rotate(180deg)}
      .qa-nav-pos{color:var(--text-2);font-size:12px;line-height:16px;min-width:32px;text-align:center}
      .qa-foot-btns{display:flex;gap:8px}
      .qa-foot-btns button{height:32px;padding:0 16px;border-radius:999px;font-size:13px;font-weight:500;line-height:18px;cursor:pointer;border:1px solid var(--border);background:var(--bg);color:var(--text-2)}
      .qa-foot-btns button:disabled{opacity:.5;cursor:default}
      .qa-skip:hover:not(:disabled){background:var(--hover);color:var(--text)}
      /* 2026-08-30 间距对齐（用户「最下一行到边界 vs 最上一行到边界差别很大」）：空状态行不吃空间
         （.appr-state padding 0 16px 12px + qa-main gap 10px 使脚行到卡底 ≈36px，眉行到卡顶仅 12px）；
         折叠单行卡 qa-top 底垫 0→12px（原底部贴边不对称）。
         2026-09-08 :empty 隐藏全局化——普通审批卡同样漏挂（用户实测「按钮距卡底太远」=空 state
         行仍吃 12px 底垫，与 .appr-btns padding-bottom 14px 叠成 26px），qa-card 特例并入。 */
      .appr-state:empty{display:none}
      .qa-collapsed .qa-top{padding:12px 16px}
      /* 2026-08-26 任务 A2：审批增强——原因说明/被拒路径/「记住此规则」建议多选 */
      .appr-desc{color:var(--text-2);font-size:13px;line-height:20px}
      .appr-path{display:flex;gap:6px;align-items:flex-start;color:var(--text-2);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:18px;word-break:break-all}
      .appr-path .ap-l{flex:none;color:#999}
      .appr-sugs{display:flex;flex-direction:column;gap:6px;padding:2px 0 0}
      .appr-sug{display:flex;align-items:flex-start;gap:9px;padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--bg);text-align:left;cursor:pointer;color:var(--text);font-size:13px;line-height:19px}
      .appr-sug:hover{border-color:#4176e6;background:var(--accent-hover)}
      .appr-sug.sel{border-color:#4176e6;background:var(--accent-sel)}
      .appr-sug .as-box{flex:none;width:15px;height:15px;margin-top:2px;border-radius:4px;border:1.5px solid var(--border);box-sizing:border-box}
      .appr-sug.sel .as-box{border-color:#4176e6;background:#4176e6}
      .appr-sug.sel .as-box::after{content:'';display:block;width:4px;height:7px;margin:1px auto 0;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
      .appr-sug .as-copy{flex:1}
      .appr-sug .as-title{color:var(--text);font-size:13px;line-height:19px}
      .appr-sug .as-sub{color:var(--text-2);font-size:11.5px;line-height:16px}
      /* 2026-08-26 P0 审批确认送达：提交中（busy）/失败重试状态行 */
      .appr-btns button.busy{opacity:.55;cursor:wait}
      .appr-state{display:flex;align-items:center;gap:8px;padding:0 16px 12px;font-size:12px;line-height:18px}
      .appr-state .as-wait{color:var(--text-3)}
      .appr-state .as-err{color:#d25f4a}
      .appr-state .appr-retry{height:26px;padding:0 12px;border-radius:999px;font-size:12px;font-weight:500;line-height:18px;cursor:pointer;border:1px solid var(--border);background:var(--bg);color:var(--text-1)}
      .appr-state .appr-retry:hover{background:var(--hover)}`
    document.head.appendChild(s)
  }


/* @module engine/gateway.js #2 */
  function setConn(on, label) {
    setConnUp(!!on) // 2026-09-07 运行态计时行「连接中断」标注的数据源
    const b = $('floria-conn')
    if (!b) return
    // 浅灰小字紧跟 Floria 品牌名后；on/off 仅控制文案（已连接/未连接/连接中…），颜色统一浅灰
    b.textContent = label || (on ? '已连接' : '未连接')
  }


/* @module engine/gateway.js #3 */
  function connect() {
    if (GATEWAY_REVIEW) {
      // 审阅模式（bun 编译 exe）：node:http 的 upgrade 握手在 bun 下 101 无法送达客户端、
      // WS onopen 永不触发，token 门会卡在「正在验证」。审阅模式 token 非空即视为通过，
      // 不建真 WS，直接走视觉流程（视频过渡 → 趴栏 → 空态）。正式网关（无 review 标志）不受影响。
      gateVerified = true
      setConn(true, '已连接')
      gatePlayTransition()
      return
    }
    if (gws) { gws.close() }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const hint = deviceHint()
    gws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(gToken)}${hint ? '&device=' + encodeURIComponent(hint) : ''}`)
    gws.onopen = () => {
      setConn(true, '已连接')
      gateVerified = true
      if (gateAwait) gatePlayTransition() // 门流程：播过渡视频（白板拉伸成输入栏/角色转正趴栏），ended 后 hideGate
      else hideGate() // URL 带 token 直连（无门）：验证通过直接解锁
      noteWsOpen() // SSE 监督者联动（2026-10-14 GPT 定案②）：WS 恢复即强制重建 SSE（半开下行唯一复活信号，重建后 hello 全量对账）
      gwSendPort.syncGwSend()
      cardBus.reportCaps() // 卡片能力表：连上/重连即补报（网关侧随连接断开已摘表，重连必须重报）
      gwApproval.sendSubscribe() // 2026-08-30 pending 重放：连上/重连即订阅当前会话（补切会话时 WS 尚未就绪的场景）
    }
    gws.onclose = () => {
      setConn(false, '未连接')
      noteWsClosed() // SSE 监督者联动：WS 断 → 关 SSE（上行已死，下行单独维持无意义），随 WS 重链统一重建
      // 2026-08-18 修复：token 未验证成功即断开（URL token 过期——网关重启/换新 token、或门内输入错误）
      // 一律回 token 门重输，避免静默卡在空态、后续数据请求带着无效 token 全 401。
      if (!gateVerified) {
        // 2026-08-28 设备配对：未授权/未验证 → 回门显示请求码（PC /server auth add 后自动进入）
        toast(gateAwait ? '设备尚未授权：请在 PC 运行 /server auth add <请求码>' : '设备未授权：请在 PC 运行 /server auth add <门上请求码>')
        showGate()
      } else {
        // 2026-08-26 修复：已通过 token 验证的会话断连后自动重连，否则 sockets=0 导致
        // 审批卡/提问卡永远送不到 floria（用户必等不到审批）。重连由 onopen 恢复即可，不再回 token 门。
        clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(connect, 4000)
      }
      gws = null
      gwSendPort.syncGwSend()
    }
    gws.onerror = () => setConn(false, '连接失败')
    gws.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      // 2026-08-23 web 独立会话：approval 带 session_id，仅当匹配当前会话才消费
      // （多个独立会话并行运行，其它会话的流不干扰当前视图）。
      // 2026-09-07：out 流分支删除——网关从不投递 out（实时流走 SSE 会话上报+jsonl，定案），
      // 原 handleLine 直连 CLI 流式渲染链（streamText/procThink/实时变更卡）随之整体退役。
      if (msg.type === 'approval') {
        if (msg.session_id && msg.session_id !== state.currentHash) return
        gwApproval.renderApproval(msg)
      } else if (msg.type === 'approval-confirmed') {
        // 2026-08-26 P0 审批确认送达：CLI 已处理回执 → 关卡 + 提示（不再 send 后立即清卡）
        if (msg.session_id && msg.session_id !== state.currentHash) return
        const ap = gwApproval.getApprovalPending()
        if (ap && ap.requestId === msg.requestId) {
          const wasAllow = ap.allowed
          gwApproval.setApprovalPending(null)
          gwApproval.clearTakeover()
          gwApproval.addSystem(wasAllow ? '已允许该工具调用' : '已拒绝该工具调用')
        }
      } else if (msg.type === 'approval-rejected') {
        // 2026-08-26 P0：目标 CLI 不在线 → 保留卡片 + 可见错误 + 重试
        if (msg.session_id && msg.session_id !== state.currentHash) return
        const ap = gwApproval.getApprovalPending()
        if (ap && ap.requestId === msg.requestId) {
          gwApproval.showApprovalError('审批未送达目标，请重试', msg.requestId, ap.allowed, ap.qa, ap.perms)
        }
      } else if (msg.type === 'approval-dismiss') {
        // 2026-08-24 审批双操作（web 与 CLI 均可）：CLI 终端/窗口已先操作 → 撤掉 floria 审批卡
        if (msg.session_id && msg.session_id !== state.currentHash) return
        if (gwApproval.getApprovalPending()) { gwApproval.setApprovalPending(null) }
        if (gwApproval.getTakeover() === 'approval') gwApproval.clearTakeover()
      } else if (msg.type === 'card-call') {
        // 卡片公开 API（2026-10-11）agent→卡：网关 POST /gateway/card-call 下行至此 → 总线查帧表、
        // 翻成卡的 `<ns>-cmd`，ack 由总线经 card-result 原路回网关。本件只做收发，不懂卡。
        cardBus.handleGatewayCall(msg)
      } else if (msg.type === 'status') gwApproval.addSystem(msg.state)
    }
  }

  // ---- token 门（2026-08-15；2026-08-17 SubPj3 复刻：白板内 token 表单 → 视频过渡 → 趴栏+胶囊+台面输入栏）----
  // 输入 token 回车 → connect()（WS 服务端验证）→ onopen 置 gateVerified → 白板内表单淡出 + 过渡视频
  // （白板拉伸成输入栏/角色转正趴栏）→ ended → 阶段3 趴栏+胶囊淡入 → 停留后 hideGate() 进空态
  // （空态同趴栏 stage，位置一致无缝）。token 错误（onclose 未验证）→ 回门重输。
  // gateVerified 声明已提前到网关模式区（2026-08-28：needToken 依赖）。

/* @module engine/gateway.js #4 */
  function initGateway() {
    gatewayCss()
    // 连接状态徽章已改为 Floria 品牌名后的浅灰小字（index.html #floria-conn），不再动态建 #conn-badge。
    // 空态图标不隐藏：进会话时的隐藏由 #chat-area.in-session 的 CSS 承担，
    // 永久 display:none 会让首页图标只在网关检测完成前瞬间可见、刷新即消失。
    // 输入区启用/占位/输入监听已随 CM6 接管归 composer-cm.js（updateListener 汇流 syncGwSend + onInputMention）
    composerPlaceholder('输入消息，Enter 发送')
    setConn(false, '连接中…')
    // 2026-08-28 token 出 URL：统一先 connect()——已授权设备（floria_auth cookie）WS 直接通过进空态；
    // 未授权（无 cookie 无首链 token）WS 被拒 → onclose 回 token 门。REVIEW 模式仍要求 URL 带 token。
    if (GATEWAY_REVIEW) { if (gToken) connect(); else showGate() }
    else connect()
    gwSendPort.syncGwSend()
  }

  async function detectGateway() {
    try {
      const res = await fetch('/gateway/health')
      if (!res.ok) return
      const d = await res.json()
      if (d.mode === 'gateway') GATEWAY = true
      if (d.review) GATEWAY_REVIEW = true
      if (d.hotReload) HOT_RELOAD = true
      if (typeof d.boot === 'number') gwBoot = d.boot
    } catch { /* 非网关环境（静态托管）忽略 */ }
  }

// —— 跨模块写入口（切割脚本生成）——
export function setGateAwait(v) { gateAwait = v }
export function setGateVerified(v) { gateVerified = v }
// SSE 监督者回唤（live.js watchdog 连续失败时调用）：主动断 WS → onclose 走既有 4s 重连链 →
// onopen → noteWsOpen 重建 SSE。gws 为空（尚未连过/REVIEW）无可断，SSE 自身重试链已覆盖。
export function forceWsReconnect() {
  clearTimeout(reconnectTimer)
  if (gws) { try { gws.close() } catch { /* 已断忽略 */ } }
}
// 分层治理 4D（2026-10-10）：feature 端口注入（app 启动序列调用一次，须早于 initGateway）。
export function setGatewayPorts(p) { gwApproval = p.approval; gwSendPort = p.send; gwMention = p.mention }

export {
  GATEWAY,
  GATEWAY_REVIEW,
  HOT_RELOAD,
  apiUrl,
  apiSetModel,
  connect,
  detectGateway,
  gToken,
  gateAwait,
  gateVerified,
  gatewayBootAt,
  gatewayCss,
  gws,
  initGateway,
  needToken,
  reconnectTimer,
  setConn,
}
