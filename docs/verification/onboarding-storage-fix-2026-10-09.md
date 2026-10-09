# 首次设置存储错误修复验证

日期：2026-10-09。基线：`8f51380f8875c26a1391250a28843f6b7866eed6`。环境：macOS、Node.js 22.19.0、npm 11.10.1、TypeScript 5.7.2。

## 故障与修复

安装版第四屏首先调用 `POST /v2/setup`。该接口原先只写幂等回执，没有来源事件，正式 SQLite 的受保护日志因此拒绝提交，返回 `500 INTERNAL_ERROR`。`mn doctor` 的健康与就绪检查均通过，不能据此判断初始化写入成功。

修复复用已有的 `api.mutation_completed` 事件，将事件与回执放在同一事务。没有关闭存储完整性检查，也没有修改已有业务记录或模型密钥。向导现在显示失败步骤，错误码与参考编号放在默认折叠的故障详情中。

原向导测试使用未启用受保护日志的内存存储。现在改用临时 SQLite，保留测试密钥和固定模型响应。打包验证增加初始化和同键重放请求，并核对受管 Host 实际打开的数据库。

## 验证证据

- 新增本地 Host 测试先复现 500，再验证成功提交、受保护回执、同键重放、不同请求冲突及冷启动后的重放。Host 与本地运行专项 37 项通过。
- 界面测试先复现 SQLite 初始化失败；修复后完整首次设置通过。另验证失败时显示步骤与诊断信息，不标记向导完成，也不继续创建模型连接。
- `npm test`：742 项通过，0 失败、0 跳过。新增打包脚本的 6 项测试随后纳入默认入口；`npm run test:boundaries`：93 项通过。
- `npm run typecheck`、`npm run typecheck:desktop`、`npm run build:desktop` 通过。
- `cargo test --locked`：9 项通过，包含数据目录覆盖、默认目录和无效路径拒绝；Rust 格式检查通过。
- `npm run verify:mac-release`、文档生成检查、链接检查、站点构建及 `git diff --check` 通过。
- `npm audit --omit=dev`：0 漏洞。
- 企业静态检查通过；真实企业集成因缺少 Docker 报 `spawn docker ENOENT`，未完成。

## 安装包验证边界

最初的打包脚本替换 HOME，导致系统 Keychain 读取超时。现改为仅通过 `MN_V2_STATE_ROOT` 隔离业务数据，Desktop 与 Host 使用同一绝对路径；保留正常 HOME。临时目录不隔离系统 Keychain，不能通过删除现有 Keychain 条目清理测试。

最终 universal 安装包通过 `npm run verify:mac-packaged-app`：数据库路径与受管进程身份校验通过，初始化和同键重放均返回 200，退出后后台进程与监听端口一并关闭。应用与 Host 均包含 arm64、x86_64；应用签名和 DMG 完整性校验通过。

修复版已安装到 `/Applications/木牛.app`。已安装应用的初始化请求与同键重放均返回 200，`doctor` 报告健康且就绪，无问题项；Host 文件摘要与构建清单一致，并确认为该应用的受管子进程。原应用与数据已备份，未提交的向导表单需要重新填写。

本次不验证真实模型任务质量或企业部署。安装产物使用本地 ad-hoc 签名，没有进行 Developer ID 签名或 Apple 公证。
