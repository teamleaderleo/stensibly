import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConflictError, StensiblyStore } from "../src/store.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const browserAgent = { id: "browser-agent", name: "Browser Agent", kind: "agent" as const };

let store: StensiblyStore;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
});

afterEach(() => {
  store.close();
});

describe("work lifecycle", () => {
  test("claims are exclusive until released", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Check the weird little board",
      priority: 50,
      actor: leo,
    });

    const claimed = store.claimItem(item.id, browserAgent, 900);
    expect(claimed.status).toBe("active");
    expect(claimed.claimedBy).toBe(browserAgent.id);

    expect(() => store.claimItem(item.id, leo, 900)).toThrow(ConflictError);

    const released = store.releaseItem(item.id, browserAgent);
    expect(released.status).toBe("ready");
    expect(released.claimedBy).toBeNull();

    const reclaimed = store.claimItem(item.id, leo, 900);
    expect(reclaimed.claimedBy).toBe(leo.id);
  });

  test("completion clears the lease and records history", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Finish something, ostensibly",
      priority: 80,
      actor: leo,
    });

    store.claimItem(item.id, browserAgent, 900);
    const completed = store.completeItem(item.id, browserAgent, "A thing occurred.");

    expect(completed.status).toBe("done");
    expect(completed.summary).toBe("A thing occurred.");
    expect(completed.claimedBy).toBeNull();
    expect(store.listEvents(item.id).map((event) => event.type)).toEqual([
      "item.created",
      "claim.created",
      "item.completed",
    ]);
  });

  test("idempotency keys prevent duplicate items and events", () => {
    const input = {
      project: "scrapbook",
      kind: "finding" as const,
      title: "The same discovery",
      priority: 40,
      actor: browserAgent,
    };

    const first = store.createItem(input, "create-1");
    const second = store.createItem(input, "create-1");
    expect(second.id).toBe(first.id);

    const eventOne = store.recordEvent({
      itemId: first.id,
      actor: browserAgent,
      type: "finding.recorded",
      payload: { useful: true },
      idempotencyKey: "event-1",
    });
    const eventTwo = store.recordEvent({
      itemId: first.id,
      actor: browserAgent,
      type: "finding.recorded",
      payload: { useful: true },
      idempotencyKey: "event-1",
    });

    expect(eventTwo.id).toBe(eventOne.id);
  });
});
