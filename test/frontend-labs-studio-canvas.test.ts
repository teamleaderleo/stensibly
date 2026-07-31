import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { frontendLabManifest } from "../site/labs/manifest.js";

const repositoryRoot = join(import.meta.dir, "..");
const routeRoot = join(repositoryRoot, "site", "labs", "studio-canvas");
const html = readFileSync(join(routeRoot, "index.html"), "utf8");
const css = readFileSync(join(routeRoot, "styles.css"), "utf8");
const responsive = readFileSync(join(routeRoot, "responsive.css"), "utf8");
const app = readFileSync(join(routeRoot, "app.js"), "utf8");
const bridge = readFileSync(join(routeRoot, "workspace-bridge.js"), "utf8");
const guide = readFileSync(join(repositoryRoot, "docs", "frontend-studio-canvas.md"), "utf8");
const routeSource = `${html}\n${css}\n${responsive}\n${app}\n${bridge}`;

const sharedArtifacts = [
  "approve-release-note",
  "worker-health",
  "repair-focus-order",
  "deploy-amber",
  "connection-health",
];

const artifactStates = ["local", "proposed", "attached", "accepted", "stale"];

describe("Studio Canvas frontend lab", () => {
  test("publishes one independent artifact-first prototype route", () => {
    const manifestEntry = frontendLabManifest.find((entry) => entry.id === "studio-canvas");
    expect(manifestEntry).toMatchObject({
      owner: "Cinder",
      status: "prototype",
      issue: 612,
      path: "./studio-canvas/",
    });
    expect(manifestEntry?.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(manifestEntry?.support).toEqual([
      "wide",
      "medium",
      "narrow",
      "light",
      "dark",
      "keyboard",
      "reduced-motion",
    ]);
    expect(html).toContain('data-stensibly-lab="prototype"');
    expect(html).toContain('<script src="./app.js"></script>');
    expect(html).toContain('<script src="./workspace-bridge.js"></script>');
    expect(html).not.toContain("../planned.js");
    expect(html).not.toContain("../planned.css");
  });

  test("represents every shared task as an inspectable artifact", () => {
    for (const id of sharedArtifacts) expect(app).toContain(`id: "${id}"`);
    expect(app).toContain("The only fictional artifact requiring a human decision");
    expect(app).toContain("Moss is healthy; Ember has an expired fictional lease");
    expect(app).toContain("top ready item because it unlocks keyboard evidence");
    expect(app).toContain("retry could duplicate the effect");
    expect(app).toContain("GitHub is healthy, API is reconnecting, and MCP is offline");
    expect(html).toContain('id="work-list"');
    expect(html).toContain('id="artifact-sheet" tabindex="-1"');
    expect(html).toContain('id="inspector-content"');
  });

  test("keeps source, revision, freshness, authority, persistence, and next action visible", () => {
    for (const field of ["source", "revision", "freshness", "authority", "persistence", "nextAction"]) expect(app).toContain(`${field}:`);
    for (const label of ["State", "Revision", "Freshness", "Authority", "Persistence", "Owner"]) expect(app).toContain(`["${label}"`);
    expect(html).toContain("review mode");
    expect(html).toContain("fixture only");
    expect(html).toContain("nothing saved");
    expect(bridge).toContain("Fictional local fixture only");
    expect(bridge).toContain("No save, approval, submission, or write occurred");
    expect(guide).toContain("Each artifact writes source, revision, freshness, authority, persistence, owner, evidence, and one safe next action");
  });

  test("distinguishes artifact states without implying live authority", () => {
    for (const state of artifactStates) {
      expect(app).toContain(`"${state}"`);
      expect(css).toContain(`[data-state="${state}"]::before`);
    }
    expect(css).toContain('content: "✎"');
    expect(css).toContain('content: "◆"');
    expect(css).toContain('content: "＋"');
    expect(css).toContain('content: "✓"');
    expect(css).toContain('content: "!"');
    expect(guide).toContain('"Accepted" describes fixture history');
    expect(guide).toContain("It does not grant live product authority");
  });

  test("provides contextual evidence, comments, versions, and activity without modal hopping", () => {
    for (const tab of ["evidence", "comments", "versions", "activity"]) expect(app).toContain(`"${tab}"`);
    expect(html).toContain('role="tablist"');
    expect(app).toContain("renderEvidence(entry)");
    expect(app).toContain("renderComments(entry)");
    expect(app).toContain("renderVersions(entry)");
    expect(app).toContain("renderActivity(entry)");
    expect(app).toContain("Typing here is local to this page instance. Nothing is saved, attached, submitted, or approved.");
    expect(app).toContain("A real restore or branch would require an explicit reviewed action. Nothing changed.");
    expect(guide).toContain("Ordinary inspection does not open a modal");
  });

  test("keeps revision comparison local and exposes no save, approval, restore, retry, or publish action", () => {
    expect(app).toContain("Local comparison only");
    expect(app).toContain("No restore, branch, approval, or save has occurred");
    expect(app).toContain("No retry control is exposed in this preview");
    expect(app).not.toMatch(/\.textContent\s*=\s*["'](?:Save|Approve|Restore|Retry|Publish)["']/);
    expect(html).not.toMatch(/>\s*(?:Save|Approve|Restore|Retry|Publish)\s*</);
    expect(guide).toContain("comparison does not restore, branch, approve, save, publish, or mutate anything");
  });

  test("preserves keyboard continuity and recoverable desktop and narrow layouts", () => {
    for (const key of ["ArrowDown", "ArrowUp", "]", "["]) expect(app).toContain(`"${key}"`);
    expect(app).toContain('keyboardEvent.key.toLowerCase() === "k"');
    expect(app).toContain('keyboardEvent.key === "/"');
    expect(app).toContain('/^[1-3]$/.test(keyboardEvent.key)');
    expect(app).toContain("commandDialog.addEventListener(\"close\"");
    expect(app).toContain("commandReturnFocus");
    expect(app).toContain('document.body.dataset[`${region}Collapsed`]');
    expect(html).toContain('id="reopen-work"');
    expect(html).toContain('id="reopen-inspector"');
    expect(responsive).toContain("body[data-work-collapsed=\"true\"] .work-region");
    expect(responsive).toContain("display: block");
    expect(responsive).toContain("#collapse-work");
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(guide).toContain("all regions stack in document order and collapse controls are disabled");
  });

  test("restores the dynamic canvas heading and wires local-only toolbar actions", () => {
    expect(html).toContain('aria-labelledby="canvas-region-title"');
    expect(bridge).toContain('heading.id = "canvas-region-title"');
    expect(bridge).toContain("new MutationObserver(syncHeadingIdentity)");
    expect(bridge).toContain('document.querySelectorAll("[data-local-action]")');
    expect(bridge).toContain("selectedArtifact()");
    expect(bridge).toContain("announce(");
  });

  test("stays fixture-only, flat, local, and free of external authority", () => {
    expect(() => new Function(app)).not.toThrow();
    expect(() => new Function(bridge)).not.toThrow();
    expect(routeSource).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/);
    expect(routeSource).not.toMatch(/https?:\/\//);
    expect(routeSource).not.toMatch(/stn\.tok_/);
    expect(routeSource).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b/);
    expect(routeSource).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    expect(css).not.toContain("url(");
    expect(css).not.toContain("@import");
    expect(html).not.toMatch(/<(?:img|iframe)\b/i);
    expect(guide).toContain("No production dashboard, authentication, API, persistence, deployment, or durable state is involved");
  });
});
