import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { StensiblyStore } from "../src/store.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const browserAgent = {
  id: "browser-agent",
  name: "Browser Agent",
  kind: "agent" as const,
};

let store: StensiblyStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  app = createApp(store);
});

afterEach(() => {
  store.close();
});

describe("REST work transitions", () => {
  test("hands off, blocks, and unblocks work", async () => {
    const createdResponse = await app.request("/api/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "scrapbook",
        kind: "task",
        title: "Exercise the HTTP door",
        actor: leo,
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await readItem(createdResponse);

    const claimResponse = await app.request(`/api/items/${created.id}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: browserAgent, leaseSeconds: 900 }),
    });
    expect(claimResponse.status).toBe(200);

    const handoffResponse = await app.request(`/api/items/${created.id}/handoff`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "rest-handoff-1",
      },
      body: JSON.stringify({
        actor: browserAgent,
        summary: "The endpoint works.",
        nextAction: "Review the result.",
        toActorId: leo.id,
      }),
    });
    expect(handoffResponse.status).toBe(200);
    expect(await readItem(handoffResponse)).toMatchObject({
      status: "ready",
      summary: "The endpoint works.",
      nextAction: "Review the result.",
      claimedBy: null,
    });

    const blockResponse = await app.request(`/api/items/${created.id}/block`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: leo,
        reason: "Waiting for a review.",
        nextAction: "Continue after review.",
      }),
    });
    expect(blockResponse.status).toBe(200);
    expect(await readItem(blockResponse)).toMatchObject({
      status: "blocked",
      summary: "Waiting for a review.",
    });

    const blockedClaim = await app.request(`/api/items/${created.id}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: browserAgent, leaseSeconds: 900 }),
    });
    expect(blockedClaim.status).toBe(409);

    const unblockResponse = await app.request(`/api/items/${created.id}/unblock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: leo,
        nextAction: "The review landed; continue.",
      }),
    });
    expect(unblockResponse.status).toBe(200);
    expect(await readItem(unblockResponse)).toMatchObject({
      status: "ready",
      nextAction: "The review landed; continue.",
    });

    const detailResponse = await app.request(`/api/items/${created.id}`);
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json() as {
      events: Array<{ type: string }>;
      artifacts: unknown[];
    };
    expect(detail.artifacts).toEqual([]);
    expect(detail.events.map((event) => event.type)).toEqual([
      "item.created",
      "claim.created",
      "work.handed_off",
      "work.blocked",
      "work.unblocked",
    ]);
  });

  test("attaches and lists artifact references", async () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Expose the output trail",
      priority: 50,
      actor: leo,
    });

    const attach = () => app.request(`/api/items/${item.id}/artifacts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "rest-artifact-1",
      },
      body: JSON.stringify({
        actor: browserAgent,
        kind: "log",
        label: "CI output",
        uri: "file:///tmp/test-output.txt",
        mimeType: "text/plain",
        metadata: { run: 42 },
      }),
    });

    const firstResponse = await attach();
    expect(firstResponse.status).toBe(201);
    const firstBody = await firstResponse.json() as {
      artifact: { id: string; actorId: string; metadata: Record<string, unknown> };
    };
    expect(firstBody.artifact).toMatchObject({
      actorId: browserAgent.id,
      metadata: { run: 42 },
    });

    const retryResponse = await attach();
    expect(retryResponse.status).toBe(201);
    const retryBody = await retryResponse.json() as { artifact: { id: string } };
    expect(retryBody.artifact.id).toBe(firstBody.artifact.id);

    const listResponse = await app.request(`/api/items/${item.id}/artifacts`);
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json() as { artifacts: Array<{ id: string }> };
    expect(listBody.artifacts.map((artifact) => artifact.id)).toEqual([firstBody.artifact.id]);

    const detailResponse = await app.request(`/api/items/${item.id}`);
    const detail = await detailResponse.json() as {
      artifacts: Array<{ id: string }>;
      events: Array<{ type: string }>;
    };
    expect(detail.artifacts.map((artifact) => artifact.id)).toEqual([firstBody.artifact.id]);
    expect(detail.events.map((event) => event.type)).toEqual([
      "item.created",
      "artifact.attached",
    ]);
  });

  test("validates required handoff context", async () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Reject a vague handoff",
      priority: 50,
      actor: leo,
    });

    const response = await app.request(`/api/items/${item.id}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: leo, summary: "Missing the next action." }),
    });
    expect(response.status).toBe(400);
  });
});

async function readItem(response: Response): Promise<{
  id: string;
  status: string;
  summary: string | null;
  nextAction: string | null;
  claimedBy: string | null;
}> {
  const body = await response.json() as {
    item: {
      id: string;
      status: string;
      summary: string | null;
      nextAction: string | null;
      claimedBy: string | null;
    };
  };
  return body.item;
}
