/**
 * 动态团队配置的读取、校验、保存与运行时解析。
 *
 * 数据源：VS Code 设置
 *   aiChatGroup.providers  -> ProviderDefinition[]
 *   aiChatGroup.roles      -> RoleDefinition[]
 *   aiChatGroup.scheduling -> 'serial' | 'parallel' | 'lead-then-parallel'
 *   ...
 *
 * API Key 只保存在 SecretStorage：
 *   aiChatGroup.apiKey.<providerId>
 * 不写入 settings.json，也永远不会下发到 Webview。
 */

import * as vscode from 'vscode';

import { MissingApiKeyError, type ProviderConfig } from './aiClient';
import {
  CHAT_MODES,
  DEFAULT_CHAT_MODE,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_HISTORY_MESSAGES,
  DEFAULT_PROVIDERS,
  DEFAULT_ROLES,
  DEFAULT_SCHEDULING,
  DEFAULT_SUMMARY_ROLE_ID,
  ROLE_COLORS,
  colorForIndex,
  emojiForIndex,
} from './defaults';
import type {
  ChatMode,
  ProviderDefinition,
  ProviderSnapshot,
  RoleColor,
  RoleDefinition,
  SchedulingMode,
  TeamSettings,
  TeamSettingsSnapshot,
} from './types';

export const API_KEY_SECRET_PREFIX = 'aiChatGroup.apiKey.';

const ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const SCHEDULING_MODES: readonly SchedulingMode[] = ['serial', 'parallel', 'lead-then-parallel'];

/** 团队成员配置有误（比如引用了不存在的 Provider），UI 应引导用户打开团队设置 */
export class TeamConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamConfigError';
  }
}

/** 读取任意 aiChatGroup.* 配置项 */
export function getConfig<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('aiChatGroup').get<T>(key, fallback);
}

// -----------------------------------------------------------------------------
// 读取（容错模式：尽量保留用户数据，坏字段留空，交给使用方/设置面板提示）
// -----------------------------------------------------------------------------

export function readProviders(): ProviderDefinition[] {
  const raw = getConfig<unknown>('providers', DEFAULT_PROVIDERS);
  if (!Array.isArray(raw)) {
    return cloneProviders(DEFAULT_PROVIDERS);
  }

  const result: ProviderDefinition[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const id = readString(record.id);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);

    result.push({
      id,
      name: readString(record.name) || id,
      baseUrl: readString(record.baseUrl),
      models: normalizeModelList(record.models),
    });
  }

  return result;
}

export function readRoles(): RoleDefinition[] {
  const raw = getConfig<unknown>('roles', DEFAULT_ROLES);
  if (!Array.isArray(raw)) {
    return cloneRoles(DEFAULT_ROLES);
  }

  const result: RoleDefinition[] = [];
  const seen = new Set<string>();

  raw.forEach((item, index) => {
    const record = asRecord(item);
    if (!record) {
      return;
    }
    const id = readString(record.id);
    if (!id || seen.has(id)) {
      return;
    }
    seen.add(id);

    const color = readRoleColor(record.color) ?? colorForIndex(index);
    const temperature = readRoleTemperature(record.temperature);

    result.push({
      id,
      name: readString(record.name) || `角色 ${index + 1}`,
      prompt: readString(record.prompt),
      providerId: readString(record.providerId),
      model: readString(record.model),
      // 未显式配置时跟随全局 temperature（全局默认 0.7）
      temperature: temperature ?? readTemperature(),
      emoji: readString(record.emoji) || emojiForIndex(index),
      color,
      enabled: record.enabled !== false,
    });
  });

  return result;
}

export function readChatMode(): ChatMode {
  const raw = readString(getConfig<unknown>('chatMode', DEFAULT_CHAT_MODE));
  return (CHAT_MODES as readonly string[]).includes(raw)
    ? (raw as ChatMode)
    : DEFAULT_CHAT_MODE;
}

export function readScheduling(): SchedulingMode {
  const raw = readString(getConfig<unknown>('scheduling', DEFAULT_SCHEDULING));
  return (SCHEDULING_MODES as readonly string[]).includes(raw)
    ? (raw as SchedulingMode)
    : DEFAULT_SCHEDULING;
}

export function readSummaryRoleId(): string {
  return readString(getConfig<unknown>('summaryRoleId', DEFAULT_SUMMARY_ROLE_ID));
}

export function readMaxConcurrency(): number {
  const raw = getConfig<unknown>('maxConcurrency', DEFAULT_MAX_CONCURRENCY);
  const value = typeof raw === 'number' ? Math.floor(raw) : Number.NaN;
  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_CONCURRENCY;
  }
  return Math.min(10, Math.max(1, value));
}

export function readDemoMode(): boolean {
  return getConfig<boolean>('demoMode', false);
}

/** 是否允许冷场心跳（默认关闭，避免自动消耗 Token） */
export function readEnableHeartbeat(): boolean {
  return getConfig<boolean>('enableHeartbeat', false);
}

/** 全局默认采样温度，0 ~ 2；角色未配置 temperature 时使用 */
/** 可选的隐形裁判模型 ID；留空则自动从首个启用 Provider 的模型列表中挑选 */
export function readJudgeModelId(): string {
  return readString(getConfig<unknown>('judgeModelId', ''));
}

export interface JudgeTarget {
  readonly provider: ProviderConfig;
  readonly model: string;
}

/**
 * 解析隐形裁判使用的 Provider + 模型。
 * Provider 取当前团队第一个启用角色绑定的 Provider；没有 Key 或模型时返回 undefined。
 */
export async function resolveJudgeTarget(
  context: vscode.ExtensionContext,
): Promise<JudgeTarget | undefined> {
  const firstRole = readRoles().find((role) => role.enabled);
  if (!firstRole) {
    return undefined;
  }

  const provider = readProviders().find((item) => item.id === firstRole.providerId);
  if (!provider || !isHttpUrl(provider.baseUrl)) {
    return undefined;
  }

  const key = (await context.secrets.get(API_KEY_SECRET_PREFIX + provider.id))?.trim();
  if (!key) {
    return undefined;
  }

  const model = readJudgeModelId() || pickCheapestModel(provider.models);
  if (!model) {
    return undefined;
  }

  return {
    provider: {
      id: provider.id,
      label: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: key,
    },
    model,
  };
}

export function readTemperature(): number {
  const raw = getConfig<unknown>('temperature', 0.7);
  const value = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isFinite(value)) {
    return 0.7;
  }
  return Math.min(2, Math.max(0, value));
}

/** 发送给模型时保留的历史消息条数（超出部分自动压缩成会议摘要） */
export function readMaxHistoryMessages(): number {
  const raw = getConfig<unknown>('maxHistoryMessages', DEFAULT_MAX_HISTORY_MESSAGES);
  const value = typeof raw === 'number' ? Math.floor(raw) : Number.NaN;
  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_HISTORY_MESSAGES;
  }
  return Math.min(200, Math.max(2, value));
}

/** 读取团队设置（不含 Key 状态） */
export function readTeamSettings(): TeamSettings {
  return {
    providers: readProviders(),
    roles: readRoles(),
    scheduling: readScheduling(),
    chatMode: readChatMode(),
    summaryRoleId: readSummaryRoleId(),
    maxConcurrency: readMaxConcurrency(),
    demoMode: readDemoMode(),
    enableHeartbeat: readEnableHeartbeat(),
  };
}

// -----------------------------------------------------------------------------
// 设置面板：快照 / 校验 / 保存
// -----------------------------------------------------------------------------

/** 构建设置面板需要的快照，并逐个读取 SecretStorage 判断 Key 是否已配置 */
export async function buildConfigSnapshot(
  context: vscode.ExtensionContext,
): Promise<TeamSettingsSnapshot> {
  const providers = readProviders();
  const snapshotProviders: ProviderSnapshot[] = [];
  for (const provider of providers) {
    snapshotProviders.push({
      ...provider,
      models: [...provider.models],
      hasKey: await hasApiKey(context, provider.id),
    });
  }

  return {
    providers: snapshotProviders,
    roles: readRoles(),
    scheduling: readScheduling(),
    chatMode: readChatMode(),
    summaryRoleId: readSummaryRoleId(),
    maxConcurrency: readMaxConcurrency(),
    demoMode: readDemoMode(),
    enableHeartbeat: readEnableHeartbeat(),
  };
}

export type TeamSettingsValidation =
  | { ok: true; settings: TeamSettings }
  | { ok: false; errors: string[] };

/**
 * 严格校验设置面板提交的数据。
 * 不信任 Webview：ID、URL、引用关系、并发数都重新检查。
 */
export function validateTeamSettings(input: unknown): TeamSettingsValidation {
  const errors: string[] = [];
  const record = asRecord(input);
  if (!record) {
    return { ok: false, errors: ['设置数据格式不正确。'] };
  }

  const providers: ProviderDefinition[] = [];
  const providerIds = new Set<string>();

  if (!Array.isArray(record.providers)) {
    errors.push('providers 必须是数组。');
  } else {
    record.providers.forEach((item, index) => {
      const providerRecord = asRecord(item);
      if (!providerRecord) {
        errors.push(`提供商 #${index + 1} 格式不正确。`);
        return;
      }

      const id = readString(providerRecord.id);
      const name = readString(providerRecord.name);
      const baseUrl = readString(providerRecord.baseUrl);
      const models = normalizeModelList(providerRecord.models);

      if (!id) {
        errors.push(`提供商 #${index + 1} 缺少 ID。`);
      } else if (!ID_PATTERN.test(id)) {
        errors.push(`提供商「${id}」的 ID 只能包含字母、数字、点、下划线和短横线。`);
      } else if (providerIds.has(id)) {
        errors.push(`提供商 ID「${id}」重复。`);
      } else {
        providerIds.add(id);
      }

      if (!name) {
        errors.push(`提供商「${id || index + 1}」缺少名称。`);
      }
      if (!baseUrl) {
        errors.push(`提供商「${name || id || index + 1}」缺少 Base URL。`);
      } else if (!isHttpUrl(baseUrl)) {
        errors.push(`提供商「${name || id}」的 Base URL 必须是 http/https 地址。`);
      }

      providers.push({ id, name, baseUrl, models });
    });
  }

  const roles: RoleDefinition[] = [];
  const roleIds = new Set<string>();

  if (!Array.isArray(record.roles)) {
    errors.push('roles 必须是数组。');
  } else {
    record.roles.forEach((item, index) => {
      const roleRecord = asRecord(item);
      if (!roleRecord) {
        errors.push(`角色 #${index + 1} 格式不正确。`);
        return;
      }

      const id = readString(roleRecord.id);
      const name = readString(roleRecord.name);
      const prompt = readString(roleRecord.prompt);
      const providerId = readString(roleRecord.providerId);
      const model = readString(roleRecord.model);
      const emoji = readString(roleRecord.emoji) || emojiForIndex(index);
      const color = readRoleColor(roleRecord.color) ?? colorForIndex(index);
      const enabled = roleRecord.enabled !== false;
      const label = name || id || `#${index + 1}`;

      if (!id) {
        errors.push(`角色 #${index + 1} 缺少 ID。`);
      } else if (!ID_PATTERN.test(id)) {
        errors.push(`角色「${label}」的 ID 只能包含字母、数字、点、下划线和短横线。`);
      } else if (roleIds.has(id)) {
        errors.push(`角色 ID「${id}」重复。`);
      } else {
        roleIds.add(id);
      }

      if (!name) {
        errors.push(`角色 #${index + 1} 缺少名称。`);
      }
      if (!prompt) {
        errors.push(`角色「${label}」缺少 System Prompt。`);
      }
      if (!providerId) {
        errors.push(`角色「${label}」没有绑定提供商。`);
      } else if (!providerIds.has(providerId)) {
        errors.push(`角色「${label}」绑定的提供商「${providerId}」不存在。`);
      }
      if (!model) {
        errors.push(`角色「${label}」没有选择模型。`);
      }

      const temperatureRaw = roleRecord.temperature;
      let roleTemperature = 0.7;
      if (temperatureRaw !== undefined) {
        if (
          typeof temperatureRaw !== 'number' ||
          !Number.isFinite(temperatureRaw) ||
          temperatureRaw < 0 ||
          temperatureRaw > 2
        ) {
          errors.push(`角色「${label}」的 temperature 必须是 0 ~ 2 的数字。`);
        } else {
          roleTemperature = temperatureRaw;
        }
      }

      roles.push({
        id,
        name,
        prompt,
        providerId,
        model,
        temperature: roleTemperature,
        emoji,
        color,
        enabled,
      });
    });
  }

  // 允许团队为空：用户可以先清空团队，聊天面板会提示“请添加角色”。
  // 角色非空时，每个角色的 providerId 必须能在 providers 中找到（上面已逐条校验）。

  const schedulingRaw = readString(record.scheduling);
  if (!(SCHEDULING_MODES as readonly string[]).includes(schedulingRaw)) {
    errors.push('调度模式不合法。');
  }
  const scheduling = (SCHEDULING_MODES as readonly string[]).includes(schedulingRaw)
    ? (schedulingRaw as SchedulingMode)
    : DEFAULT_SCHEDULING;

  const chatModeRaw = readString(record.chatMode) || DEFAULT_CHAT_MODE;
  if (!(CHAT_MODES as readonly string[]).includes(chatModeRaw)) {
    errors.push('聊天模式不合法。');
  }
  const chatMode = (CHAT_MODES as readonly string[]).includes(chatModeRaw)
    ? (chatModeRaw as ChatMode)
    : DEFAULT_CHAT_MODE;

  const summaryRoleId = readString(record.summaryRoleId);
  // casual 模式不使用汇总角色，允许暂存一个无效值；切回 work 时再校验
  if (chatMode === 'work' && summaryRoleId) {
    const summaryRole = roles.find((role) => role.id === summaryRoleId);
    if (!summaryRole) {
      errors.push('汇总角色不存在。');
    } else if (!summaryRole.enabled) {
      errors.push(`汇总角色「${summaryRole.name}」处于禁用状态。`);
    }
  }

  const concurrencyRaw = record.maxConcurrency;
  const concurrency =
    typeof concurrencyRaw === 'number' ? Math.floor(concurrencyRaw) : Number.NaN;
  if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 10) {
    errors.push('最大并发数必须是 1 ~ 10 的整数。');
  }

  const maxConcurrency = Number.isFinite(concurrency)
    ? Math.min(10, Math.max(1, concurrency))
    : DEFAULT_MAX_CONCURRENCY;

  const demoMode = record.demoMode === true;
  const enableHeartbeat = record.enableHeartbeat === true;

  if (errors.length > 0) {
    return { ok: false, errors: uniqueStrings(errors) };
  }

  return {
    ok: true,
    settings: {
      providers,
      roles,
      scheduling,
      chatMode,
      summaryRoleId,
      maxConcurrency,
      demoMode,
      enableHeartbeat,
    },
  };
}

/** 保存到用户级 settings.json（VS Code Global） */
export async function saveTeamSettings(settings: TeamSettings): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('aiChatGroup');
  const target = vscode.ConfigurationTarget.Global;

  await configuration.update('providers', settings.providers, target);
  await configuration.update('roles', settings.roles, target);
  await configuration.update('scheduling', settings.scheduling, target);
  await configuration.update('chatMode', settings.chatMode, target);
  await configuration.update('summaryRoleId', settings.summaryRoleId, target);
  await configuration.update('maxConcurrency', settings.maxConcurrency, target);
  await configuration.update('demoMode', settings.demoMode, target);
  await configuration.update('enableHeartbeat', settings.enableHeartbeat, target);
}

// -----------------------------------------------------------------------------
// 运行时解析
// -----------------------------------------------------------------------------

export async function hasApiKey(
  context: vscode.ExtensionContext,
  providerId: string,
): Promise<boolean> {
  const key = await context.secrets.get(API_KEY_SECRET_PREFIX + providerId);
  return Boolean(key && key.trim());
}

/**
 * 把 Role 解析成可发起请求的 Provider（含 Key）+ 模型。
 * 配置错误抛 TeamConfigError；缺 Key 抛 MissingApiKeyError（UI 可给出精准动作）。
 */
export async function prepareRoleTarget(
  context: vscode.ExtensionContext,
  role: RoleDefinition,
): Promise<{ provider: ProviderConfig; model: string; temperature: number }> {
  if (!role.enabled) {
    throw new TeamConfigError(`角色「${role.name}」已被禁用。`);
  }
  if (!role.prompt.trim()) {
    throw new TeamConfigError(`角色「${role.name}」还没有配置 System Prompt。`);
  }
  if (!role.model.trim()) {
    throw new TeamConfigError(`角色「${role.name}」还没有选择模型。`);
  }

  const provider = readProviders().find((item) => item.id === role.providerId);
  if (!provider) {
    throw new TeamConfigError(
      `角色「${role.name}」绑定的提供商「${role.providerId || '（空）'}」不存在，请检查团队设置。`,
    );
  }
  if (!provider.baseUrl) {
    throw new TeamConfigError(`提供商「${provider.name}」缺少 Base URL。`);
  }
  if (!isHttpUrl(provider.baseUrl)) {
    throw new TeamConfigError(`提供商「${provider.name}」的 Base URL 不是合法的 http/https 地址。`);
  }

  const key = (await context.secrets.get(API_KEY_SECRET_PREFIX + provider.id))?.trim();
  if (!key) {
    throw new MissingApiKeyError(provider.id, provider.name);
  }

  return {
    provider: {
      id: provider.id,
      label: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: key,
    },
    model: role.model.trim(),
    temperature: role.temperature ?? readTemperature(),
  };
}


// -----------------------------------------------------------------------------
// 工具
// -----------------------------------------------------------------------------

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/**
 * 没有配置 judgeModelId 时的启发式“最便宜模型”：
 * 优先 flash/mini/lite/small，排后 plus/pro/max/reasoner 等。
 * 真正的价格由 Provider 决定，用户可以用 judgeModelId 精确覆盖。
 */
function pickCheapestModel(models: readonly string[]): string {
  const candidates = models.map((model) => model.trim()).filter(Boolean);
  if (candidates.length === 0) {
    return '';
  }

  let best = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;

  for (const model of candidates) {
    let score = 10;
    if (/flash/i.test(model)) {
      score -= 8;
    } else if (/mini|lite/i.test(model)) {
      score -= 7;
    } else if (/small|air|haiku/i.test(model)) {
      score -= 6;
    } else if (/\b8k\b/i.test(model)) {
      score -= 4;
    }

    if (/plus|pro|max|reasoner|thinking|128k|32k|vision/i.test(model)) {
      score += 20;
    }

    if (score < bestScore) {
      best = model;
      bestScore = score;
    }
  }

  return best;
}

function readRoleTemperature(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < 0 || value > 2) {
    return undefined;
  }
  return value;
}

function readRoleColor(value: unknown): RoleColor | undefined {
  const color = readString(value);
  return (ROLE_COLORS as readonly string[]).includes(color)
    ? (color as RoleColor)
    : undefined;
}

function normalizeModelList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const model = readString(item);
    if (model && !seen.has(model)) {
      seen.add(model);
      result.push(model);
    }
  }
  return result.slice(0, 100);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function cloneProviders(list: ProviderDefinition[]): ProviderDefinition[] {
  return list.map((provider) => ({ ...provider, models: [...provider.models] }));
}

function cloneRoles(list: RoleDefinition[]): RoleDefinition[] {
  return list.map((role) => ({ ...role }));
}
