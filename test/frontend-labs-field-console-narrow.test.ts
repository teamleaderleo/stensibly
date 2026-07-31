import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(
  join(import.meta.dir, "..", "site", "labs", "field-console", "styles.css"),
  "utf8",
);

describe("Field Console narrow recovery", () => {
  test("lets the topbar and region headings reflow inside the canonical narrow viewport", () => {
    const narrowStart = css.indexOf("@media (max-width: 48rem)");
    const reducedMotionStart = css.indexOf("@media (prefers-reduced-motion: reduce)");

    expect(narrowStart).toBeGreaterThan(-1);
    expect(reducedMotionStart).toBeGreaterThan(narrowStart);

    const narrow = css.slice(narrowStart, reducedMotionStart);
    for (const rule of [
      ".topbar > * { max-width: 100%; }",
      ".brand, .brand-copy { min-width: 0; }",
      ".top-actions { width: 100%; min-width: 0; flex-wrap: wrap; }",
      ".top-actions > * { min-width: 0; max-width: 100%; }",
      ".top-actions select { flex: 1 1 12rem; }",
      ".region-head > div { min-width: 0; }",
      ".region-head h1, .region-head h2, .region-head p { overflow-wrap: anywhere; }",
    ]) expect(narrow).toContain(rule);
  });

  test("keeps the narrow repair local and gradient-free", () => {
    expect(css).not.toMatch(/https?:\/\//u);
    expect(css).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/iu);
    expect(css).not.toContain("@import");
    expect(css).not.toContain("url(");
  });
});
