/**
 * 极简的 OpenAI 兼容客户端。
 *
 * 只做一件事：调用 `POST {baseUrl}/chat/completions`，以流式（SSE）方式读取
 * `choices[0].delta.content`，通过 onDelta 回调实时抛给上层。
 *
 * 之所以不引第三方 SDK：
 *   - VS Code 扩展宿主自带 Node 18+，fetch 可直接用；
 *   - 少一个依赖，打包体积和供应链风险都更小；
 *   - SSE 解析逻辑可控，能自行处理超时、断流、非流式兜底。
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** 模型返回的一次工具调用（已把流式分片拼成完整参数） */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** 传给 OpenAI 兼容接口的 tools 定义 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  /** role='tool' 时对应 assistant tool_calls 里的 id */
  tool_call_id?: string;
  /** role='assistant' 时记录本轮请求执行了哪些工具 */
  tool_calls?: ToolCall[];
}

/** 一次流式请求的完整结果 */
export interface StreamChatResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason?: string;
}

/** 解析完设置后的服务商信息（含真实 API Key） */
export interface ProviderConfig {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly apiKey: string;
}

export interface StreamChatOptions {
  readonly provider: ProviderConfig;
  /** 模型 ID 由角色配置提供，不再属于 Provider */
  readonly model: string;
  readonly messages: ChatMessage[];
  /** 采样温度，0 ~ 2；调用方应优先传角色 temperature，未传时回退 0.7 */
  readonly temperature?: number;
  /** 单次回复最大 token 数 */
  readonly maxTokens: number;
  /** 连接超时 + 流式空闲超时，单位 ms */
  readonly timeoutMs: number;
  /** 用于「停止生成」的中止信号 */
  readonly signal: AbortSignal;
  /** 每收到一段增量文本就回调一次（检测到 tool_calls 后停止文本回调） */
  readonly onDelta: (delta: string) => void;
  /** 工具定义；不传则不启用工具调用 */
  readonly tools?: ToolDefinition[];
}

/** 通用 API 错误，message 已经是可直接展示给用户的中文描述 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** 原始响应片段，便于在输出面板里排查 */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 没有配置 API Key 时抛出，方便 UI 精准地提示“去设置 Key” */
export class MissingApiKeyError extends Error {
  constructor(
    readonly providerId: string,
    readonly providerLabel: string,
  ) {
    super(`提供商「${providerLabel}」还没有配置 API Key。`);
    this.name = 'MissingApiKeyError';
  }
}

/** 生成一个 name 为 AbortError 的错误，用来表示“用户主动停止” */
export function createAbortError(message = '已取消'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function normalizeRequestTemperature(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0.7;
  }
  return Math.min(2, Math.max(0, value));
}

/**
 * 把 BaseURL 解析成最终的 /chat/completions 地址。
 *
 * 允许用户把 BaseURL 配成：
 *   - https://api.deepseek.com/v1
 *   - https://api.deepseek.com/v1/
 *   - https://api.deepseek.com/v1/chat/completions（完整路径）
 *   - https://api.deepseek.com/v1/chat/completions/（带尾斜杠）
 *
 * 同时做两件防呆：
 *   - 折叠误配置产生的重复 /v1/v1、/chat/completions/chat/completions；
 *   - 保留 URL 上的 query 参数（有些兼容网关需要 api-version 之类）。
 */
export function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ApiError(`BaseURL 不是合法的 URL：${baseUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError(`BaseURL 只支持 http/https：${baseUrl}`);
  }

  url.hash = '';
  let path = url.pathname.replace(/\/+$/, '');
  path = path
    .replace(/(\/v1)(?:\/v1)+(?=\/|$)/gi, '$1')
    .replace(/(\/chat\/completions)(?:\/chat\/completions)+(?=\/|$)/gi, '$1');

  if (!/\/chat\/completions$/i.test(path)) {
    path = `${path}/chat/completions`;
  }

  url.pathname = path || '/chat/completions';
  return url.toString();
}

/**
 * 主入口：发送对话并流式读取回复 / tool_calls。
 *
 * tool_calls 的分片会先累积成完整参数；一旦发现 tool_calls，后续 content 不再
 * 回调/计入返回文本（已有文本保留）。调用方拿到 toolCalls 后执行工具，并把
 * assistant(tool_calls) + tool(result) 消息追加进 messages 再次调用。
 */
export async function streamChatCompletion(
  options: StreamChatOptions,
): Promise<StreamChatResult> {
  const {
    provider,
    model,
    messages,
    temperature,
    maxTokens,
    timeoutMs,
    signal,
    onDelta,
    tools,
  } = options;

  if (!provider.apiKey) {
    throw new MissingApiKeyError(provider.id, provider.label);
  }

  // 在建立请求资源之前解析，BaseURL 非法时直接报错，不留下监听器/定时器
  const endpoint = buildChatCompletionsUrl(provider.baseUrl);

  // 用一个内部 controller 同时承接三件事：
  //   1. 用户点击“停止” -> 外部 signal abort -> 转发给内部
  //   2. 连接/读取超时 -> 内部 abort
  //   3. fetch / reader 自身错误
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const armTimeout = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1000, timeoutMs));
  };
  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const forwardAbort = (): void => controller.abort();

  if (signal.aborted) {
    throw createAbortError();
  }
  signal.addEventListener('abort', forwardAbort, { once: true });

  try {
    armTimeout();

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 声明期望 SSE；部分网关会据此决定是否流式返回
          Accept: 'text/event-stream',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          temperature: normalizeRequestTemperature(temperature),
          max_tokens: maxTokens,
          ...(tools && tools.length > 0 ? { tools } : {}),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new ApiError(`连接 ${provider.label} 超时（${timeoutMs} ms），请检查网络或代理设置。`);
      }
      if (signal.aborted) {
        throw createAbortError();
      }
      throw new ApiError(describeNetworkError(error, provider));
    }

    clearTimer();

    if (!response.ok) {
      // 读取错误详情也要有超时，避免服务端只发响应头后卡住
      armTimeout();
      const detail = await safeReadText(response);
      clearTimer();
      throw new ApiError(
        describeHttpError(
          response.status,
          detail,
          provider,
          model,
          endpoint,
          Boolean(tools && tools.length > 0),
        ),
        response.status,
        detail.slice(0, 2000),
      );
    }

    if (!response.body) {
      throw new ApiError(`服务商「${provider.label}」返回了空响应体。`);
    }

    const contentType = response.headers.get('content-type') ?? '';

    // 兜底：有些网关会忽略 stream 参数，直接返回一整段 JSON。
    // 此时按非流式解析，一次性把内容抛给 UI。
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      let raw: string;
      try {
        armTimeout();
        raw = await response.text();
        clearTimer();
      } catch (error) {
        clearTimer();
        if (timedOut) {
          throw new ApiError(`读取「${provider.label}」响应超时（${timeoutMs} ms），请稍后重试。`);
        }
        if (signal.aborted) {
          throw createAbortError();
        }
        throw new ApiError(describeNetworkError(error, provider));
      }

      const parsed = parseNonStreamResponse(raw);
      if (!parsed.text && parsed.toolCalls.length === 0) {
        throw new ApiError(
          `无法解析「${provider.label}」的响应：既不是 SSE 流，也不是标准的 chat.completion JSON。`,
          undefined,
          raw.slice(0, 2000),
        );
      }
      if (parsed.text) {
        onDelta(parsed.text);
      }
      return parsed;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    const streamState: SseStreamState = {
      sawToolCall: false,
      toolCalls: new Map(),
    };

    try {
      while (true) {
        // 每等待一段数据就重新计时（流式空闲超时）
        armTimeout();
        const { done, value } = await reader.read();
        clearTimer();

        if (done) {
          break;
        }

        // \r\n / \r 统一成 \n，避免 SSE 事件分隔符跨 chunk 时匹配不到
        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');

        // SSE：事件之间用空行分隔
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const eventText = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = consumeSseEvent(eventText, streamState, onDelta);
          fullText += parsed.text;
          if (parsed.error) {
            throw parsed.error;
          }
          boundary = buffer.indexOf('\n\n');
        }
      }

      // 处理最后一个没有以空行结尾的事件
      buffer += decoder.decode().replace(/\r/g, '');
      if (buffer.trim()) {
        const parsed = consumeSseEvent(buffer, streamState, onDelta);
        fullText += parsed.text;
        if (parsed.error) {
          throw parsed.error;
        }
      }
    } catch (error) {
      if (timedOut) {
        throw new ApiError(`等待「${provider.label}」返回数据超时（${timeoutMs} ms 内没有新数据）。`);
      }
      if (signal.aborted) {
        throw createAbortError();
      }
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError(describeNetworkError(error, provider));
    } finally {
      clearTimer();
      try {
        // 不再需要读取：释放锁即可；若底层连接仍在，由 fetch/GC 处理
        reader.releaseLock();
      } catch {
        // 忽略：连接可能已经被 abort 掉了
      }
    }

    return {
      text: fullText,
      toolCalls: finalizeToolCalls(streamState),
      finishReason: streamState.finishReason,
    };
  } finally {
    clearTimer();
    signal.removeEventListener('abort', forwardAbort);
  }
}

interface ToolCallAccumulator {
  id?: string;
  name: string;
  arguments: string;
}

interface SseStreamState {
  sawToolCall: boolean;
  /** key = tool_calls[].index，用于把流式分片拼成完整调用 */
  toolCalls: Map<number, ToolCallAccumulator>;
  finishReason?: string;
}

interface SseParseResult {
  text: string;
  error?: ApiError;
}

/**
 * 解析一个 SSE 事件块（可能包含多行 data:）。
 *
 * tool_calls 的 name/arguments 会分多个 chunk 到达，因此只做累积，不在这里执行；
 * 一旦检测到 tool_calls，就不再继续回调文本（已有的文本保留）。
 */
function consumeSseEvent(
  rawEvent: string,
  state: SseStreamState,
  onDelta: (delta: string) => void,
): SseParseResult {
  let text = '';
  let error: ApiError | undefined;

  for (const rawLine of rawEvent.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) {
      // 忽略注释行（如 `: ping`）和 event:/id: 行
      continue;
    }

    const payload = line.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') {
      continue;
    }

    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      // 流式过程中可能拿到被截断的 JSON，跳过即可，下一段会补全
      continue;
    }

    const finishReason = readFinishReason(json);
    if (finishReason) {
      state.finishReason = finishReason;
    }

    // 先处理 tool_calls：一旦出现，当前事件及后续事件的 content 都不再输出
    const toolCallDeltas = readToolCallDeltas(json);
    if (toolCallDeltas && toolCallDeltas.length > 0) {
      state.sawToolCall = true;
      toolCallDeltas.forEach((rawToolCall, position) => {
        mergeToolCallDelta(state, rawToolCall, position);
      });
    }

    // 文本在检测到 tool_calls 之前照常输出
    const delta = readDeltaContent(json);
    if (delta && !state.sawToolCall) {
      text += delta;
      onDelta(delta);
    }

    const streamError = readStreamError(json);
    if (streamError) {
      error = new ApiError(streamError);
    }
  }

  return { text, error };
}

/** 从 delta.tool_calls（或非流式 message.tool_calls）里取出原始工具调用数组 */
function readToolCallDeltas(json: unknown): unknown[] | undefined {
  if (!isRecord(json)) {
    return undefined;
  }
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }
  const first = choices[0];
  if (!isRecord(first)) {
    return undefined;
  }

  const delta = first.delta;
  if (isRecord(delta) && Array.isArray(delta.tool_calls)) {
    return delta.tool_calls;
  }

  // 部分网关在 SSE 里直接返回完整 message.tool_calls
  const message = first.message;
  if (isRecord(message) && Array.isArray(message.tool_calls)) {
    return message.tool_calls;
  }

  return undefined;
}

/** 合并一个 tool_call 分片（id / 函数名 / 参数字符串都可能分片到达） */
function mergeToolCallDelta(
  state: SseStreamState,
  rawToolCall: unknown,
  fallbackIndex: number,
): void {
  if (!isRecord(rawToolCall)) {
    return;
  }

  const index =
    typeof rawToolCall.index === 'number' ? rawToolCall.index : fallbackIndex;
  const existing = state.toolCalls.get(index) ?? { name: '', arguments: '' };

  if (typeof rawToolCall.id === 'string' && rawToolCall.id) {
    existing.id = rawToolCall.id;
  }

  const fn = rawToolCall.function;
  if (isRecord(fn)) {
    if (typeof fn.name === 'string' && fn.name) {
      existing.name += fn.name;
    }
    if (typeof fn.arguments === 'string') {
      existing.arguments += fn.arguments;
    }
  }

  state.toolCalls.set(index, existing);
}

/** 把累积的 tool_calls 按 index 排序并生成最终结构 */
function finalizeToolCalls(state: SseStreamState): ToolCall[] {
  return Array.from(state.toolCalls.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([index, accumulator]): ToolCall => ({
      id: accumulator.id || `tool_call_${index}_${Date.now().toString(36)}`,
      type: 'function',
      function: {
        name: accumulator.name.trim(),
        arguments: accumulator.arguments || '{}',
      },
    }))
    .filter((call) => call.function.name.length > 0);
}

function readFinishReason(json: unknown): string {
  if (!isRecord(json)) {
    return '';
  }
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return '';
  }
  const first = choices[0];
  if (!isRecord(first)) {
    return '';
  }
  return typeof first.finish_reason === 'string' ? first.finish_reason : '';
}

/** 从 choices[0].delta.content 里取增量文本（兼容非流式 message.content / text） */
function readDeltaContent(json: unknown): string {
  if (!isRecord(json)) {
    return '';
  }
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return '';
  }
  const first = choices[0];
  if (!isRecord(first)) {
    return '';
  }

  const delta = first.delta;
  if (isRecord(delta) && typeof delta.content === 'string') {
    return delta.content;
  }

  // 非流式格式：choices[0].message.content
  const message = first.message;
  if (isRecord(message) && typeof message.content === 'string') {
    return message.content;
  }

  // 部分兼容实现会返回 choices[0].text
  if (typeof first.text === 'string') {
    return first.text;
  }

  return '';
}

/** 有些网关会把错误放进流里：{ "error": { "message": "..." } } */
function readStreamError(json: unknown): string {
  if (!isRecord(json)) {
    return '';
  }
  const error = json.error;
  if (isRecord(error)) {
    const message = typeof error.message === 'string' ? error.message : '';
    const code = typeof error.code === 'string' ? error.code : '';
    const detail = message || code;
    return detail ? `服务端在流中返回错误：${detail}` : '';
  }
  if (typeof error === 'string' && error.trim()) {
    return `服务端在流中返回错误：${error.trim()}`;
  }
  return '';
}

/** 非流式 JSON 响应兜底解析（支持 message.tool_calls） */
function parseNonStreamResponse(raw: string): StreamChatResult {
  if (!raw.trim()) {
    return { text: '', toolCalls: [] };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return {
      text: readDeltaContent(parsed),
      toolCalls: readNonStreamToolCalls(parsed),
      finishReason: readFinishReason(parsed) || undefined,
    };
  } catch {
    return { text: '', toolCalls: [] };
  }
}

function readNonStreamToolCalls(json: unknown): ToolCall[] {
  if (!isRecord(json)) {
    return [];
  }
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return [];
  }
  const first = choices[0];
  if (!isRecord(first)) {
    return [];
  }
  const message = first.message;
  if (!isRecord(message) || !Array.isArray(message.tool_calls)) {
    return [];
  }

  const result: ToolCall[] = [];
  message.tool_calls.forEach((rawToolCall, index) => {
    if (!isRecord(rawToolCall)) {
      return;
    }
    const fn = rawToolCall.function;
    if (!isRecord(fn)) {
      return;
    }
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name) {
      return;
    }
    let args = '{}';
    if (typeof fn.arguments === 'string') {
      args = fn.arguments;
    } else if (fn.arguments !== undefined) {
      args = JSON.stringify(fn.arguments);
    }
    const id =
      typeof rawToolCall.id === 'string' && rawToolCall.id
        ? rawToolCall.id
        : `tool_call_${index}_${Date.now().toString(36)}`;
    result.push({
      id,
      type: 'function',
      function: { name, arguments: args },
    });
  });
  return result;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * 把 HTTP 状态码翻译成人话。
 * 只截取服务端错误信息的前 300 字，避免把整页 HTML 塞进气泡。
 */
function describeHttpError(
  status: number,
  detail: string,
  provider: ProviderConfig,
  model: string,
  endpoint: string,
  usedTools: boolean,
): string {
  const snippet = detail.replace(/\s+/g, ' ').trim().slice(0, 300);
  const tail = snippet ? `\n\n服务端信息：${snippet}` : '';

  switch (status) {
    case 400:
      return `请求被拒绝（400）：参数或模型名不合法。当前模型：${model}。${tail}`;
    case 401:
      return `鉴权失败（401）：API Key 无效或已过期。请执行命令「AI 群聊: 设置 API Key」重新配置「${provider.label}」。${tail}`;
    case 403:
      return `无权访问（403）：该 Key 没有调用「${model}」的权限，或账号受限。${tail}`;
    case 404: {
      const toolHint = usedTools
        ? '本次请求携带了 tools；如果该模型不支持工具调用，可执行命令「AI 群聊: 切换 DSH 外包工具」关闭后重试。'
        : '本次请求未携带 tools。';
      return (
        `接口不存在（404）：实际请求 ${endpoint}。` +
        `请检查 BaseURL（当前 ${provider.baseUrl}）、模型名（${model}）以及角色绑定的 Provider 是否正确。` +
        `模型可能已下线或当前 Key 无权访问该模型。${toolHint}${tail}`
      );
    }
    case 429:
      return `触发限流（429）：请求过于频繁或额度不足，请稍后重试。${tail}`;
    default:
      if (status >= 500) {
        return `服务端错误（${status}）：${provider.label} 暂时不可用，可稍后重试。${tail}`;
      }
      return `请求失败（${status}）。${tail}`;
  }
}

/** 把 fetch 抛出的底层错误翻译成用户能理解的话 */
function describeNetworkError(error: unknown, provider: ProviderConfig): string {
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return `无法解析 ${provider.baseUrl} 的域名，请检查 BaseURL 或网络/代理。`;
  }
  if (/ECONNREFUSED/i.test(message)) {
    return `无法连接 ${provider.baseUrl}（连接被拒绝），请检查服务是否可用或代理设置。`;
  }
  if (/CERT|certificate|self.signed/i.test(message)) {
    return `TLS 证书校验失败（${provider.label}）：请检查代理或企业证书配置。`;
  }
  if (/abort/i.test(message)) {
    return '请求被中止。';
  }
  return `请求「${provider.label}」失败：${message || '未知网络错误'}。请检查网络、代理或 BaseURL。`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
