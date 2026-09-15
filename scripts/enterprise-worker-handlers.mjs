// SPDX-License-Identifier: Apache-2.0

import { createNodePublicWebReader } from "@mn/plugin-opc";
import { createEnterpriseFilePluginRepository, createSignedWorkerResolver, createOpcModelContextReader } from "@mn/host";
import {
  createCodingReconciliationVerificationWorkerHandler,
  createCodingSandboxCleanupWorkerHandler,
  createEncryptedMemoryReader,
  createKernelAgentTurnHandler,
  createInClusterKubernetesApi,
  KubernetesCodingExecutor,
  UnknownExternalSideEffectError,
} from "@mn/worker";

import { VaultModelSecretStore } from "./lib/enterprise-secrets.mjs";

const fixtureMode = process.env.MN_WORKER_FIXTURE_MODE === "true";

export const supportedKinds = Object.freeze([
  "system.noop",
  "agent.execution.run",
  ...(!fixtureMode ? ["coding.reconciliation.verify", "coding.sandbox.cleanup"] : []),
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
  if (!context.cas || !context.protectedPayloadKeyProvider) {
    throw new Error("企业 Agent handler 需要 S3 CAS 与 Vault Transit KeyProvider");
  }
  const secretStore = context.secretStore ?? productionSecretStore();
  const acceptsSecretReference = (reference) => /^vault:\/\/muniu\/v2\/models\/[a-zA-Z0-9._-]+$/u.test(reference);
  const runtimeProtection = { cas: context.cas, keyProvider: context.protectedPayloadKeyProvider };
  const sandboxRoot = context.sandboxRoot ?? process.env.MN_KUBERNETES_SHARED_ROOT;
  if (!sandboxRoot) throw new Error("企业 Worker 缺少共享候选卷");
  const executor = context.commandExecutor ?? new KubernetesCodingExecutor({
    api: createInClusterKubernetesApi(),
    namespace: process.env.MN_KUBERNETES_NAMESPACE,
    sharedRoot: sandboxRoot,
    volumeClaim: process.env.MN_KUBERNETES_SHARED_VOLUME_CLAIM,
    image: process.env.MN_ENTERPRISE_SANDBOX_IMAGE,
    imageDigest: process.env.MN_ENTERPRISE_SANDBOX_IMAGE_DIGEST,
    runtimeClass: process.env.MN_KUBERNETES_RUNTIME_CLASS,
    serviceAccount: process.env.MN_KUBERNETES_CANDIDATE_SERVICE_ACCOUNT,
  });
  const composition = context.composition;
  if (!composition?.context || composition.context.get("agentOsKernel") !== composition.kernel) {
    throw new Error("企业 Worker 必须由 Host Cordis 组合根创建 Kernel 与 Scope");
  }
  const indexFile = process.env.MN_PLUGIN_REPOSITORY_INDEX?.trim();
  const trustedRootsFile = process.env.MN_PLUGIN_TRUSTED_ROOTS?.trim();
  const repositoryDigest = process.env.MN_PLUGIN_REPOSITORY_DIGEST?.trim();
  if (Boolean(indexFile) !== Boolean(trustedRootsFile) || Boolean(indexFile) !== Boolean(repositoryDigest)) {
    throw new Error("Worker 签名插件仓库配置不完整");
  }
  const plugins = indexFile ? await createEnterpriseFilePluginRepository({ indexFile, trustedRootsFile }) : undefined;
  if (plugins && plugins.repositoryDigest !== repositoryDigest) throw new Error("Worker 插件仓库摘要不一致");
  const turnHandler = createKernelAgentTurnHandler({
    resolveThreadContext: createOpcModelContextReader({ store: context.store, cas: context.cas, protectedPayloadKeyProvider: context.protectedPayloadKeyProvider }),
    ...(plugins ? { resolvePluginWorker: createSignedWorkerResolver({ store: context.store, repository: plugins.pluginRepository }) } : {}),
    store: context.store,
    secretStore,
    runtimeProtection,
    approvalKernel: composition.kernel,
    scopeContext: composition.context,
    codingSandboxRoot: `${sandboxRoot}/candidates`,
    codingCommandExecutor: executor,
    memoryReader: createEncryptedMemoryReader({
      store: context.store,
      cas: context.cas,
      keyProvider: context.protectedPayloadKeyProvider,
    }),
    ...(context.modelInvoker ? { modelInvoker: context.modelInvoker } : {}),
    ...(context.modelQuoter ? { modelQuoter: context.modelQuoter } : {}),
    opcPublicWebReader: context.opcPublicWebReader ?? createNodePublicWebReader(),
    acceptsSecretReference,
  });
  return Object.freeze({
    ...common,
    "agent.execution.run": turnHandler,
    "coding.reconciliation.verify": createCodingReconciliationVerificationWorkerHandler({
      store: context.store, sandboxRoot: `${sandboxRoot}/candidates`, commandExecutor: executor, runtimeProtection,
    }),
    "coding.sandbox.cleanup": createCodingSandboxCleanupWorkerHandler({
      store: context.store, sandboxRoot: `${sandboxRoot}/candidates`, commandExecutor: executor,
    }),
  });
}

export const agentExecutionBootstrap = Object.freeze({
  configured: true,
  requiredHandler: "agent.execution.run",
  secretStore: "Vault KV v2",
  runtimeStore: "PostgreSQL mn_v2",
});
