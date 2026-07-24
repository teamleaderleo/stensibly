import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { continuationLedger } from "./continuation-contracts.js";
import {
  CONTINUATION_CARD_HTML,
  CONTINUATION_CARD_MIME_TYPE,
  CONTINUATION_CARD_URI,
} from "./continuation-card-widget.js";
import type { WorkLedger } from "./ledger.js";
import { actorSchema } from "./schemas.js";

export function registerContinuationCardApp(
  server: McpServer,
  ledger: WorkLedger,
): void {
  const continuations = continuationLedger(ledger);
  if (!continuations) return;

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
          "openai/widgetDescription": "Review a durable next action and send an approved, deferred, or rejected decision back into the conversation.",
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
      description: "Render one continuation proposal as an interactive human decision card. Use this after reading or listing a proposal when the current user should approve, defer, or reject it.",
      inputSchema: {
        id: z.string().trim().min(1).max(240),
        actor: actorSchema,
      },
      annotations: { readOnlyHint: true },
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
