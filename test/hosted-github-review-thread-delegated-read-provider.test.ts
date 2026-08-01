import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  GitHubCapabilityCatalogueService,
} from "../src/github-capability-service.ts";
import {
  hostedGitHubDelegatedReadTools,
  mountHostedGitHubDelegatedReadProviderFromEnv,
} from "../src/hosted-github-delegated-read-provider.ts";
import type { WorkLedger } from "../src/ledger.ts";
import type {
  ProjectAttachmentLedger,
  ProjectAttachmentRecord,
} from "../src/project-attachment-ledger.ts";
import {
  compileProjectContract,
  renderProjectContract,
} from "../src/project-contract.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const project = "oauth-dogfood";
const pullRequestNumber = 42;
const fixedNow = Date.parse("2026-08-01T08:00:00.000Z");
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
  goal: "Exercise private hosted GitHub review-thread reads.",
  boundaries: "Keep review writes, credentials, and unrelated GitHub tools outside this slice.",
  evidenceAndHandoff: "Return one bounded attributable review-thread receipt.",
  escalation: "Stop before dispatch when authority or binding changes.",
}));

const attachment: ProjectAttachmentRecord = {
  id: "attach_hosted_review_threads",
  project,
  snapshot,
  sourceRevision: "main@hosted-review-thread-test",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: "2026-08-01T08:00:00.000Z",
};

describe("private hosted GitHub review-thread delegated reads", () => {
  test("routes the exact PR through pull_requests:read and returns a frozen content-minimised receipt", async () => {
    const calls: Array<{
      url: string;
      method: string;
      authorization: string | null;
      body: Record<string, unknown> | null;
      signalPresent: boolean;
    }> = [];
    const mounted = mountHostedGitHubDelegatedReadProviderFromEnv(
      fakeLedger(),
      providerEnv(),
      {
        now: () => fixedNow,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const headers = new Headers(init?.headers);
          const body = init?.body
            ? JSON.parse(String(init.body)) as Record<string, unknown>
            : null;
          calls.push({
            url,
            method: init?.method ?? "GET",
            authorization: headers.get("authorization"),
            body,
            signalPresent: init?.signal !== undefined && init.signal !== null,
          });
          if (url.endsWith("/app/installations/98765/access_tokens")) {
            expect(body).toEqual({
              repositories: ["stensibly"],
              permissions: { pull_requests: "read" },
            });
            return Response.json({
              token: "review-thread-installation-token-secret",
              expires_at: "2026-08-01T09:00:00Z",
              permissions: { pull_requests: "read", metadata: "read" },
              repository_selection: "selected",
              repositories: [{ full_name: "TeamLeaderLeo/Stensibly" }],
            }, { status: 201 });
          }
          if (url === graphqlUrl) {
            expect(body).toMatchObject({
              operationName: "PullRequestReviewThreads",
              variables: {
                owner: "teamleaderleo",
                repository: "stensibly",
                number: pullRequestNumber,
                threadFirst: 25,
                threadAfter: null,
                commentFirst: 20,
              },
            });
            return graphqlResponse(reviewThreadPayload(), "THREADS:MOUNT:1");
          }
          return Response.json({ message: "unexpected request" }, { status: 500 });
        }) as typeof fetch,
      },
    );

    expect(mounted.delegatedGitHubReadTools)
      .toBe(hostedGitHubDelegatedReadTools);
    expect(mounted.delegatedGitHubReadTools)
      .toContain("list_pull_request_review_threads");

    const receipt = await mounted.callGitHubDelegatedRead!({
      ...callBase(),
      tool: "list_pull_request_review_threads",
      arguments: { pr_number: pullRequestNumber },
    });

    expect(receipt).toMatchObject({
      project,
      repositoryFullName,
      tool: "list_pull_request_review_threads",
      providerRequestId: "THREADS:MOUNT:1",
      result: {
        repositoryFullName,
        number: pullRequestNumber,
        threadCount: 1,
        commentCount: 1,
        pageCount: 1,
        providerRequestIds: ["THREADS:MOUNT:1"],
        threads: [{
          id: "PRRT_mount",
          resolved: true,
          outdated: false,
          path: "src/mount.ts",
          resolvedByLogin: "reviewer-one",
          comments: [{
            id: "PRRC_mount",
            authorLogin: "author-one",
            body: "Review [url omitted] before integration.",
            bodyWasMinimized: true,
            replyToId: null,
            review: {
              id: "PRR_mount",
              state: "COMMENTED",
              authorLogin: "author-one",
            },
          }],
        }],
      },
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.result)).toBe(true);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      method: "POST",
      authorization: null,
    });
    expect(calls[1]).toMatchObject({
      url: graphqlUrl,
      method: "POST",
      authorization: "Bearer review-thread-installation-token-secret",
      signalPresent: true,
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(privateKey);
    expect(serialized).not.toContain("installation-token-secret");
    expect(serialized).not.toContain("https://docs.github.test/private");
    expect(serialized).not.toContain("STENSIBLY_GITHUB_APP_PRIVATE_KEY");
  });

  test("denies an unmounted review write before token or provider activity", async () => {
    let externalCalls = 0;
    const mounted = mountHostedGitHubDelegatedReadProviderFromEnv(
      fakeLedger(),
      providerEnv(),
      {
        now: () => fixedNow,
        fetch: (async () => {
          externalCalls += 1;
          return Response.json({ message: "must not dispatch" }, { status: 500 });
        }) as unknown as typeof fetch,
      },
    );

    await expect(mounted.callGitHubDelegatedRead!({
      ...callBase(),
      tool: "add_review_to_pr",
      arguments: { pr_number: pullRequestNumber, action: "APPROVE" },
    })).rejects.toThrow("authority denied");
    expect(externalCalls).toBe(0);
  });
});

function callBase() {
  return {
    project,
    repository: repositoryFullName,
    actorId: "api-token:test",
    clientId: "mcp:api-token:test",
    catalogueFingerprint,
  };
}

function fakeLedger(): WorkLedger & ProjectAttachmentLedger {
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

function reviewThreadPayload() {
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
              id: "PRRT_mount",
              isResolved: true,
              isOutdated: false,
              path: "src/mount.ts",
              line: 12,
              originalLine: 11,
              startLine: null,
              originalStartLine: null,
              diffSide: "RIGHT",
              startDiffSide: null,
              resolvedBy: { login: "reviewer-one" },
              comments: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: "comment-cursor" },
                nodes: [{
                  id: "PRRC_mount",
                  bodyText: "Review https://docs.github.test/private before integration.",
                  createdAt: "2026-08-01T08:01:00Z",
                  updatedAt: "2026-08-01T08:02:00Z",
                  author: { login: "author-one" },
                  replyTo: null,
                  pullRequestReview: {
                    id: "PRR_mount",
                    state: "COMMENTED",
                    submittedAt: "2026-08-01T08:01:30Z",
                    author: { login: "author-one" },
                  },
                }],
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
