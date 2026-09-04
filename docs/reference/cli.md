# CLI 参考

`mn` 默认输出面向用户的简短结果；`--json` 输出稳定机器格式。CLI 连接 `MN_API_URL`，未设置时使用 `http://127.0.0.1:7318`。

<!-- generated:cli-help:start -->

```text
木牛 Agent OS 0.2

用法：mn <命令> [参数]

命令：
  setup             完成视图、插件、模型和工作区设置
  ask               在当前工作区提交问题
  inbox             查看审批、问题、失败和人工核对
  resume            恢复暂停或中断的执行
  doctor --fix      检查连接与可安全修复项
  plugin            查看、启用、停用或清除插件
  opc               管理机会验证工作
  code              管理 Coding 任务
  backup            创建、校验或恢复本地加密备份

全局参数：
  --json            输出稳定 JSON
  --help            显示帮助

备份示例：
  mn backup create state.mnbackup --verify
  mn backup check state.mnbackup
  mn backup restore state.mnbackup --destination restored.sqlite3

外部 Coding Runner：
  mn code runners --workspace <工作区 ID>
  mn code runner inspect claude-cli --workspace <工作区 ID> --path /绝对路径/claude
  mn code runner confirm claude-cli --workspace <工作区 ID> --path /绝对路径/claude --binary-version <版本> --sha256 <摘要> --version <配置版本>
  mn ask <任务> --workspace <工作区 ID> --thread <会话 ID> --runner claude-cli
```

<!-- generated:cli-help:end -->

## 设置

```bash
mn setup \
  --view business \
  --plugins opc,coding \
  --workspace "我的工作区" \
  --first "独立顾问需要更快整理访谈证据"
```

`--view` 接受 `business` 或 `professional`，`--plugins` 只接受 `opc`、`coding` 或两者。推荐在 Desktop 向导中连接模型；不要把 API Key 放入命令行参数或脚本。

## 会话与收件箱

```bash
mn ask "整理证据缺口并给出下一步" \
  --workspace WORKSPACE_ID \
  --thread THREAD_ID \
  --version STREAM_VERSION

mn inbox --workspace WORKSPACE_ID
mn resume EXECUTION_ID --version STREAM_VERSION
```

`ask` 提交新 turn，`resume` 只恢复 `paused` 或 `interrupted` 的执行。审批与 `needs_reconciliation` 应在收件箱中明确处理，不能用 `resume` 绕过。

Coding 会话默认使用 `builtin`。只有显式传入 `--runner claude-cli` 或 `--runner codex-cli` 时，Host 才会选择外部 Runner；其他插件的会话拒绝该参数。

## 健康检查

```bash
mn doctor --fix
```

命令检查 Host health 与 readiness。`--fix` 只执行可恢复的本地修复，不会替用户批准高风险工具、删除状态或重放未知结果的外部调用。

## 插件

```bash
mn plugin list
mn plugin enable opc \
  --workspace WORKSPACE_ID \
  --version STREAM_VERSION

mn plugin deactivate opc \
  --workspace WORKSPACE_ID \
  --version WORKSPACE_STREAM_VERSION

mn plugin disable research --version INSTALLATION_STREAM_VERSION
mn plugin purge research --version INSTALLATION_STREAM_VERSION
```

`deactivate` 只修改指定工作区。`disable` 全局停止插件接收新任务，排空执行并从所有工作区停用。`purge` 还会移除安装态与可重建投影，因此只能用于没有活动工作区和未终结 Execution 的非活动插件。事实事件不会被删除。

安装第三方插件前应在 Desktop 中审阅签名、摘要、来源、权限与进程等价信任边界。生产插件与 Host 同进程运行，不是沙箱。

## OPC 与 Coding

```bash
mn opc capture \
  --workspace WORKSPACE_ID \
  --version STREAM_VERSION \
  --input "访谈整理耗时且容易丢失反证"

mn code task \
  --workspace WORKSPACE_ID \
  --version STREAM_VERSION \
  --input "为事件游标过期补充回归测试"
```

第一个位置参数是插件命令；CLI 将其发送到 `/v2/plugins/{pluginId}/{path}`。领域对象仍由插件校验，CLI 不代替人工确认承诺、付费证据、最终机会决策或高风险代码审批。

### 外部 Coding Runner

先检查本机二进制，再由工作区 owner 对照检查结果确认版本与 SHA-256：

```bash
mn code runners --workspace WORKSPACE_ID

mn code runner inspect claude-cli \
  --workspace WORKSPACE_ID \
  --path /opt/homebrew/bin/claude \
  --json

mn code runner confirm claude-cli \
  --workspace WORKSPACE_ID \
  --path /opt/homebrew/bin/claude \
  --binary-version VERSION_FROM_INSPECTION \
  --sha256 SHA256_FROM_INSPECTION \
  --version RUNNER_CONFIGURATION_STREAM_VERSION

mn ask "修复事件游标" \
  --workspace WORKSPACE_ID \
  --thread CODING_THREAD_ID \
  --runner claude-cli \
  --version THREAD_STREAM_VERSION
```

`inspect` 不启用 Runner。`confirm` 会在同一次请求中重新读取绝对真实路径、版本、SHA-256 和文件身份；检查结果与提交值不一致时拒绝确认。Worker 在每次启动前再次检查身份。二进制变化后，旧确认不再有效。

Claude 与 Codex CLI 使用各自已有的登录、provider 和 MCP 配置。木牛只调用适配器的 `start/events/cancel/resume`，不会向外部 Runner 注入木牛的 BYOK 密钥、Prompt 注册表、Skill 或历史会话。每次外部启动仍需单次副作用审批；结果无法确认时进入 `needs_reconciliation`，不会自动重放。

## 备份

```bash
mn backup --output ./muniu-v2-backup.mnbackup --verify
```

本地备份把一致的 SQLite 快照与 `~/.muniu/v2/cas` 对象封装为同一个 AES-256-GCM 加密包，并记录数据库、每个 CAS 对象和完整负载的摘要。恢复采用 create-only 语义，同时还原数据库与独立 CAS 目录；切换前应在隔离目录复核事件 HMAC、CAS 摘要和 Keychain 可用性。

## JSON 与退出码

成功输出：

```json
{"ok":true,"command":"inbox","data":[]}
```

失败输出会包含稳定 `code`、`message`、`action` 和 `retryable`，不输出 trace ID 或字段内容到普通脚本结果。退出码：

- `0`：成功；
- `1`：可重试的 Host 或网络失败；
- `2`：参数错误或不可重试的 API 错误。
