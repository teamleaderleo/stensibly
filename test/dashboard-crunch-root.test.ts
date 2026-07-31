import { describe, expect, test } from "bun:test";

const siteFile = (name: string) => Bun.file(new URL(`../site/${name}`, import.meta.url)).text();

describe("production root tactile presentation", () => {
  test("loads one visual layer after the behavior-owned root layers", async () => {
    const html = await siteFile("index.html");
    const calmIndex = html.indexOf('href="/calm-root.css"');
    const statusIndex = html.indexOf('href="/root-mode-status.css"');
    const crunchIndex = html.indexOf('href="/crunch-root.css"');

    expect(calmIndex).toBeGreaterThan(0);
    expect(statusIndex).toBeGreaterThan(calmIndex);
    expect(crunchIndex).toBeGreaterThan(statusIndex);
    expect(html).toContain("<h1>Shared work.</h1>");
    expect(html).toContain("Stensibly keeps ownership, next actions, and handoffs visible so people and agents can pick work up without guessing.");
    expect(html).toContain('class="brand-copy"');
    expect(html).toContain('class="hero-lede"');
    expect(html).toContain('class="hero-principles"');
    expect(html).toContain("Ownership");
    expect(html).toContain("Context");
    expect(html).toContain("Continuity");
  });

  test("uses static rules and offset surfaces instead of soft effects", async () => {
    const css = await siteFile("crunch-root.css");

    expect(css).toContain("border-top: .3rem solid var(--accent-strong)");
    expect(css).toContain("box-shadow: .24rem .24rem 0 var(--line-strong)");
    expect(css).toContain("box-shadow: .65rem .65rem 0 var(--accent-soft)");
    expect(css).toContain("border-bottom: 2px solid var(--line-strong)");
    expect(css).toContain("@media (max-width: 620px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    expect(css).not.toContain("rotate(");
    expect(css).not.toMatch(/^\s*filter\s*:/im);
  });

  test("keeps every live desk mode compact, including connection editing", async () => {
    const css = await siteFile("crunch-root.css");

    for (const mode of ["connected", "degraded", "editing"]) {
      expect(css).toContain(`html[data-app-mode="${mode}"] .hero-copy`);
      expect(css).toContain(`html[data-app-mode="${mode}"] .hero-login`);
      expect(css).toContain(`html[data-app-mode="${mode}"] .login-card`);
    }
    expect(css).toContain('html[data-app-mode="editing"] .login-card {\n  padding: .25rem .88rem;');
  });

  test("preserves the accepted root status and live control identities", async () => {
    const html = await siteFile("index.html");

    for (const marker of [
      'id="root-connecting-status"',
      'src="/root-mode-status-bridge.js"',
      'id="connect-form"',
      'id="github-sign-in"',
      'id="hosted-sign-out"',
      'name="endpoint"',
      'name="token"',
      'id="change-connection"',
      'id="disconnect-connection"',
      'id="dashboard"',
      'id="project-filter"',
      'id="create-item"',
      'id="refresh"',
    ]) {
      expect(html).toContain(marker);
    }
  });
});
