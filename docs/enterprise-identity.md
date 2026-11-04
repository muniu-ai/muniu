# 企业身份与本地入口

E1.1 提供企业登录、显式成员绑定、邀请、会话撤销和工作区初始化。浏览器业务页面由 E6 提供；当前入口不提供完整经营界面。用户已选择先完成本地工程和合成数据验收，真实身份发行方及外部业务环境尚未准备。

## 本地协议验证

从工作树根目录执行 `npm ci`，再执行：

```sh
npm run verify:enterprise-identity
```

检查会启动仅监听回环地址的合成 OIDC 发行方，执行真实授权码兑换、PKCE、RS256 签名、nonce、受众和过期检查。它还验证重复及并发回调、CSRF、邀请接受、成员禁用、账号重绑、加密事件恢复和独立状态目录。模型、Sales、企业微信及真实员工身份不参与本项检查。

私有企业服务位于 `packages/enterprise-services`，由 `apps/host` 装配。产品插件不能导入此包。服务读取已提交的领域事件，查询投影不是身份来源。每个成员和工作区独立版本；批次事件只用于异步加密准备到事务提交之间的并发检查，不承载工作区业务状态。发生已知版本冲突时重新读取当前授权，不能沿用旧权限提交。

## 配置并启动入口

手工启动前，需要一个已注册的 OIDC 客户端、明确的发行方地址和管理员 subject。回调地址固定为应用来源加 `/v2/auth/callback`。Hosted 模式要求 HTTPS；development 仅允许回环 HTTP，并在健康与会话响应中明确标记模式。真实配置和密钥不得提交到仓库。

在仓库外准备配置文件，结构如下。示例地址及 subject 不能用于真实登录：

```json
{
  "origin": "http://127.0.0.1:7319",
  "profile": "development",
  "port": 7319,
  "providers": {
    "company-example": {
      "issuer": "https://login.example.invalid/",
      "clientId": "registered-client-id",
      "clientSecretEnv": "MN_ENTERPRISE_OIDC_SECRET"
    }
  },
  "organizations": [{
    "tenantId": "company-example",
    "name": "示例服务企业",
    "issuer": "https://login.example.invalid/",
    "maxMembers": 200,
    "administrator": {
      "id": "admin-example",
      "subject": "verified-admin-subject",
      "displayName": "企业管理员"
    }
  }]
}
```

`clientSecretEnv` 是服务端环境变量名；无客户端密钥的已注册公共客户端可省略。程序不把密钥传给浏览器。配置中的初始管理员只在人工开通时创建；后续重绑、停用和移除以事件为准，重启不能恢复旧绑定。

这里的人工开通就是由有权运维人员核验 issuer、subject，准备 `organizations` 配置并启动本入口；首次启动在事务中登记企业与初始管理员，没有另一个公开自助开通接口。后续启动只核对初始配置，不覆盖已提交的成员变更。

设置 `MN_ENTERPRISE_CONFIG_FILE` 指向该文件，然后执行 `npm run dev:enterprise`。macOS 默认通过独立 Keychain service 保存事件 HMAC 与包装密钥。其他平台须由受信 Host 装配 KMS 端口；当前本地命令不自动改用明文密钥文件。

默认状态目录为 `~/.muniu/enterprise-v1`，可用绝对路径变量 `MN_ENTERPRISE_STATE_ROOT` 覆盖。目录必须私有，且为空或包含有效 `enterprise-state.json` 标识。数据库为 `enterprise.sqlite`，密文 CAS 位于 `objects`，Keychain service 为 `com.muniu.enterprise.v1`。程序拒绝把非空旧目录初始化成新状态，不迁移、不清理旧数据。

本入口不读取、覆盖或清理旧 CLI/Desktop 的凭据及 `com.muniu.agent-os.v2` Keychain 项。

启动后，访问 `/v2/health` 可确认进程与模式；它不证明 OIDC、KMS 联合灾备或经营能力已验收。登录入口为 `/v2/auth/login?organizationId=company-example`。E6 页面尚未实现时，登录回调可以建立会话，但根页面不是完整工作台。

## 身份与会话规则

OIDC 的 issuer 与 subject 必须匹配平台人工开通或管理员邀请的绑定。外部令牌的 tenant_id、邮箱域名和 organization_roles 不授予企业权限。邀请只有绑定本人才能接受；停用再启用不能绕过邀请接受。最后一个有效管理员不能被停用或移除。

服务端先持久保存浏览器绑定、state、nonce 和 PKCE verifier。回调在兑换授权码前原子领取一次；重复回调、进程中断或响应丢失后均不能重兑原授权码，需要发起新的登录。OIDC 令牌只在服务器内处理，不返回浏览器。

登录会话使用 HttpOnly、SameSite=Lax cookie。HTTPS 使用 Secure 与 __Host 前缀；回环 development HTTP 使用独立的开发 cookie 名称。会话有效期八小时，登录尝试十分钟，邀请七天。成员停用、移除和账号重绑立即使旧会话失效；业务命令及幂等回放都重新检查当前成员状态。

写请求同时检查精确 Origin、CSRF token 和 Idempotency-Key。成员更新及邀请接受还需 expectedStreamVersion。认证回调采用协议自己的 state、nonce、PKCE 和单次浏览器绑定，不接受业务命令，也不要求业务幂等头。

企业提供方暂时不可用时，当前实现不会根据邮箱或客户端 tenantId 自动创建人员，也不会退回本地隐式所有者。对象和字段权限由[E1.2 企业权限服务](enterprise-access.md)接入当前身份；业务领域与持续规则仍需后续集成，不能把组织管理员身份当作财务批准资格。

## 契约与验证边界

企业身份 HTTP 来源为 `packages/contracts/src/enterprise-api-schema.ts` 与 `enterprise-identity-schema.ts`。运行时返回的 OpenAPI 和[企业 OpenAPI 文件](reference/enterprise-openapi.yaml)使用同一来源。请求、响应类型由 `npm run generate:contracts` 生成，客户端入口为 `@mn/contracts/enterprise-client`，文档使用 `npm run docs:generate` 更新。

旧 0.2 Host 的 CLI、Desktop 和产品壳暂时保留，E6.3 完成替代覆盖后退出。本入口不会装载旧状态或将旧接口映射到新身份语义。托管 PostgreSQL/S3/KMS 的完整运行与容量恢复仍需 E1.2、E7 实施并验收。

实际结果见 [E1.1 验证记录](verification/enterprise-e1-1-2026-11-02.md)。OIDC 适配使用固定版本 openid-client，并启用[官方签名验证选项](https://github.com/panva/openid-client/blob/v6.8.8/docs/functions/enableNonRepudiationChecks.md)；库代码通过依赖安装，MIT 许可记录在第三方清单中。
