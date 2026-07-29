import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  githubProjectContextLedger,
} from "./github-project-context.js";
import type { WorkLedger } from "./ledger.js";
import { asToolResult } from "./mcp-tool-result.js";

export function registerGitHubProjectContextTools(
  server: McpServer,
  ledger: WorkLedger,
): void {
  server.registerTool(
    "get_github_project_context",
    {
      description:
        "Read the last accepted GitHub issue context for one Stensibly project. Without externalId, returns a bounded project issue list. With externalId, also returns bounded history. The response includes direct GitHub links, synchronization freshness, accepted repository instruction identity, and connector recovery guidance.",
      inputSchema: {
        project: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .regex(/^[a-z0-9][a-z0-9-_]*$/, "Use a lowercase project slug"),
        externalId: z
          .string()
          .trim()
          .min(1)
          .max(256)
          .regex(
            /^github:[^/\s]+\/[^#\s]+#[1-9][0-9]*$/,
            "Use github:owner/repository#number",
          )
          .optional(),
        limit: z.number().int().min(1).max(100).default(20),
        historyLimit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => asToolResult(async () => {
      const contexts = githubProjectContextLedger(ledger);
      if (!contexts) {
        throw new Error("GitHub project context is unavailable on this backend");
      }
      return await contexts.getGitHubProjectContext(input);
    }),
  );
}
