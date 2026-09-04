export interface WorkflowStateV1 {
  readonly id: string;
  readonly terminal?: boolean;
}

export interface WorkflowTransitionV1 {
  readonly from: string;
  readonly event: string;
  readonly to: string;
  readonly requiredFields?: readonly string[];
  readonly humanOnly?: boolean;
}

export interface WorkflowDefinitionV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly initialState: string;
  readonly states: readonly WorkflowStateV1[];
  readonly transitions: readonly WorkflowTransitionV1[];
}

export class WorkflowContractError extends Error {
  constructor(
    readonly code: "INVALID_WORKFLOW" | "INVALID_TRANSITION" | "MISSING_FIELD" | "HUMAN_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "WorkflowContractError";
  }
}

export function validateWorkflow(definition: WorkflowDefinitionV1): void {
  const stateIds = new Set(definition.states.map((state) => state.id));
  if (!stateIds.has(definition.initialState)) {
    throw new WorkflowContractError("INVALID_WORKFLOW", "初始状态未在状态列表中声明");
  }
  if (stateIds.size !== definition.states.length) {
    throw new WorkflowContractError("INVALID_WORKFLOW", "工作流状态不得重名");
  }
  const keys = new Set<string>();
  for (const transition of definition.transitions) {
    if (!stateIds.has(transition.from) || !stateIds.has(transition.to)) {
      throw new WorkflowContractError("INVALID_WORKFLOW", "转换引用了未声明的状态");
    }
    const key = `${transition.from}:${transition.event}`;
    if (keys.has(key)) {
      throw new WorkflowContractError("INVALID_WORKFLOW", "同一状态和事件只能对应一个转换");
    }
    keys.add(key);
  }
}

export function applyWorkflowTransition(
  definition: WorkflowDefinitionV1,
  currentState: string,
  event: string,
  record: Readonly<Record<string, unknown>>,
  actorKind: "human" | "agent",
): string {
  validateWorkflow(definition);
  const transition = definition.transitions.find(
    (candidate) => candidate.from === currentState && candidate.event === event,
  );
  if (!transition) {
    throw new WorkflowContractError(
      "INVALID_TRANSITION",
      `状态 ${currentState} 不接受事件 ${event}`,
    );
  }
  if (transition.humanOnly && actorKind !== "human") {
    throw new WorkflowContractError("HUMAN_REQUIRED", "此状态转换需要人工确认");
  }
  for (const field of transition.requiredFields ?? []) {
    const value = record[field];
    if (value === undefined || value === null || value === "") {
      throw new WorkflowContractError("MISSING_FIELD", `缺少必填字段 ${field}`);
    }
  }
  return transition.to;
}
