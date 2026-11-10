// 数学公式**文法唯一真源**（2026-10-15 待办 11 统一）：三条渲染链共用本层的分隔符文法与行内合法性判据，
// 任何一条链都不得自带第二套正则——否则同一条消息在消息流与编辑器里渲染结果会分叉。
// 三条消费链：
//   ① 消息流 core/markdown.js extractMath（遮罩代码 → 抽公式 → esc → mdInline 末尾 restoreMath）；
//   ② work md 编辑区 @floria/cm6 包内 kernel/cm-math.js 的 StateField；
//   ③ 底栏 composer（同一扩展，两宿主共用）。
// 覆盖形态：`$…$` 行内、`$$…$$` 块级、`\(…\)` 行内、`\[…\]` 块级。
// ```math 围栏与 `` `$…$` `` 代码内写法是 codemirror-live-markdown 既有约定（不动、非本层职责）。
/* @module core/math-spec.js */
  // 源串（不带 flag）：消费方各自 new RegExp(src, 'g') —— 共享同一个 RegExp 对象会踩 lastIndex 状态。
  const MATH_SRC_BLOCK_DOLLAR = '\\$\\$([\\s\\S]+?)\\$\\$'   // $$…$$（可跨行）
  const MATH_SRC_BLOCK_BRACKET = '\\\\\\[([\\s\\S]+?)\\\\\\]' // \[…\]（可跨行）
  const MATH_SRC_INLINE_PAREN = '\\\\\\(([\\s\\S]+?)\\\\\\)'  // \(…\)（行内）
  const MATH_SRC_INLINE_DOLLAR = '\\$([^$\\n]+?)\\$'          // $…$（单行）
  // 行内 $…$ 假阳性防护：首尾不留空白；数字开头仅在正文无 LaTeX 结构时视为货币（"$5 and $10"）。
  // 有反斜杠命令 / ^ / _ / {} 的数字开头（如 "$200\text{-}800^\circ/\mathrm{s}$"）仍按公式渲染。
  const mathInlineOk = (body) => !/^\s/.test(body) && !/\s$/.test(body) &&
    !(/^\d/.test(body) && !/[\\^_{}]/.test(body))
  // 抽取顺序契约：块级先于行内（否则 $$ 被 $ 抢占）。消费方按此序依次 replace。
  const MATH_EXTRACT_ORDER = ['blockDollar', 'blockBracket', 'inlineParen', 'inlineDollar']

export { MATH_EXTRACT_ORDER, MATH_SRC_BLOCK_BRACKET, MATH_SRC_BLOCK_DOLLAR, MATH_SRC_INLINE_DOLLAR, MATH_SRC_INLINE_PAREN, mathInlineOk }
