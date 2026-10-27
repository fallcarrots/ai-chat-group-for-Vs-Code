/**
 * 团队设置面板（独立 Webview 标签页）。
 *
 * 职责：
 *   - 把当前的 Provider / Role / 调度配置发给前端；
 *   - 接收前端表单提交，严格校验后写入 VS Code 设置；
 *   - 支持“无未保存修改时”的即时删除（deleteRole / deleteProvider），
 *     删除不存在的条目时返回 persisted=false，由前端从表单移除；
 *   - 触发 API Key 输入框并刷新 Key 状态；
 *   - 保存/删除成功后通知聊天面板刷新成员条。
 *
 * 服务商与角色都是任意数量，允许团队为空。
 */

import * as vscode from 'vscode';

import { promptAndStoreApiKey } from './apiKeys';
import { ChatPanel } from './chatPanel';
import {
  buildConfigSnapshot,
  hasApiKey,
  readProviders,
  readRoles,
  readTeamSettings,
  saveTeamSettings,
  validateTeamSettings,
} from './config';
import {
  ROLE_COLOR_OPTIONS,
  ROLE_EMOJIS,
  SCHEDULING_OPTIONS,
} from './defaults';
import type { TeamSettingsSnapshot } from './types';
import { renderWebviewHtml } from './webviewHtml';

const PANEL_VIEW_TYPE = 'aiChatGroup.teamSettings';

type NoticeLevel = 'info' | 'warn' | 'error';

type OutboundMessage =
  | {
      type: 'config';
      config: TeamSettingsSnapshot;
      colors: typeof ROLE_COLOR_OPTIONS;
      emojis: readonly string[];
      schedulingOptions: typeof SCHEDULING_OPTIONS;
    }
  | { type: 'saved'; config: TeamSettingsSnapshot }
  | { type: 'error'; message: string; errors?: string[] }
  | { type: 'toast'; level: NoticeLevel; text: string }
  | { type: 'key-status'; providerId: string; hasKey: boolean }
  | { type: 'key-statuses'; statuses: Array<{ providerId: string; hasKey: boolean }> }
  | {
      type: 'delete-result';
      requestId: string;
      ok: boolean;
      message: string;
      persisted?: boolean;
    };

export class SettingsPanel {
  public static current: SettingsPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  public static createOrShow(context: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (SettingsPanel.current) {
      // 只 reveal，不重新下发 config：避免覆盖用户尚未保存的表单修改
      SettingsPanel.current.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      'AI 群聊 · 团队设置',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );

    SettingsPanel.current = new SettingsPanel(context, panel);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
  ) {
    panel.webview.html = renderWebviewHtml({
      context,
      webview: panel.webview,
      htmlFile: 'settings.html',
      scriptFile: 'settings.js',
      styleFile: 'settings.css',
    });

    panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        void this.handleMessage(message).catch((error: unknown) => {
          this.post({
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        });
      },
      undefined,
      this.disposables,
    );

    panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (SettingsPanel.current === this) {
      SettingsPanel.current = undefined;
    }
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  /** 命令面板设置 Key 后，只更新 Key 徽标，不重置用户正在编辑的表单 */
  public refreshKeyStatuses(): void {
    void this.postKeyStatuses();
  }

  private post(message: OutboundMessage): void {
    if (this.disposed) {
      return;
    }
    void Promise.resolve(this.panel.webview.postMessage(message)).catch(() => {
      /* 面板已关闭 */
    });
  }

  private async postConfig(): Promise<void> {
    try {
      const config = await buildConfigSnapshot(this.context);
      this.post({
        type: 'config',
        config,
        colors: ROLE_COLOR_OPTIONS,
        emojis: ROLE_EMOJIS,
        schedulingOptions: SCHEDULING_OPTIONS,
      });
    } catch (error) {
      this.post({
        type: 'error',
        message: `读取团队设置失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async postKeyStatuses(): Promise<void> {
    const providers = readProviders();
    const statuses: Array<{ providerId: string; hasKey: boolean }> = [];
    for (const provider of providers) {
      statuses.push({
        providerId: provider.id,
        hasKey: await hasApiKey(this.context, provider.id),
      });
    }
    this.post({ type: 'key-statuses', statuses });
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (this.disposed || !isRecord(raw) || typeof raw.type !== 'string') {
      return;
    }

    switch (raw.type) {
      case 'ready':
        void this.postConfig();
        return;

      case 'save':
        await this.save(raw.payload);
        return;

      case 'deleteRole':
        if (typeof raw.requestId === 'string' && typeof raw.roleId === 'string') {
          await this.deleteRole(raw.requestId, raw.roleId);
        }
        return;

      case 'deleteProvider':
        if (typeof raw.requestId === 'string' && typeof raw.providerId === 'string') {
          await this.deleteProvider(raw.requestId, raw.providerId);
        }
        return;

      case 'setApiKey':
        if (typeof raw.providerId === 'string') {
          const changed = await promptAndStoreApiKey(this.context, raw.providerId);
          if (changed) {
            this.post({
              type: 'key-status',
              providerId: raw.providerId,
              hasKey: await hasApiKey(this.context, raw.providerId),
            });
            ChatPanel.current?.refreshConfig();
          }
        }
        return;

      case 'openChat':
        await vscode.commands.executeCommand('ai-chat-group.openChat');
        return;

      case 'openVsCodeSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'aiChatGroup');
        return;

      default:
        return;
    }
  }

  private async save(payload: unknown): Promise<void> {
    const validation = validateTeamSettings(payload);
    if (!validation.ok) {
      this.post({
        type: 'error',
        message: '保存失败，请检查以下问题：',
        errors: validation.errors,
      });
      return;
    }

    try {
      await saveTeamSettings(validation.settings);
      const config = await buildConfigSnapshot(this.context);
      this.post({ type: 'saved', config });
      ChatPanel.current?.refreshConfig();
    } catch (error) {
      this.post({
        type: 'error',
        message: `保存团队设置失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * 删除“已保存”的角色。
   * 前端在表单干净时会调用这里立即持久化；如果还有未保存修改，前端只做本地移除并等待 Save。
   */
  private async deleteRole(requestId: string, roleId: string): Promise<void> {
    try {
      const settings = readTeamSettings();
      const role = settings.roles.find((item) => item.id === roleId);

      if (!role) {
        this.post({
          type: 'delete-result',
          requestId,
          ok: true,
          message: '该角色尚未保存，已从表单移除。',
          persisted: false,
        });
        return;
      }

      settings.roles = settings.roles.filter((item) => item.id !== roleId);
      if (settings.summaryRoleId === roleId) {
        settings.summaryRoleId = '';
      }

      const validation = validateTeamSettings(settings);
      if (!validation.ok) {
        this.post({
          type: 'delete-result',
          requestId,
          ok: false,
          message: `无法删除角色「${role.name}」：${validation.errors.join('；')}`,
        });
        return;
      }

      await saveTeamSettings(validation.settings);
      ChatPanel.current?.refreshConfig();
      this.post({
        type: 'delete-result',
        requestId,
        ok: true,
        message: `角色「${role.name}」已删除并保存。`,
        persisted: true,
      });
    } catch (error) {
      this.post({
        type: 'delete-result',
        requestId,
        ok: false,
        message: `删除角色失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * 删除“已保存”的 Provider。
   * 后端会再检查一次引用关系；即使前端判断有误，也不会删掉被角色引用的 Provider。
   */
  private async deleteProvider(requestId: string, providerId: string): Promise<void> {
    try {
      const settings = readTeamSettings();
      const provider = settings.providers.find((item) => item.id === providerId);

      if (!provider) {
        this.post({
          type: 'delete-result',
          requestId,
          ok: true,
          message: '该提供商尚未保存，已从表单移除。',
          persisted: false,
        });
        return;
      }

      const referencingRoles = settings.roles.filter(
        (role) => role.providerId === providerId,
      );
      if (referencingRoles.length > 0) {
        const names = referencingRoles.map((role) => `「${role.name}」`).join('、');
        this.post({
          type: 'delete-result',
          requestId,
          ok: false,
          message: `无法删除提供商「${provider.name}」：仍有 ${referencingRoles.length} 个角色引用它（${names}）。请先修改这些角色的提供商并保存。`,
        });
        return;
      }

      settings.providers = settings.providers.filter((item) => item.id !== providerId);

      const validation = validateTeamSettings(settings);
      if (!validation.ok) {
        this.post({
          type: 'delete-result',
          requestId,
          ok: false,
          message: `无法删除提供商「${provider.name}」：${validation.errors.join('；')}`,
        });
        return;
      }

      await saveTeamSettings(validation.settings);
      ChatPanel.current?.refreshConfig();
      this.post({
        type: 'delete-result',
        requestId,
        ok: true,
        message: `提供商「${provider.name}」已删除并保存。`,
        persisted: true,
      });
    } catch (error) {
      this.post({
        type: 'delete-result',
        requestId,
        ok: false,
        message: `删除提供商失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
