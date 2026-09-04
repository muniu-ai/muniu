# OpenAPI

公共 HTTP 契约由 `@mn/contracts` 生成，版本为 `0.2.0`。运行中的 Host 在 `/v2/openapi.json` 返回 JSON；仓库中的 [静态 YAML](https://github.com/muniu-ai/muniu/blob/main/docs/reference/openapi.yaml) 供评审与工具导入。

OpenAPI 使用以下扩展：

- `x-muniu-versioned: true`：请求体必须包含 `expectedStreamVersion`；
- 所有 mutation 都声明必需的 `Idempotency-Key`；
- `409` 表示乐观并发或幂等键冲突；
- `410` 只用于事件游标已超出保留期。

生命周期、健康检查与厂商预设等只读运维路由见 [API 路由](./api-routes.md)。客户端类型与 CLI 参数必须从同一契约生成，不能维护手写分叉模型。
