import { expect, test } from "bun:test";
import {
  compileProjectDeltaBrief,
  renderProjectDeltaBriefMarkdown,
  type CompileProjectDeltaBriefInput,
  type ProjectDeltaBrief,
} from "../src/project-delta-brief.ts";

test("only the public project delta module imports the private compiler", async () => {
  const allowed = new Set(["src/project-delta-brief.ts"]);
  const sourceFiles = Array.from(
    new Bun.Glob("src/**/*.ts").scanSync({ cwd: "." }),
  );

  for (const path of sourceFiles) {
    const source = await Bun.file(path).text();
    if (source.includes("project-delta-brief-base.js")) {
      expect(allowed.has(path), path).toBe(true);
    }
  }
});

test("compilation normalizes hostile caller inspection traps", () => {
  const hostile = new Proxy(Object.create(Object.prototype), {
    ownKeys() {
      throw new Error("private caller prose");
    },
  });

  expect(() => compileProjectDeltaBrief(
    hostile as unknown as CompileProjectDeltaBriefInput,
  )).toThrow("Project delta input inspection failed");
});

test("compilation detaches the complete caller graph once", () => {
  let getterCalls = 0;
  const observation = {
    observationId: "obs:1",
    sequence: 1,
    project: "alpha",
    subjectId: "work:1",
    kind: "work",
    state: "active",
    summary: null,
    observedAt: "2026-08-06T00:01:00.000Z",
    sourceReferences: ["source:1"],
  } as Record<string, unknown>;
  Object.defineProperty(observation, "title", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "hidden";
    },
  });
  const input = {
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
    observations: [observation],
    limit: 10,
  };

  expect(() => compileProjectDeltaBrief(
    input as unknown as CompileProjectDeltaBriefInput,
  )).toThrow("Project delta input fields must be enumerable data properties");
  expect(getterCalls).toBe(0);
});

test("Markdown rendering rejects accessor-bearing forged briefs without invoking getters", () => {
  let getterCalls = 0;
  const hostile = Object.create(Object.prototype) as Record<string, unknown>;
  Object.defineProperty(hostile, "project", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "alpha";
    },
  });

  expect(() => renderProjectDeltaBriefMarkdown(
    hostile as unknown as ProjectDeltaBrief,
  )).toThrow("Project delta brief inspection failed");
  expect(getterCalls).toBe(0);
});

test("Markdown rendering normalizes hostile inspection traps", () => {
  const hostile = new Proxy(Object.create(Object.prototype), {
    ownKeys() {
      throw new Error("private provider prose");
    },
  });

  expect(() => renderProjectDeltaBriefMarkdown(
    hostile as unknown as ProjectDeltaBrief,
  )).toThrow("Project delta brief inspection failed");
});

test("Markdown rendering uses one detached brief graph", () => {
  const safe = compileProjectDeltaBrief({
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
  });
  const target = structuredClone(safe) as ProjectDeltaBrief;
  let getCalls = 0;
  const hostile = new Proxy(target, {
    get(current, key, receiver) {
      getCalls += 1;
      if (key === "project") return "authorization: Bearer hidden";
      return Reflect.get(current, key, receiver);
    },
  });

  const markdown = renderProjectDeltaBriefMarkdown(hostile);
  expect(markdown).toContain("# Project changes: alpha");
  expect(markdown).not.toContain("authorization:");
  expect(markdown).not.toContain("Bearer hidden");
  expect(getCalls).toBe(0);
});
