import { describe, expect, test } from "bun:test";
import {
  compileProjectBrief,
  type CompileProjectBriefInput,
  type ProjectBriefArtifactInput,
} from "../src/briefs.ts";
import type { Item } from "../src/store.ts";

function item(): Item {
  return {
    id: "item-ready",
    project: "scrapbook",
    kind: "task",
    title: "Safe work",
    summary: null,
    status: "ready",
    priority: 80,
    nextAction: "Continue safely.",
    claimedBy: null,
    claimExpiresAt: null,
    claimGeneration: 0,
    version: 1,
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:01:00.000Z",
  };
}

function artifact(): ProjectBriefArtifactInput {
  return {
    project: "scrapbook",
    id: "artifact-1",
    itemId: "item-ready",
    itemTitle: "Safe work",
    actorId: "actor-1",
    kind: "log",
    label: "Safe evidence",
    uri: "file:///tmp/safe-evidence.txt",
    createdAt: "2026-08-06T00:02:00.000Z",
  };
}

describe("pure project brief caller-graph inspection", () => {
  test("projects one detached graph without ordinary caller reads", () => {
    const counters = {
      envelope: 0,
      itemArray: 0,
      item: 0,
      artifactArray: 0,
      artifact: 0,
    };
    const hostileItem = new Proxy(item(), {
      get(target, key, receiver) {
        counters.item += 1;
        if (key === "project") return "foreign-project";
        if (key === "title") return "Substituted title";
        return Reflect.get(target, key, receiver);
      },
    });
    const hostileArtifact = new Proxy(artifact(), {
      get(target, key, receiver) {
        counters.artifact += 1;
        if (key === "project") return "foreign-project";
        if (key === "itemTitle") return "Substituted title";
        return Reflect.get(target, key, receiver);
      },
    });
    const hostileItems = new Proxy([hostileItem], {
      get(target, key, receiver) {
        counters.itemArray += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const hostileArtifacts = new Proxy([hostileArtifact], {
      get(target, key, receiver) {
        counters.artifactArray += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const input: CompileProjectBriefInput = {
      project: "scrapbook",
      generatedAt: "2026-08-06T00:03:00.000Z",
      items: hostileItems,
      recentArtifacts: hostileArtifacts,
      limit: 10,
    };
    const hostileInput = new Proxy(input, {
      get(target, key, receiver) {
        counters.envelope += 1;
        if (key === "project") return "foreign-project";
        return Reflect.get(target, key, receiver);
      },
    });

    const brief = compileProjectBrief(hostileInput);

    expect(brief).toMatchObject({
      project: "scrapbook",
      ready: [{ id: "item-ready", title: "Safe work" }],
      recentArtifacts: [{ id: "artifact-1", itemTitle: "Safe work" }],
    });
    expect(counters).toEqual({
      envelope: 0,
      itemArray: 0,
      item: 0,
      artifactArray: 0,
      artifact: 0,
    });
  });

  test("rejects oversized input arrays before inspecting any entry", () => {
    const inspected = { items: 0, artifacts: 0 };
    const oversizedItems = new Proxy(new Array(10_001), {
      getOwnPropertyDescriptor(target, key) {
        if (typeof key === "string" && /^(?:0|[1-9][0-9]*)$/.test(key)) {
          inspected.items += 1;
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    }) as unknown as readonly Item[];
    const oversizedArtifacts = new Proxy(new Array(10_001), {
      getOwnPropertyDescriptor(target, key) {
        if (typeof key === "string" && /^(?:0|[1-9][0-9]*)$/.test(key)) {
          inspected.artifacts += 1;
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    }) as unknown as readonly ProjectBriefArtifactInput[];

    expect(() => compileProjectBrief({
      project: "scrapbook",
      generatedAt: "2026-08-06T00:03:00.000Z",
      items: oversizedItems,
      recentArtifacts: [],
    })).toThrow("Project brief items must contain at most 10000 entries");
    expect(inspected.items).toBe(0);

    expect(() => compileProjectBrief({
      project: "scrapbook",
      generatedAt: "2026-08-06T00:03:00.000Z",
      items: [],
      recentArtifacts: oversizedArtifacts,
    })).toThrow("Project brief artifacts must contain at most 10000 entries");
    expect(inspected.artifacts).toBe(0);
  });
});
