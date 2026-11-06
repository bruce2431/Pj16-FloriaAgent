/**
 * GatewayControlBridge.tsx —— 网关模型/思考等级/重命名控制消息的 REPL 侧处理器（2026-08-22）。
 *
 * 在 replLauncher 的 <REPL> 旁挂载（AppStateProvider 之下）。挂载时注册全局 handler，
 * gatewayClient 收到网关按会话路由的 {type:'model'|'effort'|'rename'} 后 invoke，这里落地到真实 CLI 状态：
 *  - model  → 切换同拍化（2026-09-18）：模型+供应商成对挂起（setPendingSessionModelOverride /
 *    setPendingSessionProvider），回合边界（REPL getToolUseContext）与模型名快照同一拍落地；
 *    此处只立即更新显示态 setAppState({ mainLoopModelForSession: resolved })。
 *    'default'/null → 清覆盖+清绑定，回落读盘 getActiveModel()（凭据池）——只影响本会话，不写全局凭据池。
 *    上报网关带 resolved（2026-09-19）：STATE 此刻尚未落地，不显式传值只会报出切换前的旧模型。
 *  - effort → setAppState({ effortValue })
 *  - rename → 更新内存标题缓存（terminal title / status line / 退出 re-append）+ 输入栏徽标
 *    （standaloneAgentContext.name，useSwarmBanner 渲染），2026-08-25 web 重命名实时同步。
 * 与官方 useReplBridge.onSetModel/onSetMaxThinkingTokens 同一套语义；卸载时清空 handler。
 */
import { useEffect } from 'react'
import {
  setPendingSessionModelOverride,
} from '../bootstrap/state.js'
import { setControlOverrideHandle } from '../bridge/controlOverrideHandle.js'
import { reportCurrentModel, reportSessionEffort } from '../utils/gatewayClient.js'
import { setPendingSessionProvider } from '../utils/credentials/pool.js'
import { useSetAppState } from '../state/AppState.js'
import { applyExternalRename } from '../utils/sessionStorage.js'

export function GatewayControlBridge(): null {
  const setAppState = useSetAppState()
  useEffect(() => {
    setControlOverrideHandle((kind, value, provider) => {
      if (kind === 'model') {
        const resolved = value == null || value === 'default' ? null : String(value)
        // 2026-09-18 切换同拍化：模型+供应商成对挂起，回合边界（getToolUseContext）与
        // options.mainLoopModel 快照同一拍落地；本处只更新显示态（mainLoopModelForSession）
        // + 上报网关校准，不写 STATE/pool。null/'default' → 清覆盖、清绑定（回落凭据池启动快照）。
        setPendingSessionModelOverride(resolved)
        setPendingSessionProvider(provider ?? null)
        setAppState(prev =>
          prev.mainLoopModelForSession === resolved
            ? prev
            : { ...prev, mainLoopModelForSession: resolved },
        )
        // 2026-08-24 模型 web/CLI 同步：切换后立即上报实际模型给网关（web 端读取校准）。
        // 2026-09-19 修：新值此刻还挂起在 pending（回合边界才落地 STATE），读 getMainLoopModel()
        // 只会得到切换前的旧值 → 上报必须显式带「将要生效的模型」；resolved=null（'default'/清覆盖）
        // 无具体模型可报，交回默认读值路径（与主循环回落同源）。
        reportCurrentModel(resolved ?? undefined)
      } else if (kind === 'effort') {
        // null = 显式 Off（网关 'off'→null 约定）：保留 null 透传，resolveAppliedEffort
        // 据此显式不发 effort（2026-09-18 能力声明激活默认链后 undefined 会跟随默认，
        // 折叠成 undefined 会让 Off 失效）；'auto' 沿用清除语义 = undefined 跟随模型默认。
        const v = value == null ? null : value === 'auto' ? undefined : String(value)
        setAppState(prev => (prev.effortValue === v ? prev : { ...prev, effortValue: v }))
        // 2026-11-06 每会话思考等级（C）：回报本会话实际档位（null=Off / 'auto'=清除）→ 网关
        // sessionEfforts 镜像 → web 进会话时 /gateway/session.effort 校准，不再跨会话串档。
        reportSessionEffort(v === undefined ? 'auto' : v)
      } else if (kind === 'rename') {
        // 2026-08-25 web 重命名 → CLI 实时同步：网关已把 custom-title/agent-name 写入转录，
        // 这里只更新本进程内存缓存 + AppState，让输入栏徽标（useSwarmBanner）与 terminal
        // title / status line 立即反映新名字，无需重启 CLI。sessionId 不匹配时内部忽略。
        const rename = (value ?? {}) as { sessionId?: unknown; title?: unknown }
        const title = typeof rename.title === 'string' ? rename.title : ''
        const sessionId = typeof rename.sessionId === 'string' ? rename.sessionId : ''
        if (!title || !sessionId) return
        applyExternalRename(sessionId, title)
        setAppState(prev =>
          prev.standaloneAgentContext?.name === title
            ? prev
            : {
                ...prev,
                standaloneAgentContext: {
                  ...(prev.standaloneAgentContext ?? {}),
                  name: title,
                },
              },
        )
      }
    })
    return () => setControlOverrideHandle(null)
  }, [setAppState])
  return null
}
