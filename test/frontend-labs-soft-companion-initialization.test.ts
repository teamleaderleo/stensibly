import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(
  join(import.meta.dir, "..", "site", "labs", "soft-companion", "app.js"),
  "utf8",
);

describe("Soft Companion synchronous initialization", () => {
  test("initializes filter labels before the first fixture render", () => {
    expect(() => new Function(app)).not.toThrow();

    const labels = app.indexOf(
      'const filterLabels = { all: "All", action: "Needs action", unhealthy: "Unhealthy" };',
    );
    const firstScenarioRender = app.indexOf("applyScenario(scenarioSelect.value, false);");

    expect(labels).toBeGreaterThan(-1);
    expect(firstScenarioRender).toBeGreaterThan(-1);
    expect(labels).toBeLessThan(firstScenarioRender);
    expect(app.match(/const filterLabels =/g)).toHaveLength(1);
  });
});
