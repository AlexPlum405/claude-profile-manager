# Claude Profile Manager

Claude Code 配置管理器 - 跨平台桌面应用

## 功能特性

- ✅ 可视化管理 Claude Code 配置文件
- ✅ 快速切换不同的 API 配置（en01、iflytek、minimax 等）
- ✅ 智能合并配置（不会覆盖其他设置）
- ✅ 自动备份 settings.json
- ✅ 配置验证和错误提示
- ✅ 跨平台支持（Windows、macOS、Linux）

## 开发

```bash
# 安装依赖
npm install

# 启动开发模式
npm start
```

## 构建

```bash
# 构建所有平台
npm run build

# 仅构建 Windows
npm run build:win

# 仅构建 macOS
npm run build:mac

# 仅构建 Linux
npm run build:linux
```

## 使用说明

1. 启动应用后，左侧显示所有可用的配置文件
2. 点击配置名称可以查看和编辑
3. 修改后点击 **Save** 保存配置
4. 点击 **Activate** 激活配置（会自动备份并合并到 settings.json）
5. 点击 **New** 创建新配置
6. 点击 **Delete** 删除配置（激活的配置不能删除）

## 技术栈

- Electron - 跨平台桌面应用框架
- Node.js - 文件系统操作
- 原生 HTML/CSS/JavaScript - 保持原有 UI 设计

## 配置文件位置

- Windows: `C:\Users\<用户名>\.claude\`
- macOS/Linux: `~/.claude/`

## License

MIT
