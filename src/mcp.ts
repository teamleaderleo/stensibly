import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { expireClaims, renewClaim } from "./leases.ts";
import {
  actorSchema,
  itemKinds,
  itemStatuses,
} from "./schemas.ts";
import {
  StensiblyStore,
  type ItemStatus,
} from "./store.ts";
import { blockWork, handoffWork, unblockWork } from "./transitions.ts";

export function createMcpServer(store: StensiblyStore): McpServer {
  const server = new McpServer(
    { name: "stensibly", version: "0.0.1" },
    {
      instructions: [
        "Stensibly is a shared scrapbook for work in motion.",
        "List relevant work before claiming it.",
        "Claims are temporary leases; renew active work and release work you abandon.",
        "Use handoffs, blocks, and unblocks to leave an explicit next state for other actors.",
        "Record discoveries and progress as events so another actor can continue.",
      ].join(" "),
    },
  );

  server.registerTool(
    "list_work",
    {
      description: "List current work, optionally filtered by project and status. Expired claims return to ready work first.",
      inputSchema: {
        project: z.string().trim().min(1).max(80).optional(),
        status: z.enum(itemStatuses).optional(),
      },
    },
    async ({ project, status }) =>
      asToolResult(() => {
        expireClaims(store);
        return store.listItems({
          ...(project ? { project } : {}),
          ...(status ? { status: status as ItemStatus } : {}),
        });
      }),
  );

  server.registerTool(
    "get_item",
    {
      description: "Read one item together with its complete event history. Expired claims are persisted before the result is returned.",
      inputSchema: { id: z.string().trim().min(1) },
    },
    async ({ id }) =>
      asToolResult(() => {
        expireClaims(store);
        return { item: store.getItem(id), events: store.listEvents(id) };
      }),
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
        actor: actorSchema,
        leaseSeconds: z.number().int().min(30).max(86_400).default(900),
        idempotencyKey: z.string().trim().min(1).max(240).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ id, actor, leaseSeconds, idempotencyKey }) =>
      asToolResult(() => {
        expireClaims(store);
        return store.claimItem(id, actor, leaseSeconds, idempotencyKey);
      }),
  );

  server.registerTool(
    "renew_claim",
    {
      description: "Extend a live claim held by the same actor.",
      inputSchema: {
        id: z.string().trim().min(1),
        actor: actorSchema,
        leaseSeconds: z.number().int().min(30).max(86_400).default(900),
        idempotencyKey: z.string().trim().min(1).max(240).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ id, actor, leaseSeconds, idempotencyKey }) =>
      asToolResult(() => renewClaim(store, id, actor, leaseSeconds, idempotencyKey)),
  );

  server.registerTool(
    "handoff_work",
    {
      description: "Release work to ready state with a compact summary and an explicit next action.",
      inputSchema: {
        id: z.string().trim().min(1),
        actor: actorSchema,
        summary: z.string().trim().min(1).max(10_000),
        nextAction: z.string().trim().min(1).max(2_000),
        toActorId: z.string().trim().min(1).max(120).optional(),
        idempotencyKey: z.string().trim().min(1).max(240).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ id, actor, summary, nextAction, toActorId, idempotencyKey }) =>
      asToolResult(() =>
        handoffWork(store, {
          id,
          actor,
          summary,
          nextAction,
          ...(toActorId ? { toActorId } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        }),
      ),
  );

  server.registerTool(
    "block_work",
    {
      description: "Mark work blocked, record the reason, and release any current lease.",
      inputSchema: {
        id: z.string().trim().min(1),
        actor: actorSchema,
        reason: z.string().trim().min(1).max(10_000),
        nextAction: z.string().trim().min(1).max(2_000).optional(),
        idempotencyKey: z.string().trim().min(1).max(240).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ id, actor, reason, nextAction, idempotencyKey }) =>
      asToolResult(() =>
        blockWork(store, {
          id,
          actor,
          reason,
          ...(nextAction ? { nextAction } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        }),
      ),
  );

  server.registerTool(
    "unblock_work",
    {
      description: "Return blocked work to ready state and optionally replace its next action.",
      inputSchema: {
        id: z.string().trim().min(1),
        actor: actorSchema,
        nextAction: z.string().trim().min(1).max(2_000).optional(),
        idempotencyKey: z.string().trim().min(1).max(240).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ id, actor, nextAction, idempotencyKey }) =>
      asToolResult(() =>
        unblockWork(store, {
          id,
          actor,
          ...(nextAction ? { nextAction } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        }),
      ),
  );

  server.registerTool(
    "release_work",
    {
      description: "Release an item currently claimed by this actor and return it to ready work.",
      inputSchema: {
        id: z.string().trim().min(1),
        actor: actorSchema,
        idempotencyKey: z.string().trim().min(1).max(240).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ id, actor, idempotencyKey }) =>
      asToolResult(() => {
        expireClaims(store);
        return store.releaseItem(id, actor, idempotencyKey);
      }),
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
        actor: actorSchema,
        summary: z.string().trim().max(10_000).optional(),
        idempotencyKey: z.string().trim().min(1).max(240).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ id, actor, summary, idempotencyKey }) =>
      asToolResult(() => {
        expireClaims(store);
        return store.completeItem(id, actor, summary, idempotencyKey);
      }),
  );

  return server;
}

function asToolResult(read: () => unknown) {
  try {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(read(), null, 2) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: message }],
      isError: true,
    };
  }
}
