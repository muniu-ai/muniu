# `mn` 命令行

`@mn/cli` 是木牛 Agent OS 0.2 的类型化命令宿主，只调用 Host 的 `/v2` 接口。默认输出适合直接阅读，`--json` 提供稳定的机器格式。

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

外部 Coding Runner 只支持官方原生安装提供的 macOS Mach-O CLI，不支持 npm 或 shebang wrapper。Host 确认阶段不会执行目标路径；确认后，Worker 才会把已确认制品复制到其管理的只读目录，并在受限环境中探测版本。

完整参数、退出码和 JSON 格式见 [CLI 参考](../../docs/reference/cli.md)。

## 本地开发

先在仓库根目录启动 Host：

```bash
npm run dev:host
```

另开终端构建并运行 CLI：

```bash
npm run dev:cli -- --help
npm run dev:cli -- doctor --fix
```

默认连接 `http://127.0.0.1:7318`。需要改用其他 Host 时设置 `MN_API_URL`。

## 验证

```bash
npm run typecheck -w @mn/cli
npm run test -w @mn/cli
```

不要通过 CLI 参数传递模型密钥。模型连接应由 Desktop 向导创建，密钥由 Host 写入 Keychain 或企业密钥系统。
