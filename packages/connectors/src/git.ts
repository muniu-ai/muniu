import { isAbsolute, join } from "node:path";
import type { Service } from "@mn/core";
import { indexArchitectureRepository } from "./architectureIndex.js";

export interface RepoIndex {
  rootPath: string;
  services: Service[];
  warnings: string[];
}

/**
 * Compatibility adapter for classic-v1 callers. The richer architecture index
 * remains the source of truth while this function preserves absolute service
 * and contract paths expected by the existing API and worker context.
 */
export async function indexRepository(rootPath: string): Promise<RepoIndex> {
  const architecture = await indexArchitectureRepository(rootPath);
  return deepFreeze({
    rootPath: architecture.rootPath,
    services: architecture.services.map((service) => ({
      id: service.id,
      name: service.name,
      path: service.path,
      owners: [...service.owners],
      language: service.language,
      contracts: service.contracts.map((contract) => ({
        ...contract,
        path: isAbsolute(contract.path)
          ? contract.path
          : join(architecture.rootPath, contract.path)
      }))
    })),
    warnings: [...architecture.warnings]
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
