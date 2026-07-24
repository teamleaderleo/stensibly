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
    const item = await createItem(t, "Complete atomically in Convex");
    const input = {
      serviceSecret: secret,
      workspace,
      id: item.id,
      actor: agent,
      summary: "Completed with hosted continuation proposals.",
      continuations: [
        {
          title: "Review the hosted completion",
          rationale: "A human decision should survive the current run.",
          instruction: "Review the completed item and approve the next move.",
          action: { kind: "request_decision" as const, decisionType: "hosted_review" },
          deliveryMode: "current_conversation" as const,
        },
        {
          title: "Track the next hosted slice",
          rationale: "The remaining work deserves its own item.",
          instruction: "Create a separate follow-up item.",
          action: { kind: "create_item" as const, project: "scrapbook" },
          deliveryMode: "supervisor" as const,
        },
      ],
      idempotencyKey: "convex-complete-with-continuations-1",
    };

    const result = await t.mutation(
      convexApi.completionContinuations.complete,
      input,
    ) as any;
    expect(result.item).toMatchObject({
      id: item.id,
      status: "done",
      summary: "Completed with hosted continuation proposals.",
      nextAction: undefined,
      version: item.version + 3,
    });
    expect(result.continuations).toHaveLength(2);
    expect(result.continuations.map((entry: any) => entry.status)).toEqual([
      "proposed",
      "proposed",
    ]);
    expect(await t.mutation(
      convexApi.completionContinuations.complete,
      input,
    )).toEqual(result);

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

    await expect(t.mutation(
      convexApi.completionContinuations.complete,
      { ...input, summary: "A changed replay." },
    )).rejects.toThrow("different completion request");
  });

  test("rejects invalid proposals before changing the item", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t, "Keep hosted work open after validation failure");

    await expect(t.mutation(
      convexApi.completionContinuations.complete,
      {
        serviceSecret: secret,
        workspace,
        id: item.id,
        actor: agent,
        summary: "This must remain uncommitted.",
        continuations: [{
          title: "stn.tok_secret-shaped-content",
          rationale: "Server validation rejects credential-shaped text.",
          instruction: "The item must remain ready.",
          action: { kind: "request_decision", decisionType: "validation_test" },
        }],
        idempotencyKey: "convex-complete-validation-failure",
      },
    )).rejects.toThrow("credential-shaped text");

    const detail = await t.query(convexApi.items.get, {
      serviceSecret: secret,
      workspace,
      id: item.id,
    }) as any;
    expect(detail.item).toMatchObject({
      status: "ready",
      summary: undefined,
      nextAction: "Finish the current unit.",
      version: item.version,
    });
    expect(detail.events.map((event: any) => event.type)).toEqual(["item.created"]);
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
