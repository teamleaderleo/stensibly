import { describe, expect, test } from "bun:test";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";
import {
  buildCompleteRequestBody,
  buildUnblockRequestBody,
  isBlockedTransitionRefusal,
  resolveItemActionOutcome,
  type ItemActionResolutionContext,
} from "../site/item-resolution.js";

const operator = { id: "operator-dashboard", name: "Operator", kind: "human" as const };

function recordedFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return await handler(url, init);
  };
  return { fetchImpl, requests };
}

function jsonResponse(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const blockedRefusalSqlite = {
  status: 409,
  code: "conflict",
  message: "Only blocked work at the current claim generation can be unblocked",
};
const blockedRefusalConvex = {
  status: 409,
  code: "conflict",
  message: "Only blocked work can be unblocked",
};

async function resolution(
  context: Partial<ItemActionResolutionContext>,
  handler?: Parameters<typeof recordedFetch>[0],
) {
  const recording = recordedFetch(handler ?? ((url, init) => {
    throw new Error(`unexpected request to ${url}: ${String(init.body)}`);
  }));
  const base: ItemActionResolutionContext = {
    endpoint: "https://dashboard.example",
    token: "stn.tok_test",
    itemId: "itm_1",
    item: { id: "itm_1", status: "blocked", claimGeneration: 3 },
    actor: operator,
    generateKey: () => "stn.done-fixed-key",
  };
  const outcome = await resolveItemActionOutcome({
    ...base,
    ...context,
    fetchImpl: context.fetchImpl ?? recording.fetchImpl,
  });
  return { outcome, requests: recording.requests };
}

describe("tray item resolution protocol (injected transport)", () => {
  test("sends the click-time generation in a validated complete body and stops on success", async () => {
    const { outcome, requests } = await resolution({}, () =>
      jsonResponse(200, { item: { id: "itm_1", status: "done" } }));
    expect(outcome).toBe("completed");
    expect(requests.length).toBe(1);
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
      id: "itm_1",
      actor: operator,
      action: "complete",
      expectedClaimGeneration: 3,
    });
    expect(requests[0]!.url).toBe("https://dashboard.example/api/v1/items/itm_1/complete");
    expect(requests[0]!.init.headers).toMatchObject({
      authorization: "Bearer stn.tok_test",
      "idempotency-key": "stn.done-fixed-key",
    });
  });

  test("falls back to unblock exactly once and only for the canonical blocked-item refusal", async () => {
    for (const refusal of [blockedRefusalSqlite, blockedRefusalConvex]) {
      const { outcome, requests } = await resolution({}, (url) => {
        if (!url.endsWith("/unblock")) {
          return jsonResponse(refusal.status, { error: refusal.message, code: refusal.code });
        }
        return jsonResponse(200, { item: { id: "itm_1", status: "ready" } });
      });
      expect(outcome).toBe("unblocked");
      expect(requests.length).toBe(2);
      expect(requests[0]!.url.endsWith("/complete")).toBe(true);
      expect(requests[1]!.url.endsWith("/unblock")).toBe(true);
      expect(JSON.parse(String(requests[1]!.init.body))).toEqual({
        id: "itm_1",
        actor: operator,
        action: "unblock",
        expectedClaimGeneration: 3,
      });
      const completeKey = (requests[0]!.init.headers as Record<string, string>)["idempotency-key"];
      const unblockKey = (requests[1]!.init.headers as Record<string, string>)["idempotency-key"];
      expect(completeKey).toBe(unblockKey);
    }
  });

  test("a fallback that also fails is reported failed, not retried", async () => {
    let unblockCalls = 0;
    const { outcome, requests } = await resolution({}, (url) => {
      if (url.endsWith("/unblock")) {
        unblockCalls += 1;
        return jsonResponse(404, { error: "Item does not exist", code: "not_found" });
      }
      return jsonResponse(409, { error: blockedRefusalSqlite.message, code: "conflict" });
    });
    expect(outcome).toBe("failed");
    expect(unblockCalls).toBe(1);
    expect(requests.length).toBe(2);
  });

  test("stale-generation conflicts fail closed without a second mutation attempt", async () => {
    for (const message of [
      "Claim generation changed; refresh the item before retrying",
      "Item is complete, archived, held by another actor, or the claim generation changed",
    ]) {
      const { outcome, requests } = await resolution({}, () =>
        jsonResponse(409, { error: message, code: "conflict" }));
      expect(outcome).toBe("failed");
      expect(requests.length).toBe(1);
    }
  });

  test("held claims, malformed input, auth failures, and server errors never fall back", async () => {
    const hostileResponses = [
      jsonResponse(409, { error: "Work is held by another actor", code: "conflict" }),
      jsonResponse(400, { error: "Invalid request", code: "invalid_request" }),
      jsonResponse(401, { error: "A valid Bearer token is required", code: "unauthorized" }),
      jsonResponse(500, { error: "Hosted backend request failed", code: "backend_failure" }),
    ];
    for (const response of hostileResponses) {
      const { outcome, requests } = await resolution({}, () => response.clone());
      expect(outcome).toBe("failed");
      expect(requests.length).toBe(1);
    }
  });

  test("network ambiguity fails closed with a single attempt", async () => {
    const { outcome, requests } = await resolution({}, () => {
      throw new TypeError("fetch failed");
    });
    expect(outcome).toBe("failed");
    expect(requests.length).toBe(1);
  });

  test("a non-JSON conflict body is never treated as permission to fall back", async () => {
    const { outcome, requests } = await resolution({}, () =>
      new Response("<html>gateway timeout</html>", { status: 409 }));
    expect(outcome).toBe("failed");
    expect(requests.length).toBe(1);
  });

  test("missing or invalid generations fail closed with zero requests", async () => {
    for (const claimGeneration of [
      undefined,
      null,
      -1,
      1.5,
      Number.NaN,
      "2",
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const { outcome, requests } = await resolution({
        item: { id: "itm_1", status: "blocked", claimGeneration },
      });
      expect(outcome).toBe("failed");
      expect(requests.length).toBe(0);
    }
    const missingItem = await resolution({ item: null });
    expect(missingItem.outcome).toBe("failed");
    expect(missingItem.requests.length).toBe(0);
  });

  test("an invalid actor fails closed before any request", async () => {
    const { outcome, requests } = await resolution({ actor: { id: "", name: "", kind: "robot" } });
    expect(outcome).toBe("failed");
    expect(requests.length).toBe(0);
  });

  test("the refusal gate admits exactly the two backend blocked-refusals and nothing else", () => {
    expect(isBlockedTransitionRefusal(blockedRefusalSqlite)).toBe(true);
    expect(isBlockedTransitionRefusal(blockedRefusalConvex)).toBe(true);
    expect(isBlockedTransitionRefusal(null)).toBe(false);
    expect(isBlockedTransitionRefusal(undefined)).toBe(false);
    expect(isBlockedTransitionRefusal({ status: 400, code: "invalid_request", message: "Only blocked work can be unblocked" })).toBe(false);
    expect(isBlockedTransitionRefusal({ status: 409, code: "invalid_request", message: "Only blocked work can be unblocked" })).toBe(false);
    expect(isBlockedTransitionRefusal({ status: 409, code: "conflict", message: "Claim generation changed; refresh the item before retrying" })).toBe(false);
    expect(isBlockedTransitionRefusal({ status: 409, code: "conflict", message: "Work is held by another actor" })).toBe(false);
    expect(isBlockedTransitionRefusal({ status: 409, code: "conflict", message: "Item is already complete or archived" })).toBe(false);
    expect(isBlockedTransitionRefusal({ status: 409, code: "conflict", message: "Only blocked work can be unblocked while held by another actor" })).toBe(false);
    expect(isBlockedTransitionRefusal({ status: 409, code: "conflict", message: "only blocked work can be unblocked" })).toBe(false);
  });

  test("body builders refuse to guess a generation or emit credential-shaped fields", () => {
    expect(() => buildCompleteRequestBody("itm_1", operator, undefined)).toThrow("claim generation");
    expect(() => buildUnblockRequestBody("itm_1", operator, undefined)).toThrow("claim generation");
    expect(() => buildCompleteRequestBody("itm_1", operator, "3")).toThrow();
    expect(() => buildCompleteRequestBody("itm_1", operator, Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => buildUnblockRequestBody("itm_1", operator, Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => buildUnblockRequestBody("itm_1", { id: "stn.tok_x", name: "x", kind: "agent" }, 0)).toThrow();
    expect(buildCompleteRequestBody("itm_1", operator, 0)).toEqual({
      id: "itm_1",
      actor: operator,
      action: "complete",
      expectedClaimGeneration: 0,
    });
  });
});

describe("tray-generated bodies against the real API v1 router", () => {
  function freshApp() {
    const store = new StensiblyStore(":memory:");
    return { store, app: createServerApp(store) };
  }

  test("a valid generation completes a blocked item end-to-end", async () => {
    const { store, app } = freshApp();
    try {
      const created = await jsonBody(app.request("/api/v1/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: "scrapbook",
          kind: "task",
          title: "Tray-resolvable blocker",
          actor: operator,
        }),
      }), 201);
      const itemId = created.item.id;

      await blockViaRouter(app, itemId);

      // The dashboard's only view of items is this projection.
      const listed = await jsonBody(app.request("/api/v1/items?project=scrapbook"));
      const projected = listed.items.find((entry: { id: string }) => entry.id === itemId);
      expect(projected.status).toBe("blocked");

      const body = buildCompleteRequestBody(itemId, operator, projected.claimGeneration);
      const completeResponse = await app.request(`/api/v1/items/${encodeURIComponent(itemId)}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "tray-complete-1" },
        body: JSON.stringify(body),
      });
      expect(completeResponse.status).toBe(200);
      const completed = await completeResponse.json();
      expect(completed.item).toMatchObject({
        status: "done",
        claimGeneration: projected.claimGeneration + 1,
      });
    } finally {
      store.close();
    }
  });

  test("a stale projection fails closed against the live server without any second mutation", async () => {
    const { store, app } = freshApp();
    try {
      const created = await jsonBody(app.request("/api/v1/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: "scrapbook",
          kind: "task",
          title: "Concurrently moved blocker",
          actor: operator,
        }),
      }), 201);
      const itemId = created.item.id;

      await blockViaRouter(app, itemId);
      const staleProjection = await projectedItem(app, itemId);

      // Move the real item forward while the dashboard keeps its old snapshot:
      // unblock then block again advances the generation twice, still blocked.
      const unblocked = await app.request(`/api/v1/items/${encodeURIComponent(itemId)}/unblock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildUnblockRequestBody(itemId, operator, staleProjection.claimGeneration),
        ),
      });
      expect(unblocked.status).toBe(200);
      await blockViaRouter(app, itemId);

      const versionBefore = (await jsonBody(app.request(`/api/v1/items/${encodeURIComponent(itemId)}`)))
        .item.version;

      const requestsSeen: string[] = [];
      const fetchImpl = async (url: string, init: RequestInit) => {
        const parsed = new URL(url);
        const path = parsed.pathname + parsed.search;
        requestsSeen.push(path);
        return await app.request(path, init);
      };
      const outcome = await resolveItemActionOutcome({
        endpoint: "https://router.example",
        token: "",
        itemId,
        item: staleProjection,
        actor: operator,
        generateKey: () => `stn.done-${requestsSeen.length + 1}`,
        fetchImpl,
      });

      expect(outcome).toBe("failed");
      expect(requestsSeen).toEqual([`/api/v1/items/${encodeURIComponent(itemId)}/complete`]);
      const after = await jsonBody(app.request(`/api/v1/items/${encodeURIComponent(itemId)}`));
      expect(after.item).toMatchObject({ status: "blocked", version: versionBefore });
    } finally {
      store.close();
    }
  });

  test("the pre-repair tray body shape is rejected by both production routes", async () => {
    const { store, app } = freshApp();
    try {
      const created = await jsonBody(app.request("/api/v1/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: "scrapbook", title: "Old body shape", actor: operator }),
      }), 201);
      for (const path of [
        `/api/v1/items/${created.item.id}/complete`,
        `/api/v1/items/${created.item.id}/unblock`,
      ]) {
        const response = await app.request(path, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": "legacy-shape" },
          body: JSON.stringify({ actor: operator, rationale: "Operator 1-tap Okay, Go confirmation" }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ code: "invalid_request" });
      }
    } finally {
      store.close();
    }
  });

  test("the gated fallback resolves a genuinely refused blocked transition through unblock semantics", async () => {
    const { store, app } = freshApp();
    try {
      const created = await jsonBody(app.request("/api/v1/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: "scrapbook",
          kind: "task",
          title: "Fallback target",
          actor: operator,
        }),
      }), 201);
      const itemId = created.item.id;
      await blockViaRouter(app, itemId);
      const projected = await projectedItem(app, itemId);

      // The real router cannot answer /complete with the canonical
      // blocked-refusal today; emulate exactly that refusal shape so the
      // gate's admit path stays bound to a real unblock route outcome.
      const requestsSeen: string[] = [];
      const bodies: unknown[] = [];
      const fetchImpl = async (url: string, init: RequestInit) => {
        const parsed = new URL(url);
        const path = parsed.pathname;
        requestsSeen.push(path);
        bodies.push(JSON.parse(String(init.body)));
        if (path.endsWith("/complete")) {
          return jsonResponse(409, { error: blockedRefusalSqlite.message, code: "conflict" });
        }
        return await app.request(path, init);
      };
      const outcome = await resolveItemActionOutcome({
        endpoint: "https://router.example",
        token: "",
        itemId,
        item: projected,
        actor: operator,
        generateKey: () => `stn.done-${requestsSeen.length + 1}`,
        fetchImpl,
      });

      expect(outcome).toBe("unblocked");
      expect((bodies[1] as { expectedClaimGeneration: number }).expectedClaimGeneration).toBe(projected.claimGeneration);
      const after = await jsonBody(app.request(`/api/v1/items/${encodeURIComponent(itemId)}`));
      expect(after.item).toMatchObject({ status: "ready", claimGeneration: projected.claimGeneration + 1 });
    } finally {
      store.close();
    }
  });
});

async function projectedItem(app: ReturnType<typeof createServerApp>, itemId: string) {
  const listed = await jsonBody(app.request("/api/v1/items?project=scrapbook"));
  const projected = listed.items.find((entry: { id: string }) => entry.id === itemId);
  if (!projected) throw new Error(`item ${itemId} missing from projection`);
  return projected;
}

async function blockViaRouter(app: ReturnType<typeof createServerApp>, itemId: string) {
  const detail = await jsonBody(app.request(`/api/v1/items/${encodeURIComponent(itemId)}`));
  const response = await app.request(`/api/v1/items/${encodeURIComponent(itemId)}/block`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actor: operator,
      expectedClaimGeneration: detail.item.claimGeneration,
      reason: "Waiting on an external decision",
    }),
  });
  if (response.status !== 200) {
    throw new Error(`block failed: HTTP ${response.status} ${JSON.stringify(await response.json())}`);
  }
  return response;
}

async function jsonBody(responseValue: Response | Promise<Response>, expectedStatus?: number): Promise<any> {
  const response = await responseValue;
  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    throw new Error(`expected HTTP ${expectedStatus}, got ${response.status}: ${JSON.stringify(await response.json())}`);
  }
  return await response.json();
}
