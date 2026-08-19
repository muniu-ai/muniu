# 架构

## 运行闭环

```mermaid
flowchart LR
  T[Task + Strategy V2] --> R[Run]
  R --> C1[Candidate + Session]
  R --> C2[Candidate + Session]
  C1 --> G[Gate Registry]
  C2 --> G
  G -->|失败原因| C1
  G -->|通过| S[评分与选择]
  S --> E[Evidence + Audit]
```

每个 candidate 拥有 `AgentExecutionBindingV1`，其中绑定 session、runtime、provider/model、Harness、治理策略、effect policy 和 sandbox capability 摘要。

## Cordis 生命周期

```mermaid
sequenceDiagram
  participant B as bootstrap
  participant C as Cordis Context
  participant P as plugin
  B->>C: load ordered profile layers
  C->>P: inject services + apply
  P-->>C: register effects/events
  C-->>B: runtime snapshot + digest
  B->>C: reload/dispose
  C->>P: cleanup effects in reverse order
```

API、Worker、Desktop 使用独立根 Context；每个 Agent session 再隔离 `agentHost`、`agentSession`、`toolRegistry` 和 `modelRuntime` 服务。

## 数据流

```mermaid
flowchart TB
  U[User/API] --> A[AgentHost]
  A --> M[Model provider]
  M --> A
  A --> P[Policy + Approval]
  P --> T[Workspace tools]
  T --> W[Candidate workspace]
  W --> G[Gates]
  G --> O[Object storage]
  A --> S[Session store]
  S --> PG[(PostgreSQL index)]
  S --> O
```

企业会话把事件索引、序号和摘要存入 PostgreSQL；受保护事件与模型运行时 overlay 写入 S3。读取时同时验证对象大小、SHA-256、事件摘要和链。

## 插件信任边界

```mermaid
flowchart LR
  Admin -->|install exact version/hash| Plugin
  Plugin --> Host[Muniu process]
  Host --> Secrets
  Host --> Filesystem
  Host --> Network
```

插件不是沙箱。第三方插件拥有宿主进程权限，必须由管理员显式信任。

## Kubernetes 拓扑

```mermaid
flowchart LR
  Ingress --> API1[API]
  Ingress --> API2[API]
  API1 --> PG[(PostgreSQL)]
  API2 --> PG
  API1 --> S3[(S3)]
  Worker1 --> API1
  Worker2 --> API2
  API1 -->|model stream; credentials stay here| Provider[Model Provider]
  API1 -->|bounded tool call/result| Worker1
  API1 --> PVC[(Shared workspace PVC)]
  Worker1 --> PVC
  Worker1 -->|create / inspect / exec / delete| Pod[Candidate sandbox Pod]
  API1 -->|independent inspect| Pod
  API1 -->|create / exec / delete| GatePod[Immutable authority Gate Pod]
  PVC --> Pod
  PVC --> GatePod
```

源码由 API 写入 S3 内容寻址存储，Worker 凭活跃 claim 下载并校验后物化到共享 PVC。builtin 模型流在 API 内执行，Provider 凭据不下发；模型请求的读取、搜索、补丁、写入和命令通过活跃 claim 绑定的工具协议交给 Worker，并只在同一已检查 Pod 中执行。未确认的工具调用使用同一 `callId` 重投，Worker 缓存结果，API 仅接受内容一致的幂等提交。候选 Pod 不读取 S3、不挂载 Kubernetes token，也没有默认网络。Worker 只控制候选 Pod；API 使用独立 RBAC 再次验证实际 Pod，并在第二个只读 Pod 中权威重放 Gate。

当前工具 broker 的活动执行状态仍在单个 API 进程内，跨 API 副本的 PostgreSQL broker 与故障接管尚未完成；因此该路径继续标记为实验性，不能宣称已通过多副本发布验收。Kind + Calico 探针验证的是 Pod 隔离契约。
