import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface LeaseFile {
  version: 1;
  runId: string;
  ownerId: string;
  acquiredAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface RunJobLeaseManagerOptions {
  rootDir: string;
  ownerId?: string;
  ttlMs?: number;
  heartbeatMs?: number;
}

export class RunJobLease {
  private released = false;
  private readonly heartbeat?: NodeJS.Timeout;

  constructor(
    private readonly options: {
      runId: string;
      ownerId: string;
      path: string;
      ttlMs: number;
      heartbeatMs: number;
    }
  ) {
    if (options.heartbeatMs > 0) {
      this.heartbeat = setInterval(() => this.refresh(), options.heartbeatMs);
      this.heartbeat.unref?.();
    }
  }

  get runId(): string {
    return this.options.runId;
  }

  get ownerId(): string {
    return this.options.ownerId;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    try {
      const current = readLeaseFile(this.options.path);
      if (current?.ownerId === this.options.ownerId) {
        rmSync(this.options.path, { force: true });
      }
    } catch {
      // Best effort; stale leases expire and can be reclaimed by another process.
    }
  }

  private refresh(): void {
    if (this.released) return;
    try {
      const current = readLeaseFile(this.options.path);
      if (current?.ownerId !== this.options.ownerId) {
        this.release();
        return;
      }
      writeLeaseFile(this.options.path, {
        ...current,
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + this.options.ttlMs).toISOString()
      });
    } catch {
      this.release();
    }
  }
}

export class RunJobLeaseManager {
  private readonly ownerId: string;
  private readonly ttlMs: number;
  private readonly heartbeatMs: number;

  constructor(private readonly options: RunJobLeaseManagerOptions) {
    this.ownerId = options.ownerId ?? `mn-api-${process.pid}-${randomUUID()}`;
    this.ttlMs = options.ttlMs ?? 30_000;
    this.heartbeatMs = options.heartbeatMs ?? 5_000;
  }

  acquire(runId: string): RunJobLease | undefined {
    mkdirSync(this.options.rootDir, { recursive: true });
    const path = this.leasePath(runId);
    const now = new Date();
    const lease: LeaseFile = {
      version: 1,
      runId,
      ownerId: this.ownerId,
      acquiredAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString()
    };
    if (this.tryCreate(path, lease)) {
      return this.createLease(runId, path);
    }

    const existing = readLeaseFile(path);
    if (!existing || !leaseExpired(existing)) return undefined;

    this.removeIfStillExpired(path, existing);
    if (!this.tryCreate(path, lease)) return undefined;
    return this.createLease(runId, path);
  }

  private createLease(runId: string, path: string): RunJobLease {
    return new RunJobLease({
      runId,
      ownerId: this.ownerId,
      path,
      ttlMs: this.ttlMs,
      heartbeatMs: this.heartbeatMs
    });
  }

  private leasePath(runId: string): string {
    return join(this.options.rootDir, `${safeFileName(runId)}.lock`);
  }

  private tryCreate(path: string, lease: LeaseFile): boolean {
    try {
      writeLeaseFile(path, lease, "wx");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  private removeIfStillExpired(path: string, expected: LeaseFile): void {
    const current = readLeaseFile(path);
    if (
      current?.ownerId === expected.ownerId &&
      current.expiresAt === expected.expiresAt &&
      leaseExpired(current)
    ) {
      rmSync(path, { force: true });
    }
  }
}

function writeLeaseFile(path: string, lease: LeaseFile, flag: "w" | "wx" = "w"): void {
  writeFileSync(path, `${JSON.stringify(lease, null, 2)}\n`, {
    encoding: "utf8",
    flag
  });
}

function readLeaseFile(path: string): LeaseFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LeaseFile;
  } catch {
    return undefined;
  }
}

function leaseExpired(lease: LeaseFile): boolean {
  const expiresAt = Date.parse(lease.expiresAt);
  return Number.isNaN(expiresAt) || expiresAt <= Date.now();
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}
