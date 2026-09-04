// SPDX-License-Identifier: Apache-2.0

import { createNodePublicWebReader } from "@mn/plugin-opc";
import {
  createKernelAgentTurnHandler,
  UnknownExternalSideEffectError,
} from "@mn/worker";

import { VaultModelSecretStore } from "./lib/enterprise-secrets.mjs";

const fixtureMode = process.env.MN_WORKER_FIXTURE_MODE === "true";

export const supportedKinds = Object.freeze([
  "system.noop",
  "agent.execution.run",
  ...(fixtureMode ? [
    "fixture.echo",
    "fixture.wait",
    "fixture.external_unknown",
  ] : []),
]);

function fixtureHandlers() {
  return {
    "agent.execution.run": async () => {
      throw new Error("企业 fixture 不提供 LLM，仅验证失败事务与恢复链路");
    },
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
  };
}

function productionSecretStore() {
  return new VaultModelSecretStore({
    address: process.env.MN_VAULT_ADDR,
    token: process.env.MN_VAULT_TOKEN,
    mount: process.env.MN_VAULT_KV_MOUNT ?? "secret",
    namespace: process.env.MN_VAULT_NAMESPACE,
  });
}

export async function createHandlers(context) {
  const useFixture = context.fixtureMode ?? fixtureMode;
  const common = {
    "system.noop": async (job) => ({ accepted: true, jobId: job.id }),
  };
  if (useFixture) return Object.freeze({ ...common, ...fixtureHandlers() });
  if (!context.store?.transact || !context.store?.claimJob) {
    throw new Error("企业 Agent handler 需要统一的 Kernel 与 Job store");
  }
  const secretStore = context.secretStore ?? productionSecretStore();
  const turnHandler = createKernelAgentTurnHandler({
    store: context.store,
    secretStore,
    ...(context.modelInvoker ? { modelInvoker: context.modelInvoker } : {}),
    opcPublicWebReader: context.opcPublicWebReader ?? createNodePublicWebReader(),
    acceptsSecretReference: (reference) =>
      /^vault:\/\/muniu\/v2\/models\/[a-zA-Z0-9._-]+$/u.test(reference),
  });
  return Object.freeze({
    ...common,
    "agent.execution.run": turnHandler,
  });
}

export const agentExecutionBootstrap = Object.freeze({
  configured: true,
  requiredHandler: "agent.execution.run",
  secretStore: "Vault KV v2",
  runtimeStore: "PostgreSQL mn_v2",
});
