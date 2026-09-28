# 使用 CLI

CLI 与 Desktop 连接同一 Host。CLI 不会自动启动 Host；业务命令通常需要工作区 ID。以下命令在仓库根目录执行，适用于已经完成 `npm ci` 的源码目录。

## 连接本机 Host

已经通过[快速开始](../quickstart.md)启动 Desktop 时，直接在另一个终端使用 CLI。不要再启动第二个 Host。

只使用 CLI 时，在第一个终端执行：

```bash
npm run dev:host
```

该命令先构建项目，再启动 Host。看到“木牛 Agent OS 0.2 已启动”后，保持终端运行。在第二个终端进入同一仓库根目录，执行：

```bash
node apps/cli/dist/index.js --help
node apps/cli/dist/index.js doctor
node apps/cli/dist/index.js plugin list --json
```

`doctor` 应显示“Host 已就绪”。上述三项不创建业务对象，也不探测模型连接。`doctor --fix` 会重新探测未就绪的模型连接，需要时再执行。

CLI 默认连接 `http://127.0.0.1:7318`。`MN_API_URL` 可指定已经部署的其他 Host 地址，但不会启动服务或提供远端认证配置。本文使用本机默认地址。

## 无模型密钥的首次练习

下面的命令会写入本机状态，创建练习工作区、OPC 机会和样例完成事件，但不调用模型。不要反复执行 `setup` 来查询已有工作区；每次执行都可能创建新对象。

```bash
node apps/cli/dist/index.js setup \
  --view business \
  --plugins opc \
  --workspace "CLI 练习" \
  --first "独立顾问需要更快整理访谈证据" \
  --json
```

成功输出包含 `ok: true`、`data.workspace.id`、`data.firstObject` 和 `data.sample.status: "completed"`。样例只记录本地检查结果，不验证模型或真实网页读取能力。

将返回的工作区 ID 填入变量后，读取刚创建的内容：

```bash
WORKSPACE_ID='替换为 data.workspace.id'
node apps/cli/dist/index.js opc list --workspace "$WORKSPACE_ID" --json
node apps/cli/dist/index.js inbox --workspace "$WORKSPACE_ID" --json
```

如果忘记工作区 ID，可通过只读 API 查询：

```bash
curl --fail --silent --show-error http://127.0.0.1:7318/v2/workspaces
```

无模型密钥时，可以继续登记仓库、创建 Coding 任务及使用 OPC 的手工记录命令。向 Agent 发送消息需要可用模型连接；不能把创建对象或完成样例当成 Agent 已执行。模型密钥应通过 Desktop 输入，不要放入命令行或脚本。CLI 创建工作区不会跳过 Desktop 自身的首次向导。

## 为脚本或 Agent 读取状态

在命令末尾添加 `--json`：

```bash
node apps/cli/dist/index.js doctor --json
node apps/cli/dist/index.js plugin list --json
node apps/cli/dist/index.js code repositories --workspace "$WORKSPACE_ID" --json
```

成功响应格式为 `{ "ok": true, "command": "…", "data": … }`；失败响应包含 `ok: false` 和 `error`。其中 `error` 提供错误码、处理建议、`traceId` 和是否可重试。退出码 `0` 表示命令完成，`1` 表示可重试错误或未预期错误，`2` 表示用法错误或不可重试错误。

`doctor` 即使报告未就绪，也可能以退出码 `0` 返回。自动化必须检查 `data.readiness.ready` 和 `data.readiness.issues`，不能只看退出码或 `ok`。

## 区分读取、记录与执行

| 目的 | 命令 | 影响 |
| --- | --- | --- |
| 查询状态 | `doctor`、`inbox`、`plugin list`、`opc list`、`code repositories` | 只读请求 |
| 建立对象 | `setup`、`opc capture`、`code repository`、`code task` | 写入业务状态；不等于 Agent 执行 |
| 运行样例 | `opc sample`、`code sample` | 写入样例完成事件 |
| 请求 Agent 工作 | `ask` | 创建或推进执行，可能调用模型和工具 |
| 处理现有执行 | `resume` 等 | 依赖当前状态、版本及审批条件 |

CLI 为写请求生成幂等键；更新已有对象时还要使用最新版本。发生冲突或外部结果未知时，不要直接重复运行命令，按[故障排查](../troubleshooting.md)处理。

完整参数与领域命令见 [CLI 参考](../reference/cli.md)。参考中的 `mn` 是已安装 CLI 的命令名；源码使用时将其替换为 `node apps/cli/dist/index.js`。
