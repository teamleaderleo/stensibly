import { describe, expect, test } from "bun:test";

const siteFile = (name: string) => Bun.file(new URL(`../site/${name}`, import.meta.url)).text();

describe("dashboard visual language", () => {
  test("overrides the legacy warm base with a neutral light and dark root", async () => {
    const [styles, calm] = await Promise.all([
      siteFile("styles.css"),
      siteFile("calm-root.css"),
    ]);

    expect(styles).toContain("color-scheme: light dark");
    expect(calm).toContain("--bg: #f5f5f4");
    expect(calm).toContain("--paper: #ffffff");
    expect(calm).toContain("--text: #181817");
    expect(calm).toContain("--accent: #8f8998");
    expect(calm).toContain("@media (prefers-color-scheme: dark)");
    expect(calm).toContain("--bg: #0f0f10");
    expect(calm).toContain("@media (prefers-reduced-motion: reduce)");
    expect(calm).not.toContain("#e9e5dd");
    expect(calm).not.toContain("#70668b");
    expect(calm).not.toContain("#d8ff5f");
  });

  test("keeps hosted sign-in simple, flat, and primary", async () => {
    const [html, hostedStyles, loginStyles, bridge] = await Promise.all([
      siteFile("index.html"),
      siteFile("hosted-session.css"),
      siteFile("login-scrapbook.css"),
      siteFile("hosted-session-bridge.js"),
    ]);
    const loginSurface = `${html}\n${loginStyles}\n${bridge}`;

    expect(html).toContain("<h1>Shared work.</h1>");
    expect(html).toContain('class="connection login-card"');
    expect(html).toContain('href="/login-scrapbook.css"');
    expect(html).toContain('id="github-sign-in"');
    expect(html).toContain('class="advanced-connection"');
    expect(html.indexOf('id="github-sign-in"')).toBeLessThan(html.indexOf('class="advanced-connection"'));
    expect(html.indexOf('id="github-sign-in"')).toBeLessThan(html.indexOf('name="token"'));
    expect(hostedStyles).toContain("var(--accent-solid)");
    expect(loginStyles).toContain(".login-card");
    expect(loginStyles).toContain(".advanced-connection summary:focus-visible");
    expect(loginStyles).toContain("@media (prefers-reduced-motion: reduce)");

    for (const removed of [
      "workroom-preview",
      "hero-register",
      "Recommended",
      "workroom 01",
      "calm project desk",
      "quiet",
    ]) {
      expect(loginSurface).not.toContain(removed);
    }
    expect(loginStyles).not.toContain("gradient(");
    expect(loginStyles).not.toContain("rotate(");
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
    expect(html).toContain(
      "A bearer token stays in this browser session and is cleared when the session ends.",
    );
  });

  test("keeps every primary action readable in light and dark schemes", async () => {
    const [hostedStyles, claimStyles] = await Promise.all([
      siteFile("hosted-session.css"),
      siteFile("item-claim.css"),
    ]);

    expect(hostedStyles).toContain("--accent-solid: #181817");
    expect(hostedStyles).toContain("--on-accent: #ffffff");
    expect(hostedStyles).toContain("--accent-solid: #f2f2ef");
    expect(hostedStyles).toContain("--on-accent: #0f0f10");

    expect(cssRule(hostedStyles, ".hosted-sign-in button")).toContain(
      "color: var(--on-accent);\n  border-color: var(--accent-solid);\n  background: var(--accent-solid);",
    );
    expect(cssRule(hostedStyles, [
      ".connection-form-actions button:first-child",
      ".actor-form-actions button:first-child",
      ".create-item-actions button:first-child",
    ].join(",\n"))).toContain(
      "color: var(--on-accent);\n  border-color: var(--accent-solid);\n  background: var(--accent-solid);",
    );
    expect(cssRule(claimStyles, [
      ".detail-claim-actions button",
      ".detail-renewal-actions button",
    ].join(", "))).toContain(
      "color: var(--on-accent);\n  border-color: transparent;\n  background: var(--accent-solid);",
    );

    expect(contrastRatio("#181817", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#f2f2ef", "#0f0f10")).toBeGreaterThanOrEqual(4.5);
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
