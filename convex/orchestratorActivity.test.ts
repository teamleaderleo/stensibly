import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { stableJson } from "../src/canonical-json";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "orchestrator-activity-service-secret";
const ingestRef = makeFunctionReference<"mutation">("orchestratorActivity:ingest");
const receiptRef = makeFunctionReference<"query">("orchestratorActivity:getReceipt");
const listRef = makeFunctionReference<"query">("orchestratorActivity:listObservations");

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

function observation(overrides: Record<string, unknown> = {}) {
  return {
    workspace: "test",
    project: "stensibly",
    actorId: "actor_cedar",
    sourceClass: "provider_receipt",
    sourceId: "ghop_1149_1",
    sourceFingerprint: `sha256:${"d".repeat(64)}`,
    observedAt: "2026-08-05T16:20:00.000Z",
    activityClass: "provider_effect",
    activityState: "succeeded",
    workItemId: "issue:1149",
    attemptId: "attempt_1",
    provider: "github",
    providerLifecycle: "verified",
    ...overrides,
  };
}

function ingestion(overrides: Record<string, unknown> = {}) {
  return {
    deliveryId: "delivery_1149_1",
    deliveryFingerprint: `sha256:${"c".repeat(64)}`,
    acceptedAt: "2026-08-05T16:20:01.000Z",
    observation: observation(),
    ...overrides,
  };
}

async function ingest(t: ReturnType<typeof convexTest>, value = ingestion()) {
  const project = (value.observation as Record<string, unknown>).project as string;
  return await t.mutation(ingestRef, {
    serviceSecret,
    workspace: "test",
    project,
    ingestionJson: stableJson(value),
  }) as any;
}

describe("durable orchestrator activity", () => {
  test("replays the original receipt and observation after reconnect", async () => {
    const t = convexTest(schema, modules);
    const first = await ingest(t);
    const replay = await ingest(t, ingestion({
      acceptedAt: "2026-08-05T16:25:00.000Z",
    }));

    expect(first).toMatchObject({ replayed: false, observationAppended: true });
    expect(replay).toMatchObject({ replayed: true, observationAppended: false });
    expect(replay.receiptJson).toBe(first.receiptJson);
    expect(replay.observationJson).toBe(first.observationJson);
    expect(JSON.parse(replay.receiptJson).acceptedAt).toBe("2026-08-05T16:20:01.000Z");

    const receipt = await t.query(receiptRef, {
      serviceSecret,
      workspace: "test",
      project: "stensibly",
      deliveryId: "delivery_1149_1",
    }) as any;
    expect(receipt.receiptJson).toBe(first.receiptJson);
  });

  test("deduplicates one semantic observation under a new delivery", async () => {
    const t = convexTest(schema, modules);
    const first = await ingest(t);
    const second = await ingest(t, ingestion({
      deliveryId: "delivery_1149_2",
      deliveryFingerprint: `sha256:${"e".repeat(64)}`,
      acceptedAt: "2026-08-05T16:21:00.000Z",
    }));
    expect(second).toMatchObject({ replayed: false, observationAppended: false });
    expect(second.observationJson).toBe(first.observationJson);
    expect(second.receiptJson).not.toBe(first.receiptJson);

    const listed = await t.query(listRef, {
      serviceSecret,
      workspace: "test",
      project: "stensibly",
      limit: 32,
    }) as any;
    expect(listed.truncated).toBe(false);
    expect(listed.observations).toHaveLength(1);
    expect(listed.observations[0].appendOrder).toBe(1);
  });

  test("rejects changed delivery and changed source identity", async () => {
    const t = convexTest(schema, modules);
    await ingest(t);
    await expect(ingest(t, ingestion({
      deliveryFingerprint: `sha256:${"f".repeat(64)}`,
    }))).rejects.toThrow("delivery identity conflict");
    await expect(ingest(t, ingestion({
      deliveryId: "delivery_1149_2",
      deliveryFingerprint: `sha256:${"1".repeat(64)}`,
      observation: observation({
        activityState: "failed",
        providerLifecycle: "rejected",
      }),
    }))).rejects.toThrow("source identity conflict");
  });

  test("preserves first-ingestion order when older evidence arrives later", async () => {
    const t = convexTest(schema, modules);
    const newer = ingestion({
      deliveryId: "delivery_newer",
      deliveryFingerprint: `sha256:${"2".repeat(64)}`,
      acceptedAt: "2026-08-05T16:31:00.000Z",
      observation: observation({
        sourceId: "source_newer",
        sourceFingerprint: `sha256:${"3".repeat(64)}`,
        observedAt: "2026-08-05T16:30:00.000Z",
      }),
    });
    const older = ingestion({
      deliveryId: "delivery_older",
      deliveryFingerprint: `sha256:${"4".repeat(64)}`,
      acceptedAt: "2026-08-05T16:32:00.000Z",
      observation: observation({
        sourceId: "source_older",
        sourceFingerprint: `sha256:${"5".repeat(64)}`,
        observedAt: "2026-08-05T16:10:00.000Z",
      }),
    });
    await ingest(t, newer);
    await ingest(t, older);

    const listed = await t.query(listRef, {
      serviceSecret,
      workspace: "test",
      project: "stensibly",
      limit: 32,
    }) as any;
    expect(listed.observations.map((row: any) => ({
      appendOrder: row.appendOrder,
      sourceId: JSON.parse(row.observationJson).sourceId,
      observedAt: JSON.parse(row.observationJson).observedAt,
    }))).toEqual([
      { appendOrder: 1, sourceId: "source_newer", observedAt: "2026-08-05T16:30:00.000Z" },
      { appendOrder: 2, sourceId: "source_older", observedAt: "2026-08-05T16:10:00.000Z" },
    ]);
  });

  test("scopes the same delivery identity independently by project", async () => {
    const t = convexTest(schema, modules);
    const first = await ingest(t);
    const second = await ingest(t, ingestion({
      deliveryFingerprint: `sha256:${"6".repeat(64)}`,
      observation: observation({ project: "other-project" }),
    }));
    expect(JSON.parse(first.receiptJson).project).toBe("stensibly");
    expect(JSON.parse(second.receiptJson).project).toBe("other-project");

    const stensibly = await t.query(listRef, {
      serviceSecret,
      workspace: "test",
      project: "stensibly",
      limit: 32,
    }) as any;
    const other = await t.query(listRef, {
      serviceSecret,
      workspace: "test",
      project: "other-project",
      limit: 32,
    }) as any;
    expect(stensibly.observations).toHaveLength(1);
    expect(other.observations).toHaveLength(1);
  });

  test("fails closed when stored receipt bytes are corrupted", async () => {
    const t = convexTest(schema, modules);
    await ingest(t);
    await t.run(async (ctx: any) => {
      const row = await ctx.db.query("orchestratorActivityDeliveries").first();
      if (!row) throw new Error("missing delivery fixture");
      await ctx.db.patch(row._id, { receiptJson: "{}" });
    });
    await expect(t.query(receiptRef, {
      serviceSecret,
      workspace: "test",
      project: "stensibly",
      deliveryId: "delivery_1149_1",
    })).rejects.toThrow(/receipt|delivery/i);
  });
});
