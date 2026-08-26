import { describe, expect, test } from "bun:test";
import {
  compileProjectApplicationLaneBindingSnapshotV1,
  exactApplicationLaneBindingProjectReadLimit,
} from "../src/application-lane-binding-store.ts";
import { SqliteApplicationLaneBindingStore } from "../src/application-lane-binding-sqlite-store.ts";
import { StensiblyStore } from "../src/store.ts";

const actor = { id: "agent:vesper", name: "Vesper", kind: "agent" as const };

function createItem(store: StensiblyStore, project = "stensibly") {
  return store.createItem({
    project,
    kind: "task",
    title: `Application-backed work in ${project}`,
    summary: "Exercise the project application binding index.",
    nextAction: "Inspect only if useful.",
    priority: 50,
    actor,
  });
}

function binding(
  itemId: string,
  id: string,
  project = "stensibly",
  laneRef = `elatura:${id}`,
) {
  return {
    version: 1,
    id,
    generation: 1,
    project,
    itemId,
    provider: "elatura",
    laneRef,
    laneGeneration: 1,
    capabilities: ["events", "observe"],
    createdAt: "2026-08-27T00:00:00.000Z",
    retiredAt: null,
  };
}

describe("bounded project application binding index", () => {
  test("compiler canonicalizes ordering and reports completeness explicitly", () => {
    const first = binding("item:z", "binding:z");
    const second = binding("item:a", "binding:b");
    const third = binding("item:a", "binding:a");

    const forward = compileProjectApplicationLaneBindingSnapshotV1(
      "stensibly",
      [first, second, third],
      2,
    );
    const reverse = compileProjectApplicationLaneBindingSnapshotV1(
      "stensibly",
      [third, second, first],
      2,
    );

    expect(reverse).toEqual(forward);
    expect(forward).toMatchObject({
      version: 1,
      project: "stensibly",
      truncated: true,
    });
    expect(forward.bindings.map((entry) => `${entry.itemId}/${entry.id}`)).toEqual([
      "item:a/binding:a",
      "item:a/binding:b",
    ]);
  });

  test("SQLite reads current project relations once without leaking retired or foreign bindings", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const firstItem = createItem(store);
      const secondItem = createItem(store);
      const retiredItem = createItem(store);
      const foreignItem = createItem(store, "other-project");
      const bindings = new SqliteApplicationLaneBindingStore(store);

      const first = await bindings.bindApplicationLane({
        binding: binding(firstItem.id, "binding:first"),
        idempotencyKey: "bind-project-index-first",
      });
      const second = await bindings.bindApplicationLane({
        binding: binding(secondItem.id, "binding:second"),
        idempotencyKey: "bind-project-index-second",
      });
      const retired = await bindings.bindApplicationLane({
        binding: binding(retiredItem.id, "binding:retired"),
        idempotencyKey: "bind-project-index-retired",
      });
      await bindings.retireApplicationLaneBinding({
        project: "stensibly",
        bindingId: retired.id,
        expectedGeneration: retired.generation,
        retiredAt: "2026-08-27T01:00:00.000Z",
        idempotencyKey: "retire-project-index-binding",
      });
      await bindings.bindApplicationLane({
        binding: binding(
          foreignItem.id,
          "binding:foreign",
          "other-project",
          "elatura:foreign",
        ),
        idempotencyKey: "bind-project-index-foreign",
      });

      const full = await bindings.listProjectCurrentApplicationLaneBindings("stensibly", 10);
      expect(full.truncated).toBe(false);
      expect(new Set(full.bindings.map((entry) => entry.id))).toEqual(
        new Set([first.id, second.id]),
      );
      expect(full.bindings.every((entry) => entry.project === "stensibly")).toBe(true);
      expect(full.bindings.every((entry) => entry.retiredAt === null)).toBe(true);

      const bounded = await bindings.listProjectCurrentApplicationLaneBindings("stensibly", 1);
      expect(bounded.bindings).toHaveLength(1);
      expect(bounded.truncated).toBe(true);

      const foreign = await bindings.listProjectCurrentApplicationLaneBindings("other-project", 10);
      expect(foreign.bindings.map((entry) => entry.id)).toEqual(["binding:foreign"]);
      expect(foreign.truncated).toBe(false);
    } finally {
      store.close();
    }
  });

  test("read limits are implementation budgets and reject invalid values", async () => {
    expect(exactApplicationLaneBindingProjectReadLimit()).toBe(100);
    expect(exactApplicationLaneBindingProjectReadLimit(1)).toBe(1);
    expect(exactApplicationLaneBindingProjectReadLimit(500)).toBe(500);
    expect(() => exactApplicationLaneBindingProjectReadLimit(0)).toThrow();
    expect(() => exactApplicationLaneBindingProjectReadLimit(501)).toThrow();
    expect(() => exactApplicationLaneBindingProjectReadLimit(1.5)).toThrow();

    const store = new StensiblyStore(":memory:");
    try {
      const bindings = new SqliteApplicationLaneBindingStore(store);
      await expect(bindings.listProjectCurrentApplicationLaneBindings("stensibly", 0))
        .rejects.toThrow();
    } finally {
      store.close();
    }
  });
});
