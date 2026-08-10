import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  isSuccessfulMcpToolResult,
  withSuccessfulMcpReadObservation,
  type SuccessfulMcpReadObservation,
} from "../src/mcp-successful-read-observation.ts";

type RegisteredHandler = (this: unknown, ...args: unknown[]) => Promise<unknown> | unknown;

function fakeServer() {
  const registrations = new Map<string, RegisteredHandler>();
  const server = {
    registerTool(toolName: string, _config: unknown, handler: RegisteredHandler) {
      registrations.set(toolName, handler);
      return { toolName };
    },
  } as unknown as McpServer;
  return { server, registrations };
}

describe("successful MCP read observation", () => {
  test("observes a successful read after the handler and preserves result identity and receiver", async () => {
    const { server, registrations } = fakeServer();
    const observations: SuccessfulMcpReadObservation[] = [];
    const guarded = withSuccessfulMcpReadObservation(server, async (observation) => {
      observations.push(observation);
    });
    const receiver = { marker: "receiver" };
    const input = { project: "scrapbook" };
    const result = { content: [{ type: "text", text: "ok" }] };
    let handlerCompleted = false;

    guarded.registerTool("get_brief", {} as never, async function (this: unknown) {
      expect(this).toBe(receiver);
      handlerCompleted = true;
      return result;
    } as never);
    const handler = registrations.get("get_brief");
    expect(handler).toBeDefined();
    const returned = await handler!.call(receiver, input);

    expect(handlerCompleted).toBe(true);
    expect(returned).toBe(result);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toEqual({ toolName: "get_brief", arguments: input });
    expect(Object.isFrozen(observations[0])).toBe(true);
  });

  test("never observes writes, failed tool results, thrown handlers, or malformed success envelopes", async () => {
    const { server, registrations } = fakeServer();
    const observations: SuccessfulMcpReadObservation[] = [];
    const guarded = withSuccessfulMcpReadObservation(server, (observation) => {
      observations.push(observation);
    });
    const throwingHandler = async () => {
      throw new Error("handler failure");
    };

    guarded.registerTool("create_item", {} as never, async () => ({
      content: [{ type: "text", text: "write" }],
    }) as never);
    guarded.registerTool("get_brief", {} as never, async () => ({
      content: [{ type: "text", text: "failed" }],
      isError: true,
    }) as never);
    guarded.registerTool("list_work", {} as never, async () => ({}) as never);
    guarded.registerTool("list_artifacts", {} as never, throwingHandler as never);

    await registrations.get("create_item")!({ project: "scrapbook" });
    await registrations.get("get_brief")!({ project: "scrapbook" });
    await registrations.get("list_work")!({ project: "scrapbook" });
    await expect(registrations.get("list_artifacts")!({ id: "item" }))
      .rejects.toThrow("handler failure");
    expect(observations).toEqual([]);
  });

  test("observer failure cannot replace a successful tool result", async () => {
    const { server, registrations } = fakeServer();
    const guarded = withSuccessfulMcpReadObservation(server, () => {
      throw new Error("private evidence failure");
    });
    const result = { content: [{ type: "text", text: "ok" }], isError: false };
    guarded.registerTool("get_brief", {} as never, async () => result as never);
    expect(await registrations.get("get_brief")!({ project: "scrapbook" })).toBe(result);
  });

  test("success admission contains revoked and accessor metadata without invoking getters", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "content", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return [];
      },
    });
    expect(isSuccessfulMcpToolResult(accessor)).toBe(false);
    expect(getterCalls).toBe(0);

    const { proxy, revoke } = Proxy.revocable({ content: [] }, {});
    revoke();
    expect(isSuccessfulMcpToolResult(proxy)).toBe(false);
  });

  test("keeps the original server identity when no observer is configured", () => {
    const { server } = fakeServer();
    expect(withSuccessfulMcpReadObservation(server)).toBe(server);
  });
});
