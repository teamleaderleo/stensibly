import { describe, expect, test } from "bun:test";
import {
  GitHubPublicEventsClient,
  GitHubPublicEventsProviderError,
  type GitHubPublicEventsPollState,
  type GitHubPublicEventsPollStateStore,
} from "../src/github-public-events-client.ts";

const repository = "Coreys-Quarry/quarry";

class MemoryStore implements GitHubPublicEventsPollStateStore {
  state: GitHubPublicEventsPollState | null = null;

  async getPollState() {
    return this.state;
  }

  async putPollState(state: GitHubPublicEventsPollState) {
    this.state = Object.freeze({ ...state });
    return this.state;
  }
}

describe("public GitHub Events client", () => {
  test("advances ETag only after acknowledgement, then defers and sends If-None-Match", async () => {
    const store = new MemoryStore();
    let now = Date.parse("2026-08-23T04:00:00.000Z");
    const requests: Request[] = [];
    let calls = 0;
    const client = new GitHubPublicEventsClient({
      repository,
      stateStore: store,
      now: () => now,
      fetch: async (input, init) => {
        calls += 1;
        const request = new Request(input, init);
        requests.push(request);
        if (calls === 1) {
          return new Response(JSON.stringify([{ id: "1" }]), {
            status: 200,
            headers: {
              ETag: 'W/"events-v1"',
              "X-Poll-Interval": "90",
              "Content-Type": "application/json",
            },
          });
        }
        return new Response(null, {
          status: 304,
          headers: { "X-Poll-Interval": "120" },
        });
      },
    });

    const first = await client.poll();
    expect(first).toMatchObject({
      status: "events",
      repository: "coreys-quarry/quarry",
      initial: true,
    });
    expect(first.status === "events" ? first.events : []).toHaveLength(1);
    expect(store.state).toBeNull();
    if (first.status !== "events") throw new Error("expected events page");
    await first.acknowledge();
    expect(store.state).toMatchObject({
      repository: "coreys-quarry/quarry",
      etag: 'W/"events-v1"',
      nextEligibleAt: "2026-08-23T04:01:30.000Z",
      lastPolledAt: "2026-08-23T04:00:00.000Z",
    });

    now += 60_000;
    expect(await client.poll()).toEqual({
      status: "deferred",
      repository: "coreys-quarry/quarry",
      nextEligibleAt: "2026-08-23T04:01:30.000Z",
    });
    expect(calls).toBe(1);

    now += 31_000;
    const second = await client.poll();
    expect(second.status).toBe("not_modified");
    expect(calls).toBe(2);
    expect(requests[1]!.headers.get("if-none-match")).toBe('W/"events-v1"');
    expect(requests[1]!.headers.get("authorization")).toBeNull();
    expect(requests[1]!.headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(store.state?.nextEligibleAt).toBe("2026-08-23T04:03:31.000Z");
  });

  test("leaves the prior cursor unchanged until an events page is acknowledged", async () => {
    const store = new MemoryStore();
    store.state = {
      repository: "coreys-quarry/quarry",
      etag: 'W/"old"',
      nextEligibleAt: "2026-08-23T03:59:00.000Z",
      lastPolledAt: "2026-08-23T03:58:00.000Z",
    };
    const client = new GitHubPublicEventsClient({
      repository,
      stateStore: store,
      now: () => Date.parse("2026-08-23T04:00:00.000Z"),
      fetch: async () => new Response(JSON.stringify([{ id: "2" }]), {
        status: 200,
        headers: { ETag: 'W/"new"' },
      }),
    });
    const page = await client.poll();
    expect(page).toMatchObject({ status: "events", initial: false });
    expect(store.state?.etag).toBe('W/"old"');
    if (page.status !== "events") throw new Error("expected events page");
    await page.acknowledge();
    expect(store.state?.etag).toBe('W/"new"');
  });

  test("rejects response pages above the configured cardinality", async () => {
    const client = new GitHubPublicEventsClient({
      repository,
      stateStore: new MemoryStore(),
      pageSize: 2,
      fetch: async () => new Response(JSON.stringify([{ id: "1" }, { id: "2" }, { id: "3" }])),
    });
    await expect(client.poll()).rejects.toThrow("exceeded the bounded page");
  });

  test("rejects oversized response bytes before parsing", async () => {
    const client = new GitHubPublicEventsClient({
      repository,
      stateStore: new MemoryStore(),
      maximumBodyBytes: 1024,
      fetch: async () => new Response("x".repeat(1025), {
        status: 200,
        headers: { "Content-Length": "1025" },
      }),
    });
    await expect(client.poll()).rejects.toThrow("response was oversized");
  });

  test("records provider retry eligibility without retrying in place", async () => {
    const store = new MemoryStore();
    let calls = 0;
    const now = Date.parse("2026-08-23T04:00:00.000Z");
    const client = new GitHubPublicEventsClient({
      repository,
      stateStore: store,
      now: () => now,
      fetch: async () => {
        calls += 1;
        return new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "600" },
        });
      },
    });
    try {
      await client.poll();
      throw new Error("expected provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubPublicEventsProviderError);
      expect((error as GitHubPublicEventsProviderError).status).toBe(429);
    }
    expect(calls).toBe(1);
    expect(store.state?.nextEligibleAt).toBe("2026-08-23T04:10:00.000Z");
  });
});
