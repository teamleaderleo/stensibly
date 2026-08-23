import { describe, expect, test } from "bun:test";
import {
  createHostedGitHubMailConsumerFromEnv,
  hostedGitHubMailWorkerConfigured,
} from "../src/hosted-github-mail-worker.ts";

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
};

describe("hosted GitHub mail Worker configuration", () => {
  test("stays absent when dogfood activation is absent", () => {
    expect(hostedGitHubMailWorkerConfigured({})).toBe(false);
    expect(createHostedGitHubMailConsumerFromEnv({})).toBeUndefined();
  });

  test("fails closed when any activation key appears without the full binding", () => {
    const partial = {
      STENSIBLY_GITHUB_MAIL_PROJECT: "quarry",
    };
    expect(hostedGitHubMailWorkerConfigured(partial)).toBe(true);
    expect(() => createHostedGitHubMailConsumerFromEnv(partial)).toThrow(
      "Hosted GitHub mail configuration requires CONVEX_URL",
    );
  });

  test("constructs the one-repository consumer from the complete existing bindings", () => {
    expect(hostedGitHubMailWorkerConfigured(complete)).toBe(true);
    expect(createHostedGitHubMailConsumerFromEnv(complete)).toBeDefined();
  });
});
