import { describe, expect, test } from "bun:test";
import type { EffectiveToolSurfaceSnapshot } from "../src/effective-tool-surface.js";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.js";
import {
  reconcileRunnerCancellationSettlementV1,
  type RunnerCancellationReconciliationEvidenceV1,
  type RunnerCancellationReconciliationKindV1,
} from "../src/runner-cancellation-reconciliation.js";
import {
  RunnerCancellationSettlementCoordinatorV1,
  type RunnerCancellationSettlementResultV1,
} from "../src/runner-cancellation-settlement.js";
import {
  RUNNER_ADAPTER_V1,
  parseRunnerAdapterDescriptorV1,
  type RunnerAdapterDescriptorV1,
  type RunnerAdapterV1,
  type RunnerCancellationCommandV1,
  type RunnerCancellationObservationV1,
  type RunnerCapabilityProbeV1,
  type RunnerCheckpointCommandV1,
  type RunnerExternalReferenceV1,
  type RunnerObservationV1,
  type RunnerResumeCommandV1,
  type RunnerStartCommandV1,
} from "../src/runner-adapter-v1.js";

const adapterId = "reconcile-adapter";
const adapterVersion = "1.0.0";
const profileId = "reconcile-profile";
const runId = "run-reconcile";
const requestedAt = "2026-08-01T01:00:00.000Z";
const executionAt = "2026-08-01T01:00:01.000Z";
const cancellationObservedAt = "2026-08-01T01:00:02.000Z";
const settledAt = "2026-08-01T01:00:03.000Z";
const evidenceCreatedAt = "2026-08-01T01:00:04.000Z";
const reconciledAt = "2026-08-01T01:00:05.000Z";
const defaultDigest = `sha256:${"a".repeat(64)}`;

function command(): RunnerCancellationCommandV1 {
  return {
    version: RUNNER_ADAPTER_V1,
    commandId: "cancel-reconcile-1",
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    leaseGeneration: 2,
    authority: {
      resource: `run:${runId}`,
      holderId: "actor-reconcile",
      generation: 2,
      expiresAt: "2026-08-01T02:00:00.000Z",
    },
    requestedAt,
    reason: "Cancel and reconcile the exact test run.",
  };
}

function cancellationObservation(
  input: RunnerCancellationCommandV1,
  reference: RunnerExternalReferenceV1 | null = null,
): RunnerCancellationObservationV1 {
  return {
    version: 1,
    commandId: input.commandId,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    profileId: input.profileId,
    runId: input.runId,
    runGeneration: input.runGeneration,
    leaseGeneration: input.leaseGeneration,
    observedAt: cancellationObservedAt,
    requestAccepted: true,
    deliveryKnown: true,
    remoteSettlementKnown: false,
    reference,
  };
}

class ReconciliationAdapter implements RunnerAdapterV1 {
  readonly descriptor: RunnerAdapterDescriptorV1;

  constructor(
    readonly cancellationHandler: (
      input: RunnerCancellationCommandV1,
    ) => Promise<RunnerCancellationObservationV1> = async (input) =>
      cancellationObservation(input),
  ) {
    this.descriptor = parseRunnerAdapterDescriptorV1({
      version: 1,
      adapterId,
      adapterVersion,
      profiles: [{ id: profileId, version: "2026-08-01" }],
      transports: ["memory"],
      checkpointMode: "none",
      cancellationMode: "acknowledged",
      supports: {
        start: true,
        resume: false,
        capabilityInspection: false,
        streamingObservations: false,
        durableReplay: false,
        usageReferences: false,
        traceReferences: false,
      },
    });
  }

  describe(): RunnerAdapterDescriptorV1 {
    return this.descriptor;
  }

  async inspectCapabilities(
    _input: RunnerCapabilityProbeV1,
  ): Promise<EffectiveToolSurfaceSnapshot> {
    throw new Error("unused capability probe");
  }

  async *start(
    _input: RunnerStartCommandV1,
  ): AsyncIterable<RunnerObservationV1> {
    throw new Error("unused start");
  }

  async *resume(
    _input: RunnerResumeCommandV1,
  ): AsyncIterable<RunnerObservationV1> {
    throw new Error("unused resume");
  }

  async requestCheckpoint(
    _input: RunnerCheckpointCommandV1,
  ): Promise<RunnerExternalReferenceV1> {
    throw new Error("unused checkpoint");
  }

  async requestCancellation(
    input: RunnerCancellationCommandV1,
  ): Promise<RunnerCancellationObservationV1> {
    return await this.cancellationHandler(input);
  }
}

async function coordinatorResult(
  adapter: RunnerAdapterV1,
): Promise<RunnerCancellationSettlementResultV1> {
  const clock = [executionAt, settledAt];
  const result = await new RunnerCancellationSettlementCoordinatorV1(
    adapter,
    { version: 1, workspace: "default", project: "scrapbook" },
    command(),
    () => clock.shift()!,
  ).request();
  expect(clock).toEqual([]);
  return result;
}

async function originalResult(): Promise<RunnerCancellationSettlementResultV1> {
  return await coordinatorResult(new ReconciliationAdapter());
}

async function adapterFailureResult(): Promise<RunnerCancellationSettlementResultV1> {
  return await coordinatorResult(new ReconciliationAdapter(async () => {
    throw new Error("bounded provider failure");
  }));
}

async function originalResultWithReference(
  createdAt: string,
): Promise<RunnerCancellationSettlementResultV1> {
  const reference: RunnerExternalReferenceV1 = {
    version: 1,
    kind: "provider_receipt",
    adapterId,
    externalId: "cancel-observation-receipt",
    digest: defaultDigest,
    uri: null,
    generation: 1,
    createdAt,
    accessClass: "project",
    containsPrivateContent: false,
    containsCredentials: false,
  };
  return await coordinatorResult(new ReconciliationAdapter(async (input) =>
    cancellationObservation(input, reference)
  ));
}

function evidenceExternalId(
  kind: RunnerCancellationReconciliationKindV1,
): string {
  const prefix = kind === "provider_settled"
    ? "remote-settlement"
    : kind === "provider_still_running"
      ? "runtime-still-running"
      : kind === "provider_unknown"
        ? "runtime-unknown"
        : "publication-fence";
  return `${prefix}:${runId}:g1`;
}

function evidenceReference(
  kind: RunnerCancellationReconciliationKindV1 = "provider_settled",
  overrides: Partial<RunnerExternalReferenceV1> = {},
): RunnerExternalReferenceV1 & { digest: string } {
  const digest = typeof overrides.digest === "string"
    ? overrides.digest
    : defaultDigest;
  return {
    version: 1,
    kind: "provider_receipt",
    adapterId,
    externalId: evidenceExternalId(kind),
    uri: null,
    generation: 1,
    createdAt: evidenceCreatedAt,
    accessClass: "project",
    containsPrivateContent: false,
    containsCredentials: false,
    ...overrides,
    digest,
  };
}

function evidence(
  original: RunnerCancellationSettlementResultV1,
  overrides: Partial<RunnerCancellationReconciliationEvidenceV1> = {},
): RunnerCancellationReconciliationEvidenceV1 {
  const kind = overrides.kind ?? "provider_settled";
  const publicationFenceFingerprint =
    overrides.publicationFenceFingerprint ?? null;
  const reference = overrides.reference ?? evidenceReference(kind, {
    digest: kind === "publication_fence"
      && typeof publicationFenceFingerprint === "string"
      ? publicationFenceFingerprint
      : defaultDigest,
  });
  const base: RunnerCancellationReconciliationEvidenceV1 = {
    version: 1,
    reconciliationId: "reconcile-1",
    originalResultFingerprint: original.resultFingerprint,
    kind,
    commandId: original.commandId,
    adapterId: original.adapterId,
    adapterVersion: original.adapterVersion,
    profileId: original.profileId,
    runId: original.runId,
    runGeneration: original.runGeneration,
    leaseGeneration: original.leaseGeneration,
    observedAt: reconciledAt,
    reference,
    publicationFenceFingerprint,
  };
  return {
    ...base,
    ...overrides,
    kind,
    reference,
    publicationFenceFingerprint,
  };
}

function refingerprint(
  result: RunnerCancellationSettlementResultV1,
): void {
  const { resultFingerprint: _discarded, ...withoutFingerprint } = result;
  result.resultFingerprint = fingerprintCanonicalRequest(withoutFingerprint);
}

function hideUnknownFieldOnSecondOwnKeys<T extends object>(
  target: T,
  field: string,
): T {
  let ownKeysCalls = 0;
  return new Proxy(target, {
    ownKeys(current) {
      ownKeysCalls += 1;
      const keys = Reflect.ownKeys(current);
      return ownKeysCalls === 1
        ? keys
        : keys.filter((key) => key !== field);
    },
  });
}

function addUnknownField<T extends object>(target: T): T {
  Object.defineProperty(target, "escapedAdmission", {
    configurable: true,
    enumerable: true,
    value: true,
    writable: true,
  });
  return target;
}

describe("runner cancellation reconciliation", () => {
  test("releases the exact next generation after provider-settled evidence", async () => {
    const original = await originalResult();
    const result = reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original),
    );

    expect(original.commandFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(original.settlement.operationRef).toBe(original.commandFingerprint);
    expect(result.commandFingerprint).toBe(original.commandFingerprint);
    expect(result).toMatchObject({
      outcome: "released_remote_settlement",
      kind: "provider_settled",
      settlement: {
        disposition: "retired",
        phase: "settled_failure",
      },
      generationAdvance: {
        allowed: true,
        reason: "next_generation_allowed",
      },
      containsPrivateContent: false,
      containsCredentials: false,
    });
    expect(result.settlement.owners[0]).toMatchObject({
      state: "settled_failure",
      failureClass: "cancelled",
      reconciliationRequired: false,
      canPublishLate: false,
    });
    expect(result.settlement.successfulOutputs).toEqual([{
      ownerKey: "worker:reconcile-adapter:reconcile-profile:g1",
      outputFingerprint: defaultDigest,
    }]);
    expect(result.evidenceReference.externalId).toBe(
      "remote-settlement:run-reconcile:g1",
    );
    expect(result.resultFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("releases through one receipt-bound late-publication fence", async () => {
    const original = await originalResult();
    const fence = `sha256:${"b".repeat(64)}`;
    const result = reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original, {
        kind: "publication_fence",
        publicationFenceFingerprint: fence,
      }),
    );

    expect(result.outcome).toBe("released_publication_fence");
    expect(result.generationAdvance.allowed).toBe(true);
    expect(result.evidenceReference).toMatchObject({
      externalId: "publication-fence:run-reconcile:g1",
      digest: fence,
      uri: null,
      accessClass: "project",
    });
    expect(result.settlement.owners[0]).toMatchObject({
      state: "publication_fenced",
      failureClass: "unknown_outcome",
      reconciliationRequired: false,
      canPublishLate: true,
      publicationFenceFingerprint: fence,
    });
  });

  test("keeps still-running and unknown provider observations blocked", async () => {
    const original = await originalResult();
    for (const kind of ["provider_still_running", "provider_unknown"] as const) {
      const result = reconcileRunnerCancellationSettlementV1(
        original,
        evidence(original, { kind, reconciliationId: `reconcile-${kind}` }),
      );
      expect(result.outcome, kind).toBe("still_reconciling");
      expect(result.settlement.disposition, kind).toBe("reconciliation_hold");
      expect(result.settlement.owners[0]?.state, kind).toBe(
        "reconciliation_required",
      );
      expect(result.evidenceReference.externalId, kind).toBe(
        evidenceExternalId(kind),
      );
      expect(result.generationAdvance, kind).toMatchObject({
        allowed: false,
        reason: "reconciliation_still_required",
      });
    }
  });

  test("accepts an adapter-failure result with no retained cancellation output", async () => {
    const original = await adapterFailureResult();
    expect(original).toMatchObject({
      outcome: "adapter_failure",
      cancellation: null,
    });
    expect(original.settlement.owners[0]?.outputFingerprint).toBeNull();

    const result = reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original, { kind: "provider_unknown" }),
    );
    expect(result.outcome).toBe("still_reconciling");
    expect(result.generationAdvance.allowed).toBe(false);
  });

  test("rejects adapter-failure results that retain cancellation evidence", async () => {
    const failed = structuredClone(await adapterFailureResult());
    const observed = await originalResult();
    failed.cancellation = observed.cancellation;
    refingerprint(failed);

    expect(() => reconcileRunnerCancellationSettlementV1(
      failed,
      evidence(failed),
    )).toThrow("adapter failure cannot retain cancellation evidence");
  });

  test("replays identical reconciliation inputs deterministically", async () => {
    const original = await originalResult();
    const proof = evidence(original);
    const first = reconcileRunnerCancellationSettlementV1(original, proof);
    const second = reconcileRunnerCancellationSettlementV1(original, proof);

    expect(second).toEqual(first);
    expect(second.resultFingerprint).toBe(first.resultFingerprint);
  });

  test("rejects altered top-level identity through exact nested binding", async () => {
    const original = await originalResult();
    const altered = structuredClone(original);
    altered.runId = "run-forged";

    expect(() => reconcileRunnerCancellationSettlementV1(
      altered,
      evidence(original),
    )).toThrow("observation does not match settlement result");
  });

  test("rejects a recomputed result with a different command fingerprint", async () => {
    const original = structuredClone(await originalResult());
    original.commandFingerprint = `sha256:${"b".repeat(64)}`;
    refingerprint(original);

    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original),
    )).toThrow("settlement receipt does not match result identity");
  });

  test("rejects recomputed fingerprints with altered nested cancellation identity", async () => {
    const original = structuredClone(await originalResult());
    if (!original.cancellation) throw new Error("expected cancellation evidence");
    original.cancellation.runId = "run-forged";
    refingerprint(original);

    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original),
    )).toThrow("observation does not match settlement result");
  });

  test("rejects recomputed fingerprints with credential-bearing cancellation references", async () => {
    const original = structuredClone(await originalResult());
    if (!original.cancellation) throw new Error("expected cancellation evidence");
    original.cancellation.reference = {
      version: 1,
      kind: "provider_receipt",
      adapterId,
      externalId: `github_pat_${"z".repeat(40)}`,
      digest: defaultDigest,
      uri: null,
      generation: 1,
      createdAt: cancellationObservedAt,
      accessClass: "project",
      containsPrivateContent: false,
      containsCredentials: false,
    };
    refingerprint(original);

    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original),
    )).toThrow();
  });

  test("rejects nested cancellation references before the request", async () => {
    const original = await originalResultWithReference(
      "2026-08-01T00:59:59.999Z",
    );

    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original),
    )).toThrow("outside request and observation bounds");
  });

  test("rejects a recomputed generation-advance mismatch", async () => {
    const original = structuredClone(await originalResult());
    original.generationAdvance.allowed = true;
    refingerprint(original);

    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original),
    )).toThrow("generation-advance decision does not match settlement");
  });

  test("rejects original-result accessors without invoking them", async () => {
    const clean = await originalResult();
    const proof = evidence(clean);
    const hostile = structuredClone(clean) as unknown as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(hostile, "runId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("hostile original getter");
      },
    });

    expect(() => reconcileRunnerCancellationSettlementV1(
      hostile,
      proof,
    )).toThrow("must contain only enumerable data properties");
    expect(getterCalls).toBe(0);
  });

  test("rejects evidence-reference accessors without invoking them", async () => {
    const original = await originalResult();
    const hostile = evidenceReference() as unknown as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(hostile, "digest", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("hostile evidence getter");
      },
    });

    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original, {
        reference: hostile as unknown as RunnerExternalReferenceV1,
      }),
    )).toThrow("must contain only enumerable data properties");
    expect(getterCalls).toBe(0);
  });

  test("rejects an unknown original-result field hidden between key reads", async () => {
    const clean = await originalResult();
    const hostile = hideUnknownFieldOnSecondOwnKeys(
      addUnknownField(structuredClone(clean)),
      "escapedAdmission",
    );

    expect(() => reconcileRunnerCancellationSettlementV1(
      hostile,
      evidence(clean),
    )).toThrow("has unknown field escapedAdmission");
  });

  test("rejects an unknown evidence field hidden between key reads", async () => {
    const original = await originalResult();
    const hostile = hideUnknownFieldOnSecondOwnKeys(
      addUnknownField(structuredClone(evidence(original))),
      "escapedAdmission",
    );

    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      hostile,
    )).toThrow("has unknown field escapedAdmission");
  });

  test("retains and rejects own __proto__ fields on prior results", async () => {
    const original = structuredClone(await originalResult()) as unknown as Record<
      string,
      unknown
    >;
    Object.defineProperty(original, "__proto__", {
      configurable: true,
      enumerable: true,
      value: { escapedAdmission: true },
      writable: true,
    });
    expect(Object.prototype.hasOwnProperty.call(original, "__proto__")).toBe(true);

    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original as unknown as RunnerCancellationSettlementResultV1),
    )).toThrow("has unknown field __proto__");
  });

  test("retains and rejects own __proto__ fields on evidence", async () => {
    const original = await originalResult();
    const hostile = evidence(original) as unknown as Record<string, unknown>;
    Object.defineProperty(hostile, "__proto__", {
      configurable: true,
      enumerable: true,
      value: { escapedAdmission: true },
      writable: true,
    });
    expect(Object.prototype.hasOwnProperty.call(hostile, "__proto__")).toBe(true);

    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      hostile,
    )).toThrow("has unknown field __proto__");
  });

  test("rejects identity drift and stale reconciliation time", async () => {
    const original = await originalResult();
    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original, { runId: "run-other" }),
    )).toThrow("does not match original result");

    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original, { observedAt: requestedAt }),
    )).toThrow("predates original settlement");
  });

  test("rejects cross-generation, stale, or unattributed evidence references", async () => {
    const original = await originalResult();
    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original, {
        reference: evidenceReference("provider_settled", { generation: 2 }),
      }),
    )).toThrow("not attributable to the run");

    const missingDigest = evidenceReference();
    missingDigest.digest = null as unknown as string;
    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original, { reference: missingDigest }),
    )).toThrow("not attributable to the run");

    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original, {
        reference: evidenceReference("provider_settled", {
          createdAt: requestedAt,
        }),
      }),
    )).toThrow("not attributable to the run");
  });

  test("binds each provider receipt to its declared evidence kind", async () => {
    const original = await originalResult();
    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original, {
        kind: "provider_settled",
        reference: evidenceReference("provider_unknown"),
      }),
    )).toThrow("reference does not match evidence kind");
  });

  test("requires a receipt-bound fence and rejects unrelated digests", async () => {
    const original = await originalResult();
    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original, {
        kind: "publication_fence",
        publicationFenceFingerprint: null,
      }),
    )).toThrow("fence is not bound to its receipt");

    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original, {
        kind: "publication_fence",
        publicationFenceFingerprint: `sha256:${"b".repeat(64)}`,
        reference: evidenceReference("publication_fence", {
          digest: `sha256:${"c".repeat(64)}`,
        }),
      }),
    )).toThrow("fence is not bound to its receipt");

    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original, {
        kind: "provider_settled",
        publicationFenceFingerprint: `sha256:${"c".repeat(64)}`,
      }),
    )).toThrow("provider evidence cannot contain a publication fence");
  });

  test("rejects retained provider URIs and non-project receipt access", async () => {
    const original = await originalResult();

    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original, {
        reference: evidenceReference("provider_settled", {
          uri: "https://provider.example/receipts/settlement-1",
        }),
      }),
    )).toThrow("not attributable to the run");

    for (const accessClass of ["private", "workspace"] as const) {
      expect(() => reconcileRunnerCancellationSettlementV1(
        original,
        evidence(original, {
          reference: evidenceReference("provider_settled", { accessClass }),
        }),
      )).toThrow("not attributable to the run");
    }
  });

  test("rejects credential-shaped reconciliation identities", async () => {
    const original = await originalResult();
    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original, {
        reconciliationId: `github_pat_${"d".repeat(40)}`,
      }),
    )).toThrow("reconciliation ID is invalid");
  });

  test("rejects nested array entries hidden by changing proxy length", async () => {
    const original = structuredClone(await originalResult());
    const target = [{
      ownerKey: "worker:extra:g1",
      outputFingerprint: `sha256:${"e".repeat(64)}`,
    }];
    let lengthReads = 0;
    const hostile = new Proxy(target, {
      get(current, property, receiver) {
        if (property === "length") {
          lengthReads += 1;
          return lengthReads < 3 ? 1 : 0;
        }
        return Reflect.get(current, property, receiver);
      },
    });
    (original.settlement as unknown as { successfulOutputs: unknown }).successfulOutputs = hostile;

    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original),
    )).toThrow("outputs are not derived correctly");
  });
});
