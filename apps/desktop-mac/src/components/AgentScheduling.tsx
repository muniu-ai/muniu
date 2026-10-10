// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import type { AgentSchedulingDecisionV2, AgentSchedulingRequestV2, GoalResponseV2, GoalUsageV2, ModelConnectionV2 } from "@mn/contracts";

export const runnerLabel = (id: string) => id === "codex-cli" ? "Codex CLI" : id === "claude-cli" ? "Claude Code" : "木牛内置 Agent";
export function SchedulingControls({ value, onChange, models, disabled = false, currency, onSettings }: {
  value: AgentSchedulingRequestV2; onChange: (next: AgentSchedulingRequestV2) => void; models: readonly ModelConnectionV2[];
  disabled?: boolean; currency: string; onSettings: () => void;
}) {
  const external = value.runnerId === "codex-cli" || value.runnerId === "claude-cli";
  return <fieldset className="agent-scheduling" disabled={disabled}><legend>交给谁来完成</legend>
    <div className="scheduling-fields"><label>执行者<select aria-label="任务执行者" value={value.runnerId} onChange={event => onChange({ ...value, runnerId: event.target.value as AgentSchedulingRequestV2["runnerId"] })}>
      <option value="auto">自动推荐</option><option value="builtin">木牛内置 Agent</option><option value="codex-cli">Codex CLI</option><option value="claude-cli">Claude Code</option></select></label>
      <label>调度偏好<select aria-label="调度偏好" value={value.strategy} onChange={event => onChange({ ...value, strategy: event.target.value as AgentSchedulingRequestV2["strategy"] })}>
        <option value="quality">质量优先</option><option value="balanced">质量与成本均衡</option><option value="cost">质量接近时节省成本</option></select></label>
      {!external && <label>{value.runnerId === "auto" ? "样本不足时优先模型" : "执行模型"}<select aria-label="执行模型" value={value.modelBindingId ?? ""} onChange={event => onChange({ ...value, modelBindingId: event.target.value || undefined })}>
        <option value="">{models.length ? "按可用连接推荐" : "尚无可用模型"}</option>{models.map(model => <option key={model.id} value={model.id} disabled={model.billingCurrency !== currency}>{model.displayName} · {model.defaultModel}{model.billingCurrency !== currency ? "（币种不同）" : ""}</option>)}</select></label>}
    </div>
    <p>{external ? "使用 CLI 自有账户和模型。调用前核对安装身份并请求批准；完成后登记费用。木牛无法实时限制 CLI 账单，额度作为核对边界。" : "优先比较同类任务的验收记录；没有足够样本时明确说明，不推测模型质量。复杂任务仍受本次额度约束。"}</p>
    <details><summary>估计任务收益（可选）</summary><p>填写同一币种的价值与时间成本，供 ROI 估算；不填写时只比较质量、成本和耗时。</p><div className="scheduling-fields">
      <label>完成价值（{currency}，分）<input aria-label="预期任务价值" type="number" min="0" step="1" value={value.expectedValueMinorUnits ?? ""} onChange={event => onChange({ ...value, expectedValueMinorUnits: event.target.value || undefined })} /></label>
      <label>每小时时间成本（{currency}，分）<input aria-label="每小时时间成本" type="number" min="0" step="1" value={value.timeCostMinorUnitsPerHour ?? ""} onChange={event => onChange({ ...value, timeCostMinorUnitsPerHour: event.target.value || undefined })} /></label>
    </div></details><button type="button" className="quiet-button" onClick={onSettings}>检查 Agent 与模型连接</button>
  </fieldset>;
}

export function SchedulingDecision({ decision }: { decision: AgentSchedulingDecisionV2 }) {
  const selected = decision.candidates.find(candidate => candidate.id === decision.selectedId)!;
  const money = (value: string | null, currency: string) => {
    if (value === null) return "待核对";
    const amount = BigInt(value), absolute = amount < 0n ? -amount : amount;
    return `${amount < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")} ${currency}`;
  };
  return <section className="scheduling-decision" aria-label="调度依据"><h3>{decision.request.runnerId === "auto" ? "推荐" : "已指定"}：{selected.label}</h3>
    <p>{decision.request.strategy === "quality" ? "质量优先" : decision.request.strategy === "balanced" ? "兼顾质量与成本" : "在质量接近的候选中降低成本"} · {selected.evidence === "insufficient" ? "同类记录不足，当前为初始估计" : `参考 ${selected.samples} 次已结算任务，其中 ${selected.accepted} 次已验收`}</p>
    <div className="scheduling-table"><table><caption>候选比较 · 估计值不等于厂商账单</caption><thead><tr><th>执行者</th><th>质量依据</th><th>预计执行费</th><th>预计耗时</th><th>可用情况</th></tr></thead><tbody>{decision.candidates.map(candidate => <tr key={candidate.id} className={candidate.id === decision.selectedId ? "selected" : ""}>
      <td>{candidate.label}{candidate.id === decision.selectedId && <strong> · 本次选择</strong>}</td><td>{candidate.evidence === "insufficient" ? `样本不足（${candidate.samples}）` : `验收率保守下界 ${(candidate.qualityLowerBound * 100).toFixed(1)}%`}</td>
      <td>{money(candidate.expectedCostMinorUnits, candidate.currency)}</td><td>{Math.ceil(candidate.expectedDurationMs / 60000)} 分钟</td><td>{candidate.reasons.join("；") || "符合已检查条件"}</td></tr>)}</tbody></table></div>
    {selected.expectedNetValueMinorUnits !== null && <p>估计净收益：{money(selected.expectedNetValueMinorUnits, selected.currency)}；估计 ROI：{selected.roiBasisPoints === null ? "无法计算" : `${(selected.roiBasisPoints / 100).toFixed(1)}%`}。已计入时间与返工成本，仍需实际任务验证。</p>}
    <p>确认后固定执行者、配置版本和预算。历史数据变化或执行失败不会自动换 Agent 重做。</p>
  </section>;
}

export function ExternalUsageForm({ detail, disabled, onSave }: { detail: GoalResponseV2; disabled: boolean; onSave: (usage: GoalUsageV2, source: string) => void }) {
  const [cost, setCost] = useState(""), [tokens, setTokens] = useState(""), [source, setSource] = useState("");
  return <form className="external-usage" aria-label="外部用量核对" onSubmit={event => { event.preventDefault(); if (/^(0|[1-9][0-9]{0,17})$/u.test(cost) && Number.isSafeInteger(Number(tokens)) && Number(tokens) >= 0 && tokens !== "" && source.trim()) onSave({ costMinorUnits: cost, tokens: Number(tokens), currency: detail.goal.budget.currency }, source.trim()); }}>
    <h3>核对 CLI 用量</h3><p>按厂商账单或订阅分摊登记，不将“未知”填为 0。登记后固定记录，再进行成果验收。</p><div className="scheduling-fields">
      <label>实际费用（{detail.goal.budget.currency}，分）<input aria-label="CLI 实际费用" type="number" min="0" step="1" value={cost} onChange={event => setCost(event.target.value)} required disabled={disabled} /></label>
      <label>实际 tokens<input aria-label="CLI 实际 tokens" type="number" min="0" step="1" value={tokens} onChange={event => setTokens(event.target.value)} required disabled={disabled} /></label>
      <label>账单或分摊依据<input aria-label="CLI 账单依据" maxLength={2000} value={source} onChange={event => setSource(event.target.value)} required disabled={disabled} /></label></div><button className="secondary-button" disabled={disabled}>确认用量</button>
  </form>;
}
