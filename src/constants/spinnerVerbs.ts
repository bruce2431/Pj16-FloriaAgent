import { getInitialSettings } from '../utils/settings/settings.js'

export function getSpinnerVerbs(): string[] {
  const settings = getInitialSettings()
  const config = settings.spinnerVerbs
  if (!config) {
    return SPINNER_VERBS
  }
  if (config.mode === 'replace') {
    return config.verbs.length > 0 ? config.verbs : SPINNER_VERBS
  }
  return [...SPINNER_VERBS, ...config.verbs]
}

// Spinner verbs for loading messages（渲染时统一追加「…」，条目不带省略号）。
// 平实口语，不强制「正在」开头；同一份表既是 CLI 等待台词，也经 spinner-state 上报给 web 状态行。
export const SPINNER_VERBS = [
  '看下这个',
  '先过一遍',
  '理一理',
  '翻一翻',
  '找一找',
  '对一下',
  '核一下',
  '再确认下',
  '想一下',
  '找找看',
  '试试看',
  '跑一下',
  '改一改',
  '补一下',
  '收个尾',
  '查一下',
  '顺一遍',
  '捋一下',
  '拆开看下',
  '合起来试试',
  '等一等',
  '马上好',
  '就差一点',
  '接着做',
  '往下走',
  '把这块做完',
  '处理一下',
  '看下细节',
  '对下结果',
  '把问题找出来',
  '再想想',
  '换个法子',
  '这条线找找',
  '先把坑填了',
  '把漏洞补上',
  '顺手修了',
  '把话说清楚',
  '量一下',
  '对齐一下',
  '理顺点',
  '慢慢来',
  '一点点弄',
  '快弄好了',
  '正在收尾',
  '正在核对',
  '正在跑最后一遍',
  '再看看',
  '再试一次',
  '把剩下的做完',
  '这就好',
]
