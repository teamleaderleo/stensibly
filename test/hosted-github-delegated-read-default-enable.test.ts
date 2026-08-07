import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  hostedGitHubDelegatedReadJobDetailTools,
  hostedGitHubDelegatedReadTools,
  hostedGitHubDelegatedReadProviderConfigured,
  mountHostedGitHubDelegatedReadProviderFromEnv,
} from "../src/hosted-github-delegated-read-provider.ts";
import type { WorkLedger } from "../src/ledger.ts";
import type { ProjectAttachmentLedger } from "../src/project-attachment-ledger.ts";

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

const fixedNow = Date.parse("2026-08-05T16:10:00.000Z");

describe("hosted GitHub delegated-read default enablement", () => {
  test("mounts delegated reads and bounded job details by default", () => {
    expect(hostedGitHubDelegatedReadProviderConfigured(providerEnv)).toBe(true);
    const mounted = mountHostedGitHubDelegatedReadProviderFromEnv(
      fakeLedger(),
      providerEnv,
      { now: () => fixedNow },
    );

    expect(mounted.delegatedGitHubReadTools)
      .toBe(hostedGitHubDelegatedReadJobDetailTools);
    expect(typeof mounted.callGitHubDelegatedRead).toBe("function");
  });

  test("keeps exact false as the top-level delegated-read kill switch", () => {
    const ledger = fakeLedger();
    const mounted = mountHostedGitHubDelegatedReadProviderFromEnv(
      ledger,
      {
        ...providerEnv,
        STENSIBLY_GITHUB_DELEGATED_READS_ENABLED: "false",
      },
      { now: () => fixedNow },
    );

    expect(mounted).toBe(ledger);
    expect("delegatedGitHubReadTools" in mounted).toBe(false);
    expect("callGitHubDelegatedRead" in mounted).toBe(false);
  });

  test("allows job-detail reads to be disabled independently", () => {
    const mounted = mountHostedGitHubDelegatedReadProviderFromEnv(
      fakeLedger(),
      {
        ...providerEnv,
        STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED: "false",
      },
      { now: () => fixedNow },
    );

    expect(mounted.delegatedGitHubReadTools).toBe(hostedGitHubDelegatedReadTools);
    expect(typeof mounted.callGitHubDelegatedRead).toBe("function");
  });

  test("keeps an empty environment unconfigured", () => {
    const ledger = fakeLedger();
    expect(hostedGitHubDelegatedReadProviderConfigured({})).toBe(false);
    expect(mountHostedGitHubDelegatedReadProviderFromEnv(ledger, {}))
      .toBe(ledger);
  });

  test("fails closed for partial configuration and malformed kill switches", () => {
    expect(() => hostedGitHubDelegatedReadProviderConfigured({
      STENSIBLY_GITHUB_APP_ID: "12345",
    })).toThrow(
      "Hosted GitHub delegated reads require STENSIBLY_GITHUB_APP_PRIVATE_KEY",
    );

    expect(() => hostedGitHubDelegatedReadProviderConfigured({
      ...providerEnv,
      STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED: "TRUE",
    })).toThrow("must be exact true or false");
  });
});

function fakeLedger(): WorkLedger & ProjectAttachmentLedger {
  return {
    async getProjectAttachment() {
      return null;
    },
    async acceptProjectAttachment() {
      throw new Error("acceptProjectAttachment is outside this test");
    },
  } as unknown as WorkLedger & ProjectAttachmentLedger;
}
