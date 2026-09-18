# 联合发布签名与运行时准入

`scripts/industry-delivery-release-gate.mjs` 提供无网络、无状态写入的纯验证函数 `verifyReleaseGate(manifest, trustedKeys, runtime, { now, tenantId })`。所有缺项、签名错误、过期、撤销或版本不符均抛出错误，调用方必须拒绝真实租户准入。

函数校验受信签名及签署者声明，不独立证明 72 次故障或恢复演练确实执行。签署者应先核对原始证据；不能用测试用密钥、自签临时公钥或任意非空摘要启用真实租户。

## 签名格式

发布正文是去除顶层 `signature` 后的对象。对象键递归按字典序排序，数组顺序保留，再以 UTF-8 JSON 编码；具体以 `canonicalManifestPayload` 为准。签名算法固定为 Ed25519，`signature.value` 使用标准 Base64。公钥来自部署方受控的受信根文件，不能从发布清单或 HTTP 请求提取。

受信根文件格式：

```json
{
  "keys": [
    {
      "keyId": "由发布管理者分配",
      "algorithm": "Ed25519",
      "publicKeyPem": "部署方保存的SPKI公钥PEM",
      "revoked": false
    }
  ]
}
```

以上为结构说明，不能直接部署。私钥不进入服务配置、仓库、测试证据或发布清单。公钥变更和撤销需要受控发布记录；未知、重复或已撤销的 keyId 都被拒绝。

## 运行时绑定

运行时配置包含 `candidateId` 与 `components`，结构与清单一致。部署过程从已验证的构建产物填入这些值，不能接受用户请求提供的版本或摘要，也不能从待验清单直接复制作为当前运行身份。

校验覆盖：

- 清单为正式 `release`，两仓库完整提交、锁文件及镜像摘要、网页资源摘要均完整。
- engine/plugin lock、动作目录、数据库迁移和模型配置摘要与当前运行实例逐项一致。
- `candidateId` 对应当前部署候选，当前时间位于 `validFrom` 至 `expiresAt` 的半开区间内。
- P5 七类检查均通过，具有证据摘要、验收责任人和时间。
- `newRealTenantsEnabled` 为 `true`、`demoOnly` 为 `false`，目标真实 tenant 在明确白名单内。

默认模板不满足这些条件，且没有有效签名。生产环境需可靠时钟；过期、失效或撤销清单不得继续用缓存授权。服务应在敏感动作执行前重新执行校验，并在配置切换时同步更新受信根与运行版本。

## 独立核验命令

```bash
node scripts/industry-delivery-release-gate.mjs /private/release.json \
  --trusted-keys /private/trusted-release-keys.json \
  --runtime /private/runtime-identity.json \
  --tenant TENANT_ID
```

CLI 还会读取 P5 证据文件并核对 SHA-256。证据相对路径按清单所在目录解析，运行环境应限制该目录的写权限。纯函数仅接收已读取的对象，便于服务在自己的配置加载边界调用；服务负责受信根来源、运行身份真实性、配置撤销和拒绝逻辑。

## Sales 接入与待验收范围

Sales 已接入本准入逻辑：`apps/api/rfq-release.ts` 的 `assertRfqRelease` 读取发布清单、受信根与实际运行身份文件，调用 `verifyReleaseGate`，并核对当前模板、渲染器、字体及 Sales 锁文件摘要。`RfqService.assertAction` 对非演示租户调用该检查；缺少配置或任何核验失败均拒绝正式出包。该实现不意味着当前存在有效的生产发布授权。

运行时门禁仍须以实际 API 与 Worker 证据证明伪造摘要、未知公钥、旧候选、过期清单、组件不匹配和越界 tenant 均被拒绝。纯函数单测、Sales 已接入或演示租户出包通过，都不能单独记为完整准入验收。最新验证与人工终止状态见[交付状态](delivery-status.md)，P5 仍为 `blocked`。

本模块没有自动签发、密钥托管、发布审批工作流或线上配置热更新服务。测试密钥仅在单元测试内存中生成，不输出到发布文件；部署方仍负责受信根、真实构建身份和发布证据的管理。
