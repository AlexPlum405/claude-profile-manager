# Claude Profile Manager

Claude Code 配置管理器 - 跨平台桌面应用。

本项目旨在为 Claude Code 用户提供一个可视化、易用的界面来管理、切换和备份不同的 API 配置文件。

## ✨ 功能特性

- ✅ **可视化管理**: 直观地创建、编辑和删除配置文件。
- ✅ **快速切换**: 一键激活不同的 API 配置（如 en01, iflytek, minimax 等）。
- ✅ **智能合并**: 仅更新关键字段，不覆盖用户在 Claude Code 中手动设置的其他设置。
- ✅ **自动备份**: 在激活新配置前，自动对原 `settings.json` 进行带时间戳的备份。
- ✅ **配置验证**: 内置必需字段检查，防止错误配置。
- ✅ **完全中文化**: 界面与菜单栏完全支持简体中文。
- ✅ **跨平台支持**: 适配 Windows、macOS 和 Linux。

## 🚀 快速开始

### 安装依赖

```bash
npm install
```
*提示：如果遇到 Electron 下载失败，请参考 [安装与故障排查](docs/installation.md)。*

### 启动开发模式

```bash
npm start
```

### 构建应用

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```
构建详情请参考 [构建指南](BUILD.md)。

## 📖 文档中心

- [更新日志 (CHANGELOG.md)](CHANGELOG.md) - 版本历史和修复记录。
- [架构说明 (docs/architecture.md)](docs/architecture.md) - 项目设计与关键实现。
- [开发指南 (CLAUDE.md)](CLAUDE.md) - AI 助手与开发规范。
- [安装与故障排查 (docs/installation.md)](docs/installation.md) - 详细安装指南。

## 📂 配置文件位置

- **Windows**: `C:\Users\<用户名>\.claude\`
- **macOS/Linux**: `~/.claude/`

## 📄 License

MIT
