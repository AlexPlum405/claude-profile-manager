# 安装与故障排查

本文档详细介绍了如何安装开发环境以及如何解决常见的 Electron 安装问题。

## 1. 标准安装流程

```bash
# 克隆仓库并进入目录
cd claude-profile-manager

# 安装依赖
npm install

# 启动应用
npm start
```

## 2. 解决 Electron 安装失败

如果遇到 "Electron failed to install correctly" 或下载卡住的问题，请尝试以下方法：

### 方法 1: 使用国内镜像（推荐）

这是解决网络问题的最有效方法。

```bash
# 设置 Electron 镜像源
npm config set electron_mirror https://npmmirror.com/mirrors/electron/

# 删除并重新安装
rm -rf node_modules package-lock.json
npm install
```

### 方法 2: 清理 npm 缓存

```bash
npm cache clean --force
npm install
```

### 方法 3: 使用 cnpm

```bash
npm install -g cnpm --registry=https://registry.npmmirror.com
cnpm install
```

### 方法 4: 使用系统已有的 Electron

如果你的系统已全局安装了 Electron，可以直接运行：

```bash
electron .
```

## 3. 验证安装

安装完成后，你可以通过以下命令检查 Electron 核心文件是否存在：

- **Windows**: `ls node_modules/electron/dist/electron.exe`
- **macOS**: `ls node_modules/electron/dist/Electron.app`

## 4. 构建指南

构建不同平台的安装包：

- **Windows**: `npm run build:win` (产物在 `dist/win-unpacked` 和 `.exe`)
- **macOS**: `npm run build:mac` (产物在 `dist/mac`)
- **Linux**: `npm run build:linux` (产物在 `dist/`)
