import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { SqliteApplicationLaneBindingStore } from "../src/application-lane-binding-sqlite-store.ts";
import { compileApplicationLaneWakeIntentV1 } from "../src/application-lane-wake-intent.ts";
import {
  ApplicationLaneWakeConflictError,
  ApplicationLaneWakeStorageError,
  getApplicationLaneWakeIntent,
  recordApplicationLaneWakeIntent,
  type RecordApplicationLaneWakeIntentInput,
} from "../src/application-lane-wake-store.ts";
import { StensiblyStore } from "../src/store.ts";

const actor = { id: "agent:vesper", name: "Vesper", kind: "agent" as const };
const observedAt = "2026-08-27T01:00:00.000Z";
const recordedAt = new Date("2026-08-27T01:00:01.000Z");

describe("durable same-item application lane wake intents", () => {
  test("compiles, records, and exactly replays one current admitted wake", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const fixture = await setup(store, "replay");
      const stored = recordApplicationLaneWakeIntent(store, fixture.recordInput, recordedAt);
      const replay = recordApplicationLaneWakeIntent(
        store,
        fixture.recordInput,
        new Date("2026-08-27T02:00:00.000Z"),
      );

      expect(stored).toEqual(fixture.expectedWake);
      expect(replay).toEqual(stored);
      expect(getApplicationLaneWakeIntent(store, stored.idempotencyKey)).toEqual(stored);
      const count = store.db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM application_lane_wake_intents")
        .get();
      expect(count?.count).toBe(1);
      expect(stored.grantsAuthority).toBe(false);
      expect(stored.authorizesDispatch).toBe(false);
    } finally {
      store.close();
    }
  });

  test("first admission fails after the work generation moves", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const fixture = await setup(store, "claim-moved");
      const claimed = store.claimItem(fixture.itemId, actor, 900);
      store.releaseItem(fixture.itemId, actor, claimed.claimGeneration);
      expect(store.getItem(fixture.itemId).claimGeneration).toBe(2);

      expect(() => recordApplicationLaneWakeIntent(store, fixture.recordInput, recordedAt))
        .toThrow(ApplicationLaneWakeConflictError);
      expect(getApplicationLaneWakeIntent(store, fixture.expectedWake.idempotencyKey)).toBeNull();
    } finally {
      store.close();
    }
  });

  test("first admission fails after the application binding is retired", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const fixture = await setup(store, "binding-moved");
      await fixture.bindings.retireApplicationLaneBinding({
        project: "stensibly",
        bindingId: fixture.bindingId,
        expectedGeneration: 1,
        retiredAt: "2026-08-27T01:00:00.500Z",
        idempotencyKey: "retire-wake-store-binding",
      });

      expect(() => recordApplicationLaneWakeIntent(store, fixture.recordInput, recordedAt))
        .toThrow(ApplicationLaneWakeConflictError);
    } finally {
      store.close();
    }
  });

  test("exact replay remains historical evidence after later work and binding movement", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const fixture = await setup(store, "historical-replay");
      const stored = recordApplicationLaneWakeIntent(store, fixture.recordInput, recordedAt);

      const claimed = store.claimItem(fixture.itemId, actor, 900);
      store.releaseItem(fixture.itemId, actor, claimed.claimGeneration);
      await fixture.bindings.retireApplicationLaneBinding({
        project: "stensibly",
        bindingId: fixture.bindingId,
        expectedGeneration: 1,
        retiredAt: "2026-08-27T01:30:00.000Z",
        idempotencyKey: "retire-historical-wake-binding",
      });

      const replay = recordApplicationLaneWakeIntent(
        store,
        fixture.recordInput,
        new Date("2026-08-27T03:00:00.000Z"),
      );
      expect(replay).toEqual(stored);
    } finally {
      store.close();
    }
  });

  test("direct lookup survives store restart without depending on bounded item history", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stensibly-wake-store-"));
    const databasePath = join(directory, "stensibly.db");
    let sourceRef = "";
    let itemId = "";
    try {
      const first = new StensiblyStore(databasePath);
      try {
        const fixture = await setup(first, "restart");
        const stored = recordApplicationLaneWakeIntent(first, fixture.recordInput, recordedAt);
        sourceRef = stored.idempotencyKey;
        itemId = fixture.itemId;
      } finally {
        first.close();
      }

      const second = new StensiblyStore(databasePath);
      try {
        expect(getApplicationLaneWakeIntent(second, sourceRef)).toMatchObject({
          itemId,
          idempotencyKey: sourceRef,
          claimGeneration: 0,
        });
      } finally {
        second.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("fails closed when duplicated durable fields drift from canonical wake JSON", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const fixture = await setup(store, "corruption");
      const stored = recordApplicationLaneWakeIntent(store, fixture.recordInput, recordedAt);
      store.db.query(`
        UPDATE application_lane_wake_intents
        SET lane_generation = lane_generation + 1
        WHERE source_ref = ?1
      `).run(stored.idempotencyKey);

      expect(() => getApplicationLaneWakeIntent(store, stored.idempotencyKey))
        .toThrow(ApplicationLaneWakeStorageError);
    } finally {
      store.close();
    }
  });

  test("contains corrupted durable timestamps behind the typed storage error", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const fixture = await setup(store, "corrupt-time");
      const stored = recordApplicationLaneWakeIntent(store, fixture.recordInput, recordedAt);
      store.db.query(`
        UPDATE application_lane_wake_intents
        SET recorded_at = 'not-a-time'
        WHERE source_ref = ?1
      `).run(stored.idempotencyKey);

      expect(() => getApplicationLaneWakeIntent(store, stored.idempotencyKey))
        .toThrow(ApplicationLaneWakeStorageError);
    } finally {
      store.close();
    }
  });

  test("refuses to record a wake before its source observation", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const fixture = await setup(store, "time");
      expect(() => recordApplicationLaneWakeIntent(
        store,
        fixture.recordInput,
        new Date("2026-08-27T00:59:59.999Z"),
      )).toThrow("Application lane wake cannot be recorded before its observation");
    } finally {
      store.close();
    }
  });

  test("does not accept an already-compiled wake object as the admission request", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const fixture = await setup(store, "compiled-input");
      expect(() => recordApplicationLaneWakeIntent(
        store,
        fixture.expectedWake as unknown as RecordApplicationLaneWakeIntentInput,
        recordedAt,
      )).toThrow();
      expect(getApplicationLaneWakeIntent(store, fixture.expectedWake.idempotencyKey)).toBeNull();
    } finally {
      store.close();
    }
  });
});

async function setup(store: StensiblyStore, suffix: string) {
  const item = store.createItem({
    project: "stensibly",
    kind: "task",
    title: `Application wake store ${suffix}`,
    nextAction: "Resume only from an admitted current application wake.",
    priority: 50,
    actor,
  });
  const bindingId = `binding:wake-store-${suffix}`;
  const laneRef = `elatura:wake-store-${suffix}`;
  const currentBinding = {
    version: 1,
    id: bindingId,
    generation: 1,
    project: "stensibly",
    itemId: item.id,
    provider: "elatura",
    laneRef,
    laneGeneration: 1,
    capabilities: ["events", "observe", "activate"],
    createdAt: "2026-08-27T00:00:00.000Z",
    retiredAt: null,
  };
  const registration = {
    version: 1,
    id: `wake-registration:${suffix}`,
    generation: 1,
    project: "stensibly",
    itemId: item.id,
    claimGeneration: item.claimGeneration,
    bindingId,
    bindingGeneration: 1,
    laneRef,
    laneGeneration: 1,
    eventTypes: ["changed", "possible_completion"],
    createdAt: "2026-08-27T00:30:00.000Z",
    expiresAt: null,
  };
  const currentAuthority = {
    project: "stensibly",
    itemId: item.id,
    claimGeneration: item.claimGeneration,
  };
  const event = {
    version: 1,
    eventId: `lane-event:wake-store-${suffix}`,
    laneRef,
    laneGeneration: 1,
    eventType: "changed",
    observedAt,
    confidence: "exact",
    freshness: "fresh",
    sourceRefs: [`source:wake-store-${suffix}`],
    grantsWorkAuthority: false,
    authorizesWorkDispatch: false,
  };
  const bindings = new SqliteApplicationLaneBindingStore(store);
  await bindings.bindApplicationLane({
    binding: currentBinding,
    idempotencyKey: `bind-wake-store-${suffix}`,
  });

  const decision = compileApplicationLaneWakeIntentV1(
    registration,
    currentBinding,
    currentAuthority,
    event,
  );
  if (!decision.wakeIntent) throw new Error("wake fixture did not match");
  const recordInput: RecordApplicationLaneWakeIntentInput = {
    registration,
    currentBinding,
    currentAuthority,
    event,
  };
  return {
    itemId: item.id,
    bindingId,
    bindings,
    recordInput,
    expectedWake: decision.wakeIntent,
  };
}
