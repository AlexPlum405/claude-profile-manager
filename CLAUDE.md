# Claude Profile Manager 开发指南

本项目是一个用于管理 Claude Code 配置的跨平台 Electron 应用。

## 🛠 开发指令

- **启动开发模式**: `npm start`
- **安装依赖**: `npm install`
- **构建 (Windows)**: `npm run build:win`
- **构建 (macOS)**: `npm run build:mac`
- **构建 (Linux)**: `npm run build:linux`

## 📋 编码规范

- **界面语言**: 所有用户界面文本、按钮标签、占位符、错误提示及菜单项必须使用**简体中文**。
- **UI 风格**: 保持原 HTA 版本的经典卡片布局，主色调为 `#d4916e`。
- **对话框**: 严禁使用原生 `alert()`, `confirm()`, `prompt()`。必须使用 `src/renderer.js` 中定义的自定义对话框函数。
- **配置处理**: 修改配置时应确保不对 `settings.json` 中非环境变量字段造成意外破坏。

## 🔧 环境注意事项

- **Electron 镜像**: 在网络受限环境下，请确保设置环境变量 `ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"`。
- **配置文件路径**:
    - Windows: `%USERPROFILE%\.claude\`
    - macOS/Linux: `~/.claude/`

## 📂 项目结构

- `src/main.js`: 主进程（窗口、菜单、生命周期）
- `src/renderer.js`: 渲染进程（业务逻辑、UI 交互、文件操作）
- `src/index.html`: UI 布局（原生 HTML）
- `src/styles.css`: 样式定义
- `assets/icons/`: 各平台应用图标
