# 插件安装与运维

官方 OPC 与 Coding 插件随应用提供，首次启动按工作区启用。第三方生产插件只从受信签名仓库安装。

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

## 查看与启用

```bash
mn plugin list
mn plugin enable opc --workspace WORKSPACE_ID --version STREAM_VERSION
mn plugin enable coding --workspace WORKSPACE_ID --version STREAM_VERSION
```

安装状态包括 `installed`、`active`、`draining`、`disabled`、`revoked` 和 `failed`。工作区激活会产生领域事件，因此必须携带当前 `expectedStreamVersion`。

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
