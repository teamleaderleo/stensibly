import { describe, expect, test } from "bun:test";
import { createServerApp } from "../src/server-app.js";
import {
  createLedgerStatusReader,
  DEFAULT_LEDGER_STATUS_ENDPOINT,
  DEFAULT_LEDGER_STATUS_MAX_ITEM_COUNT,
  DEFAULT_LEDGER_STATUS_MAX_RESPONSE_BYTES,
  DEFAULT_LEDGER_STATUS_TIMEOUT_MS,
  LedgerStatusReadBoundaryError,
  LedgerStatusResponseError,
  normalizeLedgerEndpointBase,
  type LedgerStatusItem,
} from "../src/studio-status-read-client.js";
import { StensiblyStore } from "../src/store.js";

const ENDPOINT = "https://ledger.example";

function fixtureItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "item-1",
    project: "scrapbook",
    kind: "task",
    title: "Fixture item",
    status: "ready",
    priority: 3,
    updatedAt: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function asFetch(impl: FetchLike): typeof fetch {
  return ((_url: unknown, _init?: unknown) =>
    impl(_url as string, _init as RequestInit | undefined)) as unknown as typeof fetch;
}

function byteStream(chunks: string[], { close = true } = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
        return;
      }
      if (close) controller.close();
    },
  });
}

async function readFailure(promise: Promise<unknown>): Promise<LedgerStatusResponseError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LedgerStatusResponseError) return error;
    throw error;
  }
  throw new Error("expected the read to fail");
}

describe("bounded defaults are deterministic", () => {
  test("defaults pin timeout, byte bound, and item bound", () => {
    expect(DEFAULT_LEDGER_STATUS_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_LEDGER_STATUS_MAX_RESPONSE_BYTES).toBe(1_048_576);
    expect(DEFAULT_LEDGER_STATUS_MAX_ITEM_COUNT).toBe(1_000);
  });

  test("option overrides must be positive integers", () => {
    for (const [key, value] of [
      ["timeoutMs", 0],
      ["timeoutMs", -5],
      ["timeoutMs", 12.5],
      ["maxResponseBytes", 0],
      ["maxItemCount", -1],
      ["maxItemCount", Number.NaN],
    ] as const) {
      expect(() =>
        createLedgerStatusReader({ endpoint: ENDPOINT, [key]: value } as never),
      ).toThrow(LedgerStatusReadBoundaryError);
    }
  });
});

describe("endpoint admission", () => {
  test("accepts origins, trailing slashes, base paths, and loopback development endpoints", () => {
    expect(normalizeLedgerEndpointBase("https://ledger.example")).toBe("https://ledger.example");
    expect(normalizeLedgerEndpointBase("https://ledger.example/")).toBe("https://ledger.example");
    expect(normalizeLedgerEndpointBase("https://gateway.example/base/")).toBe(
      "https://gateway.example/base",
    );
    expect(normalizeLedgerEndpointBase("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeLedgerEndpointBase("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(normalizeLedgerEndpointBase("http://[::1]:9000")).toBe("http://[::1]:9000");
  });

  test("rejects hostile endpoint forms without echoing them", () => {
    const hostile = [
      "ftp://ledger.example",
      "https://user:secret@ledger.example",
      "https://ledger.example/?project=x",
      "https://ledger.example/#fragment",
      "https://ledger.example/api/v1/items",
      "https://ledger.example/api/v1/items/item-1/claim",
      "http://lan-host.example:8080", // plain HTTP off loopback
      "not a url",
      "",
    ];
    for (const candidate of hostile) {
      try {
        normalizeLedgerEndpointBase(candidate);
        throw new Error(`expected rejection for ${candidate}`);
      } catch (error) {
        expect(error).toBeInstanceOf(LedgerStatusReadBoundaryError);
      }
    }
  });

  test("a reader built on a hostile endpoint is refused before any request", () => {
    let calls = 0;
    expect(() =>
      createLedgerStatusReader({
        endpoint: "https://user:secret@ledger.example",
        fetchImpl: asFetch(async () => {
          calls += 1;
          return jsonResponse({ items: [] });
        }),
      }),
    ).toThrow(LedgerStatusReadBoundaryError);
    expect(calls).toBe(0);
  });
});

describe("deadline enforcement", () => {
  test("a stalled body read is classified as timeout with a content-free message", async () => {
    const reader = createLedgerStatusReader({
      endpoint: ENDPOINT,
      timeoutMs: 40,
      fetchImpl: asFetch(async () =>
        new Response(byteStream(['{"items":['], { close: false }), { status: 200 })),
    });
    const failure = await readFailure(reader.listProjectItems("scrapbook"));
    expect(failure.kind).toBe("timeout");
    expect(failure.message).toBe("Ledger status read exceeded its time budget.");
  });

  test("a stalled connection is classified as network failure, not success", async () => {
    const reader = createLedgerStatusReader({
      endpoint: ENDPOINT,
      fetchImpl: asFetch(async () => {
        throw new TypeError("fixture unreachable");
      }),
    });
    const failure = await readFailure(reader.listProjectItems("scrapbook"));
    expect(failure.kind).toBe("network");
  });
});

describe("response size bounds", () => {
  test("an over-limit declared Content-Length is refused before reading", async () => {
    let pulled = false;
    // highWaterMark 0 keeps pull lazy so the flag only moves if the client reads.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new TextEncoder().encode("x"));
        },
      },
      new CountQueuingStrategy({ highWaterMark: 0 }),
    );
    const reader = createLedgerStatusReader({
      endpoint: ENDPOINT,
      maxResponseBytes: 64,
      fetchImpl: asFetch(async () =>
        new Response(body, { status: 200, headers: { "content-length": "65" } })),
    });
    const failure = await readFailure(reader.listProjectItems("scrapbook"));
    expect(failure.kind).toBe("oversize");
    expect(pulled).toBe(false);
  });

  test("streaming overflow past the byte limit aborts mid-stream as oversize", async () => {
    const half = "y".repeat(48);
    const reader = createLedgerStatusReader({
      endpoint: ENDPOINT,
      maxResponseBytes: 64,
      fetchImpl: asFetch(async () =>
        new Response(byteStream([half, half, half]), { status: 200 })),
    });
    const failure = await readFailure(reader.listProjectItems("scrapbook"));
    expect(failure.kind).toBe("oversize");
    expect(failure.message).toContain("byte limit");
  });

  test("a lying Content-Length is rejected after the true byte count lands", async () => {
    const payload = JSON.stringify({ items: [fixtureItem()] });
    const reader = createLedgerStatusReader({
      endpoint: ENDPOINT,
      fetchImpl: asFetch(async () =>
        new Response(byteStream([payload]), {
          status: 200,
          headers: { "content-length": String(payload.length + 25) },
        })),
    });
    const failure = await readFailure(reader.listProjectItems("scrapbook"));
    expect(failure.kind).toBe("malformed");
    expect(failure.message).toContain("did not match its declaration");
  });

  test("an unparsable Content-Length header is malformed", async () => {
    const reader = createLedgerStatusReader({
      endpoint: ENDPOINT,
      fetchImpl: asFetch(async () =>
        new Response(byteStream(["{}"]), {
          status: 200,
          headers: { "content-length": "many" },
        })),
    });
    const failure = await readFailure(reader.listProjectItems("scrapbook"));
    expect(failure.kind).toBe("malformed");
    expect(failure.message).toContain("invalid content length");
  });

  test("chunked responses without Content-Length remain readable", async () => {
    const reader = createLedgerStatusReader({
      endpoint: ENDPOINT,
      fetchImpl: asFetch(async () =>
        new Response(byteStream(['{"items":[', JSON.stringify(fixtureItem()), "]}"]), { status: 200 })),
    });
    const items = await reader.listProjectItems("scrapbook");
    expect(items.map((item) => item.id)).toEqual(["item-1"]);
  });

  test("responses beyond the item limit are oversize even when bytes fit", async () => {
    const items = Array.from({ length: 4 }, (_, index) => fixtureItem({ id: `item-${index}` }));
    const reader = createLedgerStatusReader({
      endpoint: ENDPOINT,
      maxItemCount: 3,
      fetchImpl: asFetch(async () => jsonResponse({ items })),
    });
    const failure = await readFailure(reader.listProjectItems("scrapbook"));
    expect(failure.kind).toBe("oversize");
    expect(failure.message).toContain("item limit");
  });
});

describe("payload validation into the narrow vocabulary", () => {
  function readerWithPayload(payload: unknown) {
    return createLedgerStatusReader({
      endpoint: ENDPOINT,
      fetchImpl: asFetch(async () => jsonResponse(payload)),
    });
  }

  test("valid items survive and unknown extra fields never do", async () => {
    const reader = readerWithPayload({
      items: [{
        ...fixtureItem(),
        tokenId: "must-not-survive",
        claimGeneration: 9,
        __proto__: { polluted: true },
        summary: "dropped too",
      }],
    });
    const [item] = await reader.listProjectItems("scrapbook");
    expect(item).toEqual(fixtureItem() as unknown as LedgerStatusItem);
    expect(item).not.toHaveProperty("tokenId");
    expect(item).not.toHaveProperty("claimGeneration");
    expect(item).not.toHaveProperty("summary");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("malformed envelopes are rejected as malformed", async () => {
    for (const payload of [[], { items: "all" }, { items: {} }, null, "ok"]) {
      const failure = await readFailure(readerWithPayload(payload).listProjectItems("scrapbook"));
      expect(failure.kind === "malformed" || failure.kind === "oversize").toBe(true);
    }
  });

  test("invalid JSON bodies are malformed and never echoed", async () => {
    const secretBody = '{"items":[{"title":"private detail stn.tok_abcdef"}]}';
    const reader = createLedgerStatusReader({
      endpoint: ENDPOINT,
      fetchImpl: asFetch(async () =>
        new Response(byteStream([`${secretBody}{broken`]), { status: 200 })),
    });
    const failure = await readFailure(reader.listProjectItems("scrapbook"));
    expect(failure.kind).toBe("malformed");
    expect(failure.message).not.toContain("private detail");
    expect(failure.message).not.toContain("stn.tok_");
  });

  test("every item field is validated against bounded typed expectations", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["non-object item", "nope" as unknown as Record<string, unknown>],
      ["array item", ["x"] as unknown as Record<string, unknown>],
      ["missing id", { ...fixtureItem(), id: undefined } as unknown as Record<string, unknown>],
      ["empty project", fixtureItem({ project: "" })],
      ["over-long title", fixtureItem({ title: "t".repeat(1_001) })],
      ["control characters", fixtureItem({ kind: "task\u0000hidden" })],
      ["credential-shaped claimedBy", fixtureItem({ claimedBy: "stn.tok_deadbeef" })],
      ["invalid status", fixtureItem({ status: "approved" as never })],
      ["numeric status", fixtureItem({ status: 3 as never })],
      ["float priority", fixtureItem({ priority: 3.5 })],
      ["string priority", fixtureItem({ priority: "high" as never })],
      ["missing timestamp", fixtureItem({ updatedAt: "" })],
      ["unparsable timestamp", fixtureItem({ updatedAt: "recently" })],
      ["non-string nextAction", fixtureItem({ nextAction: 42 as never })],
    ];
    for (const [label, badItem] of cases) {
      const failure = await readFailure(
        readerWithPayload({ items: [badItem] }).listProjectItems("scrapbook"),
      );
      expect(failure.kind, label).toBe("malformed");
    }
  });

  test("optional fields accept strings, nulls, or absence and nothing else", async () => {
    const absent = await readerWithPayload({ items: [fixtureItem()] }).listProjectItems("scrapbook");
    expect(absent[0]?.claimedBy).toBeUndefined();

    const nulled = await readerWithPayload({
      items: [fixtureItem({ claimedBy: null, nextAction: null })],
    }).listProjectItems("scrapbook");
    expect(nulled[0]?.claimedBy).toBeUndefined();
    expect(nulled[0]).toEqual(fixtureItem() as unknown as LedgerStatusItem);

    const failure = await readFailure(
      readerWithPayload({ items: [fixtureItem({ claimedBy: { name: "object" } })] })
        .listProjectItems("scrapbook"),
    );
    expect(failure.kind).toBe("malformed");
  });

  test("HTTP failures stay classified and truthful about the status alone", async () => {
    const reader = createLedgerStatusReader({
      endpoint: ENDPOINT,
      token: "stn.tok_secret_token_value",
      fetchImpl: asFetch(async () => jsonResponse({ error: "internal detail" }, { status: 503 })),
    });
    const failure = await readFailure(reader.listProjectItems("scrapbook"));
    expect(failure.kind).toBe("http");
    expect(failure.status).toBe(503);
    expect(failure.message).toBe("Ledger status read failed (HTTP 503).");
  });
});

describe("failures and recordings stay content-minimized", () => {
  test("no error message echoes endpoint, project, or token", async () => {
    const privateEndpoint = "https://secret-host.example";
    const projectName = "quiet-project";
    const token = "Bearer-material";
    const scenarios = [
      createLedgerStatusReader({
        endpoint: privateEndpoint,
        token,
        fetchImpl: asFetch(async () => new Response("boom", { status: 500 })),
      }).listProjectItems(projectName),
      createLedgerStatusReader({
        endpoint: privateEndpoint,
        token,
        fetchImpl: asFetch(async () => jsonResponse({ items: [{ bad: true }] })),
      }).listProjectItems(projectName),
      createLedgerStatusReader({
        endpoint: privateEndpoint,
        token,
        timeoutMs: 30,
        fetchImpl: asFetch((_url) => new Promise<Response>(() => {})),
      }).listProjectItems(projectName),
    ];
    for (const scenario of scenarios) {
      const failure = await readFailure(scenario);
      expect(failure.message).not.toContain("secret-host");
      expect(failure.message).not.toContain(projectName);
      expect(failure.message).not.toContain(token);
      expect(failure.message).not.toContain("api/v1");
    }
  });

  test("recorded requests keep exactly method and constructed URL", async () => {
    const reader = createLedgerStatusReader({
      endpoint: `${ENDPOINT}/`,
      token: "stn.tok_not_printed_anywhere",
      fetchImpl: asFetch(async () => jsonResponse({ items: [] })),
    });
    await reader.listProjectItems("scrapbook");
    expect(reader.recordedRequests()).toEqual([
      { method: "GET", url: `${ENDPOINT}/api/v1/items?project=scrapbook` },
    ]);
  });

  test("the GET-only allowlist boundary is unchanged", () => {
    expect(DEFAULT_LEDGER_STATUS_ENDPOINT).toMatch(/^https:\/\//);
  });
});

describe("public next-action contract through the real API v1 router", () => {
  test("accepts and reads 501- and 2000-character values, while the router rejects 2001", async () => {
    const store = new StensiblyStore(":memory:");
    const app = createServerApp(store);
    try {
      for (const length of [501, 2_000]) {
        const nextAction = "n".repeat(length);
        const response = await app.request("/api/v1/items", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            project: "scrapbook",
            kind: "task",
            title: `Next action ${length}`,
            nextAction,
            actor: { id: "operator", name: "Operator", kind: "human" },
          }),
        });
        expect(response.status).toBe(201);

        const reader = createLedgerStatusReader({
          endpoint: ENDPOINT,
          fetchImpl: asFetch(async (url, init) => {
            const parsed = new URL(url);
            return await app.request(`${parsed.pathname}${parsed.search}`, init);
          }),
        });
        const items = await reader.listProjectItems("scrapbook");
        expect(items.find((item) => item.title === `Next action ${length}`)?.nextAction).toBe(nextAction);
      }

      const rejected = await app.request("/api/v1/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: "scrapbook",
          kind: "task",
          title: "Next action 2001",
          nextAction: "n".repeat(2_001),
          actor: { id: "operator", name: "Operator", kind: "human" },
        }),
      });
      expect(rejected.status).toBe(400);
    } finally {
      store.close();
    }
  });
});
