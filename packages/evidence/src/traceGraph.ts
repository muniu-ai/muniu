import {
  compareCodeUnits,
  declarativeClone,
  deepFreeze,
  digestCanonical,
  exactFields,
  requireDigest,
  requireIdentifier,
  uniqueIdentifiers
} from "./shared.js";

export type TraceNodeKind =
  | "business_hypothesis"
  | "spec_clause"
  | "design_contract"
  | "diff"
  | "test_gate"
  | "approval"
  | "observation";

export type TraceEdgeKind =
  | "derives"
  | "designs"
  | "implements"
  | "verifies"
  | "approves"
  | "observes";

export interface TraceNode {
  readonly id: string;
  readonly kind: TraceNodeKind;
  readonly ref: string;
  readonly digest: string;
  readonly serviceIds: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TraceEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: TraceEdgeKind;
}

export interface TraceGraph {
  readonly schemaVersion: 1;
  readonly nodes: readonly TraceNode[];
  readonly edges: readonly TraceEdge[];
  readonly digest: string;
}

export interface ContractDriftInput {
  readonly ref: string;
  readonly expectedDigest: string;
  readonly actualDigest: string;
}

export interface TraceAnalysis {
  readonly requiredSpecClauseIds: readonly string[];
  readonly coveredSpecClauseIds: readonly string[];
  readonly missingSpecClauseIds: readonly string[];
  readonly traceabilityRate: number;
  readonly orphanDiffNodeIds: readonly string[];
  readonly orphanEvidenceNodeIds: readonly string[];
  readonly contractDriftRefs: readonly string[];
  readonly contextDrift: boolean;
  readonly complete: boolean;
  readonly digest: string;
}

const NODE_FIELDS = new Set(["id", "kind", "ref", "digest", "serviceIds", "metadata"]);
const EDGE_FIELDS = new Set(["from", "to", "kind"]);
const NODE_KINDS = new Set<TraceNodeKind>([
  "business_hypothesis",
  "spec_clause",
  "design_contract",
  "diff",
  "test_gate",
  "approval",
  "observation"
]);
const EDGE_KINDS = new Set<TraceEdgeKind>([
  "derives",
  "designs",
  "implements",
  "verifies",
  "approves",
  "observes"
]);
const EVIDENCE_KINDS = new Set<TraceNodeKind>(["test_gate", "observation"]);

export function createTraceGraph(input: {
  readonly nodes: readonly TraceNode[];
  readonly edges: readonly TraceEdge[];
}): TraceGraph {
  const safe = declarativeClone(input) as unknown as Record<string, unknown>;
  exactFields(safe, new Set(["nodes", "edges"]), "traceGraph");
  if (!Array.isArray(safe.nodes) || !Array.isArray(safe.edges)) {
    throw new TypeError("traceGraph nodes and edges must be arrays");
  }
  const nodes = safe.nodes.map((raw, index) => normalizeNode(raw, index));
  const byId = new Map<string, TraceNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) throw new TypeError(`duplicate trace node ${node.id}`);
    byId.set(node.id, node);
  }
  const edges = safe.edges.map((raw, index) => normalizeEdge(raw, index));
  const identities = new Set<string>();
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) {
      throw new TypeError(`trace edge ${edge.from}->${edge.to} references a missing node`);
    }
    if (edge.from === edge.to) throw new TypeError("trace edges cannot self-reference");
    const identity = `${edge.from}\0${edge.to}\0${edge.kind}`;
    if (identities.has(identity)) throw new TypeError("duplicate trace edge");
    identities.add(identity);
  }
  nodes.sort((left, right) => compareCodeUnits(left.id, right.id));
  edges.sort(
    (left, right) =>
      compareCodeUnits(left.from, right.from) ||
      compareCodeUnits(left.to, right.to) ||
      compareCodeUnits(left.kind, right.kind)
  );
  const semantic = { schemaVersion: 1 as const, nodes, edges };
  return deepFreeze({ ...semantic, digest: digestCanonical(semantic) });
}

export function analyzeTraceGraph(
  graphInput: TraceGraph,
  options: {
    readonly requiredSpecClauseIds: readonly string[];
    readonly contracts?: readonly ContractDriftInput[];
    readonly expectedContextDigest?: string;
    readonly actualContextDigest?: string;
  }
): TraceAnalysis {
  const graph = createTraceGraph({ nodes: graphInput.nodes, edges: graphInput.edges });
  if (graphInput.digest !== graph.digest) throw new TypeError("trace graph digest mismatch");
  const required = uniqueIdentifiers(options.requiredSpecClauseIds, "requiredSpecClauseIds");
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = adjacency(graph.edges, "outgoing");
  const incoming = adjacency(graph.edges, "incoming");
  const covered: string[] = [];
  const missing: string[] = [];
  for (const clause of required) {
    const roots = graph.nodes.filter(
      (node) => node.kind === "spec_clause" && node.ref === clause
    );
    const hasEvidence = roots.some((root) =>
      reachable(root.id, outgoing).some((id) => EVIDENCE_KINDS.has(byId.get(id)!.kind))
    );
    (hasEvidence ? covered : missing).push(clause);
  }
  const orphanDiffNodeIds = graph.nodes
    .filter((node) => node.kind === "diff")
    .filter(
      (node) =>
        !reachable(node.id, incoming).some((id) => byId.get(id)?.kind === "spec_clause")
    )
    .map((node) => node.id)
    .sort(compareCodeUnits);
  const orphanEvidenceNodeIds = graph.nodes
    .filter((node) => EVIDENCE_KINDS.has(node.kind))
    .filter(
      (node) =>
        !reachable(node.id, incoming).some((id) => byId.get(id)?.kind === "spec_clause")
    )
    .map((node) => node.id)
    .sort(compareCodeUnits);
  const contracts = (options.contracts ?? []).map((contract) => ({
    ref: requireIdentifier(contract.ref, "contract.ref"),
    expectedDigest: requireDigest(contract.expectedDigest, "contract.expectedDigest"),
    actualDigest: requireDigest(contract.actualDigest, "contract.actualDigest")
  }));
  const contractDriftRefs = contracts
    .filter((contract) => contract.expectedDigest !== contract.actualDigest)
    .map((contract) => contract.ref)
    .sort(compareCodeUnits);
  const expectedContextDigest =
    options.expectedContextDigest === undefined
      ? undefined
      : requireDigest(options.expectedContextDigest, "expectedContextDigest");
  const actualContextDigest =
    options.actualContextDigest === undefined
      ? undefined
      : requireDigest(options.actualContextDigest, "actualContextDigest");
  if ((expectedContextDigest === undefined) !== (actualContextDigest === undefined)) {
    throw new TypeError("both context digests are required for context drift analysis");
  }
  const contextDrift =
    expectedContextDigest !== undefined && expectedContextDigest !== actualContextDigest;
  const semantic = {
    requiredSpecClauseIds: required,
    coveredSpecClauseIds: covered,
    missingSpecClauseIds: missing,
    traceabilityRate: required.length === 0 ? 1 : covered.length / required.length,
    orphanDiffNodeIds,
    orphanEvidenceNodeIds,
    contractDriftRefs,
    contextDrift,
    complete:
      missing.length === 0 &&
      orphanDiffNodeIds.length === 0 &&
      orphanEvidenceNodeIds.length === 0 &&
      contractDriftRefs.length === 0 &&
      !contextDrift
  };
  return deepFreeze({ ...semantic, digest: digestCanonical(semantic) });
}

function normalizeNode(value: unknown, index: number): TraceNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`traceGraph.nodes[${index}] must be an object`);
  }
  const node = value as Record<string, unknown>;
  exactFields(node, NODE_FIELDS, `traceGraph.nodes[${index}]`);
  if (!NODE_KINDS.has(node.kind as TraceNodeKind)) {
    throw new TypeError(`traceGraph.nodes[${index}].kind is unsupported`);
  }
  if (
    node.metadata !== undefined &&
    (!node.metadata || typeof node.metadata !== "object" || Array.isArray(node.metadata))
  ) {
    throw new TypeError(`traceGraph.nodes[${index}].metadata must be an object`);
  }
  return {
    id: requireIdentifier(node.id, `traceGraph.nodes[${index}].id`),
    kind: node.kind as TraceNodeKind,
    ref: requireIdentifier(node.ref, `traceGraph.nodes[${index}].ref`),
    digest: requireDigest(node.digest, `traceGraph.nodes[${index}].digest`),
    serviceIds: uniqueIdentifiers(
      node.serviceIds,
      `traceGraph.nodes[${index}].serviceIds`
    ),
    ...(node.metadata === undefined
      ? {}
      : { metadata: node.metadata as Readonly<Record<string, unknown>> })
  };
}

function normalizeEdge(value: unknown, index: number): TraceEdge {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`traceGraph.edges[${index}] must be an object`);
  }
  const edge = value as Record<string, unknown>;
  exactFields(edge, EDGE_FIELDS, `traceGraph.edges[${index}]`);
  if (!EDGE_KINDS.has(edge.kind as TraceEdgeKind)) {
    throw new TypeError(`traceGraph.edges[${index}].kind is unsupported`);
  }
  return {
    from: requireIdentifier(edge.from, `traceGraph.edges[${index}].from`),
    to: requireIdentifier(edge.to, `traceGraph.edges[${index}].to`),
    kind: edge.kind as TraceEdgeKind
  };
}

function adjacency(
  edges: readonly TraceEdge[],
  direction: "outgoing" | "incoming"
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const edge of edges) {
    const from = direction === "outgoing" ? edge.from : edge.to;
    const to = direction === "outgoing" ? edge.to : edge.from;
    result.set(from, [...(result.get(from) ?? []), to]);
  }
  return result;
}

function reachable(start: string, graph: ReadonlyMap<string, readonly string[]>): string[] {
  const seen = new Set<string>();
  const queue = [...(graph.get(start) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(graph.get(next) ?? []));
  }
  return [...seen];
}
