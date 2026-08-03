import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  GitHubCapabilityCatalogueService,
} from "../src/github-capability-service.ts";
import {
  hostedGitHubDelegatedReadTools,
  mountHostedGitHubDelegatedReadProviderFromEnv,
  type HostedGitHubDelegatedReadInput,
  type HostedGitHubDelegatedReadProvider,
} from "../src/hosted-github-delegated-read-provider.ts";
import type { WorkLedger } from "../src/ledger.ts";
import { createMcpServer } from "../src/mcp.ts";
import type {
  ProjectAttachmentLedger,
  ProjectAttachmentRecord,
} from "../src/project-attachment-ledger.ts";
import {
  compileProjectContract,
  renderProjectContract,
} from "../src/project-contract.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const project = "review-thread-truncation";
const pullRequestNumber = 42;
const fixedNow = Date.parse("2026-08-02T14:00:00.000Z");
const catalogueFingerprint =
  new GitHubCapabilityCatalogueService().registry.fingerprint;
const graphqlUrl = "https://api.github.test/graphql";
const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;

const snapshot = compileProjectContract(renderProjectContract({
  version: 1,
  project,
  repositories: [repositoryFullName],
  runnerProfiles: [],
  concurrency: { project: 1, global: 1 },
  autonomousActions: ["inspect"],
  approvalRequired: ["write"],
  checks: [],
  tags: [],
  relatedProjects: [],
}, {
  goal: "Prove bounded review-thread truncation evidence survives projections.",
  boundaries: "No review writes, credentials, or unrelated GitHub tools.",
  evidenceAndHandoff: "Return exact retained count and truncation evidence.",
  escalation: "Stop before dispatch when authority or binding changes.",
}));

const attachment: ProjectAttachmentRecord = {
  id: "attach_review_thread_truncation",
  project,
  snapshot,
  sourceRevision: "main@review-thread-truncation",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: "2026-08-02T14:00:00.000Z",
};

describe("review-thread truncation projections", () => {
  test("hosted projection preserves total and truncation evidence", async () => {
    const mounted = mountHostedGitHubDelegatedReadProviderFromEnv(
      attachmentLedger(),
      providerEnv(),
      {
        now: () => fixedNow,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/app/installations/98765/access_tokens")) {
            return Response.json({
              token: "review-thread-installation-token-secret",
              expires_at: "2026-08-02T15:00:00Z",
              permissions: { pull_requests: "read", metadata: "read" },
              repository_selection: "selected",
              repositories: [{ full_name: "TeamLeaderLeo/Stensibly" }],
            }, { status: 201 });
          }
          if (url === graphqlUrl) {
            const body = init?.body
              ? JSON.parse(String(init.body)) as Record<string, unknown>
              : null;
            expect(body).toMatchObject({
              operationName: "PullRequestReviewThreads",
              variables: {
                number: pullRequestNumber,
                commentFirst: 20,
              },
            });
            return graphqlResponse(longThreadPayload(), "THREADS:TRUNCATED:1");
          }
          return Response.json({ message: "unexpected request" }, { status: 500 });
        }) as typeof fetch,
      },
    );

    const receipt = await mounted.callGitHubDelegatedRead!({
      project,
      repository: repositoryFullName,
      tool: "list_pull_request_review_threads",
      arguments: { pr_number: pullRequestNumber },
      actorId: "api-token:projection-test",
      clientId: "mcp:api-token:projection-test",
      catalogueFingerprint,
    });

    expect(receipt).toMatchObject({
      result: {
        threadCount: 1,
        commentCount: 20,
        threads: [{
          id: "PRRT_truncated",
          commentsTotalCount: 21,
          commentsTruncated: true,
        }],
      },
    });
    const result = receipt.result as {
      threads: Array<{ comments: unknown[] }>;
    };
    expect(result.threads[0]?.comments).toHaveLength(20);
  });

  test("public MCP projection preserves additive thread evidence", async () => {
    const calls: HostedGitHubDelegatedReadInput[] = [];
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    const provider: HostedGitHubDelegatedReadProvider = {
      delegatedGitHubReadTools: hostedGitHubDelegatedReadTools,
      async callGitHubDelegatedRead(input) {
        calls.push(input);
        return Object.freeze({
          version: 1,
          project: input.project,
          repositoryFullName: input.repository.toLowerCase(),
          tool: input.tool,
          actorId: input.actorId,
          clientId: input.clientId,
          connectionId: "ghconn_review_thread_projection",
          installationId: "98765",
          bindingId: "ghbind_review_thread_projection",
          attachmentId: "attach_review_thread_projection",
          attachmentSnapshotSha256: `sha256:${"b".repeat(64)}`,
          capabilityGrantId: null,
          approvalId: null,
          catalogueFingerprint: input.catalogueFingerprint,
          parametersSha256: `sha256:${"c".repeat(64)}`,
          providerRequestId: "THREADS:PUBLIC:TRUNCATED",
          resultSha256: `sha256:${"d".repeat(64)}`,
          result: Object.freeze({
            repositoryFullName: input.repository.toLowerCase(),
            number: input.arguments.pr_number,
            threadCount: 1,
            commentCount: 20,
            pageCount: 1,
            providerRequestIds: Object.freeze(["THREADS:PUBLIC:TRUNCATED"]),
            threads: Object.freeze([Object.freeze({
              id: "PRRT_public_truncated",
              commentsTotalCount: 21,
              commentsTruncated: true,
              comments: Object.freeze(Array.from(
                { length: 20 },
                (_, index) => Object.freeze({ id: `PRRC_public_${index + 1}` }),
              )),
            })]),
          }),
        });
      },
    };
    const server = createMcpServer(Object.assign(ledger, provider), {
      principal: readPrincipal(),
    });
    const client = new Client(
      { name: "review-thread-truncation-projection", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const receipt = await call<Record<string, unknown>>(
        client,
        "github_call_tool",
        {
          project,
          repository: repositoryFullName,
          tool: "list_pull_request_review_threads",
          arguments: { pr_number: pullRequestNumber },
          catalogueFingerprint,
        },
      );
      expect(receipt).toMatchObject({
        result: {
          threadCount: 1,
          commentCount: 20,
          threads: [{
            id: "PRRT_public_truncated",
            commentsTotalCount: 21,
            commentsTruncated: true,
          }],
        },
      });
      expect(calls).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});

function attachmentLedger(): WorkLedger & ProjectAttachmentLedger {
  return {
    async getProjectAttachment(requestedProject: string) {
      return requestedProject === project ? attachment : null;
    },
    async acceptProjectAttachment() {
      throw new Error("acceptProjectAttachment is outside this test");
    },
  } as unknown as WorkLedger & ProjectAttachmentLedger;
}

function providerEnv(): Record<string, string> {
  return {
    STENSIBLY_GITHUB_DELEGATED_READS_ENABLED: "true",
    STENSIBLY_GITHUB_APP_ID: "12345",
    STENSIBLY_GITHUB_APP_PRIVATE_KEY: privateKey,
    STENSIBLY_GITHUB_INSTALLATION_ID: "98765",
    STENSIBLY_GITHUB_PROVIDER_PROJECT: project,
    STENSIBLY_GITHUB_PROVIDER_REPOSITORY: repositoryFullName,
    STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN: "teamleaderleo",
    STENSIBLY_GITHUB_API_BASE_URL: "https://api.github.test",
  };
}

function longThreadPayload(): Record<string, unknown> {
  return {
    data: {
      repository: {
        nameWithOwner: "TeamLeaderLeo/Stensibly",
        pullRequest: {
          number: pullRequestNumber,
          reviewThreads: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: "thread-cursor" },
            nodes: [{
              id: "PRRT_truncated",
              isResolved: false,
              isOutdated: false,
              path: "src/long-discussion.ts",
              line: 20,
              originalLine: 20,
              startLine: null,
              originalStartLine: null,
              diffSide: "RIGHT",
              startDiffSide: null,
              resolvedBy: null,
              comments: {
                totalCount: 21,
                pageInfo: {
                  hasNextPage: true,
                  endCursor: "comment-cursor-20",
                },
                nodes: Array.from({ length: 20 }, (_, index) => ({
                  id: `PRRC_truncated_${index + 1}`,
                  bodyText: `Bounded review comment ${index + 1}.`,
                  createdAt: "2026-08-02T14:01:00Z",
                  updatedAt: "2026-08-02T14:02:00Z",
                  author: { login: "review-author" },
                  replyTo: null,
                  pullRequestReview: {
                    id: `PRR_truncated_${index + 1}`,
                    state: "COMMENTED",
                    submittedAt: "2026-08-02T14:01:30Z",
                    author: { login: "review-author" },
                  },
                })),
              },
            }],
          },
        },
      },
    },
  };
}

function graphqlResponse(payload: unknown, requestId: string): Response {
  const response = Response.json(payload, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-github-request-id": requestId,
    },
  });
  Object.defineProperties(response, {
    url: { configurable: true, value: graphqlUrl },
    redirected: { configurable: true, value: false },
  });
  return response;
}

function readPrincipal(): TokenPrincipal {
  return {
    tokenId: "review-thread-projection-token",
    name: "review thread projection test",
    scopes: ["read"],
    projects: [project],
  };
}

async function call<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(textContent(result));
  return JSON.parse(textContent(result)) as T;
}

function textContent(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error("MCP result had no content");
  }
  const first = content[0] as { type?: unknown; text?: unknown };
  if (first.type !== "text" || typeof first.text !== "string") {
    throw new Error("MCP result did not contain text");
  }
  return first.text;
}
