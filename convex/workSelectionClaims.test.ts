import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint";
import { compileWorkSelectionRecommendation } from "../src/work-selection-claim";
import { buildWorkerEnrolmentRequest } from "../src/worker-enrolment";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const acceptRef = makeFunctionReference<"mutation">("workSelectionClaims:accept");
const secret = "test-service-secret";
const workspace = "test";
const project = "stensibly";
const sourceFingerprint = fingerprintCanonicalRequest({
  github: "teamleaderleo/stensibly#1525",
  revision: "race-fixture-1",
});

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret));

describe("selected work acceptance and claim", () => {
  test("two workers selecting one snapshot produce exactly one owner and loser can refresh elsewhere", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const a = await enrol(t, "a");
    const b = await enrol(t, "b");
    const first = await createItem(t, "Race target", 100);
    const second = await createItem(t, "Loser fallback", 90);
    const recommendation = recommendationFor(first, "STN-HANDOFF:M7QK");

    const [left, right] = await Promise.all([
      t.mutation(acceptRef, acceptanceInput(a, recommendation, "accept:race:a")),
      t.mutation(acceptRef, acceptanceInput(b, recommendation, "accept:race:b")),
    ]) as any[];
    const results = [left, right];
    const winner = results.find((result) => result.outcome === "accepted");
    const loser = results.find((result) => result.outcome === "rejected");
    expect(winner).toMatchObject({
      outcome: "accepted",
      responsibility: { grantsResponsibility: true, grantsAuthority: false },
      claim: { itemId: first.id, authoritySource: "item_claim" },
      grantsAuthorityFromRecommendation: false,
    });
    expect(loser).toMatchObject({
      outcome: "rejected",
      responsibility: null,
      claim: null,
      requiresRefresh: true,
    });

    let state = await rawState(t);
    expect(state.acceptances).toHaveLength(1);
    expect(state.events.filter((event) => event.type === "responsibility.accepted")).toHaveLength(1);
    expect(state.events.filter((event) => event.type === "claim.created")).toHaveLength(1);
    expect(state.items.find((item) => item.externalId === first.id)).toMatchObject({
      status: "active",
      claimGeneration: 1,
    });

    const losingWorker = left.outcome === "rejected" ? a : b;
    const refreshedSecond = await readItem(t, second.id);
    const nextRecommendation = recommendationFor(refreshedSecond, "STN-HANDOFF:N7QK");
    const reselection = await t.mutation(
      acceptRef,
      acceptanceInput(losingWorker, nextRecommendation, "accept:race:loser:next"),
    ) as any;
    expect(reselection).toMatchObject({ outcome: "accepted", claim: { itemId: second.id } });
    state = await rawState(t);
    expect(state.acceptances).toHaveLength(2);
  });

  test("exact acceptance replay is idempotent and altered replay conflicts", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const worker = await enrol(t, "replay");
    const item = await createItem(t, "Replay target", 80);
    const recommendation = recommendationFor(item, "STN-HANDOFF:M7QK");
    const input = acceptanceInput(worker, recommendation, "accept:replay");

    const accepted = await t.mutation(acceptRef, input) as any;
    expect(await t.mutation(acceptRef, input)).toEqual(accepted);
    await expect(t.mutation(acceptRef, { ...input, leaseSeconds: 301 }))
      .rejects.toThrow("different selected-work acceptance");

    const state = await rawState(t);
    expect(state.acceptances).toHaveLength(1);
    expect(state.commands).toHaveLength(1);
  });

  test("rejects stale item version or generation without responsibility or claim effects", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const worker = await enrol(t, "stale");
    const item = await createItem(t, "Stale target", 80);
    const recommendation = recommendationFor(item, "STN-HANDOFF:M7QK");
    await t.run(async (ctx) => {
      const row = await ctx.db.query("items").filter((q) => q.eq(q.field("externalId"), item.id)).unique();
      if (!row) throw new Error("fixture item missing");
      await ctx.db.patch(row._id, { version: row.version + 1, updatedAt: Date.now() });
    });

    const rejected = await t.mutation(
      acceptRef,
      acceptanceInput(worker, recommendation, "accept:stale"),
    ) as any;
    expect(rejected).toMatchObject({ outcome: "rejected", reason: "work_changed", claim: null });
    const state = await rawState(t);
    expect(state.acceptances).toHaveLength(0);
    expect(state.events.filter((event) => event.type === "claim.created")).toHaveLength(0);
  });

  test("enforces WIP one for this join", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const worker = await enrol(t, "capacity");
    const first = await createItem(t, "First WIP", 90);
    const second = await createItem(t, "Second WIP", 80);
    expect(await t.mutation(
      acceptRef,
      acceptanceInput(worker, recommendationFor(first, "STN-HANDOFF:M7QK"), "accept:wip:first"),
    )).toMatchObject({ outcome: "accepted" });

    const rejected = await t.mutation(
      acceptRef,
      acceptanceInput(worker, recommendationFor(second, "STN-HANDOFF:N7QK"), "accept:wip:second"),
    ) as any;
    expect(rejected).toMatchObject({ outcome: "rejected", reason: "capacity_full", claim: null });
    expect((await rawState(t)).acceptances).toHaveLength(1);
  });

  test("preserves review independence and prevents concurrent implementation/review phases", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const implementer = await enrol(t, "implementer");
    const reviewer = await enrol(t, "reviewer");
    const implementationItem = await createItem(t, "Implement candidate", 95);
    const reviewItem = await createItem(t, "Review candidate", 95);
    const laterReviewItem = await createItem(t, "Later independent review", 90);
    const key = "github:teamleaderleo/stensibly:pr:1525:head:abc";

    const implementation = await t.mutation(acceptRef, acceptanceInput(
      implementer,
      recommendationFor(implementationItem, "STN-HANDOFF:M7QK", "implementation", key),
      "accept:implementation",
    )) as any;
    expect(implementation.outcome).toBe("accepted");

    const overlappingReview = await t.mutation(acceptRef, acceptanceInput(
      reviewer,
      recommendationFor(reviewItem, "STN-REVIEW:R7MK", "independent_review", key),
      "accept:review:overlap",
    )) as any;
    expect(overlappingReview).toMatchObject({ outcome: "rejected", reason: "phase_overlap" });

    await t.mutation(convexApi.claims.release, {
      serviceSecret: secret,
      workspace,
      id: implementationItem.id,
      actor: actorFor(implementer),
      expectedClaimGeneration: implementation.claim.claimGeneration,
      idempotencyKey: "release:implementation",
    });
    const refreshedReview = await readItem(t, reviewItem.id);
    expect(await t.mutation(acceptRef, acceptanceInput(
      reviewer,
      recommendationFor(refreshedReview, "STN-REVIEW:R7MK", "independent_review", key),
      "accept:review:after-release",
    ))).toMatchObject({ outcome: "accepted" });

    const sameWorkerReview = await t.mutation(acceptRef, acceptanceInput(
      implementer,
      recommendationFor(laterReviewItem, "STN-REVIEW:Q7MK", "independent_review", key),
      "accept:review:self",
    )) as any;
    expect(sameWorkerReview).toMatchObject({ outcome: "rejected", reason: "review_independence" });
  });

  test("rejects unavailable work and inactive workers before claim effects", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const worker = await enrol(t, "inactive");
    const item = await createItem(t, "Unavailable target", 80);
    const recommendation = recommendationFor(item, "STN-HANDOFF:M7QK");
    await t.run(async (ctx) => {
      const row = await ctx.db.query("items").filter((q) => q.eq(q.field("externalId"), item.id)).unique();
      if (!row) throw new Error("fixture item missing");
      await ctx.db.patch(row._id, { status: "blocked", version: row.version + 1, updatedAt: Date.now() });
    });
    expect(await t.mutation(acceptRef, acceptanceInput(worker, recommendation, "accept:blocked")))
      .toMatchObject({ outcome: "rejected", reason: "work_unavailable" });

    const activeItem = await createItem(t, "Worker release target", 70);
    await t.mutation(convexApi.workerEnrolments.release, {
      serviceSecret: secret,
      workspace,
      actorId: worker.actorId,
      clientId: worker.clientId,
      workerRef: worker.workerRef,
      idempotencyKey: "worker:release:before-accept",
    });
    expect(await t.mutation(acceptRef, acceptanceInput(
      worker,
      recommendationFor(activeItem, "STN-HANDOFF:N7QK"),
      "accept:released-worker",
    ))).toMatchObject({ outcome: "rejected", reason: "worker_not_active" });

    expect((await rawState(t)).acceptances).toHaveLength(0);
  });
});

async function seedWorkspace(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    const now = Date.now();
    const workspaceId = await ctx.db.insert("workspaces", {
      externalId: "ws_test",
      slug: workspace,
      name: "Test",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("projects", {
      workspaceId,
      externalId: "project_test_stensibly",
      slug: project,
      name: "Stensibly",
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function enrol(t: ReturnType<typeof convexTest>, suffix: string) {
  const actorId = `api-token:worker_${suffix}`;
  const clientId = `mcp:${actorId}`;
  const now = Date.now();
  const request = buildWorkerEnrolmentRequest({
    adapter: "chatgpt",
    profile: "generalist",
    workerSessionId: `chatgpt.${suffix}`,
    capabilities: ["coordination", "github", "review"],
    toolAllowlist: ["github", "gmail"],
    projectScope: [project],
    preferredStances: ["review"],
    startedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 2 * 60 * 60 * 1_000).toISOString(),
    heartbeatSeconds: 300,
  });
  const result = await t.mutation(convexApi.workerEnrolments.enrol, {
    serviceSecret: secret,
    workspace,
    actorId,
    clientId,
    request,
    idempotencyKey: `enrol:${suffix}`,
  }) as any;
  expect(result.outcome).toBe("accepted");
  return { actorId, clientId, workerRef: result.worker.workerRef };
}

async function createItem(t: ReturnType<typeof convexTest>, title: string, priority: number) {
  return await t.mutation(convexApi.items.create, {
    serviceSecret: secret,
    workspace,
    project,
    kind: "task",
    title,
    nextAction: `Continue ${title}`,
    priority,
    idempotencyKey: `item:${title}`,
  }) as any;
}

async function readItem(t: ReturnType<typeof convexTest>, id: string) {
  const result = await t.query(convexApi.items.get, {
    serviceSecret: secret,
    workspace,
    id,
  }) as any;
  return result.item;
}

function recommendationFor(
  item: any,
  selectedHandle: string,
  responsibilityRole: "general" | "implementation" | "independent_review" = "general",
  independenceKey: string | null = null,
) {
  return compileWorkSelectionRecommendation({
    selectedHandle,
    item,
    sourceFingerprint,
    responsibilityRole,
    independenceKey,
  });
}

function acceptanceInput(worker: any, recommendation: any, idempotencyKey: string) {
  return {
    serviceSecret: secret,
    workspace,
    actorId: worker.actorId,
    clientId: worker.clientId,
    workerRef: worker.workerRef,
    recommendation,
    leaseSeconds: 300,
    idempotencyKey,
  };
}

function actorFor(worker: any) {
  return { id: worker.actorId, name: worker.workerRef, kind: "agent" as const };
}

async function rawState(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ({
    items: await ctx.db.query("items").collect(),
    events: await ctx.db.query("events").collect(),
    acceptances: await ctx.db.query("workSelectionAcceptances").collect(),
    commands: await ctx.db.query("workSelectionCommands").collect(),
  }));
}
