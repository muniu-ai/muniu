import type {
  CapabilitiesDocument,
  GovernedProjectViewSummary,
  HarnessProfilesDocument,
  RunRecordSummary,
  SpecRepositoryRecordSummary,
  SpecRevisionSummary,
  TaskRunFormValues,
  WorkflowsDocument
} from "./types";

export function isGovernedWorkflow(
  workflowId: string,
  workflows: WorkflowsDocument | null
): boolean {
  const workflow = workflows?.workflows.find((item) => item.id === workflowId);
  return Boolean(
    workflow?.capabilities?.includes("immutable-snapshots") ||
      workflow?.capabilities?.includes("stage-checkpoints")
  );
}

export function TaskGovernanceControls({
  values,
  capabilities,
  workflows,
  harnessProfiles,
  specSets,
  specPreview,
  loading,
  onChange,
  onValidateSpec
}: {
  values: TaskRunFormValues;
  capabilities: CapabilitiesDocument | null;
  workflows: WorkflowsDocument | null;
  harnessProfiles: HarnessProfilesDocument | null;
  specSets: SpecRepositoryRecordSummary[];
  specPreview?: SpecRevisionSummary;
  loading: boolean;
  onChange: (values: TaskRunFormValues) => void;
  onValidateSpec: () => void;
}) {
  const governed = isGovernedWorkflow(values.workflowId, workflows);
  const availableWorkflows = workflows?.workflows.filter(
    (item) => item.status === "available"
  ) ?? [];
  const runnableProfiles = harnessProfiles?.harnessProfiles.filter(
    (item) => item.status === "available"
  ) ?? [];
  const approvedSpecs = specSets.flatMap((record) =>
    record.revisions
      .filter((revision) => revision.status === "approved" && revision.digest)
      .map((revision) => ({ record, revision }))
  );
  const selectedSpecKey = values.specSetId && values.specRevision
    ? `${values.specSetId}@${values.specRevision}`
    : "";

  return (
    <div className="governed-task-controls" aria-label="Task governance configuration">
      <div className="governed-control-heading">
        <strong>Workflow &amp; Harness</strong>
        <span>
          {capabilities
            ? `${capabilities.gates.filter((gate) => gate.status === "available").length} runnable gates`
            : loading
              ? "loading capabilities"
              : "capabilities unavailable"}
        </span>
      </div>

      <label className="form-field">
        <span>Workflow</span>
        <select
          aria-label="Workflow"
          required
          value={values.workflowId}
          onChange={(event) => onChange({ ...values, workflowId: event.target.value })}
        >
          {availableWorkflows.length === 0 ? (
            <option value={values.workflowId}>{values.workflowId || "Loading…"}</option>
          ) : null}
          {availableWorkflows.map((workflow) => (
            <option key={`${workflow.id}@${workflow.version}`} value={workflow.id}>
              {workflow.displayName} · v{workflow.version}
            </option>
          ))}
        </select>
      </label>

      {governed ? (
        <>
          <label className="form-field">
            <span>Harness profile</span>
            <select
              aria-label="Harness profile"
              required
              value={values.harnessProfileId}
              onChange={(event) =>
                onChange({ ...values, harnessProfileId: event.target.value })
              }
            >
              {runnableProfiles.length === 0 ? (
                <option value={values.harnessProfileId}>
                  {values.harnessProfileId || "No runnable profile"}
                </option>
              ) : null}
              {runnableProfiles.map((profile) => (
                <option key={`${profile.id}@${profile.version}`} value={profile.id}>
                  {profile.displayName} · {profile.status}
                </option>
              ))}
            </select>
          </label>

          <label className="form-field wide">
            <span>Approved Spec</span>
            <select
              aria-label="Approved Spec"
              value={approvedSpecs.some(
                ({ revision }) =>
                  `${revision.specSetId}@${revision.revision}` === selectedSpecKey
              ) ? selectedSpecKey : ""}
              onChange={(event) => {
                const selected = approvedSpecs.find(
                  ({ revision }) =>
                    `${revision.specSetId}@${revision.revision}` === event.target.value
                )?.revision;
                if (!selected?.digest) return;
                onChange({
                  ...values,
                  specSetId: selected.specSetId,
                  specRevision: String(selected.revision),
                  specDigest: selected.digest
                });
              }}
            >
              <option value="">Manual Spec reference</option>
              {approvedSpecs.map(({ record, revision }) => (
                <option
                  key={`${revision.specSetId}@${revision.revision}`}
                  value={`${revision.specSetId}@${revision.revision}`}
                >
                  {record.specSet.title} · r{revision.revision}
                </option>
              ))}
            </select>
          </label>

          <label className="form-field">
            <span>Spec set ID</span>
            <input
              required
              value={values.specSetId}
              onChange={(event) => onChange({ ...values, specSetId: event.target.value })}
            />
          </label>
          <label className="form-field">
            <span>Spec revision</span>
            <input
              required
              inputMode="numeric"
              value={values.specRevision}
              onChange={(event) => onChange({ ...values, specRevision: event.target.value })}
            />
          </label>
          <label className="form-field wide">
            <span>Spec digest</span>
            <input
              required
              pattern="[a-f0-9]{64}"
              value={values.specDigest}
              onChange={(event) => onChange({ ...values, specDigest: event.target.value })}
              placeholder="approved revision SHA-256"
            />
          </label>
          <div className="governed-control-actions wide">
            <button
              className="text-button"
              type="button"
              disabled={loading || !values.specSetId || !values.specRevision}
              onClick={onValidateSpec}
            >
              验证 Spec
            </button>
            {specPreview ? (
              <span className={`state-tag ${specPreview.status === "approved" ? "pass" : "warn"}`}>
                r{specPreview.revision} · {specPreview.status} · {specPreview.source}
              </span>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function GovernanceProjectPanel({
  view,
  loading,
  error
}: {
  view: GovernedProjectViewSummary | null;
  loading: boolean;
  error: string | null;
}) {
  if (!view && !loading && !error) return null;
  const snapshot = view?.governance?.snapshot;
  const explanation = view?.policyExplain?.explanation;
  return (
    <section className="task-subpanel governance-project-panel" aria-label="Effective governance">
      <div className="task-subpanel-heading">
        <strong>Governance &amp; Policy Explain</strong>
        <span>{loading ? "loading" : snapshot ? shortDigest(snapshot.digest) : "unavailable"}</span>
      </div>
      {error ? <div className="inline-alert">{error}</div> : null}
      {snapshot ? (
        <>
          <div className="governance-binding-grid">
            <GovernanceFact label="Sources" value={String(snapshot.layers.length)} />
            <GovernanceFact
              label="Approval"
              value={snapshot.policy.approvalMode}
            />
            <GovernanceFact
              label="Repair budget"
              value={String(snapshot.policy.budgets.maxRepairAttempts ?? "-")}
            />
            <GovernanceFact
              label="Waivers"
              value={String(snapshot.appliedWaivers.length)}
            />
          </div>
          <div className="gate-list governance-gates">
            {snapshot.policy.requiredGates.map((gate) => (
              <span className="gate-chip" key={gate}>{gate}</span>
            ))}
          </div>
          <div className="policy-decision-list" aria-label="Governance diff">
            {(explanation?.decisions ?? snapshot.decisions).map((decision) => (
              <div className="policy-decision-row" key={decision.field}>
                <div>
                  <strong>{decision.field}</strong>
                  <span>{decision.strategy} · {decision.sourceIds.join(", ")}</span>
                </div>
                <code>{compactValue(decision.effectiveValue)}</code>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {view?.spec ? (
        <div className="spec-binding-card" aria-label="Spec binding status">
          <div>
            <strong>{view.spec.title}</strong>
            <span>{view.spec.specSetId} · revision {view.spec.revision}</span>
          </div>
          <span className={`state-tag ${view.spec.status === "approved" ? "pass" : "warn"}`}>
            {view.spec.status}
          </span>
          <p>{view.spec.hypothesis}</p>
          <span>{view.spec.acceptanceCases.length} acceptance cases · digest {shortDigest(view.spec.digest)}</span>
        </div>
      ) : null}

      {view ? (
        <div className="governance-secondary-grid">
          <div aria-label="Trace graph registry">
            <strong>Trace Graphs</strong>
            {view.traceGraphs.length > 0 ? view.traceGraphs.map((record) => (
              <div className="compact-record" key={record.id}>
                <span>{record.id}</span>
                <strong>
                  {record.analysis
                    ? `${Math.round(record.analysis.traceabilityRate * 100)}% traceable`
                    : `${record.graph.nodes.length} nodes`}
                </strong>
              </div>
            )) : <span className="muted-copy">暂无 trace graph</span>}
          </div>
          <div aria-label="Learning proposals">
            <strong>Learning Proposals</strong>
            {view.learningProposals.length > 0 ? view.learningProposals.map((proposal) => (
              <div className="compact-record" key={proposal.id}>
                <span>{proposal.title}</span>
                <strong>{proposal.status} · {proposal.kind}</strong>
              </div>
            )) : <span className="muted-copy">暂无 learning proposal</span>}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function GovernedRunDetail({
  run,
  view,
  approvalBusy,
  onApprove,
  onReject
}: {
  run: RunRecordSummary;
  view: GovernedProjectViewSummary | null;
  approvalBusy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const governed = Boolean(
    run.governanceSnapshot ||
      run.harnessManifest ||
      run.stages?.length ||
      run.gateResultsV2?.length
  );
  if (!governed) return null;
  return (
    <div className="governed-run-detail" aria-label="Governed run detail">
      <div className="governed-control-heading">
        <strong>Governed Increment</strong>
        <span>{run.workflowRef?.id ?? "governed workflow"}</span>
      </div>

      {run.status === "waiting_approval" ? (
        <div className="approval-actions" aria-label="Owner approval">
          <span>Approval/Demo 正在等待人工决策</span>
          <button className="text-button" type="button" disabled={approvalBusy} onClick={onReject}>
            拒绝
          </button>
          <button className="text-button primary" type="button" disabled={approvalBusy} onClick={onApprove}>
            批准并继续
          </button>
        </div>
      ) : null}

      <div className="stage-timeline" aria-label="Governed stage timeline">
        {(run.stages ?? []).map((stage) => (
          <div className={`stage-timeline-row ${stage.status}`} key={stage.id}>
            <span className="stage-marker" aria-hidden="true" />
            <div>
              <strong>{stageLabel(stage.stage)}</strong>
              <span>attempt {stage.attempt} · {stage.status}</span>
            </div>
            <span>{stage.finishedAt ? formatDateTime(stage.finishedAt) : "pending"}</span>
          </div>
        ))}
      </div>

      {run.harnessManifest ? (
        <div className="harness-summary" aria-label="Harness manifest">
          <div>
            <strong>Harness Manifest</strong>
            <span>{run.harnessManifest.profile.id}@{run.harnessManifest.profile.version}</span>
          </div>
          <div className="governance-binding-grid">
            <GovernanceFact label="Sandbox" value={run.harnessManifest.sandbox.enforcement} />
            <GovernanceFact label="Context" value={`${run.harnessManifest.context.usedTokens}/${run.harnessManifest.context.maxTokens} tok`} />
            <GovernanceFact label="Gates" value={String(run.harnessManifest.gatePlan.length)} />
            <GovernanceFact label="Digest" value={shortDigest(run.harnessManifest.digest)} />
          </div>
        </div>
      ) : null}

      <div className="gate-evidence-list" aria-label="GateResultV2 evidence">
        {(run.gateResultsV2 ?? []).map((gate) => (
          <div className="gate-evidence-row" key={gate.id}>
            <div>
              <strong>{gate.gateId}</strong>
              <span>{gate.runnerId} · {gate.tool ? `${gate.tool.id}@${gate.tool.version}` : "built-in"}</span>
            </div>
            <span className={`gate-chip ${gate.status}`}>{gate.status}</span>
            <p>{gate.summary}</p>
            <span>
              {gate.specClauseIds.length} clauses · {gate.artifacts.length} artifacts · output {shortDigest(gate.outputDigest)}
            </span>
          </div>
        ))}
      </div>

      {run.trace ? (
        <div className="trace-summary" aria-label="Run evidence trace">
          <strong>Evidence Trace</strong>
          <span>trace {run.trace.traceId}</span>
          <span>{run.trace.evidenceIds.length} evidence nodes</span>
          <span>
            {view?.traceGraphs.some((record) => record.analysis?.complete)
              ? "trace complete"
              : "trace graph pending or incomplete"}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function GovernanceFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="governance-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function compactValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "-";
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function shortDigest(value?: string): string {
  return value ? `${value.slice(0, 10)}…` : "-";
}

function stageLabel(stage: NonNullable<RunRecordSummary["stages"]>[number]["stage"]): string {
  return stage
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" / ");
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}
