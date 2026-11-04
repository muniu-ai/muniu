# E1 工程证据映射

本页登记 E1.1/E1.2 的局部工程证据，不修改冻结基线，不把局部通过计作 B01—U01 完整场景通过。执行结果分别见 [E1.1](../verification/enterprise-e1-1-2026-11-02.md)与 [E1.2](../verification/enterprise-e1-2-2026-11-02.md)。

| 要求 | 已实现断言与测试 | 仍需集成 |
| --- | --- | --- |
| B03 并发及批准版本 | `enterprise-event-repository.test.ts`：两个服务实例并发撤销只接受一个当前版本；`permissions.test.ts`：制单与批准分离、关键字段不可见时拒批 | E2 正式业务批准、业务金额及跨聚合事务；E3 精确执行批准 |
| A01 租户、对象与字段隔离 | `enterprise-browser.test.ts`：两个已开通租户及 cookie 篡改；`permissions.test.ts`：本人、部门、项目、订单、共享、字段交集、只读审计；`enterprise-namespace.test.ts`：新旧 PostgreSQL/S3 命名空间隔离 | 全部业务 API、检索、导出和 Web 展示 |
| A02 异步边界撤权 | 身份会话按成员 epoch 重验；角色与共享撤销、到期即时拒绝；同一事务重算当前事件后提交 | E3.2/E4 模型、工具、任务派发、成果返回及通知出站 |
| A03 注入与身份伪造 | OIDC 实际签名、nonce、受众与期限验证；租户与角色只采用明确服务端绑定；API 拒绝注入 tenant 字段 | 模型提示、资料及连接器来源注入 |
| R04 重启及投影重建 | SQLite 加密事实重放、查询投影不改变事实；`enterprise-access-e2e.mjs`：真实 PostgreSQL 双服务实例、并发写入、当前撤权及重新创建服务后重放 | 全部业务聚合、Worker 在途恢复及联合灾备 |
| P01 额度及有限执行 | `quotas.test.ts`：无额度默认拒绝、管理员不能突破平台上限、评估单次限额、过期和降额生效 | E3/E4 累计预留与费用结算、公平调度和运行槽位 |

`verify:enterprise-access` 执行真实断言，`verify:enterprise-access-postgres` 在一次性数据库中验证并发和隔离。后者通过后接入 Node CI。它们补充 E1 工程门禁，不替代冻结基线的 `verify:tenant-isolation`、`verify:agent-coordination` 或质量评测。

测试身份发行方已通过本地协议检查；真实身份发行方、Sales 与企业微信环境仍未准备。真实 PostgreSQL 与本地加密 CAS 的 E1.2 验收已通过；S3/KMS 联合恢复、容量、模型质量和试点仍需后续验收。
