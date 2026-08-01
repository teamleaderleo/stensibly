import { describe, expect, test } from "bun:test";
import type { EffectiveToolSurfaceSnapshot } from "../src/effective-tool-surface.js";
import {
  reconcileRunnerCancellationSettlementV1,
  type RunnerCancellationReconciliationEvidenceV1,
} from "../src/runner-cancellation-reconciliation.js";
import { RunnerCancellationSettlementCoordinatorV1 } from "../src/runner-cancellation-settlement.js";
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

const adapterId = "reconcile-boundary-adapter";
const adapterVersion = "1.0.0";
const profileId = "reconcile-boundary-profile";
const runId = "r".repeat(156);
const requestedAt = "2026-08-01T05:00:00.000Z";
const executionAt = "2026-08-01T05:00:01.000Z";
const cancellationObservedAt = "2026-08-01T05:00:02.000Z";
const settledAt = "2026-08-01T05:00:03.000Z";
const evidenceCreatedAt = "2026-08-01T05:00:04.000Z";
const reconciledAt = "2026-08-01T05:00:05.000Z";
const evidenceDigest = `sha256:${"a".repeat(64)}`;

class BoundaryAdapter implements RunnerAdapterV1 {
  readonly descriptor: RunnerAdapterDescriptorV1 = parseRunnerAdapterDescriptorV1({
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

function command(): RunnerCancellationCommandV1 {
  return {
    version: RUNNER_ADAPTER_V1,
    commandId: "cancel-reconcile-boundary",
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    leaseGeneration: 2,
    authority: {
      resource: `run:${runId}`,
      holderId: "actor-reconcile-boundary",
      generation: 2,
      expiresAt: "2026-08-01T06:00:00.000Z",
    },
    requestedAt,
    reason: "Exercise the maximum admitted cancellation run identity.",
  };
}

describe("runner cancellation reconciliation run identity boundary", () => {
  test("reconciles a maximum-length valid cancellation run ID", async () => {
    expect(runId).toHaveLength(156);
    expect(`run:${runId}`).toHaveLength(160);

    const clock = [executionAt, settledAt];
    const original = await new RunnerCancellationSettlementCoordinatorV1(
      new BoundaryAdapter(),
      { version: 1, workspace: "default", project: "scrapbook" },
      command(),
      () => clock.shift()!,
    ).request();
    expect(clock).toEqual([]);

    const runBasedExternalId = `remote-settlement:${runId}:g1`;
    expect(runBasedExternalId.length).toBeGreaterThan(160);
    const collidingLegacyExternalId = `remote-settlement:${original.commandFingerprint}:g1`;
    expect(collidingLegacyExternalId.length).toBeLessThanOrEqual(160);
    const externalId = `remote-settlement-fingerprint:${original.commandFingerprint}:g1`;
    expect(externalId.length).toBeLessThanOrEqual(160);
    const evidence: RunnerCancellationReconciliationEvidenceV1 = {
      version: 1,
      reconciliationId: "reconcile-run-boundary",
      originalResultFingerprint: original.resultFingerprint,
      kind: "provider_settled",
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
        externalId,
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

    expect(() => reconcileRunnerCancellationSettlementV1(original, {
      ...evidence,
      reference: {
        ...evidence.reference,
        externalId: collidingLegacyExternalId,
      },
    })).toThrow("Runner cancellation reconciliation reference does not match evidence kind");

    const result = reconcileRunnerCancellationSettlementV1(original, evidence);
    expect(result).toMatchObject({
      runId,
      commandFingerprint: original.commandFingerprint,
      outcome: "released_remote_settlement",
      evidenceReference: { externalId },
      generationAdvance: {
        allowed: true,
        reason: "next_generation_allowed",
      },
    });
  });
});
