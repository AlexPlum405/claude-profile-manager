# Clave macOS Build Guide

This guide implements a two-stage release flow:

1. Stage 1: build unsigned `arm64` artifacts for local/internal verification.
2. Stage 2: after Apple credentials are ready, build signed + notarized artifacts for public distribution.

## 1) Environment Setup (macOS)

### Required tools

- Homebrew
- Node.js LTS (with npm)
- Xcode Command Line Tools (`xcode-select --install`)

### Make sure Homebrew binaries are in PATH

```bash
export PATH="/opt/homebrew/bin:$PATH"
```

### Install Node.js LTS

```bash
brew install node@22
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
node -v
npm -v
```

## 2) Install Project Dependencies

From project root:

```bash
npm ci
```

## 3) Generate macOS `.icns` App Icon

Source icon: `assets/icons/icon-new_001.jpg` (1024x1024)

```bash
TMP_ICON_PNG="assets/icons/.icon-source.png"
sips -s format png assets/icons/icon-new_001.jpg --out "$TMP_ICON_PNG"
mkdir -p assets/icons/icon.iconset
sips -z 16 16     -s format png "$TMP_ICON_PNG" --out assets/icons/icon.iconset/icon_16x16.png
sips -z 32 32     -s format png "$TMP_ICON_PNG" --out assets/icons/icon.iconset/icon_16x16@2x.png
sips -z 32 32     -s format png "$TMP_ICON_PNG" --out assets/icons/icon.iconset/icon_32x32.png
sips -z 64 64     -s format png "$TMP_ICON_PNG" --out assets/icons/icon.iconset/icon_32x32@2x.png
sips -z 128 128   -s format png "$TMP_ICON_PNG" --out assets/icons/icon.iconset/icon_128x128.png
sips -z 256 256   -s format png "$TMP_ICON_PNG" --out assets/icons/icon.iconset/icon_128x128@2x.png
sips -z 256 256   -s format png "$TMP_ICON_PNG" --out assets/icons/icon.iconset/icon_256x256.png
sips -z 512 512   -s format png "$TMP_ICON_PNG" --out assets/icons/icon.iconset/icon_256x256@2x.png
sips -z 512 512   -s format png "$TMP_ICON_PNG" --out assets/icons/icon.iconset/icon_512x512.png
sips -z 1024 1024 -s format png "$TMP_ICON_PNG" --out assets/icons/icon.iconset/icon_512x512@2x.png
iconutil -c icns assets/icons/icon.iconset -o assets/icons/icon.icns
rm -f "$TMP_ICON_PNG"
```

## 4) Stage 1 - Unsigned arm64 Build (Internal Validation)

```bash
npm run build:mac
```

Expected artifacts in `dist/`:

- `Clave-<version>-arm64.dmg`
- `Clave-<version>-arm64-mac.zip`
- unpacked app directory `dist/mac-arm64/`

### Validate artifacts and architecture

```bash
ls -lh dist
file dist/mac-arm64/Clave.app/Contents/MacOS/Clave
```

`file` output should contain `arm64`.

### Gatekeeper behavior for unsigned build

Unsigned app may be blocked on first launch. Internal testing workaround:

1. Right click app -> Open.
2. Or run:

```bash
xattr -dr com.apple.quarantine /Applications/Clave.app
```

## 5) Stage 2 - Signed + Notarized Build (Public Distribution)

Run this stage only after Apple Developer credentials are ready.

### 5.1 Prepare signing identity

Import `Developer ID Application` certificate into login keychain and verify:

```bash
security find-identity -v -p codesigning
```

### 5.2 Configure notarization credentials

Use Apple ID + app-specific password:

```bash
export APPLE_ID="your_apple_id@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="YOURTEAMID"
```

Or store credentials once:

```bash
xcrun notarytool store-credentials "clave-notary-profile" \
  --apple-id "your_apple_id@example.com" \
  --team-id "YOURTEAMID" \
  --password "xxxx-xxxx-xxxx-xxxx"
```

### 5.3 Build signed artifacts

```bash
npm run build:mac
```

### 5.4 Verify signed/notarized output

```bash
codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Clave.app
spctl -a -vv --type exec dist/mac-arm64/Clave.app
xcrun stapler validate dist/Clave-<version>-arm64.dmg
```

All commands above should pass before external distribution.
