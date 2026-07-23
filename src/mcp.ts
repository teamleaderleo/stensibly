import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  actorKinds,
  actorSchema,
  itemKinds,
  itemStatuses,
} from "./schemas.ts";
import {
  ConflictError,
  NotFoundError,
  StensiblyStore,
  type ItemStatus,
} from "./store.ts";

const actorInput = {
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(160),
  kind: z.enum(actorKinds).default("agent"),
};

export function createMcpServer(store: StensiblyStore): McpServer {
  const server = new McpServer(
    { name: "stensibly", version: "0.0.1" },
    {
      instructions: [
        "Stensibly is a shared scrapbook for work in motion.",
        "List relevant work before claiming it.",
        "Claims are temporary leases; release work you abandon.",
        "Record discoveries and progress as events so another actor can continue.",
      ].join(" "),
    },
  );

  server.registerTool(
    "list_work",
    {
      description: "List current work, optionally filtered by project and status.",
      inputSchema: {
        project: z.string().trim().min(1).max(80).optional(),
        status: z.enum(itemStatuses).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project, status }) =>
      asToolResult(() =>
        store.listItems({
          ...(project ? { project } : {}),
          ...(status ? { status: status as ItemStatus } : {}),
        }),
      ),
  );

  server.registerTool(
    "get_item",
    {
      description: "Read one item together with its complete event history.",
      inputSchema: { id: z.string().trim().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) =>
      asToolResult(() => ({ item: store.getItem(id), events: store.listEvents(id) })),
  );

  server.registerTool(
    "create_item",
    {
      description: "Create a task, finding, question, decision, tip, handoff, or note.",
      inputSchema: {
        project: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .regex(/^[a-z0-9][a-z0-9-_]*$/, "Use a lowercase project slug"),
        kind: z.enum(itemKinds).default("task"),
        title: z.string().trim().min(1).max(240),
        summary: z.string().trim().max(10_000).optional(),
        nextAction: z.string().trim().max(2_000).optional(),
        priority: z.number().int().min(0).max(100).default(50),
        actor: actorSchema.optional(),
        idempotencyKey: z.string().trim().min(1).max(240).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ idempotencyKey, ...input }) =>
      asToolResult(() => store.createItem(input, idempotencyKey)),
  );

  server.registerTool(
    "claim_work",
    {
      description: "Atomically claim an item for a limited lease. A competing live claim returns an error.",
      inputSchema: {
        id: z.string().trim().min(1),
        actor: actorInput,
        leaseSeconds: z.number().int().min(30).max(86_400).default(900),
        idempotencyKey: z.string().trim().min(1).max(240).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ id, actor, leaseSeconds, idempotencyKey }) =>
      asToolResult(() => store.claimItem(id, actor, leaseSeconds, idempotencyKey)),
  );

  server.registerTool(
    "release_work",
    {
      description: "Release an item currently claimed by this actor and return it to ready work.",
      inputSchema: {
        id: z.string().trim().min(1),
        actor: actorInput,
        idempotencyKey: z.string().trim().min(1).max(240).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ id, actor, idempotencyKey }) =>
      asToolResult(() => store.releaseItem(id, actor, idempotencyKey)),
  );

  server.registerTool(
    "record_event",
    {
      description: "Append progress, a discovery, a warning, or another event to an item's history.",
      inputSchema: {
        id: z.string().trim().min(1),
        actor: actorSchema.optional(),
        type: z.string().trim().min(1).max(120).regex(/^[a-z0-9._-]+$/),
        payload: z.record(z.string(), z.unknown()).default({}),
        idempotencyKey: z.string().trim().min(1).max(240).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ id, actor, type, payload, idempotencyKey }) =>
      asToolResult(() =>
        store.recordEvent({
          itemId: id,
          ...(actor ? { actor } : {}),
          type,
          payload,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        }),
      ),
  );

  server.registerTool(
    "complete_work",
    {
      description: "Complete an item, clear its lease, and optionally replace its summary.",
      inputSchema: {
        id: z.string().trim().min(1),
        actor: actorInput,
        summary: z.string().trim().max(10_000).optional(),
        idempotencyKey: z.string().trim().min(1).max(240).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ id, actor, summary, idempotencyKey }) =>
      asToolResult(() => store.completeItem(id, actor, summary, idempotencyKey)),
  );

  return server;
}

function asToolResult(read: () => unknown) {
  try {
    const value = read();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    };
  } catch (error) {
    const known = error instanceof ConflictError || error instanceof NotFoundError;
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: message }],
      isError: true,
      ...(known ? {} : { _meta: { unexpected: true } }),
    };
  }
}
