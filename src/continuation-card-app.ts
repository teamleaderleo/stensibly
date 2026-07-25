import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { continuationLedger } from "./continuation-contracts.js";
import {
  CONTINUATION_CARD_HTML,
  CONTINUATION_CARD_MIME_TYPE,
  CONTINUATION_CARD_URI,
} from "./continuation-card-widget.js";
import { continuationSupervisorLedger } from "./continuation-supervisor-contracts.js";
import type { WorkLedger } from "./ledger.js";
import { actorSchema } from "./schemas.js";

const continuationCardOutputSchema = {
  kind: z.literal("stensibly.continuation-card"),
  continuation: z.object({
    id: z.string(),
    sourceItemId: z.string(),
    title: z.string(),
    rationale: z.string(),
    instruction: z.string(),
    status: z.string(),
    generation: z.number().int().min(1),
    expiresAt: z.string().nullable(),
    evidence: z.array(z.object({
      kind: z.string(),
      label: z.string(),
      uri: z.string(),
    })),
  }).passthrough(),
  sourceItem: z.object({
    id: z.string(),
    project: z.string(),
    title: z.string(),
    status: z.string(),
    priority: z.number(),
    summary: z.string().nullable(),
    nextAction: z.string().nullable(),
  }),
  actor: actorSchema,
  capabilities: z.object({
    supervisorQueue: z.boolean(),
  }),
};

export function registerContinuationCardApp(
  server: McpServer,
  ledger: WorkLedger,
): void {
  const continuations = continuationLedger(ledger);
  if (!continuations) return;
  const supervisorQueue = continuationSupervisorLedger(ledger) !== null;

  server.registerResource(
    "continuation-card",
    CONTINUATION_CARD_URI,
    {
      description: "Interactive card for reviewing and continuing one durable Stensibly continuation proposal.",
      mimeType: CONTINUATION_CARD_MIME_TYPE,
    },
    async () => ({
      contents: [{
        uri: CONTINUATION_CARD_URI,
        mimeType: CONTINUATION_CARD_MIME_TYPE,
        text: CONTINUATION_CARD_HTML,
        _meta: {
          ui: {
            csp: {
              connectDomains: [],
              resourceDomains: [],
            },
            prefersBorder: true,
          },
          "openai/widgetDescription": "Review a durable next action, refine its instruction, continue in the conversation, or queue it for supervisor execution.",
          "openai/widgetPrefersBorder": true,
          "openai/widgetCSP": {
            connect_domains: [],
            resource_domains: [],
          },
        },
      }],
    }),
  );

  server.registerTool(
    "show_continuation_card",
    {
      title: "Show continuation decision card",
      description: "Use this when a person should review one durable continuation proposal in an interactive card after the proposal has been read or listed.",
      inputSchema: {
        id: z.string().trim().min(1).max(240),
        actor: actorSchema,
      },
      outputSchema: continuationCardOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: CONTINUATION_CARD_URI },
        "openai/outputTemplate": CONTINUATION_CARD_URI,
        "openai/toolInvocation/invoking": "Loading continuation…",
        "openai/toolInvocation/invoked": "Continuation ready",
      },
    },
    async ({ id, actor }) => {
      try {
        const continuation = await continuations.getContinuation(id);
        const detail = await ledger.getItem(continuation.sourceItemId);
        const structuredContent = {
          kind: "stensibly.continuation-card" as const,
          continuation,
          sourceItem: {
            id: detail.item.id,
            project: detail.item.project,
            title: detail.item.title,
            status: detail.item.status,
            priority: detail.item.priority,
            summary: detail.item.summary,
            nextAction: detail.item.nextAction,
          },
          actor,
          capabilities: { supervisorQueue },
        };
        return {
          structuredContent,
          content: [{
            type: "text" as const,
            text: `Continuation ${continuation.id} is ready for human review at generation ${continuation.generation}.`,
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: error instanceof Error ? error.message : String(error),
          }],
          isError: true,
        };
      }
    },
  );
}
