import { digestSpecRevision } from "../src/index.js";
import type { SpecRevision, SpecSet } from "../src/index.js";

export function makeSpecSet(id = "customer-health"): SpecSet {
  return {
    id,
    title: "Customer health",
    latestRevision: 0,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z"
  };
}

export function makeRevision(
  overrides: Partial<SpecRevision> = {}
): SpecRevision {
  const unsigned: SpecRevision = {
    specSetId: "customer-health",
    revision: 1,
    status: "draft",
    source: "native",
    title: "Customer health status",
    hypothesis: "Visible health signals lead to earlier customer follow-up.",
    outcomes: ["Managers can identify at-risk customers."],
    nonGoals: ["Customer export is not part of this increment."],
    targetServices: ["customer-api", "customer-web"],
    contracts: {
      interface: { endpoint: "/v1/customers" },
      data: { owner: "customer-api" },
      state: { values: ["healthy", "watch", "risk", "unknown"] },
      permission: { reader: "customer_success_manager" },
      exception: { forbidden: 403 },
      quality: { p95LatencyMs: 300 },
      observability: { metrics: ["customer_health_view_total"] }
    },
    acceptanceCases: [
      {
        id: "accept-risk-filter",
        kind: "positive",
        title: "Filter at-risk customers",
        given: ["The manager owns an at-risk customer."],
        when: "The manager filters the customer list by risk.",
        then: ["The at-risk customer is visible."]
      }
    ],
    risks: [],
    unknowns: [],
    createdAt: "2026-07-11T00:00:00.000Z",
    createdBy: "product-owner@example.com",
    ...overrides
  };

  if (overrides.digest !== undefined) {
    return unsigned;
  }
  return { ...unsigned, digest: digestSpecRevision(unsigned) };
}
