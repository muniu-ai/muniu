# `mn` 命令行

`@mn/cli` 是木牛 Agent OS 0.2 的命令行 Shell。业务命令调用 Host 的 `/v2` 接口；`backup` 直接使用本地存储和 Keychain。默认输出适合直接阅读，`--json` 提供机器格式。

命令解析、HTTP 客户端与本地备份入口位于 [src/index.ts](src/index.ts)，契约客户端来自 `@mn/contracts`。CLI 不装配产品插件或 Kernel。

## 命令面

```text
mn setup
mn ask
mn inbox
mn resume
mn doctor --fix
mn plugin ...
mn opc ...
mn code ...
mn goal ...
mn asset ...
mn business context ...
mn backup ...
```

`setup` 负责视图、插件、模型与工作区设置；`inbox` 汇总审批、Agent 问题、凭据失效、执行失败和人工核对。OPC 与 Coding 子命令只封装插件领域路由，不能绕过内核审批或代替人工确认。

`mn ask <问题> --workspace <工作区 ID>` 会自动选择工作区最近的机会或 Coding 任务会话。有多个机会时，可用 `--opportunity <标题关键词>` 选择，无需查找 Thread ID。

外部 Coding Runner 只支持官方原生安装提供的 macOS Mach-O CLI，不支持 npm 或 shebang wrapper。Host 确认阶段不会执行目标路径；确认后，Worker 才会把已确认制品复制到其管理的只读目录，并在受限环境中探测版本。

完整参数、退出码和 JSON 格式见 [CLI 参考](../../docs/reference/cli.md)。

## 资料与业务上下文

```bash
mn asset upload --workspace WORKSPACE_ID --file ./资料.docx --key MATERIAL_REQUEST_ID --json
mn asset extract ASSET_ID --json
mn business context customer CUSTOMER_ID --workspace WORKSPACE_ID --json
```

资料上传始终使用受保护 Asset，支持 TXT、Markdown、CSV、JSON、PDF、DOCX 和 XLSX，每份不超过 20 MB。上传返回 `asset` 和 `sourceRef`；将 `sourceRef` 加入 `mn goal create --file` 输入的 `resourceRefs`，无需把资料全文复制到 `objective`。`digest` 原样取 Host 返回值，不使用本地文件摘要替代。

团队执行需要显式选择。先用 `mn goal templates --workspace <id>` 查看可用模板，再用 `mn goal plan <goal-id> --workspace <id> --version <版本> --team research-summary --model <连接-id>` 生成待审阅计划。模板还包括 `business-proposal` 和 `code-delivery`，首版均使用内置模型。省略 `--team` 时沿用单 Agent 调度。

`mn goal nodes <goal-id> --workspace <id>` 返回步骤、尝试记录和当前允许的操作。团队可用 `goal pause`、`goal resume` 控制；人工节点使用 `goal decide --node <节点-id> --decision continue|stop`。变更仍须指定目标、工作区及 `--version`，计划和执行控制可附 `--key`，响应丢失时用原参数与原键重试。结果未知时按 Host 提供的核对方式处理。

`--key` 是这次上传的请求标识。响应丢失时保持文件、工作区和标识不变，重新运行同一命令；CLI 不自动重发。省略时按既有约定生成随机请求标识。提取结果保留 `complete`、`partial` 或 `unreadable` 状态、遗漏说明与页码、段落或单元格位置，提取成功不代表 Agent 已阅读全部资料。

业务上下文支持 `customer`、`order`、`delivery` 和 `review`，返回当前授权下的事实正文与版本引用。资料或经营记录变化后，应重新读取并审阅计划；读取上下文不修改经营台账。已有 `mn opc business show` 和 `command` 保持原语义。

## 本地开发

先按[贡献指南](../../CONTRIBUTING.md)准备 Node.js 22.19.x、npm 11.10.1 并执行 `npm ci`。需要调用业务命令时，在仓库根目录启动 Host：

```bash
npm run dev:host
```

另开终端构建并运行 CLI：

```bash
npm run dev:cli -- --help
npm run dev:cli -- doctor
```

默认连接 `http://127.0.0.1:7318`。需要改用其他 Host 时设置 `MN_API_URL`。`doctor` 读取健康与就绪状态；`doctor --fix` 还会重新探测未就绪的模型连接并更新状态，可能访问模型服务。

`backup` 使用 `MN_V2_STATE_ROOT` 指定的本地状态根，默认是 `~/.muniu/v2`；它不受 `MN_API_URL` 影响。备份与恢复的前置条件见 [CLI 参考](../../docs/reference/cli.md)。

## 验证

先在仓库根目录完成 `npm run build`，再执行：

```bash
npm run typecheck -w @mn/cli
npm run test -w @mn/cli
```

不要通过 CLI 参数传递模型密钥。模型连接应由 Desktop 向导创建，密钥由 Host 写入 Keychain 或企业密钥系统。
