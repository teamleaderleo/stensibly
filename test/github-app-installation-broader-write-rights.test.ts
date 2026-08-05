import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GitHubAppInstallationTokenMinter,
  type GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const fixedNow = Date.parse("2026-08-05T00:00:00.000Z");
const privateKeyPem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;
const broaderWriteProfiles = [
  "pull_requests",
  "statuses",
  "actions",
] as const;

describe("broader GitHub App installation write rights", () => {
  test("mints exact repository-scoped write tokens with independent cache identity", async () => {
    const requested: Array<Record<string, unknown>> = [];
    const minter = createMinter(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        permissions: Record<string, "write">;
      };
      requested.push(body.permissions);
      const [name] = Object.keys(body.permissions);
      return tokenResponse(
        { [name!]: "write", metadata: "read" },
        `${name}-write-token`,
      );
    });

    for (const name of broaderWriteProfiles) {
      const token = await minter.getInstallationToken({
        repositoryFullName,
        permission: { name, access: "write" },
      });
      expect(token.token).toBe(`${name}-write-token`);
      expect(await minter.getInstallationToken({
        repositoryFullName,
        permission: { name, access: "write" },
      })).toEqual(token);
    }

    expect(requested).toEqual(
      broaderWriteProfiles.map((name) => ({ [name]: "write" })),
    );
  });

  test("keeps metadata read-only and rejects it before provider activity", async () => {
    let providerCalls = 0;
    const minter = createMinter(async () => {
      providerCalls += 1;
      return tokenResponse({ metadata: "write" }, "unreachable");
    });

    await expect(minter.getInstallationToken({
      repositoryFullName,
      permission: { name: "metadata", access: "write" },
    } as unknown as GitHubInstallationTokenRequest)).rejects.toThrow(
      "metadata supports read access only",
    );
    expect(providerCalls).toBe(0);
  });

  test("rejects a widened broader write grant without cache admission", async () => {
    let providerCalls = 0;
    const minter = createMinter(async () => {
      providerCalls += 1;
      return tokenResponse({
        pull_requests: "write",
        contents: "write",
        metadata: "read",
      }, `widened-${providerCalls}`);
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(minter.getInstallationToken({
        repositoryFullName,
        permission: { name: "pull_requests", access: "write" },
      })).rejects.toThrow("did not grant exact pull_requests:write");
    }
    expect(providerCalls).toBe(2);
  });
});

function createMinter(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): GitHubAppInstallationTokenMinter {
  return new GitHubAppInstallationTokenMinter({
    appId: "12345",
    installationId: "98765",
    accountLogin: "teamleaderleo",
    privateKeyPem,
    repositoryFullNames: [repositoryFullName],
    apiBaseUrl: "https://api.github.test",
    fetch: implementation as unknown as typeof fetch,
    now: () => fixedNow,
  });
}

function tokenResponse(
  permissions: Record<string, unknown>,
  token: string,
): Response {
  return Response.json({
    token,
    expires_at: "2026-08-05T01:00:00.000Z",
    permissions,
    repository_selection: "selected",
    repositories: [{ full_name: repositoryFullName }],
  }, { status: 201 });
}
