#!/usr/bin/env bun
/**
 * probe-web-package —— @floria/web UI 基础包与 Floria 的接缝不变量（2026-10-24）
 *
 * 结构锁点：
 *   1) 包在 `SubPj1-FloriaWebUI安装包开发/packages/web/`：src 只放无业务状态的底座（icons/dom/theme），
 *      build.ts 产出 ESM + IIFE（window.FloriaWeb）+ CSS 三件。
 *   2) Floria 的 webui/ 是包的产物副本（逐字节一致）——图标/令牌唯一真源在包，Floria 不复刻。
 *   3) index.html：webui CSS 在 styles.css 之前、webui IIFE 在 app.js 之前；sw CORE 预缓存两件。
 *   4) styles.css 不再持有 :root 令牌 / reset / 统一滚动条（已迁包）。
 *   5) core/icons.js 只是转调接缝：缺 window.FloriaWeb 抛错，自身无图标字面量。
 */
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')
const PKG = '../SubPj1-FloriaWebUI安装包开发/packages/web'

let pass = 0
let fail = 0
const ok = (m: string) => {
  pass++
  console.log(`PASS  ${m}`)
}
const bad = (m: string) => {
  fail++
  console.log(`FAIL  ${m}`)
}

// ---- 1. 包本体 ----
const pkgJson = JSON.parse(read(`${PKG}/package.json`))
if (pkgJson.name === '@floria/web' && pkgJson.private === true && pkgJson.type === 'module') ok('包声明：@floria/web / private / type=module')
else bad('包声明不符（name/private/type）')

const buildTs = read(`${PKG}/build.ts`)
if (/floria-web\.iife\.js/.test(buildTs) && /window\.FloriaWeb/.test(buildTs) && /floria-web\.css/.test(buildTs)) ok('build.ts 产出 ESM + IIFE（校验 window.FloriaWeb）+ CSS')
else bad('build.ts 未产出三件或未校验全局名')

const pkgIcons = read(`${PKG}/src/icons.js`)
if (/const I = \{/.test(pkgIcons) && /function fileIcon\(/.test(pkgIcons) && /export \{\s*I,\s*fileIcon,?\s*\}/.test(pkgIcons)) ok('包 src/icons.js 持有图标表与 fileIcon（唯一真源）')
else bad('包 src/icons.js 缺图标表 / fileIcon / export')

const pkgTheme = read(`${PKG}/src/theme.css`)
if (/:root \{/.test(pkgTheme) && /html\[data-theme="dark"\] \{/.test(pkgTheme) && /::-webkit-scrollbar \{/.test(pkgTheme) && /\* \{ box-sizing: border-box/.test(pkgTheme)) ok('包 theme.css = 令牌（明/暗）+ reset + 统一滚动条')
else bad('包 theme.css 内容不全')

const hasDist = ['index.js', 'floria-web.iife.js', 'floria-web.css'].every((f) => existsSync(resolve(ROOT, `${PKG}/dist/${f}`)))
if (hasDist) ok('包 dist/ 三件产物齐全')
else bad('包 dist/ 缺产物（先 bun build.ts）')

const distIife = read(`${PKG}/dist/floria-web.iife.js`)
const distCss = read(`${PKG}/dist/floria-web.css`)
if (/window\.FloriaWeb/.test(distIife)) ok('dist IIFE 挂 window.FloriaWeb')
else bad('dist IIFE 未挂 window.FloriaWeb')

// ---- 2. Floria 载入副本逐字节一致 ----
const webIife = read('src/gateway/web/webui/floria-web.iife.js')
const webCss = read('src/gateway/web/webui/floria-web.css')
if (webIife === distIife) ok('webui/floria-web.iife.js = 包产物（未手改）')
else bad('webui/floria-web.iife.js 与包产物不一致 —— 勿手改副本，回包内改再拷')
if (webCss === distCss) ok('webui/floria-web.css = 包产物（未手改）')
else bad('webui/floria-web.css 与包产物不一致')

// ---- 3. index.html 顺序 + sw 预缓存 ----
const idx = read('src/gateway/web/index.html')
const atCss = idx.indexOf('/webui/floria-web.css')
const atStyles = idx.indexOf('/styles.css?v=')
const atIife = idx.indexOf('/webui/floria-web.iife.js')
const atApp = idx.indexOf('/app.js?v=')
if (atCss > 0 && atCss < atStyles) ok('index.html：基础包 CSS 排在业务 styles.css 之前')
else bad('index.html CSS 顺序错（令牌须先于业务样式）')
if (atIife > 0 && atIife < atApp) ok('index.html：基础包 IIFE 排在 app.js 之前')
else bad('index.html 脚本顺序错（IIFE 须先于 app.js）')

const sw = read('src/gateway/web/sw.js')
const vSw = /floria-v(\d+)/.exec(sw)?.[1]
const vApp = /app\.js\?v=(\d+)/.exec(idx)?.[1]
const vStyles = /styles\.css\?v=(\d+)/.exec(idx)?.[1]
if (vSw && vSw === vApp && vSw === vStyles) ok(`cache-bust 同值（sw/style/app = v${vSw}）`)
else bad(`cache-bust 不一致（sw=v${vSw} styles=v${vStyles} app=v${vApp}）`)
if (/'\/webui\/floria-web\.iife\.js'/.test(sw) && /'\/webui\/floria-web\.css'/.test(sw)) ok('sw CORE 预缓存基础包两件（离线可用）')
else bad('sw CORE 未预缓存基础包')

// ---- 4. styles.css 不再持有基础底座 ----
const css = read('src/gateway/web/styles.css')
// 注：styles.css 末尾另有 CM6 库要求的 hsl 三通道 `:root` 桥接令牌（--foreground/--muted…），
//     那是给第三方库的别名，不属于基础底座；此处只锁 Floria 自己的令牌/reset/全局滚动条。
if (!/--plane:/.test(css) && !/^::-webkit-scrollbar \{/m.test(css) && !/^\* \{ box-sizing: border-box/m.test(css)) ok('styles.css 已无基础令牌 / reset / 全局滚动条（真源在包）')
else bad('styles.css 仍持有基础底座 —— 两份真源会漂移')

// ---- 5. core/icons.js = 转调接缝 ----
const adapter = read('src/gateway/web-src/core/icons.js')
if (/if \(!window\.FloriaWeb\) throw new Error/.test(adapter) && /const \{\s*I,\s*fileIcon,\s*\} = window\.FloriaWeb/.test(adapter)) ok('core/icons.js 转调 window.FloriaWeb（缺包直接抛错）')
else bad('core/icons.js 未按接缝模式转调')
if (!/<svg viewBox=/.test(adapter)) ok('core/icons.js 无图标字面量（未复刻）')
else bad('core/icons.js 仍内联 SVG —— 违反唯一真源')

const bundle = read('scripts/bundle-web-modules.ts')
if (/const PIECES[\s\S]{0,120}\{ file: 'core\/icons\.js', part: 1 \}/.test(bundle)) ok('bundle PIECES 首段仍是 core/icons.js（转调先于所有消费方）')
else bad('bundle PIECES 中 core/icons.js 不在最前')

// ---- 6. 管理页通用 UI 在包内（结构 + 样式单一真源） ----
const pkgMgr = read(`${PKG}/src/mgr.js`)
if (/export function mgrBrowse/.test(pkgMgr) && /export function mgrDetail/.test(pkgMgr) && /export const mgr = \{/.test(pkgMgr)) ok('包 src/mgr.js 持有 browse/detail 与 mgr 聚合导出')
else bad('包 src/mgr.js 缺管理页组件导出')
const pkgMgrCss = read(`${PKG}/src/mgr.css`)
if (/\.mgr-card \{/.test(pkgMgrCss) && /\.mgr-dl-hd \{/.test(pkgMgrCss)) ok('包 src/mgr.css 持有管理页结构样式')
else bad('包 src/mgr.css 缺 .mgr-card/.mgr-dl-hd')
if (!/\.mgr-card \{/.test(css) && !/\.mgr-dl-hd \{/.test(css)) ok('styles.css 不再持有管理页结构样式（真源在包）')
else bad('styles.css 仍持有 .mgr-card/.mgr-dl-hd —— 两份真源会漂移')
const mgrSeam = read('src/gateway/web-src/core/mgr-ui.js')
if (/window\.FloriaWeb\.mgr/.test(mgrSeam) && /const MgrUI = /.test(mgrSeam)) ok('core/mgr-ui.js 转调 window.FloriaWeb.mgr（缺包直接抛错）')
else bad('core/mgr-ui.js 未按接缝模式转调')

console.log(`\n${pass}/${fail}`)
process.exit(fail === 0 ? 0 : 1)
