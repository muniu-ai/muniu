# E4.3 PDF 解析退出竞争修复

2026-11-05。状态：验收中。分支 `codex/enterprise-e4-3-pdf-exit`，基线 `9fec9c3`。完整 Linux CI 在 PDF 内存和排队测试中返回 `PDF_ISOLATION_UNAVAILABLE`，见[运行 41989760252](https://github.com/muniu-ai/muniu/actions/runs/41989760252)。

隔离 Linux 探针复现到：子进程已成为 `Z (zombie)`，`VmRSS` 不存在，Node 的 `exitCode` 仍为 `null`。原采样逻辑会在该窗口触发隔离拒绝；这条路径能否完整解释原 CI 失败，仍待完整复验。[Linux 手册](https://man7.org/linux/man-pages/man5/proc_pid_status.5.html)将 `Z` 和 `X` 分别定义为 zombie 与 dead。

修复核对原 PID 和内核状态。只对已结束进程停止要求 RSS，仍须等待原来的子进程发出 `close` 事件、成功退出码和有效结果。运行中或暂停的进程缺少 RSS、PID 不符或状态缺失时继续拒绝；堆限制、RSS 阈值、超时、并发及排队上限均未改变，也未增加无隔离回退。

本机类型编译和 20 项提取、资源及状态测试通过，包含新增 3 项 Linux 状态反例。首次编译缺少专用工作树的 Cordis 构建产物，补齐锁定来源的构建缓存后复验通过。96 MiB、0.25 CPU 的隔离探针确认上述内核状态；192 MiB、0.5 CPU 的 PDF 补充检查因排队超时结束，不计通过。完整 Linux 默认限制和受影响回归仍待 CI，不能据此标记本修复已通过出口。

后续[运行 41997530767](https://github.com/muniu-ai/muniu/actions/runs/41997530767)仍在同项检查失败。现补充处理采样文件随进程消失的窗口：只有内核对原 PID 返回 `ESRCH` 才继续等待退出结果；活动进程、权限错误或未知状态仍拒绝。新增反例与原提取测试共 21 项本地通过，完整 Linux 复验尚未完成。

[运行 41999640247](https://github.com/muniu-ai/muniu/actions/runs/41999640247)的独立 PDF 专项通过，但完整回归记录了 `INVALID_RSS_R`。Linux 释放内存上下文与更新退出状态存在先后顺序，可产生仍为 R、却缺少 `VmRSS` 的窗口。现仅在字段整行缺失时读取同一 PID 的 [statm 内存计数](https://man7.org/linux/man-pages/man5/proc_pid_statm.5.html)：严格七项全零才作为本次零内存观测；非零值必须重新取得有效 RSS，坏格式和权限错误仍拒绝。这不会提前认定进程结束。24 项本地测试通过，完整 CI 仍待复验。
