# `@mn/worker`

木牛 Agent OS 0.2 的持久任务执行器。Worker 只从新存储端口 claim Job，使用 30 秒租约和 fencing token 提交结果。无法确认结果的外部副作用进入人工核对，不会自动重放。
