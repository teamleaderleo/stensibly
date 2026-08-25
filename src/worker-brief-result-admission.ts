import {
  adjudicateCodexCloudPlacementV1,
  type CodexCloudDispatchReceiptV1,
  type CodexCloudPlacementPreflightInputV1,
  type CodexCloudPlacementPreflightV1,
} from "./codex-root-cloud-placement.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import {
  admitRunnerAdapterCommandReservationRecord,
  type RunnerAdapterCommandReservationRecord,
} from "./runner-adapter-command-contracts.js";
import {
  parseWorkerBriefV1,
  workerBriefJson,
  type WorkerBriefV1,
} from "./worker-brief.js";

export const WORKER_BRIEF_RESULT_ADMISSION_V1 = 1 as const;
export const CODEX_CLOUD_WORKTREE_PROFILE_V1 = "codex_cloud_worktree/v1" as const;

export type WorkerResultObligationKindV1 = "exclusion" | "provenance";
export type WorkerResultObligationDispositionV1 = "satisfied" | "violated" | "unknown";
export type WorkerResultDeltaRequirementV1 = "required_nonempty" | "allowed_empty";
export type WorkerResultCanonicalDeltaV1 =
  | "nonempty"
  | "empty"
  | "unknown"
  | "not_exposed_by_profile";
export type WorkerCheckoutFactDispositionV1 =
  | WorkerResultObligationDispositionV1
  | "observed"
  | "not_exposed_by_profile";

export interface WorkerProviderDispatchReceiptV1 {
  readonly version: typeof WORKER_BRIEF_RESULT_ADMISSION_V1;
  readonly providerTaskId: string;
  readonly dispatchedAt: string;
  readonly runnerReservationFingerprint: string;
  readonly sourcePlacementDispatchFingerprint: string;
  readonly canonicalMainPlacementDispatchFingerprint: string;
  readonly resultContractFingerprint: string;
  readonly fingerprint: string;
}

export interface WorkerResultProvenanceObligationInputV1 {
  readonly id: string;
  readonly statement: string;
  readonly sourceRef: string;
}

export interface CompileWorkerResultContractInputV1 {
  readonly version: typeof WORKER_BRIEF_RESULT_ADMISSION_V1;
  readonly brief: WorkerBriefV1;
  readonly checkoutProfile: typeof CODEX_CLOUD_WORKTREE_PROFILE_V1;
  readonly dispatchTree: string;
  readonly deltaRequirement: WorkerResultDeltaRequirementV1;
  readonly provenanceObligations: readonly WorkerResultProvenanceObligationInputV1[];
}

export interface WorkerResultContractV1 {
  readonly version: typeof WORKER_BRIEF_RESULT_ADMISSION_V1;
  readonly briefDigest: string;
  readonly checkoutProfile: typeof CODEX_CLOUD_WORKTREE_PROFILE_V1;
  readonly dispatchTree: string;
  readonly deltaRequirement: WorkerResultDeltaRequirementV1;
  readonly obligations: readonly WorkerResultObligationV1[];
  readonly fingerprint: string;
}

export interface CompileWorkerResultRequirementsInputV1 {
  readonly version: typeof WORKER_BRIEF_RESULT_ADMISSION_V1;
  readonly brief: WorkerBriefV1;
  readonly runnerReservation: RunnerAdapterCommandReservationRecord;
  readonly placements: {
    readonly source: CodexCloudPlacementPreflightInputV1;
    readonly canonicalMain: CodexCloudPlacementPreflightInputV1;
  };
  readonly checkout: {
    readonly profile: typeof CODEX_CLOUD_WORKTREE_PROFILE_V1;
    readonly dispatchTree: string;
    readonly providerDispatch: WorkerProviderDispatchReceiptV1;
  };
  readonly deltaRequirement: WorkerResultDeltaRequirementV1;
  readonly provenanceObligations: readonly WorkerResultProvenanceObligationInputV1[];
}

export interface WorkerResultObligationV1 {
  readonly id: string;
  readonly kind: WorkerResultObligationKindV1;
  readonly statement: string;
  readonly sourceRef: string;
}

export interface WorkerResultRequirementsV1 {
  readonly version: typeof WORKER_BRIEF_RESULT_ADMISSION_V1;
  readonly checkoutProfile: typeof CODEX_CLOUD_WORKTREE_PROFILE_V1;
  readonly briefDigest: string;
  readonly resultContractFingerprint: string;
  readonly runId: string;
  readonly runnerProfile: {
    readonly id: string;
    readonly version: string;
    readonly reservationFingerprint: string;
  };
  readonly coordinatorFacts: {
    readonly repository: string;
    readonly logicalSourceRef: string;
    readonly dispatchHead: string;
    readonly dispatchTree: string;
    readonly canonicalMainRef: string;
    readonly canonicalMainHeadAtDispatch: string;
    readonly providerTaskId: string;
    readonly providerDispatch: WorkerProviderDispatchReceiptV1;
    readonly sourcePlacementDispatch: CodexCloudDispatchReceiptV1;
    readonly canonicalMainPlacementDispatch: CodexCloudDispatchReceiptV1;
  };
  readonly executorContract: {
    readonly requiredFacts: readonly ["checkout_head", "checkout_tree"];
    readonly optionalFacts: readonly ["local_branch", "origin_main", "origin_url"];
    readonly notExposedByProfile: readonly ["logical_source_ref", "canonical_main"];
  };
  readonly obligations: readonly WorkerResultObligationV1[];
  readonly deltaRequirement: WorkerResultDeltaRequirementV1;
  readonly grantsAuthority: false;
  readonly authorizesResultApplication: false;
  readonly fingerprint: string;
}

export interface CompileWorkerProviderDispatchReceiptInputV1 {
  readonly version: typeof WORKER_BRIEF_RESULT_ADMISSION_V1;
  readonly providerTaskId: string;
  readonly dispatchedAt: string;
  readonly runnerReservationFingerprint: string;
  readonly sourcePlacementDispatchFingerprint: string;
  readonly canonicalMainPlacementDispatchFingerprint: string;
  readonly resultContractFingerprint: string;
}

export interface WorkerResultObservationV1 {
  readonly requirementsFingerprint: string;
  readonly checkout: {
    readonly head: string | null;
    readonly tree: string | null;
    readonly localBranch: string | null;
    readonly originMainHead: string | null;
    readonly originUrl: string | null;
  };
  readonly obligations: readonly {
    readonly id: string;
    readonly disposition: WorkerResultObligationDispositionV1;
    readonly evidenceRefs: readonly string[];
  }[];
  readonly delta: {
    readonly narrativeDeltaClaimed: boolean;
    readonly evidenceRefs: readonly string[];
  };
}

export interface CompileWorkerCanonicalDeltaEvidenceInputV1 {
  readonly version: typeof WORKER_BRIEF_RESULT_ADMISSION_V1;
  readonly requirementsFingerprint: string;
  readonly observedAt: string;
  readonly providerTaskId: string;
  readonly providerStatus: string;
  readonly evidenceAvailability: "exposed" | "not_exposed_by_profile";
  readonly changedFileCount: number | null;
  readonly changedLineCount: number | null;
  readonly diffAvailable: boolean | null;
  readonly evidenceRefs: readonly string[];
}

export interface WorkerCanonicalDeltaEvidenceV1
  extends CompileWorkerCanonicalDeltaEvidenceInputV1 {
  readonly canonicalDelta: WorkerResultCanonicalDeltaV1;
  readonly fingerprint: string;
}

export interface WorkerResultAdmissionV1 {
  readonly version: typeof WORKER_BRIEF_RESULT_ADMISSION_V1;
  readonly requirementsFingerprint: string;
  readonly checkoutEligible: boolean;
  readonly checkoutFacts: readonly {
    readonly id:
      | "checkout_head"
      | "checkout_tree"
      | "local_branch"
      | "origin_main"
      | "origin_url"
      | "logical_source_ref"
      | "canonical_main";
    readonly owner: "executor" | "coordinator";
    readonly disposition: WorkerCheckoutFactDispositionV1;
    readonly expected: string | null;
    readonly observed: string | null;
  }[];
  readonly obligations: readonly {
    readonly id: string;
    readonly kind: WorkerResultObligationKindV1;
    readonly statement: string;
    readonly disposition: WorkerResultObligationDispositionV1;
    readonly evidenceRefs: readonly string[];
  }[];
  readonly delta: {
    readonly requirement: WorkerResultDeltaRequirementV1;
    readonly narrativeDeltaClaimed: boolean;
    readonly canonicalDelta: WorkerResultCanonicalDeltaV1;
    readonly canonicalEvidenceFingerprint: string | null;
    readonly disposition: WorkerResultObligationDispositionV1;
    readonly mismatch:
      | "narrative_delta_contradicted_by_canonical_empty"
      | "narrative_delta_without_canonical_evidence"
      | null;
    readonly executorEvidenceRefs: readonly string[];
    readonly coordinatorEvidenceRefs: readonly string[];
  };
  readonly resultDisposition: "acceptance_candidate" | "review_required" | "rejected";
  readonly reviewRequired: boolean;
  readonly authorizesAcceptance: false;
  readonly authorizesResultApplication: false;
  readonly fingerprint: string;
}

export interface WorkerResultApplicationAdmissionV1 {
  readonly version: typeof WORKER_BRIEF_RESULT_ADMISSION_V1;
  readonly resultFingerprint: string;
  readonly sourcePlacementFingerprint: string;
  readonly canonicalMainPlacementFingerprint: string;
  readonly disposition: "admit" | "stale_release";
  readonly denials: readonly (
    | "result_not_candidate"
    | "source_placement_stale"
    | "canonical_main_placement_stale"
  )[];
  readonly authorizesResultApplication: false;
  readonly fingerprint: string;
}

/** Freezes result-shape obligations before the provider task is dispatched. */
export function compileWorkerResultContractV1(
  rawInput: CompileWorkerResultContractInputV1,
): WorkerResultContractV1 {
  const input = exactRecord(rawInput, [
    "version", "brief", "checkoutProfile", "dispatchTree", "deltaRequirement",
    "provenanceObligations",
  ], "Worker result contract input");
  if (input.version !== WORKER_BRIEF_RESULT_ADMISSION_V1) {
    throw new RangeError("Worker result contract version is invalid");
  }
  if (input.checkoutProfile !== CODEX_CLOUD_WORKTREE_PROFILE_V1) {
    throw new RangeError("Worker checkout profile is unsupported");
  }
  const brief = parseWorkerBriefV1(workerBriefJson(
    plainDataSnapshot(input.brief, "Worker result contract brief") as WorkerBriefV1,
  ));
  const obligations = resultObligations(brief, input.provenanceObligations);
  const contract = {
    version: WORKER_BRIEF_RESULT_ADMISSION_V1,
    briefDigest: brief.semanticDigest,
    checkoutProfile: CODEX_CLOUD_WORKTREE_PROFILE_V1,
    dispatchTree: gitObjectId(input.dispatchTree, "Dispatch tree"),
    deltaRequirement: deltaRequirement(input.deltaRequirement),
    obligations,
  };
  return deepFreeze({ ...contract, fingerprint: fingerprintCanonicalRequest(contract) });
}

/** Records the coordinator-owned provider dispatch that created the task. */
export function compileWorkerProviderDispatchReceiptV1(
  rawInput: CompileWorkerProviderDispatchReceiptInputV1,
): WorkerProviderDispatchReceiptV1 {
  const input = exactRecord(rawInput, [
    "version", "providerTaskId", "dispatchedAt", "runnerReservationFingerprint",
    "sourcePlacementDispatchFingerprint", "canonicalMainPlacementDispatchFingerprint",
    "resultContractFingerprint",
  ], "Worker provider dispatch receipt input");
  if (input.version !== WORKER_BRIEF_RESULT_ADMISSION_V1) {
    throw new RangeError("Worker provider dispatch receipt version is invalid");
  }
  const receipt = {
    version: WORKER_BRIEF_RESULT_ADMISSION_V1,
    providerTaskId: identifier(input.providerTaskId, "Provider task ID", 240),
    dispatchedAt: timestamp(input.dispatchedAt, "Provider dispatch time"),
    runnerReservationFingerprint: fingerprint(
      input.runnerReservationFingerprint,
      "Runner reservation fingerprint",
    ),
    sourcePlacementDispatchFingerprint: fingerprint(
      input.sourcePlacementDispatchFingerprint,
      "Source placement dispatch fingerprint",
    ),
    canonicalMainPlacementDispatchFingerprint: fingerprint(
      input.canonicalMainPlacementDispatchFingerprint,
      "Canonical main placement dispatch fingerprint",
    ),
    resultContractFingerprint: fingerprint(
      input.resultContractFingerprint,
      "Worker result contract fingerprint",
    ),
  };
  return deepFreeze({ ...receipt, fingerprint: fingerprintCanonicalRequest(receipt) });
}

/**
 * Compiles native Cloud requirements from the admitted brief, #1702's durable
 * command reservation, and #1695's exact pre-dispatch placement reads.
 */
export function compileWorkerResultRequirementsV1(
  rawInput: CompileWorkerResultRequirementsInputV1,
): WorkerResultRequirementsV1 {
  const input = exactRecord(rawInput, [
    "version", "brief", "runnerReservation", "placements", "checkout",
    "deltaRequirement", "provenanceObligations",
  ], "Worker result requirements input");
  if (input.version !== WORKER_BRIEF_RESULT_ADMISSION_V1) {
    throw new RangeError("Worker result requirements version is invalid");
  }
  const brief = parseWorkerBriefV1(workerBriefJson(
    plainDataSnapshot(input.brief, "Worker brief") as WorkerBriefV1,
  ));
  const reservation = admitRunnerAdapterCommandReservationRecord(
    plainDataSnapshot(
      input.runnerReservation,
      "Runner reservation",
    ) as RunnerAdapterCommandReservationRecord,
  );
  if (
    reservation.project !== brief.identity.projectId
    || reservation.itemId !== brief.identity.itemId
    || reservation.runId !== brief.identity.dispatch.runId
    || reservation.runGeneration !== brief.identity.dispatch.runGeneration
    || reservation.leaseGeneration !== brief.identity.dispatch.leaseGeneration
    || reservation.profileId !== brief.identity.dispatch.runnerProfile
  ) throw new RangeError("Runner reservation does not match the worker brief identity");
  if (reservation.profileVersion === null) {
    throw new RangeError("Native Cloud checkout requires an exact durable runner profile version");
  }

  const placements = exactRecord(input.placements, ["source", "canonicalMain"], "Worker placements");
  const source = admittedDispatchPlacement(
    plainDataSnapshot(
      placements.source,
      "Source placement input",
    ) as CodexCloudPlacementPreflightInputV1,
    "Source placement",
  );
  const canonicalMain = admittedDispatchPlacement(
    plainDataSnapshot(
      placements.canonicalMain,
      "Canonical main placement input",
    ) as CodexCloudPlacementPreflightInputV1,
    "Canonical main placement",
  );
  if (source.repository !== canonicalMain.repository) {
    throw new RangeError("Source and canonical main placements target different repositories");
  }
  const baseline = brief.situation.repositoryBaseline;
  if (baseline === null || baseline.baseRevision === null) {
    throw new RangeError("Native Cloud checkout requires an exact worker brief repository baseline");
  }
  if (baseline.repository !== source.repository || baseline.baseRevision !== source.expected.head) {
    throw new RangeError("Cloud source placement does not match the worker brief repository baseline");
  }

  const checkout = exactRecord(
    input.checkout,
    ["profile", "dispatchTree", "providerDispatch"],
    "Worker checkout input",
  );
  if (checkout.profile !== CODEX_CLOUD_WORKTREE_PROFILE_V1) {
    throw new RangeError("Worker checkout profile is unsupported");
  }
  const resultContract = compileWorkerResultContractV1({
    version: WORKER_BRIEF_RESULT_ADMISSION_V1,
    brief: input.brief as WorkerBriefV1,
    checkoutProfile: CODEX_CLOUD_WORKTREE_PROFILE_V1,
    dispatchTree: checkout.dispatchTree as string,
    deltaRequirement: input.deltaRequirement as WorkerResultDeltaRequirementV1,
    provenanceObligations: input.provenanceObligations as readonly WorkerResultProvenanceObligationInputV1[],
  });
  const sourcePlacementDispatch = requiredDispatchReceipt(source, "Source placement");
  const canonicalMainPlacementDispatch = requiredDispatchReceipt(
    canonicalMain,
    "Canonical main placement",
  );
  const reservationFingerprint = fingerprintCanonicalRequest(reservation);
  const providerDispatch = admitProviderDispatchReceipt(checkout.providerDispatch);
  if (
    providerDispatch.runnerReservationFingerprint !== reservationFingerprint
    || providerDispatch.sourcePlacementDispatchFingerprint !== sourcePlacementDispatch.fingerprint
    || providerDispatch.canonicalMainPlacementDispatchFingerprint
      !== canonicalMainPlacementDispatch.fingerprint
    || providerDispatch.resultContractFingerprint !== resultContract.fingerprint
  ) throw new RangeError("Provider dispatch receipt does not match admitted dispatch prerequisites");
  if (Date.parse(providerDispatch.dispatchedAt) <= Math.max(
    Date.parse(reservation.reservedAt),
    dispatchReceiptEvidenceTime(sourcePlacementDispatch),
    dispatchReceiptEvidenceTime(canonicalMainPlacementDispatch),
  )) throw new RangeError("Provider dispatch receipt predates admitted dispatch prerequisites");
  const requirements = {
    version: WORKER_BRIEF_RESULT_ADMISSION_V1,
    checkoutProfile: CODEX_CLOUD_WORKTREE_PROFILE_V1,
    briefDigest: brief.semanticDigest,
    resultContractFingerprint: resultContract.fingerprint,
    runId: brief.identity.dispatch.runId,
    runnerProfile: deepFreeze({
      id: reservation.profileId,
      version: reservation.profileVersion,
      reservationFingerprint,
    }),
    coordinatorFacts: deepFreeze({
      repository: source.repository,
      logicalSourceRef: source.expected.remoteRef,
      dispatchHead: source.expected.head,
      dispatchTree: resultContract.dispatchTree,
      canonicalMainRef: canonicalMain.expected.remoteRef,
      canonicalMainHeadAtDispatch: canonicalMain.expected.head,
      providerTaskId: providerDispatch.providerTaskId,
      providerDispatch,
      sourcePlacementDispatch,
      canonicalMainPlacementDispatch,
    }),
    executorContract: deepFreeze({
      requiredFacts: ["checkout_head", "checkout_tree"] as const,
      optionalFacts: ["local_branch", "origin_main", "origin_url"] as const,
      notExposedByProfile: ["logical_source_ref", "canonical_main"] as const,
    }),
    obligations: resultContract.obligations,
    deltaRequirement: resultContract.deltaRequirement,
    grantsAuthority: false as const,
    authorizesResultApplication: false as const,
  };
  return deepFreeze({ ...requirements, fingerprint: fingerprintCanonicalRequest(requirements) });
}

/** Compiles coordinator/provider facts; the executor cannot set canonicalDelta. */
export function compileWorkerCanonicalDeltaEvidenceV1(
  rawInput: CompileWorkerCanonicalDeltaEvidenceInputV1,
): WorkerCanonicalDeltaEvidenceV1 {
  const input = exactRecord(rawInput, [
    "version", "requirementsFingerprint", "observedAt", "providerTaskId", "providerStatus",
    "evidenceAvailability", "changedFileCount", "changedLineCount", "diffAvailable",
    "evidenceRefs",
  ], "Canonical worker delta evidence input");
  if (input.version !== WORKER_BRIEF_RESULT_ADMISSION_V1) {
    throw new RangeError("Canonical worker delta evidence version is invalid");
  }
  const availability = evidenceAvailability(input.evidenceAvailability);
  const changedFileCount = nullableCount(input.changedFileCount, "Changed file count");
  const changedLineCount = nullableCount(input.changedLineCount, "Changed line count");
  const diffAvailable = nullableBoolean(input.diffAvailable, "Canonical diff availability");
  if (
    availability === "not_exposed_by_profile"
    && (changedFileCount !== null || changedLineCount !== null || diffAvailable !== null)
  ) throw new RangeError("Unexposed canonical delta cannot contain provider diff facts");
  const evidence = {
    version: WORKER_BRIEF_RESULT_ADMISSION_V1,
    requirementsFingerprint: fingerprint(input.requirementsFingerprint, "Worker result target fingerprint"),
    observedAt: timestamp(input.observedAt, "Canonical worker delta observation time"),
    providerTaskId: identifier(input.providerTaskId, "Provider task ID", 240),
    providerStatus: text(input.providerStatus, "Provider task status", 120),
    evidenceAvailability: availability,
    changedFileCount,
    changedLineCount,
    diffAvailable,
    evidenceRefs: refs(input.evidenceRefs, "Canonical delta evidence"),
    canonicalDelta: deriveCanonicalDelta(
      availability,
      changedFileCount,
      changedLineCount,
      diffAvailable,
      isTerminalProviderStatus(input.providerStatus),
    ),
  };
  return deepFreeze({ ...evidence, fingerprint: fingerprintCanonicalRequest(evidence) });
}

/**
 * Admits executor checkout/narrative facts plus a separate coordinator/provider
 * delta receipt. Obligation dispositions remain non-authorizing review evidence.
 */
export function adjudicateWorkerResultV1(
  rawRequirements: WorkerResultRequirementsV1,
  rawObservation: WorkerResultObservationV1,
  rawCanonicalDelta: WorkerCanonicalDeltaEvidenceV1 | null,
): WorkerResultAdmissionV1 {
  const requirements = admitRequirements(rawRequirements);
  const observation = observationInput(rawObservation);
  if (observation.requirementsFingerprint !== requirements.fingerprint) {
    throw new RangeError("Worker result targets different requirements");
  }
  const canonicalEvidence = rawCanonicalDelta === null
    ? null
    : admitCanonicalDeltaEvidence(rawCanonicalDelta);
  if (canonicalEvidence !== null && canonicalEvidence.requirementsFingerprint !== requirements.fingerprint) {
    throw new RangeError("Canonical delta evidence targets different requirements");
  }
  if (
    canonicalEvidence !== null
    && canonicalEvidence.providerTaskId !== requirements.coordinatorFacts.providerTaskId
  ) throw new RangeError("Canonical delta evidence targets a different provider task");
  if (
    canonicalEvidence !== null
    && Date.parse(canonicalEvidence.observedAt)
      <= Date.parse(requirements.coordinatorFacts.providerDispatch.dispatchedAt)
  ) throw new RangeError("Canonical delta evidence predates the admitted provider dispatch");

  const headDisposition = exactFactDisposition(
    observation.checkout.head,
    requirements.coordinatorFacts.dispatchHead,
  );
  const treeDisposition = exactFactDisposition(
    observation.checkout.tree,
    requirements.coordinatorFacts.dispatchTree,
  );
  const checkoutFacts: WorkerResultAdmissionV1["checkoutFacts"] = deepFreeze([
    fact("checkout_head", "executor", headDisposition, requirements.coordinatorFacts.dispatchHead, observation.checkout.head),
    fact("checkout_tree", "executor", treeDisposition, requirements.coordinatorFacts.dispatchTree, observation.checkout.tree),
    fact("local_branch", "executor", optionalFactDisposition(observation.checkout.localBranch), null, observation.checkout.localBranch),
    fact("origin_main", "executor", optionalFactDisposition(observation.checkout.originMainHead), null, observation.checkout.originMainHead),
    fact("origin_url", "executor", optionalFactDisposition(observation.checkout.originUrl), null, observation.checkout.originUrl),
    fact("logical_source_ref", "coordinator", "not_exposed_by_profile", requirements.coordinatorFacts.logicalSourceRef, null),
    fact("canonical_main", "coordinator", "not_exposed_by_profile", requirements.coordinatorFacts.canonicalMainHeadAtDispatch, null),
  ]);
  const reported = new Map(observation.obligations.map((entry) => [entry.id, entry]));
  for (const id of reported.keys()) {
    if (!requirements.obligations.some((obligation) => obligation.id === id)) {
      throw new RangeError(`Worker result contains unknown obligation ${id}`);
    }
  }
  const obligations = requirements.obligations.map((obligation) => {
    const entry = reported.get(obligation.id);
    return deepFreeze({
      id: obligation.id,
      kind: obligation.kind,
      statement: obligation.statement,
      disposition: entry?.disposition ?? "unknown",
      evidenceRefs: entry?.evidenceRefs ?? [],
    });
  });
  const canonicalDelta = canonicalEvidence?.canonicalDelta ?? "unknown";
  const deltaDisposition = resultDeltaDisposition(requirements.deltaRequirement, canonicalDelta);
  const deltaMismatch = !observation.delta.narrativeDeltaClaimed
    ? null
    : canonicalDelta === "empty"
      ? "narrative_delta_contradicted_by_canonical_empty" as const
      : canonicalDelta === "unknown" || canonicalDelta === "not_exposed_by_profile"
        ? "narrative_delta_without_canonical_evidence" as const
        : null;
  const checkoutEligible = headDisposition === "satisfied" && treeDisposition === "satisfied";
  const checkoutViolated = headDisposition === "violated" || treeDisposition === "violated";
  const violated = obligations.some((obligation) => obligation.disposition === "violated");
  const unknown = obligations.some((obligation) => obligation.disposition === "unknown");
  const resultDisposition = checkoutViolated
    || violated
    || deltaDisposition === "violated"
    || deltaMismatch === "narrative_delta_contradicted_by_canonical_empty"
    ? "rejected" as const
    : (!checkoutEligible || unknown || deltaDisposition === "unknown" || deltaMismatch !== null)
      ? "review_required" as const
      : "acceptance_candidate" as const;
  const admitted = {
    version: WORKER_BRIEF_RESULT_ADMISSION_V1,
    requirementsFingerprint: requirements.fingerprint,
    checkoutEligible,
    checkoutFacts,
    obligations: deepFreeze(obligations),
    delta: deepFreeze({
      requirement: requirements.deltaRequirement,
      narrativeDeltaClaimed: observation.delta.narrativeDeltaClaimed,
      canonicalDelta,
      canonicalEvidenceFingerprint: canonicalEvidence?.fingerprint ?? null,
      disposition: deltaDisposition,
      mismatch: deltaMismatch,
      executorEvidenceRefs: observation.delta.evidenceRefs,
      coordinatorEvidenceRefs: canonicalEvidence?.evidenceRefs ?? [],
    }),
    resultDisposition,
    reviewRequired: resultDisposition !== "acceptance_candidate",
    authorizesAcceptance: false as const,
    authorizesResultApplication: false as const,
  };
  return deepFreeze({ ...admitted, fingerprint: fingerprintCanonicalRequest(admitted) });
}

/** Re-runs #1695 source and main pre-result admission before application. */
export function adjudicateWorkerResultApplicationV1(
  rawRequirements: WorkerResultRequirementsV1,
  rawObservation: WorkerResultObservationV1,
  rawCanonicalDelta: WorkerCanonicalDeltaEvidenceV1 | null,
  sourcePlacementInput: CodexCloudPlacementPreflightInputV1,
  canonicalMainPlacementInput: CodexCloudPlacementPreflightInputV1,
): WorkerResultApplicationAdmissionV1 {
  const requirements = admitRequirements(rawRequirements);
  const result = adjudicateWorkerResultV1(requirements, rawObservation, rawCanonicalDelta);
  const canonicalEvidence = rawCanonicalDelta === null
    ? null
    : admitCanonicalDeltaEvidence(rawCanonicalDelta);
  const source = adjudicateCodexCloudPlacementV1(
    plainDataSnapshot(
      sourcePlacementInput,
      "Source result placement input",
    ) as CodexCloudPlacementPreflightInputV1,
  );
  const canonicalMain = adjudicateCodexCloudPlacementV1(
    plainDataSnapshot(
      canonicalMainPlacementInput,
      "Canonical main result placement input",
    ) as CodexCloudPlacementPreflightInputV1,
  );
  const denials: WorkerResultApplicationAdmissionV1["denials"][number][] = [];
  if (result.resultDisposition !== "acceptance_candidate") denials.push("result_not_candidate");
  if (!applicationPlacementMatches(source, requirements, "source", canonicalEvidence?.observedAt ?? null)) {
    denials.push("source_placement_stale");
  }
  if (!applicationPlacementMatches(
    canonicalMain,
    requirements,
    "canonical_main",
    canonicalEvidence?.observedAt ?? null,
  )) {
    denials.push("canonical_main_placement_stale");
  }
  const admitted = {
    version: WORKER_BRIEF_RESULT_ADMISSION_V1,
    resultFingerprint: result.fingerprint,
    sourcePlacementFingerprint: source.fingerprint,
    canonicalMainPlacementFingerprint: canonicalMain.fingerprint,
    disposition: denials.length === 0 ? "admit" as const : "stale_release" as const,
    denials: deepFreeze(denials),
    authorizesResultApplication: false as const,
  };
  return deepFreeze({ ...admitted, fingerprint: fingerprintCanonicalRequest(admitted) });
}

function admittedDispatchPlacement(
  input: CodexCloudPlacementPreflightInputV1,
  label: string,
): CodexCloudPlacementPreflightV1 {
  const placement = adjudicateCodexCloudPlacementV1(input);
  if (
    placement.phase !== "pre_dispatch"
    || !placement.placementEligible
    || placement.disposition !== "admit"
    || placement.denials.length !== 0
    || placement.dispatchReceipt === null
  ) throw new RangeError(`${label} must be an admitted #1695 pre-dispatch placement`);
  return placement;
}

function requiredDispatchReceipt(
  placement: CodexCloudPlacementPreflightV1,
  label: string,
): CodexCloudDispatchReceiptV1 {
  if (placement.dispatchReceipt === null) throw new RangeError(`${label} has no dispatch receipt`);
  return placement.dispatchReceipt;
}

function applicationPlacementMatches(
  placement: CodexCloudPlacementPreflightV1,
  requirements: WorkerResultRequirementsV1,
  kind: "source" | "canonical_main",
  resultObservedAt: string | null,
): boolean {
  if (
    placement.phase !== "pre_result_application"
    || !placement.placementEligible
    || placement.disposition !== "admit"
    || placement.denials.length !== 0
    || placement.repository !== requirements.coordinatorFacts.repository
    || resultObservedAt === null
    || Date.parse(placement.evidenceLink.canonicalReadObservedAt) <= Date.parse(resultObservedAt)
    || Date.parse(placement.evidenceLink.inspectionObservedAt) <= Date.parse(resultObservedAt)
  ) return false;
  return kind === "source"
    ? placement.priorDispatchFingerprint
        === requirements.coordinatorFacts.sourcePlacementDispatch.fingerprint
      && placement.expected.remoteRef === requirements.coordinatorFacts.logicalSourceRef
      && placement.expected.head === requirements.coordinatorFacts.dispatchHead
    : placement.priorDispatchFingerprint
        === requirements.coordinatorFacts.canonicalMainPlacementDispatch.fingerprint
      && placement.expected.remoteRef === requirements.coordinatorFacts.canonicalMainRef
      && placement.expected.head === requirements.coordinatorFacts.canonicalMainHeadAtDispatch;
}

function dispatchReceiptEvidenceTime(receipt: CodexCloudDispatchReceiptV1): number {
  return Math.max(
    Date.parse(receipt.evidenceLink.canonicalReadObservedAt),
    Date.parse(receipt.evidenceLink.inspectionObservedAt),
  );
}

function admitProviderDispatchReceipt(value: unknown): WorkerProviderDispatchReceiptV1 {
  const safe = plainDataSnapshot(value, "Worker provider dispatch receipt");
  const record = exactRecord(safe, [
    "version", "providerTaskId", "dispatchedAt", "runnerReservationFingerprint",
    "sourcePlacementDispatchFingerprint", "canonicalMainPlacementDispatchFingerprint",
    "resultContractFingerprint", "fingerprint",
  ], "Worker provider dispatch receipt");
  const compiled = compileWorkerProviderDispatchReceiptV1({
    version: record.version as 1,
    providerTaskId: record.providerTaskId as string,
    dispatchedAt: record.dispatchedAt as string,
    runnerReservationFingerprint: record.runnerReservationFingerprint as string,
    sourcePlacementDispatchFingerprint: record.sourcePlacementDispatchFingerprint as string,
    canonicalMainPlacementDispatchFingerprint:
      record.canonicalMainPlacementDispatchFingerprint as string,
    resultContractFingerprint: record.resultContractFingerprint as string,
  });
  const suppliedFingerprint = fingerprint(record.fingerprint, "Provider dispatch fingerprint");
  if (compiled.fingerprint !== suppliedFingerprint) {
    throw new RangeError("Worker provider dispatch receipt does not match its content");
  }
  return deepFreeze({ ...compiled, fingerprint: suppliedFingerprint });
}

function admitPlacementDispatchReceipt(
  value: unknown,
  label: string,
): CodexCloudDispatchReceiptV1 {
  const record = exactRecord(value, [
    "version", "phase", "repository", "missionRef", "expectedFingerprint",
    "placementEligible", "disposition", "denials", "evidenceLink", "fingerprint",
  ], label);
  if (record.version !== 1 || record.phase !== "pre_dispatch") {
    throw new RangeError(`${label} identity is invalid`);
  }
  const denials = exactArray(record.denials, `${label} denials`, 32);
  if (
    record.placementEligible !== true
    || record.disposition !== "admit"
    || denials.length !== 0
  ) throw new RangeError(`${label} is not an admitted dispatch`);
  const link = exactRecord(record.evidenceLink, [
    "canonicalReadFingerprint", "canonicalReadObservedAt",
    "inspectionFingerprint", "inspectionObservedAt",
  ], `${label} evidence link`);
  const body = {
    version: 1 as const,
    phase: "pre_dispatch" as const,
    repository: identifier(record.repository, `${label} repository`, 240),
    missionRef: text(record.missionRef, `${label} mission reference`, 240),
    expectedFingerprint: fingerprint(record.expectedFingerprint, `${label} expected fingerprint`),
    placementEligible: true as const,
    disposition: "admit" as const,
    denials: deepFreeze([]) as readonly [],
    evidenceLink: deepFreeze({
      canonicalReadFingerprint: fingerprint(
        link.canonicalReadFingerprint,
        `${label} canonical read fingerprint`,
      ),
      canonicalReadObservedAt: timestamp(
        link.canonicalReadObservedAt,
        `${label} canonical read time`,
      ),
      inspectionFingerprint: fingerprint(
        link.inspectionFingerprint,
        `${label} inspection fingerprint`,
      ),
      inspectionObservedAt: timestamp(
        link.inspectionObservedAt,
        `${label} inspection time`,
      ),
    }),
  };
  const suppliedFingerprint = fingerprint(record.fingerprint, `${label} fingerprint`);
  if (fingerprintCanonicalRequest(body) !== suppliedFingerprint) {
    throw new RangeError(`${label} does not match its content`);
  }
  return deepFreeze({ ...body, fingerprint: suppliedFingerprint });
}

function admitCanonicalDeltaEvidence(value: WorkerCanonicalDeltaEvidenceV1) {
  const record = exactRecord(value, [
    "version", "requirementsFingerprint", "observedAt", "providerTaskId", "providerStatus",
    "evidenceAvailability", "changedFileCount", "changedLineCount", "diffAvailable",
    "evidenceRefs", "canonicalDelta", "fingerprint",
  ], "Canonical worker delta evidence");
  const compiled = compileWorkerCanonicalDeltaEvidenceV1({
    version: record.version as 1,
    requirementsFingerprint: record.requirementsFingerprint as string,
    observedAt: record.observedAt as string,
    providerTaskId: record.providerTaskId as string,
    providerStatus: record.providerStatus as string,
    evidenceAvailability: record.evidenceAvailability as "exposed" | "not_exposed_by_profile",
    changedFileCount: record.changedFileCount as number | null,
    changedLineCount: record.changedLineCount as number | null,
    diffAvailable: record.diffAvailable as boolean | null,
    evidenceRefs: record.evidenceRefs as readonly string[],
  });
  const suppliedFingerprint = fingerprint(record.fingerprint, "Canonical delta fingerprint");
  if (record.canonicalDelta !== compiled.canonicalDelta || suppliedFingerprint !== compiled.fingerprint) {
    throw new RangeError("Canonical worker delta evidence does not match its content");
  }
  return deepFreeze({ ...compiled, fingerprint: suppliedFingerprint });
}

function admitRequirements(value: WorkerResultRequirementsV1): WorkerResultRequirementsV1 {
  const safe = plainDataSnapshot(value, "Worker result requirements") as WorkerResultRequirementsV1;
  const record = exactRecord(safe, [
    "version", "checkoutProfile", "briefDigest", "resultContractFingerprint", "runId", "runnerProfile",
    "coordinatorFacts", "executorContract", "obligations", "deltaRequirement",
    "grantsAuthority", "authorizesResultApplication", "fingerprint",
  ], "Worker result requirements");
  if (record.version !== WORKER_BRIEF_RESULT_ADMISSION_V1) {
    throw new RangeError("Worker result requirements version is invalid");
  }
  if (record.checkoutProfile !== CODEX_CLOUD_WORKTREE_PROFILE_V1) {
    throw new RangeError("Worker checkout profile is unsupported");
  }
  const runner = exactRecord(record.runnerProfile, [
    "id", "version", "reservationFingerprint",
  ], "Worker result runner profile");
  const coordinator = exactRecord(record.coordinatorFacts, [
    "repository", "logicalSourceRef", "dispatchHead", "dispatchTree", "canonicalMainRef",
    "canonicalMainHeadAtDispatch", "providerTaskId", "providerDispatch", "sourcePlacementDispatch",
    "canonicalMainPlacementDispatch",
  ], "Worker result coordinator facts");
  const executor = exactRecord(record.executorContract, [
    "requiredFacts", "optionalFacts", "notExposedByProfile",
  ], "Worker result executor contract");
  const providerDispatch = admitProviderDispatchReceipt(coordinator.providerDispatch);
  const sourcePlacementDispatch = admitPlacementDispatchReceipt(
    coordinator.sourcePlacementDispatch,
    "Source placement dispatch receipt",
  );
  const canonicalMainPlacementDispatch = admitPlacementDispatchReceipt(
    coordinator.canonicalMainPlacementDispatch,
    "Canonical main placement dispatch receipt",
  );
  const body = {
    version: WORKER_BRIEF_RESULT_ADMISSION_V1,
    checkoutProfile: CODEX_CLOUD_WORKTREE_PROFILE_V1,
    briefDigest: fingerprint(record.briefDigest, "Worker brief digest"),
    resultContractFingerprint: fingerprint(
      record.resultContractFingerprint,
      "Worker result contract fingerprint",
    ),
    runId: identifier(record.runId, "Worker result run ID", 180),
    runnerProfile: deepFreeze({
      id: text(runner.id, "Worker result runner profile ID", 160),
      version: text(runner.version, "Worker result runner profile version", 160),
      reservationFingerprint: fingerprint(runner.reservationFingerprint, "Runner reservation fingerprint"),
    }),
    coordinatorFacts: deepFreeze({
      repository: text(coordinator.repository, "Checkout repository", 240),
      logicalSourceRef: gitRef(coordinator.logicalSourceRef, "Logical source ref"),
      dispatchHead: gitObjectId(coordinator.dispatchHead, "Dispatch head"),
      dispatchTree: gitObjectId(coordinator.dispatchTree, "Dispatch tree"),
      canonicalMainRef: gitRef(coordinator.canonicalMainRef, "Canonical main ref"),
      canonicalMainHeadAtDispatch: gitObjectId(coordinator.canonicalMainHeadAtDispatch, "Canonical main head"),
      providerTaskId: identifier(coordinator.providerTaskId, "Provider task ID", 240),
      providerDispatch,
      sourcePlacementDispatch,
      canonicalMainPlacementDispatch,
    }),
    executorContract: deepFreeze({
      requiredFacts: fixedList(executor.requiredFacts, ["checkout_head", "checkout_tree"], "Required checkout facts"),
      optionalFacts: fixedList(executor.optionalFacts, ["local_branch", "origin_main", "origin_url"], "Optional checkout facts"),
      notExposedByProfile: fixedList(executor.notExposedByProfile, ["logical_source_ref", "canonical_main"], "Unexposed checkout facts"),
    }),
    obligations: admittedObligations(record.obligations),
    deltaRequirement: deltaRequirement(record.deltaRequirement),
    grantsAuthority: false as const,
    authorizesResultApplication: false as const,
  };
  if (record.grantsAuthority !== false || record.authorizesResultApplication !== false) {
    throw new RangeError("Worker result requirements cannot grant authority");
  }
  const reconstructedResultContract = {
    version: WORKER_BRIEF_RESULT_ADMISSION_V1,
    briefDigest: body.briefDigest,
    checkoutProfile: body.checkoutProfile,
    dispatchTree: body.coordinatorFacts.dispatchTree,
    deltaRequirement: body.deltaRequirement,
    obligations: body.obligations,
  };
  if (
    fingerprintCanonicalRequest(reconstructedResultContract)
      !== body.resultContractFingerprint
  ) throw new RangeError("Worker result contract fingerprint does not match requirements");
  if (
    body.coordinatorFacts.providerTaskId !== providerDispatch.providerTaskId
    || body.resultContractFingerprint !== providerDispatch.resultContractFingerprint
    || providerDispatch.runnerReservationFingerprint !== body.runnerProfile.reservationFingerprint
    || providerDispatch.sourcePlacementDispatchFingerprint !== sourcePlacementDispatch.fingerprint
    || providerDispatch.canonicalMainPlacementDispatchFingerprint
      !== canonicalMainPlacementDispatch.fingerprint
  ) throw new RangeError("Worker provider dispatch receipt does not match requirements");
  if (
    sourcePlacementDispatch.repository !== body.coordinatorFacts.repository
    || canonicalMainPlacementDispatch.repository !== body.coordinatorFacts.repository
  ) throw new RangeError("Placement dispatch receipts do not match requirements");
  const supplied = fingerprint(record.fingerprint, "Worker result requirements fingerprint");
  if (fingerprintCanonicalRequest(body) !== supplied) {
    throw new RangeError("Worker result requirements fingerprint does not match its content");
  }
  return deepFreeze({ ...body, fingerprint: supplied });
}

function observationInput(value: WorkerResultObservationV1): WorkerResultObservationV1 {
  const record = exactRecord(value, [
    "requirementsFingerprint", "checkout", "obligations", "delta",
  ], "Worker result observation");
  const obligations = exactArray(record.obligations, "Worker result obligation dispositions", 32)
    .map((entry) => {
      const obligation = exactRecord(entry, ["id", "disposition", "evidenceRefs"], "Worker result obligation disposition");
      return deepFreeze({
        id: identifier(obligation.id, "Worker result obligation ID", 120),
        disposition: obligationDisposition(obligation.disposition),
        evidenceRefs: refs(obligation.evidenceRefs, "Worker result obligation evidence"),
      });
    });
  ensureUnique(obligations.map((entry) => entry.id), "Worker result obligation dispositions");
  const checkout = exactRecord(record.checkout, [
    "head", "tree", "localBranch", "originMainHead", "originUrl",
  ], "Worker result checkout observation");
  const delta = exactRecord(record.delta, ["narrativeDeltaClaimed", "evidenceRefs"], "Worker result delta observation");
  return deepFreeze({
    requirementsFingerprint: fingerprint(record.requirementsFingerprint, "Worker result target fingerprint"),
    checkout: deepFreeze({
      head: nullableGitObjectId(checkout.head, "Observed checkout head"),
      tree: nullableGitObjectId(checkout.tree, "Observed checkout tree"),
      localBranch: nullableText(checkout.localBranch, "Observed local branch", 240),
      originMainHead: nullableGitObjectId(checkout.originMainHead, "Observed origin main"),
      originUrl: nullableText(checkout.originUrl, "Observed origin URL", 1_024),
    }),
    obligations: deepFreeze(obligations),
    delta: deepFreeze({
      narrativeDeltaClaimed: boolean(delta.narrativeDeltaClaimed, "Narrative delta claim"),
      evidenceRefs: refs(delta.evidenceRefs, "Executor delta evidence"),
    }),
  });
}

function resultObligations(
  brief: WorkerBriefV1,
  provenance: unknown,
): readonly WorkerResultObligationV1[] {
  const obligations = [
    ...brief.objective.nonGoals.map((statement, index) => deepFreeze({
      id: `exclusion-${index + 1}-${shortFingerprint(statement)}`,
      kind: "exclusion" as const,
      statement,
      sourceRef: `worker-brief:${brief.semanticDigest}#objective.nonGoals[${index}]`,
    })),
    ...provenanceObligations(provenance),
  ];
  ensureUnique(obligations.map((obligation) => obligation.id), "Worker result obligation IDs");
  return deepFreeze(obligations);
}

function provenanceObligations(value: unknown): WorkerResultObligationV1[] {
  return exactArray(value, "Provenance obligations", 16).map((entry) => {
    const record = exactRecord(entry, ["id", "statement", "sourceRef"], "Provenance obligation");
    return deepFreeze({
      id: identifier(record.id, "Provenance obligation ID", 120),
      kind: "provenance" as const,
      statement: text(record.statement, "Provenance obligation statement", 500),
      sourceRef: text(record.sourceRef, "Provenance obligation source", 500),
    });
  });
}

function admittedObligations(value: unknown): readonly WorkerResultObligationV1[] {
  const obligations = exactArray(value, "Worker result obligations", 32).map((entry) => {
    const record = exactRecord(entry, ["id", "kind", "statement", "sourceRef"], "Worker result obligation");
    if (record.kind !== "exclusion" && record.kind !== "provenance") {
      throw new RangeError("Worker result obligation kind is invalid");
    }
    const kind: WorkerResultObligationKindV1 = record.kind;
    return deepFreeze({
      id: identifier(record.id, "Worker result obligation ID", 120),
      kind,
      statement: text(record.statement, "Worker result obligation statement", 500),
      sourceRef: text(record.sourceRef, "Worker result obligation source", 500),
    });
  });
  ensureUnique(obligations.map((obligation) => obligation.id), "Worker result obligation IDs");
  return deepFreeze(obligations);
}

function deriveCanonicalDelta(
  availability: "exposed" | "not_exposed_by_profile",
  files: number | null,
  lines: number | null,
  diffAvailable: boolean | null,
  providerTerminal: boolean,
): WorkerResultCanonicalDeltaV1 {
  if (!providerTerminal) return "unknown";
  if (availability === "not_exposed_by_profile") return "not_exposed_by_profile";
  if (files === null || lines === null || diffAvailable === null) return "unknown";
  const countsNonempty = files > 0 || lines > 0;
  if (diffAvailable !== countsNonempty) return "unknown";
  return countsNonempty ? "nonempty" : "empty";
}

function isTerminalProviderStatus(value: unknown): boolean {
  const status = text(value, "Provider task status", 120).toUpperCase();
  return status === "READY"
    || status === "COMPLETED"
    || status === "SUCCESS"
    || status === "SUCCEEDED";
}

function resultDeltaDisposition(
  requirement: WorkerResultDeltaRequirementV1,
  canonical: WorkerResultCanonicalDeltaV1,
): WorkerResultObligationDispositionV1 {
  if (canonical === "unknown" || canonical === "not_exposed_by_profile") return "unknown";
  if (requirement === "allowed_empty") return "satisfied";
  return canonical === "nonempty" ? "satisfied" : "violated";
}

function evidenceAvailability(value: unknown): "exposed" | "not_exposed_by_profile" {
  if (value !== "exposed" && value !== "not_exposed_by_profile") {
    throw new RangeError("Canonical delta evidence availability is invalid");
  }
  return value;
}

function nullableCount(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000_000) {
    throw new RangeError(`${label} is invalid`);
  }
  return value as number;
}

function nullableBoolean(value: unknown, label: string): boolean | null {
  if (value === null) return null;
  return boolean(value, label);
}

function fact(
  id: WorkerResultAdmissionV1["checkoutFacts"][number]["id"],
  owner: "executor" | "coordinator",
  disposition: WorkerCheckoutFactDispositionV1,
  expected: string | null,
  observed: string | null,
) {
  return deepFreeze({ id, owner, disposition, expected, observed });
}

function exactFactDisposition(observed: string | null, expected: string) {
  if (observed === null) return "unknown" as const;
  return observed === expected ? "satisfied" as const : "violated" as const;
}

function optionalFactDisposition(observed: string | null) {
  return observed === null ? "not_exposed_by_profile" as const : "observed" as const;
}

function obligationDisposition(value: unknown): WorkerResultObligationDispositionV1 {
  if (value !== "satisfied" && value !== "violated" && value !== "unknown") {
    throw new RangeError("Worker result obligation disposition is invalid");
  }
  return value;
}

function deltaRequirement(value: unknown): WorkerResultDeltaRequirementV1 {
  if (value !== "required_nonempty" && value !== "allowed_empty") {
    throw new RangeError("Worker result delta requirement is invalid");
  }
  return value;
}

function fixedList<const Values extends readonly string[]>(
  value: unknown,
  expected: Values,
  label: string,
): Values {
  const entries = exactArray(value, label, expected.length);
  if (entries.length !== expected.length || entries.some((entry, index) => entry !== expected[index])) {
    throw new RangeError(`${label} are invalid`);
  }
  return deepFreeze([...expected]) as unknown as Values;
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  let array: boolean;
  try {
    array = Array.isArray(value);
  } catch {
    throw new RangeError(`${label} could not be inspected`);
  }
  if (!value || typeof value !== "object" || array) throw new TypeError(`${label} must be an object`);
  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw new RangeError(`${label} could not be inspected`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const actual = keys.filter((key): key is string => typeof key === "string").sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== keys.length
    || actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) throw new RangeError(`${label} has unexpected fields`);
  const output: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new RangeError(`${label} could not be inspected`);
    }
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new RangeError(`${label}.${key} must be an enumerable data property`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function plainDataSnapshot(
  value: unknown,
  label: string,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (
    value === null
    || value === undefined
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) return value;
  if (typeof value !== "object") throw new TypeError(`${label} contains unsupported data`);
  if (depth > 24) throw new RangeError(`${label} is too deeply nested`);
  if (seen.has(value)) throw new RangeError(`${label} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return exactArray(value, label, 2_048).map((entry, index) =>
        plainDataSnapshot(entry, `${label}[${index}]`, seen, depth + 1));
    }
    let prototype: object | null;
    let keys: PropertyKey[];
    try {
      prototype = Object.getPrototypeOf(value);
      keys = Reflect.ownKeys(value);
    } catch {
      throw new RangeError(`${label} could not be inspected`);
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must contain only plain objects`);
    }
    if (keys.length > 256 || keys.some((key) => typeof key !== "string")) {
      throw new RangeError(`${label} cannot be decorated or unbounded`);
    }
    const output: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        throw new RangeError(`${label} could not be inspected`);
      }
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new RangeError(`${label}.${key} must be an enumerable data property`);
      }
      output[key] = plainDataSnapshot(
        descriptor.value,
        `${label}.${key}`,
        seen,
        depth + 1,
      );
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function exactArray(value: unknown, label: string, maximum: number): unknown[] {
  let array: boolean;
  try {
    array = Array.isArray(value);
  } catch {
    throw new RangeError(`${label} could not be inspected`);
  }
  if (!array) throw new TypeError(`${label} must be an array`);
  const arrayValue = value as unknown[];
  let prototype: object | null;
  let keys: PropertyKey[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(arrayValue);
    keys = Reflect.ownKeys(arrayValue);
    lengthDescriptor = Object.getOwnPropertyDescriptor(arrayValue, "length");
  } catch {
    throw new RangeError(`${label} could not be inspected`);
  }
  if (
    prototype !== Array.prototype
    || !lengthDescriptor
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > maximum
  ) throw new RangeError(`${label} must be a bounded plain array`);
  const length = lengthDescriptor.value as number;
  if (keys.length !== length + 1 || keys.some((key) => typeof key !== "string") || !keys.includes("length")) {
    throw new RangeError(`${label} cannot be sparse or decorated`);
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(arrayValue, String(index));
    } catch {
      throw new RangeError(`${label} could not be inspected`);
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError(`${label} entries must be enumerable data properties`);
    }
    output.push(descriptor.value);
  }
  return output;
}

function refs(value: unknown, label: string): readonly string[] {
  const output = exactArray(value, label, 8).map((entry) => text(entry, `${label} reference`, 500));
  ensureUnique(output, label);
  return deepFreeze(output);
}

function shortFingerprint(value: string): string {
  return fingerprintCanonicalRequest(value).slice("sha256:".length, "sha256:".length + 12);
}

function gitRef(value: unknown, label: string): string {
  const output = identifier(value, label, 1_024);
  if (!output.startsWith("refs/") || output.includes("..") || output.includes("@{") || output.endsWith("/") || output.endsWith(".")) {
    throw new RangeError(`${label} is invalid`);
  }
  return output;
}

function gitObjectId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new RangeError(`${label} must be a Git SHA-1`);
  }
  return value;
}

function nullableGitObjectId(value: unknown, label: string): string | null {
  return value === null ? null : gitObjectId(value, label);
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function identifier(value: unknown, label: string, maximum: number): string {
  const output = text(value, label, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u.test(output)) throw new RangeError(`${label} is invalid`);
  return output;
}

function nullableText(value: unknown, label: string, maximum: number): string | null {
  return value === null ? null : text(value, label, maximum);
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be text`);
  const output = value.trim();
  if (!output || output.length > maximum || /[\u0000-\u001f\u007f]/u.test(output)) {
    throw new RangeError(`${label} is invalid`);
  }
  return output;
}

function timestamp(value: unknown, label: string): string {
  const output = text(value, label, 64);
  const time = Date.parse(output);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== output) {
    throw new RangeError(`${label} must be canonical ISO time`);
  }
  return output;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
  return value;
}

function ensureUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new RangeError(`${label} must be unique`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
