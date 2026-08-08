import { describe, expect, test } from "bun:test";
import {
  createAccessToken,
  verifyAccessToken,
} from "../src/mcp-oauth-crypto.ts";
import type { McpOAuthGrant } from "../src/mcp-oauth-service.ts";
import { principalAuthorizationId } from "../src/token-contracts.ts";

const issuer = "https://api.stensibly.com";
const resource = `${issuer}/mcp`;
const workspace = "default";
const signingSecret = new TextEncoder().encode(
  "stable-oauth-principal-test-signing-secret",
);

describe("OAuth principal identity", () => {
  test("survives access-token rotation and remains client-bound", async () => {
    let randomByte = 1;
    const options = {
      issuer,
      resource,
      workspace,
      signingSecret,
      accessTokenSeconds: 900,
      now: () => Date.parse("2026-08-09T00:00:00.000Z"),
      randomBytes: (length: number) => {
        const bytes = new Uint8Array(length);
        bytes.fill(randomByte++);
        return bytes;
      },
    };
    const firstToken = await createAccessToken(grant(), options);
    const secondToken = await createAccessToken(grant(), options);
    const otherClientToken = await createAccessToken(grant({
      clientId: "oauth_client_other",
    }), options);
    const first = await verifyAccessToken(firstToken, options);
    const second = await verifyAccessToken(secondToken, options);
    const otherClient = await verifyAccessToken(otherClientToken, options);

    expect(firstToken).not.toBe(secondToken);
    expect(first?.tokenId).not.toBe(second?.tokenId);
    expect(first?.authorizationId).toMatch(/^oauth_grant_[A-Za-z0-9_-]{43}$/);
    expect(second?.authorizationId).toBe(first?.authorizationId);
    expect(otherClient?.authorizationId).not.toBe(first?.authorizationId);
  });

  test("keeps durable API-token attribution on the token record identity", () => {
    expect(principalAuthorizationId({
      tokenId: "tok_stable_record",
      name: "API token",
      scopes: ["read", "write"],
      projects: ["stensibly"],
    })).toBe("tok_stable_record");
  });
});

function grant(
  overrides: Partial<McpOAuthGrant> = {},
): McpOAuthGrant {
  return {
    clientId: "oauth_client_chatgpt",
    resource,
    scopes: ["read", "write", "offline_access"],
    principal: {
      accountId: "account_leo",
      name: "Leo",
      workspace,
      role: "owner",
      scopes: ["read", "write", "admin"],
      projects: null,
    },
    ...overrides,
  };
}
