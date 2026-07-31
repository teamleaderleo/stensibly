import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import {
  CHANGE_LINEAGE_REASON_CODES,
  CHANGE_LINEAGE_VERSION,
  type ChangeLineageChange,
  type ChangeLineageCheck,
  type ChangeLineageEvaluation,
  type ChangeLineageProjection,
  type ChangeLineageReasonCode,
  type ChangeLineageRewriteEdge,
  type ChangeLineageStackEdge,
  type ChangeLineageRevision,
  type ChangeRevisionReference,
} from "./change-lineage-contract.js";
import {
  codeUnitCompare,
  compareRevisionReferences,
  deepFreeze,
  parseChangeLineageInput,
  revisionKey,
  sameRevisionReference,
} from "./change-lineage-admission.js";

export * from "./change-lineage-contract.js";

const reasonOrder = new Map<ChangeLineageReasonCode, number>(
  CHANGE_LINEAGE_REASON_CODES.map((reason, index) => [reason, index]),
);

export function compileChangeLineage(input: unknown): ChangeLineageProjection {
  const parsed = parseChangeLineageInput(input);
  const changesById = new Map(parsed.changes.map((change) => [change.changeId, change]));
  const revisionsByKey = indexRevisions(parsed.changes);
  validateReferences(parsed.changes, changesById, revisionsByKey);
  rejectChangeCycles(parsed.changes, "supersession");
  rejectChangeCycles(parsed.changes, "dependency");

  const rewriteEdges = buildRewriteEdges(parsed.changes);
  rejectGraphCycles(adjacency(rewriteEdges.map((edge) => [revisionKey(edge.from), revisionKey(edge.to)])), "Change revision lineage cycle detected");
  validateSplitOperations(parsed.changes, rewriteEdges);
  const stackEdges = buildStackEdges(parsed.changes);
  rejectGraphCycles(adjacency(stackEdges.map((edge) => [revisionKey(edge.parent), revisionKey(edge.child)])), "Change stack cycle detected");

  const evaluations = parsed.changes.map(evaluateChange);
  const value = {
    version: CHANGE_LINEAGE_VERSION,
    repository: parsed.repository,
    observedAt: parsed.observedAt,
    changes: parsed.changes,
    rewriteEdges,
    stackEdges,
    evaluations,
    authorizesMutation: false as const,
    authorizesIntegration: false as const,
  };
  return deepFreeze({ ...value, projectionFingerprint: fingerprintCanonicalRequest(value) });
}

function indexRevisions(changes: readonly ChangeLineageChange[]): Map<string, ChangeLineageRevision> {
  const result = new Map<string, ChangeLineageRevision>();
  for (const change of changes) for (const revision of change.revisions) {
    result.set(revisionKey({ changeId: change.changeId, revisionId: revision.revisionId }), revision);
  }
  return result;
}

function validateReferences(
  changes: readonly ChangeLineageChange[],
  changesById: ReadonlyMap<string, ChangeLineageChange>,
  revisionsByKey: ReadonlyMap<string, ChangeLineageRevision>,
): void {
  for (const change of changes) {
    if (change.supersededBy !== null && !changesById.has(change.supersededBy)) {
      throw new RangeError(`Change ${change.changeId} names missing superseder ${change.supersededBy}`);
    }
    for (const dependency of change.semanticDependencies) if (!changesById.has(dependency)) {
      throw new RangeError(`Change ${change.changeId} names missing semantic dependency ${dependency}`);
    }
    for (const revision of change.revisions) {
      const current = { changeId: change.changeId, revisionId: revision.revisionId };
      for (const predecessor of revision.predecessors) {
        validateRevisionReference(predecessor, current, revision, revisionsByKey, "predecessor");
      }
      if (revision.stackParent !== null) {
        validateRevisionReference(revision.stackParent, current, revision, revisionsByKey, "stack parent");
      }
    }
  }
}

function validateRevisionReference(
  reference: ChangeRevisionReference,
  current: ChangeRevisionReference,
  currentRevision: ChangeLineageRevision,
  revisionsByKey: ReadonlyMap<string, ChangeLineageRevision>,
  label: string,
): void {
  if (sameRevisionReference(reference, current)) throw new RangeError(`Revision cannot name itself as ${label}`);
  const target = revisionsByKey.get(revisionKey(reference));
  if (!target) throw new RangeError(`Revision names missing ${label} ${reference.changeId}@${reference.revisionId}`);
  if (Date.parse(target.observedAt) > Date.parse(currentRevision.observedAt)) throw new RangeError(`Revision ${label} follows the child observation`);
  if (reference.changeId === current.changeId && target.generation >= currentRevision.generation) {
    throw new RangeError(`Revision ${label} must use an earlier generation`);
  }
}

function rejectChangeCycles(changes: readonly ChangeLineageChange[], kind: "supersession" | "dependency"): void {
  const edges: [string, string][] = [];
  for (const change of changes) {
    const targets = kind === "supersession"
      ? change.supersededBy === null ? [] : [change.supersededBy]
      : change.semanticDependencies;
    for (const target of targets) edges.push([change.changeId, target]);
  }
  rejectGraphCycles(adjacency(edges), kind === "supersession"
    ? "Change supersession cycle detected"
    : "Change semantic dependency cycle detected");
}

function buildRewriteEdges(changes: readonly ChangeLineageChange[]): ChangeLineageRewriteEdge[] {
  const result: ChangeLineageRewriteEdge[] = [];
  for (const change of changes) for (const revision of change.revisions) {
    const to = { changeId: change.changeId, revisionId: revision.revisionId };
    for (const from of revision.predecessors) result.push(deepFreeze({ from, to, operation: revision.operation }));
  }
  return result.sort((a, b) => compareRevisionReferences(a.from, b.from)
    || compareRevisionReferences(a.to, b.to) || codeUnitCompare(a.operation, b.operation));
}

function buildStackEdges(changes: readonly ChangeLineageChange[]): ChangeLineageStackEdge[] {
  const result: ChangeLineageStackEdge[] = [];
  for (const change of changes) for (const revision of change.revisions) {
    if (revision.stackParent !== null) result.push(deepFreeze({
      parent: revision.stackParent,
      child: { changeId: change.changeId, revisionId: revision.revisionId },
    }));
  }
  return result.sort((a, b) => compareRevisionReferences(a.parent, b.parent)
    || compareRevisionReferences(a.child, b.child));
}

function validateSplitOperations(changes: readonly ChangeLineageChange[], edges: readonly ChangeLineageRewriteEdge[]): void {
  const counts = new Map<string, number>();
  for (const edge of edges) if (edge.operation === "split") {
    counts.set(revisionKey(edge.from), (counts.get(revisionKey(edge.from)) ?? 0) + 1);
  }
  for (const change of changes) for (const revision of change.revisions) if (revision.operation === "split") {
    const predecessor = revision.predecessors[0]!;
    if ((counts.get(revisionKey(predecessor)) ?? 0) < 2) {
      throw new RangeError(`Split predecessor ${predecessor.changeId}@${predecessor.revisionId} requires at least two split successors`);
    }
  }
}

function adjacency(edges: readonly [string, string][]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [from, to] of edges) {
    const targets = result.get(from) ?? [];
    targets.push(to);
    result.set(from, targets);
    if (!result.has(to)) result.set(to, []);
  }
  return result;
}

function rejectGraphCycles(graph: ReadonlyMap<string, readonly string[]>, message: string): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (node: string): void => {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      const start = path.indexOf(node);
      throw new RangeError(`${message}: ${[...path.slice(start), node].join(" -> ")}`);
    }
    visiting.add(node);
    path.push(node);
    for (const next of graph.get(node) ?? []) visit(next);
    path.pop();
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of graph.keys()) visit(node);
}

function evaluateChange(change: ChangeLineageChange): ChangeLineageEvaluation {
  const reasons = new Set<ChangeLineageReasonCode>();
  if (change.lifecycle === "superseded") reasons.add("change_superseded");
  else if (change.lifecycle === "merged") reasons.add("change_merged");
  else if (change.lifecycle === "abandoned") reasons.add("change_abandoned");

  const reviewFresh = change.reviewedRevisionId === change.currentRevisionId;
  if (change.lifecycle === "open") {
    if (change.reviewDisposition === "none" || change.reviewDisposition === "commented") reasons.add("review_missing");
    if (change.reviewedRevisionId !== null && !reviewFresh) reasons.add("review_stale");
    if (change.reviewDisposition === "changes_requested") reasons.add("review_changes_requested");
    if (change.unresolvedThreads > 0) reasons.add("review_threads_unresolved");
  }

  const checksByName = new Map<string, ChangeLineageCheck[]>();
  for (const check of change.checks) checksByName.set(check.name, [...(checksByName.get(check.name) ?? []), check]);
  let checksFresh = true;
  for (const name of change.requiredChecks) {
    const checks = checksByName.get(name) ?? [];
    const current = checks.find((check) => check.revisionId === change.currentRevisionId);
    if (!current) {
      checksFresh = false;
      if (change.lifecycle === "open") {
        reasons.add(checks.length === 0 ? "required_check_missing" : "required_check_stale");
      }
      continue;
    }
    if (change.lifecycle !== "open") continue;
    if (["failure", "cancelled", "neutral", "skipped"].includes(current.conclusion)) {
      reasons.add("required_check_failed");
    } else if (current.conclusion === "pending") {
      reasons.add("required_check_pending");
    }
  }

  let state: ChangeLineageEvaluation["state"];
  if (change.lifecycle === "superseded") state = "superseded";
  else if (change.lifecycle !== "open") state = "historical";
  else if (["review_missing", "review_stale", "review_changes_requested", "review_threads_unresolved"]
    .some((reason) => reasons.has(reason as ChangeLineageReasonCode))) state = "waiting_for_review";
  else if (["required_check_missing", "required_check_stale", "required_check_failed", "required_check_pending"]
    .some((reason) => reasons.has(reason as ChangeLineageReasonCode))) state = "waiting_for_checks";
  else { state = "ready"; reasons.add("ready"); }

  return deepFreeze({
    changeId: change.changeId,
    currentRevisionId: change.currentRevisionId,
    state,
    reasons: [...reasons].sort((a, b) => reasonOrder.get(a)! - reasonOrder.get(b)!),
    reviewFresh,
    checksFresh,
    authorizesMutation: false as const,
    authorizesIntegration: false as const,
  });
}