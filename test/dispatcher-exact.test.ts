import { describe, expect, test } from "bun:test";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { ConflictError, StensiblyStore } from "../src/store.ts";

const supervisor = {
  id: "service:supervisor",
  name: "Supervisor",
  kind: "service" as const,
};
const now = new Date("2026-07-25T12:00:00.000Z");

describe("exact-item supervisor dispatch", () => {
  test("dispatches the requested ready item without changing ranked dispatch", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const high = createItem(store, "High priority", 100);
      const exact = createItem(store, "Exact continuation target", 10);
      const result = dispatchNextWork(store, {
        actor: supervisor,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        itemId: exact.id,
        continuationRef: "cont_exact",
        idempotencyKey: "dispatch-exact",
      }, now);

      expect(result).toMatchObject({
        item: { id: exact.id, status: "active", claimedBy: supervisor.id },
        run: { itemId: exact.id, continuationRef: "cont_exact", status: "queued" },
      });
      expect(store.getItem(high.id).status).toBe("ready");

      const next = dispatchNextWork(store, {
        actor: supervisor,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        idempotencyKey: "dispatch-ranked",
      }, now);
      expect(next?.item.id).toBe(high.id);
    } finally {
      store.close();
    }
  });

  test("returns no candidate when the exact item is unavailable or outside the project", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const exact = createItem(store, "Exact target", 50, "alpha");
      expect(dispatchNextWork(store, {
        actor: supervisor,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        project: "beta",
        itemId: exact.id,
        idempotencyKey: "dispatch-wrong-project",
      }, now)).toBeNull();

      store.claimItem(exact.id, supervisor, 900);
      expect(dispatchNextWork(store, {
        actor: supervisor,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        itemId: exact.id,
        idempotencyKey: "dispatch-unavailable",
      }, now)).toBeNull();
    } finally {
      store.close();
    }
  });

  test("rejects idempotency key reuse with a different exact item", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const first = createItem(store, "First target", 10);
      const second = createItem(store, "Second target", 10);
      dispatchNextWork(store, {
        actor: supervisor,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        itemId: first.id,
        idempotencyKey: "dispatch-replay",
      }, now);

      expect(() => dispatchNextWork(store, {
        actor: supervisor,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        itemId: second.id,
        idempotencyKey: "dispatch-replay",
      }, now)).toThrow(ConflictError);
      expect(store.getItem(second.id).status).toBe("ready");
    } finally {
      store.close();
    }
  });
});

function createItem(
  store: StensiblyStore,
  title: string,
  priority: number,
  project = "orchestration",
) {
  return store.createItem({
    project,
    kind: "task",
    title,
    nextAction: `Dispatch ${title}.`,
    priority,
    actor: supervisor,
  });
}
