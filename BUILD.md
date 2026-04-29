# 构建指南

本项目支持 Windows 和 macOS 平台的构建。

## 平台构建文档

- [Windows 构建指南](BUILD-WINDOWS.md) - Windows 平台构建说明
- [macOS 构建指南](BUILD-MAC.md) - macOS 平台构建说明

## 快速构建

### Windows
```bash
npm run build:win
```

### macOS
```bash
npm run build:mac
```

### Linux
```bash
npm run build:linux
```

## 构建产物

构建完成后，产物将生成在 `dist/` 目录下：

- **Windows**: `.exe` 安装包和便携版
- **macOS**: `.dmg` 和 `.zip` 文件
- **Linux**: `.AppImage` 和 `.deb` 包

详细说明请查看对应平台的构建文档。
