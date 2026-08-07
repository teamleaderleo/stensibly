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

const token = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;
const options = {
  endpoint: "https://api.stensibly.com",
  token,
  origin: "https://www.stensibly.com",
};

function contractHeaders(requestId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-request-id": requestId,
    [MCP_TOOL_MANIFEST_FINGERPRINT_HEADER]: MCP_TOOL_MANIFEST_FINGERPRINT,
    [MCP_TOOL_COUNT_HEADER]: String(MCP_TOOL_NAMES.length),
  };
}

function jsonResponse(
  body: unknown,
  requestId: string,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: contractHeaders(requestId),
  });
}

async function currentTools(): Promise<unknown[]> {
  const store = new StensiblyStore(":memory:");
  const server = createMcpServer(new SqliteWorkLedger(store));
  const client = new Client(
    { name: "hosted-tool-contract-protocol-boundary-test", version: "0.0.1" },
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

describe("hosted MCP tool-contract protocol boundaries", () => {
  test("requires the exact JSON-RPC version and response identity", async () => {
    const tools = await currentTools();
    const variants: unknown[] = [
      { jsonrpc: "1.0", id: 2, result: { tools } },
      { jsonrpc: "2.0", id: 3, result: { tools } },
      { id: 2, result: { tools } },
      {
        jsonrpc: "2.0",
        id: 2,
        result: { tools },
        error: { code: -32_000, message: "contradictory response" },
      },
    ];

    for (const [index, body] of variants.entries()) {
      const requestId = `tool-contract-envelope-${index + 1}`;
      const fetchImpl: FetchLike = async () => jsonResponse(body, requestId);
      expect(await verifyHostedToolContract(options, fetchImpl)).toEqual({
        name: "remote MCP tool contract",
        ok: false,
        detail:
          `Expected matching MCP tools/list JSON-RPC response; requestId=${requestId}`,
      });
    }
  });

  test("rejects duplicate JSON keys before contract admission", async () => {
    const tools = await currentTools();
    const body =
      `{"jsonrpc":"2.0","id":2,"id":3,"result":{"tools":${JSON.stringify(tools)}}}`;
    const fetchImpl: FetchLike = async () =>
      new Response(body, {
        status: 200,
        headers: contractHeaders("tool-contract-duplicate-json"),
      });

    expect(await verifyHostedToolContract(options, fetchImpl)).toEqual({
      name: "remote MCP tool contract",
      ok: false,
      detail: "MCP tools/list returned invalid JSON",
    });
  });

  test("classifies a non-success status before consuming a stalled body", async () => {
    let cancellations = 0;
    const fetchImpl: FetchLike = async () =>
      new Response(new ReadableStream<Uint8Array>({
        start() {},
        cancel() {
          cancellations += 1;
        },
      }), {
        status: 401,
        headers: contractHeaders("tool-contract-status-first"),
      });

    const result = await verifyHostedToolContract({
      ...options,
      timeoutMs: 100,
    }, fetchImpl);
    await Promise.resolve();

    expect(result).toEqual({
      name: "remote MCP tool contract",
      ok: false,
      detail:
        "Expected HTTP 200; received HTTP 401; requestId=tool-contract-status-first",
    });
    expect(cancellations).toBe(1);
  });

  test("does not wait for stalled cleanup after a fixed body rejection", async () => {
    let markCancelStarted!: () => void;
    const cancelStarted = new Promise<void>((resolve) => {
      markCancelStarted = resolve;
    });
    const neverSettles = new Promise<void>(() => {});
    const fetchImpl: FetchLike = async () =>
      new Response(new ReadableStream<Uint8Array>({
        cancel() {
          markCancelStarted();
          return neverSettles;
        },
      }), {
        status: 200,
        headers: {
          ...contractHeaders("tool-contract-cleanup-stall"),
          "content-length": "01",
        },
      });

    const verification = verifyHostedToolContract(options, fetchImpl);
    await cancelStarted;
    const stillPending = Symbol("still-pending");
    const result = await Promise.race([
      verification,
      Promise.resolve(stillPending),
    ]);

    expect(result).not.toBe(stillPending);
    expect(result).toEqual({
      name: "remote MCP tool contract",
      ok: false,
      detail: "MCP tools/list returned an invalid Content-Length",
    });
  });

  test("bounds delivered body chunks independently of total bytes", async () => {
    const tools = await currentTools();
    const bytes = new TextEncoder().encode(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { tools },
    }));
    expect(bytes.byteLength).toBeGreaterThan(4096);

    const fetchImpl: FetchLike = async () =>
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (let index = 0; index < 4097; index += 1) {
            controller.enqueue(bytes.slice(index, index + 1));
          }
          controller.enqueue(bytes.slice(4097));
          controller.close();
        },
      }), {
        status: 200,
        headers: {
          ...contractHeaders("tool-contract-chunk-bound"),
          "content-length": String(bytes.byteLength),
        },
      });

    expect(await verifyHostedToolContract(options, fetchImpl)).toEqual({
      name: "remote MCP tool contract",
      ok: false,
      detail: "MCP tools/list response exceeded 4096 chunks",
    });
  });
});
