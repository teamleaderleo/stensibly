import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import {
  MCP_CORE_TOOL_MANIFEST_FINGERPRINT,
  MCP_CORE_TOOL_NAMES,
  MCP_TOOL_COUNT_HEADER,
  MCP_TOOL_MANIFEST_FINGERPRINT_HEADER,
} from "../src/mcp-diagnostics.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const leo = { id: "leo", name: "Leo", kind: "human" as const };

let store: StensiblyStore;
let app: ReturnType<typeof createServerApp>;
let token: string;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  store.createItem({
    project: "scrapbook",
    kind: "task",
    title: "Read this through modern MCP",
    priority: 50,
    actor: leo,
  });
  const created = createApiToken(store, {
    name: "Modern MCP client",
    scopes: ["read", "write"],
    projects: ["scrapbook"],
  });
  token = created.token;
  app = createServerApp(store);
});

afterEach(() => store.close());

describe("MCP 2026-07-28 dual-era HTTP", () => {
  test("discovers the modern server without an initialize handshake", async () => {
    const response = await modernRequest("discover-1", "server/discover", {});
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      id?: unknown;
      result?: {
        resultType?: unknown;
        supportedVersions?: unknown;
        capabilities?: { tools?: unknown };
        _meta?: Record<string, unknown>;
      };
    };
    expect(payload.id).toBe("discover-1");
    expect(payload.result?.resultType).toBe("complete");
    expect(payload.result?.supportedVersions).toEqual([MODERN_PROTOCOL_VERSION]);
    expect(payload.result?.capabilities?.tools).toEqual({ listChanged: true });
    expect(payload.result?._meta?.["io.modelcontextprotocol/serverInfo"]).toEqual({
      name: "stensibly",
      version: expect.stringMatching(/^0\.0\.1\+manifest\.[a-f0-9]{12}$/),
    });
  });

  test("lists and calls tools directly with self-describing requests", async () => {
    const listed = await modernRequest(1, "tools/list", {});
    expect(listed.status).toBe(200);
    const listPayload = await listed.json() as {
      result?: {
        resultType?: unknown;
        tools?: Array<{ name?: unknown }>;
        ttlMs?: unknown;
        cacheScope?: unknown;
      };
    };
    expect(listPayload.result?.resultType).toBe("complete");
    const names = listPayload.result?.tools?.map((tool) => tool.name) ?? [];
    expect([...names].sort()).toEqual([...MCP_CORE_TOOL_NAMES]);
    expect(listed.headers.get(MCP_TOOL_MANIFEST_FINGERPRINT_HEADER)).toBe(
      MCP_CORE_TOOL_MANIFEST_FINGERPRINT,
    );
    expect(listed.headers.get(MCP_TOOL_COUNT_HEADER)).toBe(
      String(MCP_CORE_TOOL_NAMES.length),
    );
    expect(listPayload.result?.ttlMs).toBeGreaterThan(0);
    expect(listPayload.result?.cacheScope).toBe("private");
    const repeated = await modernRequest("list-repeat", "tools/list", {});
    const repeatedPayload = await repeated.json() as {
      result?: { tools?: Array<{ name?: unknown }> };
    };
    expect(repeatedPayload.result?.tools?.map((tool) => tool.name)).toEqual(names);

    const called = await modernRequest(2, "tools/call", {
      name: "list_work",
      arguments: { project: "scrapbook" },
    }, "list_work");
    expect(called.status).toBe(200);
    const callPayload = await called.json() as {
      result?: {
        resultType?: unknown;
        isError?: unknown;
        content?: Array<{ type?: unknown; text?: unknown }>;
      };
    };
    expect(callPayload.result?.resultType).toBe("complete");
    expect(callPayload.result?.isError).not.toBe(true);
    expect(callPayload.result?.content?.[0]?.type).toBe("text");
    const value = JSON.parse(String(callPayload.result?.content?.[0]?.text));
    expect(value).toEqual([
      expect.objectContaining({ project: "scrapbook", title: "Read this through modern MCP" }),
    ]);
  });

  test("rejects missing routing headers and unsupported revisions before dispatch", async () => {
    const missingMethod = await modernRequest(3, "tools/call", {
      name: "create_item",
      arguments: {
        project: "scrapbook",
        title: "Must not be created",
        actor: leo,
      },
    }, "create_item", { "mcp-method": "" });
    expect(missingMethod.status).toBe(400);
    const missingPayload = await missingMethod.json() as { error?: { code?: unknown } };
    expect(missingPayload.error?.code).toBe(-32020);
    expect(store.listItems({ project: "scrapbook" })).toHaveLength(1);

    const missingName = await modernRequest(4, "tools/call", {
      name: "create_item",
      arguments: {
        project: "scrapbook",
        title: "Must not be created either",
        actor: leo,
      },
    });
    expect(missingName.status).toBe(400);
    const missingNamePayload = await missingName.json() as { error?: { code?: unknown } };
    expect(missingNamePayload.error?.code).toBe(-32020);
    expect(store.listItems({ project: "scrapbook" })).toHaveLength(1);

    const unsupported = await modernRequest(5, "tools/list", {}, undefined, {
      "mcp-protocol-version": "2099-01-01",
    });
    expect(unsupported.status).toBe(400);
    const unsupportedPayload = await unsupported.json() as {
      error?: { code?: unknown; data?: { supported?: unknown; requested?: unknown } };
    };
    expect(unsupportedPayload.error).toMatchObject({
      code: -32022,
      data: {
        supported: [MODERN_PROTOCOL_VERSION],
        requested: "2099-01-01",
      },
    });
  });

  test("retains fixed diagnostics for modern server-construction failures", async () => {
    const failedApp = createServerApp(store, {
      mcp: {
        createModernServer() {
          throw new Error("private modern construction failure");
        },
      },
    });
    const response = await modernRequest(
      6,
      "tools/list",
      {},
      undefined,
      {},
      failedApp,
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("x-stensibly-mcp-failure-stage")).toBe(
      "server_construction",
    );
    expect(response.headers.get("x-stensibly-failure-category")).toBe("mcp_failure");
    expect(await response.text()).not.toContain("private modern construction failure");
  });
});

async function modernRequest(
  id: number | string,
  method: string,
  params: Record<string, unknown>,
  name?: string,
  headerOverrides: Record<string, string> = {},
  target: ReturnType<typeof createServerApp> = app,
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
    ...(name ? { "mcp-name": name } : {}),
    ...headerOverrides,
  };
  if (headers["mcp-method"] === "") delete headers["mcp-method"];
  const body = {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": headers["mcp-protocol-version"],
        "io.modelcontextprotocol/clientInfo": {
          name: "stensibly-modern-test",
          version: "0.0.1",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  return await target.request("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
