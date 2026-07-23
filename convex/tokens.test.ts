import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "token-test-secret";

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("Convex API tokens", () => {
  test("registers, authenticates, scopes, lists, and revokes hashed tokens", async () => {
    const t = convexTest(schema, modules);
    const secretHash = "a".repeat(64);
    const registered = await t.mutation(convexApi.tokens.register, {
      serviceSecret,
      workspace: "test",
      id: "tok_1234567890abcdef1234567890abcdef",
      name: "Scrapbook reader",
      secretHash,
      scopes: ["read"],
      projects: ["scrapbook"],
    }) as any;
    expect(registered).toMatchObject({
      name: "Scrapbook reader",
      scopes: ["read"],
      projects: ["scrapbook"],
      revokedAt: null,
    });
    expect(JSON.stringify(registered)).not.toContain(secretHash);

    const principal = await t.query(convexApi.tokens.authenticate, {
      serviceSecret,
      workspace: "test",
      id: registered.id,
      secretHash,
    });
    expect(principal).toEqual({
      tokenId: registered.id,
      name: "Scrapbook reader",
      scopes: ["read"],
      projects: ["scrapbook"],
    });

    const wrong = await t.query(convexApi.tokens.authenticate, {
      serviceSecret,
      workspace: "test",
      id: registered.id,
      secretHash: "b".repeat(64),
    });
    expect(wrong).toBeNull();

    const listed = await t.query(convexApi.tokens.list, {
      serviceSecret,
      workspace: "test",
    }) as any[];
    expect(listed).toHaveLength(1);

    const revoked = await t.mutation(convexApi.tokens.revoke, {
      serviceSecret,
      workspace: "test",
      id: registered.id,
    }) as any;
    expect(revoked.revokedAt).not.toBeNull();

    const afterRevocation = await t.query(convexApi.tokens.authenticate, {
      serviceSecret,
      workspace: "test",
      id: registered.id,
      secretHash,
    });
    expect(afterRevocation).toBeNull();
  });
});
