// 用量按钮/明细面板 + token/时刻格式化 + 剪贴板写入
import { esc } from '../../core/util.js'
import { modelProviderOf } from '../../sidebar/mgr-data.js'
/* @module chat/messages/usage.js */
  // ---- 消息复制按钮（2026-08-21 移植 DSH MessageIconActions：28px 圆形图标钮，copy → check 1s 反馈。
  // path 取自 ui-primitives/icons IconCopyOutline16；成功对勾复用 I.dshCheck）----
  const ICON_COPY = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6.14929 4.02032C7.11197 4.02032 7.87983 4.02016 8.49597 4.07598C9.12128 4.13269 9.65792 4.25188 10.1415 4.53106C10.7202 4.8653 11.2008 5.3459 11.535 5.92462C11.8142 6.40818 11.9334 6.94481 11.9901 7.57012C12.0459 8.18625 12.0458 8.95419 12.0458 9.9168C12.0458 10.8795 12.0459 11.6473 11.9901 12.2635C11.9334 12.8888 11.8142 13.4254 11.535 13.909C11.2008 14.4877 10.7202 14.9683 10.1415 15.3025C9.65792 15.5817 9.12128 15.7009 8.49597 15.7576C7.87984 15.8134 7.11196 15.8133 6.14929 15.8133C5.18667 15.8133 4.41874 15.8134 3.80261 15.7576C3.1773 15.7009 2.64067 15.5817 2.1571 15.3025C1.5784 14.9683 1.09778 14.4877 0.76355 13.909C0.484366 13.4254 0.365184 12.8888 0.308472 12.2635C0.252649 11.6473 0.252808 10.8795 0.252808 9.9168C0.252808 8.95418 0.252664 8.18625 0.308472 7.57012C0.365184 6.94481 0.484366 6.40818 0.76355 5.92462C1.09777 5.34589 1.57839 4.86529 2.1571 4.53106C2.64067 4.25188 3.1773 4.13269 3.80261 4.07598C4.41874 4.02017 5.18666 4.02032 6.14929 4.02032ZM6.14929 5.37774C5.16181 5.37774 4.46634 5.37761 3.92566 5.42657C3.39434 5.47472 3.07859 5.56574 2.83582 5.70587C2.4632 5.92106 2.15354 6.2307 1.93835 6.60333C1.79823 6.8461 1.70721 7.16185 1.65906 7.69317C1.6101 8.23385 1.61023 8.92933 1.61023 9.9168C1.61023 10.9043 1.61009 11.5998 1.65906 12.1404C1.70721 12.6717 1.79823 12.9875 1.93835 13.2303C2.15356 13.6029 2.46321 13.9126 2.83582 14.1277C3.07859 14.2679 3.39434 14.3589 3.92566 14.407C4.46634 14.456 5.16182 14.4559 6.14929 14.4559C7.13682 14.4559 7.83224 14.456 8.37292 14.407C8.90425 14.3589 9.21999 14.2679 9.46277 14.1277C9.83535 13.9126 10.145 13.6029 10.3602 13.2303C10.5004 12.9875 10.5914 12.6717 10.6395 12.1404C10.6885 11.5998 10.6884 10.9043 10.6884 9.9168C10.6884 8.92934 10.6885 8.23384 10.6395 7.69317C10.5914 7.16185 10.5004 6.8461 10.3602 6.60333C10.1451 6.23071 9.83536 5.92107 9.46277 5.70587C9.21999 5.56574 8.90424 5.47472 8.37292 5.42657C7.83224 5.3776 7.13682 5.37774 6.14929 5.37774ZM9.80164 0.367975C10.7638 0.367975 11.5314 0.36788 12.1473 0.423639C12.7726 0.480307 13.3093 0.598759 13.7928 0.877741C14.3717 1.21192 14.8521 1.69355 15.1864 2.27227C15.4655 2.75574 15.5857 3.29164 15.6425 3.9168C15.6983 4.53301 15.6971 5.3016 15.6971 6.26446V7.82989C15.6971 8.29264 15.6989 8.58993 15.6649 8.84844C15.4668 10.3525 14.401 11.5738 12.9833 11.9988V10.5467C13.6973 10.1903 14.2105 9.49662 14.3192 8.67169C14.3387 8.52347 14.3407 8.3358 14.3407 7.82989V6.26446C14.3407 5.27706 14.3398 4.58149 14.2909 4.04083C14.2428 3.50968 14.1526 3.19372 14.0126 2.95098C13.7974 2.57849 13.4876 2.26869 13.1151 2.05352C12.8724 1.91347 12.5564 1.82237 12.0253 1.77423C11.4847 1.72528 10.7888 1.7254 9.80164 1.7254H7.71472C6.7562 1.72558 5.92665 2.27697 5.52332 3.07891H4.07019C4.54221 1.51132 5.9932 0.368186 7.71472 0.367975H9.80164Z" fill="currentColor"/></svg>'
  // 回复底部「用量」标签图标（2026-10-04 还原 dsh 回复操作条）：数据库圆柱（顶部椭圆 + 侧壁/中缝弧）。
  const ICON_USAGE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><ellipse cx="8" cy="3.6" rx="5.1" ry="1.9"/><path d="M2.9 3.6v8.8c0 1.05 2.28 1.9 5.1 1.9s5.1-.85 5.1-1.9V3.6"/><path d="M2.9 8c0 1.05 2.28 1.9 5.1 1.9s5.1-.85 5.1-1.9"/></svg>'
  // token 用量格式化（dsh「用量 69.4K tok」同款）：≥1e6 → M、≥1e3 → K 一位小数，否则原值。
  function fmtUsage(n) {
    const v = Number(n)
    if (!(v > 0)) return ''
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
    return String(v)
  }
  // 回复时刻（本地中文单位格式 `YYYY 年 M 月 D 日 HH : MM`；数字前导零一律省略，如 4 月 3 日 9 : 5。
  // 2026-10-04 用户定「写成 YYYY 年 MM 月 DD 日 HH : SS，数字为 02 时仅显示 2」= 时分精度 + 去前导零）。
  function fmtClock(ts) {
    const n = Number(ts)
    if (!(n > 0)) return ''
    const d = new Date(n)
    if (Number.isNaN(d.getTime())) return ''
    return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${d.getHours()} : ${d.getMinutes()}`
  }
  // 精确 token 计数（弹出面板用，dsh 同款千分位：69,353）。
  function fmtTok(n) {
    const v = Number(n)
    return Number.isFinite(v) && v > 0 ? v.toLocaleString('en-US') : '0'
  }
  // 「用量」按钮 + 点击弹出的明细面板（2026-10-04 还原 dsh 回复底部：按钮点开显示本轮 token 明细）。
  // 数据源 = DisplayMessage.turnUsage（后端按回合收口的合计）+ DisplayMessage.model；提供方由 modelProviderOf(模型名) 派生。
  // 面板置于 .msg-actions 内 → messageCopyText 剔除 `.msg-actions` 时一并排除，不污染复制文本。
  function usageButtonHtml(usage, model) {
    const d = usage || {}
    const input = Number(d.input) || 0
    const cacheRead = Number(d.cacheRead) || 0
    const cacheWrite = Number(d.cacheWrite) || 0
    const output = Number(d.output) || 0
    const total = input + cacheRead + cacheWrite + output
    const denom = input + cacheRead + cacheWrite
    const hit = denom > 0 ? (cacheRead / denom) * 100 : 0
    const who = model ? `${modelProviderOf({ k: 'model', v: model })}/${model}` : ''
    const rows = [
      ['提供方 / 模型', who || '—'],
      ['缓存命中', hit.toFixed(1) + '%'],
      ['未缓存输入', fmtTok(input) + ' tok'],
      ['缓存读取', fmtTok(cacheRead) + ' tok'],
      ['缓存写入', fmtTok(cacheWrite) + ' tok'],
      ['输出', fmtTok(output) + ' tok'],
    ]
      .map(([k, v]) => `<div class="up-row"><span class="up-k">${k}</span><span class="up-v">${esc(v)}</span></div>`)
      .join('')
    // 按钮与面板包进 .usage-wrap（position:relative）→ 面板左缘对齐「用量」按钮左缘（dsh 同款锚点，
    // 2026-10-04；此前挂在 .msg-actions 上 left:0 是复制钮左缘＝偏左）。
    return (
      `<span class="usage-wrap">` +
      `<button class="msg-usage" type="button" aria-expanded="false" title="本轮用量明细">${ICON_USAGE}<span class="mu-txt">用量 ${fmtUsage(total)} tok</span></button>` +
      `<div class="usage-pop" hidden><div class="up-head"><span class="up-title">${ICON_USAGE}本轮用量</span><span class="up-total">${fmtTok(total)} tok</span></div><div class="up-rows">${rows}</div></div>` +
      `</span>`
    )
  }
  // 剪贴板写入（DSH ui-primitives clipboard.ts 移植）：异步 Clipboard API 优先，
  // 非安全上下文（http 局域网 / 无 clipboard）回退 textarea + execCommand('copy')
  async function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(text); return true } catch { return false }
    }
    const exec = typeof document.execCommand === 'function' ? document.execCommand.bind(document) : undefined
    if (!exec) return false
    const el = document.createElement('textarea')
    el.value = text
    el.setAttribute('readonly', '')
    el.style.position = 'fixed'
    el.style.left = '-9999px'
    document.body.appendChild(el)
    el.select()
    try { return exec('copy') } catch { return false } finally { el.remove() }
  }

