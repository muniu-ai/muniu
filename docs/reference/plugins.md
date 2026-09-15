# 插件安装与运维

官方 OPC 与 Coding 插件随应用提供，首次启动按工作区启用。第三方生产插件只从受信签名仓库安装。

当前 Host 的生产安装入口只读取组合根提供的本地签名制品，不接受调用方传入下载地址或代码。安装请求必须同时给出插件 ID 和精确版本。仓库验签、整包摘要及包内资源摘要、声明入口和生命周期校验通过后，Host 会在同一事务写入 installation、已接受的仓库序号、plugin lock、审计事件与幂等结果，然后才注册运行贡献。UI、CLI 与 Worker 入口也来自同一已验签归档，不允许用未签名旁路资源替换。

## 内置目录

下表从 `plugins/*/package.json` 生成。

<!-- generated:plugin-catalog:start -->

| 插件 ID | 包 | 版本 | 类型 | 启用方式 |
| --- | --- | --- | --- | --- |
| `coding` | `@mn/plugin-coding` | `0.2.0` | 产品插件 | 随应用提供，按工作区启用 |
| `opc` | `@mn/plugin-opc` | `0.2.0` | 产品插件 | 随应用提供，按工作区启用 |
| `runner-claude-cli` | `@mn/runner-claude-cli` | `0.2.0` | Runner Adapter | 可选，必须显式选择 |
| `runner-codex-cli` | `@mn/runner-codex-cli` | `0.2.0` | Runner Adapter | 可选，必须显式选择 |

<!-- generated:plugin-catalog:end -->

## 查看、启用、停用与清除

```bash
mn plugin list
mn plugin enable opc --workspace WORKSPACE_ID --version STREAM_VERSION
mn plugin enable coding --workspace WORKSPACE_ID --version STREAM_VERSION
mn plugin deactivate research --workspace WORKSPACE_ID --version WORKSPACE_STREAM_VERSION
mn plugin disable research --version INSTALLATION_STREAM_VERSION
mn plugin purge research --version INSTALLATION_STREAM_VERSION
```

安装状态包括 `installed`、`active`、`draining`、`disabled`、`revoked` 和 `failed`。工作区激活会产生领域事件，因此必须携带当前 `expectedStreamVersion`。

`deactivate` 只停用一个工作区，并调用该工作区已经激活的插件 `deactivate` hook。`disable` 先阻止新任务并排空未终结 Execution，再调用所有已激活工作区的 hook；工作区、installation、生命周期、plugin lock、审计事件与幂等结果在同一事务更新。hook 属于同进程可信代码；hook 失败会记录插件故障，但不能阻止安全停用。

`purge` 只接受没有活动工作区和未终结 Execution 的非活动安装。操作保留既有事实事件与事件流版本，只删除安装态、可重建投影、进程内贡献和本地制品引用。默认内核投影管理器在同一事务中清除该插件全部历史投影。重新安装会从保留的事实重建数据，且不能低于此前接受的发布序号、删除或重定义已有事件类型。

## 仓库校验

安装与更新必须同时满足：

- Ed25519 签名来自受信 key；
- release sequence 高于已经接受的序号；
- 发布元数据未过期，撤销元数据不超过 24 小时；
- 包和每个依赖的 SHA-256 匹配；
- 依赖版本精确，不含范围或浮动标签；
- 来源为 HTTPS，不含安装 hook 或远程 JavaScript；
- 不允许摘要算法降级或旧 release 回滚。

撤销元数据过旧时，Host 拒绝安装和更新，但已安装插件仍可离线启动。key rotation 必须由现有受信 key 或离线根信任授权，且保留完整审计链。

离线启动只恢复 plugin lock 中版本、发布序号和包摘要完全一致的本地制品。Host 会重新校验仓库签名、制品签名、包摘要、已知撤销项和 lock；不一致的插件进入 `failed` 或 `revoked`，不会阻止核心页面和其他插件启动。

## 升级

1. 将插件标记为 `draining`，停止接收新执行。
2. 等待活动执行到达安全边界。
3. 在独立投影 namespace 重放全部相关事件。
4. 运行投影校验和插件健康检查。
5. 原子切换安装记录、lock 摘要和投影读取指针。

重放或校验失败时保留当前版本，不切换读指针。新版本写入事件后不能自动降级，因为旧代码可能不理解新事件。被撤销的插件停止接收新任务，活动执行在安全边界中断。

## 故障隔离

插件调用与健康检查在对应 Scope 内管理。单个插件降级时，Host 的 readiness、首页、收件箱、设置和其他插件路由仍应可用。运维人员通过 `/v2/health?workspaceId=...` 查看工作区插件状态，并结合活动与审计事件定位失败 generation。

## 开发模式

开发模式允许绝对本地路径和 localhost HMR。它不改变进程等价的信任边界，界面必须持续显示警告。生产构建只能加载已验证的本地同源资源，并应用严格 CSP。

开发插件发布前必须退出开发模式，生成确定性包摘要，补齐签名、精确依赖、权限、事件 schema 与两种数据库投影定义。
