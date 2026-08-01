import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  GitHubCapabilityCatalogueService,
} from "../src/github-capability-service.ts";
import {
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
const pullRequestNumber = 84;
const fixedNow = Date.parse("2026-07-31T00:00:00.000Z");
const catalogueFingerprint =
  new GitHubCapabilityCatalogueService().registry.fingerprint;
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
  goal: "Exercise private hosted delegated GitHub pull request diff reads.",
  boundaries: "Keep credentials, writes, and public exposure outside this slice.",
  evidenceAndHandoff: "Return exact binding and provider receipts.",
  escalation: "Stop before dispatch when authority or binding changes.",
}));

const attachment: ProjectAttachmentRecord = {
  id: "attach_hosted_delegated_pr_diff_reads",
  project,
  snapshot,
  sourceRevision: "main@hosted-delegated-pr-diff-test",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: "2026-07-31T00:00:00.000Z",
};

describe("private hosted GitHub delegated pull request diff reads", () => {
  test("publishes bounded diff and patch receipts through one cached permission token", async () => {
    const calls: Array<{
      url: string;
      method: string;
      accept: string | null;
      authorization: string | null;
      body: unknown;
    }> = [];
    const diffContent = [
      "diff --git a/src/example.ts b/src/example.ts",
      "index 1111111..2222222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1 +1 @@",
      "+const credentialRef = 'env://OPENAI_API_KEY';",
      "",
    ].join("\n");
    const patchContent = [
      "From 1111111111111111111111111111111111111111 Mon Sep 17 00:00:00 2001",
      "Subject: [PATCH] Add bounded private diff read",
      "---",
      " src/example.ts | 1 +",
      " 1 file changed, 1 insertion(+)",
      "",
    ].join("\n");

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
            accept: headers.get("accept"),
            authorization: headers.get("authorization"),
            body,
          });
          if (url.endsWith("/app/installations/98765/access_tokens")) {
            return Response.json({
              token: "pull-request-diff-installation-token-secret",
              expires_at: "2026-07-31T01:00:00Z",
              permissions: {
                pull_requests: "read",
                metadata: "read",
              },
              repository_selection: "selected",
              repositories: [{ full_name: "TeamLeaderLeo/Stensibly" }],
            }, { status: 201 });
          }
          if (
            url
              === "https://api.github.test/repos/teamleaderleo/stensibly/pulls/84"
          ) {
            const accept = headers.get("accept");
            if (accept === "application/vnd.github.v3.diff") {
              return rawResponse(diffContent, "diff", "PRDIFF:1234");
            }
            if (accept === "application/vnd.github.v3.patch") {
              return rawResponse(patchContent, "patch", "PRPATCH:1234");
            }
          }
          return Response.json({ message: "unexpected request" }, { status: 500 });
        }) as unknown as typeof fetch,
      },
    );

    const diffReceipt = await mounted.callGitHubDelegatedRead!({
      ...callBase(),
      repository: "TeamLeaderLeo/Stensibly",
      tool: "get_pr_diff",
      arguments: { pr_number: pullRequestNumber, format: "diff" },
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
      providerRequestId: "PRDIFF:1234",
      result: {
        repositoryFullName,
        number: pullRequestNumber,
        format: "diff",
        byteLength: Buffer.byteLength(diffContent),
        content: diffContent,
      },
    });
    expect(patchReceipt).toMatchObject({
      tool: "get_pr_diff",
      providerRequestId: "PRPATCH:1234",
      result: {
        repositoryFullName,
        number: pullRequestNumber,
        format: "patch",
        byteLength: Buffer.byteLength(patchContent),
        content: patchContent,
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
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]).toMatchObject({
      method: "POST",
      body: {
        repositories: ["stensibly"],
        permissions: { pull_requests: "read" },
      },
    });
    const providerCalls = calls.filter((call) => call.method === "GET");
    expect(providerCalls).toHaveLength(2);
    expect(providerCalls.map((call) => call.accept)).toEqual([
      "application/vnd.github.v3.diff",
      "application/vnd.github.v3.patch",
    ]);
    expect(providerCalls.map((call) => call.authorization)).toEqual([
      "Bearer pull-request-diff-installation-token-secret",
      "Bearer pull-request-diff-installation-token-secret",
    ]);

    const serialized = JSON.stringify({ diffReceipt, patchReceipt });
    expect(serialized).not.toContain(privateKey);
    expect(serialized).not.toContain("installation-token-secret");
    expect(serialized).not.toContain("STENSIBLY_GITHUB_APP_PRIVATE_KEY");
  });

  test("keeps Actions step and remaining delegated reads outside private authority", async () => {
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
      tool: "fetch_workflow_job_steps",
      arguments: { job_id: 91345873454 },
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
      value: "https://api.github.test/repos/teamleaderleo/stensibly/pulls/84",
    },
    redirected: { configurable: true, value: false },
  });
  return response;
}
