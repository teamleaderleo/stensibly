import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const html = readFileSync(join(repositoryRoot, "site", "index.html"), "utf8");
const calm = readFileSync(join(repositoryRoot, "site", "calm-root.css"), "utf8");

function sliceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = source.indexOf(end, startIndex);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex + end.length);
}

describe("calm production dashboard root", () => {
  test("loads the calm presentation layer after existing root styles", () => {
    const baseIndex = html.indexOf('href="/styles.css"');
    const loginIndex = html.indexOf('href="/login-scrapbook.css"');
    const calmIndex = html.indexOf('href="/calm-root.css"');
    const statusIndex = html.indexOf('href="/root-mode-status.css"');

    expect(baseIndex).toBeGreaterThanOrEqual(0);
    expect(loginIndex).toBeGreaterThan(baseIndex);
    expect(calmIndex).toBeGreaterThan(loginIndex);
    expect(statusIndex).toBeGreaterThan(calmIndex);
    expect(html.match(/calm-root\.css/g)).toHaveLength(1);
    expect(html.match(/root-mode-status\.css/g)).toHaveLength(1);
  });

  test("uses one local neutral interface and display stack", () => {
    expect(calm).toContain('--font-interface: Aptos, "Segoe UI Variable Text", "Segoe UI"');
    expect(calm).toContain("--font-display: var(--font-interface)");
    expect(calm).toContain("font-family: var(--font-display)");
    expect(calm).toContain("font-family: var(--font-interface)");
    expect(calm).toContain("font-weight: 400");
    expect(calm).toContain("font-weight: 600");
    expect(calm).not.toContain("Iowan Old Style");
    expect(calm).not.toContain("Palatino Linotype");
    expect(calm).not.toContain("@import");
    expect(calm).not.toContain("url(");
    expect(calm).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
  });

  test("keeps connection and write identity collapsed by default", () => {
    const session = sliceBetween(
      html,
      '<details class="session-context" id="session-context-panel"',
      "</details>",
    );

    expect(session).toContain('<summary class="session-context-head">');
    expect(session).toContain('id="session-context-title">Connection &amp; write identity');
    expect(session).toContain('id="capability-state">unavailable');
    expect(session).toContain('id="actor-form" hidden');
    expect(session).toContain('id="change-actor"');
    expect(session).toContain('id="clear-actor"');
    expect(session).not.toMatch(/<details[^>]*\sopen(?:\s|>)/);
    expect(calm).toContain('.session-context > summary:focus-visible');
    expect(calm).toContain('.session-context[open] > summary::after');
  });

  test("keeps token entry and mutations behind deliberate controls", () => {
    const connection = sliceBetween(
      html,
      '<aside class="connection login-card"',
      "</aside>",
    );
    const advanced = sliceBetween(
      connection,
      '<details class="advanced-connection">',
      "</details>",
    );

    expect(advanced).toContain("<summary>Use API token</summary>");
    expect(advanced).toContain('input name="token" type="password"');
    expect(connection.indexOf('input name="token"')).toBeGreaterThan(
      connection.indexOf('<details class="advanced-connection">'),
    );
    expect(html).toContain('<button id="create-item" type="button" hidden>');
    expect(html).toContain('<form class="actor-form" id="actor-form" hidden>');
    expect(html.match(/<script /g)).toHaveLength(3);
    expect(html).toContain('<script src="/root-mode-status-bridge.js" type="module"></script>');
    expect(html).toContain('<script src="/hosted-session-bridge.js" type="module"></script>');
    expect(html).toContain('<script src="/app.js" type="module"></script>');
    expect(html.indexOf('/root-mode-status-bridge.js')).toBeLessThan(
      html.indexOf('/hosted-session-bridge.js'),
    );
  });
});
