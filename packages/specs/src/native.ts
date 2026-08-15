import { readFile } from "node:fs/promises";
import { canonicalFrozenClone, canonicalJson } from "./canonical.js";
import { atomicWriteText } from "./fileUtils.js";
import type { NativeSpecDocument, SpecRevision } from "./types.js";
import { validateSpecRevision } from "./validation.js";

function deterministicYaml(value: unknown): string {
  const canonicalValue = JSON.parse(canonicalJson(value)) as unknown;
  return `${JSON.stringify(canonicalValue, null, 2)}\n`;
}

function invalidNativeSpec(message: string, cause?: unknown): TypeError {
  return new TypeError(`Invalid native spec YAML: ${message}`, { cause });
}

export function serializeNativeSpecYaml(revision: SpecRevision): string {
  const validation = validateSpecRevision(revision);
  if (!validation.valid) {
    throw invalidNativeSpec(
      validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")
    );
  }
  const document: NativeSpecDocument = {
    apiVersion: "mn.dev/spec/v1",
    kind: "SpecRevision",
    revision
  };
  return deterministicYaml(document);
}

export function parseNativeSpecYaml(content: string): SpecRevision {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw invalidNativeSpec(
      "expected the deterministic JSON subset of YAML 1.2",
      error
    );
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("apiVersion" in value) ||
    value.apiVersion !== "mn.dev/spec/v1" ||
    !("kind" in value) ||
    value.kind !== "SpecRevision" ||
    !("revision" in value)
  ) {
    throw invalidNativeSpec("unsupported document envelope");
  }
  const fields = Object.keys(value);
  if (
    fields.length !== 3 ||
    fields.some((field) => !["apiVersion", "kind", "revision"].includes(field))
  ) {
    throw invalidNativeSpec("document envelope contains unsupported fields");
  }

  const validation = validateSpecRevision(value.revision);
  if (!validation.valid) {
    throw invalidNativeSpec(
      validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")
    );
  }
  return canonicalFrozenClone(value.revision as SpecRevision);
}

export async function exportNativeSpecYaml(
  filePath: string,
  revision: SpecRevision
): Promise<void> {
  await atomicWriteText(filePath, serializeNativeSpecYaml(revision));
}

export async function importNativeSpecYaml(
  filePath: string
): Promise<SpecRevision> {
  return parseNativeSpecYaml(await readFile(filePath, "utf8"));
}
