# `mn`

木牛 Agent OS 0.2 命令行宿主。命令面固定为 `setup`、`ask`、`inbox`、`resume`、`doctor`、`plugin`、`opc`、`code` 和 `backup`。

默认输出面向用户；`--json` 输出固定机器格式。CLI 只连接 `/v2`，不会读取或迁移 0.1 状态。
