# 企业经营平台 E1.1 验证记录

2026-11-03 后续状态：E1 已重新打开验收，以下为原始检查记录；当前缺口、补修和未完成项见[E1 复核记录](enterprise-e1-review-2026-11-03.md)。

日期：2026-11-02。基线为 E0.2 提交 `8306de7`，分支为 `codex/enterprise-e1-1`。当前状态：本地身份出口通过；通用容器回归仍在验证，不能据此宣称企业部署通过。

## 变化

新增私有企业服务和 Host 企业入口，提供 OIDC Authorization Code + PKCE、受保护服务端会话、明确 issuer/subject 绑定、邀请、停用、移除、重绑和工作区初始化。身份及会话事实使用 KernelEventV1 和加密 CAS；每个聚合独立版本，权限读取与事务提交之间用批次版本检测并发变化。

新增企业身份 schema、生成客户端及 OpenAPI。原 0.2 产品入口不改用新身份，也不提供兼容映射。新本地入口使用独立目录、状态标识和 Keychain service，拒绝旧非空目录。

用户确认真实 OIDC、Sales 和企业微信环境尚未准备，先完成本地工程与合成数据验收。本记录不宣称真实企业登录或生产部署通过。

## 已执行检查

| 检查 | 状态 |
| --- | --- |
| 企业服务聚焦测试 | 7 项通过 |
| 企业浏览器协议、事件存储、本地状态检查 | 8 项通过，使用回环合成 OIDC 发行方和真实 SQLite/CAS，包含两个已开通租户及 cookie 租户篡改 |
| 企业生成客户端及既有 contracts 测试 | 35 项通过 |
| 独立 Keychain 命名空间检查 | 通过；使用注入命令，不创建真实系统密钥 |
| `npm run test:boundaries` | 142 项通过 |
| `npm run verify:contracts` | 通过 |
| `npm run verify:licenses` | 通过，452 个 npm 包及 448 个 Cargo crate |
| `npm audit --omit=dev` | 0 项漏洞 |
| `npm test` | 1196 项通过；随后新增的双已开通租户场景通过聚焦复验 |
| `npm run typecheck`、`npm run typecheck:desktop`、`npm run build:desktop` | 通过 |
| `npm run build:host-sidecar`、`cargo test --locked` | 通过；Rust 13 项通过，未执行会触及旧 Keychain 的 sidecar smoke |
| `npm run docs:check`、`npm run docs:links`、`npm run docs:build`、`git diff --check` | 通过 |
| `npm run verify:helm`、`npm run verify:enterprise-fixture -- --static` | 通过；仅为静态部署检查 |
| `npm run verify:enterprise-fixture` | 首轮因 Compose 插件不可见失败；修正临时环境后因 Go 模块源超时失败；获准使用临时镜像后正在复验 |
| `npm run verify:kind` | 尚未运行，等待同一 MinIO 构建依赖完成 |

先运行缺少实现的失败测试，再实现身份、会话和存储入口。反例另发现了 JSON 字段顺序导致幂等不一致、停用再启用绕过邀请、初始配置阻止账号重绑后重启、客户端接受继承信封字段等问题，修复后聚焦检查通过。

Docker 已安装但原先未运行；仅为本次验证启动服务，使用独立 Compose 项目。临时 Docker 配置补充插件路径，不修改用户配置。用户已授权临时使用 Go 模块镜像；派生 Dockerfile 仅改变两个构建阶段的 GOPROXY 与校验服务获取地址，保留源码 SHA-256、固定提交、Go 版本、`go.sum` 和 `-mod=readonly`。GOSUMDB 仍使用 sum.golang.org 的签名身份，未关闭校验。

## 限制与后续

当前验证覆盖本地协议和合成身份，不包含浏览器经营页面、对象/字段权限、Sales、企业微信、双 Host PostgreSQL 扩容、真实 Keychain 读回及灾备。新 OpenAPI 只公布已实现身份操作，目标计划和经营接口尚未挂载。

E1.2 将接入对象与字段权限、职责分离、租户配额及企业存储。E3.1 将推进统一持久调度和动作协议。真实外部环境未准备不阻止这些本地工程工作。
