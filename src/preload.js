const { contextBridge, ipcRenderer, shell, webUtils, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const JSZip = require('jszip');
const appPackage = require('../package.json');

const homeDir = os.homedir();
const claudeRoot = path.join(homeDir, '.claude');
const activeSettingsPath = path.join(claudeRoot, 'settings.json');
const activeProfilePath = path.join(claudeRoot, '.active-profile');
const historyRoot = path.join(claudeRoot, '.clave-history');
const currentExecutablePath = process.execPath;
function resolveCurrentAppBundlePath() {
  const scriptDir = __dirname || '';
  if (scriptDir.includes('.app/Contents/Resources')) {
    return scriptDir.split('.app/Contents/Resources')[0] + '.app';
  }
  const resourcesPath = process.resourcesPath || '';
  if (resourcesPath.includes('.app/Contents/Resources')) {
    return resourcesPath.split('.app/Contents/Resources')[0] + '.app';
  }
  if (currentExecutablePath.includes('.app/Contents/MacOS/')) {
    return currentExecutablePath.split('.app/Contents/MacOS/')[0] + '.app';
  }
  return path.dirname(currentExecutablePath);
}
const currentAppBundlePath = resolveCurrentAppBundlePath();
const applicationsAppPath = '/Applications/Clave.app';

const MAX_IMPORT_JSON_BYTES = 1024 * 1024;
const MAX_IMPORT_ZIP_BYTES = 10 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 200;
const MAX_IMPORTED_PROFILES = 100;
const MAX_ZIP_JSON_ENTRY_BYTES = 1024 * 1024;
const MAX_ZIP_MANIFEST_BYTES = 256 * 1024;

const allowedImportPaths = new Set();
const allowedExportPaths = new Set();

function normalizePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  return path.resolve(filePath);
}

function isInside(parent, child) {
  const normalizedParent = normalizePath(parent);
  const normalizedChild = normalizePath(child);
  const relative = path.relative(normalizedParent, normalizedChild);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertInsideClaudeRoot(filePath) {
  if (!isInside(claudeRoot, filePath)) {
    throw new Error('文件操作被拒绝：路径不在 Claude 配置目录内。');
  }
}

function assertPrivateFile(filePath) {
  assertInsideClaudeRoot(filePath);
  const baseName = path.basename(filePath);
  const isSettings = /^settings(?:\..+)?\.json$/i.test(baseName);
  if (baseName !== '.active-profile' && !isSettings) {
    throw new Error('文件操作被拒绝：只允许访问 Clave 管理的配置文件。');
  }
}

function ensurePrivateMode(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
  } catch (error) {
    console.warn('ensurePrivateMode failed:', error);
  }
}

function assertSafeExistingPrivatePath(filePath) {
  if (!fs.existsSync(filePath)) return;
  const stats = fs.lstatSync(filePath);
  if (stats.isSymbolicLink()) {
    throw new Error('文件操作被拒绝：配置文件不能是符号链接。');
  }
  if (!stats.isFile()) {
    throw new Error('文件操作被拒绝：配置路径不是普通文件。');
  }
}

function ensureFolder(folderPath) {
  assertInsideClaudeRoot(folderPath);
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true, mode: 0o700 });
  }
}

function ensureHistoryFolder() {
  if (!fs.existsSync(historyRoot)) {
    fs.mkdirSync(historyRoot, { recursive: true, mode: 0o700 });
  }
}

function readPrivateText(filePath) {
  assertPrivateFile(filePath);
  if (!fs.existsSync(filePath)) return '';
  assertSafeExistingPrivatePath(filePath);
  ensurePrivateMode(filePath);
  return fs.readFileSync(filePath, 'utf-8');
}

function writePrivateText(filePath, text) {
  assertPrivateFile(filePath);
  ensureFolder(path.dirname(filePath));
  assertSafeExistingPrivatePath(filePath);
  if (fs.existsSync(filePath)) {
    try {
      fs.accessSync(filePath, fs.constants.W_OK);
    } catch (error) {
      ensurePrivateMode(filePath);
    }
  }
  fs.writeFileSync(filePath, text, { encoding: 'utf-8', mode: 0o600 });
  ensurePrivateMode(filePath);
}

function safeHistoryProfileName(profileName) {
  const normalized = String(profileName || '').trim();
  if (!normalized || /[/:*?"<>|\\]/.test(normalized) || normalized === '.' || normalized === '..') {
    throw new Error('历史快照被拒绝：配置名称无效。');
  }
  return normalized;
}

function historyFilePrefix(profileName) {
  return `${encodeURIComponent(safeHistoryProfileName(profileName))}__`;
}

function assertHistoryFileId(id) {
  const fileName = path.basename(String(id || ''));
  if (!/^[A-Za-z0-9%_.-]+__\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/.test(fileName)) {
    throw new Error('历史快照被拒绝：快照 ID 无效。');
  }
  const fullPath = path.join(historyRoot, fileName);
  if (!isInside(historyRoot, fullPath)) {
    throw new Error('历史快照被拒绝：路径无效。');
  }
  return { fileName, fullPath };
}

function writeHistorySnapshot(profileName, jsonText, reason = '保存前快照') {
  const name = safeHistoryProfileName(profileName);
  if (typeof jsonText !== 'string' || jsonText.trim() === '') return null;
  if (Buffer.byteLength(jsonText, 'utf-8') > MAX_IMPORT_JSON_BYTES) {
    throw new Error('历史快照过大，已拒绝写入。');
  }

  ensureHistoryFolder();
  const createdAt = new Date().toISOString();
  const timestamp = createdAt.replace(/[:.]/g, '-');
  const fileName = `${historyFilePrefix(name)}${timestamp}.json`;
  const fullPath = path.join(historyRoot, fileName);
  const payload = {
    app: 'Clave',
    version: appPackage.version || 'unknown',
    profileName: name,
    reason: String(reason || '保存前快照').slice(0, 80),
    createdAt,
    jsonText
  };

  fs.writeFileSync(fullPath, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 });
  ensurePrivateMode(fullPath);
  pruneHistorySnapshots(name, 30);
  return { id: fileName, profileName: name, reason: payload.reason, createdAt };
}

function readHistoryPayload(id) {
  const { fullPath } = assertHistoryFileId(id);
  if (!fs.existsSync(fullPath)) throw new Error('历史快照不存在。');
  const stats = fs.lstatSync(fullPath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('历史快照被拒绝：路径不是普通文件。');
  }
  ensurePrivateMode(fullPath);
  return JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
}

function listHistorySnapshots(profileName) {
  const name = safeHistoryProfileName(profileName);
  if (!fs.existsSync(historyRoot)) return [];
  const prefix = historyFilePrefix(name);
  return fs.readdirSync(historyRoot)
    .filter(fileName => fileName.startsWith(prefix) && fileName.endsWith('.json'))
    .map(fileName => {
      try {
        const payload = readHistoryPayload(fileName);
        return {
          id: fileName,
          profileName: payload.profileName || name,
          createdAt: payload.createdAt || '',
          reason: payload.reason || '保存前快照'
        };
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function pruneHistorySnapshots(profileName, keepCount) {
  const snapshots = listHistorySnapshots(profileName);
  snapshots.slice(keepCount).forEach(snapshot => {
    try {
      const { fullPath } = assertHistoryFileId(snapshot.id);
      fs.unlinkSync(fullPath);
    } catch (error) {
      console.warn('pruneHistorySnapshots failed:', error);
    }
  });
}

function readHistorySnapshot(id) {
  const payload = readHistoryPayload(id);
  return {
    id: path.basename(id),
    profileName: payload.profileName || '',
    reason: payload.reason || '',
    createdAt: payload.createdAt || '',
    jsonText: typeof payload.jsonText === 'string' ? payload.jsonText : ''
  };
}

function unlinkPrivate(filePath) {
  assertPrivateFile(filePath);
  assertSafeExistingPrivatePath(filePath);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function existsPrivate(filePath) {
  if (normalizePath(filePath) === normalizePath(claudeRoot)) {
    return fs.existsSync(filePath);
  }
  assertPrivateFile(filePath);
  try {
    assertSafeExistingPrivatePath(filePath);
  } catch (error) {
    console.warn('existsPrivate rejected path:', error);
    return false;
  }
  return fs.existsSync(filePath);
}

function readdirClaudeRoot(folderPath) {
  if (normalizePath(folderPath) !== normalizePath(claudeRoot)) {
    throw new Error('目录读取被拒绝：只允许读取 Claude 配置目录。');
  }
  if (!fs.existsSync(folderPath)) return [];
  return fs.readdirSync(folderPath);
}

function allowImportPath(filePath) {
  const normalized = normalizePath(filePath);
  if (normalized) allowedImportPaths.add(normalized);
  return normalized;
}

function allowExportPath(filePath) {
  const normalized = normalizePath(filePath);
  if (normalized) allowedExportPaths.add(normalized);
  return normalized;
}

function isAllowedImportPath(filePath) {
  return allowedImportPaths.has(normalizePath(filePath));
}

function isAllowedExportPath(filePath) {
  const normalized = normalizePath(filePath);
  if (allowedExportPaths.has(normalized)) return true;
  for (const allowedPath of allowedExportPaths) {
    if (!path.extname(allowedPath) && (normalized === `${allowedPath}.json` || normalized === `${allowedPath}.zip`)) {
      return true;
    }
  }
  return false;
}

function assertAllowedImport(filePath, extensions) {
  const normalized = normalizePath(filePath);
  if (!isAllowedImportPath(normalized)) {
    throw new Error('导入被拒绝：请通过导入对话框或拖放选择文件。');
  }
  const extension = path.extname(normalized).toLowerCase();
  if (!extensions.includes(extension)) {
    throw new Error('导入被拒绝：文件类型不支持。');
  }
  return normalized;
}

function assertAllowedExport(filePath) {
  const normalized = normalizePath(filePath);
  if (!isAllowedExportPath(normalized)) {
    throw new Error('导出被拒绝：请先通过导出对话框选择目标文件。');
  }
  return normalized;
}

function assertFileSize(filePath, maxBytes, label) {
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) throw new Error(`${label} 不是普通文件。`);
  if (stats.size > maxBytes) {
    throw new Error(`${label} 过大，最大支持 ${Math.round(maxBytes / 1024 / 1024)}MB。`);
  }
  return stats;
}

function readImportJsonFile(filePath) {
  const normalized = assertAllowedImport(filePath, ['.json']);
  assertFileSize(normalized, MAX_IMPORT_JSON_BYTES, 'JSON 文件');
  return {
    name: profileNameFromJsonFile(normalized),
    source: path.basename(normalized),
    jsonText: fs.readFileSync(normalized, 'utf-8')
  };
}

function getZipEntrySize(entry) {
  return entry && entry._data && Number.isFinite(entry._data.uncompressedSize)
    ? entry._data.uncompressedSize
    : null;
}

function assertZipEntrySize(entry, maxBytes, label) {
  const knownSize = getZipEntrySize(entry);
  if (knownSize !== null && knownSize > maxBytes) {
    throw new Error(`${label} 过大，最大支持 ${Math.round(maxBytes / 1024)}KB。`);
  }
}

async function readZipEntryText(entry, maxBytes, label) {
  assertZipEntrySize(entry, maxBytes, label);
  const text = await entry.async('string');
  if (Buffer.byteLength(text, 'utf-8') > maxBytes) {
    throw new Error(`${label} 过大，最大支持 ${Math.round(maxBytes / 1024)}KB。`);
  }
  return text;
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

async function readImportZipFile(filePath, manifestFileName) {
  const normalized = assertAllowedImport(filePath, ['.zip']);
  assertFileSize(normalized, MAX_IMPORT_ZIP_BYTES, 'ZIP 文件');

  const zip = await JSZip.loadAsync(fs.readFileSync(normalized));
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`ZIP 内文件过多，最多支持 ${MAX_ZIP_ENTRIES} 个条目。`);
  }

  const records = [];
  const archiveName = path.basename(normalized);
  const manifestFile = zip.file(manifestFileName);

  if (manifestFile) {
    const manifestText = await readZipEntryText(manifestFile, MAX_ZIP_MANIFEST_BYTES, '导入清单');
    let manifest = null;
    try {
      manifest = JSON.parse(manifestText);
    } catch (error) {
      manifest = null;
    }

    if (manifest && Array.isArray(manifest.profiles)) {
      if (manifest.profiles.length > MAX_IMPORTED_PROFILES) {
        throw new Error(`导入配置过多，最多支持 ${MAX_IMPORTED_PROFILES} 个。`);
      }

      for (const profile of manifest.profiles) {
        if (!profile || !profile.file) continue;
        const entry = zip.file(profile.file);
        if (!entry || entry.dir) continue;
        records.push({
          name: profile.name || profileNameFromZipEntry(profile.file),
          source: `${archiveName}:${profile.file}`,
          jsonText: await readZipEntryText(entry, MAX_ZIP_JSON_ENTRY_BYTES, '配置 JSON')
        });
      }
    }
  }

  if (records.length > 0) return records;

  const jsonEntries = entries
    .filter(entry => !entry.dir && /\.json$/i.test(entry.name) && entry.name !== manifestFileName)
    .slice(0, MAX_IMPORTED_PROFILES);

  for (const entry of jsonEntries) {
    records.push({
      name: profileNameFromZipEntry(entry.name),
      source: `${archiveName}:${entry.name}`,
      jsonText: await readZipEntryText(entry, MAX_ZIP_JSON_ENTRY_BYTES, '配置 JSON')
    });
  }

  if (entries.filter(entry => !entry.dir && /\.json$/i.test(entry.name)).length > MAX_IMPORTED_PROFILES) {
    throw new Error(`导入配置过多，最多支持 ${MAX_IMPORTED_PROFILES} 个。`);
  }

  return records;
}

function writeExportText(filePath, text) {
  const normalized = assertAllowedExport(filePath);
  fs.writeFileSync(normalized, text, { encoding: 'utf-8', mode: 0o600 });
  ensurePrivateMode(normalized);
}

async function writeExportProfilesZip(filePath, manifest, profiles) {
  const normalized = assertAllowedExport(filePath);
  const zip = new JSZip();
  zip.file(manifest.fileName, JSON.stringify(manifest.data, null, 2));
  profiles.forEach(profile => {
    zip.file(profile.file, profile.jsonText);
  });
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });
  fs.writeFileSync(normalized, buffer, { mode: 0o600 });
  ensurePrivateMode(normalized);
}

function requestJson({ url, method = 'GET', headers = {}, body = '', timeout = 30000 }) {
  return new Promise((resolve) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('只支持 HTTP/HTTPS 地址。');
      }
    } catch (error) {
      resolve({ success: false, statusCode: 0, elapsed: 0, url, error: error.message });
      return;
    }

    const client = parsedUrl.protocol === 'https:' ? https : http;
    const requestHeaders = Object.assign({}, headers);
    if (body && !requestHeaders['Content-Length']) {
      requestHeaders['Content-Length'] = Buffer.byteLength(body);
    }

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method,
      timeout,
      headers: requestHeaders
    };

    const startTime = Date.now();
    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          success: res.statusCode >= 200 && res.statusCode < 300,
          statusCode: res.statusCode,
          elapsed: Date.now() - startTime,
          url,
          data,
          error: res.statusCode >= 200 && res.statusCode < 300 ? null : data
        });
      });
    });

    req.on('error', (error) => {
      resolve({
        success: false,
        statusCode: 0,
        elapsed: Date.now() - startTime,
        url,
        error: error.message
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        success: false,
        statusCode: 0,
        elapsed: Date.now() - startTime,
        url,
        error: '连接超时'
      });
    });

    if (body) req.write(body);
    req.end();
  });
}

function getPathForFile(file) {
  if (!file) return '';
  const filePath = webUtils && typeof webUtils.getPathForFile === 'function'
    ? webUtils.getPathForFile(file)
    : file.path;
  if (filePath) allowImportPath(filePath);
  return filePath || '';
}

function getApplicationsAppStatus() {
  const exists = fs.existsSync(applicationsAppPath);
  let modifiedAt = '';
  if (exists) {
    try {
      modifiedAt = fs.statSync(applicationsAppPath).mtime.toISOString();
    } catch (error) {
      modifiedAt = '';
    }
  }
  return {
    path: applicationsAppPath,
    exists,
    modifiedAt,
    isCurrent: normalizePath(applicationsAppPath) === normalizePath(currentAppBundlePath)
  };
}

function deleteApplicationsApp() {
  if (normalizePath(applicationsAppPath) === normalizePath(currentAppBundlePath)) {
    throw new Error('当前正在从 /Applications 运行，不能删除自身。');
  }
  if (!fs.existsSync(applicationsAppPath)) {
    return getApplicationsAppStatus();
  }
  fs.rmSync(applicationsAppPath, { recursive: true, force: true });
  return getApplicationsAppStatus();
}

function installCurrentAppToApplications() {
  if (!fs.existsSync(currentAppBundlePath) || !currentAppBundlePath.endsWith('.app')) {
    throw new Error('当前运行包不是标准 .app，无法同步到 /Applications。');
  }
  if (normalizePath(applicationsAppPath) === normalizePath(currentAppBundlePath)) {
    return getApplicationsAppStatus();
  }
  if (fs.existsSync(applicationsAppPath)) {
    fs.rmSync(applicationsAppPath, { recursive: true, force: true });
  }
  fs.cpSync(currentAppBundlePath, applicationsAppPath, { recursive: true });
  return getApplicationsAppStatus();
}

function invoke(channel, ...args) {
  const allowedInvokeChannels = new Set([
    'profiles-open-import-dialog',
    'profiles-save-export-dialog'
  ]);
  if (!allowedInvokeChannels.has(channel)) {
    return Promise.reject(new Error('IPC 调用被拒绝。'));
  }

  return ipcRenderer.invoke(channel, ...args).then((result) => {
    if (channel === 'profiles-open-import-dialog' && Array.isArray(result)) {
      result.forEach(allowImportPath);
    }
    if (channel === 'profiles-save-export-dialog' && typeof result === 'string' && result) {
      allowExportPath(result);
    }
    return result;
  });
}

function send(channel, ...args) {
  const allowedSendChannels = new Set([
    'window-minimize',
    'window-maximize',
    'window-close'
  ]);
  if (!allowedSendChannels.has(channel)) {
    throw new Error('IPC 消息被拒绝。');
  }
  ipcRenderer.send(channel, ...args);
}

function on(channel, callback) {
  const allowedIncomingChannels = new Set([
    'menu-import-profiles',
    'menu-export-current-profile',
    'menu-export-all-profiles'
  ]);
  if (!allowedIncomingChannels.has(channel) || typeof callback !== 'function') {
    throw new Error('IPC 监听被拒绝。');
  }
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('claveApi', {
  appPackage: { version: appPackage.version || 'unknown' },
  paths: {
    homeDir,
    claudeRoot,
    activeSettingsPath,
    activeProfilePath,
    historyRoot
  },
  path: {
    basename: (...args) => path.basename(...args),
    dirname: (...args) => path.dirname(...args),
    extname: (...args) => path.extname(...args),
    join: (...args) => path.join(...args)
  },
  fs: {
    constants: { W_OK: fs.constants.W_OK },
    existsSync: existsPrivate,
    mkdirSync: ensureFolder,
    readFileSync: readPrivateText,
    writeFileSync: writePrivateText,
    unlinkSync: unlinkPrivate,
    readdirSync: readdirClaudeRoot,
    chmodSync: (filePath) => {
      assertPrivateFile(filePath);
      ensurePrivateMode(filePath);
    },
    accessSync: (filePath) => {
      assertPrivateFile(filePath);
      fs.accessSync(filePath, fs.constants.W_OK);
    }
  },
  imports: {
    readJsonFile: readImportJsonFile,
    readZipFile: readImportZipFile,
    getPathForFile
  },
  exports: {
    writeTextFile: writeExportText,
    writeProfilesZip: writeExportProfilesZip
  },
  history: {
    writeSnapshot: writeHistorySnapshot,
    listSnapshots: listHistorySnapshots,
    readSnapshot: readHistorySnapshot
  },
  clipboard: {
    writeText: (text) => clipboard.writeText(String(text || ''))
  },
  runtime: {
    executablePath: currentExecutablePath,
    appBundlePath: currentAppBundlePath,
    resourcesPath: process.resourcesPath || '',
    applicationsAppPath,
    getApplicationsAppStatus,
    deleteApplicationsApp,
    installCurrentAppToApplications,
    showCurrentAppInFinder: () => shell.showItemInFolder(currentAppBundlePath)
  },
  shell: {
    openPath: (targetPath) => {
      if (normalizePath(targetPath) !== normalizePath(claudeRoot)) {
        return Promise.reject(new Error('只能打开 Claude 配置目录。'));
      }
      return shell.openPath(targetPath);
    }
  },
  ipcRenderer: { invoke, send, on },
  net: { requestJson }
});
