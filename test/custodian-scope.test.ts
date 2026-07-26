import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runCustodianPolicy } from "../src/custodian-policy.ts";
import { inspectScrapbook } from "../src/custodian-report.ts";
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

describe("custodian project scope boundaries", () => {
  test("policy apply rejects an invalid supplied project without writing", () => {
    const first = claimedItem("first", "2099-12-31T23:58:00.000Z");
    const second = claimedItem("second", "2099-12-31T23:59:00.000Z");

    expect(() => runCustodianPolicy(store, {
      mode: "apply",
      project: "",
      now,
    })).toThrow("project must be a lowercase project slug");

    expectClaimActive(first.id);
    expectClaimActive(second.id);
  });

  test("canonical expiry rejects an invalid supplied project without writing", () => {
    const first = claimedItem("first", "2099-12-31T23:58:00.000Z");
    const second = claimedItem("second", "2099-12-31T23:59:00.000Z");

    expect(() => expireClaims(store, now, {
      project: "Second Project",
      limit: 1,
    })).toThrow("project must be a lowercase project slug");

    expectClaimActive(first.id);
    expectClaimActive(second.id);
  });

  test("read-only inspection rejects an invalid supplied project", () => {
    claimedItem("first", "2099-12-31T23:58:00.000Z");

    expect(() => inspectScrapbook(store, { project: "", now }))
      .toThrow("project must be a lowercase project slug");
  });

  test("canonical expiry applies its limit before reconciliation", () => {
    const first = claimedItem("first", "2099-12-31T23:58:00.000Z");
    const second = claimedItem("second", "2099-12-31T23:59:00.000Z");

    expect(expireClaims(store, now, { limit: 1 })).toEqual([first.id]);
    expect(store.getItem(first.id).status).toBe("ready");
    expectClaimActive(second.id);
  });

  test("repeated apply safely no-ops after reconciliation", () => {
    const item = claimedItem("scrapbook", "2099-12-31T23:58:00.000Z");

    const first = runCustodianPolicy(store, {
      mode: "apply",
      project: "scrapbook",
      now,
    });
    const eventsAfterFirst = store.listEvents(item.id);
    const second = runCustodianPolicy(store, {
      mode: "apply",
      project: "scrapbook",
      now,
    });

    expect(first.actionSummary.applied).toBe(1);
    expect(second.actionSummary).toEqual({
      eligible: 0,
      reported: 0,
      planned: 0,
      applied: 0,
      skipped: 0,
    });
    expect(store.getItem(item.id)).toMatchObject({
      status: "ready",
      claimedBy: null,
      claimExpiresAt: null,
    });
    expect(store.listEvents(item.id)).toEqual(eventsAfterFirst);
    expect(eventsAfterFirst.filter((event) => event.type === "claim.expired")).toHaveLength(1);
  });
});

function claimedItem(project: string, expiresAt: string) {
  const item = store.createItem({
    project,
    kind: "task",
    title: `Expired claim in ${project}`,
    nextAction: "Resume after expiry.",
    priority: 50,
    actor: human,
  });
  store.claimItem(item.id, agent, 900);
  store.db
    .query("UPDATE items SET claim_expires_at = ?1, updated_at = ?1 WHERE id = ?2")
    .run(expiresAt, item.id);
  return store.getItem(item.id);
}

function expectClaimActive(id: string): void {
  expect(store.getItem(id)).toMatchObject({
    status: "active",
    claimedBy: agent.id,
  });
  expect(store.listEvents(id).map((event) => event.type)).not.toContain("claim.expired");
}
