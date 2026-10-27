/**
 * 聊天记录本地持久化。
 *
 * 文件位置：context.globalStorageUri/chat-history.json
 * 不写入项目目录，也不写入 workspace 级存储。
 *
 * 设计：
 *   - 所有写操作按文件串行排队，避免并发 read-modify-write 丢消息；
 *   - 写入临时文件后再 rename 覆盖，降低写到一半崩溃导致 JSON 损坏的概率；
 *   - 读取失败（不存在 / JSON 损坏 / 权限问题）一律返回 []，不向 UI 抛错；
 *   - 角色元数据（roleId/roleName/emoji/color/model）随消息一起保存，重启后仍能还原气泡。
 */

import { TextDecoder, TextEncoder } from 'node:util';
import * as vscode from 'vscode';

import { ROLE_COLORS } from './defaults';
import type { RoleColor } from './types';

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  /** AI 消息用于重启后找回角色头像/颜色 */
  roleId?: string;
  roleName?: string;
  emoji?: string;
  color?: RoleColor;
  providerLabel?: string;
  model?: string;
  isSummary?: boolean;
  stopped?: boolean;
  error?: string;
}

const HISTORY_FILE = 'chat-history.json';
const writeQueues = new Map<string, Promise<void>>();
const historyCache = new Map<string, StoredMessage[]>();
let tempSeq = 0;

function historyUri(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, HISTORY_FILE);
}

function queueKey(context: vscode.ExtensionContext): string {
  return historyUri(context).toString();
}

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  // 队列本身吞掉错误，让后续写操作继续执行；调用方仍然拿到真实结果
  writeQueues.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function waitForQueue(key: string): Promise<void> {
  await (writeQueues.get(key) ?? Promise.resolve());
}

/** 读取并校验历史文件；任何异常都返回 [] */
async function readHistoryFile(context: vscode.ExtensionContext): Promise<StoredMessage[]> {
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(historyUri(context));
  } catch {
    return [];
  }

  try {
    const text = new TextDecoder().decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      return [];
    }

    const result: StoredMessage[] = [];
    for (const item of parsed) {
      const message = normalizeStoredMessage(item);
      if (message) {
        result.push(message);
      }
    }
    return result;
  } catch {
    return [];
  }
}

/** 校验/清洗单条消息；不合法返回 undefined */
export function normalizeStoredMessage(value: unknown): StoredMessage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const role = record.role;
  const content = record.content;
  const timestamp = record.timestamp;

  if (role !== 'user' && role !== 'assistant') {
    return undefined;
  }
  if (typeof content !== 'string') {
    return undefined;
  }
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return undefined;
  }

  const message: StoredMessage = {
    role,
    content,
    timestamp,
  };

  if (role === 'assistant') {
    if (typeof record.roleId === 'string') {
      message.roleId = record.roleId;
    }
    if (typeof record.roleName === 'string') {
      message.roleName = record.roleName;
    }
    if (typeof record.emoji === 'string') {
      message.emoji = record.emoji;
    }
    if (
      typeof record.color === 'string' &&
      (ROLE_COLORS as readonly string[]).includes(record.color)
    ) {
      message.color = record.color as RoleColor;
    }
    if (typeof record.providerLabel === 'string') {
      message.providerLabel = record.providerLabel;
    }
    if (typeof record.model === 'string') {
      message.model = record.model;
    }
    if (record.isSummary === true) {
      message.isSummary = true;
    }
    if (record.stopped === true) {
      message.stopped = true;
    }
    if (typeof record.error === 'string') {
      message.error = record.error;
    }
  }

  return message;
}

async function writeHistoryFile(
  context: vscode.ExtensionContext,
  messages: StoredMessage[],
): Promise<void> {
  const directory = context.globalStorageUri;
  await vscode.workspace.fs.createDirectory(directory);

  const target = historyUri(context);
  const data = new TextEncoder().encode(JSON.stringify(messages));
  tempSeq += 1;
  const temp = vscode.Uri.joinPath(
    directory,
    `.${HISTORY_FILE}.${Date.now().toString(36)}.${tempSeq}.tmp`,
  );

  try {
    await vscode.workspace.fs.writeFile(temp, data);
    try {
      await vscode.workspace.fs.rename(temp, target, { overwrite: true });
    } catch {
      // 某些文件系统不支持 rename 覆盖，退化为直接写目标文件
      await vscode.workspace.fs.writeFile(target, data);
      await deleteQuietly(temp);
    }
  } catch (error) {
    await deleteQuietly(temp);
    throw error;
  }
}

async function deleteQuietly(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri);
  } catch {
    // 临时文件可能已被清理
  }
}

/**
 * 追加保存一条消息。
 * 写入失败会 reject，调用方自行决定是否提示；正常使用建议 fire-and-forget 并记录日志。
 */
export async function saveMessage(
  context: vscode.ExtensionContext,
  message: StoredMessage,
): Promise<void> {
  const normalized = normalizeStoredMessage(message);
  if (!normalized) {
    throw new Error('无效的聊天记录：role/content/timestamp 格式不正确。');
  }

  const key = queueKey(context);
  await enqueue(key, async () => {
    const current = historyCache.get(key) ?? (await readHistoryFile(context));
    const next = [...current, normalized];
    await writeHistoryFile(context, next);
    historyCache.set(key, next);
  });
}

/**
 * 读取聊天记录。
 * 文件不存在、JSON 损坏或任何 I/O 错误都返回 []，不抛错。
 */
export async function loadHistory(
  context: vscode.ExtensionContext,
): Promise<StoredMessage[]> {
  const key = queueKey(context);
  await waitForQueue(key);

  const messages = await readHistoryFile(context);
  historyCache.set(key, messages);
  return messages.map((message) => ({ ...message }));
}

/**
 * 清空聊天记录文件。
 * 文件不存在视为成功；真实的删除失败会 reject，供 UI 提示。
 */
export async function clearHistory(context: vscode.ExtensionContext): Promise<void> {
  const key = queueKey(context);
  await enqueue(key, async () => {
    historyCache.delete(key);
    const uri = historyUri(context);

    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      return;
    }

    await vscode.workspace.fs.delete(uri, { useTrash: false, recursive: false });
  });
}
