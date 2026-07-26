import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { ConflictError, StensiblyStore } from "../src/store.ts";

const agent = { id: "agent", name: "Agent", kind: "agent" as const };
const leo = { id: "leo", name: "Leo", kind: "human" as const };

let store: StensiblyStore;
let ledger: SqliteWorkLedger;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  ledger = new SqliteWorkLedger(store);
});

afterEach(() => store.close());

describe("atomic completion continuations", () => {
  test("completes work at the current generation and proposes follow-ups exactly once", async () => {
    const item = await ledger.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Finish and recommend the next moves",
      nextAction: "Complete the implementation.",
      priority: 70,
      actor: agent,
    });
    const claimed = await ledger.claimWork({ id: item.id, actor: agent, leaseSeconds: 900 });

    const input = {
      id: item.id,
      actor: agent,
      expectedClaimGeneration: claimed.claimGeneration,
      summary: "The implementation is complete.",
      continuations: [
        {
          title: "Review the implementation",
          rationale: "A human review should decide whether to merge it.",
          instruction: "Inspect the linked work and record the decision.",
          action: { kind: "request_decision" as const, decisionType: "merge_review" },
          deliveryMode: "current_conversation" as const,
        },
        {
          title: "Queue the follow-up polish",
          rationale: "The adjacent polish belongs in its own work item.",
          instruction: "Create a tracked item for the remaining polish.",
          action: { kind: "create_item" as const, project: "scrapbook" },
          deliveryMode: "supervisor" as const,
        },
      ],
      idempotencyKey: "complete-with-continuations-1",
    };

    const result = await ledger.completeWorkWithContinuations(input);
    expect(result.item).toMatchObject({
      id: item.id,
      status: "done",
      summary: "The implementation is complete.",
      nextAction: null,
      claimedBy: null,
      claimGeneration: claimed.claimGeneration + 1,
    });
    expect(result.continuations).toHaveLength(2);
    expect(result.continuations.map((entry) => entry.status)).toEqual([
      "proposed",
      "proposed",
    ]);
    expect(await ledger.completeWorkWithContinuations(input)).toEqual(result);

    const detail = await ledger.getItem(item.id);
    expect(detail.events.map((event) => event.type)).toEqual([
      "item.created",
      "claim.created",
      "item.completed",
      "continuation.proposed",
      "continuation.proposed",
    ]);
    expect(detail.events.find((event) => event.type === "item.completed")?.payload).toMatchObject({
      generation: claimed.claimGeneration,
      nextGeneration: result.item.claimGeneration,
    });

    await expect(ledger.completeWorkWithContinuations({
      ...input,
      summary: "A different replay.",
    })).rejects.toThrow(ConflictError);
    await expect(ledger.completeWorkWithContinuations({
      ...input,
      expectedClaimGeneration: result.item.claimGeneration,
    })).rejects.toThrow(ConflictError);
  });

  test("rolls completion back when any proposal fails", async () => {
    const item = await ledger.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Keep this open after a failed atomic command",
      nextAction: "Try the atomic completion.",
      priority: 60,
      actor: leo,
    });

    await expect(ledger.completeWorkWithContinuations({
      id: item.id,
      actor: leo,
      expectedClaimGeneration: item.claimGeneration,
      summary: "This must be rolled back.",
      continuations: [
        {
          title: "A valid first proposal",
          rationale: "This would otherwise be inserted first.",
          instruction: "Create the follow-up item.",
          action: { kind: "create_item", project: "scrapbook" },
        },
        {
          title: "stn.tok_secret-shaped-content",
          rationale: "This triggers server-owned credential validation.",
          instruction: "The whole transaction must roll back.",
          action: { kind: "request_decision", decisionType: "rollback_test" },
        },
      ],
      idempotencyKey: "complete-with-continuations-rollback",
    })).rejects.toThrow("credential-shaped text");

    const detail = await ledger.getItem(item.id);
    expect(detail.item).toMatchObject({
      status: "ready",
      summary: null,
      nextAction: "Try the atomic completion.",
      claimGeneration: item.claimGeneration,
      version: item.version,
    });
    expect(detail.events.map((event) => event.type)).toEqual(["item.created"]);
    expect(await ledger.listContinuations({ sourceItemId: item.id })).toEqual([]);
  });

  test("extends the existing REST completion response only when proposals exist", async () => {
    const app = createServerApp(store);
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Complete through REST with a proposed next move",
      priority: 55,
      actor: agent,
    });
    const body = {
      actor: agent,
      expectedClaimGeneration: item.claimGeneration,
      summary: "Completed through the existing endpoint.",
      continuations: [{
        title: "Review the REST completion",
        rationale: "The human should choose whether to continue.",
        instruction: "Review the completed item and approve the next move.",
        action: { kind: "request_decision", decisionType: "rest_review" },
        deliveryMode: "current_conversation",
      }],
    };

    const missingGeneration = await app.request(`/api/v1/items/${item.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, expectedClaimGeneration: undefined }),
    });
    expect(missingGeneration.status).toBe(400);

    const response = await app.request(`/api/v1/items/${item.id}/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "rest-complete-with-continuation",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    const result = await response.json() as {
      item: { status: string; summary: string; claimGeneration: number };
      continuations: Array<{ status: string; sourceItemId: string }>;
    };
    expect(result.item).toMatchObject({
      status: "done",
      summary: "Completed through the existing endpoint.",
      claimGeneration: item.claimGeneration + 1,
    });
    expect(result.continuations).toEqual([
      expect.objectContaining({ status: "proposed", sourceItemId: item.id }),
    ]);

    const replay = await app.request(`/api/v1/items/${item.id}/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "rest-complete-with-continuation",
      },
      body: JSON.stringify(body),
    });
    expect(await replay.json()).toEqual(result);
  });
});
