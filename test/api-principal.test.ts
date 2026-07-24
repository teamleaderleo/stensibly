import { describe, expect, test } from "bun:test";
import { createApiV1 } from "../src/api-v1.ts";
import { createHostedApp } from "../src/hosted-app.ts";
import type { WorkLedger } from "../src/ledger.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";
import { FAILURE_CATEGORY_HEADER } from "../src/worker-observability.ts";

const ledger = {} as WorkLedger;

const principals: Record<string, TokenPrincipal> = {
  "read-token": {
    tokenId: "tok_read_secret_id",
    name: "dashboard-reader",
    scopes: ["read"],
    projects: ["scrapbook"],
  },
  "write-token": {
    tokenId: "tok_write_secret_id",
    name: "workflow-writer",
    scopes: ["write"],
    projects: ["scrapbook", "release"],
  },
  "admin-token": {
    tokenId: "tok_admin_secret_id",
    name: "operator",
    scopes: ["admin"],
    projects: null,
  },
};

class PrincipalAuthenticator implements ApiTokenAuthenticator {
  async authenticate(rawToken: string): Promise<TokenPrincipal | null> {
    return principals[rawToken] ?? null;
  }
}

const authenticator = new PrincipalAuthenticator();

describe("GET /api/v1/principal", () => {
  test("reports a project-scoped read token without identifiers", async () => {
    const app = createApiV1(authenticator, ledger, {
      required: true,
      workspace: "default",
    });
    const response = await app.request("/principal", {
      headers: { authorization: "Bearer read-token" },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      principal: {
        kind: "api_token",
        name: "dashboard-reader",
        workspace: "default",
        scopes: ["read"],
        projects: ["scrapbook"],
      },
      capabilities: {
        read: true,
        write: false,
        admin: false,
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("tok_read_secret_id");
    expect(serialized).not.toContain("read-token");
    expect(serialized).not.toContain("tokenId");
    expect(serialized).not.toContain("hash");
  });

  test("reports write-only capability without granting read", async () => {
    const app = createApiV1(authenticator, ledger, { required: true });
    const response = await app.request("/principal", {
      headers: { authorization: "Bearer write-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      principal: {
        kind: "api_token",
        name: "workflow-writer",
        workspace: null,
        scopes: ["write"],
        projects: ["scrapbook", "release"],
      },
      capabilities: {
        read: false,
        write: true,
        admin: false,
      },
    });
  });

  test("reports effective read and write capability for admin", async () => {
    const app = createApiV1(authenticator, ledger, {
      required: true,
      workspace: "default",
    });
    const response = await app.request("/principal", {
      headers: { authorization: "Bearer admin-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      principal: {
        kind: "api_token",
        name: "operator",
        workspace: "default",
        scopes: ["admin"],
        projects: null,
      },
      capabilities: {
        read: true,
        write: true,
        admin: true,
      },
    });
  });

  test("requires an authenticated bearer principal", async () => {
    const app = createApiV1(authenticator, ledger, { required: true });
    const response = await app.request("/principal");

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(response.headers.get(FAILURE_CATEGORY_HEADER)).toBe("auth_failure");
    expect(await response.json()).toEqual({
      error: "A valid Bearer token is required",
    });
  });

  test("propagates the configured hosted workspace", async () => {
    const app = createHostedApp({
      ledger,
      authenticator,
      workspace: "production-workspace",
    });
    const response = await app.request("/api/v1/principal", {
      headers: { authorization: "Bearer read-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      principal: {
        workspace: "production-workspace",
      },
    });
  });
});
