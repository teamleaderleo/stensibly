import { describe, expect, test } from "bun:test";
import {
  formatOAuthResults,
  parseVerifyOAuthHostedArgs,
  verifyOAuthHosted,
  type FetchLike,
} from "../src/verify-oauth-hosted.ts";

const endpoint = "https://worker.example";
const issuer = "https://api.example";

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function enabledFetch(
  override?: (requestUrl: URL, init: RequestInit) => Response | Promise<Response> | undefined,
): FetchLike {
  return async (input, init: RequestInit = {}) => {
    const requestUrl = new URL(String(input));
    const overridden = await override?.(requestUrl, init);
    if (overridden) return overridden;

    if (requestUrl.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "stensibly",
        backend: "convex",
        surfaces: ["api-v1", "mcp", "auth", "oauth"],
      });
    }
    if (requestUrl.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return jsonResponse({
        resource: `${issuer}/mcp`,
        authorization_servers: [issuer],
        scopes_supported: ["read", "write"],
        bearer_methods_supported: ["header"],
      });
    }
    if (requestUrl.pathname === "/.well-known/oauth-authorization-server") {
      return jsonResponse({
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        scopes_supported: ["read", "write", "offline_access"],
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (requestUrl.pathname === "/mcp") {
      const invalid = new Headers(init.headers).has("authorization");
      return jsonResponse({ error: "A valid Bearer token is required" }, 401, {
        "www-authenticate": invalid
          ? `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="read write", error="invalid_token"`
          : `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="read write"`,
      });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };
}

function resultNamed(
  results: Awaited<ReturnType<typeof verifyOAuthHosted>>,
  name: string,
) {
  const result = results.find((entry) => entry.name === name);
  if (!result) throw new Error(`Missing verifier result: ${name}`);
  return result;
}

describe("OAuth hosted verifier arguments", () => {
  test("uses canonical defaults and supports fallback endpoints", () => {
    expect(parseVerifyOAuthHostedArgs([])).toEqual({
      help: false,
      options: {
        endpoint: "https://api.stensibly.com",
        issuer: "https://api.stensibly.com",
        expectation: "enabled",
      },
    });
    expect(parseVerifyOAuthHostedArgs([
      "--",
      "--endpoint", "https://worker.example/",
      "--issuer", "https://api.example",
      "--expect", "disabled",
    ])).toEqual({
      help: false,
      options: {
        endpoint: "https://worker.example",
        issuer: "https://api.example",
        expectation: "disabled",
      },
    });
  });

  test("rejects malformed options", () => {
    expect(() => parseVerifyOAuthHostedArgs(["--endpoint"])).toThrow("--endpoint requires a value");
    expect(() => parseVerifyOAuthHostedArgs(["--expect", "maybe"])).toThrow("enabled or disabled");
    expect(() => parseVerifyOAuthHostedArgs(["--issuer", "https://api.example/path"])).toThrow(
      "must be an origin",
    );
    expect(() => parseVerifyOAuthHostedArgs(["--unknown"])).toThrow("Unknown argument");
  });
});

describe("OAuth hosted verifier checks", () => {
  test("verifies enabled OAuth on a fallback endpoint with a canonical issuer", async () => {
    const calls: Array<{
      url: URL;
      authorization: string | null;
      redirect: RequestRedirect | undefined;
    }> = [];
    const fetchImpl = enabledFetch((requestUrl, init) => {
      calls.push({
        url: requestUrl,
        authorization: new Headers(init.headers).get("authorization"),
        redirect: init.redirect,
      });
      return undefined;
    });

    const results = await verifyOAuthHosted({
      endpoint,
      issuer,
      expectation: "enabled",
    }, fetchImpl);

    expect(results).toHaveLength(5);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(calls).toHaveLength(5);
    expect(calls.every((call) => call.url.origin === endpoint)).toBe(true);
    expect(calls.every((call) => call.redirect === "manual")).toBe(true);
    expect(calls.at(-1)?.authorization).toBe("Bearer verifier.invalid.token");
    expect(formatOAuthResults(results)).toContain("5/5 OAuth hosted checks passed");
  });

  test("verifies the disabled baseline and rollback state", async () => {
    const fetchImpl: FetchLike = async (input, init: RequestInit = {}) => {
      const requestUrl = new URL(String(input));
      expect(init.redirect).toBe("manual");
      if (requestUrl.pathname === "/health") {
        return jsonResponse({
          ok: true,
          service: "stensibly",
          backend: "convex",
          surfaces: ["api-v1", "mcp", "auth"],
        });
      }
      if (requestUrl.pathname.startsWith("/.well-known/oauth-")) {
        return jsonResponse({ error: "Not found", code: "not_found" }, 404);
      }
      if (requestUrl.pathname === "/mcp") {
        expect(new Headers(init.headers).get("mcp-protocol-version")).toBe("2025-06-18");
        return jsonResponse({ error: "A valid Bearer token is required" }, 401, {
          "www-authenticate": "Bearer",
        });
      }
      throw new Error(`Unexpected request: ${requestUrl}`);
    };

    const results = await verifyOAuthHosted({
      endpoint: "https://api.stensibly.com",
      issuer: "https://api.stensibly.com",
      expectation: "disabled",
    }, fetchImpl);

    expect(results).toHaveLength(5);
    expect(results.every((result) => result.ok)).toBe(true);
  });

  test("rejects redirects instead of certifying their target", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async (_input, init: RequestInit = {}) => {
      calls += 1;
      expect(init.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: {
          location: `${issuer}/redirected`,
          "x-request-id": "oauth-redirect-1",
        },
      });
    };

    const results = await verifyOAuthHosted({
      endpoint,
      issuer,
      expectation: "enabled",
    }, fetchImpl);

    expect(calls).toBe(5);
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(results.every((result) =>
      result.detail === "Unexpected redirect response; status=302; requestId=oauth-redirect-1"
    )).toBe(true);
    expect(formatOAuthResults(results)).not.toContain(`${issuer}/redirected`);
  });

  test("requires healthy status and authorization-code response metadata", async () => {
    const unhealthy = await verifyOAuthHosted({
      endpoint,
      issuer,
      expectation: "enabled",
    }, enabledFetch((requestUrl) => {
      if (requestUrl.pathname === "/health") {
        return jsonResponse({
          ok: false,
          service: "stensibly",
          backend: "convex",
          surfaces: ["auth", "oauth"],
        });
      }
      return undefined;
    }));
    expect(resultNamed(unhealthy, "health surfaces")).toEqual({
      name: "health surfaces",
      ok: false,
      detail: "Health response does not match the hosted contract; status=200",
    });

    const missingResponseType = await verifyOAuthHosted({
      endpoint,
      issuer,
      expectation: "enabled",
    }, enabledFetch((requestUrl) => {
      if (requestUrl.pathname === "/.well-known/oauth-authorization-server") {
        return jsonResponse({
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${issuer}/oauth/token`,
          registration_endpoint: `${issuer}/oauth/register`,
          scopes_supported: ["read", "write", "offline_access"],
          response_types_supported: ["token"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      return undefined;
    }));
    expect(resultNamed(missingResponseType, "authorization-server metadata")).toEqual({
      name: "authorization-server metadata",
      ok: false,
      detail: "Authorization-server metadata does not match the canonical issuer; status=200",
    });
  });

  test("keeps the timeout active through a stalled response body", async () => {
    let healthReturned = false;
    const fetchImpl = enabledFetch((requestUrl) => {
      if (requestUrl.pathname === "/health" && !healthReturned) {
        healthReturned = true;
        return new Response(new ReadableStream<Uint8Array>({
          start() {
            // Return headers but never finish the body.
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return undefined;
    });

    const results = await verifyOAuthHosted({
      endpoint,
      issuer,
      expectation: "enabled",
      timeoutMs: 100,
    }, fetchImpl);

    expect(resultNamed(results, "health surfaces")).toEqual({
      name: "health surfaces",
      ok: false,
      detail: "Request timed out after 100ms",
    });
    expect(results.slice(1).every((result) => result.ok)).toBe(true);
  });

  test("bounds response reads and never prints response payloads", async () => {
    const privateText = "client_secret=private-value callback=https://private.example";
    const oversized = `${privateText}${"x".repeat(70_000)}`;
    const results = await verifyOAuthHosted({
      endpoint,
      issuer,
      expectation: "enabled",
    }, enabledFetch((requestUrl) => {
      if (requestUrl.pathname === "/health") {
        return new Response(oversized, {
          status: 503,
          headers: {
            "content-type": "text/plain",
            "x-request-id": "oauth-large-1",
          },
        });
      }
      return undefined;
    }));

    const health = resultNamed(results, "health surfaces");
    expect(health.ok).toBe(false);
    expect(health.detail).toBe(
      "Response body exceeds the verifier limit; status=503; requestId=oauth-large-1",
    );
    const formatted = formatOAuthResults(results);
    expect(formatted).not.toContain("private-value");
    expect(formatted).not.toContain("private.example");
    expect(formatted.length).toBeLessThan(2_000);
  });

  test("never prints malformed private bodies or raw challenge headers", async () => {
    const privateText = "Bearer oauth_refresh_privatecredential";
    const malformed = await verifyOAuthHosted({
      endpoint,
      issuer,
      expectation: "enabled",
    }, enabledFetch((requestUrl) => {
      if (requestUrl.pathname === "/health") {
        return new Response(privateText, {
          status: 503,
          headers: {
            "content-type": "text/plain",
            "x-request-id": "oauth-private-1",
          },
        });
      }
      return undefined;
    }));
    const malformedOutput = formatOAuthResults(malformed);
    expect(malformedOutput).not.toContain(privateText);
    expect(resultNamed(malformed, "health surfaces").detail).toBe(
      "Response body is not valid JSON; status=503; requestId=oauth-private-1",
    );

    const rawChallenge = `Bearer ${"a".repeat(3_000)}private-challenge`;
    const challenge = await verifyOAuthHosted({
      endpoint,
      issuer,
      expectation: "enabled",
    }, enabledFetch((requestUrl, init) => {
      if (requestUrl.pathname !== "/mcp") return undefined;
      return jsonResponse({ error: "unauthorized" }, 401, {
        "www-authenticate": rawChallenge,
        "x-request-id": new Headers(init.headers).has("authorization")
          ? "oauth-challenge-2"
          : "oauth-challenge-1",
      });
    }));
    const challengeOutput = formatOAuthResults(challenge);
    expect(challengeOutput).not.toContain("private-challenge");
    expect(resultNamed(challenge, "required-token MCP challenge").detail).toBe(
      "WWW-Authenticate challenge is invalid; status=401; requestId=oauth-challenge-1",
    );
    expect(resultNamed(challenge, "invalid-token MCP challenge").detail).toBe(
      "WWW-Authenticate challenge is invalid; status=401; requestId=oauth-challenge-2",
    );

    const control = await verifyOAuthHosted({
      endpoint,
      issuer,
      expectation: "enabled",
    }, enabledFetch((requestUrl) => {
      if (requestUrl.pathname !== "/mcp") return undefined;
      return jsonResponse({ error: "unauthorized" }, 401, {
        "www-authenticate": "Bearer resource_metadata=\"safe\"\u007fprivate",
      });
    }));
    expect(formatOAuthResults(control)).not.toContain("private");
    expect(resultNamed(control, "required-token MCP challenge").detail).toBe(
      "WWW-Authenticate challenge is invalid; status=401",
    );
  });

  test("runs all checks and carries only validated request IDs into failures", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(
        { error: "credential-like-private-response" },
        503,
        { "x-request-id": "oauth-check-500" },
      );
    };

    const results = await verifyOAuthHosted({
      endpoint: "https://api.stensibly.com",
      issuer: "https://api.stensibly.com",
      expectation: "enabled",
    }, fetchImpl);

    expect(calls).toBe(5);
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(results.every((result) => result.detail.includes("requestId=oauth-check-500")))
      .toBe(true);
    expect(formatOAuthResults(results)).not.toContain("credential-like-private-response");
  });
});
