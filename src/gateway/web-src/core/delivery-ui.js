// 交付卡 / 文件变更卡接缝（唯一真源 = @floria/web 包的 delivery 组件族；本件只转名，禁在 Floria 内复刻）
/* @module core/delivery-ui.js */
  // 结构在包内（delivery.js + delivery.css），业务侧只提供纯数据并按 data-* 钩子绑行为。
  // 缺包即抛错（不回落本地副本）。
  if (!window.FloriaWeb) throw new Error('@floria/web 包未加载（/webui/floria-web.iife.js 须先于 app.js）')
  const {
    deliverGridHtml,
    changesCardHtml,
  } = window.FloriaWeb

export {
  deliverGridHtml,
  changesCardHtml,
}
