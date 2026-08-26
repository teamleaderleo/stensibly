import { expect, test } from "bun:test";
import { compileApplicationLaneWakeIntentV1 } from "../src/application-lane-wake-intent.js";
import { applicationLaneWakeToDispatchTriggerV1 } from "../src/dispatch-trigger.js";

function currentWake() {
  const decision = compileApplicationLaneWakeIntentV1(
    {
      version: 1,
      id: "wake-registration:source-list",
      generation: 1,
      project: "stensibly",
      itemId: "item:source-list",
      claimGeneration: 0,
      bindingId: "binding:source-list",
      bindingGeneration: 1,
      laneRef: "elatura:source-list",
      laneGeneration: 1,
      eventTypes: ["changed"],
      createdAt: "2026-08-26T18:00:00.000Z",
      expiresAt: null,
    },
    {
      version: 1,
      id: "binding:source-list",
      generation: 1,
      project: "stensibly",
      itemId: "item:source-list",
      provider: "elatura",
      laneRef: "elatura:source-list",
      laneGeneration: 1,
      capabilities: ["events"],
      createdAt: "2026-08-26T17:00:00.000Z",
      retiredAt: null,
    },
    {
      project: "stensibly",
      itemId: "item:source-list",
      claimGeneration: 0,
    },
    {
      version: 1,
      eventId: "lane-event:source-list",
      laneRef: "elatura:source-list",
      laneGeneration: 1,
      eventType: "changed",
      observedAt: "2026-08-26T18:01:00.000Z",
      confidence: "exact",
      freshness: "fresh",
      sourceRefs: ["source:first"],
      grantsWorkAuthority: false,
      authorizesWorkDispatch: false,
    },
  );
  if (!decision.wakeIntent) throw new Error("fixture did not compile a wake intent");
  return decision.wakeIntent;
}

test("dispatch trigger wake admission rejects array decoration ignored by JSON element encoding", () => {
  const wake = currentWake();
  const decorated = [...wake.sourceRefs] as string[] & { extra?: string };
  decorated.extra = "source:decoration";

  expect(() => applicationLaneWakeToDispatchTriggerV1({
    ...wake,
    sourceRefs: decorated,
  })).toThrow("Wake source references contains unsupported field extra");
});
