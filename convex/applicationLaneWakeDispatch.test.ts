import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildApplicationWorkBindingV1 } from "../src/application-lane-binding";
import {
  canonicalApplicationWorkBindingInputJson,
} from "../src/application-lane-binding-store";
import {
  compileApplicationLaneWakeIntentV1,
  parseApplicationLaneWakeIntentV1,
} from "../src/application-lane-wake-intent";
import { applicationLaneWakeToDispatchTriggerV1 } from "../src/dispatch-trigger";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "application-lane-wake-service-secret";
const workspace = "default";
const project = "stensibly";
const bindRef = makeFunctionReference<"mutation">("applicationLaneBindings:bind");
const retireRef = makeFunctionReference<"mutation">("applicationLaneBindings:retire");
const recordWakeRef = makeFunctionReference<"mutation">("applicationLaneWakeDispatch:recordWake");
const consumeRef = makeFunctionReference<"mutation">("applicationLaneWakeDispatch:consume");
const acquireRef = makeFunctionReference<"mutation">("claims:acquire");
const releaseRef = makeFunctionReference<"mutation">("claims:release");

const supervisor = {
  id: "service:hosted-application-wake",
  name: "Hosted Application Wake",
  kind: "service" as const,
};

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret));

describe("hosted application-lane wake admission and trigger consumption", () => {
  test("persists a compiler-admitted wake and exact replay survives later movement", async () => {
    const t = convexTest(schema, modules);
    const fixture = await setup(t, "replay");
    const firstJson = await record(t, fixture);
    const first = parseApplicationLaneWakeIntentV1(JSON.parse(firstJson));

    const claimed = await t.mutation(acquireRef, claimArgs({
      id: fixture.itemId,
      actor: supervisor,
      leaseSeconds: 900,
    })) as any;
    await t.mutation(releaseRef, claimArgs({
      id: fixture.itemId,
      actor: supervisor,
      expectedClaimGeneration: claimed.claimGeneration,
    }));
    await retire(t, fixture, "retire-after-wake-admission");

    expect(await record(t, fixture)).toBe(firstJson);
    const rows = await t.run(async (ctx: any) => await ctx.db.query("applicationLaneWakeIntents").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceRef: first.idempotencyKey,
      wakeFingerprint: first.fingerprint,
      claimGeneration: 0,
      bindingId: fixture.binding.id,
      bindingGeneration: 1,
    });
  });

  test("consumes generation zero exactly once through the shared hosted dispatcher", async () => {
    const t = convexTest(schema, modules);
    const fixture = await setup(t, "consume");
    const wake = parseApplicationLaneWakeIntentV1(JSON.parse(await record(t, fixture)));
    const trigger = applicationLaneWakeToDispatchTriggerV1(wake);

    const first = await consume(t, trigger) as any;
    expect(first).toMatchObject({
      status: "consumed",
      replay: false,
      receipt: {
        triggerFingerprint: trigger.fingerprint,
        triggerIdempotencyKey: trigger.idempotencyKey,
        itemId: fixture.itemId,
        expectedClaimGeneration: 0,
        claimedGeneration: 1,
        sourceRef: wake.idempotencyKey,
        sourceFingerprint: wake.fingerprint,
        grantsAuthority: false,
        authorizesFurtherDispatch: false,
      },
    });
    expect(await itemState(t, fixture.itemId)).toMatchObject({
      status: "active",
      claimGeneration: 1,
      claimedByExternalId: supervisor.id,
    });
    expect(await queuedRunCount(t, fixture.itemId)).toBe(1);

    await retire(t, fixture, "retire-after-trigger-consumption");
    const replay = await consume(t, trigger) as any;
    expect(replay).toEqual({ status: "consumed", replay: true, receipt: first.receipt });
    expect(await queuedRunCount(t, fixture.itemId)).toBe(1);
  });

  test("old wake cannot consume a later ready work generation", async () => {
    const t = convexTest(schema, modules);
    const fixture = await setup(t, "stale-generation");
    const wake = parseApplicationLaneWakeIntentV1(JSON.parse(await record(t, fixture)));
    const trigger = applicationLaneWakeToDispatchTriggerV1(wake);

    const claimed = await t.mutation(acquireRef, claimArgs({
      id: fixture.itemId,
      actor: supervisor,
      leaseSeconds: 900,
    })) as any;
    await t.mutation(releaseRef, claimArgs({
      id: fixture.itemId,
      actor: supervisor,
      expectedClaimGeneration: claimed.claimGeneration,
    }));
    expect(await itemState(t, fixture.itemId)).toMatchObject({ status: "ready", claimGeneration: 2 });

    expect(await consume(t, trigger)).toEqual({
      status: "stale_generation",
      triggerFingerprint: trigger.fingerprint,
      expectedClaimGeneration: 0,
      currentClaimGeneration: 2,
    });
    expect(await queuedRunCount(t, fixture.itemId)).toBe(0);
  });

  test("retired binding makes an unconsumed wake stale", async () => {
    const t = convexTest(schema, modules);
    const fixture = await setup(t, "stale-binding");
    const wake = parseApplicationLaneWakeIntentV1(JSON.parse(await record(t, fixture)));
    const trigger = applicationLaneWakeToDispatchTriggerV1(wake);
    await retire(t, fixture, "retire-before-trigger-consumption");

    expect(await consume(t, trigger)).toEqual({
      status: "stale_source",
      triggerFingerprint: trigger.fingerprint,
    });
    expect(await queuedRunCount(t, fixture.itemId)).toBe(0);
  });

  test("self-consistent trigger without durable wake evidence stays stale", async () => {
    const t = convexTest(schema, modules);
    const fixture = await setup(t, "missing-source");
    const decision = compileApplicationLaneWakeIntentV1(
      fixture.registration,
      fixture.binding,
      { project, itemId: fixture.itemId, claimGeneration: 0 },
      fixture.event,
    );
    if (!decision.wakeIntent) throw new Error("fixture did not compile");
    const trigger = applicationLaneWakeToDispatchTriggerV1(decision.wakeIntent);

    expect(await consume(t, trigger)).toEqual({
      status: "stale_source",
      triggerFingerprint: trigger.fingerprint,
    });
    expect(await queuedRunCount(t, fixture.itemId)).toBe(0);
  });

  test("stored wake and receipt corruption fail closed", async () => {
    const wakeTest = convexTest(schema, modules);
    const wakeFixture = await setup(wakeTest, "wake-corruption");
    const wake = parseApplicationLaneWakeIntentV1(JSON.parse(await record(wakeTest, wakeFixture)));
    await wakeTest.run(async (ctx: any) => {
      const row = (await ctx.db.query("applicationLaneWakeIntents").collect())[0];
      await ctx.db.patch(row._id, { wakeFingerprint: `sha256:${"f".repeat(64)}` });
    });
    await expect(record(wakeTest, wakeFixture)).rejects.toThrow("APPLICATION_LANE_WAKE_STORAGE_CORRUPT");

    const receiptTest = convexTest(schema, modules);
    const receiptFixture = await setup(receiptTest, "receipt-corruption");
    const receiptWake = parseApplicationLaneWakeIntentV1(JSON.parse(await record(receiptTest, receiptFixture)));
    const trigger = applicationLaneWakeToDispatchTriggerV1(receiptWake);
    expect((await consume(receiptTest, trigger) as any).status).toBe("consumed");
    await receiptTest.run(async (ctx: any) => {
      const row = (await ctx.db.query("applicationLaneTriggerConsumptions").collect())[0];
      await ctx.db.patch(row._id, { receiptFingerprint: `sha256:${"e".repeat(64)}` });
    });
    await expect(consume(receiptTest, trigger)).rejects.toThrow(
      "APPLICATION_LANE_TRIGGER_RECEIPT_CORRUPT",
    );
  });
});

async function setup(t: ReturnType<typeof convexTest>, suffix: string) {
  const itemId = `item_hosted_application_${suffix}`;
  await seedProjectItem(t, itemId);
  const binding = buildApplicationWorkBindingV1({
    version: 1,
    id: `binding:hosted:${suffix}`,
    generation: 1,
    project,
    itemId,
    provider: "elatura",
    laneRef: `elatura:hosted:${suffix}`,
    laneGeneration: 1,
    capabilities: ["events", "observe", "activate", "screenshot"],
    createdAt: "2026-08-26T19:00:00.000Z",
    retiredAt: null,
  });
  await t.mutation(bindRef, serviceArgs({
    project,
    bindingJson: canonicalApplicationWorkBindingInputJson(binding),
    idempotencyKey: `bind-hosted-${suffix}`,
  }));
  const registration = {
    version: 1,
    id: `wake-registration:hosted:${suffix}`,
    generation: 1,
    project,
    itemId,
    claimGeneration: 0,
    bindingId: binding.id,
    bindingGeneration: 1,
    laneRef: binding.laneRef,
    laneGeneration: 1,
    eventTypes: ["changed", "possible_completion"],
    createdAt: "2026-08-26T19:30:00.000Z",
    expiresAt: null,
  };
  const event = {
    version: 1,
    eventId: `lane-event:hosted:${suffix}`,
    laneRef: binding.laneRef,
    laneGeneration: 1,
    eventType: "changed",
    observedAt: "2026-08-26T20:00:00.000Z",
    confidence: "exact",
    freshness: "fresh",
    sourceRefs: [`source:hosted:${suffix}`],
    grantsWorkAuthority: false,
    authorizesWorkDispatch: false,
  };
  return { itemId, binding, registration, event };
}

async function record(t: ReturnType<typeof convexTest>, fixture: Awaited<ReturnType<typeof setup>>) {
  return await t.mutation(recordWakeRef, serviceArgs({
    project,
    registrationJson: JSON.stringify(fixture.registration),
    eventJson: JSON.stringify(fixture.event),
  })) as string;
}

async function consume(t: ReturnType<typeof convexTest>, trigger: unknown) {
  return await t.mutation(consumeRef, serviceArgs({
    project,
    triggerJson: JSON.stringify(trigger),
    actor: supervisor,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    leaseSeconds: 900,
    maxAttempts: 3,
    retryBackoffSeconds: 60,
  }));
}

async function retire(
  t: ReturnType<typeof convexTest>,
  fixture: Awaited<ReturnType<typeof setup>>,
  idempotencyKey: string,
) {
  return await t.mutation(retireRef, serviceArgs({
    project,
    bindingId: fixture.binding.id,
    expectedGeneration: 1,
    retiredAt: "2026-08-26T20:10:00.000Z",
    idempotencyKey,
  }));
}

function serviceArgs(input: Record<string, unknown>) {
  return { ...input, serviceSecret, workspace };
}

function claimArgs(input: Record<string, unknown>) {
  return serviceArgs(input);
}

async function seedProjectItem(t: ReturnType<typeof convexTest>, itemExternalId: string) {
  await t.run(async (ctx: any) => {
    const workspaceRow = await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q: any) => q.eq("slug", workspace))
      .unique();
    const workspaceId = workspaceRow?._id ?? await ctx.db.insert("workspaces", {
      externalId: "ws_default",
      slug: workspace,
      name: "Default",
      createdAt: 1,
      updatedAt: 1,
    });
    let projectRow = await ctx.db
      .query("projects")
      .withIndex("by_workspace_slug", (q: any) =>
        q.eq("workspaceId", workspaceId).eq("slug", project)
      )
      .unique();
    if (!projectRow) {
      const projectId = await ctx.db.insert("projects", {
        workspaceId,
        externalId: `project_${project}`,
        slug: project,
        name: project,
        createdAt: 1,
        updatedAt: 1,
      });
      projectRow = await ctx.db.get("projects", projectId);
    }
    await ctx.db.insert("items", {
      workspaceId,
      projectId: projectRow._id,
      externalId: itemExternalId,
      kind: "task",
      title: `Hosted application work ${itemExternalId}`,
      status: "ready",
      priority: 80,
      claimGeneration: 0,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    });
  });
}

async function itemState(t: ReturnType<typeof convexTest>, itemExternalId: string) {
  return await t.run(async (ctx: any) => {
    const workspaceRow = await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q: any) => q.eq("slug", workspace))
      .unique();
    return await ctx.db
      .query("items")
      .withIndex("by_workspace_external", (q: any) =>
        q.eq("workspaceId", workspaceRow._id).eq("externalId", itemExternalId)
      )
      .unique();
  });
}

async function queuedRunCount(t: ReturnType<typeof convexTest>, itemExternalId: string) {
  const item = await itemState(t, itemExternalId);
  return await t.run(async (ctx: any) =>
    (await ctx.db.query("queuedRuns").collect()).filter((run: any) => run.itemId === item._id).length
  );
}
