import { describe, expect, test } from "bun:test";

const loader = await Bun.file(new URL("../site/item-claim.js", import.meta.url)).text();
const controller = await Bun.file(new URL("../site/project-correspondence-controller.js", import.meta.url)).text();
const helper = await Bun.file(new URL("../site/project-correspondence.js", import.meta.url)).text();
const declaration = await Bun.file(new URL("../site/project-correspondence.d.ts", import.meta.url)).text();
const styles = await Bun.file(new URL("../site/project-correspondence.css", import.meta.url)).text();
const assets = await Bun.file(new URL("../src/dashboard-assets.ts", import.meta.url)).text();

describe("dashboard project correspondence integration", () => {
  test("loads as a read-only dashboard sidecar", () => {
    expect(loader).toContain("import './project-correspondence-controller.js'");
    expect(controller).toContain("if (typeof document !== 'undefined') installProjectCorrespondenceController()");
    expect(controller).toContain("openButton.textContent = 'correspondence'");
    expect(controller).not.toContain("method: 'POST'");
    expect(controller).not.toContain("Idempotency-Key");
    expect(controller).not.toContain("reply composer");
  });

  test("uses the selected visible project and exact authenticated route", () => {
    expect(controller).toContain("[...projectFilter.options].map((option) => option.value)");
    expect(controller).toContain("normalizeCorrespondenceProjects");
    expect(controller).toContain("projects.includes(projectFilter.value)");
    expect(controller).toContain("/api/v1/projects/${encodeURIComponent(project)}/correspondence?limit=12");
    expect(controller).toContain("authorization: `Bearer ${connection.token}`");
    expect(controller).toContain("cache: 'no-store'");
    expect(controller).not.toContain("STENSIBLY_SERVICE_SECRET");
  });

  test("guards stale responses and resets with dashboard connection state", () => {
    expect(controller).toContain("const requestId = gate.begin()");
    expect(controller).toContain("gate.invalidate()");
    expect(controller).toContain("gate.isCurrent(requestId)");
    expect(controller).toContain("projectSelect.value === project");
    expect(controller).toContain("connection.endpoint === expectedConnection.endpoint");
    expect(controller).toContain("connection.token === expectedConnection.token");
    expect(controller).toContain("CONNECTION_RESET_STATES");
    expect(controller).toContain("connectionObserver?.disconnect()");
  });

  test("renders freshness, completeness, evidence, and explicit causality with text APIs", () => {
    expect(controller).toContain("CURRENTNESS_COPY");
    expect(controller).toContain("Coverage is partial");
    expect(controller).toContain("Causal predecessor:");
    expect(controller).toContain("thread.freshness.subscriptionHealth");
    expect(controller).toContain("thread.freshness.truncated");
    expect(controller).toContain("body.replaceChildren");
    expect(controller).not.toContain("innerHTML");
    expect(helper).toContain("fixedFalse(source.authorizesMutation");
    expect(helper).toContain("fixedFalse(value.containsRawMailBody");
    expect(helper).toContain("missing causal predecessor");
  });

  test("keeps local/backend absence explicit instead of inventing correspondence", () => {
    expect(controller).toContain("Correspondence is unavailable on this backend or outside the token project boundary.");
    expect(controller).toContain("No projected correspondence is available for this project yet.");
    expect(controller).toContain("No valid correspondence view is available yet.");
  });

  test("uses native dialog behavior, focus restoration, and narrow-screen reflow", () => {
    expect(controller).toContain("dialog.showModal()");
    expect(controller).toContain("dialog.addEventListener('close'");
    expect(controller).toContain("if (target?.isConnected) target.focus()");
    expect(styles).toContain(".project-correspondence-dialog");
    expect(styles).toContain("@media (max-width: 720px)");
    expect(styles).not.toMatch(/gradient\s*\(/i);
  });

  test("declares and verifies the new static assets", () => {
    expect(declaration).toContain("interface ProjectCorrespondence");
    expect(declaration).toContain('currentness: "current" | "partial" | "stale" | "unknown"');
    expect(assets).toContain('path: "/project-correspondence-controller.js"');
    expect(assets).toContain('path: "/project-correspondence.js"');
    expect(assets).toContain('path: "/project-correspondence.css"');
  });
});
