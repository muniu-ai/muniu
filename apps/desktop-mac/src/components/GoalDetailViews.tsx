// SPDX-License-Identifier: Apache-2.0
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import "./team-views.css";

export type GoalDetailView = "goal" | "plan" | "progress" | "results";
const views: readonly { id: GoalDetailView; title: string }[] = [
  { id: "goal", title: "目标" }, { id: "plan", title: "计划" },
  { id: "progress", title: "进展" }, { id: "results", title: "成果" },
];

export function GoalDetailViews({ value, onChange, panels }: {
  value: GoalDetailView;
  onChange: (view: GoalDetailView) => void;
  panels: Readonly<Record<GoalDetailView, ReactNode>>;
}) {
  const id = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    switch (event.key) {
      case "ArrowRight": next = (index + 1) % views.length; break;
      case "ArrowLeft": next = (index + views.length - 1) % views.length; break;
      case "Home": next = 0; break;
      case "End": next = views.length - 1; break;
      default: return;
    }
    event.preventDefault();
    onChange(views[next]!.id);
    tabs.current[next]?.focus();
  }
  return <div className="goal-detail-views">
    <div className="goal-detail-tabs" role="tablist" aria-label="任务详情视图">
      {views.map((view, index) => <button key={view.id} type="button" role="tab"
        id={`${id}-tab-${view.id}`} aria-controls={`${id}-panel-${view.id}`}
        aria-selected={value === view.id} tabIndex={value === view.id ? 0 : -1}
        ref={element => { tabs.current[index] = element; }}
        onClick={() => onChange(view.id)} onKeyDown={event => navigate(event, index)}>{view.title}</button>)}
    </div>
    {views.map(view => <section key={view.id} role="tabpanel" id={`${id}-panel-${view.id}`}
      aria-labelledby={`${id}-tab-${view.id}`} tabIndex={0} hidden={value !== view.id}>{panels[view.id]}</section>)}
  </div>;
}
