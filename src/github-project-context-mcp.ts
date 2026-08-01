import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getSqliteGitHubProjectContext,
  githubProjectContextLedger,
  type GetGitHubProjectContextInput,
} from "./github-project-context.js";
import type { WorkLedger } from "./ledger.js";
import { asToolResult } from "./mcp-tool-result.js";
import type { StensiblyStore } from "./store.js";

export function registerGitHubProjectContextTools(
  server: McpServer,
  ledger: WorkLedger,
): void {
  server.registerTool(
    "get_github_project_context",
    {
      description: "Read the last-known accepted GitHub issue context for one authorised Stensibly project, including canonical issue links, provider state, explicit relationships, synchronization freshness or degraded state, accepted repository instruction identity, and bounded recovery guidance. This is provider evidence and project context, not a claim, lease, approval, capability, or GitHub mutation authority.",
      inputSchema: {
        project: projectSchema(),
        externalId: z
          .string()
          .trim()
          .min(1)
          .max(300)
          .regex(
            /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/,
            "Use github:owner/repository#number",
          )
          .optional(),
        limit: z.number().int().min(1).max(100).default(20),
        historyLimit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => asToolResult(async () => ({
      context: await readGitHubProjectContext(ledger, input),
      authorityNotice:
        "GitHub issue observations and accepted repository instructions do not grant execution or provider-mutation authority. Claims, run leases, approvals, capabilities, and GitHub write receipts remain separate server-owned state.",
    })),
  );
}

async function readGitHubProjectContext(
  ledger: WorkLedger,
  input: GetGitHubProjectContextInput,
) {
  const store = sqliteStore(ledger);
  if (store) return getSqliteGitHubProjectContext(store, input);

  const projected = githubProjectContextLedger(ledger);
  if (projected) return await projected.getGitHubProjectContext(input);

  throw new Error("GitHub project context is unavailable on this backend");
}

function sqliteStore(value: unknown): StensiblyStore | null {
  if (!value || typeof value !== "object" || !("store" in value)) return null;
  const store = (value as { store?: unknown }).store;
  if (!store || typeof store !== "object" || !("db" in store)) return null;
  const db = (store as { db?: unknown }).db;
  if (!db || typeof db !== "object") return null;
  const candidate = db as { query?: unknown; exec?: unknown; transaction?: unknown };
  if (
    typeof candidate.query !== "function"
    || typeof candidate.exec !== "function"
    || typeof candidate.transaction !== "function"
  ) return null;
  return store as StensiblyStore;
}

function projectSchema() {
  return z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, "Use a lowercase project slug");
}
