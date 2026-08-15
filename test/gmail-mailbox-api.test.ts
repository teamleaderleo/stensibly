import { describe, expect, test } from "bun:test";
import {
  GmailMailboxApiClient,
  GmailMailboxProviderError,
  type GmailAccessTokenProvider,
} from "../src/gmail-mailbox-api.ts";
import { GmailHistoryCursorExpiredError } from "../src/gmail-mailbox-intake.ts";

const secretToken = "ya29.test-secret-token";
const topicName = "projects/stensibly-dogfood/topics/mailbox-change-intake";

function tokenProvider(): GmailAccessTokenProvider {
  return {
    async getAccessToken() {
      return secretToken;
    },
  };
}

function fetchFixture(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return implementation as typeof fetch;
}

describe("Gmail mailbox API adapter", () => {
  test("reads label-scoped history with the exact durable cursor and minimizes provider payloads", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const client = new GmailMailboxApiClient({
      tokenProvider: tokenProvider(),
      topicName,
      fetch: fetchFixture(async (input, init) => {
        const url = new URL(String(input));
        requests.push({ url, init });
        return Response.json({
          history: [{
            id: "101",
            messagesAdded: [{
              message: {
                id: "m_1",
                threadId: "t_1",
                labelIds: ["Label_5"],
                snippet: "private message text",
                payload: { body: { data: "private body" } },
              },
            }],
            labelsAdded: [{
              message: {
                id: "m_2",
                threadId: "t_2",
                snippet: "another private message",
              },
              labelIds: ["Label_5"],
            }],
          }],
          nextPageToken: "page_2",
          historyId: "105",
        });
      }),
    });

    const page = await client.listHistory({
      startHistoryId: "100",
      labelId: "Label_5",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.init?.method).toBe("GET");
    expect(new Headers(requests[0]!.init?.headers).get("Authorization"))
      .toBe(`Bearer ${secretToken}`);
    expect(requests[0]!.url.origin).toBe("https://gmail.googleapis.com");
    expect(requests[0]!.url.pathname).toBe("/gmail/v1/users/me/history");
    expect(requests[0]!.url.searchParams.get("startHistoryId")).toBe("100");
    expect(requests[0]!.url.searchParams.get("labelId")).toBe("Label_5");
    expect(requests[0]!.url.searchParams.get("maxResults")).toBe("500");
    expect(requests[0]!.url.searchParams.getAll("historyTypes")).toEqual([
      "messageAdded",
      "messageDeleted",
      "labelAdded",
      "labelRemoved",
    ]);
    expect(page).toEqual({
      history: [{
        id: "101",
        messagesAdded: [{
          message: {
            id: "m_1",
            threadId: "t_1",
            labelIds: ["Label_5"],
          },
        }],
        labelsAdded: [{
          message: {
            id: "m_2",
            threadId: "t_2",
          },
          labelIds: ["Label_5"],
        }],
      }],
      nextPageToken: "page_2",
      historyId: "105",
    });
    expect(JSON.stringify(page)).not.toContain("private message");
    expect(JSON.stringify(page)).not.toContain("payload");
    expect(JSON.stringify(page)).not.toContain(secretToken);
  });

  test("renews a label-scoped Gmail watch through the configured Pub/Sub topic", async () => {
    const requests: Array<{ url: URL; init?: RequestInit; body: unknown }> = [];
    const client = new GmailMailboxApiClient({
      tokenProvider: tokenProvider(),
      topicName,
      fetch: fetchFixture(async (input, init) => {
        requests.push({
          url: new URL(String(input)),
          init,
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({
          historyId: "120",
          expiration: "1787486400000",
        });
      }),
    });

    const renewed = await client.renewWatch({
      labelIds: ["Label_5"],
      labelFilterBehavior: "include",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe("/gmail/v1/users/me/watch");
    expect(requests[0]!.init?.method).toBe("POST");
    expect(new Headers(requests[0]!.init?.headers).get("Authorization"))
      .toBe(`Bearer ${secretToken}`);
    expect(requests[0]!.body).toEqual({
      topicName,
      labelIds: ["Label_5"],
      labelFilterBehavior: "include",
    });
    expect(renewed).toEqual({
      historyId: "120",
      expiration: "1787486400000",
    });
  });

  test("maps a stale Gmail history cursor to the reconciliation recovery signal", async () => {
    const client = new GmailMailboxApiClient({
      tokenProvider: tokenProvider(),
      topicName,
      fetch: fetchFixture(async () =>
        new Response("private provider explanation", { status: 404 })),
    });

    await expect(client.listHistory({
      startHistoryId: "100",
      labelId: "Label_5",
    })).rejects.toBeInstanceOf(GmailHistoryCursorExpiredError);
  });

  test("keeps provider failures and transport errors free of credentials and response bodies", async () => {
    const rejected = new GmailMailboxApiClient({
      tokenProvider: tokenProvider(),
      topicName,
      fetch: fetchFixture(async () => new Response(
        `private body with ${secretToken}`,
        { status: 429 },
      )),
    });

    let rejectedError: unknown;
    try {
      await rejected.renewWatch({
        labelIds: ["Label_5"],
        labelFilterBehavior: "include",
      });
    } catch (error) {
      rejectedError = error;
    }
    expect(rejectedError).toBeInstanceOf(GmailMailboxProviderError);
    expect(String(rejectedError)).toContain("status 429");
    expect(String(rejectedError)).not.toContain(secretToken);
    expect(String(rejectedError)).not.toContain("private body");

    const transport = new GmailMailboxApiClient({
      tokenProvider: tokenProvider(),
      topicName,
      fetch: fetchFixture(async () => {
        throw new Error(`network failure ${secretToken}`);
      }),
    });
    await expect(transport.listHistory({
      startHistoryId: "100",
      labelId: "Label_5",
    })).rejects.toThrow("Gmail provider transport failed");
    try {
      await transport.listHistory({
        startHistoryId: "100",
        labelId: "Label_5",
      });
    } catch (error) {
      expect(String(error)).not.toContain(secretToken);
    }
  });
});
