# 架构说明

本文档描述了 Claude Profile Manager 的核心架构设计与关键实现细节。

## 1. 核心流程

应用基于 Electron 构建，分为主进程（Main Process）和渲染进程（Renderer Process）。

- **主进程 (`src/main.js`)**: 负责窗口生命周期管理、菜单栏中文化配置以及原生操作系统交互。
- **渲染进程 (`src/renderer.js`)**: 负责所有业务逻辑，包括：
    - 读取 `~/.claude/` 目录下的 JSON 配置文件。
    - 处理配置的 CRUD 操作。
    - 执行“激活”逻辑：备份当前 `settings.json`，并将选定配置智能合并。
    - UI 交互与数据绑定。

## 2. 关键技术实现

### 2.1 自定义对话框系统
由于 Electron 环境不支持浏览器的同步阻塞函数（`alert`, `confirm`, `prompt`），本项目在渲染进程中实现了一套自定义的异步模拟方案：

- **函数**: `showInputDialog` (输入), `showAlert` (提示), `showConfirm` (确认)。
- **视觉风格**: 采用应用统一的主题色 (#d4916e) 与卡片式布局。
- **交互特性**:
    - 全局单例：同一时间只显示一个对话框。
    - 遮罩层逻辑：支持点击遮罩关闭或通过键盘 Esc 退出。
    - 自动聚焦：对话框打开时自动聚焦到输入框或确定按钮。

### 2.2 智能配置合并
激活配置时，应用不会盲目覆盖整个 `settings.json`，而是采用补丁式更新。

- **逻辑**: 读取选定的 Profile JSON，仅更新 `settings.json` 中的环境变量和关键字段，保留用户在 Claude Code 中手动设置的其他个性化参数。

## 3. 文件系统规约

- **配置文件**: 遵循 `settings.<name>.json` 命名规则。
- **备份文件**: 保存在 `~/.claude/backups/` 或同级目录下，命名格式为 `settings.backup.YYYY-MM-DD-HH-mm-ss.json`。
- **当前激活标记**: 通过 `.active-profile` 文件记录当前正在使用的配置名称。
