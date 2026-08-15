import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { GitHubCapabilityCatalogueService } from "../src/github-capability-service.ts";
import {
  hostedGitHubDelegatedReadJobDetailTools,
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
const fixedNow = Date.parse("2026-08-15T09:45:00.000Z");
const commitSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const blobSha = "c".repeat(40);
const tagSha = "d".repeat(40);
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
  goal: "Exercise guarded hosted GitHub repository navigation reads.",
  boundaries: "Keep credentials, mutable reads, artifacts, and writes outside this slice.",
  evidenceAndHandoff: "Return bounded directory and ref receipts.",
  escalation: "Stop before dispatch when authority or binding changes.",
}));

const attachment: ProjectAttachmentRecord = {
  id: "attach_hosted_repository_navigation",
  project,
  snapshot,
  sourceRevision: "main@hosted-repository-navigation-test",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: "2026-08-15T09:45:00.000Z",
};

describe("hosted GitHub repository navigation", () => {
  test("mounts and routes immutable directory plus exact annotated-tag resolution", async () => {
    const calls: Array<{
      url: string;
      authorization: string | null;
      body: unknown;
    }> = [];
    const mounted = mountHostedGitHubDelegatedReadProviderFromEnv(
      fakeLedger(),
      providerEnv(),
      {
        now: () => fixedNow,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const headers = new Headers(init?.headers);
          const body = init?.body ? JSON.parse(String(init.body)) : null;
          calls.push({
            url,
            authorization: headers.get("authorization"),
            body,
          });
          if (url.endsWith("/app/installations/98765/access_tokens")) {
            return Response.json({
              token: "contents-installation-token-secret",
              expires_at: "2026-08-15T10:45:00Z",
              permissions: { contents: "read", metadata: "read" },
              repository_selection: "selected",
              repositories: [{ full_name: "TeamLeaderLeo/Stensibly" }],
            }, { status: 201 });
          }
          if (url === `https://api.github.test/repos/teamleaderleo/stensibly/contents?ref=${commitSha}`) {
            return Response.json([
              {
                name: "src",
                path: "src",
                type: "dir",
                sha: treeSha,
                size: 0,
                url: `https://api.github.test/repos/teamleaderleo/stensibly/contents/src?ref=${commitSha}`,
              },
              {
                name: "README.md",
                path: "README.md",
                type: "file",
                sha: blobSha,
                size: 321,
                url: `https://api.github.test/repos/teamleaderleo/stensibly/contents/README.md?ref=${commitSha}`,
              },
            ], { headers: { "x-github-request-id": "NAV:DIR" } });
          }
          if (url === "https://api.github.test/repos/teamleaderleo/stensibly/git/ref/tags/v1.0.0") {
            return Response.json({
              ref: "refs/tags/v1.0.0",
              url: "https://api.github.test/repos/teamleaderleo/stensibly/git/refs/tags/v1.0.0",
              object: {
                type: "tag",
                sha: tagSha,
                url: `https://api.github.test/repos/teamleaderleo/stensibly/git/tags/${tagSha}`,
              },
            }, { headers: { "x-github-request-id": "NAV:REF" } });
          }
          if (url === `https://api.github.test/repos/teamleaderleo/stensibly/git/tags/${tagSha}`) {
            return Response.json({
              sha: tagSha,
              url: `https://api.github.test/repos/teamleaderleo/stensibly/git/tags/${tagSha}`,
              object: {
                type: "commit",
                sha: commitSha,
                url: `https://api.github.test/repos/teamleaderleo/stensibly/git/commits/${commitSha}`,
              },
            }, { headers: { "x-github-request-id": "NAV:TAG" } });
          }
          return Response.json({ message: "unexpected request" }, { status: 500 });
        }) as typeof fetch,
      },
    );

    expect(mounted.delegatedGitHubReadTools)
      .toBe(hostedGitHubDelegatedReadJobDetailTools);
    expect(mounted.delegatedGitHubReadTools).toContain("list_directory");
    expect(mounted.delegatedGitHubReadTools).toContain("resolve_ref");

    const directoryReceipt = await mounted.callGitHubDelegatedRead!({
      ...callBase(),
      tool: "list_directory",
      arguments: { path: "", ref: commitSha },
    });
    const refReceipt = await mounted.callGitHubDelegatedRead!({
      ...callBase(),
      tool: "resolve_ref",
      arguments: { ref: "refs/tags/v1.0.0" },
    });

    expect(directoryReceipt).toMatchObject({
      project,
      repositoryFullName,
      tool: "list_directory",
      providerRequestId: "NAV:DIR",
      result: {
        repositoryFullName,
        path: "",
        commitSha,
        truncated: false,
        entries: [
          { path: "README.md", type: "file", objectSha: blobSha, size: 321 },
          { path: "src", type: "dir", objectSha: treeSha, size: null },
        ],
      },
    });
    expect(refReceipt).toMatchObject({
      project,
      repositoryFullName,
      tool: "resolve_ref",
      providerRequestId: "NAV:TAG",
      result: {
        repositoryFullName,
        ref: "refs/tags/v1.0.0",
        refType: "tag",
        refObjectSha: tagSha,
        commitSha,
        peeledTagDepth: 1,
      },
    });
    expect(Object.isFrozen(directoryReceipt)).toBe(true);
    expect(Object.isFrozen(refReceipt)).toBe(true);

    const tokenCalls = calls.filter((call) =>
      call.url.endsWith("/app/installations/98765/access_tokens")
    );
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.body).toEqual({
      repositories: ["stensibly"],
      permissions: { contents: "read" },
    });
    const serialized = JSON.stringify({ directoryReceipt, refReceipt });
    expect(serialized).not.toContain(privateKey);
    expect(serialized).not.toContain("installation-token-secret");
    expect(serialized).not.toContain("authorization");
  });

  test("stale catalogue and foreign repository stop before token mint", async () => {
    let providerCalls = 0;
    const mounted = mountHostedGitHubDelegatedReadProviderFromEnv(
      fakeLedger(),
      providerEnv(),
      {
        now: () => fixedNow,
        fetch: (async () => {
          providerCalls += 1;
          return Response.json({});
        }) as unknown as typeof fetch,
      },
    );

    await expect(mounted.callGitHubDelegatedRead!({
      ...callBase(),
      catalogueFingerprint: `sha256:${"f".repeat(64)}`,
      tool: "list_directory",
      arguments: { path: "", ref: commitSha },
    })).rejects.toThrow("catalogue fingerprint is stale");
    await expect(mounted.callGitHubDelegatedRead!({
      ...callBase(),
      repository: "teamleaderleo/other",
      tool: "resolve_ref",
      arguments: { ref: "refs/heads/main" },
    })).rejects.toBeInstanceOf(Error);
    expect(providerCalls).toBe(0);
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
