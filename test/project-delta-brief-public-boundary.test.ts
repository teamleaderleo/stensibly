import { expect, test } from "bun:test";
import {
  renderProjectDeltaBriefMarkdown,
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
