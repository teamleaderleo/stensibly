import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };

let store: StensiblyStore;
let app: ReturnType<typeof createServerApp>;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  app = createServerApp(store);
});

afterEach(() => store.close());

describe("local item coordination compatibility", () => {
  test("returns explicit empty coordination collections", async () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Keep local detail compatible",
      priority: 50,
      actor: leo,
    });

    const response = await app.request(`/api/v1/items/${encodeURIComponent(item.id)}`);
    expect(response.status).toBe(200);
    const detail = await response.json() as {
      dependencies: unknown[];
      reservations: unknown[];
      runs: unknown[];
    };
    expect(detail.dependencies).toEqual([]);
    expect(detail.reservations).toEqual([]);
    expect(detail.runs).toEqual([]);
  });
});
