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

  test("presents hosted sign-in as the scrapbook workroom entrance", async () => {
    const [html, hostedStyles, loginStyles] = await Promise.all([
      siteFile("index.html"),
      siteFile("hosted-session.css"),
      siteFile("login-scrapbook.css"),
    ]);

    expect(html).toContain("Pick up the work without reopening every chat.");
    expect(html).toContain("workroom 01");
    expect(html).toContain('class="workroom-preview"');
    expect(html).toContain('href="/login-scrapbook.css"');
    expect(html).toContain('id="github-sign-in"');
    expect(html).toContain('class="advanced-connection"');
    expect(html.indexOf('id="github-sign-in"')).toBeLessThan(html.indexOf('class="advanced-connection"'));
    expect(html.indexOf('id="github-sign-in"')).toBeLessThan(html.indexOf('name="token"'));
    expect(hostedStyles).toContain("var(--accent-solid)");
    expect(loginStyles).toContain(".workroom-preview");
    expect(loginStyles).toContain(".advanced-connection summary:focus-visible");
    expect(loginStyles).toContain("@media (prefers-reduced-motion: reduce)");
  });

  test("preserves the existing hosted and bearer connection controls", async () => {
    const html = await siteFile("index.html");

    for (const marker of [
      'id="connect-form"',
      'id="hosted-sign-in"',
      'id="hosted-sign-in-state"',
      'id="hosted-sign-out"',
      'name="endpoint"',
      'name="token"',
      'id="cancel-connection"',
      'id="connected-summary"',
      'id="connection-error"',
      'id="connection-note"',
    ]) {
      expect(html).toContain(marker);
    }
    expect(html).toContain("Secure session cookie · no access token pasted into this page");
  });

  test("keeps every primary action readable in light and dark schemes", async () => {
    const [hostedStyles, claimStyles] = await Promise.all([
      siteFile("hosted-session.css"),
      siteFile("item-claim.css"),
    ]);

    expect(hostedStyles).toContain("--accent-solid: #5d5478");
    expect(hostedStyles).toContain("--accent-solid: #70668b");
    expect(hostedStyles).toContain("--on-accent: #fff");

    expect(cssRule(hostedStyles, ".hosted-sign-in button")).toContain(
      "color: var(--on-accent);\n  border-color: transparent;\n  background: var(--accent-solid);",
    );
    expect(cssRule(hostedStyles, [
      ".connection-form-actions button:first-child",
      ".actor-form-actions button:first-child",
      ".create-item-actions button:first-child",
    ].join(",\n"))).toContain(
      "color: var(--on-accent);\n  background: var(--accent-solid);",
    );
    expect(cssRule(claimStyles, [
      ".detail-claim-actions button",
      ".detail-renewal-actions button",
    ].join(", "))).toContain(
      "color: var(--on-accent);\n  border-color: transparent;\n  background: var(--accent-solid);",
    );

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

function cssRule(styles: string, selectors: string): string {
  const start = styles.indexOf(`${selectors} {`);
  if (start < 0) throw new Error(`Missing CSS rule: ${selectors}`);
  const end = styles.indexOf("}", start);
  if (end < 0) throw new Error(`Unclosed CSS rule: ${selectors}`);
  return styles.slice(start, end + 1);
}

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
