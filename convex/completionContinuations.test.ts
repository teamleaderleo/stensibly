import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const agent = { id: "agent", name: "Agent", kind: "agent" as const };

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret);
});

describe("Convex atomic completion continuations", () => {
  test("completes and proposes follow-ups exactly once", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t, "Hosted atomic completion");
    const input = {
      serviceSecret: secret,
      workspace,
      id: item.id,
      actor: agent,
      summary: "The hosted implementation is complete.",
      continuations: [
        {
          title: "Review the hosted implementation",
          rationale: "A human decision should survive this mutation.",
          instruction: "Review the completed work and record a decision.",
          action: { kind: "request_decision" as const, decisionType: "merge_review" },
          deliveryMode: "current_conversation" as const,
        },
        {
          title: "Track the remaining polish",
          rationale: "The adjacent polish belongs in a separate item.",
          instruction: "Create a follow-up task for the remaining polish.",
          action: { kind: "create_item" as const, project: "scrapbook" },
          deliveryMode: "supervisor" as const,
        },
      ],
      idempotencyKey: "hosted-complete-continuations-1",
    };

    const result = await t.mutation(
      convexApi.completionContinuations.complete,
      input,
    ) as any;
    expect(result.item).toMatchObject({
      id: item.id,
      status: "done",
      summary: input.summary,
      nextAction: null,
      claimedBy: null,
      version: item.version + 3,
    });
    expect(result.continuations).toHaveLength(2);
    expect(result.continuations.map((entry: any) => ({
      sourceItemId: entry.sourceItemId,
      status: entry.status,
      deliveryMode: entry.deliveryMode,
    }))).toEqual([
      {
        sourceItemId: item.id,
        status: "proposed",
        deliveryMode: "current_conversation",
      },
      {
        sourceItemId: item.id,
        status: "proposed",
        deliveryMode: "supervisor",
      },
    ]);
    expect(await t.mutation(convexApi.completionContinuations.complete, input)).toEqual(result);

    await expect(t.mutation(convexApi.completionContinuations.complete, {
      ...input,
      summary: "A changed replay.",
    })).rejects.toThrow("different completion request");

    const detail = await t.query(convexApi.items.get, {
      serviceSecret: secret,
      workspace,
      id: item.id,
    }) as any;
    expect(detail.events.map((event: any) => event.type)).toEqual([
      "item.created",
      "item.completed",
      "continuation.proposed",
      "continuation.proposed",
    ]);
  });

  test("rolls back completion and proposals when validation fails", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t, "Hosted rollback source");

    await expect(t.mutation(convexApi.completionContinuations.complete, {
      serviceSecret: secret,
      workspace,
      id: item.id,
      actor: agent,
      summary: "This must remain invisible.",
      continuations: [
        {
          title: "A valid first proposal",
          rationale: "This would otherwise be inserted.",
          instruction: "Create a tracked follow-up.",
          action: { kind: "create_item", project: "scrapbook" },
        },
        {
          title: "stn.tok_secret-shaped-content",
          rationale: "Server-owned validation rejects this draft.",
          instruction: "The whole mutation must roll back.",
          action: { kind: "request_decision", decisionType: "rollback_test" },
        },
      ],
      idempotencyKey: "hosted-complete-continuations-rollback",
    })).rejects.toThrow("credential-shaped text");

    const detail = await t.query(convexApi.items.get, {
      serviceSecret: secret,
      workspace,
      id: item.id,
    }) as any;
    expect(detail.item).toMatchObject({
      status: "ready",
      summary: null,
      nextAction: "Finish the current unit.",
      version: item.version,
    });
    expect(detail.events.map((event: any) => event.type)).toEqual(["item.created"]);
    expect(await t.mutation(convexApi.continuations.list, {
      serviceSecret: secret,
      workspace,
      sourceItemId: item.id,
    })).toEqual([]);
  });

  test("rejects idempotency keys owned by another operation", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t, "Hosted idempotency collision");
    await t.mutation(convexApi.events.record, {
      serviceSecret: secret,
      workspace,
      id: item.id,
      actor: agent,
      type: "progress.recorded",
      payload: { summary: "Existing operation" },
      idempotencyKey: "shared-operation-key",
    });

    await expect(t.mutation(convexApi.completionContinuations.complete, {
      serviceSecret: secret,
      workspace,
      id: item.id,
      actor: agent,
      continuations: [],
      idempotencyKey: "shared-operation-key",
    })).rejects.toThrow("another operation");
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
