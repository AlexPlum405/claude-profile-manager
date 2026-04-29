# 构建指南

本项目支持 Windows、macOS 和 Linux 平台的构建。

## 平台构建说明

- [Windows 构建与分发指南](docs/build-windows.md) - 包含安装包与便携版说明。
- [macOS 构建与签名指南](docs/build-mac.md) - 包含 arm64 构建、签名与公证流程。

## 快速构建命令

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

- **Windows**: `.exe` 安装包、便携版以及解压目录。
- **macOS**: `.dmg` 安装镜像、`.zip` 压缩包以及 `.app` 包。
- **Linux**: `.AppImage`、`.deb` 以及 `.rpm` 包（取决于配置）。

详细的分发建议和环境配置请查看上述对应平台的文档。
