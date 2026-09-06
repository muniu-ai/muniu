// SPDX-License-Identifier: Apache-2.0
import type { Execution, PluginInstallation, PluginWorkerV1 } from "@mn/contracts";
import type { KernelStore } from "@mn/kernel";
import { assertPluginWorker, cloneJson } from "@mn/plugin-sdk";
import { PLUGIN_INSTALLATION_PROJECTION, PLUGIN_LOCK_PROJECTION, type LocalSignedPluginRepository, type PluginLockV1 } from "./plugin-installation.js";

export function createSignedWorkerResolver(options: { readonly store: KernelStore; readonly repository: LocalSignedPluginRepository }) {
  const modules = new Map<string, Promise<PluginWorkerV1>>();
  return async (execution: Execution): Promise<PluginWorkerV1> => {
    const installation = await options.store.transact(execution.tenantId, (transaction) => {
      const installed = transaction.getProjection<PluginInstallation>(PLUGIN_INSTALLATION_PROJECTION, execution.pluginId);
      const lock = transaction.getProjection<PluginLockV1>(PLUGIN_LOCK_PROJECTION, "current");
      const entry = lock?.plugins.find((item) => item.pluginId === execution.pluginId);
      if (!installed || !entry || !["active", "installed"].includes(installed.status)
        || installed.tenantId !== execution.tenantId
        || entry.packageSha256 !== installed.packageSha256 || entry.version !== installed.version
        || installed.packageSha256 !== execution.pluginPackageSha256) {
        throw new Error("Worker 插件与租户 execution lock 不一致，拒绝执行");
      }
      return installed;
    });
    const release = (await options.repository.read())?.releases.find((item) =>
      item.manifest.id === installation.pluginId && item.manifest.version === installation.version
      && item.manifest.packageSha256 === installation.packageSha256);
    if (!release?.loadEntrypoint) throw new Error("Worker 缺少已锁定的签名插件制品");
    // Recheck the tenant lock before reusing an already verified module.
    const bytes = await release.loadEntrypoint("worker");
    if (!bytes) throw new Error("插件没有声明 Worker 入口");
    const key = `${execution.tenantId}:${installation.packageSha256}`;
    let result = modules.get(key);
    if (!result) {
      result = (async () => {
        const module = await import(`data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}#${encodeURIComponent(key)}`);
        if (typeof module.default !== "function") throw new Error("Worker 入口必须默认导出贡献工厂");
        const value: unknown = await module.default(cloneJson(release.manifest));
        assertPluginWorker(value, release.manifest);
        return value;
      })();
      modules.set(key, result);
    }
    return result;
  };
}
