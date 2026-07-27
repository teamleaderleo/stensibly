import { describe, expect, test } from "bun:test";
import {
  formatOAuthResults,
  parseVerifyOAuthHostedArgs,
  verifyOAuthHosted,
  type FetchLike,
} from "../src/verify-oauth-hosted.ts";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function enabledFetch(
  endpoint: string,
  issuer: string,
  overrides: {
    health?: Record<string, unknown>;
    responseTypes?: string[];
  } = {},
): { fetchImpl: FetchLike; calls: Array<{ url: URL; authorization: string | null; redirect: RequestRedirect | undefined }> } {
  const calls: Array<{
    url: URL;
    authorization: string | null;
    redirect: RequestRedirect | undefined;
  }> = [];
  const fetchImpl: FetchLike = async (input, init = {}) => {
    const requestUrl = new URL(String(input));
    const headers = new Headers(init.headers);
    calls.push({
      url: requestUrl,
      authorization: headers.get("authorization"),
      redirect: init.redirect,
    });

    if (requestUrl.pathname === "/health") {
      return jsonResponse(overrides.health ?? {
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
        response_types_supported: overrides.responseTypes ?? ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (requestUrl.pathname === "/mcp") {
      const invalid = headers.has("authorization");
      return jsonResponse({ error: "A valid Bearer token is required" }, 401, {
        "www-authenticate": invalid
          ? `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="read write", error="invalid_token"`
          : `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="read write"`,
      });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };
  return { fetchImpl, calls };
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
  test("verifies enabled OAuth on a fallback endpoint without following redirects", async () => {
    const endpoint = "https://worker.example";
    const issuer = "https://api.example";
    const { fetchImpl, calls } = enabledFetch(endpoint, issuer);

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
    const fetchImpl: FetchLike = async (input, init = {}) => {
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
    const fetchImpl: FetchLike = async (_input, init = {}) => {
      calls += 1;
      expect(init.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://api.stensibly.com/health" },
      });
    };

    const results = await verifyOAuthHosted({
      endpoint: "https://worker.example",
      issuer: "https://api.stensibly.com",
      expectation: "enabled",
    }, fetchImpl);

    expect(calls).toBe(5);
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(results.every((result) => result.detail === "Redirects are not allowed")).toBe(true);
  });

  test("requires a healthy service and authorization-code response metadata", async () => {
    const endpoint = "https://worker.example";
    const issuer = "https://api.example";
    const { fetchImpl } = enabledFetch(endpoint, issuer, {
      health: {
        ok: false,
        service: "stensibly",
        backend: "convex",
        surfaces: ["api-v1", "mcp", "auth", "oauth"],
      },
      responseTypes: ["token"],
    });

    const results = await verifyOAuthHosted({ endpoint, issuer, expectation: "enabled" }, fetchImpl);
    expect(results.find((result) => result.name === "health surfaces")).toEqual({
      name: "health surfaces",
      ok: false,
      detail: "Hosted health contract is invalid",
    });
    expect(results.find((result) => result.name === "authorization-server metadata")).toEqual({
      name: "authorization-server metadata",
      ok: false,
      detail: "Authorization-server metadata is invalid",
    });
    expect(results.filter((result) => result.ok)).toHaveLength(3);
  });

  test("keeps response data out of bounded failure diagnostics", async () => {
    const secretBody = "stn.tok_deadbeefdeadbeefdeadbeefdeadbeef.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const secretChallenge = `Bearer token="${"s".repeat(3_000)}"`;
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      if (calls === 4 || calls === 5) {
        return jsonResponse({ error: secretBody }, 401, {
          "www-authenticate": secretChallenge,
          "x-request-id": "oauth-check-401",
        });
      }
      return jsonResponse({ error: secretBody }, 503, {
        "x-request-id": "oauth-check-500",
      });
    };

    const results = await verifyOAuthHosted({
      endpoint: "https://api.stensibly.com",
      issuer: "https://api.stensibly.com",
      expectation: "enabled",
    }, fetchImpl);

    expect(results).toHaveLength(5);
    expect(results.every((result) => !result.ok)).toBe(true);
    const output = formatOAuthResults(results);
    expect(output).not.toContain(secretBody);
    expect(output).not.toContain("token=");
    expect(output).not.toContain("sss");
    expect(output).toContain("requestId=oauth-check-500");
    expect(output).toContain("requestId=oauth-check-401");
    expect(results.slice(3).every((result) => result.detail.includes("exceeds the verifier limit")))
      .toBe(true);
  });

  test("rejects an oversized body before buffering its contents", async () => {
    const fetchImpl: FetchLike = async () => new Response("{}", {
      status: 503,
      headers: {
        "content-type": "application/json",
        "content-length": "32769",
        "x-request-id": "oauth-body-limit",
      },
    });

    const results = await verifyOAuthHosted({
      endpoint: "https://api.stensibly.com",
      issuer: "https://api.stensibly.com",
      expectation: "enabled",
    }, fetchImpl);

    expect(results.every((result) => !result.ok)).toBe(true);
    expect(results.every((result) =>
      result.detail === "Response body exceeds the verifier limit; requestId=oauth-body-limit"
    )).toBe(true);
  });

  test("keeps the timeout active while reading the response body", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          start() {
            // Deliberately never enqueue or close.
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return jsonResponse({ error: "failed" }, 503);
    };

    const results = await verifyOAuthHosted({
      endpoint: "https://api.stensibly.com",
      issuer: "https://api.stensibly.com",
      expectation: "enabled",
      timeoutMs: 100,
    }, fetchImpl);

    expect(calls).toBe(5);
    expect(results[0]).toEqual({
      name: "health surfaces",
      ok: false,
      detail: "Request timed out after 100ms",
    });
    expect(results.slice(1).every((result) => !result.ok)).toBe(true);
  });
});
