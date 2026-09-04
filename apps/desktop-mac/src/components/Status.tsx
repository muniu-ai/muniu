import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, LoaderCircle, RotateCcw } from "lucide-react";

export function Loading({ label = "正在加载" }: { readonly label?: string }) {
  return <div className="state-card" role="status"><LoaderCircle className="spin" size={18} />{label}</div>;
}

export function EmptyState({ title, detail, action }: { readonly title: string; readonly detail: string; readonly action?: ReactNode }) {
  return <div className="empty-state"><CheckCircle2 size={24} /><strong>{title}</strong><p>{detail}</p>{action}</div>;
}

export function ErrorState({ title = "暂时无法加载", detail, action, onRetry }: {
  readonly title?: string;
  readonly detail: string;
  readonly action?: string;
  readonly onRetry?: () => void;
}) {
  return <div className="error-state" role="alert"><AlertTriangle size={22} /><div><strong>{title}</strong><p>{detail}</p>{action && <small>{action}</small>}</div>{onRetry && <button className="quiet-button" onClick={onRetry}><RotateCcw size={15} />重试</button>}</div>;
}
