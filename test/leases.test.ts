import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { expireClaims, renewClaim } from "../src/leases.ts";
import { ConflictError, StensiblyStore } from "../src/store.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const browserAgent = {
  id: "browser-agent",
  name: "Browser Agent",
  kind: "agent" as const,
};

let store: StensiblyStore;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
});

afterEach(() => {
  store.close();
});

describe("claim leases", () => {
  test("expired claims return to ready work exactly once and advance generation", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Recover abandoned work",
      priority: 50,
      actor: leo,
    });
    const claimed = store.claimItem(item.id, browserAgent, 900);
    expect(claimed.claimGeneration).toBe(1);
    store.db
      .query("UPDATE items SET claim_expires_at = ?1 WHERE id = ?2")
      .run("2020-01-01T00:00:00.000Z", item.id);

    expect(expireClaims(store, new Date("2100-01-01T00:00:00.000Z"))).toEqual([item.id]);
    expect(store.getItem(item.id)).toMatchObject({
      status: "ready",
      claimedBy: null,
      claimExpiresAt: null,
      claimGeneration: 2,
    });
    expect(expireClaims(store, new Date("2100-01-01T00:01:00.000Z"))).toEqual([]);
    expect(store.listEvents(item.id).map((event) => event.type)).toEqual([
      "item.created",
      "claim.created",
      "claim.expired",
    ]);
    expect(store.listEvents(item.id).at(-1)?.payload).toMatchObject({
      generation: 1,
      nextGeneration: 2,
    });
  });

  test("only the live claimant with current generation can renew a lease", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Keep carrying the work",
      priority: 50,
      actor: leo,
    });
    const claimed = store.claimItem(item.id, browserAgent, 60);
    const renewed = renewClaim(
      store,
      item.id,
      browserAgent,
      3600,
      claimed.claimGeneration,
      "renew-1",
    );

    expect(new Date(renewed.claimExpiresAt ?? 0).getTime()).toBeGreaterThan(
      new Date(claimed.claimExpiresAt ?? 0).getTime(),
    );
    expect(renewed.claimGeneration).toBe(claimed.claimGeneration + 1);
    expect(renewClaim(
      store,
      item.id,
      browserAgent,
      3600,
      claimed.claimGeneration,
      "renew-1",
    )).toEqual(renewed);
    expect(() => renewClaim(
      store,
      item.id,
      browserAgent,
      3600,
      claimed.claimGeneration,
    )).toThrow(ConflictError);
    expect(() => renewClaim(
      store,
      item.id,
      leo,
      3600,
      renewed.claimGeneration,
    )).toThrow(ConflictError);
    expect(store.listEvents(item.id).map((event) => event.type)).toEqual([
      "item.created",
      "claim.created",
      "claim.renewed",
    ]);
    expect(store.listEvents(item.id).at(-1)?.payload).toMatchObject({
      generation: claimed.claimGeneration,
      nextGeneration: renewed.claimGeneration,
    });
  });
});
