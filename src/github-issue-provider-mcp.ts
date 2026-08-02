import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerGitHubCapabilityTools } from "./github-capability-mcp.js";
import type { GitHubIssueContext } from "./github-issue-context.js";
import type {
  GitHubProviderReceipt,
  GitHubProviderRequestContext,
} from "./github-provider-contracts.js";
import type { WorkLedger } from "./ledger.js";
import { asToolResult } from "./mcp-tool-result.js";
import type { McpRequestContext } from "./mcp-context.js";
import {
  principalCanAccessProject,
  principalHasScope,
} from "./token-contracts.js";

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

export interface GitHubIssueProviderWriteService {
  createIssue(input: GitHubProviderRequestContext & {
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
    idempotencyKey: string;
  }): Promise<GitHubProviderReceipt>;
  updateIssue(input: GitHubProviderRequestContext & {
    issueNumber: number;
    expectedSourceRevision: string;
    title?: string;
    body?: string;
    state?: "open" | "closed";
    stateReason?: "completed" | "not_planned" | "reopened" | null;
    idempotencyKey: string;
  }): Promise<GitHubProviderReceipt>;
  addIssueComment(input: GitHubProviderRequestContext & {
    issueNumber: number;
    body: string;
    idempotencyKey: string;
  }): Promise<GitHubProviderReceipt>;
}

export interface GitHubProviderReceiptLookupService {
  getGitHubProviderReceipt(
    project: string,
    idempotencyKey: string,
  ): Promise<GitHubProviderReceipt | null>;
}

export function withGitHubIssueProviderWriteService<T extends object>(
  target: T,
  service: GitHubIssueProviderWriteService,
): T & GitHubIssueProviderWriteService {
  return Object.assign(target, {
    createIssue: service.createIssue.bind(service),
    updateIssue: service.updateIssue.bind(service),
    addIssueComment: service.addIssueComment.bind(service),
  });
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
    async (input) => asToolResult(() => readService(ledger).listIssues({
      ...providerContext(context, input.project, input.repository, "read"),
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
    async (input) => asToolResult(() => readService(ledger).searchIssues({
      ...providerContext(context, input.project, input.repository, "read"),
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
    async (input) => asToolResult(() => readService(ledger).getIssue({
      ...providerContext(context, input.project, input.repository, "read"),
      issueNumber: input.issueNumber,
    })),
  );

  server.registerTool(
    "github_create_issue",
    {
      description: "Create one GitHub issue in the repository bound to a Stensibly project. Requires write scope and an explicit idempotency key. Initial labels and assignees remain unavailable in this public packet.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        title: z.string().trim().min(1).max(256),
        body: z.string().max(128 * 1024).optional(),
        idempotencyKey: idempotencyKeySchema(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input) => asToolResult(() => writeService(ledger).createIssue({
      ...providerContext(context, input.project, input.repository, "write"),
      title: input.title,
      ...(input.body === undefined ? {} : { body: input.body }),
      labels: [],
      assignees: [],
      idempotencyKey: input.idempotencyKey,
    })),
  );

  server.registerTool(
    "github_update_issue",
    {
      description: "Update the title, body, or state of one exact GitHub issue using the last provider source revision as an optimistic-concurrency fence. Requires write scope and an explicit idempotency key.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        issueNumber: z.number().int().min(1),
        expectedSourceRevision: sourceRevisionSchema(),
        title: z.string().trim().min(1).max(256).optional(),
        body: z.string().max(128 * 1024).optional(),
        state: z.enum(["open", "closed"]).optional(),
        stateReason: z
          .enum(["completed", "not_planned", "reopened"])
          .nullable()
          .optional(),
        idempotencyKey: idempotencyKeySchema(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input) => asToolResult(() => writeService(ledger).updateIssue({
      ...providerContext(context, input.project, input.repository, "write"),
      issueNumber: input.issueNumber,
      expectedSourceRevision: input.expectedSourceRevision,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.stateReason === undefined
        ? {}
        : { stateReason: input.stateReason }),
      idempotencyKey: input.idempotencyKey,
    })),
  );

  server.registerTool(
    "github_add_issue_comment",
    {
      description: "Add one bounded comment to an exact GitHub issue. Requires write scope and an explicit idempotency key; the returned durable receipt omits the comment body.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        issueNumber: z.number().int().min(1),
        body: z.string().min(1).max(64 * 1024),
        idempotencyKey: idempotencyKeySchema(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input) => asToolResult(() => writeService(ledger).addIssueComment({
      ...providerContext(context, input.project, input.repository, "write"),
      issueNumber: input.issueNumber,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
    })),
  );

  server.registerTool(
    "get_github_provider_receipt",
    {
      description: "Reconcile one GitHub provider operation by project, repository, and idempotency key. Returns a bounded durable receipt only when it belongs to the authenticated actor and client; foreign or absent receipts return null.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        idempotencyKey: idempotencyKeySchema(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => asToolResult(async () => {
      const identity = providerContext(
        context,
        input.project,
        input.repository,
        "read",
      );
      const receipt = await receiptLookupService(ledger).getGitHubProviderReceipt(
        input.project,
        input.idempotencyKey,
      );
      if (
        !receipt
        || receipt.repositoryFullName !== input.repository.toLowerCase()
        || receipt.actorId !== identity.actorId
        || receipt.clientId !== identity.clientId
      ) {
        return null;
      }
      return receipt;
    }),
  );
}

function readService(ledger: WorkLedger): GitHubIssueProviderReadService {
  if (!hasReadService(ledger)) {
    throw new Error(
      "GitHub issue provider reads are unavailable because this backend has no mounted provider service",
    );
  }
  return ledger;
}

function writeService(ledger: WorkLedger): GitHubIssueProviderWriteService {
  const createIssue = capturedMethod(ledger, "createIssue");
  const updateIssue = capturedMethod(ledger, "updateIssue");
  const addIssueComment = capturedMethod(ledger, "addIssueComment");
  if (!createIssue || !updateIssue || !addIssueComment) {
    throw new Error(
      "GitHub issue provider writes are unavailable because this backend has no enabled provider write service",
    );
  }
  return Object.freeze({
    createIssue: createIssue as GitHubIssueProviderWriteService["createIssue"],
    updateIssue: updateIssue as GitHubIssueProviderWriteService["updateIssue"],
    addIssueComment:
      addIssueComment as GitHubIssueProviderWriteService["addIssueComment"],
  });
}

function receiptLookupService(
  ledger: WorkLedger,
): GitHubProviderReceiptLookupService {
  const get = capturedMethod(ledger, "getGitHubProviderReceipt");
  if (!get) {
    throw new Error("GitHub provider receipts are unavailable on this backend");
  }
  return Object.freeze({
    getGitHubProviderReceipt:
      get as GitHubProviderReceiptLookupService["getGitHubProviderReceipt"],
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
  requiredScope: "read" | "write",
): GitHubProviderRequestContext {
  const principal = context.principal;
  if (!principal) {
    throw new Error(
      "GitHub issue provider operations require an authenticated remote MCP principal",
    );
  }
  if (!principalHasScope(principal, requiredScope)) {
    throw new Error(
      `GitHub issue provider operations require ${requiredScope} scope`,
    );
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

function idempotencyKeySchema() {
  return z.string().trim().min(1).max(240);
}

function sourceRevisionSchema() {
  return z.string().regex(/^sha256:[a-f0-9]{64}$/);
}
