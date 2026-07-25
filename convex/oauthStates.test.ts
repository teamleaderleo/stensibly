import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "oauth-state-test-secret";

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("Convex OAuth state", () => {
  test("consumes a matching state exactly once without exposing its hash", async () => {
    const t = convexTest(schema, modules);
    const secretHash = "a".repeat(64);
    const pkceVerifierHash = "e".repeat(64);
    const created = await t.mutation(convexApi.oauthStates.create, {
      serviceSecret,
      workspace: "test",
      id: "oauth_1234567890abcdef",
      secretHash,
      pkceVerifierHash,
      returnTo: "https://stensibly.com/projects/scrapbook",
      expiresAt: Date.now() + 60_000,
    }) as any;
    expect(created).toMatchObject({
      id: "oauth_1234567890abcdef",
      returnTo: "https://stensibly.com/projects/scrapbook",
      consumedAt: null,
    });
    expect(JSON.stringify(created)).not.toContain(secretHash);
    expect(JSON.stringify(created)).not.toContain(pkceVerifierHash);

    const consumed = await t.mutation(convexApi.oauthStates.consume, {
      serviceSecret,
      workspace: "test",
      id: created.id,
      secretHash,
      pkceVerifierHash,
    }) as any;
    expect(consumed.consumedAt).not.toBeNull();
    expect(JSON.stringify(consumed)).not.toContain(secretHash);
    expect(JSON.stringify(consumed)).not.toContain(pkceVerifierHash);

    const replay = await t.mutation(convexApi.oauthStates.consume, {
      serviceSecret,
      workspace: "test",
      id: created.id,
      secretHash,
      pkceVerifierHash,
    });
    expect(replay).toBeNull();
  });

  test("rejects wrong hashes, workspaces, malformed hashes, and expired state", async () => {
    const t = convexTest(schema, modules);
    const secretHash = "b".repeat(64);
    const pkceVerifierHash = "f".repeat(64);
    const created = await t.mutation(convexApi.oauthStates.create, {
      serviceSecret,
      workspace: "test",
      id: "oauth_abcdef1234567890",
      secretHash,
      pkceVerifierHash,
      returnTo: "https://stensibly.com/",
      expiresAt: Date.now() + 60_000,
    }) as any;

    for (const input of [
      { workspace: "test", secretHash: "c".repeat(64), pkceVerifierHash },
      { workspace: "other", secretHash, pkceVerifierHash },
      { workspace: "test", secretHash: "malformed", pkceVerifierHash, id: created.id },
      { workspace: "test", secretHash, pkceVerifierHash: "0".repeat(64), id: created.id },
      { workspace: "test", secretHash, pkceVerifierHash, id: "invalid-state-id" },
    ]) {
      const result = await t.mutation(convexApi.oauthStates.consume, {
        serviceSecret,
        workspace: input.workspace,
        id: input.id ?? created.id,
        secretHash: input.secretHash,
        pkceVerifierHash: input.pkceVerifierHash,
      });
      expect(result).toBeNull();
    }

    const future = Date.now() + 120_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(future);
    try {
      const expired = await t.mutation(convexApi.oauthStates.consume, {
        serviceSecret,
        workspace: "test",
        id: created.id,
        secretHash,
        pkceVerifierHash,
      });
      expect(expired).toBeNull();
    } finally {
      clock.mockRestore();
    }

    const recreated = await t.mutation(convexApi.oauthStates.create, {
      serviceSecret,
      workspace: "test",
      id: created.id,
      secretHash,
      pkceVerifierHash,
      returnTo: "https://stensibly.com/retry",
      expiresAt: Date.now() + 60_000,
    }) as any;
    expect(recreated.id).toBe(created.id);
    expect(recreated.returnTo).toBe("https://stensibly.com/retry");
  });

  test("rejects duplicate IDs, oversized lifetimes, and credential-bearing return URLs", async () => {
    const t = convexTest(schema, modules);
    const input = {
      serviceSecret,
      workspace: "test",
      id: "oauth_duplicate123456",
      secretHash: "d".repeat(64),
      pkceVerifierHash: "1".repeat(64),
      returnTo: "https://stensibly.com/",
      expiresAt: Date.now() + 60_000,
    };
    await t.mutation(convexApi.oauthStates.create, input);
    await expect(t.mutation(convexApi.oauthStates.create, input)).rejects.toThrow(
      "already exists",
    );
    await expect(t.mutation(convexApi.oauthStates.create, {
      ...input,
      id: "oauth_too_long_123456",
      expiresAt: Date.now() + 16 * 60_000,
    })).rejects.toThrow("no more than 15 minutes");
    await expect(t.mutation(convexApi.oauthStates.create, {
      ...input,
      id: "oauth_credentials12345",
      returnTo: "https://user:password@stensibly.com/",
    })).rejects.toThrow("cannot contain credentials");
  });
});
