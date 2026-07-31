import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  GitHubCapabilityCatalogueService,
} from "../src/github-capability-service.ts";
import {
  hostedGitHubDelegatedReadProviderConfigured,
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
const fixedNow = Date.parse("2026-07-31T00:00:00.000Z");
const commitSha = "b".repeat(40);
const blobSha = "c".repeat(40);
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
  goal: "Exercise private hosted delegated GitHub reads.",
  boundaries: "Keep credentials, writes, and public dispatch outside this slice.",
  evidenceAndHandoff: "Return exact binding and provider receipts.",
  escalation: "Stop before dispatch when authority or binding changes.",
}));

const attachment: ProjectAttachmentRecord = {
  id: "attach_hosted_delegated_reads",
  project,
  snapshot,
  sourceRevision: "main@hosted-delegated-read-test",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: "2026-07-31T00:00:00.000Z",
};

describe("private hosted GitHub delegated reads", () => {
  test("mints exact per-tool tokens and returns attributable two-tool receipts", async () => {
    const calls: Array<{
      url: string;
      method: string;
      authorization: string | null;
      body: unknown;
    }> = [];
    const fileContent = Buffer.from("private composition proof\n", "utf8");
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
            body,
          });
          if (url.endsWith("/app/installations/98765/access_tokens")) {
            const permissions = body?.permissions as Record<string, string>;
            const permission = Object.keys(permissions)[0]!;
            return Response.json({
              token: `${permission}-installation-token-secret`,
              expires_at: "2026-07-31T01:00:00Z",
              permissions: permission === "metadata"
                ? { metadata: "read" }
                : { contents: "read", metadata: "read" },
              repository_selection: "selected",
              repositories: [{ full_name: "TeamLeaderLeo/Stensibly" }],
            }, { status: 201 });
          }
          if (url === "https://api.github.test/repos/teamleaderleo/stensibly") {
            return Response.json(repositoryPayload(), {
              headers: { "x-github-request-id": "REPO:1234" },
            });
          }
          if (url === `https://api.github.test/repos/teamleaderleo/stensibly/contents/README.md?ref=${commitSha}`) {
            return Response.json({
              type: "file",
              path: "README.md",
              sha: blobSha,
              size: fileContent.byteLength,
              encoding: "base64",
              content: fileContent.toString("base64"),
              url: `https://api.github.test/repos/TeamLeaderLeo/Stensibly/contents/README.md?ref=${commitSha}`,
              git_url: `https://api.github.test/repos/TeamLeaderLeo/Stensibly/git/blobs/${blobSha}`,
            }, {
              headers: { "x-github-request-id": "FILE:1234" },
            });
          }
          return Response.json({ message: "unexpected request" }, { status: 500 });
        }) as typeof fetch,
      },
    );

    const repositoryReceipt = await mounted.callGitHubDelegatedRead!({
      ...callBase(),
      repository: "TeamLeaderLeo/Stensibly",
      tool: "get_repo",
      arguments: {},
    });
    const fileReceipt = await mounted.callGitHubDelegatedRead!({
      ...callBase(),
      tool: "fetch_file",
      arguments: { path: "README.md", ref: commitSha },
    });

    expect(repositoryReceipt).toMatchObject({
      version: 1,
      project,
      repositoryFullName,
      tool: "get_repo",
      connectionId: "ghconn_installation_98765",
      installationId: "98765",
      attachmentId: attachment.id,
      attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
      capabilityGrantId: null,
      approvalId: null,
      catalogueFingerprint,
      providerRequestId: "REPO:1234",
      result: {
        repositoryFullName,
        id: 123456,
        defaultBranch: "main",
      },
    });
    expect(repositoryReceipt.bindingId).toMatch(/^ghbind_[a-f0-9]{24}$/);
    expect(repositoryReceipt.parametersSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(repositoryReceipt.resultSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(fileReceipt).toMatchObject({
      tool: "fetch_file",
      providerRequestId: "FILE:1234",
      result: {
        repositoryFullName,
        path: "README.md",
        ref: commitSha,
        blobSha,
        size: fileContent.byteLength,
        encoding: "base64",
        contentBase64: fileContent.toString("base64"),
      },
    });
    expect(Object.isFrozen(repositoryReceipt)).toBe(true);
    expect(Object.isFrozen(fileReceipt)).toBe(true);

    const tokenCalls = calls.filter((call) =>
      call.url.endsWith("/app/installations/98765/access_tokens")
    );
    expect(tokenCalls).toHaveLength(2);
    expect(tokenCalls.map((call) => call.body)).toEqual([
      {
        repositories: ["stensibly"],
        permissions: { metadata: "read" },
      },
      {
        repositories: ["stensibly"],
        permissions: { contents: "read" },
      },
    ]);
    const providerCalls = calls.filter((call) => call.method === "GET");
    expect(providerCalls).toHaveLength(2);
    expect(providerCalls.map((call) => call.authorization)).toEqual([
      "Bearer metadata-installation-token-secret",
      "Bearer contents-installation-token-secret",
    ]);
    const serialized = JSON.stringify({ repositoryReceipt, fileReceipt });
    expect(serialized).not.toContain(privateKey);
    expect(serialized).not.toContain("installation-token-secret");
    expect(serialized).not.toContain("STENSIBLY_GITHUB_APP_PRIVATE_KEY");
  });

  test("rejects stale, unbound, malformed, and unsupported calls before token or provider activity", async () => {
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
      catalogueFingerprint: `sha256:${"0".repeat(64)}`,
      tool: "get_repo",
      arguments: {},
    })).rejects.toThrow("catalogue fingerprint is stale");
    await expect(mounted.callGitHubDelegatedRead!({
      ...callBase(),
      repository: "teamleaderleo/another-repository",
      tool: "get_repo",
      arguments: {},
    })).rejects.toThrow("outside the accepted project attachment");
    await expect(mounted.callGitHubDelegatedRead!({
      ...callBase(),
      tool: "get_pr_info",
      arguments: { pullNumber: 1 },
    })).rejects.toThrow("authority denied");
    await expect(mounted.callGitHubDelegatedRead!({
      ...callBase(),
      tool: "fetch_file",
      arguments: { path: "README.md", ref: "main" },
    })).rejects.toBeInstanceOf(Error);

    const missingAttachment = mountHostedGitHubDelegatedReadProviderFromEnv(
      fakeLedger(null),
      providerEnv(),
      {
        now: () => fixedNow,
        fetch: (async () => {
          externalCalls += 1;
          return Response.json({ message: "must not dispatch" }, { status: 500 });
        }) as unknown as typeof fetch,
      },
    );
    await expect(missingAttachment.callGitHubDelegatedRead!({
      ...callBase(),
      tool: "get_repo",
      arguments: {},
    })).rejects.toThrow("no accepted repository attachment");

    expect(externalCalls).toBe(0);
  });

  test("stays disabled by default and fails closed on partial or malformed enablement", () => {
    const ledger = fakeLedger();
    expect(
      mountHostedGitHubDelegatedReadProviderFromEnv(ledger, providerEnv(false)),
    ).toBe(ledger);
    expect("callGitHubDelegatedRead" in ledger).toBe(false);
    expect(hostedGitHubDelegatedReadProviderConfigured(providerEnv(false)))
      .toBe(false);

    const explicitlyDisabled = providerEnv();
    explicitlyDisabled.STENSIBLY_GITHUB_DELEGATED_READS_ENABLED = "false";
    const secondLedger = fakeLedger();
    expect(
      mountHostedGitHubDelegatedReadProviderFromEnv(
        secondLedger,
        explicitlyDisabled,
      ),
    ).toBe(secondLedger);
    expect("callGitHubDelegatedRead" in secondLedger).toBe(false);

    expect(() => mountHostedGitHubDelegatedReadProviderFromEnv(fakeLedger(), {
      STENSIBLY_GITHUB_DELEGATED_READS_ENABLED: "true",
    })).toThrow("STENSIBLY_GITHUB_APP_ID");

    const malformed = providerEnv();
    malformed.STENSIBLY_GITHUB_DELEGATED_READS_ENABLED = " true ";
    expect(() => hostedGitHubDelegatedReadProviderConfigured(malformed))
      .toThrow("must be exact true or false");
  });

  test("rejects an invalid clock before mounting credentials or provider activity", () => {
    let externalCalls = 0;
    expect(() => mountHostedGitHubDelegatedReadProviderFromEnv(
      fakeLedger(),
      providerEnv(),
      {
        now: () => Number.NaN,
        fetch: (async () => {
          externalCalls += 1;
          return Response.json({});
        }) as unknown as typeof fetch,
      },
    )).toThrow("require a valid current time");
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

function fakeLedger(
  record: ProjectAttachmentRecord | null = attachment,
): WorkLedger & ProjectAttachmentLedger {
  return {
    async getProjectAttachment(requestedProject: string) {
      return requestedProject === project ? record : null;
    },
    async acceptProjectAttachment() {
      throw new Error("acceptProjectAttachment is outside this test");
    },
  } as unknown as WorkLedger & ProjectAttachmentLedger;
}

function providerEnv(enabled = true): Record<string, string> {
  return {
    ...(enabled
      ? { STENSIBLY_GITHUB_DELEGATED_READS_ENABLED: "true" }
      : {}),
    STENSIBLY_GITHUB_APP_ID: "12345",
    STENSIBLY_GITHUB_APP_PRIVATE_KEY: privateKey,
    STENSIBLY_GITHUB_INSTALLATION_ID: "98765",
    STENSIBLY_GITHUB_PROVIDER_PROJECT: project,
    STENSIBLY_GITHUB_PROVIDER_REPOSITORY: repositoryFullName,
    STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN: "teamleaderleo",
    STENSIBLY_GITHUB_API_BASE_URL: "https://api.github.test",
  };
}

function repositoryPayload() {
  return {
    id: 123456,
    node_id: "R_kgDOHostedDelegated",
    full_name: "TeamLeaderLeo/Stensibly",
    private: true,
    archived: false,
    disabled: false,
    visibility: "private",
    default_branch: "main",
    updated_at: "2026-07-31T00:10:00Z",
    pushed_at: "2026-07-31T00:09:00Z",
  };
}
