/**
 * 扩展入口。
 *
 * 命令：
 *   ai-chat-group.openChat         打开群聊
 *   ai-chat-group.openTeamSettings 打开团队设置（任意 Provider / Role）
 *   ai-chat-group.setApiKey        为任意 Provider 设置/清除 SecretStorage 中的 Key
 */

import * as vscode from 'vscode';

import { promptAndStoreApiKey } from './apiKeys';
import { ChatPanel } from './chatPanel';
import { SettingsPanel } from './settingsPanel';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('ai-chat-group.openChat', () => {
      ChatPanel.createOrShow(context);
    }),

    vscode.commands.registerCommand('ai-chat-group.openTeamSettings', () => {
      SettingsPanel.createOrShow(context);
    }),

    vscode.commands.registerCommand(
      'ai-chat-group.setApiKey',
      async (providerId?: unknown): Promise<void> => {
        const changed = await promptAndStoreApiKey(
          context,
          typeof providerId === 'string' ? providerId : undefined,
        );
        if (changed) {
          ChatPanel.current?.refreshConfig();
          SettingsPanel.current?.refreshKeyStatuses();
        }
      },
    ),

    // DSH 外包工具的安全开关：默认开启；关闭后下一次请求不再携带 tools
    vscode.commands.registerCommand('ai-chat-group.toggleTools', async (): Promise<void> => {
      const configuration = vscode.workspace.getConfiguration('aiChatGroup');
      const current = configuration.get<boolean>('enableTools', true);
      await configuration.update('enableTools', !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        `AI 的 DSH 外包工具已${!current ? '启用' : '禁用'}。`,
      );
    }),
  );
}

export function deactivate(): void {
  ChatPanel.current?.dispose();
  SettingsPanel.current?.dispose();
}
