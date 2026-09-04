import { createConnection } from "node:net";
import { join } from "node:path";

export const DEFAULT_HOST_PORT = 7318;
export const LEGACY_DAEMON_PORT = 7318;
export const STATE_ROOT_ENV = "MN_V2_STATE_ROOT";
export const DESKTOP_PARENT_PID_ENV = "MN_DESKTOP_PARENT_PID";

export interface LocalStatePaths {
  readonly root: string;
  readonly database: string;
  readonly cas: string;
}

export function localStatePaths(root: string): LocalStatePaths {
  return { root, database: join(root, "state.sqlite3"), cas: join(root, "cas") };
}

export function defaultLocalStatePaths(homeDirectory: string): LocalStatePaths {
  return localStatePaths(join(homeDirectory, ".muniu", "v2"));
}

export function desktopParentPid(environment: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = environment[DESKTOP_PARENT_PID_ENV];
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${DESKTOP_PARENT_PID_ENV} 必须是有效进程号`);
  }
  return value;
}

export type LegacyDaemonProbe = () => Promise<boolean>;

export function probeLegacyDaemon(
  host = "127.0.0.1",
  port = LEGACY_DAEMON_PORT,
  timeoutMs = 250,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (active: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(active);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

export async function assertNoLegacyDaemon(probe: LegacyDaemonProbe = probeLegacyDaemon): Promise<void> {
  if (await probe()) {
    throw new Error("检测到 0.1 daemon 正在运行。请先退出 0.1 daemon，再启动木牛 0.2。");
  }
}

export interface RetentionPolicy {
  readonly businessDays?: number;
  readonly executionDays?: number;
  readonly deliverableDays?: number;
  readonly auditDays?: number;
}

export interface EnterpriseReadinessInput {
  readonly retention: RetentionPolicy;
  readonly engineLockDigest: string;
  readonly workerEngineLockDigest: string;
  readonly pluginLockDigest: string;
  readonly workerPluginLockDigest: string;
  readonly postgresReady: boolean;
  readonly s3Ready: boolean;
}

export interface ReadinessIssue {
  readonly code: string;
  readonly message: string;
  readonly action: string;
}

export interface EnterpriseReadiness {
  readonly ready: boolean;
  readonly issues: readonly ReadinessIssue[];
}

export function enterpriseReadiness(input: EnterpriseReadinessInput): EnterpriseReadiness {
  const issues: ReadinessIssue[] = [];
  const retention = input.retention;
  if ([retention.businessDays, retention.executionDays, retention.deliverableDays, retention.auditDays]
    .some((value) => !Number.isInteger(value) || Number(value) < 1)) {
    issues.push({
      code: "RETENTION_POLICY_REQUIRED",
      message: "企业生产 profile 尚未配置完整保留策略",
      action: "配置业务、执行、成果和审计保留天数",
    });
  }
  if (input.engineLockDigest !== input.workerEngineLockDigest) {
    issues.push({
      code: "ENGINE_LOCK_MISMATCH",
      message: "Host 与 Worker 的 engine lock 不一致",
      action: "使用同一发布物重新部署 Host 与 Worker",
    });
  }
  if (input.pluginLockDigest !== input.workerPluginLockDigest) {
    issues.push({
      code: "PLUGIN_LOCK_MISMATCH",
      message: "Host 与 Worker 的 plugin lock 不一致",
      action: "同步插件 lock 后重新部署",
    });
  }
  if (!input.postgresReady) {
    issues.push({ code: "POSTGRES_UNAVAILABLE", message: "PostgreSQL 不可用", action: "恢复 PostgreSQL 连接" });
  }
  if (!input.s3Ready) {
    issues.push({ code: "S3_UNAVAILABLE", message: "S3 对象存储不可用", action: "恢复 S3 连接" });
  }
  return { ready: issues.length === 0, issues };
}
