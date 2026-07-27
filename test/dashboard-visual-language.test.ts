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
    expect(hostedStyles).toContain("var(--accent-strong)");
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

    expect(combined).toContain("var(--accent-strong)");
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
