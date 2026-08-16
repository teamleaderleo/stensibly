import { describe, expect, test } from "bun:test";
import { stableJson } from "../src/canonical-json.ts";
import { ConvexOrchestratorActivityIngestionStore } from "../src/convex-orchestrator-activity-ingestion-store.ts";
import {
  compileOrchestratorActivityIngestionCandidate,
} from "../src/orchestrator-activity-ingestion-candidate.ts";
import { compileOrchestratorActivityObservation } from "../src/orchestrator-activity-observation.ts";

function input(overrides: Record<string, unknown> = {}) {
  return {
    deliveryId: "delivery_adapter_1",
    deliveryFingerprint: `sha256:${"a".repeat(64)}`,
    acceptedAt: "2026-08-16T06:20:01.000Z",
    observation: {
      workspace: "default",
      project: "stensibly",
      actorId: "actor_adapter",
      sourceClass: "ledger_event",
      sourceId: "event_adapter_1",
      sourceFingerprint: `sha256:${"b".repeat(64)}`,
      observedAt: "2026-08-16T06:20:00.000Z",
      activityClass: "progress_evidence",
      activityState: "in_progress",
    },
    ...overrides,
  };
}

function responseFor(value = input(), responseOverrides: Record<string, unknown> = {}) {
  const candidate = compileOrchestratorActivityIngestionCandidate(value);
  return {
    receiptJson: stableJson(candidate.receipt),
    observationJson: stableJson(candidate.observation),
    replayed: false,
    observationAppended: true,
    ...responseOverrides,
  };
}

describe("Convex orchestrator activity ingestion adapter", () => {
  test("sends canonical bounded input and re-admits the durable result", async () => {
    const calls: Array<{ kind: string; args: Record<string, unknown> }> = [];
    const store = new ConvexOrchestratorActivityIngestionStore({
      serviceSecret: "service-secret",
      workspace: "default",
      client: {
        async mutation(_reference, args) {
          calls.push({ kind: "mutation", args });
          return responseFor();
        },
        async query() {
          throw new Error("unexpected query");
        },
      },
    });

    const result = await store.ingest(input());
    expect(result).toMatchObject({ replayed: false, observationAppended: true });
    expect(result.receipt.deliveryId).toBe("delivery_adapter_1");
    expect(result.observation.sourceId).toBe("event_adapter_1");
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(calls[0]!.args.ingestionJson as string);
    expect(sent).toMatchObject({
      deliveryId: "delivery_adapter_1",
      acceptedAt: "2026-08-16T06:20:01.000Z",
      observation: { workspace: "default", project: "stensibly" },
    });
    expect(calls[0]!.args).toMatchObject({
      serviceSecret: "service-secret",
      workspace: "default",
      project: "stensibly",
    });
  });

  test("accepts original receipt replay when only accepted time changed", async () => {
    const original = responseFor();
    const replayInput = input({ acceptedAt: "2026-08-16T06:25:00.000Z" });
    const store = new ConvexOrchestratorActivityIngestionStore({
      serviceSecret: "service-secret",
      client: {
        async mutation() {
          return { ...original, replayed: true, observationAppended: false };
        },
        async query() {
          throw new Error("unexpected query");
        },
      },
    });
    const replay = await store.ingest(replayInput);
    expect(replay.replayed).toBe(true);
    expect(replay.observationAppended).toBe(false);
    expect(replay.receipt.acceptedAt).toBe("2026-08-16T06:20:01.000Z");
  });

  test("re-admits receipt lookups and rejects credential-shaped IDs before query", async () => {
    const candidate = compileOrchestratorActivityIngestionCandidate(input());
    let queryCalls = 0;
    const store = new ConvexOrchestratorActivityIngestionStore({
      serviceSecret: "service-secret",
      client: {
        async mutation() {
          throw new Error("unexpected mutation");
        },
        async query() {
          queryCalls += 1;
          return { receiptJson: stableJson(candidate.receipt) };
        },
      },
    });
    const receipt = await store.getReceipt("default", "stensibly", "delivery_adapter_1");
    expect(receipt?.receiptId).toBe(candidate.receipt.receiptId);
    expect(queryCalls).toBe(1);

    await expect(store.getReceipt(
      "default",
      "stensibly",
      "github_pat_abcdefghijklmnopqrstuvwxyz",
    )).rejects.toThrow("credential material");
    expect(queryCalls).toBe(1);
  });

  test("preserves durable append order and refuses gaps", async () => {
    const first = compileOrchestratorActivityObservation(input().observation);
    const second = compileOrchestratorActivityObservation({
      ...(input().observation as Record<string, unknown>),
      sourceId: "event_adapter_2",
      sourceFingerprint: `sha256:${"c".repeat(64)}`,
      observedAt: "2026-08-16T06:10:00.000Z",
    });
    let corrupt = false;
    const store = new ConvexOrchestratorActivityIngestionStore({
      serviceSecret: "service-secret",
      client: {
        async mutation() {
          throw new Error("unexpected mutation");
        },
        async query() {
          return {
            observations: [
              { appendOrder: 1, observationJson: stableJson(first) },
              { appendOrder: corrupt ? 3 : 2, observationJson: stableJson(second) },
            ],
            truncated: false,
          };
        },
      },
    });
    const listed = await store.listObservations("default", "stensibly", 32);
    expect(listed.observations.map((row) => row.sourceId)).toEqual([
      "event_adapter_1",
      "event_adapter_2",
    ]);
    expect(listed.observations.map((row) => row.observedAt)).toEqual([
      "2026-08-16T06:20:00.000Z",
      "2026-08-16T06:10:00.000Z",
    ]);

    corrupt = true;
    await expect(store.listObservations("default", "stensibly", 32))
      .rejects.toThrow("append order is not contiguous");
  });

  test("rejects corrupted durable receipts and impossible replay append state", async () => {
    const candidate = compileOrchestratorActivityIngestionCandidate(input());
    const badReceipt = { ...candidate.receipt, receiptId: "oair_00000000000000000000000000000000" };
    const store = new ConvexOrchestratorActivityIngestionStore({
      serviceSecret: "service-secret",
      client: {
        async mutation() {
          return {
            receiptJson: stableJson(badReceipt),
            observationJson: stableJson(candidate.observation),
            replayed: true,
            observationAppended: true,
          };
        },
        async query() {
          throw new Error("unexpected query");
        },
      },
    });
    await expect(store.ingest(input())).rejects.toThrow(/receipt ID|replayed/i);
  });
});
