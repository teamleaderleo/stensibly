import { describe, expect, test } from "bun:test";
import { GmailSemanticMessageClient } from "../src/gmail-semantic-message-client.ts";

const tokenProvider = {
  async getAccessToken() {
    return "test-access-token";
  },
};

describe("Gmail semantic message client", () => {
  test("fetches exactly one admitted provider message with full MIME fields", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input instanceof URL
        ? input
        : new URL(typeof input === "string" ? input : input.url);
      calls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify({
        id: "m-reply",
        threadId: "t-stn",
        payload: {
          mimeType: "text/plain",
          filename: "",
          headers: [],
          body: { data: "QQ" },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = new GmailSemanticMessageClient({
      tokenProvider,
      fetch: fetchImpl,
      apiBaseUrl: "https://gmail.googleapis.com",
    });

    const result = await client.fetchAdmittedMessage({
      accountBinding: "gmail_operator_primary",
      providerMessageId: "m-reply",
      expectedProviderThreadId: "t-stn",
    }) as Record<string, unknown>;

    expect(result.id).toBe("m-reply");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/gmail/v1/users/me/messages/m-reply");
    expect(calls[0]!.url.searchParams.get("format")).toBe("full");
    expect(calls[0]!.url.searchParams.get("fields")).toBe("id,threadId,payload");
    expect(calls[0]!.init.method).toBe("GET");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-access-token");
  });

  test("rejects an oversized provider response before JSON admission", async () => {
    const fetchImpl = (async () => new Response(
      JSON.stringify({ padding: "x".repeat(513 * 1024) }),
      { status: 200 },
    )) as unknown as typeof fetch;
    const client = new GmailSemanticMessageClient({
      tokenProvider,
      fetch: fetchImpl,
    });

    await expect(client.fetchAdmittedMessage({
      accountBinding: "gmail_operator_primary",
      providerMessageId: "m-reply",
      expectedProviderThreadId: "t-stn",
    })).rejects.toMatchObject({ operation: "response" });
  });
});
