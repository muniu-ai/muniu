// SPDX-License-Identifier: Apache-2.0
import type { Page } from './navigation.js';
export const BUSINESS_GROUPS = {
  sales: ['customer', 'contact', 'opportunity', 'service_version', 'quote_version', 'contract', 'order'],
  delivery: ['project', 'milestone', 'delivery_version', 'customer_acceptance', 'change_request'],
  finance: ['payment_schedule', 'receipt', 'refund', 'expense', 'adjustment', 'operating_objective', 'business_review', 'metric_definition'],
} as const;
export interface WorkspaceRoute { readonly page: Page; readonly objectType?: string; }
interface RoutePort { read(): string; write(hash: string): void; subscribe(listener: () => void): () => void; }
const pages: readonly Page[] = ['overview', 'attention', 'sales', 'delivery', 'finance', 'knowledge', 'organization', 'workflows', 'connections', 'usage'];
export function parseWorkspaceRoute(hash: string): WorkspaceRoute {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash, separator = raw.indexOf('?'), name = separator < 0 ? raw : raw.slice(0, separator);
  const page = pages.includes(name as Page) ? name as Page : 'overview';
  if (!Object.hasOwn(BUSINESS_GROUPS, page)) return { page };
  const categories: readonly string[] = BUSINESS_GROUPS[page as keyof typeof BUSINESS_GROUPS], query = new URLSearchParams(separator < 0 ? '' : raw.slice(separator + 1));
  const requested = query.getAll('tab');
  const objectType = requested.length === 1 && [...query.keys()].every(key => key === 'tab') && categories.includes(requested[0]!) ? requested[0]! : categories[0]!;
  return { page, objectType };
}
export class WorkspaceRouter {
  private value: WorkspaceRoute; private readonly listeners = new Set<() => void>(); private detach?: () => void;
  constructor(private readonly port: RoutePort) { this.value = Object.freeze(parseWorkspaceRoute(port.read())); }
  readonly snapshot = (): WorkspaceRoute => this.value;
  private update = () => {
    const next = parseWorkspaceRoute(this.port.read());
    if (next.page === this.value.page && next.objectType === this.value.objectType) return;
    this.value = Object.freeze(next); for (const listener of this.listeners) listener();
  };
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.detach) { this.detach = this.port.subscribe(this.update); this.update(); }
    return () => { this.listeners.delete(listener); if (!this.listeners.size) { this.detach?.(); this.detach = undefined; } };
  };
  navigate(page: Page, objectType?: string): void {
    const next = parseWorkspaceRoute('#' + page + (objectType ? '?tab=' + encodeURIComponent(objectType) : ''));
    if (next.page === this.value.page && next.objectType === this.value.objectType) return;
    this.port.write('#' + next.page + (next.objectType ? '?tab=' + encodeURIComponent(next.objectType) : '')); this.update();
  }
}
