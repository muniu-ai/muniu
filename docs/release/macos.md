# macOS 发布

木牛 0.2 的 macOS 产物是 universal `.app`、ZIP 与 DMG。产品名为“木牛”，bundle identifier 为 `dev.muniu.desktop`，最低系统版本为 macOS Monterey 12.0。

公开分发前必须完成 Developer ID 签名、Apple 公证、staple 与 Gatekeeper 验收。没有这些外部凭据时，只能把产物描述为本地 unsigned 构建。

## 构建输入

- 版本来源：`apps/desktop-mac/src-tauri/tauri.conf.json`；
- Host sidecar：`mn-host`；
- 目标：`universal-apple-darwin`；
- DMG：`Muniu_0.2.0_universal.dmg`；
- ZIP：`Muniu_0.2.0_universal.zip`；
- 自动更新：`bundle.createUpdaterArtifacts` 保持 `false`。

只验证前端：

```bash
npm run typecheck:desktop
npm run build:desktop
```

构建本地 unsigned 原生产物：

```bash
npm run release:mac
```

脚本构建 Intel 与 Apple Silicon universal app，通过 `hdiutil` 生成 DMG，并校验 ZIP、DMG、架构和挂载内容。产物位于：

```text
apps/desktop-mac/src-tauri/target/universal-apple-darwin/release/bundle/
```

## 签名与公证

先按 [Developer ID 与公证手册](./apple-developer-id.md) 配置 Keychain identity 和 notary profile，再运行：

```bash
export MNIU_MACOS_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export MNIU_NOTARY_KEYCHAIN_PROFILE="muniu-notary"
npm run preflight:mac-signing -- --public

MN_MACOS_SIGN=1 \
MN_MACOS_NOTARIZE=1 \
MN_NOTARY_KEYCHAIN_PROFILE="${MNIU_NOTARY_KEYCHAIN_PROFILE}" \
npm run release:mac
```

不要把 identity、app-specific password、API key 或 `.p8` 内容写入仓库。构建脚本只通过 Keychain profile 调用 `notarytool`。

## 验收

```bash
export APP_PATH="apps/desktop-mac/src-tauri/target/universal-apple-darwin/release/bundle/macos/木牛.app"
export DMG_PATH="apps/desktop-mac/src-tauri/target/universal-apple-darwin/release/bundle/dmg/Muniu_0.2.0_universal.dmg"

codesign --verify --deep --strict --verbose=2 "${APP_PATH}"
xcrun stapler validate "${APP_PATH}"
spctl --assess --type execute --verbose "${APP_PATH}"
xcrun stapler validate "${DMG_PATH}"
spctl --assess --type open --verbose "${DMG_PATH}"
hdiutil verify "${DMG_PATH}"
```

还要在一台干净 Mac 上从网络下载 DMG，核对 SHA-256，安装并完成四屏向导。验收应证明：

- app 主二进制和 `mn-host` sidecar 的来源、架构与签名正确；
- 生产 CSP 只加载同源脚本；
- 新状态写入 `~/.muniu/v2`，不读取或修改早期状态；
- 同端口已有早期 daemon 时明确拒绝启动；
- OPC 或 Coding 单插件故障不影响核心页面；
- 安装包不包含凭据、测试状态或开发 HMR 配置。

## Homebrew cask

发布前将 `packaging/homebrew/Casks/mniu.rb` 更新到 `0.2.0`，并把占位 SHA-256 替换为最终 DMG 的真实值：

```bash
shasum -a 256 "${DMG_PATH}"
brew tap-new local/muniu
mkdir -p "$(brew --repository local/muniu)/Casks"
cp packaging/homebrew/Casks/mniu.rb "$(brew --repository local/muniu)/Casks/mniu.rb"
brew install --cask --dry-run local/muniu/muniu
```

占位摘要未替换、签名或公证缺失时不得发布 cask。

## 安装与卸载

```bash
open "${DMG_PATH}"
brew install --cask muniu
brew uninstall --cask muniu
```

普通卸载保留用户状态。只有用户明确要求、确认备份且理解不可恢复后果时，才能另行删除 `~/.muniu/v2` 和 Keychain 中的 0.2 条目；发布文档不提供递归删除命令。

## 发布门禁

```bash
npm run verify:mac-release
npm run verify:release -- --tag v0.2.0
npm run docs:links
npm run docs:build
npm audit --omit=dev
```

发布标签和产物不可覆盖。ZIP、DMG、源码归档、SBOM、第三方许可证清单和容器镜像都应进入 `SHA256SUMS` 或平台来源证明。
