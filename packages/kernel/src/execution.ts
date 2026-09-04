import type { ExecutionStatus } from "@mn/contracts";
import { KernelError } from "./errors.js";

export type ExecutionCommand = "start" | "pause" | "interrupt" | "resume" | "complete" | "fail" | "cancel" | "reconcile";

const TRANSITIONS: Readonly<Record<ExecutionStatus, Partial<Record<ExecutionCommand, ExecutionStatus>>>> = {
  queued: { start: "running", cancel: "cancelled" },
  running: {
    pause: "paused",
    interrupt: "interrupted",
    complete: "completed",
    fail: "failed",
    cancel: "cancelled",
  },
  waiting_approval: {
    pause: "paused",
    interrupt: "interrupted",
    cancel: "cancelled",
    fail: "failed",
  },
  paused: { resume: "queued", cancel: "cancelled" },
  interrupted: { resume: "queued", cancel: "cancelled" },
  needs_reconciliation: { reconcile: "completed", cancel: "cancelled", fail: "failed" },
  completed: {},
  failed: {},
  cancelled: {},
};

export function transitionExecution(status: ExecutionStatus, command: ExecutionCommand): ExecutionStatus {
  const next = TRANSITIONS[status][command];
  if (!next) {
    throw new KernelError(
      "INVALID_EXECUTION_TRANSITION",
      `执行处于 ${status}，不能执行 ${command}`,
      "刷新执行状态并选择可用操作",
    );
  }
  return next;
}

export function unknownEffectStatus(effectClass: string, outcomeKnown: boolean): ExecutionStatus | undefined {
  if (outcomeKnown) return undefined;
  if (["external_side_effect", "financial", "privileged", "unknown"].includes(effectClass)) {
    return "needs_reconciliation";
  }
  return undefined;
}
