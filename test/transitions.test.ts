import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renewClaim } from "../src/leases.ts";
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
  test("a handoff fences the current claim and replays exactly", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Pass the work onward",
      priority: 50,
      actor: leo,
    });
    const claimed = store.claimItem(item.id, browserAgent, 900);

    const request = {
      id: item.id,
      actor: browserAgent,
      expectedClaimGeneration: claimed.claimGeneration,
      summary: "Found the relevant files and narrowed the fault.",
      nextAction: "Patch the parser and rerun the fixture.",
      toActorId: leo.id,
      idempotencyKey: "handoff-1",
    };
    const handedOff = handoffWork(store, request);

    expect(handedOff).toMatchObject({
      status: "ready",
      claimedBy: null,
      claimExpiresAt: null,
      claimGeneration: claimed.claimGeneration + 1,
      summary: request.summary,
      nextAction: request.nextAction,
    });
    expect(handoffWork(store, request)).toEqual(handedOff);

    const event = store.listEvents(item.id).at(-1);
    expect(event).toMatchObject({
      type: "work.handed_off",
      actorId: browserAgent.id,
      payload: {
        summary: request.summary,
        nextAction: request.nextAction,
        toActorId: leo.id,
        generation: claimed.claimGeneration,
        nextGeneration: claimed.claimGeneration + 1,
      },
    });
  });

  test("never-claimed ready work accepts generation zero", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Hand off unclaimed work",
      priority: 50,
      actor: leo,
    });

    const handedOff = handoffWork(store, {
      id: item.id,
      actor: leo,
      expectedClaimGeneration: 0,
      summary: "Prepared the task for another actor.",
      nextAction: "Choose an implementation owner.",
    });

    expect(handedOff).toMatchObject({
      status: "ready",
      claimGeneration: 1,
      claimedBy: null,
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

  test("blocking and unblocking each advance the generation exactly once", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Wait for an external answer",
      priority: 50,
      actor: leo,
    });
    const claimed = store.claimItem(item.id, browserAgent, 900);

    const blockRequest = {
      id: item.id,
      actor: browserAgent,
      expectedClaimGeneration: claimed.claimGeneration,
      reason: "The API credentials have not arrived.",
      nextAction: "Retry once credentials are available.",
      idempotencyKey: "block-1",
    };
    const blocked = blockWork(store, blockRequest);
    expect(blocked).toMatchObject({
      status: "blocked",
      claimedBy: null,
      claimExpiresAt: null,
      claimGeneration: claimed.claimGeneration + 1,
      summary: blockRequest.reason,
      nextAction: blockRequest.nextAction,
    });
    expect(blockWork(store, blockRequest)).toEqual(blocked);
    expect(() => store.claimItem(item.id, leo, 900)).toThrow(ConflictError);

    const unblockRequest = {
      id: item.id,
      actor: leo,
      expectedClaimGeneration: blocked.claimGeneration,
      nextAction: "Use the newly supplied credentials.",
      idempotencyKey: "unblock-1",
    };
    const unblocked = unblockWork(store, unblockRequest);
    expect(unblocked).toMatchObject({
      status: "ready",
      nextAction: unblockRequest.nextAction,
      claimGeneration: blocked.claimGeneration + 1,
    });
    expect(unblockWork(store, unblockRequest)).toEqual(unblocked);

    expect(store.listEvents(item.id).map((event) => event.type)).toEqual([
      "item.created",
      "claim.created",
      "work.blocked",
      "work.unblocked",
    ]);
    expect(store.listEvents(item.id).slice(-2).map((event) => event.payload)).toEqual([
      expect.objectContaining({
        generation: claimed.claimGeneration,
        nextGeneration: blocked.claimGeneration,
      }),
      expect.objectContaining({
        generation: blocked.claimGeneration,
        nextGeneration: unblocked.claimGeneration,
      }),
    ]);
  });

  test("same-actor stale generations cannot mutate reacquired work", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Reject stale same-actor transitions",
      priority: 50,
      actor: leo,
    });
    const firstClaim = store.claimItem(item.id, browserAgent, 900);
    const renewed = renewClaim(
      store,
      item.id,
      browserAgent,
      1800,
      firstClaim.claimGeneration,
    );

    expect(() => handoffWork(store, {
      id: item.id,
      actor: browserAgent,
      expectedClaimGeneration: firstClaim.claimGeneration,
      summary: "Stale handoff.",
      nextAction: "Should fail.",
    })).toThrow(ConflictError);
    expect(() => blockWork(store, {
      id: item.id,
      actor: browserAgent,
      expectedClaimGeneration: firstClaim.claimGeneration,
      reason: "Stale block.",
    })).toThrow(ConflictError);
    expect(store.getItem(item.id)).toEqual(renewed);
  });

  test("expiry advances generation before a stale transition is evaluated", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Reject expired authority",
      priority: 50,
      actor: leo,
    });
    const claimed = store.claimItem(item.id, browserAgent, 900);
    store.db
      .query("UPDATE items SET claim_expires_at = ?1 WHERE id = ?2")
      .run("2020-01-01T00:00:00.000Z", item.id);

    expect(() => handoffWork(store, {
      id: item.id,
      actor: browserAgent,
      expectedClaimGeneration: claimed.claimGeneration,
      summary: "Expired handoff.",
      nextAction: "Should fail.",
    })).toThrow(ConflictError);
    expect(store.getItem(item.id)).toMatchObject({
      status: "ready",
      claimedBy: null,
      claimGeneration: claimed.claimGeneration + 1,
    });
  });

  test("completed work rejects further workflow transitions", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Leave completed work alone",
      priority: 50,
      actor: leo,
    });
    store.completeItem(item.id, leo, "Done.");

    expect(() => blockWork(store, {
      id: item.id,
      actor: leo,
      expectedClaimGeneration: store.getItem(item.id).claimGeneration,
      reason: "Too late.",
    })).toThrow(ConflictError);
    expect(() => handoffWork(store, {
      id: item.id,
      actor: leo,
      expectedClaimGeneration: store.getItem(item.id).claimGeneration,
      summary: "Too late.",
      nextAction: "Do nothing.",
    })).toThrow(ConflictError);
  });
});
