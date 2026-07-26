import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConflictError, StensiblyStore } from "../src/store.ts";
import { blockWork, handoffWork, unblockWork } from "../src/transitions.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const browserAgent = {
  id: "browser-agent",
  name: "Browser Agent",
  kind: "agent" as const,
};

let store: StensiblyStore;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
});

afterEach(() => {
  store.close();
});

describe("work transitions", () => {
  test("a handoff releases the claim and leaves a compact continuation", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Pass the work onward",
      priority: 50,
      actor: leo,
    });
    const claimed = store.claimItem(item.id, browserAgent, 900);

    const handedOff = handoffWork(store, {
      id: item.id,
      actor: browserAgent,
      expectedClaimGeneration: claimed.claimGeneration,
      summary: "Found the relevant files and narrowed the fault.",
      nextAction: "Patch the parser and rerun the fixture.",
      toActorId: leo.id,
      idempotencyKey: "handoff-1",
    });

    expect(handedOff).toMatchObject({
      status: "ready",
      claimedBy: null,
      claimExpiresAt: null,
      claimGeneration: claimed.claimGeneration + 1,
      summary: "Found the relevant files and narrowed the fault.",
      nextAction: "Patch the parser and rerun the fixture.",
    });
    expect(handoffWork(store, {
      id: item.id,
      actor: browserAgent,
      expectedClaimGeneration: claimed.claimGeneration,
      summary: "Found the relevant files and narrowed the fault.",
      nextAction: "Patch the parser and rerun the fixture.",
      toActorId: leo.id,
      idempotencyKey: "handoff-1",
    }).id).toBe(item.id);

    const event = store.listEvents(item.id).at(-1);
    expect(event).toMatchObject({
      type: "work.handed_off",
      actorId: browserAgent.id,
      payload: {
        summary: "Found the relevant files and narrowed the fault.",
        nextAction: "Patch the parser and rerun the fixture.",
        toActorId: leo.id,
        generation: claimed.claimGeneration,
        nextGeneration: handedOff.claimGeneration,
      },
    });
  });

  test("another actor cannot hand off or block a live claimed item", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Respect the current worker",
      priority: 50,
      actor: leo,
    });
    const claimed = store.claimItem(item.id, browserAgent, 900);

    expect(() => handoffWork(store, {
      id: item.id,
      actor: leo,
      expectedClaimGeneration: claimed.claimGeneration,
      summary: "Premature handoff.",
      nextAction: "Interfere with the other worker.",
    })).toThrow(ConflictError);

    expect(() => blockWork(store, {
      id: item.id,
      actor: leo,
      expectedClaimGeneration: claimed.claimGeneration,
      reason: "Premature block.",
    })).toThrow(ConflictError);
  });

  test("blocking releases a claim and unblocking returns work to ready", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Wait for an external answer",
      priority: 50,
      actor: leo,
    });
    const claimed = store.claimItem(item.id, browserAgent, 900);

    const blocked = blockWork(store, {
      id: item.id,
      actor: browserAgent,
      expectedClaimGeneration: claimed.claimGeneration,
      reason: "The API credentials have not arrived.",
      nextAction: "Retry once credentials are available.",
      idempotencyKey: "block-1",
    });
    expect(blocked).toMatchObject({
      status: "blocked",
      claimedBy: null,
      claimExpiresAt: null,
      summary: "The API credentials have not arrived.",
      nextAction: "Retry once credentials are available.",
    });
    expect(() => store.claimItem(item.id, leo, 900)).toThrow(ConflictError);

    const unblocked = unblockWork(store, {
      id: item.id,
      actor: leo,
      expectedClaimGeneration: blocked.claimGeneration,
      nextAction: "Use the newly supplied credentials.",
      idempotencyKey: "unblock-1",
    });
    expect(unblocked).toMatchObject({
      status: "ready",
      nextAction: "Use the newly supplied credentials.",
    });
    expect(unblockWork(store, {
      id: item.id,
      actor: leo,
      expectedClaimGeneration: blocked.claimGeneration,
      nextAction: "Use the newly supplied credentials.",
      idempotencyKey: "unblock-1",
    }).id).toBe(item.id);

    expect(store.listEvents(item.id).map((event) => event.type)).toEqual([
      "item.created",
      "claim.created",
      "work.blocked",
      "work.unblocked",
    ]);
  });

  test("same actor cannot reuse a stale generation after authority changes", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Fence recycled actor identity",
      priority: 50,
      actor: leo,
    });
    const first = store.claimItem(item.id, browserAgent, 900);
    const released = store.releaseItem(
      item.id,
      browserAgent,
      first.claimGeneration,
    );
    const second = store.claimItem(item.id, browserAgent, 900);
    expect(second.claimGeneration).toBe(released.claimGeneration + 1);

    expect(() => handoffWork(store, {
      id: item.id,
      actor: browserAgent,
      expectedClaimGeneration: first.claimGeneration,
      summary: "Stale handoff.",
      nextAction: "Should not apply.",
    })).toThrow(ConflictError);
    expect(() => blockWork(store, {
      id: item.id,
      actor: browserAgent,
      expectedClaimGeneration: first.claimGeneration,
      reason: "Stale block.",
    })).toThrow(ConflictError);
    expect(() => store.completeItem(
      item.id,
      browserAgent,
      first.claimGeneration,
      "Stale completion.",
    )).toThrow(ConflictError);
  });

  test("idempotency keys replay only the exact item operation", () => {
    const firstItem = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Replay exact operation",
      priority: 50,
      actor: leo,
    });
    const secondItem = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Reject cross-item replay",
      priority: 50,
      actor: leo,
    });
    const claimed = store.claimItem(firstItem.id, browserAgent, 900);
    const command = {
      id: firstItem.id,
      actor: browserAgent,
      expectedClaimGeneration: claimed.claimGeneration,
      summary: "Exact handoff.",
      nextAction: "Continue from the recorded state.",
      idempotencyKey: "exact-handoff",
    };

    const handedOff = handoffWork(store, command);
    expect(handoffWork(store, command)).toEqual(handedOff);
    expect(() => handoffWork(store, {
      ...command,
      summary: "Changed handoff.",
    })).toThrow(ConflictError);
    expect(() => handoffWork(store, {
      ...command,
      expectedClaimGeneration: claimed.claimGeneration + 1,
    })).toThrow(ConflictError);
    expect(() => handoffWork(store, {
      ...command,
      id: secondItem.id,
      actor: leo,
      expectedClaimGeneration: secondItem.claimGeneration,
    })).toThrow(ConflictError);
    expect(() => blockWork(store, {
      id: firstItem.id,
      actor: browserAgent,
      expectedClaimGeneration: claimed.claimGeneration,
      reason: "Cross-operation reuse.",
      idempotencyKey: "exact-handoff",
    })).toThrow(ConflictError);

    const completionItem = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Replay exact completion",
      priority: 50,
      actor: leo,
    });
    const completed = store.completeItem(
      completionItem.id,
      leo,
      completionItem.claimGeneration,
      "Done once.",
      "exact-completion",
    );
    expect(store.completeItem(
      completionItem.id,
      leo,
      completionItem.claimGeneration,
      "Done once.",
      "exact-completion",
    )).toEqual(completed);
    expect(() => store.completeItem(
      completionItem.id,
      leo,
      completionItem.claimGeneration,
      "Different summary.",
      "exact-completion",
    )).toThrow(ConflictError);
    expect(() => store.completeItem(
      completionItem.id,
      leo,
      completionItem.claimGeneration + 1,
      "Done once.",
      "exact-completion",
    )).toThrow(ConflictError);
  });

  test("completed work rejects further workflow transitions", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Leave completed work alone",
      priority: 50,
      actor: leo,
    });
    const completed = store.completeItem(
      item.id,
      leo,
      item.claimGeneration,
      "Done.",
    );

    expect(() => blockWork(store, {
      id: item.id,
      actor: leo,
      expectedClaimGeneration: completed.claimGeneration,
      reason: "Too late.",
    })).toThrow(ConflictError);
    expect(() => handoffWork(store, {
      id: item.id,
      actor: leo,
      expectedClaimGeneration: completed.claimGeneration,
      summary: "Too late.",
      nextAction: "Do nothing.",
    })).toThrow(ConflictError);
  });
});
