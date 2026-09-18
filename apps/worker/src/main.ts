// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentOsKernel, type KernelStore } from "@mn/kernel";
import { createBusinessActionWorkerHandler } from "./business-actions.js";
import { createBusinessCandidateWorkerHandler, type BusinessCandidateWorkerOptions } from "./business-candidates.js";
import { loadBusinessProviderConfiguration } from "./business-provider.js";

import {
  runWorkerMain,
  type AgentOsWorkerOptions,
} from "./index.js";

interface WorkerBootstrapModule {
  readonly createWorkerOptions?: () => AgentOsWorkerOptions | Promise<AgentOsWorkerOptions>;
  readonly createBusinessCandidateOptions?: () => Omit<BusinessCandidateWorkerOptions, "sourcePort">
    | Promise<Omit<BusinessCandidateWorkerOptions, "sourcePort">>;
}

export async function main(
  bootstrapModule = process.env.MN_WORKER_BOOTSTRAP_MODULE,
): Promise<void> {
  if (!bootstrapModule) {
    throw new Error("缺少 MN_WORKER_BOOTSTRAP_MODULE；请指向本地受信任的 Worker 组合模块");
  }
  if (!isAbsolute(bootstrapModule)) {
    throw new Error("MN_WORKER_BOOTSTRAP_MODULE 必须是绝对路径");
  }
  const loaded = await import(pathToFileURL(bootstrapModule).href) as WorkerBootstrapModule;
  if (typeof loaded.createWorkerOptions !== "function") {
    throw new Error("Worker 组合模块必须导出 createWorkerOptions()");
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const configured = await loaded.createWorkerOptions();
    const business = await loadBusinessProviderConfiguration("enterprise");
    if (loaded.createBusinessCandidateOptions && !business) throw new Error("询价候选Worker必须配置受信任的Sales资料端口");
    let workerOptions = configured;
    if (business) {
      const store = configured.store as typeof configured.store & KernelStore;
      if (typeof store.transact !== "function" || typeof store.readEvents !== "function") throw new Error("业务Worker要求支持事务和事件的存储");
      if (configured.handlers["business.action.execute"]) throw new Error("业务动作只能由一个受信Worker处理器负责");
      const handler = createBusinessActionWorkerHandler({ store, kernel: new AgentOsKernel(store), ports: business.businessProvider });
      workerOptions = { ...configured, handlers: { ...configured.handlers, "business.action.execute": handler },
        kinds: [...(configured.kinds ?? Object.keys(configured.handlers)), "business.action.execute"] };
      if (loaded.createBusinessCandidateOptions) {
        if (workerOptions.handlers["business.candidate.extract"]) throw new Error("询价候选只能由一个受信Worker处理器负责");
        if (!business.businessProvider.inquiries) throw new Error("询价候选Worker缺少当前Sales资料端口");
        const candidate = await loaded.createBusinessCandidateOptions();
        if (candidate.store !== store) throw new Error("询价候选必须共用Worker事务存储");
        if (candidate.modelMode === "test_fixture") throw new Error("生产Worker不能使用询价模型测试模式");
        workerOptions = { ...workerOptions, handlers: { ...workerOptions.handlers, "business.candidate.extract": createBusinessCandidateWorkerHandler({
          ...candidate, sourcePort: business.businessProvider.inquiries,
        }) },
          kinds: [...(workerOptions.kinds ?? Object.keys(workerOptions.handlers)), "business.candidate.extract"] };
      }
    }
    await runWorkerMain(workerOptions, { signal: abort.signal });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Worker 启动失败");
    process.exitCode = 1;
  });
}
