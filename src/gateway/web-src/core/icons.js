// 图标表接缝（唯一真源 = @floria/web 包；本件只摊名字，禁在 Floria 内复刻图标）
/* @module core/icons.js */
  // 2026-10-24 收口：图标表（I + fileIcon）整体移入 UI 基础包
  // `SubPj1-FloriaWebUI安装包开发/packages/web/src/icons.js`，产物 /webui/floria-web.iife.js 先于 app.js 同步加载并挂
  // window.FloriaWeb。缺包即抛错（不回落本地副本——回落会让两份图标表各自漂移）。
  if (!window.FloriaWeb) throw new Error('@floria/web 包未加载（/webui/floria-web.iife.js 须先于 app.js）')
  const {
    I,
    fileIcon,
  } = window.FloriaWeb

export {
  I,
  fileIcon,
}
