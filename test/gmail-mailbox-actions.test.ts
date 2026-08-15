import { expect, test } from "bun:test";
import { GmailMailboxActionClient } from "../src/gmail-mailbox-actions.ts";

test("archives quiet mail and marks it read after durable admission", async () => {
  let observedUrl = "";
  let observedBody = "";
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    observedUrl = String(input);
    observedBody = String(init?.body);
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer gmail-access-token-1234567890",
    );
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const client = new GmailMailboxActionClient({
    tokenProvider: { getAccessToken: async () => "gmail-access-token-1234567890" },
    fetch: fakeFetch,
  });
  await client.archiveMessage("gmail-message-1");
  expect(observedUrl).toEndWith(
    "/gmail/v1/users/me/messages/gmail-message-1/modify",
  );
  expect(JSON.parse(observedBody)).toEqual({
    removeLabelIds: ["INBOX", "UNREAD"],
  });
});

test("repeatedly sweeps only Label_5 + INBOX until the quiet mailbox is empty", async () => {
  const requests: Array<{ url: string; method: string; body: string }> = [];
  let listRound = 0;
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method, body: String(init?.body ?? "") });
    if (method === "GET") {
      listRound += 1;
      return new Response(JSON.stringify(
        listRound === 1
          ? { messages: [{ id: "m1" }, { id: "m2" }] }
          : {},
      ), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const client = new GmailMailboxActionClient({
    tokenProvider: { getAccessToken: async () => "gmail-access-token-1234567890" },
    fetch: fakeFetch,
  });

  expect(await client.archiveMessagesWithLabels(["Label_5", "INBOX"])).toBe(2);
  const listRequests = requests.filter((entry) => entry.method === "GET");
  expect(listRequests).toHaveLength(2);
  for (const entry of listRequests) {
    const url = new URL(entry.url);
    expect(url.searchParams.getAll("labelIds")).toEqual(["Label_5", "INBOX"]);
    expect(url.searchParams.get("maxResults")).toBe("100");
    expect(url.searchParams.get("includeSpamTrash")).toBe("false");
  }
  const modifyRequests = requests.filter((entry) => entry.method === "POST");
  expect(modifyRequests.map((entry) => entry.url)).toEqual([
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/modify",
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/m2/modify",
  ]);
  for (const entry of modifyRequests) {
    expect(JSON.parse(entry.body)).toEqual({ removeLabelIds: ["INBOX", "UNREAD"] });
  }
});
