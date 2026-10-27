/*
 * 团队设置 Webview 前端。
 *
 * 纯 DOM 构建（不用 innerHTML 拼接用户数据），所有 Provider / Role 都是动态列表。
 * 表单提交后由扩展再次校验并写入用户级 settings.json。
 */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const els = {
    status: document.getElementById('save-status'),
    save: document.getElementById('btn-save'),
    openChat: document.getElementById('btn-open-chat'),
    jsonSettings: document.getElementById('btn-json-settings'),
    errorBanner: document.getElementById('error-banner'),
    errorList: document.getElementById('error-list'),
    chatMode: document.getElementById('chat-mode'),
    scheduling: document.getElementById('scheduling'),
    schedulingHint: document.getElementById('scheduling-hint'),
    maxConcurrency: document.getElementById('max-concurrency'),
    summaryRole: document.getElementById('summary-role'),
    demoMode: document.getElementById('demo-mode'),
    enableHeartbeat: document.getElementById('enable-heartbeat'),
    providers: document.getElementById('providers'),
    providerCount: document.getElementById('provider-count'),
    datalists: document.getElementById('provider-datalists'),
    roles: document.getElementById('roles'),
    roleCount: document.getElementById('role-count'),
    addProvider: document.getElementById('btn-add-provider'),
    addRole: document.getElementById('btn-add-role'),
    toast: document.getElementById('toast'),
    modalOverlay: document.getElementById('modal-overlay'),
    modalTitle: document.getElementById('modal-title'),
    modalMessage: document.getElementById('modal-message'),
    modalCancel: document.getElementById('modal-cancel'),
    modalOk: document.getElementById('modal-ok'),
  };

  const FALLBACK_COLORS = [
    { id: 'blue', label: '蓝色' },
    { id: 'purple', label: '紫色' },
    { id: 'green', label: '绿色' },
    { id: 'orange', label: '橙色' },
    { id: 'red', label: '红色' },
    { id: 'pink', label: '粉色' },
    { id: 'cyan', label: '青色' },
    { id: 'yellow', label: '黄色' },
  ];

  const FALLBACK_EMOJIS = ['🧑‍💼', '🗄️', '🎨', '🧪', '🔍', '🛠️', '📊', '🧠', '🚀', '🛡️'];

  const FALLBACK_SCHEDULING = [
    {
      id: 'serial',
      label: '串行排队发言',
      description: '按角色列表顺序依次发言，后发言的角色能看到前面所有角色的内容。',
    },
    {
      id: 'parallel',
      label: '全部并行',
      description: '所有启用角色同时发言，响应更快，但彼此看不到本轮其他人的输出。',
    },
    {
      id: 'lead-then-parallel',
      label: '首位先行 + 其余并行',
      description: '列表第一个启用角色先发言，其余角色并行；其余角色都能看到首位角色的内容。',
    },
  ];

  const DEFAULT_ROLE_PROMPT =
    '你是一名正在参与多 AI 群聊的专家。请从你的专业角度分析需求，给出简洁、可执行的建议，并明确你的判断依据。';

  const state = {
    config: null,
    colors: FALLBACK_COLORS,
    emojis: FALLBACK_EMOJIS,
    schedulingOptions: FALLBACK_SCHEDULING,
    dirty: false,
    saving: false,
    loaded: false,
    savedProviderIds: new Set(),
    savedRoleIds: new Set(),
    pendingDeletes: new Map(),
    deletingKeys: new Set(),
    modalResolver: null,
    modalCancelable: false,
    modalPreviousFocus: null,
    toastTimer: 0,
  };

  // ---------------------------------------------------------------------------
  // 扩展 -> Webview
  // ---------------------------------------------------------------------------

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || typeof message.type !== 'string') {
      return;
    }

    switch (message.type) {
      case 'config':
        if (Array.isArray(message.colors) && message.colors.length > 0) {
          state.colors = message.colors;
        }
        if (Array.isArray(message.emojis) && message.emojis.length > 0) {
          state.emojis = message.emojis;
        }
        if (Array.isArray(message.schedulingOptions) && message.schedulingOptions.length > 0) {
          state.schedulingOptions = message.schedulingOptions;
        }
        state.config = normalizeConfig(message.config);
        state.loaded = true;
        state.saving = false;
        state.dirty = false;
        state.savedProviderIds = new Set(
          state.config.providers.map(function (provider) {
            return provider.id;
          }),
        );
        state.savedRoleIds = new Set(
          state.config.roles.map(function (role) {
            return role.id;
          }),
        );
        renderAll();
        hideErrors();
        setStatus('已加载', 'idle');
        break;

      case 'saved':
        state.config = normalizeConfig(message.config);
        state.loaded = true;
        state.saving = false;
        state.dirty = false;
        state.savedProviderIds = new Set(
          state.config.providers.map(function (provider) {
            return provider.id;
          }),
        );
        state.savedRoleIds = new Set(
          state.config.roles.map(function (role) {
            return role.id;
          }),
        );
        renderAll();
        hideErrors();
        setStatus('已保存', 'saved');
        toast('团队设置已保存', 'success');
        break;

      case 'error':
        state.saving = false;
        setSaveEnabled();
        const errors =
          Array.isArray(message.errors) && message.errors.length > 0
            ? message.errors
            : [typeof message.message === 'string' ? message.message : '保存失败。'];
        showErrors(errors);
        setStatus('保存失败', 'error');
        break;

      case 'key-status':
        updateProviderKey(message.providerId, Boolean(message.hasKey));
        break;

      case 'key-statuses':
        if (Array.isArray(message.statuses)) {
          message.statuses.forEach(function (item) {
            if (item && typeof item.providerId === 'string') {
              updateProviderKey(item.providerId, Boolean(item.hasKey));
            }
          });
        }
        break;

      case 'delete-result': {
        const pending = state.pendingDeletes.get(message.requestId);
        if (pending) {
          window.clearTimeout(pending.timer);
          state.pendingDeletes.delete(message.requestId);
          pending.resolve({
            ok: Boolean(message.ok),
            message:
              typeof message.message === 'string' && message.message
                ? message.message
                : message.ok
                  ? '已删除。'
                  : '删除失败。',
          });
        }
        break;
      }

      case 'toast':
        toast(message.text || '', message.level || 'info');
        break;

      default:
        break;
    }
  });

  function normalizeConfig(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const providers = Array.isArray(source.providers)
      ? source.providers.map(function (item, index) {
          const provider = item && typeof item === 'object' ? item : {};
          return {
            id:
              typeof provider.id === 'string' && provider.id.trim()
                ? provider.id.trim()
                : 'provider-' + (index + 1),
            name: typeof provider.name === 'string' ? provider.name : '',
            baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : '',
            models: Array.isArray(provider.models)
              ? provider.models.filter(function (model) {
                  return typeof model === 'string';
                })
              : [],
            hasKey: Boolean(provider.hasKey),
          };
        })
      : [];

    const roles = Array.isArray(source.roles)
      ? source.roles.map(function (item, index) {
          const role = item && typeof item === 'object' ? item : {};
          return {
            id:
              typeof role.id === 'string' && role.id.trim()
                ? role.id.trim()
                : 'role-' + (index + 1),
            name: typeof role.name === 'string' ? role.name : '',
            prompt: typeof role.prompt === 'string' ? role.prompt : '',
            providerId: typeof role.providerId === 'string' ? role.providerId : '',
            model: typeof role.model === 'string' ? role.model : '',
            temperature: normalizeRoleTemperature(role.temperature),
            emoji:
              typeof role.emoji === 'string' && role.emoji.trim()
                ? role.emoji
                : FALLBACK_EMOJIS[index % FALLBACK_EMOJIS.length],
            color: validColor(role.color),
            enabled: role.enabled !== false,
          };
        })
      : [];

    return {
      providers: providers,
      roles: roles,
      scheduling: validScheduling(source.scheduling),
      chatMode: source.chatMode === 'casual' ? 'casual' : 'work',
      summaryRoleId: typeof source.summaryRoleId === 'string' ? source.summaryRoleId : '',
      maxConcurrency: clampNumber(source.maxConcurrency, 1, 10, 3),
      demoMode: source.demoMode === true,
      enableHeartbeat: source.enableHeartbeat === true,
    };
  }

  function normalizeRoleTemperature(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return 0.7;
    }
    return Math.min(2, Math.max(0, value));
  }

  function validColor(value) {
    return state.colors.some(function (item) {
      return item.id === value;
    })
      ? value
      : 'blue';
  }

  function validScheduling(value) {
    return state.schedulingOptions.some(function (item) {
      return item.id === value;
    })
      ? value
      : 'lead-then-parallel';
  }

  function clampNumber(value, min, max, fallback) {
    if (value === '' || value === null || value === undefined) {
      return fallback;
    }
    const number = typeof value === 'number' ? Math.floor(value) : Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, number));
  }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  function renderAll() {
    if (!state.config) {
      return;
    }
    renderProviders();
    renderRoles();
    renderScheduling();
    updateCounts();
    setSaveEnabled();
  }

  function renderProviders() {
    els.providers.replaceChildren();
    const providers = state.config.providers;

    if (providers.length === 0) {
      els.providers.appendChild(
        emptyCard('还没有提供商。点击右上角「+ 添加提供商」接入任意 OpenAI 兼容接口。'),
      );
      renderDatalists();
      return;
    }

    providers.forEach(function (provider) {
      const card = h('article', 'entity-card provider-card');
      card.dataset.providerId = provider.id;

      const head = h('div', 'entity-head');
      const titleWrap = h('div', 'entity-title');
      titleWrap.append(
        h('span', 'entity-tag', '提供商'),
        h('code', 'entity-id', provider.id),
      );

      const actions = h('div', 'entity-actions');
      const keyBadge = h(
        'span',
        'key-badge ' + (provider.hasKey ? 'ok' : 'warn'),
        provider.hasKey ? '已配置 Key' : '未配置 Key',
      );
      keyBadge.dataset.keyBadge = provider.id;

      const setKeyButton = button('🔑 设置 Key', 'ghost-btn small', 'set-key');
      setKeyButton.title = '为该提供商设置或清除 API Key';
      const deleteProviderButton = button('🗑️ 删除', 'danger-btn small', 'delete-provider');
      deleteProviderButton.title = '删除这个提供商（有角色引用时会被拦截）';

      actions.append(keyBadge, setKeyButton, deleteProviderButton);
      head.append(titleWrap, actions);

      const grid = h('div', 'form-grid');
      grid.append(
        field('名称', textInput('name', provider.name, '例如 DeepSeek官方')),
        field('Base URL', textInput('baseUrl', provider.baseUrl, 'https://api.deepseek.com/v1')),
        field(
          '模型 ID（逗号分隔，用于角色输入提示）',
          textInput('models', provider.models.join(', '), 'deepseek-chat, deepseek-reasoner'),
          'span-2',
        ),
      );

      card.append(head, grid);
      els.providers.appendChild(card);
    });

    renderDatalists();
  }

  function renderDatalists() {
    els.datalists.replaceChildren();
    state.config.providers.forEach(function (provider) {
      const list = document.createElement('datalist');
      list.id = 'provider-models-' + provider.id;
      provider.models.forEach(function (model) {
        const option = document.createElement('option');
        option.value = model;
        list.appendChild(option);
      });
      els.datalists.appendChild(list);
    });
  }

  function renderRoles() {
    els.roles.replaceChildren();
    const roles = state.config.roles;
    const providers = state.config.providers;

    if (roles.length === 0) {
      els.roles.appendChild(
        emptyCard('还没有角色。点击右上角「+ 添加角色」，为它绑定 Provider、模型和 system prompt。'),
      );
      return;
    }

    roles.forEach(function (role, index) {
      const card = h('article', 'entity-card role-card');
      card.dataset.roleId = role.id;

      const head = h('div', 'entity-head role-head');
      const identity = h('div', 'role-identity');

      const emoji = textInput('emoji', role.emoji, '🤖');
      emoji.classList.add('emoji-input');
      emoji.maxLength = 4;

      const name = textInput('name', role.name, '角色名称');
      name.classList.add('role-name-input');

      identity.append(emoji, name);

      const actions = h('div', 'entity-actions');
      actions.appendChild(h('span', 'order-label', '顺序 #' + (index + 1)));

      const enabledLabel = h('label', 'switch');
      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.dataset.field = 'enabled';
      enabled.checked = role.enabled;
      enabledLabel.append(enabled, document.createTextNode(' 启用'));

      const moveUpButton = button('↑', 'ghost-btn tiny', 'move-up', index === 0);
      moveUpButton.title = '上移一位';
      const moveDownButton = button('↓', 'ghost-btn tiny', 'move-down', index === roles.length - 1);
      moveDownButton.title = '下移一位';
      const deleteRoleButton = button('🗑️ 删除', 'danger-btn small', 'delete-role');
      deleteRoleButton.title = '删除这个角色';

      actions.append(enabledLabel, moveUpButton, moveDownButton, deleteRoleButton);

      head.append(identity, actions);

      const temperature = document.createElement('input');
      temperature.type = 'number';
      temperature.min = '0';
      temperature.max = '2';
      temperature.step = '0.1';
      temperature.dataset.field = 'temperature';
      temperature.value = String(role.temperature);

      const grid = h('div', 'form-grid');
      grid.append(
        field('提供商', providerSelect(role.providerId)),
        field('模型 ID', modelInput(role, providers)),
        field('Temperature（0-2）', temperature),
        field('气泡颜色', colorSelect(role.color)),
        field('角色 ID', h('code', 'static-value', role.id)),
      );

      const promptLabel = h('label', 'field prompt-field');
      promptLabel.appendChild(h('span', 'field-label', 'System Prompt'));
      const prompt = document.createElement('textarea');
      prompt.dataset.field = 'prompt';
      prompt.rows = 5;
      prompt.placeholder = '描述这个角色的职责、审查重点和输出格式……';
      prompt.value = role.prompt;
      promptLabel.appendChild(prompt);

      card.append(head, grid, promptLabel);

      const provider = providers.find(function (item) {
        return item.id === role.providerId;
      });
      if (!provider) {
        const warning = h(
          'p',
          'role-warning',
          '绑定的提供商「' + (role.providerId || '空') + '」不存在，请修正后再保存。',
        );
        card.appendChild(warning);
      }

      els.roles.appendChild(card);
    });
  }

  function providerSelect(selectedId) {
    const select = document.createElement('select');
    select.dataset.field = 'providerId';

    const providers = state.config.providers;
    if (providers.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '（暂无提供商）';
      select.appendChild(option);
    } else {
      providers.forEach(function (provider) {
        const option = document.createElement('option');
        option.value = provider.id;
        option.textContent = provider.name || provider.id;
        select.appendChild(option);
      });
    }

    const exists = providers.some(function (provider) {
      return provider.id === selectedId;
    });
    if (!exists) {
      const option = document.createElement('option');
      option.value = selectedId;
      option.textContent = selectedId ? '（已删除：' + selectedId + '）' : '（未绑定）';
      select.appendChild(option);
    }

    select.value = selectedId;
    return select;
  }

  function modelInput(role, providers) {
    const input = textInput('model', role.model, '例如 deepseek-chat');
    const provider = providers.find(function (item) {
      return item.id === role.providerId;
    });
    if (provider) {
      input.setAttribute('list', 'provider-models-' + provider.id);
    }
    return input;
  }

  function colorSelect(selectedColor) {
    const select = document.createElement('select');
    select.dataset.field = 'color';
    state.colors.forEach(function (color) {
      const option = document.createElement('option');
      option.value = color.id;
      option.textContent = color.label;
      select.appendChild(option);
    });
    select.value = selectedColor;
    return select;
  }

  function renderScheduling() {
    els.scheduling.replaceChildren();
    state.schedulingOptions.forEach(function (item) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.label;
      els.scheduling.appendChild(option);
    });
    els.chatMode.value = state.config.chatMode;
    els.scheduling.value = state.config.scheduling;

    els.maxConcurrency.value = String(state.config.maxConcurrency);
    els.demoMode.checked = state.config.demoMode;
    els.enableHeartbeat.checked = state.config.enableHeartbeat;

    renderSummaryOptions();
    updateSchedulingHint();
  }

  function renderSummaryOptions() {
    els.summaryRole.replaceChildren();

    const none = document.createElement('option');
    none.value = '';
    none.textContent = '（不汇总）';
    els.summaryRole.appendChild(none);

    state.config.roles.forEach(function (role) {
      const option = document.createElement('option');
      option.value = role.id;
      option.textContent = role.name + (role.enabled ? '' : '（已禁用）');
      els.summaryRole.appendChild(option);
    });

    const summaryId = state.config.summaryRoleId;
    const exists = Array.from(els.summaryRole.options).some(function (option) {
      return option.value === summaryId;
    });
    if (summaryId && !exists) {
      const option = document.createElement('option');
      option.value = summaryId;
      option.textContent = '（不存在：' + summaryId + '）';
      els.summaryRole.appendChild(option);
    }
    els.summaryRole.value = summaryId;
  }

  function updateSchedulingHint() {
    if (state.config.chatMode === 'casual') {
      els.schedulingHint.textContent =
        '闲聊模式：忽略发言顺序、汇总角色和最大并发，随机选一个角色开场，然后自动接龙 2-3 轮。';
      return;
    }

    const selected = state.schedulingOptions.find(function (item) {
      return item.id === state.config.scheduling;
    });
    els.schedulingHint.textContent = selected ? selected.description : '';
  }

  function updateCounts() {
    els.providerCount.textContent = String(state.config.providers.length);
    els.roleCount.textContent = String(state.config.roles.length);
  }

  // ---------------------------------------------------------------------------
  // DOM 小工具
  // ---------------------------------------------------------------------------

  function h(tag, className, text) {
    const element = document.createElement(tag);
    if (className) {
      element.className = className;
    }
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  }

  function button(text, className, action, disabled) {
    const element = h('button', className, text);
    element.type = 'button';
    element.dataset.action = action;
    if (disabled) {
      element.disabled = true;
    }
    return element;
  }

  function textInput(fieldName, value, placeholder) {
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.field = fieldName;
    input.value = value || '';
    input.placeholder = placeholder || '';
    input.autocomplete = 'off';
    input.spellcheck = false;
    return input;
  }

  function field(labelText, control, extraClass) {
    const label = h('label', 'field' + (extraClass ? ' ' + extraClass : ''));
    label.appendChild(h('span', 'field-label', labelText));
    label.appendChild(control);
    return label;
  }

  function emptyCard(text) {
    const empty = h('div', 'empty-card', text);
    return empty;
  }

  // ---------------------------------------------------------------------------
  // 表单 -> state
  // ---------------------------------------------------------------------------

  document.addEventListener('input', function (event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    if (target.id === 'max-concurrency') {
      state.config.maxConcurrency = clampNumber(target.value, 1, 10, 3);
      markDirty();
      return;
    }

    const fieldName = target.dataset ? target.dataset.field : undefined;
    if (!fieldName) {
      return;
    }

    const providerCard = target.closest('.provider-card');
    if (providerCard) {
      const provider = getProvider(providerCard.dataset.providerId);
      if (!provider) {
        return;
      }
      applyProviderField(provider, fieldName, target.value);
      markDirty();
      return;
    }

    const roleCard = target.closest('.role-card');
    if (roleCard) {
      const role = getRole(roleCard.dataset.roleId);
      if (!role) {
        return;
      }
      applyRoleField(role, fieldName, target);
      markDirty();
    }
  });

  document.addEventListener('change', function (event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    if (target.id === 'chat-mode') {
      state.config.chatMode = target.value;
      updateSchedulingHint();
      markDirty();
      return;
    }
    if (target.id === 'scheduling') {
      state.config.scheduling = target.value;
      updateSchedulingHint();
      markDirty();
      return;
    }
    if (target.id === 'summary-role') {
      state.config.summaryRoleId = target.value;
      markDirty();
      return;
    }
    if (target.id === 'demo-mode') {
      state.config.demoMode = target.checked;
      markDirty();
      return;
    }
    if (target.id === 'enable-heartbeat') {
      state.config.enableHeartbeat = target.checked;
      markDirty();
      return;
    }
    if (target.id === 'max-concurrency') {
      state.config.maxConcurrency = clampNumber(target.value, 1, 10, 3);
      markDirty();
      return;
    }

    const fieldName = target.dataset ? target.dataset.field : undefined;
    if (!fieldName) {
      return;
    }

    const roleCard = target.closest('.role-card');
    if (roleCard) {
      const role = getRole(roleCard.dataset.roleId);
      if (!role) {
        return;
      }

      if (fieldName === 'providerId') {
        role.providerId = target.value;
        const provider = getProvider(role.providerId);
        const modelField = roleCard.querySelector('input[data-field="model"]');
        if (modelField) {
          if (provider) {
            modelField.setAttribute('list', 'provider-models-' + provider.id);
          } else {
            modelField.removeAttribute('list');
          }
          if (
            provider &&
            provider.models.length > 0 &&
            (!role.model || provider.models.indexOf(role.model) === -1)
          ) {
            role.model = provider.models[0];
            modelField.value = role.model;
          }
        }
        updateRoleWarning(roleCard, role);
      } else if (fieldName === 'enabled') {
        role.enabled = target.checked;
        renderSummaryOptions();
      } else if (fieldName === 'color') {
        role.color = target.value;
      } else {
        applyRoleField(role, fieldName, target);
      }
      markDirty();
    }

    const providerCard = target.closest('.provider-card');
    if (providerCard) {
      const provider = getProvider(providerCard.dataset.providerId);
      if (!provider) {
        return;
      }
      applyProviderField(provider, fieldName, target.value);
      markDirty();
    }
  });

  function applyProviderField(provider, fieldName, value) {
    if (fieldName === 'name') {
      provider.name = value;
      refreshProviderOptionLabels(provider);
    } else if (fieldName === 'baseUrl') {
      provider.baseUrl = value;
    } else if (fieldName === 'models') {
      provider.models = value
        .split(',')
        .map(function (item) {
          return item.trim();
        })
        .filter(Boolean);
      updateProviderDatalist(provider);
    }
  }

  function applyRoleField(role, fieldName, target) {
    if (fieldName === 'name') {
      role.name = target.value;
      refreshSummaryOptionLabels();
    } else if (fieldName === 'prompt') {
      role.prompt = target.value;
    } else if (fieldName === 'model') {
      role.model = target.value;
    } else if (fieldName === 'emoji') {
      role.emoji = target.value;
    } else if (fieldName === 'enabled') {
      role.enabled = target.checked;
    } else if (fieldName === 'color') {
      role.color = target.value;
    } else if (fieldName === 'temperature') {
      const value = Number(target.value);
      role.temperature =
        target.value.trim() !== '' && Number.isFinite(value)
          ? Math.min(2, Math.max(0, value))
          : 0.7;
    }
  }

  function getProvider(id) {
    return state.config.providers.find(function (provider) {
      return provider.id === id;
    });
  }

  function getRole(id) {
    return state.config.roles.find(function (role) {
      return role.id === id;
    });
  }

  function refreshProviderOptionLabels(provider) {
    const selects = document.querySelectorAll('select[data-field="providerId"]');
    selects.forEach(function (select) {
      Array.from(select.options).forEach(function (option) {
        if (option.value === provider.id) {
          option.textContent = provider.name || provider.id;
        }
      });
    });
  }

  function refreshSummaryOptionLabels() {
    const options = els.summaryRole.querySelectorAll('option');
    options.forEach(function (option) {
      const role = getRole(option.value);
      if (role) {
        option.textContent = role.name + (role.enabled ? '' : '（已禁用）');
      }
    });
  }

  function updateProviderDatalist(provider) {
    const list = document.getElementById('provider-models-' + provider.id);
    if (!list) {
      return;
    }
    list.replaceChildren();
    provider.models.forEach(function (model) {
      const option = document.createElement('option');
      option.value = model;
      list.appendChild(option);
    });
  }

  function updateRoleWarning(card, role) {
    const existing = card.querySelector('.role-warning');
    const provider = getProvider(role.providerId);
    if (provider) {
      if (existing) {
        existing.remove();
      }
      return;
    }
    const warning =
      existing ||
      h(
        'p',
        'role-warning',
        '绑定的提供商「' + (role.providerId || '空') + '」不存在，请修正后再保存。',
      );
    warning.textContent =
      '绑定的提供商「' + (role.providerId || '空') + '」不存在，请修正后再保存。';
    if (!existing) {
      card.appendChild(warning);
    }
  }

  function updateProviderKey(providerId, hasKey) {
    const provider = getProvider(providerId);
    if (provider) {
      provider.hasKey = hasKey;
    }
    const badges = document.querySelectorAll('[data-key-badge]');
    badges.forEach(function (badge) {
      if (badge.dataset.keyBadge === providerId) {
        badge.className = 'key-badge ' + (hasKey ? 'ok' : 'warn');
        badge.textContent = hasKey ? '已配置 Key' : '未配置 Key';
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 增删 / 排序
  // ---------------------------------------------------------------------------

  els.addProvider.addEventListener('click', function () {
    if (!state.config) {
      return;
    }
    const id = uniqueId('provider');
    state.config.providers.push({
      id: id,
      name: '新提供商',
      baseUrl: '',
      models: [],
      hasKey: false,
    });
    markDirty();
    renderProviders();
    renderRoles();
    renderScheduling();
    updateCounts();
    focusEntityField('.provider-card', 'providerId', id, 'name');
  });

  els.addRole.addEventListener('click', function () {
    if (!state.config) {
      return;
    }
    const id = uniqueId('role');
    const index = state.config.roles.length;
    const provider = state.config.providers[0];
    state.config.roles.push({
      id: id,
      name: '新角色',
      prompt: DEFAULT_ROLE_PROMPT,
      providerId: provider ? provider.id : '',
      model: provider && provider.models.length > 0 ? provider.models[0] : '',
      temperature: 0.7,
      emoji: state.emojis[index % state.emojis.length] || '🤖',
      color: state.colors[index % state.colors.length]
        ? state.colors[index % state.colors.length].id
        : 'blue',
      enabled: true,
    });
    markDirty();
    renderRoles();
    renderScheduling();
    updateCounts();
    focusEntityField('.role-card', 'roleId', id, 'name');
  });

  function uniqueId(prefix) {
    let id = '';
    do {
      id =
        prefix +
        '-' +
        Date.now().toString(36) +
        Math.random().toString(36).slice(2, 6);
    } while (
      state.config.providers.some(function (provider) {
        return provider.id === id;
      }) ||
      state.config.roles.some(function (role) {
        return role.id === id;
      })
    );
    return id;
  }

  function focusEntityField(cardSelector, idKey, id, fieldName) {
    const cards = document.querySelectorAll(cardSelector);
    for (let index = 0; index < cards.length; index += 1) {
      const card = cards[index];
      const value = idKey === 'providerId' ? card.dataset.providerId : card.dataset.roleId;
      if (value === id) {
        const field = card.querySelector('[data-field="' + fieldName + '"]');
        if (field) {
          field.focus();
          if (typeof field.select === 'function') {
            field.select();
          }
        }
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 动态按钮
  // ---------------------------------------------------------------------------

  document.addEventListener('click', async function (event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const actionElement = target.closest('[data-action]');
    if (!actionElement || !state.config) {
      return;
    }

    const action = actionElement.dataset.action;
    const roleCard = actionElement.closest('.role-card');
    const providerCard = actionElement.closest('.provider-card');

    if (action === 'set-key' && providerCard) {
      const providerId = providerCard.dataset.providerId;
      if (!state.savedProviderIds.has(providerId)) {
        toast('请先保存团队设置，再为这个新 Provider 配置 API Key。', 'warn');
        return;
      }
      vscode.postMessage({
        type: 'setApiKey',
        providerId: providerId,
      });
      return;
    }

    if (action === 'delete-provider' && providerCard) {
      await deleteProvider(providerCard.dataset.providerId);
      return;
    }

    if (action === 'delete-role' && roleCard) {
      await deleteRole(roleCard.dataset.roleId);
      return;
    }

    if ((action === 'move-up' || action === 'move-down') && roleCard) {
      const index = state.config.roles.findIndex(function (role) {
        return role.id === roleCard.dataset.roleId;
      });
      if (index < 0) {
        return;
      }
      const targetIndex = action === 'move-up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= state.config.roles.length) {
        return;
      }
      const current = state.config.roles[index];
      state.config.roles[index] = state.config.roles[targetIndex];
      state.config.roles[targetIndex] = current;
      markDirty();
      renderRoles();
      renderScheduling();
      updateCounts();
    }
  });

  // ---------------------------------------------------------------------------
  // 删除
  //
  // 说明：
  //   - 删除确认使用自绘 modal，不用 window.confirm（VS Code Webview 中不可靠）；
  //   - 表单没有其他未保存修改且实体已保存时，走后端 deleteRole / deleteProvider 立即持久化；
  //   - 表单有未保存修改时，只做本地移除，等用户点击「保存更改」一起提交，避免覆盖未保存内容。
  // ---------------------------------------------------------------------------

  async function deleteRole(roleId) {
    const role = getRole(roleId);
    const lockKey = 'role:' + roleId;
    if (!role || state.deletingKeys.has(lockKey)) {
      return;
    }
    state.deletingKeys.add(lockKey);

    const canPersist = !state.dirty && state.savedRoleIds.has(roleId);

    try {
      const confirmed = await openModal({
        title: '删除角色',
        message:
          '确定删除角色「' +
          (role.name || role.id) +
          '」吗？\n\n' +
          (canPersist
            ? '当前没有其他未保存修改，删除后会立即写入团队设置。'
            : '删除后请点击右上角「保存更改」才会写入团队设置。'),
        showCancel: true,
        okText: '🗑️ 删除',
        danger: true,
      });
      if (!confirmed) {
        return;
      }

      if (canPersist) {
        const result = await requestDelete('deleteRole', { roleId: roleId });
        if (!result.ok) {
          await showAlert('删除角色失败', result.message);
          return;
        }

        state.savedRoleIds.delete(roleId);
        removeRoleLocally(roleId);
        if (!state.dirty) {
          setStatus('已删除并保存', 'saved');
        }
        if (state.config.roles.length === 0) {
          toast('角色已删除，团队为空，请添加新角色。', 'warn');
        } else {
          toast(result.message, 'success');
        }
        return;
      }

      removeRoleLocally(roleId);
      markDirty();
      if (state.config.roles.length === 0) {
        toast('已从表单移除，团队为空，请添加新角色；点击「保存更改」生效。', 'warn');
      } else {
        toast('已从表单移除，点击「保存更改」生效。', 'info');
      }
    } catch (error) {
      await showAlert('删除角色失败', error instanceof Error ? error.message : String(error));
    } finally {
      state.deletingKeys.delete(lockKey);
    }
  }

  async function deleteProvider(providerId) {
    const provider = getProvider(providerId);
    const lockKey = 'provider:' + providerId;
    if (!provider || state.deletingKeys.has(lockKey)) {
      return;
    }
    state.deletingKeys.add(lockKey);

    try {
      const references = state.config.roles.filter(function (role) {
        return role.providerId === providerId;
      });
      if (references.length > 0) {
        const names = references
          .slice(0, 6)
          .map(function (role) {
            return '「' + (role.name || role.id) + '」';
          })
          .join('、');
        await showAlert(
          '无法删除提供商',
          '「' +
            (provider.name || provider.id) +
            '」仍被 ' +
            references.length +
            ' 个角色引用：' +
            names +
            (references.length > 6 ? ' 等' : '') +
            '。\n\n请先在角色的「提供商」下拉框中换成其他 Provider，保存后再删除。',
        );
        return;
      }

      const canPersist = !state.dirty && state.savedProviderIds.has(providerId);

      const confirmed = await openModal({
        title: '删除提供商',
        message:
          '确定删除提供商「' +
          (provider.name || provider.id) +
          '」吗？\n\n' +
          (canPersist
            ? '当前没有其他未保存修改，删除后会立即写入团队设置。'
            : '删除后请点击右上角「保存更改」才会写入团队设置。'),
        showCancel: true,
        okText: '🗑️ 删除',
        danger: true,
      });
      if (!confirmed) {
        return;
      }

      if (canPersist) {
        const result = await requestDelete('deleteProvider', { providerId: providerId });
        if (!result.ok) {
          await showAlert('删除提供商失败', result.message);
          return;
        }

        state.savedProviderIds.delete(providerId);
        removeProviderLocally(providerId);
        if (!state.dirty) {
          setStatus('已删除并保存', 'saved');
        }
        if (state.config.providers.length === 0) {
          toast('提供商已删除，团队为空，请添加新的提供商和角色。', 'warn');
        } else {
          toast(result.message, 'success');
        }
        return;
      }

      removeProviderLocally(providerId);
      markDirty();
      if (state.config.providers.length === 0) {
        toast('已从表单移除，团队为空，请添加提供商和角色；点击「保存更改」生效。', 'warn');
      } else {
        toast('已从表单移除，点击「保存更改」生效。', 'info');
      }
    } catch (error) {
      await showAlert('删除提供商失败', error instanceof Error ? error.message : String(error));
    } finally {
      state.deletingKeys.delete(lockKey);
    }
  }

  function removeRoleLocally(roleId) {
    state.config.roles = state.config.roles.filter(function (role) {
      return role.id !== roleId;
    });
    if (state.config.summaryRoleId === roleId) {
      state.config.summaryRoleId = '';
    }
    renderRoles();
    renderScheduling();
    updateCounts();
  }

  function removeProviderLocally(providerId) {
    state.config.providers = state.config.providers.filter(function (provider) {
      return provider.id !== providerId;
    });
    renderProviders();
    renderRoles();
    renderScheduling();
    updateCounts();
  }

  function requestDelete(type, payload) {
    return new Promise(function (resolve) {
      const requestId =
        'delete-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const timer = window.setTimeout(function () {
        state.pendingDeletes.delete(requestId);
        resolve({ ok: false, message: '删除请求超时（10 秒），请重试。' });
      }, 10000);

      state.pendingDeletes.set(requestId, { resolve: resolve, timer: timer });
      vscode.postMessage(Object.assign({ type: type, requestId: requestId }, payload));
    });
  }

  // ---------------------------------------------------------------------------
  // 自定义确认弹窗
  // ---------------------------------------------------------------------------

  function openModal(options) {
    if (!els.modalOverlay) {
      return Promise.resolve(false);
    }
    if (state.modalResolver) {
      // 同一时间只允许一个弹窗
      return Promise.resolve(false);
    }

    return new Promise(function (resolve) {
      state.modalResolver = resolve;
      state.modalCancelable = options.showCancel !== false;
      state.modalPreviousFocus = document.activeElement;

      els.modalTitle.textContent = options.title || '提示';
      els.modalMessage.textContent = options.message || '';
      els.modalCancel.hidden = !state.modalCancelable;
      els.modalOk.textContent = options.okText || '确定';
      els.modalOk.className = options.danger ? 'danger-btn' : 'primary-btn';
      els.modalOverlay.hidden = false;

      (state.modalCancelable ? els.modalCancel : els.modalOk).focus();
    });
  }

  function closeModal(result) {
    if (!state.modalResolver) {
      return;
    }
    const resolver = state.modalResolver;
    state.modalResolver = null;
    els.modalOverlay.hidden = true;

    if (state.modalPreviousFocus && typeof state.modalPreviousFocus.focus === 'function') {
      state.modalPreviousFocus.focus();
    }
    state.modalPreviousFocus = null;
    resolver(Boolean(result));
  }

  function showAlert(title, message) {
    return openModal({
      title: title,
      message: message,
      showCancel: false,
      okText: '知道了',
      danger: false,
    });
  }

  els.modalCancel.addEventListener('click', function () {
    closeModal(false);
  });

  els.modalOk.addEventListener('click', function () {
    closeModal(true);
  });

  els.modalOverlay.addEventListener('click', function (event) {
    if (event.target === els.modalOverlay && state.modalCancelable) {
      closeModal(false);
    }
  });

  document.addEventListener('keydown', function (event) {
    if (!els.modalOverlay || els.modalOverlay.hidden) {
      return;
    }
    if (event.key === 'Escape' && state.modalCancelable) {
      event.preventDefault();
      closeModal(false);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      closeModal(true);
    }
  });

  // ---------------------------------------------------------------------------
  // 保存 / 校验
  // ---------------------------------------------------------------------------

  els.save.addEventListener('click', save);
  els.openChat.addEventListener('click', function () {
    vscode.postMessage({ type: 'openChat' });
  });
  els.jsonSettings.addEventListener('click', function () {
    vscode.postMessage({ type: 'openVsCodeSettings' });
  });

  window.addEventListener('keydown', function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (els.modalOverlay && !els.modalOverlay.hidden) {
        return;
      }
      save();
    }
  });

  function save() {
    if (!state.config || state.saving) {
      return;
    }

    const payload = collectPayload();
    const errors = validateClient(payload);
    if (errors.length > 0) {
      showErrors(errors);
      setStatus('请检查表单', 'error');
      return;
    }

    hideErrors();
    state.saving = true;
    setSaveEnabled();
    setStatus('保存中…', 'saving');
    vscode.postMessage({ type: 'save', payload: payload });
  }

  function collectPayload() {
    return {
      providers: state.config.providers.map(function (provider) {
        return {
          id: provider.id.trim(),
          name: provider.name.trim(),
          baseUrl: provider.baseUrl.trim(),
          models: Array.from(
            new Set(
              provider.models
                .map(function (model) {
                  return model.trim();
                })
                .filter(Boolean),
            ),
          ),
        };
      }),
      roles: state.config.roles.map(function (role) {
        return {
          id: role.id.trim(),
          name: role.name.trim(),
          prompt: role.prompt.trim(),
          providerId: role.providerId.trim(),
          model: role.model.trim(),
          temperature: normalizeRoleTemperature(role.temperature),
          emoji: role.emoji.trim(),
          color: role.color,
          enabled: Boolean(role.enabled),
        };
      }),
      scheduling: state.config.scheduling,
      chatMode: state.config.chatMode,
      summaryRoleId: state.config.summaryRoleId,
      maxConcurrency: Number(state.config.maxConcurrency),
      demoMode: Boolean(state.config.demoMode),
      enableHeartbeat: Boolean(state.config.enableHeartbeat),
    };
  }

  function validateClient(payload) {
    const errors = [];
    const providerIds = new Set();

    // 允许空团队：删除最后一个 Provider / Role 后仍然可以保存。
    // 聊天面板会在发送时提示「请添加角色」。
    payload.providers.forEach(function (provider, index) {
      if (!provider.name) {
        errors.push('提供商 #' + (index + 1) + ' 缺少名称。');
      }
      if (!provider.baseUrl) {
        errors.push('提供商「' + (provider.name || provider.id) + '」缺少 Base URL。');
      } else if (!isHttpUrl(provider.baseUrl)) {
        errors.push('提供商「' + (provider.name || provider.id) + '」的 Base URL 必须是 http/https 地址。');
      }
      if (providerIds.has(provider.id)) {
        errors.push('提供商 ID「' + provider.id + '」重复。');
      }
      providerIds.add(provider.id);
    });

    payload.roles.forEach(function (role, index) {
      if (!role.name) {
        errors.push('角色 #' + (index + 1) + ' 缺少名称。');
      }
      if (!role.prompt) {
        errors.push('角色「' + (role.name || role.id) + '」缺少 System Prompt。');
      }
      if (!role.providerId) {
        errors.push('角色「' + (role.name || role.id) + '」没有绑定提供商。');
      } else if (!providerIds.has(role.providerId)) {
        errors.push('角色「' + (role.name || role.id) + '」绑定的提供商不存在。');
      }
      if (!role.model) {
        errors.push('角色「' + (role.name || role.id) + '」没有选择模型。');
      }
      if (
        typeof role.temperature !== 'number' ||
        !Number.isFinite(role.temperature) ||
        role.temperature < 0 ||
        role.temperature > 2
      ) {
        errors.push('角色「' + (role.name || role.id) + '」的 temperature 必须是 0 ~ 2 的数字。');
      }
    });


    if (payload.chatMode !== 'casual' && payload.summaryRoleId) {
      const summaryRole = payload.roles.find(function (role) {
        return role.id === payload.summaryRoleId;
      });
      if (!summaryRole) {
        errors.push('汇总角色不存在。');
      } else if (!summaryRole.enabled) {
        errors.push('汇总角色「' + summaryRole.name + '」处于禁用状态。');
      }
    }

    if (
      !Number.isFinite(payload.maxConcurrency) ||
      payload.maxConcurrency < 1 ||
      payload.maxConcurrency > 10
    ) {
      errors.push('最大并发数必须是 1 ~ 10 的整数。');
    }

    return errors;
  }

  function isHttpUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (error) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // 状态 / 错误 / Toast
  // ---------------------------------------------------------------------------

  function markDirty() {
    if (!state.dirty) {
      state.dirty = true;
      setStatus('未保存的更改', 'dirty');
    }
    hideErrors();
  }

  function setStatus(text, stateName) {
    els.status.textContent = text;
    els.status.dataset.state = stateName;
  }

  function setSaveEnabled() {
    els.save.disabled = !state.loaded || state.saving;
  }

  function showErrors(errors) {
    els.errorList.replaceChildren();
    errors.forEach(function (error) {
      const item = document.createElement('li');
      item.textContent = error;
      els.errorList.appendChild(item);
    });
    els.errorBanner.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function hideErrors() {
    els.errorBanner.hidden = true;
    els.errorList.replaceChildren();
  }

  function toast(text, level) {
    if (!text) {
      return;
    }
    els.toast.textContent = text;
    els.toast.className = 'toast ' + (level || 'info');
    els.toast.hidden = false;

    if (state.toastTimer) {
      window.clearTimeout(state.toastTimer);
    }
    state.toastTimer = window.setTimeout(function () {
      els.toast.hidden = true;
    }, 2800);
  }

  // 提示扩展：DOM 已就绪
  vscode.postMessage({ type: 'ready' });
})();
