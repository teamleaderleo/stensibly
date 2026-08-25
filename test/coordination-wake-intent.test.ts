import { describe, expect, test } from "bun:test";
import {
  compileCoordinationWakeIntentV1,
  parseCoordinationEventObservationV1,
  parseCoordinationEventSubscriptionV1,
} from "../src/coordination-wake-intent.ts";

const subscription = {
  version: 1,
  id: "subscription:parent-a:child-b",
  generation: 3,
  project: "stensibly",
  sourceItemId: "item:child-b",
  sourceCorrelationId: "workflow:parent-a:child-b",
  eventTypes: ["run.succeeded", "run.blocked", "run.failed"],
  targetItemId: "item:parent-a",
  targetGeneration: 11,
  minimumRoutingLevel: "attention",
  createdAt: "2026-08-25T09:00:00.000Z",
  expiresAt: "2026-08-25T10:00:00.000Z",
} as const;

const event = {
  eventId: "event:child-b:completed:1",
  project: "stensibly",
  sourceItemId: "item:child-b",
  correlationId: "workflow:parent-a:child-b",
  eventType: "run.succeeded",
  routingLevel: "attention",
  sourceRunId: "run:child-b:epoch-1",
  observedAt: "2026-08-25T09:05:00.000Z",
  sourceRefs: ["run:child-b:epoch-1", "revision:abc1234"],
} as const;

describe("cross-item coordination wake intents", () => {
  test("compiles one deterministic authority-free wake intent for a material child event", () => {
    const decision = compileCoordinationWakeIntentV1(subscription, event);

    expect(decision).toMatchObject({
      version: 1,
      matched: true,
      reason: "matched",
      subscription: {
        id: subscription.id,
        generation: subscription.generation,
      },
      sourceEventId: event.eventId,
      targetItemId: subscription.targetItemId,
      targetGeneration: subscription.targetGeneration,
    });
    expect(decision.wakeIntent).toMatchObject({
      version: 1,
      kind: "target_item_wakeup",
      project: "stensibly",
      sourceItemId: subscription.sourceItemId,
      sourceCorrelationId: subscription.sourceCorrelationId,
      sourceRunId: event.sourceRunId,
      targetItemId: subscription.targetItemId,
      targetGeneration: subscription.targetGeneration,
      routingLevel: "attention",
      grantsAuthority: false,
      authorizesDispatch: false,
    });
    expect(decision.wakeIntent?.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(decision.wakeIntent?.idempotencyKey).toMatch(/^coordination-wake:[a-f0-9]{64}$/u);
    expect(decision.decisionFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.wakeIntent)).toBe(true);
    expect(Object.isFrozen(decision.wakeIntent?.sourceRefs)).toBe(true);
  });

  test("binds target responsibility generation into decision and idempotency identity", () => {
    const generation11 = compileCoordinationWakeIntentV1(subscription, event);
    const generation12 = compileCoordinationWakeIntentV1({
      ...subscription,
      targetGeneration: 12,
    }, event);

    expect(generation11.targetGeneration).toBe(11);
    expect(generation12.targetGeneration).toBe(12);
    expect(generation11.wakeIntent?.targetGeneration).toBe(11);
    expect(generation12.wakeIntent?.targetGeneration).toBe(12);
    expect(generation12.decisionFingerprint).not.toBe(generation11.decisionFingerprint);
    expect(generation12.wakeIntent?.fingerprint).not.toBe(generation11.wakeIntent?.fingerprint);
    expect(generation12.wakeIntent?.idempotencyKey).not.toBe(generation11.wakeIntent?.idempotencyKey);
  });

  test("treats event types and source references as semantic sets", () => {
    const first = compileCoordinationWakeIntentV1(subscription, event);
    const second = compileCoordinationWakeIntentV1(
      {
        ...subscription,
        eventTypes: [...subscription.eventTypes].reverse(),
      },
      {
        ...event,
        sourceRefs: [...event.sourceRefs].reverse(),
      },
    );

    expect(second).toEqual(first);
    expect(parseCoordinationEventSubscriptionV1({
      ...subscription,
      eventTypes: [...subscription.eventTypes].reverse(),
    }).eventTypes).toEqual([...subscription.eventTypes].sort());
  });

  test("keeps one durable child correlation across successor source runs", () => {
    const first = compileCoordinationWakeIntentV1(subscription, event);
    const successor = compileCoordinationWakeIntentV1(subscription, {
      ...event,
      eventId: "event:child-b:completed:2",
      sourceRunId: "run:child-b:epoch-2",
      observedAt: "2026-08-25T09:20:00.000Z",
    });

    expect(first.matched).toBe(true);
    expect(successor.matched).toBe(true);
    expect(successor.wakeIntent).toMatchObject({
      sourceCorrelationId: subscription.sourceCorrelationId,
      sourceRunId: "run:child-b:epoch-2",
      targetItemId: subscription.targetItemId,
      targetGeneration: subscription.targetGeneration,
    });
    expect(successor.wakeIntent?.fingerprint).not.toBe(first.wakeIntent?.fingerprint);
  });

  test("requires the configured materiality threshold without deriving materiality itself", () => {
    const routine = compileCoordinationWakeIntentV1(subscription, {
      ...event,
      routingLevel: "record",
    });
    const urgent = compileCoordinationWakeIntentV1(subscription, {
      ...event,
      eventId: "event:child-b:incident:1",
      routingLevel: "interrupt",
    });

    expect(routine).toMatchObject({
      matched: false,
      reason: "below_routing_threshold",
      wakeIntent: null,
    });
    expect(urgent).toMatchObject({
      matched: true,
      reason: "matched",
      wakeIntent: { routingLevel: "interrupt" },
    });
  });

  test("explains source, correlation, type, and project mismatches without producing wake intent", () => {
    const cases = [
      [{ ...event, project: "quarry" }, "project_mismatch"],
      [{ ...event, sourceItemId: "item:other-child" }, "source_item_mismatch"],
      [{ ...event, correlationId: "workflow:other" }, "correlation_mismatch"],
      [{ ...event, eventType: "run.heartbeat" }, "event_type_mismatch"],
    ] as const;

    for (const [candidate, reason] of cases) {
      expect(compileCoordinationWakeIntentV1(subscription, candidate)).toMatchObject({
        matched: false,
        reason,
        wakeIntent: null,
      });
    }
  });

  test("honors subscription lifetime at exact boundaries", () => {
    expect(compileCoordinationWakeIntentV1(subscription, {
      ...event,
      observedAt: "2026-08-25T08:59:59.999Z",
    })).toMatchObject({
      matched: false,
      reason: "subscription_not_started",
    });

    expect(compileCoordinationWakeIntentV1(subscription, {
      ...event,
      observedAt: subscription.createdAt,
    }).matched).toBe(true);

    expect(compileCoordinationWakeIntentV1(subscription, {
      ...event,
      observedAt: subscription.expiresAt,
    })).toMatchObject({
      matched: false,
      reason: "subscription_expired",
    });
  });

  test("rejects same-item subscriptions because local wake conditions own that case", () => {
    expect(() => parseCoordinationEventSubscriptionV1({
      ...subscription,
      targetItemId: subscription.sourceItemId,
    })).toThrow("different source and target items");
  });

  test("requires a positive target generation", () => {
    expect(() => parseCoordinationEventSubscriptionV1({
      ...subscription,
      targetGeneration: 0,
    })).toThrow("Target generation must be a positive safe integer");
  });

  test("admits dense data only and never executes caller accessors", () => {
    let getterReads = 0;
    const hostile = { ...subscription } as Record<string, unknown>;
    Object.defineProperty(hostile, "project", {
      enumerable: true,
      get() {
        getterReads += 1;
        return "stensibly";
      },
    });

    expect(() => parseCoordinationEventSubscriptionV1(hostile)).toThrow(
      "enumerable data properties",
    );
    expect(getterReads).toBe(0);

    const sparse = new Array<string>(2);
    sparse[0] = "run.succeeded";
    expect(() => parseCoordinationEventSubscriptionV1({
      ...subscription,
      eventTypes: sparse,
    })).toThrow("dense data");
  });

  test("rejects unsupported fields, duplicate event types, and credential-shaped references", () => {
    expect(() => parseCoordinationEventSubscriptionV1({
      ...subscription,
      managerRank: "portfolio",
    })).toThrow("unsupported field managerRank");

    expect(() => parseCoordinationEventSubscriptionV1({
      ...subscription,
      eventTypes: ["run.succeeded", "run.succeeded"],
    })).toThrow("must not contain duplicates");

    expect(() => parseCoordinationEventObservationV1({
      ...event,
      sourceRefs: ["ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    })).toThrow("credential-shaped text");
  });
});
