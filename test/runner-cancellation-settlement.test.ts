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

const requestedAt = "2026-08-01T00:00:00.000Z";
const observedAt = "2026-08-01T00:00:05.000Z";
const adapterId = "loop-adapter";
const adapterVersion = "1.0.0";
const profileId = "test-profile";
const runId = "run-cancellation-settlement";

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
    commandId: "cancel-command-1",
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
      expiresAt: "2026-08-01T01:00:00.000Z",
    },
    requestedAt,
    reason: "Stop the bounded conformance run.",
    ...overrides,
  };
}

function cancellationObservation(
  input: RunnerCancellationCommandV1,
  overrides: Partial<RunnerCancellationObservationV1> = {},
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
    observedAt,
    requestAccepted: true,
    deliveryKnown: false,
    remoteSettlementKnown: false,
    reference: null,
    ...overrides,
  };
}

function providerReceiptReference(): RunnerExternalReferenceV1 & { digest: string } {
  return {
    version: 1,
    kind: "provider_receipt",
    adapterId,
    externalId: "cancel-receipt-1",
    digest: `sha256:${"a".repeat(64)}`,
    uri: null,
    generation: 1,
    createdAt: observedAt,
    accessClass: "project",
    containsPrivateContent: false,
    containsCredentials: false,
  };
}

class CancellationAdapter implements RunnerAdapterV1 {
  readonly descriptor: RunnerAdapterDescriptorV1;
  calls = 0;

  constructor(
    cancellationMode: RunnerAdapterDescriptorV1["cancellationMode"] = "best_effort",
    readonly handler: (
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
      cancellationMode,
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
    this.calls += 1;
    return await this.handler(input);
  }
}

describe("runner cancellation settlement coordinator", () => {
  test("joins concurrent callers around one adapter cancellation", async () => {
    let resolve!: (value: RunnerCancellationObservationV1) => void;
    const adapter = new CancellationAdapter(
      "best_effort",
      (input) => new Promise((done) => {
        resolve = (value) => done(value);
        expect(input.commandId).toBe("cancel-command-1");
      }),
    );
    const input = command();
    const coordinator = new RunnerCancellationSettlementCoordinatorV1(
      adapter,
      scope,
      input,
      () => observedAt,
    );

    const first = coordinator.request();
    const second = coordinator.request();
    expect(second).toBe(first);
    expect(coordinator.admissionOpen).toBe(false);
    expect(coordinator.phase).toBe("closing");

    await Promise.resolve();
    expect(adapter.calls).toBe(1);
    resolve(cancellationObservation(input));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(secondResult).toBe(firstResult);
    expect(firstResult.outcome).toBe("cancellation_observed");
    expect(firstResult.settlement.phase).toBe("settled_failure");
    expect(firstResult.settlement.reconciliationOwnerKeys).toEqual([
      "worker:loop-adapter:test-profile:g1",
    ]);
    expect(firstResult.generationAdvance).toMatchObject({
      allowed: false,
      reason: "reconciliation_still_required",
    });
    expect(firstResult.resultFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(firstResult.containsPrivateContent).toBe(false);
    expect(firstResult.containsCredentials).toBe(false);
    expect(Object.isFrozen(firstResult)).toBe(true);
    expect(coordinator.phase).toBe("settled_success");
  });

  test("cancelling one waiter does not cancel the authoritative operation", async () => {
    let resolve!: (value: RunnerCancellationObservationV1) => void;
    const input = command();
    const adapter = new CancellationAdapter(
      "best_effort",
      () => new Promise((done) => {
        resolve = done;
      }),
    );
    const coordinator = new RunnerCancellationSettlementCoordinatorV1(
      adapter,
      scope,
      input,
      () => observedAt,
    );
    const abort = new AbortController();
    const cancelled = coordinator.request(abort.signal);
    const surviving = coordinator.request();

    await Promise.resolve();
    abort.abort();
    resolve(cancellationObservation(input));

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await expect(surviving).resolves.toMatchObject({
      outcome: "cancellation_observed",
    });
    expect(adapter.calls).toBe(1);
    expect(coordinator.phase).toBe("settled_success");
  });

  test("converts adapter failures into content-minimised reconciliation evidence", async () => {
    const adapter = new CancellationAdapter("best_effort", async () => {
      throw new Error(`provider leaked github_pat_${"a".repeat(40)}`);
    });
    const coordinator = new RunnerCancellationSettlementCoordinatorV1(
      adapter,
      scope,
      command(),
      () => observedAt,
    );

    const result = await coordinator.request();
    expect(result.outcome).toBe("adapter_failure");
    expect(result.cancellation).toBeNull();
    expect(result.settlement.reconciliationOwnerKeys).toHaveLength(1);
    expect(result.generationAdvance.allowed).toBe(false);
    expect(JSON.stringify(result)).not.toContain("github_pat_");
    expect(JSON.stringify(result)).not.toContain("provider leaked");
    expect(adapter.calls).toBe(1);
  });

  test("rejects hostile observation accessors without invoking them", async () => {
    let getterCalls = 0;
    const adapter = new CancellationAdapter("best_effort", async (input) => {
      const hostile = cancellationObservation(input) as unknown as Record<string, unknown>;
      Object.defineProperty(hostile, "commandId", {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error("hostile getter");
        },
      });
      return hostile as unknown as RunnerCancellationObservationV1;
    });
    const coordinator = new RunnerCancellationSettlementCoordinatorV1(
      adapter,
      scope,
      command(),
      () => observedAt,
    );

    const result = await coordinator.request();
    expect(result.outcome).toBe("adapter_failure");
    expect(getterCalls).toBe(0);
    expect(result.cancellation).toBeNull();
  });

  test("rejects nested reference accessors without invoking them", async () => {
    let getterCalls = 0;
    const adapter = new CancellationAdapter("best_effort", async (input) => {
      const hostile = providerReceiptReference() as unknown as Record<string, unknown>;
      Object.defineProperty(hostile, "digest", {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error("hostile reference getter");
        },
      });
      return cancellationObservation(input, {
        reference: hostile as unknown as RunnerExternalReferenceV1,
      });
    });
    const coordinator = new RunnerCancellationSettlementCoordinatorV1(
      adapter,
      scope,
      command(),
      () => observedAt,
    );

    const result = await coordinator.request();
    expect(result.outcome).toBe("adapter_failure");
    expect(result.cancellation).toBeNull();
    expect(getterCalls).toBe(0);
  });

  test("treats identity drift as adapter failure and keeps the generation blocked", async () => {
    const adapter = new CancellationAdapter("best_effort", async (input) =>
      cancellationObservation(input, { runId: "run-other" })
    );
    const coordinator = new RunnerCancellationSettlementCoordinatorV1(
      adapter,
      scope,
      command(),
      () => observedAt,
    );

    const result = await coordinator.request();
    expect(result.outcome).toBe("adapter_failure");
    expect(result.generationAdvance).toMatchObject({
      allowed: false,
      reason: "reconciliation_still_required",
    });
  });

  test("rejects cross-generation cancellation references", async () => {
    const reference = providerReceiptReference();
    reference.generation = 2;
    const adapter = new CancellationAdapter("best_effort", async (input) =>
      cancellationObservation(input, { reference })
    );
    const coordinator = new RunnerCancellationSettlementCoordinatorV1(
      adapter,
      scope,
      command(),
      () => observedAt,
    );

    const result = await coordinator.request();
    expect(result.outcome).toBe("adapter_failure");
    expect(result.cancellation).toBeNull();
    expect(result.settlement.successfulOutputs).toEqual([]);
    expect(result.generationAdvance.allowed).toBe(false);
  });

  test("resolves hostile or retrograde clocks as bounded reconciliation evidence", async () => {
    const cases: Array<[string, () => string]> = [
      ["throwing", () => {
        throw new Error(`clock leaked github_pat_${"b".repeat(40)}`);
      }],
      ["malformed", () => "invalid-time"],
      ["before request", () => "2026-07-31T23:59:59.000Z"],
      ["before adapter observation", () => "2026-08-01T00:00:02.000Z"],
    ];

    for (const [label, clock] of cases) {
      const adapter = new CancellationAdapter();
      const coordinator = new RunnerCancellationSettlementCoordinatorV1(
        adapter,
        scope,
        command({ commandId: `cancel-${label.replaceAll(" ", "-")}` }),
        clock,
      );

      const result = await coordinator.request();
      expect(result, label).toMatchObject({
        outcome: "adapter_failure",
        cancellation: null,
        observedAt: requestedAt,
        settlement: {
          disposition: "reconciliation_hold",
        },
        generationAdvance: {
          allowed: false,
          reason: "reconciliation_still_required",
        },
      });
      expect(JSON.stringify(result), label).not.toContain("github_pat_");
      expect(JSON.stringify(result), label).not.toContain("clock leaked");
      expect(coordinator.phase, label).toBe("settled_success");
    }
  });

  test("retains a cancellation receipt digest during reconciliation", async () => {
    const reference = providerReceiptReference();
    const adapter = new CancellationAdapter("acknowledged", async (input) =>
      cancellationObservation(input, {
        requestAccepted: true,
        deliveryKnown: true,
        reference,
      })
    );
    const coordinator = new RunnerCancellationSettlementCoordinatorV1(
      adapter,
      scope,
      command(),
      () => observedAt,
    );

    const result = await coordinator.request();
    expect(result.outcome).toBe("cancellation_observed");
    expect(result.settlement.successfulOutputs).toEqual([{
      ownerKey: "worker:loop-adapter:test-profile:g1",
      outputFingerprint: reference.digest,
    }]);
    expect(result.generationAdvance.allowed).toBe(false);
  });

  test("rejects an expired authority before adapter activity", () => {
    const adapter = new CancellationAdapter();
    expect(() => new RunnerCancellationSettlementCoordinatorV1(
      adapter,
      scope,
      command({
        authority: {
          resource: `run:${runId}`,
          holderId: "runner-actor",
          generation: 1,
          expiresAt: requestedAt,
        },
      }),
      () => observedAt,
    )).toThrow("Runner cancellation authority is expired at request time");
    expect(adapter.calls).toBe(0);
  });

  test("rejects credential-shaped commands before adapter activity", () => {
    const adapter = new CancellationAdapter();
    expect(() => new RunnerCancellationSettlementCoordinatorV1(
      adapter,
      scope,
      command({ commandId: `github_pat_${"a".repeat(40)}` }),
      () => observedAt,
    )).toThrow("Runner cancellation command ID is invalid");
    expect(adapter.calls).toBe(0);
  });

  test("rejects adapters that declare cancellation unsupported", () => {
    const adapter = new CancellationAdapter("unsupported");
    expect(() => new RunnerCancellationSettlementCoordinatorV1(
      adapter,
      scope,
      command(),
      () => observedAt,
    )).toThrow("does not support cancellation");
    expect(adapter.calls).toBe(0);
  });
});
