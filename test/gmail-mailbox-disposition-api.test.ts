import { describe, expect, test } from "bun:test";
import {
  GmailMailboxDispositionApiClient,
  GmailMailboxDispositionProviderError,
} from "../src/gmail-mailbox-disposition-api.ts";

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GmailMailboxDispositionApiClient", () => {
  test("reads and mutates only the exact configured Gmail message", async () => {
    const calls: Array<{ url: string; method: string; body: string | null }> = [];
    const fakeFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: typeof init?.body === "string" ? init.body : null });
      if (method === "GET") {
        return response({
          id: "gmail_message_exact",
          threadId: "gmail_thread_exact",
          labelIds: ["SENT", "INBOX", "UNREAD"],
        });
      }
      return response({ id: "gmail_message_exact" });
    }) as typeof fetch;
    const client = new GmailMailboxDispositionApiClient({
      tokenProvider: { async getAccessToken() { return "token-for-exact-mailbox"; } },
      accountBinding: "gmail_operator_primary",
      mailboxAddress: "operator@example.com",
      stensiblyLabelId: "Label_6",
      fetch: fakeFetch,
    });

    const target = {
      accountBinding: "gmail_operator_primary",
      mailboxAddress: "operator@example.com",
      providerThreadId: "gmail_thread_exact",
      providerMessageId: "gmail_message_exact",
    };
    const snapshot = await client.readMessageLabels(target);
    expect(snapshot).toMatchObject({
      source: "gmail_message_label_snapshot",
      providerMessageId: "gmail_message_exact",
      providerThreadId: "gmail_thread_exact",
      isDraft: false,
    });

    await client.mutateMessageLabels({
      ...target,
      dispositionEffectId: "gmail-disposition-effect-1",
      addLabelIds: ["Label_6"],
      removeLabelIds: ["INBOX", "UNREAD"],
    });

    expect(calls).toHaveLength(2);
    const readCall = calls[0]!;
    const mutateCall = calls[1]!;
    expect(readCall.url).toContain("/gmail/v1/users/me/messages/gmail_message_exact?");
    expect(readCall.url).not.toContain("messages?");
    expect(mutateCall.url).toContain("/gmail/v1/users/me/messages/gmail_message_exact/modify");
    expect(JSON.parse(mutateCall.body!)).toEqual({
      addLabelIds: ["Label_6"],
      removeLabelIds: ["INBOX", "UNREAD"],
    });
  });

  test("rejects mailbox widening and arbitrary labels before provider access", async () => {
    let calls = 0;
    const client = new GmailMailboxDispositionApiClient({
      tokenProvider: { async getAccessToken() { return "token-for-exact-mailbox"; } },
      accountBinding: "gmail_operator_primary",
      mailboxAddress: "operator@example.com",
      stensiblyLabelId: "Label_6",
      fetch: (async () => {
        calls += 1;
        return response({});
      }) as typeof fetch,
    });

    await expect(client.readMessageLabels({
      accountBinding: "other-account",
      mailboxAddress: "operator@example.com",
      providerThreadId: "gmail_thread_exact",
      providerMessageId: "gmail_message_exact",
    })).rejects.toThrow("outside the configured mailbox binding");

    await expect(client.mutateMessageLabels({
      accountBinding: "gmail_operator_primary",
      mailboxAddress: "operator@example.com",
      providerThreadId: "gmail_thread_exact",
      providerMessageId: "gmail_message_exact",
      dispositionEffectId: "gmail-disposition-effect-1",
      addLabelIds: ["NewTaxonomyLabel"],
      removeLabelIds: [],
    })).rejects.toThrow("outside the bounded policy");
    expect(calls).toBe(0);
  });

  test("reuses an injected protected token provider and retries one rejected access token", async () => {
    const invalidated: string[] = [];
    let tokenCalls = 0;
    let providerCalls = 0;
    const tokenProvider = {
      async getAccessToken() {
        tokenCalls += 1;
        return tokenCalls === 1 ? "rejected-protected-token" : "refreshed-protected-token";
      },
      invalidateAccessToken(token: string) {
        invalidated.push(token);
      },
    };
    const client = new GmailMailboxDispositionApiClient({
      tokenProvider,
      accountBinding: "gmail_operator_primary",
      mailboxAddress: "operator@example.com",
      stensiblyLabelId: "Label_6",
      fetch: (async () => {
        providerCalls += 1;
        return providerCalls === 1
          ? response({ error: "unauthorized" }, 401)
          : response({
              id: "gmail_message_exact",
              threadId: "gmail_thread_exact",
              labelIds: ["Label_6"],
            });
      }) as typeof fetch,
    });

    const snapshot = await client.readMessageLabels({
      accountBinding: "gmail_operator_primary",
      mailboxAddress: "operator@example.com",
      providerThreadId: "gmail_thread_exact",
      providerMessageId: "gmail_message_exact",
    });
    expect(snapshot?.labelIds).toEqual(["Label_6"]);
    expect(invalidated).toEqual(["rejected-protected-token"]);
    expect(tokenCalls).toBe(2);
    expect(providerCalls).toBe(2);
  });

  test("provider transport uncertainty is surfaced without a blind retry", async () => {
    const client = new GmailMailboxDispositionApiClient({
      tokenProvider: { async getAccessToken() { return "token-for-exact-mailbox"; } },
      accountBinding: "gmail_operator_primary",
      mailboxAddress: "operator@example.com",
      stensiblyLabelId: "Label_6",
      fetch: (async () => { throw new Error("connection dropped"); }) as typeof fetch,
    });
    await expect(client.mutateMessageLabels({
      accountBinding: "gmail_operator_primary",
      mailboxAddress: "operator@example.com",
      providerThreadId: "gmail_thread_exact",
      providerMessageId: "gmail_message_exact",
      dispositionEffectId: "gmail-disposition-effect-1",
      addLabelIds: ["Label_6"],
      removeLabelIds: ["INBOX", "UNREAD"],
    })).rejects.toBeInstanceOf(GmailMailboxDispositionProviderError);
  });
});
