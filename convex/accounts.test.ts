import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "account-test-secret";

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("Convex hosted accounts", () => {
  test("reuses provider subjects while refusing to merge accounts by email", async () => {
    const t = convexTest(schema, modules);
    const first = await upsertGithubAccount(t, {
      subject: "1001",
      username: "leo",
      displayName: "Leo",
      email: "LEO@example.com",
    });
    expect(first).toMatchObject({
      account: {
        displayName: "Leo",
        primaryEmail: "leo@example.com",
      },
      identity: {
        provider: "github",
        subject: "1001",
        username: "leo",
        emailVerified: true,
      },
      membership: {
        workspace: "test",
        role: "owner",
        projects: null,
        revokedAt: null,
      },
    });

    const repeated = await upsertGithubAccount(t, {
      subject: "1001",
      username: "teamleaderleo",
      displayName: "Leo Updated",
      email: "leo@example.com",
    });
    expect(repeated.account.id).toBe(first.account.id);
    expect(repeated.account.displayName).toBe("Leo Updated");
    expect(repeated.identity.username).toBe("teamleaderleo");

    const sameEmailDifferentSubject = await upsertGithubAccount(t, {
      subject: "2002",
      username: "another-leo",
      displayName: "Another Leo",
      email: "leo@example.com",
    });
    expect(sameEmailDifferentSubject.account.id).not.toBe(first.account.id);
  });

  test("creates, authenticates, rotates, lists, and revokes hashed browser sessions", async () => {
    const t = convexTest(schema, modules);
    const accountContext = await upsertGithubAccount(t, {
      subject: "1001",
      username: "leo",
      displayName: "Leo",
      email: "leo@example.com",
      role: "member",
      projects: ["scrapbook"],
    });
    const firstHash = "a".repeat(64);
    const nextHash = "b".repeat(64);
    const expiresAt = Date.now() + 60_000;

    const created = await t.mutation(convexApi.accounts.createSession, {
      serviceSecret,
      workspace: "test",
      accountId: accountContext.account.id,
      id: "ses_1234567890abcdef",
      secretHash: firstHash,
      expiresAt,
      userAgent: "Stensibly test browser",
    }) as any;
    expect(created).toMatchObject({
      id: "ses_1234567890abcdef",
      userAgent: "Stensibly test browser",
      revokedAt: null,
    });
    expect(JSON.stringify(created)).not.toContain(firstHash);

    const authenticated = await t.query(convexApi.accounts.authenticateSession, {
      serviceSecret,
      workspace: "test",
      id: created.id,
      secretHash: firstHash,
    }) as any;
    expect(authenticated).toMatchObject({
      account: { id: accountContext.account.id, displayName: "Leo" },
      membership: { role: "member", projects: ["scrapbook"] },
      principal: {
        type: "account",
        accountId: accountContext.account.id,
        workspace: "test",
        role: "member",
        scopes: ["read", "write"],
        projects: ["scrapbook"],
      },
      capabilities: { read: true, write: true, admin: false },
    });

    const wrongHash = await t.query(convexApi.accounts.authenticateSession, {
      serviceSecret,
      workspace: "test",
      id: created.id,
      secretHash: "c".repeat(64),
    });
    expect(wrongHash).toBeNull();

    const rotated = await t.mutation(convexApi.accounts.rotateSession, {
      serviceSecret,
      workspace: "test",
      id: created.id,
      secretHash: firstHash,
      nextSecretHash: nextHash,
      expiresAt: Date.now() + 120_000,
    }) as any;
    expect(rotated.id).toBe(created.id);

    const oldSecret = await t.query(convexApi.accounts.authenticateSession, {
      serviceSecret,
      workspace: "test",
      id: created.id,
      secretHash: firstHash,
    });
    expect(oldSecret).toBeNull();

    const touched = await t.mutation(convexApi.accounts.touchSession, {
      serviceSecret,
      workspace: "test",
      id: created.id,
      secretHash: nextHash,
    }) as any;
    expect(touched.id).toBe(created.id);

    const sessions = await t.query(convexApi.accounts.listSessions, {
      serviceSecret,
      workspace: "test",
      accountId: accountContext.account.id,
    }) as any[];
    expect(sessions).toHaveLength(1);
    expect(JSON.stringify(sessions)).not.toContain(nextHash);

    const updatedAccount = await t.mutation(convexApi.accounts.setDefaultActor, {
      serviceSecret,
      workspace: "test",
      accountId: accountContext.account.id,
      actorId: "leo",
    }) as any;
    expect(updatedAccount.defaultActorId).toBe("leo");

    const revoked = await t.mutation(convexApi.accounts.revokeSession, {
      serviceSecret,
      workspace: "test",
      id: created.id,
    }) as any;
    expect(revoked.revokedAt).not.toBeNull();

    const afterRevocation = await t.query(convexApi.accounts.authenticateSession, {
      serviceSecret,
      workspace: "test",
      id: created.id,
      secretHash: nextHash,
    });
    expect(afterRevocation).toBeNull();
  });
});

async function upsertGithubAccount(
  t: ReturnType<typeof convexTest>,
  input: {
    subject: string;
    username: string;
    displayName: string;
    email: string;
    role?: "owner" | "admin" | "member" | "viewer";
    projects?: string[];
  },
) {
  return await t.mutation(convexApi.accounts.upsertProviderIdentity, {
    serviceSecret,
    workspace: "test",
    provider: "github",
    subject: input.subject,
    username: input.username,
    displayName: input.displayName,
    email: input.email,
    emailVerified: true,
    avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
    bootstrapRole: input.role ?? "owner",
    projects: input.projects,
  }) as any;
}
