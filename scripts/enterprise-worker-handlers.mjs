// SPDX-License-Identifier: Apache-2.0

import { UnknownExternalSideEffectError } from "@mn/worker";

export const handlers = Object.freeze({
  "system.noop": async (job) => ({ accepted: true, jobId: job.id }),
  ...(process.env.MN_WORKER_FIXTURE_MODE === "true" ? {
    "fixture.echo": async (job) => ({ ...job.payload, handledBy: process.env.MN_WORKER_INSTANCE_ID }),
    "fixture.wait": async (job, context) => {
      const delayMs = job.attempts > 1
        ? Number(job.payload.recoveryDelayMs ?? 2000)
        : Number(job.payload.delayMs ?? 45000);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        context.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("Worker 租约已失效"));
        }, { once: true });
      });
      return { recovered: job.attempts > 1, handledBy: process.env.MN_WORKER_INSTANCE_ID };
    },
    "fixture.external_unknown": async (job) => {
      const executionId = job.payload.executionId;
      if (typeof executionId !== "string" || !executionId) throw new Error("fixture executionId 缺失");
      throw new UnknownExternalSideEffectError(executionId);
    },
  } : {}),
});

export const agentExecutionBootstrap = Object.freeze({
  configured: false,
  requiredHandler: "agent.execution.run",
  reason: "需要受信模块注入真实的 LLM、Scope、RuntimeStore 与审批端口",
});
