import { describe, expect, test } from "bun:test";
import {
  formatOAuthAbuseResult,
  parseOAuthAbuseArgs,
  verifyOAuthAbuse,
  type FetchLike,
  type OAuthAbuseOptions,
} from "../src/verify-oauth-abuse.ts";

const endpoint = "https://oauth-staging.example";
const issuer = "https://issuer-staging.example";
const redirectUri = "https://chatgpt.com/connector/oauth/callback";

function options(overrides: Partial<OAuthAbuseOptions> = {}): OAuthAbuseOptions {
  return {
    endpoint,
    issuer,
    mode: "registration-burst",
    requests: 12,
    concurrency: 4,
    timeoutMs: 1_000,
    execute: true,
    runTag: "testrun",
    ...overrides,
  };
}

function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId,
      ...headers,
    },
  });
}

describe("OAuth abuse verifier arguments", () => {
  test("defaults to a dry-run registration burst and retains a generated run tag", () => {
    const parsed = parseOAuthAbuseArgs(["--endpoint", endpoint]);
    expect(parsed.help).toBe(false);
    expect(parsed.options).toMatchObject({
      endpoint,
      issuer: endpoint,
      mode: "registration-burst",
      requests: 12,
      concurrency: 4,
      timeoutMs: 10_000,
      execute: false,
    });
    expect(parsed.options?.runTag).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
  });

  test("supports explicit execution and deterministic run correlation", () => {
    expect(parseOAuthAbuseArgs([
      "--endpoint", endpoint,
      "--issuer", issuer,
      "--mode", "authorization-invalid",
      "--requests", "20",
      "--concurrency", "5",
      "--timeout-ms", "5000",
      "--run-tag", "review-run-7",
      "--execute-non-production",
    ])).toEqual({
      help: false,
      options: {
        endpoint,
        issuer,
        mode: "authorization-invalid",
        requests: 20,
        concurrency: 5,
        timeoutMs: 5_000,
        execute: true,
        runTag: "review-run-7",
      },
    });
  });

  test("rejects DNS-equivalent production origins before any request", () => {
    for (const production of [
      "https://api.stensibly.com",
      "https://API.STENSIBLY.COM:443",
      "https://api.stensibly.com.",
      "https://stensibly-api.leoli-082000.workers.dev",
      "https://STENSIBLY-API.LEOLI-082000.WORKERS.DEV:443",
      "https://stensibly-api.leoli-082000.workers.dev.",
    ]) {
      expect(() => parseOAuthAbuseArgs(["--endpoint", production]))
        .toThrow("refuses known production endpoints");
    }
  });

  test("rejects unsafe origins, invalid tags, and excessive settings", () => {
    expect(() => parseOAuthAbuseArgs([
      "--endpoint", "http://oauth-staging.example",
    ])).toThrow("valid HTTPS origin");
    expect(() => parseOAuthAbuseArgs([
      "--endpoint", `${endpoint}/path`,
    ])).toThrow("valid HTTPS origin");
    expect(() => parseOAuthAbuseArgs([
      "--endpoint", endpoint,
      "--run-tag", "private tag",
    ])).toThrow("runTag is invalid");
    expect(() => parseOAuthAbuseArgs([
      "--endpoint", endpoint,
      "--requests", "51",
    ])).toThrow("between 11 and 50");
    expect(() => parseOAuthAbuseArgs([
      "--endpoint", endpoint,
      "--concurrency", "11",
    ])).toThrow("between 1 and 10");
  });

  test("requires a satisfiable fresh-window registration cohort", () => {
    expect(() => parseOAuthAbuseArgs([
      "--endpoint", endpoint,
      "--mode", "registration-burst",
      "--requests", "10",
    ])).toThrow("between 11 and 50");
    expect(parseOAuthAbuseArgs([
      "--endpoint", endpoint,
      "--mode", "authorization-invalid",
      "--requests", "2",
      "--run-tag", "auth-min",
    ]).options?.requests).toBe(2);
  });
});

describe("guarded OAuth abuse evidence", () => {
  test("dry-run performs no requests and emits the correlation tag", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      throw new Error("should not run");
    };
    const result = await verifyOAuthAbuse(options({ execute: false }), fetchImpl);
    expect(result).toMatchObject({ executed: false, ok: true, runTag: "testrun" });
    expect(result.outcomes).toEqual([]);
    expect(calls).toBe(0);
    expect(formatOAuthAbuseResult(result)).toContain("runTag=testrun");
  });

  test("refuses production aliases at the direct API boundary", async () => {
    let calls = 0;
    await expect(verifyOAuthAbuse(options({
      endpoint: "https://api.stensibly.com.",
    }), async () => {
      calls += 1;
      return jsonResponse({}, 201, "should-not-run");
    })).rejects.toThrow("refuses known production endpoints");
    expect(calls).toBe(0);
  });

  test("observes classified accepted registration and bounded edge rate limiting", async () => {
    const privateMarker = "private-registration-response-secret";
    const calls: Array<{ url: URL; init: RequestInit; body: Record<string, unknown> }> = [];
    const fetchImpl: FetchLike = async (input, init = {}) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url: new URL(String(input)), init, body });
      if (calls.length <= 10) {
        return jsonResponse({ client_id: privateMarker }, 201, `accepted-${calls.length}`);
      }
      return jsonResponse(
        { error: "temporarily_unavailable", error_description: privateMarker },
        429,
        `limited-${calls.length}`,
        { "retry-after": "60" },
      );
    };

    const result = await verifyOAuthAbuse(options(), fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.counts).toMatchObject({
      accepted: 10,
      rateLimited: 2,
      evidenceFailed: 0,
      unexpected: 0,
    });
    expect(calls).toHaveLength(12);
    expect(calls.every((call) => call.url.pathname === "/oauth/register")).toBe(true);
    expect(calls.every((call) => call.init.method === "POST")).toBe(true);
    expect(calls.every((call) => call.init.redirect === "manual")).toBe(true);
    expect(calls.every((call) => new Headers(call.init.headers).get("authorization") === null))
      .toBe(true);
    expect(calls.every((call) => new Headers(call.init.headers).get("cookie") === null)).toBe(true);
    expect(calls.every((call) =>
      Array.isArray(call.body.redirect_uris)
      && call.body.redirect_uris[0] === redirectUri
      && call.body.token_endpoint_auth_method === "none"
      && String(call.body.client_name).includes("testrun")
    )).toBe(true);

    const formatted = formatOAuthAbuseResult(result);
    expect(formatted).toContain("runTag=testrun");
    expect(formatted).toContain("oauthError=temporarily_unavailable");
    expect(formatted).not.toContain(privateMarker);
    expect(formatted).not.toContain(redirectUri);
    expect(formatted).not.toContain("Stensibly abuse verifier");
  });

  test("rejects generic proxy registration statuses", async () => {
    let calls = 0;
    const generic429 = await verifyOAuthAbuse(options(), async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ client_id: "private" }, 201, "accepted-1");
      return new Response("<html>rate limited</html>", {
        status: 429,
        headers: {
          "content-type": "text/html",
          "retry-after": "60",
          "x-request-id": `proxy-${calls}`,
        },
      });
    });
    expect(generic429.ok).toBe(false);
    expect(generic429.counts.evidenceFailed).toBeGreaterThan(0);

    calls = 0;
    const wrongOAuthError = await verifyOAuthAbuse(options(), async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ client_id: "private" }, 201, "accepted-1");
      return jsonResponse({ error: "server_error" }, 429, `wrong-${calls}`, { "retry-after": "60" });
    });
    expect(wrongOAuthError.ok).toBe(false);
    expect(wrongOAuthError.counts.evidenceFailed).toBeGreaterThan(0);
  });

  test("fails when a burst does not prove both acceptance and rate limiting", async () => {
    let calls = 0;
    const allAccepted = await verifyOAuthAbuse(options(), async () => {
      calls += 1;
      return jsonResponse({ client_id: "private" }, 201, `accepted-${calls}`);
    });
    expect(allAccepted.ok).toBe(false);
    expect(allAccepted.counts).toMatchObject({ accepted: 12, rateLimited: 0 });

    calls = 0;
    const badRetry = await verifyOAuthAbuse(options(), async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ client_id: "private" }, 201, "accepted-1")
        : jsonResponse({ error: "temporarily_unavailable" }, 429, `limited-${calls}`, {
          "retry-after": "999",
        });
    });
    expect(badRetry.ok).toBe(false);
    expect(badRetry.counts.unexpected).toBeGreaterThan(0);
  });

  test("loads the classified invalid-client authorization path without redirects", async () => {
    const privateMarker = "private-authorization-body";
    const calls: URL[] = [];
    const fetchImpl: FetchLike = async (input, init = {}) => {
      const requestUrl = new URL(String(input));
      calls.push(requestUrl);
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("manual");
      expect(new Headers(init.headers).get("authorization")).toBeNull();
      expect(new Headers(init.headers).get("cookie")).toBeNull();
      return jsonResponse(
        { error: "invalid_request", error_description: privateMarker },
        400,
        `auth-${calls.length}`,
      );
    };

    const result = await verifyOAuthAbuse(options({
      mode: "authorization-invalid",
      requests: 9,
      concurrency: 3,
    }), fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.counts).toMatchObject({ rejected: 9, redirected: 0, evidenceFailed: 0, unexpected: 0 });
    expect(calls).toHaveLength(9);
    for (const call of calls) {
      expect(call.pathname).toBe("/oauth/authorize");
      expect(call.searchParams.get("response_type")).toBe("code");
      expect(call.searchParams.get("client_id")).toBe("oauth_client_abuseverify01");
      expect(call.searchParams.get("redirect_uri")).toBe(redirectUri);
      expect(call.searchParams.get("code_challenge_method")).toBe("S256");
      expect(call.searchParams.get("resource")).toBe(`${issuer}/mcp`);
      expect(call.searchParams.get("state")).toContain("testrun");
    }
    const formatted = formatOAuthAbuseResult(result);
    expect(formatted).toContain("oauthError=invalid_request");
    expect(formatted).not.toContain(privateMarker);
    expect(formatted).not.toContain(redirectUri);
  });

  test("rejects a generic proxy 400 and oversized OAuth evidence", async () => {
    const generic = await verifyOAuthAbuse(options({
      mode: "authorization-invalid",
      requests: 2,
      concurrency: 1,
    }), async (_input, _init) => new Response("<html>bad request</html>", {
      status: 400,
      headers: { "content-type": "text/html", "x-request-id": "proxy-400" },
    }));
    expect(generic.ok).toBe(false);
    expect(generic.counts.evidenceFailed).toBe(2);

    const oversized = await verifyOAuthAbuse(options({
      mode: "authorization-invalid",
      requests: 2,
      concurrency: 1,
    }), async () => new Response("x".repeat(3_000), {
      status: 400,
      headers: {
        "content-type": "application/json",
        "content-length": "3000",
        "x-request-id": "oversized-400",
      },
    }));
    expect(oversized.ok).toBe(false);
    expect(oversized.outcomes.every((entry) => entry.evidenceFailure === "body_too_large")).toBe(true);
  });

  test("rejects authorization redirects without retaining their target", async () => {
    const privateLocation = "https://private.example/callback?secret=value";
    const result = await verifyOAuthAbuse(options({
      mode: "authorization-invalid",
      requests: 2,
      concurrency: 1,
    }), async () => new Response("private-body", {
      status: 302,
      headers: { location: privateLocation },
    }));
    expect(result.ok).toBe(false);
    expect(result.counts.redirected).toBe(2);
    const formatted = formatOAuthAbuseResult(result);
    expect(formatted).not.toContain(privateLocation);
    expect(formatted).not.toContain("private-body");
  });

  test("rejects a response-origin mismatch", async () => {
    const result = await verifyOAuthAbuse(options({
      mode: "authorization-invalid",
      requests: 2,
      concurrency: 1,
    }), async () => {
      const response = jsonResponse({ error: "invalid_request" }, 400, "origin-mismatch");
      Object.defineProperty(response, "url", { value: "https://other.example/oauth/authorize" });
      return response;
    });
    expect(result.ok).toBe(false);
    expect(result.outcomes.every((entry) => entry.transportFailure === "origin_mismatch")).toBe(true);
  });

  test("physically respects request and concurrency bounds", async () => {
    let active = 0;
    let maximumActive = 0;
    const fetchImpl: FetchLike = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return jsonResponse({ error: "invalid_request" }, 400, `concurrent-${maximumActive}`);
    };
    const result = await verifyOAuthAbuse(options({
      mode: "authorization-invalid",
      requests: 9,
      concurrency: 3,
    }), fetchImpl);
    expect(result.ok).toBe(true);
    expect(maximumActive).toBeLessThanOrEqual(3);

    await expect(verifyOAuthAbuse(options({ requests: 51 }), fetchImpl))
      .rejects.toThrow("between 11 and 50");
    await expect(verifyOAuthAbuse(options({ concurrency: 11 }), fetchImpl))
      .rejects.toThrow("between 1 and 10");
  });

  test("times out a stalled response body with a fixed classification", async () => {
    let cancelled = false;
    const result = await verifyOAuthAbuse(options({
      mode: "authorization-invalid",
      requests: 2,
      concurrency: 1,
      timeoutMs: 100,
    }), async () => new Response(new ReadableStream<Uint8Array>({
      start() {
        // Deliberately never enqueue or close.
      },
      cancel() {
        cancelled = true;
      },
    }), {
      status: 400,
      headers: {
        "content-type": "application/json",
        "x-request-id": "stalled-body",
      },
    }));
    expect(result.ok).toBe(false);
    expect(result.outcomes.every((entry) => entry.transportFailure === "timeout")).toBe(true);
    expect(cancelled).toBe(true);
  });

  test("uses fixed transport failures without exposing thrown errors", async () => {
    const privateMarker = "private-upstream-exception";
    const result = await verifyOAuthAbuse(options({
      mode: "authorization-invalid",
      requests: 2,
      concurrency: 1,
    }), async () => {
      throw new Error(privateMarker);
    });
    expect(result.ok).toBe(false);
    expect(result.outcomes.every((entry) => entry.transportFailure === "request_failed")).toBe(true);
    expect(formatOAuthAbuseResult(result)).not.toContain(privateMarker);
  });
});
