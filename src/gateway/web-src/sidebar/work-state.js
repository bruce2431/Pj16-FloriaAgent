// work 视图项目槽的缺省值（2026-10-10 自 engine/state.js 下移）：work 领域默认值，归 feature 层
// （sidebar），不进 core——core/storage.js 的 loadWork/loadWorkSlot 收 defaults 参数，由本层调用方传入。
// 唯一手改处，web/app.js 为生成物。

/* @module sidebar/work-state.js */
  // 项目槽缺省（新项目 / 无槽时用）。**键名 = 槽内键名 = state 上同名 live 字段**
  // （state.workSlots[<label>]，见 core/ui-state.js 与 core/storage.js 的 stashWorkSlot/loadWorkSlot）。
  // 一个键一件事，槽与 live 字段一一对应，不再有两套命名（旧 wkPanes 的 workspace/sidebar 已并入
  // wkPreview/panelPinned，由 loadWork 的迁移一次性折叠）。
  const WORK_SLOT_DEF = {
    wkTab: 'files',        // 侧栏体：'files' 文件树 / 'chat' 会话列表
    wkMainTab: 'chat',     // 下沉区：'chat' 助手 / 'file' 编辑区 / 'plugins' 项目插件页
    wkAssist: true,        // 聊天 tab 是否在场
    wkAssistMode: 'side',  // 助手形态：'side' 靠栏 / 'float' 悬浮卡 / 'slim' 收敛输入栏
    wkAssistH: 430,        // 悬浮卡高度 px
    wkChats: [],           // 顶栏聊天胶囊开放集（会话 hash 或 'new'）
    wkFiles: [],           // 顶栏文件 pill 开放集（项目内相对 POSIX 路径）
    // 该项目**切换前停在哪个会话**（'' = 无活动会话）。**槽专属字段，无同名 live 字段**——
    // 活动会话的真源是路由 state.currentHash，本键只在 stash 那一刻记下它，供切回时作恢复目标
    // （switchWorkProject 返回它，调用方显式 navigate）。不是顶栏开放集，不进 wkChats。
    activeChat: '',
    workFile: '',          // 当前打开的文件（项目内相对路径）
    wkPreview: true,       // 右栏预览列是否在场
    wkPvTab: '',           // 右栏页态：'' = 预览态 / 已注册工具 id
    wkPvCard: '',          // 预览态当前卡 id（'' = 无卡项目的传统单页）
    panelPinned: false,    // 侧栏是否被主动打开（桌面）
  }

export { WORK_SLOT_DEF }
