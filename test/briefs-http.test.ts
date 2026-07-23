import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { StensiblyStore } from "../src/store.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };

let store: StensiblyStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  app = createApp(store);
});

afterEach(() => {
  store.close();
});

describe("project brief REST endpoint", () => {
  test("returns a compact brief", async () => {
    store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "First task",
      priority: 80,
      actor: leo,
    });
    store.createItem({
      project: "scrapbook",
      kind: "decision",
      title: "Keep the brief deterministic",
      priority: 40,
      actor: leo,
    });

    const response = await app.request("/api/projects/scrapbook/brief?limit=1");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      brief: {
        project: string;
        counts: { total: number };
        ready: Array<{ title: string }>;
        knowledge: Array<{ title: string }>;
      };
    };
    expect(body.brief.project).toBe("scrapbook");
    expect(body.brief.counts.total).toBe(2);
    expect(body.brief.ready).toHaveLength(1);
    expect(body.brief.ready[0]?.title).toBe("First task");
    expect(body.brief.knowledge).toEqual([
      expect.objectContaining({ title: "Keep the brief deterministic" }),
    ]);
  });

  test("returns useful client errors", async () => {
    const invalidLimit = await app.request("/api/projects/scrapbook/brief?limit=0");
    expect(invalidLimit.status).toBe(400);

    const missingProject = await app.request("/api/projects/missing/brief");
    expect(missingProject.status).toBe(404);
  });
});
