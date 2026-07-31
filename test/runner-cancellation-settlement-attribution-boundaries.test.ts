import { describe, expect, test } from "bun:test";
import {
  RunnerCancellationSettlementCoordinatorV1,
  type RunnerCancellationSettlementScopeV1,
} from "../src/runner-cancellation-settlement.ts";
import {
  RUNNER_ADAPTER_V1,
  parseRunnerAdapterDescriptorV1,
  type RunnerAdapterDescriptorV1,
  type RunnerAdapterV1,
  type RunnerCancellationCommandV1,
  type RunnerCancellationObservationV1,
  type RunnerExternalReferenceV1,
} from "../src/runner-adapter-v1.ts";

const requestedAt = "2026-08-01T00:00:00.000Z";
const observedAt = "2026-08-01T00:00:05.000Z";
const adapterId = "loop-adapter";
const adapterVersion = "1.0.0";
const profileId = "test-profile";
const runId = "run-cancellation-attribution";

const scope: RunnerCancellationSettlementScopeV1 = {
  version: 1,
  workspace: "default",
  project: "scrapbook",
};

function command(
  overrides: Partial<RunnerCancellationCommandV1> = {},
): RunnerCancellationCommandV1 {
  return {
    version: RUNNER_ADAPTER_V1,
    commandId: "cancel-attribution-1",
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    leaseGeneration: 1,
    authority: {
      resource: `run:${runId}`,
      holderId: "runner-actor",
      generation: 1,
      expiresAt: "2026-08-01T00:01:00.000Z",
    },
    requestedAt,
    reason: "Stop the bounded conformance run.",
    ...overrides,
  };
}

function observation(
  input: RunnerCancellationCommandV1,
  overrides: Partial<RunnerCancellationObservationV1> = {},
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
    observedAt,
    requestAccepted: true,
    deliveryKnown: false,
    remoteSettlementKnown: false,
    reference: null,
    ...overrides,
  };
}

function providerReference(
  overrides: Partial<RunnerExternalReferenceV1> = {},
): RunnerExternalReferenceV1 {
  return {
    version: RUNNER_ADAPTER_V1,
    kind: "provider_receipt",
    adapterId,
    externalId: "cancel-receipt-attribution-1",
    digest: `sha256:${"a".repeat(64)}`,
    uri: null,
    generation: 1,
    createdAt: observedAt,
    accessClass: "project",
    containsPrivateContent: false,
    containsCredentials: false,
    ...overrides,
  };
}

class CancellationPort {
  readonly descriptor: RunnerAdapterDescriptorV1;
  calls = 0;

  constructor(
    readonly handler: (
      input: RunnerCancellationCommandV1,
    ) => Promise<RunnerCancellationObservationV1> = async (input) =>
      observation(input),
  ) {
    this.descriptor = parseRunnerAdapterDescriptorV1({
      version: RUNNER_ADAPTER_V1,
      adapterId,
      adapterVersion,
      profiles: [{ id: profileId, version: "2026-08-01" }],
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
  }

  describe(): RunnerAdapterDescriptorV1 {
    return this.descriptor;
  }

  async requestCancellation(
    input: RunnerCancellationCommandV1,
  ): Promise<RunnerCancellationObservationV1> {
    this.calls += 1;
    return await this.handler(input);
  }

  asAdapter(): RunnerAdapterV1 {
    return this as unknown as RunnerAdapterV1;
  }
}

describe("runner cancellation attribution boundaries", () => {
  test("does not dispatch after authority expires before execution", async () => {
    const adapter = new CancellationPort();
    const coordinator = new RunnerCancellationSettlementCoordinatorV1(
      adapter.asAdapter(),
      scope,
      command(),
      () => "2026-08-01T01:00:00.000Z",
    );

    const result = await coordinator.request();

    expect(adapter.calls).toBe(0);
    expect(result).toMatchObject({
      outcome: "adapter_failure",
      cancellation: null,
      generationAdvance: {
        allowed: false,
        reason: "reconciliation_still_required",
      },
    });
  });

  test("changes result identity when exact authority or intent changes", async () => {
    const firstAdapter = new CancellationPort();
    const secondAdapter = new CancellationPort();
    const first = new RunnerCancellationSettlementCoordinatorV1(
      firstAdapter.asAdapter(),
      scope,
      command(),
      () => "2026-08-01T00:00:10.000Z",
    );
    const second = new RunnerCancellationSettlementCoordinatorV1(
      secondAdapter.asAdapter(),
      scope,
      command({
        authority: {
          resource: `run:${runId}`,
          holderId: "replacement-runner",
          generation: 1,
          expiresAt: "2026-08-01T00:02:00.000Z",
        },
        reason: "Stop after operator reassignment.",
      }),
      () => "2026-08-01T00:00:10.000Z",
    );

    const [firstResult, secondResult] = await Promise.all([
      first.request(),
      second.request(),
    ]);

    expect(firstResult.commandId).toBe(secondResult.commandId);
    expect(firstResult.resultFingerprint).not.toBe(secondResult.resultFingerprint);
    expect(firstResult.settlement.receiptFingerprint)
      .not.toBe(secondResult.settlement.receiptFingerprint);
  });

  test("does not retain a reference created after its observation", async () => {
    const reference = providerReference({
      createdAt: "2026-08-01T01:00:00.000Z",
    });
    const adapter = new CancellationPort(async (input) => observation(input, {
      reference,
    }));
    const coordinator = new RunnerCancellationSettlementCoordinatorV1(
      adapter.asAdapter(),
      scope,
      command(),
      () => "2026-08-01T01:00:01.000Z",
    );

    const result = await coordinator.request();

    expect(result.outcome).toBe("adapter_failure");
    expect(result.cancellation).toBeNull();
    expect(result.settlement.successfulOutputs).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(reference.digest);
  });
});
