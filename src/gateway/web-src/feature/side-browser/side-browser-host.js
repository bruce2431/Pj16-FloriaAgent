// 侧边浏览器宿主（2026-11-22）：把 browser/SideBrowser 纯组件挂到 chat 会话卡右缘，并注册为 inline 卡。
// 分区：组件目录（browser/）整目录可拷贝、零宿主依赖；本件是 Floria 侧唯一接线点——
//   · 挂载 #side-browser（#session-card 内满高 wrapper），仅 chat 模式可见（applySbMode 调 syncSideBrowserMode）；
//   · 注册 inline 卡 instanceId=floria-side-browser：openedit 等命令经 cardBus 暴露给 @ 提及派发器；
//   · Config/tabs.json 的内部页声明由组件自读，宿主只给 configUrl，不拼 iframe URL。
import { cardBus } from '../engine/card-bus.js'
import { state } from '../engine/state.js'
/* @module feature/side-browser/side-browser-host.js */

  const SIDE_BROWSER_INSTANCE = 'floria-side-browser'
  let sideBrowserCtl = null

  function sideBrowserBox() {
    return document.getElementById('side-browser')
  }

  // 仅 chat 模式在场：work 模式的右栏/下沉区有自己的卡，不叠加侧边浏览器。
  function syncSideBrowserMode(workOn) {
    const box = sideBrowserBox()
    if (box) box.hidden = !!workOn || !sideBrowserCtl
  }

  function initSideBrowser() {
    const box = sideBrowserBox()
    if (!box || !window.UIDesignSideBrowser || sideBrowserCtl) return
    sideBrowserCtl = window.UIDesignSideBrowser.mount(box, {
      ns: SIDE_BROWSER_INSTANCE,
      appOrigin: location.origin,
      configUrl: '/browser/Config/tabs.json',
    })
    const invoke = (cmd) => (args) => sideBrowserCtl.dispatch(cmd, args).then((r) => {
      if (r.ok === false) throw new Error(r.error || '命令失败')
      return r.result
    })
    cardBus.registerInlineCard({
      instanceId: SIDE_BROWSER_INSTANCE,
      ns: SIDE_BROWSER_INSTANCE,
      cmds: ['open', 'load', 'page', 'back', 'forward', 'reload', 'close', 'state', 'locate'],
      handlers: {
        open: invoke('open'),
        load: invoke('load'),
        page: invoke('page'),
        back: invoke('back'),
        forward: invoke('forward'),
        reload: invoke('reload'),
        close: invoke('close'),
        state: () => sideBrowserCtl.state(),
        locate: () => sideBrowserCtl.state(),
      },
    })
    syncSideBrowserMode(state.sbMode === 'work')
  }
