import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  mountHostedGitHubOperationsFromEnv,
} from "../src/hosted-github-operations.ts";
import type { HostedGitHubDelegatedReadProvider } from "../src/hosted-github-delegated-read-provider.ts";
import type { WorkLedger } from "../src/ledger.ts";
import type { OperationWorkflowStore } from "../src/operation-workflow-contracts.ts";
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

const fixedNow = Date.parse("2026-08-10T02:58:00.000Z");

describe("hosted GitHub repository-health default enablement", () => {
  test("mounts read-only repository health without enabling publication writes", () => {
    const mounted = mountHostedGitHubOperationsFromEnv(
      fakeLedger(),
      providerEnv,
      { now: () => fixedNow },
    );

    expect(typeof mounted.githubRepoHealth).toBe("function");
    expect("githubPublishChange" in mounted).toBe(false);
    expect("githubLandPr" in mounted).toBe(false);
  });

  test("keeps publication methods behind their exact opt-in", () => {
    const mounted = mountHostedGitHubOperationsFromEnv(
      fakeLedger(),
      {
        ...providerEnv,
        STENSIBLY_GITHUB_PUBLICATION_WRITES_ENABLED: "true",
      },
      { now: () => fixedNow },
    );

    expect(typeof mounted.githubRepoHealth).toBe("function");
    expect(typeof mounted.githubPublishChange).toBe("function");
    expect(typeof mounted.githubLandPr).toBe("function");
  });
});

function fakeLedger(): WorkLedger
  & ProjectAttachmentLedger
  & OperationWorkflowStore
  & Pick<HostedGitHubDelegatedReadProvider, "callGitHubDelegatedRead"> {
  return {
    async getProjectAttachment() {
      return null;
    },
    async acceptProjectAttachment() {
      throw new Error("acceptProjectAttachment is outside this test");
    },
    async reserveOperationWorkflow() {
      throw new Error("reserveOperationWorkflow is outside this test");
    },
    async transitionOperationWorkflow() {
      throw new Error("transitionOperationWorkflow is outside this test");
    },
    async getOperationWorkflow() {
      return null;
    },
    async callGitHubDelegatedRead() {
      throw new Error("callGitHubDelegatedRead is outside this test");
    },
  } as unknown as WorkLedger
    & ProjectAttachmentLedger
    & OperationWorkflowStore
    & Pick<HostedGitHubDelegatedReadProvider, "callGitHubDelegatedRead">;
}
