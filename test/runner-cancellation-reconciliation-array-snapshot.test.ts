import { describe, expect, test } from "bun:test";
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
  type RunnerAdapterV1,
  type RunnerCancellationCommandV1,
  type RunnerCancellationObservationV1,
} from "../src/runner-adapter-v1.js";

const adapterId = "array-snapshot-adapter";
const adapterVersion = "1.0.0";
const profileId = "array-snapshot-profile";
const runId = "run-array-snapshot";
const requestedAt = "2026-08-01T02:00:00.000Z";
const executionAt = "2026-08-01T02:00:01.000Z";
const cancellationObservedAt = "2026-08-01T02:00:02.000Z";
const settledAt = "2026-08-01T02:00:03.000Z";
const evidenceCreatedAt = "2026-08-01T02:00:04.000Z";
const reconciledAt = "2026-08-01T02:00:05.000Z";
const digest = `sha256:${"a".repeat(64)}`;

function command(): RunnerCancellationCommandV1 {
  return {
    version: RUNNER_ADAPTER_V1,
    commandId: "cancel-array-snapshot",
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    leaseGeneration: 2,
    authority: {
      resource: `run:${runId}`,
      holderId: "actor-array-snapshot",
      generation: 2,
      expiresAt: "2026-08-01T03:00:00.000Z",
    },
    requestedAt,
    reason: "Exercise array descriptor snapshot admission.",
  };
}

function adapter(): RunnerAdapterV1 {
  const descriptor = parseRunnerAdapterDescriptorV1({
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
  return {
    descriptor,
    describe: () => descriptor,
    requestCancellation: async (
      input: RunnerCancellationCommandV1,
    ): Promise<RunnerCancellationObservationV1> => ({
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
    }),
  } as unknown as RunnerAdapterV1;
}

async function originalResult(): Promise<RunnerCancellationSettlementResultV1> {
  const clock = [executionAt, settledAt];
  return new RunnerCancellationSettlementCoordinatorV1(
    adapter(),
    { version: 1, workspace: "default", project: "scrapbook" },
    command(),
    () => clock.shift()!,
  ).request();
}

function evidence(
  original: RunnerCancellationSettlementResultV1,
): RunnerCancellationReconciliationEvidenceV1 {
  return {
    version: 1,
    reconciliationId: "reconcile-array-snapshot-1",
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
      externalId: `remote-settlement:${runId}:g1`,
      digest,
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

function changingLengthArray(): string[] {
  const target = [digest];
  let reads = 0;
  return new Proxy(target, {
    get(current, key, receiver) {
      if (key === "length") {
        reads += 1;
        return reads <= 2 ? 1 : 0;
      }
      return Reflect.get(current, key, receiver);
    },
  });
}

describe("runner cancellation reconciliation array snapshots", () => {
  test("rejects an array entry hidden between validation and copy length reads", async () => {
    const clean = await originalResult();
    const hostile = structuredClone(clean) as RunnerCancellationSettlementResultV1;
    (hostile.settlement as { successfulOutputs: string[] }).successfulOutputs =
      changingLengthArray();

    expect(() => reconcileRunnerCancellationSettlementV1(
      hostile,
      evidence(clean),
    )).toThrow();
  });
});
