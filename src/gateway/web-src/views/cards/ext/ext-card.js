// 外部预览卡片 · 渲染实现（卡片化二期）（2026-10-01 卡片化：views/ → views/cards/；唯一手改处，
// web/app.js 为生成物）
// 只留 iframe 壳：字段校验 / URL 构造归 engine/ext-decl.js（纯函数），外部卡运行时表归 engine/ext-runtime.js，
// 槽位编排归 engine/registry.js；本模块顶层把 mountExtCard 经 setExtCardRenderer 注入 ext-runtime——
// 外部永不获得在宿主 DOM 执行的能力。

import { esc } from '../../../core/util.js'
import { extCardSrc } from '../../../engine/ext-decl.js'
import { setExtCardRenderer } from '../../../engine/ext-runtime.js'
import { cardBus } from '../../../engine/card-bus.js'
/* @module views/cards/ext/ext-card.js */
  // ---------- 外部卡片（卡片化二期）----------
  // 用途：项目 `.claude/preview/` 里的界面单元（卡片）被 Floria web 内部调用——preview 在
  // preview.json 的 cards 段静态声明，或由预览页 postMessage 实时注册；宿主只按声明的 host 摆位，
  // **不解释卡片内容**（内容永远跑在它自己的文档里）。声明文件与 backend 段同一份申报表。
  // 渲染 = 一卡一 iframe（`/preview/<label>/<path>`，同源）：preview 保持自包含（自带 css/js/
  // 相对路径），与宿主 DOM/CSS/JS 零互相污染——一期 SPEC-视图卡化 §7「外部插件 = iframe」边界的延续。
  // 契约：preview.json cards（网关 GET /gateway/preview-cards 读出，见 docs/gateway.md §6）
  //       预览页 → 宿主 parent.postMessage({ type:'floria-cards-register', cards:[…] }, '*')
  //       宿主 → 预览页沿用既有 floria-rail-action 通道，本模块不新增回发。

  // 把一张外部卡的卡体写进宿主卡体（调用方 = registry 经 setExtCardRenderer 注入后 openCard 的 mount）
  function mountExtCard(body, label, card) {
    // 同卡重渲（切 kind/cat 或刷新）：旧帧随 innerHTML 拆除前先注销，否则表里留个死项
    const old = body.querySelector('.ext-frame')
    if (old) cardBus.unregisterFrame(old.__cardKey)
    // data-ext-label：预览目录文件变化（preview-changed）时按「项目 + 卡」定位该帧重载
    // （frame 层刷新归 feature/preview-frame.js，本模块只提供归属标记）。
    body.innerHTML =
      '<div class="ext-shell">' +
      `<iframe class="ext-frame" title="${esc(card.title)}" data-ext-card="${esc(card.id)}" data-ext-label="${esc(label)}" src="${esc(extCardSrc(label, card))}"></iframe>` +
      '</div>'
    // kind 恒 'ext'：EXT（当前预览项目）与应用（label = 全局根）共用本渲染器，label 已足以区分归属
    cardBus.registerFrame({ kind: 'ext', label, el: body.querySelector('.ext-frame'), id: card.id })
  }
  // 顶层注入：registry 的 EXT/APP 描述符 mount 走 extRender 闭包，外部实现不 import 进 engine。
  setExtCardRenderer(mountExtCard)

export {
  mountExtCard,
}
