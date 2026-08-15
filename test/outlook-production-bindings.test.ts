import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  PRODUCTION_BINDING_CONTRACT,
  REQUIRED_PRODUCTION_BINDINGS,
} from "../scripts/worker-production-release.ts";

const exactOutlookBindings = [
  "STENSIBLY_OUTLOOK_OAUTH_CLIENT_ID",
  "STENSIBLY_OUTLOOK_OAUTH_REFRESH_TOKEN",
  "STENSIBLY_OUTLOOK_CLIENT_STATE",
  "STENSIBLY_OUTLOOK_FOLDER_ID",
  "STENSIBLY_OUTLOOK_MAILBOX",
  "STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID",
  "STENSIBLY_OUTLOOK_NOTIFICATION_URL",
] as const;

describe("Outlook production Worker binding contract", () => {
  test("pins exactly the seven operator-staged Outlook names with protected secret values", () => {
    const actual = Object.keys(REQUIRED_PRODUCTION_BINDINGS)
      .filter((name) => name.startsWith("STENSIBLY_OUTLOOK_"))
      .sort();
    expect(actual).toEqual([...exactOutlookBindings].sort());

    expect(REQUIRED_PRODUCTION_BINDINGS.STENSIBLY_OUTLOOK_OAUTH_CLIENT_ID).toEqual({
      name: "STENSIBLY_OUTLOOK_OAUTH_CLIENT_ID",
      type: "secret_text",
    });
    expect(REQUIRED_PRODUCTION_BINDINGS.STENSIBLY_OUTLOOK_OAUTH_REFRESH_TOKEN).toEqual({
      name: "STENSIBLY_OUTLOOK_OAUTH_REFRESH_TOKEN",
      type: "secret_text",
    });
    expect(REQUIRED_PRODUCTION_BINDINGS.STENSIBLY_OUTLOOK_CLIENT_STATE).toEqual({
      name: "STENSIBLY_OUTLOOK_CLIENT_STATE",
      type: "secret_text",
    });
    expect(REQUIRED_PRODUCTION_BINDINGS.STENSIBLY_OUTLOOK_FOLDER_ID).toEqual({
      name: "STENSIBLY_OUTLOOK_FOLDER_ID",
      type: "secret_text",
    });
    expect(REQUIRED_PRODUCTION_BINDINGS.STENSIBLY_OUTLOOK_MAILBOX?.text).toBe(
      "cheerleaderleo@outlook.com",
    );
    expect(REQUIRED_PRODUCTION_BINDINGS.STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID?.text).toBe(
      "outlook_operator_primary",
    );
    expect(REQUIRED_PRODUCTION_BINDINGS.STENSIBLY_OUTLOOK_NOTIFICATION_URL?.text).toBe(
      "https://api.stensibly.com/internal/outlook/notifications",
    );
  });

  test("forbids secret, tenant, and subscription-id bindings outside the seven-name contract", () => {
    expect(PRODUCTION_BINDING_CONTRACT.forbiddenBindings).toEqual(expect.arrayContaining([
      "STENSIBLY_OUTLOOK_OAUTH_CLIENT_SECRET",
      "STENSIBLY_OUTLOOK_OAUTH_TENANT",
      "STENSIBLY_OUTLOOK_SUBSCRIPTION_ID",
    ]));
  });

  test("checks in the exact live custom domain and non-secret Outlook variables", () => {
    const wrangler = JSON.parse(readFileSync("wrangler.jsonc", "utf8")) as {
      routes?: Array<{ pattern?: string; custom_domain?: boolean }>;
      vars?: Record<string, string>;
    };
    expect(wrangler.routes).toContainEqual({
      pattern: "api.stensibly.com",
      custom_domain: true,
    });
    expect(wrangler.vars).toMatchObject({
      STENSIBLY_OUTLOOK_MAILBOX: "cheerleaderleo@outlook.com",
      STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID: "outlook_operator_primary",
      STENSIBLY_OUTLOOK_NOTIFICATION_URL:
        "https://api.stensibly.com/internal/outlook/notifications",
    });
  });
});
