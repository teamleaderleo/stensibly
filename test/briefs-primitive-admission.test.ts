import { describe, expect, test } from "bun:test";
import {
  compileProjectBrief,
  type CompileProjectBriefInput,
} from "../src/briefs.ts";
import type { Item } from "../src/store.ts";

type BriefInput = Parameters<typeof compileProjectBrief>[0];

function item(id: string, priority = 50): Item {
  return {
    id,
    project: "scrapbook",
    kind: "task",
    title: `Item ${id}`,
    summary: null,
    status: "ready",
    priority,
    nextAction: null,
    claimedBy: null,
    claimExpiresAt: null,
    claimGeneration: 0,
    version: 1,
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:01:00.000Z",
  };
}

function compile(items: BriefInput["items"]): void {
  compileProjectBrief({
    project: "scrapbook",
    generatedAt: "2026-08-06T00:03:00.000Z",
    items,
    recentArtifacts: [],
  });
}

describe("project brief detached primitive admission", () => {
  test("rejects non-primitive priority before coercion", () => {
    let coercions = 0;
    const hostilePriority = {
      [Symbol.toPrimitive]() {
        coercions += 1;
        return 90;
      },
      valueOf() {
        coercions += 1;
        return 90;
      },
    };
    const hostile = {
      ...item("hostile-priority"),
      priority: hostilePriority,
    } as unknown as Item;

    expect(() => compile([
      hostile,
      item("comparison", 80),
    ])).toThrow(/Project brief item field priority/i);
    expect(coercions).toBe(0);
  });

  test("rejects non-primitive status before property-key coercion", () => {
    let coercions = 0;
    const hostileStatus = {
      [Symbol.toPrimitive]() {
        coercions += 1;
        return "ready";
      },
      toString() {
        coercions += 1;
        return "ready";
      },
    };
    const hostile = {
      ...item("hostile-status"),
      status: hostileStatus,
    } as unknown as Item;

    expect(() => compile([hostile])).toThrow(/Project brief item field status/i);
    expect(coercions).toBe(0);
  });

  test("rejects non-primitive artifact text before retention", () => {
    let coercions = 0;
    const hostileLabel = {
      [Symbol.toPrimitive]() {
        coercions += 1;
        return "Hostile evidence";
      },
      toString() {
        coercions += 1;
        return "Hostile evidence";
      },
    };
    const boundItem = item("artifact-item");
    const input: CompileProjectBriefInput = {
      project: "scrapbook",
      generatedAt: "2026-08-06T00:03:00.000Z",
      items: [boundItem],
      recentArtifacts: [{
        project: "scrapbook",
        id: "artifact-hostile",
        itemId: boundItem.id,
        itemTitle: boundItem.title,
        actorId: "actor-hostile",
        kind: "log",
        label: hostileLabel,
        uri: "file:///tmp/evidence.txt",
        createdAt: "2026-08-06T00:02:00.000Z",
      } as unknown as BriefInput["recentArtifacts"][number]],
    };

    expect(() => compileProjectBrief(input)).toThrow(
      /Project brief artifact field label/i,
    );
    expect(coercions).toBe(0);
  });
});
