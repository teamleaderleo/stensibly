import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  GitHubProviderRequestContext,
} from "./github-provider-contracts.js";
import type {
  GitHubIssueProviderSetWriteService,
} from "./github-issue-provider-set-write-service.js";
import type { WorkLedger } from "./ledger.js";
import type { McpRequestContext } from "./mcp-context.js";
import { asToolResult } from "./mcp-tool-result.js";
import {
  principalCanAccessProject,
  principalHasScope,
} from "./token-contracts.js";

export function registerGitHubIssueProviderSetWriteTools(
  server: McpServer,
  ledger: WorkLedger,
  context: McpRequestContext,
): void {
  server.registerTool(
    "github_add_issue_labels",
    {
      description: "Add one or more unique labels to an exact GitHub issue. Requires write scope and an explicit idempotency key; the durable receipt records the verified resulting label set.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        issueNumber: z.number().int().min(1),
        labels: z.array(labelSchema()).min(1).max(100),
        idempotencyKey: idempotencyKeySchema(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input) => asToolResult(() => setWriteService(ledger).addIssueLabels({
      ...providerContext(context, input.project, input.repository),
      issueNumber: input.issueNumber,
      labels: input.labels,
      idempotencyKey: input.idempotencyKey,
    })),
  );

  server.registerTool(
    "github_remove_issue_label",
    {
      description: "Remove one exact label from a GitHub issue. Requires write scope and an explicit idempotency key; the durable receipt records the verified resulting label set.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        issueNumber: z.number().int().min(1),
        label: labelSchema(),
        idempotencyKey: idempotencyKeySchema(),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (input) => asToolResult(() => setWriteService(ledger).removeIssueLabel({
      ...providerContext(context, input.project, input.repository),
      issueNumber: input.issueNumber,
      label: input.label,
      idempotencyKey: input.idempotencyKey,
    })),
  );

  server.registerTool(
    "github_add_issue_assignees",
    {
      description: "Add one to ten unique GitHub assignees to an exact issue. Requires write scope and an explicit idempotency key; the durable receipt records the verified resulting assignee set.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        issueNumber: z.number().int().min(1),
        assignees: z.array(loginSchema()).min(1).max(10),
        idempotencyKey: idempotencyKeySchema(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input) => asToolResult(() => setWriteService(ledger).addIssueAssignees({
      ...providerContext(context, input.project, input.repository),
      issueNumber: input.issueNumber,
      assignees: input.assignees,
      idempotencyKey: input.idempotencyKey,
    })),
  );

  server.registerTool(
    "github_remove_issue_assignees",
    {
      description: "Remove one to ten exact GitHub assignees from an issue. Requires write scope and an explicit idempotency key; the durable receipt records the verified resulting assignee set.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        issueNumber: z.number().int().min(1),
        assignees: z.array(loginSchema()).min(1).max(10),
        idempotencyKey: idempotencyKeySchema(),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (input) => asToolResult(() =>
      setWriteService(ledger).removeIssueAssignees({
        ...providerContext(context, input.project, input.repository),
        issueNumber: input.issueNumber,
        assignees: input.assignees,
        idempotencyKey: input.idempotencyKey,
      })
    ),
  );
}

function setWriteService(ledger: WorkLedger): GitHubIssueProviderSetWriteService {
  const addIssueLabels = capturedMethod(ledger, "addIssueLabels");
  const removeIssueLabel = capturedMethod(ledger, "removeIssueLabel");
  const addIssueAssignees = capturedMethod(ledger, "addIssueAssignees");
  const removeIssueAssignees = capturedMethod(ledger, "removeIssueAssignees");
  if (
    !addIssueLabels
    || !removeIssueLabel
    || !addIssueAssignees
    || !removeIssueAssignees
  ) {
    throw new Error(
      "GitHub issue label and assignee writes are unavailable because this backend has no enabled provider set-write service",
    );
  }
  return Object.freeze({
    addIssueLabels:
      addIssueLabels as GitHubIssueProviderSetWriteService["addIssueLabels"],
    removeIssueLabel:
      removeIssueLabel as GitHubIssueProviderSetWriteService["removeIssueLabel"],
    addIssueAssignees:
      addIssueAssignees as GitHubIssueProviderSetWriteService["addIssueAssignees"],
    removeIssueAssignees:
      removeIssueAssignees as GitHubIssueProviderSetWriteService["removeIssueAssignees"],
  });
}

function capturedMethod(
  value: unknown,
  name: string,
): ((...args: unknown[]) => unknown) | null {
  if (!value || typeof value !== "object") return null;
  let current: object | null = value;
  while (current && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        return null;
      }
      return (...args: unknown[]) => Reflect.apply(descriptor.value, value, args);
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return null;
}

function providerContext(
  context: McpRequestContext,
  project: string,
  repository: string,
): GitHubProviderRequestContext {
  const principal = context.principal;
  if (!principal) {
    throw new Error(
      "GitHub issue provider operations require an authenticated remote MCP principal",
    );
  }
  if (!principalHasScope(principal, "write")) {
    throw new Error("GitHub issue provider operations require write scope");
  }
  if (!principalCanAccessProject(principal, project)) {
    throw new Error(
      "GitHub issue provider operation is outside this principal's project scope",
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

function labelSchema() {
  return z.string().trim().min(1).max(100);
}

function loginSchema() {
  return z
    .string()
    .trim()
    .min(1)
    .max(39)
    .regex(
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/,
      "Use a GitHub login",
    )
    .refine((value) => !value.includes("--"), "Use a GitHub login");
}

function idempotencyKeySchema() {
  return z.string().trim().min(1).max(240);
}
