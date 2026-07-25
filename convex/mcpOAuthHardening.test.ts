import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "mcp-oauth-hardening-secret";
const workspace = "test";
const resource = "https://api.stensibly.com/mcp";
const redirectUri = "https://chatgpt.com/connector/oauth/callback";
const codeChallenge = "a".repeat(43);

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("Convex MCP OAuth hardening", () => {
  test("does not persist a refresh token without offline_access", async () => {
    const t = convexTest(schema, modules);
    const account = await upsertAccount(t);
    const client = await registerClient(t, ["authorization_code"]);

    await createCode(t, account.account.id, client.clientId, ["read"]);
    const grant = await exchangeCode(t, client.clientId, "oauth_refresh_unusedtoken") as any;
    expect(grant).toMatchObject({ scopes: ["read"] });

    const refreshTokens = await t.run(async (ctx) =>
      await ctx.db.query("mcpOAuthRefreshTokens").collect());
    expect(refreshTokens).toHaveLength(0);
  });

  test("rejects offline_access for clients without the refresh grant", async () => {
    const t = convexTest(schema, modules);
    const account = await upsertAccount(t);
    const client = await registerClient(t, ["authorization_code"]);

    await expect(createCode(
      t,
      account.account.id,
      client.clientId,
      ["read", "offline_access"],
    )).rejects.toThrow("OAuth client is not registered for refresh tokens");
  });

  test("replay revokes the active leaf after more than 100 rotations", async () => {
    const t = convexTest(schema, modules);
    const account = await upsertAccount(t);
    const client = await registerClient(t, ["authorization_code", "refresh_token"]);

    await createCode(t, account.account.id, client.clientId, ["read", "offline_access"]);
    await exchangeCode(t, client.clientId, refreshId(0));

    let currentId = refreshId(0);
    let currentHash = hashFor(0);
    for (let index = 1; index <= 105; index += 1) {
      const nextId = refreshId(index);
      const nextHash = hashFor(index);
      const rotated = await t.mutation(convexApi.mcpOAuth.rotateRefreshToken, {
        serviceSecret,
        workspace,
        id: currentId,
        secretHash: currentHash,
        clientId: client.clientId,
        nextId,
        nextSecretHash: nextHash,
        nextExpiresAt: Date.now() + 120_000,
      }) as any;
      expect(rotated.status).toBe("ok");
      currentId = nextId;
      currentHash = nextHash;
    }

    const replay = await t.mutation(convexApi.mcpOAuth.rotateRefreshToken, {
      serviceSecret,
      workspace,
      id: refreshId(0),
      secretHash: hashFor(0),
      clientId: client.clientId,
      nextId: "oauth_refresh_replaytarget",
      nextSecretHash: "e".repeat(64),
      nextExpiresAt: Date.now() + 120_000,
    }) as any;
    expect(replay).toEqual({ status: "replayed" });

    const activeAfterReplay = await t.mutation(convexApi.mcpOAuth.rotateRefreshToken, {
      serviceSecret,
      workspace,
      id: currentId,
      secretHash: currentHash,
      clientId: client.clientId,
      nextId: "oauth_refresh_afterreplayx",
      nextSecretHash: "f".repeat(64),
      nextExpiresAt: Date.now() + 120_000,
    }) as any;
    expect(activeAfterReplay).toEqual({ status: "replayed" });
  });
});

async function upsertAccount(t: ReturnType<typeof convexTest>) {
  return await t.mutation(convexApi.accounts.upsertProviderIdentity, {
    serviceSecret,
    workspace,
    provider: "github",
    subject: "1001",
    username: "teamleaderleo",
    displayName: "Leo",
    emailVerified: false,
    bootstrapRole: "member",
    projects: ["scrapbook"],
  }) as any;
}

async function registerClient(
  t: ReturnType<typeof convexTest>,
  grantTypes: string[],
) {
  return await t.mutation(convexApi.mcpOAuth.registerClient, {
    serviceSecret,
    workspace,
    clientId: "oauth_client_abcdefghijkl",
    clientName: "ChatGPT",
    redirectUris: [redirectUri],
    tokenEndpointAuthMethod: "none",
    grantTypes,
    responseTypes: ["code"],
  }) as any;
}

async function createCode(
  t: ReturnType<typeof convexTest>,
  accountId: string,
  clientId: string,
  scopes: ("read" | "write" | "offline_access")[],
) {
  return await t.mutation(convexApi.mcpOAuth.createAuthorizationCode, {
    serviceSecret,
    workspace,
    accountId,
    clientId,
    redirectUri,
    codeChallenge,
    scopes,
    resource,
    id: "oauth_code_abcdefghijkl",
    secretHash: "a".repeat(64),
    expiresAt: Date.now() + 60_000,
  });
}

async function exchangeCode(
  t: ReturnType<typeof convexTest>,
  clientId: string,
  refreshIdValue: string,
) {
  return await t.mutation(convexApi.mcpOAuth.exchangeAuthorizationCode, {
    serviceSecret,
    workspace,
    id: "oauth_code_abcdefghijkl",
    secretHash: "a".repeat(64),
    clientId,
    redirectUri,
    codeChallenge,
    refreshId: refreshIdValue,
    refreshSecretHash: hashFor(0),
    refreshExpiresAt: Date.now() + 120_000,
  });
}

function refreshId(index: number): string {
  return `oauth_refresh_${String(index).padStart(12, "0")}`;
}

function hashFor(index: number): string {
  const digit = (index % 10).toString(16);
  return digit.repeat(64);
}
