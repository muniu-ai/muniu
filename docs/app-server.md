# app-server v2 接入

木牛 v0.2.0 使用 JSON-RPC app-server 作为 CLI、Desktop、Worker 协调器和嵌入式客户端的统一控制入口。HTTP 只保留健康检查、就绪检查、指标、OAuth 回调和受控内容下载，不再提供公开的控制 REST/SSE API。

## 启动本地服务

先完成构建，再选择一种传输：

```bash
npm ci
npm run build

node apps/cli/dist/index.js app-server --transport stdio
node apps/cli/dist/index.js app-server --transport unix --socket ~/.muniu/app-server.sock
node apps/cli/dist/index.js app-server --transport ws --port 0
```

`stdio` 使用一行一个 JSON-RPC 消息的 JSONL。Unix socket 只允许进程所有者访问。WebSocket 只监听回环地址，并把随机 bearer token 与实际端口写入 `~/.muniu/app-server.json`；该文件权限为 `0600`。非回环明文 WebSocket 会被拒绝。

企业部署通过 API HTTPS 监听器提供 WSS。WebSocket 升级前必须完成 OIDC/JWKS 验证；连接建立后，`tenantId`、`subject`、角色、permission profile 和 sandbox 不能扩大。方法级 RBAC、租户隔离与连接限流均在服务端执行。

## 建立连接

每个连接必须先发送 `initialize`：

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"example","version":"0.2.0"}}}
```

服务端响应包含：

- `protocolVersion: "2"`；
- `serverInfo` 和能力声明；
- 服务端实际采用的 `instructionSources`；
- `{ "protocol": "app-server-v2", "baselineCommit": "99660ab3c7b861c916e467581fa9b8723504d66b", "methodSet": "core-stable-subset" }` 兼容声明。

客户端收到响应后必须发送 `initialized` notification。握手前的其他请求会收到标准 JSON-RPC 错误；未声明的方法返回 `-32601`。协议只接受 schema 中的稳定字段，实验字段不会被忽略。

## 使用 TypeScript SDK

`@mn/sdk` 是仓库内的私有 workspace，v0.2.0 不发布 npm 包。Node.js 客户端可直接连接本机 WebSocket：

```ts
import { MuniuClient, WebSocketRpcChannel } from "@mn/sdk";

const channel = await WebSocketRpcChannel.connect(url, token);
const client = new MuniuClient({
  channel,
  clientInfo: { name: "example", version: "0.2.0" },
  approvalHandler: async (_method, _params) => ({ decision: "accept" })
});

await client.connect();
const thread = await client.startThread({
  cwd: process.cwd(),
  modelProvider: "openai",
  model: "gpt-5"
});
const turn = await thread.run({
  input: [{ type: "text", text: "检查当前变更" }]
});
await client.close();
```

浏览器使用 `BrowserWebSocketRpcChannel`。SDK 还提供 `resumeThread`、`forkThread`、`listThreads`、`runStreamed`、`steer`、`interrupt`、`setGoal`，以及 task、run、evidence、provider、extension 和 diagnostics 等类型化服务。`AbortSignal` 会中断当前 turn；结构化输出由 `outputSchema` 校验；图像、音频、skill 和路径 mention 通过 `input` 传递。

审批、补充输入、动态工具和 MCP elicitation 都由 SDK handler 回答。handler 未返回前，请求保持待处理状态；连接中断后，服务端根据 V3 事实链重建待审批 item，不会自动批准。

## 生命周期与事实链

交互状态按以下关系组织：

```text
Thread
└── Turn
    └── Item
```

Thread 是交互与执行容器。Task、Run、Candidate 和 Evidence 仍由 Spec、Governance、Harness、Loop 和 Gate 管理；两组对象只通过不可变 ID 关联。`thread/goal/*` 投影现有 Loop 目标、状态和 token budget，不建立第二套调度状态。

所有 notification 先写入 `AgentEventV3` 事实链，再发送给客户端。事件记录 sequence、因果与关联 ID、公开控制字段、受保护内容、effect commitment 和摘要链。原始 hidden reasoning 不写入日志；只有 Provider 明确返回且通过数据策略的 reasoning summary 可以形成 item。

`thread/delete` 写入 tombstone 并从普通列表隐藏，不物理删除受保留策略约束的证据和制品。协议不实现破坏历史的 rollback；从历史 turn 继续工作时使用 `thread/fork`。

## 顺序、恢复与背压

每条持久化 notification 都有 cursor。客户端重连时从最后确认的 cursor 恢复；服务端按持久化顺序重放，不能把发送顺序当作事实顺序的替代品。

单个 frame 上限为 16 MiB。每个连接的待发送队列上限为 1,024 条或 16 MiB。队列溢出时，服务端保留最后 cursor 并断开连接；已写入的事件不会丢失。大于 128 KiB 的工具输出写入 CAS，item 只保留摘要、摘要值和引用。

## 安全边界

集中 tool policy 是所有副作用的唯一入口。命令、文件、网络、MCP、动态工具和子 Agent 调用先生成 effect commitment，再检查 sandbox 与审批。授权与实际参数摘要绑定；拒绝 sandbox 时不会回退到无 sandbox 执行。

本地命令插件、JavaScript 配置和明确启用的 HMR 与宿主进程等权，属于可信代码，不是 sandbox。MCP OAuth token 只存入 vault。日志、诊断、迁移清单和审批记录使用同一数据脱敏策略；遥测默认关闭。

完整方法和事件边界见 [v0.2.0 兼容矩阵](compatibility-v0.2.md)，升级步骤见 [v0.2.0 迁移指南](migration-v0.2.md)。
