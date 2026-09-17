/** Deterministic text-only request classification for the first policy revision. */

import type { ReasoningTaskClass } from './types.ts'

const SIMPLE = new RegExp([
  String.raw`\b(pwd|ls|dir|list files?|file exists?|path check|metadata|simple grep|simple search|routing|housekeeping|session title)\b`,
  String.raw`路径|文件是否存在|元数据|简单搜索|工具路由|会话标题`,
].join('|'), 'u')
const MEDIUM = new RegExp([
  String.raw`\b(short summary|simple summary|simple explanation|simple rewrite|basic classification|single[ -]?file understanding|non-?critical support)\b`,
  String.raw`普通短总结|简单文本解释|简单格式改写|基础分类|简单单文件理解|非关键辅助分析`,
].join('|'), 'u')
const COMPLEX = new RegExp([
  String.raw`\b(code|coding|debug|bug|sql|shell|automation|multi[ -]?file|architecture|refactor|runtime|backend|agent|dsh|plugin|amazon|advertis|listing|business|analysis|compare|decision|plan|multi[ -]?step|multi[ -]?constraint|long task|root cause)\b`,
  String.raw`代码|开发|调试|多文件|架构|重构|运行时|后端|插件|广告|亚马逊|运营|经营|分析|比较|决策|规划|多步骤|多约束|长任务|归因`,
].join('|'), 'u')
const LONG_OUTPUT = /\b(long|detailed|comprehensive|full report|exhaustive)\b|长输出|详细|完整报告|全面/u

/** Classify only clear low/medium exceptions; unknown user work remains complex and therefore xhigh-first. */
export function classifyReasoningTask(text: string): ReasoningTaskClass {
  if (LONG_OUTPUT.test(text)) return 'long-output'
  if (COMPLEX.test(text)) return 'complex'
  if (SIMPLE.test(text)) return 'simple'
  if (MEDIUM.test(text)) return 'normal'
  return 'complex'
}
