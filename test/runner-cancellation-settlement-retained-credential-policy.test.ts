import { describe, expect, test } from "bun:test";
import type { EffectiveToolSurfaceSnapshot } from "../src/effective-tool-surface.js";
import {
  RunnerCancellationSettlementCoordinatorV1,
  type RunnerCancellationSettlementScopeV1,
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

const requestedAt = "2026-08-08T01:00:00.000Z";
const observedAt = "2026-08-08T01:00:05.000Z";
const adapterId = "credential-control-adapter";
const adapterVersion = "1.0.0";
const profileId = "credential-control";

const scope: RunnerCancellationSettlementScopeV1 = {
  version: 1,
  workspace: "default",
  project: "stensibly",
};

function command(
  overrides: Partial<RunnerCancellationCommandV1> = {},
): RunnerCancellationCommandV1 {
  const runId = overrides.runId ?? "run-credential-control";
  return {
    version: RUNNER_ADAPTER_V1,
    commandId: "cancel-credential-control",
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    leaseGeneration: 1,
    authority: {
      resource: `run:${runId}`,
      holderId: "credential-control-holder",
      generation: 1,
      expiresAt: "2026-08-08T02:00:00.000Z",
    },
    requestedAt,
    reason: "Stop the bounded credential control run.",
    ...overrides,
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
    observedAt,
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

function coordinator(
  input: RunnerCancellationCommandV1,
  scopeInput: RunnerCancellationSettlementScopeV1 = scope,
): RunnerCancellationSettlementCoordinatorV1 {
  return new RunnerCancellationSettlementCoordinatorV1(
    new CancellationAdapter(),
    scopeInput,
    input,
    () => observedAt,
  );
}

describe("runner cancellation settlement shared retained credential policy", () => {
  test("rejects grammar-reachable Stensibly identities at the shared 12-character threshold", () => {
    const serviceIdentity = `stn.svc_${"a".repeat(12)}`;
    const tokenIdentity = `stn.tok_${"b".repeat(12)}`;

    expect(() => coordinator(command({ commandId: serviceIdentity })))
      .toThrow("Runner cancellation command ID is invalid");
    expect(() => coordinator(command({ runId: tokenIdentity })))
      .toThrow("Runner cancellation run ID is invalid");
    expect(() => coordinator(command({
      authority: {
        ...command().authority,
        holderId: serviceIdentity,
      },
    }))).toThrow("Runner cancellation authority holder is invalid");
    expect(() => coordinator(command({ reason: `reason:${tokenIdentity}` })))
      .toThrow("Runner cancellation reason is invalid");
  });

  test("retains benign Stensibly-like aliases below the shared threshold", async () => {
    const benign = `stn.tok_${"a".repeat(11)}`;
    const input = command({
      commandId: benign,
      runId: benign,
      authority: {
        ...command({ runId: benign }).authority,
        holderId: benign,
      },
      reason: `reason:${benign}`,
    });
    const result = await coordinator(input).request();

    expect(result.commandId).toBe(benign);
    expect(result.runId).toBe(benign);
    expect(result.resultFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });
});
