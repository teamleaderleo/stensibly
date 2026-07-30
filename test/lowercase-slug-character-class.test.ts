import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertSlug } from "../convex/lib/domain.ts";
import { normalizeBoardProject } from "../site/board-filter.js";
import { ConvexMcpOAuthService } from "../src/mcp-oauth-service.ts";
import { validateProjectScope } from "../src/project-scope.ts";
import { createItemSchema } from "../src/schemas.ts";

const malformedClass = "[a-z0-9" + "-_]";
const valid = ["a", "alpha-1", "alpha_1", "a-b_c-9"];
const accidentalRangeValues = ["a@", "a:", "a?", "a[", "a\\", "a^"];

describe("lowercase slug character classes", () => {
  test("demonstrates the accidental ASCII range and the corrected boundary", () => {
    const malformed = new RegExp(`^[a-z0-9]${malformedClass}*$`);
    const corrected = /^[a-z0-9][a-z0-9_-]*$/;
    expect(accidentalRangeValues.filter((value) => malformed.test(value)))
      .toEqual(accidentalRangeValues);
    expect(accidentalRangeValues.filter((value) => corrected.test(value))).toEqual([]);
    expect(malformed.test("aA")).toBe(true);
    expect(corrected.test("aA")).toBe(false);
    expect(valid.every((value) => corrected.test(value))).toBe(true);
  });

  test("project, schema, OAuth, Convex, and browser validators reject accidental-range punctuation", () => {
    const client = {} as ConstructorParameters<typeof ConvexMcpOAuthService>[0]["client"];
    for (const value of valid) {
      expect(validateProjectScope(value)).toBe(value);
      expect(createItemSchema.parse({ project: value, title: "Slug boundary" }).project).toBe(value);
      expect(new ConvexMcpOAuthService({
        client,
        serviceSecret: "test-service-secret",
        workspace: value,
      }).workspace).toBe(value);
      expect(assertSlug(value, "Project")).toBe(value);
      expect(normalizeBoardProject(value)).toBe(value);
    }

    for (const value of accidentalRangeValues) {
      expect(() => validateProjectScope(value)).toThrow("lowercase project slug");
      expect(() => createItemSchema.parse({ project: value, title: "Slug boundary" })).toThrow();
      expect(() => new ConvexMcpOAuthService({
        client,
        serviceSecret: "test-service-secret",
        workspace: value,
      })).toThrow("lowercase slug");
      expect(() => assertSlug(value, "Project")).toThrow("lowercase slug");
      expect(normalizeBoardProject(value)).toBe("");
    }
  });

  test("preserves each validator's existing uppercase normalization policy", () => {
    const client = {} as ConstructorParameters<typeof ConvexMcpOAuthService>[0]["client"];
    expect(() => validateProjectScope("Alpha")).toThrow("lowercase project slug");
    expect(() => createItemSchema.parse({ project: "Alpha", title: "Slug boundary" })).toThrow();
    expect(normalizeBoardProject("Alpha")).toBe("");
    expect(new ConvexMcpOAuthService({
      client,
      serviceSecret: "test-service-secret",
      workspace: "Alpha",
    }).workspace).toBe("alpha");
    expect(assertSlug("Alpha", "Project")).toBe("alpha");
  });

  test("production source cannot reintroduce the malformed class", () => {
    const offenders = ["src", "convex", "site"]
      .flatMap((root) => productionFiles(root))
      .filter((path) => readFileSync(path, "utf8").includes(malformedClass));
    expect(offenders).toEqual([]);
  });
});

function productionFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (entry === "_generated") continue;
      files.push(...productionFiles(path));
      continue;
    }
    if (/\.(?:ts|js|html)$/.test(entry)) files.push(path);
  }
  return files.sort();
}
