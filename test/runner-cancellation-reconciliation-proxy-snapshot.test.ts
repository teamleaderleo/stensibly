import { describe, expect, test } from "bun:test";
import { reconcileRunnerCancellationSettlementV1 } from "../src/runner-cancellation-reconciliation.ts";
import {
  RunnerCancellationSettlementCoordinatorV1,
  type RunnerCancellationSettlementResultV1,
} from "../src/runner-cancellation-settlement.ts";
import type { EffectiveToolSurfaceSnapshot } from "../src/effective-tool-surface.ts";
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
} from "../src/runner-adapter-v1.ts";

const adapterId = "proxy-adapter";
const adapterVersion = "1.0.0";
const profileId = "proxy-profile";
const runId = "run-proxy-snapshot";
const requestedAt = "2026-08-01T01:00:00.000Z";
const executionAt = "2026-08-01T01:00:01.000Z";
const cancellationObservedAt = "2026-08-01T01:00:02.000Z";
const settledAt = "2026-08-01T01:00:03.000Z";
const evidenceCreatedAt = "2026-08-01T01:00:04.000Z";
const reconciledAt = "2026-08-01T01:00:05.000Z";
const digest = `sha256:${"a".repeat(64)}`;

class ProxyAdapter implements RunnerAdapterV1 {
  readonly descriptor: RunnerAdapterDescriptorV1;

  constructor() {
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

async function priorResult(): Promise<RunnerCancellationSettlementResultV1> {
  const command: RunnerCancellationCommandV1 = {
    version: RUNNER_ADAPTER_V1,
    commandId: "cancel-proxy-snapshot-1",
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    leaseGeneration: 2,
    authority: {
      resource: `run:${runId}`,
      holderId: "actor-proxy",
      generation: 2,
      expiresAt: "2026-08-01T02:00:00.000Z",
    },
    requestedAt,
    reason: "Exercise one descriptor snapshot.",
  };
  const clock = [executionAt, settledAt];
  const result = await new RunnerCancellationSettlementCoordinatorV1(
    new ProxyAdapter(),
    { version: 1, workspace: "default", project: "scrapbook" },
    command,
    () => clock.shift()!,
  ).request();
  expect(clock).toEqual([]);
  return result;
}

function mutablePriorResult(
  result: RunnerCancellationSettlementResultV1,
): RunnerCancellationSettlementResultV1 {
  return JSON.parse(JSON.stringify(result)) as RunnerCancellationSettlementResultV1;
}

function evidence(result: RunnerCancellationSettlementResultV1) {
  return {
    version: 1,
    reconciliationId: "reconcile-proxy-snapshot-1",
    originalResultFingerprint: result.resultFingerprint,
    kind: "provider_settled",
    commandId: result.commandId,
    adapterId: result.adapterId,
    adapterVersion: result.adapterVersion,
    profileId: result.profileId,
    runId: result.runId,
    runGeneration: result.runGeneration,
    leaseGeneration: result.leaseGeneration,
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

describe("runner cancellation reconciliation descriptor snapshots", () => {
  test("rejects changing own-key views from one captured descriptor map", async () => {
    const clean = await priorResult();
    const mutable = mutablePriorResult(clean);
    const stableKeys = Reflect.ownKeys(mutable);
    let ownKeyCalls = 0;
    const proxied = new Proxy(mutable, {
      ownKeys() {
        ownKeyCalls += 1;
        return ownKeyCalls === 1 ? stableKeys : stableKeys.slice(1);
      },
    });

    expect(() => reconcileRunnerCancellationSettlementV1(
      proxied,
      evidence(clean),
    )).toThrow();
    expect(ownKeyCalls).toBe(1);
  });

  test("uses the captured nested array length without later proxy reads", async () => {
    const clean = await priorResult();
    const mutable = mutablePriorResult(clean);
    const owners = mutable.settlement.owners;
    let lengthReads = 0;
    mutable.settlement.owners = new Proxy(owners, {
      get(target, property, receiver) {
        if (property === "length") {
          lengthReads += 1;
          return lengthReads === 1 ? Reflect.get(target, property, receiver) : 0;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const result = reconcileRunnerCancellationSettlementV1(
      mutable,
      evidence(clean),
    );

    expect(result.outcome).toBe("released_remote_settlement");
    expect(lengthReads).toBe(0);
  });
});
