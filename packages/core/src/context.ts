import type {
  AgentRunResult,
  AgentTask,
  FailureClassification,
  Project,
  RunContext,
  Service
} from "./types.js";

export function selectServices(project: Project, task: AgentTask): Service[] {
  const targets = new Set(task.targetServices);

  return project.services.filter(
    (service) => targets.has(service.id) || targets.has(service.name)
  );
}

export function buildArchitectureBrief(context: RunContext): string {
  const services = context.selectedServices
    .map((service) => {
      const contracts = service.contracts
        .map((contract) => `${contract.type}:${contract.path}`)
        .join(", ");
      return `- ${service.name} (${service.path}); owners=${service.owners.join(
        ","
      )}; contracts=${contracts || "none"}`;
    })
    .join("\n");

  return [
    `Task: ${context.task.title}`,
    `Intent: ${context.task.intent}`,
    "Target services:",
    services || "- none selected",
    "Acceptance criteria:",
    context.task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")
  ].join("\n");
}

export function buildRunPrompt(context: RunContext): string {
  const brief = context.architectureBrief ?? buildArchitectureBrief(context);
  const previousFailures = context.previousFailures.length
    ? context.previousFailures.map((item) => `- ${item}`).join("\n")
    : "- none";

  return [
    "# Mission",
    context.task.prompt,
    "",
    "# Architecture Brief",
    brief,
    "",
    "# Required Output",
    "- Make the smallest complete code change that satisfies the acceptance criteria.",
    "- Run the relevant checks and report the commands used.",
    "- End with a machine-readable summary containing changed files, checks, risks, and next steps.",
    "",
    "# Previous Failures",
    previousFailures
  ].join("\n");
}

export function compactRunSummary(result: AgentRunResult): string {
  return [
    `provider=${result.provider}`,
    `candidate=${result.candidateId}`,
    `status=${result.status}`,
    `exitCode=${result.exitCode ?? "null"}`,
    `summary=${result.summary.slice(0, 4000)}`,
    `stderrTail=${result.stderr.slice(-2000)}`
  ].join("\n");
}

export function classifyFailure(result: AgentRunResult): FailureClassification {
  const combined = `${result.stderr}\n${result.stdout}`.toLowerCase();

  if (combined.includes("timed out") || combined.includes("timeout")) {
    return {
      kind: "timeout",
      retryable: true,
      reason: "The run exceeded its timeout budget"
    };
  }

  if (combined.includes("permission") || combined.includes("denied")) {
    return {
      kind: "command_denied",
      retryable: false,
      reason: "The run attempted an operation blocked by policy or OS permissions"
    };
  }

  if (combined.includes("test failed") || combined.includes("failing test")) {
    return {
      kind: "test_failure",
      retryable: true,
      reason: "Tests failed after the candidate run"
    };
  }

  if (combined.includes("type error") || combined.includes("tsc")) {
    return {
      kind: "type_error",
      retryable: true,
      reason: "Type checking failed"
    };
  }

  if (combined.includes("cannot comply") || combined.includes("refuse")) {
    return {
      kind: "model_refusal",
      retryable: true,
      reason: "The model did not complete the requested coding task"
    };
  }

  if (combined.includes("context") && combined.includes("exceeded")) {
    return {
      kind: "context_exhausted",
      retryable: true,
      reason: "The model exhausted or exceeded available context"
    };
  }

  return {
    kind: "unknown",
    retryable: result.status !== "completed",
    reason: "No known failure signature matched"
  };
}

export function createRunContext(params: {
  project: Project;
  task: AgentTask;
  previousFailures?: string[];
  compactSummary?: string;
}): RunContext {
  const selectedServices = selectServices(params.project, params.task);

  return {
    project: params.project,
    task: params.task,
    selectedServices,
    previousFailures: params.previousFailures ?? [],
    compactSummary: params.compactSummary
  };
}
