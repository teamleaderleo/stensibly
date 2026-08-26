import { describe, expect, test } from "bun:test";
import {
  compileApplicationLaneWakeIntentV1,
  parseApplicationLaneWakeRegistrationV1,
} from "../src/application-lane-wake-intent.ts";

const binding = {
  version: 1,
  id: "binding:work-a:lane-a",
  generation: 3,
  project: "stensibly",
  itemId: "item:work-a",
  provider: "elatura",
  laneRef: "elatura:lane:chat-a",
  laneGeneration: 7,
  capabilities: ["events", "observe", "activate", "screenshot"],
  createdAt: "2026-08-27T00:00:00.000Z",
  retiredAt: null,
} as const;

const registration = {
  version: 1,
  id: "wake:work-a:chat-a",
  generation: 2,
  project: "stensibly",
  itemId: binding.itemId,
  claimGeneration: 0,
  bindingId: binding.id,
  bindingGeneration: binding.generation,
  laneRef: binding.laneRef,
  laneGeneration: binding.laneGeneration,
  eventTypes: ["changed", "possible_completion", "recovery_needed"],
  createdAt: "2026-08-27T00:05:00.000Z",
  expiresAt: "2026-08-27T01:00:00.000Z",
} as const;

const authority = {
  project: "stensibly",
  itemId: binding.itemId,
  claimGeneration: 0,
} as const;

const event = {
  version: 1,
  eventId: "elatura:event:chat-a:42",
  laneRef: binding.laneRef,
  laneGeneration: binding.laneGeneration,
  eventType: "changed",
  observedAt: "2026-08-27T00:10:00.000Z",
  confidence: "exact",
  freshness: "fresh",
  sourceRefs: ["elatura:signal:42", "elatura:observation:42"],
  grantsWorkAuthority: false,
  authorizesWorkDispatch: false,
} as const;

describe("same-item application lane wake intents", () => {
  test("compiles generation-zero current work into one authority-free wake intent", () => {
    const decision = compileApplicationLaneWakeIntentV1(
      registration,
      binding,
      authority,
      event,
    );

    expect(decision).toMatchObject({
      version: 1,
      matched: true,
      reason: "matched",
      itemId: binding.itemId,
      claimGeneration: 0,
      sourceEventId: event.eventId,
      wakeIntent: {
        kind: "application_lane_item_wakeup",
        project: "stensibly",
        itemId: binding.itemId,
        claimGeneration: 0,
        bindingId: binding.id,
        bindingGeneration: binding.generation,
        laneRef: binding.laneRef,
        laneGeneration: binding.laneGeneration,
        sourceEventId: event.eventId,
        eventType: "changed",
        confidence: "exact",
        freshness: "fresh",
        grantsAuthority: false,
        authorizesDispatch: false,
      },
    });
    expect(decision.wakeIntent?.sourceRefs).toEqual([...event.sourceRefs].sort());
    expect(decision.wakeIntent?.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(decision.wakeIntent?.idempotencyKey).toMatch(/^application-lane-wake:[a-f0-9]{64}$/u);
    expect(decision.decisionFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.wakeIntent)).toBe(true);
  });

  test("exact replay and semantic event-type sets are deterministic", () => {
    const first = compileApplicationLaneWakeIntentV1(registration, binding, authority, event);
    const second = compileApplicationLaneWakeIntentV1(
      { ...registration, eventTypes: [...registration.eventTypes].reverse() },
      { ...binding, capabilities: [...binding.capabilities].reverse() },
      authority,
      { ...event, sourceRefs: [...event.sourceRefs].reverse() },
    );

    expect(second).toEqual(first);
  });

  test("a changed claim generation leaves the durable application binding valid but makes the wake stale", () => {
    expect(compileApplicationLaneWakeIntentV1(
      registration,
      binding,
      { ...authority, claimGeneration: 1 },
      event,
    )).toMatchObject({
      matched: false,
      reason: "claim_generation_mismatch",
      wakeIntent: null,
    });

    expect(compileApplicationLaneWakeIntentV1(
      { ...registration, claimGeneration: 1 },
      binding,
      { ...authority, claimGeneration: 1 },
      event,
    )).toMatchObject({ matched: true, wakeIntent: { claimGeneration: 1 } });
  });

  test("retired or replaced binding generations cannot wake current work", () => {
    expect(compileApplicationLaneWakeIntentV1(
      registration,
      { ...binding, generation: 4 },
      authority,
      event,
    )).toMatchObject({
      matched: false,
      reason: "binding_generation_mismatch",
      wakeIntent: null,
    });

    expect(compileApplicationLaneWakeIntentV1(
      registration,
      { ...binding, retiredAt: "2026-08-27T00:30:00.000Z" },
      authority,
      event,
    )).toMatchObject({
      matched: false,
      reason: "binding_retired",
      wakeIntent: null,
    });
  });

  test("semantic lane retargeting fences both registration and source event", () => {
    expect(compileApplicationLaneWakeIntentV1(
      registration,
      { ...binding, laneGeneration: 8 },
      authority,
      { ...event, laneGeneration: 8 },
    )).toMatchObject({
      matched: false,
      reason: "lane_generation_mismatch",
      wakeIntent: null,
    });

    expect(compileApplicationLaneWakeIntentV1(
      registration,
      binding,
      authority,
      { ...event, laneGeneration: 8 },
    )).toMatchObject({
      matched: false,
      reason: "event_lane_generation_mismatch",
      wakeIntent: null,
    });
  });

  test("requires the current relation to declare event capability", () => {
    expect(compileApplicationLaneWakeIntentV1(
      registration,
      { ...binding, capabilities: ["observe", "activate", "screenshot"] },
      authority,
      event,
    )).toMatchObject({
      matched: false,
      reason: "events_capability_missing",
      wakeIntent: null,
    });
  });

  test("Stensibly registration chooses which application-local event types deserve a wake", () => {
    expect(compileApplicationLaneWakeIntentV1(
      registration,
      binding,
      authority,
      { ...event, eventId: "elatura:event:chat-a:43", eventType: "idle" },
    )).toMatchObject({
      matched: false,
      reason: "event_type_mismatch",
      wakeIntent: null,
    });

    expect(compileApplicationLaneWakeIntentV1(
      registration,
      binding,
      authority,
      {
        ...event,
        eventId: "elatura:event:chat-a:44",
        eventType: "possible_completion",
        confidence: "probable",
        freshness: "stale",
      },
    )).toMatchObject({
      matched: true,
      wakeIntent: {
        eventType: "possible_completion",
        confidence: "probable",
        freshness: "stale",
      },
    });
  });

  test("honors registration lifetime at exact boundaries", () => {
    expect(compileApplicationLaneWakeIntentV1(
      registration,
      binding,
      authority,
      { ...event, observedAt: "2026-08-27T00:04:59.999Z" },
    )).toMatchObject({ matched: false, reason: "registration_not_started" });

    expect(compileApplicationLaneWakeIntentV1(
      registration,
      binding,
      authority,
      { ...event, observedAt: registration.createdAt },
    ).matched).toBe(true);

    expect(compileApplicationLaneWakeIntentV1(
      registration,
      binding,
      authority,
      { ...event, observedAt: registration.expiresAt },
    )).toMatchObject({ matched: false, reason: "registration_expired" });
  });

  test("keeps registration generation positive and claim generation non-negative", () => {
    expect(parseApplicationLaneWakeRegistrationV1(registration).claimGeneration).toBe(0);
    expect(() => parseApplicationLaneWakeRegistrationV1({
      ...registration,
      generation: 0,
    })).toThrow("Wake registration generation must be a positive safe integer");
    expect(() => parseApplicationLaneWakeRegistrationV1({
      ...registration,
      claimGeneration: -1,
    })).toThrow("Wake registration claim generation must be a non-negative safe integer");
  });

  test("rejects browser, routing, and authority fields at wake registration boundary", () => {
    for (const patch of [
      { tabId: 7 },
      { selector: "[data-message-id]" },
      { routingLevel: "interrupt" },
      { grantsAuthority: true },
    ]) {
      expect(() => parseApplicationLaneWakeRegistrationV1({
        ...registration,
        ...patch,
      })).toThrow("unsupported field");
    }
  });
});
