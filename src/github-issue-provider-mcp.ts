import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerGitHubCapabilityTools } from "./github-capability-mcp.js";
import type { GitHubIssueContext } from "./github-issue-context.js";
import type { GitHubProviderRequestContext } from "./github-provider-contracts.js";
import type { WorkLedger } from "./ledger.js";
import { asToolResult } from "./mcp-tool-result.js";
import type { McpRequestContext } from "./mcp-context.js";

export interface GitHubIssueProviderReadService {
  listIssues(input: GitHubProviderRequestContext & {
    state?: "open" | "closed" | "all";
    labels?: string[];
    assignees?: string[];
    cursor?: string;
    limit?: number;
  }): Promise<{ issues: GitHubIssueContext[]; nextCursor: string | null }>;
  searchIssues(input: GitHubProviderRequestContext & {
    query: string;
    state?: "open" | "closed" | "all";
    cursor?: string;
    limit?: number;
  }): Promise<{ issues: GitHubIssueContext[]; nextCursor: string | null }>;
  getIssue(input: GitHubProviderRequestContext & {
    issueNumber: number;
  }): Promise<GitHubIssueContext>;
}

export function withGitHubIssueProviderReadService<T extends object>(
  target: T,
  service: GitHubIssueProviderReadService,
): T & GitHubIssueProviderReadService {
  return Object.assign(target, {
    listIssues: service.listIssues.bind(service),
    searchIssues: service.searchIssues.bind(service),
    getIssue: service.getIssue.bind(service),
  });
}

export function registerGitHubIssueProviderTools(
  server: McpServer,
  ledger: WorkLedger,
  context: McpRequestContext,
): void {
  registerGitHubCapabilityTools(server, ledger, context);

  server.registerTool(
    "github_list_issues",
    {
      description: "List a bounded page of GitHub issues from one repository bound to a Stensibly project. Pull requests and issue bodies stay outside the result.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        state: z.enum(["open", "closed", "all"]).default("open"),
        labels: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
        assignees: z.array(z.string().trim().min(1).max(39)).max(100).optional(),
        cursor: z.string().trim().min(1).max(512).optional(),
        limit: z.number().int().min(1).max(100).default(30),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => asToolResult(() => service(ledger).listIssues({
      ...providerContext(context, input.project, input.repository),
      state: input.state,
      ...(input.labels ? { labels: input.labels } : {}),
      ...(input.assignees ? { assignees: input.assignees } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit: input.limit,
    })),
  );

  server.registerTool(
    "github_search_issues",
    {
      description: "Search GitHub issues inside one repository bound to a Stensibly project. Repository and issue-only qualifiers are enforced by the MCP boundary.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        query: z
          .string()
          .trim()
          .min(1)
          .max(512)
          .refine(
            (value) => !/\b[A-Za-z][A-Za-z0-9_-]*:/.test(value),
            "GitHub issue search query cannot contain provider qualifiers",
          ),
        state: z.enum(["open", "closed", "all"]).default("all"),
        cursor: z.string().trim().min(1).max(512).optional(),
        limit: z.number().int().min(1).max(100).default(30),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => asToolResult(() => service(ledger).searchIssues({
      ...providerContext(context, input.project, input.repository),
      query: input.query,
      state: input.state,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit: input.limit,
    })),
  );

  server.registerTool(
    "github_get_issue",
    {
      description: "Read one exact GitHub issue from a repository bound to a Stensibly project, with canonical identity and provider revision evidence while omitting the issue body.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        issueNumber: z.number().int().min(1),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => asToolResult(() => service(ledger).getIssue({
      ...providerContext(context, input.project, input.repository),
      issueNumber: input.issueNumber,
    })),
  );
}

function service(ledger: WorkLedger): GitHubIssueProviderReadService {
  if (!hasReadService(ledger)) {
    throw new Error(
      "GitHub issue provider reads are unavailable because this backend has no mounted provider service",
    );
  }
  return ledger;
}

function hasReadService(value: unknown): value is WorkLedger & GitHubIssueProviderReadService {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GitHubIssueProviderReadService>;
  return typeof candidate.listIssues === "function"
    && typeof candidate.searchIssues === "function"
    && typeof candidate.getIssue === "function";
}

function providerContext(
  context: McpRequestContext,
  project: string,
  repository: string,
): GitHubProviderRequestContext {
  const principal = context.principal;
  if (!principal) {
    throw new Error(
      "GitHub issue provider reads require an authenticated remote MCP principal",
    );
  }
  const tokenIdentity = `api-token:${principal.tokenId}`;
  return {
    project,
    repository,
    actorId: tokenIdentity,
    clientId: `mcp:${tokenIdentity}`,
  };
}

function projectSchema() {
  return z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use a lowercase project slug");
}

function repositorySchema() {
  return z
    .string()
    .trim()
    .min(3)
    .max(200)
    .regex(
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
      "Use a GitHub owner/repository identifier",
    );
}
