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
    expect(requests[0]?.init?.cache).toBeUndefined();
    expect(requests[0]?.init?.redirect).toBeUndefined();
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
    expect(requests[0]?.init?.cache).toBeUndefined();
    expect(requests[0]?.init?.redirect).toBeUndefined();
    const body = new URLSearchParams(String(requests[0]?.init?.body));
    expect(body.get("code")).toBe(EXCHANGE_INPUT.code);
    expect(body.get("redirect_uri")).toBe(EXCHANGE_INPUT.redirectUri);
    expect(body.get("code_verifier")).toBe(EXCHANGE_INPUT.codeVerifier);
  });

  test("invokes injected fetch without rebinding its receiver", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl = (function (
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      requests.push({ input, init });
      return Promise.resolve(new Response(null, { status: 405 }));
    }) as typeof fetch;
    const client = githubClient(fetchImpl);

    await expect(client.prepareExchange()).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
  });
});

function githubClient(fetchImpl: typeof fetch): HttpGitHubOAuthClient {
  return new HttpGitHubOAuthClient({
    clientId: "github-client-id-sentinel",
    clientSecret: "github-client-secret-sentinel",
    fetch: fetchImpl,
  });
}
