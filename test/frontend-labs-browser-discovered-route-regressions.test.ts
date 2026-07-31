import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const labsRoot = join(import.meta.dir, "..", "site", "labs");
const softCompanionApp = readFileSync(
  join(labsRoot, "soft-companion", "app.js"),
  "utf8",
);
const fieldConsoleCss = readFileSync(
  join(labsRoot, "field-console", "styles.css"),
  "utf8",
);

describe("browser-discovered frontend route regressions", () => {
  test("initializes Soft Companion filter labels before its first render", () => {
    const declaration = softCompanionApp.indexOf("const filterLabels");
    const firstScenarioRender = softCompanionApp.indexOf(
      "applyScenario(scenarioSelect.value, false)",
    );

    expect(declaration).toBeGreaterThan(-1);
    expect(firstScenarioRender).toBeGreaterThan(-1);
    expect(declaration).toBeLessThan(firstScenarioRender);
    expect(softCompanionApp.match(/const filterLabels/g)).toHaveLength(1);
  });

  test("lets the Field Console brand shrink and wrap at narrow widths", () => {
    const narrowMedia = fieldConsoleCss.match(
      /@media \(max-width: 48rem\) \{([\s\S]*?)\n\}/u,
    )?.[1];

    expect(narrowMedia).toBeDefined();
    expect(narrowMedia).toContain(".brand { min-width: 0; }");
    expect(narrowMedia).toContain(".brand-copy { min-width: 0; }");
    expect(narrowMedia).toContain(".brand-copy small { overflow-wrap: anywhere; }");
  });
});
