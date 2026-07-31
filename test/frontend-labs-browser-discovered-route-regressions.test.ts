import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fieldConsoleCss = readFileSync(
  join(import.meta.dir, "..", "site", "labs", "field-console", "styles.css"),
  "utf8",
);

describe("browser-discovered Field Console regressions", () => {
  test("lets the brand shrink and wrap at narrow widths", () => {
    const narrowMedia = fieldConsoleCss.match(
      /@media \(max-width: 48rem\) \{([\s\S]*?)\n\}/u,
    )?.[1];

    expect(narrowMedia).toBeDefined();
    expect(narrowMedia).toContain(".brand { min-width: 0; }");
    expect(narrowMedia).toContain(".brand-copy { min-width: 0; }");
    expect(narrowMedia).toContain(".brand-copy small { overflow-wrap: anywhere; }");
  });
});
