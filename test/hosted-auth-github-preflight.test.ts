import { describe, expect, test } from "bun:test";
import { HttpGitHubOAuthClient } from "../src/hosted-auth.ts";

const EXCHANGE_INPUT = {
  code: "authorization-code-sentinel",
  redirectUri: "https://api.stensibly.com/auth/github/callback",
  codeVerifier: "a".repeat(43),
};

describe("HttpGitHubOAuthClient callback egress hardening", () => {
  test("preflights the exact token endpoint without sending an authorization code", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      return new Response(null, { status: 405 });
    }) as typeof fetch;
    const client = githubClient(fetchImpl);

    await expect(client.prepareExchange()).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(String(requests[0]?.input)).toBe("https://github.com/login/oauth/access_token");
    expect(requests[0]?.init?.method).toBe("GET");
    expect(requests[0]?.init?.cache).toBe("no-store");
    expect(requests[0]?.init?.redirect).toBe("manual");
    expect(requests[0]?.init?.body).toBeUndefined();
  });

  test("serializes the one-shot token exchange form body explicitly", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      return new Response(JSON.stringify({
        access_token: "github-token-sentinel",
        scope: "",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = githubClient(fetchImpl);

    await expect(client.exchangeCode(EXCHANGE_INPUT)).resolves.toBe("github-token-sentinel");
    expect(requests).toHaveLength(1);
    expect(typeof requests[0]?.init?.body).toBe("string");
    expect(requests[0]?.init?.cache).toBe("no-store");
    expect(requests[0]?.init?.redirect).toBe("manual");
    const body = new URLSearchParams(String(requests[0]?.init?.body));
    expect(body.get("code")).toBe(EXCHANGE_INPUT.code);
    expect(body.get("redirect_uri")).toBe(EXCHANGE_INPUT.redirectUri);
    expect(body.get("code_verifier")).toBe(EXCHANGE_INPUT.codeVerifier);
  });
});

function githubClient(fetchImpl: typeof fetch): HttpGitHubOAuthClient {
  return new HttpGitHubOAuthClient({
    clientId: "github-client-id-sentinel",
    clientSecret: "github-client-secret-sentinel",
    fetch: fetchImpl,
  });
}
