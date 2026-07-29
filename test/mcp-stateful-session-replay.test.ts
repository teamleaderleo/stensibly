import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  WebStandardStreamableHTTPServerTransport,
  type EventStore,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { StensiblyStore } from "../src/store.ts";

const project = "oauth-dogfood";
const protocolVersion = "2025-11-25";
const actor = {
  id: "kestrel:stateful-replay",
  name: "Kestrel Stateful Replay",
  kind: "agent" as const,
};

class MemoryEventStore implements EventStore {
  readonly events: Array<{
    id: string;
    streamId: string;
    message: JSONRPCMessage;
  }> = [];
  private nextId = 0;

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const id = `event-${++this.nextId}`;
    this.events.push({ id, streamId, message });
    return id;
  }

  async getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    return this.events.find((event) => event.id === eventId)?.streamId;
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> },
  ): Promise<string> {
    const index = this.events.findIndex((event) => event.id === lastEventId);
    if (index < 0) throw new Error(`Unknown event id: ${lastEventId}`);
    const streamId = this.events[index]!.streamId;
    for (const event of this.events.slice(index + 1)) {
      if (event.streamId === streamId) await send(event.id, event.message);
    }
    return streamId;
  }
}

describe("Stensibly stateful MCP result replay", () => {
  test("replays the committed result without re-running the handler, then deduplicates an explicit retry", async () => {
    const store = new StensiblyStore(":memory:");
    const eventStore = new MemoryEventStore();
    let handlerCalls = 0;
    let committedItemId: string | undefined;
    const scheduled: Array<{
      reconnect: () => void;
      delay: number;
      attempt: number;
    }> = [];
    const observedTokens: string[] = [];
    const errors: string[] = [];

    const server = new McpServer(
      { name: "stensibly-stateful-replay", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    server.registerTool(
      "create_item",
      {
        description: "Create a Stensibly item through the real durable store.",
        inputSchema: {
          project: z.string(),
          kind: z.literal("task"),
          title: z.string(),
          summary: z.string().optional(),
          nextAction: z.string().optional(),
          priority: z.number().int(),
          actor: z.object({
            id: z.string(),
            name: z.string(),
            kind: z.literal("agent"),
          }),
          idempotencyKey: z.string(),
        },
      },
      async (input, extra) => {
        handlerCalls += 1;
        const created = store.createItem(
          {
            project: input.project,
            kind: input.kind,
            title: input.title,
            summary: input.summary,
            nextAction: input.nextAction,
            priority: input.priority,
            actor: input.actor,
          },
          input.idempotencyKey,
        );
        committedItemId = created.id;

        // Only the first logical request loses its live response stream. The
        // server transport stores the eventual result in the event store so a
        // Last-Event-ID GET can replay it without invoking this handler again.
        if (handlerCalls === 1) extra.closeSSEStream?.();

        return {
          content: [{ type: "text", text: JSON.stringify(created) }],
        };
      },
    );

    const serverTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => "session-lane-68",
      eventStore,
      retryInterval: 1,
      enableJsonResponse: false,
      keepAliveMs: 0,
    });
    await server.connect(serverTransport);

    const endpoint = new URL("http://stensibly.test/mcp");
    const fetchForServer = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const request = new Request(input, init);
      // Client.connect() may open the optional standalone legacy GET. This
      // fixture isolates request-scoped replay, so decline only GETs without a
      // replay cursor and route every other request through the real transport.
      if (request.method === "GET" && !request.headers.has("last-event-id")) {
        return new Response(null, { status: 405 });
      }
      return await serverTransport.handleRequest(request);
    };

    const clientTransport = new StreamableHTTPClientTransport(endpoint, {
      fetch: fetchForServer,
      reconnectionOptions: {
        initialReconnectionDelay: 1,
        maxReconnectionDelay: 10,
        reconnectionDelayGrowFactor: 2,
        maxRetries: 2,
      },
      reconnectionScheduler(reconnect, delay, attempt) {
        scheduled.push({ reconnect, delay, attempt });
        return () => {};
      },
    });
    const client = new Client({ name: "stensibly-stateful-client", version: "0.0.1" });
    client.onerror = (error) => errors.push(error.message);

    const idempotencyKey = "lane-68-stateful-create-v1";
    const request = {
      project,
      kind: "task" as const,
      title: "Recover the original MCP result",
      summary: "Commit once, disconnect before delivery, then replay by event cursor.",
      nextAction: "Distinguish transport replay from a new application retry.",
      priority: 98,
      actor,
      idempotencyKey,
    };

    try {
      await client.connect(clientTransport);
      expect(client.getServerVersion()?.name).toBe("stensibly-stateful-replay");

      const originalResult = client.callTool(
        { name: "create_item", arguments: request },
        undefined,
        {
          timeout: 5_000,
          onresumptiontoken: (token) => observedTokens.push(token),
        },
      );

      await waitFor(() => handlerCalls === 1, "first durable handler execution");
      await waitFor(() => scheduled.length === 1, "request replay schedule");

      expect(await promiseState(originalResult)).toBe("pending");
      expect(store.listItems({ project })).toHaveLength(1);
      expect(countCreatedEvents(store)).toBe(1);
      expect(committedItemId).toBeDefined();
      expect(observedTokens).toEqual(["event-1"]);
      expect(scheduled[0]).toMatchObject({ delay: 1, attempt: 0 });

      scheduled.shift()!.reconnect();
      const replayedEnvelope = await originalResult;
      const replayedItem = readToolJson<{ id: string; title: string }>(replayedEnvelope);

      expect(replayedItem).toMatchObject({
        id: committedItemId,
        title: request.title,
      });
      expect(handlerCalls).toBe(1);
      expect(store.listItems({ project }).map((item) => item.id)).toEqual([
        committedItemId,
      ]);
      expect(countCreatedEvents(store)).toBe(1);
      expect(eventStore.events).toHaveLength(2);
      expect(eventStore.events[0]?.message).toEqual({});
      expect(eventStore.events[1]?.message).toMatchObject({
        jsonrpc: "2.0",
        result: {},
      });
      expect(errors).toEqual([]);

      // This is a new JSON-RPC call, not transport replay. The handler runs a
      // second time, while Stensibly's exact idempotency contract returns the
      // same item and leaves one durable creation event.
      const explicitRetryEnvelope = await client.callTool({
        name: "create_item",
        arguments: request,
      });
      const explicitRetryItem = readToolJson<{ id: string }>(explicitRetryEnvelope);
      expect(explicitRetryItem.id).toBe(committedItemId);
      expect(handlerCalls).toBe(2);
      expect(store.listItems({ project })).toHaveLength(1);
      expect(countCreatedEvents(store)).toBe(1);

      const changedEnvelope = await client.callTool({
        name: "create_item",
        arguments: { ...request, title: "Changed request under the same key" },
      });
      expect(changedEnvelope.isError).toBe(true);
      expect(readToolText(changedEnvelope)).toMatch(/different operation/i);
      expect(handlerCalls).toBe(3);
      expect(store.listItems({ project })).toHaveLength(1);
      expect(countCreatedEvents(store)).toBe(1);
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      store.close();
    }
  });
});

function countCreatedEvents(store: StensiblyStore): number {
  return store.db
    .query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM events WHERE type = 'item.created'",
    )
    .get()!.count;
}

function readToolText(envelope: {
  content?: Array<{ type?: unknown; text?: unknown }>;
}): string {
  const first = envelope.content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("MCP tool result did not contain text");
  }
  return first.text;
}

function readToolJson<T>(envelope: {
  content?: Array<{ type?: unknown; text?: unknown }>;
}): T {
  return JSON.parse(readToolText(envelope)) as T;
}

async function promiseState(promise: Promise<unknown>): Promise<"pending" | "settled"> {
  return await Promise.race([
    promise.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20)),
  ]);
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
