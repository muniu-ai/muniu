import { parseDocument } from "yaml";
import type { ContractRef } from "@mn/core";
import type {
  ConsistencyBoundary,
  ManifestDataResource,
  ManifestDependency,
  ManifestDeployment,
  ManifestObservability,
  ProjectManifest,
  ProjectManifestService
} from "./architectureTypes.js";

const TOP_FIELDS = new Set(["apiVersion", "kind", "metadata", "services", "consistency"]);
const SERVICE_FIELDS = new Set([
  "id",
  "path",
  "owners",
  "language",
  "contracts",
  "dependencies",
  "data",
  "commands",
  "observability",
  "deployment"
]);
const CONTRACT_TYPES = new Set(["openapi", "protobuf", "graphql", "asyncapi", "other"]);
const DEPENDENCY_KINDS = new Set(["sync", "async", "data"]);
const DATA_KINDS = new Set(["database", "redis", "topic", "object-store"]);
const DATA_ROLES = new Set(["owner", "reader", "writer", "publisher", "consumer"]);
const CONSISTENCY_STRATEGIES = new Set([
  "saga",
  "transactional-outbox",
  "eventual",
  "two-phase-commit"
]);

function fail(message: string): never {
  throw new TypeError(`Invalid project manifest: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function knownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail(`${path} contains unsupported fields: ${unknown.sort().join(", ")}`);
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    return fail(`${path} must be a non-empty trimmed string`);
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(result)) {
    fail(`${path} is not a safe identifier`);
  }
  return result;
}

function stringList(
  value: unknown,
  path: string,
  options: { minimum?: number } = {}
): string[] {
  if (!Array.isArray(value)) return fail(`${path} must be an array`);
  const values = value.map((item, index) => text(item, `${path}[${index}]`));
  if (values.length < (options.minimum ?? 0)) {
    fail(`${path} must contain at least ${options.minimum} item(s)`);
  }
  if (new Set(values).size !== values.length) fail(`${path} contains duplicates`);
  return values;
}

export function normalizeRepositoryRelativePath(value: unknown, field = "path"): string {
  const candidate = text(value, field);
  if (
    candidate.includes("\\") ||
    candidate.includes("\0") ||
    candidate.startsWith("/") ||
    /^[A-Za-z]:/u.test(candidate)
  ) {
    return fail(`${field} must be a repository-relative POSIX path`);
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return fail(`${field} contains path traversal or empty segments`);
  }
  return segments.join("/");
}

function contracts(value: unknown, path: string): ContractRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fail(`${path} must be an array`);
  return value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const source = record(item, itemPath);
    knownFields(source, new Set(["type", "path", "serviceName"]), itemPath);
    const type = text(source.type, `${itemPath}.type`);
    if (!CONTRACT_TYPES.has(type)) fail(`${itemPath}.type is unsupported`);
    return {
      type: type as ContractRef["type"],
      path: normalizeRepositoryRelativePath(source.path, `${itemPath}.path`),
      ...(source.serviceName === undefined
        ? {}
        : { serviceName: text(source.serviceName, `${itemPath}.serviceName`) })
    };
  });
}

function dependencies(value: unknown, path: string): ManifestDependency[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fail(`${path} must be an array`);
  return value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const source = record(item, itemPath);
    knownFields(source, new Set(["service", "kind", "contract"]), itemPath);
    const kind = text(source.kind, `${itemPath}.kind`);
    if (!DEPENDENCY_KINDS.has(kind)) fail(`${itemPath}.kind is unsupported`);
    return {
      service: identifier(source.service, `${itemPath}.service`),
      kind: kind as ManifestDependency["kind"],
      ...(source.contract === undefined
        ? {}
        : { contract: text(source.contract, `${itemPath}.contract`) })
    };
  });
}

function dataResources(value: unknown, path: string): ManifestDataResource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fail(`${path} must be an array`);
  return value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const source = record(item, itemPath);
    knownFields(source, new Set(["kind", "name", "role", "lifecycle"]), itemPath);
    const kind = text(source.kind, `${itemPath}.kind`);
    const role = text(source.role, `${itemPath}.role`);
    if (!DATA_KINDS.has(kind)) fail(`${itemPath}.kind is unsupported`);
    if (!DATA_ROLES.has(role)) fail(`${itemPath}.role is unsupported`);
    return {
      kind: kind as ManifestDataResource["kind"],
      name: text(source.name, `${itemPath}.name`),
      role: role as ManifestDataResource["role"],
      ...(source.lifecycle === undefined
        ? {}
        : { lifecycle: text(source.lifecycle, `${itemPath}.lifecycle`) })
    };
  });
}

function commands(value: unknown, path: string): Record<string, string> {
  if (value === undefined) return {};
  const source = record(value, path);
  const result: Record<string, string> = {};
  for (const key of Object.keys(source).sort()) {
    result[identifier(key, `${path} key`)] = text(source[key], `${path}.${key}`);
  }
  return result;
}

function observability(value: unknown, path: string): ManifestObservability {
  if (value === undefined) return { metrics: [], traces: [], logs: [], alerts: [] };
  const source = record(value, path);
  knownFields(source, new Set(["metrics", "traces", "logs", "alerts"]), path);
  return {
    metrics: source.metrics === undefined ? [] : stringList(source.metrics, `${path}.metrics`),
    traces: source.traces === undefined ? [] : stringList(source.traces, `${path}.traces`),
    logs: source.logs === undefined ? [] : stringList(source.logs, `${path}.logs`),
    alerts: source.alerts === undefined ? [] : stringList(source.alerts, `${path}.alerts`)
  };
}

function deployment(value: unknown, path: string): ManifestDeployment | undefined {
  if (value === undefined) return undefined;
  const source = record(value, path);
  knownFields(source, new Set(["unit", "rollbackCommand"]), path);
  return {
    unit: text(source.unit, `${path}.unit`),
    ...(source.rollbackCommand === undefined
      ? {}
      : { rollbackCommand: text(source.rollbackCommand, `${path}.rollbackCommand`) })
  };
}

function services(value: unknown): ProjectManifestService[] {
  if (!Array.isArray(value) || value.length === 0) {
    return fail("services must contain at least one service");
  }
  const result = value.map((item, index) => {
    const path = `services[${index}]`;
    const source = record(item, path);
    knownFields(source, SERVICE_FIELDS, path);
    return {
      id: identifier(source.id, `${path}.id`),
      path: normalizeRepositoryRelativePath(source.path, `${path}.path`),
      owners: stringList(source.owners, `${path}.owners`, { minimum: 1 }),
      ...(source.language === undefined
        ? {}
        : { language: text(source.language, `${path}.language`) }),
      ...(source.contracts === undefined
        ? {}
        : { contracts: contracts(source.contracts, `${path}.contracts`) }),
      dependencies: dependencies(source.dependencies, `${path}.dependencies`),
      data: dataResources(source.data, `${path}.data`),
      commands: commands(source.commands, `${path}.commands`),
      observability: observability(source.observability, `${path}.observability`),
      ...(source.deployment === undefined
        ? {}
        : { deployment: deployment(source.deployment, `${path}.deployment`)! })
    } satisfies ProjectManifestService;
  });
  const ids = result.map((service) => service.id);
  const paths = result.map((service) => service.path);
  if (new Set(ids).size !== ids.length) fail("service ids must be unique");
  if (new Set(paths).size !== paths.length) fail("service paths must be unique");
  return result;
}

function consistency(value: unknown): ConsistencyBoundary[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fail("consistency must be an array");
  return value.map((item, index) => {
    const path = `consistency[${index}]`;
    const source = record(item, path);
    knownFields(source, new Set(["id", "participants", "strategy"]), path);
    const strategy = text(source.strategy, `${path}.strategy`);
    if (!CONSISTENCY_STRATEGIES.has(strategy)) fail(`${path}.strategy is unsupported`);
    return {
      id: identifier(source.id, `${path}.id`),
      participants: stringList(source.participants, `${path}.participants`, { minimum: 2 }),
      strategy: strategy as ConsistencyBoundary["strategy"]
    };
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function parseProjectManifest(content: string): ProjectManifest {
  let raw: unknown;
  try {
    const document = parseDocument(content, {
      schema: "core",
      uniqueKeys: true,
      prettyErrors: true
    });
    if (document.errors.length > 0) {
      fail(document.errors.map((error) => error.message).join("; "));
    }
    raw = document.toJS({ maxAliasCount: 50 }) as unknown;
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("Invalid project manifest")) {
      throw error;
    }
    fail(error instanceof Error ? error.message : String(error));
  }
  const source = record(raw, "$manifest");
  knownFields(source, TOP_FIELDS, "$manifest");
  if (source.apiVersion !== "mn.dev/project/v1" || source.kind !== "Project") {
    fail("apiVersion must be mn.dev/project/v1 and kind must be Project");
  }
  const metadata = record(source.metadata, "metadata");
  knownFields(metadata, new Set(["id", "owner"]), "metadata");
  const parsed: ProjectManifest = {
    apiVersion: "mn.dev/project/v1",
    kind: "Project",
    metadata: {
      id: identifier(metadata.id, "metadata.id"),
      ...(metadata.owner === undefined ? {} : { owner: text(metadata.owner, "metadata.owner") })
    },
    services: services(source.services),
    consistency: consistency(source.consistency)
  };
  const serviceIds = new Set(parsed.services.map((service) => service.id));
  for (const service of parsed.services) {
    for (const dependency of service.dependencies) {
      if (!serviceIds.has(dependency.service)) {
        fail(`service ${service.id} depends on unknown service ${dependency.service}`);
      }
    }
  }
  for (const boundary of parsed.consistency) {
    for (const participant of boundary.participants) {
      if (!serviceIds.has(participant)) {
        fail(`consistency ${boundary.id} references unknown service ${participant}`);
      }
    }
  }
  return deepFreeze(parsed);
}
