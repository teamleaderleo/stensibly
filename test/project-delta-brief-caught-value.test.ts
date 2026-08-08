import { expect, test } from "bun:test";
import {
  compileProjectDeltaBrief,
  renderProjectDeltaBriefMarkdown,
  type CompileProjectDeltaBriefInput,
  type ProjectDeltaBrief,
} from "../src/project-delta-brief.ts";

function hostileThrownValue(counter: { reads: number }): object {
  return new Proxy(Object.create(null), {
    getPrototypeOf() {
      counter.reads += 1;
      throw new Error("caught caller value must remain opaque");
    },
  });
}

test("compile normalization does not inspect arbitrary caught caller values", () => {
  const counter = { reads: 0 };
  const thrown = hostileThrownValue(counter);
  const input = new Proxy(Object.create(null), {
    getPrototypeOf() {
      throw thrown;
    },
  });

  expect(() => compileProjectDeltaBrief(
    input as CompileProjectDeltaBriefInput,
  )).toThrow("Project delta input inspection failed");
  expect(counter.reads).toBe(0);
});

test("render normalization does not inspect arbitrary caught caller values", () => {
  const counter = { reads: 0 };
  const thrown = hostileThrownValue(counter);
  const brief = new Proxy(Object.create(null), {
    getPrototypeOf() {
      throw thrown;
    },
  });

  expect(() => renderProjectDeltaBriefMarkdown(
    brief as ProjectDeltaBrief,
  )).toThrow("Project delta brief inspection failed");
  expect(counter.reads).toBe(0);
});
