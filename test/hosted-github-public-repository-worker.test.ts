import { describe, expect, test } from "bun:test";
import {
  createHostedGitHubPublicRepositoryObserverFromEnv,
  hostedGitHubPublicRepositoryFallbackEnabled,
} from "../src/hosted-github-public-repository-worker.ts";

const complete = {
  CONVEX_URL: "https://example.convex.cloud",
  STENSIBLY_SERVICE_SECRET: "service-secret",
  STENSIBLY_WORKSPACE: "default",
  STENSIBLY_GMAIL_OAUTH_CLIENT_ID: "gmail-client-id",
  STENSIBLY_GMAIL_OAUTH_CLIENT_SECRET: "gmail-client-secret",
  STENSIBLY_GMAIL_OAUTH_REFRESH_TOKEN: "gmail-refresh-token",
  STENSIBLY_GMAIL_MAILBOX: "leoli.4u@gmail.com",
  STENSIBLY_GMAIL_MAILBOX_BINDING_ID: "gmail_operator_primary",
  STENSIBLY_GMAIL_STENSIBLY_LABEL_ID: "Label_6",
  STENSIBLY_GITHUB_MAIL_PROJECT: "quarry",
  STENSIBLY_GITHUB_MAIL_REPOSITORY: "Coreys-Quarry/quarry",
  STENSIBLY_GITHUB_MAIL_PROJECT_CODE: "QRY",
  STENSIBLY_GITHUB_PUBLIC_EVENTS_FALLBACK_ENABLED: "true",
};

describe("hosted public GitHub repository fallback", () => {
  test("is disabled unless explicitly enabled", () => {
    expect(hostedGitHubPublicRepositoryFallbackEnabled({})).toBe(false);
    expect(hostedGitHubPublicRepositoryFallbackEnabled({
      STENSIBLY_GITHUB_PUBLIC_EVENTS_FALLBACK_ENABLED: "false",
    })).toBe(false);
    expect(createHostedGitHubPublicRepositoryObserverFromEnv({})).toBeUndefined();
  });

  test("rejects ambiguous enable values", () => {
    expect(() => hostedGitHubPublicRepositoryFallbackEnabled({
      STENSIBLY_GITHUB_PUBLIC_EVENTS_FALLBACK_ENABLED: "yes",
    })).toThrow("must be true or false");
  });

  test("fails closed when enabled without the existing mail mapping", () => {
    expect(() => createHostedGitHubPublicRepositoryObserverFromEnv({
      STENSIBLY_GITHUB_PUBLIC_EVENTS_FALLBACK_ENABLED: "true",
    })).toThrow("requires the hosted GitHub mail mapping");
  });

  test("constructs the one-repository fallback from the complete binding", () => {
    expect(createHostedGitHubPublicRepositoryObserverFromEnv(complete)).toBeDefined();
  });
});
