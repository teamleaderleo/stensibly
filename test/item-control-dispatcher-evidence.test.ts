import { describe, expect, test } from "bun:test";
import { projectItemControl } from "../src/item-control.ts";

const now = new Date("2026-07-26T12:00:00.000Z");
const expiresAt = "2026-07-26T12:15:00.000Z";
const createdAt = "2026-07-26T12:00:00.000Z";
const activeItem = {
  kind: "task",
  status: "active",
  summary: "Current dispatcher evidence.",
  nextAction: "Validate the exact current grant.",
  claimedBy: "service:supervisor",
  claimExpiresAt: expiresAt,
  claimGeneration: 4,
};
const dispatcherEvents = [
  {
    actorId: "service:supervisor",
    type: "claim.created",
    payload: {
      generation: 4,
      expiresAt,
      source: "supervisor_dispatch",
    },
    createdAt,
  },
  {
    actorId: "service:supervisor",
    type: "run.queued",
    payload: {
      runId: "run_current",
      generation: 1,
      leaseGeneration: 1,
      leaseExpiresAt: expiresAt,
      source: "supervisor_dispatch",
    },
    createdAt,
  },
];

describe("dispatcher evidence completeness", () => {
  test("fails closed when an exact dispatcher claim has no matching run", () => {
    const control = projectItemControl({
      item: activeItem,
      events: dispatcherEvents,
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

  test("fails closed when the exact run has a malformed lease timestamp", () => {
    const control = projectItemControl({
      item: activeItem,
      events: dispatcherEvents,
      runs: [{
        id: "run_current",
        actorId: "service:supervisor",
        leaseOwnerId: "service:supervisor",
        status: "running",
        leaseExpiresAt: "not-a-timestamp",
        lastHeartbeatAt: createdAt,
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
