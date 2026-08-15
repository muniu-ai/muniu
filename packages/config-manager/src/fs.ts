import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  rm,
  mkdir,
  readFile,
  rename,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";

export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function atomicWriteText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, content);
  await rename(tempPath, path);
}

export async function removeFileIfExists(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function backupFileIfExists(
  path: string,
  backupRoot: string,
  label: string,
  now = new Date()
): Promise<string | undefined> {
  if (!(await fileExists(path))) return undefined;
  const safeLabel = label.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const backupDir = join(backupRoot, safeLabel);
  await mkdir(backupDir, { recursive: true });
  const backupPath = join(backupDir, `${timestamp(now)}.bak`);
  await copyFile(path, backupPath);
  return backupPath;
}

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function timestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}
