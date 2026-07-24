import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const actor = { id: "agent-1", name: "Agent One", kind: "agent" as const };

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret);
});

describe("Convex completion parity", () => {
  test("completion preserves or replaces summary, clears next action and lease, and replays once", async () => {
    const t = convexTest(schema, modules);
    const createItem = async (title: string, summary: string, nextAction: string) => await t.mutation(
      convexApi.items.create,
      {
        serviceSecret: secret,
        workspace,
        project: "scrapbook",
        kind: "task",
        title,
        summary,
        nextAction,
        priority: 50,
        actor,
      },
    ) as any;

    const preserved = await createItem("Preserve the final summary", "Original summary", "This must disappear");
    await t.mutation(convexApi.claims.acquire, {
      serviceSecret: secret,
      workspace,
      id: preserved.id,
      actor,
      leaseSeconds: 900,
    });
    const completed = await t.mutation(convexApi.items.complete, {
      serviceSecret: secret,
      workspace,
      id: preserved.id,
      actor,
      idempotencyKey: "complete-preserve",
    }) as any;
    expect(completed).toMatchObject({
      status: "done",
      summary: "Original summary",
      nextAction: null,
      claimedBy: null,
      claimExpiresAt: null,
    });
    const completedVersion = completed.version;
    const replayed = await t.mutation(convexApi.items.complete, {
      serviceSecret: secret,
      workspace,
      id: preserved.id,
      actor,
      idempotencyKey: "complete-preserve",
    }) as any;
    expect(replayed.version).toBe(completedVersion);
    expect(replayed.nextAction).toBeNull();
    const preservedDetail = await t.query(convexApi.items.get, {
      serviceSecret: secret,
      workspace,
      id: preserved.id,
    }) as any;
    expect(preservedDetail.events.filter((event: any) => event.type === "item.completed")).toHaveLength(1);

    const replaced = await createItem("Replace the final summary", "Before completion", "Also disappears");
    const replacedResult = await t.mutation(convexApi.items.complete, {
      serviceSecret: secret,
      workspace,
      id: replaced.id,
      actor,
      summary: "Completed with evidence",
      idempotencyKey: "complete-replace",
    }) as any;
    expect(replacedResult).toMatchObject({
      status: "done",
      summary: "Completed with evidence",
      nextAction: null,
      claimedBy: null,
      claimExpiresAt: null,
    });
  });
});
