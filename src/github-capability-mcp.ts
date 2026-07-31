import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  githubCapabilitySkills,
  githubCapabilityTiers,
} from "./github-capability-curation.js";
import { GitHubCapabilityCatalogueService } from "./github-capability-service.js";
import type { HostedGitHubDelegatedReadProvider } from "./hosted-github-delegated-read-provider.js";
import type { WorkLedger } from "./ledger.js";
import type { McpRequestContext } from "./mcp-context.js";
import { asToolResult } from "./mcp-tool-result.js";
import {
  principalCanAccessProject,
  principalHasScope,
} from "./token-contracts.js";

const catalogue = new GitHubCapabilityCatalogueService();
const delegatedToolNames = ["get_repo", "fetch_file"] as const;
const delegatedToolSet = new Set<string>(delegatedToolNames);

export function registerGitHubCapabilityTools(
  server: McpServer,
  ledger: WorkLedger,
  context: McpRequestContext,
): void {
  const delegated = delegatedReadProvider(ledger);

  server.registerTool(
    "github_list_toolsets",
    {
      description: "List the curated GitHub skill bundles, visibility tiers, counts, catalogue revision, and current delegated-dispatch status. Essential capabilities are the ordinary model-visible set; secondary and advanced capabilities stay searchable.",
      inputSchema: {
        skills: z.array(z.enum(githubCapabilitySkills)).max(githubCapabilitySkills.length).optional(),
        includeHidden: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => asToolResult(async () => {
      const result = catalogue.listToolsets(input);
      return {
        ...result,
        dispatchSurface: delegated
          ? "typed_first_party_and_guarded_delegated"
          : result.dispatchSurface,
        delegatedDispatchEnabled: delegated !== null,
        delegatedTools: delegated ? [...delegatedToolNames] : [],
      };
    }),
  );

  server.registerTool(
    "github_search_tools",
    {
      description: "Search the curated GitHub capability catalogue by action name, skill, tier, and read-only status. Internal primitives and excluded reaction tools stay hidden unless explicitly requested.",
      inputSchema: {
        query: z.string().trim().min(1).max(200),
        skills: z.array(z.enum(githubCapabilitySkills)).max(githubCapabilitySkills.length).optional(),
        tiers: z.array(z.enum(githubCapabilityTiers)).max(githubCapabilityTiers.length).optional(),
        readOnly: z.boolean().optional(),
        includeHidden: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => asToolResult(async () =>
      catalogue.searchTools(input).map((capability) => ({
        ...capability,
        delegatedDispatchEnabled:
          delegated !== null && delegatedToolSet.has(capability.name),
      }))
    ),
  );

  server.registerTool(
    "github_get_tool",
    {
      description: "Get one exact curated GitHub capability with its skill, priority tier, risk, repository scope, execution mode, and current first-party or guarded delegated dispatch binding when available.",
      inputSchema: {
        name: z.string().trim().min(1).max(128).regex(/^[a-z][a-z0-9_]{0,127}$/),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => asToolResult(async () => {
      const capability = catalogue.getTool(name);
      const delegatedDispatchEnabled =
        delegated !== null && delegatedToolSet.has(capability.name);
      return {
        ...capability,
        catalogueRevision: catalogue.registry.curationRevision,
        sourceRevision: catalogue.registry.sourceRevision,
        fingerprint: catalogue.registry.fingerprint,
        delegatedDispatchEnabled,
        recommendedAction: capability.dispatchEnabled && capability.firstPartyTool
          ? `Call ${capability.firstPartyTool} through Stensibly.`
          : delegatedDispatchEnabled
          ? `Call ${capability.name} through github_call_tool with the current catalogue fingerprint.`
          : capability.executionMode === "delegated"
          ? "Await a guarded native provider binding for this capability."
          : capability.executionMode === "internal_primitive"
          ? "Use Publish Changes so Stensibly can compose and recover the primitive sequence."
          : "Keep this capability outside ordinary model-visible tool selection.",
      };
    }),
  );

  if (!delegated) return;
  server.registerTool(
    "github_call_tool",
    {
      description: "Call one currently enabled guarded GitHub read through the project's accepted repository attachment and hosted GitHub App binding. The initial public subset is repository metadata and one file at an immutable commit.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        tool: z.enum(delegatedToolNames),
        arguments: z.union([
          z.object({}).strict(),
          z.object({
            path: z.string().min(1).max(4_096),
            ref: z.string().regex(/^[a-f0-9]{40}$/),
          }).strict(),
        ]),
        catalogueFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => asToolResult(async () => {
      const principal = delegatedPrincipal(context, input.project);
      return delegated.callGitHubDelegatedRead({
        project: input.project,
        repository: input.repository,
        tool: input.tool,
        arguments: input.arguments,
        actorId: principal.actorId,
        clientId: principal.clientId,
        catalogueFingerprint: input.catalogueFingerprint,
      });
    }),
  );
}

function delegatedReadProvider(
  value: unknown,
): HostedGitHubDelegatedReadProvider | null {
  if (!value || typeof value !== "object") return null;
  const descriptor = Object.getOwnPropertyDescriptor(
    value,
    "callGitHubDelegatedRead",
  );
  if (
    !descriptor
    || !("value" in descriptor)
    || !descriptor.enumerable
    || typeof descriptor.value !== "function"
  ) {
    return null;
  }
  return value as HostedGitHubDelegatedReadProvider;
}

function delegatedPrincipal(
  context: McpRequestContext,
  project: string,
): { actorId: string; clientId: string } {
  const principal = context.principal;
  if (!principal) {
    throw new Error(
      "Guarded GitHub delegated reads require an authenticated remote MCP principal",
    );
  }
  if (!principalHasScope(principal, "read")) {
    throw new Error("Guarded GitHub delegated reads require read scope");
  }
  if (!principalCanAccessProject(principal, project)) {
    throw new Error(
      "Guarded GitHub delegated reads are outside this principal's project scope",
    );
  }
  const actorId = `api-token:${principal.tokenId}`;
  return { actorId, clientId: `mcp:${actorId}` };
}

function projectSchema() {
  return z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use a lowercase project slug");
}

function repositorySchema() {
  return z
    .string()
    .min(3)
    .max(200)
    .regex(
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
      "Use a GitHub owner/repository identifier",
    );
}
