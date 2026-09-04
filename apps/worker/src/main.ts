// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  runWorkerMain,
  type AgentOsWorkerOptions,
} from "./index.js";

interface WorkerBootstrapModule {
  readonly createWorkerOptions?: () => AgentOsWorkerOptions | Promise<AgentOsWorkerOptions>;
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
    await runWorkerMain(await loaded.createWorkerOptions(), { signal: abort.signal });
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
