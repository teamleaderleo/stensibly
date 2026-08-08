import { describe, expect, test } from "bun:test";
import type { EffectiveToolSurfaceSnapshot } from "../src/effective-tool-surface.js";
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

const adapterId = "reconciliation-credential-control";
const adapterVersion = "1.0.0";
const profileId = "credential-control";
const runId = "run-reconciliation-control";
const requestedAt = "2026-08-08T02:00:00.000Z";
const executionAt = "2026-08-08T02:00:01.000Z";
const cancellationObservedAt = "2026-08-08T02:00:02.000Z";
const settledAt = "2026-08-08T02:00:03.000Z";
const evidenceCreatedAt = "2026-08-08T02:00:04.000Z";
const reconciledAt = "2026-08-08T02:00:05.000Z";
const digest = `sha256:${"d".repeat(64)}`;

function command(): RunnerCancellationCommandV1 {
  return {
    version: RUNNER_ADAPTER_V1,
    commandId: "cancel-reconciliation-control",
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    leaseGeneration: 1,
    authority: {
      resource: `run:${runId}`,
      holderId: "reconciliation-holder",
      generation: 1,
      expiresAt: "2026-08-08T03:00:00.000Z",
    },
    requestedAt,
    reason: "Cancel the reconciliation credential control run.",
  };
}

function observation(
  input: RunnerCancellationCommandV1,
): RunnerCancellationObservationV1 {
  return {
    version: RUNNER_ADAPTER_V1,
    commandId: input.commandId,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    profileId: input.profileId,
    runId: input.runId,
    runGeneration: input.runGeneration,
    leaseGeneration: input.leaseGeneration,
    observedAt: cancellationObservedAt,
    requestAccepted: true,
    deliveryKnown: false,
    remoteSettlementKnown: false,
    reference: null,
  };
}

class CancellationAdapter implements RunnerAdapterV1 {
  readonly descriptor: RunnerAdapterDescriptorV1 = parseRunnerAdapterDescriptorV1({
    version: RUNNER_ADAPTER_V1,
    adapterId,
    adapterVersion,
    profiles: [{ id: profileId, version: "2026-08-08" }],
    transports: ["memory"],
    checkpointMode: "none",
    cancellationMode: "best_effort",
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
    return observation(input);
  }
}

async function originalResult(): Promise<RunnerCancellationSettlementResultV1> {
  const clock = [executionAt, settledAt];
  const result = await new RunnerCancellationSettlementCoordinatorV1(
    new CancellationAdapter(),
    { version: 1, workspace: "default", project: "stensibly" },
    command(),
    () => clock.shift()!,
  ).request();
  expect(clock).toEqual([]);
  return result;
}

function evidence(
  original: RunnerCancellationSettlementResultV1,
  reconciliationId: string,
): RunnerCancellationReconciliationEvidenceV1 {
  return {
    version: 1,
    reconciliationId,
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
      adapterId: original.adapterId,
      externalId: `remote-settlement:${original.runId}:g${original.runGeneration}`,
      digest,
      uri: null,
      generation: original.runGeneration,
      createdAt: evidenceCreatedAt,
      accessClass: "project",
      containsPrivateContent: false,
      containsCredentials: false,
    },
    publicationFenceFingerprint: null,
  };
}

describe("runner cancellation reconciliation shared retained credential policy", () => {
  test("rejects reconciliation identity at the shared 12-character Stensibly threshold", async () => {
    const original = await originalResult();
    const serviceIdentity = `stn.svc_${"a".repeat(12)}`;
    const tokenIdentity = `stn.tok_${"b".repeat(12)}`;

    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original, serviceIdentity),
    )).toThrow("Runner cancellation reconciliation ID is invalid");
    expect(() => reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original, tokenIdentity),
    )).toThrow("Runner cancellation reconciliation ID is invalid");
  });

  test("retains benign Stensibly-like reconciliation identity below the shared threshold", async () => {
    const original = await originalResult();
    const benign = `stn.tok_${"a".repeat(11)}`;
    const result = reconcileRunnerCancellationSettlementV1(
      original,
      evidence(original, benign),
    );

    expect(result.reconciliationId).toBe(benign);
    expect(result.resultFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });
});
