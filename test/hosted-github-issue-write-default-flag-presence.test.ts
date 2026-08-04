import { describe, expect, test } from "bun:test";
import {
  hostedGitHubIssueProviderConfigured,
  mountHostedGitHubIssueProviderFromEnv,
} from "../src/hosted-github-issue-provider.ts";
import type { WorkLedger } from "../src/ledger.ts";

const writeFlag = "STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED";

describe("hosted GitHub issue-write flag presence", () => {
  test("treats exact false alone as an unconfigured kill switch", () => {
    const env = { [writeFlag]: "false" };
    const ledger = Object.create(null) as WorkLedger;

    expect(hostedGitHubIssueProviderConfigured(env)).toBe(false);
    expect(mountHostedGitHubIssueProviderFromEnv(ledger, env)).toBe(ledger);
  });

  test("keeps an empty flag unconfigured when no provider settings exist", () => {
    const env = { [writeFlag]: "" };
    const ledger = Object.create(null) as WorkLedger;

    expect(hostedGitHubIssueProviderConfigured(env)).toBe(false);
    expect(mountHostedGitHubIssueProviderFromEnv(ledger, env)).toBe(ledger);
  });

  test("still fails closed for malformed or explicit true without provider settings", () => {
    expect(() => hostedGitHubIssueProviderConfigured({
      [writeFlag]: "enabled",
    })).toThrow(`${writeFlag} must be exact true or false`);

    expect(() => hostedGitHubIssueProviderConfigured({
      [writeFlag]: "true",
    })).toThrow("STENSIBLY_GITHUB_APP_ID is required");
  });
});
