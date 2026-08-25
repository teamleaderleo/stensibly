import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectRenderedBlockedIds,
  reconcileBatchTargets,
  summarizeBatchResults,
} from "../site/decision-tray-batch.js";

const REPO_ROOT = join(import.meta.dir, "..");

function item(id: string, project: string, status: string) {
  return { id, project, status };
}

describe("decision tray batch scope", () => {
  test("collects exactly the blocked ids rendered in the visible view", () => {
    const visible = [
      item("v-block-1", "atlas", "blocked"),
      item("v-active", "atlas", "active"),
      item("v-block-2", "atlas", "blocked"),
      item("v-done", "atlas", "done"),
    ];
    expect(collectRenderedBlockedIds(visible)).toEqual(["v-block-1", "v-block-2"]);
  });

  test("never includes hidden-project blockers even when they are blocked globally", () => {
    const visible = [item("visible-blocker", "atlas", "blocked")];
    const hiddenBlockers = [item("hidden-blocker", "orbit", "blocked")];
    const rendered = collectRenderedBlockedIds(visible);

    const globallyBlocked = new Set([...visible, ...hiddenBlockers]
      .filter((entry) => entry.status === "blocked")
      .map((entry) => entry.id));
    const { targets } = reconcileBatchTargets(rendered, (id) => globallyBlocked.has(id));

    expect(targets).toEqual(["visible-blocker"]);
    expect(targets).not.toContain("hidden-blocker");
  });

  test("drops rendered ids that are no longer visible blockers between render and click", () => {
    const rendered = ["still-blocked", "now-done", "filtered-away"];
    // Current state: one item resolved, one moved out of the selected filter.
    const currentVisibleBlocked = new Set(["still-blocked"]);
    const { targets, stale } = reconcileBatchTargets(
      rendered,
      (id) => currentVisibleBlocked.has(id),
    );
    expect(targets).toEqual(["still-blocked"]);
    expect(stale).toEqual(["now-done", "filtered-away"]);
  });

  test("rejects malformed inputs instead of guessing scope", () => {
    expect(() => collectRenderedBlockedIds("items" as unknown)).toThrow("must be an array");
    expect(() => collectRenderedBlockedIds([{ id: "", status: "blocked" }] as unknown)).toThrow("missing its id");
    expect(() => collectRenderedBlockedIds([null] as unknown)).toThrow("item records");
    expect(() => reconcileBatchTargets("ids" as unknown, () => true)).toThrow("must be an array");
    expect(() => reconcileBatchTargets(["x"], undefined as unknown as (id: string) => boolean)).toThrow(
      "visibility check",
    );
    expect(() => reconcileBatchTargets([""], () => true)).toThrow("non-empty strings");
  });
});

describe("batch outcome truthfulness", () => {
  test("reports completed and unblocked resolutions separately", () => {
    const summary = summarizeBatchResults([
      { id: "a", outcome: "completed" },
      { id: "b", outcome: "unblocked" },
    ]);
    expect(summary.completed).toBe(1);
    expect(summary.unblocked).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.allResolved).toBe(true);
    expect(summary.summaryLine).toContain("1 completed");
    expect(summary.summaryLine).toContain("1 unblocked");
    expect(summary.summaryLine.toLowerCase()).not.toContain("failed");
  });

  test("a completion-only batch reads as done, not partially cleared", () => {
    const summary = summarizeBatchResults([
      { id: "a", outcome: "completed" },
      { id: "b", outcome: "completed" },
    ]);
    expect(summary.summaryLine).toContain("Completed 2 of 2");
    expect(summary.allResolved).toBe(true);
  });

  test("partial failure is never aggregate success", () => {
    const summary = summarizeBatchResults([
      { id: "a", outcome: "completed" },
      { id: "b", outcome: "failed" },
      { id: "c", outcome: "failed" },
    ]);
    expect(summary.resolved).toBe(1);
    expect(summary.failed).toBe(2);
    expect(summary.allResolved).toBe(false);
    expect(summary.summaryLine).toContain("Partial clear");
    expect(summary.summaryLine).toContain("2 failed");
  });

  test("stale rendered items are counted as untouched, not successful", () => {
    const summary = summarizeBatchResults([{ id: "a", outcome: "unblocked" }], { staleCount: 2 });
    expect(summary.staleCount).toBe(2);
    expect(summary.attempted).toBe(1);
    expect(summary.allResolved).toBe(false);
    expect(summary.summaryLine).toContain("2 no longer blocked here");
  });

  test("an empty tray states there was nothing to clear", () => {
    const summary = summarizeBatchResults([]);
    expect(summary.attempted).toBe(0);
    expect(summary.summaryLine).toContain("No blocked items");
  });

  test("results without honest outcomes are rejected rather than inflated", () => {
    expect(() => summarizeBatchResults([{ id: "a", outcome: "approved" } as never])).toThrow(
      "completed/unblocked/failed",
    );
    expect(() => summarizeBatchResults([{ outcome: "completed" } as never])).toThrow("item id");
    expect(() => summarizeBatchResults([], { staleCount: -1 })).toThrow("non-negative integer");
  });
});

describe("dashboard wiring keeps the batch on the rendered visible set", () => {
  const appJs = readFileSync(join(REPO_ROOT, "site", "app.js"), "utf8");
  const html = readFileSync(join(REPO_ROOT, "site", "index.html"), "utf8");

  test("the click handler reconciles the captured rendered tray ids against current visibility", () => {
    expect(appJs).toContain("trayRenderedBlockedIds = collectRenderedBlockedIds(visible)");
    expect(appJs).toContain("reconcileBatchTargets(trayRenderedBlockedIds, isStillVisibleBlockedItem)");
    expect(appJs).toContain("summarizeBatchResults(results, { staleCount: stale.length })");
  });

  test("no code path filters global items for a batch action anymore", () => {
    expect(appJs).not.toContain("items.filter((i) => i.status === 'blocked')");
    expect(appJs).not.toContain("items.filter((item) => item.status === 'blocked')");
  });

  test("per-item resolution reports its true final state", () => {
    expect(appJs).toContain("items.find((i) => i.id === itemId)");
    expect(appJs).toContain("return await resolveItemActionOutcome({");
    expect(appJs).toContain("resolveItemActionOutcome } from './item-resolution.js'");
    expect(appJs).toContain('Could not update');
    expect(appJs).not.toContain('showQuickToast(`Updated');
  });

  test("button label and progress copy match the implementation", () => {
    expect(html).toContain(">⚡ Clear Blockers</button>");
    expect(html).not.toContain("Mark All Done");
    expect(appJs).toContain("TRAY_BATCH_PROGRESS = 'Clearing…'");
    expect(appJs).toContain("button.textContent = TRAY_BATCH_LABEL;");
  });
});
