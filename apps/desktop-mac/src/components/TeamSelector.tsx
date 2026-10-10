// SPDX-License-Identifier: Apache-2.0
import { useId } from "react";
import type { TeamTemplateIdV1, TeamTemplateSummaryV1 } from "@mn/contracts";
import "./team-views.css";

export function TeamSelector({ value, templates, onChange, disabled = false }: {
  value: TeamTemplateIdV1 | null;
  templates: readonly TeamTemplateSummaryV1[];
  onChange: (value: TeamTemplateIdV1 | null) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return <fieldset className="team-selector" disabled={disabled}>
    <legend>执行方式</legend>
    <p>简单任务由单 Agent 完成；需要分工时，请选择团队模板并审阅计划。</p>
    <div className="team-selector-options">
      <label><input type="radio" name={id} aria-label="单 Agent" checked={value === null} onChange={() => onChange(null)} />
        <span><strong>单 Agent</strong><small>沿用当前执行者与任务流程</small></span></label>
      {templates.map(template => <label key={template.id}>
        <input type="radio" name={id} aria-label={template.title} aria-describedby={`${id}-${template.id}-description`}
          checked={value === template.id} disabled={!template.available} onChange={() => onChange(template.id)} />
        <span id={`${id}-${template.id}-description`}><strong>{template.title}</strong><small>{template.description}</small>
          <small>{template.nodeCount} 个步骤 · 版本 {template.version}</small>
          {!template.available && <small className="team-unavailable">{template.unavailableReason || "当前不可用，请检查执行条件"}</small>}</span>
      </label>)}
    </div>
    {value !== null && !templates.some(template => template.id === value) && <p role="status">所选团队暂不可用，请刷新目录或重新选择。原选择已保留。</p>}
  </fieldset>;
}
