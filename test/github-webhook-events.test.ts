import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiToken } from "../src/auth.ts";
import {
  ProviderEventCapacityError,
  SqliteProviderEventStore,
} from "../src/provider-events.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const secret = "github-webhook-test-secret";
const fixedNow = Date.parse("2026-07-27T13:00:00.000Z");
const tempDirectories: string[] = [];

afterEach(async () => {
  while (tempDirectories.length) {
    await rm(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("GitHub provider event intake", () => {
  test("deduplicates signed content across delivery identities, survives restart, and acknowledges once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stensibly-provider-events-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "events.sqlite");

    let store = new StensiblyStore(databasePath);
    const adminToken = createApiToken(store, {
      name: "Administrator",
      scopes: ["admin"],
      projects: null,
    }).token;
    let app = createServerApp(store, {
      githubWebhook: { secret, now: () => fixedNow },
    });
    const body = JSON.stringify(reviewPayload());
    let storeClosed = false;

    try {
      const accepted = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(body, "delivery-1"),
        body,
      });
      expect(accepted.status).toBe(202);
      const acceptedJson = await accepted.json() as {
        duplicate: boolean;
        event: {
          id: string;
          externalObjectId: string;
          routingLevel: string;
          status: string;
          repository: string;
          subjectNumber: number;
          revision: string;
          acknowledgedBy: string | null;
        };
      };
      expect(acceptedJson).toMatchObject({
        duplicate: false,
        event: {
          externalObjectId: "987654321",
          routingLevel: "record",
          status: "pending",
          repository: "teamleaderleo/stensibly",
          subjectNumber: 327,
          revision: "0123456789abcdef0123456789abcdef01234567",
          acknowledgedBy: null,
        },
      });

      const exactDeliveryReplay = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(body, "delivery-1"),
        body,
      });
      expect(exactDeliveryReplay.status).toBe(200);
      expect(await exactDeliveryReplay.json()).toMatchObject({
        duplicate: true,
        event: { id: acceptedJson.event.id },
      });

      const freshDeliveryReplay = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(body, "delivery-2"),
        body,
      });
      expect(freshDeliveryReplay.status).toBe(200);
      expect(await freshDeliveryReplay.json()).toMatchObject({
        duplicate: true,
        event: { id: acceptedJson.event.id, deliveryId: "delivery-1" },
      });

      store.close();
      storeClosed = true;
      store = new StensiblyStore(databasePath);
      storeClosed = false;
      app = createServerApp(store, {
        githubWebhook: { secret, now: () => fixedNow + 1_000 },
      });

      const alteredReplayBody = JSON.stringify(reviewPayload({ action: "dismissed" }));
      const reservedDeliveryConflict = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(alteredReplayBody, "delivery-2"),
        body: alteredReplayBody,
      });
      expect(reservedDeliveryConflict.status).toBe(409);
      expect(await reservedDeliveryConflict.json()).toMatchObject({ code: "conflict" });

      const pending = await app.request(
        "/api/v1/provider-events?status=pending&limit=10",
        { headers: bearer(adminToken) },
      );
      expect(pending.status).toBe(200);
      expect(await pending.json()).toMatchObject({
        events: [{ id: acceptedJson.event.id, status: "pending" }],
      });

      const acknowledged = await app.request(
        `/api/v1/provider-events/${encodeURIComponent(acceptedJson.event.id)}/acknowledge`,
        {
          method: "POST",
          headers: {
            ...bearer(adminToken),
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );
      expect(acknowledged.status).toBe(200);
      expect(await acknowledged.json()).toMatchObject({
        event: {
          id: acceptedJson.event.id,
          status: "acknowledged",
          acknowledgedBy: "api_token:Administrator",
          acknowledgedAt: "2026-07-27T13:00:01.000Z",
        },
      });

      const exactReplay = await app.request(
        `/api/v1/provider-events/${encodeURIComponent(acceptedJson.event.id)}/acknowledge`,
        {
          method: "POST",
          headers: {
            ...bearer(adminToken),
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );
      expect(exactReplay.status).toBe(200);

      const noPending = await app.request(
        "/api/v1/provider-events?status=pending",
        { headers: bearer(adminToken) },
      );
      expect(await noPending.json()).toEqual({ events: [] });
    } finally {
      if (!storeClosed) store.close();
    }
  });

  test("bounds retained delivery identities while keeping one logical event", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const events = new SqliteProviderEventStore(store, { maxStoredEvents: 2 });
      const input = {
        deliveryId: "delivery-primary",
        payloadDigest: "a".repeat(64),
        externalObjectId: "review-primary",
        repository: "teamleaderleo/stensibly",
        subjectNumber: 327,
        action: "submitted",
        revision: "a".repeat(40),
        actor: "reviewer",
        summary: "Review primary",
        receivedAt: "2026-07-27T13:00:00.000Z",
      };

      const first = events.ingestGitHubPullRequestReview(input);
      const replay = events.ingestGitHubPullRequestReview({
        ...input,
        deliveryId: "delivery-alias-1",
      });
      expect(first.duplicate).toBe(false);
      expect(replay).toMatchObject({ duplicate: true, event: { id: first.event.id } });
      expect(events.list()).toHaveLength(1);
      expect(store.db.query<{ total: number }, []>(`
        SELECT COUNT(*) AS total FROM provider_event_deliveries
      `).get()?.total).toBe(2);

      expect(() => events.ingestGitHubPullRequestReview({
        ...input,
        deliveryId: "delivery-alias-2",
      })).toThrow(ProviderEventCapacityError);
      expect(events.list()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("rejects invalid signatures and altered reuse of one delivery identity", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const app = createServerApp(store, {
        githubWebhook: { secret, now: () => fixedNow },
      });
      const body = JSON.stringify(reviewPayload());

      const invalid = await app.request("/webhooks/github", {
        method: "POST",
        headers: {
          ...signedHeaders(body, "delivery-conflict"),
          "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
        },
        body,
      });
      expect(invalid.status).toBe(401);
      expect(await invalid.json()).toMatchObject({ code: "unauthorized" });

      const accepted = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(body, "delivery-conflict"),
        body,
      });
      expect(accepted.status).toBe(202);

      const alteredBody = JSON.stringify(reviewPayload({ action: "dismissed" }));
      const conflict = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(alteredBody, "delivery-conflict"),
        body: alteredBody,
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ code: "conflict" });
    } finally {
      store.close();
    }
  });

  test("stops and cancels a chunked body immediately above the physical cap", async () => {
    const store = new StensiblyStore(":memory:");
    let pulls = 0;
    let cancelled = false;
    try {
      const app = createServerApp(store, {
        githubWebhook: { secret, maxBodyBytes: 1_024, now: () => fixedNow },
      });
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls > 50) {
            controller.close();
            return;
          }
          controller.enqueue(new TextEncoder().encode("x".repeat(600)));
        },
        cancel() {
          cancelled = true;
        },
      });
      const request = new Request("http://localhost/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "delivery-stream",
          "x-github-event": "pull_request_review",
          "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
        },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" });

      const response = await app.fetch(request);
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ code: "payload_too_large" });
      expect(cancelled).toBe(true);
      expect(pulls).toBeLessThan(50);
      expect(new SqliteProviderEventStore(store).list()).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("ignores other signed event classes and rejects malformed or declared-oversized reviews", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const app = createServerApp(store, {
        githubWebhook: { secret, maxBodyBytes: 1_024, now: () => fixedNow },
      });

      const pingBody = JSON.stringify({ zen: "Keep it logically awesome." });
      const ping = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(pingBody, "delivery-ping", "ping"),
        body: pingBody,
      });
      expect(ping.status).toBe(202);
      expect(await ping.json()).toEqual({
        accepted: false,
        ignored: true,
        reason: "unsupported_event_type",
      });

      const malformedBody = JSON.stringify({ action: "submitted" });
      const malformed = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(malformedBody, "delivery-malformed"),
        body: malformedBody,
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({ code: "invalid_request" });

      const unsupportedActionBody = JSON.stringify(reviewPayload({ action: "created" }));
      const unsupportedAction = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(unsupportedActionBody, "delivery-action"),
        body: unsupportedActionBody,
      });
      expect(unsupportedAction.status).toBe(400);

      const wrongMediaType = await app.request("/webhooks/github", {
        method: "POST",
        headers: {
          ...signedHeaders(malformedBody, "delivery-media"),
          "content-type": "text/plain",
        },
        body: malformedBody,
      });
      expect(wrongMediaType.status).toBe(415);

      const oversizedBody = JSON.stringify({ padding: "x".repeat(2_000) });
      const oversized = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(oversizedBody, "delivery-large"),
        body: oversizedBody,
      });
      expect(oversized.status).toBe(413);
    } finally {
      store.close();
    }
  });

  test("requires authenticated admin access even when global HTTP auth is disabled", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const readToken = createApiToken(store, {
        name: "Reader",
        scopes: ["read"],
        projects: null,
      });
      const adminToken = createApiToken(store, {
        name: "Administrator",
        scopes: ["admin"],
        projects: null,
      });
      const app = createServerApp(store, {
        httpAuth: { required: false },
        githubWebhook: { secret, now: () => fixedNow },
      });
      const body = JSON.stringify(reviewPayload());

      const accepted = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(body, "delivery-auth"),
        body,
      });
      expect(accepted.status).toBe(202);

      const anonymous = await app.request("/api/v1/provider-events");
      expect(anonymous.status).toBe(401);

      const reader = await app.request("/api/v1/provider-events", {
        headers: bearer(readToken.token),
      });
      expect(reader.status).toBe(403);

      const administrator = await app.request("/api/v1/provider-events", {
        headers: bearer(adminToken.token),
      });
      expect(administrator.status).toBe(200);
      const administratorJson = await administrator.json() as {
        events: Array<{ id: string }>;
      };
      const eventId = administratorJson.events[0]!.id;

      const forgedActor = await app.request(
        `/api/v1/provider-events/${encodeURIComponent(eventId)}/acknowledge`,
        {
          method: "POST",
          headers: {
            ...bearer(adminToken.token),
            "content-type": "application/json",
          },
          body: JSON.stringify({ actor: "Nightjar" }),
        },
      );
      expect(forgedActor.status).toBe(400);

      const acknowledged = await app.request(
        `/api/v1/provider-events/${encodeURIComponent(eventId)}/acknowledge`,
        {
          method: "POST",
          headers: {
            ...bearer(adminToken.token),
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );
      expect(acknowledged.status).toBe(200);
      expect(await acknowledged.json()).toMatchObject({
        event: {
          id: eventId,
          status: "acknowledged",
          acknowledgedBy: "api_token:Administrator",
        },
      });
    } finally {
      store.close();
    }
  });

  test("returns a fixed non-secret 500 for unexpected persistence failures", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const app = createServerApp(store, {
        githubWebhook: { secret, now: () => fixedNow },
      });
      store.db.exec("DROP TABLE provider_events");
      const body = JSON.stringify(reviewPayload());
      const response = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(body, "delivery-storage-failure"),
        body,
      });

      expect(response.status).toBe(500);
      const result = await response.json() as { error: string; code: string };
      expect(result).toEqual({
        error: "Provider event storage failed",
        code: "backend_failure",
      });
      expect(JSON.stringify(result)).not.toContain("provider_events");
      expect(JSON.stringify(result)).not.toContain("SQLite");
    } finally {
      store.close();
    }
  });

  test("preserves pending rows, prunes acknowledged rows for capacity, and survives restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stensibly-provider-capacity-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "events.sqlite");
    let store = new StensiblyStore(databasePath);
    let events = new SqliteProviderEventStore(store, {
      maxStoredEvents: 2,
      acknowledgedRetentionMs: 0,
    });
    let closed = false;
    try {
      const first = ingest(events, "first", "a", "2026-07-27T13:00:00.000Z");
      const second = ingest(events, "second", "b", "2026-07-27T13:01:00.000Z");
      expect(() => ingest(
        events,
        "blocked",
        "c",
        "2026-07-27T13:02:00.000Z",
      )).toThrow(ProviderEventCapacityError);
      expect(events.list({ status: "pending" }).map((event) => event.id)).toEqual([
        first.id,
        second.id,
      ]);

      events.acknowledge(first.id, "api_token:Administrator", "2026-07-27T13:02:00.000Z");
      const third = ingest(events, "third", "c", "2026-07-27T13:03:00.000Z");
      expect(events.list({ status: "pending" }).map((event) => event.id)).toEqual([
        second.id,
        third.id,
      ]);
      expect(events.list({ status: "acknowledged" })).toEqual([]);

      store.close();
      closed = true;
      store = new StensiblyStore(databasePath);
      closed = false;
      events = new SqliteProviderEventStore(store, {
        maxStoredEvents: 2,
        acknowledgedRetentionMs: 0,
      });
      expect(events.list({ status: "pending" }).map((event) => event.id)).toEqual([
        second.id,
        third.id,
      ]);
    } finally {
      if (!closed) store.close();
    }
  });

  test("serves pending records oldest first so later arrivals cannot starve them", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const events = new SqliteProviderEventStore(store);
      const older = ingest(events, "older", "a", "2026-07-27T13:00:00.000Z");
      const newer = ingest(events, "newer", "b", "2026-07-27T13:01:00.000Z");

      expect(events.list({ status: "pending", limit: 1 })).toEqual([older]);
      events.acknowledge(older.id, "api_token:Administrator", "2026-07-27T13:02:00.000Z");
      expect(events.list({ status: "pending", limit: 1 })).toEqual([newer]);
    } finally {
      store.close();
    }
  });

  test("fails closed for unsupported backend configuration and weak secrets", () => {
    const store = new StensiblyStore(":memory:");
    try {
      expect(() => createServerApp(store, {
        backend: "convex",
        githubWebhook: { secret },
      })).toThrow("requires the SQLite backend");
      expect(() => createServerApp(store, {
        githubWebhook: { secret: "short" },
      })).toThrow("between 16 and 1024 UTF-8 bytes");
    } finally {
      store.close();
    }
  });
});

function ingest(
  events: SqliteProviderEventStore,
  suffix: string,
  digestCharacter: string,
  receivedAt: string,
) {
  return events.ingestGitHubPullRequestReview({
    deliveryId: `delivery-${suffix}`,
    payloadDigest: digestCharacter.repeat(64),
    externalObjectId: `review-${suffix}`,
    repository: "teamleaderleo/stensibly",
    subjectNumber: 327,
    action: "submitted",
    revision: digestCharacter.repeat(40),
    actor: "reviewer",
    summary: `Review ${suffix}`,
    receivedAt,
  }).event;
}

function reviewPayload(overrides: { action?: string } = {}) {
  return {
    action: overrides.action ?? "submitted",
    repository: { full_name: "teamleaderleo/stensibly" },
    pull_request: { number: 327 },
    review: {
      id: 987654321,
      commit_id: "0123456789abcdef0123456789abcdef01234567",
      state: "approved",
    },
    sender: { login: "reviewer" },
  };
}

function signedHeaders(
  body: string,
  deliveryId: string,
  eventType = "pull_request_review",
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-github-delivery": deliveryId,
    "x-github-event": eventType,
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
