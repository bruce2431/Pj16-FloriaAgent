# 术语表（glossary）

> 本文件属 `docs/` 文档库。
> 会话/文档/LOG 交流一律用本表规范名；实体列 = `gateway/web/index.html` + `app.js` 实际 DOM 码；「旧称」= 规范前的口语叫法（LOG 历史条目中常见）。
> 可视化树形版 + 信号族机制层（四泳道信号流图/12 步生命周期/信号台账/病谱/冲突清单/不变量清单，图例 chip 三视图交叉高亮）见项目预览页 `.claude/preview/index.html`「web 前端 DOM 术语树」+「web 前端机制层」两节。
> 链路定案正文 → [web-ui.md](web-ui.md) 与 [gateway.md](gateway.md)。

## 界面与跨端

| 规范名 | 实体 | 说明 | 旧称 |
|---|---|---|---|
| token 门 | `#gate-screen` | 未认证时的设备配对页：请求码 + PC 端 `/server auth add` 授权（阶段：趴栏图→过渡视频→配对） | 初始chat界面 |
| 新会话界面 | `#empty-hint` | 认证后空态：趴栏图 + 输入栏居中 | 初始chat界面 |
| 聊天主区 | `#chat-area`（`#chat-scroll`/`#messages`） | 会话界面主体 | chat界面 |
| 管理视图 | `.mgr-pane`（入口 `.mgr-tab`） | 管理 tabs 打开的页：第一方「插件 / 预览」+ 已启用的应用 tab（`app:<id>`，见「应用」行） | |
| 项目预览页 | `.preview-shell`（iframe） | `/preview/<label>/*` 托管页（项目侧栏胶囊 / 项目列表进入） | |
| 外部卡 | `ext:<label>:<id>`（`.ext-shell` > `.ext-frame`） | preview 申报、由宿主摆进主区/侧栏的卡片：**一卡一 iframe**（`/preview/<label>/<path>`，同源），内容跑在自己的文档里（宿主不解释、不注入） | 卡片化二期/外部卡片 |
| 应用 / 应用卡 | `app:<id>`（`.ext-shell` > `.ext-frame`） | **工作区根** `.claude/preview/preview.json` 的 `cards` 申报、经插件卡「应用」列表手动启用的常驻卡：启用后成侧栏 tab（`app:<id>`），点击 `openCard` → `mountExtCard` 渲染其 iframe 页。与外部卡同壳不同表：**恒属工作区根、不被预览生命周期清理**。链路 → [web-ui.md](web-ui.md) §42 | 常驻插件卡/全局应用 |
| 卡片申报 | `preview.json` 的 `cards` 段 / `floria-cards-register` | preview 向宿主声明「我有哪些卡、摆在哪」（静态清单 + 运行期 postMessage 同 id 覆盖）；与 `backend` 并列的第二种能力申报，渲染位置由 preview 要求（`host:"view"`）。label 含全局根（应用卡来源）。链路 → [web-ui.md](web-ui.md) §42 + [gateway.md](gateway.md) §6.5 | |
| 神经元视图 | `.neu-pane`（`.neu-card` / `.neu-graph` / `.neu-pop`） | 层级1 神经元库选择卡片 + 层级2 三级节点图（mem→cog→社群，Canvas 力导向）+ 悬停/点击浮窗；数据源 [gateway.md](gateway.md) §14。2026-10-10 起为工作区根应用卡（`app:neurons`，页面 `.claude/preview/neurons/index.html`），类名新归属该自包含页 | 「神经」tab |
| web 前端 | `gateway/web/` | 浏览器端界面（等权前端之一） | web界面 |
| 主题 | `<html data-theme>`（`html[data-theme="dark"]`） | 前端配色主题：缺省属性 = 浅色；`data-theme="dark"` = **夜晚模式**（配色参考 Prism）。真源 = `<html data-theme>`；`localStorage['floria-theme']`（`'light'`/`'dark'`，缺省跟随 `prefers-color-scheme`）只作下次首帧的预置输入。所有暗色差异只在 `html[data-theme="dark"]` 一处覆盖语义令牌，浅色路径逐像素不变。见 web-ui §56 | 夜晚模式 / 暗色主题 |
| 主题切换钮 | `#panel-theme`（`.act-btn`，`I.sun`⇄`I.moon`） | 侧栏头部动作区 `#panel-actions` 内的日/月图标钮（与搜索/折叠并列，chat/work 两模式均可见）：点击翻转 `<html data-theme>` + 写 localStorage + 换图标 + 同步 `theme-color`。见 web-ui §56 | 明暗切换钮 |
| CLI 界面 | REPL（React/Ink） | 终端界面（等权前端之一） | cli界面 |
| PC 端 | — | 本地电脑（exe/网关所在） | 本地 |
| 远程端 | — | iPad/iPhone 等远程设备 | 遥测（已退役） |
| 内置网关 | `localGateway.ts` | exe 内置网关进程 | 网关 |
| CLI 客户端注册表 | `cliClients` | 网关侧 CLI 会话进程路由表 | |
| web 独立会话 | wsession | web 端「笔/项目+」新建的独立 CLI 进程会话 | |
| 会话间通信 | `session_send` 工具 / `session-message` 帧 | 会话 A 的 agent 向会话 B 发一条消息，B 侧以与 user 消息同构的形态接收（空闲开回合/忙则排队/离线自动拉起），气泡外带来源灰字行；**无授权门**——会话目录内任何会话可发，唯一硬门是寻址（sid 精确 > 标题唯一，不猜不兜底）。链路 → [core.md](core.md) 末节 + [gateway.md](gateway.md) §13 | 跨会话消息/会话互发 |
| 来源灰字行 | `.msg .who`（气泡外）/ `.q-who`（排队区） | 「来自 会话：X」小灰字；**在气泡容器内、`.body` 之前**（气泡上方，文档流占位，不影响几何）；**随其气泡一侧对齐**——用户气泡右对齐故来源行右对齐（`.msg.user .who { align-self: flex-end }`；CLI 侧同义的行盒 flex-end） | |
| UI 基础包 | `@floria/web` / `window.FloriaWeb` | 网页 UI 的无业务底座：主题令牌（明/暗）、reset、统一滚动条、图标表 `I`/`fileIcon`、`esc`/`fromHtml`、管理页通用 UI `mgr`（页面壳/搜索/分类/卡片/动作位/详情头）。唯一真源 `SubPj1-FloriaWebUI安装包开发/packages/web/`（独立仓库 `bruce2431/subpj1-floria-web`，`dist/` 不进仓库），Floria 部署 `web/webui/floria-web.{iife.js,css}`，[web-ui.md §72](web-ui.md) | 网页 UI 包 |

## 侧栏与会话管理

| 规范名 | 实体 | 说明 | 旧称 |
|---|---|---|---|
| 底板 | `--plane`（浅 `#ececf1` / 暗 `#000000`） | 容器底色，`body` 与 `#app` 同色 ⇒ 整窗读作一块底板（`#app` 的 22px 外框圆弧融进底板不再显形）；**侧栏与视图卡之间的缝隙露出它当分隔**。卡化读法见 web-ui §41 | 底子/画布 |
| 无形槽 | `#chat-area` | 承载视图卡的无形状容器：通高、无圆角/无背景/无边距，只作定位与卡的 flex 容器；`#gate-screen`（token 门浮层）与 `#menu-btn`（侧栏唤出汉堡，全视口共用）留槽级，与「当前哪张卡」无关。**同一时刻槽里恰好一张卡**；**会话级浮层禁直挂此槽**（须挂 `#session-card` 内），否则跨卡残留（见 web-ui §41） | 主区/内容区 |
| 视图卡 | `.view-card` | 浮在底板上的圆角卡（`border-radius: var(--radius)` + 边距 2px + `background: var(--chat-bg)` + `position: relative`）：会话流/管理视图/项目预览各一张；**不画线、不加阴影**，分隔只靠与底板的底色差。`margin: 2px` 从槽移到卡上 ⇒ 卡矩形 ≡ 卡化前 `#chat-area` 的矩形 | 内容卡 |
| 会话卡 | `#session-card`（`.view-card.session`） | 会话视图那张卡，常驻 `index.html`——承载 `messagesEl`/`inputWrap`/`charEl` 等模块级 const 引用的单例 DOM，**离开只切 `hidden` 不销毁**；描述符 `views/cards/session/session-card.js`（`deactivate` = `teardownSessionView`），见 web-ui §53 | |
| 管理卡 | `.view-card.mgr` | 插件/项目/模型/神经四个管理视图的卡，按需创建、离开即 `.remove()`（神经元图 rAF 以 `canvas.isConnected` 自毁） | |
| 预览卡 | `.view-card[data-view=preview]` | 项目预览那张卡（`views/cards/preview/preview-card.js` 描述符，`CARDS` 条目，经 `openCard('preview', {label,hasPreview})` 挂载）；同样按需创建、离开即 `.remove()` | |
| 卡内滚动层 | `.view-scroll` / `.view-body` | 管理卡的滚动层与内容列（`24px 20px 8px` 内边距 + 920px 内容宽），镜像会话卡 `#chat-scroll` 的几何；全高视图（预览/神经元图）由 `.view-card:has(...)` 改 padding/overflow | |
| 视图注册表 | `engine/registry.js` `CARDS` | 卡定义单一真源（`{id,title,tip,icon,tab,mount\|card,deactivate?}`，一卡一目录 `views/cards/<name>/<name>-card.js`）：侧栏 tab 生成 / `#mgr/<id>` 路由 / 卡体挂载三处查同一张表；**整卡切换唯一入口 `openCard(id, payload)`**（切换先调离场卡 `deactivate?.()`）+ 契约出口 `deactivateCard(id)`，会话卡以 `tab:false` 入表走同一路径（web-ui §41/§53） | tab 定义 |
| 卡生命周期契约 | `openCard` 离场钩子 / `deactivateCard` | 切卡时通道自动调用离场卡描述符的 `deactivate()`（`prev && prev !== id` 才触发），承载会话语义卸载等收尾；`deactivateCard(id)` 是供卡主动卸另一卡的契约出口。**依赖方向不变量**：卡 → 小底座（core + mgr-data + registry + ext-runtime + ext-decl + preview-frame + work-tools + 卡自身目录 + 卡自身特性域 feature/<卡名>），禁卡依赖兄弟子系统（web-ui §53，`probes/probe-web-card-boundary.ts` 锁） | 卡片契约 |
| 侧栏开合核 | `engine/panel.js` `applyPanelOpen`/`closePanel` | 侧栏开合落地唯一实现（钉住态 `state.panelPinned` + 可见态 `state.panelOpen` + `#sidebar.open` + 折叠清 `--panel-w`）；`sidebar/recent.js` 的 `setPanel` 委托其核（popup/行浮窗清理留包装层），卡只经 `closePanel()` 收抽屉（web-ui §53） | 侧栏 |
| 侧栏 | `#sidebar` | = 折叠态（宽度 0，无自带外观）+ 展开面板。**是 `#app` 的真实 flex 子元素**（桌面 ≥721px 亦然）：折叠 0 ↔ 展开 280 **只由自身宽度驱动**，主区 `#chat-area` 靠 flex 跟随收放（无 `padding-left` 避让，门期收宽至 0）。展开态是**通高平面列、无自身形状**（`#sidebar.open`：只有 `width: calc(var(--panel-w) + 4px)` + `padding: 2px` + 透明填充，**无圆角、无外边距**——「圆弧属于内容卡，侧栏没有自身形状」）；**两种模式下都不着色、几何同一份单一真源**，侧栏本就**是底板的那一列**——chat 底下底板色 `--plane` 灰、work 底下底板色 `--chat-bg` 白（见「模式色钩子」条），故**不存在任何 `#app.work #sidebar.open` 覆盖**（存在即读成一张独立卡：chat 被透明掩住、work 被白填出来）；手机 ≤720px 为覆盖式抽屉（脱离 flex 流，宽 `min(300px, 84vw)`，显式给白底，否则透出 `#scrim` 发黑）。展开态右缘可拖拽调宽（`#panel-resizer` 把手，仅展开态 ≥721px 显示，范围 [232, min(560, 视口−120)] 写 `:root --panel-w`，**不记忆**——折叠即清内联值回默认 280px）。唤出入口 = `#menu-btn`（钉住）/ 窗口左缘唤出（`document` 级监听，无对应元素，悬停预览、离开即收），见 web-ui §38 | 侧栏 |
| 注册快捷按钮 | `.rail-ico` | **预览页**经 `postMessage` 注册的快捷按钮（点击回跳预览页）；注册集属于当前那份预览文档，换文档即清（web-ui §39）。**挂载点暂缺（2026-09-25）**——原容器 `#rail-ext` 随 64px 折叠带撤除，样式与注册链保留、落地位置待定 | 预览注册按钮 / 注册轨按钮 |
| 展开面板 | `#panel` | 展开态 280px：模式行 + 两个面板（chat / work，同一时刻恰一个非 hidden）；底色同底板、**不画右缘分隔线**（侧栏是通高平面，分隔由底板色从卡缝露出承担，web-ui §41） | |
| 模式切换 tab | `.mode-switch` > `.ms-thumb` + `.ms-btn` | 侧栏模式分段控件（`floria·chat` / `floria·work`），占原位品牌行；**无任何胶囊元素**——无轨道底色、无浮起白块。卡面上唯一一块形状 = `.ms-thumb`「**空位**」（从卡面缺掉的一块：半透明暗底 `rgba(0,0,0,.06)` + 内阴影），**落在非当前模式那侧**（处于的模式在卡片上），当前那侧什么都不画。两钮恒 `font-weight:600`（防 CJK 字宽跳动）；当前钮 `.ms-btn.on` **不画底色**（与所在表面同色，只翻字色，禁自绘白片）。切换 = 空位**变形 + 位移**：`left`/`right` 双内衬（= 非当前钮矩形，由 `positionMsThumb()` 实测写入），前缘快、后缘慢 ⇒ 中途拉长再收回；方向性 transition 由 JS 按方向写内联，非切换定位写 `none`。原 `.floria-logo` 品牌按钮退役，折叠入口仍是右侧 `#panel-collapse`。见 web-ui §43 | 品牌行/logo 行 |
| 模式色钩子 | `#app.work` → `--sunken-bg` / 底板色 | **workstate**：随模式切换的颜色统一挂 `#app.work` 一个类（唯一写口 `applySbMode()`）。**底板色对调**：`#app { background: var(--plane) }`（chat 灰）/ `#app.work { background: var(--chat-bg) }`（work 白）——侧栏那列的白由此而来（侧栏自己不着色）；`--sunken-bg` 同理（`#app` 白 / `#app.work` `--plane`），消费方 = `#composer-mask`。形态两模式同构（通高底板 + 内缩 2px 的圆角内容卡），只有这对颜色个性化。新增随模式的颜色只在此加一行，旧 `:has(#panel.work)` 旁路已清。见 web-ui §43/§51 | workstate / 模式色 |
| chat 面板 | `#chat-panel` | 现行侧栏（管理 tabs + 最近列表）；`sbMode=chat` 时在场 | |
| work 面板 | `#work-panel` | Prism 式工作区侧栏（与 chat 面板共用同一条侧栏基线；work 下那列显白是底板色 `--chat-bg` 给的）：项目切换（`#wk-proj-seat` + `#wk-proj-pop`）/ 文件·聊天 tab / 新建入口（`#wk-new` + `#wk-new-pop`）/ 文件树（`#wk-body`）/ 视图开关浮层（`#wk-view-pop`，侧栏右上角 `#wk-view` 展开）/ 工作区卡（`#wk-foot`）；`sbMode=work` 时在场。见 web-ui §43 | 项目态侧栏 |
| 工作区编辑区 | `#work-editor` | work 模式**下沉区**（`#chat-area.work` grid `col1/row2`）里的**文件 tab** 内容，与 `#session-card`（聊天 tab）**二选一**显示（`.wk-show-file` / `.wk-show-chat` 类，判据 = `wkShownTab()`）；**所有可编辑文本统一挂一个 CodeMirror 6 编辑器**（markdown = Live Preview、其余 = 源码面 + 语法高亮，无阅读/编辑两态），图片/二进制只读。**刻意不用 `.view-card` 类**（常驻栏，不参与「槽里恰好一张卡」语义）。手机 ≤720px 单列铺满（原 `.wk-file-open` 覆盖层 + `#wk-ed-back` 已删）。见 web-ui §43/§54 | 编辑器/文件 tab |
| 保存态 | `#wk-ed-save` | 编辑区头部路径右侧文本，单点写（`wkEdState`）：空=干净、`已保存`、`.dirty`=未保存（停输 ~1s 自动存，Ctrl+S 立即存）、`.conflict`=外部已改（409，`window.confirm` 选覆盖/重载，绝不静默覆盖） | 保存指示 |
| 编辑器宿主 | `.wk-ed-cm`（`wkEdHost`） | `#wk-ed-body` 内挂 CodeMirror `EditorView` 的单元（`renderEdBody()` 对任何可编辑文本 `body.replaceChildren(wkEdHost)`）。`wkEdView` 全生命周期只建一次，切文件只换文档/语言。基础扩展含 **`EditorView.lineWrapping`**（长行按窗口软换行）、语言 compartment `wkEdLangComp`、主题 `wkEdThemeSpec`（取 `--text/--bg/--mono/--accent/--border` 变量）。见 web-ui §54 | 编辑器宿主 |
| 语言分流 / 代码高亮 | `wkEdLangExt`/`wkEdLangFor`/`wkEdBuildHlStyle` | 按扩展名热换语言扩展（json/js·ts/css/html/py/sh/yaml/tex…，`wkEdSetLang(path)` 经 `wkEdLangComp.reconfigure` 不重建 view）；非 md 用 `syntaxHighlighting(wkEdHlStyle)`——`HighlightStyle.define` 把 lezer `tags` 映到 **`--hl-*` CSS 变量**（`:root` + 暗色覆盖）⇒ 一套 style 随日/夜自动变色。无语言包 = 纯文本。见 web-ui §54 | 语法高亮 |
| 侧栏开合两钮 | `#wk-view` / `#menu-btn` | work 模式侧栏开/收的**两个触发器、互斥在场**（2026-10-14 待办 5，取代旧 `#wk-view-pop` 两开关浮层）：`#wk-view`（顶栏 `.panel-actions`，图标 `I.collapse`）＝ 收起（`setPane('sidebar', false)`）；折叠态汉堡 `#menu-btn` ＝ 常开（`setPanel(true,{pin:true})`）。`#sidebar.open` 兄弟选择器把汉堡藏起，任一时刻恰一个可见。真源＝`state.panelPinned`（当前项目槽 `workSlots[<label>].panelPinned`，落地口 `applySidebarPin()`，移动端不恢复）。不变量 = 聊天 tab / 文件 tab / 预览至少一个在场（`applyPanes()` 全关时强制回聊天 tab 并 toast） | 侧栏开合 |
| work 右栏 | `#work-preview` | work 模式**下沉区右侧的一张白卡**（`col3`，浮在底 `--plane` 上：`background: var(--chat-bg)` + `margin: 2px` + 圆角，四周 2px 缝露底板；在场由 `state.wkPreview` 门控，`#chat-area.work.wk-preview`；列宽 = `state.wkPrevW` → CSS 变量 `--wk-pw`）。**两态、单一状态源 `state.wkPvTab`**：`''` = **预览态**（挂项目预览帧 `#wk-pv-body`，内容走 `feature/preview-frame.js` 的 `mountPreview`，与「项目」视图卡同一份两级链）/ 已注册工具 id = **工具态**（顶 tab 条 `#wk-pv-tabs` + 该工具 pane）。**持久列、非 `.view-card`**，不清会话槽、不切模式；关掉不销毁、重开零重载；关栏即回预览态。见 web-ui §43/§58 | 工具栏 |
| 右栏工具注册表 | `sidebar/work-tools.js`（`WK_TOOL_DEFS` + `WK_FRAME_TOOLS`） | 右栏**工具态**顶 tab 条的登记处：`registerWkTool({ id, title, pane, mount })` 追加一枚工具 tab（**注册序 = tab 序**，任一模块可注册，右栏不感知内容；同 id 覆写原位）；查询 `wkToolDef(id)` / `wkToolDefs()`（宿主注册序 + 帧申报序拼接）/ `wkToolNormId(id)`（未注册回落首枚）；渲染 `renderWkToolTabs()` 写 `#wk-pv-tabs`（点击委托挂 `work.js mountWork`，重渲不清事件；预览段只在项目有卡或 `hasPreview` 时出现）。内置一枚：评论（`pane: 'wk-cmt'`）。见 web-ui §58 | 工具栏 |
| 帧工具 | `WK_FRAME_TOOLS`（`registerWkFrameTools` / `clearWkFrameTools`） | 预览页（iframe）经 `postMessage floria-wk-tool-register { tools:[{id,title}] }` 申报进右栏 tab 条的工具（**整份替换**，凭 `e.source` = 右栏当前 `.preview-frame` 才采纳）——**无 pane、无 mount**，内容归预览页自管：工具态时宿主保留 `#wk-pv-body` 在场并把选中 id 经 `floria-wk-tool-select { id }` 回传（`notifyFrame`，`''` = 回默认态）。申报集随当前预览文档失效（换项目/换 src → `clearWkFrameTools`）。外部实例：Pj18 预览页「编译日志」。见 web-ui §58 | 工具栏/iframe 桥 |
| 工具页 tab | `.wk-pv-tab`（`#wk-pv-tabs`） | 右栏工具态顶条的一枚工具页签（`data-wkpv` = 工具 id）：Prism 式**纯文字 tab**，active `.on` = 主色文字 + 2px 下划线（无卡片底/边框块）。点击 → `setPvTab(id)`（`work.js` 切页态唯一入口）。显隐由 `applyPvTab()` 落。见 web-ui §58 | 工具栏 |
| 评论面板 | `#wk-cmt`（`.cmt-*`；卡 `views/cards/comment/comment-card.js`，面板 `views/cards/comment/comment-panel.js`） | 右栏「评论」工具页（`state.wkPvTab='comments'`；显隐归 `work.js applyPvTab`，本模块不碰 hidden）内容：筛选按钮（`data-cmtf` 全部/未解决）+ 按 path→行号排序的列表；条目 `.cmt-item`（`.resolved` 灰化）含定位钮 `data-cmtloc` / 时间 / `.cmt-ex` 摘录 / `.cmt-text` 正文 / 解决·重开·删除（`data-cmtact`）。事件一次委托（`cmtMount`）。数据 = `GET/POST /gateway/comments`，存 `<项目根>/.claude/comments.json`，整份替换 + 失败回滚。见 web-ui §55 / [gateway.md](gateway.md) §17 | 评论列表 |
| 原文评论标记 | `.cmt-mark` / `.cmt-mark-res`（CM6 `.cm-line` 行装饰器） | 被批注的行/块在**原文**上的可见标记（暖色底 + 左竖条；已解决=中性灰淡显）——`work.js` `cmtApplyMarks()` 据 `feature/comment/comment-data.js` `cmtRangesFor(path)` 的行范围 l0..l1，经 `wkEdCmtEffect`→`wkEdCmtField` → `wkEdBuildCmtDeco` 落 `Decoration.line`。面板定位 → `wkCmtScrollId` → `wkEdScrollToLine` 滚到该行 + `.cmt-flash` 闪烁。见 web-ui §55 | 批注高亮 |
| 工具栏胶囊 | `#wk-tb-tool`（`.wk-tb-pill`） | 顶栏 `.wk-topbar` 最右钮（`.wk-tb-tabs` 用 `flex:1 1 auto` 顶到最右），**切右栏两态**：预览态显 `I.plug` + 「工具栏」（点击 `toggleToolbar()` → `setPvTab('comments')` 入工具态）；工具态显 `I.dshClose` + 「关闭」（点击 → 清 `wkPvTab` 回预览态）。active 态 `.wk-tb-pill.on` 随工具态；图标/文字/active 全在 `work.js applyPvTab()` 一处写（HTML 不预置）。见 web-ui §58 | 工具栏按钮 |
| 添加评论浮层 | `.cmt-pop`（`.cmp-*`；`openCommentComposer`） | 文件选区「添加评论」行唤出的浅色浮窗（顶部 `+` 浮窗同族定位：锚 `snap.rect` 夹取视口内）：`.cmp-loc` 位置（文件 · 行范围）+ `.cmp-ex` 摘录 + `.cmp-in` textarea + 取消/评论；Ctrl+Enter 提交、Escape/点外/滚动关闭。提交构 `ProjectComment` 落当前项目。见 web-ui §55 | 评论输入浮层 |
| 下沉区 | `#chat-area.work`（整块） | work 模式主区本体：底色 = `--plane`（`#chat-area.work` 自身 `background: var(--plane)`，2026-10-07 定案——不再是从白卡里「挖洞」，而是整块工作区就是底板）。其内三列：`col1` = 编辑/聊天容器（`#work-editor` / `#session-card` 二选一）+ 顶栏 tab 条，**裸落底板**（只留 2px 内边距，不涂底不造卡形）；`col2` = `.work-gutter` 分界条；`col3` = `#work-preview`（**下沉区右侧的白卡**，浮在底板上故显形，见 work 右栏）。助手浮卡/收敛条脱流（`:not()` 排除）。见 web-ui §43/§58 | 主区本体 |
| 顶栏 tab 条 | `.wk-topbar`（`#wk-tb-new` / `#wk-tb-tabs` / `#wk-tb-tool`） | 下沉区顶部一行 `[+] [聊天胶囊 × N] [文件名] …… [工具栏]`：`#wk-tb-new` = 新建聊天（`newWorkChat()`）；聊天胶囊 = 开放集 `state.wkChats` 一条一枚（`data-wkchat` = 会话 hash 或哨兵 `new`），命名用会话标题、右端 `×`（`.wk-tb-x`）= `wkCloseTab()` 只移除不删会话；文件 pill（`data-wkftab` = 项目内相对路径，开放集 `state.wkFiles` 一条一枚），右端 `×` = `closeWkFile()`（先 flush pending 编辑再清 `workFile` + 回聊天 tab）。全部 pill 由 `renderTopbar()` 单口渲染，**同一时刻 active 恰一个**（与下沉区实际显示同源 = `wkShownTab()`）。点胶囊 = 切路由 + 靠回栏；点文件 pill = `openWorkFile(p)`（打开 = 编辑区 + 广播）；**右键 / 长按胶囊与文件 pill = 行菜单**（重命名 / 关闭标签）；**点侧栏会话行（`.sess-item`）与点胶囊同语义**（强制聊天 tab + 助手靠回栏）；最右 `#wk-tb-tool` = 工具栏胶囊 | tab 条/切换条 |
| 聊天 tab / 文件 tab | `state.wkMainTab`（`'chat'`/`'file'`） | 下沉区**二选一**显示：`'chat'` = 助手卡（靠栏，`#session-card`）/ `'file'` = 编辑区（`state.workFile` 非空）。助手脱流（float/slim）时下沉格按「有文件给 file、否则空」显示。全局持久化。见 web-ui §43 | 下沉区内容 |
| 新建入口「+」 | `#wk-new` / `#wk-new-pop` | work 侧栏 tab 行右侧加号：聊天 tab = 新建聊天（`navigate('#/')`）；文件 tab = 弹 `#wk-new-pop`（新建文件/新建文件夹/上传文件/上传文件夹，接入见 web-ui §45）。按钮 title 随 tab 切换 | 加号/新建 |
| 最近列表 | `#recent`/`#recent-body` | 会话容器（「最近」头 + 整理会话 + 模式 tabs）；连接状态点 `#floria-conn` 随模式行改址落在此头左侧 | |
| 整理会话弹层 | `#organize-pop` | 「一个列表 / 按项目展开」切换浮层 | |
| 模式 tabs | `#mode-tabs` | 项目/聊天两种列表排列 | |
| 项目文件夹分组 | `.folder` | 按项目分组的折叠头（含行内「+」新建） | |
| 会话 tab | `button.sess-item` | 最近列表里的单个会话条目；**排序 = 有状态（运行态点在场）置顶 + 组内 createdAt 降序**（`engine/sessions.js` `sessCmp` 单一排序器，createdAt 由网关 `/gateway/sessions` 透传 jsonl birthtime；气泡弹层/搜索覆盖层同序；项目胶囊与文件夹维持最近活跃不动）；**work 侧栏另有置顶层**——`state.wkPins` 命中的会话先于 `sessCmp`（`wkBodyHtml` 排序，仅 work 列表消费；chat 侧栏不受影响；持久化走 `savePins()` 独立写口，`saveWork()` 不携带 `wkPins`） | 会话tab/会话行/置顶 |
| 状态点 | `.dot` | tab 左侧运行态小点（web/CLI 同一判定链） | |
| 行操作浮窗 | `.row-menu-pop` | 行右键（桌面）/ 长按（触屏）唤出的浮窗，挂 `document.body` 的 fixed 卡片，落点 = 行左下（长按）/ 指针处（右键）；与标题展开同生同灭。**注册式（`registerRowMenu`）一源多用**：会话行（`recent.js`，重命名 / 关闭会话；**置顶 / 取消置顶仅 work 侧栏行**）、work 文件树行（`work-rows.js`，打开/重命名/下载/删除=移入 `.trash/`）与顶栏胶囊（`work-mount.js`，会话胶囊 = 重命名 / 关闭标签，文件 pill = 重命名 / 关闭标签）——菜单项由各列表声明（web-ui §7 / §45 / §68） | 三点菜单/会话行菜单/文件行菜单/浮窗 |
| 侧栏标题延展 | `.row-peek` / `.sess-item.expanded` | **电脑鼠标悬停、iPad 手指点击/长按**都只做横向延展：克隆行 `.row-peek` 向右单行展开（fixed 覆盖层、`pointer-events:none`，真行留在流中）；触屏点击记 `peekPin` 供列表重建后恢复；`.expanded` 仅底色高亮。**行高恒不变**（禁止标题换行）。会话行与文件树 `.wk-row` 共用 | 展开 tab / 长按展开 |
| 搜索覆盖层 | `#search-overlay` | 全屏搜索全部对话 | |
| 重命名弹窗 | `#rename-modal` | 重命名对话框，**一件两用**（`openRenameDialog({heading,placeholder,okText,value,onSubmit})`）：会话行 → 会话标题、work 文件行 → 文件/目录名（web-ui §7） | |

## 消息流（`#messages` 内）

| 规范名 | 实体 | 说明 | 旧称 |
|---|---|---|---|
| 消息气泡 | `.msg` | 用户（u）/回复（assistant）/系统提示（`.msg-system`） | |
| 引导气泡 | `[data-t="g"]` | guide agent 产物，按碎片交错穿插 | 引导消息 |
| 处理折叠体 | `details.done-fold` | 回合处理块总称：处理状态 + 旁白 + 工具调用行 | 折叠体 |
| ├ 处理状态 | summary（`.df-dot`/`.d-count`/`.d-dur`） | 终态词三态「正在处理 / 已处理 / 已停止」+ 计数段 + 计时：处理中「正在处理」、正常收尾「已处理」、无正文非正常收尾「已停止」（不显时长与计数）；**计数段** = `.d-count`（`N 次工具调用`/`N 次提问`，0 值省略，成果态显）；**脉冲点** = `.df-dot` 呼吸小圆点（无响应/连接中断红标与状态行均不在 summary 轮转） | |
| ├ 状态显示行 | `.fold-state` 宿主行 | **容器统称（状态显示行 = 状态行 + 记录行两类子元素）**：回合处理中的实时活动行——有工具组并入 `tool-fold` summary 同行、无工具组=段尾独立行；**并发复合态**：工具在飞且引擎仍在产出（turn-beat 新鲜）时，状态**作原子尾缀并进运行行所在的唯一行容器**成「正在运行:<工具> <detail> 并思考」一行一句，二者正交不再二选一；**唯一性不变量：本行一次只有一个状态占用者**——红标在场即挂 `.is-flagged` 独占（见「红标独占」） | 状态层/状态行（旧混称） |
| ├ ├ 状态行 | `.fold-state`（`.think-state` 扫光）/ 运行中 `.tool-running` | **一次性实时动画子元素**，回合收口即消失、不留存不折叠：正在思考/正在生成/正在压缩（扫光文字 + 距最后落盘计时 + 流式预览 `.think-stream` + 无响应/连接中断红标 `.d-stale`）与「正在运行:<工具>」（运行中工具行即活动指示）；并入 `tool-fold` 时折叠顶只留状态行、tf-label 记录概括不同显；**「引擎仍在产出」的判定＝`vacuumOf`**：无工具在飞按「回合未收口」推断、有工具在飞按 turn-beat 新鲜度取证（6s），压缩态为显式实证先于取证；**行首槽对齐**：状态行与工具行共用 `.t-ico` 16px 槽 + 5px gap，文字左缘恒 21px——同一宿主行两类状态轮转/并存时零横移；文本另置 `.ts-text` 子节点，tick 只写该节点 | 思考状态行/状态层 |
| ├ ├ 状态尾缀 | `.think-state.ts-join` | **并发复合态的原子尾缀**：无独立图标槽（同行已有工具图标），文案「并思考/并生成/并压缩中」由 `messages.js vacuumLabel(mode, join)` 单一映射后写入 `data-label`，`live.js` tick 只读该字段补「 Ns」（状态行/记录行一律空格分隔、无分隔点；不复刻 mode→label 三元链）；`flex:none` + `.think-state` 恒 `white-space:nowrap` ⇒ 几何上不可被挤（`.tl-text` 是让位方）；不重复扫光（宿主组用 `:not(.ts-join)`，扫光随「正在运行」行）；**红标在场时随状态文字一并隐去（见「红标独占」）** | |
| ├ ├ 红标独占 | `.fold-state.is-flagged` + `.d-stale` | **单状态槽不变量**：僵死红标「无响应 Nm Ns」/ 断连红标「连接中断」是状态槽的**唯一占用者**（非状态文字旁的注解）——`live.js` tick 以唯一判据（红标 HTML 非空）给宿主行挂 `.is-flagged`，`styles.css` 隐去同行 `.think-state`（含并发尾缀）与 `.think-stream`（引擎产出的暂态，无产出即过期），`.d-stale` margin 归零＝红标即行首；信号恢复每秒重算自动摘标、状态文字原样复原。文案/阈值单源 = `messages.js statusFlags(connUp, staleSec)` + `STALE_SEC=150`（优先级：连接中断 > 无响应；`staleSec<=0` = 本帧判据不适用） | |
| ├ ├ 记录行 | `tool-fold` summary（`.tf-label`） | **被折叠进状态显示行的留存子元素**：完成工具的概括记录（「运行了命令 (1)」等），收口后留存、可折叠展开工具明细（`.tool-line` 单工具行） | |
| ├ 旁白 | `.done-think` | 体内 AI 叙述文本块；回合结束后渲染为回复气泡正文 | 旁白/结论 |
| ├ 行首槽 | `.t-ico` | 状态行与工具行的共用行首图标槽（16px 固定宽、内含 14px svg，**通用类**——从 `.tool-line .t-ico` 提升）；扫光宿主之一（透明覆盖扫光条 `::after`，与 `.tool-line.tool-running`/`.tool-fold[data-state='running'] summary`/`.tool-cur summary` 共用同一规则组，`.think-state` 侧限 `:not(.ts-join)`） | |
| ├ 工具调用行 | `.tool-line`（运行中 `.tool-running`） | 单工具一行（图标+名称+详情）；**并发复合时它是唯一行容器 `.fold-state` 里的让位方**（`.tl-text` 省略号 + 可收缩），状态尾缀恒完整（见上「状态尾缀」） | 工具调用行 |
| ├ 工具折叠 | `details.tool-fold` | 多工具成组折叠体（工具调用行自成折叠时的形态）；真空态状态层 `.fold-state` 并入其 summary（并入时顶替 tf-label）；概括标签 `.tf-label` 超宽单行省略；**开合态恢复用结构稳定键 `foldKey`**（宿主段 `data-m|data-t` + 主类名 + 段内同类序号；取代数组下标——下标错位会把旧 done-fold 的 open 灌给新 tool-fold）。**注：`foldKey` 只治「折叠体自动展开」；「运行命令块异常大」真因是并发复合态的行内挤压（见「状态尾缀」）** | |
| └ 思考折叠 | `details.think-row` | 思考文本折叠体 | |
| 变更卡 | `.change-card` | 「N个文件已更改」文件增删清单 | |
| 乐观气泡 | 无 `data-m` 的 user 气泡 | 发送瞬间先行渲染、尚未落盘的用户气泡；落盘原地换真身 = **接管帧**（首条消息事务链 `firstSendHash`）；乐观/落盘两态 body **同走 `mdHtml`**（同源渲染，两态气泡尺寸零差异） | 开启消息/开启主张 |
| 排队 dock | `.queue-dock` > `.q-item` | 排队消息条目（无「排队中」文本标签）；`.q-item` = 纯命中盒（无背景/边框/内边距），**气泡壳挂文字段 `.q-text`**——气泡归属文字、不归属图片：纯文本项=一个气泡、纯图项无 `.q-text` 即无气泡（整张图即点击体）、文字+图项=文字带气泡而图片在气泡外裸渲染；排队图恒 `.q-img` 不换 `.msg-img`（不开大图） | 排队消息 |
| 两层消息流占位 | `.pin-stage` | 回合开启消息唤出的静态预留块（层2），挂流末恒定在场，高度=max(0, 视口高−输入栏预留−**当前**内容脚印)（脚印实时读取——内容增长/收起都不产生额外滚动余量，未超一屏时滚动极限恒=开启气泡贴顶位；空白恰铺到输入栏上沿，长会话不加空白）；**用户滚动输入永不摘占位**，拆收仅随视图退出 | 钉顶占位/`.pin-spacer`（动态补差体系已退役） |
| 撤回动画 | restored 链 | 打断无实质响应 → 气泡塌缩淡出 + 文本回填输入栏 | |
| 压缩实时态 | compact-state → 状态行 | 「正在压缩会话中……」 | |
| 图片消息 | `.msg-imgs`/`.msg-img` + 灯箱 | 内联缩略图（上限 160px）+ 点击放大层 | |
| 文件卡片 | `.msg-files`（`.file-card`） | 消息内文件附件卡片（dshFile 图标 + 文件名，点击复制路径）；发送占位 `[文件:<会话 cwd 相对路径>]` 在渲染层剥出 | |
| 任务列表复选框 | `.md-task-checkbox`（`core/markdown.js`） | `- [ ]`/`- [x]`/`- [X]`（有序表同支持）行渲染出**真** `<input type="checkbox">`（`data-task-line` 记行号、`disabled` 只读展示），**非 CSS 伪元素模拟**；`data-md` 仍挂整行原文（`- [ ] 待办甲`）⇒ 复制得原文。可编辑面（用户改勾选态）走 CM6 `toggleTaskLineCM`（§67.2） | 任务项/checkbox |
| 代码块/表格 | `.code-block`/`.md-table` | markdown 渲染件；代码块为 codex 式（头栏 `.code-head`＝语言名 `.code-lang` + 动作钮 `.code-acts`〔软换行 `.cb-wrap` / 复制 `.cb-copy`〕，体 `pre > code` 走 lowlight `hljs-*` 着色 + 软换行偏好 `.wrap`），见 web-ui.md §59 | |
| 消息操作条 | `.msg-actions`（`.msg-copy`/`.usage-wrap`/`.msg-time`） | 气泡底部一行：复制钮（copy→check 1s，复制文本经 `messageCopyText` 剔 `.msg-actions` 等）→ `.usage-wrap`（含「用量 X tok」**按钮** `<button class="msg-usage">`〔`ICON_USAGE` 数据库图标 + 该条回复请求 token 合计 `input+cache_creation+cache_read+output`，`fmtUsage` ≥1e3 折 K 一位小数；点击弹 `.usage-pop` 明细面板〕）+ `.usage-pop`）→ 时间（本地中文单位 `YYYY 年 M 月 D 日 HH : MM`、前导零省略，`fmtClock`）；用量按钮文字与时间**同字号 12px**；**仅 assistant 回复气泡携带**（用户气泡只有复制钮）。数据源 = 投影层 `DisplayMessage.usage` 明细对象 `{input,cacheRead,cacheWrite,output}`（`conversationDisplay.ts` assistant 分支 `usageDetail`）+ `DisplayMessage.model` + `DisplayMessage.timestamp` |
| 用量明细面板 | `.usage-pop`（`.up-head`/`.up-title`/`.up-total`/`.up-rows`/`.up-row`/`.up-k`/`.up-v`） | 点 `.msg-usage` 弹出的卡片（绝对定位在 `.usage-wrap` 内，`left:0` **左缘对齐用量按钮左缘**〔dsh 同款〕、底部对其上方 8px、宽 280px，`--bg`+`--border`+`--shadow`）：头部「本轮用量」+ 合计（`fmtTok` 千分位）→ 行 = 提供方 / 模型（`modelProviderOf({k:'model',v:model})/model`）、缓存命中 `cacheRead/(input+cacheRead+cacheWrite)`、未缓存输入、缓存读取、缓存写入、输出（各 `fmtTok` tok）。打开时 `.msg-usage` `aria-expanded="true"`；单开互斥（`closeUsagePops` 开本关它）+ 点外区关闭 | |
| 图表卡 | `.chart-frame`（` ```chart ` 围栏） | 双段围栏的 web 渲染形态：`%%html` 段进沙箱 iframe（`sandbox="allow-scripts"` srcdoc，opaque origin），`%%ascii` 段弃用、`chart-raw` 留全文供「源码」按钮切换；高度自适应（srcdoc 尾注 CHART_BOOT ResizeObserver postMessage 上报，CSS max-height 60vh 内部滚动） | |
| turn-beat | SSE | 引擎增量活性心跳（150s 无 beat 且无已知阻塞原因在场 → 标「无响应」；**已知阻塞原因在场时抑制**——审批接管（等待审批）与**工具在飞**（等待工具结果）都属正常停顿非僵死，工具在飞判据取 `.tool-line.tool-running` 运行态标记）；**红标文案/阈值单源 = `messages.js statusFlags(connUp, staleSec)` + `STALE_SEC=150`**，豁免场景由调用方传 `staleSec=0` 表达「判据不适用」；红标在场时独占状态槽（见「红标独占」） | |

## 输入区

| 规范名 | 实体 | 说明 | 旧称 |
|---|---|---|---|
| 输入栏 | `#input-bar`（挂载 `#input-wrap`） | 会话内 docked 态贴底；空态时挂新会话界面 stage 内 | 输入栏 |
| 输入框 | `#input` | contenteditable 富文本；**粘贴一律落 text/plain**（图片粘贴分支除外：`clipboardData.files` 优先入列） | |
| 发送钮/停止键 | `#send-btn` | 回合进行中变停止键（发 interrupt 打断；空输入才响应停止键） | 打断按钮 |
| 项目选择器 | `#proj-seat` + `#proj-pop` | 空态选目标项目（「全局」默认）；会话态锁定只读（项目 chip） | |
| 模型·推理座 | `#model-seat` + `#model-pop` | 模型与推理等级两级选择（等级菜单按供应商 `effortLevels` 声明动态渲染，GLM 未设置显「默认」） | |
| 上下文占用环 | `#ctx-meter` | 环形百分比 + 点击展开 breakdown 面板 | |
| 附件（落点按 target 分） | 底栏 `#img-pills` 胶囊 / 正文 Markdown 原文引用 | **底栏 composer**：上传/粘贴**只进 `#img-pills` 胶囊行**（`pending*` 内部态回显，缩略图/文件卡 + `×`），**不自动插输入框正文**；**work 编辑卡**：插正文引用——图片 `![](file-cache/<dirKey>/x.png)`（`editor/editor-attachments.js`，行内由 `edAttImgPlugin` 直渲 `<img class="cm-att-img">`，尺寸=文字行高）、文件 `[文件名](file-cache/<dirKey>/x.pdf)`；**@ 浮窗「上传」组**可把本次上传插回正文。上传落盘名 = 时间戳 `YYYYMMDDHHMMSS.<ext>`（`uploadStampName`）。渲染与可编辑同源（光标/拖选落引用区间即还原源码）。消息流侧同经 `mdHtml` 渲 `.msg-img`。见 §67.3 | 附件胶囊/`#img-pills` |
| `+` 浮窗 | `#cmd-btn` 唤出 | 去顶层 tab，单页四组堆放（上传=选图行+已选缩略图+文件上传行 / 技能=MGR.skills.personal / 引用会话=近 48h ALL / 指令=MOCK_COMMANDS；`.grp` 组标题 + `.rowIco` 行图标）；等宽=输入栏同宽，搜索框滤全部组。**行图标 = dsh `MenuView .itemIcon` 逐字（14×14 裸图标，无背景/圆角，色随行文本）**；**每条命令各有字形**（`commands.js` `CMD_ICON` 表，同 dsh `HOST_FACES` 语义，表外回落 `dshPlus`），非整列共用「+」；图片行字形 = Radix Icons `image`（dsh 产品集无图片图标，取 `icons.js` 里唯一非 dsh 原件）；`/clear` 行已删（无对应前端动作）；goal 字形备存 `I.dshGoal` 未上行（floria 后端无 `/goal` 命令）。**dsh 图标族不变量：`stroke="currentColor"` 逐条挂 path、绝不挂 `<svg>`**（只有 `stroke-width` 在 `<svg>`）——含 `fill="currentColor"` 实心路径的字形（dshFile、dshSkill）若在 `<svg>` 上写 stroke，实心轮廓会被再描一遍、比同排粗一倍 | |
| 命令菜单 | `#cmd-pop` | 统一条目 `cmdEntries()` 平铺索引（键盘导航跨组）；选择分发：图片行=`img-file` 选图 / 文件上传行=`file-upload` 选文件（`addUploadFiles` 上传**落盘按项目+会话**：带 sid 网关落 `<会话启动根>/.claude/file-cache/<会话uuid>/`（时间戳名），无 sid 带 project 按项目根落 `_pending`；**底栏只进 `#img-pills` 文件卡、不插正文**，work 编辑卡才插 `[文件名](file-cache/<dirKey>/<名>)` 原文引用，见 §67.3）/ 技能·会话=`appendMentionChip` 追加输入栏（serializeInput 序列化 `[插件:X]/[会话:X]` 令牌，与 @ 提及同链）/ 命令=原链（risk→确认门）；vision 入口门控随图片 tab 退役（粘贴/拖拽/发送链本无门控） | |
| 风险确认门 | `#risk-modal` | 高危命令确认对话框 | |
| @ 提及浮窗 | `#mention-pop` + `.mention` | 插件/技能 + 近 48h 会话提及选择（会话区为浮窗第一区） | |
| 引用浮窗 | `.quote-pop`（`inputbar/quote.js`） | 编辑区/消息流选中文本**松开鼠标**即唤出（document mouseup）；**浅色竖排菜单**（色值不跟主题变量）：动作行（内置「使用 AI 编辑」+ 项目申报行，见「浮窗动作」）+ 下行输入行（写话术即发「引用 + 话术」）；**右键不拦**，浏览器原生菜单照旧；开窗即快照选区（点浮窗输入框会清 DOM selection；快照 = `quoteSnapOfRange(range)` 单一构造入口、无模块级状态）。两条来源：宿主机内选区（桌面鼠标）+ 预览页 `postMessage` 自报。**触屏设备不弹本浮窗**（走 iOS 原生选中菜单）。见 web-ui §47/§48 | 选中引用浮窗 |
| 引用胶囊 | 输入栏 `.mention.ref` / 消息内 `.mention-chip.m-ref` | 选中引用的 chip：**file 类** = 文件 icon +「引用自 <basename>」（只给位置，序列化 `[@引用:<路径>#L<s>-<e>]`）；**reply 类** = 消息 icon +「引用自「<标题>」· 第 N 条回复」（序列化 = 锚点令牌 `[@引用回复:<第N条>|<标题>]` + 原文块）；**pdf 类** = 文件 icon +「引用自 <basename> · 第 N 页」（序列化 `[@引用PDF:<路径>#p<s>-<e>]` + 原文块）；两类原文块只进消息、气泡渲染前由 `stripQuoteBodies` 剥掉；回显双入口 `renderUserText`/`mdInline`。见 web-ui §47/§48 | 引用 chip |
| 浮窗动作 | `preview.json` `quoteActions` 段 / `.quote-pop .qp-row` | 项目向宿主申报的浮窗动作行（与 `backend`/`cards` 并列的**第三种能力申报**）：纯数据（无 path，不指向文件；`id` 白名单 + 组内唯一、`title` 非空、`icon` 取 `I` 表键缺省 `plug`）。宿主与内置行「使用 AI 编辑」合流（同 id 内置优先），点击**只回发 id**（`floria-quote-action`）给预览帧，**执行逻辑在项目页面自己的运行上下文**。载体复用 `GET /gateway/preview-cards`（一次请求取两份申报），动作表常驻 `engine/ext-runtime.js`，与 EXT 卡同生命周期。见 web-ui §48 | 申报动作/浮窗 tab |
| 预览桥 | `floria-quote-open` / `-close` / `-action`（`window.message`） | 预览页（iframe）内的选区跨文档不可达 ⇒ 预览页自报开窗/关窗（`-open` 带 `{text, rect, pdf, page, pageEnd?}`，rect = 帧内视口坐标），宿主点申报动作回发 `-action`（`{id}`）。**门 = `e.source` 必须是当前 `.preview-frame` 的 `contentWindow`**（按 e.source 反查帧，不取第一个）；宿主 `quoteFrameRect` 叠帧偏移换算坐标。见 web-ui §48 | 预览引用桥 |
| 提及令牌 | `[会话:标题\|sid]` / `[插件:X]` | chip 随消息文本发出的字面令牌（`serializeInput` 单一序列化点）；**会话令牌恒带 sid**（精确寻址，免疫改名），chip 与 CLI 终端**只显示标题**（按 `\|` 切分）；sid 由 `hashOf(s)` 得出（与 web 消息路由同键）。两个提及入口 = `@` 浮窗（`mention.js`）与「+」菜单「引用会话」（`commands.js`）——**两处都输出带 sid 形态**；令牌为纯 UI 引用手势，**不产生授权** | |
| 接管栏 | `#composer-takeover`（`#input-bar` 最后一个子元素） | **仅审批/提问卡（`.appr-card`）**；可交互提问走 CLI 审批链 `renderQuestionApproval` 下发的 `.appr-card.qa-card`（选项点选/多选/自定义输入/跳过/上一题下一题）；审批卡是输入栏的子元素而非兄弟节点；`.bar-takeover` 时输入栏仅 `padding:0 + overflow:hidden`（**卡自身铬全剥离贴卡面**——`.appr-card` 去边框/背景/圆角/阴影，黄条头贴顶，圆角由输入栏裁溢出裁出；输入栏自身边框/背景铬不动=表面连续）+ 原内容组 `display:none` → 卡片即输入栏本体；出现/解决 = **单一时间轴：输入栏自身高度** h0→h1 过渡（0.32s cubic-bezier）+ overflow 裁切（无 fade 淡入淡出——杜绝淡入与高度动画双时间轴竞速）；动画期 `.composer-growing` 卡片 absolute bottom:0 底边锚定，`wrapAnimating` 期 `syncTakeoverPad` 首行直接 return（RO 守卫）；聊天区 padding-bottom 一次性设终值 + `lastPad` 同值短路 | |
| 任务浮窗 | `#task-dock` + `.td-panel`/`.td-lip`/`.td-head`（`#input-bar` 子元素） | 底栏上的生长式浮窗，渲 TodoV2 任务清单（CLI `task-state` 上报，与 CLI `TaskListV2` 同源同判定）；**dsh 任务栏形态**（2026-10-04 定案）——收敛态露出**整条头部条**（`.td-lip`，与 `.td-panel` 同族白卡）：计划图标 `.td-hico` + 「任务」`.td-title` + 计数 `.td-counts` + 折叠箭头 `.td-chev`（收敛朝上/展开朝下，`:not(.open)` `rotate(180deg)`），点击上展、再点 `.td-head`（同 header）向下收敛；展开态=头部 + 圆点状态行列表（`.td-item`/`.td-dot`：完成绿实心 / 进行中蓝环 / 待办灰实心，语义挂 `data-st`），仅阻塞行 dim（完成行不变暗）；宽=输入栏宽−48px 居中，展开底边与输入栏上沿留 `--td-gap`=10px 间距、最高 `min(40vh,460px)` 内部滚动；审批/提问接管在场 → `.blocked` 自动收敛 + 禁点 | 任务栏/任务清单窗 |
| composer 遮罩 | `#composer-mask`（`#session-card` 内、`#chat-scroll` 兄弟） | 会话态贴底栏的全卡宽渐隐层：`linear-gradient(180deg, color-mix(in srgb, var(--sunken-bg) 0%, transparent) 0, var(--sunken-bg) 36px)` 上叠实心底（透明→底色 36px 渐隐带 + 其下实心遮住滚过的消息；**底色 = 模式色钩子 `--sunken-bg`**，chat 白卡 / work 底板随模式换色）；高度 `calc(var(--bar-h,116px) + 58px)`——`--bar-h` = 底栏布局高（`engine/viewport.js` settle 实测 `#input-wrap` offsetHeight），故多行输入/接管卡长高时渐隐带上沿随底栏上沿同步上移；仅 `#chat-area.in-session` 显形（空态/管理卡隐，`#session-card.wk-assist-slim` 一并隐）；z-index 3：盖消息流、低于 `#char`(4)/`#input-wrap`(5)，`pointer-events:none` 不挡交互。移植自 dsh `ConversationRoot` `.composerSeat` input mask，见 web-ui §51 | |
| toast | `#toast` | 轻提示条（2.6s 自灭，非阻塞反馈） | |

## 浮窗与覆盖层（泛指）

- **浮窗** = 锚点弹出小层统称（`.popup` 家族）：整理会话弹层、最近会话气泡（`#bubble-pop`）、提及浮窗、模型/项目弹窗等。
- **覆盖层** = 全屏层统称：搜索覆盖层、重命名弹窗、风险确认门、拖放覆盖层、灯箱。

## SSE 信号族（网关 → web 群发）

| 信号 | 用途 |
|---|---|
| `turn-state` | 回合开始/结束（打断收口双持久信号之一） |
| `turn-beat` | 引擎增量活性心跳（150s 缺席且无已知阻塞原因——无审批接管、无工具在飞 → 标「无响应」；红标在场即独占状态槽，状态文字/流式预览同隐） |
| `stream-text` | 流式字符通道（CLI 流式 delta 100ms 合帧全文快照 → 状态行后流式预览；'' = 块边界/落盘/打断清除。纯显示暂态不落盘，权威 delta 接管即让位） |
| `compact-state` | 压缩实时态起止 |
| `restored` | 撤回链（文本回填输入栏） |
| `queue-state` | CLI 入队上报（排队 dock 数据源；每项可带 `from:{title,sid?}` = 会话间通信来源，CLI 上报前已剥包装，见 [gateway.md](gateway.md) §12/§13） |
| `task-state` | CLI TodoV2 任务清单上报（任务浮窗数据源；空数组=清单清空 → 浮窗整体不出现） |
| `model` | CLI 每会话实际模型上报（HTTP `/gateway/model-report` 落值即群发，唯一不走 `/clients` WS 的信号；底栏模型 seat 实时校准源，见 [web-ui.md](web-ui.md) §5） |
| `ws-failed` | web 独立会话启动失败 |

## 生图能力层（输出侧，后端概念）

| 规范名 | 实体 | 说明 | 旧称 |
|---|---|---|---|
| 生图能力层 | `services/imagegen/` | provider-neutral 输出侧生图：能力判定 → 选 adapter → 生成（超时/重试）→ 落盘 → `![](文件名)` 回填 → 合成 Anthropic 响应。展示链（`.claude/images/` + `/gateway/file` + CLI/web 渲染）与厂商无关，零改动复用 | Gemini 生图/Gemini adapter（架构本身） |
| 生图 adapter | `services/imagegen/adapters/*.ts` | **厂商协议差异唯一所在**：`supports(ctx)` + `generate(req,ctx)`，import 即自注册进注册表；新增一家只写一个 adapter | 厂商分支/特判 |
| 能力声明 | `ProviderConfig.imageCapabilities` | 每模型 `{inputImage,outputImage,imageEdit,multiTurnImage}`；**`outputImage` = 请求交给生图能力层的唯一判据**；与 `modelVision`（输入侧识图）并列独立、互不覆盖；缺省 = 功能关闭。姊妹字段 `imageModel?`（主模型编排时**选用的生图模型 id**，缺省 = `ImageGeneration` 工具关闭）；凭据池 `CredentialsFile.tools.image`（`{provider,model?}`，**按能力分槽的工具绑定**）= **回落目标**：会话 provider 无生图能力时工具改用绑定 provider 的模型/端点/钥匙（会话自带可出图 `imageModel` 时优先）。工具绑定模型**不出现在可切换模型列表**（谓词 `isToolBoundModel()`，web/CLI 共用；仅隐藏不禁止） | 生图模型清单 |
| 生图落盘名 | `{provider}-{模型短名}-{YYYYMMDDHHmmss}[-{n}].{ext}` | 落 `<cwd>/.claude/images/`（与 `/gateway/file` 同口径），原子写；模型短名去尾 `-preview`；`seq` 防同秒多图互覆；超 4MB 先压后落 | |
| 会话生图上下文 | `services/imagegen/sessionContext.ts` | 记住本会话**最近生成的一张图**（内存 Map + 写透盘 sidecar `.imagegen-context.json`），使「继续把刚才那张改成夜景」无需重新附图。输入图装配优先级：**显式附图 > `@图片引用` > 上下文回注**；门控 `imageEdit\|\|multiTurnImage` 且本轮无其它附图，命中加正文标记「（基于上一张图继续编辑）」。条目 `path`=展示图、可选 `sourcePath`=全保真原图；**回注读 `sourcePath ?? path`** | 多轮改图记忆 |
| `@图片引用` | `[@文件:<工作区相对路径>]` 图片令牌 | web `@` chip 产出的**纯文本令牌**；生图会话不传 tools ⇒ 由 `mentionImages.ts` 在**请求装配期**解析成 `InputImage`（服务端、前端中立）。门控 `inputImage`；基准 `getPortableRoot()`；`resolveRealWithinRoot` realpath 复核挡符号链接/junction 逃逸 + 拒非普通文件；非图扩展名静默跳过、失败进警告回正文 | @图片路径 |
| 生图原图（`.source/`） | `<cwd>/.claude/images/.source/<名>` | **全保真原图**（隐藏子目录、**永不被 markdown 引用**）。展示图恒扁平落 `<dir>`（web `MD_IMG_CODE` 只认单文件名）+ 受 4MB 上限；**仅当压缩过**才把原始字节按源扩展名写 `.source/`，`PersistedImage.sourcePath` 指原图、未压缩时 `=== path`（零额外写盘）。改图回注基于原图而非降质预览 | — |
| `ImageGeneration` 工具（主模型编排） | `tools/ImageGenerationTool/` | **文本模型编排生图入口**：运行态门控 `isImageGenerationToolEnabled({target, sessionCaps, sessionModel})`——存在**可出图的生图目标**（`selectImageTarget`，**会话 provider 优先**、否则回落凭据池 `tools.image`）且**会话模型非生图模型**（与直连链互斥）。**`sessionModel` = `getMainLoopModel()`（含 /model override / web 切换），非 provider 快照 `getActiveModel()`**；生图模型不用 sessionModel（回落时连端点/钥匙都取 `tools.image` 绑定 provider 的）。入参 `{prompt, image_path?, aspect_ratio?}`；复用 `generateImages` 核心。**可见性靠模型回显**：结果文本含 `![](文件名)` + 指示模型原样输出（web 只渲染 assistant 文本 ⇒ 零前端改动） | image_generation |

## 卡片公开 API（卡↔宿主 / 卡↔卡 / agent→卡，2026-10-11）

| 规范名 | 实体 | 说明 | 旧称 |
|---|---|---|---|
| 卡 | 预览帧 / 外置卡（iframe）或第一方内联卡 | web 前端里在浏览器内运行的一帧界面，对外暴露一组**公开命令**。iframe 卡只认识 `parent`（跨源拿不到兄弟帧的 `contentWindow`）——既是卡↔卡不能直连的物理原因，也是**不给卡加 token** 的鉴权边界 | 卡片 |
| 宿主总线 | `engine/card-bus.js`（唯一顶层名 `cardBus`） | 三层模型的**中介**层：帧实例表 + 命令通道（卡↔宿主）+ 跨卡 broker（卡↔卡）+ 能力表。**宿主是唯一 broker**——卡↔卡只能经它转译 | 卡片 API 总线 |
| 在场（卡） | 判据 `el.isConnected`（内联卡恒在场） | 卡是否仍挂在文档里。DOM 拆除点显式注销（`unregisterFrame`）；不在场即不可达，**绝不打开/启动一张卡**（那是用户手势） | — |
| 命名空间 `ns` | 信封前缀，如 `floria-pv` | 卡自定义的命令/事件命名空间，宿主从消息 `type` 前缀推导（`<ns>-cmd` / `<ns>-event`），不要求卡额外申报。agent 寻址里 `ns` 用于**跨设备选持卡浏览器** | — |
| 卡命令 / ack | `<ns>-cmd` / `<ns>-event{ev:'ack'}` | 每条命令恒回一条 ack（成功失败都在内），**ack 用 `cmd` 与在途命令配对**（每帧串行队列是前提）。标准方法集 `state`（必须）/`open`（可选），其余卡片自定义 | — |
| 能力表 | `listCaps()` / `GET /gateway/cards` | 各在场帧的 `{label, instanceId, kind, ns, cmds, ready}`；agent 的 `CardCall` list 数据源，也是「命令名以卡申报为准」的真源 | — |
| `instanceId` | 帧 key（`<kind>:<label>:<id>`） | 卡的最精确寻址键（id = ext 卡 `card.id`，否则自增序；同 kind+label 撞车加 `#seq`）。agent 寻址优先级 `instanceId > ns > label` | — |
| 保留前缀 | `floria-card-call` / `floria-card-result` | 卡↔卡信封（与卡 ns 零撞车）；由总线路由，目标不在场立即回 `{ok:false}` 不打开目标、禁自调用 | — |
| `CardCall` 工具 | `tools/CardCallTool/`（`feature('CARD_API')`） | agent→卡出口：`action:'list'`（列在场卡）/`'call'`（驱动命令）；经网关 `/gateway/card-call`。命令名不内置白名单（以卡申报为准，故须先 list） | card_call |
