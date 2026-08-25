export const CODEX_ROOT_ROUTING_V1 = 1 as const;

export type CodexRootRoutingCandidateId =
  | "architecture_integration"
  | "bounded_hot_path"
  | "settled_implementation";

export type CodexRootRoutingCandidateWorkloadClass =
  | "architecture_integration"
  | "bounded_hot_path"
  | "settled_implementation";

export type CodexRootRoutingTradeoff =
  | "reasoned_integration"
  | "latency"
  | "high_certainty_settlement";

export type CodexRootRuntimeModel =
  | "gpt-5.6-sol"
  | "gpt-5.3-codex-spark"
  | "gpt-5.6-luna";

export type CodexRootRoutingEffort = "high" | "medium" | "max";

export interface CodexRootRoutingCandidate {
  readonly id: CodexRootRoutingCandidateId;
  readonly model: CodexRootRuntimeModel;
  readonly effort: CodexRootRoutingEffort;
  readonly workloadClass: CodexRootRoutingCandidateWorkloadClass;
  readonly tradeoff: CodexRootRoutingTradeoff;
}

const candidates = Object.freeze([
  Object.freeze({
    id: "architecture_integration" as const,
    model: "gpt-5.6-sol" as const,
    effort: "high" as const,
    workloadClass: "architecture_integration" as const,
    tradeoff: "reasoned_integration" as const,
  }),
  Object.freeze({
    id: "bounded_hot_path" as const,
    model: "gpt-5.3-codex-spark" as const,
    effort: "medium" as const,
    workloadClass: "bounded_hot_path" as const,
    tradeoff: "latency" as const,
  }),
  Object.freeze({
    id: "settled_implementation" as const,
    model: "gpt-5.6-luna" as const,
    effort: "max" as const,
    workloadClass: "settled_implementation" as const,
    tradeoff: "high_certainty_settlement" as const,
  }),
] as const);

const lookup = Object.freeze({
  architecture_integration: candidates[0],
  bounded_hot_path: candidates[1],
  settled_implementation: candidates[2],
} as const);

export function codexRootRoutingCandidates(): readonly CodexRootRoutingCandidate[] {
  return candidates;
}

export function codexRootRoutingCandidateById(
  candidateId: string,
): CodexRootRoutingCandidate {
  if (candidateId in lookup) {
    return lookup[candidateId as CodexRootRoutingCandidateId];
  }
  const expected = candidates.map((candidate) => candidate.id).join(", ");
  throw new RangeError(`Unknown Codex root routing candidate id: ${candidateId}; expected one of ${expected}`);
}
