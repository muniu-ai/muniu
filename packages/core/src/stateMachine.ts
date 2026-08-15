import type { RunStatus } from "./types.js";

const terminalStatuses = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled"
]);

export const runTransitions: Record<RunStatus, RunStatus[]> = {
  queued: ["preparing", "cancelled"],
  preparing: ["running", "failed", "cancelled"],
  running: ["verifying", "failed", "cancelled"],
  verifying: ["waiting_approval", "completed", "failed", "cancelled"],
  waiting_approval: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: []
};

export function isTerminalRunStatus(status: RunStatus): boolean {
  return terminalStatuses.has(status);
}

export function canTransitionRun(
  current: RunStatus,
  next: RunStatus
): boolean {
  return runTransitions[current].includes(next);
}

export function transitionRun(current: RunStatus, next: RunStatus): RunStatus {
  if (!canTransitionRun(current, next)) {
    throw new Error(`Invalid run transition: ${current} -> ${next}`);
  }

  return next;
}
