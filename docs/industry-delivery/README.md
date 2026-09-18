# 工业询价交付验收包

本目录供实施者和验收人员核对版本、资料授权、报价正确性与故障处理。样本校验通过仅证明验收包自身一致；产品执行、企业部署、竞品表现和客户收益分别记录。

## 范围和状态

参考应用限定为工业阀门询价资料整理、内部报价管理和批准版本的文件导出。发送报价由人工完成。样本中的产品、客户、参数、价格和商务规则均为虚构，不用于实际采购、选型或报价。

| 工作包 | 本目录交付 | 依赖 | 当前状态 |
| --- | --- | --- | --- |
| P0 | 两仓库完整基线、锁文件摘要和工具链记录 | 可读取固定 Git 对象 | 基线已记录；不代表两仓库测试通过 |
| P2 | 60 个版本化样本、预期来源与金额、20 个留出样本 | 合成资料，无客户授权依赖 | 样本完整性可校验；行业专家复核未执行 |
| P4 | 12 类故障、每类 API 与 Worker 各 3 次 | 实际服务入口与可注入环境 | 72 次执行均为 `not_run` |
| P5 | 发布清单模板、源授权台账、企业部署与恢复验收要求 | 产品测试、生产依赖、恢复证据 | `blocked`；新真实租户默认关闭 |
| P6 | 固定工作流、木牛、DSH、ADP 结果契约与汇总脚本 | 冻结配置及实际执行环境 | 对照未执行；不存在领先结论 |
| P7 | 真实客户验证条件 | 真实资料授权、业务负责人、验收与付费证据 | `blocked`；尚无客户样本 |

## 使用

从仓库根目录执行，使用 Node.js 22.19.x 与 npm 11.10.1：

```bash
node scripts/industry-delivery-validate.mjs
node --test scripts/industry-delivery-assets.test.mjs
node scripts/industry-delivery-summary.mjs fixtures/industry-delivery/v1/benchmark-results.template.json
node scripts/industry-delivery-release-gate.mjs docs/industry-delivery/release-manifest.template.json
```

最后一条命令应退出失败，说明模板缺少发布证据，不能授权真实租户。它是独立验收工具，不替代服务运行时门禁；运行时实现须另行测试。

开发默认使用 40 个 `development` 样本。不得将 20 个 `holdout` 样本输入提示词示例、规则调试或实现优化。冻结代码提交、模型、提示词、规则及配置摘要后再由验收执行者选择留出样本。文件保存在仓库中，因此这里只提供流程限制，没有实现访问隔离；泄漏后必须记录并建立新的独立评估集。

如需重新生成样本，执行 `node scripts/industry-delivery-generate-fixtures.mjs`。该命令会重写 `v1` 固定样本；评估开始后禁止修改 `v1`，新样本应使用新版本目录与新生成器版本。

## 文件

- [P0 基线](p0-baselines.json)：固定基线及捕获时工作树状态。
- [样本与故障规范](acceptance.md)：预期结果、异常测试和证据要求。
- [对照契约](comparison.md)：同场比较、状态语义及汇总方法。
- [发布清单模板](release-manifest.template.json)：联合版本和技术门禁。
- [发布签名与运行时准入](release-signature.md)：受信公钥、有效期、候选和产物绑定。
- [源授权台账](source-authorization-ledger.json)：资料使用范围及真实资料准入要求。
- [企业部署与恢复](enterprise-recovery.md)：已有命令、依赖、停止条件和恢复证据。

## 基线说明

开始本工作包时，两个工作树的 `git status --short` 均无输出，分别位于 `89eb29591a6f9294faa3aa379debb47a6d6bbc3c` 和 `8913a94c567403bd2f3021d09b0bf9474bd4102d`。正式捕获文件时并行实现已经开始，因此其中 `currentWorkingTree.clean` 为 `false`。锁文件摘要始终从固定基线的 Git 对象计算，不把中途修改当成基线。

默认 shell 曾提供 Node.js 23.11.0 与 npm 11.4.1，不符合 OS 要求。验收包测试使用本机 `~/.local/share/muniu-toolchains/node-v22.19.0-darwin-arm64/bin` 中的 Node.js 22.19.0 与 npm 11.10.1。Sales 基线的 TypeScript 为 5.9.3，独立保留；OS 为 5.7.2，不合并构建链。

[Sales 基线检查](p0-sales-checks.json)记录 43 项测试通过、类型检查通过及既有 lint 失败。日志摘要来自本地执行记录；临时日志不随仓库分发，发布验收须重新执行并保存持久证据，不能豁免既有 lint 问题。
