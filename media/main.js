/*
 * AI 群聊 Webview 前端逻辑（普通 JS，不经过打包）
 *
 * 职责：
 *   - 接收扩展发来的消息协议（init / load-history / user / assistant-* / notice / status / clear）；
 *   - 渲染左右气泡、成员条、Markdown、代码块复制；
 *   - 处理 Enter 发送、中文输入法、自动滚动、停止生成；
 *   - 所有用户/模型文本都先转义，再生成 HTML，避免 Webview 内 XSS。
 */
(function () {
  'use strict';

  // acquireVsCodeApi 每个 Webview 只能调用一次
  const vscode = acquireVsCodeApi();

  const els = {
    messages: document.getElementById('messages'),
    empty: document.getElementById('empty-state'),
    emptyMembers: document.getElementById('empty-members'),
    members: document.getElementById('members'),
    status: document.getElementById('status'),
    statusText: document.getElementById('status-text'),
    input: document.getElementById('input'),
    send: document.getElementById('btn-send'),
    stop: document.getElementById('btn-stop'),
    clear: document.getElementById('btn-clear'),
    teamSettings: document.getElementById('btn-team-settings'),
    settings: document.getElementById('btn-settings'),
    tokenEstimate: document.getElementById('token-estimate'),
    judgeStatus: document.getElementById('judge-status'),
    scrollBottom: document.getElementById('scroll-bottom'),
    charCount: document.getElementById('char-count'),
    hint: document.getElementById('hint'),
  };

  const state = {
    busy: false,
    demoMode: false,
    composing: false,
    stickToBottom: true,
    maxInput: 4000,
    /** id -> 原始文本，用于“复制”整条消息 */
    rawText: new Map(),
    /** id -> 正在流式输出的 DOM/缓冲区 */
    streams: new Map(),
    /** 工具调用卡片 id -> DOM */
    toolCards: new Map(),
  };

  // ---------------------------------------------------------------------------
  // 扩展 -> Webview 消息
  // ---------------------------------------------------------------------------

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || typeof message.type !== 'string') {
      return;
    }

    switch (message.type) {
      case 'init':
        handleInit(message);
        break;
      case 'load-history':
        handleLoadHistory(message.messages);
        break;
      case 'config':
        handleConfig(message);
        break;
      case 'user':
        appendUser(message.entry);
        break;
      case 'assistant-start':
        startAssistant(message.entry);
        break;
      case 'assistant-delta':
        appendDelta(message.id, message.delta);
        break;
      case 'assistant-end':
        finishAssistant(message.id, message.stopped, message.error);
        break;
      case 'tool-call-start':
        startToolCard(message);
        break;
      case 'tool-call-end':
        finishToolCard(message);
        break;
      case 'tool-call-progress':
        updateToolCard(message);
        break;
      case 'judge-start':
        setJudgeStatus(true);
        break;
      case 'judge-end':
        setJudgeStatus(false);
        break;
      case 'notice':
        appendNotice(message);
        break;
      case 'status':
        setBusy(Boolean(message.busy), message.text);
        break;
      case 'system-note':
        appendSystemNote(message.text);
        break;
      case 'token-estimate':
        updateTokenEstimate(message.tokens);
        break;
      case 'clear':
        clearMessages();
        break;
      default:
        break;
    }
  });

  function handleInit(message) {
    if (Number.isFinite(message.maxInput) && message.maxInput > 0) {
      state.maxInput = message.maxInput;
    }
    state.demoMode = Boolean(message.demoMode);
    renderMembers(Array.isArray(message.members) ? message.members : []);

    resetMessages();
    setJudgeStatus(false);

    const history = Array.isArray(message.history) ? message.history : [];
    history.forEach(renderHistoryEntry);

    showEmpty(history.length === 0);
    setBusy(Boolean(message.busy), message.status || '');
    updateTokenEstimate(message.tokenEstimate);
    syncInput();
    scrollToBottom(true);
    els.input.focus();
  }

  function handleLoadHistory(messages) {
    const list = Array.isArray(messages) ? messages : [];
    resetMessages();
    list.forEach(function (message, index) {
      renderStoredMessage(message, index);
    });
    showEmpty(list.length === 0);
    scrollToBottom(true);
  }

  function renderStoredMessage(message, index) {
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.role !== 'user' && message.role !== 'assistant') {
      return;
    }
    if (typeof message.content !== 'string') {
      return;
    }

    const timestamp =
      typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
        ? message.timestamp
        : Date.now();
    const id =
      'history-' +
      message.role +
      '-' +
      Math.trunc(timestamp).toString(36) +
      '-' +
      index;

    if (message.role === 'user') {
      appendUser({
        id: id,
        kind: 'user',
        text: message.content,
        time: timestamp,
      });
      return;
    }

    renderHistoryEntry({
      id: id,
      kind: 'assistant',
      text: message.content,
      time: timestamp,
      roleId: typeof message.roleId === 'string' ? message.roleId : undefined,
      roleName:
        typeof message.roleName === 'string' && message.roleName
          ? message.roleName
          : 'AI',
      emoji:
        typeof message.emoji === 'string' && message.emoji
          ? message.emoji
          : '🤖',
      color: typeof message.color === 'string' ? message.color : undefined,
      providerLabel:
        typeof message.providerLabel === 'string'
          ? message.providerLabel
          : undefined,
      model: typeof message.model === 'string' ? message.model : undefined,
      isSummary: message.isSummary === true,
      stopped: message.stopped === true,
      error: typeof message.error === 'string' ? message.error : undefined,
    });
  }

  function handleConfig(message) {
    if (Number.isFinite(message.maxInput) && message.maxInput > 0) {
      state.maxInput = message.maxInput;
    }
    state.demoMode = Boolean(message.demoMode);
    renderMembers(Array.isArray(message.members) ? message.members : []);
    updateHint();
    syncInput();
  }

  function renderHistoryEntry(entry) {
    if (!entry || typeof entry.id !== 'string') {
      return;
    }
    if (entry.kind === 'user') {
      appendUser(entry);
      return;
    }

    startAssistant(entry);
    const stream = state.streams.get(entry.id);
    if (!stream) {
      return;
    }
    stream.buffer = typeof entry.text === 'string' ? entry.text : '';
    if (stream.buffer.trim()) {
      stream.typing.hidden = true;
    }
    renderStream(stream);
    finishAssistant(entry.id, Boolean(entry.stopped), entry.error);
  }

  // ---------------------------------------------------------------------------
  // 渲染：用户消息 / AI 消息
  // ---------------------------------------------------------------------------

  function createMessageElement(id, extraClass) {
    const article = document.createElement('article');
    article.className = 'msg' + (extraClass ? ' ' + extraClass : '');
    article.dataset.id = id;
    return article;
  }

  function createActions(id) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'link-btn';
    button.dataset.action = 'copy';
    button.dataset.id = id;
    button.title = '复制这条消息的原始文本';
    button.textContent = '复制';

    actions.appendChild(button);
    return actions;
  }

  function appendUser(entry) {
    if (!entry || typeof entry.id !== 'string') {
      return;
    }

    const message = createMessageElement(entry.id, 'user');
    const main = document.createElement('div');
    main.className = 'msg-main';

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = '你';
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatTime(entry.time);
    meta.append(name, time);

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const body = document.createElement('div');
    body.className = 'bubble-body user-text';
    body.textContent = typeof entry.text === 'string' ? entry.text : '';
    bubble.appendChild(body);

    main.append(meta, bubble, createActions(entry.id));
    message.appendChild(main);
    els.messages.appendChild(message);

    state.rawText.set(entry.id, body.textContent);
    showEmpty(false);
    scrollToBottom();
  }

  function startAssistant(entry) {
    if (!entry || typeof entry.id !== 'string') {
      return;
    }

    const roleId = entry.roleId;
    const message = createMessageElement(entry.id, 'ai ' + colorClass(entry.color));

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = entry.emoji || '🤖';

    const main = document.createElement('div');
    main.className = 'msg-main';

    const meta = document.createElement('div');
    meta.className = 'msg-meta';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.roleName || 'AI';

    meta.appendChild(name);

    const badgeText = [entry.providerLabel, entry.model].filter(Boolean).join(' · ');
    if (badgeText) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = badgeText;
      meta.appendChild(badge);
    }

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatTime(entry.time);
    meta.appendChild(time);

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    const body = document.createElement('div');
    body.className = 'bubble-body markdown';

    const typing = document.createElement('div');
    typing.className = 'typing';
    typing.setAttribute('aria-label', '正在生成');
    typing.innerHTML = '<i></i><i></i><i></i>';

    bubble.append(body, typing);
    main.append(meta, bubble, createActions(entry.id));
    message.append(avatar, main);
    els.messages.appendChild(message);

    state.rawText.set(entry.id, '');
    state.streams.set(entry.id, {
      msg: message,
      body: body,
      typing: typing,
      buffer: '',
      lastHtml: '',
      raf: 0,
    });

    showEmpty(false);
    scrollToBottom();
  }

  function appendDelta(id, delta) {
    const stream = state.streams.get(id);
    if (!stream || typeof delta !== 'string') {
      return;
    }

    stream.buffer += delta;
    state.rawText.set(id, stream.buffer);

    if (stream.buffer.trim()) {
      stream.typing.hidden = true;
    }

    scheduleRender(stream);
    scrollToBottom();
  }

  function scheduleRender(stream) {
    if (stream.raf) {
      return;
    }
    // 每个 token 都重渲染会卡；按帧合并
    stream.raf = window.requestAnimationFrame(function () {
      stream.raf = 0;
      renderStream(stream);
    });
  }

  function renderStream(stream) {
    const html = renderMarkdown(stream.buffer);
    if (stream.lastHtml === html) {
      return;
    }
    stream.lastHtml = html;
    stream.body.innerHTML = html;
  }

  function finishAssistant(id, stopped, error) {
    const stream = state.streams.get(id);
    if (!stream) {
      return;
    }

    if (stream.raf) {
      cancelAnimationFrame(stream.raf);
      stream.raf = 0;
    }

    if (!stream.buffer.trim()) {
      stream.buffer = error ? '*（没有收到内容）*' : '（无内容）';
    }

    renderStream(stream);
    stream.typing.remove();
    state.rawText.set(id, stream.buffer);

    if (stopped) {
      stream.msg.classList.add('stopped');
      addNote(stream.msg, '已停止生成');
    }

    if (error) {
      stream.msg.classList.add('failed');
      stream.msg.title = String(error);
      addNote(stream.msg, '请求失败（详情见系统提示）', 'error-note');
    }

    state.streams.delete(id);
    scrollToBottom();
  }

  function addNote(messageEl, text, extraClass) {
    const bubble = messageEl.querySelector('.bubble');
    if (!bubble) {
      return;
    }
    const note = document.createElement('div');
    note.className = 'note' + (extraClass ? ' ' + extraClass : '');
    note.textContent = text;
    bubble.appendChild(note);
  }

  function appendNotice(message) {
    const level =
      message.level === 'error' || message.level === 'warn' ? message.level : 'info';

    const card = document.createElement('section');
    card.className = 'notice ' + level;

    const text = document.createElement('div');
    text.className = 'notice-text';
    text.textContent = typeof message.text === 'string' ? message.text : '';
    card.appendChild(text);

    if (Array.isArray(message.actions) && message.actions.length > 0) {
      const row = document.createElement('div');
      row.className = 'notice-actions';

      message.actions.forEach(function (action) {
        if (!action || typeof action.label !== 'string' || typeof action.command !== 'string') {
          return;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'primary-btn small';
        button.dataset.command = action.command;
        if (typeof action.providerId === 'string' && action.providerId) {
          button.dataset.providerId = action.providerId;
        }
        button.textContent = action.label;
        row.appendChild(button);
      });

      if (row.childElementCount > 0) {
        card.appendChild(row);
      }
    }

    els.messages.appendChild(card);
    showEmpty(false);
    scrollToBottom();
  }

  // ---------------------------------------------------------------------------
  // 成员条
  // ---------------------------------------------------------------------------

  function renderMembers(members) {
    els.members.replaceChildren();
    els.emptyMembers.replaceChildren();

    const validMembers = members.filter(function (member) {
      return member && typeof member.name === 'string';
    });

    if (validMembers.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'member-pill empty-team';
      empty.textContent = '还没有启用任何角色，请打开团队设置';
      els.emptyMembers.appendChild(empty);
      return;
    }

    validMembers.forEach(function (member) {
      const chip = document.createElement('span');
      chip.className = 'member ' + colorClass(member.color);

      const avatar = document.createElement('span');
      avatar.className = 'member-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = member.emoji || '🤖';

      const name = document.createElement('span');
      name.className = 'member-name';
      name.textContent = member.name;

      chip.append(avatar, name);

      const modelText = [member.providerLabel, member.model].filter(Boolean).join(' · ');
      if (modelText) {
        const model = document.createElement('span');
        model.className = 'member-model';
        model.textContent = modelText;
        chip.appendChild(model);
      }

      els.members.appendChild(chip);

      const preview = document.createElement('span');
      preview.className = 'member-pill';
      preview.textContent = (member.emoji || '') + ' ' + member.name;
      els.emptyMembers.appendChild(preview);
    });
  }

  function colorClass(color) {
    if (
      color === 'blue' ||
      color === 'purple' ||
      color === 'green' ||
      color === 'orange' ||
      color === 'red' ||
      color === 'pink' ||
      color === 'cyan' ||
      color === 'yellow'
    ) {
      return 'role-color-' + color;
    }
    return '';
  }

  // ---------------------------------------------------------------------------
  // 状态 / 滚动 / 输入
  // ---------------------------------------------------------------------------

  function setBusy(busy, text) {
    state.busy = busy;
    els.status.classList.toggle('busy', busy);
    els.status.classList.toggle('idle', !busy);
    els.statusText.textContent = text || (busy ? '讨论中…' : '空闲');
    els.stop.hidden = !busy;
    if (!busy) {
      setJudgeStatus(false);
    }
    updateHint();
    syncSendState();
  }

  function setJudgeStatus(active) {
    if (!els.judgeStatus) {
      return;
    }
    els.judgeStatus.hidden = !active;
  }

  function updateHint() {
    if (state.busy) {
      els.hint.textContent = '讨论进行中，点击「停止」可中断本轮生成';
    } else if (state.demoMode) {
      els.hint.textContent = '演示模式已开启：不请求真实模型，仅用于预览界面';
    } else {
      els.hint.textContent = 'Enter 发送 · Shift+Enter 换行 · 内容会发送给上方配置的多个模型';
    }
  }

  function syncSendState() {
    const length = els.input.value.length;
    const tooLong = length > state.maxInput;

    els.send.disabled = state.busy || els.input.value.trim().length === 0 || tooLong;
    els.charCount.textContent = length > 0 ? length + ' / ' + state.maxInput : '';
    els.charCount.classList.toggle('limit', tooLong);
  }

  function syncInput() {
    resizeInput();
    syncSendState();
  }

  function resizeInput() {
    els.input.style.height = 'auto';
    const nextHeight = Math.min(els.input.scrollHeight, 160);
    els.input.style.height = Math.max(nextHeight, 22) + 'px';
  }

  function showEmpty(show) {
    els.empty.hidden = !show;
  }

  function isNearBottom() {
    const distance =
      els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight;
    return distance < 56;
  }

  function scrollToBottom(force) {
    if (!force && !state.stickToBottom) {
      return;
    }
    // 等一帧，确保刚 append 的内容已经参与布局
    window.requestAnimationFrame(function () {
      els.messages.scrollTop = els.messages.scrollHeight;
      state.stickToBottom = true;
      els.scrollBottom.hidden = true;
    });
  }

  function resetMessages() {
    // 先取消未执行完的渲染帧，避免回调操作已经移除的 DOM
    state.streams.forEach(function (stream) {
      if (stream.raf) {
        cancelAnimationFrame(stream.raf);
      }
    });
    state.streams.clear();
    state.toolCards.clear();

    Array.from(els.messages.children).forEach(function (child) {
      if (child !== els.empty) {
        child.remove();
      }
    });
    state.rawText.clear();
  }

  function findMessageElement(id) {
    const messages = els.messages.querySelectorAll('.msg');
    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index].dataset.id === id) {
        return messages[index];
      }
    }
    return null;
  }

  function startToolCard(message) {
    if (!message || typeof message.id !== 'string' || state.toolCards.has(message.id)) {
      return;
    }

    const details = document.createElement('details');
    details.className = 'tool-card running';
    details.dataset.toolId = message.id;

    const summary = document.createElement('summary');
    summary.textContent = message.title || '🔍 正在调用工具...';
    const body = document.createElement('div');
    body.className = 'tool-body';
    details.append(summary, body);

    const targetMessage = findMessageElement(message.messageId);
    const main = targetMessage ? targetMessage.querySelector('.msg-main') : null;
    if (main) {
      const bubble = main.querySelector('.bubble');
      if (bubble) {
        main.insertBefore(details, bubble);
      } else {
        main.appendChild(details);
      }
    } else {
      els.messages.appendChild(details);
    }

    state.toolCards.set(message.id, { details: details, body: body, summary: summary });
    showEmpty(false);
    scrollToBottom();
  }

  function updateToolCard(message) {
    if (!message || typeof message.id !== 'string') {
      return;
    }
    const card = state.toolCards.get(message.id);
    if (!card) {
      return;
    }
    if (typeof message.title === 'string' && message.title) {
      card.summary.textContent = message.title;
    }
  }

  function finishToolCard(message) {
    if (!message || typeof message.id !== 'string') {
      return;
    }
    const card = state.toolCards.get(message.id);
    if (!card) {
      return;
    }

    card.details.classList.remove('running');
    card.details.classList.add(message.ok ? 'ok' : 'error');
    card.summary.textContent =
      message.title || (message.ok ? '✅ 工具调用完成' : '❌ 工具调用失败');

    const preview = document.createElement('pre');
    preview.className = 'tool-preview';
    preview.textContent =
      typeof message.content === 'string' && message.content
        ? message.content
        : '（无内容）';
    card.body.replaceChildren(preview);

    state.toolCards.delete(message.id);
    scrollToBottom();
  }

  function appendSystemNote(text) {
    if (!text) {
      return;
    }
    const note = document.createElement('div');
    note.className = 'system-note';
    note.textContent = text;
    els.messages.appendChild(note);
    showEmpty(false);
    scrollToBottom();
  }

  function updateTokenEstimate(tokens) {
    const value = Number(tokens);
    if (!els.tokenEstimate) {
      return;
    }
    if (!Number.isFinite(value) || value <= 0) {
      els.tokenEstimate.hidden = true;
      els.tokenEstimate.textContent = '';
      return;
    }

    els.tokenEstimate.hidden = false;
    els.tokenEstimate.textContent = '≈ ' + formatTokenCount(value) + ' tokens';
    els.tokenEstimate.title =
      '当前请求 payload 的预估 Token：约 ' +
      value.toLocaleString('zh-CN') +
      '（汉字 1 字≈1.5 token，其他字符约 4 字符/token）';
  }

  function formatTokenCount(tokens) {
    if (tokens >= 1000) {
      return (tokens / 1000).toFixed(1) + 'k';
    }
    return String(Math.round(tokens));
  }

  function clearMessages() {
    resetMessages();
    setJudgeStatus(false);
    showEmpty(true);
    updateTokenEstimate(0);
    scrollToBottom(true);
  }

  function send() {
    const text = els.input.value.trim();
    if (!text || state.busy) {
      return;
    }
    if (text.length > state.maxInput) {
      els.hint.textContent =
        '内容过长（' + text.length + ' / ' + state.maxInput + '），请删减后再发送';
      return;
    }

    vscode.postMessage({ type: 'send', text: text });

    // 用户主动发送时强制跟随到底部（即使刚才正在翻阅旧消息）
    state.stickToBottom = true;
    els.scrollBottom.hidden = true;

    // 乐观清空输入框：用户消息由扩展回传后渲染，保持单一数据源
    els.input.value = '';
    syncInput();
    els.input.focus();
  }

  function copyText(text) {
    if (!text) {
      return;
    }
    vscode.postMessage({ type: 'copy', text: text });
  }

  function flash(button, label) {
    if (button.dataset.flashing === '1') {
      return;
    }
    const original = button.textContent;
    button.dataset.flashing = '1';
    button.textContent = label;
    window.setTimeout(function () {
      button.textContent = original;
      delete button.dataset.flashing;
    }, 1200);
  }

  function formatTime(value) {
    if (!value) {
      return '';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }

  // ---------------------------------------------------------------------------
  // 事件绑定
  // ---------------------------------------------------------------------------

  els.send.addEventListener('click', send);

  els.stop.addEventListener('click', function () {
    vscode.postMessage({ type: 'stop' });
  });

  els.clear.addEventListener('click', function () {
    vscode.postMessage({ type: 'clear' });
  });

  els.teamSettings.addEventListener('click', function () {
    vscode.postMessage({ type: 'command', command: 'openTeamSettings' });
  });

  els.settings.addEventListener('click', function () {
    vscode.postMessage({ type: 'command', command: 'openSettings' });
  });

  els.scrollBottom.addEventListener('click', function () {
    scrollToBottom(true);
  });

  els.input.addEventListener('input', syncInput);

  els.input.addEventListener('compositionstart', function () {
    state.composing = true;
  });

  els.input.addEventListener('compositionend', function () {
    state.composing = false;
  });

  els.input.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' || event.shiftKey) {
      return;
    }
    // 关键：中文输入法选词时按回车不能发送
    if (event.isComposing || state.composing || event.keyCode === 229) {
      return;
    }
    event.preventDefault();
    send();
  });

  els.messages.addEventListener('scroll', function () {
    state.stickToBottom = isNearBottom();
    els.scrollBottom.hidden = state.stickToBottom;
  });

  els.messages.addEventListener('click', function (event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    // 代码块复制
    const copyCode = target.closest('[data-action="copy-code"]');
    if (copyCode) {
      const block = copyCode.closest('.code-block');
      const code = block ? block.querySelector('code') : null;
      if (code) {
        copyText(code.textContent || '');
        flash(copyCode, '已复制');
      }
      return;
    }

    // 整条消息复制
    const copyMessage = target.closest('[data-action="copy"]');
    if (copyMessage) {
      const messageEl = copyMessage.closest('.msg');
      const id = messageEl ? messageEl.dataset.id : '';
      copyText(id ? state.rawText.get(id) || '' : '');
      flash(copyMessage, '已复制');
      return;
    }

    // 卡片上的命令按钮（设置 Key / 打开设置 / 清空）
    const commandButton = target.closest('[data-command]');
    if (commandButton) {
      vscode.postMessage({
        type: 'command',
        command: commandButton.dataset.command,
        providerId: commandButton.dataset.providerId,
      });
      return;
    }

    // 示例需求：填进输入框
    const sample = target.closest('[data-sample]');
    if (sample) {
      els.input.value = sample.dataset.sample || '';
      syncInput();
      els.input.focus();
      return;
    }

    // 链接交给扩展用系统浏览器打开
    const link = target.closest('a[href]');
    if (link) {
      event.preventDefault();
      vscode.postMessage({ type: 'openExternal', url: link.href });
    }
  });

  window.addEventListener('resize', function () {
    scrollToBottom();
  });

  // ---------------------------------------------------------------------------
  // Markdown 渲染
  //
  // 说明：为了不依赖 CDN / 第三方库，这里实现一个够用的子集：
  //   标题、段落、粗体、斜体、删除线、行内代码、代码块、引用、有序/无序列表、分割线、http(s) 链接。
  // 安全策略：所有文本先 HTML 转义，再拼装标签；链接只允许 http/https。
  // ---------------------------------------------------------------------------

  const ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return ESCAPE_MAP[character];
    });
  }

  // >>> markdown-renderer
  function renderMarkdown(source) {
    const lines = String(source || '')
      .replace(/\r\n?/g, '\n')
      .split('\n');

    const html = [];
    let paragraph = [];
    let list = null; // { type: 'ul' | 'ol', items: string[] }
    let quote = [];
    let code = null; // { lang: string, lines: string[] }

    function flushParagraph() {
      if (paragraph.length === 0) {
        return;
      }
      html.push(
        '<p>' + inlineMarkdown(paragraph.join('\n')).replace(/\n/g, '<br />') + '</p>',
      );
      paragraph = [];
    }

    function flushList() {
      if (!list) {
        return;
      }
      const items = list.items
        .map(function (item) {
          return '<li>' + inlineMarkdown(item) + '</li>';
        })
        .join('');
      html.push('<' + list.type + '>' + items + '</' + list.type + '>');
      list = null;
    }

    function flushQuote() {
      if (quote.length === 0) {
        return;
      }
      html.push(
        '<blockquote>' +
          quote
            .map(function (line) {
              return '<p>' + inlineMarkdown(line) + '</p>';
            })
            .join('') +
          '</blockquote>',
      );
      quote = [];
    }

    function flushAll() {
      flushParagraph();
      flushList();
      flushQuote();
    }

    lines.forEach(function (line) {
      const fence = line.match(/^\s*```(.*)$/);

      // 代码块内部：原样收集，直到遇到结束 fence（流式时可能还没结束）
      if (code) {
        if (fence) {
          html.push(renderCodeBlock(code.lang, code.lines.join('\n')));
          code = null;
        } else {
          code.lines.push(line);
        }
        return;
      }

      if (fence) {
        flushAll();
        code = {
          lang: fence[1].trim().split(/\s+/)[0] || '',
          lines: [],
        };
        return;
      }

      if (/^\s*$/.test(line)) {
        flushAll();
        return;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushAll();
        const level = heading[1].length;
        html.push(
          '<h' + level + '>' + inlineMarkdown(heading[2].trim()) + '</h' + level + '>',
        );
        return;
      }

      if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
        flushAll();
        html.push('<hr />');
        return;
      }

      const quoteLine = line.match(/^\s*>\s?(.*)$/);
      if (quoteLine) {
        flushParagraph();
        flushList();
        quote.push(quoteLine[1]);
        return;
      }

      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      if (bullet) {
        flushParagraph();
        flushQuote();
        if (!list || list.type !== 'ul') {
          flushList();
          list = { type: 'ul', items: [] };
        }
        list.items.push(bullet[1]);
        return;
      }

      const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ordered) {
        flushParagraph();
        flushQuote();
        if (!list || list.type !== 'ol') {
          flushList();
          list = { type: 'ol', items: [] };
        }
        list.items.push(ordered[1]);
        return;
      }

      // 列表项的续行
      if (list) {
        list.items[list.items.length - 1] += '\n' + line.trim();
        return;
      }

      // 引用的续行
      if (quote.length > 0) {
        quote.push(line.trim());
        return;
      }

      paragraph.push(line.trim());
    });

    // 流式输出中，代码块可能尚未闭合：按剩余内容渲染
    if (code) {
      html.push(renderCodeBlock(code.lang, code.lines.join('\n')));
    }
    flushAll();

    return html.join('');
  }

  function inlineMarkdown(text) {
    // 先按行内代码切分：代码段内部不做任何格式化，避免 `*args` 被当成斜体
    const segments = String(text).split(/(`[^`\n]*`)/g);

    return segments
      .map(function (segment) {
        if (segment.length >= 2 && segment.charAt(0) === '`' && segment.charAt(segment.length - 1) === '`') {
          return '<code>' + escapeHtml(segment.slice(1, -1)) + '</code>';
        }

        let html = escapeHtml(segment);

        // 链接：只允许 http/https（文本已经转义，不会闭合属性）
        html = html.replace(
          /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
          function (match, label, url) {
            return (
              '<a href="' + url + '" title="' + url + '">' + label + '</a>'
            );
          },
        );

        // 粗体、斜体、删除线
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
        html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');

        return html;
      })
      .join('');
  }

  function renderCodeBlock(lang, code) {
    const label = escapeHtml(lang || 'text');
    return (
      '<div class="code-block">' +
      '<div class="code-head">' +
      '<span class="code-lang">' + label + '</span>' +
      '<button type="button" class="link-btn" data-action="copy-code">复制</button>' +
      '</div>' +
      '<pre><code>' + escapeHtml(code) + '</code></pre>' +
      '</div>'
    );
  }
  // <<< markdown-renderer

  // 通知扩展：DOM 已就绪，可以发送初始数据了
  vscode.postMessage({ type: 'ready' });
})();
