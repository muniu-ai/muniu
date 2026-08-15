import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const SAFE_SPEC_SET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function isSafeSpecSetId(specSetId: string): boolean {
  return SAFE_SPEC_SET_ID.test(specSetId);
}

export function assertSafeSpecSetId(specSetId: string): void {
  if (!isSafeSpecSetId(specSetId)) {
    throw new TypeError(`Unsafe spec set id: ${specSetId}`);
  }
}

export async function atomicWriteText(
  filePath: string,
  content: string
): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );

  try {
    await writeFile(temporaryPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function readOptionalText(
  filePath: string
): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}
