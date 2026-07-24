import { describe, expect, test } from "bun:test";

const loader = await Bun.file(new URL("../site/item-claim.js", import.meta.url)).text();
const controller = await Bun.file(new URL("../site/project-brief-controller.js", import.meta.url)).text();
const helper = await Bun.file(new URL("../site/project-brief.js", import.meta.url)).text();
const declaration = await Bun.file(new URL("../site/project-brief.d.ts", import.meta.url)).text();
const styles = await Bun.file(new URL("../site/project-brief.css", import.meta.url)).text();

describe("dashboard project brief integration", () => {
  test("loads as a read-only dashboard extension", () => {
    expect(loader).toContain("import './project-brief-controller.js'");
    expect(controller).toContain("if (typeof document !== 'undefined') installProjectBriefController()");
    expect(controller).toContain("openButton.textContent = 'project brief'");
    expect(controller).not.toContain("method: 'POST'");
    expect(controller).not.toContain("Idempotency-Key");
  });

  test("derives projects from the existing visible project filter", () => {
    expect(controller).toContain("[...projectFilter.options].map((option) => option.value)");
    expect(controller).toContain("normalizeBriefProjects");
    expect(controller).toContain("projects.includes(projectFilter.value)");
    expect(controller).not.toContain("localStorage.setItem");
    expect(helper).toContain("PROJECT_PATTERN");
  });

  test("uses the exact authorized bounded brief route", () => {
    expect(controller).toContain("/api/v1/projects/${encodeURIComponent(project)}/brief?limit=10");
    expect(controller).toContain("authorization: `Bearer ${connection.token}`");
    expect(controller).toContain("sessionStorage.getItem(TOKEN_STORAGE_KEY)");
    expect(controller).toContain("localStorage.getItem(ENDPOINT_STORAGE_KEY)");
    expect(controller).not.toContain("STENSIBLY_SERVICE_SECRET");
  });

  test("guards stale responses and preserves the last valid brief on refresh failure", () => {
    expect(controller).toContain("const requestId = gate.begin()");
    expect(controller).toContain("gate.invalidate()");
    expect(controller).toContain("gate.isCurrent(requestId) && dialog.open && projectSelect.value === project");
    expect(controller).toContain("currentBrief?.project === project ? 'refreshing' : 'loading'");
    expect(controller).toContain("if (!currentBrief || currentBrief.project !== projectSelect.value)");
    expect(controller).toContain("currentBrief = brief");
  });

  test("handles API, compatibility, and request-ID failures beside the cached view", () => {
    expect(controller).toContain("describeHttpFailure");
    expect(controller).toContain("formatValidationIssues");
    expect(controller).toContain("safeRequestId");
    expect(controller).toContain("response.status === 404");
    expect(controller).toContain("readProjectBrief(payload, project)");
    expect(controller).toContain("redactCredentialText");
  });

  test("renders known brief sections and safe artifact references with text APIs", () => {
    for (const label of ["Ready work", "Active work", "Blocked work", "Knowledge", "Recently completed", "Recent artifacts"]) {
      expect(controller).toContain(label);
    }
    expect(controller).toContain("safeBriefArtifactHref");
    expect(controller).toContain("link.rel = 'noreferrer noopener'");
    expect(controller).toContain("body.replaceChildren");
    expect(controller).not.toContain("innerHTML");
  });

  test("uses native dialog close behavior and restores focus", () => {
    expect(controller).toContain("dialog.showModal()");
    expect(controller).toContain("dialog.addEventListener('close'");
    expect(controller).toContain("if (target?.isConnected) target.focus()");
    expect(controller).toContain("if (dashboard.hidden && dialog.open) dialog.close()");
  });

  test("keeps response types and narrow-screen presentation aligned", () => {
    expect(declaration).toContain("interface ProjectBrief");
    expect(declaration).toContain("recentArtifacts: ProjectBriefArtifact[]");
    expect(controller).toContain("/project-brief.css");
    expect(styles).toContain(".project-brief-dialog");
    expect(styles).toContain(".project-brief-grid");
    expect(styles).toContain("@media (max-width: 720px)");
  });
});
