import { describe, expect, test } from "bun:test";
import {
  buildApplicationWorkBindingV1,
  matchApplicationLaneEventV1,
  parseElaturaApplicationLaneEventV1,
} from "../src/application-lane-binding.ts";

const binding = {
  version: 1,
  id: "binding:work-a:elatura-chat-a",
  generation: 3,
  project: "stensibly",
  itemId: "item:work-a",
  provider: "elatura",
  laneRef: "elatura:lane:chat-a",
  laneGeneration: 7,
  capabilities: ["screenshot", "events", "activate", "observe"],
  createdAt: "2026-08-26T17:00:00.000Z",
  retiredAt: null,
} as const;

const event = {
  version: 1,
  eventId: "elatura:event:chat-a:42",
  laneRef: binding.laneRef,
  laneGeneration: binding.laneGeneration,
  eventType: "changed",
  observedAt: "2026-08-26T17:05:00.000Z",
  confidence: "exact",
  freshness: "fresh",
  sourceRefs: ["elatura:signal:42", "elatura:observation:42"],
  grantsWorkAuthority: false,
  authorizesWorkDispatch: false,
} as const;

describe("Elatura application work binding", () => {
  test("binds one durable work item to one opaque lane generation", () => {
    const parsed = buildApplicationWorkBindingV1(binding);

    expect(parsed).toMatchObject({
      itemId: "item:work-a",
      provider: "elatura",
      laneRef: "elatura:lane:chat-a",
      laneGeneration: 7,
      grantsWorkAuthority: false,
      grantsApplicationAuthority: false,
    });
    expect(parsed).not.toHaveProperty("itemGeneration");
    expect(parsed).not.toHaveProperty("claimGeneration");
    expect(parsed.capabilities).toEqual(["activate", "events", "observe", "screenshot"]);
    expect(parsed.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.capabilities)).toBe(true);
  });

  test("treats capability order as a semantic set", () => {
    const first = buildApplicationWorkBindingV1(binding);
    const second = buildApplicationWorkBindingV1({
      ...binding,
      capabilities: [...binding.capabilities].reverse(),
    });

    expect(second).toEqual(first);
  });

  test("keeps claim/responsibility generations with their owning wake and dispatch contracts", () => {
    expect(() => buildApplicationWorkBindingV1({ ...binding, itemGeneration: 11 })).toThrow(
      "unsupported field itemGeneration",
    );
    expect(() => buildApplicationWorkBindingV1({ ...binding, claimGeneration: 11 })).toThrow(
      "unsupported field claimGeneration",
    );
  });

  test("rejects browser implementation identity at the binding boundary", () => {
    expect(() => buildApplicationWorkBindingV1({ ...binding, tabId: 123 })).toThrow(
      "unsupported field tabId",
    );
    expect(() => buildApplicationWorkBindingV1({ ...binding, browserProfile: "profile-a" })).toThrow(
      "unsupported field browserProfile",
    );
  });

  test("projects a matching lane event into an authority-free provider observation", () => {
    const decision = matchApplicationLaneEventV1(binding, event);

    expect(decision).toMatchObject({
      version: 1,
      matched: true,
      reason: "matched",
      sourceEventId: event.eventId,
      binding: { id: binding.id, generation: binding.generation },
      observation: {
        kind: "provider_observation",
        project: "stensibly",
        provider: "elatura",
        eventType: "lane.changed",
        sourceObjectRef: binding.laneRef,
        sourceObjectGeneration: binding.laneGeneration,
        itemId: binding.itemId,
        confidence: "exact",
        freshness: "fresh",
        grantsWorkAuthority: false,
        authorizesDispatch: false,
      },
    });
    expect(decision.observation).not.toHaveProperty("itemGeneration");
    expect(decision.observation).not.toHaveProperty("claimGeneration");
    expect(decision.observation?.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(decision.observation?.idempotencyKey).toMatch(/^application-lane-observation:[a-f0-9]{64}$/u);
    expect(decision.decisionFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  test("preserves the Elatura signal vocabulary without assigning work semantics", () => {
    const possibleCompletion = matchApplicationLaneEventV1(binding, {
      ...event,
      eventId: "elatura:event:chat-a:43",
      eventType: "possible_completion",
      confidence: "probable",
    });
    const unavailable = matchApplicationLaneEventV1(binding, {
      ...event,
      eventId: "elatura:event:chat-a:44",
      eventType: "discarded_or_unavailable",
      freshness: "stale",
    });

    expect(possibleCompletion.observation).toMatchObject({
      eventType: "lane.possible_completion",
      confidence: "probable",
    });
    expect(unavailable.observation).toMatchObject({
      eventType: "lane.discarded_or_unavailable",
      freshness: "stale",
    });
    expect(possibleCompletion.observation).not.toHaveProperty("routingLevel");
    expect(possibleCompletion.observation).not.toHaveProperty("priority");
    expect(possibleCompletion.observation).not.toHaveProperty("nextWork");
  });

  test("keeps exact replay deterministic without classifying work materiality", () => {
    const first = matchApplicationLaneEventV1(binding, event);
    const second = matchApplicationLaneEventV1(binding, {
      ...event,
      sourceRefs: [...event.sourceRefs].reverse(),
    });

    expect(second).toEqual(first);
  });

  test("fences semantic lane retargeting by generation", () => {
    expect(matchApplicationLaneEventV1(binding, { ...event, laneGeneration: 8 })).toMatchObject({
      matched: false,
      reason: "lane_generation_mismatch",
      observation: null,
    });

    expect(matchApplicationLaneEventV1(binding, {
      ...event,
      laneRef: "elatura:lane:other-chat",
    })).toMatchObject({
      matched: false,
      reason: "lane_ref_mismatch",
      observation: null,
    });
  });

  test("honors binding lifetime at exact boundaries", () => {
    const retired = {
      ...binding,
      retiredAt: "2026-08-26T18:00:00.000Z",
    } as const;

    expect(matchApplicationLaneEventV1(retired, {
      ...event,
      observedAt: "2026-08-26T16:59:59.999Z",
    })).toMatchObject({ matched: false, reason: "event_before_binding" });
    expect(matchApplicationLaneEventV1(retired, {
      ...event,
      observedAt: retired.createdAt,
    }).matched).toBe(true);
    expect(matchApplicationLaneEventV1(retired, {
      ...event,
      observedAt: retired.retiredAt,
    })).toMatchObject({ matched: false, reason: "binding_retired" });
  });

  test("requires browser events to remain authority-free", () => {
    expect(() => parseElaturaApplicationLaneEventV1({ ...event, grantsWorkAuthority: true })).toThrow(
      "zero work authority",
    );
    expect(() => parseElaturaApplicationLaneEventV1({ ...event, authorizesWorkDispatch: true })).toThrow(
      "zero work dispatch",
    );
  });

  test("rejects routing or browser fields in admitted lane events", () => {
    expect(() => parseElaturaApplicationLaneEventV1({ ...event, routingLevel: "interrupt" })).toThrow(
      "unsupported field routingLevel",
    );
    expect(() => parseElaturaApplicationLaneEventV1({ ...event, selector: "[data-message-id]" })).toThrow(
      "unsupported field selector",
    );
  });

  test("never executes caller accessors", () => {
    let getterReads = 0;
    const hostile = { ...binding } as Record<string, unknown>;
    Object.defineProperty(hostile, "laneRef", {
      enumerable: true,
      get() {
        getterReads += 1;
        return "elatura:lane:chat-a";
      },
    });

    expect(() => buildApplicationWorkBindingV1(hostile)).toThrow("enumerable data properties");
    expect(getterReads).toBe(0);
  });
});
