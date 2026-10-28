# AI Chat Group

在 VS Code 里开一个「多 Agent 群聊」：Provider 和角色全部由配置/表单驱动，数量不限。
用户发送需求后，团队按你选择的调度策略依次或并行发言，最后可选一个角色做汇总。

> 典型默认团队：项目经理先出方案 → 后端 + 前端并行审查 → 项目经理汇总。
> 但代码里没有任何硬编码角色，你可以随时加一个「测试专家」「安全专家」「产品经理」。

## 功能

- **任意 Provider**：任何 OpenAI 兼容接口，只需名称、Base URL 和模型 ID 建议列表
- **任意角色**：自定义名称、emoji、气泡颜色、system prompt、Provider + 模型、角色级 temperature、启用/禁用、顺序
- **团队设置面板**：可视化添加/删除/修改 Provider 与 Role，不用手写 JSON
- **工作 / 闲聊 / 自由三模式**：`work` 按调度汇报，`casual` 随机接龙，`free` 用黑板模型并发广播、自主接话
- **真实 @ 机制**：用户 @ 角色会跳过随机；AI 回复里 @ 角色会强制下一位接话
- **智能话题路由**：casual 无 @ 时由隐形裁判在 3 秒内选出最合适的角色；失败静默回退随机
- **冷场心跳**：面板可见且开启后，空闲 5 分钟会让 AI 主动开话题；连续 3 次后休眠
- **三种调度模式**：串行排队、全部并行、首位先行 + 其余并行（仅工作模式）
- **可选汇总角色**：所有角色发言结束后，指定角色综合输出
- **上下文按角色注入**：每次请求都是 `system prompt + 本轮上下文`，换角色/换模型不会丢提示词
- **本地长时记忆**：聊天记录持久化到 `context.globalStorageUri`，重启 VS Code 后自动恢复
- **API Key 安全存储**：按 Provider ID 存入 VS Code SecretStorage，不写 settings.json、不下发 Webview
- **流式输出**：SSE 逐字显示，支持停止生成、超时、错误映射
- **主题自适应**：全部使用 `--vscode-*` 变量，支持深色/浅色
- **Markdown**：标题、列表、引用、代码块、行内代码、粗体/斜体/删除线、http(s) 链接
- **演示模式**：没有 API Key 也能预览动态角色、颜色与调度流程
- **DSH 外包工具**：角色可调用 `delegate_task_to_dsh`，把读取文件/搜索/执行命令的任务交给本地 DeepSeek Harness
- **工具可视化**：委托中/完成后显示灰色可折叠卡片，可展开预览 DSH 最终输出

## 快速开始

```bash
npm install
```

1. 用 VS Code 打开本目录，按 `F5` 启动扩展开发宿主；
2. 在新窗口执行命令 **「AI 群聊: 团队设置」**；
3. 添加 Provider，点击「设置 Key」写入 SecretStorage；
4. 添加/编辑角色，给每个角色绑定 Provider 和模型；
5. 执行 **「AI 群聊: 打开 AI 群聊面板」**，输入需求发送。

没有 Key 时，可以在团队设置里打开 **演示模式** 先预览完整界面。

## 核心概念

### Provider（提供商）

只描述“怎么连”：

| 字段 | 说明 |
| --- | --- |
| `id` | 唯一 ID，用于角色绑定和 SecretStorage 键名 |
| `name` | 展示名称 |
| `baseUrl` | OpenAI 兼容根地址，扩展自动拼接 `/chat/completions` |
| `models` | 模型 ID 建议列表，仅用于团队设置里的输入提示，不限制手填其他模型 |

API Key 不属于 Provider 的 JSON 配置，而是通过命令/设置面板写入：

```text
SecretStorage key = aiChatGroup.apiKey.<providerId>
```

### Role（角色）

只描述“是谁、怎么说话、用哪个模型”：

| 字段 | 说明 |
| --- | --- |
| `id` | 唯一 ID |
| `name` | 群聊显示名 |
| `prompt` | system prompt，每次请求都作为 `messages[0]` |
| `providerId` | 绑定的 Provider ID |
| `model` | 模型 ID |
| `temperature` | 可选，0 ~ 2；不填时跟随全局 `aiChatGroup.temperature`（默认 0.7） |
| `emoji` | 头像 emoji |
| `color` | `blue` / `purple` / `green` / `orange` / `red` / `pink` / `cyan` / `yellow` |
| `enabled` | 是否参与群聊 |

数组顺序就是发言顺序；禁用角色不会出现在聊天成员条里。

### 调度模式

| `aiChatGroup.scheduling` | 行为 | 本轮上下文 |
| --- | --- | --- |
| `serial` | 按角色顺序串行发言 | 后发言者能看到前面所有角色本轮的输出 |
| `parallel` | 所有启用角色并行（受 `maxConcurrency` 限制） | 每个角色只看到本轮之前的历史，看不到本轮其他人的输出 |
| `lead-then-parallel` | 第一个启用角色先发言，其余角色并行 | 其余角色都能看到首位角色的输出 |

### 聊天模式

| `aiChatGroup.chatMode` | 行为 |
| --- | --- |
| `work`（默认） | 按 `scheduling` 调度，可选汇总角色，适合技术方案讨论 |
| `casual` | 随机选一个启用角色开场，然后排除刚发言的角色随机换人接龙，总共 2-3 轮 |
| `free` | 黑板模型：全员并发阅读最新上下文，自主返回 `speak`/`wait`；总线每秒消费一条发言并再次广播 |

闲聊模式不会插入任何合成的用户消息：用户只在最开始发一条消息，后续都是 AI 之间的
气泡。每个 casual 角色会在系统提示词末尾追加：

> 你现在在一个微信群聊里，请注意看群友的发言，你可以直接回复他们，语气要自然、像真人。
>
> 如果你想让群里的某位专家发表意见，请使用 `@专家名` 的格式呼叫他们。

后续接话时，上下文会包含用户原话、本轮接龙记录，并注入：

> 你看，群友刚说了这段话，你觉得呢？像网友一样回复他，可以赞同、反驳或吐槽。

闲聊模式会忽略 `scheduling`、`summaryRoleId` 和 `maxConcurrency`；只有 1 个启用角色时只能发言 1 次。

### 自由发言（黑板模型）

`free` 模式不再由裁判指定谁说话，而是把当前黑板广播给所有启用角色：

```text
用户消息
  -> Promise.allSettled 并发请求所有角色
  -> 每个角色返回 {"action":"speak","content":"..."} 或 {"action":"wait"}
  -> speak 进入 messageQueue
  -> 总线每 1 秒取队首，渲染 AI 气泡，并再次广播
```

规则：

- 决策 Prompt 追加：
  > 你身处一个自由群聊。请阅读最新上下文。你可以自主决定是否发言。如果你想说话，请严格输出 JSON：`{"action": "speak", "content": "你的发言"}`。如果你觉得不知道说什么，或者想先让别人说，请严格输出 JSON：`{"action": "wait"}`。不要输出任何其他额外解释。
- 兼容模型返回的 ````json` Markdown 包裹；
- 所有角色都 `wait` 或队列为空时，等待 5 秒；仍无人发言则随机角色强制催促（例如“大家怎么都不说话了？@某人，你先说。”）；
- 每轮真正渲染到 UI 的 AI 发言最多 **10 条**；
- 用户 `@` 在 free 模式下不指定单人，全员仍会收到广播；
- 用户消息、每条总线发言都会进入历史并持久化；
- 进入 free 模式后首次发言会显示：`⚡ 自由发言模式已开启，大家可以自由接话`。

### @ 点名

- 用户输入 `@角色名`（例如 `@前端专家 看下这个接口`）会跳过随机/调度，直接让被 @ 的角色回复；
- casual 系统提示会把当前启用角色名注入为“群成员：…”，帮助模型 @ 到真实存在的角色；
- 同时 @ 多个角色时，按文本中出现顺序依次回复；
- `casual` 模式下，AI 回复中可以写 `@角色名` 呼叫下一位群友。后端会在 `assistant-end` 后解析，强制把下一位发言权交给被 @ 的角色，并在其 system prompt 中注入“群友刚刚@了你，请你回应他。”；
- 没有用户 @ 且 AI 没有互相 @ 时，仍然走原来的随机接龙 2-3 轮；
- AI 互相 @ 最多允许连续 **6** 轮，防止两个角色无限互相 @（用户一次点名很多角色时，轮数会按名单扩展）；
- `work` 模式下用户 @ 角色时，只让被 @ 的角色按顺序回复，不再执行调度和汇总。

### 智能话题路由（隐形裁判）

`casual` 模式下，如果用户没有 `@` 任何角色，会先发起一次**非流式**裁判请求：

```text
你是一个群聊调度员。当前群成员：${角色列表}。
用户刚刚说：'${用户输入}'。
请判断哪位成员最适合回答？只输出成员名字，不要标点，如果都不适合请输出 None。
```

- 请求超时 **3 秒**，使用 `AbortController`；
- 裁判 API 报错、超时、输出 `None`、输出名字不在当前启用角色列表中时，**静默回退随机抽取**，不向用户报错；
- 成功时该角色作为第一轮，后续继续走随机接龙或 AI @ 逻辑；
- 用户 @ 优先级最高，不会发起裁判请求；
- 请求期间输入框上方显示 `🤔 正在分析该由谁接话...`，结束（成功/失败）后隐藏。

裁判模型：

```json
"aiChatGroup.judgeModelId": ""
```

- 留空时，从**第一个启用角色**绑定的 Provider 的 `models` 列表中自动挑选；
- 自动挑选是启发式的：优先 `flash` / `mini` / `lite` / `small` / `8k`，排后 `plus` / `pro` / `max` / `reasoner` / `128k` 等；
- 想精确控制请直接填模型 ID，例如 `"glm-4-flash"` 或 `"deepseek-chat"`（模型需属于第一个启用角色绑定的 Provider）；
- 裁判请求复用第一个启用角色的 Provider Key，不额外保存 Key。

### 冷场心跳（Heartbeat）

默认关闭，避免自动消耗 Token。可在团队设置面板勾选 **「冷场心跳（空闲 5 分钟后主动开话题）」**：

```json
"aiChatGroup.enableHeartbeat": false
```

开启后：

- 仅当聊天面板**可见且打开**时，每 2 分钟检查一次；
- 距离上一次用户/AI 发言超过 **5 分钟**，触发一次主动发言；
- 优先让隐形裁判选角色，裁判不可用/失败/None 时随机选一个启用角色；
- 主动发言的 Prompt 会要求角色用轻松话题开聊，例如 IT 八卦、吐槽、中午吃什么；
- 心跳 AI 请求使用 **3 秒超时**、关闭 tools、`max_tokens: 200`，尽量控制成本；
- 心跳失败后 5 分钟内不重复尝试，避免连续烧 Token；
- 聊天中会先显示一条 `[角色名] 正在开启新话题...`，然后才是 AI 气泡；
- 连续 **3 次**主动发言后自动休眠，不再触发，直到用户再次发言；
- 用户发言会重置连续计数并唤醒心跳；
- 面板隐藏或关闭时定时器停止。

心跳选中的角色不会自动接龙，只发一条主动话题消息；用户继续回复后恢复正常群聊流程。

### 汇总角色

`aiChatGroup.summaryRoleId` 非空时，所有角色发言结束后，该角色再做一次汇总。
汇总请求会把本轮所有发言作为上下文，并在该角色的 system prompt 后追加“汇总任务”。

## 配置示例

```jsonc
{
  "aiChatGroup.providers": [
    {
      "id": "deepseek",
      "name": "DeepSeek官方",
      "baseUrl": "https://api.deepseek.com/v1",
      "models": ["deepseek-chat", "deepseek-reasoner"]
    },
    {
      "id": "zhipu",
      "name": "智谱GLM",
      "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
      "models": ["glm-4-plus", "glm-4-flash"]
    }
  ],
  "aiChatGroup.roles": [
    {
      "id": "pm",
      "name": "项目经理",
      "prompt": "你负责拆解需求、给出方案与任务分工……",
      "providerId": "deepseek",
      "model": "deepseek-chat",
      "emoji": "🧑‍💼",
      "color": "blue",
      "enabled": true
    },
    {
      "id": "tester",
      "name": "测试专家",
      "prompt": "你负责挑刺，找出边界条件、失败路径和缺失的测试……",
      "providerId": "zhipu",
      "model": "glm-4-plus",
      "temperature": 1,
      "emoji": "🧪",
      "color": "pink",
      "enabled": true
    }
  ],
  "aiChatGroup.scheduling": "lead-then-parallel",
  "aiChatGroup.chatMode": "work",
  "aiChatGroup.judgeModelId": "",
  "aiChatGroup.enableHeartbeat": false,
  "aiChatGroup.summaryRoleId": "pm",
  "aiChatGroup.maxConcurrency": 3,
  "aiChatGroup.demoMode": false,
  "aiChatGroup.enableTools": true,
  "aiChatGroup.temperature": 0.7,
  "aiChatGroup.maxTokens": 1200,
  "aiChatGroup.requestTimeoutMs": 90000,
  "aiChatGroup.maxContextChars": 6000,
  "aiChatGroup.maxHistoryMessages": 30
}
```

## DSH 外包工具

这个插件本身**不再直接读取工作区文件**。所有文件读取、代码搜索和命令执行都外包给本地
DeepSeek Harness；插件只负责调度和展示结果。

前置条件：

1. DSH Web 服务运行在 `http://127.0.0.1:3080`；
2. 已安装带 `POST /x/headless` + `GET /x/headless/status` 的新版 `dsh-web-submit` 插件。

开启 `aiChatGroup.enableTools`（默认 true）且工作区已受信任时，角色请求会携带：

```json
{
  "name": "delegate_task_to_dsh",
  "description": "当你需要读取文件、搜索代码或执行命令时，请使用此工具，将你想做的事情用自然语言告诉 DSH",
  "parameters": {
    "type": "object",
    "properties": { "task": { "type": "string" } },
    "required": ["task"]
  }
}
```

执行流程：

```text
角色请求
  -> 模型返回 tool_calls（流式分片拼成完整 task）
  -> POST http://127.0.0.1:3080/x/headless
       { "task": "...", "cwd": "第一个 workspace folder 或 process.cwd()" }
  -> GET  /x/headless/status?sessionId=...&requestId=...&afterSeq=...
       每 1.5 秒轮询，直到 completed / failed / 5 分钟超时
  -> 把 DSH 最终文本作为 role='tool' 结果回传
  -> 自动再次请求群聊模型，生成最终回复
```

细节：

- 提交超时 30 秒；单次状态查询超时 15 秒；总等待上限 5 分钟；
- 状态支持 `pending` / `running` / `completed` / `failed`；
- `completed` 时取状态接口的 `text`；`failed` 时把 `error` 和已产生的文本一起回传；
- DSH 输出只把前 **20,000 字**交给群聊模型，避免单次外包把上下文撑爆；
- 点击聊天面板的「停止」会中止轮询；
- UI 会显示灰色折叠卡片：`🛰️ 正在委托 DSH: ...` → `🛰️ DSH 处理中: ...` →
  `✅ DSH 已完成: ... (N 字)`，点击可展开预览最终输出；
- 可用命令 **「AI 群聊: 切换 DSH 外包工具」** 全局启用/禁用。

安全边界：

- 插件只访问本机 `127.0.0.1:3080`；实际文件/命令权限由 DSH 自身的工具与工作区策略控制；
- 工作区未受信任或关闭 `enableTools` 时，请求不携带 tools；
- 插件不实现写入、删除、执行命令等本地工具；
- 工具结果只进入当前轮 API 对话，群聊历史中保留最终回复。

## 团队设置面板

点击聊天面板顶部的 **「⚙️ 团队设置」**，或执行命令 **「AI 群聊: 团队设置」**。

面板支持：

- Provider：新增、删除、修改名称/Base URL/模型建议列表、查看 Key 状态、设置 Key
- Role：新增、删除、上移/下移、启用/禁用、emoji、名称、颜色、Provider、模型、Prompt
- 调度：聊天模式（工作/闲聊/自由发言）、发言模式、最大并发、汇总角色、演示模式、冷场心跳
- 保存前在前后端各做一次校验：
  - Provider ID 唯一、Base URL 合法
  - 角色引用的 Provider 必须存在
  - 汇总角色必须存在且启用（为空表示不汇总）
  - 并发数 1~10
  - **允许空团队**：删除最后一个角色或 Provider 后仍可保存，聊天面板会提示先添加角色

### 删除行为

- 每个 Role / Provider 卡片右上角都有明确的 **「🗑️ 删除」** 按钮；
- 删除确认使用自绘弹窗，不依赖 `window.confirm`（VS Code Webview 中不可靠）；
- **表单没有其他未保存修改、且条目已保存**：删除会立即通过 `deleteRole` / `deleteProvider` 写入 settings.json；
- **表单还有未保存修改**：只从当前表单移除，Toast 会提示点击「保存更改」一起生效，避免覆盖其他修改；
- 被角色引用的 Provider 不允许删除，会弹窗列出引用它的角色，要求先更换 Provider；
- 删除汇总角色时会自动把「汇总角色」置为“不汇总”；
- 删除最后一个角色 / Provider 后，会提示“团队为空，请添加新角色 / 提供商”。

设置保存到 **用户级** `settings.json`；表单里不包含 API Key。
删除 Provider 后，SecretStorage 中的旧 Key 会保留（以旧 ID 为键），可重新添加同 ID 的 Provider 继续使用，或通过「设置 Key」留空清除。

## 消息与上下文

每次角色调用组装为：

```ts
[
  { role: 'system', content: role.prompt },
  // 只有在发生历史压缩时才有：
  { role: 'system', content: '【会议摘要】……' },
  {
    role: 'user',
    content: [
      '【最近讨论】……',
      '【用户本轮需求】……',
      '【本轮已有发言】……',
      '你是「xxx」，请直接输出你的发言。',
    ].join('\n\n'),
  },
]
```

这样即使角色、Provider、模型动态变化，每个请求也始终携带该角色的 system prompt；
其他角色的历史发言以带标签的文本进入上下文，避免被模型误认为“自己说过的话”。

### 上下文窗口与自动压缩

- `aiChatGroup.maxHistoryMessages`（默认 30）控制保留的最近历史条数；
- 超出窗口的最老消息不会被直接丢弃，而是调用一个轻量模型（优先使用第一个有可用 Key 的角色 Provider）压缩成 **200 字以内的会议摘要**；
- 摘要作为 **system 消息** 放在角色 prompt 之后，最近 N 条消息继续留在 user 上下文里；
- 摘要会缓存复用：下一次只有新滑出窗口的消息会与旧摘要合并，不会每次重新总结全部历史；
- 如果摘要模型调用失败（没 Key、超时、429 等），会退化为本地截断摘要，群聊继续，不会阻塞；
- 发生压缩时，聊天中会插入一条灰色系统提示：`📦 历史记录过长，已自动压缩之前的讨论内容`；
- 顶部角落会显示最近一次请求 payload 的预估 Token（汉字 1 字≈1.5 token，其他字符约 4 字符/token）。

`maxHistoryMessages` 可在 VS Code 设置中搜索 `aiChatGroup.maxHistoryMessages` 修改；团队设置面板暂不包含这个通用项。

## 聊天记录持久化

聊天记录保存在 VS Code 原生全局存储目录：

```text
context.globalStorageUri/chat-history.json
```

不会写入项目目录，也不依赖 workspace 设置。文件内容是 JSON 数组：

```json
[
  { "role": "user", "content": "你好", "timestamp": 1710000000000 },
  {
    "role": "assistant",
    "content": "...",
    "timestamp": 1710000001000,
    "roleId": "pm",
    "roleName": "项目经理",
    "emoji": "🧑‍💼",
    "color": "blue",
    "providerLabel": "DeepSeek官方",
    "model": "deepseek-chat"
  }
]
```

- Webview `ready` 时读取并发送 `{ type: 'load-history', messages }`；
- 用户发送消息后立即追加保存；
- AI 流式回复结束（`assistant-end`）后追加保存；
- 点击「清空」会删除全局存储文件并清空界面；
- 写入按文件串行排队，并先写临时文件再 rename，避免并发覆盖和半截 JSON；
- 文件不存在、JSON 损坏或读取 IO 错误时，`loadHistory` 静默返回 `[]`；
- 历史 AI 消息通过 `roleId` 在当前团队配置中重新匹配头像、颜色和显示名；角色已删除时回退到保存时的快照。

## 目录结构

```text
ai-chat-group/
├── package.json            # 命令、providers/roles 配置 schema、默认团队
├── src/
│   ├── extension.ts        # 命令注册
│   ├── chatPanel.ts        # 聊天 Webview、动态调度、上下文组装
│   ├── settingsPanel.ts    # 团队设置 Webview、保存校验
│   ├── config.ts           # 读取/校验/保存配置、SecretStorage、Role 解析
│   ├── types.ts            # Provider/Role/调度类型
│   ├── defaults.ts         # 默认团队、颜色/emoji 调色板、汇总指令
│   ├── aiClient.ts         # fetch + SSE + 超时/错误映射
│   ├── tokens.ts           # 简单 Token 估算
│   ├── storage.ts          # globalStorageUri 聊天记录持久化
│   ├── tools.ts            # DSH 外包工具定义与结果格式化
│   ├── apiKeys.ts          # 设置 Key 的 QuickPick/InputBox
│   ├── demo.ts             # 动态演示文本
│   └── webviewHtml.ts      # Webview HTML/CSP/nonce 装载
├── media/
│   ├── chat.html
│   ├── main.js
│   ├── style.css
│   ├── settings.html
│   ├── settings.js
│   └── settings.css
└── out/                    # tsc 编译产物
```

## 从旧版本升级

旧版（0.0.1）的配置结构是：

```jsonc
"aiChatGroup.providers": { "deepseek": { "label": "...", "model": "..." } },
"aiChatGroup.roleProviders": { "pm": "deepseek" },
"aiChatGroup.parallelReview": true,
"aiChatGroup.enableSummary": true
```

新版改为数组结构，并移除了 `roleProviders` / `parallelReview` / `enableSummary`：

- 打开 **团队设置**，重新添加 Provider 与角色即可；
- 以前写在 `providers.*.apiKey` 里的 Key 不再读取，请用「设置 Key」重新写入 SecretStorage；
- 角色先用默认团队兜底，修改后保存为新的 `aiChatGroup.roles`。

## 常见问题：404 接口不存在

先看错误信息里的 **“实际请求” URL**：

```text
https://api.moonshot.cn/v1/chat/completions
```

如果实际请求就是上面这个地址，说明不是 `/v1` 或 `/chat/completions` 重复拼接的问题。接下来按顺序检查：

1. **模型是否已下线**。Kimi 的 `moonshot-v1-8k` / `moonshot-v1-32k` / `moonshot-v1-128k` 等
   `moonshot-v1` 系列已于 **2026-08-31** 下线，继续使用会返回 404。请改用当前模型，例如
   `kimi-k3.1-pro` 或 `kimi-k2.7-code`。可用 `GET /v1/models` 确认账号可用的模型。
2. **tools 是否被模型支持**。插件默认携带 `delegate_task_to_dsh` 工具；如果模型不支持
   tools，可执行命令 **「AI 群聊: 切换 DSH 外包工具」** 关闭后重试。
3. **角色绑定的 Provider 是否正确**。404 信息里会显示实际请求 URL 和模型名，确认不是你
   改了 Kimi Provider，但角色仍绑定在另一个 Provider 上。
4. **Key 的区域/产品是否匹配**。Kimi 中国站是 `api.moonshot.cn`，国际站是
   `api.moonshot.ai`；Kimi Code Key 与开放平台 API Key 也不通用。

官方模型列表：<https://platform.kimi.com/docs/models>

## 已知限制

- Node 原生 `fetch` 不自动读取系统代理；需要代理时可改用带 `ProxyAgent` 的实现；
- 聊天记录保存在全局存储的明文 JSON 中，不做加密；多人共用系统账号时请注意；
- 聊天记录文件没有自动上限，长期使用可能变大；
- 单个角色暂无独立 maxTokens（全局配置）；temperature 已支持角色级覆盖。
- Token 数是估算值，可能与具体模型 tokenizer 有偏差；
- 摘要模型使用第一个有可用 Key 的角色 Provider，不是独立的轻量模型配置；
- 隐形裁判的“最便宜模型”是名称启发式选择，不是实时价格查询；可用 `aiChatGroup.judgeModelId` 精确覆盖；
- DSH 外包需要本机 DSH Web 服务与新版 `dsh-web-submit` 插件；服务未启动时工具会返回明确错误；
- 工具调用需要模型/Provider 支持 OpenAI tools 格式；不支持时请关闭 `aiChatGroup.enableTools`；
- `cwd` 使用第一个 workspace folder；没有打开工作区时使用 `process.cwd()`；
- 单个外包任务最长等待 5 分钟，超时后任务可能仍在 DSH 网页端运行；
- DSH 输出超过 20,000 字会截断后再交给群聊模型；
- 实际文件/命令权限由 DSH 控制，插件本身不再做本地路径校验；
- Markdown 只覆盖常用子集，不支持表格、脚注、嵌套列表缩进；
- 团队设置保存到用户级配置，不区分 workspace；
- 只允许一个聊天面板和一个团队设置面板；
- 闲聊模式至少需要 2 个启用角色才能形成接龙；只有 1 个角色时只发言一次；
- 心跳默认关闭；开启后会持续产生自动请求，请留意 Token 成本。

## 开发

```bash
npm run compile   # tsc
npm run watch     # 监听编译
npm run lint      # eslint
npm test          # @vscode/test-cli（需要图形环境）
```

发布前记得把 `package.json` 的 `publisher` 改成你自己的 Marketplace 账号名。
