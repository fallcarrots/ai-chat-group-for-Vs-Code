/**
 * 全动态多 Agent 群聊的核心类型。
 *
 * 设计原则：
 *   - Provider 只描述“怎么连”（名称、BaseURL、可用模型列表）；
 *   - Role 只描述“是谁、负责什么、用哪个模型”；
 *   - 二者通过 providerId 关联，任意数量、任意顺序。
 */

/** 气泡/头像可用颜色（映射到 media/style.css 里的 VS Code 主题变量） */
export type RoleColor =
  | 'blue'
  | 'purple'
  | 'green'
  | 'orange'
  | 'red'
  | 'pink'
  | 'cyan'
  | 'yellow';

/** 群聊调度模式 */
export type SchedulingMode = 'serial' | 'parallel' | 'lead-then-parallel';

/** 群聊模式：工作汇报 / 闲聊接龙 */
export type ChatMode = 'work' | 'casual' | 'free';

/** 用户可配置的 OpenAI 兼容提供商 */
export interface ProviderDefinition {
  id: string;
  name: string;
  baseUrl: string;
  /** 用于角色表单里的模型 ID 建议，不限制角色手工输入其他模型 */
  models: string[];
}

/** 用户可配置的 AI 角色 */
export interface RoleDefinition {
  id: string;
  name: string;
  /** system prompt，每次请求都会作为 messages[0] 发送 */
  prompt: string;
  providerId: string;
  model: string;
  /** 该角色的采样温度，0 ~ 2；不填时跟随全局 aiChatGroup.temperature */
  temperature?: number;
  /** 头像 emoji */
  emoji: string;
  color: RoleColor;
  enabled: boolean;
}

/** 团队级设置（可写入 settings.json / 团队设置面板） */
export interface TeamSettings {
  providers: ProviderDefinition[];
  roles: RoleDefinition[];
  scheduling: SchedulingMode;
  chatMode: ChatMode;
  /** 为空字符串表示不做最终汇总 */
  summaryRoleId: string;
  /** 并行模式的并发上限 */
  maxConcurrency: number;
  /** 免密钥演示模式 */
  demoMode: boolean;
  /** 冷场时是否允许 AI 主动发起话题（默认关闭） */
  enableHeartbeat: boolean;
}

/** 设置面板需要的快照：额外带上每个 Provider 是否已经存过 Key */
export interface ProviderSnapshot extends ProviderDefinition {
  hasKey: boolean;
}

export interface TeamSettingsSnapshot {
  providers: ProviderSnapshot[];
  roles: RoleDefinition[];
  scheduling: SchedulingMode;
  chatMode: ChatMode;
  summaryRoleId: string;
  maxConcurrency: number;
  demoMode: boolean;
  enableHeartbeat: boolean;
}
