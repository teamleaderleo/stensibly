import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiToken } from "../src/auth.ts";
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
  test("deduplicates a signed review, survives restart, and acknowledges once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stensibly-provider-events-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "events.sqlite");

    let store = new StensiblyStore(databasePath);
    let app = createServerApp(store, {
      githubWebhook: { secret, now: () => fixedNow },
    });
    const body = JSON.stringify(reviewPayload());

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
        routingLevel: "record",
        status: "pending",
        repository: "teamleaderleo/stensibly",
        subjectNumber: 327,
        revision: "0123456789abcdef0123456789abcdef01234567",
        acknowledgedBy: null,
      },
    });

    const replay = await app.request("/webhooks/github", {
      method: "POST",
      headers: signedHeaders(body, "delivery-1"),
      body,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      duplicate: true,
      event: { id: acceptedJson.event.id },
    });

    store.close();
    store = new StensiblyStore(databasePath);
    app = createServerApp(store, {
      githubWebhook: { secret, now: () => fixedNow + 1_000 },
    });

    try {
      const pending = await app.request("/api/v1/provider-events?status=pending&limit=10");
      expect(pending.status).toBe(200);
      expect(await pending.json()).toMatchObject({
        events: [{ id: acceptedJson.event.id, status: "pending" }],
      });

      const acknowledged = await app.request(
        `/api/v1/provider-events/${encodeURIComponent(acceptedJson.event.id)}/acknowledge`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ actor: "Nightjar" }),
        },
      );
      expect(acknowledged.status).toBe(200);
      expect(await acknowledged.json()).toMatchObject({
        event: {
          id: acceptedJson.event.id,
          status: "acknowledged",
          acknowledgedBy: "Nightjar",
          acknowledgedAt: "2026-07-27T13:00:01.000Z",
        },
      });

      const exactReplay = await app.request(
        `/api/v1/provider-events/${encodeURIComponent(acceptedJson.event.id)}/acknowledge`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ actor: "Nightjar" }),
        },
      );
      expect(exactReplay.status).toBe(200);

      const competingActor = await app.request(
        `/api/v1/provider-events/${encodeURIComponent(acceptedJson.event.id)}/acknowledge`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ actor: "Relay" }),
        },
      );
      expect(competingActor.status).toBe(409);
      expect(await competingActor.json()).toMatchObject({ code: "conflict" });

      const noPending = await app.request("/api/v1/provider-events?status=pending");
      expect(await noPending.json()).toEqual({ events: [] });
    } finally {
      store.close();
    }
  });

  test("rejects invalid signatures and conflicting delivery reuse", async () => {
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

      const listed = await app.request("/api/v1/provider-events");
      const listedJson = await listed.json() as { events: unknown[] };
      expect(listedJson.events).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("ignores other signed event classes and rejects malformed or oversized reviews", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const app = createServerApp(store, {
        githubWebhook: { secret, maxBodyBytes: 1024, now: () => fixedNow },
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

      const oversizedBody = JSON.stringify({ padding: "x".repeat(2_000) });
      const oversized = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(oversizedBody, "delivery-large"),
        body: oversizedBody,
      });
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toMatchObject({ code: "payload_too_large" });

      const listed = await app.request("/api/v1/provider-events");
      expect(await listed.json()).toEqual({ events: [] });
    } finally {
      store.close();
    }
  });

  test("keeps webhook authentication separate from principal-bound admin acknowledgement", async () => {
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
        httpAuth: { required: true },
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
      expect(administratorJson.events).toHaveLength(1);
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
      expect(await forgedActor.json()).toMatchObject({ code: "invalid_request" });

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
});

function reviewPayload(overrides: { action?: string } = {}) {
  return {
    action: overrides.action ?? "submitted",
    repository: { full_name: "teamleaderleo/stensibly" },
    pull_request: {
      number: 327,
      head: { sha: "0123456789abcdef0123456789abcdef01234567" },
    },
    review: { state: "approved" },
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
