import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const labsRoot = join(import.meta.dir, "..", "site", "labs");
const softCompanion = readFileSync(join(labsRoot, "soft-companion", "app.js"), "utf8");
const fieldConsole = readFileSync(join(labsRoot, "field-console", "styles.css"), "utf8");

describe("browser-exposed frontend route repairs", () => {
  test("admits Soft Companion filter labels before the initial render", () => {
    const declaration = 'const filterLabels = { all: "All", action: "Needs action", unhealthy: "Unhealthy" };';
    const initialization = "applyScenario(scenarioSelect.value, false);";

    expect(softCompanion.split(declaration)).toHaveLength(2);
    expect(softCompanion.indexOf(declaration)).toBeGreaterThan(-1);
    expect(softCompanion.indexOf(declaration)).toBeLessThan(softCompanion.indexOf(initialization));
  });

  test("lets Field Console controls and headings reflow inside the narrow viewport", () => {
    const narrowStart = fieldConsole.indexOf("@media (max-width: 48rem)");
    const reducedMotionStart = fieldConsole.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(narrowStart).toBeGreaterThan(-1);
    expect(reducedMotionStart).toBeGreaterThan(narrowStart);

    const narrow = fieldConsole.slice(narrowStart, reducedMotionStart);
    expect(narrow).toContain(".topbar > * { max-width: 100%; }");
    expect(narrow).toContain(".brand, .brand-copy { min-width: 0; }");
    expect(narrow).toContain(".top-actions { width: 100%; min-width: 0; flex-wrap: wrap; }");
    expect(narrow).toContain(".top-actions > * { min-width: 0; max-width: 100%; }");
    expect(narrow).toContain(".top-actions select { flex: 1 1 12rem; }");
    expect(narrow).toContain(".region-head > div { min-width: 0; }");
    expect(narrow).toContain("overflow-wrap: anywhere");
  });

  test("keeps both route repairs local and gradient-free", () => {
    for (const source of [softCompanion, fieldConsole]) {
      expect(source).not.toMatch(/https?:\/\//);
      expect(source).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    }
  });
});
