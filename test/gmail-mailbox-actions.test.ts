import { expect, test } from "bun:test";
import { GmailMailboxActionClient } from "../src/gmail-mailbox-actions.ts";

test("archives by removing only INBOX after durable admission", async () => {
  let observedUrl = "";
  let observedBody = "";
  const client = new GmailMailboxActionClient({
    tokenProvider: { getAccessToken: async () => "gmail-access-token-1234567890" },
    fetch: async (input, init) => {
      observedUrl = String(input);
      observedBody = String(init?.body);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer gmail-access-token-1234567890");
      return new Response("{}", { status: 200 });
    },
  });
  await client.archiveMessage("gmail-message-1");
  expect(observedUrl).toEndWith("/gmail/v1/users/me/messages/gmail-message-1/modify");
  expect(JSON.parse(observedBody)).toEqual({ removeLabelIds: ["INBOX"] });
});
