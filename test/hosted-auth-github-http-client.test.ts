import { describe, expect, test } from "bun:test";
import {
  HttpGitHubOAuthClient,
  type GitHubProviderFailureReason,
  type GitHubProviderFailureStage,
} from "../src/hosted-auth.ts";

const EXCHANGE_INPUT = {
  code: "authorization-code-sentinel",
  redirectUri: "https://api.stensibly.com/auth/github/callback",
  codeVerifier: "a".repeat(43),
};

const TOKEN = "github-token-sentinel";

describe("HttpGitHubOAuthClient", () => {
  test("classifies non-2xx token exchange without exposing the provider body", async () => {
    const client = githubClient(singleUseFetch(
      new Response(JSON.stringify({
        error: "bad_verification_code",
        error_description: "provider-body-sentinel",
      }), { status: 401 }),
    ));

    const error = await captureFailure(client.exchangeCode(EXCHANGE_INPUT));
    expectFailure(
      error,
      "token_exchange",
      ["provider-body-sentinel", EXCHANGE_INPUT.code],
      "bad_verification_code",
    );
  });

  test("classifies the fixed GitHub token rejection reasons", async () => {
    const reasons: GitHubProviderFailureReason[] = [
      "incorrect_client_credentials",
      "redirect_uri_mismatch",
      "bad_verification_code",
      "unverified_user_email",
    ];
    for (const reason of reasons) {
      const client = githubClient(singleUseFetch(new Response(JSON.stringify({
        error: reason,
        error_description: `provider-${reason}-sentinel`,
      }), { status: 401 })));
      expectFailure(
        await captureFailure(client.exchangeCode(EXCHANGE_INPUT)),
        "token_exchange",
        [`provider-${reason}-sentinel`, EXCHANGE_INPUT.code],
        reason,
      );
    }

    const unknown = githubClient(singleUseFetch(new Response(JSON.stringify({
      error: "application_suspended",
      error_description: "provider-unknown-sentinel",
    }), { status: 403 })));
    expectFailure(
      await captureFailure(unknown.exchangeCode(EXCHANGE_INPUT)),
      "token_exchange",
      ["application_suspended", "provider-unknown-sentinel", EXCHANGE_INPUT.code],
      "provider_rejection",
    );
  });

  test("classifies malformed token JSON and a missing token", async () => {
    const malformed = githubClient(singleUseFetch(
      new Response("{", { status: 200 }),
    ));
    expectFailure(
      await captureFailure(malformed.exchangeCode(EXCHANGE_INPUT)),
      "token_exchange",
      [EXCHANGE_INPUT.code],
      "malformed_response",
    );

    for (const payload of ["scalar", []]) {
      const invalidShape = githubClient(singleUseFetch(tokenResponse(payload)));
      expectFailure(
        await captureFailure(invalidShape.exchangeCode(EXCHANGE_INPUT)),
        "token_exchange",
        [EXCHANGE_INPUT.code, "scalar"],
        "malformed_response",
      );
    }

    const missing = githubClient(singleUseFetch(tokenResponse({ scope: "" })));
    expectFailure(
      await captureFailure(missing.exchangeCode(EXCHANGE_INPUT)),
      "token_exchange",
      [EXCHANGE_INPUT.code],
      "missing_access_token",
    );
  });

  test("accepts an empty token scope and classifies inherited scope", async () => {
    const emptyScope = githubClient(singleUseFetch(tokenResponse({
      access_token: TOKEN,
      scope: "",
    })));
    expect(await emptyScope.exchangeCode(EXCHANGE_INPUT)).toBe(TOKEN);

    const inheritedScope = githubClient(singleUseFetch(tokenResponse({
      access_token: TOKEN,
      scope: "repo, user",
    })));
    expectFailure(
      await captureFailure(inheritedScope.exchangeCode(EXCHANGE_INPUT)),
      "unexpected_scope",
      [TOKEN, EXCHANGE_INPUT.code, "repo"],
    );
  });

  test("classifies a non-2xx identity request without exposing provider content", async () => {
    const client = githubClient(singleUseFetch(
      new Response("identity-provider-body-sentinel", { status: 503 }),
    ));

    const error = await captureFailure(client.readIdentity(TOKEN));
    expectFailure(error, "identity_request", [TOKEN, "identity-provider-body-sentinel"]);
  });

  test("separates provider timeouts from other network exceptions", async () => {
  const cases = [
    {
      error: Object.assign(new Error("timeout-sentinel"), { name: "TimeoutError" }),
      reason: "network_timeout" as const,
      excluded: "timeout-sentinel",
    },
    {
      error: new TypeError("network-exception-sentinel"),
      reason: "network_exception" as const,
      excluded: "network-exception-sentinel",
    },
  ];

  for (const testCase of cases) {
    let calls = 0;
    const throwingFetch = (async () => {
      calls += 1;
      throw testCase.error;
    }) as unknown as typeof fetch;

    const exchangeClient = githubClient(throwingFetch);
    expectFailure(
      await captureFailure(exchangeClient.exchangeCode(EXCHANGE_INPUT)),
      "token_exchange",
      [testCase.excluded, EXCHANGE_INPUT.code],
      testCase.reason,
    );
    expect(calls).toBe(1);

    const identityClient = githubClient(throwingFetch);
    expectFailure(
      await captureFailure(identityClient.readIdentity(TOKEN)),
      "identity_request",
      [testCase.excluded, TOKEN],
      testCase.reason,
    );
    expect(calls).toBe(2);
  }
});

  test("requires an explicit X-OAuth-Scopes header", async () => {
    const client = githubClient(singleUseFetch(identityResponse({
      id: 1001,
      login: "teamleaderleo",
    })));

    const error = await captureFailure(client.readIdentity(TOKEN));
    expectFailure(error, "identity_payload", [TOKEN, "teamleaderleo"]);
  });

  test("classifies malformed identity JSON and invalid identity fields", async () => {
    const malformed = githubClient(singleUseFetch(new Response("{", {
      status: 200,
      headers: { "x-oauth-scopes": "" },
    })));
    expectFailure(
      await captureFailure(malformed.readIdentity(TOKEN)),
      "identity_payload",
      [TOKEN],
    );

    const invalid = githubClient(singleUseFetch(identityResponse({
      id: 1001,
      login: "   ",
    }, "")));
    expectFailure(
      await captureFailure(invalid.readIdentity(TOKEN)),
      "identity_payload",
      [TOKEN],
    );
  });

  test("classifies identity response scope independently", async () => {
    const client = githubClient(singleUseFetch(identityResponse({
      id: 1001,
      login: "teamleaderleo",
    }, "repo")));

    const error = await captureFailure(client.readIdentity(TOKEN));
    expectFailure(error, "unexpected_scope", [TOKEN, "teamleaderleo", "repo"]);
  });

  test("returns a normalized identity on the successful no-scope path", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const client = githubClient(singleUseFetch(identityResponse({
      id: 1001,
      login: "teamleaderleo",
      name: " Leo ",
      avatar_url: "https://avatars.githubusercontent.com/u/1001?v=4",
    }, ""), requests));

    await expect(client.readIdentity(TOKEN)).resolves.toEqual({
      subject: "1001",
      username: "teamleaderleo",
      displayName: "Leo",
      email: undefined,
      emailVerified: false,
      avatarUrl: "https://avatars.githubusercontent.com/u/1001?v=4",
    });
    expect(requests).toHaveLength(1);
    expect(String(requests[0]?.input)).toBe("https://api.github.com/user");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
  });
});

function githubClient(fetchImpl: typeof fetch): HttpGitHubOAuthClient {
  return new HttpGitHubOAuthClient({
    clientId: "github-client-id-sentinel",
    clientSecret: "github-client-secret-sentinel",
    fetch: fetchImpl,
  });
}

function singleUseFetch(
  response: Response,
  requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [],
): typeof fetch {
  let used = false;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    if (used) throw new Error("unexpected fetch call");
    used = true;
    return response;
  }) as typeof fetch;
}

function tokenResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function identityResponse(payload: unknown, scopes?: string): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (scopes !== undefined) headers.set("x-oauth-scopes", scopes);
  return new Response(JSON.stringify(payload), { status: 200, headers });
}

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected provider failure");
}

function expectFailure(
  error: unknown,
  stage: GitHubProviderFailureStage,
  excluded: string[],
  reason?: GitHubProviderFailureReason,
): void {
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({
    name: "ProviderFailure",
    message: "GitHub provider failure",
    stage,
    ...(reason ? { reason } : {}),
  });
  const serialized = JSON.stringify(error);
  expect(serialized).toBe(JSON.stringify({ stage, ...(reason ? { reason } : {}) }));
  for (const value of excluded) expect(serialized).not.toContain(value);
}
