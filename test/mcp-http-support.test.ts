import { describe, expect, test } from "bun:test";
import {
  MCP_PROTOCOL_VERSION,
  callToolEnvelope,
  callToolJson,
  initializeMessage,
  mcpHeaders,
  mcpRequest,
  readJsonRpcResult,
  readToolEnvelope,
  readToolJson,
  toolCall,
  toolsListMessage,
  type McpRequestTarget,
} from "./support/mcp-http.ts";

describe("MCP HTTP test support", () => {
  test("builds one canonical protocol envelope and header set", () => {
    expect(mcpHeaders(null)).toEqual({
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    });
    expect(mcpHeaders("stn.tok_test", { origin: "https://allowed.example" })).toEqual({
      accept: "application/json, text/event-stream",
      authorization: "Bearer stn.tok_test",
      "content-type": "application/json",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      origin: "https://allowed.example",
    });

    expect(initializeMessage(1, { clientName: "support-test" })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "support-test", version: "0.0.1" },
      },
    });
    expect(toolsListMessage(2)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(toolCall(3, "list_work", { project: "scrapbook" })).toEqual({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "list_work",
        arguments: { project: "scrapbook" },
      },
    });
  });

  test("routes in-process requests through the supplied app seam", async () => {
    let capturedPath = "";
    let capturedInit: RequestInit | undefined;
    const app: McpRequestTarget = {
      request(path, init) {
        capturedPath = path;
        capturedInit = init;
        return Response.json({ jsonrpc: "2.0", result: {}, id: 4 });
      },
    };

    const response = await mcpRequest(
      app,
      "stn.tok_test",
      toolsListMessage(4),
      { "x-request-id": "support-request" },
    );

    expect(response.status).toBe(200);
    expect(capturedPath).toBe("/mcp");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toEqual(expect.objectContaining({
      authorization: "Bearer stn.tok_test",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      "x-request-id": "support-request",
    }));
    expect(JSON.parse(String(capturedInit?.body))).toEqual(toolsListMessage(4));
  });

  test("reads generic JSON-RPC results and validates identity and errors", async () => {
    await expect(readJsonRpcResult<{ tools: string[] }>(Response.json({
      jsonrpc: "2.0",
      result: { tools: ["list_work"] },
      id: 5,
    }), 5)).resolves.toEqual({ tools: ["list_work"] });

    await expect(readJsonRpcResult(Response.json({
      jsonrpc: "2.0",
      result: {},
      id: 6,
    }), 7)).rejects.toThrow("did not match 7");

    await expect(readJsonRpcResult(Response.json({
      jsonrpc: "2.0",
      error: { code: -32600, message: "synthetic failure" },
      id: 8,
    }), 8)).rejects.toThrow("synthetic failure");
  });

  test("parses tool envelopes and JSON while preserving typed tool failures", async () => {
    await expect(readToolJson<{ ok: boolean }>(Response.json({
      jsonrpc: "2.0",
      result: { content: [{ type: "text", text: '{"ok":true}' }] },
      id: 9,
    }))).resolves.toEqual({ ok: true });

    await expect(readToolEnvelope(Response.json({
      jsonrpc: "2.0",
      result: { isError: true, content: [{ type: "text", text: "denied" }] },
      id: 10,
    }))).resolves.toEqual({ isError: true, text: "denied" });

    await expect(readToolJson(Response.json({
      jsonrpc: "2.0",
      result: { isError: true, content: [{ type: "text", text: "denied" }] },
      id: 11,
    }))).rejects.toThrow("denied");

    await expect(readToolJson(Response.json({
      jsonrpc: "2.0",
      result: { content: [{ type: "image", data: "ignored" }] },
      id: 12,
    }))).rejects.toThrow("did not contain a text tool result");

    await expect(readToolJson(Response.json({
      jsonrpc: "2.0",
      result: { content: [{ type: "text", text: "not-json" }] },
      id: 13,
    }))).rejects.toThrow("was not valid JSON");
  });

  test("includes bounded response context when a tool call fails", async () => {
    const app: McpRequestTarget = {
      request() {
        return new Response("synthetic denial", { status: 403 });
      },
    };

    await expect(callToolJson(app, "stn.tok_test", 14, "create_item", {}))
      .rejects.toThrow("Remote MCP tool create_item returned 403: synthetic denial");
  });

  test("forwards per-call headers and preserves tool error envelopes", async () => {
    let capturedHeaders: HeadersInit | undefined;
    const app: McpRequestTarget = {
      request(_path, init) {
        capturedHeaders = init?.headers;
        return Response.json({
          jsonrpc: "2.0",
          result: { isError: true, content: [{ type: "text", text: "conflict" }] },
          id: 15,
        });
      },
    };

    await expect(callToolEnvelope(
      app,
      "stn.tok_test",
      15,
      "create_item",
      {},
      { "x-request-id": "operation-15" },
    )).resolves.toEqual({ isError: true, text: "conflict" });
    expect(capturedHeaders).toEqual(expect.objectContaining({
      "x-request-id": "operation-15",
    }));
  });
});
