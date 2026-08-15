# macOS 发布指南

本文记录 M7 Mac 发布阶段中可在本地重复执行的部分。它不表示应用已经通过 Developer ID 签名、Apple 公证或 Gatekeeper 验收。

账号、证书、公证凭据、更新签名密钥和最终验收步骤见 [Developer ID 与 macOS 公证操作手册](./apple-developer-id.md)。

## 发布输入

- 产品名：`木牛`
- Bundle 标识：`dev.muniu.desktop`
- 版本来源：`apps/desktop-mac/src-tauri/tauri.conf.json`
- 最低系统版本：macOS Monterey 12.0
- DMG 产物：`Muniu_<version>_universal.dmg`
- ZIP 产物：`Muniu_<version>_universal.zip`
- 自动更新产物：`Muniu_<version>_universal.app.tar.gz`
- Homebrew cask：`packaging/homebrew/Casks/mniu.rb`
- 自动更新地址：`https://github.com/muniu-ai/muniu/releases/latest/download/latest.json`
- 自动更新 dry-run manifest：`packaging/updater/latest.dry-run.json`

## 构建

只验证前端时不需要 Rust：

```bash
npm run build:desktop
```

原生发布构建需要 Rust/Cargo 和 Apple 构建工具链：

```bash
npm run release:mac
```

发布脚本使用 Tauri 构建 universal `.app`，再通过 `hdiutil` 无头生成 DMG，不依赖 Finder 或 AppleScript。DMG 包含背景图、固定 Finder 图标布局、`Applications` 快捷链接和 `安装说明.txt`；构建完成后会以只读方式挂载最终镜像并逐项验证。

```text
apps/desktop-mac/src-tauri/target/universal-apple-darwin/release/bundle/dmg/Muniu_0.1.0_universal.dmg
```

`apps/desktop-mac/src-tauri/tauri.conf.json` 设置了 `bundle.createUpdaterArtifacts`。发布脚本会从最终 app 重新生成版本化 updater archive；提供 updater 私钥时，还会生成 `.sig` 与真实 `latest.json`。

本地验证默认生成 unsigned 产物。正式发布需提供 Developer ID identity、notary profile 和 updater 私钥：

```bash
MNIU_MACOS_SIGN=1 \
MNIU_MACOS_NOTARIZE=1 \
MNIU_MACOS_SIGNING_IDENTITY="Developer ID Application: <name> (<team id>)" \
MNIU_NOTARY_KEYCHAIN_PROFILE=mniu-notary \
TAURI_SIGNING_PRIVATE_KEY_PATH=/secure/release/mniu-updater.key \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<password> \
npm run release:mac
```

## Apple Developer 签名

公开分发 DMG 或 ZIP 前必须签名；本地开发和个人自用不需要。签名 identity 与团队账号属于外部凭据，不写入仓库。

```bash
codesign --verify --deep --strict --verbose=2 "木牛.app"
spctl --assess --type execute --verbose "木牛.app"
```

## Apple 公证

公证同样依赖 Apple 凭据。先把 notary profile 保存到 Keychain：

```bash
xcrun notarytool store-credentials mniu-notary
```

再执行正式构建：

```bash
MNIU_MACOS_SIGN=1 \
MNIU_MACOS_NOTARIZE=1 \
MNIU_MACOS_SIGNING_IDENTITY="Developer ID Application: <name> (<team id>)" \
MNIU_NOTARY_KEYCHAIN_PROFILE=mniu-notary \
TAURI_SIGNING_PRIVATE_KEY_PATH=/secure/release/mniu-updater.key \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<password> \
npm run release:mac
```

只有签名、公证、staple 和 `spctl` 均有通过证据时，才能声明 Gatekeeper 验收完成。

## Homebrew cask

cask 草案故意保留 `REPLACE_WITH_RELEASE_SHA256`。发布前必须替换为真实 DMG 校验值：

```bash
shasum -a 256 Muniu_0.1.0_universal.dmg
```

本地 tap dry-run：

```bash
brew tap-new local/mniu
mkdir -p "$(brew --repository local/mniu)/Casks"
cp packaging/homebrew/Casks/mniu.rb "$(brew --repository local/mniu)/Casks/mniu.rb"
brew install --cask --dry-run local/mniu/mniu
```

仍含 `REPLACE_WITH_RELEASE_SHA256` 时不得发布 cask。

## 自动更新 dry-run

> v0.1.0 Developer Preview 不发布签名/公证桌面应用，运行时 updater、updater capability 和 updater artifact generation 均已禁用。以下流程只保留为未来签名发布通道的设计资料，不得用于 v0.1.0 发布。

桌面端已经接入 Tauri 2 updater：

- JS 依赖：`@tauri-apps/plugin-updater`
- Rust 插件：`tauri-plugin-updater`
- Tauri 配置：`plugins.updater.pubkey`、`plugins.updater.endpoints`、`bundle.createUpdaterArtifacts`
- dry-run manifest：`packaging/updater/latest.dry-run.json`

仓库内的 updater 公钥与 dry-run manifest 只用于验证配置形状。正式发布前必须替换为真实公钥，并用发布环境中的私钥生成签名：

```bash
TAURI_SIGNING_PRIVATE_KEY_PATH=/secure/release/mniu-updater.key \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<password> \
npm run release:mac
```

签名构建应产出：

```text
Muniu_0.1.0_universal.app.tar.gz
Muniu_0.1.0_universal.app.tar.gz.sig
latest.json
```

脚本会在 app 完成公证和 staple 后重建 updater archive，签名后为 `darwin-aarch64` 与 `darwin-x86_64` 写入同一个 universal archive URL 和真实签名。不得发布含 `REPLACE_WITH_TAURI_UPDATER_SIGNATURE` 的 `latest.dry-run.json`。

## 安装

通过 DMG 安装：

```bash
open Muniu_0.1.0_universal.dmg
```

发布真实 tap 后通过 Homebrew 安装：

```bash
brew install --cask mniu
```

安装后验证深链接：

```bash
open "mniu://import/provider?payload=eyJwcm92aWRlcnMiOltdfQ"
```

只有 macOS 确实唤起已安装应用并展示导入确认流，`mniu://` 验收才算通过。

## 卸载

普通卸载：

```bash
brew uninstall --cask mniu
```

只有用户明确要求删除支持数据时才使用：

```bash
brew uninstall --cask --zap mniu
```

手动清理候选路径：

```bash
rm -rf "$HOME/Library/Application Support/dev.muniu.desktop"
rm -f "$HOME/Library/Preferences/dev.muniu.desktop.plist"
rm -rf "$HOME/.mniu"
```

## 安全要求

- API key 与 MCP env secret 只能进入环境变量、本地加密 secret vault 或 macOS Keychain，发布产物不得包含真实 secret。
- Provider、MCP、Prompt 深链接写配置前必须先预览并确认。
- 配置写入必须保留 dry-run、diff 与 backup。
- `mniu://` 不得自动导入未受信任 payload。
- `mniu.diagnostics` 可以包含受限的本地日志、专属 app 日志、Tauri panic 日志和木牛相关 DiagnosticReports 尾部样本；采集器必须限制文件数和字节数、排除其他应用，并在导出前脱敏 Bearer/API key/token/secret/password。
- Gatekeeper 通过必须有 Developer ID 签名与 Apple 公证证据。
- 已发布 cask 必须固定真实 SHA-256。

## 验证

本地发布工程检查：

```bash
npm run verify:mac-release
```

外部凭据到位后的完整发布证据还必须包括：

- `npm run release:mac`
- `codesign --verify --deep --strict --verbose=2`
- `xcrun notarytool submit ... --wait`
- `xcrun stapler staple` 与 `xcrun stapler validate`
- `spctl --assess`
- `brew install --cask --dry-run`
- signed updater archive 和真实 `latest.json`
- 已安装应用的 updater check/download/install 验证
- 已安装应用的 `mniu://` 唤起验证
