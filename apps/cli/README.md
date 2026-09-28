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
mn backup ...
```

`setup` 负责视图、插件、模型与工作区设置；`inbox` 汇总审批、Agent 问题、凭据失效、执行失败和人工核对。OPC 与 Coding 子命令只封装插件领域路由，不能绕过内核审批或代替人工确认。

`mn ask <问题> --workspace <工作区 ID>` 会自动选择工作区最近的机会或 Coding 任务会话。有多个机会时，可用 `--opportunity <标题关键词>` 选择，无需查找 Thread ID。

外部 Coding Runner 只支持官方原生安装提供的 macOS Mach-O CLI，不支持 npm 或 shebang wrapper。Host 确认阶段不会执行目标路径；确认后，Worker 才会把已确认制品复制到其管理的只读目录，并在受限环境中探测版本。

完整参数、退出码和 JSON 格式见 [CLI 参考](../../docs/reference/cli.md)。

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
