/* 遥测 · 会话查看器 — Service Worker（静态资源缓存 + 离线兜底） */
/* 2026-08-28 CORE 改绝对路径：SPA 路径路由（/session/<hash>）下 SW scope=/，相对路径等价但显式绝对防歧义 */
const CACHE = 'floria-v806'
// /vendor/katex/*（2026-10-06 公式渲染）：js+css+woff2 字体一并预缓存，保证离线时公式仍可排版
// /cm6/*（2026-10-24）：@floria/cm6 全局 IIFE（CM6 依赖全内联）随包预缓存，离线编辑可用
const CORE = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.json', '/icon.ico',
  '/cm6/floria-cm6.iife.js',
  // 侧边浏览器（2026-11-22）：纯组件脚本/样式 + 内部页编辑卡
  '/browser/SideBrowser/side-browser.js', '/browser/SideBrowser/side-browser.css',
  '/browser/Config/EditCard/index.html', '/browser/Config/EditCard/edit-card.js', '/browser/Config/EditCard/edit-card.css',
  // UI 基础包（2026-10-24 @floria/web）：全局 IIFE + 主题令牌/基础样式
  '/webui/floria-web.iife.js', '/webui/floria-web.css',
  // 解压组件（2026-10-24）：xlsx/docx 预览依赖 window.fflate
  '/vendor/fflate.js',
  '/vendor/katex/katex.min.js', '/vendor/katex/katex.min.css',
  '/vendor/katex/fonts/KaTeX_AMS-Regular.woff2', '/vendor/katex/fonts/KaTeX_Caligraphic-Bold.woff2',
  '/vendor/katex/fonts/KaTeX_Caligraphic-Regular.woff2', '/vendor/katex/fonts/KaTeX_Fraktur-Bold.woff2',
  '/vendor/katex/fonts/KaTeX_Fraktur-Regular.woff2', '/vendor/katex/fonts/KaTeX_Main-Bold.woff2',
  '/vendor/katex/fonts/KaTeX_Main-BoldItalic.woff2', '/vendor/katex/fonts/KaTeX_Main-Italic.woff2',
  '/vendor/katex/fonts/KaTeX_Main-Regular.woff2', '/vendor/katex/fonts/KaTeX_Math-BoldItalic.woff2',
  '/vendor/katex/fonts/KaTeX_Math-Italic.woff2', '/vendor/katex/fonts/KaTeX_SansSerif-Bold.woff2',
  '/vendor/katex/fonts/KaTeX_SansSerif-Italic.woff2', '/vendor/katex/fonts/KaTeX_SansSerif-Regular.woff2',
  '/vendor/katex/fonts/KaTeX_Script-Regular.woff2', '/vendor/katex/fonts/KaTeX_Size1-Regular.woff2',
  '/vendor/katex/fonts/KaTeX_Size2-Regular.woff2', '/vendor/katex/fonts/KaTeX_Size3-Regular.woff2',
  '/vendor/katex/fonts/KaTeX_Size4-Regular.woff2', '/vendor/katex/fonts/KaTeX_Typewriter-Regular.woff2',
  '/char/1.jpg', '/char/2.jpg', '/char/3.jpg', '/char/4.jpg',
  '/gate/state-token.webp', '/gate/state-newchat.webp', '/gate/transition.webm', '/gate/transition.mp4']

// 逐项预缓存：任一资源缺失不让整次安装失败（addAll 一个 404 即整体 reject，
// 旧 SW 会继续服役，造成新页面配旧资源的混版）。
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(CORE.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

// 网络优先，失败回退缓存（静态）；API 不缓存
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.origin !== location.origin) return
  if (url.pathname.startsWith('/gateway/')) return
  // /preview/ 不缓存：入口带网关 token（?token=），避免带凭据的响应进缓存残留，且预览页始终实时
  if (url.pathname.startsWith('/preview/')) return

  // HTML 导航网络优先且不回退缓存（2026-09-18 根修）：离线兜底曾在网络抖动瞬间静默回喂缓存里的
  // 旧 index.html → 旧 app.js（v330 之前无自愈的旧代码永停旧版，「刷新了还在跑旧前端」实报的交付
  // 根因）。覆盖全部 SPA 路由导航（mode==='navigate' 含 /session/、/project/ 等路径刷新）——导航失败
  // 宁可报错由用户重试，绝不静默发旧；静态资产兜底保留。
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request))
    return
  }

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(e.request, copy))
        return res
      })
      // 只回退该请求自身的缓存；绝不拿 '/'（index.html）顶替 JS/CSS——那会让脚本拿到 HTML
      // 解析失败，window.FloriaWeb/FloriaCM6 缺失，图标与整个 app 启动一起崩。
      .catch(() => caches.match(e.request).then((m) => m || Response.error())),
  )
})
