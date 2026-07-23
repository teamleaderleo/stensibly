import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  authenticateApiToken,
  createApiToken,
  filterItemsForPrincipal,
  listApiTokens,
  principalCanAccessProject,
  principalHasScope,
  revokeApiToken,
} from "../src/auth.ts";
import { StensiblyStore } from "../src/store.ts";

let store: StensiblyStore;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
});

afterEach(() => {
  store.close();
});

describe("API tokens", () => {
  test("creates a token once and stores only its hash", () => {
    const created = createApiToken(store, {
      name: "Scrapbook observer",
      scopes: ["read"],
      projects: ["scrapbook", "scrapbook"],
    });

    expect(created.token).toMatch(/^stn\.tok_[a-f0-9]{32}\.[A-Za-z0-9_-]{40,}$/);
    expect(created).toMatchObject({
      name: "Scrapbook observer",
      scopes: ["read"],
      projects: ["scrapbook"],
      revokedAt: null,
    });

    const stored = store.db
      .query<{ secret_hash: string }, [string]>(
        "SELECT secret_hash FROM api_tokens WHERE id = ?1",
      )
      .get(created.id);
    expect(stored?.secret_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.secret_hash).not.toContain(created.token);

    expect(listApiTokens(store)).toEqual([
      {
        id: created.id,
        name: created.name,
        scopes: ["read"],
        projects: ["scrapbook"],
        createdAt: created.createdAt,
        revokedAt: null,
      },
    ]);
  });

  test("authenticates exact tokens and rejects tampering", () => {
    const created = createApiToken(store, {
      name: "Worker",
      scopes: ["write", "read", "write"],
      projects: null,
    });

    expect(authenticateApiToken(store, created.token)).toEqual({
      tokenId: created.id,
      name: "Worker",
      scopes: ["read", "write"],
      projects: null,
    });
    expect(authenticateApiToken(store, `${created.token}x`)).toBeNull();
    expect(authenticateApiToken(store, "stn.invalid.token")).toBeNull();
  });

  test("revocation invalidates future requests", () => {
    const created = createApiToken(store, {
      name: "Temporary worker",
      scopes: ["read", "write"],
      projects: ["scrapbook"],
    });
    expect(authenticateApiToken(store, created.token)).not.toBeNull();

    const revoked = revokeApiToken(store, created.id);
    expect(revoked.revokedAt).not.toBeNull();
    expect(authenticateApiToken(store, created.token)).toBeNull();
  });

  test("applies action and project scopes", () => {
    const created = createApiToken(store, {
      name: "Project reader",
      scopes: ["read"],
      projects: ["scrapbook"],
    });
    const principal = authenticateApiToken(store, created.token);
    if (!principal) throw new Error("Token failed to authenticate");

    expect(principalHasScope(principal, "read")).toBe(true);
    expect(principalHasScope(principal, "write")).toBe(false);
    expect(principalCanAccessProject(principal, "scrapbook")).toBe(true);
    expect(principalCanAccessProject(principal, "elsewhere")).toBe(false);
    expect(filterItemsForPrincipal(principal, [
      { project: "scrapbook", id: "one" },
      { project: "elsewhere", id: "two" },
    ])).toEqual([{ project: "scrapbook", id: "one" }]);
  });

  test("admin scope grants read and write across allowed projects", () => {
    const created = createApiToken(store, {
      name: "Project administrator",
      scopes: ["admin"],
      projects: ["scrapbook"],
    });
    const principal = authenticateApiToken(store, created.token);
    if (!principal) throw new Error("Token failed to authenticate");

    expect(principalHasScope(principal, "read")).toBe(true);
    expect(principalHasScope(principal, "write")).toBe(true);
    expect(principalCanAccessProject(principal, "scrapbook")).toBe(true);
    expect(principalCanAccessProject(principal, "elsewhere")).toBe(false);
  });
});
