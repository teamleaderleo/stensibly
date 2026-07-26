import { describe, expect, test } from "bun:test";
import { projectItemControl } from "../src/item-control.ts";

const now = new Date("2026-07-26T12:00:00.000Z");
const activeItem = {
  kind: "task",
  status: "active",
  summary: "Current dispatcher evidence.",
  nextAction: "Validate the exact current grant.",
  claimedBy: "service:supervisor",
  claimExpiresAt: "2026-07-26T12:15:00.000Z",
  claimGeneration: 4,
};
const dispatcherEvent = {
  actorId: "service:supervisor",
  type: "claim.created",
  payload: { generation: 4, source: "supervisor_dispatch" },
};

describe("dispatcher evidence completeness", () => {
  test("fails closed when an exact dispatcher claim has no matching run", () => {
    const control = projectItemControl({
      item: activeItem,
      events: [dispatcherEvent],
      runs: [],
      now,
    });

    expect(control.authority).toMatchObject({
      state: "superseded",
      holderActorId: null,
      source: "none",
      allowedOperations: [],
    });
  });

  test("fails closed when a matching run has a malformed lease timestamp", () => {
    const control = projectItemControl({
      item: activeItem,
      events: [dispatcherEvent],
      runs: [{
        actorId: "service:supervisor",
        leaseOwnerId: "service:supervisor",
        status: "running",
        leaseExpiresAt: "not-a-timestamp",
        lastHeartbeatAt: "2026-07-26T12:00:00.000Z",
      }],
      now,
    });

    expect(control.authority).toMatchObject({
      state: "superseded",
      holderActorId: null,
      source: "none",
      allowedOperations: [],
    });
  });
});
