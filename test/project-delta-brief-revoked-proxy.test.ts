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
      observedAt: "2026-08-08T00:00:00.000Z",
    },
    toCheckpoint: {
      id: "checkpoint:1",
      throughSequence: 1,
      observedAt: "2026-08-08T00:01:00.000Z",
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
      observedAt: "2026-08-08T00:01:00.000Z",
      sourceReferences: ["source:1"],
    }],
    limit: 10,
  };
}

describe("project delta revoked-proxy inspection", () => {
  test("normalizes a revoked compile envelope to the fixed input diagnostic", () => {
    const { proxy, revoke } = Proxy.revocable(input(), {});
    revoke();

    expect(() => compileProjectDeltaBrief(proxy as CompileProjectDeltaBriefInput))
      .toThrow("Project delta input inspection failed");
  });

  test("normalizes a revoked render brief to the fixed brief diagnostic", () => {
    const brief = compileProjectDeltaBrief(input());
    const { proxy, revoke } = Proxy.revocable(brief, {});
    revoke();

    expect(() => renderProjectDeltaBriefMarkdown(proxy as ProjectDeltaBrief))
      .toThrow("Project delta brief inspection failed");
  });
});
