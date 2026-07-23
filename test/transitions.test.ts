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
    store.claimItem(item.id, browserAgent, 900);

    const handedOff = handoffWork(store, {
      id: item.id,
      actor: browserAgent,
      summary: "Found the relevant files and narrowed the fault.",
      nextAction: "Patch the parser and rerun the fixture.",
      toActorId: leo.id,
      idempotencyKey: "handoff-1",
    });

    expect(handedOff).toMatchObject({
      status: "ready",
      claimedBy: null,
      claimExpiresAt: null,
      summary: "Found the relevant files and narrowed the fault.",
      nextAction: "Patch the parser and rerun the fixture.",
    });
    expect(handoffWork(store, {
      id: item.id,
      actor: browserAgent,
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
    store.claimItem(item.id, browserAgent, 900);

    expect(() => handoffWork(store, {
      id: item.id,
      actor: leo,
      summary: "Premature handoff.",
      nextAction: "Interfere with the other worker.",
    })).toThrow(ConflictError);

    expect(() => blockWork(store, {
      id: item.id,
      actor: leo,
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
    store.claimItem(item.id, browserAgent, 900);

    const blocked = blockWork(store, {
      id: item.id,
      actor: browserAgent,
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
      reason: "Too late.",
    })).toThrow(ConflictError);
    expect(() => handoffWork(store, {
      id: item.id,
      actor: leo,
      summary: "Too late.",
      nextAction: "Do nothing.",
    })).toThrow(ConflictError);
  });
});
