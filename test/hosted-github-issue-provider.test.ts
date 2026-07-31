import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { GitHubRestIssueProviderAdapter } from "../src/github-rest-issue-adapter.ts";
import {
  mountHostedGitHubIssueProviderFromEnv,
} from "../src/hosted-github-issue-provider.ts";
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

const projectContract = {
  version: 1 as const,
  project,
  repositories: [repositoryFullName],
  runnerProfiles: [],
  concurrency: { project: 1, global: 1 },
  autonomousActions: ["inspect"],
  approvalRequired: ["write"],
  checks: [],
  tags: [],
  relatedProjects: [],
};

const projectContext = {
  goal: "Exercise hosted GitHub issue reads.",
  boundaries: "Keep provider credentials server-side.",
  evidenceAndHandoff: "Record exact provider evidence.",
  escalation: "Stop when the accepted repository binding changes.",
};

const snapshot = compileProjectContract(
  renderProjectContract(projectContract, projectContext),
);

const attachment: ProjectAttachmentRecord = {
  id: "attach_hosted_github",
  project,
  snapshot,
  sourceRevision: "main@provider-read-test",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: "2026-07-31T00:00:00.000Z",
};

const apiIssue = {
  number: 525,
  node_id: "I_kwDOHostedRead",
  repository_url: "https://api.github.test/repos/teamleaderleo/stensibly",
  title: "Bake first-party GitHub actions into Stensibly",
  body: "provider body remains outside the MCP result",
  state: "open",
  state_reason: null,
  labels: [{ name: "enhancement" }],
  assignees: [{ login: "teamleaderleo" }],
  milestone: null,
  created_at: "2026-07-29T13:16:18Z",
  updated_at: "2026-07-31T00:10:00Z",
};

const apiPullRequest = {
  ...apiIssue,
  number: 645,
  node_id: "PR_kwDOHostedRead",
  title: "A pull request",
  pull_request: { url: "https://api.github.com/repos/teamleaderleo/stensibly/pulls/645" },
};

describe("hosted GitHub issue provider", () => {
  test("mints one narrowed installation token and executes all three typed reads", async () => {
    const privateKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }).privateKey;
    const calls: Array<{
      url: string;
      method: string;
      authorization: string | null;
      body: unknown;
    }> = [];
    const fetcher = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
      calls.push({
        url,
        method,
        authorization: headers.get("authorization"),
        body,
      });
      if (url.endsWith("/app/installations/98765/access_tokens")) {
        return Response.json({
          token: "installation-token-secret",
          expires_at: "2026-07-31T01:00:00Z",
          permissions: { issues: "read", metadata: "read" },
          repository_selection: "selected",
          repositories: [{ full_name: "TeamLeaderLeo/Stensibly" }],
        }, {
          status: 201,
          headers: { "x-github-request-id": "token-request" },
        });
      }
      if (url.includes("/search/issues")) {
        return Response.json({
          total_count: 1,
          incomplete_results: false,
          items: [apiIssue],
        }, {
          headers: { "x-github-request-id": "search-request" },
        });
      }
      if (url.endsWith("/repos/teamleaderleo/stensibly/issues/525")) {
        return Response.json(apiIssue, {
          headers: { "x-github-request-id": "get-request" },
        });
      }
      if (url.includes("/repos/teamleaderleo/stensibly/issues?")) {
        return Response.json([apiPullRequest, apiIssue], {
          headers: { "x-github-request-id": "list-request" },
        });
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    };

    const env = providerEnv(privateKey);
    env.STENSIBLY_GITHUB_PROVIDER_REPOSITORY = "TeamLeaderLeo/Stensibly";
    env.STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN = "TeamLeaderLeo";
    const mounted = mountHostedGitHubIssueProviderFromEnv(
      fakeLedger(),
      env,
      { fetch: fetcher as typeof fetch, now: () => fixedNow },
    );

    const context = {
      project,
      repository: repositoryFullName,
      actorId: "api-token:test",
      clientId: "mcp:api-token:test",
    };
    const listed = await mounted.listIssues!({
      ...context,
      state: "open",
      limit: 10,
    });
    const searched = await mounted.searchIssues!({
      ...context,
      query: "first-party GitHub actions",
      state: "all",
      limit: 10,
    });
    const issue = await mounted.getIssue!({
      ...context,
      issueNumber: 525,
    });

    expect(listed.issues).toHaveLength(1);
    expect(listed.issues[0]?.reference.externalId).toBe(
      "github:teamleaderleo/stensibly#525",
    );
    expect(searched.issues).toHaveLength(1);
    expect(issue).toMatchObject({
      title: apiIssue.title,
      state: "open",
      providerNodeId: apiIssue.node_id,
      containsIssueBody: false,
    });
    expect(issue.sourceRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
    const serialized = JSON.stringify({ listed, searched, issue });
    expect(serialized).not.toContain("installation-token-secret");
    expect(serialized).not.toContain(apiIssue.body);

    const tokenCalls = calls.filter((call) =>
      call.url.endsWith("/app/installations/98765/access_tokens")
    );
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.method).toBe("POST");
    expect(tokenCalls[0]?.authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
    expect(tokenCalls[0]?.body).toEqual({
      repositories: ["stensibly"],
      permissions: { issues: "read" },
    });
    const providerCalls = calls.filter((call) => call.method === "GET");
    expect(providerCalls).toHaveLength(3);
    expect(providerCalls.every((call) =>
      call.authorization === "Bearer installation-token-secret"
    )).toBe(true);
    expect(providerCalls.find((call) => call.url.includes("/search/issues"))?.url)
      .toContain("repo%3Ateamleaderleo%2Fstensibly+is%3Aissue");
  });

  test("accepts a mixed-case caller against lowercase hosted configuration", async () => {
    const privateKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }).privateKey;
    let mintCalls = 0;
    let issueCalls = 0;
    const mounted = mountHostedGitHubIssueProviderFromEnv(
      fakeLedger(),
      providerEnv(privateKey),
      {
        fetch: (async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith("/app/installations/98765/access_tokens")) {
            mintCalls += 1;
            return Response.json({
              token: "installation-token-secret",
              expires_at: "2026-07-31T01:00:00Z",
              permissions: { issues: "read" },
              repository_selection: "selected",
              repositories: [{ full_name: repositoryFullName }],
            }, { status: 201 });
          }
          issueCalls += 1;
          expect(url).toEndWith("/repos/teamleaderleo/stensibly/issues/525");
          return Response.json(apiIssue);
        }) as unknown as typeof fetch,
        now: () => fixedNow,
      },
    );

    const issue = await mounted.getIssue!({
      project,
      repository: "TeamLeaderLeo/Stensibly",
      actorId: "api-token:test",
      clientId: "mcp:api-token:test",
      issueNumber: 525,
    });

    expect(issue.reference.externalId).toBe("github:teamleaderleo/stensibly#525");
    expect(mintCalls).toBe(1);
    expect(issueCalls).toBe(1);
  });

  test("rejects cross-repository provider results for every typed read", async () => {
    let providerCalls = 0;
    const foreignIssue = {
      ...apiIssue,
      repository_url: "https://api.github.test/repos/teamleaderleo/other",
    };
    const adapter = new GitHubRestIssueProviderAdapter({
      tokenProvider: {
        async getInstallationToken() {
          return {
            token: "read-token",
            expiresAt: "2026-07-31T01:00:00.000Z",
          };
        },
      },
      apiBaseUrl: "https://api.github.test",
      fetch: (async (input: RequestInfo | URL) => {
        providerCalls += 1;
        const url = String(input);
        if (url.includes("/search/issues")) {
          return Response.json({ items: [foreignIssue] });
        }
        if (url.endsWith("/issues/525")) {
          return Response.json(foreignIssue);
        }
        return Response.json([foreignIssue]);
      }) as typeof fetch,
    });

    await expect(adapter.listIssues({
      repositoryFullName,
      state: "open",
      limit: 10,
    })).rejects.toThrow("did not match the accepted repository");
    await expect(adapter.searchIssues({
      repositoryFullName,
      query: "provider identity",
      state: "all",
      limit: 10,
    })).rejects.toThrow("did not match the accepted repository");
    await expect(adapter.getIssue({
      repositoryFullName,
      issueNumber: 525,
    })).rejects.toThrow("did not match the accepted repository");
    expect(providerCalls).toBe(3);
  });

  test("keeps the provider absent when no GitHub App configuration exists", () => {
    const ledger = fakeLedger();
    const mounted = mountHostedGitHubIssueProviderFromEnv(ledger, {});
    expect(mounted).toBe(ledger);
    expect("getIssue" in mounted).toBe(false);
  });

  test("fails closed on partial provider configuration", () => {
    expect(() => mountHostedGitHubIssueProviderFromEnv(fakeLedger(), {
      STENSIBLY_GITHUB_APP_ID: "12345",
    })).toThrow("STENSIBLY_GITHUB_APP_PRIVATE_KEY");
  });

  test("rejects malformed and normalized hosted project identities before mounting", () => {
    const privateKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }).privateKey;

    for (const configuredProject of [
      "oauthDogfood",
      "oauth@dogfood",
      "oauth:dogfood",
      "oauth[dogfood",
      "ｏauth-dogfood",
      " oauth-dogfood",
      "oauth-dogfood ",
    ]) {
      const env = providerEnv(privateKey);
      env.STENSIBLY_GITHUB_PROVIDER_PROJECT = configuredProject;
      expect(() => mountHostedGitHubIssueProviderFromEnv(fakeLedger(), env)).toThrow(
        "Use an exact lowercase project slug",
      );
    }
  });

  test("rejects padded hosted repository and account identities before mounting", () => {
    const privateKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }).privateKey;

    for (const [key, value] of [
      [
        "STENSIBLY_GITHUB_PROVIDER_REPOSITORY",
        ` ${repositoryFullName}`,
      ],
      [
        "STENSIBLY_GITHUB_PROVIDER_REPOSITORY",
        `${repositoryFullName} `,
      ],
      [
        "STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN",
        " teamleaderleo",
      ],
      [
        "STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN",
        "teamleaderleo ",
      ],
    ] as const) {
      const env = providerEnv(privateKey);
      env[key] = value;
      expect(() => mountHostedGitHubIssueProviderFromEnv(fakeLedger(), env)).toThrow(
        `requires exact printable ASCII ${key}`,
      );
    }
  });

  test("rejects a repository outside the exact hosted binding before dispatch", async () => {
    const privateKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }).privateKey;
    let providerCalls = 0;
    const mounted = mountHostedGitHubIssueProviderFromEnv(
      fakeLedger(),
      providerEnv(privateKey),
      {
        fetch: (async () => {
          providerCalls += 1;
          return Response.json({ message: "must not dispatch" }, { status: 500 });
        }) as unknown as typeof fetch,
        now: () => fixedNow,
      },
    );

    await expect(mounted.getIssue!({
      project,
      repository: "teamleaderleo/another-repository",
      actorId: "api-token:test",
      clientId: "mcp:api-token:test",
      issueNumber: 1,
    })).rejects.toThrow("outside the accepted project attachment");
    expect(providerCalls).toBe(0);
  });
});

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

function providerEnv(privateKey: string): Record<string, string> {
  return {
    STENSIBLY_GITHUB_APP_ID: "12345",
    STENSIBLY_GITHUB_APP_PRIVATE_KEY: privateKey,
    STENSIBLY_GITHUB_INSTALLATION_ID: "98765",
    STENSIBLY_GITHUB_PROVIDER_PROJECT: project,
    STENSIBLY_GITHUB_PROVIDER_REPOSITORY: repositoryFullName,
    STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN: "teamleaderleo",
    STENSIBLY_GITHUB_API_BASE_URL: "https://api.github.test",
  };
}
