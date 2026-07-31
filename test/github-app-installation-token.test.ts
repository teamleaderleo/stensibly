import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { GitHubAppInstallationTokenMinter } from "../src/github-app-installation-token.ts";
import { GitHubRestIssueProviderAdapter } from "../src/github-rest-issue-adapter.ts";

const privateKeyPem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;
const tokenProvider = {
  async getInstallationToken() {
    return {
      token: "test-token",
      expiresAt: "2026-07-31T01:00:00.000Z",
    };
  },
};
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function minterOptions(apiBaseUrl: string) {
  return {
    appId: "12345",
    installationId: "98765",
    accountLogin: "teamleaderleo",
    privateKeyPem,
    repositoryFullNames: ["teamleaderleo/stensibly"],
    apiBaseUrl,
  };
}

function constructors(apiBaseUrl: string): Array<() => unknown> {
  return [
    () => new GitHubAppInstallationTokenMinter(minterOptions(apiBaseUrl)),
    () => new GitHubRestIssueProviderAdapter({ tokenProvider, apiBaseUrl }),
  ];
}

async function capturedError(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected operation to reject");
}

describe("GitHub provider API base", () => {
  test("accepts HTTPS and the explicit localhost HTTP test exception", () => {
    for (const apiBaseUrl of [
      "https://api.github.com",
      "http://localhost:8787",
    ]) {
      for (const construct of constructors(apiBaseUrl)) {
        expect(construct).not.toThrow();
      }
    }
  });

  test("rejects every other scheme even when the hostname is localhost", () => {
    for (const apiBaseUrl of [
      "ftp://localhost/github",
      "file://localhost/tmp/github",
      "http://127.0.0.1:8787",
    ]) {
      for (const construct of constructors(apiBaseUrl)) {
        expect(construct).toThrow("GitHub API base URL must use HTTPS");
      }
    }
  });
});

describe("GitHub installation token permissions", () => {
  test("rejects invalid trusted clocks before cache or provider activity", async () => {
    for (const invalidNow of [Number.NaN, Number.POSITIVE_INFINITY]) {
      let mintCalls = 0;
      const minter = new GitHubAppInstallationTokenMinter({
        ...minterOptions("https://api.github.test"),
        now: () => invalidNow,
        fetch: (async () => {
          mintCalls += 1;
          return Response.json({
            token: "unreachable-token",
            expires_at: "2026-07-31T01:00:00.000Z",
            permissions: { issues: "read" },
            repository_selection: "selected",
            repositories: [{ full_name: "teamleaderleo/stensibly" }],
          }, { status: 201 });
        }) as unknown as typeof fetch,
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(minter.getInstallationToken({
          repositoryFullName: "teamleaderleo/stensibly",
          issues: "read",
        })).rejects.toThrow("requires a valid current time");
      }
      expect(mintCalls).toBe(0);
    }
  });

  test("rejects and never caches a write-capable response for a read mint", async () => {
    let mintCalls = 0;
    const minter = new GitHubAppInstallationTokenMinter({
      ...minterOptions("https://api.github.test"),
      now: () => Date.parse("2026-07-31T00:00:00.000Z"),
      fetch: (async () => {
        mintCalls += 1;
        return Response.json({
          token: "write-capable-token",
          expires_at: "2026-07-31T01:00:00.000Z",
          permissions: { issues: "write" },
          repository_selection: "selected",
          repositories: [{ full_name: "teamleaderleo/stensibly" }],
        }, { status: 201 });
      }) as unknown as typeof fetch,
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(minter.getInstallationToken({
        repositoryFullName: "teamleaderleo/stensibly",
        issues: "read",
      })).rejects.toThrow("exact issues:read");
    }
    expect(mintCalls).toBe(2);
  });

  test("rejects and never caches additional write permissions", async () => {
    let mintCalls = 0;
    const minter = new GitHubAppInstallationTokenMinter({
      ...minterOptions("https://api.github.test"),
      now: () => Date.parse("2026-07-31T00:00:00.000Z"),
      fetch: (async () => {
        mintCalls += 1;
        return Response.json({
          token: "contents-write-token",
          expires_at: "2026-07-31T01:00:00.000Z",
          permissions: { issues: "read", contents: "write" },
          repository_selection: "selected",
          repositories: [{ full_name: "teamleaderleo/stensibly" }],
        }, { status: 201 });
      }) as unknown as typeof fetch,
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(minter.getInstallationToken({
        repositoryFullName: "teamleaderleo/stensibly",
        issues: "read",
      })).rejects.toThrow("exact issues:read permission scope");
    }
    expect(mintCalls).toBe(2);
  });

  test("rejects every non-exact repository grant without cache admission", async () => {
    const invalidScopes: Array<Record<string, unknown>> = [
      {},
      {
        repository_selection: "all",
        repositories: [{ full_name: "teamleaderleo/stensibly" }],
      },
      {
        repository_selection: "selected",
        repositories: [],
      },
      {
        repository_selection: "selected",
        repositories: [{ full_name: "teamleaderleo/another-repository" }],
      },
      {
        repository_selection: "selected",
        repositories: [
          { full_name: "teamleaderleo/stensibly" },
          { full_name: "teamleaderleo/another-repository" },
        ],
      },
    ];

    for (const scope of invalidScopes) {
      let mintCalls = 0;
      const minter = new GitHubAppInstallationTokenMinter({
        ...minterOptions("https://api.github.test"),
        now: () => Date.parse("2026-07-31T00:00:00.000Z"),
        fetch: (async () => {
          mintCalls += 1;
          return Response.json({
            token: "non-exact-repository-token",
            expires_at: "2026-07-31T01:00:00.000Z",
            permissions: { issues: "read" },
            ...scope,
          }, { status: 201 });
        }) as unknown as typeof fetch,
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(minter.getInstallationToken({
          repositoryFullName: "teamleaderleo/stensibly",
          issues: "read",
        })).rejects.toThrow("exact repository teamleaderleo/stensibly");
      }
      expect(mintCalls).toBe(2);
    }
  });

  test("uses one lowercase authority and cache identity for mixed-case aliases", async () => {
    let mintCalls = 0;
    const minter = new GitHubAppInstallationTokenMinter({
      ...minterOptions("https://api.github.test"),
      repositoryFullNames: ["TeamLeaderLeo/Stensibly"],
      now: () => Date.parse("2026-07-31T00:00:00.000Z"),
      fetch: (async (_input: FetchInput, init: FetchInit) => {
        mintCalls += 1;
        expect(JSON.parse(String(init?.body))).toEqual({
          repositories: ["stensibly"],
          permissions: { issues: "read" },
        });
        return Response.json({
          token: "read-token",
          expires_at: "2026-07-31T01:00:00.000Z",
          permissions: { issues: "read" },
          repository_selection: "selected",
          repositories: [{ full_name: "TeamLeaderLeo/Stensibly" }],
        }, { status: 201 });
      }) as unknown as typeof fetch,
    });

    const lowercase = await minter.getInstallationToken({
      repositoryFullName: "teamleaderleo/stensibly",
      issues: "read",
    });
    const mixedCase = await minter.getInstallationToken({
      repositoryFullName: "TeamLeaderLeo/Stensibly",
      issues: "read",
    });

    expect(lowercase).toEqual(mixedCase);
    expect(mintCalls).toBe(1);
  });
});

describe("GitHub provider credential redaction", () => {
  test("omits the outbound App JWT from token-mint errors", async () => {
    let authorization = "";
    const minter = new GitHubAppInstallationTokenMinter({
      ...minterOptions("https://api.github.test"),
      now: () => Date.parse("2026-07-31T00:00:00.000Z"),
      fetch: (async (_input: FetchInput, init: FetchInit) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json({ message: authorization }, { status: 401 });
      }) as unknown as typeof fetch,
    });

    const error = await capturedError(() => minter.getInstallationToken({
      repositoryFullName: "teamleaderleo/stensibly",
      issues: "read",
    }));

    expect(authorization).toStartWith("Bearer ");
    expect(error.message).toContain("HTTP 401");
    expect(error.message).not.toContain(authorization);
    expect(error.message).not.toContain(authorization.slice("Bearer ".length));
  });

  test("omits the outbound installation token from REST errors", async () => {
    const installationToken = "installation-token-secret";
    let authorization = "";
    const adapter = new GitHubRestIssueProviderAdapter({
      tokenProvider: {
        async getInstallationToken() {
          return {
            token: installationToken,
            expiresAt: "2026-07-31T01:00:00.000Z",
          };
        },
      },
      apiBaseUrl: "https://api.github.test",
      fetch: (async (_input: FetchInput, init: FetchInit) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json({ message: authorization }, { status: 403 });
      }) as unknown as typeof fetch,
    });

    const error = await capturedError(() => adapter.getIssue({
      repositoryFullName: "TeamLeaderLeo/Stensibly",
      issueNumber: 1,
    }));

    expect(authorization).toBe(`Bearer ${installationToken}`);
    expect(error.message).toContain("HTTP 403");
    expect(error.message).not.toContain(authorization);
    expect(error.message).not.toContain(installationToken);
  });
});
