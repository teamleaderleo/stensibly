import { describe, expect, test } from "bun:test";
import {
  formatOAuthResults,
  MAX_OAUTH_VERIFY_RESPONSE_BYTES,
  parseVerifyOAuthHostedArgs,
  verifyOAuthHosted,
  type FetchLike,
} from "../src/verify-oauth-hosted.ts";

const endpoint = "https://worker.example";
const issuer = "https://api.example";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function validResponse(input: string | URL | Request, init: RequestInit = {}): Response {
  const requestUrl = new URL(String(input));
  const headers = new Headers(init.headers);
  if (requestUrl.pathname === "/health") {
    return jsonResponse({
      ok: true,
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
    const invalid = headers.has("authorization");
    return jsonResponse({ error: "A valid Bearer token is required" }, 401, {
      "www-authenticate": invalid
        ? `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="read write", error="invalid_token"`
        : `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="read write"`,
    });
  }
  throw new Error("Unexpected verifier request");
}

function validFetch(): FetchLike {
  return async (input, init = {}) => validResponse(input, init);
}

function resultNamed(
  results: Awaited<ReturnType<typeof verifyOAuthHosted>>,
  name: string,
) {
  const result = results.find((entry) => entry.name === name);
  if (!result) throw new Error(`Missing result ${name}`);
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
  test("verifies enabled OAuth on a fallback endpoint without following redirects", async () => {
    const calls: Array<{ url: URL; authorization: string | null; redirect: RequestRedirect | undefined }> = [];
    const fetchImpl: FetchLike = async (input, init = {}) => {
      const headers = new Headers(init.headers);
      calls.push({
        url: new URL(String(input)),
        authorization: headers.get("authorization"),
        redirect: init.redirect,
      });
      return validResponse(input, init);
    };

    const results = await verifyOAuthHosted({ endpoint, issuer, expectation: "enabled" }, fetchImpl);

    expect(results).toHaveLength(5);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(calls).toHaveLength(5);
    expect(calls.every((call) => call.redirect === "manual")).toBe(true);
    expect(calls.at(-1)?.authorization).toBe("Bearer verifier.invalid.token");
    expect(formatOAuthResults(results)).toContain("5/5 OAuth hosted checks passed");
  });

  test("verifies the disabled baseline and rollback state", async () => {
    const fetchImpl: FetchLike = async (input, init = {}) => {
      const requestUrl = new URL(String(input));
      if (requestUrl.pathname === "/health") {
        return jsonResponse({ ok: true, backend: "convex", surfaces: ["api-v1", "mcp", "auth"] });
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
      throw new Error("Unexpected verifier request");
    };

    const results = await verifyOAuthHosted({
      endpoint: "https://api.stensibly.com",
      issuer: "https://api.stensibly.com",
      expectation: "disabled",
    }, fetchImpl);

    expect(results).toHaveLength(5);
    expect(results.every((result) => result.ok)).toBe(true);
  });

  test("runs all checks and reports only bounded validated request IDs", async () => {
    let calls = 0;
    const privateBody = "credential=secret-private-callback";
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Response(privateBody, {
        status: 503,
        headers: {
          "content-type": "text/plain",
          "x-request-id": "oauth-check-500",
          "x-private-upstream": privateBody,
        },
      });
    };

    const results = await verifyOAuthHosted({ endpoint, issuer, expectation: "enabled" }, fetchImpl);
    const formatted = formatOAuthResults(results);

    expect(calls).toBe(5);
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(results.every((result) => result.detail.includes("requestId=oauth-check-500"))).toBe(true);
    expect(formatted).not.toContain(privateBody);
    expect(formatted).not.toContain("x-private-upstream");
  });

  test("rejects every redirect without certifying the redirect target", async () => {
    const redirects: Array<RequestRedirect | undefined> = [];
    const fetchImpl: FetchLike = async (_input, init = {}) => {
      redirects.push(init.redirect);
      return new Response(null, {
        status: 302,
        headers: {
          location: `${issuer}/health`,
          "x-request-id": "redirect-302",
        },
      });
    };

    const results = await verifyOAuthHosted({ endpoint, issuer, expectation: "enabled" }, fetchImpl);
    const formatted = formatOAuthResults(results);

    expect(results).toHaveLength(5);
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(results.every((result) => result.detail.includes("Unexpected redirect response HTTP 302")))
      .toBe(true);
    expect(redirects.every((value) => value === "manual")).toBe(true);
    expect(formatted).not.toContain(`${issuer}/health`);
  });

  test("requires a healthy response and authorization-code metadata", async () => {
    const fetchImpl: FetchLike = async (input, init = {}) => {
      const requestUrl = new URL(String(input));
      if (requestUrl.pathname === "/health") {
        return jsonResponse({
          ok: false,
          backend: "convex",
          surfaces: ["api-v1", "mcp", "auth", "oauth"],
        });
      }
      if (requestUrl.pathname === "/.well-known/oauth-authorization-server") {
        const response = validResponse(input, init);
        const body = await response.json() as Record<string, unknown>;
        delete body.response_types_supported;
        return jsonResponse(body);
      }
      return validResponse(input, init);
    };

    const results = await verifyOAuthHosted({ endpoint, issuer, expectation: "enabled" }, fetchImpl);

    expect(resultNamed(results, "health surfaces")).toMatchObject({
      ok: false,
      detail: "Hosted health contract is incomplete",
    });
    expect(resultNamed(results, "authorization-server metadata")).toMatchObject({
      ok: false,
      detail: "Authorization-server metadata does not match the required code flow",
    });
    expect(results.filter((result) => result.ok)).toHaveLength(3);
  });

  test("keeps the deadline active while the response body stalls", async () => {
    const fetchImpl: FetchLike = async (input, init = {}) => {
      const requestUrl = new URL(String(input));
      if (requestUrl.pathname === "/health") {
        return new Response(new ReadableStream<Uint8Array>({
          start() {
            // Headers arrive, but the body intentionally never completes.
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return validResponse(input, init);
    };

    const results = await verifyOAuthHosted({
      endpoint,
      issuer,
      expectation: "enabled",
      timeoutMs: 100,
    }, fetchImpl);

    expect(resultNamed(results, "health surfaces")).toMatchObject({
      ok: false,
      detail: "Request timed out after 100ms",
    });
    expect(results.filter((result) => result.ok)).toHaveLength(4);
  });

  test("physically bounds response bodies and never prints private content", async () => {
    const privateValue = "oauth_client_secret_private_callback";
    const oversized = JSON.stringify({
      privateValue,
      padding: "x".repeat(MAX_OAUTH_VERIFY_RESPONSE_BYTES),
    });
    const fetchImpl: FetchLike = async (input, init = {}) => {
      const requestUrl = new URL(String(input));
      if (requestUrl.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return new Response(oversized, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "body-too-large",
          },
        });
      }
      return validResponse(input, init);
    };

    const results = await verifyOAuthHosted({ endpoint, issuer, expectation: "enabled" }, fetchImpl);
    const failed = resultNamed(results, "protected-resource metadata");
    const formatted = formatOAuthResults(results);

    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain("Response body exceeds the verifier byte limit");
    expect(failed.detail).toContain("requestId=body-too-large");
    expect(formatted).not.toContain(privateValue);
    expect(results.filter((result) => result.ok)).toHaveLength(4);
  });

  test("does not retain malformed response bodies or raw challenge headers", async () => {
    const privateBody = "private_token=body-secret";
    const privateChallenge = `Bearer ${"private-token-value".repeat(300)}`;
    const fetchImpl: FetchLike = async (input, init = {}) => {
      const requestUrl = new URL(String(input));
      if (requestUrl.pathname === "/health") {
        return new Response(privateBody, {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      if (requestUrl.pathname === "/mcp") {
        return jsonResponse({ error: "token required" }, 401, {
          "www-authenticate": privateChallenge,
        });
      }
      return validResponse(input, init);
    };

    const results = await verifyOAuthHosted({ endpoint, issuer, expectation: "enabled" }, fetchImpl);
    const formatted = formatOAuthResults(results);

    expect(resultNamed(results, "health surfaces").detail).toBe("Response body is not valid JSON");
    expect(resultNamed(results, "required-token MCP challenge").detail)
      .toBe("Bearer challenge exceeds the verifier character limit");
    expect(resultNamed(results, "invalid-token MCP challenge").detail)
      .toBe("Bearer challenge exceeds the verifier character limit");
    expect(formatted).not.toContain(privateBody);
    expect(formatted).not.toContain("private-token-value");
  });
});
