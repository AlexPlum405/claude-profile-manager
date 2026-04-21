# 安装说明

## Electron 安装问题修复

如果遇到 "Electron failed to install correctly" 错误，请按以下步骤操作：

### 方法 1: 清理缓存重新安装

```bash
# 1. 删除 node_modules 和缓存
rm -rf node_modules package-lock.json
npm cache clean --force

# 2. 重新安装
npm install
```

### 方法 2: 手动下载 Electron

```bash
# 设置镜像源（国内用户）
npm config set electron_mirror https://npmmirror.com/mirrors/electron/

# 重新安装
npm install
```

### 方法 3: 使用 cnpm

```bash
npm install -g cnpm --registry=https://registry.npmmirror.com
cnpm install
```

### 方法 4: 直接运行（如果已有 electron）

如果系统已全局安装 electron：

```bash
electron .
```

## 验证安装

```bash
# 检查 electron 是否正确安装
ls node_modules/electron/dist/

# 应该看到 electron.exe (Windows) 或 Electron.app (macOS)
```

## 启动应用

```bash
npm start
```

## 构建应用

```bash
npm run build:win    # Windows
npm run build:mac    # macOS  
npm run build:linux  # Linux
```
