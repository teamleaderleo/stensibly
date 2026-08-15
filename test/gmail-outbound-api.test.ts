import { describe, expect, test } from "bun:test";
import {
  GmailOutboundApiClient,
  GmailOutboundApiError,
} from "../src/gmail-outbound-api.ts";

const accessToken = "test_access_token_1234567890";
const rfcMessageId = "<stn.1234567890abcdef@mail.stensibly.com>";

function tokenProvider() {
  return { async getAccessToken() { return accessToken; } };
}

describe("GmailOutboundApiClient", () => {
  test("sends raw Gmail messages with protected bearer access and reads bounded reconciliation metadata", async () => {
    const requests: { url: URL; init: RequestInit }[] = [];
    const client = new GmailOutboundApiClient({
      tokenProvider: tokenProvider(),
      apiBaseUrl: "https://gmail.example.test",
      now: () => Date.parse("2026-08-15T08:00:00.000Z"),
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push({ url, init: init ?? {} });
        const authorization = new Headers(init?.headers).get("Authorization");
        expect(authorization).toBe(`Bearer ${accessToken}`);
        if (url.pathname.endsWith("/messages/send")) {
          const body = JSON.parse(String(init?.body));
          expect(body.raw).toBe("YWJjZA");
          expect(body.threadId).toBe("gmail_thread_1");
          return new Response(JSON.stringify({ id: "gmail_message_2", threadId: "gmail_thread_1" }));
        }
        if (url.pathname.endsWith("/messages")) {
          expect(url.searchParams.get("q")).toBe(`rfc822msgid:${rfcMessageId}`);
          expect(url.searchParams.get("maxResults")).toBe("64");
          return new Response(JSON.stringify({ messages: [{ id: "gmail_message_2" }] }));
        }
        if (url.pathname.endsWith("/messages/gmail_message_2")) {
          expect(url.searchParams.get("format")).toBe("metadata");
          return new Response(JSON.stringify({
            id: "gmail_message_2",
            threadId: "gmail_thread_1",
            internalDate: String(Date.parse("2026-08-15T08:00:00.000Z")),
            payload: {
              headers: [
                { name: "Message-ID", value: rfcMessageId },
                { name: "X-Stensibly-Effect", value: "mailfx_1234567890abcdef" },
                { name: "Subject", value: "[STN-HANDOFF:K8R4] Hosted continuation" },
                { name: "References", value: "<root@example.com>" },
              ],
            },
          }));
        }
        throw new Error("unexpected request");
      },
    });

    const sent = await client.sendRaw({ raw: "YWJjZA", threadId: "gmail_thread_1" });
    expect(sent).toEqual({
      id: "gmail_message_2",
      threadId: "gmail_thread_1",
      acceptedAt: "2026-08-15T08:00:00.000Z",
    });

    const found = await client.findMessagesByRfcMessageId({ rfcMessageId });
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({
      id: "gmail_message_2",
      threadId: "gmail_thread_1",
      rfcMessageId,
      outboundEffectId: "mailfx_1234567890abcdef",
      subject: "[STN-HANDOFF:K8R4] Hosted continuation",
      references: ["<root@example.com>"],
      acceptedAt: "2026-08-15T08:00:00.000Z",
    });
    expect(requests).toHaveLength(3);
  });

  test("pagination or oversized reconciliation scope fails closed instead of claiming complete absence", async () => {
    const client = new GmailOutboundApiClient({
      tokenProvider: tokenProvider(),
      apiBaseUrl: "https://gmail.example.test",
      fetch: async () => new Response(JSON.stringify({
        messages: [{ id: "gmail_message_1" }],
        nextPageToken: "more",
      })),
    });
    await expect(client.findMessagesByRfcMessageId({ rfcMessageId }))
      .rejects.toBeInstanceOf(GmailOutboundApiError);
  });

  test("provider and transport failures expose sanitized errors without bearer material", async () => {
    const client = new GmailOutboundApiClient({
      tokenProvider: tokenProvider(),
      apiBaseUrl: "https://gmail.example.test",
      fetch: async () => new Response("provider secret prose", { status: 503 }),
    });
    let caught: unknown;
    try {
      await client.sendRaw({ raw: "YWJjZA" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GmailOutboundApiError);
    expect(String(caught)).toContain("status 503");
    expect(String(caught)).not.toContain(accessToken);
    expect(String(caught)).not.toContain("provider secret prose");
  });
});
