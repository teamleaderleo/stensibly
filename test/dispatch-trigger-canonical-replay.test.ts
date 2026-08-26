import { expect, test } from "bun:test";
import { buildDispatchTriggerV1, parseDispatchTriggerV1 } from "../src/dispatch-trigger.js";

test("dispatch trigger replay rejects normalized identity aliases", () => {
  const trigger = buildDispatchTriggerV1({
    triggerClass: "explicit_current",
    project: "stensibly",
    itemId: "item:canonical-replay",
    expectedClaimGeneration: 0,
    sourceRef: "eligibility:canonical-replay",
    sourceFingerprint: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  });

  expect(() => parseDispatchTriggerV1({
    ...trigger,
    itemId: ` ${trigger.itemId}`,
  })).toThrow("Dispatch trigger fields are not canonical");
});
