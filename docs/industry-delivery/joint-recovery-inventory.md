# 联合恢复清单离线校验

`verify:joint-recovery` 校验签名清单和本地备份文件，并生成必须人工核对的 operationKey。它不执行备份、数据库恢复、解密、撤销导入或外部动作，也不批准真实租户准入。

```bash
npm run verify:joint-recovery -- CHECKPOINT.json TRUSTED_KEYS.json ARTIFACT_DIRECTORY
```

清单与文件必须来自已停止写入、只读保存的受控备份目录。可信公钥配置从当前受控配置取得，不从备份清单中自取。密钥配置沿用发布门禁的 `keys` 数组：`keyId`、`algorithm: Ed25519`、`revoked: false`、`publicKeyPem`；失效或撤销的签名密钥不得继续信任。私钥和服务凭据不放入清单。

## 清单字段

清单 `schemaVersion` 为 1，`kind` 为 `joint_recovery_checkpoint`，包含 `checkpointId`、`createdAt`、`expiresAt`、`sourceStoppedAt` 和 `signature`。时间使用带毫秒的 UTC ISO 格式。签名覆盖移除 `signature` 后按键排序的完整 JSON，沿用 `canonicalManifestPayload`；签名字段为 `algorithm`、`keyId`、Base64 `value`。

| 字段 | 必需内容 |
| --- | --- |
| `databases.agentOs`、`databases.sales` | 各自的 `restorePoint` 和备份文件 `artifact` |
| `objects` | 每项包含原始 `source`、灾备 `backup` 以及本地内容 `artifact` |
| `artifacts.release` | 对应联合发布清单 |
| `artifacts.engineLock`、`pluginLock`、`actionCatalog`、`migrations` | 版本与迁移证据 |
| `artifacts.templates`、`fonts`、`trustedRoots` | 渲染与签名核验依赖 |
| `artifacts.writerIsolation`、`keyRecovery` | 旧环境隔离记录、可恢复密钥的核验证据 |
| `artifacts.revocations`、`tombstones`、`identityFreezes` | 当前撤销、删除和身份冻结检查点 |
| `artifacts.effects`、`restoredOperations` | 独立副作用证据和恢复库中潜在在途操作的只读导出 |

每个 `artifact` 为 `{path, bytes, sha256}`；路径相对备份目录，不允许绝对路径、目录穿越或符号链接。文件按流核对长度和 SHA-256；结构化证据 JSON 上限 16 MiB。对象引用为 `{bucket, key, versionId}`。未启用版本控制时 `versionId` 明确为 null；原始对象与备份的版本号独立记录，不互相替代。相同原始 bucket/key/version 不能重复登记。

撤销、tombstone 与身份冻结证据是 `schemaVersion: 1` 的 JSON，`checkpointAt` 必须覆盖旧环境停写时刻；其余内容保存实际系统导出的记录。校验器核对时间、签名和文件完整性，不宣称这些记录已经应用到恢复环境。

`effects` 包含 `schemaVersion: 1`、`coverageStart`、`coverageEnd`、`includesActiveAtStart: true` 及 `operations`。证据须覆盖“两个恢复点中较早者至旧环境实际停写”的完整区间，同时包括区间起点已经在途的请求。`restoredOperations` 包含 `schemaVersion: 1` 和 `operations`。两份 operation 每项记录唯一 `operationKey`、`dispatchedAt`、`state`，已结束状态另需 `observedAt`；状态可为 running、unknown、succeeded、failed、cancelled。它们表示潜在外部执行，不包含尚未执行的排队意图。

## 结果解释

退出码 0 表示 `inventory_verified`。结果中的 `productionAdmission` 和 `replayAllowed` 始终为 false。所有 running/unknown、区间内启动的操作，以及在区间内才收到结果的操作都进入核对清单；包括源环境已经完成、却可能随数据库回退丢失的操作。

清单签名是可信签署者对检查点和证据完整范围的声明，不是独立测得的复制完整性。仍须执行两库、对象、密钥的隔离恢复，导入当前撤销与删除事实，再逐项核对副作用。证据缺失时保持相关范围冻结。实际 RPO/RTO、72 次故障矩阵和 P5 不因本校验通过而完成。

本地测试使用合成签名及文件，覆盖摘要篡改、证据缺失、路径越界、撤销密钥、过期签名、陈旧撤销检查点、窗口缺口和晚到效果。未连接生产服务或使用真实备份。
