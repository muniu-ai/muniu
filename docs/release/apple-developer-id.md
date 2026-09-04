# Developer ID 与 Apple 公证

本手册适用于通过 DMG、ZIP、GitHub Release、官网或 Homebrew 分发木牛 0.2，不适用于 Mac App Store。

本地开发与个人自用可以构建 unsigned 产物。向其他用户公开分发时，需要有效的 Developer ID Application 证书和 Apple 公证。木牛生成 `.app`、`.zip` 与 `.dmg`，不生成 `.pkg`。

## 准备账号和证书

1. 使用开启双重认证并加入 Apple Developer Program 的 Apple Account 登录 Xcode。
2. 在 `Xcode > Settings > Accounts > Manage Certificates` 创建 `Developer ID Application`。
3. 在“钥匙串访问”的“我的证书”中确认该证书带有私钥。
4. 记录 Team ID，并限制发布账号和证书的访问范围。

检查当前签名 identity：

```bash
security find-identity -v -p codesigning
```

`.p12`、私钥、密码和恢复材料必须通过仓库外的安全通道保存。不要提交到 Git、CI artifact 或诊断包。

## 配置 notary profile

在 Apple Account 创建 app-specific password，然后让 `notarytool` 交互式读取密码：

```bash
xcrun notarytool store-credentials muniu-notary \
  --apple-id "your-apple-id@example.com" \
  --team-id "TEAMID"
```

不要把 app-specific password 写在命令参数中。验证 profile：

```bash
xcrun notarytool history --keychain-profile muniu-notary
```

团队也可使用 App Store Connect API key。`.p8` 文件必须位于仓库外，由受限的 CI secret 或密钥管理系统提供。

## 发布前检查

```bash
export MNIU_MACOS_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export MNIU_NOTARY_KEYCHAIN_PROFILE="muniu-notary"
npm run preflight:mac-signing -- --public
```

公开模式会验证 Apple 命令行工具、identity 和 notary profile。检查失败时不要切换为 unsigned 后继续发布。

## 构建

```bash
MN_MACOS_SIGN=1 \
MN_MACOS_NOTARIZE=1 \
MN_NOTARY_KEYCHAIN_PROFILE="${MNIU_NOTARY_KEYCHAIN_PROFILE}" \
npm run release:mac
```

发布脚本依次：

1. 构建 universal app 并验证 `x86_64`、`arm64`；
2. 验证 app 签名；
3. 提交 app 的 ZIP 容器，等待公证并 staple app；
4. 生成最终 ZIP 与 DMG；
5. 签名、公证并 staple DMG；
6. 验证 ZIP、DMG 和挂载内容并输出 SHA-256。

## 独立验收

```bash
export APP_PATH="apps/desktop-mac/src-tauri/target/universal-apple-darwin/release/bundle/macos/木牛.app"
export DMG_PATH="apps/desktop-mac/src-tauri/target/universal-apple-darwin/release/bundle/dmg/Muniu_0.2.0_universal.dmg"

codesign --verify --deep --strict --verbose=2 "${APP_PATH}"
xcrun stapler validate "${APP_PATH}"
spctl --assess --type execute --verbose "${APP_PATH}"
xcrun stapler validate "${DMG_PATH}"
spctl --assess --type open --verbose "${DMG_PATH}"
hdiutil verify "${DMG_PATH}"
lipo -archs "${APP_PATH}/Contents/MacOS/muniu-desktop"
```

所有命令通过后，再在干净设备上验证网络下载、安装、首次向导与 Host 启动。只有同时具备签名、公证、staple、Gatekeeper 和干净安装证据，才能声明公开分发就绪。

## 常见失败

- `0 valid identities found`：证书未安装、缺少私钥、已过期或 Keychain 未解锁。
- `The signature of the binary is invalid`：检查嵌套二进制是否都已签名，且签名后没有修改 app。
- 公证结果为 `Invalid`：使用 `xcrun notarytool log` 查看 Apple 返回的具体问题，不上传含凭据的完整日志。
- 公证成功但 `spctl` 拒绝：确认交付的是 staple 之后重新生成并计算摘要的产物。

## 官方资料

- [Apple：创建 Developer ID 证书](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
- [Apple：公证 macOS 软件](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Tauri：macOS 代码签名](https://v2.tauri.app/distribute/sign/macos/)
