import { describe, expect, test } from "bun:test";
import {
  MCP_TOOL_COUNT_HEADER,
  MCP_TOOL_MANIFEST_FINGERPRINT_HEADER,
} from "../src/mcp-diagnostics.ts";
import {
  formatResults,
  parseVerifyHostedArgs,
  redactSecrets,
  verifyHosted,
  type FetchLike,
} from "../src/verify-hosted.ts";

const token = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;
const manifestFingerprint = `sha256:${"d".repeat(64)}`;
const manifestToolCount = 19;
const manifestServerVersion = `0.0.1+manifest.${manifestFingerprint.slice(7, 19)}`;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("hosted verifier arguments", () => {
  test("uses safe defaults and environment values", () => {
    const parsed = parseVerifyHostedArgs(["--", "--project", "scrapbook"], {
      STENSIBLY_TOKEN: token,
    });
    expect(parsed).toEqual({
      help: false,
      options: {
        endpoint: "https://api.stensibly.com",
        token,
        origin: "https://www.stensibly.com",
        project: "scrapbook",
      },
    });
  });

  test("lets command arguments override environment values", () => {
    const parsed = parseVerifyHostedArgs([
      "--endpoint", "https://example.test/",
      "--token", token,
      "--origin", "https://dashboard.example.test",
    ], {
      STENSIBLY_ENDPOINT: "https://ignored.test",
      STENSIBLY_TOKEN: "ignored",
    });
    expect(parsed.options).toEqual({
      endpoint: "https://example.test",
      token,
      origin: "https://dashboard.example.test",
    });
  });

  test("rejects missing, unknown, and malformed values", () => {
    expect(() => parseVerifyHostedArgs([], {})).toThrow("token is required");
    expect(() => parseVerifyHostedArgs(["--token"], {})).toThrow("--token requires a value");
    expect(() => parseVerifyHostedArgs(["--wat"], { STENSIBLY_TOKEN: token })).toThrow("Unknown argument");
    expect(() => parseVerifyHostedArgs(["--endpoint", "https://example.test/path"], { STENSIBLY_TOKEN: token }))
      .toThrow("must be an origin");
    expect(() => parseVerifyHostedArgs(["--project", "Not A Slug"], { STENSIBLY_TOKEN: token }))
      .toThrow("lowercase project slug");
  });
});

describe("hosted verifier output", () => {
  test("redacts explicit and token-shaped secrets", () => {
    expect(redactSecrets(`failed with ${token}`, token)).toBe("failed with [REDACTED]");
    expect(redactSecrets(new Error(`server echoed ${token}`))).toBe("server echoed [REDACTED]");
  });

  test("formats a complete summary", () => {
    expect(formatResults([
      { name: "one", ok: true, detail: "good" },
      { name: "two", ok: false, detail: "bad" },
    ])).toBe("[PASS] one: good\n[FAIL] two: bad\n1/2 hosted checks passed");
  });
});

describe("hosted verifier checks", () => {
  test("validates direct options before requesting", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse({});
    };

    await expect(verifyHosted({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
      project: "Bad Project",
    }, fetchImpl)).rejects.toThrow("lowercase project slug");
    await expect(verifyHosted({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
      timeoutMs: 0,
    }, fetchImpl)).rejects.toThrow("timeoutMs");
    expect(calls).toBe(0);
  });

  test("verifies health, Worker receipt, auth, CORS, items, and both MCP eras", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (input, init = {}) => {
      const requestUrl = new URL(String(input));
      calls.push({ url: requestUrl, init });

      if (requestUrl.pathname === "/health") {
        return jsonResponse({ ok: true, backend: "convex" }, 200, {
          "x-request-id": "health-success",
          "x-stensibly-processing-stage": "response_produced",
          "x-stensibly-worker-version-id": "123e4567-e89b-12d3-a456-426614174000",
          "x-stensibly-worker-version-tag": "main.5179d439",
          "x-stensibly-worker-version-created-at": "2026-07-29T11:40:00.000Z",
        });
      }
      if (requestUrl.pathname === "/api/v1/items" && init.method === "OPTIONS") {
        expect(new Headers(init.headers).get("origin")).toBe("https://www.stensibly.com");
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "https://www.stensibly.com",
            "access-control-allow-headers": "Authorization, Content-Type, Idempotency-Key",
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "x-request-id": "cors-success",
          },
        });
      }
      if (requestUrl.pathname === "/api/v1/items") {
        if (!new Headers(init.headers).has("authorization")) {
          return jsonResponse({ error: "A valid Bearer token is required" }, 401, {
            "www-authenticate": "Bearer",
            "x-request-id": "unauth-success",
          });
        }
        expect(requestUrl.searchParams.get("project")).toBe("scrapbook");
        expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${token}`);
        return jsonResponse({ items: [{ id: "item_1" }] }, 200, {
          "x-request-id": "items-success",
        });
      }
      if (requestUrl.pathname === "/mcp") {
        const headers = new Headers(init.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${token}`);
        expect(headers.get("origin")).toBe("https://www.stensibly.com");
        const payload = JSON.parse(String(init.body)) as { method?: string };
        if (payload.method === "initialize") {
          expect(headers.get("mcp-protocol-version")).toBe("2025-06-18");
          return jsonResponse({
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "stensibly", version: manifestServerVersion },
            },
          }, 200, {
            "x-request-id": "mcp-success",
            [MCP_TOOL_MANIFEST_FINGERPRINT_HEADER]: manifestFingerprint,
            [MCP_TOOL_COUNT_HEADER]: String(manifestToolCount),
          });
        }
        expect(payload.method).toBe("server/discover");
        expect(headers.get("mcp-protocol-version")).toBe("2026-07-28");
        expect(headers.get("mcp-method")).toBe("server/discover");
        return jsonResponse({
          jsonrpc: "2.0",
          id: 2,
          result: {
            resultType: "complete",
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: { listChanged: true } },
            _meta: {
              "io.modelcontextprotocol/serverInfo": {
                name: "stensibly",
                version: manifestServerVersion,
              },
            },
          },
        }, 200, {
          "x-request-id": "mcp-discovery-success",
          [MCP_TOOL_MANIFEST_FINGERPRINT_HEADER]: manifestFingerprint,
          [MCP_TOOL_COUNT_HEADER]: String(manifestToolCount),
        });
      }
      throw new Error(`Unexpected request: ${requestUrl}`);
    };

    const results = await verifyHosted({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
      project: "scrapbook",
    }, fetchImpl);

    expect(results).toHaveLength(6);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results[0]?.detail).toContain(
      "workerVersion=123e4567-e89b-12d3-a456-426614174000",
    );
    expect(results[4]?.detail).toContain(`version=${manifestServerVersion}`);
    expect(results[4]?.detail).toContain(`manifest=${manifestFingerprint}`);
    expect(results[4]?.detail).toContain(`tools=${manifestToolCount}`);
    expect(results[5]?.detail).toContain("protocol=2026-07-28");
    expect(calls).toHaveLength(6);
    const output = formatResults(results);
    expect(output).not.toContain(token);
    expect(output).not.toContain("requestId=");
  });

  test("fails MCP verification when the server version contradicts its manifest receipt", async () => {
    const fetchImpl: FetchLike = async (input, init = {}) => {
      const requestUrl = new URL(String(input));
      if (requestUrl.pathname === "/health") {
        return jsonResponse({ ok: true, backend: "convex" }, 200, {
          "x-request-id": "health-success",
          "x-stensibly-processing-stage": "response_produced",
          "x-stensibly-worker-version-id": "123e4567-e89b-12d3-a456-426614174000",
        });
      }
      if (requestUrl.pathname === "/api/v1/items" && init.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "https://www.stensibly.com",
            "access-control-allow-headers": "Authorization, Content-Type",
            "access-control-allow-methods": "GET, OPTIONS",
          },
        });
      }
      if (requestUrl.pathname === "/api/v1/items") {
        if (!new Headers(init.headers).has("authorization")) {
          return jsonResponse({}, 401, { "www-authenticate": "Bearer" });
        }
        return jsonResponse({ items: [] });
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          serverInfo: { name: "stensibly", version: "0.0.1" },
        },
      }, 200, {
        "x-request-id": "stale-server-version",
        [MCP_TOOL_MANIFEST_FINGERPRINT_HEADER]: manifestFingerprint,
        [MCP_TOOL_COUNT_HEADER]: String(manifestToolCount),
      });
    };

    const results = await verifyHosted({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
    }, fetchImpl);

    expect(results[4]).toMatchObject({ name: "remote MCP initialize", ok: false });
    expect(results[4]?.detail).toContain(`Expected MCP serverInfo.version=${manifestServerVersion}`);
    expect(results[4]?.detail).toContain("received 0.0.1");
    expect(results[4]?.detail).toContain("requestId=stale-server-version");
  });

  test("fails health verification when the Worker receipt is missing", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const requestUrl = new URL(String(input));
      if (requestUrl.pathname === "/health") {
        return jsonResponse({ ok: true, backend: "convex" }, 200, {
          "x-request-id": "missing-receipt",
        });
      }
      return jsonResponse({ error: "later check" }, 500, {
        "x-request-id": "later-check",
      });
    };

    const results = await verifyHosted({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
    }, fetchImpl);

    expect(results[0]).toMatchObject({ name: "health", ok: false });
    expect(results[0]?.detail).toContain("x-stensibly-processing-stage=response_produced");
    expect(results[0]?.detail).toContain("requestId=missing-receipt");
  });

  test("runs every check, redacts failures, and includes valid request IDs", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse({ error: `failed for ${token}` }, 500, {
        "x-request-id": "worker-500",
      });
    };

    const results = await verifyHosted({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
    }, fetchImpl);

    expect(calls).toBe(6);
    expect(results).toHaveLength(6);
    expect(results.every((result) => !result.ok)).toBe(true);
    const output = formatResults(results);
    expect(output).not.toContain(token);
    expect(results.every((result) => result.detail.includes("requestId=worker-500"))).toBe(true);
  });

  test("ignores malformed request IDs without losing the diagnosis", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ error: "backend failed" }, 503, {
        "x-request-id": "unsafe request id",
      });

    const results = await verifyHosted({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
    }, fetchImpl);

    expect(results[0]?.detail).toContain("Expected HTTP 200; received HTTP 503");
    expect(results[0]?.detail).not.toContain("requestId=");
  });

  test("redacts a token-shaped request ID", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ error: "backend failed" }, 503, {
        "x-request-id": token,
      });

    const results = await verifyHosted({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
    }, fetchImpl);

    expect(results[0]?.detail).toContain("requestId=[REDACTED]");
    expect(formatResults(results)).not.toContain(token);
  });
});
