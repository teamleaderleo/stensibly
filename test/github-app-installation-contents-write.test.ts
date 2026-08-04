import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GitHubAppInstallationTokenMinter,
  type GitHubInstallationTokenProvider,
  type GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";
import {
  repositoryWriteInstallationTokenProvider,
} from "../src/github-repository-write-installation-token.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const privateKeyPem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;

function minter(fetcher: typeof fetch) {
  return new GitHubAppInstallationTokenMinter({
    appId: "12345",
    installationId: "98765",
    accountLogin: "teamleaderleo",
    privateKeyPem,
    repositoryFullNames: [repositoryFullName],
    apiBaseUrl: "https://api.github.test",
    fetch: fetcher,
    now: () => Date.parse("2026-08-03T10:00:00.000Z"),
  });
}

function tokenResponse(access: "read" | "write", token: string): Response {
  return Response.json({
    token,
    expires_at: "2026-08-03T11:00:00.000Z",
    permissions: {
      contents: access,
      metadata: "read",
    },
    repository_selection: "selected",
    repositories: [{ full_name: repositoryFullName }],
  }, { status: 201 });
}

describe("GitHub App contents write installation tokens", () => {
  test("mints and caches exact canonical read and write scopes independently", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const provider = minter((async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      const permission = body.permissions as Record<string, unknown>;
      const access = permission.contents as "read" | "write";
      return tokenResponse(access, `contents-${access}-token`);
    }) as unknown as typeof fetch);
    const repositoryTokens = repositoryWriteInstallationTokenProvider(provider);

    const read = await repositoryTokens.getRepositoryContentsToken({
      repositoryFullName,
      access: "read",
    });
    const readReplay = await repositoryTokens.getRepositoryContentsToken({
      repositoryFullName,
      access: "read",
    });
    const write = await repositoryTokens.getRepositoryContentsToken({
      repositoryFullName,
      access: "write",
    });
    const writeReplay = await repositoryTokens.getRepositoryContentsToken({
      repositoryFullName,
      access: "write",
    });

    expect(read).toEqual(readReplay);
    expect(write).toEqual(writeReplay);
    expect(read.token).toBe("contents-read-token");
    expect(write.token).toBe("contents-write-token");
    expect(requests).toEqual([
      {
        repositories: ["stensibly"],
        permissions: { contents: "read" },
      },
      {
        repositories: ["stensibly"],
        permissions: { contents: "write" },
      },
    ]);
  });

  test("rejects non-canonical repository identities before provider access", () => {
    let providerCalls = 0;
    const provider: GitHubInstallationTokenProvider = {
      async getInstallationToken() {
        providerCalls += 1;
        throw new Error("must not mint");
      },
    };
    const repositoryTokens = repositoryWriteInstallationTokenProvider(provider);
    const cases = [
      "TeamLeaderLeo/Stensibly",
      "git@github.com:teamleaderleo/stensibly.git",
      " teamleaderleo/stensibly ",
      `teamleaderleo/repositoryxgithub_pat_${"a".repeat(20)}`,
    ];

    for (const repository of cases) {
      expect(() => repositoryTokens.getRepositoryContentsToken({
        repositoryFullName: repository,
        access: "write",
      })).toThrow("GitHub repository identity is invalid");
    }
    expect(providerCalls).toBe(0);
  });

  test("rejects extra permission authority and does not cache it", async () => {
    let mintCalls = 0;
    const provider = minter((async () => {
      mintCalls += 1;
      return Response.json({
        token: "over-broad-token",
        expires_at: "2026-08-03T11:00:00.000Z",
        permissions: {
          contents: "write",
          issues: "write",
        },
        repository_selection: "selected",
        repositories: [{ full_name: repositoryFullName }],
      }, { status: 201 });
    }) as unknown as typeof fetch);
    const repositoryTokens = repositoryWriteInstallationTokenProvider(provider);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(repositoryTokens.getRepositoryContentsToken({
        repositoryFullName,
        access: "write",
      })).rejects.toThrow("exact contents:write permission scope");
    }
    expect(mintCalls).toBe(2);
  });

  test("keeps every unrelated installation permission read-only", async () => {
    let mintCalls = 0;
    const provider = minter((async () => {
      mintCalls += 1;
      return tokenResponse("read", "must-not-mint");
    }) as unknown as typeof fetch);
    const invalid = {
      repositoryFullName,
      permission: { name: "actions", access: "write" },
    } as unknown as GitHubInstallationTokenRequest;

    await expect(provider.getInstallationToken(invalid)).rejects.toThrow(
      "GitHub installation permission actions supports read access only",
    );
    expect(mintCalls).toBe(0);
  });
});
