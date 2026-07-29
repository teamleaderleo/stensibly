import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { StensiblyStore } from "../../src/store.ts";

class MemoryEventStore {
  events = [];
  nextId = 0;
  async storeEvent(streamId, message) {
    const id = `event-${++this.nextId}`;
    this.events.push({ id, streamId, message });
    return id;
  }
  async getStreamIdForEventId(eventId) {
    return this.events.find((event) => event.id === eventId)?.streamId;
  }
  async replayEventsAfter(lastEventId, { send }) {
    const index = this.events.findIndex((event) => event.id === lastEventId);
    if (index < 0) throw new Error(`Unknown event id: ${lastEventId}`);
    const streamId = this.events[index].streamId;
    for (const event of this.events.slice(index + 1)) {
      if (event.streamId === streamId) await send(event.id, event.message);
    }
    return streamId;
  }
  eventsFor(eventId) {
    const first = this.events.find((event) => event.id === eventId);
    if (!first) throw new Error(`Missing event ${eventId}`);
    return this.events.filter((event) => event.streamId === first.streamId);
  }
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function readToolJson(envelope) {
  const first = envelope?.content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("MCP tool result did not contain text");
  }
  return JSON.parse(first.text);
}

function countCreatedEvents(store) {
  return store.db.query("SELECT COUNT(*) AS count FROM events WHERE type = 'item.created'").get().count;
}

const store = new StensiblyStore(":memory:");
const eventStore = new MemoryEventStore();
let handlerCalls = 0;
let committedItemId;
const tokens = [];
const replayGets = [];
const clientErrors = [];
const serverErrors = [];

const server = new McpServer(
  { name: "stensibly-replay-v130", version: "0.0.1" },
  { capabilities: { tools: {} } },
);
server.server.onerror = (error) => serverErrors.push(error.message);
server.registerTool(
  "create_item",
  {
    inputSchema: {
      project: z.string(),
      kind: z.literal("task"),
      title: z.string(),
      priority: z.number().int(),
      actor: z.object({ id: z.string(), name: z.string(), kind: z.literal("agent") }),
      idempotencyKey: z.string(),
    },
  },
  async (input, extra) => {
    handlerCalls += 1;
    const item = store.createItem(
      {
        project: input.project,
        kind: input.kind,
        title: input.title,
        priority: input.priority,
        actor: input.actor,
      },
      input.idempotencyKey,
    );
    committedItemId = item.id;
    if (handlerCalls === 1) extra.closeSSEStream?.();
    return { content: [{ type: "text", text: JSON.stringify(item) }] };
  },
);

const serverTransport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: () => "session-v130",
  eventStore,
  retryInterval: 25,
  enableJsonResponse: false,
});
await server.connect(serverTransport);

const endpoint = new URL("http://stensibly.test/mcp");
const fetchForServer = async (input, init) => {
  const request = new Request(input, init);
  const cursor = request.headers.get("last-event-id");
  if (request.method === "GET" && cursor === null) return new Response(null, { status: 405 });
  if (request.method === "GET" && cursor !== null) replayGets.push(cursor);
  return serverTransport.handleRequest(request);
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
const client = new Client({ name: "stensibly-replay-v130-client", version: "0.0.1" });
client.onerror = (error) => clientErrors.push(error.message);

const input = {
  project: "oauth-dogfood",
  kind: "task",
  title: "Replay committed Stensibly result on SDK 1.30",
  priority: 98,
  actor: { id: "kestrel:v130", name: "Kestrel v1.30", kind: "agent" },
  idempotencyKey: "lane-68-v130-replay",
};

try {
  await client.connect(clientTransport);
  const original = client.callTool(
    { name: "create_item", arguments: input },
    undefined,
    { timeout: 5000, onresumptiontoken: (token) => tokens.push(token) },
  );

  await waitFor(() => handlerCalls === 1, "first handler execution");
  await waitFor(() => tokens.length >= 1, "priming token");
  await waitFor(() => eventStore.eventsFor(tokens[0]).length >= 2, "stored request result");

  const replayedItem = readToolJson(await original);
  const requestEvents = eventStore.eventsFor(tokens[0]);

  assert.equal(handlerCalls, 1);
  assert.equal(replayedItem.id, committedItemId);
  assert.equal(requestEvents.length, 2);
  assert.deepEqual(Object.keys(requestEvents[0].message), []);
  assert.equal(requestEvents[1].message.id !== undefined, true);
  assert.equal("result" in requestEvents[1].message, true);
  assert.deepEqual(replayGets, [tokens[0]]);
  assert.equal(store.listItems({ project: input.project }).length, 1);
  assert.equal(countCreatedEvents(store), 1);
  assert.deepEqual(serverErrors, []);
  assert.deepEqual(clientErrors, []);

  const retryItem = readToolJson(await client.callTool({ name: "create_item", arguments: input }));
  assert.equal(handlerCalls, 2);
  assert.equal(retryItem.id, committedItemId);
  assert.equal(store.listItems({ project: input.project }).length, 1);
  assert.equal(countCreatedEvents(store), 1);

  console.log(JSON.stringify({
    package: "@modelcontextprotocol/sdk@1.30.0",
    bun: Bun.version,
    transportReplay: {
      handlerCalls: 1,
      requestEventCount: requestEvents.length,
      replayGets,
      tokens,
      resultItemId: replayedItem.id,
      durableItemCount: 1,
      durableCreationEventCount: 1,
    },
    exactApplicationRetry: {
      totalHandlerCalls: handlerCalls,
      returnedItemId: retryItem.id,
      durableItemCount: 1,
      durableCreationEventCount: 1,
    },
  }, null, 2));
} finally {
  await client.close().catch(() => {});
  await server.close().catch(() => {});
  store.close();
}
