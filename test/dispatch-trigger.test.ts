import { describe, expect, test } from "bun:test";
import { compileApplicationLaneWakeIntentV1 } from "../src/application-lane-wake-intent.js";
import {
  applicationLaneWakeToDispatchTriggerV1,
  buildDispatchTriggerV1,
  parseDispatchTriggerV1,
} from "../src/dispatch-trigger.js";

function compileWake(claimGeneration = 0) {
  const decision = compileApplicationLaneWakeIntentV1(
    {
      version: 1,
      id: "wake-registration:chat-1",
      generation: 3,
      project: "stensibly",
      itemId: "item:work-1",
      claimGeneration,
      bindingId: "binding:chat-1",
      bindingGeneration: 2,
      laneRef: "elatura:chat-1",
      laneGeneration: 4,
      eventTypes: ["changed", "possible_completion"],
      createdAt: "2026-08-26T18:00:00.000Z",
      expiresAt: null,
    },
    {
      version: 1,
      id: "binding:chat-1",
      generation: 2,
      project: "stensibly",
      itemId: "item:work-1",
      provider: "elatura",
      laneRef: "elatura:chat-1",
      laneGeneration: 4,
      capabilities: ["events", "observe", "activate"],
      createdAt: "2026-08-26T17:00:00.000Z",
      retiredAt: null,
    },
    {
      project: "stensibly",
      itemId: "item:work-1",
      claimGeneration,
    },
    {
      version: 1,
      eventId: "lane-event:42",
      laneRef: "elatura:chat-1",
      laneGeneration: 4,
      eventType: "changed",
      observedAt: "2026-08-26T18:05:00.000Z",
      confidence: "exact",
      freshness: "fresh",
      sourceRefs: ["source:local-change"],
      grantsWorkAuthority: false,
      authorizesWorkDispatch: false,
    },
  );
  expect(decision.matched).toBe(true);
  expect(decision.wakeIntent).not.toBeNull();
  return decision.wakeIntent!;
}

describe("dispatch_trigger/v1", () => {
  test("normalizes generation-zero application wake eligibility without granting dispatch", () => {
    const wake = compileWake(0);
    const trigger = applicationLaneWakeToDispatchTriggerV1(wake);

    expect(trigger).toEqual({
      version: 1,
      kind: "dispatch_trigger",
      triggerClass: "wake_intent",
      project: "stensibly",
      itemId: "item:work-1",
      expectedClaimGeneration: 0,
      sourceRef: wake.idempotencyKey,
      sourceFingerprint: wake.fingerprint,
      grantsAuthority: false,
      authorizesDispatch: false,
      fingerprint: trigger.fingerprint,
      idempotencyKey: trigger.idempotencyKey,
    });
    expect(trigger.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(trigger.idempotencyKey).toBe(
      `dispatch-trigger:${trigger.fingerprint.slice("sha256:".length)}`,
    );
  });

  test("keeps application-specific fields behind the opaque source reference", () => {
    const trigger = applicationLaneWakeToDispatchTriggerV1(compileWake());
    const keys = Object.keys(trigger).sort();

    expect(keys).toEqual([
      "authorizesDispatch",
      "expectedClaimGeneration",
      "fingerprint",
      "grantsAuthority",
      "idempotencyKey",
      "itemId",
      "kind",
      "project",
      "sourceFingerprint",
      "sourceRef",
      "triggerClass",
      "version",
    ]);
    expect("laneRef" in trigger).toBe(false);
    expect("laneGeneration" in trigger).toBe(false);
    expect("bindingId" in trigger).toBe(false);
    expect("eventType" in trigger).toBe(false);
    expect("runnerProfile" in trigger).toBe(false);
    expect("priority" in trigger).toBe(false);
  });

  test("exact wake replay produces the same trigger and claim-generation movement changes identity", () => {
    const first = applicationLaneWakeToDispatchTriggerV1(compileWake(0));
    const replay = applicationLaneWakeToDispatchTriggerV1(compileWake(0));
    const nextGeneration = applicationLaneWakeToDispatchTriggerV1(compileWake(1));

    expect(replay).toEqual(first);
    expect(nextGeneration.expectedClaimGeneration).toBe(1);
    expect(nextGeneration.fingerprint).not.toBe(first.fingerprint);
    expect(nextGeneration.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  test("supports explicit current eligibility through the same provider-neutral contract", () => {
    const trigger = buildDispatchTriggerV1({
      triggerClass: "explicit_current",
      project: "stensibly",
      itemId: "item:manual-1",
      expectedClaimGeneration: 7,
      sourceRef: "eligibility:operator-request-1",
      sourceFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(trigger.triggerClass).toBe("explicit_current");
    expect(trigger.expectedClaimGeneration).toBe(7);
    expect(trigger.grantsAuthority).toBe(false);
    expect(trigger.authorizesDispatch).toBe(false);
    expect(parseDispatchTriggerV1(trigger)).toEqual(trigger);
  });

  test("rejects tampered application wake bytes before trigger creation", () => {
    const wake = compileWake();

    expect(() => applicationLaneWakeToDispatchTriggerV1({
      ...wake,
      claimGeneration: wake.claimGeneration + 1,
    })).toThrow("Application lane wake intent fingerprint is invalid");

    expect(() => applicationLaneWakeToDispatchTriggerV1({
      ...wake,
      authorizesDispatch: true,
    })).toThrow("Application lane wake intent must authorize zero dispatch");

    expect(() => applicationLaneWakeToDispatchTriggerV1({
      ...wake,
      tabId: 19,
    })).toThrow("Application lane wake intent contains unsupported field tabId");
  });

  test("rejects trigger tampering even when the outer fields remain well formed", () => {
    const trigger = applicationLaneWakeToDispatchTriggerV1(compileWake());

    expect(() => parseDispatchTriggerV1({
      ...trigger,
      expectedClaimGeneration: trigger.expectedClaimGeneration + 1,
    })).toThrow("Dispatch trigger fingerprint is invalid");

    expect(() => parseDispatchTriggerV1({
      ...trigger,
      authorizesDispatch: true,
    })).toThrow("Dispatch trigger must authorize zero dispatch");
  });

  test("rejects negative zero and routing decorations at the generic boundary", () => {
    expect(() => buildDispatchTriggerV1({
      triggerClass: "wake_intent",
      project: "stensibly",
      itemId: "item:work-1",
      expectedClaimGeneration: -0,
      sourceRef: "wake:1",
      sourceFingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    })).toThrow("Dispatch trigger expected claim generation must be a non-negative safe integer");

    expect(() => buildDispatchTriggerV1({
      triggerClass: "wake_intent",
      project: "stensibly",
      itemId: "item:work-1",
      expectedClaimGeneration: 0,
      sourceRef: "wake:1",
      sourceFingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      routingLevel: "urgent",
    })).toThrow("Dispatch trigger input contains unsupported field routingLevel");
  });

  test("contains hostile top-level inspection without executing accessors", () => {
    let getterCalls = 0;
    const input = Object.defineProperty({
      triggerClass: "explicit_current",
      project: "stensibly",
      itemId: "item:manual-1",
      expectedClaimGeneration: 0,
      sourceRef: "eligibility:1",
      sourceFingerprint: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    }, "sourceRef", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "eligibility:hostile";
      },
    });

    expect(() => buildDispatchTriggerV1(input)).toThrow(
      "Dispatch trigger input must contain enumerable data properties",
    );
    expect(getterCalls).toBe(0);

    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => buildDispatchTriggerV1(proxy)).toThrow("Dispatch trigger input inspection failed");
  });
});
