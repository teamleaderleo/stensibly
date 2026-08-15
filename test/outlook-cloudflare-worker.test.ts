import { describe, expect, test } from "bun:test";
import worker, { type CloudflareBindings } from "../src/cloudflare-worker.ts";

function env(): CloudflareBindings {
  return {
    CONVEX_URL: "https://example.convex.cloud",
    STENSIBLY_SERVICE_SECRET: "service-secret",
    STENSIBLY_WORKSPACE: "default",
    STENSIBLY_OUTLOOK_OAUTH_CLIENT_ID: "public-client-id",
    STENSIBLY_OUTLOOK_OAUTH_REFRESH_TOKEN: "refresh-token",
    STENSIBLY_OUTLOOK_CLIENT_STATE: "client-state",
    STENSIBLY_OUTLOOK_FOLDER_ID: "folder_stensibly_handoffs",
    STENSIBLY_OUTLOOK_MAILBOX: "cheerleaderleo@outlook.com",
    STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID: "outlook_operator_primary",
    STENSIBLY_OUTLOOK_NOTIFICATION_URL:
      "https://api.stensibly.com/internal/outlook/notifications",
  };
}

describe("Cloudflare Outlook ingress", () => {
  test("routes the exact internal notification path to the Microsoft validation handshake", async () => {
    const response = await worker.fetch(
      new Request(
        "https://api.stensibly.com/internal/outlook/notifications?validationToken=graph%20challenge",
        { method: "POST" },
      ),
      env(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe("graph challenge");
  });

  test("keeps the Outlook bindings out of the hosted app string environment", async () => {
    const module = await import("../src/cloudflare-worker.ts");
    const projected = module.stringEnvironment(env());
    expect(Object.keys(projected).some((name) => name.startsWith("STENSIBLY_OUTLOOK_"))).toBe(false);
  });
});
