import { describe, expect, test } from "bun:test";
import {
  ApplicationLaneBindingConflictError,
  ApplicationLaneBindingStorageError,
} from "../src/application-lane-binding-store.ts";
import { SqliteApplicationLaneBindingStore } from "../src/application-lane-binding-sqlite-store.ts";
import { StensiblyStore } from "../src/store.ts";

const actor = { id: "agent:vesper", name: "Vesper", kind: "agent" as const };

function createItem(store: StensiblyStore, project = "stensibly") {
  return store.createItem({
    project,
    kind: "task",
    title: `Application-backed work in ${project}`,
    summary: "Exercise a durable application lane binding.",
    nextAction: "Observe the bound application lane.",
    priority: 70,
    actor,
  });
}

function binding(itemId: string, override: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: "binding:work-a:lane-a",
    generation: 1,
    project: "stensibly",
    itemId,
    provider: "elatura",
    laneRef: "elatura:lane:chat-a",
    laneGeneration: 7,
    capabilities: ["events", "observe", "activate", "screenshot"],
    createdAt: "2026-08-27T00:00:00.000Z",
    retiredAt: null,
    ...override,
  };
}

describe("SQLite application lane binding store", () => {
  test("persists one current binding with direct lookup and exact replay", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const bindings = new SqliteApplicationLaneBindingStore(store);
      const input = {
        binding: binding(item.id),
        idempotencyKey: "bind-lane-a",
      };

      const created = await bindings.bindApplicationLane(input);
      const replayed = await bindings.bindApplicationLane(input);

      expect(replayed).toEqual(created);
      expect(await bindings.getApplicationLaneBinding("stensibly", created.id)).toEqual(created);
      expect(await bindings.listCurrentApplicationLaneBindings("stensibly", item.id)).toEqual([created]);
      expect(await bindings.listApplicationLaneBindingHistory("stensibly", created.id)).toEqual([created]);
      expect(created).toMatchObject({
        generation: 1,
        itemId: item.id,
        laneRef: "elatura:lane:chat-a",
        laneGeneration: 7,
        retiredAt: null,
        grantsWorkAuthority: false,
        grantsApplicationAuthority: false,
      });
    } finally {
      store.close();
    }
  });

  test("conflicts changed reuse of one idempotency identity and stable binding id", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const bindings = new SqliteApplicationLaneBindingStore(store);
      await bindings.bindApplicationLane({
        binding: binding(item.id),
        idempotencyKey: "bind-lane-a",
      });

      await expect(bindings.bindApplicationLane({
        binding: binding(item.id, { laneRef: "elatura:lane:other" }),
        idempotencyKey: "bind-lane-a",
      })).rejects.toBeInstanceOf(ApplicationLaneBindingConflictError);

      await expect(bindings.bindApplicationLane({
        binding: binding(item.id),
        idempotencyKey: "bind-lane-a-second-command",
      })).rejects.toBeInstanceOf(ApplicationLaneBindingConflictError);
    } finally {
      store.close();
    }
  });

  test("requires the bound item to belong to the declared project", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "other-project");
      const bindings = new SqliteApplicationLaneBindingStore(store);

      await expect(bindings.bindApplicationLane({
        binding: binding(item.id),
        idempotencyKey: "wrong-project",
      })).rejects.toBeInstanceOf(ApplicationLaneBindingConflictError);
      expect(await bindings.listCurrentApplicationLaneBindings("stensibly", item.id)).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("retires only the exact current generation and preserves append-only history", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const bindings = new SqliteApplicationLaneBindingStore(store);
      const active = await bindings.bindApplicationLane({
        binding: binding(item.id),
        idempotencyKey: "bind-lane-a",
      });

      const command = {
        project: "stensibly",
        bindingId: active.id,
        expectedGeneration: 1,
        retiredAt: "2026-08-27T01:00:00.000Z",
        idempotencyKey: "retire-lane-a",
      };
      const retired = await bindings.retireApplicationLaneBinding(command);
      const replayed = await bindings.retireApplicationLaneBinding(command);

      expect(replayed).toEqual(retired);
      expect(retired).toMatchObject({
        generation: 2,
        itemId: item.id,
        laneRef: active.laneRef,
        laneGeneration: active.laneGeneration,
        retiredAt: command.retiredAt,
      });
      expect(await bindings.getApplicationLaneBinding("stensibly", active.id)).toEqual(retired);
      expect(await bindings.listCurrentApplicationLaneBindings("stensibly", item.id)).toEqual([]);
      expect(await bindings.listApplicationLaneBindingHistory("stensibly", active.id)).toEqual([
        active,
        retired,
      ]);

      await expect(bindings.retireApplicationLaneBinding({
        ...command,
        idempotencyKey: "retire-again",
        expectedGeneration: 1,
      })).rejects.toBeInstanceOf(ApplicationLaneBindingConflictError);
    } finally {
      store.close();
    }
  });

  test("keeps direct current lookup independent from ordinary item event volume", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const bindings = new SqliteApplicationLaneBindingStore(store);
      const active = await bindings.bindApplicationLane({
        binding: binding(item.id),
        idempotencyKey: "bind-lane-a",
      });

      for (let index = 0; index < 250; index += 1) {
        store.appendEvent({
          itemId: item.id,
          actorId: actor.id,
          type: "diagnostic.noise",
          payload: { index },
        });
      }

      expect(store.listEvents(item.id).length).toBeGreaterThan(200);
      expect(await bindings.getApplicationLaneBinding("stensibly", active.id)).toEqual(active);
      expect(await bindings.listCurrentApplicationLaneBindings("stensibly", item.id)).toEqual([active]);
    } finally {
      store.close();
    }
  });

  test("fails closed when duplicated durable fields diverge from canonical binding JSON", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const bindings = new SqliteApplicationLaneBindingStore(store);
      const active = await bindings.bindApplicationLane({
        binding: binding(item.id),
        idempotencyKey: "bind-lane-a",
      });

      store.db.query(`
        UPDATE application_lane_bindings
        SET binding_fingerprint = ?1
        WHERE id = ?2 AND is_current = 1
      `).run(`sha256:${"f".repeat(64)}`, active.id);

      await expect(bindings.getApplicationLaneBinding("stensibly", active.id))
        .rejects.toBeInstanceOf(ApplicationLaneBindingStorageError);
    } finally {
      store.close();
    }
  });

  test("isolates project-scoped lookup even when binding ids are reused elsewhere", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const firstItem = createItem(store, "stensibly");
      const secondItem = createItem(store, "other-project");
      const bindings = new SqliteApplicationLaneBindingStore(store);
      const first = await bindings.bindApplicationLane({
        binding: binding(firstItem.id),
        idempotencyKey: "bind-first-project",
      });
      const second = await bindings.bindApplicationLane({
        binding: binding(secondItem.id, {
          project: "other-project",
          laneRef: "elatura:lane:other-project",
        }),
        idempotencyKey: "bind-second-project",
      });

      expect(second.id).toBe(first.id);
      expect(await bindings.getApplicationLaneBinding("stensibly", first.id)).toEqual(first);
      expect(await bindings.getApplicationLaneBinding("other-project", second.id)).toEqual(second);
      expect(await bindings.listCurrentApplicationLaneBindings("stensibly", secondItem.id)).toEqual([]);
      expect(await bindings.listCurrentApplicationLaneBindings("other-project", secondItem.id)).toEqual([second]);
    } finally {
      store.close();
    }
  });
});
