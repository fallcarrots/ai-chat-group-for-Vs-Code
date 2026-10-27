/**
 * 演示模式（aiChatGroup.demoMode = true）。
 *
 * 不发送任何网络请求，根据“当前角色 + 本轮已有发言”生成排版示例，
 * 用于在没有 API Key 或没有配置 Provider 时预览动态角色、颜色和流式效果。
 *
 * 注意：这里不参与真实调度，文本仅用于展示，不代表模型输出。
 */

import { createAbortError } from './aiClient';
import type { RoleDefinition } from './types';

export interface DemoContribution {
  role: RoleDefinition;
  text: string;
}

export interface DemoContext {
  requirement: string;
  /** 本轮已经完成的角色发言（串行/首位角色/汇总时使用） */
  contributions: DemoContribution[];
  /** normal = 普通发言；summary = 汇总发言；casual = 闲聊接龙；heartbeat = 主动开话题 */
  mode: 'normal' | 'summary' | 'casual' | 'heartbeat';
}

/** 按动态角色生成演示文本 */
export function buildDemoReply(role: RoleDefinition, context: DemoContext): string {
  if (context.mode === 'summary') {
    return buildSummary(role, context);
  }
  return context.contributions.length > 0
    ? buildFollowUp(role, context)
    : buildOpening(role, context);
}

/** 把演示文本按“每 3 个字符一块”推给 UI，模拟打字机效果 */
export async function streamDemoText(
  text: string,
  signal: AbortSignal,
  onDelta: (delta: string) => void,
): Promise<string> {
  const characters = Array.from(text);
  let full = '';

  for (let index = 0; index < characters.length; index += 3) {
    if (signal.aborted) {
      throw createAbortError();
    }
    const chunk = characters.slice(index, index + 3).join('');
    full += chunk;
    onDelta(chunk);
    await delay(18);
  }

  if (signal.aborted) {
    throw createAbortError();
  }
  return full;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildOpening(role: RoleDefinition, context: DemoContext): string {
  const short = shorten(context.requirement, 80);
  let codeBlock = '';
  if (/后端|前端|开发|工程|测试|代码|架构/i.test(role.name)) {
    codeBlock = `

\`\`\`ts
// ${role.name} 视角的演示片段
const plan = await group.chat({
  role: '${role.name}',
  input: userRequirement,
  stream: true,
});
\`\`\``;
  }

  return `### ${role.name} 的初步分析（演示模式）

**需求**：${short}

- **理解**：把需求拆成可验证的输入、输出与边界条件；
- **方案**：先定义一个最小可运行版本，再补齐错误处理与测试；
- **风险**：接口超时、上下文变长、不同模型的输出格式差异。${codeBlock}

> 这是演示内容：开启真实模式后，这里会显示 ${role.name} 绑定的模型输出。`;
}

function buildFollowUp(role: RoleDefinition, context: DemoContext): string {
  const short = shorten(context.requirement, 60);
  const previous = context.contributions[context.contributions.length - 1];
  const snippet = shorten(previous.text.replace(/\s+/g, ' '), 60);

  return `### ${role.name} 的补充意见（演示模式）

已阅读 **${previous.role.name}** 的发言，需求是：${short}

- **补充**：${previous.role.name} 给出的方案可以落地，但需要明确失败时的降级路径；
- **风险**：并发调度时，后发角色看到的是旧上下文，需要按调度模式区分；
- **建议**：把 Provider 与 Role 解耦，角色只声明 \`providerId + model\`，替换模型不需要改提示词。

> 参考片段：${snippet}……（演示模式）`;
}

function buildSummary(role: RoleDefinition, context: DemoContext): string {
  const speakers = context.contributions.map((item) => item.role.name);
  const uniqueSpeakers = Array.from(new Set(speakers));
  const short = shorten(context.requirement, 80);

  const opinions =
    context.contributions.length > 0
      ? context.contributions
          .map((item) => {
            const snippet = shorten(item.text.replace(/\s+/g, ' '), 50);
            return `- **${item.role.name}**：${snippet}`;
          })
          .join('\n')
      : '- 本轮还没有其他角色的发言。';

  return `### 讨论汇总（演示模式）

**汇总者**：${role.name} · **参与角色**：${uniqueSpeakers.join('、') || '无'}
**原始需求**：${short}

### 各方观点
${opinions}

### 综合结论
1. 先交付可运行的最小版本，再逐步补齐可观测性与测试；
2. 角色只依赖 \`providerId + model\`，更换模型无需改 system prompt；
3. 并行模式下各角色只共享本轮之前的上下文，串行模式才逐条累积。

### 待确认
- 是否需要把对话记录持久化到 workspace？
- 是否需要为每个角色单独设置 temperature / maxTokens？

> 这是一条演示汇总，真实模式会由你指定的汇总角色生成。`;
}

function shorten(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}…`
    : normalized;
}
