import { describe, expect, test } from "bun:test";
import type { HostedSessionContext } from "../src/hosted-account-service.js";
import {
  resolveHostedSessionUsageSubject,
  resolveTokenUsageSubject,
} from "../src/hosted-usage-subject.js";
import type { TokenPrincipal } from "../src/token-contracts.js";

const accountId = "acct_public_beta_1";

function session(
  override: Partial<HostedSessionContext> = {},
): HostedSessionContext {
  const base: HostedSessionContext = {
    session: {
      id: "ses_abcdefghijklmnop",
      userAgent: null,
      createdAt: "2026-08-26T00:00:00.000Z",
      lastSeenAt: "2026-08-26T00:00:00.000Z",
      expiresAt: "2026-09-26T00:00:00.000Z",
      revokedAt: null,
    },
    account: {
      id: accountId,
      displayName: "Public beta account",
      primaryEmail: null,
      avatarUrl: null,
      defaultActorId: null,
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
      disabledAt: null,
    },
    membership: {
      workspace: "default",
      role: "member",
      projects: ["alpha"],
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
      revokedAt: null,
    },
    principal: {
      type: "account",
      accountId,
      name: "Public beta account",
      workspace: "default",
      role: "member",
      scopes: ["read"],
      projects: ["alpha"],
    },
    capabilities: { read: true, write: false, admin: false },
  };
  return { ...base, ...override };
}

function token(
  override: Partial<TokenPrincipal> = {},
): TokenPrincipal {
  return {
    tokenId: "tok_access_1",
    name: "Hosted token",
    scopes: ["read"],
    projects: ["alpha"],
    ...override,
  };
}

describe("hosted usage subject resolution", () => {
  test("browser sessions and OAuth access tokens converge on one account allowance owner", () => {
    const browser = resolveHostedSessionUsageSubject(session(), "default");
    const oauth = resolveTokenUsageSubject(token({
      tokenId: "oauth_access_first",
      authorizationId: "oauth_grant_stable_1",
      oauthAccountId: accountId,
      scopes: ["read", "write"],
      projects: null,
    }), "default");

    expect(browser.subject).toEqual({
      kind: "account",
      id: accountId,
      workspace: "default",
    });
    expect(oauth.subject).toEqual(browser.subject);
    expect(oauth.subjectFingerprint).toBe(browser.subjectFingerprint);
    expect(browser.source).toBe("hosted_session_account");
    expect(oauth.source).toBe("oauth_account");
    expect(browser.grantsAuthority).toBe(false);
    expect(oauth.grantsAuthority).toBe(false);
  });

  test("OAuth access-token rotation cannot mint a fresh account usage subject", () => {
    const first = resolveTokenUsageSubject(token({
      tokenId: "oauth_access_first",
      authorizationId: "oauth_grant_stable_1",
      oauthAccountId: accountId,
    }), "default");
    const rotated = resolveTokenUsageSubject(token({
      tokenId: "oauth_access_rotated",
      authorizationId: "oauth_grant_stable_1",
      oauthAccountId: accountId,
    }), "default");

    expect(rotated.subject).toEqual(first.subject);
    expect(rotated.subjectFingerprint).toBe(first.subjectFingerprint);
  });

  test("machine credential rotation reuses the stable authorization identity", () => {
    const first = resolveTokenUsageSubject(token({
      tokenId: "tok_machine_first",
      authorizationId: "service_principal_ci",
    }), "default");
    const rotated = resolveTokenUsageSubject(token({
      tokenId: "tok_machine_rotated",
      authorizationId: "service_principal_ci",
      scopes: ["read", "write", "admin"],
      projects: ["other-project"],
    }), "default");

    expect(first.source).toBe("authorization");
    expect(first.subject).toEqual({
      kind: "authorization",
      id: "service_principal_ci",
      workspace: "default",
    });
    expect(rotated.subject).toEqual(first.subject);
    expect(rotated.subjectFingerprint).toBe(first.subjectFingerprint);
  });

  test("token identity remains the explicit fallback when no stable authorization identity exists", () => {
    const first = resolveTokenUsageSubject(token({ tokenId: "tok_machine_first" }), "default");
    const rotated = resolveTokenUsageSubject(token({ tokenId: "tok_machine_rotated" }), "default");

    expect(first.subject.id).toBe("tok_machine_first");
    expect(rotated.subject.id).toBe("tok_machine_rotated");
    expect(rotated.subjectFingerprint).not.toBe(first.subjectFingerprint);
  });

  test("project and scope authority changes never alter the account usage identity", () => {
    const narrow = resolveTokenUsageSubject(token({
      tokenId: "oauth_access_narrow",
      authorizationId: "oauth_grant_stable_1",
      oauthAccountId: accountId,
      scopes: ["read"],
      projects: ["alpha"],
    }), "default");
    const broad = resolveTokenUsageSubject(token({
      tokenId: "oauth_access_broad",
      authorizationId: "oauth_grant_stable_1",
      oauthAccountId: accountId,
      scopes: ["read", "write", "admin"],
      projects: null,
    }), "default");

    expect(broad.subject).toEqual(narrow.subject);
    expect(broad.subjectFingerprint).toBe(narrow.subjectFingerprint);
    expect(broad.grantsAuthority).toBe(false);
  });

  test("fails closed on cross-workspace or cross-account session context", () => {
    expect(() => resolveHostedSessionUsageSubject(session({
      membership: { ...session().membership, workspace: "other" },
    }), "default")).toThrow("does not match");

    expect(() => resolveHostedSessionUsageSubject(session({
      principal: { ...session().principal, accountId: "acct_other" },
    }), "default")).toThrow("does not match");

    expect(() => resolveHostedSessionUsageSubject(session({
      principal: { ...session().principal, workspace: "other" },
    }), "default")).toThrow("does not match");
  });

  test("fails closed on disabled or revoked session account context", () => {
    expect(() => resolveHostedSessionUsageSubject(session({
      account: {
        ...session().account,
        disabledAt: "2026-08-26T00:01:00.000Z",
      },
    }), "default")).toThrow("unavailable");

    expect(() => resolveHostedSessionUsageSubject(session({
      membership: {
        ...session().membership,
        revokedAt: "2026-08-26T00:01:00.000Z",
      },
    }), "default")).toThrow("unavailable");
  });

  test("rejects malformed workspaces, account ids, and credential-like authorization ids", () => {
    expect(() => resolveTokenUsageSubject(token({
      oauthAccountId: "account-without-prefix",
    }), "default")).toThrow("account identity is invalid");

    expect(() => resolveTokenUsageSubject(token({
      authorizationId: "stn.tok_abcdefghijklmnopqrstuvwxyz",
    }), "default")).toThrow("credential-like text");

    expect(() => resolveTokenUsageSubject(token(), "Default")).toThrow("workspace is invalid");
    expect(() => resolveHostedSessionUsageSubject(session(), "other")).toThrow("does not match");
  });

  test("returns immutable deterministic resolution evidence", () => {
    const first = resolveHostedSessionUsageSubject(session(), "default");
    const second = resolveHostedSessionUsageSubject(session(), "default");

    expect(second).toEqual(first);
    expect(second.subjectFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second.subject)).toBe(true);
  });
});
