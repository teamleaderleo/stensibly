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
  test("round-trips one exact runner-only credential grant", async () => {
    const t = convexTest(schema, modules);
    const runnerGrant = {
      version: 1 as const,
      actorId: "service:big-red-glaeda",
      runnerType: "glaeda-workstation",
      adapterId: "glaeda-workstation",
      profiles: ["repo-query/v1"],
      tools: [
        "claim_runner_work" as const,
        "transition_runner_run" as const,
        "reserve_workstation_adapter_command" as const,
        "settle_runner_adapter_command" as const,
      ],
    };
    const registered = await t.mutation(convexApi.tokens.register, {
      serviceSecret,
      workspace: "test",
      id: "tok_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      name: "Big Red Glaeda",
      secretHash: "c".repeat(64),
      scopes: ["write"],
      projects: ["glaeda"],
      runnerGrant,
    }) as any;
    expect(registered).toMatchObject({
      scopes: ["write"],
      projects: ["glaeda"],
      runnerGrant,
    });
    expect(await t.query(convexApi.tokens.authenticate, {
      serviceSecret,
      workspace: "test",
      id: registered.id,
      secretHash: "c".repeat(64),
    })).toMatchObject({ runnerGrant });
    await expect(t.mutation(convexApi.tokens.register, {
      serviceSecret,
      workspace: "test",
      id: "tok_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      name: "Overbroad Big Red",
      secretHash: "d".repeat(64),
      scopes: ["read", "write"],
      projects: ["glaeda"],
      runnerGrant,
    })).rejects.toThrow("scope must be exactly write");
  });

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
