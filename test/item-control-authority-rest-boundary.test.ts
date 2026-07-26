import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const actor = { id: "agent:writer", name: "Writer", kind: "agent" as const };

let store: StensiblyStore;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
});

afterEach(() => store.close());

describe("legacy REST item event authority boundary", () => {
  test("rejects reserved lifecycle types while ordinary events remain recordable", async () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Protect legacy event writes",
      priority: 70,
      actor,
    });
    const app = createServerApp(store);

    for (const type of ["claim.created", "run.queued"]) {
      const response = await app.request(`/api/items/${encodeURIComponent(item.id)}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actor,
          type,
          payload: {
            source: "supervisor_dispatch",
            generation: 1,
            runId: "run_forged",
          },
        }),
      });
      expect(response.status).toBe(400);
      const body = await response.json() as {
        error: string;
        issues: Array<{ path: string; message: string }>;
      };
      expect(body.error).toBe("Invalid request");
      expect(body.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: "type",
          message: "Event type is reserved for internal lifecycle writers",
        }),
      ]));
    }

    const ordinary = await app.request(`/api/items/${encodeURIComponent(item.id)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor,
        type: "progress.recorded",
        payload: { summary: "Still public and non-authoritative." },
      }),
    });
    expect(ordinary.status).toBe(201);
    const ordinaryBody = await ordinary.json() as { event: { type: string } };
    expect(ordinaryBody.event.type).toBe("progress.recorded");

    const types = store.listEvents(item.id).map((event) => event.type);
    expect(types).toContain("progress.recorded");
    expect(types).not.toContain("claim.created");
    expect(types).not.toContain("run.queued");
  });
});
