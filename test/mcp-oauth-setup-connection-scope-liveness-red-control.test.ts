import { describe, expect, test } from "bun:test";
import type { HostedAccountService } from "../src/hosted-account-service.ts";
import type {
  McpOAuthGrant,
  McpOAuthService,
} from "../src/mcp-oauth-service.ts";
import { createMcpOAuth } from "../src/mcp-oauth.ts";

const issuer = "https://api.stensibly.com";
const resource = `${issuer}/mcp`;
const clientId = "oauth_client_abcdefghijkl";
const code = `oauth_code_abcdefghijkl.${"s".repeat(43)}`;
const verifier = "v".repeat(43);

type RecorderInput = Parameters<NonNullable<McpOAuthService["recordSetupConnection"]>>[0];

describe("MCP setup connection capture scope and liveness", () => {
  test("binds the exact access-token project claim into connection evidence", async () => {
    for (const projects of [["scrapbook"], null] as const) {
      const attempts: Record<string, unknown>[] = [];
      const app = oauthApp(projects, async (input) => {
        attempts.push({ ...input });
      });

      const response = await exchange(app);
      expect(response.status).toBe(200);
      expect(attempts).toEqual([{
        accountId: "acct_test",
        clientId,
        resource,
        projects,
      }]);
    }
  });

  test("a never-settling observational recorder cannot hold the token response open", async () => {
    let observedRecorderCall!: () => void;
    const recorderCalled = new Promise<void>((resolve) => {
      observedRecorderCall = resolve;
    });
    const neverSettles = new Promise<void>(() => {});
    const app = oauthApp(["scrapbook"], async () => {
      observedRecorderCall();
      await neverSettles;
    });

    const responsePromise = exchange(app);
    await recorderCalled;
    const outcome = await Promise.race([
      responsePromise.then((response) => ({ kind: "response" as const, status: response.status })),
      delay(100).then(() => ({ kind: "blocked" as const })),
    ]);
    expect(outcome).toEqual({ kind: "response", status: 200 });
  });
});

function oauthApp(
  projects: readonly string[] | null,
  recorder: (input: RecorderInput) => Promise<void>,
) {
  const service: McpOAuthService = {
    async registerClient() {
      throw new Error("unexpected registration");
    },
    async getClient() {
      throw new Error("unexpected client lookup");
    },
    async createAuthorizationCode() {
      throw new Error("unexpected code creation");
    },
    async exchangeAuthorizationCode() {
      return grant(projects);
    },
    async rotateRefreshToken() {
      return { status: "invalid" };
    },
    async recordSetupConnection(input) {
      await recorder(input);
    },
  };
  const accountService: Pick<HostedAccountService, "authenticateSession"> = {
    async authenticateSession() {
      return null;
    },
  };
  return createMcpOAuth({
    service,
    accountService,
    issuer,
    resource,
    workspace: "default",
    signingSecret: "0123456789abcdef0123456789abcdef",
    now: () => 1_000_000,
    randomBytes: (length) => new Uint8Array(length).fill(7),
  });
}

function grant(projects: readonly string[] | null): McpOAuthGrant {
  return {
    clientId,
    resource,
    scopes: ["read"],
    principal: {
      accountId: "acct_test",
      name: "Leo",
      workspace: "default",
      role: "member",
      scopes: ["read"],
      projects: projects === null ? null : [...projects],
    },
  };
}

async function exchange(app: ReturnType<typeof createMcpOAuth>): Promise<Response> {
  return await app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: "https://chatgpt.com/connector/oauth/callback",
      code,
      code_verifier: verifier,
      resource,
    }),
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
