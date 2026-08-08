import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  MCP_TOOL_COUNT_HEADER,
  MCP_TOOL_MANIFEST_FINGERPRINT,
  MCP_TOOL_MANIFEST_FINGERPRINT_HEADER,
  MCP_TOOL_NAMES,
} from "../src/mcp-diagnostics.ts";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import { verifyHostedToolContract } from "../src/verify-hosted-tool-contract.ts";
import type { FetchLike } from "../src/verify-hosted.ts";
import { withHostedGitHubDelegatedReadProvider } from "./support/hosted-mcp-ledger.ts";

const token = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;
const snapshot = JSON.parse(
  readFileSync(new URL("../docs/chatgpt-app-actions.json", import.meta.url), "utf8"),
) as { snapshotVersion: number; toolContractFingerprint: string };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function currentTools(): Promise<unknown[]> {
  const store = new StensiblyStore(":memory:");
  const server = createMcpServer(withHostedGitHubDelegatedReadProvider(
    new SqliteWorkLedger(store),
  ));
  const client = new Client(
    { name: "hosted-tool-contract-test", version: "0.0.1" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
    store.close();
  }
}

function contractHeaders(requestId: string): Record<string, string> {
  return {
    "x-request-id": requestId,
    [MCP_TOOL_MANIFEST_FINGERPRINT_HEADER]: MCP_TOOL_MANIFEST_FINGERPRINT,
    [MCP_TOOL_COUNT_HEADER]: String(MCP_TOOL_NAMES.length),
  };
}

describe("hosted MCP full-contract verification", () => {
  test("verifies live tools/list against the checked-in ChatGPT snapshot", async () => {
    const tools = await currentTools();
    let calls = 0;
    const fetchImpl: FetchLike = async (input, init = {}) => {
      calls += 1;
      expect(new URL(String(input)).pathname).toBe("/mcp");
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(headers.get("origin")).toBe("https://www.stensibly.com");
      expect(headers.get("mcp-protocol-version")).toBe("2025-06-18");
      expect(headers.get("accept-encoding")).toBe("identity");
      expect(init.redirect).toBe("error");
      const payload = JSON.parse(String(init.body)) as { method?: string; id?: number };
      expect(payload).toMatchObject({ method: "tools/list", id: 2 });
      return jsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { tools },
      }, 200, contractHeaders("tool-contract-success"));
    };

    const result = await verifyHostedToolContract({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
    }, fetchImpl);

    expect(calls).toBe(1);
    expect(result).toEqual({
      name: "remote MCP tool contract",
      ok: true,
      detail: `200 tools=${MCP_TOOL_NAMES.length} snapshot=v${snapshot.snapshotVersion} contract=${snapshot.toolContractFingerprint}`,
    });
  });

  test("fails when schema or metadata drift changes the full contract only", async () => {
    const tools = await currentTools() as Array<Record<string, unknown>>;
    const changedTools = tools.map((tool, index) =>
      index === 0
        ? { ...tool, description: `${String(tool.description ?? "")} changed` }
        : tool
    );
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { tools: changedTools },
      }, 200, contractHeaders("tool-contract-drift"));

    const result = await verifyHostedToolContract({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
    }, fetchImpl);

    expect(result).toMatchObject({ name: "remote MCP tool contract", ok: false });
    expect(result.detail).toContain(
      `Expected ChatGPT tool contract ${snapshot.toolContractFingerprint}; received sha256:`,
    );
    expect(result.detail).toContain("requestId=tool-contract-drift");
    expect(result.detail).not.toContain(token);
  });

  test("rejects malformed tool envelopes without retaining provider content", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: {
          tools: [{
            name: "bad-tool",
            description: `private ${token}`,
            inputSchema: "wrong",
          }],
        },
      }, 200, contractHeaders("tool-contract-malformed"));

    const result = await verifyHostedToolContract({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
    }, fetchImpl);

    expect(result).toEqual({
      name: "remote MCP tool contract",
      ok: false,
      detail: "MCP tools/list tool 1 has an invalid input schema",
    });
  });

  test("normalizes manifest-compiler failures without echoing hostile tool identity", async () => {
    const hostileName = "secret://github/private-provider-reference";
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: {
          tools: [{
            name: hostileName,
            inputSchema: { type: "object", properties: {} },
          }],
        },
      }, 200, contractHeaders("tool-contract-hostile-name"));

    const result = await verifyHostedToolContract({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
    }, fetchImpl);

    expect(result).toEqual({
      name: "remote MCP tool contract",
      ok: false,
      detail: "MCP tools/list contract is invalid; requestId=tool-contract-hostile-name",
    });
    expect(result.detail).not.toContain(hostileName);
  });

  test("rejects a declared tools/list body above the verifier byte ceiling", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("{}", {
        status: 200,
        headers: {
          ...contractHeaders("tool-contract-oversized"),
          "content-length": String(1024 * 1024 + 1),
          "content-type": "application/json",
        },
      });

    const result = await verifyHostedToolContract({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
    }, fetchImpl);

    expect(result).toEqual({
      name: "remote MCP tool contract",
      ok: false,
      detail: "MCP tools/list response exceeded 1 MiB",
    });
  });

  test("times out a stalled tools/list response body", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: {
          ...contractHeaders("tool-contract-stalled"),
          "content-type": "application/json",
        },
      });

    const result = await verifyHostedToolContract({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
      timeoutMs: 100,
    }, fetchImpl);

    expect(result).toEqual({
      name: "remote MCP tool contract",
      ok: false,
      detail: "Request timed out after 100ms",
    });
  });

  test("normalizes transport failures without retaining thrown provider prose", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error(`provider failure ${token} secret://private-reference`);
    };

    const result = await verifyHostedToolContract({
      endpoint: "https://api.stensibly.com",
      token,
      origin: "https://www.stensibly.com",
    }, fetchImpl);

    expect(result).toEqual({
      name: "remote MCP tool contract",
      ok: false,
      detail: "MCP tools/list request failed",
    });
  });
});
