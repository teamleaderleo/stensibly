import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export const COORDINATION_GRAPH_SCHEMA_VERSION = 1 as const;
export const COORDINATION_GRAPH_COMPILER_REVISION = "coordination-graph-core/3" as const;
export const COORDINATION_GRAPH_MAX_NODES = 500;
export const COORDINATION_GRAPH_MAX_EDGES = 2_000;

export const COORDINATION_NODE_KINDS = [
  "source",
  "evidence",
  "review",
  "decision",
  "authority",
  "action",
  "output",
  "projection",
] as const;
export const COORDINATION_DECLARED_STATES = [
  "pending",
  "accepted",
  "failed",
  "ambiguous",
  "revoked",
  "unknown",
] as const;
export const COORDINATION_RECEIPT_STATUSES = ["accepted", "failed", "ambiguous"] as const;
export const COORDINATION_READINESS_EDGE_TYPES = [
  "requires",
  "blocked_by",
  "consumes_evidence",
  "requires_review",
  "requires_decision",
  "requires_authority",
  "produces",
] as const;
export const COORDINATION_CAUSAL_EDGE_TYPES = [
  "supersedes",
  "caused_by",
  "continues",
  "recovers",
  "related",
] as const;
export const COORDINATION_EVALUATION_STATES = [
  "accepted",
  "eligible",
  "blocked",
  "failed",
  "ambiguous",
  "stale",
  "revoked",
  "unknown",
] as const;

export type CoordinationNodeKind = typeof COORDINATION_NODE_KINDS[number];
export type CoordinationDeclaredState = typeof COORDINATION_DECLARED_STATES[number];
export type CoordinationReceiptStatus = typeof COORDINATION_RECEIPT_STATUSES[number];
export type CoordinationReadinessEdgeType = typeof COORDINATION_READINESS_EDGE_TYPES[number];
export type CoordinationCausalEdgeType = typeof COORDINATION_CAUSAL_EDGE_TYPES[number];
export type CoordinationEvaluationState = typeof COORDINATION_EVALUATION_STATES[number];

export interface CoordinationNodeReference {
  id: string;
  generation: number;
}

export interface CoordinationReceipt {
  inputFingerprint: string;
  outputFingerprint: string;
  status: CoordinationReceiptStatus;
  observedAt: string;
  expiresAt: string | null;
}

export interface CoordinationGraphNode extends CoordinationNodeReference {
  kind: CoordinationNodeKind;
  workspace: string;
  project: string;
  definitionFingerprint: string;
  environmentFingerprint: string | null;
  policyVersion: string;
  authorityGeneration: number | null;
  owner: string | null;
  selectedProducer?: CoordinationNodeReference | null;
  declaredState: CoordinationDeclaredState;
  receipt: CoordinationReceipt | null;
}

export interface CoordinationReadinessEdge {
  layer: "readiness";
  type: CoordinationReadinessEdgeType;
  from: CoordinationNodeReference;
  to: CoordinationNodeReference;
  competitionId?: string;
}

export interface CoordinationCausalEdge {
  layer: "causal";
  type: CoordinationCausalEdgeType;
  from: CoordinationNodeReference;
  to: CoordinationNodeReference;
}

export type CoordinationGraphEdge = CoordinationReadinessEdge | CoordinationCausalEdge;

export interface CoordinationGraph {
  schemaVersion: typeof COORDINATION_GRAPH_SCHEMA_VERSION;
  workspace: string;
  project: string;
  policyVersion: string;
  nodes: CoordinationGraphNode[];
  edges: CoordinationGraphEdge[];
}

export interface CoordinationNodeEvaluation {
  key: string;
  state: CoordinationEvaluationState;
  expectedInputFingerprint: string | null;
  outputFingerprint: string | null;
  affected: boolean;
  reasons: string[];
}

export interface CoordinationGraphEvaluation {
  schemaVersion: 1;
  graphFingerprint: string;
  evaluatedAt: string;
  changedNodeKeys: string[];
  affectedNodeKeys: string[];
  topologicalOrder: string[];
  nodes: CoordinationNodeEvaluation[];
}

export interface CoordinationGraphComparison {
  changedNodeKeys: string[];
  addedNodeKeys: string[];
  removedNodeKeys: string[];
}

export interface CoordinationFingerprintDependency {
  key: string;
  type: CoordinationReadinessEdgeType;
  outputFingerprint: string;
  competitionId?: string;
}

export interface CoordinationEvaluationOptions {
  evaluatedAt: string;
  changedNodeKeys?: readonly string[];
}

const graphKeys = ["schemaVersion", "workspace", "project", "policyVersion", "nodes", "edges"] as const;
const nodeKeys = [
  "id",
  "generation",
  "kind",
  "workspace",
  "project",
  "definitionFingerprint",
  "environmentFingerprint",
  "policyVersion",
  "authorityGeneration",
  "owner",
  "selectedProducer",
  "declaredState",
  "receipt",
] as const;
const nodeRequiredKeys = [
  "id",
  "generation",
  "kind",
  "workspace",
  "project",
  "definitionFingerprint",
  "environmentFingerprint",
  "policyVersion",
  "authorityGeneration",
  "owner",
  "declaredState",
  "receipt",
] as const;
const receiptKeys = ["inputFingerprint", "outputFingerprint", "status", "observedAt", "expiresAt"] as const;
const referenceKeys = ["id", "generation"] as const;
const causalEdgeKeys = ["layer", "type", "from", "to"] as const;
const readinessEdgeKeys = ["layer", "type", "from", "to", "competitionId"] as const;
const readinessEdgeRequiredKeys = ["layer", "type", "from", "to"] as const;
const dependencyKeys = ["key", "type", "outputFingerprint", "competitionId"] as const;
const dependencyRequiredKeys = ["key", "type", "outputFingerprint"] as const;
const evaluationOptionKeys = ["evaluatedAt", "changedNodeKeys"] as const;
const issuedEvaluations = new WeakSet<object>();

export function coordinationNodeKey(reference: CoordinationNodeReference): string {
  return `${reference.id}@${reference.generation}`;
}

export function canonicalizeCoordinationGraph(input: unknown): CoordinationGraph {
  const record = exactRecord(input, graphKeys, graphKeys, "Coordination graph");
  if (record.schemaVersion !== COORDINATION_GRAPH_SCHEMA_VERSION) {
    throw new Error("Coordination graph schema version is unsupported");
  }
  const workspace = boundedSlug(record.workspace, "Coordination workspace", 80);
  const project = boundedSlug(record.project, "Coordination project", 80);
  const policyVersion = boundedIdentifier(record.policyVersion, "Coordination policy version", 120);
  const rawNodes = exactArray(record.nodes, "Coordination graph nodes", COORDINATION_GRAPH_MAX_NODES);
  const rawEdges = exactArray(record.edges, "Coordination graph edges", COORDINATION_GRAPH_MAX_EDGES);

  const nodes = rawNodes.map((node) => parseNode(node, workspace, project));
  const nodeIdentity = new Set<string>();
  for (const node of nodes) {
    const key = coordinationNodeKey(node);
    if (nodeIdentity.has(key)) throw new Error(`Duplicate coordination node ${key}`);
    nodeIdentity.add(key);
  }

  const edges = rawEdges.map(parseEdge);
  const edgeIdentity = new Set<string>();
  for (const edge of edges) {
    const from = coordinationNodeKey(edge.from);
    const to = coordinationNodeKey(edge.to);
    if (!nodeIdentity.has(from)) throw new Error(`Coordination edge source ${from} is missing`);
    if (!nodeIdentity.has(to)) throw new Error(`Coordination edge target ${to} is missing`);
    if (edge.layer === "readiness" && from === to) {
      throw new Error(`Readiness node ${from} cannot depend on itself`);
    }
    const key = coordinationEdgeKey(edge);
    if (edgeIdentity.has(key)) throw new Error(`Duplicate coordination edge ${key}`);
    edgeIdentity.add(key);
  }

  const graph: CoordinationGraph = {
    schemaVersion: 1,
    workspace,
    project,
    policyVersion,
    nodes: [...nodes].sort((left, right) =>
      codeUnitCompare(coordinationNodeKey(left), coordinationNodeKey(right))
    ),
    edges: [...edges].sort((left, right) =>
      codeUnitCompare(coordinationEdgeKey(left), coordinationEdgeKey(right))
    ),
  };
  validateExclusiveProducers(graph);
  validateCompetitionSelections(graph);
  topologicalReadinessOrder(graph);
  return graph;
}

export function coordinationGraphFingerprint(graph: CoordinationGraph): string {
  return fingerprintCanonicalRequest(canonicalizeCoordinationGraph(graph));
}

export function coordinationNodeInputFingerprint(
  nodeInput: CoordinationGraphNode,
  dependenciesInput: readonly CoordinationFingerprintDependency[],
  graphPolicyVersionInput: string,
): string {
  const workspace = boundedSlug(nodeInput.workspace, "Coordination node workspace", 80);
  const project = boundedSlug(nodeInput.project, "Coordination node project", 80);
  const node = parseNode(nodeInput, workspace, project);
  const graphPolicyVersion = boundedIdentifier(
    graphPolicyVersionInput,
    "Coordination graph policy version",
    120,
  );
  const dependencies = exactArray(
    dependenciesInput,
    "Coordination fingerprint dependencies",
    COORDINATION_GRAPH_MAX_EDGES,
  ).map(parseFingerprintDependency).sort(compareDependencies);

  return fingerprintCanonicalRequest({
    schemaVersion: 1,
    compilerRevision: COORDINATION_GRAPH_COMPILER_REVISION,
    graphPolicyVersion,
    node: {
      id: node.id,
      generation: node.generation,
      kind: node.kind,
      workspace: node.workspace,
      project: node.project,
      definitionFingerprint: node.definitionFingerprint,
      environmentFingerprint: node.environmentFingerprint,
      policyVersion: node.policyVersion,
      authorityGeneration: node.authorityGeneration,
      owner: node.owner,
      selectedProducer: node.selectedProducer ?? null,
    },
    dependencies,
  });
}

export function compareCoordinationGraphs(
  previousInput: CoordinationGraph,
  candidateInput: CoordinationGraph,
): CoordinationGraphComparison {
  const previous = canonicalizeCoordinationGraph(previousInput);
  const candidate = canonicalizeCoordinationGraph(candidateInput);
  if (previous.workspace !== candidate.workspace || previous.project !== candidate.project) {
    throw new Error("Coordination graph snapshots must share workspace and project");
  }

  const previousNodes = new Map(previous.nodes.map((node) => [coordinationNodeKey(node), node]));
  const candidateNodes = new Map(candidate.nodes.map((node) => [coordinationNodeKey(node), node]));
  const addedNodeKeys = [...candidateNodes.keys()].filter((key) => !previousNodes.has(key)).sort();
  const removedNodeKeys = [...previousNodes.keys()].filter((key) => !candidateNodes.has(key)).sort();
  const changed = new Set<string>([...addedNodeKeys, ...removedNodeKeys]);

  for (const [key, node] of candidateNodes) {
    const prior = previousNodes.get(key);
    if (prior && stableJson(prior) !== stableJson(node)) changed.add(key);
  }

  const previousEdges = new Map(previous.edges.map((edge) => [coordinationEdgeKey(edge), edge]));
  const candidateEdges = new Map(candidate.edges.map((edge) => [coordinationEdgeKey(edge), edge]));
  for (const [key, edge] of candidateEdges) {
    if (edge.layer === "readiness" && !previousEdges.has(key)) {
      changed.add(coordinationNodeKey(edge.to));
    }
  }
  for (const [key, edge] of previousEdges) {
    if (
      edge.layer === "readiness"
      && !candidateEdges.has(key)
      && candidateNodes.has(coordinationNodeKey(edge.to))
    ) {
      changed.add(coordinationNodeKey(edge.to));
    }
  }
  if (previous.policyVersion !== candidate.policyVersion) {
    for (const key of candidateNodes.keys()) changed.add(key);
  }

  return {
    changedNodeKeys: [...changed].sort(),
    addedNodeKeys,
    removedNodeKeys,
  };
}

export function evaluateCoordinationGraph(
  input: CoordinationGraph,
  options: CoordinationEvaluationOptions,
): CoordinationGraphEvaluation {
  const graph = canonicalizeCoordinationGraph(input);
  const admittedOptions = parseCoordinationEvaluationOptions(options);
  const evaluatedAt = admittedOptions.evaluatedAt;
  const nodeMap = new Map(graph.nodes.map((node) => [coordinationNodeKey(node), node]));
  const changed = new Set(admittedOptions.changedNodeKeys.map((key) => {
    if (!nodeMap.has(key)) throw new Error(`Changed coordination node ${key} is missing`);
    return key;
  }));
  const affected = affectedReadinessNodes(graph, changed);
  const order = topologicalReadinessOrder(graph);
  const incoming = readinessIncomingEdges(graph);
  const evaluations = new Map<string, CoordinationNodeEvaluation>();

  for (const key of order) {
    const node = nodeMap.get(key)!;
    const dependencyEdges = incoming.get(key) ?? [];
    const dependencyResult = evaluateDependencies(node, dependencyEdges, evaluations);
    const isAffected = affected.has(key);

    if (node.declaredState === "revoked") {
      evaluations.set(key, nodeEvaluation(key, "revoked", isAffected, null, null, [
        "node authority or accepted state was revoked",
      ]));
      continue;
    }
    if (node.declaredState === "unknown") {
      evaluations.set(key, nodeEvaluation(key, "unknown", isAffected, null, null, [
        "node state is explicitly unknown",
      ]));
      continue;
    }
    if (dependencyResult.blockers.length) {
      evaluations.set(key, nodeEvaluation(
        key,
        "blocked",
        isAffected,
        null,
        null,
        dependencyResult.blockers,
      ));
      continue;
    }

    const expectedInputFingerprint = coordinationNodeInputFingerprint(
      node,
      dependencyResult.dependencies,
      graph.policyVersion,
    );
    const receipt = node.receipt;
    if (!receipt) {
      evaluations.set(key, nodeEvaluation(
        key,
        isAffected && node.declaredState === "accepted" ? "stale" : "eligible",
        isAffected,
        expectedInputFingerprint,
        null,
        [isAffected
          ? "node is downstream of a changed graph input without fresh exact proof"
          : "no accepted receipt exists for the complete input fingerprint"],
      ));
      continue;
    }
    if (receipt.inputFingerprint !== expectedInputFingerprint) {
      evaluations.set(key, nodeEvaluation(key, "stale", isAffected, expectedInputFingerprint, null, [
        "receipt input fingerprint does not match the complete declared inputs",
      ]));
      continue;
    }
    if (receipt.observedAt > evaluatedAt) {
      evaluations.set(key, nodeEvaluation(key, "stale", isAffected, expectedInputFingerprint, null, [
        "receipt observation occurs after the immutable evaluation time",
      ]));
      continue;
    }
    if (receipt.expiresAt !== null && receipt.expiresAt <= evaluatedAt) {
      evaluations.set(key, nodeEvaluation(key, "stale", isAffected, expectedInputFingerprint, null, [
        "receipt freshness window expired",
      ]));
      continue;
    }
    if (receipt.status === "accepted" && node.declaredState === "accepted") {
      evaluations.set(key, nodeEvaluation(
        key,
        "accepted",
        isAffected,
        expectedInputFingerprint,
        receipt.outputFingerprint,
        [isAffected
          ? "fresh accepted receipt proves the reevaluated complete inputs"
          : "accepted receipt matches the complete declared inputs"],
      ));
      continue;
    }
    if (receipt.status === "failed" && node.declaredState === "failed") {
      evaluations.set(key, nodeEvaluation(key, "failed", isAffected, expectedInputFingerprint, null, [
        isAffected
          ? "fresh failure receipt proves the reevaluated complete inputs"
          : "accepted failure receipt matches the complete declared inputs",
      ]));
      continue;
    }
    if (receipt.status === "ambiguous" && node.declaredState === "ambiguous") {
      evaluations.set(key, nodeEvaluation(key, "ambiguous", isAffected, expectedInputFingerprint, null, [
        isAffected
          ? "fresh ambiguity receipt proves the reevaluated complete inputs"
          : "accepted ambiguity receipt requires reconciliation",
      ]));
      continue;
    }
    evaluations.set(key, nodeEvaluation(key, "stale", isAffected, expectedInputFingerprint, null, [
      "declared state and receipt disposition do not agree",
    ]));
  }

  const result = deepFreeze({
    schemaVersion: 1 as const,
    graphFingerprint: fingerprintCanonicalRequest(graph),
    evaluatedAt,
    changedNodeKeys: [...changed].sort(),
    affectedNodeKeys: [...affected].sort(),
    topologicalOrder: order,
    nodes: order.map((key) => evaluations.get(key)!),
  });
  issuedEvaluations.add(result);
  return result;
}

export function evaluateCoordinationGraphChange(
  previous: CoordinationGraph,
  candidate: CoordinationGraph,
  evaluatedAt: string,
): CoordinationGraphEvaluation {
  const comparison = compareCoordinationGraphs(previous, candidate);
  const candidateKeys = new Set(
    canonicalizeCoordinationGraph(candidate).nodes.map(coordinationNodeKey),
  );
  return evaluateCoordinationGraph(candidate, {
    evaluatedAt,
    changedNodeKeys: comparison.changedNodeKeys.filter((key) => candidateKeys.has(key)),
  });
}

export function renderCoordinationQueueMarkdown(
  graph: CoordinationGraph,
  evaluationOrOptions: CoordinationGraphEvaluation | CoordinationEvaluationOptions,
): string {
  const canonical = canonicalizeCoordinationGraph(graph);
  let evaluationResult: CoordinationGraphEvaluation;
  if (
    evaluationOrOptions
    && typeof evaluationOrOptions === "object"
    && issuedEvaluations.has(evaluationOrOptions)
  ) {
    evaluationResult = evaluationOrOptions as CoordinationGraphEvaluation;
    if (coordinationGraphFingerprint(canonical) !== evaluationResult.graphFingerprint) {
      throw new Error("Coordination queue graph does not match its evaluation receipt");
    }
  } else {
    evaluationResult = evaluateCoordinationGraph(
      canonical,
      evaluationOrOptions as CoordinationEvaluationOptions,
    );
  }

  const nodeMap = new Map(canonical.nodes.map((node) => [coordinationNodeKey(node), node]));
  const priority: Record<CoordinationEvaluationState, number> = {
    ambiguous: 0,
    failed: 1,
    stale: 2,
    blocked: 3,
    eligible: 4,
    unknown: 5,
    revoked: 6,
    accepted: 7,
  };
  const rows = [...evaluationResult.nodes].sort((left, right) =>
    priority[left.state] - priority[right.state] || codeUnitCompare(left.key, right.key)
  );
  const lines = [
    `# Coordination queue · ${canonical.workspace}/${canonical.project}`,
    "",
    `Graph: \`${evaluationResult.graphFingerprint}\``,
    `Evaluated: ${evaluationResult.evaluatedAt}`,
    "",
  ];
  for (const row of rows) {
    const node = nodeMap.get(row.key)!;
    lines.push(`## ${row.state.toUpperCase()} · ${row.key}`);
    lines.push(`Kind: ${node.kind}${node.owner ? ` · Owner: ${node.owner}` : ""}`);
    lines.push(`Reason: ${row.reasons.join("; ")}`);
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

function evaluateDependencies(
  target: CoordinationGraphNode,
  edges: readonly CoordinationReadinessEdge[],
  evaluations: ReadonlyMap<string, CoordinationNodeEvaluation>,
): {
  blockers: string[];
  dependencies: CoordinationFingerprintDependency[];
} {
  const blockers: string[] = [];
  const dependencies: CoordinationFingerprintDependency[] = [];
  const competitionGroups = new Map<string, CoordinationReadinessEdge[]>();

  for (const edge of edges) {
    if (edge.type === "produces" && edge.competitionId) {
      const group = competitionGroups.get(edge.competitionId) ?? [];
      group.push(edge);
      competitionGroups.set(edge.competitionId, group);
      continue;
    }
    const key = coordinationNodeKey(edge.from);
    const dependency = evaluations.get(key)!;
    if (dependency.state !== "accepted" || !dependency.outputFingerprint) {
      blockers.push(`${key} is ${dependency.state}`);
      continue;
    }
    dependencies.push({
      key,
      type: edge.type,
      outputFingerprint: dependency.outputFingerprint,
    });
  }

  for (const [competitionId, group] of [...competitionGroups.entries()].sort(([left], [right]) =>
    codeUnitCompare(left, right)
  )) {
    if (!target.selectedProducer) {
      blockers.push(`competition ${competitionId} requires an explicit selected producer`);
      continue;
    }
    const selectedKey = coordinationNodeKey(target.selectedProducer);
    const selected = group.find((edge) => coordinationNodeKey(edge.from) === selectedKey);
    if (!selected) {
      blockers.push(`competition ${competitionId} does not contain selected producer ${selectedKey}`);
      continue;
    }
    const evaluation = evaluations.get(selectedKey)!;
    if (evaluation.state !== "accepted" || !evaluation.outputFingerprint) {
      blockers.push(`${selectedKey} is ${evaluation.state}`);
      continue;
    }
    dependencies.push({
      key: selectedKey,
      type: selected.type,
      outputFingerprint: evaluation.outputFingerprint,
      competitionId,
    });
  }

  return {
    blockers: [...new Set(blockers)].sort(codeUnitCompare),
    dependencies: dependencies.sort(compareDependencies),
  };
}

function parseCoordinationEvaluationOptions(input: unknown): {
  evaluatedAt: string;
  changedNodeKeys: string[];
} {
  if (input === undefined) {
    throw new Error("Coordination evaluation time must be a canonical UTC timestamp");
  }
  const record = exactRecord(
    input,
    evaluationOptionKeys,
    [] as const,
    "Coordination evaluation options",
  );
  return {
    evaluatedAt: canonicalTimestamp(record.evaluatedAt, "Coordination evaluation time"),
    changedNodeKeys: record.changedNodeKeys === undefined
      ? []
      : exactArray(
        record.changedNodeKeys,
        "Changed coordination nodes",
        COORDINATION_GRAPH_MAX_NODES,
      ).map(boundedNodeKey),
  };
}

function parseNode(
  input: unknown,
  graphWorkspace: string,
  graphProject: string,
): CoordinationGraphNode {
  const record = exactRecord(input, nodeKeys, nodeRequiredKeys, "Coordination node");
  const workspace = boundedSlug(record.workspace, "Coordination node workspace", 80);
  const project = boundedSlug(record.project, "Coordination node project", 80);
  if (workspace !== graphWorkspace || project !== graphProject) {
    throw new Error("Coordination node must match the graph workspace and project");
  }
  return {
    id: boundedIdentifier(record.id, "Coordination node ID", 160),
    generation: positiveInteger(record.generation, "Coordination node generation"),
    kind: closedValue(record.kind, COORDINATION_NODE_KINDS, "Coordination node kind"),
    workspace,
    project,
    definitionFingerprint: sha256(record.definitionFingerprint, "Coordination definition fingerprint"),
    environmentFingerprint: nullableSha256(
      record.environmentFingerprint,
      "Coordination environment fingerprint",
    ),
    policyVersion: boundedIdentifier(record.policyVersion, "Coordination node policy version", 120),
    authorityGeneration: record.authorityGeneration === null
      ? null
      : positiveInteger(record.authorityGeneration, "Coordination authority generation"),
    owner: record.owner === null
      ? null
      : boundedIdentifier(record.owner, "Coordination node owner", 160),
    selectedProducer: record.selectedProducer === undefined || record.selectedProducer === null
      ? null
      : parseReference(record.selectedProducer, "Coordination selected producer"),
    declaredState: closedValue(
      record.declaredState,
      COORDINATION_DECLARED_STATES,
      "Coordination declared state",
    ),
    receipt: record.receipt === null ? null : parseReceipt(record.receipt),
  };
}

function parseReceipt(input: unknown): CoordinationReceipt {
  const record = exactRecord(input, receiptKeys, receiptKeys, "Coordination receipt");
  const observedAt = canonicalTimestamp(record.observedAt, "Coordination receipt observation time");
  const expiresAt = record.expiresAt === null
    ? null
    : canonicalTimestamp(record.expiresAt, "Coordination receipt expiry time");
  if (expiresAt !== null && expiresAt <= observedAt) {
    throw new Error("Coordination receipt expiry must follow its observation time");
  }
  return {
    inputFingerprint: sha256(record.inputFingerprint, "Coordination receipt input fingerprint"),
    outputFingerprint: sha256(record.outputFingerprint, "Coordination receipt output fingerprint"),
    status: closedValue(record.status, COORDINATION_RECEIPT_STATUSES, "Coordination receipt status"),
    observedAt,
    expiresAt,
  };
}

function parseEdge(input: unknown): CoordinationGraphEdge {
  const discriminator = exactRecord(
    input,
    readinessEdgeKeys,
    readinessEdgeRequiredKeys,
    "Coordination edge",
  );
  const layer = closedValue(
    discriminator.layer,
    ["readiness", "causal"] as const,
    "Coordination edge layer",
  );
  if (layer === "causal") {
    const record = exactRecord(input, causalEdgeKeys, causalEdgeKeys, "Coordination causal edge");
    return {
      layer,
      type: closedValue(record.type, COORDINATION_CAUSAL_EDGE_TYPES, "Coordination causal edge type"),
      from: parseReference(record.from, "Coordination edge source"),
      to: parseReference(record.to, "Coordination edge target"),
    };
  }

  const type = closedValue(
    discriminator.type,
    COORDINATION_READINESS_EDGE_TYPES,
    "Coordination readiness edge type",
  );
  const competitionId = discriminator.competitionId === undefined
    ? undefined
    : boundedIdentifier(discriminator.competitionId, "Coordination competition ID", 160);
  if (type !== "produces" && competitionId !== undefined) {
    throw new Error("Only produces edges may declare a competition ID");
  }
  return {
    layer,
    type,
    from: parseReference(discriminator.from, "Coordination edge source"),
    to: parseReference(discriminator.to, "Coordination edge target"),
    ...(competitionId ? { competitionId } : {}),
  };
}

function parseReference(input: unknown, label: string): CoordinationNodeReference {
  const record = exactRecord(input, referenceKeys, referenceKeys, label);
  return {
    id: boundedIdentifier(record.id, `${label} ID`, 160),
    generation: positiveInteger(record.generation, `${label} generation`),
  };
}

function parseFingerprintDependency(input: unknown): CoordinationFingerprintDependency {
  const record = exactRecord(
    input,
    dependencyKeys,
    dependencyRequiredKeys,
    "Coordination fingerprint dependency",
  );
  return {
    key: boundedNodeKey(record.key),
    type: closedValue(
      record.type,
      COORDINATION_READINESS_EDGE_TYPES,
      "Coordination dependency edge type",
    ),
    outputFingerprint: sha256(
      record.outputFingerprint,
      "Coordination dependency output fingerprint",
    ),
    ...(record.competitionId === undefined
      ? {}
      : {
        competitionId: boundedIdentifier(
          record.competitionId,
          "Coordination dependency competition ID",
          160,
        ),
      }),
  };
}

function validateExclusiveProducers(graph: CoordinationGraph): void {
  const producers = new Map<string, CoordinationReadinessEdge[]>();
  for (const edge of graph.edges) {
    if (edge.layer !== "readiness" || edge.type !== "produces") continue;
    const target = coordinationNodeKey(edge.to);
    const current = producers.get(target) ?? [];
    current.push(edge);
    producers.set(target, current);
  }
  for (const [target, edges] of producers) {
    if (edges.length < 2) continue;
    const competitionIds = new Set(edges.map((edge) => edge.competitionId ?? ""));
    if (competitionIds.size !== 1 || competitionIds.has("")) {
      throw new Error(`Exclusive coordination output ${target} has competing producers`);
    }
  }
}

function validateCompetitionSelections(graph: CoordinationGraph): void {
  const nodeMap = new Map(graph.nodes.map((node) => [coordinationNodeKey(node), node]));
  const competitionProducers = new Map<string, CoordinationReadinessEdge[]>();
  for (const edge of graph.edges) {
    if (edge.layer !== "readiness" || edge.type !== "produces" || !edge.competitionId) continue;
    const target = coordinationNodeKey(edge.to);
    const current = competitionProducers.get(target) ?? [];
    current.push(edge);
    competitionProducers.set(target, current);
  }
  for (const node of graph.nodes) {
    if (!node.selectedProducer) continue;
    const target = coordinationNodeKey(node);
    const group = competitionProducers.get(target);
    if (!group) {
      throw new Error(`Coordination node ${target} selects a producer without a competition`);
    }
    const selectedKey = coordinationNodeKey(node.selectedProducer);
    if (!nodeMap.has(selectedKey)) {
      throw new Error(`Coordination selected producer ${selectedKey} is missing`);
    }
    if (!group.some((edge) => coordinationNodeKey(edge.from) === selectedKey)) {
      throw new Error(`Coordination selected producer ${selectedKey} is outside competition for ${target}`);
    }
  }
}

function topologicalReadinessOrder(graph: CoordinationGraph): string[] {
  const keys = graph.nodes.map(coordinationNodeKey).sort(codeUnitCompare);
  const indegree = new Map(keys.map((key) => [key, 0]));
  const outgoing = new Map(keys.map((key) => [key, [] as string[]]));
  for (const edge of graph.edges) {
    if (edge.layer !== "readiness") continue;
    const from = coordinationNodeKey(edge.from);
    const to = coordinationNodeKey(edge.to);
    indegree.set(to, indegree.get(to)! + 1);
    outgoing.get(from)!.push(to);
  }
  for (const targets of outgoing.values()) targets.sort(codeUnitCompare);
  const ready = keys.filter((key) => indegree.get(key) === 0).sort(codeUnitCompare);
  const result: string[] = [];
  while (ready.length) {
    const key = ready.shift()!;
    result.push(key);
    for (const target of outgoing.get(key)!) {
      const next = indegree.get(target)! - 1;
      indegree.set(target, next);
      if (next === 0) insertSorted(ready, target);
    }
  }
  if (result.length !== keys.length) {
    const emitted = new Set(result);
    const cycle = keys.filter((key) => !emitted.has(key));
    throw new Error(`Readiness graph contains a dependency cycle: ${cycle.join(", ")}`);
  }
  return result;
}

function affectedReadinessNodes(
  graph: CoordinationGraph,
  changed: ReadonlySet<string>,
): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.layer !== "readiness") continue;
    const from = coordinationNodeKey(edge.from);
    const targets = outgoing.get(from) ?? [];
    targets.push(coordinationNodeKey(edge.to));
    outgoing.set(from, targets);
  }
  const affected = new Set(changed);
  const queue = [...changed].sort(codeUnitCompare);
  while (queue.length) {
    const key = queue.shift()!;
    for (const target of (outgoing.get(key) ?? []).sort(codeUnitCompare)) {
      if (affected.has(target)) continue;
      affected.add(target);
      queue.push(target);
    }
  }
  return affected;
}

function readinessIncomingEdges(graph: CoordinationGraph): Map<string, CoordinationReadinessEdge[]> {
  const incoming = new Map<string, CoordinationReadinessEdge[]>();
  for (const edge of graph.edges) {
    if (edge.layer !== "readiness") continue;
    const target = coordinationNodeKey(edge.to);
    const current = incoming.get(target) ?? [];
    current.push(edge);
    incoming.set(target, current);
  }
  for (const edges of incoming.values()) {
    edges.sort((left, right) => codeUnitCompare(
      coordinationEdgeKey(left),
      coordinationEdgeKey(right),
    ));
  }
  return incoming;
}

function nodeEvaluation(
  key: string,
  state: CoordinationEvaluationState,
  affected: boolean,
  expectedInputFingerprint: string | null,
  outputFingerprint: string | null,
  reasons: string[],
): CoordinationNodeEvaluation {
  return {
    key,
    state,
    expectedInputFingerprint,
    outputFingerprint,
    affected,
    reasons: [...new Set(reasons)].sort(codeUnitCompare),
  };
}

function coordinationEdgeKey(edge: CoordinationGraphEdge): string {
  return [
    edge.layer,
    edge.type,
    coordinationNodeKey(edge.from),
    coordinationNodeKey(edge.to),
    edge.layer === "readiness" ? edge.competitionId ?? "" : "",
  ].join("|");
}

function compareDependencies(
  left: CoordinationFingerprintDependency,
  right: CoordinationFingerprintDependency,
): number {
  return codeUnitCompare(left.key, right.key)
    || codeUnitCompare(left.type, right.type)
    || codeUnitCompare(left.competitionId ?? "", right.competitionId ?? "");
}

function boundedNodeKey(value: unknown): string {
  if (typeof value !== "string") throw new Error("Coordination node key must be a string");
  const match = /^(.+)@([1-9][0-9]*)$/.exec(value.trim());
  if (!match) throw new Error("Coordination node key is invalid");
  return coordinationNodeKey({
    id: boundedIdentifier(match[1], "Coordination node key ID", 160),
    generation: positiveInteger(Number(match[2]), "Coordination node key generation"),
  });
}

function boundedSlug(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (
    normalized.length < 1
    || normalized.length > maximum
    || !/^[a-z0-9][a-z0-9_-]*$/.test(normalized)
  ) {
    throw new Error(`${label} must be a bounded lowercase slug`);
  }
  return normalized;
}

function boundedIdentifier(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (
    normalized.length < 1
    || normalized.length > maximum
    || !/^[A-Za-z0-9][A-Za-z0-9._:/@#-]*$/.test(normalized)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 identifier`);
  }
  return value;
}

function nullableSha256(value: unknown, label: string): string | null {
  return value === null ? null : sha256(value, label);
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a canonical UTC timestamp`);
  const canonical = new Date(parsed).toISOString();
  const supplied = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
  if (canonical !== supplied) throw new Error(`${label} must be a canonical UTC timestamp`);
  return canonical;
}

function closedValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value as T[number])) {
    throw new Error(`${label} is invalid`);
  }
  return value as T[number];
}

function exactRecord<const Allowed extends readonly string[], const Required extends readonly string[]>(
  value: unknown,
  allowedKeys: Allowed,
  requiredKeys: Required,
  label: string,
): Record<Allowed[number], unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`${label} contains a symbol field`);
  }
  const allowed = new Set<string>(allowedKeys);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field ${key}`);
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} field ${key} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(descriptors, key)) throw new Error(`${label} is missing field ${key}`);
  }
  return result as Record<Allowed[number], unknown>;
}

function exactArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must contain at most ${maximum} entries`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must use the default array prototype`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`${label} contains a symbol field`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    if (key === "length") continue;
    if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      throw new Error(`${label} contains unknown field ${key}`);
    }
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor) throw new Error(`${label} must be dense`);
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} must contain enumerable data entries`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function insertSorted(values: string[], value: string): void {
  let index = 0;
  while (index < values.length && values[index]! < value) index += 1;
  values.splice(index, 0, value);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
