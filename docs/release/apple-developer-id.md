# Developer ID 与 macOS 公证操作手册

本手册用于木牛的 macOS 直接分发，即通过 DMG、ZIP、GitHub Release、官网或 Homebrew 提供安装包。它不涉及 Mac App Store 上架。

v0.1.0 Developer Preview 不包含运行时自动更新器，因此本手册只管理 Apple 代码签名和公证凭据。

## 是否现在必须办理

| 使用方式 | Developer ID Application | Notarization | 结论 |
|---|---:|---:|---|
| 仅在当前开发 Mac 上运行、调试或自用 | 否 | 否 | 可继续使用 unsigned 本地产物 |
| 少量内部测试，测试者愿意手动在“隐私与安全性”中放行 | 非技术必需 | 非技术必需 | 可测试，但不属于 M7 发布完成 |
| 通过 DMG、ZIP、GitHub Release、官网或 Homebrew 分发给其他用户 | 是 | 是 | 木牛 M7 的正式发布要求 |
| Mac App Store 上架 | 使用 App Store 分发证书，不是本文流程 | 由 App Store 流程处理 | 当前不在木牛范围内 |

Developer ID Application 是“Mac App Store 之外分发”的证书。木牛当前生成的是 `.app`、`.zip` 和 `.dmg`，不生成 `.pkg`，因此不需要 Developer ID Installer。

## 1. 注册 Apple Developer Program

1. 使用将长期持有发布权限、已开启双重认证的 Apple Account 登录 [Apple Developer](https://developer.apple.com/programs/enroll/)。
2. 选择个人或组织身份。个人账号使用本人法定姓名；组织账号需要法定实体的 D-U-N-S Number、组织域名工作邮箱、公开可访问的网站，以及有权代表组织签署协议的人员。
3. 完成协议、身份验证和年度付费。Apple 当前公布的 Apple Developer Program 年费为 99 美元，实际按地区显示本地币种和税费。
4. 在账号的 Membership 页面记录 Team ID。

免费 Apple Developer 账号只能用于开发测试，不能完成木牛正式公证。

## 2. 创建 Developer ID Application 证书

推荐直接在 Xcode 创建，以确保证书和私钥同时进入本机 Keychain：

Apple 官方账号帮助将普通 Developer ID 证书创建权限限定为 Account Holder；组织使用 cloud-managed certificate 时，可由被授予相应权限的管理员操作。若账号里看不到该选项，先让 Account Holder 检查角色权限。

1. 打开 Xcode，进入 `Settings > Accounts`。
2. 添加已加入 Apple Developer Program 的 Apple Account。
3. 选中团队，点击 `Manage Certificates`。
4. 点击 `+`，选择 `Developer ID Application`。
5. 打开“钥匙串访问”，在“我的证书”中确认该证书下方带有私钥。

也可以在 Apple Developer 的 `Certificates, Identifiers & Profiles` 页面创建。网页方式需要先在“钥匙串访问 > 证书助理 > 从证书颁发机构请求证书”生成 CSR，下载 `.cer` 后双击导入。

验证证书：

```bash
security find-identity -v -p codesigning
```

应看到类似：

```text
Developer ID Application: Your Name (TEAMID)
```

证书需要迁移到另一台构建机时，从“钥匙串访问”的“我的证书”导出包含私钥的 `.p12`，通过安全通道保存。不要把 `.p12`、密码或私钥提交到仓库。

## 3. 配置 notarization 凭据

木牛发布脚本使用 `notarytool` Keychain profile。Apple ID 方式最直接：

1. 在 [Apple Account](https://account.apple.com/) 为该账号生成 app-specific password。
2. 执行：

```bash
xcrun notarytool store-credentials mniu-notary \
  --apple-id "your-apple-id@example.com" \
  --team-id "TEAMID"
```

命令会安全提示输入 app-specific password。不要把密码直接写进命令行，以免进入 shell history 或进程参数。

3. 验证 profile 能访问公证服务：

```bash
xcrun notarytool history --keychain-profile mniu-notary
```

团队发布也可改用 App Store Connect API key。将 `.p8` 放在仓库外的安全目录，并通过 `APPLE_API_ISSUER`、`APPLE_API_KEY`、`APPLE_API_KEY_PATH` 管理；不要把 key 文件提交到仓库。

## 4. 运行发布前检查

先设置当前终端环境：

```bash
export MNIU_MACOS_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export MNIU_NOTARY_KEYCHAIN_PROFILE="mniu-notary"
npm run preflight:mac-signing -- --public
```

本地开发模式可以运行同一检查但不要求凭据齐全：

```bash
npm run preflight:mac-signing
```

## 5. 构建签名并公证的正式产物

```bash
MNIU_MACOS_SIGN=1 \
MNIU_MACOS_NOTARIZE=1 \
npm run release:mac
```

脚本将执行：

1. 构建 Intel + Apple Silicon universal `.app`。
2. 校验 app 签名。
3. 提交 app 的 ZIP 容器到 Apple 公证并将 ticket staple 到 app。
4. 生成最终 ZIP 和 DMG。
5. 签名、提交并 staple DMG。
6. 输出 ZIP 和 DMG 的 SHA-256。

## 6. 发布验收

```bash
APP="apps/desktop-mac/src-tauri/target/universal-apple-darwin/release/bundle/macos/木牛.app"
DMG="apps/desktop-mac/src-tauri/target/universal-apple-darwin/release/bundle/dmg/Muniu_0.1.0_universal.dmg"

codesign --verify --deep --strict --verbose=2 "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose "$APP"
xcrun stapler validate "$DMG"
spctl --assess --type open --verbose "$DMG"
hdiutil verify "$DMG"
lipo -archs "$APP/Contents/MacOS/mniu-desktop"
```

最终应同时满足：

- `codesign` 验证通过。
- `stapler validate` 对 app 和 DMG 通过。
- `spctl` 显示 accepted。
- 二进制同时包含 `x86_64 arm64`。
- 从网络下载到一台干净 Mac 后，Gatekeeper 不拦截，`mniu://` 能唤起应用。

## 7. 常见问题

- `0 valid identities found`：证书没有安装、证书下缺少私钥、证书过期，或当前 Keychain 未解锁。
- `The signature of the binary is invalid`：检查嵌套二进制是否全部签名，并确认未在签名后修改 app 内容。
- notarization 返回 `Invalid`：用 `xcrun notarytool log <submission-id> --keychain-profile mniu-notary` 查看 Apple 日志。
- `spctl` 拒绝但公证成功：确认最终用户拿到的是 staple 之后重新生成的 ZIP/DMG。

## 官方资料

- [Apple Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
- [Apple notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Tauri macOS code signing](https://v2.tauri.app/distribute/sign/macos/)
