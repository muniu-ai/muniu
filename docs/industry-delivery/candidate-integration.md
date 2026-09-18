# 候选跨仓库契约集成

## 当前验证状态

2026-09-18：运行器自检 2 项通过；默认测试中的跨仓库场景明确跳过。实际九项验收尚未完成，不计入通过数。一次实跑触发 80 秒子进程时限，总耗时约 83 秒；当时容器基线并行运行，机器负载和内存压力较高，但尚不能确认超时或业务源读取失败的唯一原因。

随后补充了阶段与部分报告保存。按用户轻量验证要求，没有继续运行 PGlite 或跨仓库测试。超时证据保留在 `/tmp/muniu-candidate-e2e-NYIVtI/`。下列内容说明运行器的设计覆盖范围，不代表九项验收已通过。

## 运行方法与覆盖范围

使用 Node.js 22.19.x，先完成 OS 标准构建，并在独立 Sales 仓库安装锁定依赖。运行器不会构建或修改两个仓库。

```sh
node scripts/industry-candidate-e2e.mjs --sales-root /absolute/path/to/muniu-ai-sales-rfq
```

默认对以下场景各运行三次，也可传 `--repetitions 1` 做单轮诊断：

| 场景 | 计划执行的检查 |
| --- | --- |
| 正常候选 | Sales 会话上传虚构文本；OS 经真实 HTTP 读取业务来源、运行固定模型流程并保护成果；Sales 经专用服务身份读取成果，再由人类请求采纳为未确认建议 |
| 排队期间撤权 | 保留 OS 工作区 owner，停用 Sales 对应成员；Worker 不调用模型，不发布候选，也不写入模型请求或预算预留 |
| 模型期间撤权 | 测试模型返回前停用 Sales 对应成员；保留一次已结算模型记录，但候选失败且无可读取成果，Sales 拒绝采纳 |

Sales 使用真实 Handler、会话、授权、迁移、来源与采纳代码，数据库为内存 PGlite。OS 使用真实 Host、Kernel、Worker、保护存储和 SQLite。来源读取与保护成果读取均经过本机 HTTP 和现有生产适配器。OS 人类身份仅由本地测试注入，不验证 OIDC。

模型调用器明确标记为 `test_fixture`，使用零费率测试报价，不读取真实模型密钥。它只返回带精确原文引用的固定示例，不评价真实模型抽取质量。子进程不继承模型、对象存储或数据库凭据，HTTP 仅允许 `127.0.0.1`。不得把此结果记作真实 PostgreSQL、模型质量实测、完整故障矩阵或客户验收。

所有状态保存在新建的 `/tmp/muniu-candidate-e2e-*` 目录。输出包含 `report.json`、进程日志、阶段和 HTTP 状态、源码提交与文件摘要，以及本地 SQLite 和加密 CAS。服务令牌和保护密钥只在子进程内存中生成；结束后保留的加密数据不保证可重新解密。

```sh
# 默认只运行运行器的自检，并明确跳过跨仓库场景。
node --test scripts/industry-candidate-e2e.test.mjs

# 设置路径后实跑三个场景，每个重复三次。
MUNIU_CANDIDATE_SALES_ROOT=/absolute/path/to/muniu-ai-sales-rfq \
  node --test scripts/industry-candidate-e2e.test.mjs
```

子进程总时限为 80 秒，外层集成测试为 90 秒。超时报告须保留；应排除机器负载等原因后按原时限重跑，不能将超时或跳过记作通过。
