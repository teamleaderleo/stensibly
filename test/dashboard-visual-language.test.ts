import { describe, expect, test } from "bun:test";

const siteFile = (name: string) => Bun.file(new URL(`../site/${name}`, import.meta.url)).text();

describe("dashboard visual language", () => {
  test("uses a warm light foundation with an intentional dark scheme", async () => {
    const styles = await siteFile("styles.css");

    expect(styles).toContain("color-scheme: light dark");
    expect(styles).toContain("--bg: #e9e5dd");
    expect(styles).toContain("--accent: #70668b");
    expect(styles).toContain("@media (prefers-color-scheme: dark)");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).not.toContain("#0b0b0d");
    expect(styles).not.toContain("#d8ff5f");
  });

  test("keeps hosted sign-in primary and advanced token access secondary", async () => {
    const [html, hostedStyles] = await Promise.all([
      siteFile("index.html"),
      siteFile("hosted-session.css"),
    ]);

    expect(html).toContain("Shared work, in one place.");
    expect(html).toContain("People and agents working here");
    expect(html).toContain('id="github-sign-in"');
    expect(html.indexOf('id="github-sign-in"')).toBeLessThan(html.indexOf("advanced connection"));
    expect(hostedStyles).toContain("var(--accent-solid)");
  });

  test("keeps every primary action readable in light and dark schemes", async () => {
    const [hostedStyles, claimStyles] = await Promise.all([
      siteFile("hosted-session.css"),
      siteFile("item-claim.css"),
    ]);

    expect(hostedStyles).toContain("--accent-solid: #5d5478");
    expect(hostedStyles).toContain("--accent-solid: #70668b");
    expect(hostedStyles).toContain("--on-accent: #fff");
    expect(hostedStyles).toContain(".connection-form-actions button:first-child");
    expect(hostedStyles).toContain(".actor-form-actions button:first-child");
    expect(hostedStyles).toContain(".create-item-actions button:first-child");
    expect(hostedStyles).toContain("color: var(--on-accent)");
    expect(hostedStyles).toContain("background: var(--accent-solid)");
    expect(claimStyles).toContain(".detail-claim-actions button, .detail-renewal-actions button");
    expect(claimStyles).toContain("color: var(--on-accent)");
    expect(claimStyles).toContain("background: var(--accent-solid)");

    expect(contrastRatio("#5d5478", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#70668b", "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  test("keeps dynamically loaded item actions inside the same palette", async () => {
    const actionStyles = await Promise.all([
      "item-claim.css",
      "item-progress.css",
      "item-block.css",
      "item-complete.css",
      "item-handoff.css",
    ].map(siteFile));
    const combined = actionStyles.join("\n");

    expect(combined).toContain("var(--accent-solid)");
    expect(combined).toContain("var(--danger-soft)");
    expect(combined).not.toContain("#ffc0aa");
    expect(combined).not.toContain("rgba(255,154,118");
  });

  test("removes terminal persona copy while preserving the four-state board", async () => {
    const [html, app] = await Promise.all([
      siteFile("index.html"),
      siteFile("app.js"),
    ]);
    const combined = `${html}\n${app}`;

    expect(combined).not.toContain("See what the machines are doing before they forget");
    expect(combined).not.toContain("Agents in the walls");
    expect(combined).not.toContain("quiet. suspiciously quiet.");
    expect(app).toContain("const DEFAULT_ENDPOINT");
    for (const status of ["ready", "active", "blocked", "done"]) {
      expect(app).toContain(`'${status}'`);
    }
  });
});

function contrastRatio(background: string, foreground: string): number {
  const light = relativeLuminance(foreground);
  const dark = relativeLuminance(background);
  return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
}

function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)?.map((value) => Number.parseInt(value, 16) / 255);
  if (!channels || channels.length !== 3) throw new Error(`Invalid colour: ${hex}`);
  const [red = 0, green = 0, blue = 0] = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
