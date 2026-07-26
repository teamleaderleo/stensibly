import { expect, test } from "bun:test";
import { projectItemControl } from "../src/item-control.ts";

test("malformed blocked claim fields fail closed", () => {
  const control = projectItemControl({
    item: {
      kind: "task",
      status: "blocked",
      summary: "Waiting on review.",
      nextAction: "Ask the reviewer.",
      claimedBy: 42,
      claimExpiresAt: "not-a-timestamp",
      claimGeneration: 4,
    },
    now: new Date("2026-07-26T12:00:00.000Z"),
  });

  expect(control.authority).toMatchObject({
    state: "superseded",
    holderActorId: null,
    generation: 4,
    source: "none",
    allowedOperations: [],
  });
});
