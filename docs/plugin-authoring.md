# 插件开发

Agent OS 0.2 插件通过 `@mn/plugin-sdk` 贡献产品能力，通过 `@mn/contracts` 使用公共数据类型。产品插件不得依赖内核实现，也不得导入其他产品插件。

## 信任边界

生产插件与 Host 同进程运行，可使用宿主进程能访问的文件、网络和凭据。签名、权限声明与 `ExecutionAuthority` 约束安装流程、Agent 和经内核调用的工具，但不能把恶意同进程代码变成沙箱。

安装界面必须明确显示：

- 发布者、版本、许可证和来源；
- 包 SHA-256、签名 key 与 release sequence；
- 请求的权限、effect class 和数据 namespace；
- 插件与宿主进程权限等价。

需要隔离不受信代码时，应通过 Coding sandbox 或独立服务边界执行，不应把它作为进程内插件加载。

## 包结构

插件发布物是一个 UTF-8 JSON 归档；归档本身的字节摘要写入 `packageSha256`，清单再整体使用 Ed25519 签名。归档内每个文件同时记录 SHA-256，Host 只有在仓库、清单、整包和全部声明资源都通过校验后，才读取入口字节。归档可以提供以下入口：

```text
plugin/
├── host.mjs
├── worker.mjs
├── ui.mjs
└── cli.mjs
```

入口是包内相对路径，只允许 `.js`、`.mjs`、`.css`、`.json` 或 `.sql`；Host、Worker 和 CLI 入口必须是 JavaScript 模块。归档拒绝重复路径、非规范 Base64、摘要不一致、缺失入口、绝对路径、路径逃逸、安装 hook 和远程 JavaScript。UI、CLI 与 Worker 组合根从同一个已验签归档读取各自入口，不直接 `import` 仓库路径。

## `PluginManifestV1`

清单包含以下字段：

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 固定为 `1` |
| `id`、`version`、`engineApi` | 插件身份、精确版本与宿主 API 范围 |
| `displayName`、`description` | 安装与设置页面显示的信息 |
| `entrypoints` | 可选的 host、worker、ui、cli 包内入口 |
| `contributes` | routes、navigation、widgets、commands、agents、skills、workflows、tools、memorySchemas、healthCheck |
| `permissions` | 权限标识、effect class、用途与是否必需 |
| `dataNamespace` | 插件私有数据范围 |
| `eventSchemas` | 插件事件的 JSON schema |
| `projections` | SQLite/PostgreSQL 投影 namespace 与入口 |
| `dependencies` | 依赖插件的精确版本与 SHA-256 |
| `packageSha256` | 插件包 SHA-256 |
| `signature` | Ed25519 算法、key ID 与签名值 |
| `release` | 单调 sequence、发布时间、过期时间与 HTTPS 来源 |
| `license`、`homepage` | 许可证与可选主页 |

版本不得使用范围或浮动标签。依赖项必须同时固定版本和摘要。已经发布的事件类型不能改变原有含义；需要新结构时应发布新的事件类型。

## 定义贡献

`PluginDefinitionV1` 的标识和版本必须与签名清单一致，`trustBoundary` 固定为 `process_equivalent`。贡献 ID 在同类中唯一，清单声明与运行时定义必须逐项一致。

```ts
import type { PluginDefinitionV1 } from "@mn/plugin-sdk";

export const plugin: PluginDefinitionV1 = {
  id: "example.product",
  version: "0.2.0",
  official: false,
  trustBoundary: "process_equivalent",
  contributions: {
    routes: [{ id: "example.items", path: "/example/items" }],
    navigation: [{ id: "example.nav", label: "示例", routeId: "example.items" }],
    widgets: [],
    commands: [],
    agents: [],
    skills: [],
    workflows: [],
    tools: [],
    memorySchemas: [],
  },
};
```

插件只能贡献二级路由和首页/工作区组件，不得覆盖首页、工作区、收件箱、成果、活动、Agents、集成或设置。全局审批、安全与设置页面由 Shell 管理。

Skill 应显示预期成果、示例输入、来源、许可证、版本、权限和安装结果。Tool 必须声明稳定标识、版本和 effect class。Workflow 只声明类型化状态与转移，不能携带任意脚本求值逻辑。

## 数据与记忆

- 领域事件写入插件自己的 namespace，通过 `expectedStreamVersion` 参与乐观并发。
- SQLite 和 PostgreSQL 投影使用独立 namespace，不能直接修改其他插件表。
- 记忆使用 `scopeType + namespace + resourceId`。跨 namespace 默认不可见，只有有效的 `ShareGrant` 才能读取。
- 敏感字段放入加密 payload 或 CAS，不得复制到公开事件、日志或搜索索引。

## 生命周期

安装或升级按以下顺序完成：

1. 校验仓库元数据时效、撤销表、签名、release sequence、摘要和精确依赖。
2. 将包按摘要写入本地存储，不执行安装 hook。
3. 排空插件的活动 Execution。
4. 在新投影 namespace 重放事件并校验结果。
5. 原子切换版本与投影，记录审计事件。

插件产生新事件后不支持自动降级。撤销的插件不再接收新任务，活动任务在下一个安全边界进入中断状态。插件健康检查失败时，只将该插件标为 degraded；核心页面和其他插件继续工作。

## 开发模式

开发模式可从绝对本地路径加载资源，并允许 localhost HMR。界面必须持续显示开发警告，审计记录每次装载、卸载和配置变更。生产 CSP 只加载已验证的同源本地资源，并禁止 object、frame、base 和 form。

提交前至少运行插件单元测试、投影重放测试、供应链测试、`npm run verify:plugins` 与 `git diff --check`。
