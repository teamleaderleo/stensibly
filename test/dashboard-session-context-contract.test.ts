import { describe, expect, test } from "bun:test";

const html = await Bun.file(new URL("../site/index.html", import.meta.url)).text();
const app = await Bun.file(new URL("../site/app.js", import.meta.url)).text();
const controller = await Bun.file(new URL("../site/session-context-controller.js", import.meta.url)).text();
const styles = await Bun.file(new URL("../site/styles.css", import.meta.url)).text();

describe("dashboard capability and actor integration", () => {
  test("ships capability and actor UI with server contract limits", () => {
    expect(html).toContain('id="session-context-panel"');
    expect(html).toContain('id="principal-summary"');
    expect(html).toContain('id="actor-form"');
    expect(html).toContain('maxlength="120"');
    expect(html).toContain('maxlength="160"');
  });

  test("refreshes capability after connect, manual refresh, and cancelled connection edits", () => {
    expect(app).toContain("createSessionContextController");
    expect(app.match(/sessionContext\.refresh\(\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(app).toContain("endpointChanged || tokenChanged");
    expect(app).toContain("sessionContext.reset()");
  });

  test("keeps actor state session-only and performs no ledger mutation", () => {
    expect(controller).toContain("sessionStorage.setItem");
    expect(controller).toContain("sessionStorage.removeItem");
    expect(controller).not.toContain("localStorage");
    expect(controller).toContain("/api/v1/principal");
    expect(controller).not.toMatch(/method:\s*['\"]POST['\"]/);
    expect(controller).not.toContain("/api/v1/items");
  });

  test("keeps older APIs read-only and routes auth failures to the connection path", () => {
    expect(controller).toContain("response.status === 404");
    expect(controller).toContain("Board inspection remains available");
    expect(controller).toContain("response.status === 401 || response.status === 403");
    expect(controller).toContain("reportConnectionIssue(message)");
  });

  test("uses stale-response guards and text-only rendering", () => {
    expect(controller).toContain("createRequestGate");
    expect(controller).toContain("gate.isCurrent");
    expect(controller).toContain("textContent");
    expect(controller).toContain("redactCredentialText");
    expect(controller).not.toContain("innerHTML");
  });

  test("includes responsive session presentation", () => {
    expect(styles).toContain(".session-context");
    expect(styles).toContain(".capability-badges");
    expect(styles).toContain(".actor-form");
  });
});
