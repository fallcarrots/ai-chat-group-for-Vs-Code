/**
 * 聊天面板：完全由 aiChatGroup.providers / aiChatGroup.roles 驱动。
 *
 * 调度规则（aiChatGroup.scheduling）：
 *   serial             按角色数组顺序串行，后发言者能看到前面所有角色本轮的输出；
 *   parallel           所有启用角色并行（并发数受 maxConcurrency 限制），彼此看不到本轮输出；
 *   lead-then-parallel 数组第一个启用角色先发言，其余角色并行，且都能看到首位角色的输出。
 *
 * 如果配置了 summaryRoleId，则所有角色发言结束后，该角色再做一次“汇总”发言。
 *
 * 每次请求的 messages 都强制为：
 *   [ { role: 'system', content: role.prompt },
 *     { role: 'system', content: 会议摘要 }?,
 *     { role: 'user', content: 最近窗口 + 本轮上下文 } ]
 * 保证角色换人、换模型后 system prompt 仍然正确。
 *
 * 历史超过 aiChatGroup.maxHistoryMessages 时，最老的消息会先被压缩成 200 字以内的
 * 会议摘要（缓存复用），最近 N 条作为滑动窗口继续参与上下文。
 */

import * as vscode from 'vscode';

import {
  ApiError,
  MissingApiKeyError,
  buildChatCompletionsUrl,
  createAbortError,
  isAbortError,
  streamChatCompletion,
  type ChatMessage,
  type ProviderConfig,
  type ToolDefinition,
} from './aiClient';
import {
  TeamConfigError,
  getConfig,
  prepareRoleTarget,
  readChatMode,
  readDemoMode,
  readEnableHeartbeat,
  readMaxConcurrency,
  readMaxHistoryMessages,
  readProviders,
  readRoles,
  readScheduling,
  readSummaryRoleId,
  resolveJudgeTarget,
} from './config';
import {
  CASUAL_REPLY_INSTRUCTION,
  CASUAL_SYSTEM_SUFFIX,
  HISTORY_SUMMARY_PROMPT,
  MAX_SUMMARY_CHARS,
  SUMMARY_INSTRUCTION,
} from './defaults';
import { buildDemoReply, streamDemoText } from './demo';
import {
  clearHistory,
  loadHistory,
  saveMessage,
  type StoredMessage,
} from './storage';
import type { RoleColor, RoleDefinition } from './types';
import { estimateMessagesTokens } from './tokens';
import {
  DELEGATE_TOOL_NAME,
  TOOL_DEFINITIONS,
  buildDelegationFailure,
  buildDelegationSuccess,
  describeToolCall,
  type ToolExecutionResult,
} from './tools';
import { renderWebviewHtml } from './webviewHtml';

const PANEL_VIEW_TYPE = 'aiChatGroup.chat';
/** 单条用户输入的最大长度（字符） */
const MAX_INPUT_CHARS = 4000;
/** 单次角色发言最多允许几轮工具调用，防止模型无限循环 */
const MAX_TOOL_ROUNDS = 5;
/** casual 模式下允许 AI 互相 @ 的最大连续发言数，防止死循环 */
const MAX_CASUAL_TURNS = 6;
/** 隐形裁判请求超时（非流式） */
const JUDGE_TIMEOUT_MS = 3_000;
/** 裁判只需要输出一个角色名，限制 token 降低成本 */
const JUDGE_MAX_TOKENS = 16;
/** 心跳检查间隔：2 分钟 */
const HEARTBEAT_INTERVAL_MS = 2 * 60_000;
/** 超过 5 分钟没有用户/AI 发言视为冷场 */
const HEARTBEAT_IDLE_MS = 5 * 60_000;
/** 连续主动发言上限，达到后休眠 */
const HEARTBEAT_MAX_PROACTIVE = 3;
/** 心跳 AI 请求超时（与裁判相同） */
const HEARTBEAT_TIMEOUT_MS = 3_000;

/** 本地 DeepSeek Harness headless 接口 */
const DSH_SUBMIT_URL = 'http://127.0.0.1:3080/x/headless';
const DSH_STATUS_URL = 'http://127.0.0.1:3080/x/headless/status';
const DSH_SUBMIT_TIMEOUT_MS = 30_000;
const DSH_STATUS_TIMEOUT_MS = 15_000;
const DSH_POLL_INTERVAL_MS = 1_500;
const DSH_POLL_TIMEOUT_MS = 5 * 60_000;

/** 一条聊天记录。User 和 Assistant 共用，前端据此渲染气泡。 */
interface HistoryEntry {
  id: string;
  kind: 'user' | 'assistant';
  text: string;
  time: number;
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

interface MemberInfo {
  id: string;
  name: string;
  emoji: string;
  color: RoleColor;
  providerLabel: string;
  model: string;
}

type NoticeLevel = 'info' | 'warn' | 'error';
type NoticeCommand = 'setApiKey' | 'openTeamSettings' | 'openSettings' | 'clearChat';

interface NoticeAction {
  label: string;
  command: NoticeCommand;
  /** 精准设置某个 Provider 的 Key */
  providerId?: string;
}

/** 扩展 -> Webview 的消息协议（前端见 media/main.js） */
type OutboundMessage =
  | {
      type: 'init';
      members: MemberInfo[];
      history: HistoryEntry[];
      busy: boolean;
      status: string;
      demoMode: boolean;
      maxInput: number;
      tokenEstimate: number;
    }
  | { type: 'config'; members: MemberInfo[]; demoMode: boolean; maxInput: number }
  | { type: 'user'; entry: HistoryEntry }
  | { type: 'assistant-start'; entry: HistoryEntry }
  | { type: 'assistant-delta'; id: string; delta: string }
  | { type: 'assistant-end'; id: string; stopped?: boolean; error?: string }
  | { type: 'notice'; level: NoticeLevel; text: string; actions?: NoticeAction[] }
  | { type: 'status'; busy: boolean; text: string }
  | { type: 'system-note'; text: string }
  | { type: 'token-estimate'; tokens: number }
  | {
      type: 'tool-call-start';
      id: string;
      messageId: string;
      toolName: string;
      title: string;
    }
  | {
      type: 'tool-call-progress';
      id: string;
      title: string;
    }
  | {
      type: 'tool-call-end';
      id: string;
      ok: boolean;
      title: string;
      content: string;
      charCount?: number;
      itemCount?: number;
      truncated?: boolean;
    }
  | { type: 'judge-start' }
  | { type: 'judge-end' }
  | { type: 'load-history'; messages: StoredMessage[] }
  | { type: 'clear' };

/** 某个角色调用失败时，带上角色、Provider 与原始错误 */
class RoleCallError extends Error {
  constructor(
    readonly role: RoleDefinition,
    readonly providerLabel: string,
    readonly providerId: string | undefined,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'RoleCallError';
  }
}

/** 本轮某个角色的完整发言，用于后续角色的上下文 */
interface RoundContribution {
  role: RoleDefinition;
  text: string;
}

interface DshOutcome {
  ok: boolean;
  text?: string;
  error?: string;
  sessionId?: string;
}

interface DiscussionContext {
  requirement: string;
  /** 滑动窗口内的最近历史记录 */
  prior: HistoryEntry[];
  /** 被滑出窗口的旧消息压缩成的会议摘要（可选） */
  historySummary?: string;
  /** 本轮已经完成的其他角色发言（按调度模式截取） */
  contributions: RoundContribution[];
  mode: 'normal' | 'summary' | 'casual' | 'heartbeat';
  /** casual 模式本轮为何轮到该角色：用户点名 / AI 点名 / 随机 */
  casualTrigger?: 'user-mention' | 'ai-mention' | 'random';
}

export class ChatPanel {
  public static current: ChatPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly output = vscode.window.createOutputChannel('AI 群聊');
  private history: HistoryEntry[] = [];
  private busy = false;
  private stopRequested = false;
  private statusText = '空闲';
  private abortController: AbortController | undefined;
  private seq = 0;
  private disposed = false;
  /** 自动压缩生成的会议摘要缓存 */
  private historySummary = '';
  /** 摘要已经覆盖的旧历史条数（从 history 数组开头算） */
  private summaryCoveredCount = 0;
  /** 最近一次请求 payload 的估算 token 数 */
  private lastTokenEstimate = 0;
  /** 首次 ready 时加载持久化历史的 Promise；发送前等待它完成，避免竞态 */
  private historyLoadPromise: Promise<void> = Promise.resolve();
  /** 面板是否可见：隐藏时暂停心跳定时器 */
  private panelVisible = true;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  /** 最近一次群聊发言（用户或 AI）时间 */
  private lastActivityAt = Date.now();
  /** 连续主动发言次数 */
  private heartbeatConsecutive = 0;
  /** 达到上限后休眠，直到用户再次发言 */
  private heartbeatSleeping = false;
  /** 上次心跳尝试时间：失败后 5 分钟内不重复烧 Token */
  private lastHeartbeatAttemptAt = 0;

  public static createOrShow(context: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(PANEL_VIEW_TYPE, 'AI 群聊', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });

    ChatPanel.current = new ChatPanel(context, panel);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
  ) {
    panel.webview.html = renderWebviewHtml({
      context,
      webview: panel.webview,
      htmlFile: 'chat.html',
      scriptFile: 'main.js',
      styleFile: 'style.css',
    });

    this.panelVisible = panel.visible;
    this.log(`[${new Date().toISOString()}] 群聊面板已创建`);

    panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        void this.handleMessage(message).catch((error: unknown) => {
          this.reportError(error);
        });
      },
      undefined,
      this.disposables,
    );

    panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    panel.onDidChangeViewState(
      (event) => {
        this.panelVisible = event.webviewPanel.visible;
        this.syncHeartbeatTimer();
      },
      undefined,
      this.disposables,
    );

    vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration('aiChatGroup')) {
          this.postConfig();
          if (event.affectsConfiguration('aiChatGroup.enableHeartbeat')) {
            this.syncHeartbeatTimer();
          }
        }
      },
      undefined,
      this.disposables,
    );

    this.disposables.push(this.output);
    this.syncHeartbeatTimer();
  }

  /** 团队设置保存 / API Key 变化后刷新顶部成员信息 */
  public refreshConfig(): void {
    this.postConfig();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stopHeartbeatTimer();
    if (ChatPanel.current === this) {
      ChatPanel.current = undefined;
    }
    this.abortController?.abort();
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  // ---------------------------------------------------------------------------
  // 心跳 / 主动发言
  // ---------------------------------------------------------------------------

  private syncHeartbeatTimer(): void {
    this.stopHeartbeatTimer();

    if (this.disposed || !this.panelVisible || this.heartbeatSleeping) {
      return;
    }
    if (!readEnableHeartbeat()) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      void this.tickHeartbeat().catch((error: unknown) => {
        this.log(
          `[heartbeat] 检查失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private async tickHeartbeat(): Promise<void> {
    if (this.disposed || !this.panelVisible || this.busy || this.heartbeatSleeping) {
      return;
    }
    if (!readEnableHeartbeat()) {
      this.stopHeartbeatTimer();
      return;
    }
    if (Date.now() - this.lastActivityAt < HEARTBEAT_IDLE_MS) {
      return;
    }
    if (Date.now() - this.lastHeartbeatAttemptAt < HEARTBEAT_IDLE_MS) {
      return;
    }

    this.lastHeartbeatAttemptAt = Date.now();
    await this.runHeartbeat();
  }

  private async runHeartbeat(): Promise<void> {
    if (this.disposed || this.busy || !this.panelVisible || !readEnableHeartbeat()) {
      return;
    }

    const roles = readRoles().filter((role) => role.enabled);
    if (roles.length === 0) {
      return;
    }

    this.busy = true;
    this.stopRequested = false;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      const judgePick = await this.judgeNextSpeaker(
        '群里已经冷场很久了，谁来主动开个轻松话题？',
        roles,
        signal,
      );
      const role = judgePick ?? this.pickHeartbeatRole(roles);
      if (!role) {
        return;
      }

      this.post({
        type: 'system-note',
        text: `${role.name} 正在开启新话题...`,
      });
      this.postStatus(`${role.name} 正在开启新话题...`);

      await this.speak(
        role,
        {
          requirement: '',
          prior: this.history.slice(),
          historySummary: '',
          contributions: [],
          mode: 'heartbeat',
        },
        `${role.name} 正在开启新话题...`,
        {
          timeoutMs: HEARTBEAT_TIMEOUT_MS,
          allowTools: false,
          maxTokens: 200,
        },
      );

      this.heartbeatConsecutive += 1;
      this.lastActivityAt = Date.now();

      if (this.heartbeatConsecutive >= HEARTBEAT_MAX_PROACTIVE) {
        this.heartbeatSleeping = true;
        this.stopHeartbeatTimer();
        this.post({
          type: 'system-note',
          text: `💤 连续 ${HEARTBEAT_MAX_PROACTIVE} 次主动发言，心跳已休眠；你发一句话即可唤醒。`,
        });
      }
    } catch (error) {
      if (this.stopRequested || isAbortError(error)) {
        this.notify('info', '本轮主动发言已停止。');
      } else {
        this.log(
          `[heartbeat] 主动发言失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } finally {
      this.busy = false;
      this.stopRequested = false;
      this.abortController = undefined;
      this.postStatus('空闲');
    }
  }

  private pickHeartbeatRole(roles: RoleDefinition[]): RoleDefinition | undefined {
    if (roles.length === 0) {
      return undefined;
    }
    const lastAssistant = [...this.history]
      .reverse()
      .find((entry) => entry.kind === 'assistant' && entry.roleId);
    const candidates = lastAssistant
      ? roles.filter((role) => role.id !== lastAssistant.roleId)
      : roles;
    const pool = candidates.length > 0 ? candidates : roles;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private wakeHeartbeat(): void {
    this.heartbeatConsecutive = 0;
    this.heartbeatSleeping = false;
    this.lastActivityAt = Date.now();
    this.syncHeartbeatTimer();
  }

  // ---------------------------------------------------------------------------
  // Webview 通信
  // ---------------------------------------------------------------------------

  private post(message: OutboundMessage): void {
    if (this.disposed) {
      return;
    }
    void Promise.resolve(this.panel.webview.postMessage(message)).catch(() => {
      /* 面板已关闭 */
    });
  }

  private postStatus(text: string): void {
    this.statusText = text;
    this.post({ type: 'status', busy: this.busy, text });
  }

  private log(line: string): void {
    if (this.disposed) {
      return;
    }
    this.output.appendLine(line);
  }

  private postInit(): void {
    this.post({
      type: 'init',
      members: buildMembers(),
      // 历史统一走 load-history，避免 init 和 load-history 重复渲染
      history: [],
      busy: this.busy,
      status: this.statusText,
      demoMode: readDemoMode(),
      maxInput: MAX_INPUT_CHARS,
      tokenEstimate: this.lastTokenEstimate,
    });
    this.post({
      type: 'load-history',
      messages: this.history.map(historyToStored),
    });
  }

  /** Webview ready：先加载全局存储里的历史，再发 init + load-history */
  private async handleReady(): Promise<void> {
    const load = this.reloadHistory();
    this.historyLoadPromise = load;
    await load;
    this.postInit();
  }

  private async reloadHistory(): Promise<void> {
    const stored = await loadHistory(this.context);
    // Webview 刷新通常发生在空闲时；如果正在流式生成，不覆盖本轮流式状态
    if (!this.busy && (stored.length > 0 || this.history.length === 0)) {
      const roles = readRoles();
      this.history = stored.map((message, index) =>
        storedToHistory(message, index, roles),
      );
      this.historySummary = '';
      this.summaryCoveredCount = 0;
      this.lastTokenEstimate = 0;
      const last = this.history[this.history.length - 1];
      this.lastActivityAt = last ? last.time : Date.now();
    }
  }

  private postConfig(): void {
    this.post({
      type: 'config',
      members: buildMembers(),
      demoMode: readDemoMode(),
      maxInput: MAX_INPUT_CHARS,
    });
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (this.disposed || !isRecord(raw) || typeof raw.type !== 'string') {
      return;
    }

    switch (raw.type) {
      case 'ready':
        await this.handleReady();
        return;

      case 'send':
        if (typeof raw.text === 'string') {
          await this.handleUserInput(raw.text);
        }
        return;

      case 'stop':
        this.requestStop();
        return;

      case 'clear':
        await this.clearChat();
        return;

      case 'copy':
        if (typeof raw.text === 'string') {
          await vscode.env.clipboard.writeText(raw.text.slice(0, 200_000));
        }
        return;

      case 'openExternal':
        if (typeof raw.url === 'string') {
          await this.openExternal(raw.url);
        }
        return;

      case 'command':
        if (typeof raw.command === 'string') {
          await this.runWebviewCommand(
            raw.command,
            typeof raw.providerId === 'string' ? raw.providerId : undefined,
          );
        }
        return;

      default:
        return;
    }
  }

  private async runWebviewCommand(command: string, providerId?: string): Promise<void> {
    switch (command) {
      case 'setApiKey':
        // 统一走命令：命令会同时刷新聊天面板与团队设置面板的 Key 状态
        await vscode.commands.executeCommand('ai-chat-group.setApiKey', providerId);
        return;
      case 'openTeamSettings':
        await vscode.commands.executeCommand('ai-chat-group.openTeamSettings');
        return;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'aiChatGroup');
        return;
      case 'clearChat':
        await this.clearChat();
        return;
      default:
        return;
    }
  }

  private async openExternal(rawUrl: string): Promise<void> {
    try {
      const uri = vscode.Uri.parse(rawUrl, true);
      const scheme = uri.scheme.toLowerCase();
      if (scheme !== 'http' && scheme !== 'https') {
        this.notify('warn', '只允许打开 http/https 链接。');
        return;
      }
      await vscode.env.openExternal(uri);
    } catch {
      this.notify('warn', '链接格式不合法，无法打开。');
    }
  }

  // ---------------------------------------------------------------------------
  // 用户输入 / 停止 / 清空
  // ---------------------------------------------------------------------------

  private async handleUserInput(rawText: string): Promise<void> {
    const text = rawText.trim();
    if (!text) {
      return;
    }
    if (text.length > MAX_INPUT_CHARS) {
      this.notify('warn', `单条需求最多 ${MAX_INPUT_CHARS} 字，当前 ${text.length} 字。`);
      return;
    }
    await this.historyLoadPromise;
    if (this.disposed) {
      return;
    }
    if (this.busy) {
      this.notify('warn', '上一条需求还在讨论中，请等待结束，或点击「停止」后重试。');
      return;
    }

    const enabledRoles = readRoles().filter((role) => role.enabled);
    if (enabledRoles.length === 0) {
      this.notify('error', '当前团队没有启用的角色。请先在「团队设置」里添加或启用角色。', [
        { label: '打开团队设置', command: 'openTeamSettings' },
      ]);
      return;
    }

    // 用户发言会唤醒心跳并重置连续主动发言计数
    this.wakeHeartbeat();

    // 快照本轮的角色顺序：即使中途修改设置，本轮也保持稳定
    const prior = this.history.slice();
    const userEntry: HistoryEntry = {
      id: this.nextId('u'),
      kind: 'user',
      text,
      time: Date.now(),
    };
    this.history.push(userEntry);
    this.post({ type: 'user', entry: userEntry });
    this.persistHistoryEntry(userEntry);

    this.busy = true;
    this.stopRequested = false;
    this.abortController = new AbortController();
    this.postStatus(`${enabledRoles[0].name} 正在准备…`);

    try {
      await this.runDiscussion(text, prior, enabledRoles);
    } catch (error) {
      if (this.stopRequested || isAbortError(error)) {
        this.notify('info', '本轮讨论已停止，可以继续发送新的需求。');
      } else {
        this.reportError(error);
      }
    } finally {
      this.busy = false;
      this.stopRequested = false;
      this.abortController = undefined;
      this.postStatus('空闲');
    }
  }

  private requestStop(): void {
    if (!this.busy || !this.abortController) {
      return;
    }
    this.stopRequested = true;
    this.abortController.abort();
    this.postStatus('正在停止…');
  }

  private async clearChat(): Promise<void> {
    if (this.busy) {
      this.notify('warn', '讨论进行中，请先点击「停止」再清空。');
      return;
    }

    await this.historyLoadPromise;
    if (this.disposed) {
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      '确定要清空当前群聊记录吗？',
      { modal: true },
      '清空',
    );
    if (choice !== '清空') {
      return;
    }

    try {
      await clearHistory(this.context);
    } catch (error) {
      this.logErrorDetail(error);
      this.notify('warn', '本地聊天记录删除失败，当前界面已清空，但重启后可能恢复。');
    }

    this.history = [];
    this.historySummary = '';
    this.summaryCoveredCount = 0;
    this.lastTokenEstimate = 0;
    this.wakeHeartbeat();
    this.post({ type: 'clear' });
    this.post({ type: 'token-estimate', tokens: 0 });
    this.postStatus('空闲');
  }

  // ---------------------------------------------------------------------------
  // 动态调度
  // ---------------------------------------------------------------------------

  private async runDiscussion(
    requirement: string,
    prior: HistoryEntry[],
    roles: RoleDefinition[],
  ): Promise<void> {
    const signal = this.abortController?.signal;
    if (!signal) {
      return;
    }

    // 先处理滑动窗口：超出 maxHistoryMessages 的旧消息压缩成 system 摘要
    const historyWindow = await this.prepareHistoryWindow(prior, roles);
    this.throwIfStopped(signal);

    if (historyWindow.compressed) {
      this.post({
        type: 'system-note',
        text: historyWindow.fallback
          ? '📦 历史记录过长，已使用本地摘要压缩之前的讨论内容'
          : '📦 历史记录过长，已自动压缩之前的讨论内容（摘要 ≤ 200 字）',
      });
    }

    // 所有角色共享同一份“最近窗口 + 会议摘要”
    const baseContext = {
      requirement,
      prior: historyWindow.recent,
      historySummary: historyWindow.summary,
    };

    const chatMode = readChatMode();
    const mentionedRoles = findMentionedRoles(requirement, roles);

    // 用户点名：跳过随机/调度/汇总，按 @ 出现顺序依次回复
    if (mentionedRoles.length > 0) {
      if (chatMode === 'casual') {
        await this.runCasualDiscussion(baseContext, roles, mentionedRoles);
      } else {
        await this.runMentionedDiscussion(baseContext, mentionedRoles);
      }
      return;
    }

    // 没有用户点名：闲聊模式先尝试隐形裁判，失败则静默回退随机
    if (chatMode === 'casual') {
      const judgeRole = await this.judgeNextSpeaker(requirement, roles, signal);
      await this.runCasualDiscussion(baseContext, roles, [], judgeRole);
      return;
    }

    const scheduling = readScheduling();
    const contributions: RoundContribution[] = [];

    if (scheduling === 'serial') {
      // 串行：每个角色都能看到前面所有角色的本轮输出
      for (const role of roles) {
        this.throwIfStopped(signal);
        const text = await this.speak(
          role,
          { ...baseContext, contributions: contributions.slice(), mode: 'normal' },
          `${role.name} 正在发言…`,
        );
        contributions.push({ role, text });
      }
    } else if (scheduling === 'parallel') {
      // 全部并行：彼此看不到本轮其他人的输出
      this.postStatus(`${roles.length} 个角色正在并行发言…`);
      const results = await this.runParallel(roles, {
        ...baseContext,
        contributions: [],
        mode: 'normal',
      });
      contributions.push(...results);
    } else {
      // 首位先行 + 其余并行：其余角色都能看到首位角色的输出
      const [lead, ...rest] = roles;
      this.throwIfStopped(signal);
      const leadText = await this.speak(
        lead,
        { ...baseContext, contributions: [], mode: 'normal' },
        `${lead.name} 正在发言…`,
      );
      contributions.push({ role: lead, text: leadText });

      if (rest.length > 0) {
        this.throwIfStopped(signal);
        this.postStatus(`${rest.length} 个角色正在并行发言…`);
        const results = await this.runParallel(rest, {
          ...baseContext,
          contributions: [{ role: lead, text: leadText }],
          mode: 'normal',
        });
        contributions.push(...results);
      }
    }

    // 可选：汇总发言
    const summaryRoleId = readSummaryRoleId();
    if (!summaryRoleId) {
      return;
    }

    const summaryRole = roles.find((role) => role.id === summaryRoleId);
    if (!summaryRole) {
      this.notify('warn', `汇总角色「${summaryRoleId}」不存在或未启用，本轮跳过汇总。`);
      return;
    }

    this.throwIfStopped(signal);
    this.postStatus(`${summaryRole.name} 正在汇总…`);
    await this.speak(
      summaryRole,
      { ...baseContext, contributions: contributions.slice(), mode: 'summary' },
      `${summaryRole.name} 正在汇总…`,
    );
  }

  /**
   * 计算本次请求使用的历史窗口。
   * 超过 maxHistoryMessages 的最老消息会先压缩成摘要，最近 N 条原样保留。
   */
  private async prepareHistoryWindow(
    prior: HistoryEntry[],
    roles: RoleDefinition[],
  ): Promise<{
    recent: HistoryEntry[];
    summary: string;
    compressed: boolean;
    fallback: boolean;
  }> {
    const maxMessages = readMaxHistoryMessages();
    const overflow = Math.max(0, prior.length - maxMessages);

    if (overflow === 0) {
      return { recent: prior, summary: '', compressed: false, fallback: false };
    }

    // 窗口配置变大、历史被清理或摘要缓存不完整时，从头重新压缩
    if (
      this.summaryCoveredCount > overflow ||
      (this.summaryCoveredCount > 0 && !this.historySummary)
    ) {
      this.historySummary = '';
      this.summaryCoveredCount = 0;
    }

    let compressed = false;
    let fallback = false;

    if (this.summaryCoveredCount < overflow) {
      const newEntries = prior.slice(this.summaryCoveredCount, overflow);
      const result = await this.createHistorySummary(
        newEntries,
        this.historySummary,
        roles,
      );
      this.historySummary = result.summary;
      this.summaryCoveredCount = overflow;
      compressed = true;
      fallback = result.fallback;
    }

    return {
      recent: prior.slice(overflow),
      summary: this.historySummary,
      compressed,
      fallback,
    };
  }

  /**
   * 用轻量级调用生成/更新会议摘要。
   * 优先使用第一个可用的角色 Provider；失败时退化为本地截断摘要，绝不阻塞群聊。
   */
  private async createHistorySummary(
    newEntries: HistoryEntry[],
    existingSummary: string,
    roles: RoleDefinition[],
  ): Promise<{ summary: string; fallback: boolean }> {
    const fallback = buildFallbackSummary(newEntries, existingSummary);

    if (newEntries.length === 0) {
      return { summary: existingSummary || fallback, fallback: !existingSummary };
    }

    const signal = this.abortController?.signal;
    if (!signal) {
      throw createAbortError();
    }

    // 演示模式不调用真实模型
    if (readDemoMode()) {
      return { summary: fallback, fallback: true };
    }

    let target: { provider: ProviderConfig; model: string; temperature: number } | undefined;
    for (const role of roles) {
      try {
        target = await prepareRoleTarget(this.context, role);
        break;
      } catch (error) {
        if (this.stopRequested || isAbortError(error)) {
          throw error;
        }
      }
    }

    if (signal.aborted) {
      throw createAbortError();
    }
    if (!target) {
      this.log('[context] 没有可用的 Provider/Key，使用本地摘要。');
      return { summary: fallback, fallback: true };
    }

    const transcript = formatHistory(newEntries, 12_000);
    if (!transcript.trim()) {
      return { summary: fallback, fallback: true };
    }

    const blocks: string[] = [];
    if (existingSummary) {
      blocks.push(`【已有会议摘要】\n${existingSummary}`);
    }
    blocks.push(`【需要合并的较早讨论】\n${transcript}`);
    blocks.push('请输出合并后的会议摘要，不超过 200 个汉字。');

    this.postStatus('正在压缩历史记录…');

    try {
      const result = await streamChatCompletion({
        provider: target.provider,
        model: target.model,
        messages: [
          { role: 'system', content: HISTORY_SUMMARY_PROMPT },
          { role: 'user', content: blocks.join('\n\n') },
        ],
        temperature: 0.2,
        maxTokens: 300,
        timeoutMs: Math.min(60_000, getConfig<number>('requestTimeoutMs', 90_000)),
        signal,
        onDelta: () => {
          /* 摘要不需要流式展示 */
        },
      });

      const summary = truncateText(result.text.trim(), MAX_SUMMARY_CHARS);
      if (!summary) {
        return { summary: fallback, fallback: true };
      }

      this.log(
        `[${new Date().toISOString()}] [context] 生成会议摘要 ${summary.length} 字，覆盖 ${newEntries.length} 条旧消息。`,
      );
      return { summary, fallback: false };
    } catch (error) {
      if (this.stopRequested || isAbortError(error)) {
        throw error;
      }
      this.log(
        `[${new Date().toISOString()}] [context] 自动摘要失败，使用本地摘要：${describeError(error)}`,
      );
      return { summary: fallback, fallback: true };
    }
  }

  /** 在发送前更新 Webview 顶部的 Token 估算（包含 tools 与 tool_calls） */
  private updateTokenEstimate(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
  ): void {
    const tokens = estimateMessagesTokens(messages, tools);
    this.lastTokenEstimate = tokens;
    this.post({ type: 'token-estimate', tokens });
  }

  /**
   * 隐形裁判：非流式、3 秒超时、失败静默返回 undefined。
   * 只输出角色名；None / 无效名字 / 网络错误 / 超时 都交给调用方回退随机。
   */
  private async judgeNextSpeaker(
    requirement: string,
    roles: RoleDefinition[],
    signal: AbortSignal,
  ): Promise<RoleDefinition | undefined> {
    if (signal.aborted) {
      throw createAbortError();
    }

    let target;
    try {
      target = await resolveJudgeTarget(this.context);
    } catch {
      return undefined;
    }
    if (!target) {
      return undefined;
    }
    if (signal.aborted) {
      throw createAbortError();
    }

    this.post({ type: 'judge-start' });

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, JUDGE_TIMEOUT_MS);
    const forwardAbort = (): void => controller.abort();
    signal.addEventListener('abort', forwardAbort, { once: true });

    try {
      const memberList = roles.map((role) => role.name).join('、');
      const prompt =
        `你是一个群聊调度员。当前群成员：${memberList}。` +
        `用户刚刚说：'${requirement}'。` +
        '请判断哪位成员最适合回答？只输出成员名字，不要标点，如果都不适合请输出 None。';

      const response = await fetch(buildChatCompletionsUrl(target.provider.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${target.provider.apiKey}`,
        },
        body: JSON.stringify({
          model: target.model,
          messages: [{ role: 'system', content: prompt }],
          stream: false,
          temperature: 0,
          max_tokens: JUDGE_MAX_TOKENS,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return undefined;
      }

      const data: unknown = await response.json();
      const text = extractJudgeText(data).trim();
      this.log(`[judge] ${target.provider.label}/${target.model} -> ${text || '(empty)'}`);

      if (!text || /^none$/i.test(text)) {
        return undefined;
      }

      return roles.find((role) => role.name === text);
    } catch (error) {
      if (signal.aborted) {
        throw createAbortError();
      }
      this.log(
        `[judge] ${timedOut ? '超时' : '失败'}，回退随机：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', forwardAbort);
      this.post({ type: 'judge-end' });
    }
  }

  /**
   * 用户点名（work 模式）：按 @ 出现顺序依次回复，不走调度/汇总。
   */
  private async runMentionedDiscussion(
    base: Pick<DiscussionContext, 'requirement' | 'prior' | 'historySummary'>,
    roles: RoleDefinition[],
  ): Promise<void> {
    const signal = this.abortController?.signal;
    if (!signal || roles.length === 0) {
      return;
    }

    const chain: RoundContribution[] = [];
    for (const role of roles) {
      this.throwIfStopped(signal);
      const text = await this.speak(
        role,
        {
          ...base,
          contributions: chain.slice(),
          mode: 'normal',
        },
        `${role.name} 被点名，正在回复…`,
      );
      chain.push({ role, text });
    }
  }

  /**
   * 闲聊模式：
   *   - 没有用户 @：随机挑 1 个角色开场，之后排除刚发言者随机接话，共 2-3 轮；
   *   - 用户 @ 了角色：按 @ 顺序依次回复，不再随机；
   *   - AI 回复里 @ 了角色：把下一个发言权强制交给被 @ 的角色；
   *   - 最多 MAX_CASUAL_TURNS 轮，防止两个 AI 互相 @ 无限循环；
   *   - 不插入任何合成的用户消息，只有一条真实用户消息 + 连续 AI 气泡。
   */
  private async runCasualDiscussion(
    base: Pick<DiscussionContext, 'requirement' | 'prior' | 'historySummary'>,
    roles: RoleDefinition[],
    initialMentions: RoleDefinition[] = [],
    judgePick?: RoleDefinition,
  ): Promise<void> {
    const signal = this.abortController?.signal;
    if (!signal || roles.length === 0) {
      return;
    }

    const hasUserMentions = initialMentions.length > 0;
    if (!hasUserMentions && !judgePick && roles.length < 2) {
      this.notify(
        'warn',
        '闲聊模式至少需要 2 个启用的角色才能接龙。本轮只让一个角色发言，请在团队设置里添加更多角色。',
      );
    }

    const randomTarget = hasUserMentions
      ? 0
      : roles.length >= 2
        ? (Math.random() < 0.5 ? 2 : 3)
        : 1;
    const maxTurns = Math.max(MAX_CASUAL_TURNS, initialMentions.length + 3);
    const pending = [...initialMentions];
    const forced: RoleDefinition[] = [];
    const chain: RoundContribution[] = [];
    let judgeFirst = judgePick;
    let lastRoleId = '';
    let turns = 0;

    while (turns < maxTurns) {
      this.throwIfStopped(signal);

      let role: RoleDefinition | undefined;
      let trigger: 'user-mention' | 'ai-mention' | 'random';

      if (judgeFirst) {
        // 裁判选中的角色作为第一轮，后续再进入随机/AI @ 逻辑
        role = judgeFirst;
        judgeFirst = undefined;
        trigger = 'random';
      } else if (forced.length > 0) {
        role = forced.shift();
        trigger = 'ai-mention';
      } else if (pending.length > 0) {
        role = pending.shift();
        trigger = 'user-mention';
      } else if (!hasUserMentions && turns < randomTarget) {
        const candidates = roles.filter((item) => item.id !== lastRoleId);
        const pool = candidates.length > 0 ? candidates : roles;
        role = pool[Math.floor(Math.random() * pool.length)];
        trigger = 'random';
      } else {
        break;
      }

      if (!role) {
        break;
      }

      const status =
        trigger === 'user-mention'
          ? `${role.name} 被点名，正在回复…`
          : trigger === 'ai-mention'
            ? `${role.name} 被 @，正在接话…`
            : turns === 0
              ? `${role.name} 加入了群聊…`
              : `${role.name} 正在接话…`;

      const text = await this.speak(
        role,
        {
          ...base,
          contributions: chain.slice(),
          mode: 'casual',
          casualTrigger: trigger,
        },
        status,
      );

      chain.push({ role, text });
      lastRoleId = role.id;
      turns += 1;

      // AI 回复里出现 @角色名时，强制把这些角色排到下一次发言
      const mentioned = findMentionedRoles(text, roles).filter(
        (item) => item.id !== role.id,
      );
      for (const target of mentioned) {
        const pendingIndex = pending.findIndex((item) => item.id === target.id);
        if (pendingIndex >= 0) {
          pending.splice(pendingIndex, 1);
        }
        if (!forced.some((item) => item.id === target.id)) {
          forced.push(target);
        }
      }
    }
  }

  /**
   * 受 maxConcurrency 限制的并行执行。
   * 任意角色失败不会中断其他已启动角色；全部结束后抛出第一个错误。
   */
  private async runParallel(
    roles: RoleDefinition[],
    base: DiscussionContext,
  ): Promise<RoundContribution[]> {
    const signal = this.abortController?.signal;
    if (!signal) {
      throw createAbortError();
    }

    const limit = Math.min(Math.max(1, readMaxConcurrency()), roles.length);
    const outcomes: Array<{ role: RoleDefinition; text?: string; error?: unknown }> = new Array(
      roles.length,
    );
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= roles.length) {
          return;
        }

        const role = roles[index];
        if (this.stopRequested || signal.aborted) {
          outcomes[index] = { role, error: createAbortError() };
          continue;
        }

        try {
          const text = await this.speak(
            role,
            { ...base, contributions: base.contributions.slice() },
            `${role.name} 正在发言…`,
          );
          outcomes[index] = { role, text };
        } catch (error) {
          outcomes[index] = { role, error };
        }
      }
    };

    await Promise.all(Array.from({ length: limit }, () => worker()));

    const firstFailure = outcomes.find((outcome) => outcome.error !== undefined);
    if (firstFailure) {
      throw firstFailure.error;
    }

    return outcomes.map((outcome) => ({
      role: outcome.role,
      text: outcome.text ?? '',
    }));
  }

  /**
   * 让一个动态角色发言。
   * 每次请求都重新读取该角色当前绑定的 Provider/Model，并校验 System Prompt。
   */
  private async speak(
    role: RoleDefinition,
    context: DiscussionContext,
    status: string,
    options: { timeoutMs?: number; allowTools?: boolean; maxTokens?: number } = {},
  ): Promise<string> {
    const signal = this.abortController?.signal;
    if (!signal) {
      throw createAbortError();
    }
    if (signal.aborted) {
      throw createAbortError();
    }

    const demoMode = readDemoMode();
    const providerDefinition = readProviders().find((item) => item.id === role.providerId);

    let target: { provider: ProviderConfig; model: string; temperature: number } | undefined;
    if (!demoMode) {
      target = await prepareRoleTarget(this.context, role);
      if (signal.aborted) {
        throw createAbortError();
      }
    }

    const isSummary = context.mode === 'summary';
    const providerLabel = target?.provider.label ?? providerDefinition?.name ?? '演示模式';
    const modelLabel = target?.model ?? role.model ?? '';

    const entry: HistoryEntry = {
      id: this.nextId('a'),
      kind: 'assistant',
      text: '',
      time: Date.now(),
      roleId: role.id,
      roleName: isSummary ? `${role.name} · 汇总` : role.name,
      emoji: role.emoji,
      color: role.color,
      providerLabel,
      model: modelLabel,
      isSummary,
    };

    this.post({ type: 'assistant-start', entry });
    this.postStatus(status);

    let full = '';
    let stopped = false;
    let errorMessage: string | undefined;

    // 演示模式与真实请求共用同一份上下文；真实请求的 Token 估算在循环内逐次上报
    const messages = this.buildMessages(role, context);

    const onDelta = (delta: string): void => {
      full += delta;
      this.post({ type: 'assistant-delta', id: entry.id, delta });
    };

    try {
      if (demoMode) {
        this.updateTokenEstimate(messages);
        const demoText = buildDemoReply(role, {
          requirement: context.requirement,
          contributions: context.contributions,
          mode: context.mode,
        });
        full = await streamDemoText(demoText, signal, onDelta);
      } else {
        if (!target) {
          throw new TeamConfigError('内部错误：非演示模式缺少 Provider 配置。');
        }
        full = await this.runToolLoop(
          role,
          target,
          messages,
          signal,
          onDelta,
          entry.id,
          options,
        );

        if (!full.trim()) {
          throw new ApiError(
            '模型返回了空内容，可能触发了服务端内容过滤，或该模型不支持当前参数。请换个说法或检查角色绑定的模型。',
          );
        }
      }
    } catch (error) {
      if (this.stopRequested || isAbortError(error)) {
        stopped = true;
        throw error;
      }
      errorMessage = describeError(error);
      this.logErrorDetail(error);
      throw new RoleCallError(role, providerLabel, target?.provider.id ?? role.providerId, error);
    } finally {
      this.post({
        type: 'assistant-end',
        id: entry.id,
        stopped: stopped || undefined,
        error: errorMessage,
      });

      if (full.trim()) {
        const savedEntry: HistoryEntry = {
          ...entry,
          text: full,
          stopped: stopped || undefined,
          error: errorMessage,
        };
        this.history.push(savedEntry);
        this.persistHistoryEntry(savedEntry);
        this.lastActivityAt = Date.now();
      }
    }

    return full;
  }

  /** 异步追加到全局存储；失败只记日志，不打断本轮生成 */
  private persistHistoryEntry(entry: HistoryEntry): void {
    void saveMessage(this.context, historyToStored(entry)).catch((error: unknown) => {
      this.log(
        `[storage] 保存聊天记录失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  /**
   * 工具调用循环：
   *   请求 -> 如果有 tool_calls -> 委托 DSH 执行 -> 追加 assistant(tool_calls)
   *   + role='tool' 结果 -> 再请求 -> 直到没有 tool_calls 或达到轮次上限。
   *
   * 工具结果只进入本次请求的 messages，不写入群聊历史；最终答案才是历史的一部分。
   */
  private async runToolLoop(
    role: RoleDefinition,
    target: { provider: ProviderConfig; model: string; temperature: number },
    baseMessages: ChatMessage[],
    signal: AbortSignal,
    onDelta: (delta: string) => void,
    assistantMessageId: string,
    options: { timeoutMs?: number; allowTools?: boolean; maxTokens?: number } = {},
  ): Promise<string> {
    // DSH 外包工具仅在「用户开关开启 + 工作区已受信任」时启用
    const toolsEnabled = getConfig<boolean>('enableTools', true);
    const tools =
      toolsEnabled && vscode.workspace.isTrusted && options.allowTools !== false
        ? TOOL_DEFINITIONS
        : undefined;

    const conversation = baseMessages.map((message) => ({ ...message }));
    let text = '';

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      this.throwIfStopped(signal);
      this.updateTokenEstimate(conversation, tools);

      const startedAt = Date.now();
      const result = await streamChatCompletion({
        provider: target.provider,
        model: target.model,
        messages: conversation,
        tools,
        temperature: target.temperature,
        maxTokens: options.maxTokens ?? getConfig<number>('maxTokens', 1200),
        timeoutMs:
          options.timeoutMs ?? getConfig<number>('requestTimeoutMs', 90_000),
        signal,
        onDelta: (delta) => {
          text += delta;
          onDelta(delta);
        },
      });

      this.log(
        `[${new Date().toISOString()}] → ${role.name} | ${target.provider.label}/${target.model} | round=${round + 1} | ${conversation.length} 条消息 | tool_calls=${result.toolCalls.length} | ${Date.now() - startedAt} ms`,
      );

      if (result.toolCalls.length === 0) {
        return text;
      }

      if (round === MAX_TOOL_ROUNDS) {
        throw new ApiError(
          `工具调用超过 ${MAX_TOOL_ROUNDS} 轮，已停止本轮生成。请缩小需求范围或拆分任务。`,
        );
      }

      // 把模型这轮的 tool_calls 原样追加，供下一次请求使用
      conversation.push({
        role: 'assistant',
        content: result.text,
        tool_calls: result.toolCalls,
      });

      for (const toolCall of result.toolCalls) {
        this.throwIfStopped(signal);

        const preview = describeToolCall(toolCall);
        const cardId = this.nextId('tool');
        this.post({
          type: 'tool-call-start',
          id: cardId,
          messageId: assistantMessageId,
          toolName: toolCall.function.name,
          title: preview.startText,
        });
        this.postStatus(`正在委托 DSH：${preview.taskSummary || '任务'}…`);

        let execution: ToolExecutionResult;
        try {
          if (!tools) {
            execution = buildDelegationFailure(
              preview.task,
              'DSH 外包工具已禁用（enableTools=false 或工作区未受信任）。',
            );
          } else if (toolCall.function.name !== DELEGATE_TOOL_NAME) {
            execution = buildDelegationFailure(
              preview.task,
              `未知工具「${toolCall.function.name || 'unknown'}」。可用工具只有 ${DELEGATE_TOOL_NAME}。`,
            );
          } else if (!preview.task) {
            execution = buildDelegationFailure(
              '',
              'delegate_task_to_dsh 缺少非空 task 参数。',
            );
          } else {
            const outcome = await this.delegateTaskToDsh(
              preview.task,
              signal,
              (status) => {
                this.post({
                  type: 'tool-call-progress',
                  id: cardId,
                  title: `🛰️ DSH ${formatDshStatus(status)}: ${preview.taskSummary}...`,
                });
              },
            );
            execution = outcome.ok
              ? buildDelegationSuccess(preview.task, outcome.text ?? '')
              : buildDelegationFailure(preview.task, outcome.error ?? '未知错误');
          }
        } catch (error) {
          if (this.stopRequested || isAbortError(error)) {
            this.post({
              type: 'tool-call-end',
              id: cardId,
              ok: false,
              title: `⏹️ 已停止 DSH 委托: ${preview.taskSummary || '任务'}`,
              content: '用户停止了本轮生成。',
            });
            throw error;
          }
          execution = buildDelegationFailure(
            preview.task,
            error instanceof Error ? error.message : String(error),
          );
        }

        if (this.stopRequested || signal.aborted) {
          this.post({
            type: 'tool-call-end',
            id: cardId,
            ok: false,
            title: `⏹️ 已停止 DSH 委托: ${preview.taskSummary || '任务'}`,
            content: '用户停止了本轮生成。',
          });
          throw createAbortError();
        }

        conversation.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: execution.modelContent,
        });

        this.post({
          type: 'tool-call-end',
          id: cardId,
          ok: execution.ok,
          title: execution.title,
          content: execution.preview,
          charCount: execution.charCount,
          truncated: execution.truncated,
        });

        this.log(
          `[${new Date().toISOString()}] [tool] ${toolCall.function.name} ${execution.ok ? 'ok' : 'fail'} target=${execution.target || preview.taskSummary} content=${execution.modelContent.length} chars`,
        );
      }

      this.postStatus(`${role.name} 正在继续生成…`);
    }

    throw new ApiError(
      `工具调用超过 ${MAX_TOOL_ROUNDS} 轮，已停止本轮生成。请缩小需求范围或拆分任务。`,
    );
  }

  /**
   * 把任务提交给本地 DSH，并轮询 /x/headless/status 直到完成。
   *
   * 提交：POST http://127.0.0.1:3080/x/headless  { task, cwd }
   * 状态：GET  http://127.0.0.1:3080/x/headless/status?sessionId=...&requestId=...&afterSeq=...
   */
  private async delegateTaskToDsh(
    task: string,
    signal: AbortSignal,
    onStatus: (status: string) => void,
  ): Promise<DshOutcome> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    let submitted;
    try {
      submitted = await fetchDshJson(
        DSH_SUBMIT_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ task, cwd }),
        },
        DSH_SUBMIT_TIMEOUT_MS,
        signal,
      );
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (!submitted.ok) {
      return {
        ok: false,
        error: describeDshHttpError('提交 DSH 任务', submitted.status, submitted.raw),
      };
    }

    const submitData = isRecord(submitted.data) ? submitted.data : undefined;
    if (!submitData) {
      const rawText = submitted.raw.trim();
      return rawText
        ? { ok: true, text: rawText }
        : { ok: false, error: 'DSH 提交接口返回了空响应。' };
    }

    if (submitData.ok === false) {
      const reason = typeof submitData.error === 'string' ? submitData.error : '未知错误';
      return { ok: false, error: `DSH 拒绝了任务：${reason}` };
    }

    // 兼容同步返回最终结果的实现
    if (
      submitData.status === 'completed' &&
      typeof submitData.text === 'string'
    ) {
      return { ok: true, text: submitData.text };
    }

    const sessionId =
      typeof submitData.sessionId === 'string' ? submitData.sessionId.trim() : '';
    if (!sessionId) {
      const text = typeof submitData.text === 'string' ? submitData.text.trim() : '';
      if (text) {
        return { ok: true, text };
      }
      return {
        ok: false,
        error:
          'DSH 提交成功但没有返回 sessionId，无法轮询任务状态。请确认 dsh-web-submit 插件为新版并重启 Web 服务。',
      };
    }

    const requestId =
      typeof submitData.requestId === 'string' ? submitData.requestId : '';
    const baselineSeq =
      typeof submitData.baselineSeq === 'number' && Number.isInteger(submitData.baselineSeq)
        ? submitData.baselineSeq
        : undefined;

    const statusUrl = new URL(DSH_STATUS_URL);
    statusUrl.searchParams.set('sessionId', sessionId);
    if (requestId) {
      statusUrl.searchParams.set('requestId', requestId);
    }
    if (baselineSeq !== undefined) {
      statusUrl.searchParams.set('afterSeq', String(baselineSeq));
    }

    const deadline = Date.now() + DSH_POLL_TIMEOUT_MS;
    let lastStatus = '';
    let lastText = '';

    for (;;) {
      this.throwIfStopped(signal);

      if (Date.now() >= deadline) {
        return {
          ok: false,
          error: `等待 DSH 任务完成超时（5 分钟）。任务可能仍在运行，sessionId：${sessionId}`,
          sessionId,
        };
      }

      let statusResponse;
      try {
        statusResponse = await fetchDshJson(
          statusUrl.toString(),
          { headers: { Accept: 'application/json' } },
          DSH_STATUS_TIMEOUT_MS,
          signal,
        );
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        };
      }

      if (!statusResponse.ok) {
        return {
          ok: false,
          error: describeDshHttpError(
            '查询 DSH 任务状态',
            statusResponse.status,
            statusResponse.raw,
          ),
          sessionId,
        };
      }

      const data = isRecord(statusResponse.data) ? statusResponse.data : undefined;
      if (!data) {
        return {
          ok: false,
          error: 'DSH 状态接口返回了无法解析的数据。',
          sessionId,
        };
      }
      if (data.ok === false) {
        const reason = typeof data.error === 'string' ? data.error : '未知错误';
        return {
          ok: false,
          error: `DSH 状态查询失败：${reason}`,
          sessionId,
        };
      }

      const status = typeof data.status === 'string' ? data.status : 'unknown';
      if (status !== lastStatus) {
        lastStatus = status;
        onStatus(status);
      }

      const text = typeof data.text === 'string' ? data.text.trim() : '';
      if (text) {
        lastText = text;
      }

      if (status === 'completed') {
        return {
          ok: true,
          text: text || lastText || '（DSH 已完成，但没有返回文本）',
          sessionId,
        };
      }

      if (status === 'failed') {
        const reason = typeof data.error === 'string' ? data.error : '未知原因';
        return {
          ok: false,
          error: `DSH 回合失败（${reason}）${
            text ? `\n\n已产生的输出：\n${text}` : ''
          }`,
          sessionId,
        };
      }

      await delay(DSH_POLL_INTERVAL_MS, signal);
    }
  }

  /**
   * 组装 messages。
   * system prompt 永远来自当前角色的配置；其余上下文以带标签的 user 内容传入，
   * 避免把其他角色的发言误当成“自己说过的话”。
   */
  private buildMessages(role: RoleDefinition, context: DiscussionContext): ChatMessage[] {
    const systemBase =
      context.mode === 'summary'
        ? `${role.prompt}\n\n---\n${SUMMARY_INSTRUCTION}`
        : role.prompt;
    let system = systemBase;
    if (context.mode === 'casual' || context.mode === 'heartbeat') {
      system += `\n\n${CASUAL_SYSTEM_SUFFIX}`;

      // 告诉模型群里有哪些真实角色名，避免它 @ 出不存在的专家
      const memberNames = readRoles()
        .filter((item) => item.enabled)
        .map((item) => item.name.trim())
        .filter(Boolean);
      if (memberNames.length > 0) {
        system += `\n\n群成员：${memberNames.join('、')}。`;
      }

      if (context.mode === 'casual' && context.casualTrigger === 'ai-mention') {
        // AI 互相 @：下一个发言者被强制点名
        system += '\n\n群友刚刚@了你，请你回应他。';
      } else if (context.mode === 'casual' && context.casualTrigger === 'user-mention') {
        system += '\n\n用户刚刚@了你，请你回应他。';
      } else if (context.mode === 'casual' && context.contributions.length > 0) {
        // 普通随机接话
        system += `\n\n${CASUAL_REPLY_INSTRUCTION}`;
      }
    }

    const blocks: string[] = [];
    const priorText = formatHistory(context.prior, getConfig<number>('maxContextChars', 6000));

    if (priorText) {
      blocks.push(`【此前的讨论记录（仅供参考，不要逐字复述）】\n${priorText}`);
    }
    if (context.mode === 'heartbeat') {
      blocks.push(
        `【群聊已冷场】\n你是群里的「${role.name}」。` +
          '群里已经冷场很久了，请找个轻松的话题（比如IT八卦、吐槽、甚至中午吃什么）' +
          '主动挑头开聊，字数简短，像真人一样。',
      );
    } else {
      blocks.push(
        context.mode === 'casual'
          ? `【用户刚才在群里说】\n${context.requirement}`
          : `【用户本轮需求】\n${context.requirement}`,
      );
    }

    if (context.mode === 'casual') {
      if (context.contributions.length > 0) {
        blocks.push(
          `【本轮接龙记录】\n${context.contributions
            .map((item) => `【${item.role.name}】\n${item.text}`)
            .join('\n\n')}`,
        );
        const target = context.contributions[context.contributions.length - 1];
        blocks.push(`你正在回复的群友是「${target.role.name}」。`);
      }

      if (context.casualTrigger === 'ai-mention') {
        blocks.push('请优先回应刚刚 @ 你的群友。');
      } else if (context.casualTrigger === 'user-mention') {
        blocks.push('请优先回应用户的点名。');
      } else if (context.contributions.length > 0) {
        blocks.push(CASUAL_REPLY_INSTRUCTION);
      } else {
        blocks.push(
          '你是被随机点到、第一个发言的群友。请像网友一样回复用户上面的话，可以赞同、反驳或吐槽。',
        );
      }
    } else if (context.mode !== 'heartbeat') {
      if (context.contributions.length > 0) {
        blocks.push(
          `【本轮已有发言】\n${context.contributions
            .map((item) => `【${item.role.name}】\n${item.text}`)
            .join('\n\n')}`,
        );
      }

      if (context.mode === 'summary') {
        blocks.push('请按照 system prompt 中的“汇总任务”输出最终汇总。');
      } else {
        blocks.push(
          `你是「${role.name}」。请直接输出你的发言，不要复述别人已经说过的内容。`,
        );
      }
    }

    const messages: ChatMessage[] = [{ role: 'system', content: system }];

    // 被滑出窗口的旧消息压缩成的会议摘要：system 消息，放在角色 prompt 之后
    if (context.historySummary) {
      messages.push({
        role: 'system',
        content: `【会议摘要】\n${context.historySummary}`,
      });
    }

    messages.push({ role: 'user', content: blocks.join('\n\n') });
    return messages;
  }

  private throwIfStopped(signal: AbortSignal): void {
    if (this.stopRequested || signal.aborted) {
      throw createAbortError();
    }
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.seq}`;
  }

  // ---------------------------------------------------------------------------
  // 错误 / 提示
  // ---------------------------------------------------------------------------

  private notify(level: NoticeLevel, text: string, actions?: NoticeAction[]): void {
    this.post({ type: 'notice', level, text, actions });
  }

  private reportError(error: unknown): void {
    const message = describeError(error);
    this.logErrorDetail(error);

    const actions: NoticeAction[] = [];
    const missingKey =
      error instanceof MissingApiKeyError
        ? error
        : error instanceof RoleCallError && error.cause instanceof MissingApiKeyError
          ? error.cause
          : undefined;

    if (missingKey) {
      actions.push({
        label: '设置 API Key',
        command: 'setApiKey',
        providerId: missingKey.providerId,
      });
      actions.push({ label: '打开团队设置', command: 'openTeamSettings' });
    } else if (
      error instanceof RoleCallError &&
      error.cause instanceof ApiError &&
      error.cause.status === 401
    ) {
      actions.push({
        label: '设置 API Key',
        command: 'setApiKey',
        providerId: error.providerId,
      });
      actions.push({ label: '打开团队设置', command: 'openTeamSettings' });
    } else if (
      error instanceof TeamConfigError ||
      error instanceof RoleCallError ||
      (error instanceof ApiError && (error.status === 400 || error.status === 404))
    ) {
      actions.push({ label: '打开团队设置', command: 'openTeamSettings' });
    }

    this.notify('error', message, actions.length > 0 ? actions : undefined);
  }

  private logErrorDetail(error: unknown): void {
    const cause = error instanceof RoleCallError ? error.cause : error;
    const detail = cause instanceof ApiError ? cause.detail : undefined;
    this.log(
      `[${new Date().toISOString()}] [error] ${describeError(error)}${detail ? `\n[api-detail] ${detail}` : ''}`,
    );
  }
}

// -----------------------------------------------------------------------------
// 纯函数 / 工具
// -----------------------------------------------------------------------------

interface DshFetchResult {
  ok: boolean;
  status: number;
  data: unknown;
  raw: string;
}

/** 带超时 + 外部中止的 fetch JSON 请求 */
async function fetchDshJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<DshFetchResult> {
  if (signal.aborted) {
    throw createAbortError();
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();
  signal.addEventListener('abort', forwardAbort, { once: true });

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const raw = await response.text();
    let data: unknown;
    try {
      data = raw.trim() ? JSON.parse(raw) : undefined;
    } catch {
      data = undefined;
    }
    return {
      ok: response.ok,
      status: response.status,
      data,
      raw,
    };
  } catch (error) {
    if (signal.aborted) {
      throw createAbortError();
    }
    if (timedOut) {
      throw new Error(`请求 DSH 超时（${timeoutMs}ms）。`);
    }
    throw new Error(
      `无法连接 DSH（${url}）：${
        error instanceof Error ? error.message : String(error)
      }。请确认 DSH Web 服务正在运行。`,
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', forwardAbort);
  }
}

function describeDshHttpError(action: string, status: number, raw: string): string {
  const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 400);

  if (status === 404 || status === 405) {
    return (
      `${action}失败（HTTP ${status}）：DSH 接口不存在。` +
      '请确认 DSH Web 服务正在运行，并已安装带 /x/headless/status 的新版 dsh-web-submit 插件。' +
      (snippet ? `响应：${snippet}` : '')
    );
  }
  if (status === 401 || status === 403) {
    return `${action}失败（HTTP ${status}）：DSH 拒绝了访问，请检查本地鉴权配置。${snippet ? `响应：${snippet}` : ''}`;
  }
  if (status === 413) {
    return `${action}失败（HTTP 413）：任务描述超过 DSH 请求体上限，请缩小任务范围。`;
  }
  return `${action}失败（HTTP ${status}）：${snippet || '空响应'}`;
}

function formatDshStatus(status: string): string {
  switch (status) {
    case 'pending':
      return '排队中';
    case 'running':
      return '处理中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'unknown':
      return '等待状态';
    default:
      return status || '处理中';
  }
}

/** 可被 AbortSignal 取消的 sleep */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(createAbortError());
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 顶部成员卡片：只展示当前启用的角色，完全由配置生成 */
function buildMembers(): MemberInfo[] {
  const providers = new Map(readProviders().map((provider) => [provider.id, provider]));

  return readRoles()
    .filter((role) => role.enabled)
    .map((role) => {
      const provider = providers.get(role.providerId);
      return {
        id: role.id,
        name: role.name,
        emoji: role.emoji,
        color: role.color,
        providerLabel: provider?.name ?? (role.providerId || '未绑定提供商'),
        model: role.model || '未配置模型',
      };
    });
}

/**
 * 历史记录 -> 带说话人标签的纯文本。
 * 从最近的消息往前累加，超出预算就丢弃更早的内容。
 */
function formatHistory(entries: HistoryEntry[], budgetChars: number): string {
  if (entries.length === 0) {
    return '';
  }

  const lines = sortHistory(entries).map((entry) => {
    const text = entry.text.length > 2000 ? `${entry.text.slice(0, 2000)}…` : entry.text;
    const speaker = entry.kind === 'user' ? '用户' : (entry.roleName ?? 'AI');
    return `${speaker}：${text.trim()}`;
  });

  const picked: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (picked.length > 0 && used + line.length > budgetChars) {
      break;
    }
    picked.unshift(line);
    used += line.length + 1;
  }

  return picked.join('\n\n');
}

/** 按开始时间排序，避免并行发言的完成顺序影响重放/上下文顺序 */
function historyToStored(entry: HistoryEntry): StoredMessage {
  if (entry.kind === 'user') {
    return {
      role: 'user',
      content: entry.text,
      timestamp: entry.time,
    };
  }

  return {
    role: 'assistant',
    content: entry.text,
    timestamp: entry.time,
    roleId: entry.roleId,
    roleName: entry.roleName,
    emoji: entry.emoji,
    color: entry.color,
    providerLabel: entry.providerLabel,
    model: entry.model,
    isSummary: entry.isSummary,
    stopped: entry.stopped,
    error: entry.error,
  };
}

function storedToHistory(
  message: StoredMessage,
  index: number,
  roles: RoleDefinition[],
): HistoryEntry {
  const id = `history-${message.role}-${Math.trunc(message.timestamp).toString(36)}-${index}`;

  if (message.role === 'user') {
    return {
      id,
      kind: 'user',
      text: message.content,
      time: message.timestamp,
    };
  }

  const currentRole = message.roleId
    ? roles.find((role) => role.id === message.roleId)
    : undefined;
  const roleName = currentRole
    ? message.isSummary
      ? `${currentRole.name} · 汇总`
      : currentRole.name
    : message.roleName || 'AI';

  return {
    id,
    kind: 'assistant',
    text: message.content,
    time: message.timestamp,
    roleId: message.roleId,
    roleName,
    emoji: currentRole?.emoji ?? message.emoji ?? '🤖',
    color: currentRole?.color ?? message.color,
    providerLabel: message.providerLabel,
    model: message.model,
    isSummary: message.isSummary,
    stopped: message.stopped,
    error: message.error,
  };
}

function extractJudgeText(value: unknown): string {
  if (!isRecord(value)) {
    return '';
  }

  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return '';
  }

  const choice = choices[0];
  if (!isRecord(choice)) {
    return '';
  }

  const message = choice.message;
  if (isRecord(message)) {
    const content = message.content;
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
        .join('');
    }
  }

  return typeof choice.text === 'string' ? choice.text : '';
}

/**
 * 从文本中解析 @角色名。
 * 角色名按长度倒序参与正则，保证「前端专家」不会被「前端」抢先匹配。
 */
function findMentionedRoles(text: string, roles: RoleDefinition[]): RoleDefinition[] {
  if (!text || roles.length === 0) {
    return [];
  }

  const candidates = roles
    .map((role) => ({ role, name: role.name.trim() }))
    .filter((item) => item.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length);

  if (candidates.length === 0) {
    return [];
  }

  const regex = new RegExp(
    `@(${candidates.map((item) => escapeRegExp(item.name)).join('|')})`,
    'g',
  );
  const seen = new Set<string>();
  const result: RoleDefinition[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const found = candidates.find((item) => item.name === match?.[1]);
    if (found && !seen.has(found.role.id)) {
      seen.add(found.role.id);
      result.push(found.role);
    }
  }

  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sortHistory(entries: HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => a.time - b.time);
}

/** 本地摘要兜底：API 摘要失败 / 演示模式时使用，仍然保证 ≤ 200 字 */
function buildFallbackSummary(entries: HistoryEntry[], existingSummary: string): string {
  const transcript = formatHistory(entries, 1200).replace(/\s+/g, ' ').trim();
  const parts = [existingSummary, transcript].filter(Boolean);
  if (parts.length === 0) {
    return '（较早的讨论内容）';
  }
  return truncateText(parts.join(' '), MAX_SUMMARY_CHARS);
}

/** 按 Unicode 字符截断，避免把 emoji 劈开 */
function truncateText(text: string, maxChars: number): string {
  const characters = Array.from(text.trim());
  if (characters.length <= maxChars) {
    return characters.join('');
  }
  return characters.slice(0, Math.max(1, maxChars - 1)).join('') + '…';
}

/** 把任意异常翻译成能直接展示的中文文案 */
function describeError(error: unknown): string {
  if (error instanceof MissingApiKeyError) {
    return `提供商「${error.providerLabel}」还没有配置 API Key。点击下方「设置 API Key」，或打开团队设置检查 Provider。`;
  }
  if (error instanceof TeamConfigError) {
    return error.message;
  }
  if (error instanceof RoleCallError) {
    return `【${error.role.name} · ${error.providerLabel}】${describeError(error.cause)}`;
  }
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message || '未知错误。';
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
