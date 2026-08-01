import { describe, expect, test } from "bun:test";
import type { EffectiveToolSurfaceSnapshot } from "../src/effective-tool-surface.js";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.js";
import {
  reconcileRunnerCancellationSettlementV1,
  type RunnerCancellationReconciliationEvidenceV1,
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

const adapterId = "reconcile-failure-adapter";
const adapterVersion = "1.0.0";
const profileId = "reconcile-failure-profile";
const runId = "run-reconcile-failure";
const requestedAt = "2026-08-01T03:00:00.000Z";
const executionAt = "2026-08-01T03:00:01.000Z";
const cancellationObservedAt = "2026-08-01T03:00:02.000Z";
const settledAt = "2026-08-01T03:00:03.000Z";
const evidenceCreatedAt = "2026-08-01T03:00:04.000Z";
const reconciledAt = "2026-08-01T03:00:05.000Z";
const evidenceDigest = `sha256:${"a".repeat(64)}`;

function command(): RunnerCancellationCommandV1 {
  return {
    version: RUNNER_ADAPTER_V1,
    commandId: "cancel-reconcile-failure",
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    leaseGeneration: 2,
    authority: {
      resource: `run:${runId}`,
      holderId: "actor-reconcile-failure",
      generation: 2,
      expiresAt: "2026-08-01T04:00:00.000Z",
    },
    requestedAt,
    reason: "Exercise adapter-failure reconciliation controls.",
  };
}

class FailureAdapter implements RunnerAdapterV1 {
  readonly descriptor: RunnerAdapterDescriptorV1;

  constructor(readonly fails: boolean) {
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
    if (this.fails) {
      throw new Error("bounded provider failure");
    }
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
      reference: null,
    };
  }
}

async function settlementResult(
  fails: boolean,
): Promise<RunnerCancellationSettlementResultV1> {
  const clock = [executionAt, settledAt];
  const result = await new RunnerCancellationSettlementCoordinatorV1(
    new FailureAdapter(fails),
    { version: 1, workspace: "default", project: "scrapbook" },
    command(),
    () => clock.shift()!,
  ).request();
  expect(clock).toEqual([]);
  return result;
}

function unknownEvidence(
  original: RunnerCancellationSettlementResultV1,
): RunnerCancellationReconciliationEvidenceV1 {
  return {
    version: 1,
    reconciliationId: "reconcile-adapter-failure",
    originalResultFingerprint: original.resultFingerprint,
    kind: "provider_unknown",
    commandId: original.commandId,
    adapterId: original.adapterId,
    adapterVersion: original.adapterVersion,
    profileId: original.profileId,
    runId: original.runId,
    runGeneration: original.runGeneration,
    leaseGeneration: original.leaseGeneration,
    observedAt: reconciledAt,
    reference: {
      version: 1,
      kind: "provider_receipt",
      adapterId,
      externalId: `runtime-unknown:${runId}:g1`,
      digest: evidenceDigest,
      uri: null,
      generation: 1,
      createdAt: evidenceCreatedAt,
      accessClass: "project",
      containsPrivateContent: false,
      containsCredentials: false,
    },
    publicationFenceFingerprint: null,
  };
}

function refingerprint(result: RunnerCancellationSettlementResultV1): void {
  const { resultFingerprint: _discarded, ...withoutFingerprint } = result;
  result.resultFingerprint = fingerprintCanonicalRequest(withoutFingerprint);
}

describe("runner cancellation reconciliation adapter failures", () => {
  test("keeps a legitimate adapter failure under reconciliation hold", async () => {
    const original = await settlementResult(true);
    expect(original).toMatchObject({
      outcome: "adapter_failure",
      cancellation: null,
    });
    expect(original.settlement.owners[0]?.outputFingerprint).toBeNull();

    const result = reconcileRunnerCancellationSettlementV1(
      original,
      unknownEvidence(original),
    );
    expect(result).toMatchObject({
      commandFingerprint: original.commandFingerprint,
      outcome: "still_reconciling",
      generationAdvance: {
        allowed: false,
        reason: "reconciliation_still_required",
      },
    });
  });

  test("rejects adapter failure that retains cancellation evidence", async () => {
    const failed = structuredClone(await settlementResult(true));
    const observed = await settlementResult(false);
    failed.cancellation = observed.cancellation;
    refingerprint(failed);

    expect(() => reconcileRunnerCancellationSettlementV1(
      failed,
      unknownEvidence(failed),
    )).toThrow("adapter failure cannot retain cancellation evidence");
  });
});
