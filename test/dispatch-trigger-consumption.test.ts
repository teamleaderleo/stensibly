import { describe, expect, test } from "bun:test";
import { SqliteApplicationLaneBindingStore } from "../src/application-lane-binding-sqlite-store.ts";
import { compileApplicationLaneWakeIntentV1 } from "../src/application-lane-wake-intent.ts";
import { recordApplicationLaneWakeIntent } from "../src/application-lane-wake-store.ts";
import {
  applicationLaneWakeToDispatchTriggerV1,
  buildDispatchTriggerV1,
} from "../src/dispatch-trigger.ts";
import {
  DispatchTriggerConsumptionConflictError,
  DispatchTriggerConsumptionStorageError,
  consumeApplicationLaneDispatchTrigger,
  ensureDispatchTriggerConsumptionSchema,
  getDispatchTriggerConsumptionReceipt,
} from "../src/dispatch-trigger-consumption.ts";
import { ensureRunSchema } from "../src/runs.ts";
import { StensiblyStore } from "../src/store.ts";

const actor = {
  id: "service:vesper-trigger",
  name: "Vesper trigger consumer",
  kind: "service" as const,
};
const observedAt = "2026-08-27T02:00:00.000Z";
const consumedAt = new Date("2026-08-27T02:00:01.000Z");

function dispatchInput() {
  return {
    actor,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    continuationRef: "cont:application-wake",
  };
}

describe("durable application-lane dispatch trigger consumption", () => {
  test("consumes generation-zero wake once through the existing exact dispatcher", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const fixture = await setup(store, "consume");
      const first = consumeApplicationLaneDispatchTrigger(store, {
        trigger: fixture.trigger,
        dispatch: dispatchInput(),
      }, consumedAt);

      expect(first).toMatchObject({
        status: "consumed",
        replay: false,
        receipt: {
          triggerFingerprint: fixture.trigger.fingerprint,
          triggerIdempotencyKey: fixture.trigger.idempotencyKey,
          project: "stensibly",
          itemId: fixture.itemId,
          expectedClaimGeneration: 0,
          claimedGeneration: 1,
          sourceRef: fixture.wake.idempotencyKey,
          sourceFingerprint: fixture.wake.fingerprint,
          grantsAuthority: false,
          authorizesFurtherDispatch: false,
        },
      });
      expect(store.getItem(fixture.itemId)).toMatchObject({
        status: "active",
        claimGeneration: 1,
        claimedBy: actor.id,
      });
      if (first.status !== "consumed") throw new Error("expected consumed fixture");
      expect(getDispatchTriggerConsumptionReceipt(store, fixture.trigger.idempotencyKey))
        .toEqual(first.receipt);

      const replay = consumeApplicationLaneDispatchTrigger(store, {
        trigger: fixture.trigger,
        dispatch: dispatchInput(),
      }, new Date("2026-08-27T03:00:00.000Z"));
      expect(replay).toEqual({
        status: "consumed",
        replay: true,
        receipt: first.receipt,
      });
      expect(runCount(store, fixture.itemId)).toBe(1);
    } finally {
      store.close();
    }
  });

  test("stale work generation cannot consume a later ready incarnation", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const fixture = await setup(store, "stale-generation");
      const claimed = store.claimItem(fixture.itemId, actor, 900);
      store.releaseItem(fixture.itemId, actor, claimed.claimGeneration);
      expect(store.getItem(fixture.itemId)).toMatchObject({ status: "ready", claimGeneration: 2 });

      const outcome = consumeApplicationLaneDispatchTrigger(store, {
        trigger: fixture.trigger,
        dispatch: dispatchInput(),
      }, consumedAt);
      expect(outcome).toEqual({
        status: "stale_generation",
        triggerFingerprint: fixture.trigger.fingerprint,
        expectedClaimGeneration: 0,
        currentClaimGeneration: 2,
      });
      expect(runCount(store, fixture.itemId)).toBe(0);
      expect(getDispatchTriggerConsumptionReceipt(store, fixture.trigger.idempotencyKey)).toBeNull();
    } finally {
      store.close();
    }
  });

  test("a moved application binding makes an unconsumed trigger stale", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const fixture = await setup(store, "stale-binding");
      await fixture.bindings.retireApplicationLaneBinding({
        project: "stensibly",
        bindingId: fixture.bindingId,
        expectedGeneration: 1,
        retiredAt: "2026-08-27T02:00:00.500Z",
        idempotencyKey: "retire-before-trigger-consumption",
      });

      expect(consumeApplicationLaneDispatchTrigger(store, {
        trigger: fixture.trigger,
        dispatch: dispatchInput(),
      }, consumedAt)).toEqual({
        status: "stale_source",
        triggerFingerprint: fixture.trigger.fingerprint,
      });
      expect(store.getItem(fixture.itemId)).toMatchObject({ status: "ready", claimGeneration: 0 });
      expect(runCount(store, fixture.itemId)).toBe(0);
    } finally {
      store.close();
    }
  });

  test("a trigger without a durable Stensibly wake source cannot dispatch", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const fixture = await setup(store, "missing-source", false);
      expect(consumeApplicationLaneDispatchTrigger(store, {
        trigger: fixture.trigger,
        dispatch: dispatchInput(),
      }, consumedAt)).toEqual({
        status: "stale_source",
        triggerFingerprint: fixture.trigger.fingerprint,
      });
      expect(runCount(store, fixture.itemId)).toBe(0);
    } finally {
      store.close();
    }
  });

  test("a self-consistent generic trigger cannot relabel another durable wake source", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const fixture = await setup(store, "source-mismatch");
      const otherItem = store.createItem({
        project: "stensibly",
        kind: "task",
        title: "Other trigger target",
        nextAction: "Remain unrelated.",
        priority: 1,
        actor,
      });
      const forged = buildDispatchTriggerV1({
        triggerClass: "wake_intent",
        project: "stensibly",
        itemId: otherItem.id,
        expectedClaimGeneration: 0,
        sourceRef: fixture.wake.idempotencyKey,
        sourceFingerprint: fixture.wake.fingerprint,
      });

      expect(() => consumeApplicationLaneDispatchTrigger(store, {
        trigger: forged,
        dispatch: dispatchInput(),
      }, consumedAt)).toThrow(DispatchTriggerConsumptionConflictError);
      expect(store.getItem(otherItem.id)).toMatchObject({ status: "ready", claimGeneration: 0 });
    } finally {
      store.close();
    }
  });

  test("receipt insert failure rolls the nested claim and queued run back", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const fixture = await setup(store, "receipt-rollback");
      ensureRunSchema(store);
      ensureDispatchTriggerConsumptionSchema(store);
      store.db.exec(`
        CREATE TRIGGER fail_dispatch_trigger_consumption_insert
        BEFORE INSERT ON dispatch_trigger_consumptions
        BEGIN
          SELECT RAISE(ABORT, 'forced consumption receipt failure');
        END;
      `);

      expect(() => consumeApplicationLaneDispatchTrigger(store, {
        trigger: fixture.trigger,
        dispatch: dispatchInput(),
      }, consumedAt)).toThrow();

      expect(store.getItem(fixture.itemId)).toMatchObject({
        status: "ready",
        claimedBy: null,
        claimGeneration: 0,
      });
      expect(runCount(store, fixture.itemId)).toBe(0);
      expect(getDispatchTriggerConsumptionReceipt(store, fixture.trigger.idempotencyKey)).toBeNull();
    } finally {
      store.close();
    }
  });

  test("an exact consumption replay survives later application-binding movement", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const fixture = await setup(store, "historical-replay");
      const first = consumeApplicationLaneDispatchTrigger(store, {
        trigger: fixture.trigger,
        dispatch: dispatchInput(),
      }, consumedAt);
      if (first.status !== "consumed") throw new Error("expected consumed fixture");

      await fixture.bindings.retireApplicationLaneBinding({
        project: "stensibly",
        bindingId: fixture.bindingId,
        expectedGeneration: 1,
        retiredAt: "2026-08-27T02:30:00.000Z",
        idempotencyKey: "retire-after-trigger-consumption",
      });
      const replay = consumeApplicationLaneDispatchTrigger(store, {
        trigger: fixture.trigger,
        dispatch: dispatchInput(),
      }, new Date("2026-08-27T04:00:00.000Z"));
      expect(replay).toEqual({ status: "consumed", replay: true, receipt: first.receipt });
    } finally {
      store.close();
    }
  });

  test("direct receipt reads fail closed on durable corruption", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const fixture = await setup(store, "receipt-corruption");
      const outcome = consumeApplicationLaneDispatchTrigger(store, {
        trigger: fixture.trigger,
        dispatch: dispatchInput(),
      }, consumedAt);
      expect(outcome.status).toBe("consumed");
      store.db.query(`
        UPDATE dispatch_trigger_consumptions
        SET receipt_fingerprint = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        WHERE trigger_idempotency_key = ?1
      `).run(fixture.trigger.idempotencyKey);

      expect(() => getDispatchTriggerConsumptionReceipt(store, fixture.trigger.idempotencyKey))
        .toThrow(DispatchTriggerConsumptionStorageError);
    } finally {
      store.close();
    }
  });
});

async function setup(store: StensiblyStore, suffix: string, persistWake = true) {
  const item = store.createItem({
    project: "stensibly",
    kind: "task",
    title: `Trigger consumption ${suffix}`,
    nextAction: "Consume only the exact durable application wake.",
    priority: 50,
    actor,
  });
  const bindingId = `binding:trigger-${suffix}`;
  const laneRef = `elatura:trigger-${suffix}`;
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
    createdAt: "2026-08-27T01:00:00.000Z",
    retiredAt: null,
  };
  const registration = {
    version: 1,
    id: `wake-registration:trigger-${suffix}`,
    generation: 1,
    project: "stensibly",
    itemId: item.id,
    claimGeneration: 0,
    bindingId,
    bindingGeneration: 1,
    laneRef,
    laneGeneration: 1,
    eventTypes: ["changed", "possible_completion"],
    createdAt: "2026-08-27T01:30:00.000Z",
    expiresAt: null,
  };
  const currentAuthority = {
    project: "stensibly",
    itemId: item.id,
    claimGeneration: 0,
  };
  const event = {
    version: 1,
    eventId: `lane-event:trigger-${suffix}`,
    laneRef,
    laneGeneration: 1,
    eventType: "changed",
    observedAt,
    confidence: "exact",
    freshness: "fresh",
    sourceRefs: [`source:trigger-${suffix}`],
    grantsWorkAuthority: false,
    authorizesWorkDispatch: false,
  };
  const bindings = new SqliteApplicationLaneBindingStore(store);
  await bindings.bindApplicationLane({
    binding: currentBinding,
    idempotencyKey: `bind-trigger-${suffix}`,
  });

  let wake;
  if (persistWake) {
    wake = recordApplicationLaneWakeIntent(store, {
      registration,
      currentBinding,
      currentAuthority,
      event,
    }, new Date("2026-08-27T02:00:00.500Z"));
  } else {
    const decision = compileApplicationLaneWakeIntentV1(
      registration,
      currentBinding,
      currentAuthority,
      event,
    );
    if (!decision.wakeIntent) throw new Error("trigger fixture did not compile a wake");
    wake = decision.wakeIntent;
  }
  const trigger = applicationLaneWakeToDispatchTriggerV1(wake);
  return { itemId: item.id, bindingId, bindings, wake, trigger };
}

function runCount(store: StensiblyStore, itemId: string): number {
  ensureRunSchema(store);
  const row = store.db
    .query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM work_runs WHERE item_id = ?1",
    )
    .get(itemId);
  return row?.count ?? 0;
}
