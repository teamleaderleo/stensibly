import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GitHubAppInstallationTokenMinter,
  type GitHubInstallationPermissionInput,
  type GitHubInstallationTokenRequest,
} from "../src/github-app-installation-token.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const fixedNow = Date.parse("2026-07-31T00:00:00.000Z");
const privateKeyPem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;

const readProfiles = [
  "metadata",
  "contents",
  "pull_requests",
  "statuses",
  "actions",
] as const;

describe("GitHub App installation permission profiles", () => {
  test("keeps legacy issue reads compatible with the exact issue profile and cache", async () => {
    const requests: unknown[] = [];
    const minter = createMinter(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as unknown);
      return tokenResponse({ issues: "read", metadata: "read" }, "legacy-token");
    });

    const legacy = await minter.getInstallationToken({
      repositoryFullName,
      issues: "read",
    });
    const exact = await minter.getInstallationToken({
      repositoryFullName,
      permission: { name: "issues", access: "read" },
    });

    expect(legacy).toEqual(exact);
    expect(requests).toEqual([{
      repositories: ["stensibly"],
      permissions: { issues: "read" },
    }]);
  });

  test("mints one repository permission per read profile with independent cache identity", async () => {
    const requested: Array<Record<string, unknown>> = [];
    const minter = createMinter(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        permissions: Record<string, "read">;
      };
      requested.push(body.permissions);
      const [name] = Object.keys(body.permissions);
      return tokenResponse(
        name === "metadata"
          ? { metadata: "read" }
          : { [name!]: "read", metadata: "read" },
        `${name}-token`,
      );
    });

    for (const name of readProfiles) {
      const token = await minter.getInstallationToken({
        repositoryFullName,
        permission: { name, access: "read" },
      });
      expect(token.token).toBe(`${name}-token`);
      const cached = await minter.getInstallationToken({
        repositoryFullName,
        permission: { name, access: "read" },
      });
      expect(cached).toEqual(token);
    }

    expect(requested).toEqual(readProfiles.map((name) => ({ [name]: "read" })));
  });

  test("retains exact issue-write behavior", async () => {
    let body: unknown;
    const minter = createMinter(async (_input, init) => {
      body = JSON.parse(String(init?.body)) as unknown;
      return tokenResponse({ issues: "write", metadata: "read" }, "write-token");
    });

    const result = await minter.getInstallationToken({
      repositoryFullName,
      permission: { name: "issues", access: "write" },
    });

    expect(result.token).toBe("write-token");
    expect(body).toEqual({
      repositories: ["stensibly"],
      permissions: { issues: "write" },
    });
  });

  test("rejects unsupported, write-capable, decorated, and accessor profiles before provider activity", async () => {
    let providerCalls = 0;
    const minter = createMinter(async () => {
      providerCalls += 1;
      return tokenResponse({ contents: "read" }, "unreachable");
    });

    await expect(minter.getInstallationToken({
      repositoryFullName,
      permission: { name: "metadata", access: "write" },
    } as unknown as GitHubInstallationTokenRequest)).rejects.toThrow(
      "metadata supports read access only",
    );

    await expect(minter.getInstallationToken({
      repositoryFullName,
      permission: { name: "administration", access: "read" },
    } as unknown as GitHubInstallationTokenRequest)).rejects.toThrow(
      "permission name is unsupported",
    );

    const decorated = { name: "contents", access: "read", widened: true };
    await expect(minter.getInstallationToken({
      repositoryFullName,
      permission: decorated,
    } as unknown as GitHubInstallationTokenRequest)).rejects.toThrow(
      "permission profile has an unknown field",
    );

    let getterCalls = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "name", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "contents";
      },
    });
    Object.defineProperty(accessor, "access", {
      enumerable: true,
      value: "read",
    });
    await expect(minter.getInstallationToken({
      repositoryFullName,
      permission: accessor,
    } as unknown as GitHubInstallationTokenRequest)).rejects.toThrow(
      "field name must be an enumerable data property",
    );

    expect(getterCalls).toBe(0);
    expect(providerCalls).toBe(0);
  });

  test("requires exactly one legacy or exact permission profile", async () => {
    let providerCalls = 0;
    const minter = createMinter(async () => {
      providerCalls += 1;
      return tokenResponse({ issues: "read" }, "unreachable");
    });

    await expect(minter.getInstallationToken({
      repositoryFullName,
    } as unknown as GitHubInstallationTokenRequest)).rejects.toThrow(
      "requires exactly one permission profile",
    );
    await expect(minter.getInstallationToken({
      repositoryFullName,
      issues: "read",
      permission: { name: "issues", access: "read" },
    } as unknown as GitHubInstallationTokenRequest)).rejects.toThrow(
      "requires exactly one permission profile",
    );
    await expect(minter.getInstallationToken({
      repositoryFullName,
      permission: { name: "issues", access: "read" },
      destructive: true,
    } as unknown as GitHubInstallationTokenRequest)).rejects.toThrow(
      "request has an unknown field",
    );
    expect(providerCalls).toBe(0);
  });

  test("rejects widened provider grants repeatedly without cache admission", async () => {
    for (const [permission, returned] of [
      [
        { name: "contents", access: "read" },
        { contents: "read", issues: "read", metadata: "read" },
      ],
      [
        { name: "actions", access: "read" },
        { actions: "read", contents: "write", metadata: "read" },
      ],
      [
        { name: "metadata", access: "read" },
        { metadata: "read", issues: "read" },
      ],
    ] as const) {
      let providerCalls = 0;
      const minter = createMinter(async () => {
        providerCalls += 1;
        return tokenResponse(returned, `widened-${providerCalls}`);
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(minter.getInstallationToken({
          repositoryFullName,
          permission: permission as GitHubInstallationPermissionInput,
        })).rejects.toThrow("did not grant exact");
      }
      expect(providerCalls).toBe(2);
    }
  });

  test("rejects malformed permission response descriptors without cache admission", async () => {
    let providerCalls = 0;
    const minter = createMinter(async () => {
      providerCalls += 1;
      const permissions = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(permissions, "contents", {
        enumerable: false,
        value: "read",
      });
      return tokenResponse(permissions, `hidden-${providerCalls}`);
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(minter.getInstallationToken({
        repositoryFullName,
        permission: { name: "contents", access: "read" },
      })).rejects.toThrow("did not grant exact contents:read");
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
    fetch: implementation as typeof fetch,
    now: () => fixedNow,
  });
}

function tokenResponse(
  permissions: Record<string, unknown>,
  token: string,
): Response {
  return Response.json({
    token,
    expires_at: "2026-07-31T01:00:00.000Z",
    permissions,
    repository_selection: "selected",
    repositories: [{ full_name: repositoryFullName }],
  }, { status: 201 });
}
