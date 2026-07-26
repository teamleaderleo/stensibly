import { describe, expect, test } from "bun:test";
import { buildItemControlView } from "../src/item-control.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { MAX_ITEM_DETAIL_EVENTS } from "../src/sqlite-item-detail.ts";
import { StensiblyStore, type Item, type ItemEvent } from "../src/store.ts";

const now = new Date("2026-07-26T12:00:00.000Z");
const agent = { id: "agent", name: "Agent", kind: "agent" as const };
const leo = { id: "leo", name: "Leo", kind: "human" as const };

describe("canonical item control projection", () => {
  test("projects live and expiring claim authority", () => {
    const live = buildItemControlView({
      item: item({
        status: "active",
        claimedBy: agent.id,
        claimExpiresAt: "2026-07-26T13:00:00.000Z",
        claimGeneration: 7,
      }),
      events: [event("claim.created", agent.id, { generation: 7 })],
    }, { now });
    expect(live).toMatchObject({
      version: 1,
      authority: {
        state: "live",
        holderActorId: agent.id,
        generation: 7,
        source: "claim",
        allowedOperations: ["renew", "release", "complete", "handoff", "block"],
        approvalRequiredOperations: [],
      },
      responsibility: {
        actorId: agent.id,
        heartbeatExpectedAt: null,
        evidenceRequired: [],
        escalationState: "none",
      },
    });

    const expiring = buildItemControlView({
      item: item({
        status: "active",
        claimedBy: agent.id,
        claimExpiresAt: "2026-07-26T12:02:00.000Z",
        claimGeneration: 8,
      }),
      events: [event("claim.created", agent.id, { generation: 8 })],
    }, { now });
    expect(expiring.authority.state).toBe("expiring");
  });

  test("projects raw and reconciled expiry at the usable generation", () => {
    const rawExpired = buildItemControlView({
      item: item({
        status: "active",
        claimedBy: agent.id,
        claimExpiresAt: "2026-07-26T11:59:00.000Z",
        claimGeneration: 4,
      }),
      events: [event("claim.created", agent.id, {
        generation: 4,
        source: "supervisor_dispatch",
      })],
    }, { now });
    expect(rawExpired).toMatchObject({
      authority: {
        state: "expired",
        holderActorId: null,
        generation: 5,
        expiresAt: "2026-07-26T11:59:00.000Z",
        source: "dispatcher",
        allowedOperations: ["claim", "complete", "handoff", "block"],
      },
      responsibility: { actorId: agent.id },
    });

    const reconciled = buildItemControlView({
      item: item({ status: "ready", claimGeneration: 5 }),
      events: [
        event("claim.created", agent.id, {
          generation: 4,
          source: "supervisor_dispatch",
        }),
        event("claim.expired", null, {
          previousClaimant: agent.id,
          expiredAt: "2026-07-26T11:59:00.000Z",
          generation: 4,
          nextGeneration: 5,
        }),
      ],
    }, { now });
    expect(reconciled).toMatchObject({
      authority: {
        state: "expired",
        generation: 5,
        source: "dispatcher",
      },
      responsibility: { actorId: agent.id },
    });
  });

  test("projects handoff, blocked, completed, and decision responsibility", () => {
    const handedOff = buildItemControlView({
      item: item({
        status: "ready",
        claimGeneration: 3,
        summary: "Implementation finished.",
        nextAction: "Review the result.",
      }),
      events: [event("work.handed_off", agent.id, {
        toActorId: leo.id,
        generation: 2,
        nextGeneration: 3,
      })],
    }, { now });
    expect(handedOff).toMatchObject({
      authority: {
        state: "superseded",
        generation: 3,
        allowedOperations: ["claim", "complete", "handoff", "block"],
      },
      responsibility: {
        actorId: leo.id,
        summary: "Implementation finished.",
        nextAction: "Review the result.",
      },
    });

    const blocked = buildItemControlView({
      item: item({
        status: "blocked",
        claimGeneration: 4,
        summary: "Needs a human decision.",
      }),
      events: [event("work.blocked", leo.id, {
        generation: 3,
        nextGeneration: 4,
      })],
    }, { now });
    expect(blocked).toMatchObject({
      authority: {
        state: "superseded",
        allowedOperations: ["complete", "handoff", "unblock"],
      },
      responsibility: { actorId: leo.id, escalationState: "blocked" },
    });

    const completed = buildItemControlView({
      item: item({ status: "done", claimGeneration: 5 }),
      events: [event("item.completed", agent.id, {
        generation: 4,
        nextGeneration: 5,
      })],
    }, { now });
    expect(completed).toMatchObject({
      authority: { state: "superseded", allowedOperations: [] },
      responsibility: { actorId: null, escalationState: "none" },
    });

    const decision = buildItemControlView({
      item: item({ kind: "decision" }),
      events: [],
    }, { now });
    expect(decision.responsibility.escalationState).toBe("decision_required");
  });

  test("fails closed on malformed authority and redacts presentation text", () => {
    const malformed = buildItemControlView({
      item: item({
        status: "active",
        claimGeneration: Number.NaN,
        claimedBy: "stn.tok_secret-value",
        claimExpiresAt: "invalid",
        summary: "Use Bearer secret-value for the request.",
      }),
      events: [],
    }, { now });
    expect(malformed.authority).toMatchObject({
      state: "superseded",
      holderActorId: null,
      generation: 0,
      source: "none",
      allowedOperations: [],
    });
    expect(malformed.responsibility.actorId).toBeNull();
    expect(malformed.responsibility.summary).toContain("[REDACTED]");
    expect(JSON.stringify(malformed)).not.toContain("secret-value");
  });

  test("bounds SQLite item-detail event reads before projection", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const created = store.createItem({
        project: "scrapbook",
        kind: "task",
        title: "Bound item detail",
        priority: 50,
        actor: leo,
      });
      for (let index = 0; index < MAX_ITEM_DETAIL_EVENTS + 20; index += 1) {
        store.recordEvent({
          itemId: created.id,
          actor: agent,
          type: "progress.recorded",
          payload: { index },
        });
      }
      expect(store.listEvents(created.id).length).toBe(MAX_ITEM_DETAIL_EVENTS + 21);
      const detail = await new SqliteWorkLedger(store).getItem(created.id);
      expect(detail.events).toHaveLength(MAX_ITEM_DETAIL_EVENTS);
      expect(detail.control.authority.state).toBe("unclaimed");
    } finally {
      store.close();
    }
  });
});

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: "item_control",
    project: "scrapbook",
    kind: "task",
    title: "Project canonical control",
    summary: null,
    status: "ready",
    priority: 50,
    nextAction: null,
    claimedBy: null,
    claimExpiresAt: null,
    claimGeneration: 0,
    version: 1,
    createdAt: "2026-07-26T10:00:00.000Z",
    updatedAt: "2026-07-26T10:00:00.000Z",
    ...overrides,
  };
}

function event(
  type: string,
  actorId: string | null,
  payload: Record<string, unknown>,
): ItemEvent {
  return {
    id: `evt_${type}`,
    itemId: "item_control",
    actorId,
    type,
    payload,
    createdAt: "2026-07-26T10:00:00.000Z",
  };
}
