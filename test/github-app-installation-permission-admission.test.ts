import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GitHubAppInstallationTokenMinter,
  type GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const fixedNow = Date.parse("2026-07-31T00:00:00.000Z");
const privateKeyPem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;

describe("GitHub installation token request admission", () => {
  test("rejects padded and non-ASCII repository aliases before provider activity", async () => {
    let providerCalls = 0;
    const minter = createMinter(async () => {
      providerCalls += 1;
      return tokenResponse();
    });

    for (const repository of [
      ` ${repositoryFullName}`,
      `${repositoryFullName} `,
      "teamleaderleo／stensibly",
      "ｔeamleaderleo/stensibly",
    ]) {
      await expect(minter.getInstallationToken({
        repositoryFullName: repository,
        permission: { name: "contents", access: "read" },
      })).rejects.toThrow("exact printable ASCII");
    }
    expect(providerCalls).toBe(0);
  });

  test("accepts exact null-prototype request and permission records", async () => {
    let providerCalls = 0;
    const minter = createMinter(async () => {
      providerCalls += 1;
      return tokenResponse();
    });
    const permission = Object.assign(Object.create(null), {
      name: "contents",
      access: "read",
    });
    const request = Object.assign(Object.create(null), {
      repositoryFullName,
      permission,
    }) as GitHubInstallationTokenRequest;

    const result = await minter.getInstallationToken(request);

    expect(result.token).toBe("contents-token");
    expect(providerCalls).toBe(1);
  });

  test("rejects request accessors, symbols, hidden fields, and custom prototypes without getter execution", async () => {
    let providerCalls = 0;
    const minter = createMinter(async () => {
      providerCalls += 1;
      return tokenResponse();
    });

    let getterCalls = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "repositoryFullName", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return repositoryFullName;
      },
    });
    Object.defineProperty(accessor, "permission", {
      enumerable: true,
      value: { name: "contents", access: "read" },
    });
    await expect(minter.getInstallationToken(
      accessor as unknown as GitHubInstallationTokenRequest,
    )).rejects.toThrow("field repositoryFullName must be an enumerable data property");

    const symbolic = {
      repositoryFullName,
      permission: { name: "contents", access: "read" },
      [Symbol("authority")]: true,
    };
    await expect(minter.getInstallationToken(
      symbolic as unknown as GitHubInstallationTokenRequest,
    )).rejects.toThrow("contains a symbol field");

    const hidden = {
      repositoryFullName,
      permission: { name: "contents", access: "read" },
    };
    Object.defineProperty(hidden, "hidden", {
      enumerable: false,
      value: true,
    });
    await expect(minter.getInstallationToken(
      hidden as unknown as GitHubInstallationTokenRequest,
    )).rejects.toThrow("has an unknown field");

    const custom = Object.assign(
      Object.create({ inherited: true }),
      {
        repositoryFullName,
        permission: { name: "contents", access: "read" },
      },
    );
    await expect(minter.getInstallationToken(
      custom as unknown as GitHubInstallationTokenRequest,
    )).rejects.toThrow("plain or null prototype");

    expect(getterCalls).toBe(0);
    expect(providerCalls).toBe(0);
  });

  test("keeps top-level and nested unknown-field diagnostics fixed and credential-safe", async () => {
    let providerCalls = 0;
    const minter = createMinter(async () => {
      providerCalls += 1;
      return tokenResponse();
    });
    const unknownFields = [
      `github_pat_${"g".repeat(40)}`,
      `stn.tok_${"s".repeat(40)}`,
      `sk-proj-${"o".repeat(40)}`,
      `xoxb-${"x".repeat(40)}`,
      `authorization\n${"secret".repeat(20)}`,
    ];

    for (const field of unknownFields) {
      const topLevel = {
        repositoryFullName,
        permission: { name: "contents", access: "read" },
        [field]: true,
      } as unknown as GitHubInstallationTokenRequest;
      const nested = {
        repositoryFullName,
        permission: { name: "contents", access: "read", [field]: true },
      } as unknown as GitHubInstallationTokenRequest;

      for (const [request, expected] of [
        [topLevel, "GitHub installation token request has an unknown field"],
        [nested, "GitHub installation permission profile has an unknown field"],
      ] as const) {
        try {
          await minter.getInstallationToken(request);
          throw new Error("expected admission failure");
        } catch (error) {
          expect(error).toBeInstanceOf(RangeError);
          expect((error as Error).message).toBe(expected);
          expect(String(error)).not.toContain(field);
        }
      }
    }

    expect(providerCalls).toBe(0);
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
    fetch: implementation as typeof fetch,
    now: () => fixedNow,
  });
}

function tokenResponse(): Response {
  return Response.json({
    token: "contents-token",
    expires_at: "2026-07-31T01:00:00.000Z",
    permissions: { contents: "read", metadata: "read" },
    repository_selection: "selected",
    repositories: [{ full_name: repositoryFullName }],
  }, { status: 201 });
}
