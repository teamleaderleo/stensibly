import { expect, test } from "bun:test";
import { HttpGitHubOAuthClient } from "../src/hosted-auth.ts";

const exchangeInput = {
  code: "authorization-code-sentinel",
  redirectUri: "https://api.stensibly.com/auth/github/callback",
  codeVerifier: "a".repeat(43),
};

for (const operation of ["preflight", "exchange", "identity"] as const) {
  test(`contains hostile provider error metadata during ${operation}`, async () => {
    let metadataTrapCalls = 0;
    const hostileError = new Proxy(Object.create(null), {
      has() {
        metadataTrapCalls += 1;
        throw new Error("provider error metadata prose must not escape");
      },
      get() {
        metadataTrapCalls += 1;
        throw new Error("provider error getter prose must not escape");
      },
      getPrototypeOf() {
        metadataTrapCalls += 1;
        throw new Error("provider error prototype prose must not escape");
      },
    });
    const client = new HttpGitHubOAuthClient({
      clientId: "github-client-id-sentinel",
      clientSecret: "github-client-secret-sentinel",
      fetch: (async () => {
        throw hostileError;
      }) as unknown as typeof fetch,
    });

    let captured: unknown;
    try {
      if (operation === "preflight") await client.prepareExchange();
      else if (operation === "exchange") await client.exchangeCode(exchangeInput);
      else await client.readIdentity("github-token-sentinel");
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(Error);
    expect(captured).toMatchObject({
      name: "ProviderFailure",
      message: "GitHub provider failure",
      stage: operation === "identity" ? "identity_request" : "token_exchange",
      reason: "network_exception",
    });
    expect(String(captured)).not.toContain("provider error");
    expect(metadataTrapCalls).toBeGreaterThan(0);
  });
}
