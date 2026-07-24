import { describe, expect, test } from "bun:test";
import {
  FAILURE_CATEGORY_HEADER,
  REQUEST_ID_HEADER,
  acceptedRequestId,
  classifyRoute,
  observeWorkerRequest,
  type RequestLogRecord,
} from "../src/worker-observability.ts";

const rawToken = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;

describe("Worker request IDs", () => {
  test("accepts bounded request IDs and rejects unsafe values", () => {
    expect(acceptedRequestId(" client.123:abc ")).toBe("client.123:abc");
    expect(acceptedRequestId("contains spaces")).toBeNull();
    expect(acceptedRequestId("/")).toBeNull();
    expect(acceptedRequestId("a".repeat(129))).toBeNull();
  });

  test("classifies public routes without logging path parameters", () => {
    expect(classifyRoute("/health")).toBe("health");
    expect(classifyRoute("/api/v1/items/item_secret")).toBe("rest_v1");
    expect(classifyRoute("/mcp")).toBe("mcp");
    expect(classifyRoute("/other/private/path")).toBe("other");
  });
});

describe("Worker request logging", () => {
  test("propagates an accepted request ID and logs one safe success record", async () => {
    const records: RequestLogRecord[] = [];
    const times = [10, 16];
    const response = await observeWorkerRequest(
      new Request("https://api.example/api/v1/items?project=private", {
        headers: {
          authorization: `Bearer ${rawToken}`,
          "x-request-id": "client-123",
        },
      }),
      async (request) => {
        expect(request.headers.get(REQUEST_ID_HEADER)).toBe("client-123");
        return Response.json({ items: [] });
      },
      {
        log: (record) => records.push(record),
        now: () => times.shift() ?? 16,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("client-123");
    expect(records).toEqual([{
      event: "request.complete",
      requestId: "client-123",
      method: "GET",
      route: "rest_v1",
      status: 200,
      durationMs: 6,
      outcome: "success",
    }]);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(rawToken);
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("authorization");
  });

  test("generates a request ID when the incoming value is unsafe", async () => {
    const response = await observeWorkerRequest(
      new Request("https://api.example/health", {
        headers: { "x-request-id": "unsafe request id" },
      }),
      async () => Response.json({ ok: true }),
      {
        createRequestId: () => "generated-123",
        log: () => {},
      },
    );

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("generated-123");
  });

  test("uses explicit failure categories and strips the private header", async () => {
    const records: RequestLogRecord[] = [];
    const response = await observeWorkerRequest(
      new Request("https://api.example/api/v1/items"),
      async () => Response.json({ error: "backend failed" }, {
        status: 400,
        headers: { [FAILURE_CATEGORY_HEADER]: "convex_failure" },
      }),
      {
        createRequestId: () => "request-1",
        log: (record) => records.push(record),
      },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get(FAILURE_CATEGORY_HEADER)).toBeNull();
    expect(records[0]?.failureCategory).toBe("convex_failure");
  });

  test("infers auth, CORS, MCP, and request failure categories", async () => {
    const cases = [
      {
        request: new Request("https://api.example/api/v1/items"),
        status: 401,
        expected: "auth_failure",
      },
      {
        request: new Request("https://api.example/api/v1/items", {
          headers: { origin: "https://blocked.example" },
        }),
        status: 403,
        expected: "cors_rejection",
      },
      {
        request: new Request("https://api.example/mcp", { method: "POST" }),
        status: 500,
        expected: "mcp_failure",
      },
      {
        request: new Request("https://api.example/api/v1/items"),
        status: 400,
        expected: "request_failure",
      },
    ] as const;

    for (const testCase of cases) {
      const records: RequestLogRecord[] = [];
      await observeWorkerRequest(
        testCase.request,
        async () => new Response("failed", { status: testCase.status }),
        {
          allowedOrigins: ["https://www.stensibly.com"],
          createRequestId: () => "request-case",
          log: (record) => records.push(record),
        },
      );
      expect(records[0]?.failureCategory).toBe(testCase.expected);
    }
  });

  test("returns a sanitized gateway failure when the handler throws", async () => {
    const records: RequestLogRecord[] = [];
    const response = await observeWorkerRequest(
      new Request("https://api.example/health", {
        headers: { authorization: `Bearer ${rawToken}` },
      }),
      async () => {
        throw new Error(`failure with ${rawToken}`);
      },
      {
        createRequestId: () => "gateway-1",
        log: (record) => records.push(record),
      },
    );

    expect(response.status).toBe(500);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("gateway-1");
    expect(await response.json()).toEqual({
      error: "Unexpected gateway error",
      code: "gateway_failure",
    });
    expect(records[0]?.failureCategory).toBe("gateway_failure");
    expect(JSON.stringify(records)).not.toContain(rawToken);
  });

  test("never replaces an application response when the logger throws", async () => {
    const response = await observeWorkerRequest(
      new Request("https://api.example/health"),
      async () => new Response("healthy", { status: 200 }),
      {
        createRequestId: () => "logger-1",
        log: () => {
          throw new Error("logger unavailable");
        },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("healthy");
  });
});
