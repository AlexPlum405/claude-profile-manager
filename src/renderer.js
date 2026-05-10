const claveBridge = window.claveApi;
if (!claveBridge) {
  throw new Error('Clave 安全桥未加载，应用无法访问本地配置。');
}
const {
  fs,
  path,
  shell,
  ipcRenderer,
  imports: importApi,
  exports: exportApi,
  history: historyApi,
  clipboard,
  runtime,
  net,
  appPackage
} = claveBridge;

// 路径配置
const homeDir = claveBridge.paths.homeDir;
const claudeRoot = claveBridge.paths.claudeRoot;
const activeSettingsPath = claveBridge.paths.activeSettingsPath;
const activeProfilePath = claveBridge.paths.activeProfilePath;
const EXPORT_MANIFEST_FILE = 'clave-profiles-manifest.json';
const PROFILE_ORDER_STORAGE_KEY = 'clave-profile-order-v1';
const MODEL_HISTORY_STORAGE_KEY = 'clave-model-history-v1';

let currentLoadedProfile = '';
let selectedProfile = '';
let cachedProfiles = null;
let cachedActiveProfile = null;
let pendingProfileLoadToken = 0;
let pendingThemeFrame = null;
let pendingApiTestToken = 0;
let currentTheme = '';
let activeJsonBracketMatch = null;
let draggingProfileName = '';
let cachedAvailableModels = [];
let pendingModelListToken = 0;
let lastDiagnostics = null;

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

const PROVIDER_TEMPLATES = [
  {
    id: 'custom',
    name: '自定义服务',
    description: '保留当前配置，只使用手动填写的地址和模型。',
    baseUrl: '',
    endpointMode: 'auto',
    formatId: '',
    defaultModel: '',
    knownModels: [],
    hostPatterns: []
  },
  {
    id: 'mimo',
    name: 'Mimo / 小米 Mimo',
    description: 'Mimo 的 Anthropic 兼容网关通常可对话，但不开放模型列表。',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
    endpointMode: 'auto',
    formatId: 'anthropic-native',
    defaultModel: 'mimo-v2.5-pro',
    knownModels: ['mimo-v2.5-pro'],
    hostPatterns: ['xiaomimimo.com']
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    description: 'MiniMax Anthropic 兼容接口。',
    baseUrl: 'https://api.minimax.chat/anthropic',
    endpointMode: 'auto',
    formatId: 'minimax-anthropic',
    defaultModel: 'MiniMax-M2.7',
    knownModels: ['MiniMax-M2.7'],
    hostPatterns: ['minimax.chat']
  },
  {
    id: 'volcengine',
    name: '火山引擎 Ark',
    description: 'OpenAI 兼容 chat/completions 线路。',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    endpointMode: 'openai',
    formatId: 'volcengine-api',
    defaultModel: '',
    knownModels: [],
    hostPatterns: ['volces.com', 'ark.cn']
  },
  {
    id: 'sensenova',
    name: '商汤日日新',
    description: '商汤 OpenAI 兼容线路。',
    baseUrl: 'https://token.sensenova.cn/v1/llm/chat-completions',
    endpointMode: 'direct',
    formatId: 'openai-compatible',
    defaultModel: '',
    knownModels: [],
    hostPatterns: ['sensenova.cn']
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI 兼容',
    description: '通用 /v1/chat/completions 服务。',
    baseUrl: 'https://api.openai.com',
    endpointMode: 'openai',
    formatId: 'openai-compatible',
    defaultModel: '',
    knownModels: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'],
    hostPatterns: ['openai.com', 'deepseek.com']
  },
  {
    id: 'anthropic',
    name: 'Anthropic 原生',
    description: '官方 Anthropic /v1/messages 服务。',
    baseUrl: 'https://api.anthropic.com',
    endpointMode: 'anthropic',
    formatId: 'anthropic-native',
    defaultModel: 'claude-sonnet-4-6',
    knownModels: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5'],
    hostPatterns: ['anthropic.com', 'claude.ai']
  },
  {
    id: 'iflytek',
    name: '讯飞星火',
    description: '常见完整端点模式，建议使用直连。',
    baseUrl: '',
    endpointMode: 'direct',
    formatId: 'openai-compatible',
    defaultModel: '',
    knownModels: [],
    hostPatterns: ['iflytek.com']
  }
];

const SCENARIO_PRESETS = [
  { id: '', name: '未标记', description: '不绑定使用场景。' },
  { id: 'daily-coding', name: '日常编码', description: '稳定、通用，适合默认开发。' },
  { id: 'deep-reasoning', name: '深度推理', description: '更强推理，适合复杂架构和长任务。' },
  { id: 'fast-cheap', name: '便宜快速', description: '低成本快速响应。' },
  { id: 'backup-route', name: '备用线路', description: '主线路异常时切换。' },
  { id: 'cn-route', name: '国内线路', description: '国内网络环境优先。' }
];

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
    urlPatterns: ['anthropic.com', 'claude.ai', 'xiaomimimo.com']
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
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.warn('readText failed:', err);
    return '';
  }
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

function byProfileName(a, b) {
  return a.localeCompare(b, 'zh-Hans-CN', { sensitivity: 'base' });
}

function readProfileOrder() {
  try {
    const raw = localStorage.getItem(PROFILE_ORDER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const unique = new Set();
    return parsed.filter((item) => {
      if (typeof item !== 'string' || !item) return false;
      if (unique.has(item)) return false;
      unique.add(item);
      return true;
    });
  } catch (err) {
    console.warn('readProfileOrder failed:', err);
    return [];
  }
}

function writeProfileOrder(order) {
  const unique = new Set();
  const normalized = (Array.isArray(order) ? order : []).filter((item) => {
    if (typeof item !== 'string' || !item) return false;
    if (unique.has(item)) return false;
    unique.add(item);
    return true;
  });
  try {
    localStorage.setItem(PROFILE_ORDER_STORAGE_KEY, JSON.stringify(normalized));
  } catch (err) {
    console.warn('writeProfileOrder failed:', err);
  }
}

function clearProfileOrder() {
  try {
    localStorage.removeItem(PROFILE_ORDER_STORAGE_KEY);
  } catch (err) {
    console.warn('clearProfileOrder failed:', err);
  }
}

function reconcileProfileOrder(profiles) {
  const order = readProfileOrder();
  const profileSet = new Set(profiles);
  const existing = order.filter(name => profileSet.has(name));
  const missing = profiles.filter(name => !existing.includes(name));
  const merged = [...existing, ...missing];

  if (merged.length !== order.length || merged.some((name, index) => order[index] !== name)) {
    writeProfileOrder(merged);
  }
  return merged;
}

function replaceProfileInStoredOrder(previousName, nextName) {
  if (!previousName || !nextName || previousName === nextName) return;
  const order = readProfileOrder();
  const index = order.indexOf(previousName);
  if (index >= 0) {
    order[index] = nextName;
    writeProfileOrder(order);
  }
}

function moveProfileOrder(draggedProfile, targetProfile) {
  if (!draggedProfile || !targetProfile || draggedProfile === targetProfile) return false;
  const order = scanProfiles();
  const fromIndex = order.indexOf(draggedProfile);
  const toIndex = order.indexOf(targetProfile);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return false;

  const nextOrder = order.slice();
  const [moved] = nextOrder.splice(fromIndex, 1);
  nextOrder.splice(toIndex, 0, moved);
  writeProfileOrder(nextOrder);
  cachedProfiles = nextOrder.slice();
  return true;
}

function isProfileReorderAllowed() {
  const searchInput = document.getElementById('profileSearch');
  return !searchInput || !searchInput.value.trim();
}

function clearDragState() {
  draggingProfileName = '';
  const items = document.querySelectorAll('.sidebar-item');
  items.forEach(item => {
    item.classList.remove('dragging');
    item.classList.remove('drag-over');
  });
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

  const alphabeticalProfiles = results.sort(byProfileName);
  const orderedProfiles = reconcileProfileOrder(alphabeticalProfiles);
  cachedProfiles = orderedProfiles;
  return orderedProfiles.slice();
}

// ── JSON 编辑器（contenteditable <pre>）统一访问层 ─────────────
function getJsonEditorValue() {
  const el = document.getElementById('profileJson');
  if (!el) return '';
  return el.innerText || el.textContent || '';
}

function getJsonEditorCaret() {
  const el = document.getElementById('profileJson');
  if (!el) return 0;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return 0;
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

function getJsonEditorSelectionCount() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  return sel.getRangeAt(0).toString().length;
}

function setJsonEditorCaret(offset) {
  const el = document.getElementById('profileJson');
  if (!el) return;
  const sel = window.getSelection();
  if (!sel) return;
  let remaining = offset;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (remaining <= len) {
      const range = document.createRange();
      range.setStart(node, Math.max(0, remaining));
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    remaining -= len;
  }
  // 超出末尾 → 放到最后
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
}

function renderJsonEditorContent(text, activeIndex = -1, matchIndex = -1) {
  const el = document.getElementById('profileJson');
  if (!el) return;
  if (activeIndex < 0 || matchIndex < 0) {
    el.textContent = text;
    return;
  }
  const first = Math.min(activeIndex, matchIndex);
  const second = Math.max(activeIndex, matchIndex);
  const a = escapeHtml(text.slice(0, first));
  const b = escapeHtml(text[first] || '');
  const c = escapeHtml(text.slice(first + 1, second));
  const d = escapeHtml(text[second] || '');
  const e = escapeHtml(text.slice(second + 1));
  const anchorClass = first === activeIndex ? ' bracket-anchor' : '';
  const matchClass = second === activeIndex ? ' bracket-anchor' : '';
  el.innerHTML =
    a +
    `<span class="bracket-active${anchorClass}">${b}</span>` +
    c +
    `<span class="bracket-active${matchClass}">${d}</span>` +
    e;
}

function setJsonEditorValue(text) {
  const el = document.getElementById('profileJson');
  if (!el) return;
  el.textContent = text;
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

function getTemplateById(id) {
  return PROVIDER_TEMPLATES.find(template => template.id === id) || PROVIDER_TEMPLATES[0];
}

function getFormatById(id) {
  return API_FORMATS.find(format => format.id === id) || null;
}

function hostFromUrl(baseUrl = '') {
  try {
    return new URL(String(baseUrl || '').trim()).hostname.toLowerCase();
  } catch (error) {
    return '';
  }
}

function detectProviderTemplate(configOrUrl = '') {
  const baseUrl = typeof configOrUrl === 'string'
    ? configOrUrl
    : (configOrUrl && configOrUrl.env && configOrUrl.env.ANTHROPIC_BASE_URL) || '';
  const configTemplate = typeof configOrUrl === 'object'
    && configOrUrl
    && configOrUrl.apiFormat
    && configOrUrl.apiFormat.providerTemplate;
  if (configTemplate) return getTemplateById(configTemplate);

  const host = hostFromUrl(baseUrl);
  if (!host) return PROVIDER_TEMPLATES[0];
  return PROVIDER_TEMPLATES.find(template =>
    template.id !== 'custom'
    && template.hostPatterns.some(pattern => host.includes(pattern))
  ) || PROVIDER_TEMPLATES[0];
}

function modelHistoryKey(baseUrl = '') {
  return hostFromUrl(baseUrl) || 'custom';
}

function readModelHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MODEL_HISTORY_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

function writeModelHistory(history) {
  try {
    localStorage.setItem(MODEL_HISTORY_STORAGE_KEY, JSON.stringify(history || {}));
  } catch (error) {
    console.warn('writeModelHistory failed:', error);
  }
}

function rememberModelForProvider(baseUrl, modelId) {
  const model = String(modelId || '').trim();
  if (!model) return;
  const key = modelHistoryKey(baseUrl);
  const history = readModelHistory();
  const list = Array.isArray(history[key]) ? history[key] : [];
  history[key] = [model, ...list.filter(item => item !== model)].slice(0, 12);
  writeModelHistory(history);
}

function collectModelsFromProfiles(baseUrl = '') {
  const host = hostFromUrl(baseUrl);
  if (!host) return [];
  const found = [];
  scanProfiles({ force: true }).forEach(profile => {
    const parsed = parseJson(readProfileText(profile));
    if (!parsed || !parsed.env || hostFromUrl(parsed.env.ANTHROPIC_BASE_URL) !== host) return;
    const model = getProviderModelFromConfig(parsed) || (parsed.env && parsed.env.ANTHROPIC_MODEL) || parsed.model || '';
    if (model) found.push(String(model).trim());
  });
  return found;
}

function modelRecordsFromIds(ids = [], source = '已知') {
  const seen = new Set();
  return ids
    .map(id => String(id || '').trim())
    .filter(id => {
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map(id => ({ id, owned_by: source }));
}

function getFallbackModelRecords(config = parseJson(getJsonEditorValue()) || {}) {
  const baseUrl = config && config.env ? config.env.ANTHROPIC_BASE_URL : document.getElementById('baseUrl')?.value || '';
  const template = detectProviderTemplate(config || baseUrl);
  const current = getProviderModelFromConfig(config);
  const history = readModelHistory()[modelHistoryKey(baseUrl)] || [];
  const profileModels = collectModelsFromProfiles(baseUrl);
  return modelRecordsFromIds([
    current,
    ...(template.knownModels || []),
    ...(history || []),
    ...profileModels
  ], template.id === 'custom' ? '历史' : template.name);
}

function formatDateTime(value) {
  if (!value) return '无记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

function daysSince(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return Infinity;
  return (Date.now() - date.getTime()) / (24 * 60 * 60 * 1000);
}

function buildHealthReport(config, profileName = selectedProfile, activeProfile = getActiveProfile()) {
  const checks = [];
  let score = 100;
  const env = (config && config.env) || {};
  const apiFormat = (config && config.apiFormat) || {};
  const providerModel = getProviderModelFromConfig(config);

  const push = (key, label, status, detail, penalty = 0) => {
    checks.push({ key, label, status, detail });
    if (status === 'bad' || status === 'warn') score -= penalty;
  };

  push(
    'baseUrl',
    'Base URL',
    env.ANTHROPIC_BASE_URL ? 'ok' : 'bad',
    env.ANTHROPIC_BASE_URL || '未填写',
    25
  );
  push(
    'token',
    '认证令牌',
    env.ANTHROPIC_AUTH_TOKEN ? 'ok' : 'bad',
    env.ANTHROPIC_AUTH_TOKEN ? redactSecret(env.ANTHROPIC_AUTH_TOKEN) : '未填写',
    25
  );
  push(
    'model',
    '模型',
    providerModel || env.ANTHROPIC_MODEL || config?.model ? 'ok' : 'warn',
    providerModel || env.ANTHROPIC_MODEL || config?.model || '未设置',
    12
  );

  if (apiFormat.modelCompatibility && apiFormat.modelCompatibility.compatible === false) {
    push('compatibility', '模型兼容性', 'bad', apiFormat.modelCompatibility.reason || '不兼容 Claude Code', 28);
  } else if (apiFormat.modelCompatibility && apiFormat.modelCompatibility.known) {
    push('compatibility', '模型兼容性', 'ok', '已确认 text 兼容', 0);
  } else {
    push('compatibility', '模型兼容性', 'warn', '未确认，建议测试连接', 6);
  }

  if (apiFormat.testResult && apiFormat.testResult.success) {
    const stale = apiFormat.testedAt && daysSince(apiFormat.testedAt) > 7;
    push(
      'test',
      '连接测试',
      stale ? 'warn' : 'ok',
      `${apiFormat.name || apiFormat.id || '通过'} · ${formatDateTime(apiFormat.testedAt)}`,
      stale ? 8 : 0
    );
  } else if (apiFormat.testResult) {
    push('test', '连接测试', 'bad', '最近测试失败', 25);
  } else {
    push('test', '连接测试', 'warn', '尚未测试', 15);
  }

  const listStatus = apiFormat.modelListStatus;
  if (listStatus && listStatus.state === 'available') {
    push('modelList', '模型列表', 'ok', `${listStatus.count || 0} 个模型 · ${formatDateTime(listStatus.checkedAt)}`, 0);
  } else if (listStatus && listStatus.state === 'unavailable') {
    push('modelList', '模型列表', 'warn', '服务未开放，使用手动/兜底模型', 4);
  } else {
    push('modelList', '模型列表', 'warn', '未获取', 4);
  }

  push(
    'active',
    '激活状态',
    profileName && profileName === activeProfile ? 'ok' : 'warn',
    profileName && profileName === activeProfile ? '当前已激活' : `当前激活：${activeProfile || '无'}`,
    profileName && profileName === activeProfile ? 0 : 4
  );

  return {
    score: Math.max(0, Math.min(100, score)),
    status: score >= 85 ? 'ok' : score >= 60 ? 'warn' : 'bad',
    checks
  };
}

function setModelHint(message = '', type = '') {
  const hint = document.getElementById('modelHint');
  if (!hint) return;
  if (!message) {
    hint.textContent = '';
    hint.classList.add('hidden');
    hint.classList.remove('warning', 'error');
    return;
  }
  hint.textContent = message;
  hint.classList.remove('hidden');
  hint.classList.toggle('warning', type === 'warning');
  hint.classList.toggle('error', type === 'error');
}

function describeModelOption(model) {
  if (!model || !model.id) return '';
  const parts = [model.id];
  const modalities = Array.isArray(model.output_modalities) ? model.output_modalities : [];
  if (modalities.length > 0) parts.push(`[${modalities.join(', ')}]`);
  if (model.owned_by) parts.push(`- ${model.owned_by}`);
  return parts.join(' ');
}

function renderModelOptions(models = cachedAvailableModels, selectedModel = '') {
  const input = document.getElementById('modelSelect');
  const options = document.getElementById('modelOptions');
  if (!input || !options) return;

  options.innerHTML = '';
  const fallbackModels = getFallbackModelRecords(parseJson(getJsonEditorValue()) || {});
  const mergedModels = [...(models || []), ...fallbackModels];
  const seen = new Set();
  mergedModels.forEach(model => {
    if (!model || !model.id || seen.has(model.id)) return;
    seen.add(model.id);
    const option = document.createElement('option');
    option.value = model.id;
    option.label = describeModelOption(model);
    options.appendChild(option);
  });

  if (selectedModel && !seen.has(selectedModel)) {
    const current = document.createElement('option');
    current.value = selectedModel;
    current.label = '当前模型';
    options.insertBefore(current, options.firstChild);
  }

  input.disabled = false;
  input.placeholder = seen.size > 0
    ? '选择或输入模型 ID'
    : selectedModel
      ? '当前模型'
      : '手动输入模型 ID';
  if (document.activeElement !== input) {
    input.value = selectedModel || '';
  }
}

function updateModelPickerFromConfig(config = parseJson(getJsonEditorValue())) {
  const selectedModel = getProviderModelFromConfig(config);
  renderModelOptions(cachedAvailableModels, selectedModel);
  if (selectedModel) {
    setModelHint(`当前模型：${selectedModel}`);
  } else if (cachedAvailableModels.length === 0) {
    setModelHint('');
  }
}

function resetAvailableModels(message = '') {
  cachedAvailableModels = [];
  pendingModelListToken++;
  updateModelPickerFromConfig();
  if (message) setModelHint(message, 'warning');
}

function getCustomSelectShell(targetId) {
  return Array.from(document.querySelectorAll('.custom-select'))
    .find(shell => shell.dataset.target === targetId) || null;
}

function getCustomSelectLabel(targetId, value) {
  const shell = getCustomSelectShell(targetId);
  if (!shell) return value || '';
  const valueText = String(value || '');
  const options = Array.from(shell.querySelectorAll('.custom-select-menu button[data-value]'));
  const selected = options.find(option => String(option.dataset.value || '') === valueText);
  if (selected) return selected.textContent.trim();
  return valueText || (options[0] ? options[0].textContent.trim() : '未选择');
}

function closeCustomSelect(shell) {
  if (!shell) return;
  const button = shell.querySelector('.custom-select-button');
  const menu = shell.querySelector('.custom-select-menu');
  shell.classList.remove('open');
  if (menu) menu.classList.add('hidden');
  if (button) button.setAttribute('aria-expanded', 'false');
}

function closeAllCustomSelects(except = null) {
  document.querySelectorAll('.custom-select.open').forEach(shell => {
    if (shell !== except) closeCustomSelect(shell);
  });
}

function openCustomSelect(shell) {
  const button = shell.querySelector('.custom-select-button');
  const menu = shell.querySelector('.custom-select-menu');
  if (!button || !menu) return;
  closeAllCustomSelects(shell);
  shell.classList.add('open');
  menu.classList.remove('hidden');
  button.setAttribute('aria-expanded', 'true');
}

function setCustomSelectValue(targetId, value, { silent = false } = {}) {
  const input = document.getElementById(targetId);
  const shell = getCustomSelectShell(targetId);
  if (!input) return;

  const nextValue = String(value || '');
  const previousValue = input.value;
  input.value = nextValue;

  if (shell) {
    const button = shell.querySelector('.custom-select-button');
    const options = Array.from(shell.querySelectorAll('.custom-select-menu button[data-value]'));
    const label = getCustomSelectLabel(targetId, nextValue);
    if (button) {
      button.textContent = label;
      button.title = label;
    }
    options.forEach(option => {
      const selected = String(option.dataset.value || '') === nextValue;
      option.classList.toggle('selected', selected);
      option.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
  }

  if (!silent && previousValue !== nextValue) {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function setupCustomSelects() {
  document.querySelectorAll('.custom-select').forEach(shell => {
    const targetId = shell.dataset.target;
    const input = document.getElementById(targetId);
    const button = shell.querySelector('.custom-select-button');
    const menu = shell.querySelector('.custom-select-menu');
    if (!targetId || !input || !button || !menu) return;

    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');

    if (shell.dataset.ready !== 'true') {
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (shell.classList.contains('open')) {
          closeCustomSelect(shell);
        } else {
          openCustomSelect(shell);
        }
      });

      button.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        event.preventDefault();
        openCustomSelect(shell);
        const options = Array.from(menu.querySelectorAll('button[data-value]:not(:disabled)'));
        const selectedIndex = options.findIndex(option => option.classList.contains('selected'));
        const nextIndex = event.key === 'ArrowUp'
          ? Math.max(0, selectedIndex < 0 ? options.length - 1 : selectedIndex - 1)
          : Math.min(options.length - 1, selectedIndex + 1);
        if (options[nextIndex]) options[nextIndex].focus();
      });

      menu.addEventListener('click', event => {
        const option = event.target.closest('button[data-value]');
        if (!option || option.disabled) return;
        event.preventDefault();
        event.stopPropagation();
        setCustomSelectValue(targetId, option.dataset.value || '');
        closeCustomSelect(shell);
        button.focus();
      });

      menu.addEventListener('keydown', event => {
        const option = event.target.closest('button[data-value]');
        if (!option) return;
        const options = Array.from(menu.querySelectorAll('button[data-value]:not(:disabled)'));
        const currentIndex = options.indexOf(option);
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          option.click();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const direction = event.key === 'ArrowDown' ? 1 : -1;
          const next = options[currentIndex + direction] || options[currentIndex];
          if (next) next.focus();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          closeCustomSelect(shell);
          button.focus();
        }
      });

      shell.dataset.ready = 'true';
    }

    setCustomSelectValue(targetId, input.value, { silent: true });
  });

  if (document.body.dataset.customSelectGlobalReady !== 'true') {
    document.addEventListener('click', () => closeAllCustomSelects());
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeAllCustomSelects();
    });
    document.body.dataset.customSelectGlobalReady = 'true';
  }
}

function isModelListDiscoveryUnavailable(attempts = []) {
  const meaningfulAttempts = attempts.filter(attempt => attempt && (attempt.statusCode || attempt.error));
  if (meaningfulAttempts.length === 0) return false;
  return meaningfulAttempts.every(attempt => [404, 405, 501].includes(Number(attempt.statusCode)));
}

function saveModelListStatusToConfig(status) {
  const config = parseJson(getJsonEditorValue()) || {};
  if (!config.apiFormat) config.apiFormat = {};
  config.apiFormat.modelListStatus = Object.assign({ checkedAt: new Date().toISOString() }, status);
  setJsonEditorValue(JSON.stringify(config, null, 2));
  syncFieldsFromJson();
}

function normalizeClaudeCodeBaseUrl(baseUrl, mode = 'auto') {
  if (!baseUrl || typeof baseUrl !== 'string') return baseUrl;
  // direct 模式下 Base URL 本身即完整端点，保持原样（只去掉尾部斜杠）
  if (mode === 'direct') {
    return baseUrl.trim().replace(/\/+$/, '');
  }
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
    const mode = (normalized.apiFormat && normalized.apiFormat.endpointMode) || 'auto';
    normalized.env.ANTHROPIC_BASE_URL = normalizeClaudeCodeBaseUrl(normalized.env.ANTHROPIC_BASE_URL, mode);
  }

  return normalized;
}

function getCurrentEndpointMode() {
  const select = document.getElementById('endpointMode');
  if (select && select.value) return select.value;
  const parsed = parseJson(getJsonEditorValue());
  return (parsed && parsed.apiFormat && parsed.apiFormat.endpointMode) || 'auto';
}

function setBaseUrlHint(message = '', isWarning = false) {
  const hint = document.getElementById('baseUrlHint');
  if (!hint) return;
  if (message) {
    hint.textContent = message;
    hint.classList.remove('hidden');
    hint.classList.toggle('warning', isWarning);
  } else {
    hint.textContent = '';
    hint.classList.add('hidden');
    hint.classList.remove('warning');
  }
}

function normalizeBaseUrlField({ notify = false } = {}) {
  const input = document.getElementById('baseUrl');
  if (!input) return '';

  const raw = input.value.trim();
  const mode = getCurrentEndpointMode();

  // direct 模式下不剥离端点
  if (mode === 'direct') {
    const stripped = raw.replace(/\/+$/, '');
    if (stripped !== raw) input.value = stripped;
    setBaseUrlHint();
    return stripped;
  }

  const normalized = normalizeClaudeCodeBaseUrl(raw, mode);
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
  const isRenamed = result.valid && input.value.trim() !== (currentLoadedProfile || selectedProfile || '');

  if (!result.valid) {
    hint.textContent = result.message;
    hint.classList.add('error');
    hint.classList.remove('warning', 'hidden');
  } else if (isRenamed) {
    hint.textContent = `将保存为 settings.${input.value.trim()}.json`;
    hint.classList.add('warning');
    hint.classList.remove('error', 'hidden');
  } else {
    hint.textContent = '';
    hint.classList.add('hidden');
    hint.classList.remove('error', 'warning');
  }
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
  const { value, error } = parseJsonWithError(getJsonEditorValue());
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
  setJsonEditorValue(JSON.stringify(parsed, null, 2));
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

function findMatchingQuote(text, quoteIndex) {
  // 扫描 JSON 字符串，判断 quoteIndex 处的 " 是开还是关，找配对的另一端。
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (inString && ch === '\\') { escaped = true; continue; }
    if (ch === '"') {
      if (!inString) {
        inString = true;
        stringStart = i;
        if (i === quoteIndex) {
          // 找关闭那一个
          for (let j = i + 1; j < text.length; j += 1) {
            if (escaped) { escaped = false; continue; }
            if (text[j] === '\\') { escaped = true; continue; }
            if (text[j] === '"') return j;
          }
          return -1;
        }
      } else {
        inString = false;
        if (i === quoteIndex) return stringStart;
      }
    }
  }
  return -1;
}

function getBracketIndexNearCaret(text, caret) {
  const candidates = [caret, caret - 1];
  return candidates.find(index => index >= 0 && index < text.length && '{}[]"'.includes(text[index])) ?? -1;
}

function markMatchingJsonBracket() {
  const editor = document.getElementById('profileJson');
  if (!editor) return;

  const text = getJsonEditorValue();

  // 有选区：保持当前高亮不变，不做任何 validation/status 变动
  if (getJsonEditorSelectionCount() > 0) {
    return;
  }

  const caret = getJsonEditorCaret();
  const bracketIndex = getBracketIndexNearCaret(text, caret);
  if (bracketIndex === -1) {
    if (activeJsonBracketMatch) {
      // 原本有高亮的场合需要清掉
      activeJsonBracketMatch = null;
      renderJsonEditorContent(text, -1, -1);
      setJsonEditorCaret(caret);
    }
    return;
  }

  const ch = text[bracketIndex];
  const matchIndex = ch === '"'
    ? findMatchingQuote(text, bracketIndex)
    : findMatchingJsonBracket(text, bracketIndex);

  if (matchIndex === -1) {
    // 找不到配对：不报错、不打扰用户，只清掉既有高亮
    if (activeJsonBracketMatch) {
      activeJsonBracketMatch = null;
      renderJsonEditorContent(text, -1, -1);
      setJsonEditorCaret(caret);
    }
    return;
  }

  activeJsonBracketMatch = { bracketIndex, matchIndex };
  renderJsonEditorContent(text, bracketIndex, matchIndex);
  setJsonEditorCaret(caret);
  setJsonStatusNote(`已标识匹配的 ${text[bracketIndex]} ${text[matchIndex]}`, 'success');
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

function getProfileScenarioName(profileName) {
  const parsed = parseJson(readProfileText(profileName));
  if (!parsed || !parsed.apiFormat || !parsed.apiFormat.scenarioTag) return '';
  const scenario = SCENARIO_PRESETS.find(item => item.id === parsed.apiFormat.scenarioTag);
  return scenario ? scenario.name : parsed.apiFormat.scenarioName || '';
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
  const current = parseJson(getJsonEditorValue()) || {};
  if (!current.env) current.env = {};

  current.env.ANTHROPIC_BASE_URL = normalizeBaseUrl
    ? normalizeBaseUrlField()
    : document.getElementById('baseUrl').value.trim();
  current.env.ANTHROPIC_AUTH_TOKEN = document.getElementById('apiKey').value.trim();

  if (!current.env.CLAUDE_CODE_ATTRIBUTION_HEADER) {
    current.env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
  }

  const modeSelect = document.getElementById('endpointMode');
  if (modeSelect && modeSelect.value) {
    if (!current.apiFormat) current.apiFormat = {};
    current.apiFormat.endpointMode = modeSelect.value;
  }

  const providerSelect = document.getElementById('providerTemplate');
  if (providerSelect && providerSelect.value) {
    const template = getTemplateById(providerSelect.value);
    if (!current.apiFormat) current.apiFormat = {};
    current.apiFormat.providerTemplate = template.id;
    current.apiFormat.providerTemplateName = template.name;
  }

  const modelInput = document.getElementById('modelSelect');
  const providerModel = modelInput ? modelInput.value.trim() : '';
  if (providerModel) {
    if (!current.apiFormat) current.apiFormat = {};
    current.apiFormat.providerModel = providerModel;
    current.env.ANTHROPIC_MODEL = providerModel;
    if (!current.model) {
      current.model = CLAUDE_CODE_FALLBACK_MODEL;
    } else if (!isClaudeCodeModel(current.model)) {
      current.model = providerModel;
    }
  }

  const thinkingToggle = document.getElementById('toggleThinking');
  if (thinkingToggle) {
    current.alwaysThinkingEnabled = !!thinkingToggle.checked;
    current.env.CLAUDE_CODE_DISABLE_THINKING = thinkingToggle.checked ? "0" : "1";
  }

  const effortSelect = document.getElementById('effortLevel');
  if (effortSelect && effortSelect.value) {
    current.effortLevel = effortSelect.value;
    current.env.CLAUDE_CODE_EFFORT_LEVEL = effortSelect.value;
  }

  const permModeSelect = document.getElementById('permissionsMode');
  if (permModeSelect && permModeSelect.value) {
    if (!current.permissions) current.permissions = {};
    current.permissions.defaultMode = permModeSelect.value;
    delete current.permissions.mode;
  }

  const scenarioSelect = document.getElementById('scenarioTag');
  if (scenarioSelect) {
    const scenario = SCENARIO_PRESETS.find(item => item.id === scenarioSelect.value) || SCENARIO_PRESETS[0];
    if (!current.apiFormat) current.apiFormat = {};
    if (scenario.id) {
      current.apiFormat.scenarioTag = scenario.id;
      current.apiFormat.scenarioName = scenario.name;
    } else {
      delete current.apiFormat.scenarioTag;
      delete current.apiFormat.scenarioName;
    }
  }

  return JSON.stringify(current, null, 2);
}

function syncFieldsFromJson() {
  const parsed = parseJson(getJsonEditorValue());
  if (!parsed || !parsed.env) return;

  document.getElementById('baseUrl').value = parsed.env.ANTHROPIC_BASE_URL || '';
  const modeSelect = document.getElementById('endpointMode');
  if (modeSelect) {
    setCustomSelectValue('endpointMode', (parsed.apiFormat && parsed.apiFormat.endpointMode) || 'auto', { silent: true });
  }
  const providerSelect = document.getElementById('providerTemplate');
  if (providerSelect) {
    const template = detectProviderTemplate(parsed);
    setCustomSelectValue('providerTemplate', template.id, { silent: true });
    updateProviderTemplateHint(template);
  }
  normalizeBaseUrlField();
  document.getElementById('apiKey').value = parsed.env.ANTHROPIC_AUTH_TOKEN || '';

  const thinkingToggle = document.getElementById('toggleThinking');
  if (thinkingToggle) {
    thinkingToggle.checked = parsed.alwaysThinkingEnabled === true
      || parsed.env.CLAUDE_CODE_DISABLE_THINKING === "0";
  }
  const effortSelect = document.getElementById('effortLevel');
  if (effortSelect) {
    const lvl = parsed.effortLevel || parsed.env.CLAUDE_CODE_EFFORT_LEVEL || 'medium';
    setCustomSelectValue('effortLevel', ['low', 'medium', 'high', 'max'].includes(lvl) ? lvl : 'medium', { silent: true });
  }
  const permModeSelect = document.getElementById('permissionsMode');
  if (permModeSelect) {
    const pm = (parsed.permissions && (parsed.permissions.defaultMode || parsed.permissions.mode)) || 'default';
    setCustomSelectValue('permissionsMode', ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'].includes(pm) ? pm : 'default', { silent: true });
  }
  const scenarioSelect = document.getElementById('scenarioTag');
  if (scenarioSelect) {
    const scenario = (parsed.apiFormat && parsed.apiFormat.scenarioTag) || '';
    setCustomSelectValue('scenarioTag', SCENARIO_PRESETS.some(item => item.id === scenario) ? scenario : '', { silent: true });
  }
  updateModelPickerFromConfig(parsed);
  renderHealthPanel(parsed);
}

function syncJsonFromFields(options = {}) {
  setJsonEditorValue(buildJsonFromFields(options));
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

function updateProviderTemplateHint(template = getTemplateById('custom')) {
  const hint = document.getElementById('providerTemplateHint');
  if (!hint) return;
  if (!template || template.id === 'custom') {
    hint.textContent = '自定义模式：保留当前地址、端点模式和模型。';
  } else {
    hint.textContent = template.description;
  }
  hint.classList.remove('hidden', 'error');
  hint.classList.toggle('warning', template && template.id !== 'custom');
}

function renderHealthPanel(config = parseJson(getJsonEditorValue()) || {}) {
  const scoreEl = document.getElementById('healthScore');
  const summaryEl = document.getElementById('healthSummary');
  const checksEl = document.getElementById('healthChecks');
  if (!scoreEl || !summaryEl || !checksEl) return;

  const report = buildHealthReport(config, selectedProfile, getActiveProfile());
  scoreEl.textContent = String(report.score);
  scoreEl.classList.toggle('warn', report.status === 'warn');
  scoreEl.classList.toggle('bad', report.status === 'bad');
  summaryEl.textContent = report.status === 'ok'
    ? '配置状态良好，可以放心切换。'
    : report.status === 'warn'
      ? '配置可用但仍有风险项，建议测试或补齐信息。'
      : '配置存在阻断项，暂不建议激活。';

  checksEl.innerHTML = '';
  report.checks.forEach(check => {
    const item = document.createElement('div');
    item.className = 'health-check';
    const label = document.createElement('div');
    label.className = 'health-check-label';
    const dot = document.createElement('span');
    dot.className = `health-dot ${check.status === 'ok' ? 'health-ok' : check.status === 'bad' ? 'health-bad' : 'health-warn'}`;
    const text = document.createElement('span');
    text.textContent = check.label;
    const value = document.createElement('div');
    value.className = 'health-check-value';
    value.textContent = sanitizeDiagnosticText(check.detail);
    label.appendChild(dot);
    label.appendChild(text);
    item.appendChild(label);
    item.appendChild(value);
    checksEl.appendChild(item);
  });
}

function renderRuntimeInfo() {
  const summary = document.getElementById('runtimeSummary');
  const details = document.getElementById('runtimeDetails');
  if (!summary || !details || !runtime) return;
  const appStatus = runtime.getApplicationsAppStatus();
  summary.textContent = appStatus.exists
    ? (appStatus.isCurrent ? '当前从 /Applications 运行。' : '/Applications 存在一个 Clave 包。')
    : '未检测到 /Applications/Clave.app。';
  details.innerHTML = '';
  [
    ['当前包', runtime.appBundlePath || '未知'],
    ['Applications', appStatus.exists ? `${appStatus.path} · ${appStatus.modifiedAt ? formatDateTime(appStatus.modifiedAt) : '存在'}` : '未安装'],
    ['版本', appPackage.version || 'unknown']
  ].forEach(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'runtime-row';
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.textContent = value;
    row.appendChild(labelEl);
    row.appendChild(valueEl);
    details.appendChild(row);
  });
}

function openCurrentAppLocation() {
  if (!runtime || !runtime.showCurrentAppInFinder) return;
  runtime.showCurrentAppInFinder();
}

function deleteOldApplicationsApp() {
  if (!runtime || !runtime.deleteApplicationsApp) return;
  const status = runtime.getApplicationsAppStatus();
  if (!status.exists) {
    showAlert('/Applications 中没有旧 Clave 包。');
    renderRuntimeInfo();
    return;
  }
  if (status.isCurrent) {
    showAlert('当前正在从 /Applications 运行，不能删除自身。');
    return;
  }
  showConfirm('确定删除 /Applications/Clave.app 吗？这只会删除旧应用包，不会删除配置。', (confirmed) => {
    if (!confirmed) return;
    try {
      runtime.deleteApplicationsApp();
      renderRuntimeInfo();
      showAlert('已删除 /Applications/Clave.app。');
    } catch (error) {
      showAlert(`删除失败：${error.message || String(error)}`);
    }
  });
}

function syncCurrentAppToApplications() {
  if (!runtime || !runtime.installCurrentAppToApplications) return;
  showConfirm('确定把当前运行的 Clave 同步到 /Applications/Clave.app 吗？这会覆盖同名旧包。', (confirmed) => {
    if (!confirmed) return;
    try {
      runtime.installCurrentAppToApplications();
      renderRuntimeInfo();
      showAlert('已同步当前 Clave 到 /Applications。');
    } catch (error) {
      showAlert(`同步失败：${error.message || String(error)}`);
    }
  });
}

function applyProviderTemplate(templateId) {
  const template = getTemplateById(templateId);
  const config = parseJson(getJsonEditorValue()) || {};
  if (!config.env) config.env = {};
  if (!config.apiFormat) config.apiFormat = {};

  if (template.baseUrl) {
    config.env.ANTHROPIC_BASE_URL = template.baseUrl;
  }
  if (template.defaultModel) {
    config.apiFormat.providerModel = template.defaultModel;
    config.env.ANTHROPIC_MODEL = template.defaultModel;
    if (!config.model || !isClaudeCodeModel(config.model)) {
      config.model = template.defaultModel;
    }
  }

  const format = getFormatById(template.formatId);
  if (format) {
    config.apiFormat.id = format.id;
    config.apiFormat.name = format.name;
    config.apiFormat.endpoint = format.endpoint;
    config.apiFormat.authHeader = format.authHeader;
    config.apiFormat.authPrefix = format.authPrefix;
  }
  config.apiFormat.endpointMode = template.endpointMode || 'auto';
  config.apiFormat.providerTemplate = template.id;
  config.apiFormat.providerTemplateName = template.name;
  if (template.knownModels && template.knownModels.length > 0) {
    config.apiFormat.knownModels = template.knownModels.slice();
  } else {
    delete config.apiFormat.knownModels;
  }
  delete config.apiFormat.modelCompatibility;
  delete config.apiFormat.testResult;

  setJsonEditorValue(JSON.stringify(config, null, 2));
  cachedAvailableModels = modelRecordsFromIds(template.knownModels || [], template.name);
  syncFieldsFromJson();
  setJsonStatus(`已应用模板：${template.name}`, 'success');
  setModelHint(template.knownModels && template.knownModels.length > 0
    ? `已加载 ${template.knownModels.length} 个已知模型。`
    : '模板已应用，可手动输入模型或获取模型列表。',
  'warning');
}

function applySelectedProviderTemplate() {
  const select = document.getElementById('providerTemplate');
  if (!select) return;
  applyProviderTemplate(select.value);
}

function createSnapshotFromExisting(name, reason = '保存前快照', nextText = '') {
  try {
    if (!name || !fileExists(profilePath(name))) return null;
    const previousText = readText(profilePath(name));
    if (!previousText || previousText === nextText) return null;
    return historyApi.writeSnapshot(name, previousText, reason);
  } catch (error) {
    console.warn('createSnapshotFromExisting failed:', error);
    return null;
  }
}

function saveProfileFile(name, jsonText, options = {}) {
  ensureFolder(claudeRoot);
  if (options.snapshot !== false) {
    createSnapshotFromExisting(name, options.reason || '保存前快照', jsonText);
  }
  writeText(profilePath(name), jsonText);
  profileTextCache.set(name, jsonText);
  profileMetaCache.delete(name);
  cachedProfiles = null;
  refreshHistoryPanel();
}

function setHistorySelectOptions(options, selectedValue = '') {
  const menu = document.querySelector('.custom-select[data-target="historySelect"] .custom-select-menu');
  if (!menu) return;
  menu.innerHTML = '';
  options.forEach(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.value = item.value || '';
    button.textContent = item.label;
    if (item.disabled) button.disabled = true;
    menu.appendChild(button);
  });
  setCustomSelectValue('historySelect', selectedValue, { silent: true });
}

function saveManualSnapshot() {
  const selected = ensureSelection();
  if (!selected) return;

  const jsonText = getJsonEditorValue();
  if (!jsonText.trim()) {
    showAlert('当前 JSON 为空，无法保存快照。');
    return;
  }

  const { error } = parseJsonWithError(jsonText);
  if (error) {
    setJsonStatus(`JSON 无效：${error.message}`, 'error');
    showAlert('JSON 无效，请修正后再保存快照。');
    return;
  }

  try {
    const snapshot = historyApi.writeSnapshot(selected, jsonText, '手动快照');
    refreshHistoryPanel();
    if (snapshot && snapshot.id) {
      setCustomSelectValue('historySelect', snapshot.id, { silent: true });
    }
    showToast('已保存快照。');
  } catch (error) {
    showAlert(`保存快照失败：${error.message || String(error)}`);
  }
}

function refreshHistoryPanel() {
  const select = document.getElementById('historySelect');
  const summary = document.getElementById('historySummary');
  if (!select || !summary) return;

  if (!selectedProfile) {
    setHistorySelectOptions([{ value: '', label: '请先选择配置', disabled: true }], '');
    summary.textContent = '未选择配置。';
    return;
  }

  let snapshots = [];
  try {
    snapshots = historyApi.listSnapshots(selectedProfile);
  } catch (error) {
    summary.textContent = `读取历史失败：${error.message || String(error)}`;
    return;
  }

  if (snapshots.length === 0) {
    setHistorySelectOptions([{ value: '', label: '暂无快照', disabled: true }], '');
    summary.textContent = '点击“保存快照”可手动留档，覆盖保存前也会自动留档。';
    return;
  }

  const options = snapshots.map(snapshot => ({
    value: snapshot.id,
    label: `${formatDateTime(snapshot.createdAt)} · ${snapshot.reason || '保存前快照'}`
  }));
  const currentValue = snapshots.some(snapshot => snapshot.id === select.value)
    ? select.value
    : snapshots[0].id;
  setHistorySelectOptions(options, currentValue);
  summary.textContent = `已保存 ${snapshots.length} 个快照，最多保留 30 个。`;
}

function flattenJsonKeys(value, prefix = '', out = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    out[prefix || 'value'] = value;
    return out;
  }
  Object.keys(value).sort().forEach(key => {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    const child = value[key];
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      flattenJsonKeys(child, nextPrefix, out);
    } else {
      out[nextPrefix] = child;
    }
  });
  return out;
}

function buildJsonDiffRows(beforeText, afterText) {
  const before = parseJson(beforeText);
  const after = parseJson(afterText);
  if (!before || !after) {
    return [{
      keyPath: 'JSON',
      before: before ? '有效' : '无法解析',
      after: after ? '有效' : '无法解析'
    }];
  }
  const beforeFlat = flattenJsonKeys(before);
  const afterFlat = flattenJsonKeys(after);
  const keys = uniqueStrings([...Object.keys(beforeFlat), ...Object.keys(afterFlat)]).sort();
  return keys
    .filter(key => JSON.stringify(beforeFlat[key]) !== JSON.stringify(afterFlat[key]))
    .slice(0, 80)
    .map(key => ({
      keyPath: key,
      before: valueForPreview(beforeFlat[key], key),
      after: valueForPreview(afterFlat[key], key)
    }));
}

function showDiffDialog(titleText, rows) {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'dialog-card wide';
  const title = document.createElement('div');
  title.className = 'dialog-message';
  title.textContent = titleText;
  const list = document.createElement('div');
  list.className = 'preview-list';

  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'preview-row';
    empty.textContent = '没有可见差异。';
    list.appendChild(empty);
  } else {
    rows.forEach(row => {
      const item = document.createElement('div');
      item.className = 'preview-row';
      const label = document.createElement('div');
      label.className = 'preview-label';
      label.textContent = row.keyPath;
      const before = document.createElement('div');
      before.className = 'preview-value';
      before.textContent = `快照：${row.before}`;
      const after = document.createElement('div');
      after.className = 'preview-value preview-change';
      after.textContent = `当前：${row.after}`;
      item.appendChild(label);
      item.appendChild(before);
      item.appendChild(after);
      list.appendChild(item);
    });
  }

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
  overlay.onclick = event => { if (event.target === overlay) close(); };
  ok.focus();
}

function getSelectedHistorySnapshot() {
  const select = document.getElementById('historySelect');
  if (!select || !select.value) {
    showAlert('请选择一个历史快照。');
    return null;
  }
  try {
    return historyApi.readSnapshot(select.value);
  } catch (error) {
    showAlert(`读取快照失败：${error.message || String(error)}`);
    return null;
  }
}

function showSelectedHistoryDiff() {
  const snapshot = getSelectedHistorySnapshot();
  if (!snapshot) return;
  const rows = buildJsonDiffRows(snapshot.jsonText, getJsonEditorValue());
  showDiffDialog(`历史差异：${formatDateTime(snapshot.createdAt)}`, rows);
}

function restoreSelectedHistorySnapshot() {
  const snapshot = getSelectedHistorySnapshot();
  if (!snapshot) return;
  showConfirm(`确定恢复到 ${formatDateTime(snapshot.createdAt)} 的快照吗？当前编辑内容会先生成快照。`, (confirmed) => {
    if (!confirmed) return;
    try {
      if (selectedProfile && getJsonEditorValue().trim()) {
        historyApi.writeSnapshot(selectedProfile, getJsonEditorValue(), '恢复前快照');
      }
      setJsonEditorValue(jsonPrettyOrRaw(snapshot.jsonText));
      syncFieldsFromJson();
      validateJsonEditor();
      setJsonStatus('已恢复历史快照，点击保存以持久化', 'success');
      refreshHistoryPanel();
      showAlert('已恢复快照到编辑器。');
    } catch (error) {
      showAlert(`恢复失败：${error.message || String(error)}`);
    }
  });
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
  const report = buildHealthReport(parsed, profileName, activeProfile);
  const baseClass = report.status === 'ok' ? 'health-ok' : report.status === 'bad' ? 'health-bad' : 'health-warn';
  const activeClass = profileName === activeProfile ? ' health-active' : '';
  const blocking = report.checks.find(check => check.status === 'bad') || report.checks.find(check => check.status === 'warn');
  return {
    label: profileName === activeProfile ? `已激活 ${report.score}` : `健康 ${report.score}`,
    className: `${baseClass}${activeClass}`,
    title: blocking ? `${blocking.label}：${blocking.detail}` : '配置状态良好'
  };
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
    div.draggable = true;

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

    const scenarioName = getProfileScenarioName(profile);
    const scenarioSpan = document.createElement('span');
    scenarioSpan.className = 'profile-scenario';
    scenarioSpan.textContent = scenarioName;

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
    if (scenarioName) infoDiv.appendChild(scenarioSpan);
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

    div.addEventListener('dragstart', (e) => {
      if (!isProfileReorderAllowed()) {
        e.preventDefault();
        showAlert('请先清空搜索关键词，再拖动排序。');
        return;
      }
      draggingProfileName = profile;
      div.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', profile);
      }
    });

    div.addEventListener('dragover', (e) => {
      if (!draggingProfileName || draggingProfileName === profile) return;
      e.preventDefault();
      div.classList.add('drag-over');
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });

    div.addEventListener('dragleave', () => {
      div.classList.remove('drag-over');
    });

    div.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!draggingProfileName || draggingProfileName === profile) {
        clearDragState();
        return;
      }
      const moved = moveProfileOrder(draggingProfileName, profile);
      clearDragState();
      if (moved) {
        rebuildProfileList(activeProfile || getActiveProfile());
      }
    });

    div.addEventListener('dragend', () => {
      clearDragState();
    });

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
  setJsonEditorValue(fileExists(profilePath(selected))
    ? jsonPrettyOrRaw(readProfileText(selected))
    : getDefaultProfileTemplate());

  syncFieldsFromJson();
  updateProfileNameHint();
  validateJsonEditor();
  clearDiagnostics();
  refreshHistoryPanel();
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
  const jsonText = getJsonEditorValue();
  const parsed = validateJsonEditor();
  if (!parsed) {
    showAlert('JSON 格式无效，请先修正。');
    return;
  }

  ensureFolder(claudeRoot);
  const wasActive = previousName && getActiveProfile(true) === previousName;

  if (previousName && previousName !== name && fileExists(profilePath(previousName))) {
    const prevContent = readText(profilePath(previousName));
    const prevParsed = parseJson(prevContent);
    const curParsed = parseJson(jsonText);
    const sameIdentity = !!prevParsed && !!curParsed
      && (prevParsed.env && curParsed.env)
      && prevParsed.env.ANTHROPIC_BASE_URL === curParsed.env.ANTHROPIC_BASE_URL
      && prevParsed.env.ANTHROPIC_AUTH_TOKEN === curParsed.env.ANTHROPIC_AUTH_TOKEN;

    if (!sameIdentity) {
      showConfirm(
        `检测到 "${previousName}" 与当前编辑内容差异较大（Base URL 或 Token 不同）。\n\n确认重命名并删除旧文件吗？`,
        (confirmed) => {
          if (!confirmed) return;
          saveProfileFile(name, jsonText);
          fs.unlinkSync(profilePath(previousName));
          replaceProfileInStoredOrder(previousName, name);
          invalidateProfileCache(previousName);
          if (wasActive) {
            writeText(activeProfilePath, name);
            cachedActiveProfile = name;
          }
          selectedProfile = name;
          const title = document.getElementById('profileTitle');
          if (title) title.value = name;
          rebuildProfileList(name);
          currentLoadedProfile = name;
          syncStatus();
          showAlert(`已保存 ${name}`);
        }
      );
      return;
    }

    saveProfileFile(name, jsonText);
    fs.unlinkSync(profilePath(previousName));
    replaceProfileInStoredOrder(previousName, name);
    invalidateProfileCache(previousName);
    if (wasActive) {
      writeText(activeProfilePath, name);
      cachedActiveProfile = name;
    }
  } else {
    saveProfileFile(name, jsonText);
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
    setJsonEditorValue(getDefaultProfileTemplate());

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
  lastDiagnostics = null;
}

function showDiagnostics({ summary, items = [], type = 'error' }) {
  const panel = document.getElementById('diagnosticPanel');
  const summaryEl = document.getElementById('diagnosticSummary');
  const details = document.getElementById('diagnosticDetails');
  if (!panel || !summaryEl || !details) return;

  lastDiagnostics = {
    type,
    summary,
    items: items.map(item => ({
      label: item.label,
      value: sanitizeDiagnosticText(item.value)
    })),
    createdAt: new Date().toISOString()
  };

  panel.classList.remove('hidden');
  panel.classList.toggle('warning', type === 'warning');
  panel.classList.toggle('success', type === 'success');
  summaryEl.textContent = summary;
  summaryEl.classList.toggle('error', type === 'error');
  summaryEl.classList.toggle('warning', type === 'warning');
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

function buildDiagnosticsReport() {
  if (!lastDiagnostics) return '';
  const lines = [
    `Clave 诊断报告`,
    `时间：${formatDateTime(lastDiagnostics.createdAt)}`,
    `结果：${lastDiagnostics.summary}`,
    `类型：${lastDiagnostics.type}`,
    ''
  ];
  lastDiagnostics.items.forEach(item => {
    lines.push(`${item.label}：${item.value}`);
  });
  return lines.join('\n');
}

function copyDiagnosticsReport() {
  const report = buildDiagnosticsReport();
  if (!report) {
    showAlert('暂无诊断报告可复制。');
    return;
  }
  clipboard.writeText(report);
  showAlert('诊断报告已复制。');
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

function getActivationPrecheck(profileData) {
  const errors = [];
  const warnings = [];
  const env = (profileData && profileData.env) || {};
  const apiFormat = (profileData && profileData.apiFormat) || {};
  const model = getProviderModelFromConfig(profileData) || env.ANTHROPIC_MODEL || profileData.model || '';

  if (!env.ANTHROPIC_BASE_URL) errors.push('缺少 ANTHROPIC_BASE_URL。');
  if (!env.ANTHROPIC_AUTH_TOKEN) errors.push('缺少 ANTHROPIC_AUTH_TOKEN。');
  if (!model) warnings.push('未设置模型，Claude Code 可能使用默认模型。');
  if (apiFormat.modelCompatibility && apiFormat.modelCompatibility.compatible === false) {
    errors.push(`模型不兼容：${apiFormat.modelCompatibility.reason || '不支持 text 输出'}`);
  }
  if (!apiFormat.testResult || !apiFormat.testResult.success) {
    warnings.push('此配置未通过连接测试。');
  } else if (apiFormat.testedAt && daysSince(apiFormat.testedAt) > 7) {
    warnings.push('连接测试已超过 7 天，建议重新测试。');
  }
  if (apiFormat.modelListStatus && apiFormat.modelListStatus.state === 'unavailable') {
    warnings.push('服务未开放模型列表，将使用当前/手动模型。');
  }
  if (env.ANTHROPIC_BASE_URL && /\/(?:v1\/)?(?:messages|chat\/completions)$/i.test(env.ANTHROPIC_BASE_URL)
    && apiFormat.endpointMode !== 'direct') {
    warnings.push('Base URL 看起来包含完整端点，激活时会自动规范化为基础地址。');
  }

  return { errors, warnings };
}

function showPrecheckDiagnostics(errors, warnings) {
  const items = [
    ...errors.map((value, index) => ({ label: `阻断 ${index + 1}`, value })),
    ...warnings.map((value, index) => ({ label: `提醒 ${index + 1}`, value }))
  ];
  showDiagnostics({
    summary: errors.length > 0 ? '激活前检查未通过。' : '激活前检查有提醒。',
    items,
    type: errors.length > 0 ? 'error' : 'warning'
  });
}

function continueActivationAfterPrecheck(selected, jsonText, profileData) {
  showActivationPreview(selected, profileData, (accepted) => {
    if (accepted) performActivation(selected, jsonText, profileData);
  });
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
      setJsonEditorValue('');
      syncStatus();
    }
  });
}

function activateCurrent() {
  const selected = ensureSelection();
  if (!selected) return;

  try {
    syncJsonFromFields({ normalizeBaseUrl: true });
    const jsonText = getJsonEditorValue();
    const profileData = parseJson(jsonText);

    if (!profileData) {
      showAlert('JSON 格式无效，请先修正。');
      return;
    }

    const precheck = getActivationPrecheck(profileData);
    if (precheck.errors.length > 0) {
      showPrecheckDiagnostics(precheck.errors, precheck.warnings);
      showAlert(precheck.errors[0]);
      return;
    }

    if (precheck.warnings.length > 0) {
      showPrecheckDiagnostics([], precheck.warnings);
      showConfirm(
        `激活前有 ${precheck.warnings.length} 个提醒：\n\n${precheck.warnings.join('\n')}\n\n是否继续激活？`,
        (confirmed) => {
          if (confirmed) continueActivationAfterPrecheck(selected, jsonText, profileData);
        }
      );
      return;
    }

    continueActivationAfterPrecheck(selected, jsonText, profileData);

  } catch (err) {
    console.error('activateCurrent failed:', err);
    const msg = err && err.message ? err.message : String(err);
    showAlert(`激活失败：${msg}`);
  }
}

function performActivation(selected, jsonText, profileData) {
  // 保存 profile 文件
  createSnapshotFromExisting(selected, '激活前快照', jsonText);
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
  refreshHistoryPanel();
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

function resetProfileOrder() {
  const profiles = scanProfiles({ force: true });
  if (profiles.length <= 1) {
    showAlert('当前配置数量不足，无需重排。');
    return;
  }

  showConfirm('确定恢复默认排序（按名称）吗？', (confirmed) => {
    if (!confirmed) return;
    clearProfileOrder();
    cachedProfiles = null;
    clearDragState();
    rebuildProfileList(getActiveProfile(true));
    showAlert('已恢复默认排序。');
  });
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

async function exportProfilesToPath(profileNames, targetPath, options = {}) {
  const profiles = profileNames.map(name => getProfileRecordForExport(name, options));
  const extension = path.extname(targetPath).toLowerCase();

  if (profiles.length === 1 && extension === '.json') {
    exportApi.writeTextFile(targetPath, profiles[0].jsonText);
    return { kind: 'json', count: 1, targetPath };
  }

  const zipPath = ensureFileExtension(targetPath, 'zip');
  const manifest = buildProfileManifest(profiles);
  const zipProfiles = profiles.map(profile => {
    const manifestEntry = manifest.profiles.find(item => item.name === profile.name);
    return {
      file: manifestEntry.file,
      jsonText: profile.jsonText
    };
  });
  await exportApi.writeProfilesZip(zipPath, {
    fileName: EXPORT_MANIFEST_FILE,
    data: manifest
  }, zipProfiles);
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

  return [importApi.readJsonFile(filePath)];
}

async function readProfilesFromZipFile(filePath) {
  return importApi.readZipFile(filePath, EXPORT_MANIFEST_FILE);
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

          saveProfileFile(normalized.name, normalized.jsonText, { snapshot: false });
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
      .map(file => importApi.getPathForFile(file))
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

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function stripModelEndpoint(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(?:v1\/)?(?:chat\/completions|messages|models)$/i, '');
}

function getModelListUrls(baseUrl, endpointMode = 'auto') {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return [];

  const base = endpointMode === 'direct'
    ? stripModelEndpoint(raw)
    : stripModelEndpoint(normalizeClaudeCodeBaseUrl(raw, endpointMode));

  const urls = [];
  if (/\/(?:v1\/)?models$/i.test(raw)) urls.push(raw);
  if (base.endsWith('/v1')) {
    urls.push(`${base}/models`);
  } else {
    urls.push(`${base}/v1/models`);
    urls.push(`${base}/models`);
  }
  return uniqueStrings(urls);
}

function getModelListHeaderSets(apiKey, endpointMode = 'auto') {
  const bearerHeaders = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
  const anthropicHeaders = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json'
  };

  if (endpointMode === 'anthropic') return [anthropicHeaders, bearerHeaders];
  return [bearerHeaders, anthropicHeaders];
}

function normalizeModelInfo(item) {
  if (typeof item === 'string') {
    const id = item.trim();
    return id ? { id, raw: item } : null;
  }
  if (!item || typeof item !== 'object') return null;

  const id = item.id || item.name || item.model || item.model_id;
  if (!id) return null;
  return {
    id: String(id).trim(),
    name: item.display_name || item.name || String(id).trim(),
    owned_by: item.owned_by || item.owner || item.provider || '',
    output_modalities: Array.isArray(item.output_modalities) ? item.output_modalities : null,
    raw: item
  };
}

function extractModelsFromResponse(data) {
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    return [];
  }

  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.data)
      ? parsed.data
      : Array.isArray(parsed.models)
        ? parsed.models
        : Array.isArray(parsed.model_list)
          ? parsed.model_list
          : [];

  const seen = new Set();
  return list
    .map(normalizeModelInfo)
    .filter(model => {
      if (!model || !model.id || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    })
    .sort((a, b) => a.id.localeCompare(b.id, 'zh-Hans-CN', { sensitivity: 'base' }));
}

async function fetchAvailableModelList(baseUrl, apiKey, endpointMode = 'auto') {
  const urls = getModelListUrls(baseUrl, endpointMode);
  const headerSets = getModelListHeaderSets(apiKey, endpointMode);
  const attempts = [];
  const merged = [];
  const seen = new Set();

  for (const url of urls) {
    for (const headers of headerSets) {
      const result = await net.requestJson({
        url,
        method: 'GET',
        timeout: 12000,
        headers
      });
      attempts.push({
        url,
        statusCode: result.statusCode,
        success: result.success,
        error: result.error || ''
      });
      if (!result.success) continue;

      extractModelsFromResponse(result.data).forEach(model => {
        if (seen.has(model.id)) return;
        seen.add(model.id);
        merged.push(model);
      });

      if (merged.length > 0) {
        return { models: merged, attempts };
      }
    }
  }

  return { models: merged, attempts };
}

async function checkModelTextCompatibility(baseUrl, apiKey, model, endpointMode = 'auto') {
  const { models } = await fetchAvailableModelList(baseUrl, apiKey, endpointMode);
  if (!models || models.length === 0) return { known: false, compatible: true };

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
  const parsed = parseJson(getJsonEditorValue());
  if (!parsed) return 'claude-sonnet-4-6';

  if (parsed.apiFormat && parsed.apiFormat.providerModel) {
    const pm = String(parsed.apiFormat.providerModel).trim();
    if (pm) return pm;
  }

  if (parsed.env && parsed.env.ANTHROPIC_MODEL) {
    const envModel = String(parsed.env.ANTHROPIC_MODEL).trim();
    if (envModel) return envModel;
  }

  if (parsed.model) {
    const raw = String(parsed.model).trim();
    if (raw) {
      const aliasKey = raw.replace(/\[.*\]/, '');
      if (CLAUDE_CODE_MODEL_ALIASES.has(raw) || CLAUDE_CODE_MODEL_ALIASES.has(aliasKey)) {
        return 'claude-sonnet-4-6';
      }
      return raw;
    }
  }

  return 'claude-sonnet-4-6';
}

// ── 网络诊断：检测系统代理与推荐 NO_PROXY ──
const RFC1918_RANGES = [
  { start: ipToInt('10.0.0.0'), end: ipToInt('10.255.255.255'), cidr: '10.0.0.0/8' },
  { start: ipToInt('172.16.0.0'), end: ipToInt('172.31.255.255'), cidr: '172.16.0.0/12' },
  { start: ipToInt('192.168.0.0'), end: ipToInt('192.168.255.255'), cidr: '192.168.0.0/16' }
];

function ipToInt(ip) {
  const parts = String(ip || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (parts[0] << 24 | parts[1] << 16 | parts[2] << 8 | parts[3]) >>> 0;
}

function classifyHost(host) {
  if (!host) return { type: 'empty' };
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return { type: 'loopback' };
  const intVal = ipToInt(host);
  if (intVal === null) return { type: 'hostname', value: host };
  for (const range of RFC1918_RANGES) {
    if (intVal >= range.start && intVal <= range.end) return { type: 'private', ip: host, cidr: range.cidr };
  }
  return { type: 'public', ip: host };
}

function buildRecommendedNoProxy(baseUrl) {
  const parts = new Set(['localhost', '127.0.0.1']);
  try {
    const url = new URL(baseUrl);
    const host = url.hostname;
    const cls = classifyHost(host);
    if (cls.type === 'private') {
      parts.add(host);
      parts.add(cls.cidr);
    } else if (cls.type === 'hostname') {
      parts.add(host);
    }
  } catch (_) { /* ignore */ }
  return Array.from(parts).join(',');
}

async function runNetworkDiagnosis(baseUrl, apiKey, model, format, endpointMode) {
  const sys = typeof net.detectSystemProxy === 'function' ? net.detectSystemProxy() : { proxyEnv: {}, primary: null, noProxy: '' };
  const ifaces = typeof net.listLocalNetworkInterfaces === 'function' ? net.listLocalNetworkInterfaces() : [];
  const hostClass = (() => {
    try { return classifyHost(new URL(baseUrl).hostname); } catch (_) { return { type: 'invalid' }; }
  })();

  // 复用测试连接的完整请求（POST + 认证 + body），分别跑直连和经代理两路
  const directPromise = testApiFormat(baseUrl, apiKey, model, format, endpointMode, '');
  const proxyPromise = (sys.primary && !sys.primary.unsupported)
    ? testApiFormat(baseUrl, apiKey, model, format, endpointMode, sys.primary.raw)
    : Promise.resolve(null);

  const [direct, viaProxy] = await Promise.all([directPromise, proxyPromise]);

  // 判定口径与测试连接完全一致：2xx 算成功
  const directOk = direct && direct.statusCode >= 200 && direct.statusCode < 300;
  const proxyOk = viaProxy && viaProxy.statusCode >= 200 && viaProxy.statusCode < 300;

  let recommendation;
  if (hostClass.type === 'private' || hostClass.type === 'loopback') {
    recommendation = {
      strategy: 'bypass',
      reason: hostClass.type === 'private' ? `目标 ${hostClass.ip} 属于内网段 ${hostClass.cidr}，必须绕过本地代理直连` : '目标为本机回环地址',
      noProxy: buildRecommendedNoProxy(baseUrl),
      clearHttp: true
    };
  } else if (sys.primary && sys.primary.unsupported) {
    recommendation = {
      strategy: 'manual',
      reason: `检测到不支持的代理协议：${sys.primary.raw}`,
      noProxy: buildRecommendedNoProxy(baseUrl),
      clearHttp: false
    };
  } else if (sys.primary) {
    if (directOk && proxyOk) {
      recommendation = {
        strategy: 'bypass',
        reason: '两条路径都能完整调通 API，直连延迟更可控，建议绕过代理（写入 NO_PROXY，防止 Claude Code CLI 走代理）',
        noProxy: buildRecommendedNoProxy(baseUrl),
        clearHttp: false
      };
    } else if (directOk && !proxyOk) {
      recommendation = {
        strategy: 'bypass',
        reason: '直连能完整调通 API，经代理失败，必须绕过代理（Claude Code CLI 默认会读 HTTP_PROXY）',
        noProxy: buildRecommendedNoProxy(baseUrl),
        clearHttp: true
      };
    } else if (!directOk && proxyOk) {
      recommendation = {
        strategy: 'use-proxy',
        reason: '直连失败但经代理可达，必须通过代理访问',
        proxyUrl: sys.primary.raw,
        noProxy: sys.noProxy || '',
        clearHttp: false
      };
    } else {
      recommendation = {
        strategy: 'none-works',
        reason: '直连与代理均未能成功调通 API，请检查 API Key、网络连通性或上游服务状态',
        noProxy: buildRecommendedNoProxy(baseUrl),
        clearHttp: false
      };
    }
  } else {
    recommendation = {
      strategy: 'direct',
      reason: directOk ? '未检测到系统代理，直连可调通 API' : '未检测到系统代理，但直连失败',
      noProxy: '',
      clearHttp: false
    };
  }

  return {
    baseUrl,
    probeUrl: direct ? direct.url : baseUrl,
    hostClass,
    systemProxy: sys,
    interfaces: ifaces,
    direct,
    viaProxy,
    recommendation
  };
}

function formatProbeResult(r) {
  if (!r) return '未测试';
  if (r.statusCode > 0) return `HTTP ${r.statusCode} · ${r.elapsed}ms`;
  return `失败：${r.error || '未知错误'} · ${r.elapsed}ms`;
}

function strategyLabel(strategy) {
  switch (strategy) {
    case 'bypass': return '绕过代理直连';
    case 'use-proxy': return '通过代理访问';
    case 'direct': return '直连';
    case 'none-works': return '无可用路径';
    case 'manual': return '需手动处理';
    default: return strategy || '';
  }
}

function noProxyEntriesEqual(a, b) {
  const norm = (v) => new Set(String(v || '').split(',').map(s => s.trim()).filter(Boolean));
  const setA = norm(a);
  const setB = norm(b);
  if (setA.size !== setB.size) return false;
  for (const item of setA) if (!setB.has(item)) return false;
  return true;
}

function buildRecommendedEnvPatch(rec, currentEnv = {}) {
  const patch = { set: {}, unset: [] };
  if (!rec) return patch;
  const env = (currentEnv && typeof currentEnv === 'object') ? currentEnv : {};

  if (rec.clearHttp) {
    ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'].forEach(key => {
      if (Object.prototype.hasOwnProperty.call(env, key)) patch.unset.push(key);
    });
  }

  if (rec.strategy === 'use-proxy' && rec.proxyUrl) {
    if (env.HTTP_PROXY !== rec.proxyUrl) patch.set.HTTP_PROXY = rec.proxyUrl;
    if (env.HTTPS_PROXY !== rec.proxyUrl) patch.set.HTTPS_PROXY = rec.proxyUrl;
  }

  if (rec.noProxy) {
    if (!noProxyEntriesEqual(env.NO_PROXY, rec.noProxy)) patch.set.NO_PROXY = rec.noProxy;
    if (!noProxyEntriesEqual(env.no_proxy, rec.noProxy)) patch.set.no_proxy = rec.noProxy;
  }

  return patch;
}

function isPatchEmpty(patch) {
  if (!patch) return true;
  const hasSet = patch.set && Object.keys(patch.set).length > 0;
  const hasUnset = patch.unset && patch.unset.length > 0;
  return !hasSet && !hasUnset;
}

let lastAppliedNetworkPatch = null;

function applyNetworkPatchToJson(patch, strategy) {
  if (!patch) return false;
  const jsonText = getJsonEditorValue();
  const config = parseJson(jsonText);
  if (!config) {
    showAlert('当前 JSON 无效，无法应用推荐。');
    return false;
  }

  // 自动快照（永久可恢复的兜底）。reason 带策略标签，用户在历史面板能直接识别。
  let snapshotInfo = null;
  const profileForSnapshot = currentLoadedProfile || selectedProfile;
  if (profileForSnapshot && jsonText && jsonText.trim()) {
    const label = strategyLabel(strategy) || '未知策略';
    const reason = `网络诊断前·${label}·${new Date().toLocaleString('zh-CN', { hour12: false })}`.slice(0, 80);
    try {
      snapshotInfo = historyApi.writeSnapshot(profileForSnapshot, jsonText, reason);
      if (typeof refreshHistoryPanel === 'function') refreshHistoryPanel();
    } catch (err) {
      console.warn('网络诊断快照保存失败：', err);
    }
  }

  const envCreated = !config.env || typeof config.env !== 'object';
  if (envCreated) config.env = {};

  const touchedKeys = new Set([...(patch.unset || []), ...Object.keys(patch.set || {})]);
  const snapshot = {};
  touchedKeys.forEach(key => {
    snapshot[key] = Object.prototype.hasOwnProperty.call(config.env, key)
      ? { exists: true, value: config.env[key] }
      : { exists: false };
  });

  (patch.unset || []).forEach(key => { delete config.env[key]; });
  Object.entries(patch.set || {}).forEach(([key, value]) => { config.env[key] = value; });
  setJsonEditorValue(JSON.stringify(config, null, 2));
  if (typeof syncFieldsFromJson === 'function') syncFieldsFromJson();

  lastAppliedNetworkPatch = {
    snapshot,
    envCreated,
    touchedKeys: Array.from(touchedKeys),
    appliedAt: Date.now(),
    snapshotId: snapshotInfo ? snapshotInfo.id : null,
    snapshotReason: snapshotInfo ? snapshotInfo.reason : ''
  };

  const msg = snapshotInfo
    ? `已应用网络推荐，已保存快照「${snapshotInfo.reason}」。`
    : '已应用网络诊断推荐到当前配置。';
  showUndoBar(msg, undoLastNetworkPatch, 20000);
  return true;
}

function undoLastNetworkPatch() {
  const ctx = lastAppliedNetworkPatch;
  if (!ctx) {
    showAlert('没有可撤销的网络推荐。');
    return;
  }
  const config = parseJson(getJsonEditorValue());
  if (!config) {
    showAlert('当前 JSON 无效，无法撤销。');
    return;
  }
  if (!config.env || typeof config.env !== 'object') config.env = {};

  ctx.touchedKeys.forEach(key => {
    const prev = ctx.snapshot[key];
    if (!prev || !prev.exists) {
      delete config.env[key];
    } else {
      config.env[key] = prev.value;
    }
  });
  if (ctx.envCreated && Object.keys(config.env).length === 0) {
    delete config.env;
  }

  setJsonEditorValue(JSON.stringify(config, null, 2));
  if (typeof syncFieldsFromJson === 'function') syncFieldsFromJson();
  lastAppliedNetworkPatch = null;
  hideUndoBar();
  showAlert('已撤销网络诊断推荐。');
}

function hideUndoBar() {
  const existing = document.getElementById('undoBar');
  if (existing) existing.remove();
}

function showUndoBar(message, onUndo, ttlMs = 20000) {
  hideUndoBar();

  const bar = document.createElement('div');
  bar.id = 'undoBar';
  Object.assign(bar.style, {
    position: 'fixed',
    bottom: '24px',
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'var(--text-main)',
    color: 'white',
    padding: '10px 14px',
    borderRadius: '10px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    fontSize: '13px',
    zIndex: '9999',
    maxWidth: 'calc(100% - 48px)'
  });

  const text = document.createElement('span');
  text.textContent = message;
  text.style.flex = '1';

  const undoBtn = document.createElement('button');
  undoBtn.textContent = '撤销';
  Object.assign(undoBtn.style, {
    background: 'rgba(255,255,255,0.15)',
    border: '1px solid rgba(255,255,255,0.3)',
    color: 'white',
    padding: '4px 12px',
    borderRadius: '6px',
    fontSize: '12px',
    cursor: 'pointer'
  });

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', '关闭');
  Object.assign(closeBtn.style, {
    background: 'transparent',
    border: 'none',
    color: 'rgba(255,255,255,0.7)',
    fontSize: '18px',
    lineHeight: '1',
    cursor: 'pointer',
    padding: '0 4px'
  });

  const timer = setTimeout(() => hideUndoBar(), ttlMs);

  undoBtn.onclick = () => {
    clearTimeout(timer);
    if (typeof onUndo === 'function') onUndo();
  };
  closeBtn.onclick = () => {
    clearTimeout(timer);
    hideUndoBar();
  };

  bar.appendChild(text);
  bar.appendChild(undoBtn);
  bar.appendChild(closeBtn);
  document.body.appendChild(bar);
}

function renderDiagnosisDialog(diag) {
  const existing = document.getElementById('networkDiagnosisDialog');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'networkDiagnosisDialog';
  overlay.className = 'dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'dialog-card wide';
  dialog.style.maxWidth = '640px';

  const title = document.createElement('div');
  title.className = 'dialog-message';
  title.style.fontSize = '15px';
  title.style.fontWeight = '600';
  title.style.marginBottom = '12px';
  title.textContent = '网络诊断报告';
  dialog.appendChild(title);

  const sys = diag.systemProxy || {};
  const rec = diag.recommendation || {};
  const hostClass = diag.hostClass || {};
  const currentEnv = (parseJson(getJsonEditorValue()) || {}).env || {};
  const patch = buildRecommendedEnvPatch(rec, currentEnv);
  const patchEmpty = isPatchEmpty(patch);

  const section = (label, body) => {
    const wrap = document.createElement('div');
    wrap.style.marginBottom = '10px';
    const lbl = document.createElement('div');
    lbl.style.fontSize = '11px';
    lbl.style.color = 'var(--text-muted)';
    lbl.style.textTransform = 'uppercase';
    lbl.style.letterSpacing = '0.04em';
    lbl.style.marginBottom = '4px';
    lbl.textContent = label;
    const bd = document.createElement('div');
    bd.style.fontSize = '12px';
    bd.style.fontFamily = 'ui-monospace, monospace';
    bd.style.whiteSpace = 'pre-wrap';
    bd.style.wordBreak = 'break-all';
    bd.textContent = body;
    wrap.appendChild(lbl);
    wrap.appendChild(bd);
    return wrap;
  };

  const hostSummary = hostClass.type === 'private'
    ? `${hostClass.ip} · 内网 (${hostClass.cidr})`
    : hostClass.type === 'public'
    ? `${hostClass.ip} · 公网`
    : hostClass.type === 'hostname'
    ? `${hostClass.value} · 域名`
    : hostClass.type === 'loopback'
    ? '回环地址'
    : '无效或未填写';
  dialog.appendChild(section('API 目标', `${diag.baseUrl}\n${hostSummary}`));

  const proxySummary = sys.primary
    ? (sys.primary.unsupported ? `不支持的代理：${sys.primary.raw}` : `${sys.primary.protocol}//${sys.primary.host}:${sys.primary.port}${sys.primary.hasAuth ? ' (含认证)' : ''}`)
    : '未检测到';
  const envLines = Object.entries(sys.proxyEnv || {}).map(([k, v]) => `${k}=${v}`).join('\n') || '（无相关环境变量）';
  dialog.appendChild(section('系统代理', `${proxySummary}\n\n${envLines}`));

  dialog.appendChild(section('探测结果', `直连：${formatProbeResult(diag.direct)}\n经代理：${formatProbeResult(diag.viaProxy)}\n\n说明：诊断使用与「测试连接」完全一致的请求（POST + 认证 + 业务端点），分别通过直连和系统代理各发一次，判定口径为 HTTP 2xx。`));

  const recBox = document.createElement('div');
  recBox.style.background = 'rgba(212, 145, 110, 0.08)';
  recBox.style.border = '1px solid rgba(212, 145, 110, 0.3)';
  recBox.style.borderRadius = '8px';
  recBox.style.padding = '10px 12px';
  recBox.style.marginBottom = '12px';
  const recTitle = document.createElement('div');
  recTitle.style.fontSize = '12px';
  recTitle.style.fontWeight = '600';
  recTitle.style.marginBottom = '4px';
  recTitle.textContent = `建议策略：${strategyLabel(rec.strategy)}`;
  const recReason = document.createElement('div');
  recReason.style.fontSize = '12px';
  recReason.style.color = 'var(--text-muted)';
  recReason.style.marginBottom = '8px';
  recReason.textContent = rec.reason || '';
  recBox.appendChild(recTitle);
  recBox.appendChild(recReason);

  const patchLines = [];
  (patch.unset || []).forEach(k => patchLines.push(`- ${k}`));
  Object.entries(patch.set || {}).forEach(([k, v]) => patchLines.push(`+ ${k}=${v}`));
  if (patchEmpty) {
    const done = document.createElement('div');
    done.style.fontSize = '12px';
    done.style.color = 'var(--text-muted)';
    done.style.fontStyle = 'italic';
    done.textContent = '当前 env 已符合推荐策略，无需变更。';
    recBox.appendChild(done);
  } else if (patchLines.length > 0) {
    const pre = document.createElement('div');
    pre.style.fontFamily = 'ui-monospace, monospace';
    pre.style.fontSize = '11.5px';
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.wordBreak = 'break-all';
    pre.textContent = patchLines.join('\n');
    recBox.appendChild(pre);
  }
  dialog.appendChild(recBox);

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';

  const btnClose = document.createElement('button');
  btnClose.className = 'btn-action btn-secondary';
  btnClose.textContent = '关闭';
  btnClose.onclick = () => overlay.remove();

  const btnCopy = document.createElement('button');
  btnCopy.className = 'btn-action btn-secondary';
  btnCopy.textContent = '复制报告';
  btnCopy.onclick = () => {
    const text = [
      `API 目标: ${diag.baseUrl} (${hostSummary})`,
      `系统代理: ${proxySummary}`,
      `直连: ${formatProbeResult(diag.direct)}`,
      `经代理: ${formatProbeResult(diag.viaProxy)}`,
      `建议: ${strategyLabel(rec.strategy)} — ${rec.reason || ''}`,
      ...patchLines
    ].join('\n');
    clipboard.writeText(text);
    showAlert('诊断报告已复制到剪贴板。');
  };

  const btnApply = document.createElement('button');
  btnApply.className = 'btn-action btn-primary';
  btnApply.textContent = patchEmpty ? '已是最优配置' : '应用推荐到当前配置';
  btnApply.disabled = patchEmpty;
  btnApply.onclick = () => {
    if (applyNetworkPatchToJson(patch, rec.strategy)) overlay.remove();
  };

  actions.appendChild(btnClose);
  actions.appendChild(btnCopy);
  actions.appendChild(btnApply);
  dialog.appendChild(actions);

  overlay.appendChild(dialog);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

async function diagnoseNetwork() {
  const btn = document.getElementById('diagnoseBtn');
  if (btn) { btn.disabled = true; btn.innerText = '诊断中...'; }
  try {
    syncJsonFromFields();
    const config = parseJson(getJsonEditorValue()) || {};
    const env = config.env || {};
    const baseUrl = env.ANTHROPIC_BASE_URL || document.getElementById('baseUrl')?.value?.trim() || '';
    const apiKey = env.ANTHROPIC_AUTH_TOKEN || document.getElementById('apiKey')?.value?.trim() || '';
    if (!baseUrl) {
      showAlert('请先填写 ANTHROPIC_BASE_URL。');
      return;
    }
    if (!apiKey) {
      showAlert('请先填写 API 密钥，诊断需要与测试连接走完全一致的请求。');
      return;
    }

    const model = getModelFromConfig();
    const endpointMode = getCurrentEndpointMode();
    const formatId = config.apiFormat && config.apiFormat.id;
    const format = (formatId && getFormatById(formatId)) || sortFormatsByUrl(API_FORMATS, baseUrl)[0];
    if (!format) {
      showAlert('未找到可用的 API 格式，无法执行诊断。');
      return;
    }

    const diag = await runNetworkDiagnosis(baseUrl, apiKey, model, format, endpointMode);
    renderDiagnosisDialog(diag);
  } catch (err) {
    showAlert(`网络诊断失败：${err.message || String(err)}`);
  } finally {
    if (btn) { btn.disabled = false; btn.innerText = '网络诊断'; }
  }
}

async function testApiFormat(baseUrl, apiKey, model, format, endpointMode = 'auto', proxyUrl = '') {
  let finalUrl = baseUrl.replace(/\/$/, '');

  if (endpointMode === 'direct') {
    // 直连：Base URL 本身即完整端点，不追加任何路径
  } else if (endpointMode === 'anthropic') {
    if (!/\/v1\/messages$/i.test(finalUrl)) finalUrl = finalUrl + '/v1/messages';
  } else if (endpointMode === 'openai') {
    if (!/\/v1\/chat\/completions$/i.test(finalUrl)) finalUrl = finalUrl + '/v1/chat/completions';
  } else {
    // auto：检查是否已经包含常见端点
    const commonEndpoints = ['/v1/chat/completions', '/v1/messages', '/chat/completions', '/messages'];
    const hasEndpoint = commonEndpoints.some(ep => finalUrl.endsWith(ep));
    if (!hasEndpoint) finalUrl = finalUrl + format.endpoint;
  }

  const postData = JSON.stringify(format.requestBody(model));
  const headers = {
    'Content-Type': 'application/json'
  };

  // 设置认证头
  if (format.authPrefix) {
    headers[format.authHeader] = format.authPrefix + apiKey;
  } else {
    headers[format.authHeader] = apiKey;
  }

  // 添加额外的请求头
  Object.assign(headers, format.additionalHeaders);

  const result = await net.requestJson({
    url: finalUrl,
    method: 'POST',
    timeout: 30000,
    headers,
    body: postData,
    proxyUrl
  });
  const success = result.statusCode === 200;
  return {
    success,
    statusCode: result.statusCode,
    elapsed: result.elapsed,
    url: finalUrl,
    error: success ? null : (result.error || result.data || '请求失败')
  };
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

function setModelFetchLoading(isLoading) {
  const button = document.getElementById('fetchModelsBtn');
  const input = document.getElementById('modelSelect');
  const applyButton = document.getElementById('applyModelBtn');
  if (button) {
    button.disabled = isLoading;
    button.innerText = isLoading ? '获取中...' : '获取模型';
  }
  if (input) input.disabled = isLoading;
  if (applyButton) applyButton.disabled = isLoading;
}

function applySelectedModelToJson(modelId) {
  if (!modelId) return;
  const config = parseJson(getJsonEditorValue()) || {};
  if (!config.env) config.env = {};
  if (!config.apiFormat) config.apiFormat = {};

  config.apiFormat.providerModel = modelId;
  config.env.ANTHROPIC_MODEL = modelId;

  if (!config.model) {
    config.model = CLAUDE_CODE_FALLBACK_MODEL;
  } else if (!isClaudeCodeModel(config.model)) {
    config.model = modelId;
  }

  const metadata = cachedAvailableModels.find(model => model.id === modelId);
  if (metadata && Array.isArray(metadata.output_modalities)) {
    config.apiFormat.modelCompatibility = {
      known: true,
      compatible: metadata.output_modalities.includes('text'),
      reason: metadata.output_modalities.includes('text')
        ? undefined
        : `模型 ${modelId} 的输出模态是 ${metadata.output_modalities.join(', ')}，不是 Claude Code 需要的 text。`
    };
    if (!config.apiFormat.modelCompatibility.reason) {
      delete config.apiFormat.modelCompatibility.reason;
    }
  }

  rememberModelForProvider(config.env.ANTHROPIC_BASE_URL || '', modelId);
  setJsonEditorValue(JSON.stringify(config, null, 2));
  syncFieldsFromJson();
  setJsonStatus(`已写入模型：${modelId}`, 'success');
  setModelHint(`已选择模型：${modelId}`);
}

function applyModelInputToJson() {
  const input = document.getElementById('modelSelect');
  const modelId = input ? input.value.trim() : '';
  if (!modelId) {
    setModelHint('请先输入模型 ID。', 'error');
    showAlert('请先输入模型 ID。');
    return;
  }

  applySelectedModelToJson(modelId);
  renderModelOptions(cachedAvailableModels, modelId);
}

async function fetchModelsForCurrentConfig() {
  clearDiagnostics();
  const token = ++pendingModelListToken;
  normalizeBaseUrlField({ notify: true });
  syncJsonFromFields();

  const baseUrl = document.getElementById('baseUrl').value.trim();
  const apiKey = document.getElementById('apiKey').value.trim();
  const endpointMode = getCurrentEndpointMode();

  if (!baseUrl || !apiKey) {
    showAlert('请先填写基础地址和 API 密钥。');
    setModelHint('缺少 Base URL 或认证令牌。', 'error');
    return;
  }

  let preserveModelHint = false;
  try {
    setModelFetchLoading(true);
    setModelHint('正在获取模型列表...');
    const { models, attempts } = await fetchAvailableModelList(baseUrl, apiKey, endpointMode);
    if (token !== pendingModelListToken) return;

    cachedAvailableModels = models;
    const currentModel = getProviderModelFromConfig(parseJson(getJsonEditorValue()) || {});
    renderModelOptions(cachedAvailableModels, currentModel);

    if (models.length === 0) {
      const first = attempts.find(attempt => attempt.statusCode || attempt.error) || attempts[0];
      preserveModelHint = true;
      const listUnavailable = isModelListDiscoveryUnavailable(attempts);
      if (listUnavailable) {
        saveModelListStatusToConfig({
          state: 'unavailable',
          statusCode: first ? first.statusCode || 0 : 0,
          endpoint: first ? first.url : '',
          reason: '服务未开放模型列表接口'
        });
        showDiagnostics({
          summary: '该服务未开放模型列表接口。',
          items: [
            { label: '尝试端点', value: first ? first.url : '' },
            { label: 'HTTP 状态', value: first ? String(first.statusCode || 0) : '' },
            { label: '当前模型', value: currentModel || '未设置' },
            { label: '处理方式', value: currentModel ? '已保留当前模型，也可以手动输入模型 ID 后应用。' : '请手动输入模型 ID 后应用。' }
          ],
          type: 'warning'
        });
        setModelHint(
          currentModel
            ? '服务未开放模型列表，已保留当前模型；也可以手动输入模型 ID。'
            : '服务未开放模型列表，请手动输入模型 ID。',
          'warning'
        );
        showAlert(currentModel
          ? '该服务未开放模型列表，已保留当前模型。'
          : '该服务未开放模型列表，请手动输入模型 ID。');
        return;
      }
      saveModelListStatusToConfig({
        state: 'failed',
        statusCode: first ? first.statusCode || 0 : 0,
        endpoint: first ? first.url : '',
        reason: first ? (first.error || '模型列表为空或响应格式不支持') : '模型列表为空或响应格式不支持'
      });
      showDiagnostics({
        summary: '未能获取模型列表。',
        items: [
          { label: '尝试端点', value: first ? first.url : '' },
          { label: 'HTTP 状态', value: first ? String(first.statusCode || 0) : '' },
          { label: '错误摘要', value: first ? (first.error || '模型列表为空或响应格式不支持') : '模型列表为空或响应格式不支持' },
          { label: '建议', value: '确认该服务是否支持 /v1/models，或切换端点拼接模式后重试。' }
        ],
        type: 'error'
      });
      setModelHint('没有获取到可用模型。', 'error');
      showAlert('获取模型失败，已生成诊断。');
      return;
    }

    saveModelListStatusToConfig({
      state: 'available',
      count: models.length
    });
    setModelHint(`已获取 ${models.length} 个模型。`);
    showAlert(`已获取 ${models.length} 个模型。`);
  } catch (err) {
    preserveModelHint = true;
    console.error('fetchModelsForCurrentConfig failed:', err);
    setModelHint(`获取失败：${err.message || String(err)}`, 'error');
    showAlert(`获取模型失败：${err.message || String(err)}`);
  } finally {
    if (token === pendingModelListToken) {
      setModelFetchLoading(false);
      if (preserveModelHint) {
        const currentModel = getProviderModelFromConfig(parseJson(getJsonEditorValue()) || {});
        renderModelOptions(cachedAvailableModels, currentModel);
      } else {
        updateModelPickerFromConfig();
      }
    }
  }
}

function saveApiFormatToConfig(format, result, compatibility = null) {
  const jsonText = getJsonEditorValue();
  const config = parseJson(jsonText) || {};
  const previousApiFormat = config.apiFormat || {};

  config.apiFormat = {
    id: format.id,
    name: format.name,
    endpoint: format.endpoint,
    authHeader: format.authHeader,
    authPrefix: format.authPrefix,
    endpointMode: getCurrentEndpointMode(),
    testedAt: new Date().toISOString(),
    testResult: {
      success: result.success,
      statusCode: result.statusCode,
      elapsed: result.elapsed
    }
  };
  if (previousApiFormat.providerModel) {
    config.apiFormat.providerModel = previousApiFormat.providerModel;
    if (config.env && config.env.ANTHROPIC_BASE_URL) {
      rememberModelForProvider(config.env.ANTHROPIC_BASE_URL, previousApiFormat.providerModel);
    }
  }
  ['providerTemplate', 'providerTemplateName', 'knownModels', 'modelListStatus', 'scenarioTag', 'scenarioName'].forEach(key => {
    if (previousApiFormat[key] !== undefined) {
      config.apiFormat[key] = previousApiFormat[key];
    }
  });
  const currentTemplate = detectProviderTemplate(config);
  if (currentTemplate && currentTemplate.id !== 'custom') {
    config.apiFormat.providerTemplate = currentTemplate.id;
    config.apiFormat.providerTemplateName = currentTemplate.name;
  }
  if (compatibility) {
    config.apiFormat.modelCompatibility = compatibility;
  } else if (previousApiFormat.modelCompatibility) {
    config.apiFormat.modelCompatibility = previousApiFormat.modelCompatibility;
  }

  const updatedJson = JSON.stringify(config, null, 2);
  setJsonEditorValue(updatedJson);
  syncFieldsFromJson();

  setJsonStatus('测试结果已写入编辑器，点击"保存"按钮以持久化', 'success');
}

function saveModelCompatibilityToConfig(compatibility) {
  const jsonText = getJsonEditorValue();
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
  setJsonEditorValue(updatedJson);
  syncFieldsFromJson();

  setJsonStatus('兼容性检查结果已写入编辑器，点击"保存"按钮以持久化', compatibility.compatible ? 'success' : 'error');
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

  // 检查当前配置是否为空（只有默认模板，没有实际配置）
  const editorJson = parseJson(getJsonEditorValue());
  const hasRealConfig = editorJson && editorJson.env &&
    (editorJson.env.ANTHROPIC_BASE_URL || editorJson.env.ANTHROPIC_AUTH_TOKEN);

  // 如果配置为空且名称与选中配置不同，提示用户先保存
  if (!hasRealConfig && testingProfile && testingProfile !== currentLoadedProfile) {
    showAlert('当前编辑的配置与选中配置不同，请先保存配置后再测试。');
    return;
  }

  document.getElementById('footerHint').innerText = '状态：正在测试连接...';

  // 异步顺序测试
  (async () => {
    const model = getModelFromConfig();
    const endpointMode = getCurrentEndpointMode();
    const compatibility = await checkModelTextCompatibility(baseUrl, apiKey, model, endpointMode);
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
      const result = await testApiFormat(baseUrl, apiKey, model, format, endpointMode);
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
  setupCustomSelects();

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
  renderRuntimeInfo();
  refreshHistoryPanel();
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
    resetAvailableModels('连接信息已变化，请重新获取模型列表。');
    syncJsonFromFields();
  });
  baseUrlInput.addEventListener('blur', () => {
    normalizeBaseUrlField({ notify: true });
    resetAvailableModels('连接信息已变化，请重新获取模型列表。');
    syncJsonFromFields();
  });
  baseUrlInput.addEventListener('change', () => {
    normalizeBaseUrlField({ notify: true });
    resetAvailableModels('连接信息已变化，请重新获取模型列表。');
    syncJsonFromFields();
  });
  document.getElementById('apiKey').addEventListener('keyup', () => {
    resetAvailableModels('认证令牌已变化，请重新获取模型列表。');
    syncJsonFromFields();
  });
  const endpointModeSelect = document.getElementById('endpointMode');
  if (endpointModeSelect) {
    endpointModeSelect.addEventListener('change', () => {
      setBaseUrlHint();
      resetAvailableModels('端点模式已变化，请重新获取模型列表。');
      syncJsonFromFields();
    });
  }
  const providerTemplateSelect = document.getElementById('providerTemplate');
  if (providerTemplateSelect) {
    providerTemplateSelect.addEventListener('change', () => {
      updateProviderTemplateHint(getTemplateById(providerTemplateSelect.value));
    });
  }
  const modelSelect = document.getElementById('modelSelect');
  if (modelSelect) {
    modelSelect.addEventListener('change', () => {
      if (modelSelect.value.trim()) applyModelInputToJson();
    });
    modelSelect.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyModelInputToJson();
      }
    });
  }
  ['toggleThinking', 'effortLevel', 'permissionsMode', 'scenarioTag'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => syncJsonFromFields());
  });
  const jsonEditor = document.getElementById('profileJson');
  jsonEditor.addEventListener('input', () => {
    activeJsonBracketMatch = null;
    validateJsonEditor();
    syncFieldsFromJson();
  });
  jsonEditor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
    }
  });
  jsonEditor.addEventListener('mouseup', markMatchingJsonBracket);
  jsonEditor.addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
      markMatchingJsonBracket();
    }
  });
});
