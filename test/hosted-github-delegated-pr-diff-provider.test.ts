import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  GitHubCapabilityCatalogueService,
} from "../src/github-capability-service.ts";
import {
  mountHostedGitHubDelegatedReadProviderFromEnv,
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
import type { TokenPrincipal } from "../src/token-contracts.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const project = "oauth-dogfood";
const pullRequestNumber = 42;
const pullRequestUrl =
  "https://api.github.test/repos/teamleaderleo/stensibly/pulls/42";
const fixedNow = Date.parse("2026-08-01T00:00:00.000Z");
const catalogueFingerprint =
  new GitHubCapabilityCatalogueService().registry.fingerprint;
const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;

const diffText = [
  "diff --git a/src/config.ts b/src/config.ts",
  "index 1111111..2222222 100644",
  "--- a/src/config.ts",
  "+++ b/src/config.ts",
  "@@ -1 +1 @@",
  "-export const refs = ['env://OLD_KEY'];",
  "+export const refs = ['env://OPENAI_API_KEY', 'secret://github/app-private-key'];",
  "",
].join("\n");

const patchText = [
  "From 0123456789abcdef0123456789abcdef01234567 Mon Sep 17 00:00:00 2001",
  "Subject: [PATCH] Keep credential locators exact",
  "---",
  " src/config.ts | 2 +-",
  " 1 file changed, 1 insertion(+), 1 deletion(-)",
  "",
  diffText,
].join("\n");

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
  goal: "Exercise private hosted delegated GitHub pull-request text reads.",
  boundaries: "Keep credential values, writes, and public diff dispatch outside this slice.",
  evidenceAndHandoff: "Return exact binding and bounded provider receipts.",
  escalation: "Stop before dispatch when authority, identity, or catalogue evidence changes.",
}));

const attachment: ProjectAttachmentRecord = {
  id: "attach_hosted_delegated_pr_diff_reads",
  project,
  snapshot,
  sourceRevision: "main@hosted-delegated-pr-diff-test",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: "2026-08-01T00:00:00.000Z",
};

describe("private hosted GitHub pull request diff reads", () => {
  test("returns bounded attributable diff and patch receipts with pull-request-only authority", async () => {
    const calls: Array<{
      url: string;
      method: string;
      authorization: string | null;
      accept: string | null;
      body: unknown;
    }> = [];
    let rawCall = 0;
    const mounted = mountHostedGitHubDelegatedReadProviderFromEnv(
      fakeLedger(),
      providerEnv(),
      {
        now: () => fixedNow,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          const headers = new Headers(init?.headers);
          const body = init?.body
            ? JSON.parse(String(init.body)) as Record<string, unknown>
            : null;
          calls.push({
            url,
            method,
            authorization: headers.get("authorization"),
            accept: headers.get("accept"),
            body,
          });
          if (url.endsWith("/app/installations/98765/access_tokens")) {
            return Response.json({
              token: "pull-request-installation-token-secret",
              expires_at: "2026-08-01T01:00:00Z",
              permissions: {
                pull_requests: "read",
                metadata: "read",
              },
              repository_selection: "selected",
              repositories: [{ full_name: "TeamLeaderLeo/Stensibly" }],
            }, { status: 201 });
          }
          if (url === pullRequestUrl) {
            rawCall += 1;
            const format = headers.get("accept")
              === "application/vnd.github.v3.patch"
              ? "patch"
              : "diff";
            return rawResponse(
              format === "patch" ? patchText : diffText,
              format,
              `PRRAW:HOSTED:${rawCall}`,
            );
          }
          return Response.json({ message: "unexpected request" }, { status: 500 });
        }) as unknown as typeof fetch,
      },
    );

    const diffReceipt = await mounted.callGitHubDelegatedRead!({
      ...callBase(),
      repository: "TeamLeaderLeo/Stensibly",
      tool: "get_pr_diff",
      arguments: { pr_number: pullRequestNumber },
    });
    const patchReceipt = await mounted.callGitHubDelegatedRead!({
      ...callBase(),
      tool: "get_pr_diff",
      arguments: { pr_number: pullRequestNumber, format: "patch" },
    });

    expect(diffReceipt).toMatchObject({
      version: 1,
      project,
      repositoryFullName,
      tool: "get_pr_diff",
      connectionId: "ghconn_installation_98765",
      installationId: "98765",
      attachmentId: attachment.id,
      attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
      capabilityGrantId: null,
      approvalId: null,
      catalogueFingerprint,
      providerRequestId: "PRRAW:HOSTED:1",
      result: {
        repositoryFullName,
        number: pullRequestNumber,
        format: "diff",
        byteLength: Buffer.byteLength(diffText, "utf8"),
        content: diffText,
      },
    });
    expect(patchReceipt).toMatchObject({
      version: 1,
      project,
      repositoryFullName,
      tool: "get_pr_diff",
      providerRequestId: "PRRAW:HOSTED:2",
      result: {
        repositoryFullName,
        number: pullRequestNumber,
        format: "patch",
        byteLength: Buffer.byteLength(patchText, "utf8"),
        content: patchText,
      },
    });
    expect(diffReceipt.bindingId).toMatch(/^ghbind_[a-f0-9]{24}$/);
    expect(diffReceipt.parametersSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(diffReceipt.resultSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(diffReceipt)).toBe(true);
    expect(Object.isFrozen(diffReceipt.result)).toBe(true);
    expect(Object.isFrozen(patchReceipt)).toBe(true);
    expect(Object.isFrozen(patchReceipt.result)).toBe(true);

    const tokenCalls = calls.filter((call) =>
      call.url.endsWith("/app/installations/98765/access_tokens")
    );
    expect(tokenCalls).toHaveLength(2);
    expect(tokenCalls.map((call) => call.body)).toEqual([
      {
        repositories: ["stensibly"],
        permissions: { pull_requests: "read" },
      },
      {
        repositories: ["stensibly"],
        permissions: { pull_requests: "read" },
      },
    ]);
    const providerCalls = calls.filter((call) => call.method === "GET");
    expect(providerCalls).toHaveLength(2);
    expect(providerCalls.map((call) => call.url)).toEqual([
      pullRequestUrl,
      pullRequestUrl,
    ]);
    expect(providerCalls.map((call) => call.authorization)).toEqual([
      "Bearer pull-request-installation-token-secret",
      "Bearer pull-request-installation-token-secret",
    ]);
    expect(providerCalls.map((call) => call.accept)).toEqual([
      "application/vnd.github.v3.diff",
      "application/vnd.github.v3.patch",
    ]);

    const serialized = JSON.stringify({ diffReceipt, patchReceipt });
    expect(serialized).toContain("env://OPENAI_API_KEY");
    expect(serialized).toContain("secret://github/app-private-key");
    expect(serialized).not.toContain(privateKey);
    expect(serialized).not.toContain("installation-token-secret");
    expect(serialized).not.toContain("STENSIBLY_GITHUB_APP_PRIVATE_KEY");
  });

  test("keeps review, status, and Actions reads outside private authority", async () => {
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

    for (const input of [
      {
        tool: "list_pull_request_review_threads",
        arguments: { pr_number: pullRequestNumber },
      },
      {
        tool: "get_commit_combined_status",
        arguments: { commit_sha: "a".repeat(40) },
      },
      {
        tool: "fetch_commit_workflow_runs",
        arguments: { commit_sha: "a".repeat(40) },
      },
      {
        tool: "fetch_workflow_run_jobs",
        arguments: { run_id: 123 },
      },
    ]) {
      await expect(mounted.callGitHubDelegatedRead!({
        ...callBase(),
        ...input,
      })).rejects.toBeInstanceOf(Error);
    }
    expect(externalCalls).toBe(0);
  });

  test("preserves the public three-read discovery and dispatch fence", async () => {
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
    const server = createMcpServer(mounted, {
      principal: readPrincipal(),
    });
    const client = new Client(
      { name: "hosted-pr-diff-public-fence", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const toolsets = await call<{
        delegatedTools: string[];
      }>(client, "github_list_toolsets", {});
      expect(toolsets.delegatedTools).toEqual([
        "get_repo",
        "fetch_file",
        "get_pr_info",
      ]);
      const denied = await client.callTool({
        name: "github_call_tool",
        arguments: {
          project,
          repository: repositoryFullName,
          tool: "get_pr_diff",
          arguments: { pr_number: pullRequestNumber, format: "diff" },
          catalogueFingerprint,
        },
      });
      expect(denied.isError).toBe(true);
      expect(externalCalls).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

function rawResponse(
  content: string,
  format: "diff" | "patch",
  requestId: string,
): Response {
  const response = new Response(content, {
    status: 200,
    headers: {
      "content-type": `application/vnd.github.v3.${format}; charset=utf-8`,
      "x-github-request-id": requestId,
    },
  });
  Object.defineProperties(response, {
    url: {
      configurable: true,
      value: pullRequestUrl,
    },
    redirected: {
      configurable: true,
      value: false,
    },
  });
  return response;
}

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

function readPrincipal(): TokenPrincipal {
  return {
    tokenId: "hosted-pr-diff-public-fence",
    name: "hosted PR diff public fence",
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
