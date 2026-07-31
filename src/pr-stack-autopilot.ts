import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export const PR_STACK_AUTOPILOT_VERSION = 2 as const;

export const PR_STACK_LIFECYCLES = ["open", "closed", "merged"] as const;
export const PR_STACK_MERGEABILITY = [
  "mergeable",
  "conflicting",
  "unknown",
] as const;
export const PR_STACK_CHECK_CONCLUSIONS = [
  "success",
  "failure",
  "cancelled",
  "pending",
  "skipped",
  "neutral",
] as const;
export const PR_STACK_REVIEW_DISPOSITIONS = [
  "approved",
  "changes_requested",
  "commented",
  "none",
] as const;
export const PR_STACK_STATES = [
  "ready_to_integrate",
  "waiting_for_checks",
  "waiting_for_review",
  "waiting_for_dependency",
  "stale_base",
  "head_changed_after_review",
  "overlapping_candidate",
  "conflicted",
  "draft_execution_surface",
  "recovery_required",
  "observation_refresh_required",
  "inactive_closed",
  "inactive_merged",
  "superseded_candidate",
] as const;
export const PR_STACK_RECOMMENDATIONS = [
  "continue",
  "review",
  "repair",
  "restack",
  "integrate_dependency_first",
  "partition",
  "merge",
  "refresh_observation",
  "archive",
] as const;
export const PR_STACK_REASON_CODES = [
  "candidate_superseded",
  "candidate_merged",
  "candidate_closed",
  "draft",
  "merge_conflict",
  "mergeability_unknown",
  "base_stale",
  "dependency_superseded",
  "dependency_closed",
  "dependency_merged",
  "dependency_open",
  "review_missing",
  "review_stale",
  "review_changes_requested",
  "review_threads_unresolved",
  "required_check_missing",
  "required_check_pending",
  "required_check_failed",
  "required_check_stale",
  "overlapping_paths",
  "overlapping_added_blob",
  "overlapping_outcome",
  "ready",
] as const;

export type PrStackLifecycle = typeof PR_STACK_LIFECYCLES[number];
export type PrStackMergeability = typeof PR_STACK_MERGEABILITY[number];
export type PrStackCheckConclusion = typeof PR_STACK_CHECK_CONCLUSIONS[number];
export type PrStackReviewDisposition = typeof PR_STACK_REVIEW_DISPOSITIONS[number];
export type PrStackState = typeof PR_STACK_STATES[number];
export type PrStackRecommendation = typeof PR_STACK_RECOMMENDATIONS[number];
export type PrStackReasonCode = typeof PR_STACK_REASON_CODES[number];

export interface PrStackCheck {
  name: string;
  headSha: string;
  conclusion: PrStackCheckConclusion;
}

export interface PrStackCandidate {
  number: number;
  url: string;
  lifecycle: PrStackLifecycle;
  closedAt: string | null;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  supersededBy: number | null;
  baseRef: string;
  baseSha: string;
  mergeBaseSha: string;
  aheadBy: number;
  behindBy: number;
  headRef: string;
  headSha: string;
  draft: boolean;
  mergeability: PrStackMergeability;
  dependencies: number[];
  changedPaths: string[];
  addedBlobShas: string[];
  outcomeClaim: string | null;
  requiredChecks: string[];
  checks: PrStackCheck[];
  reviewedHeadSha: string | null;
  reviewDisposition: PrStackReviewDisposition;
  unresolvedThreads: number;
}

export interface PrStackOverlap {
  otherNumber: number;
  sharedPathCount: number;
  sharedPaths: string[];
  sharedAddedBlobCount: number;
  sharedAddedBlobShas: string[];
  sameOutcomeClaim: boolean;
}

export interface PrStackEvaluation {
  number: number;
  headSha: string;
  state: PrStackState;
  recommendation: PrStackRecommendation;
  reasons: PrStackReasonCode[];
  dependencies: number[];
  overlaps: PrStackOverlap[];
  authorizesMutation: false;
}

export interface PrStackProjection {
  version: typeof PR_STACK_AUTOPILOT_VERSION;
  repository: string;
  mainSha: string;
  observedAt: string;
  candidates: PrStackCandidate[];
  evaluations: PrStackEvaluation[];
  projectionFingerprint: string;
}

interface ParsedInput {
  repository: string;
  mainSha: string;
  observedAt: string;
  candidates: PrStackCandidate[];
}

const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const overlapEvidenceLimit = 20;
const reasonOrder = new Map<PrStackReasonCode, number>(
  PR_STACK_REASON_CODES.map((reason, index) => [reason, index]),
);

export function compilePrStackProjection(input: unknown): PrStackProjection {
  const parsed = parseInput(input);
  const candidatesByNumber = new Map(
    parsed.candidates.map((candidate) => [candidate.number, candidate]),
  );
  validateLifecycleObservations(parsed.candidates, parsed.observedAt);
  validateDependencies(parsed.candidates, candidatesByNumber);
  validateSupersession(parsed.candidates, candidatesByNumber);
  validateBaseBindings(parsed.candidates, parsed.mainSha, candidatesByNumber);
  rejectDependencyCycles(parsed.candidates, candidatesByNumber);

  const overlaps = buildOverlaps(parsed.candidates);
  const evaluations = parsed.candidates.map((candidate) =>
    evaluateCandidate(
      candidate,
      candidatesByNumber,
      overlaps.get(candidate.number) ?? [],
    )
  );
  const withoutFingerprint = {
    version: PR_STACK_AUTOPILOT_VERSION,
    repository: parsed.repository,
    mainSha: parsed.mainSha,
    observedAt: parsed.observedAt,
    candidates: parsed.candidates,
    evaluations,
  };
  return deepFreeze({
    ...withoutFingerprint,
    projectionFingerprint: fingerprintCanonicalRequest(withoutFingerprint),
  });
}

function parseInput(input: unknown): ParsedInput {
  const record = exactRecord(
    input,
    ["repository", "mainSha", "observedAt", "candidates"],
    "PR stack input",
  );
  const repository = repositoryName(record.repository);
  const mainSha = commitSha(record.mainSha, "PR stack main SHA");
  const observedAt = canonicalTimestamp(record.observedAt, "PR stack observation time");
  const candidates = exactArray(record.candidates, "PR stack candidates", 0, 100)
    .map((candidate) => parseCandidate(candidate, repository))
    .sort((left, right) => left.number - right.number);

  const numbers = new Set<number>();
  const headRefs = new Set<string>();
  for (const candidate of candidates) {
    if (numbers.has(candidate.number)) {
      throw new RangeError(`PR stack contains duplicate pull request ${candidate.number}`);
    }
    if (headRefs.has(candidate.headRef)) {
      throw new RangeError(`PR stack contains duplicate head ref ${candidate.headRef}`);
    }
    numbers.add(candidate.number);
    headRefs.add(candidate.headRef);
  }
  return { repository, mainSha, observedAt, candidates };
}

function parseCandidate(input: unknown, repository: string): PrStackCandidate {
  const record = exactRecord(
    input,
    [
      "number",
      "url",
      "lifecycle",
      "closedAt",
      "mergedAt",
      "mergeCommitSha",
      "supersededBy",
      "baseRef",
      "baseSha",
      "mergeBaseSha",
      "aheadBy",
      "behindBy",
      "headRef",
      "headSha",
      "draft",
      "mergeability",
      "dependencies",
      "changedPaths",
      "addedBlobShas",
      "outcomeClaim",
      "requiredChecks",
      "checks",
      "reviewedHeadSha",
      "reviewDisposition",
      "unresolvedThreads",
    ],
    "PR stack candidate",
  );
  const number = positiveInteger(record.number, "Pull request number", 1_000_000_000);
  const lifecycle = closedValue(
    record.lifecycle,
    PR_STACK_LIFECYCLES,
    "Pull request lifecycle",
  );
  const closedAt = nullableTimestamp(record.closedAt, "Pull request closed time");
  const mergedAt = nullableTimestamp(record.mergedAt, "Pull request merged time");
  const mergeCommitSha = nullableSha(
    record.mergeCommitSha,
    "Pull request merge commit SHA",
  );
  const supersededBy = nullablePositiveInteger(
    record.supersededBy,
    "Pull request superseder",
    1_000_000_000,
  );
  validateLifecycleTuple(
    lifecycle,
    closedAt,
    mergedAt,
    mergeCommitSha,
  );

  const reviewDisposition = closedValue(
    record.reviewDisposition,
    PR_STACK_REVIEW_DISPOSITIONS,
    "Pull request review disposition",
  );
  const reviewedHeadSha = record.reviewedHeadSha === null
    ? null
    : commitSha(record.reviewedHeadSha, "Pull request reviewed head SHA");
  if (reviewDisposition === "none" && reviewedHeadSha !== null) {
    throw new RangeError("Pull request without a review cannot carry a reviewed head SHA");
  }
  if (reviewDisposition !== "none" && reviewedHeadSha === null) {
    throw new RangeError("Pull request review requires an exact reviewed head SHA");
  }

  const candidate: PrStackCandidate = {
    number,
    url: pullRequestUrl(record.url, repository, number),
    lifecycle,
    closedAt,
    mergedAt,
    mergeCommitSha,
    supersededBy,
    baseRef: gitRef(record.baseRef, "Pull request base ref"),
    baseSha: commitSha(record.baseSha, "Pull request base SHA"),
    mergeBaseSha: commitSha(record.mergeBaseSha, "Pull request merge-base SHA"),
    aheadBy: nonNegativeInteger(record.aheadBy, "Pull request ahead count", 1_000_000),
    behindBy: nonNegativeInteger(record.behindBy, "Pull request behind count", 1_000_000),
    headRef: gitRef(record.headRef, "Pull request head ref"),
    headSha: commitSha(record.headSha, "Pull request head SHA"),
    draft: booleanValue(record.draft, "Pull request draft state"),
    mergeability: closedValue(
      record.mergeability,
      PR_STACK_MERGEABILITY,
      "Pull request mergeability",
    ),
    dependencies: numberList(record.dependencies, "Pull request dependencies", 50),
    changedPaths: pathList(record.changedPaths, "Pull request changed paths", 2_000),
    addedBlobShas: shaList(record.addedBlobShas, "Pull request added blobs", 2_000),
    outcomeClaim: record.outcomeClaim === null
      ? null
      : outcomeClaim(record.outcomeClaim),
    requiredChecks: stringList(
      record.requiredChecks,
      "Pull request required checks",
      100,
      160,
    ),
    checks: parseChecks(record.checks),
    reviewedHeadSha,
    reviewDisposition,
    unresolvedThreads: nonNegativeInteger(
      record.unresolvedThreads,
      "Pull request unresolved review threads",
      10_000,
    ),
  };

  if (candidate.supersededBy === candidate.number) {
    throw new RangeError("Pull request cannot supersede itself");
  }
  if (candidate.baseRef === candidate.headRef) {
    throw new RangeError("Pull request base and head refs must differ");
  }
  if (candidate.baseSha === candidate.headSha) {
    throw new RangeError("Pull request base and head SHAs must differ");
  }
  if (
    candidate.aheadBy === 0
    && candidate.mergeBaseSha !== candidate.headSha
  ) {
    throw new RangeError("Pull request zero-ahead ancestry is inconsistent");
  }
  if (
    candidate.aheadBy > 0
    && candidate.mergeBaseSha === candidate.headSha
  ) {
    throw new RangeError("Pull request ahead ancestry is inconsistent");
  }
  if (isActive(candidate) && candidate.aheadBy === 0) {
    throw new RangeError(
      "Active pull request head must advance beyond its merge base",
    );
  }
  if (candidate.behindBy === 0 && candidate.mergeBaseSha !== candidate.baseSha) {
    throw new RangeError("Pull request current-base ancestry is inconsistent");
  }
  if (candidate.behindBy > 0 && candidate.mergeBaseSha === candidate.baseSha) {
    throw new RangeError("Pull request stale-base ancestry is inconsistent");
  }
  const checkNames = new Set<string>();
  for (const check of candidate.checks) {
    if (checkNames.has(check.name)) {
      throw new RangeError(`Pull request contains duplicate check ${check.name}`);
    }
    checkNames.add(check.name);
  }
  if (candidate.reviewDisposition === "none" && candidate.unresolvedThreads > 0) {
    throw new RangeError("Pull request without a review cannot carry unresolved threads");
  }
  return deepFreeze(candidate);
}

function validateLifecycleTuple(
  lifecycle: PrStackLifecycle,
  closedAt: string | null,
  mergedAt: string | null,
  mergeCommitSha: string | null,
): void {
  if (lifecycle === "open") {
    if (closedAt !== null || mergedAt !== null || mergeCommitSha !== null) {
      throw new RangeError("Open pull request cannot carry terminal lifecycle identity");
    }
    return;
  }
  if (lifecycle === "closed") {
    if (closedAt === null || mergedAt !== null || mergeCommitSha !== null) {
      throw new RangeError("Closed pull request lifecycle identity is inconsistent");
    }
    return;
  }
  if (closedAt === null || mergedAt === null || mergeCommitSha === null) {
    throw new RangeError("Merged pull request requires closure and merge identity");
  }
  if (Date.parse(mergedAt) > Date.parse(closedAt)) {
    throw new RangeError("Pull request merge time cannot follow its close time");
  }
}

function validateLifecycleObservations(
  candidates: readonly PrStackCandidate[],
  observedAt: string,
): void {
  const observationTime = Date.parse(observedAt);
  for (const candidate of candidates) {
    for (const [label, timestamp] of [
      ["close", candidate.closedAt],
      ["merge", candidate.mergedAt],
    ] as const) {
      if (timestamp !== null && Date.parse(timestamp) > observationTime) {
        throw new RangeError(
          `Pull request ${candidate.number} ${label} time follows the stack observation`,
        );
      }
    }
  }
}

function validateDependencies(
  candidates: readonly PrStackCandidate[],
  candidatesByNumber: ReadonlyMap<number, PrStackCandidate>,
): void {
  for (const candidate of candidates) {
    for (const dependency of candidate.dependencies) {
      if (dependency === candidate.number) {
        throw new RangeError(`Pull request ${candidate.number} cannot depend on itself`);
      }
      if (!candidatesByNumber.has(dependency)) {
        throw new RangeError(
          `Pull request ${candidate.number} depends on missing pull request ${dependency}`,
        );
      }
    }
  }
}

function validateSupersession(
  candidates: readonly PrStackCandidate[],
  candidatesByNumber: ReadonlyMap<number, PrStackCandidate>,
): void {
  for (const candidate of candidates) {
    if (
      candidate.supersededBy !== null
      && !candidatesByNumber.has(candidate.supersededBy)
    ) {
      throw new RangeError(
        `Pull request ${candidate.number} names missing superseder ${candidate.supersededBy}`,
      );
    }
  }
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (number: number): void => {
    if (visited.has(number)) return;
    if (visiting.has(number)) {
      throw new RangeError("PR stack supersession cycle detected");
    }
    visiting.add(number);
    const superseder = candidatesByNumber.get(number)!.supersededBy;
    if (superseder !== null) visit(superseder);
    visiting.delete(number);
    visited.add(number);
  };
  for (const candidate of candidates) visit(candidate.number);
}

function validateBaseBindings(
  candidates: readonly PrStackCandidate[],
  mainSha: string,
  candidatesByNumber: ReadonlyMap<number, PrStackCandidate>,
): void {
  for (const candidate of candidates) {
    if (candidate.baseRef === "main") {
      if (isActive(candidate) && candidate.baseSha !== mainSha) {
        throw new RangeError(
          `Pull request ${candidate.number} main base SHA does not match the observed main SHA`,
        );
      }
      continue;
    }
    const matchingDependency = candidate.dependencies
      .map((number) => candidatesByNumber.get(number)!)
      .find((dependency) => dependency.headRef === candidate.baseRef);
    if (!matchingDependency) {
      throw new RangeError(
        `Pull request ${candidate.number} base ref must match main or an explicit dependency head`,
      );
    }
    if (
      isActive(candidate)
      && candidate.baseSha !== matchingDependency.headSha
    ) {
      throw new RangeError(
        `Pull request ${candidate.number} stacked base SHA does not match dependency ${matchingDependency.number}`,
      );
    }
  }
}

function rejectDependencyCycles(
  candidates: readonly PrStackCandidate[],
  candidatesByNumber: ReadonlyMap<number, PrStackCandidate>,
): void {
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const path: number[] = [];
  const visit = (number: number): void => {
    if (visited.has(number)) return;
    if (visiting.has(number)) {
      const start = path.indexOf(number);
      throw new RangeError(
        `PR stack dependency cycle detected: ${[
          ...path.slice(start),
          number,
        ].join(" -> ")}`,
      );
    }
    visiting.add(number);
    path.push(number);
    for (const dependency of candidatesByNumber.get(number)!.dependencies) {
      visit(dependency);
    }
    path.pop();
    visiting.delete(number);
    visited.add(number);
  };
  for (const candidate of candidates) visit(candidate.number);
}

function parseChecks(value: unknown): PrStackCheck[] {
  return exactArray(value, "Pull request checks", 0, 200)
    .map((input) => {
      const record = exactRecord(
        input,
        ["name", "headSha", "conclusion"],
        "Pull request check",
      );
      return {
        name: exactText(record.name, "Pull request check name", 160),
        headSha: commitSha(record.headSha, "Pull request check head SHA"),
        conclusion: closedValue(
          record.conclusion,
          PR_STACK_CHECK_CONCLUSIONS,
          "Pull request check conclusion",
        ),
      } satisfies PrStackCheck;
    })
    .sort((left, right) => codeUnitCompare(left.name, right.name));
}

function buildOverlaps(
  candidates: readonly PrStackCandidate[],
): Map<number, PrStackOverlap[]> {
  const result = new Map<number, PrStackOverlap[]>(
    candidates.map((candidate) => [candidate.number, []]),
  );
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const left = candidates[leftIndex]!;
      const right = candidates[rightIndex]!;
      const allSharedPaths = intersection(left.changedPaths, right.changedPaths);
      const allSharedAddedBlobShas = intersection(
        left.addedBlobShas,
        right.addedBlobShas,
      );
      const sameOutcomeClaim = left.outcomeClaim !== null
        && left.outcomeClaim === right.outcomeClaim;
      if (
        allSharedPaths.length === 0
        && allSharedAddedBlobShas.length === 0
        && !sameOutcomeClaim
      ) continue;
      const common = {
        sharedPathCount: allSharedPaths.length,
        sharedPaths: allSharedPaths.slice(0, overlapEvidenceLimit),
        sharedAddedBlobCount: allSharedAddedBlobShas.length,
        sharedAddedBlobShas: allSharedAddedBlobShas.slice(
          0,
          overlapEvidenceLimit,
        ),
        sameOutcomeClaim,
      };
      result.get(left.number)!.push({ otherNumber: right.number, ...common });
      result.get(right.number)!.push({ otherNumber: left.number, ...common });
    }
  }
  for (const overlaps of result.values()) {
    overlaps.sort((left, right) => left.otherNumber - right.otherNumber);
    for (const overlap of overlaps) deepFreeze(overlap);
  }
  return result;
}

function evaluateCandidate(
  candidate: PrStackCandidate,
  candidatesByNumber: ReadonlyMap<number, PrStackCandidate>,
  overlaps: readonly PrStackOverlap[],
): PrStackEvaluation {
  if (candidate.supersededBy !== null) {
    return evaluationResult(
      candidate,
      "superseded_candidate",
      "archive",
      ["candidate_superseded"],
      overlaps,
    );
  }
  if (candidate.lifecycle === "merged") {
    return evaluationResult(
      candidate,
      "inactive_merged",
      "archive",
      ["candidate_merged"],
      overlaps,
    );
  }
  if (candidate.lifecycle === "closed") {
    return evaluationResult(
      candidate,
      "inactive_closed",
      "archive",
      ["candidate_closed"],
      overlaps,
    );
  }

  const reasons = new Set<PrStackReasonCode>();
  if (candidate.draft) reasons.add("draft");
  if (candidate.mergeability === "conflicting") reasons.add("merge_conflict");
  if (candidate.mergeability === "unknown") reasons.add("mergeability_unknown");
  if (candidate.behindBy > 0) reasons.add("base_stale");

  for (const dependencyNumber of candidate.dependencies) {
    const dependency = candidatesByNumber.get(dependencyNumber)!;
    if (dependency.supersededBy !== null) reasons.add("dependency_superseded");
    else if (dependency.lifecycle === "closed") reasons.add("dependency_closed");
    else if (dependency.lifecycle === "merged") reasons.add("dependency_merged");
    else reasons.add("dependency_open");
  }

  if (
    candidate.reviewDisposition === "none"
    || candidate.reviewDisposition === "commented"
  ) reasons.add("review_missing");
  if (
    candidate.reviewedHeadSha !== null
    && candidate.reviewedHeadSha !== candidate.headSha
  ) reasons.add("review_stale");
  if (candidate.reviewDisposition === "changes_requested") {
    reasons.add("review_changes_requested");
  }
  if (candidate.unresolvedThreads > 0) reasons.add("review_threads_unresolved");

  const checksByName = new Map(candidate.checks.map((check) => [check.name, check]));
  for (const requiredCheck of candidate.requiredChecks) {
    const check = checksByName.get(requiredCheck);
    if (!check) reasons.add("required_check_missing");
    else if (check.headSha !== candidate.headSha) reasons.add("required_check_stale");
    else if (check.conclusion === "failure" || check.conclusion === "cancelled") {
      reasons.add("required_check_failed");
    } else if (check.conclusion !== "success") reasons.add("required_check_pending");
  }

  const blockingOverlaps = overlaps.filter((overlap) => {
    const other = candidatesByNumber.get(overlap.otherNumber)!;
    return isActive(other)
      && !isStackedOn(candidate.number, other.number, candidatesByNumber)
      && !isStackedOn(other.number, candidate.number, candidatesByNumber);
  });
  if (blockingOverlaps.some((overlap) => overlap.sharedPathCount > 0)) {
    reasons.add("overlapping_paths");
  }
  if (blockingOverlaps.some((overlap) => overlap.sharedAddedBlobCount > 0)) {
    reasons.add("overlapping_added_blob");
  }
  if (blockingOverlaps.some((overlap) => overlap.sameOutcomeClaim)) {
    reasons.add("overlapping_outcome");
  }

  let state: PrStackState;
  let recommendation: PrStackRecommendation;
  if (reasons.has("mergeability_unknown")) {
    state = "observation_refresh_required";
    recommendation = "refresh_observation";
  } else if (reasons.has("draft")) {
    state = "draft_execution_surface";
    recommendation = "continue";
  } else if (reasons.has("merge_conflict")) {
    state = "conflicted";
    recommendation = "repair";
  } else if (
    reasons.has("base_stale")
    || reasons.has("dependency_superseded")
    || reasons.has("dependency_closed")
    || reasons.has("dependency_merged")
  ) {
    state = "stale_base";
    recommendation = "restack";
  } else if (reasons.has("dependency_open")) {
    state = "waiting_for_dependency";
    recommendation = "integrate_dependency_first";
  } else if (reasons.has("review_stale")) {
    state = "head_changed_after_review";
    recommendation = "review";
  } else if (reasons.has("required_check_failed")) {
    state = "recovery_required";
    recommendation = "repair";
  } else if (
    reasons.has("review_missing")
    || reasons.has("review_changes_requested")
    || reasons.has("review_threads_unresolved")
  ) {
    state = "waiting_for_review";
    recommendation = reasons.has("review_changes_requested")
      ? "repair"
      : "review";
  } else if (
    reasons.has("required_check_missing")
    || reasons.has("required_check_pending")
    || reasons.has("required_check_stale")
  ) {
    state = "waiting_for_checks";
    recommendation = "continue";
  } else if (
    reasons.has("overlapping_paths")
    || reasons.has("overlapping_added_blob")
    || reasons.has("overlapping_outcome")
  ) {
    state = "overlapping_candidate";
    recommendation = "partition";
  } else {
    reasons.add("ready");
    state = "ready_to_integrate";
    recommendation = "merge";
  }
  return evaluationResult(
    candidate,
    state,
    recommendation,
    [...reasons].sort(compareReasons),
    overlaps,
  );
}

function evaluationResult(
  candidate: PrStackCandidate,
  state: PrStackState,
  recommendation: PrStackRecommendation,
  reasons: PrStackReasonCode[],
  overlaps: readonly PrStackOverlap[],
): PrStackEvaluation {
  return deepFreeze({
    number: candidate.number,
    headSha: candidate.headSha,
    state,
    recommendation,
    reasons,
    dependencies: [...candidate.dependencies],
    overlaps: overlaps.map((overlap) => ({
      otherNumber: overlap.otherNumber,
      sharedPathCount: overlap.sharedPathCount,
      sharedPaths: [...overlap.sharedPaths],
      sharedAddedBlobCount: overlap.sharedAddedBlobCount,
      sharedAddedBlobShas: [...overlap.sharedAddedBlobShas],
      sameOutcomeClaim: overlap.sameOutcomeClaim,
    })),
    authorizesMutation: false as const,
  });
}

function isActive(candidate: PrStackCandidate): boolean {
  return candidate.lifecycle === "open" && candidate.supersededBy === null;
}

function isStackedOn(
  candidateNumber: number,
  possibleBaseNumber: number,
  candidatesByNumber: ReadonlyMap<number, PrStackCandidate>,
  seen = new Set<number>(),
): boolean {
  if (seen.has(candidateNumber)) return false;
  seen.add(candidateNumber);
  const candidate = candidatesByNumber.get(candidateNumber)!;
  if (candidate.baseRef === "main") return false;
  const directBase = candidate.dependencies
    .map((number) => candidatesByNumber.get(number)!)
    .find((dependency) => dependency.headRef === candidate.baseRef);
  if (!directBase) return false;
  if (directBase.number === possibleBaseNumber) return true;
  return isStackedOn(directBase.number, possibleBaseNumber, candidatesByNumber, seen);
}

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new RangeError(`${label} contains a symbol field`);
  }
  const allowed = new Set(allowedKeys);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key)) throw new RangeError(`${label} contains unknown field ${key}`);
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError(`${label} field ${key} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(descriptors, key)) throw new RangeError(`${label} is missing field ${key}`);
  }
  return result;
}

function exactArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): unknown[] {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minimum
    || value.length > maximum
  ) {
    throw new RangeError(`${label} must contain between ${minimum} and ${maximum} entries`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new RangeError(`${label} contains a symbol field`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    if (key === "length") continue;
    if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      throw new RangeError(`${label} contains unknown field ${key}`);
    }
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor) throw new RangeError(`${label} must be dense`);
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError(`${label} must contain enumerable data entries`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function repositoryName(value: unknown): string {
  const repository = exactText(value, "PR stack repository", 200).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9_.-]{0,99})\/[a-z0-9](?:[a-z0-9_.-]{0,99})$/.test(repository)) {
    throw new RangeError("PR stack repository is invalid");
  }
  return repository;
}

function pullRequestUrl(value: unknown, repository: string, number: number): string {
  const url = exactText(value, "Pull request URL", 500);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RangeError("Pull request URL is invalid");
  }
  const canonical = `https://github.com/${repository}/pull/${number}`;
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== "github.com"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.port !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.pathname.toLowerCase() !== `/${repository}/pull/${number}`
  ) throw new RangeError("Pull request URL does not match its repository and number");
  return canonical;
}

function gitRef(value: unknown, label: string): string {
  const ref = exactText(value, label, 240);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/.test(ref)
    || ref.includes("..")
    || ref.includes("//")
    || ref.endsWith("/")
    || ref.endsWith(".lock")
  ) throw new RangeError(`${label} is invalid`);
  return ref;
}

function commitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{40}$/.test(value)) {
    throw new RangeError(`${label} must be a full commit SHA`);
  }
  return value.toLowerCase();
}

function nullableSha(value: unknown, label: string): string | null {
  return value === null ? null : commitSha(value, label);
}

function outcomeClaim(value: unknown): string {
  const claim = exactText(value, "Pull request outcome claim", 160).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:/#-]{0,159}$/.test(claim)) {
    throw new RangeError("Pull request outcome claim is invalid");
  }
  return claim;
}

function pathList(value: unknown, label: string, maximum: number): string[] {
  return sortedUnique(
    exactArray(value, label, 0, maximum).map((entry) => repositoryPath(entry)),
    label,
  );
}

function repositoryPath(value: unknown): string {
  const path = exactText(value, "Pull request changed path", 1_024);
  if (path.startsWith("/") || path.includes("\\")) {
    throw new RangeError("Pull request changed path is invalid");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new RangeError("Pull request changed path is invalid");
  }
  return path;
}

function shaList(value: unknown, label: string, maximum: number): string[] {
  return sortedUnique(
    exactArray(value, label, 0, maximum)
      .map((entry) => commitSha(entry, "Pull request added blob SHA")),
    label,
  );
}

function numberList(value: unknown, label: string, maximum: number): number[] {
  const numbers = exactArray(value, label, 0, maximum)
    .map((entry) => positiveInteger(entry, label, 1_000_000_000))
    .sort((left, right) => left - right);
  if (new Set(numbers).size !== numbers.length) {
    throw new RangeError(`${label} must be unique`);
  }
  return numbers;
}

function stringList(
  value: unknown,
  label: string,
  maximumEntries: number,
  maximumLength: number,
): string[] {
  return sortedUnique(
    exactArray(value, label, 0, maximumEntries)
      .map((entry) => exactText(entry, label, maximumLength)),
    label,
  );
}

function sortedUnique(values: string[], label: string): string[] {
  values.sort(codeUnitCompare);
  if (new Set(values).size !== values.length) {
    throw new RangeError(`${label} must be unique`);
  }
  return values;
}

function exactText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)
  ) throw new RangeError(`${label} is invalid`);
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !timestampPattern.test(value)) {
    throw new RangeError(`${label} must be an ISO UTC timestamp`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`${label} must be a valid timestamp`);
  }
  const canonical = date.toISOString();
  const expected = value.length === 20 ? value.replace(/Z$/, ".000Z") : value;
  if (canonical !== expected) throw new RangeError(`${label} must be a valid timestamp`);
  return canonical;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : canonicalTimestamp(value, label);
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value as number;
}

function nullablePositiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): number | null {
  return value === null ? null : positiveInteger(value, label, maximum);
}

function nonNegativeInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new RangeError(`${label} must be boolean`);
  return value;
}

function closedValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value as T[number])) {
    throw new RangeError(`${label} is invalid`);
  }
  return value as T[number];
}

function intersection(left: readonly string[], right: readonly string[]): string[] {
  const rightValues = new Set(right);
  return left.filter((value) => rightValues.has(value));
}

function compareReasons(left: PrStackReasonCode, right: PrStackReasonCode): number {
  return reasonOrder.get(left)! - reasonOrder.get(right)!;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}
