import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  hostedGitHubIssueProviderConfigured,
  mountHostedGitHubIssueProviderFromEnv,
} from "../src/hosted-github-issue-provider.ts";
import type { WorkLedger } from "../src/ledger.ts";

const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;
const fixedNow = Date.parse("2026-08-05T06:30:00.000Z");
const writeFlag = "STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED";
const providerEnv = Object.freeze({
  STENSIBLY_GITHUB_APP_ID: "12345",
  STENSIBLY_GITHUB_APP_PRIVATE_KEY: privateKey,
  STENSIBLY_GITHUB_INSTALLATION_ID: "98765",
  STENSIBLY_GITHUB_PROVIDER_PROJECT: "oauth-dogfood",
  STENSIBLY_GITHUB_PROVIDER_REPOSITORY: "teamleaderleo/stensibly",
  STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN: "teamleaderleo",
  STENSIBLY_GITHUB_API_BASE_URL: "https://api.github.test",
});

describe("hosted GitHub issue-write explicit opt-in", () => {
  test("keeps complete read configuration read-only when the write flag is absent", () => {
    const mounted = mountHostedGitHubIssueProviderFromEnv(
      fakeLedger(true),
      providerEnv,
      { now: () => fixedNow },
    );

    expect(typeof mounted.getIssue).toBe("function");
    expect("createIssue" in mounted).toBe(false);
    expect("updateIssue" in mounted).toBe(false);
    expect("addIssueComment" in mounted).toBe(false);
  });

  test("mounts create, update, and comment only with exact true and durable receipts", () => {
    const mounted = mountHostedGitHubIssueProviderFromEnv(
      fakeLedger(true),
      {
        ...providerEnv,
        [writeFlag]: "true",
      },
      { now: () => fixedNow },
    );

    expect(typeof mounted.getIssue).toBe("function");
    expect(typeof mounted.createIssue).toBe("function");
    expect(typeof mounted.updateIssue).toBe("function");
    expect(typeof mounted.addIssueComment).toBe("function");
  });

  test("keeps exact false as a configured-provider write kill switch", () => {
    const mounted = mountHostedGitHubIssueProviderFromEnv(
      fakeLedger(true),
      {
        ...providerEnv,
        [writeFlag]: "false",
      },
      { now: () => fixedNow },
    );

    expect(typeof mounted.getIssue).toBe("function");
    expect("createIssue" in mounted).toBe(false);
  });

  test("requires durable receipts for explicit write activation", () => {
    expect(() => mountHostedGitHubIssueProviderFromEnv(
      fakeLedger(false),
      {
        ...providerEnv,
        [writeFlag]: "true",
      },
      { now: () => fixedNow },
    )).toThrow("durable provider receipt store");
  });

  test("keeps false and empty alone unconfigured and fails closed on invalid activation", () => {
    const ledger = Object.create(null) as WorkLedger;
    for (const value of ["false", ""] as const) {
      const env = { [writeFlag]: value };
      expect(hostedGitHubIssueProviderConfigured(env)).toBe(false);
      expect(mountHostedGitHubIssueProviderFromEnv(ledger, env)).toBe(ledger);
    }

    expect(() => hostedGitHubIssueProviderConfigured({
      [writeFlag]: "enabled",
    })).toThrow(`${writeFlag} must be exact true or false`);
    expect(() => hostedGitHubIssueProviderConfigured({
      [writeFlag]: "true",
    })).toThrow("Hosted GitHub issue provider requires STENSIBLY_GITHUB_APP_ID");
  });
});

function fakeLedger(withReceipts: boolean): WorkLedger {
  const ledger: Record<string, unknown> = {
    async getProjectAttachment() {
      return null;
    },
    async acceptProjectAttachment() {
      throw new Error("acceptProjectAttachment is outside this test");
    },
  };
  if (withReceipts) {
    Object.assign(ledger, {
      async reserveGitHubProviderReceipt() {
        throw new Error("reserveGitHubProviderReceipt is outside this test");
      },
      async updateGitHubProviderReceipt() {
        throw new Error("updateGitHubProviderReceipt is outside this test");
      },
      async getGitHubProviderReceipt() {
        return null;
      },
    });
  }
  return ledger as unknown as WorkLedger;
}
