import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GitHubAppInstallationTokenMinter,
} from "../src/github-app-installation-token.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const privateKeyPem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;

describe("GitHub installation-token synchronous fetch failure", () => {
  test("normalizes a synchronous provider throw to the fixed request error", async () => {
    const hostile = "provider-secret-sync-throw";
    const provider = new GitHubAppInstallationTokenMinter({
      appId: "12345",
      installationId: "98765",
      accountLogin: "teamleaderleo",
      privateKeyPem,
      repositoryFullNames: [repositoryFullName],
      apiBaseUrl: "https://api.github.test",
      fetch: (() => {
        throw new Error(hostile);
      }) as unknown as typeof fetch,
      now: () => Date.parse("2026-08-04T18:30:00.000Z"),
      responseTimeoutMs: 60_000,
    });

    let thrown: unknown;
    try {
      await provider.getInstallationToken({
        repositoryFullName,
        permission: { name: "contents", access: "write" },
      });
    } catch (error) {
      thrown = error;
    }

    expect(String(thrown)).toContain(
      "request failed before a response was available",
    );
    expect(String(thrown)).not.toContain(hostile);
    expect(JSON.stringify(thrown)).not.toContain(hostile);
  });
});
