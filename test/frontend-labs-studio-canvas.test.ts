import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { frontendLabManifest } from "../site/labs/manifest.js";

const repositoryRoot = join(import.meta.dir, "..");
const routeRoot = join(repositoryRoot, "site", "labs", "studio-canvas");
const html = readFileSync(join(routeRoot, "index.html"), "utf8");
const css = readFileSync(join(routeRoot, "styles.css"), "utf8");
const responsive = readFileSync(join(routeRoot, "responsive.css"), "utf8");
const policy = readFileSync(join(routeRoot, "fixture-policy.js"), "utf8");
const app = readFileSync(join(routeRoot, "app.js"), "utf8");
const bridge = readFileSync(join(routeRoot, "workspace-bridge.js"), "utf8");
const guide = readFileSync(join(repositoryRoot, "docs", "frontend-studio-canvas.md"), "utf8");
const routeSource = `${html}\n${css}\n${responsive}\n${policy}\n${app}\n${bridge}`;

const sharedArtifacts = [
  "approve-release-note",
  "worker-health",
  "repair-focus-order",
  "deploy-amber",
  "connection-health",
];

const artifactStates = ["local", "proposed", "attached", "accepted", "stale"];

describe("Studio Canvas frontend lab", () => {
  test("publishes one direct shared-fixture artifact workspace", () => {
    expect(frontendLabManifest.find((entry) => entry.id === "studio-canvas")).toEqual({
      id: "studio-canvas",
      title: "Studio Canvas",
      thesis: "An artifact-first workspace with work navigation, versions, evidence, comments, and commands around the selected output.",
      owner: "Cinder",
      status: "prototype",
      revision: "11b745b461905851383c884ac79754a2f79e4cb1",
      issue: 612,
      path: "./studio-canvas/",
      support: ["wide", "medium", "narrow", "light", "dark", "keyboard", "reduced-motion"],
    });
    const fixturesPosition = html.indexOf('../fixtures.classic.js');
    const policyPosition = html.indexOf('./fixture-policy.js');
    const appPosition = html.indexOf('./app.js');
    const bridgePosition = html.indexOf('./workspace-bridge.js');
    expect(fixturesPosition).toBeGreaterThan(-1);
    expect(fixturesPosition).toBeLessThan(policyPosition);
    expect(policyPosition).toBeLessThan(appPosition);
    expect(appPosition).toBeLessThan(bridgePosition);
    expect(html).not.toContain("runtime-boundary.js");
    expect(app).toContain("const artifacts = studioPolicy.projectArtifacts(baseArtifacts)");
    expect(bridge).not.toContain("selectedArtifact = function");
    expect(bridge).not.toContain("renderCommands = function");
  });

  test("represents every shared task as one inspectable artifact", () => {
    for (const id of sharedArtifacts) expect(app).toContain(`id: "${id}"`);
    expect(policy).toContain("Shared decision");
    expect(policy).toContain("Shared worker projection");
    expect(policy).toContain("Shared ready work rank");
    expect(policy).toContain("Shared operation");
    expect(policy).toContain("Shared connection projection");
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
    expect(policy).toContain("Fictional local fixture only");
    expect(policy).toContain("No save, approval, submission, or write occurred");
    expect(app).toContain("localActionResult.hidden = false");
    expect(app).toContain("localActionResult.focus({ preventScroll: true })");
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
    expect(guide).toContain('“Accepted” describes fixture history');
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

  test("offers comparison only when an earlier revision exists", () => {
    expect(app).toContain("selectedArtifact().versions.length > 1");
    expect(app).toContain("No earlier revision is available for comparison.");
    expect(app).toContain("Local comparison only");
    expect(app).toContain("No restore, branch, approval, or save has occurred");
    expect(app).toContain("No retry control is exposed in this preview");
    expect(guide).toContain("comparison is omitted from command search when the selected artifact has no earlier revision");
    expect(guide).toContain("comparison does not restore, branch, approve, save, publish, or mutate anything");
    expect(app).not.toMatch(/\.textContent\s*=\s*["'](?:Save|Approve|Restore|Retry|Publish)["']/);
    expect(html).not.toMatch(/>\s*(?:Save|Approve|Restore|Retry|Publish)\s*</);
  });

  test("keeps command focus and responsive collapse fail-closed", () => {
    expect(app).toContain("commandReturnFocus = isUsefulReturnTarget(document.activeElement)");
    expect(app).toContain("commandReturnFocus = null");
    expect(app).toContain("studioPolicy.commandKinds(narrowMedia.matches, selectedArtifact().versions.length > 1)");
    expect(app).toContain("if (collapsed && narrowMedia.matches)");
    expect(app).toContain("Collapse controls are disabled in the narrow stacked layout");
    expect(app).toContain('document.body.dataset.workCollapsed = "false"');
    expect(app).toContain('document.body.dataset.inspectorCollapsed = "false"');
    expect(html).toContain('id="reopen-work"');
    expect(html).toContain('id="reopen-inspector"');
    expect(responsive).toContain("body[data-work-collapsed=\"true\"] .work-region");
    expect(responsive).toContain("display: block");
    expect(responsive).toContain("#collapse-work");
    expect(guide).toContain("collapse commands are omitted from search");
    expect(guide).toContain("a stale command cannot focus a hidden recovery control");
  });

  test("restores dynamic heading and roving inspector-tab semantics", () => {
    expect(html).toContain('aria-labelledby="canvas-region-title"');
    expect(bridge).toContain('heading.id = "canvas-region-title"');
    expect(bridge).toContain('button.id = `studio-canvas-tab-${tab}`');
    expect(bridge).toContain('button.setAttribute("aria-controls", "inspector-content")');
    expect(bridge).toContain('inspectorContentNode.setAttribute("role", "tabpanel")');
    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) expect(bridge).toContain(`event.key === "${key}"`);
    expect(bridge).toContain("inspectorButtons().find((button) => button.dataset.tab === nextTab)?.focus()");
    expect(bridge).not.toContain("StensiblyFrontendLabFixtures");
  });

  test("preserves keyboard continuity and narrow document order", () => {
    for (const key of ["ArrowDown", "ArrowUp", "]", "["]) expect(app).toContain(`"${key}"`);
    expect(app).toContain('keyboardEvent.key.toLowerCase() === "k"');
    expect(app).toContain('keyboardEvent.key === "/"');
    expect(app).toContain('/^[1-3]$/.test(keyboardEvent.key)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(guide).toContain("all regions stack in document order");
  });

  test("stays fixture-only, flat, local, and free of external authority", () => {
    expect(() => new Function(policy)).not.toThrow();
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
