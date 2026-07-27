import { afterEach, describe, expect, test } from "bun:test";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexWorkLedger } from "../src/convex-ledger.ts";
import type { ItemControlView } from "../src/item-control.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const item = {
  id: "item_1",
  project: "scrapbook",
  kind: "task" as const,
  title: "Use the benchmark pool",
  summary: null,
  status: "ready" as const,
  priority: 50,
  nextAction: null,
  claimedBy: null,
  claimExpiresAt: null,
  claimGeneration: 0,
  version: 1,
  createdAt: "2026-07-25T12:00:00.000Z",
  updatedAt: "2026-07-25T12:00:00.000Z",
};

const control: ItemControlView = {
  schemaVersion: 1,
  authority: {
    state: "unclaimed",
    holderActorId: null,
    generation: 0,
    expiresAt: null,
    source: "none",
    allowedOperations: ["claim", "complete", "handoff", "block"],
    approvalRequiredOperations: [],
    unavailableReasons: {},
  },
  responsibility: {
    actorId: null,
    summary: null,
    nextAction: null,
    heartbeatExpectedAt: null,
    evidenceRequired: [],
    escalationState: "none",
  },
};

const capability = {
  version: 1,
  itemDetailVisibleEventLimit: 100,
  directVisibleEventLimit: 1_000,
  physicalEventRowLimit: 5_000,
  physicalEventByteLimit: 8 * 1024 * 1024,
  artifactLimit: 100,
  artifactOverflowCode: "history_window_overflow:artifacts",
  boundedItemControl: true,
  boundedDirectEvents: true,
  boundedArtifacts: true,
};

let store: StensiblyStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

describe("hosted item detail composition", () => {
  test("combines capability-verified canonical detail with the reservation query", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const reservations = [{
      id: "res_1",
      resource: "gpu:benchmark-pool",
      mode: "shared" as const,
      capacity: 5,
      units: 2,
      usedUnits: 4,
      availableUnits: 1,
      holderActorId: "alpha",
      expiresAt: "2026-07-25T12:15:00.000Z",
      createdAt: "2026-07-25T12:00:00.000Z",
      updatedAt: "2026-07-25T12:00:00.000Z",
    }];
    const runs = [{
      id: "run_1",
      itemId: item.id,
      actorId: "alpha",
      harness: "codex",
      model: "gpt-5.6",
      externalRunId: null,
      repository: "teamleaderleo/stensibly",
      branch: "feat/agent-run-visibility-v2",
      worktree: null,
      status: "running" as const,
      childAgentCount: 2,
      toolCallCount: 14,
      startedAt: "2026-07-25T12:00:00.000Z",
      lastHeartbeatAt: "2026-07-25T12:01:00.000Z",
      endedAt: null,
      outcome: null,
    }];
    const ledger = new ConvexWorkLedger({
      client: {
        query: async (reference: FunctionReference<"query">, args) => {
          const name = getFunctionName(reference);
          calls.push({ name, args });
          if (name === "historyCapabilities:get") return capability;
          if (name === "itemControl:get") {
            return {
              historyContractVersion: 1,
              item,
              control,
              events: [],
              eventsTruncated: false,
              artifacts: [],
              runs,
              dependencies: [],
            };
          }
          if (name === "itemReservations:list") return reservations;
          throw new Error(`Unexpected query ${name}`);
        },
        mutation: async () => {
          throw new Error("not used");
        },
      },
      serviceSecret: "service-secret",
      workspace: "default",
    });

    const before = Date.now();
    const detail = await ledger.getItem(item.id);
    const after = Date.now();
    const hostedDetail = detail as typeof detail & {
      historyContractVersion: 1;
      eventsTruncated: boolean;
    };

    expect(hostedDetail.historyContractVersion).toBe(1);
    expect(hostedDetail.eventsTruncated).toBe(false);
    expect(detail).toMatchObject({
      item,
      control,
      events: [],
      artifacts: [],
      dependencies: [],
      reservations,
      runs,
    });
    expect(calls.map((call) => call.name)).toEqual([
      "historyCapabilities:get",
      "itemControl:get",
      "itemReservations:list",
    ]);
    const capabilityCall = calls.find((call) => call.name === "historyCapabilities:get")!;
    const itemCall = calls.find((call) => call.name === "itemControl:get")!;
    const reservationCall = calls.find((call) => call.name === "itemReservations:list")!;
    expect(capabilityCall.args).toEqual({
      serviceSecret: "service-secret",
      workspace: "default",
    });
    expect(itemCall.args).toMatchObject({
      serviceSecret: "service-secret",
      workspace: "default",
      id: item.id,
    });
    expect(reservationCall.args).toMatchObject({
      serviceSecret: "service-secret",
      workspace: "default",
      itemId: item.id,
    });
    expect(itemCall.args.now as number).toBeGreaterThanOrEqual(before);
    expect(itemCall.args.now as number).toBeLessThanOrEqual(after);
    expect(reservationCall.args.now).toBe(itemCall.args.now);
  });

  test("keeps local REST item detail explicit and compatible", async () => {
    store = new StensiblyStore(":memory:");
    const created = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Keep local detail compatible",
      priority: 50,
      actor: { id: "leo", name: "Leo", kind: "human" },
    });
    const app = createServerApp(store);

    const response = await app.request(`/api/v1/items/${encodeURIComponent(created.id)}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      control: {
        schemaVersion: 1,
        authority: { state: "unclaimed", generation: 0, source: "none" },
      },
      dependencies: [],
      reservations: [],
      runs: [],
    });
  });
});
