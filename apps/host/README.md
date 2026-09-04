# `@mn/host`

木牛 Agent OS 0.2 的唯一组合根。它用 Cordis 组合内核与产品插件，只暴露 `/v2` API。

本地 profile 的权威状态位于 `~/.muniu/v2`；企业 profile 通过注入的 PostgreSQL 与 S3 端口运行。Host 不读取、迁移或删除 0.1 状态。
