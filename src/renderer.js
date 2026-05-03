const fs = require('fs');
const path = require('path');
const os = require('os');
const { shell, ipcRenderer } = require('electron');

// 路径配置
const homeDir = os.homedir();
const claudeRoot = path.join(homeDir, '.claude');
const activeSettingsPath = path.join(claudeRoot, 'settings.json');
const activeProfilePath = path.join(claudeRoot, '.active-profile');

let currentLoadedProfile = '';
let selectedProfile = '';

// API 格式定义
const API_FORMATS = [
  {
    id: 'anthropic-native',
    name: 'Anthropic 原生 API',
    endpoint: '/v1/messages',
    authHeader: 'x-api-key',
    authPrefix: '',
    additionalHeaders: { 'anthropic-version': '2023-06-01' },
    requestBody: (model) => ({
      model: model,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Hi' }]
    }),
    urlPatterns: ['anthropic.com', 'claude.ai']
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI 兼容格式',
    endpoint: '/v1/chat/completions',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    additionalHeaders: {},
    requestBody: (model) => ({
      model: model,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Hi' }]
    }),
    urlPatterns: ['sensenova.cn', 'deepseek.com', 'openai.com', 'api.openai.com', 'token.sensenova']
  },
  {
    id: 'minimax-anthropic',
    name: 'MiniMax Anthropic 兼容',
    endpoint: '/v1/messages',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    additionalHeaders: { 'anthropic-version': '2023-06-01' },
    requestBody: (model) => ({
      model: model,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Hi' }]
    }),
    urlPatterns: ['minimax.chat']
  },
  {
    id: 'volcengine-api',
    name: '火山引擎 API',
    endpoint: '/v1/chat/completions',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    additionalHeaders: {},
    requestBody: (model) => ({
      model: model,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Hi' }]
    }),
    urlPatterns: ['volcengine.com', 'ark.cn']
  },
  {
    id: 'generic-messages',
    name: '通用 /v1/messages 端点',
    endpoint: '/v1/messages',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    additionalHeaders: {},
    requestBody: (model) => ({
      model: model,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Hi' }]
    }),
    urlPatterns: []
  },
  {
    id: 'generic-completions',
    name: '通用 /v1/chat/completions 端点',
    endpoint: '/v1/chat/completions',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    additionalHeaders: {},
    requestBody: (model) => ({
      model: model,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Hi' }]
    }),
    urlPatterns: []
  }
];

// 工具函数
function profilePath(name) {
  return path.join(claudeRoot, `settings.${name}.json`);
}

function ensureFolder(folderPath) {
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }
}

function readText(filePath) {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

function writeText(filePath, text) {
  ensureFolder(path.dirname(filePath));

  if (fs.existsSync(filePath)) {
    try {
      fs.accessSync(filePath, fs.constants.W_OK);
    } catch (e) {
      // 某些迁移/复制场景下文件可能是只读，尽量自动修复权限
      try { fs.chmodSync(filePath, 0o600); } catch (chmodErr) {}
    }
  }

  fs.writeFileSync(filePath, text, 'utf-8');
}

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

function scanProfiles() {
  const results = [];
  if (!fs.existsSync(claudeRoot)) return results;

  const files = fs.readdirSync(claudeRoot);
  files.forEach(file => {
    const lower = file.toLowerCase();
    if (lower === 'settings.json') return;
    if (!lower.startsWith('settings.')) return;
    if (!lower.endsWith('.json')) return;

    const profile = file.substring(9, file.length - 5);
    if (profile && profile !== 'json') {
      results.push(profile);
    }
  });

  results.sort();
  return results;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function jsonPrettyOrRaw(text) {
  const parsed = parseJson(text);
  if (!parsed) return text;
  return JSON.stringify(parsed, null, 2);
}

function getActiveProfile() {
  const marker = readText(activeProfilePath).trim();
  if (marker && fileExists(profilePath(marker))) {
    return marker;
  }

  if (fileExists(activeSettingsPath)) {
    const activeText = readText(activeSettingsPath);
    const profiles = scanProfiles();
    for (const profile of profiles) {
      if (readText(profilePath(profile)) === activeText) {
        return profile;
      }
    }
  }

  return '';
}

function getBaseUrl() {
  const parsed = parseJson(readText(activeSettingsPath));
  if (parsed && parsed.env && parsed.env.ANTHROPIC_BASE_URL) {
    return parsed.env.ANTHROPIC_BASE_URL;
  }
  return '';
}

function getProfileMeta(profileName) {
  const text = readText(profilePath(profileName));
  const parsed = parseJson(text);
  if (!parsed || !parsed.env) return '';

  const url = parsed.env.ANTHROPIC_BASE_URL || '';
  if (url) {
    try {
      const match = url.match(/\/\/([^\/]+)/);
      if (match) return match[1].replace(/\/$/, '');
    } catch (e) {}
    return url;
  }
  return '';
}

function getDefaultProfileTemplate() {
  return JSON.stringify({
    "$schema": "https://json.schemastore.org/claude-code-settings.json",
    "model": "opus[1m]",
    "effortLevel": "medium",
    "includeCoAuthoredBy": false,
    "skipDangerousModePermissionPrompt": true,
    "permissions": {
      "mode": "auto",
      "allow": [
        "mcp__pencil",
        "mcp__pencil__batch_design",
        "mcp__pencil__batch_get",
        "mcp__pencil__get_editor_state",
        "mcp__pencil__get_screenshot",
        "mcp__pencil__get_guidelines",
        "mcp__pencil__get_variables",
        "mcp__pencil__snapshot_layout",
        "mcp__pencil__spawn_agents",
        "mcp__pencil__find_empty_space_on_canvas",
        "mcp__pencil__export_nodes",
        "mcp__pencil__search_all_unique_properties",
        "mcp__pencil__replace_all_matching_properties",
        "mcp__pencil__set_variables",
        "mcp__pencil__open_document"
      ]
    },
    "enabledPlugins": {
      "chrome-devtools-mcp@claude-plugins-official": true,
      "claude-md-management@claude-plugins-official": true,
      "code-review@claude-plugins-official": true,
      "code-simplifier@claude-plugins-official": true,
      "context7@claude-plugins-official": true,
      "figma@claude-plugins-official": true,
      "frontend-design@claude-plugins-official": true,
      "github@claude-plugins-official": true,
      "playground@claude-plugins-official": true,
      "playwright@claude-plugins-official": true,
      "ralph-loop@claude-plugins-official": true,
      "rust-analyzer-lsp@claude-plugins-official": true,
      "skill-creator@claude-plugins-official": true
    },
    "extraKnownMarketplaces": {
      "anthropic-agent-skills": {
        "source": {
          "source": "github",
          "repo": "anthropics/skills"
        }
      }
    },
    "env": {
      "ANTHROPIC_BASE_URL": "",
      "ANTHROPIC_AUTH_TOKEN": "",
      "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
      "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
      "ENABLE_TOOL_SEARCH": "true",
      "API_TIMEOUT_MS": "600000",
      "BASH_DEFAULT_TIMEOUT_MS": "120000",
      "CLAUDE_CODE_MAX_RETRIES": "10",
      "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY": "10",
      "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "80",
      "CLAUDE_CODE_SYNTAX_HIGHLIGHT": "true",
      "DISABLE_TELEMETRY": "1",
      "DISABLE_ERROR_REPORTING": "0",
      "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB": "1"
    }
  }, null, 2);
}

function buildJsonFromFields() {
  const jsonNode = document.getElementById('profileJson');
  const current = parseJson(jsonNode.value) || {};
  if (!current.env) current.env = {};

  current.env.ANTHROPIC_BASE_URL = document.getElementById('baseUrl').value.trim();
  current.env.ANTHROPIC_AUTH_TOKEN = document.getElementById('apiKey').value.trim();

  if (!current.env.CLAUDE_CODE_ATTRIBUTION_HEADER) {
    current.env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
  }

  return JSON.stringify(current, null, 2);
}

function syncFieldsFromJson() {
  const parsed = parseJson(document.getElementById('profileJson').value);
  if (!parsed || !parsed.env) return;

  document.getElementById('baseUrl').value = parsed.env.ANTHROPIC_BASE_URL || '';
  document.getElementById('apiKey').value = parsed.env.ANTHROPIC_AUTH_TOKEN || '';
}

function syncJsonFromFields() {
  document.getElementById('profileJson').value = buildJsonFromFields();
}

function syncStatus() {
  const active = getActiveProfile() || 'unknown';
  const baseUrl = getBaseUrl();

  document.getElementById('status').innerText = '配置已同步';
  document.getElementById('footerHint').innerText = active === 'unknown'
    ? '状态：未检测到激活配置'
    : `状态：已激活 ${active}`;
}

function saveProfileFile(name, jsonText) {
  ensureFolder(claudeRoot);
  writeText(profilePath(name), jsonText);
}

function ensureSelection() {
  if (!selectedProfile) {
    showAlert('请先选择一个配置。');
    return null;
  }
  return selectedProfile;
}

function selectProfileItem(name) {
  const items = document.querySelectorAll('.sidebar-item');
  items.forEach(item => {
    if (item.dataset.profile === name) {
      item.classList.add('selected');
    } else {
      item.classList.remove('selected');
    }
  });
}

function rebuildProfileList(activeProfile) {
  const profiles = scanProfiles();
  const listEl = document.getElementById('profileList');
  listEl.innerHTML = '';

  profiles.forEach(profile => {
    const div = document.createElement('div');
    div.className = 'sidebar-item';
    div.dataset.profile = profile;

    if (profile === activeProfile) {
      div.classList.add('active');
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'item-name';
    nameSpan.textContent = profile;

    const metaSpan = document.createElement('span');
    metaSpan.className = 'item-meta';
    metaSpan.textContent = getProfileMeta(profile);

    // 添加测试状态图标
    const statusIcon = document.createElement('span');
    statusIcon.className = 'profile-status-icon';

    const config = parseJson(readText(profilePath(profile)));
    if (config && config.apiFormat && config.apiFormat.testResult) {
      if (config.apiFormat.testResult.success) {
        // 测试成功时隐藏图标
        statusIcon.style.display = 'none';
      } else {
        statusIcon.textContent = '❌';
        statusIcon.title = '测试失败';
      }
    } else {
      statusIcon.textContent = '⚠️';
      statusIcon.title = '未测试';
    }

    div.appendChild(nameSpan);
    div.appendChild(metaSpan);
    div.appendChild(statusIcon);

    div.onclick = () => {
      selectedProfile = profile;
      selectProfileItem(profile);
      loadSelectedProfile();
    };

    listEl.appendChild(div);
  });
}

function loadSelectedProfile() {
  const selected = ensureSelection();
  if (!selected) return;

  currentLoadedProfile = selected;
  document.getElementById('profileName').value = selected;
  document.getElementById('profileJson').value = fileExists(profilePath(selected))
    ? jsonPrettyOrRaw(readText(profilePath(selected)))
    : getDefaultProfileTemplate();

  syncFieldsFromJson();
  syncStatus();
}

function saveCurrent() {
  const name = document.getElementById('profileName').value.trim();
  if (!name) {
    showAlert('配置名称不能为空。');
    return;
  }

  syncJsonFromFields();
  const jsonText = document.getElementById('profileJson').value;
  if (!parseJson(jsonText)) {
    showAlert('JSON 格式无效，请先修正。');
    return;
  }

  ensureFolder(claudeRoot);
  saveProfileFile(name, jsonText);
  selectedProfile = name;
  rebuildProfileList(name);
  currentLoadedProfile = name;
  syncStatus();
  showAlert(`已保存 ${name}`);
}

function createNewProfile() {
  // 创建自定义输入对话框
  showInputDialog('请输入新配置名称', 'custom', (name) => {
    if (!name) return;

    const trimmedName = name.trim();
    if (!trimmedName) return;

    currentLoadedProfile = '';
    document.getElementById('profileName').value = trimmedName;
    document.getElementById('baseUrl').value = '';
    document.getElementById('apiKey').value = '';
    document.getElementById('profileJson').value = getDefaultProfileTemplate();

    saveCurrent();
    rebuildProfileList(trimmedName);
    loadSelectedProfile();
  });
}

// ── Notification System ──
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '❌';
  if (type === 'warning') icon = '⚠️';

  toast.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;">
      <span>${icon}</span>
      <span>${message}</span>
    </div>
  `;

  container.appendChild(toast);

  // Auto remove
  setTimeout(() => {
    toast.classList.add('hide');
    setTimeout(() => container.removeChild(toast), 300);
  }, 3000);
}

// Override original showAlert with Toast for lightweight notifications
function showAlert(message) {
  // If message looks like a success message, use success type
  const isSuccess = message.includes('保存') || message.includes('启用') || message.includes('成功');
  const isError = message.includes('失败') || message.includes('无效') || message.includes('连接失败');
  
  showToast(message, isSuccess ? 'success' : (isError ? 'error' : 'info'));
}

function showInputDialog(message, defaultValue, callback) {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);backdrop-filter:blur(2px);z-index:10000;display:flex;align-items:center;justify-content:center;animation:fadeIn 0.2s ease-out;';

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:white;padding:24px;border-radius:12px;box-shadow:var(--shadow-window);min-width:320px;animation:slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);';

  const label = document.createElement('div');
  label.textContent = message;
  label.style.cssText = 'margin-bottom:16px;font-size:14px;font-weight:600;color:var(--text-main);';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = defaultValue || '';
  input.className = 'info-input';
  input.style.cssText = 'width:100%;margin-bottom:20px;';

  const btnContainer = document.createElement('div');
  btnContainer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';

  const btnCancel = document.createElement('button');
  btnCancel.textContent = '取消';
  btnCancel.className = 'btn btn-new';

  const btnOk = document.createElement('button');
  btnOk.textContent = '确定';
  btnOk.className = 'btn btn-save';

  btnContainer.appendChild(btnCancel);
  btnContainer.appendChild(btnOk);

  dialog.appendChild(label);
  dialog.appendChild(input);
  dialog.appendChild(btnContainer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  input.focus();
  input.select();

  const close = (value) => {
    overlay.style.animation = 'fadeOut 0.2s ease-in';
    dialog.style.animation = 'slideDown 0.2s ease-in';
    setTimeout(() => {
      document.body.removeChild(overlay);
      callback(value);
    }, 180);
  };

  btnOk.onclick = () => close(input.value);
  btnCancel.onclick = () => close(null);
  input.onkeydown = (e) => {
    if (e.key === 'Enter') close(input.value);
    if (e.key === 'Escape') close(null);
  };
}

function showConfirm(message, callback) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);backdrop-filter:blur(2px);z-index:10000;display:flex;align-items:center;justify-content:center;animation:fadeIn 0.2s ease-out;';

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:white;padding:24px;border-radius:12px;box-shadow:var(--shadow-window);min-width:320px;max-width:400px;animation:slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);';

  const message_div = document.createElement('div');
  message_div.textContent = message;
  message_div.style.cssText = 'margin-bottom:24px;font-size:14px;color:var(--text-main);line-height:1.6;font-weight:500;';

  const btnContainer = document.createElement('div');
  btnContainer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';

  const btnCancel = document.createElement('button');
  btnCancel.textContent = '取消';
  btnCancel.className = 'btn btn-new';

  const btnOk = document.createElement('button');
  btnOk.textContent = '确定';
  btnOk.className = 'btn btn-delete';
  btnOk.style.background = 'var(--error)';
  btnOk.style.color = 'white';
  btnOk.style.borderColor = 'var(--error)';

  btnContainer.appendChild(btnCancel);
  btnContainer.appendChild(btnOk);

  dialog.appendChild(message_div);
  dialog.appendChild(btnContainer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  btnOk.focus();

  const close = (result) => {
    overlay.style.animation = 'fadeOut 0.2s ease-in';
    dialog.style.animation = 'slideDown 0.2s ease-in';
    setTimeout(() => {
      document.body.removeChild(overlay);
      callback(result);
    }, 180);
  };

  btnOk.onclick = () => close(true);
  btnCancel.onclick = () => close(false);
  overlay.onclick = (e) => { if (e.target === overlay) close(false); };
}

function deleteCurrent() {
  const selected = ensureSelection();
  if (!selected) return;

  if (selected === getActiveProfile()) {
    showAlert('当前激活配置不能删除，请先切换到其他配置。');
    return;
  }

  showConfirm(`确定删除配置 '${selected}' 吗？`, (confirmed) => {
    if (!confirmed) return;

    if (fileExists(profilePath(selected))) {
      fs.unlinkSync(profilePath(selected));
    }

    selectedProfile = '';
    rebuildProfileList('');

    const profiles = scanProfiles();
    if (profiles.length > 0) {
      selectedProfile = profiles[0];
      selectProfileItem(selectedProfile);
      loadSelectedProfile();
    } else {
      document.getElementById('profileName').value = '';
      document.getElementById('baseUrl').value = '';
      document.getElementById('apiKey').value = '';
      document.getElementById('profileJson').value = '';
      syncStatus();
    }
  });
}

function activateCurrent() {
  const selected = ensureSelection();
  if (!selected) return;

  try {
    syncJsonFromFields();
    const jsonText = document.getElementById('profileJson').value;
    const profileData = parseJson(jsonText);

    if (!profileData) {
      showAlert('JSON 格式无效，请先修正。');
      return;
    }

    // 验证必需字段
    if (!profileData.env || !profileData.env.ANTHROPIC_BASE_URL || !profileData.env.ANTHROPIC_AUTH_TOKEN) {
      showAlert('配置缺少必需字段：ANTHROPIC_BASE_URL 和 ANTHROPIC_AUTH_TOKEN');
      return;
    }

    // 检查测试状态
    if (!profileData.apiFormat || !profileData.apiFormat.testResult || !profileData.apiFormat.testResult.success) {
      showConfirm(
        '此配置未通过测试或测试失败。\n\n强制激活可能导致运行时错误。\n\n是否仍要激活？',
        (confirmed) => {
          if (confirmed) {
            performActivation(selected, jsonText, profileData);
          }
        }
      );
      return;
    }

    // 测试通过，直接激活
    performActivation(selected, jsonText, profileData);

  } catch (err) {
    console.error('activateCurrent failed:', err);
    const msg = err && err.message ? err.message : String(err);
    showAlert(`激活失败：${msg}`);
  }
}

function performActivation(selected, jsonText, profileData) {
  // 保存 profile 文件
  writeText(profilePath(selected), jsonText);

  // 合并到 settings.json
  const existingSettings = parseJson(readText(activeSettingsPath)) || {};

  const mergeKeys = ['env', 'model', 'effortLevel', 'includeCoAuthoredBy',
                     'skipDangerousModePermissionPrompt', 'permissions',
                     'enabledPlugins', 'extraKnownMarketplaces', 'apiFormat'];

  mergeKeys.forEach(key => {
    if (profileData[key] !== undefined) {
      existingSettings[key] = profileData[key];
    }
  });

  const mergedJson = JSON.stringify(existingSettings, null, 2);
  writeText(activeSettingsPath, mergedJson);
  writeText(activeProfilePath, selected);

  rebuildProfileList(selected);
  syncStatus();
  showAlert(`已启用 ${selected}`);
}

function refreshAll() {
  const active = getActiveProfile();
  selectedProfile = active || '';
  rebuildProfileList(selectedProfile);

  if (selectedProfile) {
    loadSelectedProfile();
  }

  syncStatus();
}

function openFolder() {
  shell.openPath(claudeRoot);
}

// 测试配置连通性
let testTimer = null;

function showTestProgress(timeout) {
  const overlay = document.createElement('div');
  overlay.id = 'test-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:white;padding:24px 32px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.3);min-width:300px;text-align:center;';

  const title = document.createElement('div');
  title.textContent = '正在测试连接...';
  title.style.cssText = 'font-size:15px;font-weight:600;color:#333;margin-bottom:16px;';

  const barBg = document.createElement('div');
  barBg.style.cssText = 'width:100%;height:6px;background:#eee;border-radius:3px;overflow:hidden;margin-bottom:12px;';

  const barFill = document.createElement('div');
  barFill.id = 'test-bar';
  barFill.style.cssText = 'width:0%;height:100%;background:#d4916e;border-radius:3px;transition:width 0.3s;';

  barBg.appendChild(barFill);

  const timer = document.createElement('div');
  timer.id = 'test-timer';
  timer.style.cssText = 'font-size:12px;color:#999;font-family:"IBM Plex Mono",Consolas,monospace;';
  timer.textContent = `0.0s / ${timeout}s`;

  dialog.appendChild(title);
  dialog.appendChild(barBg);
  dialog.appendChild(timer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const start = Date.now();
  const timeoutMs = timeout * 1000;
  testTimer = setInterval(() => {
    const elapsed = Date.now() - start;
    const pct = Math.min((elapsed / timeoutMs) * 100, 100);
    const secs = (elapsed / 1000).toFixed(1);
    const bar = document.getElementById('test-bar');
    const timerEl = document.getElementById('test-timer');
    if (bar) bar.style.width = pct + '%';
    if (timerEl) timerEl.textContent = `${secs}s / ${timeout}s`;
  }, 100);
}

function hideTestProgress() {
  if (testTimer) { clearInterval(testTimer); testTimer = null; }
  const overlay = document.getElementById('test-overlay');
  if (overlay) document.body.removeChild(overlay);
}

// 新增：API 格式测试相关函数

function sortFormatsByUrl(formats, url) {
  const urlLower = url.toLowerCase();
  const matched = [];
  const unmatched = [];

  formats.forEach(format => {
    const hasMatch = format.urlPatterns.some(pattern => urlLower.includes(pattern.toLowerCase()));
    if (hasMatch) {
      matched.push(format);
    } else {
      unmatched.push(format);
    }
  });

  return [...matched, ...unmatched];
}

function getModelFromConfig() {
  const parsed = parseJson(document.getElementById('profileJson').value);
  let model = 'claude-sonnet-4-6';
  if (parsed) {
    if (parsed.env && parsed.env.ANTHROPIC_MODEL) {
      model = parsed.env.ANTHROPIC_MODEL;
    } else if (parsed.model) {
      const alias = parsed.model.replace(/\[.*\]/, '');
      const aliasMap = { opus: 'claude-opus-4-6', sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5-20251001' };
      if (aliasMap[alias]) model = aliasMap[alias];
    }
  }
  return model;
}

function testApiFormat(baseUrl, apiKey, model, format) {
  return new Promise((resolve) => {
    const https = require('https');
    const http = require('http');
    const { URL } = require('url');

    // 处理已经包含端点的 Base URL
    let finalUrl = baseUrl.replace(/\/$/, '');

    // 检查 Base URL 是否已经包含了 /v1/chat/completions 或 /v1/messages 等端点
    const commonEndpoints = ['/v1/chat/completions', '/v1/messages', '/chat/completions', '/messages'];
    const hasEndpoint = commonEndpoints.some(ep => finalUrl.endsWith(ep));

    if (!hasEndpoint) {
      // 如果没有端点，则追加
      finalUrl = finalUrl + format.endpoint;
    }

    const url = finalUrl;

    try {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      const postData = JSON.stringify(format.requestBody(model));

      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      };

      // 设置认证头
      if (format.authPrefix) {
        headers[format.authHeader] = format.authPrefix + apiKey;
      } else {
        headers[format.authHeader] = apiKey;
      }

      // 添加额外的请求头
      Object.assign(headers, format.additionalHeaders);

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname,
        method: 'POST',
        timeout: 30000,
        headers: headers
      };

      const startTime = Date.now();

      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          const elapsed = Date.now() - startTime;
          const success = res.statusCode === 200;
          resolve({
            success: success,
            statusCode: res.statusCode,
            elapsed: elapsed,
            error: success ? null : data
          });
        });
      });

      req.on('error', (err) => {
        const elapsed = Date.now() - startTime;
        resolve({
          success: false,
          statusCode: 0,
          elapsed: elapsed,
          error: err.message
        });
      });

      req.on('timeout', () => {
        req.destroy();
        const elapsed = Date.now() - startTime;
        resolve({
          success: false,
          statusCode: 0,
          elapsed: elapsed,
          error: '连接超时'
        });
      });

      req.write(postData);
      req.end();
    } catch (err) {
      resolve({
        success: false,
        statusCode: 0,
        elapsed: 0,
        error: err.message
      });
    }
  });
}

function showEnhancedTestProgress(formats) {
  const overlay = document.createElement('div');
  overlay.id = 'test-overlay';
  overlay.className = 'test-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'test-dialog';

  const title = document.createElement('div');
  title.className = 'test-title';
  title.textContent = '正在测试 API 兼容性...';

  const formatList = document.createElement('div');
  formatList.className = 'test-format-list';
  formatList.id = 'test-format-list';

  formats.forEach(format => {
    const item = document.createElement('div');
    item.className = 'test-format-item';
    item.dataset.formatId = format.id;

    item.innerHTML = `
      <span class="format-icon">⏳</span>
      <span class="format-name">${format.name}</span>
      <span class="format-status">等待中</span>
    `;

    formatList.appendChild(item);
  });

  dialog.appendChild(title);
  dialog.appendChild(formatList);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
}

function updateTestProgress(formatId, status, result = null) {
  const item = document.querySelector(`[data-format-id="${formatId}"]`);
  if (!item) return;

  const icon = item.querySelector('.format-icon');
  const statusEl = item.querySelector('.format-status');

  item.classList.remove('testing', 'success', 'failed');

  if (status === 'testing') {
    item.classList.add('testing');
    icon.textContent = '🔄';
    icon.classList.add('spin');
    statusEl.textContent = '测试中...';
  } else if (status === 'success') {
    item.classList.add('success');
    icon.textContent = '✅';
    icon.classList.remove('spin');
    statusEl.textContent = `成功 (${result.elapsed}ms)`;
  } else if (status === 'failed') {
    item.classList.add('failed');
    icon.textContent = '❌';
    icon.classList.remove('spin');
    statusEl.textContent = `失败 (${result.statusCode || '错误'})`;
  }
}

function hideEnhancedTestProgress() {
  const overlay = document.getElementById('test-overlay');
  if (overlay) {
    overlay.style.animation = 'fadeOut 0.2s ease-in';
    setTimeout(() => {
      if (document.body.contains(overlay)) {
        document.body.removeChild(overlay);
      }
    }, 200);
  }
}

function saveApiFormatToConfig(format, result) {
  const jsonText = document.getElementById('profileJson').value;
  const config = parseJson(jsonText) || {};

  config.apiFormat = {
    id: format.id,
    name: format.name,
    endpoint: format.endpoint,
    authHeader: format.authHeader,
    authPrefix: format.authPrefix,
    testedAt: new Date().toISOString(),
    testResult: {
      success: result.success,
      statusCode: result.statusCode,
      elapsed: result.elapsed
    }
  };

  const updatedJson = JSON.stringify(config, null, 2);
  document.getElementById('profileJson').value = updatedJson;
  syncFieldsFromJson();

  // 保存到文件并刷新侧边栏
  const selected = selectedProfile;
  if (selected) {
    saveProfileFile(selected, updatedJson);
    rebuildProfileList(getActiveProfile());
  }
}

function showTestFailureDialog(testResults) {
  const failedCount = testResults.filter(r => !r.result.success).length;
  const totalCount = testResults.length;

  let message = `所有 ${totalCount} 种 API 格式测试均失败。\n\n`;
  message += '测试结果：\n';

  testResults.forEach(({ format, result }) => {
    const status = result.success ? '✅' : '❌';
    const detail = result.success ? `${result.elapsed}ms` : (result.error || `状态码 ${result.statusCode}`);
    message += `${status} ${format.name}: ${detail}\n`;
  });

  message += '\n请检查：\n';
  message += '• Base URL 是否正确\n';
  message += '• API Key 是否有效\n';
  message += '• 网络连接是否正常';

  showAlert(message);
}

function testCurrent() {
  const baseUrl = document.getElementById('baseUrl').value.trim();
  const apiKey = document.getElementById('apiKey').value.trim();

  if (!baseUrl || !apiKey) {
    showAlert('请先填写基础地址和 API 密钥。');
    return;
  }

  const model = getModelFromConfig();
  const sortedFormats = sortFormatsByUrl(API_FORMATS, baseUrl);

  showEnhancedTestProgress(sortedFormats);
  document.getElementById('footerHint').innerText = '状态：正在测试连接...';

  // 异步顺序测试
  (async () => {
    let successFormat = null;
    const testResults = [];

    for (const format of sortedFormats) {
      updateTestProgress(format.id, 'testing');
      const result = await testApiFormat(baseUrl, apiKey, model, format);
      testResults.push({ format, result });

      if (result.success) {
        successFormat = format;
        updateTestProgress(format.id, 'success', result);
        break;
      } else {
        updateTestProgress(format.id, 'failed', result);
      }
    }

    // 延迟 1 秒后关闭对话框，让用户看到最终结果
    setTimeout(() => {
      hideEnhancedTestProgress();

      if (successFormat) {
        const successResult = testResults.find(r => r.format === successFormat).result;
        saveApiFormatToConfig(successFormat, successResult);
        showAlert(`连接成功！\n\n格式: ${successFormat.name}\n响应时间: ${successResult.elapsed}ms`);
      } else {
        showTestFailureDialog(testResults);
      }

      document.getElementById('footerHint').innerText = `状态：已激活 ${getActiveProfile() || 'unknown'}`;
    }, 1000);
  })();
}

// 窗口控制函数
function minimizeWindow() {
  ipcRenderer.send('window-minimize');
}

function maximizeWindow() {
  ipcRenderer.send('window-maximize');
}

function closeWindow() {
  ipcRenderer.send('window-close');
}

// 初始化
window.addEventListener('DOMContentLoaded', () => {
  const active = getActiveProfile();
  selectedProfile = active || '';
  rebuildProfileList(selectedProfile);

  if (selectedProfile) {
    loadSelectedProfile();
  } else {
    const profiles = scanProfiles();
    if (profiles.length > 0) {
      selectedProfile = profiles[0];
      selectProfileItem(selectedProfile);
      loadSelectedProfile();
    }
  }

  syncStatus();

  document.getElementById('baseUrl').addEventListener('keyup', syncJsonFromFields);
  document.getElementById('apiKey').addEventListener('keyup', syncJsonFromFields);
  document.getElementById('profileJson').addEventListener('keyup', syncFieldsFromJson);
});
