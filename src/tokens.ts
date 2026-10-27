/**
 * 轻量 Token 估算。
 *
 * 只用于 UI 提示，不追求与具体模型 tokenizer 完全一致：
 *   - 汉字（含扩展 CJK）按 1 字 ≈ 1.5 token
 *   - 其他字符（英文、空格、标点、代码符号）按 4 字符 ≈ 1 token
 *   - 每条消息额外加 4 token 的角色/格式开销
 */

import type { ChatMessage, ToolDefinition } from './aiClient';

const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

export function estimateTextTokens(text: string): number {
  if (!text) {
    return 0;
  }
  const cjkCount = text.match(CJK_PATTERN)?.length ?? 0;
  const otherCount = Math.max(0, text.length - cjkCount);
  return Math.ceil(cjkCount * 1.5 + otherCount / 4);
}

export function estimateMessagesTokens(
  messages: ChatMessage[],
  tools: ToolDefinition[] = [],
): number {
  let total = tools.length > 0 ? estimateTextTokens(JSON.stringify(tools)) : 0;

  for (const message of messages) {
    total += estimateTextTokens(message.content) + 4;
    if (message.tool_calls && message.tool_calls.length > 0) {
      total += estimateTextTokens(JSON.stringify(message.tool_calls));
    }
  }

  return total;
}
