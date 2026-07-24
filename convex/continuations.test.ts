import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const agent = { id: "agent", name: "Agent", kind: "agent" as const };
const leo = { id: "leo", name: "Leo", kind: "human" as const };

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret);
});

describe("Convex continuations", () => {
  test("proposes, approves, consumes, and replays exactly", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t, "Hosted continuation source");
    const proposalInput = {
      serviceSecret: secret,
      workspace,
      sourceItemId: item.id,
      title: "Review the hosted result",
      rationale: "A human decision should outlive the current run.",
      instruction: "Review the evidence and continue in the current conversation.",
      action: { kind: "request_decision" as const, decisionType: "review_result" },
      evidence: [{ kind: "commit", label: "Implementation", uri: "git:repo@abc" }],
      actor: agent,
      approvalMode: "human" as const,
      deliveryMode: "current_conversation" as const,
      idempotencyKey: "convex-proposal-1",
    };

    const proposed = await t.mutation(convexApi.continuations.propose, proposalInput) as any;
    expect(proposed).toMatchObject({
      sourceItemId: item.id,
      status: "proposed",
      generation: 1,
      suggestedBy: agent.id,
      result: null,
      consumedAt: null,
    });
    expect(await t.mutation(convexApi.continuations.propose, proposalInput)).toEqual(proposed);

    const listed = await t.mutation(convexApi.continuations.list, {
      serviceSecret: secret,
      workspace,
      sourceItemId: item.id,
      status: "proposed",
    }) as any[];
    expect(listed.map((entry) => entry.id)).toEqual([proposed.id]);

    const approvedInput = {
      serviceSecret: secret,
      workspace,
      id: proposed.id,
      actor: leo,
      command: "approve" as const,
      expectedGeneration: 1,
      note: "Continue here.",
      idempotencyKey: "convex-approve-1",
    };
    const approved = await t.mutation(convexApi.continuations.resolve, approvedInput) as any;
    expect(approved).toMatchObject({
      status: "approved",
      generation: 2,
      resolutionActorId: leo.id,
      resolutionNote: "Continue here.",
    });
    expect(await t.mutation(convexApi.continuations.resolve, approvedInput)).toEqual(approved);

    await expect(t.mutation(convexApi.continuations.resolve, {
      serviceSecret: secret,
      workspace,
      id: proposed.id,
      actor: agent,
      command: "consume",
      expectedGeneration: 1,
      result: { decisionId: "decision_stale" },
    })).rejects.toThrow("generation changed");

    const consumedInput = {
      serviceSecret: secret,
      workspace,
      id: proposed.id,
      actor: agent,
      command: "consume" as const,
      expectedGeneration: 2,
      result: {
        decisionId: "decision_hosted_review",
        conversationRef: "chatgpt:conversation:hosted-review",
      },
      idempotencyKey: "convex-consume-1",
    };
    const consumed = await t.mutation(convexApi.continuations.resolve, consumedInput) as any;
    expect(consumed).toMatchObject({
      status: "consumed",
      generation: 3,
      result: consumedInput.result,
      resolutionActorId: agent.id,
    });
    expect(consumed.consumedAt).toEqual(expect.any(String));
    expect(await t.mutation(convexApi.continuations.resolve, consumedInput)).toEqual(consumed);

    const detail = await t.query(convexApi.items.get, {
      serviceSecret: secret,
      workspace,
      id: item.id,
    }) as any;
    expect(detail.item.version).toBe(item.version + 3);
    expect(detail.events.map((event: any) => event.type)).toEqual(expect.arrayContaining([
      "continuation.proposed",
      "continuation.approved",
      "continuation.consumed",
    ]));
  });

  test("validates consumption results and expires once", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t, "Hosted expiry source");
    const created = await t.mutation(convexApi.continuations.propose, {
      serviceSecret: secret,
      workspace,
      sourceItemId: item.id,
      title: "Create the follow-up",
      rationale: "The next unit should be tracked separately.",
      instruction: "Create the item and return its durable id.",
      action: { kind: "create_item", project: "scrapbook" },
      actor: agent,
    }) as any;
    const approved = await t.mutation(convexApi.continuations.resolve, {
      serviceSecret: secret,
      workspace,
      id: created.id,
      actor: leo,
      command: "approve",
      expectedGeneration: 1,
    }) as any;
    await expect(t.mutation(convexApi.continuations.resolve, {
      serviceSecret: secret,
      workspace,
      id: created.id,
      actor: agent,
      command: "consume",
      expectedGeneration: approved.generation,
      result: { runId: "run_wrong_kind" },
    })).rejects.toThrow("requires a result item ID");

    const expiring = await t.mutation(convexApi.continuations.propose, {
      serviceSecret: secret,
      workspace,
      sourceItemId: item.id,
      title: "Time-sensitive approval",
      rationale: "The external decision window has closed.",
      instruction: "Approve only before expiry.",
      action: { kind: "request_decision", decisionType: "release_window" },
      actor: agent,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    }) as any;
    const expired = await t.mutation(convexApi.continuations.get, {
      serviceSecret: secret,
      workspace,
      id: expiring.id,
    }) as any;
    expect(expired).toMatchObject({ status: "expired", generation: 2 });
    expect(await t.mutation(convexApi.continuations.get, {
      serviceSecret: secret,
      workspace,
      id: expiring.id,
    })).toEqual(expired);

    const detail = await t.query(convexApi.items.get, {
      serviceSecret: secret,
      workspace,
      id: item.id,
    }) as any;
    expect(detail.events.filter((event: any) => event.type === "continuation.expired")).toHaveLength(1);
  });
});

async function createItem(t: ReturnType<typeof convexTest>, title: string) {
  return await t.mutation(convexApi.items.create, {
    serviceSecret: secret,
    workspace,
    project: "scrapbook",
    kind: "task",
    title,
    nextAction: "Finish the current unit.",
    priority: 60,
    actor: agent,
  }) as any;
}
