import { expect, test } from "bun:test";
import {
  GMAIL_PUBSUB_PATH,
  gmailUnattendedConfigured,
} from "../src/gmail-unattended-worker.ts";

test("requires the complete protected Gmail binding set", () => {
  const env = {
    CONVEX_URL: "https://example.convex.cloud",
    STENSIBLY_SERVICE_SECRET: "service-secret",
    STENSIBLY_GMAIL_OAUTH_CLIENT_ID: "client-id",
    STENSIBLY_GMAIL_OAUTH_CLIENT_SECRET: "client-secret",
    STENSIBLY_GMAIL_OAUTH_REFRESH_TOKEN: "refresh-token",
    STENSIBLY_GMAIL_MAILBOX: "leoli.4u@gmail.com",
    STENSIBLY_GMAIL_MAILBOX_BINDING_ID: "gmail_operator_primary",
    STENSIBLY_GMAIL_WATCH_LABEL_ID: "Label_5",
    STENSIBLY_GMAIL_PUBSUB_TOPIC: "projects/example/topics/stensibly-gmail-handoffs",
    STENSIBLY_GMAIL_PUBSUB_SUBSCRIPTION: "projects/example/subscriptions/stensibly-gmail-handoffs",
    STENSIBLY_GMAIL_PUBSUB_AUDIENCE: "https://api.stensibly.com/internal/gmail/pubsub",
    STENSIBLY_GMAIL_PUBSUB_SERVICE_ACCOUNT: "stensibly-gmail-push@example.iam.gserviceaccount.com",
  };
  expect(gmailUnattendedConfigured(env)).toBe(true);
  expect(gmailUnattendedConfigured({ ...env, STENSIBLY_GMAIL_OAUTH_REFRESH_TOKEN: "" })).toBe(false);
  expect(GMAIL_PUBSUB_PATH).toBe("/internal/gmail/pubsub");
});
