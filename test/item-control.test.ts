import { describe, expect, test } from "bun:test";
import {
  projectItemControl,
  type ItemControlItemInput,
} from "../src/item-control.ts";

const now = new Date("2026-07-26T12:00:00.000Z");

function item(overrides: Partial<ItemControlItemInput> = {}): ItemControlItemInput {
  return {
    kind: "task",
    status: "ready",
    summary: "Current context",
    nextAction: "Take the next bounded step.",
    claimedBy: null,
    claimExpiresAt: null,
    claimGeneration: 0,
    ...overrides,
  };
}

describe("canonical item control projection", () => {
  test("exposes ready and blocked work as unclaimed with status-specific operations", () => {
    const ready = projectItemControl({ item: item(), now });
    expect(ready).toMatchObject({
      schemaVersion: 1,
      authority: {
        state: "unclaimed",
        holderActorId: null,
        generation: 0,
        expiresAt: null,
        source: "none",
        allowedOperations: ["claim", "complete", "handoff", "block"],
        approvalRequiredOperations: [],
      },
      responsibility: {
        actorId: null,
        summary: "Current context",
        nextAction: "Take the next bounded step.",
        heartbeatExpectedAt: null,
        evidenceRequired: [],
        escalationState: "none",
      },
    });
    expect(ready.authority.unavailableReasons.renew).toContain("No live claim");

    const blocked = projectItemControl({
      item: item({
        status: "blocked",
        summary: "Waiting on review.",
        nextAction: "Ask the reviewer.",
        claimGeneration: 4,
      }),
      now,
    });
    expect(blocked.authority).toMatchObject({
      state: "unclaimed",
      generation: 4,
      allowedOperations: ["complete", "handoff", "unblock"],
    });
    expect(blocked.responsibility.escalationState).toBe("blocked");
  });

  test("classifies live and expiring direct claims from trusted time", () => {
    const live = projectItemControl({
      item: item({
        status: "active",
        claimedBy: "agent:one",
        claimExpiresAt: "2026-07-26T12:20:00.000Z",
        claimGeneration: 7,
      }),
      now,
    });
    expect(live.authority).toMatchObject({
      state: "live",
      holderActorId: "agent:one",
      generation: 7,
      source: "claim",
      allowedOperations: ["renew", "release", "complete", "handoff", "block"],
    });
    expect(live.responsibility).toMatchObject({
      actorId: "agent:one",
      heartbeatExpectedAt: null,
    });

    const expiring = projectItemControl({
      item: item({
        status: "active",
        claimedBy: "agent:one",
        claimExpiresAt: "2026-07-26T12:04:59.000Z",
        claimGeneration: 7,
      }),
      now,
    });
    expect(expiring.authority.state).toBe("expiring");
  });

  test("reports expired authority without granting an operation", () => {
    const control = projectItemControl({
      item: item({
        status: "active",
        claimedBy: "agent:one",
        claimExpiresAt: "2026-07-26T11:59:59.000Z",
        claimGeneration: 8,
      }),
      now,
    });
    expect(control.authority).toMatchObject({
      state: "expired",
      holderActorId: "agent:one",
      generation: 8,
      source: "claim",
      allowedOperations: [],
    });
    expect(control.authority.unavailableReasons.complete).toContain("refresh");
    expect(control.responsibility.actorId).toBe("agent:one");
  });

  test("identifies dispatcher authority from one matching live run", () => {
    const control = projectItemControl({
      item: item({
        status: "active",
        claimedBy: "service:supervisor",
        claimExpiresAt: "2026-07-26T12:15:00.000Z",
        claimGeneration: 3,
      }),
      runs: [{
        actorId: "service:supervisor",
        leaseOwnerId: "service:supervisor",
        status: "running",
        leaseExpiresAt: "2026-07-26T12:10:00.000Z",
        lastHeartbeatAt: "2026-07-26T12:00:00.000Z",
      }],
      now,
    });
    expect(control.authority.source).toBe("dispatcher");
    expect(control.responsibility.heartbeatExpectedAt).toBe("2026-07-26T12:10:00.000Z");
  });

  test("fails closed for conflicting runs and malformed authority fields", () => {
    const conflicting = projectItemControl({
      item: item({
        status: "active",
        claimedBy: "service:supervisor",
        claimExpiresAt: "2026-07-26T12:15:00.000Z",
        claimGeneration: 3,
      }),
      runs: [
        { actorId: "service:supervisor", status: "running" },
        { actorId: "agent:other", status: "waiting" },
      ],
      now,
    });
    expect(conflicting.authority).toMatchObject({
      state: "superseded",
      holderActorId: null,
      expiresAt: null,
      source: "none",
      allowedOperations: [],
    });

    const malformedActive = projectItemControl({
      item: item({
        status: "active",
        claimedBy: "agent:one",
        claimExpiresAt: null,
        claimGeneration: -1,
      }),
      now,
    });
    expect(malformedActive.authority).toMatchObject({
      state: "superseded",
      generation: 0,
      allowedOperations: [],
    });

    const unsafeGeneration = projectItemControl({
      item: item({
        claimGeneration: Number.MAX_SAFE_INTEGER + 1,
      }),
      now,
    });
    expect(unsafeGeneration.authority).toMatchObject({
      state: "superseded",
      generation: 0,
      allowedOperations: [],
    });

    const malformedReady = projectItemControl({
      item: item({
        status: "ready",
        claimedBy: "Bearer secret-shaped-holder",
        claimExpiresAt: "not-a-timestamp",
      }),
      now,
    });
    expect(malformedReady.authority).toMatchObject({
      state: "superseded",
      holderActorId: null,
      source: "none",
      allowedOperations: [],
    });
  });

  test("preserves handed-off responsibility only for the current generation", () => {
    const control = projectItemControl({
      item: item({
        status: "ready",
        claimGeneration: 5,
        summary: "Implementation is ready for review.",
        nextAction: "Review and decide.",
      }),
      events: [{
        actorId: "agent:builder",
        type: "work.handed_off",
        payload: { toActorId: "human:reviewer", nextGeneration: 5 },
      }],
      now,
    });
    expect(control.responsibility.actorId).toBe("human:reviewer");

    const stale = projectItemControl({
      item: item({ status: "ready", claimGeneration: 6 }),
      events: [{
        actorId: "agent:builder",
        type: "work.handed_off",
        payload: { toActorId: "human:reviewer", nextGeneration: 5 },
      }],
      now,
    });
    expect(stale.responsibility.actorId).toBeNull();
  });

  test("closes terminal authority and preserves an explicit empty summary", () => {
    const completed = projectItemControl({
      item: item({
        kind: "decision",
        status: "done",
        summary: "",
        nextAction: null,
        claimGeneration: 9,
      }),
      now,
    });
    expect(completed.authority).toMatchObject({
      state: "superseded",
      generation: 9,
      allowedOperations: [],
    });
    expect(completed.responsibility).toMatchObject({
      actorId: null,
      summary: "",
      escalationState: "none",
    });
  });

  test("redacts credential-shaped responsibility values without erasing safe context", () => {
    const control = projectItemControl({
      item: item({
        summary: "Use Bearer very-secret-token, ghp_this_must_not_leak, and stn.tok_secret-shaped-content safely.",
        nextAction: "Review https://user:password@example.test/result.",
      }),
      now,
    });
    expect(control.responsibility.summary).toBe(
      "Use [REDACTED], [REDACTED], and [REDACTED] safely.",
    );
    expect(control.responsibility.nextAction).toBe(
      "Review https://[REDACTED]@example.test/result.",
    );
    expect(JSON.stringify(control)).not.toContain("very-secret-token");
    expect(JSON.stringify(control)).not.toContain("ghp_this_must_not_leak");
    expect(JSON.stringify(control)).not.toContain("secret-shaped-content");
    expect(JSON.stringify(control)).not.toContain("user:password");
  });
});
