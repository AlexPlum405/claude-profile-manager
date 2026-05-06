const fs = require('fs');
const path = require('path');
const os = require('os');
const { shell, ipcRenderer } = require('electron');
const JSZip = require('jszip');
const appPackage = require('../package.json');

// 路径配置
const homeDir = os.homedir();
const claudeRoot = path.join(homeDir, '.claude');
const activeSettingsPath = path.join(claudeRoot, 'settings.json');
const activeProfilePath = path.join(claudeRoot, '.active-profile');
const EXPORT_MANIFEST_FILE = 'clave-profiles-manifest.json';

let currentLoadedProfile = '';
let selectedProfile = '';
let cachedProfiles = null;
let cachedActiveProfile = null;
let pendingProfileLoadToken = 0;
let pendingThemeFrame = null;
let pendingApiTestToken = 0;
let currentTheme = '';
let activeJsonBracketMatch = null;

const profileTextCache = new Map();
const profileMetaCache = new Map();
const CLAUDE_CODE_FALLBACK_MODEL = 'opus[1m]';
const CLAUDE_CODE_MODEL_ALIASES = new Set([
  'default',
  'sonnet',
  'opus',
  'haiku',
  'sonnet[1m]',
  'opus[1m]',
  'opusplan'
]);
const INVALID_PROFILE_NAME_CHARS = /[/:*?"<>|\\]/;
const RESERVED_PROFILE_NAMES = new Set(['json', '.', '..']);

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

function invalidateProfileCache(profileName) {
  if (profileName) {
    profileTextCache.delete(profileName);
    profileMetaCache.delete(profileName);
  } else {
    profileTextCache.clear();
    profileMetaCache.clear();
  }
  cachedProfiles = null;
  cachedActiveProfile = null;
}

function readProfileText(profileName) {
  if (profileTextCache.has(profileName)) {
    return profileTextCache.get(profileName);
  }

  const text = readText(profilePath(profileName));
  profileTextCache.set(profileName, text);
  return text;
}

function scanProfiles(options = {}) {
  if (!options.force && cachedProfiles) {
    return cachedProfiles.slice();
  }

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
  cachedProfiles = results;
  return results.slice();
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function parseJsonWithError(text) {
  try {
    return { value: JSON.parse(text), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

function redactSecret(value) {
  if (!value || typeof value !== 'string') return value || '';
  if (value.length <= 10) return '***';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function sanitizeDiagnosticText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1...redacted');
}

function validateProfileName(name, { currentName = '' } = {}) {
  const trimmed = (name || '').trim();
  if (!trimmed) return { valid: false, message: '配置名称不能为空。' };
  if (RESERVED_PROFILE_NAMES.has(trimmed.toLowerCase())) {
    return { valid: false, message: '这个名称是保留名称，请换一个。' };
  }
  if (INVALID_PROFILE_NAME_CHARS.test(trimmed)) {
    return { valid: false, message: '名称不能包含 / : * ? " < > | 或反斜杠。' };
  }
  if (/^\s|\s$/.test(name)) {
    return { valid: false, message: '名称首尾不能有空格。' };
  }
  if (trimmed.length > 80) {
    return { valid: false, message: '名称过长，请控制在 80 个字符以内。' };
  }
  if (currentName && currentName !== trimmed && fileExists(profilePath(trimmed))) {
    return { valid: false, message: `配置 ${trimmed} 已存在，请换一个名称。` };
  }
  return { valid: true, message: '名称可用。' };
}

function jsonPrettyOrRaw(text) {
  const parsed = parseJson(text);
  if (!parsed) return text;
  return JSON.stringify(parsed, null, 2);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function isClaudeCodeModel(model) {
  if (!model || typeof model !== 'string') return false;
  const normalized = model.trim();
  if (CLAUDE_CODE_MODEL_ALIASES.has(normalized)) return true;
  if (/^claude-[a-z0-9.-]+(?:-\d{8})?(?:\[1m\])?$/i.test(normalized)) return true;
  if (/^anthropic\.claude-[a-z0-9.-]+/i.test(normalized)) return true;
  if (/^arn:aws:bedrock:/i.test(normalized)) return true;
  return false;
}

function getProviderModelFromConfig(config) {
  if (!config || typeof config !== 'object') return '';
  if (config.apiFormat && config.apiFormat.providerModel) {
    return String(config.apiFormat.providerModel).trim();
  }
  if (config.env && config.env.ANTHROPIC_MODEL && !isClaudeCodeModel(config.env.ANTHROPIC_MODEL)) {
    return String(config.env.ANTHROPIC_MODEL).trim();
  }
  if (config.model && !isClaudeCodeModel(config.model)) {
    return String(config.model).trim();
  }
  return '';
}

function normalizeClaudeCodeBaseUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return baseUrl;
  // Claude Code appends /v1/messages at runtime; chat-completions endpoints are only for connection tests.
  return baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(?:v1\/)?(?:chat\/completions|messages)$/i, '');
}

function normalizeForClaudeCodeActivation(profileData) {
  const normalized = cloneJson(profileData);
  const providerModel = getProviderModelFromConfig(normalized);

  if (providerModel) {
    if (!normalized.apiFormat) normalized.apiFormat = {};
    normalized.apiFormat.providerModel = providerModel;
  }

  if (normalized.env && normalized.env.ANTHROPIC_BASE_URL) {
    normalized.env.ANTHROPIC_BASE_URL = normalizeClaudeCodeBaseUrl(normalized.env.ANTHROPIC_BASE_URL);
  }

  return normalized;
}

function setBaseUrlHint(message = '', isWarning = false) {
  const hint = document.getElementById('baseUrlHint');
  if (!hint) return;
  hint.textContent = message || '填写 /v1/messages 前面的地址，Clave 会自动移除完整端点。';
  hint.classList.toggle('warning', isWarning);
}

function normalizeBaseUrlField({ notify = false } = {}) {
  const input = document.getElementById('baseUrl');
  if (!input) return '';

  const raw = input.value.trim();
  const normalized = normalizeClaudeCodeBaseUrl(raw);
  if (raw && normalized !== raw) {
    input.value = normalized;
    setBaseUrlHint(`已自动改为 Claude Code Base URL：${normalized}`, true);
    if (notify) showAlert('已自动移除完整端点，Claude Code 会自行追加 /v1/messages。');
  } else {
    setBaseUrlHint();
  }

  return normalized;
}

function updateProfileNameHint() {
  const input = document.getElementById('profileName');
  const hint = document.getElementById('profileNameHint');
  if (!input || !hint) return true;

  const result = validateProfileName(input.value, { currentName: currentLoadedProfile || selectedProfile });
  input.classList.toggle('invalid', !result.valid);
  hint.textContent = result.message || '名称会用于 settings.<name>.json 文件名。';
  hint.classList.toggle('error', !result.valid);
  hint.classList.toggle('warning', result.valid && input.value.trim() !== (currentLoadedProfile || selectedProfile || ''));
  return result.valid;
}

function setJsonStatus(message, type = '') {
  const status = document.getElementById('jsonStatus');
  const editor = document.getElementById('profileJson');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error', type === 'error');
  status.classList.toggle('success', type === 'success');
  if (editor) editor.classList.toggle('invalid', type === 'error');
}

function setJsonStatusNote(message, type = '') {
  const status = document.getElementById('jsonStatus');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error', type === 'error');
  status.classList.toggle('success', type === 'success');
}

function validateJsonEditor() {
  const editor = document.getElementById('profileJson');
  if (!editor) return null;
  const { value, error } = parseJsonWithError(editor.value);
  if (error) {
    setJsonStatus(`JSON 无效：${error.message}`, 'error');
    return null;
  }
  setJsonStatus('JSON 有效', 'success');
  return value;
}

function formatJsonEditor() {
  const editor = document.getElementById('profileJson');
  if (!editor) return;
  const parsed = validateJsonEditor();
  if (!parsed) return;
  editor.value = JSON.stringify(parsed, null, 2);
  syncFieldsFromJson();
  setJsonStatus('JSON 已格式化', 'success');
}

function getJsonBracketTokens(text) {
  const tokens = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString && '{}[]'.includes(char)) {
      tokens.push({ index: i, char });
    }
  }

  return tokens;
}

function findMatchingJsonBracket(text, bracketIndex) {
  const pairs = {
    '{': '}',
    '[': ']',
    '}': '{',
    ']': '['
  };
  const openers = new Set(['{', '[']);
  const tokens = getJsonBracketTokens(text);
  const tokenPosition = tokens.findIndex(token => token.index === bracketIndex);
  if (tokenPosition === -1) return -1;

  const start = tokens[tokenPosition];
  const matchChar = pairs[start.char];
  if (!matchChar) return -1;

  const direction = openers.has(start.char) ? 1 : -1;
  let depth = 0;

  for (let i = tokenPosition; i >= 0 && i < tokens.length; i += direction) {
    const token = tokens[i];
    if (token.char === start.char) depth += 1;
    if (token.char === matchChar) depth -= 1;
    if (depth === 0) return token.index;
  }

  return -1;
}

function getBracketIndexNearCaret(text, caret) {
  const candidates = [caret, caret - 1];
  return candidates.find(index => index >= 0 && index < text.length && '{}[]'.includes(text[index])) ?? -1;
}

function clearJsonBracketMarkers() {
  const layer = document.getElementById('jsonBracketMarkers');
  if (layer) layer.replaceChildren();
  activeJsonBracketMatch = null;
}

function clearJsonBracketMarkerElements() {
  const layer = document.getElementById('jsonBracketMarkers');
  if (layer) layer.replaceChildren();
}

function getTextareaIndexRect(textarea, index) {
  const computed = window.getComputedStyle(textarea);
  const mirror = document.createElement('div');
  const marker = document.createElement('span');
  const properties = [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'letterSpacing',
    'lineHeight',
    'textTransform',
    'textAlign',
    'textIndent',
    'tabSize',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'boxSizing'
  ];

  properties.forEach(property => {
    mirror.style[property] = computed[property];
  });

  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.left = '-99999px';
  mirror.style.top = '0';
  mirror.style.width = `${textarea.offsetWidth}px`;
  mirror.style.minHeight = '0';
  mirror.style.height = 'auto';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordBreak = 'break-word';
  mirror.style.overflowWrap = 'break-word';

  mirror.textContent = textarea.value.slice(0, index);
  marker.textContent = textarea.value[index] || '\u200b';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const mirrorRect = mirror.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  const result = {
    left: markerRect.left - mirrorRect.left - textarea.scrollLeft,
    top: markerRect.top - mirrorRect.top - textarea.scrollTop,
    width: Math.max(markerRect.width, Number.parseFloat(computed.fontSize) * 0.65),
    height: markerRect.height || Number.parseFloat(computed.lineHeight) || 18
  };

  mirror.remove();
  return result;
}

function renderJsonBracketMarker(textarea, index, isAnchor = false) {
  const layer = document.getElementById('jsonBracketMarkers');
  if (!layer) return;

  const rect = getTextareaIndexRect(textarea, index);
  const marker = document.createElement('span');
  marker.className = `bracket-marker${isAnchor ? ' anchor' : ''}`;
  marker.textContent = textarea.value[index];
  marker.style.left = `${rect.left}px`;
  marker.style.top = `${rect.top}px`;
  marker.style.width = `${rect.width}px`;
  marker.style.height = `${rect.height}px`;
  layer.appendChild(marker);
}

function renderActiveJsonBracketMarkers() {
  const editor = document.getElementById('profileJson');
  if (!editor || !activeJsonBracketMatch) return;
  const { bracketIndex, matchIndex } = activeJsonBracketMatch;
  if (editor.value[bracketIndex] === undefined || editor.value[matchIndex] === undefined) {
    clearJsonBracketMarkers();
    return;
  }

  clearJsonBracketMarkerElements();
  renderJsonBracketMarker(editor, bracketIndex, true);
  renderJsonBracketMarker(editor, matchIndex);
}

function markMatchingJsonBracket() {
  const editor = document.getElementById('profileJson');
  if (!editor) return;
  clearJsonBracketMarkers();

  if (editor.selectionStart !== editor.selectionEnd) {
    validateJsonEditor();
    return;
  }

  const bracketIndex = getBracketIndexNearCaret(editor.value, editor.selectionStart);
  if (bracketIndex === -1) {
    validateJsonEditor();
    return;
  }

  const matchIndex = findMatchingJsonBracket(editor.value, bracketIndex);
  if (matchIndex === -1) {
    setJsonStatusNote(`未找到匹配的 ${editor.value[bracketIndex]}`, 'error');
    return;
  }

  requestAnimationFrame(() => {
    activeJsonBracketMatch = { bracketIndex, matchIndex };
    renderActiveJsonBracketMarkers();
    setJsonStatusNote(`已标识匹配的 ${editor.value[bracketIndex]} ${editor.value[matchIndex]}`, 'success');
  });
}

function getActiveProfile(force = false) {
  if (!force && cachedActiveProfile !== null) {
    return cachedActiveProfile;
  }

  const marker = readText(activeProfilePath).trim();
  if (marker && fileExists(profilePath(marker))) {
    cachedActiveProfile = marker;
    return marker;
  }

  if (fileExists(activeSettingsPath)) {
    const activeText = readText(activeSettingsPath);
    const profiles = scanProfiles({ force });
    for (const profile of profiles) {
      if (readProfileText(profile) === activeText) {
        cachedActiveProfile = profile;
        return profile;
      }
    }
  }

  cachedActiveProfile = '';
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
  if (profileMetaCache.has(profileName)) {
    return profileMetaCache.get(profileName);
  }

  const text = readProfileText(profileName);
  const parsed = parseJson(text);
  if (!parsed || !parsed.env) {
    profileMetaCache.set(profileName, '');
    return '';
  }

  const url = parsed.env.ANTHROPIC_BASE_URL || '';
  if (url) {
    try {
      const match = url.match(/\/\/([^\/]+)/);
      if (match) {
        const meta = match[1].replace(/\/$/, '');
        profileMetaCache.set(profileName, meta);
        return meta;
      }
    } catch (e) {}
    profileMetaCache.set(profileName, url);
    return url;
  }
  profileMetaCache.set(profileName, '');
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

function buildJsonFromFields({ normalizeBaseUrl = false } = {}) {
  const jsonNode = document.getElementById('profileJson');
  const current = parseJson(jsonNode.value) || {};
  if (!current.env) current.env = {};

  current.env.ANTHROPIC_BASE_URL = normalizeBaseUrl
    ? normalizeBaseUrlField()
    : document.getElementById('baseUrl').value.trim();
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
  normalizeBaseUrlField();
  document.getElementById('apiKey').value = parsed.env.ANTHROPIC_AUTH_TOKEN || '';
}

function syncJsonFromFields(options = {}) {
  document.getElementById('profileJson').value = buildJsonFromFields(options);
}

function syncStatus() {
  const active = getActiveProfile() || 'unknown';
  const hintEl = document.getElementById('footerHint');
  if (hintEl) {
    hintEl.innerText = active === 'unknown'
      ? '状态：未检测到激活配置'
      : `状态：已激活 ${active}`;
  }
}

function saveProfileFile(name, jsonText) {
  ensureFolder(claudeRoot);
  writeText(profilePath(name), jsonText);
  profileTextCache.set(name, jsonText);
  profileMetaCache.delete(name);
  cachedProfiles = null;
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

function getProfileHealth(profileName, activeProfile) {
  const parsed = parseJson(readProfileText(profileName));
  if (!parsed) return { label: 'JSON 错误', className: 'health-bad', title: '配置 JSON 无效' };
  if (!parsed.env || !parsed.env.ANTHROPIC_BASE_URL || !parsed.env.ANTHROPIC_AUTH_TOKEN) {
    return { label: '缺字段', className: 'health-bad', title: '缺少 Base URL 或 Auth Token' };
  }
  if (parsed.apiFormat && parsed.apiFormat.modelCompatibility && parsed.apiFormat.modelCompatibility.compatible === false) {
    return { label: '不兼容', className: 'health-bad', title: parsed.apiFormat.modelCompatibility.reason || '模型不兼容 Claude Code' };
  }
  if (parsed.apiFormat && parsed.apiFormat.testResult) {
    if (parsed.apiFormat.testResult.success) {
      return {
        label: profileName === activeProfile ? '已激活' : '可用',
        className: profileName === activeProfile ? 'health-ok health-active' : 'health-ok',
        title: `最近测试通过：${parsed.apiFormat.name || parsed.apiFormat.id || 'unknown'}`
      };
    }
    return { label: '失败', className: 'health-bad', title: '最近测试失败' };
  }
  return { label: '未测试', className: 'health-warn', title: '尚未测试连接' };
}

function rebuildProfileList(activeProfile) {
  const profiles = scanProfiles();
  const listEl = document.getElementById('profileList');
  if (!listEl) return;
  listEl.innerHTML = '';

  profiles.forEach(profile => {
    const div = document.createElement('div');
    div.className = 'sidebar-item';
    div.dataset.profile = profile;

    if (profile === selectedProfile) {
      div.classList.add('selected');
    }

    const infoDiv = document.createElement('div');
    infoDiv.className = 'profile-info';
    infoDiv.style.display = 'flex';
    infoDiv.style.flexDirection = 'column';
    infoDiv.style.gap = '2px';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'profile-name';
    nameSpan.style.fontSize = '13px';
    nameSpan.style.fontWeight = '600';
    nameSpan.textContent = profile;

    const metaSpan = document.createElement('span');
    metaSpan.className = 'profile-url';
    metaSpan.style.fontFamily = "'Geist Mono', monospace";
    metaSpan.style.fontSize = '9px';
    metaSpan.style.color = 'var(--text-muted)';
    metaSpan.textContent = getProfileMeta(profile) || 'Standard';

    const health = getProfileHealth(profile, activeProfile);
    const statusSpan = document.createElement('span');
    statusSpan.className = 'profile-status';
    statusSpan.title = health.title;
    const dot = document.createElement('span');
    dot.className = `health-dot ${health.className}`;
    const label = document.createElement('span');
    label.textContent = health.label;
    statusSpan.appendChild(dot);
    statusSpan.appendChild(label);

    infoDiv.appendChild(nameSpan);
    infoDiv.appendChild(metaSpan);
    infoDiv.appendChild(statusSpan);
    div.appendChild(infoDiv);

    div.onclick = () => {
      pendingApiTestToken++;
      hideEnhancedTestProgress();
      selectedProfile = profile;
      selectProfileItem(profile);
      const loadToken = ++pendingProfileLoadToken;
      window.requestAnimationFrame(() => {
        if (loadToken === pendingProfileLoadToken) {
          loadSelectedProfile(profile);
        }
      });
    };

    listEl.appendChild(div);
  });
}

function loadSelectedProfile(profileName = selectedProfile) {
  const selected = profileName || ensureSelection();
  if (!selected) return;

  currentLoadedProfile = selected;
  const title = document.getElementById('profileTitle');
  if (title) title.value = selected;
  document.getElementById('profileName').value = selected;
  document.getElementById('profileJson').value = fileExists(profilePath(selected))
    ? jsonPrettyOrRaw(readProfileText(selected))
    : getDefaultProfileTemplate();

  syncFieldsFromJson();
  updateProfileNameHint();
  validateJsonEditor();
  clearDiagnostics();
  syncStatus();
}

function saveCurrent() {
  const name = document.getElementById('profileName').value.trim();
  const previousName = currentLoadedProfile || selectedProfile;
  const nameCheck = validateProfileName(document.getElementById('profileName').value, { currentName: previousName });
  updateProfileNameHint();
  if (!nameCheck.valid) {
    showAlert(nameCheck.message);
    return;
  }

  syncJsonFromFields({ normalizeBaseUrl: true });
  const jsonText = document.getElementById('profileJson').value;
  const parsed = validateJsonEditor();
  if (!parsed) {
    showAlert('JSON 格式无效，请先修正。');
    return;
  }

  ensureFolder(claudeRoot);
  const wasActive = previousName && getActiveProfile(true) === previousName;
  saveProfileFile(name, jsonText);
  if (previousName && previousName !== name && fileExists(profilePath(previousName))) {
    fs.unlinkSync(profilePath(previousName));
    invalidateProfileCache(previousName);
    if (wasActive) {
      writeText(activeProfilePath, name);
      cachedActiveProfile = name;
    }
  }
  selectedProfile = name;
  const title = document.getElementById('profileTitle');
  if (title) title.value = name;
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
    const nameCheck = validateProfileName(name);
    if (!nameCheck.valid) {
      showAlert(nameCheck.message);
      return;
    }

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

// 主题管理
function updateThemePicker(name) {
  const swatches = document.querySelectorAll('.swatch');
  swatches.forEach(s => {
    const themeValue = s.dataset.themeValue;
    const isTarget = themeValue
      ? themeValue === name
      : (name === 'azure' && s.title.includes('蔚蓝')) ||
        (name === 'emerald' && s.title.includes('翡翠')) ||
        (name === 'silver' && s.title.includes('银石墨'));
    s.classList.toggle('active', isTarget);
  });
}

function setTheme(name) {
  if (!name) return;
  currentTheme = name;
  updateThemePicker(name);

  if (pendingThemeFrame) {
    window.cancelAnimationFrame(pendingThemeFrame);
  }

  pendingThemeFrame = window.requestAnimationFrame(() => {
    document.documentElement.setAttribute('data-theme', currentTheme);
    localStorage.setItem('clave-theme', currentTheme);
    pendingThemeFrame = null;
  });
}

// ── Notification System ──
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toastMessage');
  if (!toast || !toastMsg) return;

  toastMsg.innerText = message;
  toast.className = 'visible';
  toast.style.background = type === 'error' ? 'var(--error)' : 'var(--text-main)';
  
  setTimeout(() => {
    toast.className = '';
  }, 3500);
}

function showAlert(message) {
  showToast(
    message,
    message.includes('失败') || message.includes('无效') || message.includes('不支持') || message.includes('不能')
      || message.includes('缺少') || message.includes('不能为空') || message.includes('已存在')
      ? 'error'
      : 'success'
  );
}

function clearDiagnostics() {
  const panel = document.getElementById('diagnosticPanel');
  const summary = document.getElementById('diagnosticSummary');
  const details = document.getElementById('diagnosticDetails');
  if (panel) panel.classList.add('hidden');
  if (summary) summary.textContent = '等待测试结果';
  if (details) details.innerHTML = '';
}

function showDiagnostics({ summary, items = [], type = 'error' }) {
  const panel = document.getElementById('diagnosticPanel');
  const summaryEl = document.getElementById('diagnosticSummary');
  const details = document.getElementById('diagnosticDetails');
  if (!panel || !summaryEl || !details) return;

  panel.classList.remove('hidden');
  summaryEl.textContent = summary;
  summaryEl.classList.toggle('error', type === 'error');
  summaryEl.classList.toggle('success', type === 'success');
  details.innerHTML = '';

  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'diagnostic-item';
    const label = document.createElement('div');
    label.className = 'diagnostic-label';
    label.textContent = item.label;
    const value = document.createElement('div');
    value.className = 'diagnostic-value';
    value.textContent = sanitizeDiagnosticText(item.value);
    div.appendChild(label);
    div.appendChild(value);
    details.appendChild(div);
  });
}

function showInputDialog(message, defaultValue, callback) {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'dialog-card';

  const label = document.createElement('div');
  label.textContent = message;
  label.className = 'dialog-message';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = defaultValue || '';
  input.className = 'input-field';

  const btnContainer = document.createElement('div');
  btnContainer.className = 'dialog-actions';

  const btnCancel = document.createElement('button');
  btnCancel.textContent = '取消';
  btnCancel.className = 'btn-action btn-secondary';

  const btnOk = document.createElement('button');
  btnOk.textContent = '确定';
  btnOk.className = 'btn-action btn-primary';

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
  overlay.className = 'dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'dialog-card';

  const message_div = document.createElement('div');
  message_div.textContent = message;
  message_div.className = 'dialog-message';

  const btnContainer = document.createElement('div');
  btnContainer.className = 'dialog-actions';

  const btnCancel = document.createElement('button');
  btnCancel.textContent = '取消';
  btnCancel.className = 'btn-action btn-secondary';

  const btnOk = document.createElement('button');
  btnOk.textContent = '确定';
  btnOk.className = 'btn-action btn-primary';
  btnOk.style.background = 'var(--error)';
  btnOk.style.color = 'white';

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

function valueForPreview(value, keyPath = '') {
  if (/TOKEN|KEY|SECRET/i.test(keyPath)) return redactSecret(value);
  if (typeof value === 'string') return value;
  if (value === undefined) return '未设置';
  return JSON.stringify(value);
}

function buildActivationPreviewRows(profileData) {
  const activationData = normalizeForClaudeCodeActivation(profileData);
  const existingSettings = parseJson(readText(activeSettingsPath)) || {};
  const rows = [];
  const keys = ['model', 'effortLevel', 'env.ANTHROPIC_BASE_URL', 'env.ANTHROPIC_MODEL', 'env.ANTHROPIC_AUTH_TOKEN', 'apiFormat.id', 'apiFormat.name'];

  keys.forEach(keyPath => {
    const parts = keyPath.split('.');
    const before = parts.reduce((acc, part) => acc && acc[part], existingSettings);
    const after = parts.reduce((acc, part) => acc && acc[part], activationData);
    if (after !== undefined && JSON.stringify(before) !== JSON.stringify(after)) {
      rows.push({
        keyPath,
        before: valueForPreview(before, keyPath),
        after: valueForPreview(after, keyPath)
      });
    }
  });

  if (rows.length === 0) {
    rows.push({ keyPath: 'settings.json', before: '当前配置', after: '无可见差异' });
  }
  return rows;
}

function showActivationPreview(profileName, profileData, callback) {
  const rows = buildActivationPreviewRows(profileData);
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'dialog-card wide';

  const title = document.createElement('div');
  title.className = 'dialog-message';
  title.textContent = `激活预览：${profileName}`;

  const list = document.createElement('div');
  list.className = 'preview-list';

  rows.forEach(row => {
    const item = document.createElement('div');
    item.className = 'preview-row';
    const label = document.createElement('div');
    label.className = 'preview-label';
    label.textContent = row.keyPath;
    const before = document.createElement('div');
    before.className = 'preview-value';
    before.textContent = `当前：${row.before}`;
    const after = document.createElement('div');
    after.className = 'preview-value preview-change';
    after.textContent = `写入：${row.after}`;
    item.appendChild(label);
    item.appendChild(before);
    item.appendChild(after);
    list.appendChild(item);
  });

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  const cancel = document.createElement('button');
  cancel.className = 'btn-action btn-secondary';
  cancel.textContent = '取消';
  const ok = document.createElement('button');
  ok.className = 'btn-action btn-primary';
  ok.textContent = '确认激活';
  actions.appendChild(cancel);
  actions.appendChild(ok);

  dialog.appendChild(title);
  dialog.appendChild(list);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const close = (result) => {
    overlay.style.animation = 'fadeOut 0.2s ease-in';
    dialog.style.animation = 'slideDown 0.2s ease-in';
    setTimeout(() => {
      if (document.body.contains(overlay)) document.body.removeChild(overlay);
      callback(result);
    }, 180);
  };

  ok.onclick = () => close(true);
  cancel.onclick = () => close(false);
  overlay.onclick = (e) => { if (e.target === overlay) close(false); };
  ok.focus();
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
      invalidateProfileCache(selected);
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
      const title = document.getElementById('profileTitle');
      if (title) title.value = '';
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
    syncJsonFromFields({ normalizeBaseUrl: true });
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

    if (profileData.apiFormat && profileData.apiFormat.modelCompatibility && profileData.apiFormat.modelCompatibility.compatible === false) {
      showAlert(`当前模型不能作为 Claude Code 对话模型使用：${profileData.apiFormat.modelCompatibility.reason || '模型不兼容'}`);
      showDiagnostics({
        summary: '激活已阻止：模型不兼容 Claude Code。',
        items: [
          { label: '模型', value: getProviderModelFromConfig(profileData) || profileData.model || '' },
          { label: '原因', value: profileData.apiFormat.modelCompatibility.reason || '模型不兼容' },
          { label: '建议', value: '换成 output_modalities 包含 text 的模型后重新测试。' }
        ],
        type: 'error'
      });
      return;
    }

    // 检查测试状态
    if (!profileData.apiFormat || !profileData.apiFormat.testResult || !profileData.apiFormat.testResult.success) {
      showConfirm(
        '此配置未通过测试或测试失败。\n\n强制激活可能导致运行时错误。\n\n是否仍要激活？',
        (confirmed) => {
          if (confirmed) {
            showActivationPreview(selected, profileData, (accepted) => {
              if (accepted) performActivation(selected, jsonText, profileData);
            });
          }
        }
      );
      return;
    }

    showActivationPreview(selected, profileData, (accepted) => {
      if (accepted) performActivation(selected, jsonText, profileData);
    });

  } catch (err) {
    console.error('activateCurrent failed:', err);
    const msg = err && err.message ? err.message : String(err);
    showAlert(`激活失败：${msg}`);
  }
}

function performActivation(selected, jsonText, profileData) {
  // 保存 profile 文件
  writeText(profilePath(selected), jsonText);
  profileTextCache.set(selected, jsonText);
  profileMetaCache.delete(selected);

  const activationData = normalizeForClaudeCodeActivation(profileData);

  // 合并到 settings.json
  const existingSettings = parseJson(readText(activeSettingsPath)) || {};

  const mergeKeys = ['env', 'model', 'effortLevel', 'includeCoAuthoredBy',
                     'skipDangerousModePermissionPrompt', 'permissions',
                     'enabledPlugins', 'extraKnownMarketplaces', 'apiFormat'];

  mergeKeys.forEach(key => {
    if (activationData[key] !== undefined) {
      existingSettings[key] = activationData[key];
    }
  });

  const mergedJson = JSON.stringify(existingSettings, null, 2);
  writeText(activeSettingsPath, mergedJson);
  writeText(activeProfilePath, selected);
  cachedActiveProfile = selected;

  rebuildProfileList(selected);
  syncStatus();
  showAlert(`已启用 ${selected}`);
}

function refreshAll() {
  invalidateProfileCache();
  const active = getActiveProfile(true);
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

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19);
}

function ensureFileExtension(filePath, extension) {
  if (!filePath) return '';
  const normalizedExtension = extension.startsWith('.') ? extension : `.${extension}`;
  return path.extname(filePath) ? filePath : `${filePath}${normalizedExtension}`;
}

function getProfileFileName(profileName) {
  return `settings.${profileName}.json`;
}

function buildProfileManifest(profiles) {
  return {
    app: 'Clave',
    version: appPackage.version || 'unknown',
    exportedAt: new Date().toISOString(),
    profileCount: profiles.length,
    profiles: profiles.map(profile => ({
      name: profile.name,
      file: `profiles/${getProfileFileName(profile.name)}`
    }))
  };
}

function getProfileRecordForExport(profileName, options = {}) {
  if (!profileName || !fileExists(profilePath(profileName))) {
    throw new Error(`配置 ${profileName || 'unknown'} 不存在。`);
  }

  let jsonText = readProfileText(profileName);
  if (options.preferEditor && profileName === selectedProfile) {
    syncJsonFromFields({ normalizeBaseUrl: true });
    const parsed = validateJsonEditor();
    if (!parsed) {
      throw new Error('当前编辑器 JSON 无效，无法导出。');
    }
    jsonText = JSON.stringify(parsed, null, 2);
  }

  return { name: profileName, jsonText };
}

async function createProfilesZip(profiles) {
  const zip = new JSZip();
  const manifest = buildProfileManifest(profiles);
  zip.file(EXPORT_MANIFEST_FILE, JSON.stringify(manifest, null, 2));

  profiles.forEach(profile => {
    const manifestEntry = manifest.profiles.find(item => item.name === profile.name);
    zip.file(manifestEntry.file, profile.jsonText);
  });

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });
}

async function exportProfilesToPath(profileNames, targetPath, options = {}) {
  const profiles = profileNames.map(name => getProfileRecordForExport(name, options));
  const extension = path.extname(targetPath).toLowerCase();

  if (profiles.length === 1 && extension === '.json') {
    fs.writeFileSync(targetPath, profiles[0].jsonText, 'utf-8');
    return { kind: 'json', count: 1, targetPath };
  }

  const zipPath = ensureFileExtension(targetPath, 'zip');
  const zipBuffer = await createProfilesZip(profiles);
  fs.writeFileSync(zipPath, zipBuffer);
  return { kind: 'zip', count: profiles.length, targetPath: zipPath };
}

async function exportCurrentProfile() {
  const selected = ensureSelection();
  if (!selected) return;

  try {
    const defaultPath = path.join(homeDir, 'Downloads', `${getProfileFileName(selected)}`);
    const chosenPath = await ipcRenderer.invoke('profiles-save-export-dialog', {
      title: `导出配置：${selected}`,
      defaultPath,
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'ZIP', extensions: ['zip'] }
      ]
    });
    if (!chosenPath) return;

    const targetPath = path.extname(chosenPath)
      ? chosenPath
      : ensureFileExtension(chosenPath, 'json');
    const result = await exportProfilesToPath([selected], targetPath, { preferEditor: true });
    showAlert(`已导出 ${result.count} 个配置到 ${path.basename(result.targetPath)}`);
  } catch (err) {
    console.error('exportCurrentProfile failed:', err);
    showAlert(`导出失败：${err.message || String(err)}`);
  }
}

async function exportAllProfiles() {
  const profiles = scanProfiles({ force: true });
  if (profiles.length === 0) {
    showAlert('没有可导出的配置。');
    return;
  }

  try {
    const defaultPath = path.join(homeDir, 'Downloads', `clave-profiles-${timestampForFile()}.zip`);
    const chosenPath = await ipcRenderer.invoke('profiles-save-export-dialog', {
      title: `批量导出 ${profiles.length} 个配置`,
      defaultPath,
      filters: [{ name: 'ZIP', extensions: ['zip'] }]
    });
    if (!chosenPath) return;

    const result = await exportProfilesToPath(profiles, ensureFileExtension(chosenPath, 'zip'));
    showAlert(`已导出 ${result.count} 个配置到 ${path.basename(result.targetPath)}`);
  } catch (err) {
    console.error('exportAllProfiles failed:', err);
    showAlert(`导出失败：${err.message || String(err)}`);
  }
}

function profileNameFromJsonFile(filePath) {
  const baseName = path.basename(filePath, path.extname(filePath));
  const match = baseName.match(/^settings\.(.+)$/i);
  return match ? match[1] : baseName;
}

function profileNameFromZipEntry(entryName) {
  const fileName = entryName.split('/').filter(Boolean).pop() || '';
  const baseName = fileName.replace(/\.json$/i, '');
  const match = baseName.match(/^settings\.(.+)$/i);
  return match ? match[1] : baseName;
}

function normalizeImportedProfileName(name, fallback = 'imported-profile') {
  let normalized = String(name || '').trim();
  normalized = normalized.replace(/\.json$/i, '').replace(/^settings\./i, '');
  normalized = normalized.replace(/[/:*?"<>|\\]/g, '-');
  normalized = normalized.replace(/\s+/g, ' ').trim();
  if (!normalized || RESERVED_PROFILE_NAMES.has(normalized.toLowerCase())) {
    normalized = fallback;
  }
  if (normalized.length > 80) {
    normalized = normalized.slice(0, 80).trim();
  }
  return normalized || fallback;
}

function uniqueImportedProfileName(baseName, usedNames) {
  const base = normalizeImportedProfileName(baseName);
  let candidate = base;
  if (!usedNames.has(candidate) && !fileExists(profilePath(candidate))) {
    usedNames.add(candidate);
    return candidate;
  }

  const suffixBase = base.length > 64 ? base.slice(0, 64).trim() : base;
  candidate = normalizeImportedProfileName(`${suffixBase}-imported`);
  let index = 2;
  while (usedNames.has(candidate) || fileExists(profilePath(candidate))) {
    candidate = normalizeImportedProfileName(`${suffixBase}-imported-${index}`);
    index += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function normalizeImportedProfileRecord(record, usedNames) {
  const parsed = parseJson(record.jsonText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      skipped: true,
      source: record.source,
      reason: 'JSON 无效或不是配置对象'
    };
  }

  const name = uniqueImportedProfileName(record.name, usedNames);
  return {
    name,
    originalName: record.name,
    source: record.source,
    jsonText: JSON.stringify(parsed, null, 2)
  };
}

async function readProfilesFromJsonFile(filePath) {
  if (path.basename(filePath) === EXPORT_MANIFEST_FILE) {
    return [];
  }

  return [{
    name: profileNameFromJsonFile(filePath),
    source: path.basename(filePath),
    jsonText: fs.readFileSync(filePath, 'utf-8')
  }];
}

async function readProfilesFromZipFile(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const records = [];
  const manifestFile = zip.file(EXPORT_MANIFEST_FILE);

  if (manifestFile) {
    const manifest = parseJson(await manifestFile.async('string'));
    if (manifest && Array.isArray(manifest.profiles)) {
      for (const profile of manifest.profiles) {
        if (!profile || !profile.file) continue;
        const entry = zip.file(profile.file);
        if (!entry) continue;
        records.push({
          name: profile.name || profileNameFromZipEntry(profile.file),
          source: `${path.basename(filePath)}:${profile.file}`,
          jsonText: await entry.async('string')
        });
      }
    }
  }

  if (records.length > 0) return records;

  const jsonEntries = Object.values(zip.files)
    .filter(entry => !entry.dir && /\.json$/i.test(entry.name) && entry.name !== EXPORT_MANIFEST_FILE);

  for (const entry of jsonEntries) {
    records.push({
      name: profileNameFromZipEntry(entry.name),
      source: `${path.basename(filePath)}:${entry.name}`,
      jsonText: await entry.async('string')
    });
  }

  return records;
}

async function readImportFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.json') {
    return readProfilesFromJsonFile(filePath);
  }
  if (extension === '.zip') {
    return readProfilesFromZipFile(filePath);
  }
  return [];
}

function showImportResultDialog(imported, skipped) {
  if (skipped.length === 0 && imported.length <= 1) return;

  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'dialog-card wide';

  const title = document.createElement('div');
  title.className = 'dialog-message';
  title.textContent = `导入完成：${imported.length} 个成功，${skipped.length} 个跳过`;

  const list = document.createElement('div');
  list.className = 'import-result-list';

  imported.slice(0, 30).forEach(item => {
    const row = document.createElement('div');
    row.className = 'import-result-row';
    const name = document.createElement('strong');
    name.textContent = item.name;
    const source = document.createElement('span');
    source.textContent = item.source;
    row.appendChild(name);
    row.appendChild(source);
    list.appendChild(row);
  });

  skipped.slice(0, 30).forEach(item => {
    const row = document.createElement('div');
    row.className = 'import-result-row import-result-error';
    const source = document.createElement('strong');
    source.textContent = item.source;
    const reason = document.createElement('span');
    reason.textContent = item.reason;
    row.appendChild(source);
    row.appendChild(reason);
    list.appendChild(row);
  });

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  const ok = document.createElement('button');
  ok.className = 'btn-action btn-primary';
  ok.textContent = '完成';
  actions.appendChild(ok);

  dialog.appendChild(title);
  dialog.appendChild(list);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const close = () => {
    if (document.body.contains(overlay)) document.body.removeChild(overlay);
  };
  ok.onclick = close;
  overlay.onclick = (event) => { if (event.target === overlay) close(); };
  ok.focus();
}

async function importProfileFiles(filePaths) {
  const uniquePaths = [...new Set((filePaths || []).filter(Boolean))];
  if (uniquePaths.length === 0) return;

  const usedNames = new Set();
  const imported = [];
  const skipped = [];

  try {
    ensureFolder(claudeRoot);

    for (const filePath of uniquePaths) {
      try {
        const records = await readImportFile(filePath);
        if (records.length === 0) {
          skipped.push({ source: path.basename(filePath), reason: '不支持的文件类型或空 ZIP' });
          continue;
        }

        records.forEach(record => {
          const normalized = normalizeImportedProfileRecord(record, usedNames);
          if (normalized.skipped) {
            skipped.push(normalized);
            return;
          }

          saveProfileFile(normalized.name, normalized.jsonText);
          imported.push(normalized);
        });
      } catch (err) {
        skipped.push({ source: path.basename(filePath), reason: err.message || String(err) });
      }
    }

    if (imported.length > 0) {
      invalidateProfileCache();
      selectedProfile = imported[0].name;
      rebuildProfileList(getActiveProfile(true));
      selectProfileItem(selectedProfile);
      loadSelectedProfile(selectedProfile);
    }

    showAlert(`导入完成：${imported.length} 个成功，${skipped.length} 个跳过`);
    showImportResultDialog(imported, skipped);
  } catch (err) {
    console.error('importProfileFiles failed:', err);
    showAlert(`导入失败：${err.message || String(err)}`);
  }
}

async function importProfiles() {
  try {
    const filePaths = await ipcRenderer.invoke('profiles-open-import-dialog');
    await importProfileFiles(filePaths);
  } catch (err) {
    console.error('importProfiles failed:', err);
    showAlert(`导入失败：${err.message || String(err)}`);
  }
}

function dataTransferHasFiles(dataTransfer) {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types || []).includes('Files');
}

function setDropOverlayVisible(visible) {
  const overlay = document.getElementById('dropOverlay');
  if (!overlay) return;
  overlay.classList.toggle('hidden', !visible);
}

function setupProfileDropImport() {
  let dragDepth = 0;

  window.addEventListener('dragenter', (event) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth += 1;
    setDropOverlayVisible(true);
  });

  window.addEventListener('dragover', (event) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (event) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDropOverlayVisible(false);
  });

  window.addEventListener('drop', async (event) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth = 0;
    setDropOverlayVisible(false);

    const filePaths = Array.from(event.dataTransfer.files || [])
      .map(file => file.path)
      .filter(Boolean);
    await importProfileFiles(filePaths);
  });
}

function setProfileMoreMenuOpen(open) {
  const menu = document.getElementById('profileMoreMenu');
  const button = document.getElementById('profileMoreButton');
  if (!menu || !button) return;

  menu.classList.toggle('hidden', !open);
  button.setAttribute('aria-expanded', open ? 'true' : 'false');

  if (open) {
    const firstItem = menu.querySelector('button');
    if (firstItem) setTimeout(() => firstItem.focus(), 0);
  }
}

function closeProfileMoreMenu() {
  setProfileMoreMenuOpen(false);
}

function toggleProfileMoreMenu(event) {
  if (event) event.stopPropagation();

  const menu = document.getElementById('profileMoreMenu');
  if (!menu) return;

  setProfileMoreMenuOpen(menu.classList.contains('hidden'));
}

function handleMoreMenuAction(action) {
  closeProfileMoreMenu();
  if (typeof action !== 'function') return;

  try {
    const result = action();
    if (result && typeof result.catch === 'function') {
      result.catch(err => {
        console.error('profile more menu action failed:', err);
        showAlert(`操作失败：${err.message || String(err)}`);
      });
    }
  } catch (err) {
    console.error('profile more menu action failed:', err);
    showAlert(`操作失败：${err.message || String(err)}`);
  }
}

function setupProfileMoreMenu() {
  document.addEventListener('click', (event) => {
    const shell = document.querySelector('.more-menu-shell');
    if (shell && !shell.contains(event.target)) closeProfileMoreMenu();
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeProfileMoreMenu();
  });
}

ipcRenderer.on('menu-import-profiles', () => importProfiles());
ipcRenderer.on('menu-export-current-profile', () => exportCurrentProfile());
ipcRenderer.on('menu-export-all-profiles', () => exportAllProfiles());

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

function fetchOpenAIModelList(baseUrl, apiKey) {
  return new Promise((resolve) => {
    const https = require('https');
    const http = require('http');
    const { URL } = require('url');

    let modelsUrl = normalizeClaudeCodeBaseUrl(baseUrl).replace(/\/$/, '');
    if (modelsUrl.endsWith('/v1')) {
      modelsUrl += '/models';
    } else {
      modelsUrl += '/v1/models';
    }

    try {
      const parsedUrl = new URL(modelsUrl);
      const client = parsedUrl.protocol === 'https:' ? https : http;
      const req = client.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname,
        method: 'GET',
        timeout: 12000,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            resolve(null);
            return;
          }
          try {
            const parsed = JSON.parse(data);
            resolve(Array.isArray(parsed.data) ? parsed.data : null);
          } catch (e) {
            resolve(null);
          }
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    } catch (e) {
      resolve(null);
    }
  });
}

async function checkModelTextCompatibility(baseUrl, apiKey, model) {
  const models = await fetchOpenAIModelList(baseUrl, apiKey);
  if (!models) return { known: false, compatible: true };

  const metadata = models.find(item => item && item.id === model);
  if (!metadata) {
    return {
      known: true,
      compatible: true,
      reason: '模型列表未返回该 ID，将继续用实际请求验证。'
    };
  }

  if (Array.isArray(metadata.output_modalities) && !metadata.output_modalities.includes('text')) {
    return {
      known: true,
      compatible: false,
      reason: `模型 ${model} 的输出模态是 ${metadata.output_modalities.join(', ')}，不是 Claude Code 需要的 text。`
    };
  }

  return { known: true, compatible: true };
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
            url: url,
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
          url: url,
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
          url: url,
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
        url: url,
        error: err.message
      });
    }
  });
}

function showEnhancedTestProgress(formats) {
  const bar = document.getElementById('testProgressBar');
  if (bar) bar.style.width = '40%';
  const btn = document.getElementById('testBtn');
  if (btn) {
    btn.innerText = '正在测试...';
    btn.classList.add('btn-testing');
  }
}

function updateTestProgress(formatId, status, result = null) {
  const bar = document.getElementById('testProgressBar');
  if (!bar) return;
  const currentWidth = parseFloat(bar.style.width) || 0;
  bar.style.width = Math.min(95, currentWidth + 15) + '%';
}

function hideEnhancedTestProgress() {
  const bar = document.getElementById('testProgressBar');
  if (bar) {
    bar.style.width = '100%';
    setTimeout(() => { bar.style.width = '0%'; }, 600);
  }
  const btn = document.getElementById('testBtn');
  if (btn) {
    btn.innerText = '测试连接';
    btn.classList.remove('btn-testing');
  }
}

function saveApiFormatToConfig(format, result, compatibility = null) {
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
  if (compatibility) {
    config.apiFormat.modelCompatibility = compatibility;
  }

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

function saveModelCompatibilityToConfig(compatibility) {
  const jsonText = document.getElementById('profileJson').value;
  const config = parseJson(jsonText) || {};
  if (!config.apiFormat) config.apiFormat = {};
  config.apiFormat.modelCompatibility = compatibility;
  if (!compatibility.compatible) {
    config.apiFormat.testResult = {
      success: false,
      statusCode: 0,
      elapsed: 0
    };
  }
  const updatedJson = JSON.stringify(config, null, 2);
  document.getElementById('profileJson').value = updatedJson;
  syncFieldsFromJson();

  if (selectedProfile) {
    saveProfileFile(selectedProfile, updatedJson);
    rebuildProfileList(getActiveProfile());
  }
}

function showTestFailureDialog(testResults) {
  const failedCount = testResults.filter(r => !r.result.success).length;
  const totalCount = testResults.length;
  const first = testResults.find(r => !r.result.success) || testResults[0];

  showDiagnostics({
    summary: `所有 ${totalCount} 种 API 格式测试均失败。`,
    items: [
      { label: '失败数量', value: `${failedCount}/${totalCount}` },
      { label: '失败端点', value: first && first.result ? first.result.url : '' },
      { label: 'HTTP 状态', value: first && first.result ? String(first.result.statusCode || 0) : '' },
      { label: '错误摘要', value: first && first.result ? (first.result.error || '未知错误') : '' },
      { label: '建议', value: '检查 Base URL、模型 ID、Token 权限，以及模型是否支持 text 输出。' }
    ],
    type: 'error'
  });
  showAlert('测试失败，已生成连接诊断。');
}

function testCurrent() {
  clearDiagnostics();
  const testToken = ++pendingApiTestToken;
  const testingProfile = selectedProfile;
  normalizeBaseUrlField({ notify: true });
  syncJsonFromFields();

  const baseUrl = document.getElementById('baseUrl').value.trim();
  const apiKey = document.getElementById('apiKey').value.trim();

  if (!baseUrl || !apiKey) {
    showAlert('请先填写基础地址和 API 密钥。');
    return;
  }

  document.getElementById('footerHint').innerText = '状态：正在测试连接...';

  // 异步顺序测试
  (async () => {
    const model = getModelFromConfig();
    const compatibility = await checkModelTextCompatibility(baseUrl, apiKey, model);
    if (testToken !== pendingApiTestToken || testingProfile !== selectedProfile) return;
    if (!compatibility.compatible) {
      document.getElementById('footerHint').innerText = `状态：已激活 ${getActiveProfile() || 'unknown'}`;
      saveModelCompatibilityToConfig(compatibility);
      showDiagnostics({
        summary: `${model} 不兼容 Claude Code。`,
        items: [
          { label: 'Base URL', value: baseUrl },
          { label: '模型', value: model },
          { label: '原因', value: compatibility.reason },
          { label: '建议', value: '选择 output_modalities 包含 text 的模型。图片模型只能用于图像生成接口。' }
        ],
        type: 'error'
      });
      showAlert(`${model} 不能作为 Claude Code 对话模型使用。\n\n${compatibility.reason}`);
      return;
    }

    const sortedFormats = sortFormatsByUrl(API_FORMATS, baseUrl);
    showEnhancedTestProgress(sortedFormats);

    let successFormat = null;
    const testResults = [];

    for (const format of sortedFormats) {
      updateTestProgress(format.id, 'testing');
      const result = await testApiFormat(baseUrl, apiKey, model, format);
      if (testToken !== pendingApiTestToken || testingProfile !== selectedProfile) return;
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
      if (testToken !== pendingApiTestToken || testingProfile !== selectedProfile) return;
      hideEnhancedTestProgress();

      if (successFormat) {
        const successResult = testResults.find(r => r.format === successFormat).result;
        saveApiFormatToConfig(successFormat, successResult, compatibility);
        showDiagnostics({
          summary: `连接成功：${successFormat.name}`,
          items: [
            { label: '请求端点', value: successResult.url },
            { label: '模型', value: model },
            { label: 'HTTP 状态', value: String(successResult.statusCode) },
            { label: '响应时间', value: `${successResult.elapsed}ms` }
          ],
          type: 'success'
        });
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
  // 加载保存的主题
  const savedTheme = localStorage.getItem('clave-theme') || 'azure';
  setTheme(savedTheme);

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
  setupProfileDropImport();
  setupProfileMoreMenu();

  // 搜索逻辑
  const searchInput = document.getElementById('profileSearch');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const term = e.target.value.toLowerCase();
      const items = document.querySelectorAll('.sidebar-item');
      items.forEach(item => {
        const name = item.dataset.profile.toLowerCase();
        item.style.display = name.includes(term) ? 'flex' : 'none';
      });
    });

    //快捷键 CMD+K
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInput.focus();
      }
    });
  }

  const baseUrlInput = document.getElementById('baseUrl');
  const profileNameInput = document.getElementById('profileName');
  profileNameInput.addEventListener('input', () => {
    const title = document.getElementById('profileTitle');
    if (title) title.value = profileNameInput.value;
    updateProfileNameHint();
  });
  baseUrlInput.addEventListener('input', () => {
    setBaseUrlHint();
    syncJsonFromFields();
  });
  baseUrlInput.addEventListener('blur', () => {
    normalizeBaseUrlField({ notify: true });
    syncJsonFromFields();
  });
  baseUrlInput.addEventListener('change', () => {
    normalizeBaseUrlField({ notify: true });
    syncJsonFromFields();
  });
  document.getElementById('apiKey').addEventListener('keyup', syncJsonFromFields);
  const jsonEditor = document.getElementById('profileJson');
  jsonEditor.addEventListener('input', () => {
    clearJsonBracketMarkers();
    validateJsonEditor();
    syncFieldsFromJson();
  });
  jsonEditor.addEventListener('mouseup', markMatchingJsonBracket);
  jsonEditor.addEventListener('scroll', renderActiveJsonBracketMarkers);
});
