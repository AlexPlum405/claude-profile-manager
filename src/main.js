const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');

// Aero UI relies on large translucent layers; keep GPU acceleration on by default.
if (process.env.CLAVE_DISABLE_HW_ACCELERATION === '1') {
  app.disableHardwareAcceleration();
}

// 单实例锁（防止多开）
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

function createWindow() {
  const isWindows = process.platform === 'win32';
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    frame: false,
    transparent: !isWindows,
    roundedCorners: true,
    thickFrame: isWindows,
    hasShadow: true,
    resizable: true,
    minWidth: 900,
    minHeight: 640,
    show: false, // 先隐藏，加载完再显示
    backgroundColor: isWindows ? '#F5F5F7' : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false
    },
    icon: path.join(__dirname, '../assets/icons/icon.png')
  });

  if (isWindows && typeof win.setBackgroundMaterial === 'function') {
    try {
      win.setBackgroundMaterial('mica');
    } catch {
      win.setBackgroundMaterial('auto');
    }
  }

  // 加载完成后显示窗口（避免白屏闪烁）
  win.once('ready-to-show', () => {
    win.show();
  });

  win.loadFile('src/index.html');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl !== win.webContents.getURL()) {
      event.preventDefault();
    }
  });

  // 页面加载完成后注入平台信息
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`
      document.documentElement.setAttribute('data-platform', '${process.platform}');
    `);
  });

  // 创建中文菜单
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '导入配置...',
          accelerator: 'CmdOrCtrl+O',
          click: () => { win.webContents.send('menu-import-profiles'); }
        },
        {
          label: '导出当前配置...',
          accelerator: 'CmdOrCtrl+E',
          click: () => { win.webContents.send('menu-export-current-profile'); }
        },
        {
          label: '批量导出 ZIP...',
          accelerator: 'Shift+CmdOrCtrl+E',
          click: () => { win.webContents.send('menu-export-all-profiles'); }
        },
        { type: 'separator' },
        {
          label: '刷新',
          accelerator: 'CmdOrCtrl+R',
          click: () => { win.reload(); }
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: 'CmdOrCtrl+Q',
          click: () => { app.quit(); }
        }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: '重做', accelerator: 'Shift+CmdOrCtrl+Z', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { label: '强制重新加载', accelerator: 'CmdOrCtrl+Shift+R', role: 'forceReload' },
        { label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', role: 'zoomIn' },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', accelerator: 'F11', role: 'togglefullscreen' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: '关于 Clave',
              message: 'Clave',
              detail: `版本: ${app.getVersion()}\n\nClaude Code 配置快速切换工具\n\n© 2026`
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // 开发模式下打开开发者工具
  // win.webContents.openDevTools();
}

// 窗口控制 IPC（全局只注册一次，按事件来源定位窗口）
ipcMain.on('window-minimize', (event) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target || target.isDestroyed()) return;
  target.minimize();
});

ipcMain.on('window-maximize', (event) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target || target.isDestroyed()) return;

  if (target.isMaximized()) {
    target.unmaximize();
  } else {
    target.maximize();
  }
});

ipcMain.on('window-close', (event) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target || target.isDestroyed()) return;
  target.close();
});

function windowFromEvent(event) {
  const target = BrowserWindow.fromWebContents(event.sender);
  return target && !target.isDestroyed() ? target : null;
}

ipcMain.handle('profiles-open-import-dialog', async (event) => {
  const target = windowFromEvent(event);
  const options = {
    title: '导入 Clave 配置',
    defaultPath: app.getPath('downloads'),
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Clave profiles', extensions: ['json', 'zip'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'ZIP', extensions: ['zip'] }
    ]
  };
  const result = target
    ? await dialog.showOpenDialog(target, options)
    : await dialog.showOpenDialog(options);

  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('profiles-save-export-dialog', async (event, options = {}) => {
  const target = windowFromEvent(event);
  const dialogOptions = {
    title: options.title || '导出 Clave 配置',
    defaultPath: options.defaultPath || path.join(app.getPath('downloads'), 'clave-profiles.zip'),
    filters: Array.isArray(options.filters) && options.filters.length > 0
      ? options.filters
      : [
          { name: 'ZIP', extensions: ['zip'] },
          { name: 'JSON', extensions: ['json'] }
        ]
  };
  const result = target
    ? await dialog.showSaveDialog(target, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions);

  return result.canceled ? '' : result.filePath;
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
