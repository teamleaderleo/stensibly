import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "provider-capacity-service-secret";
const ingestRef = makeFunctionReference<"mutation">("providerCapacities:ingestCodeRabbit");
const latestRef = makeFunctionReference<"query">("providerCapacities:latestCodeRabbit");

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("hosted provider capacity observations", () => {
  test("deduplicates deliveries and preserves the newest provider observation", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const first = input({
      deliveryId: "delivery-first",
      payloadDigest: "a".repeat(64),
      observedAt: Date.parse("2026-07-28T13:00:00.000Z"),
      receivedAt: Date.parse("2026-07-28T13:00:01.000Z"),
    });
    const inserted = await t.mutation(ingestRef, first) as any;
    expect(inserted).toMatchObject({
      duplicate: false,
      observation: {
        state: "available",
        remaining: null,
        limit: null,
        repository: "teamleaderleo/stensibly",
      },
    });
    expect(await t.mutation(ingestRef, first)).toMatchObject({
      duplicate: true,
      observation: { id: inserted.observation.id },
    });
    await expect(t.mutation(ingestRef, {
      ...first,
      payloadDigest: "b".repeat(64),
    })).rejects.toThrow("PROVIDER_CAPACITY_DELIVERY_CONFLICT");

    await t.mutation(ingestRef, input({
      deliveryId: "delivery-newer",
      payloadDigest: "c".repeat(64),
      providerState: "unavailable",
      remaining: 0,
      quotaLimit: 1,
      refillAt: Date.parse("2026-07-28T14:00:00.000Z"),
      observedAt: Date.parse("2026-07-28T13:05:00.000Z"),
      receivedAt: Date.parse("2026-07-28T13:05:01.000Z"),
    }));
    await t.mutation(ingestRef, input({
      deliveryId: "delivery-late-old",
      payloadDigest: "d".repeat(64),
      observedAt: Date.parse("2026-07-28T13:02:00.000Z"),
      receivedAt: Date.parse("2026-07-28T13:06:00.000Z"),
    }));

    expect(await t.query(latestRef, queryArgs())).toMatchObject({
      state: "unavailable",
      remaining: 0,
      limit: 1,
      observedAt: Date.parse("2026-07-28T13:05:00.000Z"),
    });
  });

  test("reuses one logical observation across delivery aliases without raw prose", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const first = input({
      deliveryId: "delivery-primary",
      payloadDigest: "e".repeat(64),
    });
    const inserted = await t.mutation(ingestRef, first) as any;
    const replay = await t.mutation(ingestRef, {
      ...first,
      deliveryId: "delivery-alias",
    }) as any;
    expect(replay).toMatchObject({
      duplicate: true,
      observation: { id: inserted.observation.id },
    });
    expect(JSON.stringify(replay)).not.toContain("Reviews are available now");
    expect(JSON.stringify(replay)).not.toContain("commentBody");
  });

  test("accepts a bounded bot pull-request author proxy", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const inserted = await t.mutation(ingestRef, input({
      deliveryId: "delivery-bot-subject",
      payloadDigest: "9".repeat(64),
      subjectLogin: "dependabot[bot]",
    })) as any;
    expect(inserted).toMatchObject({
      duplicate: false,
      observation: { subjectLogin: "dependabot[bot]" },
    });
    expect(await t.query(latestRef, {
      ...queryArgs(),
      subjectLogin: "dependabot[bot]",
    })).toMatchObject({
      subjectLogin: "dependabot[bot]",
      subjectBasis: "pull_request_author_proxy",
    });
  });

  test("requires the service boundary", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    await expect(t.mutation(ingestRef, {
      ...input(),
      serviceSecret: "wrong",
    })).rejects.toThrow("Unauthorized");
  });
});

function input(overrides: Record<string, unknown> = {}) {
  return {
    serviceSecret,
    workspace: "test",
    deliveryId: "delivery-default",
    payloadDigest: "f".repeat(64),
    sourceCommentId: "5104466293",
    repository: "teamleaderleo/stensibly",
    pullRequestNumber: 421,
    subjectLogin: "teamleaderleo",
    providerState: "available",
    remaining: null,
    quotaLimit: null,
    refillAt: null,
    observedAt: Date.parse("2026-07-28T13:00:00.000Z"),
    receivedAt: Date.parse("2026-07-28T13:00:01.000Z"),
    ...overrides,
  };
}

function queryArgs() {
  return {
    serviceSecret,
    workspace: "test",
    repository: "teamleaderleo/stensibly",
    subjectLogin: "teamleaderleo",
  };
}

async function seedWorkspace(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx: any) => {
    await ctx.db.insert("workspaces", {
      externalId: "ws_test",
      slug: "test",
      name: "Test",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}
