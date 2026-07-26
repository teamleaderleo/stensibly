import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CUSTODIAN_POLICY_ID,
  CUSTODIAN_POLICY_VERSION,
  runCustodianPolicy,
} from "../src/custodian-policy.ts";
import { expireClaims } from "../src/leases.ts";
import { StensiblyStore } from "../src/store.ts";

const human = { id: "human", name: "Human", kind: "human" as const };
const agent = { id: "agent", name: "Agent", kind: "agent" as const };
const now = new Date("2100-01-01T00:00:00.000Z");

let store: StensiblyStore;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
});

afterEach(() => {
  store.close();
});

describe("custodian automation policy", () => {
  test("defaults to read-only observation and reports every eligible claim", () => {
    const first = claimedItem(
      "scrapbook",
      "First observed elapsed claim",
      "2099-12-31T23:58:00.000Z",
    );
    const second = claimedItem(
      "scrapbook",
      "Second observed elapsed claim",
      "2099-12-31T23:59:00.000Z",
    );

    const result = runCustodianPolicy(store, { maxActions: 1, now });

    expect(result.policy).toEqual({
      id: CUSTODIAN_POLICY_ID,
      version: CUSTODIAN_POLICY_VERSION,
      mode: "observe",
      maxActions: 1,
      rules: {
        expiredClaim: "reconcile",
        expiringClaim: "notify",
        missingNextAction: "report",
        staleReady: "report",
        staleBlocked: "report",
        duplicateTitle: "report",
      },
      semanticTransitions: "disabled",
    });
    expect(result.actionSummary).toEqual({
      eligible: 2,
      reported: 2,
      planned: 0,
      applied: 0,
      skipped: 0,
    });
    expect(result.actions).toEqual([
      expect.objectContaining({
        itemId: first.id,
        status: "reported",
        expectedClaimGeneration: first.claimGeneration,
        expectedVersion: first.version,
        durableEvent: null,
      }),
      expect.objectContaining({
        itemId: second.id,
        status: "reported",
        expectedClaimGeneration: second.claimGeneration,
        expectedVersion: second.version,
        durableEvent: null,
      }),
    ]);
    expect(store.getItem(first.id)).toMatchObject({ status: "active", claimedBy: agent.id });
    expect(store.getItem(second.id)).toMatchObject({ status: "active", claimedBy: agent.id });
  });

  test("dry-run emits the exact deterministic bounded plan without writing", () => {
    const first = claimedItem(
      "scrapbook",
      "First planned elapsed claim",
      "2099-12-31T23:58:00.000Z",
    );
    const second = claimedItem(
      "scrapbook",
      "Second planned elapsed claim",
      "2099-12-31T23:59:00.000Z",
    );

    const result = runCustodianPolicy(store, {
      mode: "dry-run",
      maxActions: 1,
      now,
    });

    expect(result.actions).toEqual([
      {
        kind: "expire_claim",
        itemId: first.id,
        project: "scrapbook",
        status: "planned",
        rationale: expect.any(String),
        previousClaimant: agent.id,
        claimExpiredAt: "2099-12-31T23:58:00.000Z",
        expectedClaimGeneration: first.claimGeneration,
        expectedVersion: first.version,
        durableEvent: null,
      },
      {
        kind: "expire_claim",
        itemId: second.id,
        project: "scrapbook",
        status: "skipped",
        rationale: expect.any(String),
        previousClaimant: agent.id,
        claimExpiredAt: "2099-12-31T23:59:00.000Z",
        expectedClaimGeneration: second.claimGeneration,
        expectedVersion: second.version,
        durableEvent: null,
        reason: "action_limit",
      },
    ]);
    expect(result.actionSummary).toEqual({
      eligible: 2,
      reported: 0,
      planned: 1,
      applied: 0,
      skipped: 1,
    });
    expect(store.getItem(first.id).status).toBe("active");
    expect(store.getItem(second.id).status).toBe("active");
    expect(store.listEvents(first.id).map((event) => event.type)).not.toContain("claim.expired");
  });

  test("apply reconciles only bounded project-scoped claims with durable audit metadata", () => {
    const scoped = claimedItem(
      "scrapbook",
      "Scoped elapsed claim",
      "2099-12-31T23:58:00.000Z",
    );
    const scopedOverflow = claimedItem(
      "scrapbook",
      "Scoped overflow",
      "2099-12-31T23:59:00.000Z",
    );
    const other = claimedItem(
      "other",
      "Other elapsed claim",
      "2099-12-31T23:57:00.000Z",
    );

    const result = runCustodianPolicy(store, {
      mode: "apply",
      project: "scrapbook",
      maxActions: 1,
      now,
    });

    expect(result.report.expiredClaimIds).toEqual([scoped.id, scopedOverflow.id]);
    expect(result.actions).toEqual([
      expect.objectContaining({
        itemId: scoped.id,
        status: "applied",
        durableEvent: "claim.expired",
      }),
      expect.objectContaining({
        itemId: scopedOverflow.id,
        status: "skipped",
        reason: "action_limit",
      }),
    ]);
    expect(store.getItem(scoped.id)).toMatchObject({
      status: "ready",
      claimedBy: null,
      claimExpiresAt: null,
      claimGeneration: scoped.claimGeneration + 1,
      version: scoped.version + 1,
    });
    expect(store.getItem(scopedOverflow.id)).toMatchObject({
      status: "active",
      claimedBy: agent.id,
      claimGeneration: scopedOverflow.claimGeneration,
    });
    expect(store.getItem(other.id)).toMatchObject({
      status: "active",
      claimedBy: agent.id,
      claimGeneration: other.claimGeneration,
    });

    const expiry = store.listEvents(scoped.id).find((event) => event.type === "claim.expired");
    expect(expiry?.payload).toMatchObject({
      previousClaimant: agent.id,
      expiredAt: "2099-12-31T23:58:00.000Z",
      generation: scoped.claimGeneration,
      nextGeneration: scoped.claimGeneration + 1,
      previousVersion: scoped.version,
      nextVersion: scoped.version + 1,
      automation: {
        source: "custodian",
        policy: CUSTODIAN_POLICY_ID,
        policyVersion: CUSTODIAN_POLICY_VERSION,
        mode: "apply",
      },
    });
  });

  test("apply skips a claim whose fenced snapshot changed after planning", () => {
    const item = claimedItem(
      "scrapbook",
      "Concurrent elapsed claim",
      "2099-12-31T23:59:00.000Z",
    );

    const result = runCustodianPolicy(
      store,
      { mode: "apply", now },
      {
        expireClaims(currentStore, currentNow, options) {
          currentStore.db
            .query(`
              UPDATE items
              SET claim_generation = claim_generation + 1,
                  version = version + 1,
                  updated_at = ?1
              WHERE id = ?2
            `)
            .run("2099-12-31T23:59:30.000Z", item.id);
          return expireClaims(currentStore, currentNow, options);
        },
      },
    );

    expect(result.actions).toEqual([
      expect.objectContaining({
        itemId: item.id,
        status: "skipped",
        reason: "state_changed",
        durableEvent: null,
      }),
    ]);
    expect(store.getItem(item.id)).toMatchObject({
      status: "active",
      claimedBy: agent.id,
      claimExpiresAt: "2099-12-31T23:59:00.000Z",
      claimGeneration: item.claimGeneration + 1,
      version: item.version + 1,
    });
    expect(store.listEvents(item.id).map((event) => event.type)).not.toContain("claim.expired");
  });

  test("apply leaves semantic findings unchanged", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Human decision required",
      priority: 100,
      actor: human,
    });
    store.db
      .query("UPDATE items SET updated_at = ?1 WHERE id = ?2")
      .run("2099-01-01T00:00:00.000Z", item.id);
    const eventsBefore = store.listEvents(item.id);

    const result = runCustodianPolicy(store, {
      mode: "apply",
      staleDays: 7,
      now,
    });

    expect(result.policy.semanticTransitions).toBe("disabled");
    expect(result.report.missingNextActions.map((entry) => entry.id)).toContain(item.id);
    expect(result.report.staleReady.map((entry) => entry.id)).toContain(item.id);
    expect(result.actions).toEqual([]);
    expect(store.getItem(item.id)).toMatchObject({ status: "ready", nextAction: null });
    expect(store.listEvents(item.id)).toEqual(eventsBefore);
  });

  test("validates modes and action limits", () => {
    expect(() => runCustodianPolicy(store, { mode: "invalid" as never }))
      .toThrow("mode must be observe, dry-run, or apply");
    expect(() => runCustodianPolicy(store, { maxActions: -1 }))
      .toThrow("maxActions must be a whole number between 0 and 10000");
    expect(() => runCustodianPolicy(store, { maxActions: 1.5 }))
      .toThrow("maxActions must be a whole number between 0 and 10000");
  });
});

function claimedItem(project: string, title: string, claimExpiresAt: string) {
  const item = store.createItem({
    project,
    kind: "task",
    title,
    nextAction: "Resume after expiry.",
    priority: 50,
    actor: human,
  });
  store.claimItem(item.id, agent, 900);
  store.db
    .query(`
      UPDATE items
      SET claim_expires_at = ?1,
          updated_at = ?1
      WHERE id = ?2
    `)
    .run(claimExpiresAt, item.id);
  return store.getItem(item.id);
}
