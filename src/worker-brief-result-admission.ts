import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import * as core from "./worker-brief-result-admission-core.js";

export * from "./worker-brief-result-admission-core.js";

export type WorkerResultEffectExpectationDispositionV1 = "allowed" | "forbidden";
export type WorkerResultEffectCoverageDispositionV1 = "complete" | "incomplete";

export interface WorkerResultEffectExpectationInputV1 {
  readonly id: string;
  readonly provider: string;
  readonly disposition: WorkerResultEffectExpectationDispositionV1;
  readonly statement: string;
  readonly sourceRef: string;
}
export interface WorkerResultEffectExpectationV1 extends WorkerResultEffectExpectationInputV1 {}

export interface CompileWorkerResultContractInputWithEffectsV1 extends core.CompileWorkerResultContractInputV1 {
  readonly effectExpectations: readonly WorkerResultEffectExpectationInputV1[];
}
export type CompileWorkerResultContractInputV1 = core.CompileWorkerResultContractInputV1 | CompileWorkerResultContractInputWithEffectsV1;
export interface WorkerResultContractWithEffectsV1 extends core.WorkerResultContractV1 {
  readonly effectExpectations: readonly WorkerResultEffectExpectationV1[];
}
export type WorkerResultContractV1 = core.WorkerResultContractV1 | WorkerResultContractWithEffectsV1;

export interface CompileWorkerResultRequirementsInputWithEffectsV1 extends core.CompileWorkerResultRequirementsInputV1 {
  readonly effectExpectations: readonly WorkerResultEffectExpectationInputV1[];
}
export type CompileWorkerResultRequirementsInputV1 = core.CompileWorkerResultRequirementsInputV1 | CompileWorkerResultRequirementsInputWithEffectsV1;
export interface WorkerResultRequirementsWithEffectsV1 extends Omit<core.WorkerResultRequirementsV1, "resultContractFingerprint" | "coordinatorFacts" | "fingerprint"> {
  readonly resultContractFingerprint: string;
  readonly coordinatorFacts: core.WorkerResultRequirementsV1["coordinatorFacts"];
  readonly effectExpectations: readonly WorkerResultEffectExpectationV1[];
  readonly fingerprint: string;
}
export type WorkerResultRequirementsV1 = core.WorkerResultRequirementsV1 | WorkerResultRequirementsWithEffectsV1;

export interface WorkerResultEffectNarrativeV1 {
  readonly claimedEffectIds: readonly string[];
  readonly evidenceRefs: readonly string[];
}
export interface WorkerResultObservationWithEffectsV1 extends core.WorkerResultObservationV1 {
  readonly effects: WorkerResultEffectNarrativeV1;
}
export type WorkerResultObservationV1 = core.WorkerResultObservationV1 | WorkerResultObservationWithEffectsV1;

export interface CompileWorkerEffectEvidenceInputV1 {
  readonly version: typeof core.WORKER_BRIEF_RESULT_ADMISSION_V1;
  readonly requirementsFingerprint: string;
  readonly observedAt: string;
  readonly providerTaskId: string;
  readonly coverage: readonly {
    readonly provider: string;
    readonly disposition: WorkerResultEffectCoverageDispositionV1;
    readonly evidenceRefs: readonly string[];
  }[];
  readonly observedEffects: readonly {
    readonly effectId: string;
    readonly provider: string;
    readonly instanceId: string;
    readonly evidenceRefs: readonly string[];
  }[];
}
export interface WorkerEffectEvidenceV1 extends CompileWorkerEffectEvidenceInputV1 { readonly fingerprint: string }

export interface WorkerResultEffectAdmissionV1 {
  readonly expectations: readonly WorkerResultEffectExpectationV1[];
  readonly narrativeClaimedEffectIds: readonly string[];
  readonly narrativeClaimedNoEffects: boolean;
  readonly coverage: readonly WorkerEffectEvidenceV1["coverage"][number][];
  readonly observedEffects: readonly WorkerEffectEvidenceV1["observedEffects"][number][];
  readonly providerObservedEffectCount: number;
  readonly providerEvidenceFingerprint: string | null;
  readonly disposition: core.WorkerResultObligationDispositionV1;
  readonly mismatchEffectIds: readonly string[];
  readonly forbiddenObservedEffectIds: readonly string[];
  readonly unexpectedObservedInstanceIds: readonly string[];
  readonly executorEvidenceRefs: readonly string[];
  readonly coordinatorEvidenceRefs: readonly string[];
}
export interface WorkerResultAdmissionWithEffectsV1 extends Omit<core.WorkerResultAdmissionV1, "resultDisposition" | "reviewRequired" | "fingerprint"> {
  readonly effects: WorkerResultEffectAdmissionV1;
  readonly resultDisposition: "acceptance_candidate" | "review_required" | "rejected";
  readonly reviewRequired: boolean;
  readonly fingerprint: string;
}
export type WorkerResultAdmissionV1 = core.WorkerResultAdmissionV1 | WorkerResultAdmissionWithEffectsV1;

export function compileWorkerResultContractV1(raw: CompileWorkerResultContractInputV1): WorkerResultContractV1 {
  const input = snapshot(raw, "Worker result contract input") as Record<string, unknown>;
  if (!("effectExpectations" in input)) return core.compileWorkerResultContractV1(input as unknown as core.CompileWorkerResultContractInputV1);
  exactKeys(input, ["version", "brief", "checkoutProfile", "dispatchTree", "deltaRequirement", "provenanceObligations", "effectExpectations"], "Worker result contract input");
  const base = core.compileWorkerResultContractV1({
    version: input.version as 1,
    brief: input.brief as core.CompileWorkerResultContractInputV1["brief"],
    checkoutProfile: input.checkoutProfile as typeof core.CODEX_CLOUD_WORKTREE_PROFILE_V1,
    dispatchTree: input.dispatchTree as string,
    deltaRequirement: input.deltaRequirement as core.WorkerResultDeltaRequirementV1,
    provenanceObligations: input.provenanceObligations as readonly core.WorkerResultProvenanceObligationInputV1[],
  });
  const effectExpectations = expectations(input.effectExpectations);
  const { fingerprint: _fingerprint, ...baseBody } = base;
  const body = { ...baseBody, effectExpectations };
  return freeze({ ...body, fingerprint: fingerprintCanonicalRequest(body) });
}

export function compileWorkerResultRequirementsV1(raw: CompileWorkerResultRequirementsInputV1): WorkerResultRequirementsV1 {
  const input = snapshot(raw, "Worker result requirements input") as Record<string, unknown>;
  if (!("effectExpectations" in input)) return core.compileWorkerResultRequirementsV1(input as unknown as core.CompileWorkerResultRequirementsInputV1);
  exactKeys(input, ["version", "brief", "runnerReservation", "placements", "checkout", "deltaRequirement", "provenanceObligations", "effectExpectations"], "Worker result requirements input");
  const checkout = exact(input.checkout, ["profile", "dispatchTree", "providerDispatch"], "Worker checkout input");
  const enhancedContract = compileWorkerResultContractV1({
    version: input.version as 1,
    brief: input.brief as core.CompileWorkerResultContractInputV1["brief"],
    checkoutProfile: checkout.profile as typeof core.CODEX_CLOUD_WORKTREE_PROFILE_V1,
    dispatchTree: checkout.dispatchTree as string,
    deltaRequirement: input.deltaRequirement as core.WorkerResultDeltaRequirementV1,
    provenanceObligations: input.provenanceObligations as readonly core.WorkerResultProvenanceObligationInputV1[],
    effectExpectations: input.effectExpectations as readonly WorkerResultEffectExpectationInputV1[],
  }) as WorkerResultContractWithEffectsV1;
  const actualDispatch = admitDispatch(checkout.providerDispatch);
  if (actualDispatch.resultContractFingerprint !== enhancedContract.fingerprint) throw new RangeError("Provider dispatch receipt does not match the effect-sensitive result contract");
  const baseContract = core.compileWorkerResultContractV1({
    version: input.version as 1,
    brief: input.brief as core.CompileWorkerResultContractInputV1["brief"],
    checkoutProfile: checkout.profile as typeof core.CODEX_CLOUD_WORKTREE_PROFILE_V1,
    dispatchTree: checkout.dispatchTree as string,
    deltaRequirement: input.deltaRequirement as core.WorkerResultDeltaRequirementV1,
    provenanceObligations: input.provenanceObligations as readonly core.WorkerResultProvenanceObligationInputV1[],
  });
  const baseDispatch = core.compileWorkerProviderDispatchReceiptV1({ ...withoutFingerprint(actualDispatch), resultContractFingerprint: baseContract.fingerprint });
  const base = core.compileWorkerResultRequirementsV1({
    version: input.version as 1,
    brief: input.brief as core.CompileWorkerResultRequirementsInputV1["brief"],
    runnerReservation: input.runnerReservation as core.CompileWorkerResultRequirementsInputV1["runnerReservation"],
    placements: input.placements as core.CompileWorkerResultRequirementsInputV1["placements"],
    checkout: { profile: checkout.profile as typeof core.CODEX_CLOUD_WORKTREE_PROFILE_V1, dispatchTree: checkout.dispatchTree as string, providerDispatch: baseDispatch },
    deltaRequirement: input.deltaRequirement as core.WorkerResultDeltaRequirementV1,
    provenanceObligations: input.provenanceObligations as readonly core.WorkerResultProvenanceObligationInputV1[],
  });
  const { fingerprint: _fingerprint, ...baseBody } = base;
  const body = {
    ...baseBody,
    resultContractFingerprint: enhancedContract.fingerprint,
    coordinatorFacts: freeze({ ...base.coordinatorFacts, providerDispatch: actualDispatch }),
    effectExpectations: enhancedContract.effectExpectations,
  };
  return freeze({ ...body, fingerprint: fingerprintCanonicalRequest(body) });
}

export function compileWorkerEffectEvidenceV1(raw: CompileWorkerEffectEvidenceInputV1): WorkerEffectEvidenceV1 {
  const input = exact(snapshot(raw, "Worker effect evidence input"), ["version", "requirementsFingerprint", "observedAt", "providerTaskId", "coverage", "observedEffects"], "Worker effect evidence input");
  if (input.version !== core.WORKER_BRIEF_RESULT_ADMISSION_V1) throw new RangeError("Worker effect evidence version is invalid");
  const coverage = boundedArray(input.coverage, 32, "Worker effect coverage").map((value) => {
    const entry = exact(value, ["provider", "disposition", "evidenceRefs"], "Worker effect coverage entry");
    if (entry.disposition !== "complete" && entry.disposition !== "incomplete") throw new RangeError("Worker effect coverage disposition is invalid");
    return freeze({ provider: provider(entry.provider), disposition: entry.disposition as WorkerResultEffectCoverageDispositionV1, evidenceRefs: refs(entry.evidenceRefs, "Worker effect coverage evidence") });
  });
  unique(coverage.map((entry) => entry.provider), "Worker effect coverage providers");
  const observedEffects = boundedArray(input.observedEffects, 64, "Observed worker effects").map((value) => {
    const entry = exact(value, ["effectId", "provider", "instanceId", "evidenceRefs"], "Observed worker effect");
    return freeze({ effectId: id(entry.effectId, 160, "Observed effect ID"), provider: provider(entry.provider), instanceId: id(entry.instanceId, 240, "Observed effect instance ID"), evidenceRefs: refs(entry.evidenceRefs, "Observed effect evidence") });
  });
  unique(observedEffects.map((entry) => `${entry.provider}\u0000${entry.instanceId}`), "Observed provider effect instances");
  const body = {
    version: core.WORKER_BRIEF_RESULT_ADMISSION_V1,
    requirementsFingerprint: digest(input.requirementsFingerprint, "Worker effect requirements fingerprint"),
    observedAt: iso(input.observedAt, "Worker effect observation time"),
    providerTaskId: id(input.providerTaskId, 240, "Provider task ID"),
    coverage: freeze(coverage), observedEffects: freeze(observedEffects),
  };
  return freeze({ ...body, fingerprint: fingerprintCanonicalRequest(body) });
}

export function adjudicateWorkerResultV1(rawRequirements: WorkerResultRequirementsV1, rawObservation: WorkerResultObservationV1, rawCanonicalDelta: core.WorkerCanonicalDeltaEvidenceV1 | null, rawEffectEvidence: WorkerEffectEvidenceV1 | null = null): WorkerResultAdmissionV1 {
  if (!hasEffects(rawRequirements)) return core.adjudicateWorkerResultV1(rawRequirements, rawObservation as core.WorkerResultObservationV1, rawCanonicalDelta);
  const admitted = admitRequirements(rawRequirements);
  const observation = admitObservation(rawObservation, admitted.enhanced.fingerprint, admitted.base.fingerprint);
  const delta = adaptDelta(rawCanonicalDelta, admitted.enhanced.fingerprint, admitted.base.fingerprint);
  const baseResult = core.adjudicateWorkerResultV1(admitted.base, observation.base, delta.base);
  const effectEvidence = rawEffectEvidence === null ? null : admitEffectEvidence(rawEffectEvidence);
  if (effectEvidence !== null) {
    if (effectEvidence.requirementsFingerprint !== admitted.enhanced.fingerprint) throw new RangeError("Worker effect evidence targets different requirements");
    if (effectEvidence.providerTaskId !== admitted.enhanced.coordinatorFacts.providerTaskId) throw new RangeError("Worker effect evidence targets a different provider task");
    if (Date.parse(effectEvidence.observedAt) <= Date.parse(admitted.enhanced.coordinatorFacts.providerDispatch.dispatchedAt)) throw new RangeError("Worker effect evidence predates the admitted provider dispatch");
  }
  const effects = reconcile(admitted.enhanced.effectExpectations, observation.effects, effectEvidence);
  const resultDisposition = baseResult.resultDisposition === "rejected" || effects.disposition === "violated"
    ? "rejected" as const
    : baseResult.resultDisposition === "review_required" || effects.disposition === "unknown" ? "review_required" as const : "acceptance_candidate" as const;
  const { fingerprint: _fingerprint, resultDisposition: _disposition, reviewRequired: _review, ...baseBody } = baseResult;
  const body = { ...baseBody, requirementsFingerprint: admitted.enhanced.fingerprint, effects, resultDisposition, reviewRequired: resultDisposition !== "acceptance_candidate" };
  return freeze({ ...body, fingerprint: fingerprintCanonicalRequest(body) });
}

export function adjudicateWorkerResultApplicationV1(
  rawRequirements: WorkerResultRequirementsV1,
  rawObservation: WorkerResultObservationV1,
  rawCanonicalDelta: core.WorkerCanonicalDeltaEvidenceV1 | null,
  sourcePlacementInput: Parameters<typeof core.adjudicateWorkerResultApplicationV1>[3],
  canonicalMainPlacementInput: Parameters<typeof core.adjudicateWorkerResultApplicationV1>[4],
  rawEffectEvidence: WorkerEffectEvidenceV1 | null = null,
): core.WorkerResultApplicationAdmissionV1 {
  if (!hasEffects(rawRequirements)) return core.adjudicateWorkerResultApplicationV1(rawRequirements, rawObservation as core.WorkerResultObservationV1, rawCanonicalDelta, sourcePlacementInput, canonicalMainPlacementInput);
  const admitted = admitRequirements(rawRequirements);
  const observation = admitObservation(rawObservation, admitted.enhanced.fingerprint, admitted.base.fingerprint);
  const delta = adaptDelta(rawCanonicalDelta, admitted.enhanced.fingerprint, admitted.base.fingerprint);
  const effectEvidence = rawEffectEvidence === null ? null : admitEffectEvidence(rawEffectEvidence);
  const result = adjudicateWorkerResultV1(admitted.enhanced, rawObservation, rawCanonicalDelta, effectEvidence) as WorkerResultAdmissionWithEffectsV1;
  let applicationDelta = delta.base;
  if (applicationDelta !== null && effectEvidence !== null && Date.parse(effectEvidence.observedAt) > Date.parse(applicationDelta.observedAt)) {
    applicationDelta = core.compileWorkerCanonicalDeltaEvidenceV1({ ...deltaInput(applicationDelta, admitted.base.fingerprint), observedAt: effectEvidence.observedAt });
  }
  const baseApplication = core.adjudicateWorkerResultApplicationV1(admitted.base, observation.base, applicationDelta, sourcePlacementInput, canonicalMainPlacementInput);
  const denials = [...baseApplication.denials];
  if (result.resultDisposition !== "acceptance_candidate" && !denials.includes("result_not_candidate")) denials.unshift("result_not_candidate");
  const body = {
    version: core.WORKER_BRIEF_RESULT_ADMISSION_V1,
    resultFingerprint: result.fingerprint,
    sourcePlacementFingerprint: baseApplication.sourcePlacementFingerprint,
    canonicalMainPlacementFingerprint: baseApplication.canonicalMainPlacementFingerprint,
    disposition: denials.length === 0 ? "admit" as const : "stale_release" as const,
    denials: freeze(denials), authorizesResultApplication: false as const,
  };
  return freeze({ ...body, fingerprint: fingerprintCanonicalRequest(body) });
}

function reconcile(expectationsInput: readonly WorkerResultEffectExpectationV1[], narrative: WorkerResultEffectNarrativeV1, evidence: WorkerEffectEvidenceV1 | null): WorkerResultEffectAdmissionV1 {
  const byId = new Map(expectationsInput.map((entry) => [entry.id, entry]));
  for (const effectId of narrative.claimedEffectIds) if (!byId.has(effectId)) throw new RangeError(`Worker narrative contains undeclared effect ${effectId}`);
  const coverage = evidence?.coverage ?? [];
  const observed = evidence?.observedEffects ?? [];
  const coverageByProvider = new Map(coverage.map((entry) => [entry.provider, entry]));
  const observedIds = new Set<string>();
  const forbidden: string[] = [];
  const unexpected: string[] = [];
  for (const effect of observed) {
    const expectation = byId.get(effect.effectId);
    if (expectation === undefined || expectation.provider !== effect.provider) { unexpected.push(`${effect.provider}:${effect.instanceId}`); continue; }
    observedIds.add(expectation.id);
    if (expectation.disposition === "forbidden") forbidden.push(expectation.id);
  }
  const narrativeIds = new Set(narrative.claimedEffectIds);
  const mismatch = expectationsInput
    .filter((entry) => coverageByProvider.get(entry.provider)?.disposition === "complete")
    .filter((entry) => narrativeIds.has(entry.id) !== observedIds.has(entry.id))
    .map((entry) => entry.id);
  const coverageComplete = evidence !== null && expectationsInput.every((entry) => coverageByProvider.get(entry.provider)?.disposition === "complete");
  const disposition: core.WorkerResultObligationDispositionV1 = forbidden.length || unexpected.length ? "violated" : !coverageComplete || mismatch.length ? "unknown" : "satisfied";
  return freeze({
    expectations: expectationsInput,
    narrativeClaimedEffectIds: narrative.claimedEffectIds,
    narrativeClaimedNoEffects: narrative.claimedEffectIds.length === 0,
    coverage: freeze([...coverage]), observedEffects: freeze([...observed]),
    providerObservedEffectCount: observed.length, providerEvidenceFingerprint: evidence?.fingerprint ?? null,
    disposition, mismatchEffectIds: freeze(sorted(mismatch)), forbiddenObservedEffectIds: freeze(sorted(forbidden)),
    unexpectedObservedInstanceIds: freeze(sorted(unexpected)), executorEvidenceRefs: narrative.evidenceRefs,
    coordinatorEvidenceRefs: freeze(sorted([...coverage.flatMap((entry) => entry.evidenceRefs), ...observed.flatMap((entry) => entry.evidenceRefs)])),
  });
}

function admitRequirements(raw: WorkerResultRequirementsWithEffectsV1): { enhanced: WorkerResultRequirementsWithEffectsV1; base: core.WorkerResultRequirementsV1 } {
  const value = exact(snapshot(raw, "Worker result requirements"), ["version", "checkoutProfile", "briefDigest", "resultContractFingerprint", "runId", "runnerProfile", "coordinatorFacts", "executorContract", "obligations", "deltaRequirement", "grantsAuthority", "authorizesResultApplication", "effectExpectations", "fingerprint"], "Worker result requirements");
  const effectExpectations = expectations(value.effectExpectations);
  const supplied = digest(value.fingerprint, "Worker result requirements fingerprint");
  const body = { ...value, effectExpectations } as Record<string, unknown>;
  delete body.fingerprint;
  if (fingerprintCanonicalRequest(body) !== supplied) throw new RangeError("Worker result requirements fingerprint does not match its content");
  const coordinator = exact(value.coordinatorFacts, ["repository", "logicalSourceRef", "dispatchHead", "dispatchTree", "canonicalMainRef", "canonicalMainHeadAtDispatch", "providerTaskId", "providerDispatch", "sourcePlacementDispatch", "canonicalMainPlacementDispatch"], "Worker result coordinator facts");
  const actualDispatch = admitDispatch(coordinator.providerDispatch);
  const enhancedContractFingerprint = fingerprintCanonicalRequest({ version: value.version, briefDigest: value.briefDigest, checkoutProfile: value.checkoutProfile, dispatchTree: coordinator.dispatchTree, deltaRequirement: value.deltaRequirement, obligations: value.obligations, effectExpectations });
  if (value.resultContractFingerprint !== enhancedContractFingerprint || actualDispatch.resultContractFingerprint !== enhancedContractFingerprint) throw new RangeError("Worker effect-sensitive result contract fingerprint does not match requirements");
  const baseContractFingerprint = fingerprintCanonicalRequest({ version: value.version, briefDigest: value.briefDigest, checkoutProfile: value.checkoutProfile, dispatchTree: coordinator.dispatchTree, deltaRequirement: value.deltaRequirement, obligations: value.obligations });
  const baseDispatch = core.compileWorkerProviderDispatchReceiptV1({ ...withoutFingerprint(actualDispatch), resultContractFingerprint: baseContractFingerprint });
  const baseBody = { ...value, resultContractFingerprint: baseContractFingerprint, coordinatorFacts: { ...coordinator, providerDispatch: baseDispatch } } as Record<string, unknown>;
  delete baseBody.effectExpectations;
  delete baseBody.fingerprint;
  const base = freeze({ ...baseBody, fingerprint: fingerprintCanonicalRequest(baseBody) }) as unknown as core.WorkerResultRequirementsV1;
  return { enhanced: freeze({ ...body, fingerprint: supplied }) as unknown as WorkerResultRequirementsWithEffectsV1, base };
}

function admitObservation(raw: WorkerResultObservationV1, enhancedFingerprint: string, baseFingerprint: string): { base: core.WorkerResultObservationV1; effects: WorkerResultEffectNarrativeV1 } {
  const value = exact(snapshot(raw, "Worker result observation"), ["requirementsFingerprint", "checkout", "obligations", "delta", "effects"], "Worker result observation");
  if (digest(value.requirementsFingerprint, "Worker result target fingerprint") !== enhancedFingerprint) throw new RangeError("Worker result targets different requirements");
  const effectValue = exact(value.effects, ["claimedEffectIds", "evidenceRefs"], "Worker effect narrative");
  const claimedEffectIds = boundedArray(effectValue.claimedEffectIds, 32, "Worker claimed effect IDs").map((entry) => id(entry, 160, "Worker claimed effect ID"));
  unique(claimedEffectIds, "Worker claimed effect IDs");
  return {
    base: { requirementsFingerprint: baseFingerprint, checkout: value.checkout as core.WorkerResultObservationV1["checkout"], obligations: value.obligations as core.WorkerResultObservationV1["obligations"], delta: value.delta as core.WorkerResultObservationV1["delta"] },
    effects: freeze({ claimedEffectIds: freeze(claimedEffectIds), evidenceRefs: refs(effectValue.evidenceRefs, "Worker effect narrative evidence") }),
  };
}

function adaptDelta(raw: core.WorkerCanonicalDeltaEvidenceV1 | null, enhancedFingerprint: string, baseFingerprint: string): { admitted: core.WorkerCanonicalDeltaEvidenceV1 | null; base: core.WorkerCanonicalDeltaEvidenceV1 | null } {
  if (raw === null) return { admitted: null, base: null };
  const admitted = core.compileWorkerCanonicalDeltaEvidenceV1(deltaInput(raw, enhancedFingerprint));
  if (raw.fingerprint !== admitted.fingerprint || raw.canonicalDelta !== admitted.canonicalDelta) throw new RangeError("Canonical worker delta evidence does not match effect-sensitive requirements");
  return { admitted, base: core.compileWorkerCanonicalDeltaEvidenceV1(deltaInput(admitted, baseFingerprint)) };
}
function deltaInput(value: core.WorkerCanonicalDeltaEvidenceV1, requirementsFingerprint: string): core.CompileWorkerCanonicalDeltaEvidenceInputV1 {
  return {
    version: value.version, requirementsFingerprint, observedAt: value.observedAt, providerTaskId: value.providerTaskId,
    providerStatus: value.providerStatus, evidenceAvailability: value.evidenceAvailability, changedFileCount: value.changedFileCount,
    changedLineCount: value.changedLineCount, diffAvailable: value.diffAvailable, evidenceRefs: value.evidenceRefs,
  };
}

function admitEffectEvidence(raw: WorkerEffectEvidenceV1): WorkerEffectEvidenceV1 {
  const value = exact(snapshot(raw, "Worker effect evidence"), ["version", "requirementsFingerprint", "observedAt", "providerTaskId", "coverage", "observedEffects", "fingerprint"], "Worker effect evidence");
  const compiled = compileWorkerEffectEvidenceV1({
    version: value.version as 1,
    requirementsFingerprint: value.requirementsFingerprint as string,
    observedAt: value.observedAt as string,
    providerTaskId: value.providerTaskId as string,
    coverage: value.coverage as CompileWorkerEffectEvidenceInputV1["coverage"],
    observedEffects: value.observedEffects as CompileWorkerEffectEvidenceInputV1["observedEffects"],
  });
  if (value.fingerprint !== compiled.fingerprint) throw new RangeError("Worker effect evidence does not match its content");
  return compiled;
}
function admitDispatch(raw: unknown): core.WorkerProviderDispatchReceiptV1 {
  const value = exact(snapshot(raw, "Worker provider dispatch receipt"), ["version", "providerTaskId", "dispatchedAt", "runnerReservationFingerprint", "sourcePlacementDispatchFingerprint", "canonicalMainPlacementDispatchFingerprint", "resultContractFingerprint", "fingerprint"], "Worker provider dispatch receipt");
  const compiled = core.compileWorkerProviderDispatchReceiptV1({
    version: value.version as 1,
    providerTaskId: value.providerTaskId as string,
    dispatchedAt: value.dispatchedAt as string,
    runnerReservationFingerprint: value.runnerReservationFingerprint as string,
    sourcePlacementDispatchFingerprint: value.sourcePlacementDispatchFingerprint as string,
    canonicalMainPlacementDispatchFingerprint: value.canonicalMainPlacementDispatchFingerprint as string,
    resultContractFingerprint: value.resultContractFingerprint as string,
  });
  if (value.fingerprint !== compiled.fingerprint) throw new RangeError("Worker provider dispatch receipt does not match its content");
  return compiled;
}
function withoutFingerprint(value: core.WorkerProviderDispatchReceiptV1): core.CompileWorkerProviderDispatchReceiptInputV1 {
  const { fingerprint: _fingerprint, ...body } = value;
  return body;
}

function expectations(raw: unknown): readonly WorkerResultEffectExpectationV1[] {
  const values = boundedArray(raw, 32, "Worker effect expectations");
  if (values.length === 0) throw new RangeError("Effect-sensitive result contracts require at least one declared effect expectation");
  const output = values.map((value) => {
    const entry = exact(value, ["id", "provider", "disposition", "statement", "sourceRef"], "Worker effect expectation");
    if (entry.disposition !== "allowed" && entry.disposition !== "forbidden") throw new RangeError("Worker effect expectation disposition is invalid");
    return freeze({ id: id(entry.id, 160, "Worker effect expectation ID"), provider: provider(entry.provider), disposition: entry.disposition as WorkerResultEffectExpectationDispositionV1, statement: text(entry.statement, 500, "Worker effect expectation statement"), sourceRef: text(entry.sourceRef, 500, "Worker effect expectation source") });
  });
  unique(output.map((entry) => entry.id), "Worker effect expectation IDs");
  return freeze(output);
}
function hasEffects(value: WorkerResultRequirementsV1): value is WorkerResultRequirementsWithEffectsV1 {
  try { return Object.prototype.hasOwnProperty.call(value, "effectExpectations"); }
  catch { throw new RangeError("Worker result requirements could not be inspected"); }
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  exactKeys(value as Record<string, unknown>, keys, label);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string") || actual.length !== keys.length || [...keys].sort().some((key, index) => key !== (actual as string[]).sort()[index])) throw new RangeError(`${label} has unexpected fields`);
}
function boundedArray(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) throw new RangeError(`${label} must be a bounded plain array`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string") || !keys.includes("length")) throw new RangeError(`${label} cannot be sparse or decorated`);
  return value.map((entry) => entry);
}
function refs(value: unknown, label: string): readonly string[] {
  const output = boundedArray(value, 16, label).map((entry) => text(entry, 500, `${label} reference`));
  if (output.length === 0) throw new RangeError(`${label} requires at least one reference`);
  unique(output, label); return freeze(output);
}
function provider(value: unknown): string { const output = text(value, 80, "Worker effect provider"); if (!/^[a-z0-9][a-z0-9._:-]*$/u.test(output)) throw new RangeError("Worker effect provider is invalid"); return output }
function id(value: unknown, max: number, label: string): string { const output = text(value, max, label); if (!/^[A-Za-z0-9][A-Za-z0-9._:/@#-]*$/u.test(output)) throw new RangeError(`${label} is invalid`); return output }
function text(value: unknown, max: number, label: string): string { if (typeof value !== "string") throw new RangeError(`${label} must be text`); const output = value.trim(); if (!output || output.length > max || /[\u0000-\u001f\u007f]/u.test(output)) throw new RangeError(`${label} is invalid`); return output }
function digest(value: unknown, label: string): string { if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) throw new RangeError(`${label} is invalid`); return value }
function iso(value: unknown, label: string): string { const output = text(value, 64, label); const time = Date.parse(output); if (!Number.isFinite(time) || new Date(time).toISOString() !== output) throw new RangeError(`${label} must be canonical ISO time`); return output }
function unique(values: readonly string[], label: string): void { if (new Set(values).size !== values.length) throw new RangeError(`${label} must be unique`) }
function sorted(values: readonly string[]): string[] { return [...new Set(values)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0) }

function snapshot(value: unknown, label: string, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") throw new TypeError(`${label} contains unsupported data`);
  if (depth > 24) throw new RangeError(`${label} is too deeply nested`);
  if (seen.has(value)) throw new RangeError(`${label} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) return boundedArray(value, 2048, label).map((entry, index) => snapshot(entry, `${label}[${index}]`, seen, depth + 1));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must contain only plain objects`);
    const keys = Reflect.ownKeys(value);
    if (keys.length > 256 || keys.some((key) => typeof key !== "string")) throw new RangeError(`${label} cannot be decorated or unbounded`);
    const output: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new RangeError(`${label}.${key} must be an enumerable data property`);
      output[key] = snapshot(descriptor.value, `${label}.${key}`, seen, depth + 1);
    }
    return output;
  } finally { seen.delete(value); }
}
function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const nested of Object.values(value as Record<string, unknown>)) freeze(nested); Object.freeze(value) } return value }
