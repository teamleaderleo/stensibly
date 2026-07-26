import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const actor = { id: "agent", name: "Agent", kind: "agent" as const };

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret);
});

describe("hosted semantic transition replay identity", () => {
  test("handoff replay requires the exact actor generation and payload", async () => {
    const t = convexTest(schema, modules);
    const item = await t.mutation(convexApi.items.create, {
      serviceSecret: secret,
      workspace,
      project: "scrapbook",
      kind: "task",
      title: "Fence hosted handoff replay",
      priority: 50,
      actor,
    }) as any;
    const request = {
      serviceSecret: secret,
      workspace,
      id: item.id,
      actor,
      expectedClaimGeneration: item.claimGeneration,
      summary: "Ready for the next actor.",
      nextAction: "Review the result.",
      idempotencyKey: "hosted-handoff-exact-replay",
    };

    const first = await t.mutation(convexApi.items.handoff, request) as any;
    expect(await t.mutation(convexApi.items.handoff, request)).toEqual(first);
    await expect(t.mutation(convexApi.items.handoff, {
      ...request,
      nextAction: "Changed replay.",
    })).rejects.toThrow("different semantic transition request");
    await expect(t.mutation(convexApi.items.handoff, {
      ...request,
      expectedClaimGeneration: first.claimGeneration,
    })).rejects.toThrow("different semantic transition request");
    await expect(t.mutation(convexApi.items.handoff, {
      ...request,
      actor: { id: "other", name: "Other", kind: "agent" },
    })).rejects.toThrow("different semantic transition request");
  });
});
