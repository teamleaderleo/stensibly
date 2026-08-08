import { describe, expect, test } from "bun:test";
import {
  compileProjectDeltaBrief,
  renderProjectDeltaBriefMarkdown,
  type CompileProjectDeltaBriefInput,
  type ProjectDeltaBrief,
} from "../src/project-delta-brief.ts";

function input(): CompileProjectDeltaBriefInput {
  return {
    project: "alpha",
    fromCheckpoint: {
      id: "checkpoint:0",
      throughSequence: 0,
      observedAt: "2026-08-06T00:00:00.000Z",
    },
    toCheckpoint: {
      id: "checkpoint:1",
      throughSequence: 1,
      observedAt: "2026-08-06T00:01:00.000Z",
    },
    observations: [{
      observationId: "obs:1",
      sequence: 1,
      project: "alpha",
      subjectId: "work:1",
      kind: "work",
      state: "active",
      title: "Safe work",
      summary: null,
      observedAt: "2026-08-06T00:01:00.000Z",
      sourceReferences: ["source:1"],
    }],
    limit: 10,
  };
}

describe("project delta caller-graph inspection", () => {
  test("compiles a valid input without caller ownKeys", () => {
    let ownKeysCalls = 0;
    const hostile = new Proxy(input(), {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("caller ownKeys must remain unreachable");
      },
    });

    const result = compileProjectDeltaBrief(hostile);

    expect(result.project).toBe("alpha");
    expect(ownKeysCalls).toBe(0);
  });

  test("renders a valid brief without caller ownKeys", () => {
    const brief = structuredClone(
      compileProjectDeltaBrief(input()),
    ) as ProjectDeltaBrief;
    let ownKeysCalls = 0;
    const hostile = new Proxy(brief, {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("caller ownKeys must remain unreachable");
      },
    });

    const markdown = renderProjectDeltaBriefMarkdown(hostile);

    expect(markdown).toContain("# Project changes: alpha");
    expect(ownKeysCalls).toBe(0);
  });
});
