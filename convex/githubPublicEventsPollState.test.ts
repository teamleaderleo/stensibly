import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "github-public-events-poll-state-secret";
const getRef = makeFunctionReference<"query">(
  "githubPublicEventsPollState:get",
);
const putRef = makeFunctionReference<"mutation">(
  "githubPublicEventsPollState:put",
);

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("durable GitHub public Events poll state", () => {
  test("returns null before any poll and persists one upserted row", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    expect(await t.query(getRef, getArgs())).toBeNull();

    const first = await t.mutation(putRef, putArgs()) as any;
    expect(first).toEqual({
      repository: "coreys-quarry/quarry",
      etag: '"etag-1"',
      nextEligibleAt: Date.parse("2026-08-25T11:05:00.000Z"),
      lastPolledAt: Date.parse("2026-08-25T11:00:00.000Z"),
      updatedAt: first.updatedAt,
    });

    const second = await t.mutation(putRef, putArgs({
      etag: '"etag-2"',
      nextEligibleAt: Date.parse("2026-08-25T12:10:00.000Z"),
      lastPolledAt: Date.parse("2026-08-25T12:00:00.000Z"),
    })) as any;
    expect(second.etag).toBe('"etag-2"');

    const read = await t.query(getRef, getArgs()) as any;
    expect(read).toEqual(second);
  });

  test("keeps repositories and workspaces isolated", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    await t.mutation(putRef, putArgs());
    await seedWorkspace(t, "ws_other", "other");

    expect(await t.query(getRef, getArgs({ workspace: "other" }))).toBeNull();
    expect(await t.query(getRef, getArgs({
      repository: "teamleaderleo/stensibly",
    }))).toBeNull();
    await expect(t.mutation(putRef, putArgs({ workspace: "other" })))
      .resolves.toBeTruthy();
    expect(await t.query(getRef, getArgs({ workspace: "other" })))
      .toMatchObject({ repository: "coreys-quarry/quarry" });
  });

  test("requires the service boundary", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    await expect(t.mutation(putRef, {
      ...putArgs(),
      serviceSecret: "wrong",
    })).rejects.toThrow("Unauthorized");
    await expect(t.query(getRef, {
      ...getArgs(),
      serviceSecret: "wrong",
    })).rejects.toThrow("Unauthorized");
  });

  test("rejects malformed repository, ETag, and timing input", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);

    await expect(t.mutation(putRef, putArgs({
      repository: "Coreys-Quarry/quarry",
    }))).rejects.toThrow("GitHub repository is invalid");
    await expect(t.mutation(putRef, putArgs({ etag: "" })))
      .rejects.toThrow("GitHub public Events ETag is invalid");
    await expect(t.mutation(putRef, putArgs({ etag: `"bad\n"` })))
      .rejects.toThrow("GitHub public Events ETag is invalid");
    await expect(t.mutation(putRef, putArgs({
      nextEligibleAt: Date.parse("2026-08-25T11:05:00.000Z") + 0.5,
    }))).rejects.toThrow("next eligibility is invalid");
    await expect(t.mutation(putRef, putArgs({
      lastPolledAt: -1,
    }))).rejects.toThrow("last receipt time is invalid");

    await expect(t.query(getRef, getArgs({
      repository: "Coreys-Quarry/quarry",
    }))).rejects.toThrow("GitHub repository is invalid");
  });
});

function getArgs(overrides: Record<string, unknown> = {}) {
  return {
    serviceSecret,
    workspace: "test",
    repository: "coreys-quarry/quarry",
    ...overrides,
  };
}

function putArgs(overrides: Record<string, unknown> = {}) {
  return {
    ...getArgs(),
    etag: '"etag-1"',
    nextEligibleAt: Date.parse("2026-08-25T11:05:00.000Z"),
    lastPolledAt: Date.parse("2026-08-25T11:00:00.000Z"),
    ...overrides,
  };
}

async function seedWorkspace(
  t: ReturnType<typeof convexTest>,
  externalId = "ws_test",
  slug = "test",
) {
  await t.run(async (ctx: any) => {
    await ctx.db.insert("workspaces", {
      externalId,
      slug,
      name: "Test",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}
