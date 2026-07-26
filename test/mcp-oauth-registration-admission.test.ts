import { describe, expect, test } from "bun:test";
import {
  enforceOAuthRegistrationAdmission,
  type OAuthRegistrationAdmissionOptions,
  type OAuthRegistrationRateLimiter,
} from "../src/mcp-oauth-registration-admission.ts";
import { parseClientRegistration } from "../src/mcp-oauth-protocol.ts";
import {
  observeWorkerRequest,
  type RequestLogRecord,
} from "../src/worker-observability.ts";

const issuer = "https://api.stensibly.com";
const allowedCallback = "https://chatgpt.com/connector/oauth/callback";

class SequenceLimiter implements OAuthRegistrationRateLimiter {
  readonly keys: string[] = [];

  constructor(private readonly outcomes: Array<boolean | Error>) {}

  async limit(input: { key: string }): Promise<{ success: boolean }> {
    this.keys.push(input.key);
    const outcome = this.outcomes.shift() ?? true;
    if (outcome instanceof Error) throw outcome;
    return { success: outcome };
  }
}

describe("MCP OAuth registration admission", () => {
  test("allows the configured ChatGPT callback to reach registration", async () => {
    const limiter = new SequenceLimiter([true]);
    const result = await runRequest(registrationRequest([allowedCallback]), {
      enabled: true,
      rateLimiter: limiter,
      allowedRedirectOrigins: "https://chatgpt.com",
    });

    expect(result.response.status).toBe(201);
    expect(result.registrationCalls).toBe(1);
    expect(limiter.keys).toEqual(["oauth-register"]);
  });

  test("rejects at the limiter before parsing or registration work", async () => {
    const limiter = new SequenceLimiter([false]);
    const request = new Request(`${issuer}/oauth/register`, {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.42",
        "content-type": "application/json",
      },
      body: "not-json-and-must-not-be-parsed",
    });
    const result = await runRequest(request, {
      enabled: true,
      rateLimiter: limiter,
      allowedRedirectOrigins: "https://chatgpt.com",
    });

    expect(result.response.status).toBe(429);
    expect(result.response.headers.get("retry-after")).toBe("60");
    expect(result.registrationCalls).toBe(0);
    expect(limiter.keys).toEqual(["oauth-register"]);
    expect(await result.response.json()).toEqual({
      error: "temporarily_unavailable",
      error_description: "OAuth client registration is temporarily rate limited",
    });
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]).toMatchObject({
      route: "other",
      status: 429,
      failureCategory: "auth_failure",
    });
    const observable = JSON.stringify(result.logs);
    expect(observable).not.toContain("203.0.113.42");
    expect(observable).not.toContain("not-json");
  });

  test("bounds repeated requests before downstream registration", async () => {
    const limiter = new SequenceLimiter([true, true, false]);
    const options: OAuthRegistrationAdmissionOptions = {
      enabled: true,
      rateLimiter: limiter,
      allowedRedirectOrigins: "https://chatgpt.com",
    };

    const first = await runRequest(registrationRequest([allowedCallback]), options);
    const second = await runRequest(registrationRequest([allowedCallback]), options);
    const third = await runRequest(registrationRequest([allowedCallback]), options);

    expect([first.response.status, second.response.status, third.response.status])
      .toEqual([201, 201, 429]);
    expect(first.registrationCalls + second.registrationCalls + third.registrationCalls).toBe(2);
    expect(limiter.keys).toEqual(["oauth-register", "oauth-register", "oauth-register"]);
  });

  test("rejects mixed allowed and disallowed redirect origins as one request", async () => {
    const limiter = new SequenceLimiter([true]);
    const result = await runRequest(registrationRequest([
      allowedCallback,
      "https://example.com/oauth/callback",
    ]), {
      enabled: true,
      rateLimiter: limiter,
      allowedRedirectOrigins: "https://chatgpt.com",
    });

    expect(result.response.status).toBe(400);
    expect(result.registrationCalls).toBe(0);
    expect(await result.response.json()).toEqual({
      error: "invalid_client_metadata",
      error_description: "A redirect_uri origin is not allowed",
    });
  });

  test("rejects deceptive hosts, subdomains, credentials, fragments, and HTTP downgrade", async () => {
    const rejected = [
      "https://chatgpt.com.evil.example/oauth/callback",
      "https://sub.chatgpt.com/connector/oauth/callback",
      "https://user:password@chatgpt.com/connector/oauth/callback",
      "https://chatgpt.com/connector/oauth/callback#fragment",
      "http://chatgpt.com/connector/oauth/callback",
    ];

    for (const redirectUri of rejected) {
      const result = await runRequest(registrationRequest([redirectUri]), {
        enabled: true,
        rateLimiter: new SequenceLimiter([true]),
        allowedRedirectOrigins: "https://chatgpt.com",
      });
      expect(result.response.status).toBe(400);
      expect(result.registrationCalls).toBe(0);
    }
  });

  test("fails closed for missing or malformed allowlist configuration", async () => {
    const malformed = [
      undefined,
      "",
      "http://chatgpt.com",
      "https://*.chatgpt.com",
      "https://user@chatgpt.com",
      "https://chatgpt.com/callback",
      "not-a-url",
    ];

    for (const allowedRedirectOrigins of malformed) {
      const result = await runRequest(registrationRequest([allowedCallback]), {
        enabled: true,
        rateLimiter: new SequenceLimiter([true]),
        allowedRedirectOrigins,
      });
      expect(result.response.status).toBe(503);
      expect(result.registrationCalls).toBe(0);
    }

    const missingLimiter = await runRequest(registrationRequest([allowedCallback]), {
      enabled: true,
      allowedRedirectOrigins: "https://chatgpt.com",
    });
    expect(missingLimiter.response.status).toBe(503);
    expect(missingLimiter.registrationCalls).toBe(0);
  });

  test("fails closed when the edge limiter is unavailable", async () => {
    const result = await runRequest(registrationRequest([allowedCallback]), {
      enabled: true,
      rateLimiter: new SequenceLimiter([new Error("binding unavailable")]),
      allowedRedirectOrigins: "https://chatgpt.com",
    });

    expect(result.response.status).toBe(503);
    expect(result.registrationCalls).toBe(0);
    expect(await result.response.json()).toEqual({
      error: "temporarily_unavailable",
      error_description: "OAuth client registration is unavailable",
    });
  });

  test("does not affect ordinary Stensibly tokens or non-registration OAuth routes", async () => {
    const limiter = new SequenceLimiter([false]);
    const options: OAuthRegistrationAdmissionOptions = {
      enabled: true,
      rateLimiter: limiter,
      allowedRedirectOrigins: "https://chatgpt.com",
    };
    const token = "stn.tok_private-value";

    const mcp = await runRequest(new Request(`${issuer}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: "{}",
    }), options);
    const oauthToken = await runRequest(new Request(`${issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code",
    }), options);

    expect(mcp.response.status).toBe(204);
    expect(oauthToken.response.status).toBe(204);
    expect(mcp.downstreamAuthorization).toBe(`Bearer ${token}`);
    expect(limiter.keys).toEqual([]);
    expect(JSON.stringify(mcp.logs)).not.toContain(token);
  });

  test("leaves disabled OAuth registration on the existing downstream path", async () => {
    const limiter = new SequenceLimiter([false]);
    const result = await runRequest(registrationRequest([allowedCallback]), {
      enabled: false,
      rateLimiter: limiter,
      allowedRedirectOrigins: "https://chatgpt.com",
    });

    expect(result.response.status).toBe(201);
    expect(result.registrationCalls).toBe(1);
    expect(limiter.keys).toEqual([]);
  });
});

async function runRequest(
  request: Request,
  options: OAuthRegistrationAdmissionOptions,
): Promise<{
  response: Response;
  registrationCalls: number;
  downstreamAuthorization: string | null;
  logs: RequestLogRecord[];
}> {
  let registrationCalls = 0;
  let downstreamAuthorization: string | null = null;
  const logs: RequestLogRecord[] = [];
  let clock = 0;

  const response = await observeWorkerRequest(
    request,
    async (observedRequest) => {
      const rejection = await enforceOAuthRegistrationAdmission(observedRequest, options);
      if (rejection) return rejection;

      const url = new URL(observedRequest.url);
      if (observedRequest.method === "POST" && url.pathname === "/oauth/register") {
        const contentType = observedRequest.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().startsWith("application/json")) {
          return oauthInputError("Registration request must use application/json");
        }
        try {
          const input = parseClientRegistration(JSON.parse(await observedRequest.text()));
          registrationCalls += 1;
          return Response.json({
            client_id: "oauth_client_test",
            redirect_uris: input.redirectUris,
          }, { status: 201 });
        } catch {
          return oauthInputError("Registration request is invalid");
        }
      }

      downstreamAuthorization = observedRequest.headers.get("authorization");
      return new Response(null, { status: 204 });
    },
    {
      createRequestId: () => "request-test",
      log: (record) => logs.push(record),
      now: () => clock++,
    },
  );

  return { response, registrationCalls, downstreamAuthorization, logs };
}

function registrationRequest(redirectUris: string[]): Request {
  return new Request(`${issuer}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT",
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
}

function oauthInputError(description: string): Response {
  return Response.json({
    error: "invalid_client_metadata",
    error_description: description,
  }, { status: 400 });
}
