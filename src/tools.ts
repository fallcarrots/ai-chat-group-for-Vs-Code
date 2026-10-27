/**
 * DSH 外包工具。
 *
 * 本文件不再直接访问文件系统。所有读取文件、搜索代码、执行命令的工作都交给
 * 本地 DeepSeek Harness Web 服务处理；插件只负责：
 *   1. 把自然语言任务交给 DSH；
 *   2. 轮询 DSH 状态；
 *   3. 把最终文本包装成 role='tool' 结果。
 */

import type { ToolCall, ToolDefinition } from './aiClient';

export const DELEGATE_TOOL_NAME = 'delegate_task_to_dsh';

/** 回传给模型的 DSH 输出上限，避免一次长报告把上下文撑爆 */
export const MAX_DELEGATE_OUTPUT_CHARS = 20_000;

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: DELEGATE_TOOL_NAME,
      description:
        '当你需要读取文件、搜索代码或执行命令时，请使用此工具，将你想做的事情用自然语言告诉 DSH',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description:
              '用自然语言描述要 DSH 完成的任务，包括目标、涉及路径/模块、约束和期望输出。',
          },
        },
        required: ['task'],
      },
    },
  },
];

export interface ToolCallPreview {
  task: string;
  /** 用于卡片标题的短任务描述 */
  taskSummary: string;
  startText: string;
}

export interface ToolExecutionResult {
  ok: boolean;
  toolName: string;
  /** 展示用短任务描述 */
  target: string;
  /** 完成后给 UI 折叠卡片的标题 */
  title: string;
  /** 展开后的预览内容 */
  preview: string;
  /** 作为 role='tool' 发给模型的内容 */
  modelContent: string;
  charCount?: number;
  truncated?: boolean;
}

export function describeToolCall(call: ToolCall): ToolCallPreview {
  const task = readTaskArgument(call);
  const summary = summarizeTask(task);
  return {
    task,
    taskSummary: summary,
    startText: `🛰️ 正在委托 DSH: ${summary || '（未提供 task）'}...`,
  };
}

/** 成功结果：DSH 最终输出 -> tool 消息 + UI 卡片 */
export function buildDelegationSuccess(task: string, output: string): ToolExecutionResult {
  const raw = String(output ?? '').trim();
  const display = raw || '（DSH 没有返回文本）';
  const characters = Array.from(display);
  const truncated = characters.length > MAX_DELEGATE_OUTPUT_CHARS;
  const shown = truncated
    ? characters.slice(0, MAX_DELEGATE_OUTPUT_CHARS).join('')
    : display;
  const summary = summarizeTask(task);

  return {
    ok: true,
    toolName: DELEGATE_TOOL_NAME,
    target: summary,
    title: `✅ DSH 已完成: ${summary} (${characters.length} 字${truncated ? '，已截断' : ''})`,
    preview: shown,
    modelContent: `${shown}${
      truncated
        ? `\n\n（输出过长，已截断到 ${MAX_DELEGATE_OUTPUT_CHARS} 字，原文共 ${characters.length} 字）`
        : ''
    }`,
    charCount: characters.length,
    truncated,
  };
}

/** 失败结果：DSH 没启动 / 超时 / failed / 状态接口 404 等 */
export function buildDelegationFailure(task: string, message: string): ToolExecutionResult {
  const summary = summarizeTask(task);
  const reason = String(message || '未知错误').trim();

  return {
    ok: false,
    toolName: DELEGATE_TOOL_NAME,
    target: summary,
    title: `❌ DSH 执行失败: ${summary || 'unknown task'}`,
    preview: reason,
    modelContent: `DSH 任务执行失败：${reason}`,
  };
}

function readTaskArgument(call: ToolCall): string {
  try {
    const parsed: unknown = JSON.parse(call.function.arguments || '{}');
    if (isRecord(parsed) && typeof parsed.task === 'string') {
      return parsed.task.trim();
    }
  } catch {
    // 参数 JSON 不合法时按空任务处理，由执行层给出明确错误
  }
  return '';
}

function summarizeTask(task: string): string {
  const normalized = task.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length > 80 ? `${normalized.slice(0, 80)}…` : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
