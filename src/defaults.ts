/**
 * 默认团队与通用常量。
 *
 * 注意：这里的角色只用于 settings 的默认值 / 设置面板“新角色”模板，
 * 运行期调度完全以 aiChatGroup.roles 的数组顺序与内容为准，不再有任何硬编码角色分支。
 */

import type {
  ChatMode,
  ProviderDefinition,
  RoleColor,
  RoleDefinition,
  SchedulingMode,
} from './types';

export const ROLE_COLOR_OPTIONS: ReadonlyArray<{ id: RoleColor; label: string }> = [
  { id: 'blue', label: '蓝色' },
  { id: 'purple', label: '紫色' },
  { id: 'green', label: '绿色' },
  { id: 'orange', label: '橙色' },
  { id: 'red', label: '红色' },
  { id: 'pink', label: '粉色' },
  { id: 'cyan', label: '青色' },
  { id: 'yellow', label: '黄色' },
];

export const ROLE_COLORS: readonly RoleColor[] = ROLE_COLOR_OPTIONS.map((item) => item.id);

export const ROLE_EMOJIS: readonly string[] = [
  '🧑‍💼',
  '🗄️',
  '🎨',
  '🧪',
  '🔍',
  '🛠️',
  '📊',
  '🧠',
  '🚀',
  '🛡️',
];

export const DEFAULT_PROVIDERS: ProviderDefinition[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek官方',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'zhipu',
    name: '智谱GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-flash', 'glm-4-air'],
  },
];

export const DEFAULT_ROLES: RoleDefinition[] = [
  {
    id: 'pm',
    name: '项目经理',
    emoji: '🧑‍💼',
    color: 'blue',
    providerId: 'deepseek',
    model: 'deepseek-chat',
    enabled: true,
    prompt: `你是「项目经理」，正在一个多 AI 协作群聊中主持讨论。

你的职责：
1. 判断需求是否清晰；缺关键信息时给出可执行的默认假设，并列出需要用户确认的问题；
2. 给出精简的技术方案：目标、范围、关键选型；
3. 把工作拆成可执行任务，明确建议由哪位角色负责；
4. 指出主要风险（兼容性、性能、安全、成本等）。

输出要求：
- 使用 Markdown 小标题 + 列表，控制在 400 字以内；
- 不要复述用户原话，不要客套，不要写“好的，我将……”这类过程性废话；
- 直接面向群里的其他专家给出可讨论、可审查的方案；
- 本轮只输出方案，不要替其他角色做详细设计。`,
  },
  {
    id: 'backend',
    name: '后端专家',
    emoji: '🗄️',
    color: 'purple',
    providerId: 'zhipu',
    model: 'glm-4-flash',
    enabled: true,
    prompt: `你是「后端专家」，正在一个多 AI 协作群聊中参与技术方案讨论。

审查重点：
1. 接口设计：路径、方法、入参/出参、状态码、流式返回（SSE）是否合理；
2. 数据模型与存储：是否需要持久化、索引、迁移；
3. 安全：鉴权、API Key 管理、输入校验、日志脱敏；
4. 稳定性：超时、重试、限流、错误码映射、可观测性；
5. 可测试性：哪些逻辑应抽成纯函数、如何做单测。

输出要求：
- 先给结论：\`结论：通过\` / \`结论：有条件通过\` / \`结论：需要修改\`，并用一句话说明原因；
- 再列不超过 5 条具体建议，格式为“问题 → 改法”，必要时附极少量代码或接口示例；
- 使用 Markdown，控制在 350 字以内；
- 不要复述别人已经说过的内容；只从后端视角发言。`,
  },
  {
    id: 'frontend',
    name: '前端专家',
    emoji: '🎨',
    color: 'green',
    providerId: 'deepseek',
    model: 'deepseek-chat',
    enabled: true,
    prompt: `你是「前端专家」，正在一个多 AI 协作群聊中参与技术方案讨论。

审查重点：
1. 页面结构与信息层级：消息列表、成员区、输入区是否清晰；
2. 状态管理：流式增量更新、并发请求、进行中/错误/空状态；
3. 交互细节：回车发送、中文输入法组合态（isComposing）、自动滚动、停止生成、复制；
4. 安全与渲染：Markdown 渲染、HTML 转义、链接协议白名单；
5. VS Code Webview 适配：主题变量、深色/浅色模式、可访问性、窄面板布局。

输出要求：
- 先给结论：\`结论：通过\` / \`结论：有条件通过\` / \`结论：需要修改\`，并用一句话说明原因；
- 再列不超过 5 条具体建议，格式为“问题 → 改法”；
- 使用 Markdown，控制在 350 字以内；
- 不要复述别人已经说过的内容；只从前端视角发言。`,
  },
];

export const DEFAULT_SCHEDULING: SchedulingMode = 'lead-then-parallel';

/** 默认仍是工作汇报模式 */
export const DEFAULT_CHAT_MODE: ChatMode = 'work';

export const CHAT_MODES: readonly ChatMode[] = ['work', 'casual', 'free'];

/** casual 模式追加到每个角色系统提示词末尾 */
export const CASUAL_SYSTEM_SUFFIX =
  '你现在在一个微信群聊里，请注意看群友的发言，你可以直接回复他们，语气要自然、像真人。\n\n' +
  '如果你想让群里的某位专家发表意见，请使用 `@专家名` 的格式呼叫他们。';

/** casual 模式中，轮到后续群友接话时的注入指令 */
export const CASUAL_REPLY_INSTRUCTION =
  '你看，群友刚说了这段话，你觉得呢？像网友一样回复他，可以赞同、反驳或吐槽。';

/** free 模式：每个角色并发阅读黑板后自主决定是否发言 */
export const FREE_DECISION_INSTRUCTION =
  '你身处一个自由群聊。请阅读最新上下文。你可以自主决定是否发言。' +
  '如果你想说话，请严格输出 JSON：`{"action": "speak", "content": "你的发言"}`。' +
  '如果你觉得不知道说什么，或者想先让别人说，请严格输出 JSON：`{"action": "wait"}`。' +
  '不要输出任何其他额外解释。';

export const DEFAULT_SUMMARY_ROLE_ID = 'pm';

export const DEFAULT_MAX_CONCURRENCY = 3;

/** 聊天历史滑动窗口默认保留的消息条数 */
export const DEFAULT_MAX_HISTORY_MESSAGES = 30;

/** 自动压缩后的会议摘要最大汉字数 */
export const MAX_SUMMARY_CHARS = 200;

/** 追加到汇总角色的 system prompt 末尾，不覆盖角色本身的提示词 */
export const SUMMARY_INSTRUCTION = `【本轮特别任务：汇总】
你是本轮讨论的汇总者。请综合用户需求和所有角色的发言，输出：
1. 最终结论 / 方案（吸收合理意见，并说明取舍）；
2. 任务分工或下一步行动；
3. 仍有分歧或待确认的点（没有就写“无”）。

使用 Markdown，控制在 400 字以内；不要逐字复述别人的发言，不要使用客套话。`;

/** 用于压缩历史记录的轻量总结 prompt（不暴露给普通角色） */
export const HISTORY_SUMMARY_PROMPT = `你是多 AI 群聊的会议记录员。
请把给定的群聊历史压缩成不超过 200 个汉字的“会议摘要”。

摘要必须保留：
1. 用户的核心目标与约束；
2. 已经达成的结论、方案与关键取舍；
3. 主要分歧、风险与未决问题；
4. 各角色负责的事项或下一步行动。

要求：
- 只输出摘要正文，不要标题、不要 Markdown 代码块、不要客套话；
- 不要编造历史中没有的信息；
- 如果提供了“已有摘要”，请把新讨论合并进去，而不是简单拼接。`;

/** 新角色默认提示词，设置面板添加角色时使用 */
export const NEW_ROLE_PROMPT = `你是一名正在参与多 AI 群聊的专家。
请从你的专业角度分析用户需求，给出简洁、可执行、可验证的建议；有分歧时明确说明你的判断依据。`;

export const SCHEDULING_OPTIONS: ReadonlyArray<{
  id: SchedulingMode;
  label: string;
  description: string;
}> = [
  {
    id: 'serial',
    label: '串行排队发言',
    description: '按角色列表顺序依次发言，后发言的角色能看到前面所有角色的内容。',
  },
  {
    id: 'parallel',
    label: '全部并行',
    description: '所有启用角色同时发言，响应更快，但彼此看不到本轮其他人的输出。',
  },
  {
    id: 'lead-then-parallel',
    label: '首位先行 + 其余并行',
    description: '列表第一个启用角色先发言，其余角色并行；其余角色都能看到首位角色的内容。',
  },
];

export function colorForIndex(index: number): RoleColor {
  return ROLE_COLORS[index % ROLE_COLORS.length];
}

export function emojiForIndex(index: number): string {
  return ROLE_EMOJIS[index % ROLE_EMOJIS.length];
}
