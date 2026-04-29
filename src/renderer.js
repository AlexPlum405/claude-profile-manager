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
      item.classList.add('active');
    } else {
      item.classList.remove('active');
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

    div.appendChild(nameSpan);
    div.appendChild(metaSpan);

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

function showInputDialog(message, defaultValue, callback) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:white;padding:20px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.3);min-width:300px;';

  const label = document.createElement('div');
  label.textContent = message;
  label.style.cssText = 'margin-bottom:15px;font-size:14px;color:#333;';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = defaultValue || '';
  input.style.cssText = 'width:100%;padding:8px;font-size:14px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;margin-bottom:15px;';

  const btnContainer = document.createElement('div');
  btnContainer.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;';

  const btnCancel = document.createElement('button');
  btnCancel.textContent = '取消';
  btnCancel.style.cssText = 'padding:8px 20px;background:#999;color:white;border:none;border-radius:4px;cursor:pointer;';

  const btnOk = document.createElement('button');
  btnOk.textContent = '确定';
  btnOk.style.cssText = 'padding:8px 20px;background:#d4916e;color:white;border:none;border-radius:4px;cursor:pointer;';

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
    document.body.removeChild(overlay);
    callback(value);
  };

  btnOk.onclick = () => close(input.value);
  btnCancel.onclick = () => close(null);
  input.onkeydown = (e) => {
    if (e.key === 'Enter') close(input.value);
    if (e.key === 'Escape') close(null);
  };
}

function showAlert(message, callback) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:white;padding:20px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.3);min-width:300px;max-width:500px;';

  const message_div = document.createElement('div');
  message_div.textContent = message;
  message_div.style.cssText = 'margin-bottom:20px;font-size:14px;color:#333;line-height:1.5;';

  const btnContainer = document.createElement('div');
  btnContainer.style.cssText = 'display:flex;justify-content:flex-end;';

  const btnOk = document.createElement('button');
  btnOk.textContent = '确定';
  btnOk.style.cssText = 'padding:8px 20px;background:#d4916e;color:white;border:none;border-radius:4px;cursor:pointer;';

  btnContainer.appendChild(btnOk);

  dialog.appendChild(message_div);
  dialog.appendChild(btnContainer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  btnOk.focus();

  const close = () => {
    document.body.removeChild(overlay);
    if (callback) callback();
  };

  btnOk.onclick = close;
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
  document.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      close();
      document.onkeydown = null;
    }
  };
}

function showConfirm(message, callback) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:white;padding:20px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.3);min-width:300px;max-width:500px;';

  const message_div = document.createElement('div');
  message_div.textContent = message;
  message_div.style.cssText = 'margin-bottom:20px;font-size:14px;color:#333;line-height:1.5;';

  const btnContainer = document.createElement('div');
  btnContainer.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;';

  const btnCancel = document.createElement('button');
  btnCancel.textContent = '取消';
  btnCancel.style.cssText = 'padding:8px 20px;background:#999;color:white;border:none;border-radius:4px;cursor:pointer;';

  const btnOk = document.createElement('button');
  btnOk.textContent = '确定';
  btnOk.style.cssText = 'padding:8px 20px;background:#d4916e;color:white;border:none;border-radius:4px;cursor:pointer;';

  btnContainer.appendChild(btnCancel);
  btnContainer.appendChild(btnOk);

  dialog.appendChild(message_div);
  dialog.appendChild(btnContainer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  btnOk.focus();

  const close = (result) => {
    document.body.removeChild(overlay);
    document.onkeydown = null;
    callback(result);
  };

  btnOk.onclick = () => close(true);
  btnCancel.onclick = () => close(false);
  overlay.onclick = (e) => {
    if (e.target === overlay) close(false);
  };
  document.onkeydown = (e) => {
    if (e.key === 'Enter') close(true);
    if (e.key === 'Escape') close(false);
  };
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

    // 保存 profile 文件
    writeText(profilePath(selected), jsonText);

    // 合并到 settings.json
    const existingSettings = parseJson(readText(activeSettingsPath)) || {};

    const mergeKeys = ['env', 'model', 'effortLevel', 'includeCoAuthoredBy',
                       'skipDangerousModePermissionPrompt', 'permissions',
                       'enabledPlugins', 'extraKnownMarketplaces'];

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
  } catch (err) {
    console.error('activateCurrent failed:', err);
    const msg = err && err.message ? err.message : String(err);
    showAlert(`激活失败：${msg}`);
  }
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

function testCurrent() {
  const baseUrl = document.getElementById('baseUrl').value.trim();
  const apiKey = document.getElementById('apiKey').value.trim();

  if (!baseUrl || !apiKey) {
    showAlert('请先填写基础地址和 API 密钥。');
    return;
  }

  // 从 JSON 中读取模型名（如有）
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

  const TIMEOUT = 30;
  showTestProgress(TIMEOUT);
  document.getElementById('footerHint').innerText = '状态：正在测试连接...';

  const url = baseUrl.replace(/\/$/, '') + '/v1/messages';
  const https = require('https');
  const http = require('http');
  const { URL } = require('url');

  const parsedUrl = new URL(url);
  const client = parsedUrl.protocol === 'https:' ? https : http;

  const postData = JSON.stringify({
    model: model,
    max_tokens: 10,
    messages: [{ role: 'user', content: 'Hi' }]
  });

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.pathname,
    method: 'POST',
    timeout: TIMEOUT * 1000,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const startTime = Date.now();
  const restoreStatus = () => {
    document.getElementById('footerHint').innerText = `状态：已激活 ${getActiveProfile() || 'unknown'}`;
  };

  const req = client.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      hideTestProgress();
      const elapsed = Date.now() - startTime;
      if (res.statusCode === 200) {
        restoreStatus();
        showAlert(`连接成功！\n\n模型: ${model}\n响应时间: ${elapsed}ms\n状态码: ${res.statusCode}`);
      } else {
        let errMsg = `状态码: ${res.statusCode}`;
        try {
          const errBody = JSON.parse(data);
          if (errBody.error && errBody.error.message) {
            errMsg += `\n错误: ${errBody.error.message}`;
          }
        } catch (e) {}
        restoreStatus();
        showAlert(`连接失败\n\n模型: ${model}\n${errMsg}\n响应时间: ${elapsed}ms`);
      }
    });
  });

  req.on('error', (err) => {
    hideTestProgress();
    restoreStatus();
    showAlert(`连接失败\n\n错误: ${err.message}`);
  });

  req.on('timeout', () => {
    req.destroy();
    hideTestProgress();
    restoreStatus();
    showAlert(`连接超时（${TIMEOUT}秒）`);
  });

  req.write(postData);
  req.end();
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
