/**
 * API Key 的交互与 SecretStorage 写入。
 * 聊天面板、团队设置面板、命令面板都复用这里的逻辑。
 */

import * as vscode from 'vscode';

import { API_KEY_SECRET_PREFIX, readProviders } from './config';

/**
 * 让用户为某个 Provider 设置/清除 API Key。
 * @param providerId 指定 Provider；不传则先弹出 QuickPick 选择。
 * @returns 是否实际发生了修改（用户取消返回 false）
 */
export async function promptAndStoreApiKey(
  context: vscode.ExtensionContext,
  providerId?: string,
): Promise<boolean> {
  const providers = readProviders();

  if (providers.length === 0) {
    await vscode.window.showErrorMessage(
      '还没有配置任何提供商。请先打开「AI 群聊: 团队设置」添加 Provider。',
    );
    return false;
  }

  let provider = providerId
    ? providers.find((item) => item.id === providerId)
    : undefined;

  if (providerId && !provider) {
    await vscode.window.showErrorMessage(`找不到 Provider「${providerId}」，它可能已被删除。`);
    return false;
  }

  if (!provider) {
    const picked = await vscode.window.showQuickPick(
      providers.map((item) => ({
        label: item.name || item.id,
        description: item.baseUrl,
        detail: `Provider ID：${item.id}`,
        provider: item,
      })),
      {
        title: 'AI 群聊 · 设置 API Key',
        placeHolder: '选择要配置 API Key 的提供商',
        ignoreFocusOut: true,
      },
    );
    if (!picked) {
      return false;
    }
    provider = picked.provider;
  }

  const input = await vscode.window.showInputBox({
    title: `设置「${provider.name}」的 API Key`,
    prompt:
      'Key 会保存在 VS Code SecretStorage 中，不会写入 settings.json。留空并回车可清除已保存的 Key。',
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'sk-...',
  });

  if (input === undefined) {
    return false;
  }

  const key = input.trim();
  const secretKey = API_KEY_SECRET_PREFIX + provider.id;

  if (!key) {
    await context.secrets.delete(secretKey);
    await vscode.window.showInformationMessage(`已清除「${provider.name}」的 API Key。`);
    return true;
  }

  await context.secrets.store(secretKey, key);
  await vscode.window.showInformationMessage(
    `已保存「${provider.name}」的 API Key（存储在 SecretStorage）。`,
  );
  return true;
}
