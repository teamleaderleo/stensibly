import { expect, test } from "bun:test";
import { consumeApplicationLaneDispatchTrigger } from "../src/dispatch-trigger-consumption.ts";
import { buildDispatchTriggerV1 } from "../src/dispatch-trigger.ts";
import { StensiblyStore } from "../src/store.ts";

test("trigger consumption does not freeze caller-owned nested input objects", () => {
  const store = new StensiblyStore(":memory:");
  try {
    const canonicalTrigger = buildDispatchTriggerV1({
      triggerClass: "wake_intent",
      project: "stensibly",
      itemId: "item:caller-owned-input",
      expectedClaimGeneration: 0,
      sourceRef: `application-lane-wake:${"a".repeat(64)}`,
      sourceFingerprint: `sha256:${"b".repeat(64)}`,
    });
    const trigger: Record<string, unknown> = { ...canonicalTrigger };
    const actor = {
      id: "service:caller-owned-input",
      name: "Caller owned input",
      kind: "service",
    };
    const executionEnvelope = {
      marker: "caller-owned",
      nested: { mutable: true },
    };
    const dispatch = {
      actor,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      executionEnvelope,
    };

    expect(Object.isFrozen(trigger)).toBe(false);
    expect(Object.isFrozen(dispatch)).toBe(false);
    expect(Object.isFrozen(actor)).toBe(false);
    expect(Object.isFrozen(executionEnvelope)).toBe(false);
    expect(Object.isFrozen(executionEnvelope.nested)).toBe(false);

    expect(consumeApplicationLaneDispatchTrigger(store, {
      trigger,
      dispatch,
    })).toEqual({
      status: "stale_source",
      triggerFingerprint: canonicalTrigger.fingerprint,
    });

    expect(Object.isFrozen(trigger)).toBe(false);
    expect(Object.isFrozen(dispatch)).toBe(false);
    expect(Object.isFrozen(actor)).toBe(false);
    expect(Object.isFrozen(executionEnvelope)).toBe(false);
    expect(Object.isFrozen(executionEnvelope.nested)).toBe(false);

    trigger.itemId = "item:caller-mutated-after-call";
    actor.name = "Caller mutated after call";
    executionEnvelope.marker = "mutated";
    executionEnvelope.nested.mutable = false;

    expect(trigger.itemId).toBe("item:caller-mutated-after-call");
    expect(actor.name).toBe("Caller mutated after call");
    expect(executionEnvelope.marker).toBe("mutated");
    expect(executionEnvelope.nested.mutable).toBe(false);
  } finally {
    store.close();
  }
});
