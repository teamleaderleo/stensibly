import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { MAX_EXECUTION_RECORDS_PER_RUN } from "../src/execution-record-limits";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const actor = { id: "agent:bounds", name: "Bounds", kind: "agent" as const };
const envelope = {
  schemaVersion: 1 as const,
  objective: "Verify bounded hosted execution history",
  scopeClass: "atomic" as const,
  estimate: { lowMinutes: 5, likelyMinutes: 10, highMinutes: 20, confidence: 0.8 },
  budget: { expectedMessages: 1, expectedToolCalls: 5, expectedReviewMinutes: 2 },
  boundaries: { softCheckpointMinutes: 12, forcedHandoffMinutes: 18, hardRecoveryMinutes: 25 },
  completion: {
    requiredOutputs: ["bounded projection"],
    verificationRequired: true,
    continuationStateRequired: false,
    acceptanceChecks: ["limit and overflow are deterministic"],
  },
  durableState: {
    accessClass: "project" as const,
    retentionClass: "standard" as const,
    redactionRequired: false,
    deleteAfter: null,
  },
};

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret));

describe("hosted execution projection bounds", () => {
  test("returns exactly the shared limit and fails closed above it", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t, "Hosted record bound");
    const run = await t.mutation(convexApi.runs.start, {
      serviceSecret: secret,
      workspace,
      itemId: item.id,
      actor,
      harness: "generic-mcp",
      executionEnvelope: envelope,
    }) as any;

    await insertActualEvents(t, item.id, run.id, MAX_EXECUTION_RECORDS_PER_RUN);
    const atLimit = await t.query(convexApi.runs.listActive, {
      serviceSecret: secret,
      workspace,
      project: "bounds",
    }) as any[];
    expect(atLimit[0]?.executionRecords).toHaveLength(MAX_EXECUTION_RECORDS_PER_RUN);

    await insertActualEvents(t, item.id, run.id, 1, MAX_EXECUTION_RECORDS_PER_RUN);
    await expect(t.query(convexApi.runs.listActive, {
      serviceSecret: secret,
      workspace,
      project: "bounds",
    })).rejects.toThrow("Run execution-result history exceeds the bounded projection");
  });

  test("filters private execution rows before the public 100-event limit", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t, "Hosted public event bound");
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("items").collect())
        .find((entry) => entry.externalId === item.id);
      if (!row) throw new Error("Item fixture disappeared");
      for (let index = 0; index < 100; index += 1) {
        const id = await ctx.db.insert("events", {
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          itemId: row._id,
          externalId: "pending",
          type: "work.progressed",
          payload: { index },
          createdAt: 1_000 + index,
        });
        await ctx.db.patch(id, { externalId: `evt_${id}` });
      }
      for (let index = 0; index < 120; index += 1) {
        const id = await ctx.db.insert("events", {
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          itemId: row._id,
          externalId: "pending",
          type: `run.execution_actual:private-${index}`,
          payload: { index },
          createdAt: 2_000 + index,
        });
        await ctx.db.patch(id, { externalId: `evt_${id}` });
      }
    });

    const detail = await t.query(convexApi.itemControl.get, {
      serviceSecret: secret,
      workspace,
      id: item.id,
      now: 3_000,
    }) as any;
    expect(detail.events).toHaveLength(100);
    expect(detail.events.filter((event: any) => event.type === "work.progressed"))
      .toHaveLength(99);
    expect(detail.events.some((event: any) => event.type === "item.created")).toBe(true);
    expect(detail.events.some((event: any) =>
      event.type.startsWith("run.execution_envelope:")
      || event.type.startsWith("run.execution_actual:")
    )).toBe(false);
  });
});

async function createItem(t: ReturnType<typeof convexTest>, title: string) {
  return await t.mutation(convexApi.items.create, {
    serviceSecret: secret,
    workspace,
    project: "bounds",
    kind: "task",
    title,
    nextAction: "Verify the bound.",
    priority: 50,
    actor,
  }) as any;
}

async function insertActualEvents(
  t: ReturnType<typeof convexTest>,
  itemExternalId: string,
  runId: string,
  count: number,
  offset = 0,
) {
  await t.run(async (ctx) => {
    const item = (await ctx.db.query("items").collect())
      .find((entry) => entry.externalId === itemExternalId);
    if (!item) throw new Error("Item fixture disappeared");
    for (let index = 0; index < count; index += 1) {
      const ordinal = offset + index;
      const id = await ctx.db.insert("events", {
        workspaceId: item.workspaceId,
        projectId: item.projectId,
        itemId: item._id,
        externalId: "pending",
        type: `run.execution_actual:${runId}`,
        payload: {
          runId,
          generation: ordinal + 2,
          leaseGeneration: 1,
          transition: "finish:succeeded",
          actual: { toolCalls: ordinal },
        },
        createdAt: 10_000 + ordinal,
      });
      await ctx.db.patch(id, { externalId: `evt_${id}` });
    }
  });
}
