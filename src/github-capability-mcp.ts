import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  githubCapabilitySkills,
  githubCapabilityTiers,
} from "./github-capability-curation.js";
import { GitHubCapabilityCatalogueService } from "./github-capability-service.js";
import { asToolResult } from "./mcp-tool-result.js";

const catalogue = new GitHubCapabilityCatalogueService();

export function registerGitHubCapabilityTools(server: McpServer): void {
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
    async (input) => asToolResult(async () => catalogue.listToolsets(input)),
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
    async (input) => asToolResult(async () => catalogue.searchTools(input)),
  );

  server.registerTool(
    "github_get_tool",
    {
      description: "Get one exact curated GitHub capability with its skill, priority tier, risk, repository scope, execution mode, and current first-party dispatch binding when available.",
      inputSchema: {
        name: z.string().trim().min(1).max(128).regex(/^[a-z][a-z0-9_]{0,127}$/),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => asToolResult(async () => {
      const capability = catalogue.getTool(name);
      return {
        ...capability,
        catalogueRevision: catalogue.registry.curationRevision,
        sourceRevision: catalogue.registry.sourceRevision,
        fingerprint: catalogue.registry.fingerprint,
        delegatedDispatchEnabled: false,
        recommendedAction: capability.dispatchEnabled && capability.firstPartyTool
          ? `Call ${capability.firstPartyTool} through Stensibly.`
          : capability.executionMode === "delegated"
          ? "Await the guarded github_call_tool provider-binding slice."
          : capability.executionMode === "internal_primitive"
          ? "Use Publish Changes so Stensibly can compose and recover the primitive sequence."
          : "Keep this capability outside ordinary model-visible tool selection.",
      };
    }),
  );
}
