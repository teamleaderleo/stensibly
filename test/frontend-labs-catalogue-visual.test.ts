import { describe, expect, test } from "bun:test";

const labsFile = (name: string) => Bun.file(new URL(`../site/labs/${name}`, import.meta.url)).text();

describe("frontend Labs catalogue visual hierarchy", () => {
  test("uses a distinct editorial studio shell with tactile selection states", async () => {
    const styles = await labsFile("styles.css");

    expect(styles).toContain('--font-display: "Iowan Old Style"');
    expect(styles).toContain("border-top: .3rem solid var(--accent)");
    expect(styles).toContain("border-top: .35rem solid var(--line-strong)");
    expect(styles).toContain('.variant-card[data-selected="true"]');
    expect(styles).toContain("box-shadow: .45rem .45rem 0");
    expect(styles).toContain(".card-actions { display: grid;");
    expect(styles).toContain(".compare-frame { min-width: 0; border: 2px solid var(--line-strong);");
    expect(styles).toContain("@media (max-width: 520px)");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    expect(styles).not.toContain("rotate(");
  });

  test("preserves the catalogue and comparison interaction boundaries", async () => {
    const [html, catalogue] = await Promise.all([
      labsFile("index.html"),
      labsFile("catalogue.js"),
    ]);

    for (const marker of [
      'id="variant-grid"',
      'id="selection-summary"',
      'id="compare-button"',
      'id="compare-section"',
      'id="compare-grid"',
      'id="close-compare"',
    ]) {
      expect(html).toContain(marker);
    }
    expect(catalogue).toContain('frame.setAttribute("sandbox", "allow-scripts")');
    expect(catalogue).toContain('frame.referrerPolicy = "no-referrer"');
    expect(catalogue).not.toContain("allow-same-origin");
  });
});
