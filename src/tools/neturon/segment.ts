/**
 * 分词与门槛 — 对照 Python 基线 core/retriever.py（_split_query/词表）+ core/trigger.py（followup 门槛）
 *
 * 分词实现：Intl.Segmenter（ICU 词典切分，零原生依赖）替代 jieba——
 * kw 分数仅在查询时使用，无落盘兼容性问题。停用词/通用词表 1:1 保留。
 */

export function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text)
}

// 停用词（retriever.py _STOP_WORDS）
const STOP_WORDS = new Set([
  '用户', '我', '你', '他', '她', '的', '了', '是', '在', '不', '和', '就', '都',
])

// 爬虫技能库通用词（retriever.py _GENERIC_TOKENS）：认知层匹配只统计非通用领域词
export const GENERIC_TOKENS = new Set([
  '下载', '爬取', '抓取', '采集', '提取', '导入', '导出', '录入', '批量', '全部', '所有', '原图',
  '预览', '转码', '怎么', '什么', '如何', '哪些', '哪个', '需要', '是否', '可以', '处理', '工具',
  '脚本', '网页', '页面', '网站', '链接', '视频', '图片', '照片', '媒体', '内容', '正文', '简介',
  '头像', '背景', '评论', '检索', '上传', '保存', '记录', '方法', '流程', '登录', '作品', '详细',
])

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

/** 中文/混合文本切词：ICU 词典切分 + 过滤标点空白与停用词 */
export function segmentChinese(text: string): string[] {
  const out: string[] = []
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (!isWordLike) continue
    const w = segment.trim()
    if (!w || STOP_WORDS.has(w)) continue
    out.push(w)
  }
  return out
}

/**
 * 查询分词（_split_query 移植）：中文段逐词，空格分隔的显式关键词追加保留；去重小写。
 */
export function splitQuery(queryText: string): string[] {
  const keywords: string[] = []
  const spaceParts = queryText.split(/\s+/).filter(p => p.trim())

  for (const part of spaceParts) {
    if (hasChinese(part)) {
      keywords.push(...segmentChinese(part))
    } else {
      keywords.push(part)
    }
  }

  const seen = new Set<string>()
  const result: string[] = []
  for (const kw of keywords) {
    const lower = kw.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    result.push(lower)
  }
  return result
}

// ── followup 门槛（trigger.py _match_followup；引擎内检索门槛，拦后续追问型查询） ──

// 明确非后续的查询模式
const NON_FOLLOWUP_KEYWORDS = [
  '天气', '编程', '代码', 'bug', '报错', 'error',
  '你好', '早上好', '晚安', '你是谁', '能做什么',
  '帮助', '谢谢', '再见', '拜拜', 'Python', 'java',
]

const PRONOUNS = /(她|他|你|我|它|他们|她们|你们|我们)/

const FOLLOWUP_WORDS = new Set([
  '然后', '之后', '后来', '还有', '继续', '再说', '所以', '但是',
  '不过', '为什么', '真的吗', '详细', '具体', '比如', '例如',
])

export interface FollowupHit {
  tier: 'followup'
  confidence: number
  reason: string
}

const FOLLOWUP_CONFIDENCE = 0.35
const SHORT_QUERY_CONFIDENCE = 0.3
const FOLLOWUP_MAX_LEN = 15
const SHORT_QUERY_MAX_LEN = 4

/** 后续追问检测：返回 null=非 followup（放行检索），返回命中=引擎门槛拦下 */
export function matchFollowup(query: string): FollowupHit | null {
  const q = query.trim()

  for (const kw of NON_FOLLOWUP_KEYWORDS) {
    if (q.includes(kw)) return null
  }

  // 查询含代词 + 中等长度 → 可能是后续
  if (q.length <= FOLLOWUP_MAX_LEN && PRONOUNS.test(q)) {
    return {
      tier: 'followup',
      confidence: FOLLOWUP_CONFIDENCE,
      reason: '查询含代词，可能是后续追问',
    }
  }

  // 极短查询且含常见后续词
  if (q.length <= SHORT_QUERY_MAX_LEN) {
    const words = [...segmentChinese(q)]
    if (words.some(w => FOLLOWUP_WORDS.has(w))) {
      return {
        tier: 'followup',
        confidence: SHORT_QUERY_CONFIDENCE,
        reason: '极短查询，可能是后续追问',
      }
    }
  }

  return null
}
