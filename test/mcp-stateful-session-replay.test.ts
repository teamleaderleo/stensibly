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
  test("characterizes SDK 1.29 replay loss, then recovers through exact application retry", async () => {
    const store = new StensiblyStore(":memory:");
    const eventStore = new MemoryEventStore();
    let handlerCalls = 0;
    let committedItemId: string | undefined;
    const observedTokens: string[] = [];
    const replayGets: string[] = [];
    const clientErrors: string[] = [];
    const serverErrors: string[] = [];

    const server = new McpServer(
      { name: "stensibly-stateful-replay", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    server.server.onerror = (error) => serverErrors.push(error.message);
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
        if (handlerCalls === 1) extra.closeSSEStream?.();
        return {
          content: [{ type: "text", text: JSON.stringify(created) }],
        };
      },
    );

    const serverTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => "session-lane-68",
      eventStore,
      retryInterval: 250,
      enableJsonResponse: false,
    });
    await server.connect(serverTransport);

    const endpoint = new URL("http://stensibly.test/mcp");
    const fetchForServer = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const request = new Request(input, init);
      const lastEventId = request.headers.get("last-event-id");
      if (request.method === "GET" && lastEventId === null) {
        return new Response(null, { status: 405 });
      }
      if (request.method === "GET" && lastEventId !== null) {
        replayGets.push(lastEventId);
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
    });
    const client = new Client({ name: "stensibly-stateful-client", version: "0.0.1" });
    client.onerror = (error) => clientErrors.push(error.message);

    const idempotencyKey = "lane-68-stateful-create-v1";
    const request = {
      project,
      kind: "task" as const,
      title: "Recover the original MCP result",
      summary: "Commit once, disconnect before delivery, then attempt replay by event cursor.",
      nextAction: "Distinguish transport replay from a new application retry.",
      priority: 98,
      actor,
      idempotencyKey,
    };

    try {
      await withDeadline(client.connect(clientTransport), 3_000, "client.connect");
      expect(client.getServerVersion()?.name).toBe("stensibly-stateful-replay");

      const originalResult = client.callTool(
        { name: "create_item", arguments: request },
        undefined,
        {
          timeout: 1_200,
          onresumptiontoken: (token) => observedTokens.push(token),
        },
      );

      await waitFor(() => handlerCalls === 1, "first durable handler execution");
      await waitFor(() => observedTokens.length === 1, "request priming token");
      await waitFor(
        () => serverErrors.some((message) => message.includes("No connection established")),
        "SDK 1.29 disconnected-response error",
      );
      await waitFor(() => replayGets.length === 1, "Last-Event-ID replay GET");

      const itemId = committedItemId;
      if (itemId === undefined) throw new Error("Expected committed item id");
      const primingToken = observedTokens[0]!;
      const requestEvents = eventsForToken(eventStore, primingToken);

      expect(await promiseState(originalResult)).toBe("pending");
      expect(replayGets).toEqual([primingToken]);
      expect(observedTokens).toEqual([primingToken]);
      expect(requestEvents).toHaveLength(1);
      expect(Object.keys(requestEvents[0]!.message as object)).toHaveLength(0);
      expect(store.listItems({ project }).map((item) => item.id)).toEqual([itemId]);
      expect(countCreatedEvents(store)).toBe(1);

      await expect(originalResult).rejects.toThrow(/timed out/i);
      expect(handlerCalls).toBe(1);
      expect(store.listItems({ project })).toHaveLength(1);
      expect(countCreatedEvents(store)).toBe(1);

      const explicitRetryEnvelope = await withDeadline(
        client.callTool({ name: "create_item", arguments: request }),
        3_000,
        "exact application retry",
      );
      const explicitRetryItem = readToolJson<{ id: string }>(explicitRetryEnvelope);
      expect(explicitRetryItem.id).toBe(itemId);
      expect(handlerCalls).toBe(2);
      expect(store.listItems({ project })).toHaveLength(1);
      expect(countCreatedEvents(store)).toBe(1);

      const changedEnvelope = await withDeadline(
        client.callTool({
          name: "create_item",
          arguments: { ...request, title: "Changed request under the same key" },
        }),
        3_000,
        "changed-key conflict request",
      );
      expect(isToolError(changedEnvelope)).toBe(true);
      expect(readToolText(changedEnvelope)).toMatch(/different .*request/i);
      expect(handlerCalls).toBe(3);
      expect(store.listItems({ project })).toHaveLength(1);
      expect(countCreatedEvents(store)).toBe(1);
      expect(clientErrors).toEqual([]);
    } finally {
      await settleWithin(client.close(), 1_000);
      await settleWithin(server.close(), 1_000);
      store.close();
    }
  }, 15_000);
});

function eventsForToken(eventStore: MemoryEventStore, eventId: string) {
  const primingEvent = eventStore.events.find((event) => event.id === eventId);
  if (primingEvent === undefined) throw new Error(`Missing event ${eventId}`);
  return eventStore.events.filter((event) => event.streamId === primingEvent.streamId);
}

function countCreatedEvents(store: StensiblyStore): number {
  return store.db
    .query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM events WHERE type = 'item.created'",
    )
    .get()!.count;
}

function isToolError(envelope: unknown): boolean {
  if (typeof envelope !== "object" || envelope === null) return false;
  return (envelope as { isError?: unknown }).isError === true;
}

function readToolText(envelope: unknown): string {
  if (typeof envelope !== "object" || envelope === null) {
    throw new Error("MCP tool result was not an object");
  }
  const content = (envelope as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("MCP tool result had no content array");
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("MCP tool result did not contain text");
  }
  return first.text;
}

function readToolJson<T>(envelope: unknown): T {
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

async function withDeadline<T>(
  promise: Promise<T>,
  milliseconds: number,
  description: string,
): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), milliseconds),
    ),
  ]);
}

async function settleWithin(promise: Promise<unknown>, milliseconds: number): Promise<void> {
  await Promise.race([
    promise.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  ]);
}
