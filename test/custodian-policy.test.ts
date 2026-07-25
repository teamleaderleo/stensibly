import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CUSTODIAN_POLICY_VERSION,
  runCustodianPolicy,
} from "../src/custodian-policy.ts";
import { StensiblyStore } from "../src/store.ts";

const human = { id: "human", name: "Human", kind: "human" as const };
const agent = { id: "agent", name: "Agent", kind: "agent" as const };

let store: StensiblyStore;
let originalNow: typeof Date.now;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  originalNow = Date.now;
  Date.now = () => Date.parse("2026-03-06T00:00:00.000Z");
});

afterEach(() => {
  Date.now = originalNow;
  store.close();
});

describe("custodian automation policy", () => {
  test("defaults to read-only observation with explicit conservative rules", () => {
    const item = claimedItem("scrapbook", "Observe elapsed claim", 60);
    const result = runCustodianPolicy(store, {
      now: new Date("2026-03-06T00:02:00.000Z"),
    });

    expect(result.policy).toEqual({
      version: CUSTODIAN_POLICY_VERSION,
      mode: "observe",
      maxActions: 100,
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
      eligible: 1,
      reported: 1,
      planned: 0,
      applied: 0,
      skipped: 0,
    });
    expect(result.actions).toEqual([
      expect.objectContaining({
        kind: "expire_claim",
        itemId: item.id,
        project: "scrapbook",
        status: "reported",
        durableEvent: null,
      }),
    ]);
    expect(store.getItem(item.id)).toMatchObject({ status: "active", claimedBy: agent.id });
  });

  test("dry-run emits the exact bounded plan without writing", () => {
    const first = claimedItem("scrapbook", "First elapsed claim", 30);
    const second = claimedItem("scrapbook", "Second elapsed claim", 60);
    const result = runCustodianPolicy(store, {
      mode: "dry-run",
      maxActions: 1,
      now: new Date("2026-03-06T00:02:00.000Z"),
    });

    expect(result.actions).toEqual([
      expect.objectContaining({ itemId: first.id, status: "planned" }),
      expect.objectContaining({ itemId: second.id, status: "skipped", reason: "action_limit" }),
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
    expect(store.listEvents(first.id).some((event) => event.type === "claim.expired")).toBe(false);
  });

  test("apply reconciles only the bounded scoped claims and appends audit metadata", () => {
    const scoped = claimedItem("scrapbook", "Scoped elapsed claim", 30);
    const scopedOverflow = claimedItem("scrapbook", "Scoped overflow", 60);
    const other = claimedItem("other", "Other elapsed claim", 30);
    const now = new Date("2026-03-06T00:02:00.000Z");

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
    });
    expect(store.getItem(scopedOverflow.id)).toMatchObject({ status: "active", claimedBy: agent.id });
    expect(store.getItem(other.id)).toMatchObject({ status: "active", claimedBy: agent.id });

    const expiry = store.listEvents(scoped.id).find((event) => event.type === "claim.expired");
    expect(expiry?.payload).toMatchObject({
      previousClaimant: agent.id,
      automation: {
        source: "custodian",
        policyVersion: CUSTODIAN_POLICY_VERSION,
        mode: "apply",
      },
    });
  });

  test("apply never performs semantic transitions for stale or vague work", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Human decision required",
      priority: 100,
      actor: human,
    });
    store.db.query("UPDATE items SET updated_at = ?1 WHERE id = ?2")
      .run("2026-02-01T00:00:00.000Z", item.id);

    const result = runCustodianPolicy(store, {
      mode: "apply",
      staleDays: 7,
      now: new Date("2026-03-06T00:02:00.000Z"),
    });

    expect(result.report.missingNextActions.map((entry) => entry.id)).toContain(item.id);
    expect(result.report.staleReady.map((entry) => entry.id)).toContain(item.id);
    expect(result.actions).toEqual([]);
    expect(store.getItem(item.id)).toMatchObject({ status: "ready", nextAction: null });
    expect(store.listEvents(item.id).map((event) => event.type)).not.toContain("item.blocked");
    expect(store.listEvents(item.id).map((event) => event.type)).not.toContain("item.completed");
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

function claimedItem(project: string, title: string, leaseSeconds: number) {
  const item = store.createItem({
    project,
    kind: "task",
    title,
    nextAction: "Resume after expiry.",
    priority: 50,
    actor: human,
  });
  store.claimItem(item.id, agent, leaseSeconds);
  return item;
}
