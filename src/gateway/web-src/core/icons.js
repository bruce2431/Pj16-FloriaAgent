// 图标表接缝（唯一真源 = @floria/web 包；本件只摊名字，禁在 Floria 内复刻图标）
/* @module core/icons.js */
  // 2026-10-24 收口：产品图标表 I 移入 UI 基础包
  // `SubPj1-FloriaWebUI安装包开发/packages/web/src/icons.js`，产物 /webui/floria-web.iife.js 先于 app.js 同步加载并挂
  // window.FloriaWeb。缺包即抛错（不回落本地副本——回落会让两份图标表各自漂移）。
  // 文件图标 fileIcon = dsh 链接图标族（code=`</>` / image / document / other），唯一手改处
  // `SubPj4-CodeMirror6开发/src/icons/file-icons.js`，经 /cm6/floria-cm6.iife.js 挂 window.FloriaCM6。
  if (!window.FloriaWeb) throw new Error('@floria/web 包未加载（/webui/floria-web.iife.js 须先于 app.js）')
  if (!window.FloriaCM6) throw new Error('@floria/cm6 包未加载（/cm6/floria-cm6.iife.js 须先于 app.js）')
  const { I } = window.FloriaWeb
  const { fileIcon } = window.FloriaCM6

export {
  I,
  fileIcon,
}
