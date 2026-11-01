// 管理页通用 UI 接缝（唯一真源 = @floria/web 包的 mgr 组件族；本件只转名，禁在 Floria 内复刻）
/* @module core/mgr-ui.js */
  // 页面壳 / 搜索 / 分类 / 卡片 / 动作位 / 详情头的结构与绑定在包内（mgr.js + mgr.css），
  // 业务侧只提供数据与回调。缺包即抛错（不回落本地副本）。
  if (!window.FloriaWeb) throw new Error('@floria/web 包未加载（/webui/floria-web.iife.js 须先于 app.js）')
  const MgrUI = window.FloriaWeb.mgr

export {
  MgrUI,
}
