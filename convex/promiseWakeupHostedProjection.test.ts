import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "promise-wakeup-hosted-projection";
const workspace = "test";
const actor = { id: "agent:hosted", name: "Hosted", kind: "agent" as const };
const now = Date.parse("2026-07-27T00:00:00.000Z");

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret));

describe("hosted promise wakeup projection", () => {
  test("reports an explicit unavailable empty source for legacy and queued runs", async () => {
    const t = convexTest(schema, modules);
    const item = await t.mutation(convexApi.items.create, {
      serviceSecret,
      workspace,
      project: "hosted-wakeups",
      kind: "task",
      title: "Hosted wakeup projection",
      nextAction: "Report no fabricated wakeup identifiers.",
      priority: 50,
      actor,
    }) as any;

    await t.run(async (ctx) => {
      const itemDoc = (await ctx.db.query("items").collect())
        .find((entry) => entry.externalId === item.id);
      const actorDoc = (await ctx.db.query("actors").collect())
        .find((entry) => entry.externalId === actor.id);
      if (!itemDoc || !actorDoc) throw new Error("Hosted projection fixture disappeared");

      await ctx.db.insert("runs", {
        workspaceId: itemDoc.workspaceId,
        projectId: itemDoc.projectId,
        itemId: itemDoc._id,
        externalId: "run_hosted_legacy",
        actorId: actorDoc._id,
        actorExternalId: actorDoc.externalId,
        harness: "generic-mcp",
        status: "running",
        startedAt: now,
        lastHeartbeatAt: now,
      });
      await ctx.db.insert("queuedRuns", {
        workspaceId: itemDoc.workspaceId,
        projectId: itemDoc.projectId,
        itemId: itemDoc._id,
        externalId: "run_hosted_queued",
        actorId: actorDoc._id,
        actorExternalId: actorDoc.externalId,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        status: "running",
        generation: 1,
        leaseGeneration: 1,
        leaseOwnerExternalId: actorDoc.externalId,
        leaseExpiresAt: now + 600_000,
        lastHeartbeatAt: now,
        usage: {},
        retryAttempt: 0,
        maxAttempts: 3,
        retryBackoffSeconds: 60,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
      });
    });

    const legacy = await t.query(convexApi.items.get, {
      serviceSecret,
      workspace,
      id: item.id,
    }) as any;
    expect(legacy.runs).toEqual([
      expect.objectContaining({
        id: "run_hosted_legacy",
        promiseWakeupSource: "hosted_unavailable",
        consumedPromiseWakeupIds: [],
      }),
    ]);

    const canonical = await t.query(convexApi.itemControl.get, {
      serviceSecret,
      workspace,
      id: item.id,
      now,
    }) as any;
    expect(canonical.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "run_hosted_legacy",
        promiseWakeupSource: "hosted_unavailable",
        consumedPromiseWakeupIds: [],
      }),
      expect.objectContaining({
        id: "run_hosted_queued",
        promiseWakeupSource: "hosted_unavailable",
        consumedPromiseWakeupIds: [],
      }),
    ]));
  });
});
