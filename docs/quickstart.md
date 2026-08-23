# 快速开始

## 环境

- Node.js 22.19.x
- npm 11.10.1
- Git

```bash
npm ci
npm run build
node apps/cli/dist/index.js app-server --transport ws --port 0
```

app-server 只监听回环地址，并把连接信息写入 `~/.muniu/app-server.json`。另开终端执行：

```bash
node apps/cli/dist/index.js init
node apps/cli/dist/index.js provider add --preset deepseek --api-key-env OPENAI_API_KEY
node apps/cli/dist/index.js agent run \
  --provider PROVIDER_ID --model MODEL_ID \
  --prompt "为当前仓库补一个聚焦测试" --cwd .
```

`agent run` 通过 TypeScript SDK 创建 Thread/Turn/Item，并把模型、工具、审批、命令、Gate 和证据绑定到同一事实链。默认不查找 Claude/Codex CLI。

## 常用检查

```bash
mn agent sessions
mn profile inspect
mn plugin list
mn doctor
```

本地状态位于 `~/.muniu`。不要把目录中的凭据、日志、会话或插件清单提交到 Git。

升级已有状态前先阅读 [v0.2.0 迁移指南](migration-v0.2.md)。
