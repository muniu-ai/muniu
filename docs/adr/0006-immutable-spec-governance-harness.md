# ADR 0006: Run 绑定不可变 Spec、Governance 与 Harness

## Status

Accepted

## Decision

governed run 创建前固定批准的 SpecRevision、有效 Standard Pack、Workflow 和 HarnessManifest。运行期间上游更新只影响新 run，不改变在途执行。

## Consequences

修正需求必须创建新 revision 并重新审批；旧 prompt 通过 legacy adapter 进入 classic-v1。
