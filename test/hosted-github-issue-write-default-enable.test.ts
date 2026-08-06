import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  mountHostedGitHubIssueProviderFromEnv,
} from "../src/hosted-github-issue-provider.ts";
import type { WorkLedger } from "../src/ledger.ts";

const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;

const providerEnv = Object.freeze({
  STENSIBLY_GITHUB_APP_ID: "12345",
  STENSIBLY_GITHUB_APP_PRIVATE_KEY: privateKey,
  STENSIBLY_GITHUB_INSTALLATION_ID: "98765",
  STENSIBLY_GITHUB_PROVIDER_PROJECT: "oauth-dogfood",
  STENSIBLY_GITHUB_PROVIDER_REPOSITORY: "teamleaderleo/stensibly",
  STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN: "teamleaderleo",
  STENSIBLY_GITHUB_API_BASE_URL: "https://api.github.test",
});

const fixedNow = Date.parse("2026-08-05T00:00:00.000Z");

describe("hosted GitHub issue write enablement", () => {
  test("mounts issue writes by default when durable receipts are available", () => {
    const mounted = mountHostedGitHubIssueProviderFromEnv(
      fakeLedger(true),
      providerEnv,
      { now: () => fixedNow },
    );

    expect(typeof mounted.getIssue).toBe("function");
    expect(typeof mounted.createIssue).toBe("function");
    expect(typeof mounted.updateIssue).toBe("function");
    expect(typeof mounted.addIssueComment).toBe("function");
  });

  test("keeps exact false as the hosted issue-write kill switch", () => {
    const mounted = mountHostedGitHubIssueProviderFromEnv(
      fakeLedger(true),
      {
        ...providerEnv,
        STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED: "false",
      },
      { now: () => fixedNow },
    );

    expect(typeof mounted.getIssue).toBe("function");
    expect("createIssue" in mounted).toBe(false);
    expect("updateIssue" in mounted).toBe(false);
    expect("addIssueComment" in mounted).toBe(false);
  });

  test("preserves read-only mounting when the defaulted backend lacks durable receipts", () => {
    const mounted = mountHostedGitHubIssueProviderFromEnv(
      fakeLedger(false),
      providerEnv,
      { now: () => fixedNow },
    );

    expect(typeof mounted.getIssue).toBe("function");
    expect("createIssue" in mounted).toBe(false);
  });

  test("treats exact true as a required write contract", () => {
    expect(() => mountHostedGitHubIssueProviderFromEnv(
      fakeLedger(false),
      {
        ...providerEnv,
        STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED: "true",
      },
      { now: () => fixedNow },
    )).toThrow("durable provider receipt store");
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
