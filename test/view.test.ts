import { describe, expect, test } from "bun:test";
import type { Item } from "../src/store.ts";
import { renderBoard } from "../src/view.ts";

const baseItem: Item = {
  id: "item-1",
  project: "scrapbook",
  kind: "task",
  title: "Inspect the dashboard",
  summary: null,
  status: "ready",
  priority: 50,
  nextAction: "Open the page.",
  claimedBy: null,
  claimExpiresAt: null,
  version: 1,
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T01:00:00.000Z",
};

describe("dashboard view", () => {
  test("renders status totals, active actors, projects, and lease metadata", () => {
    const items: Item[] = [
      baseItem,
      {
        ...baseItem,
        id: "item-2",
        project: "api",
        title: "Remote MCP",
        status: "active",
        claimedBy: "coding-agent",
        claimExpiresAt: "2026-07-23T02:00:00.000Z",
      },
      {
        ...baseItem,
        id: "item-3",
        title: "Waiting for credentials",
        status: "blocked",
      },
      {
        ...baseItem,
        id: "item-4",
        title: "Already survived",
        status: "done",
      },
    ];

    const html = renderBoard(items);

    expect(html).toContain("Agents in the walls");
    expect(html).toContain("coding-agent");
    expect(html).toContain('value="api"');
    expect(html).toContain('data-expires="2026-07-23T02:00:00.000Z"');
    expect(html).toContain("auto · on");
    expect(html).toContain("Ready");
    expect(html).toContain("Active");
    expect(html).toContain("Blocked");
    expect(html).toContain("Done");
  });

  test("escapes item content and omits archived work", () => {
    const html = renderBoard([
      {
        ...baseItem,
        title: '<script>alert("nope")</script>',
        summary: "A & B",
      },
      {
        ...baseItem,
        id: "archived",
        title: "Should not appear",
        status: "archived",
      },
    ]);

    expect(html).not.toContain('<script>alert("nope")</script>');
    expect(html).toContain("&lt;script&gt;alert(&quot;nope&quot;)&lt;/script&gt;");
    expect(html).toContain("A &amp; B");
    expect(html).not.toContain("Should not appear");
  });
});
