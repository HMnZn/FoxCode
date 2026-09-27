/**
 * 字符级的 token 估算。
 *
 * 这是宿主侧估算公式的**镜像**：`packages/fox_agent_core/src/harness/compaction.py:77-105`
 * 的 `estimate_tokens()`（ASCII 约 4 字符 1 token，非 ASCII 逐字符 1 token —— 中文就是
 * 差不多一个字一个 token）。前端只拿它做「正在流式输出时的实时量级」，权威数字永远
 * 是宿主回传的 usage；两边公式保持一致，才不会出现「估算值比随后到达的权威值大很多」
 * 这种让人怀疑数字跳动的现象。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let nonAscii = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 127) nonAscii += 1
  }
  const ascii = text.length - nonAscii
  return Math.max(1, Math.floor((ascii + 3) / 4) + nonAscii)
}
