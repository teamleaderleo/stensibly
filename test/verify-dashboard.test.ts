import { afterEach, describe, expect, test } from "bun:test";
import { verifyDashboardHtml, verifyDashboardUrl } from "../src/verify-dashboard.ts";

const validHtml = `<!doctype html>
<html><head>
<title>Stensibly · Agent scrapbook</title>
<meta name="description" content="Stensibly is a shared work-in-progress ledger for humans and agents." />
<link rel="stylesheet" href="/styles.css" />
<link rel="stylesheet" href="/item-claim.css" />
</head><body>
<form id="connect-form"></form>
<section id="dashboard"></section>
<dialog id="item-detail-dialog"></dialog>
<script src="/app.js" type="module"></script>
</body></html>`;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("dashboard HTML verification", () => {
  test("accepts the production shell markers", () => {
    expect(() => verifyDashboardHtml(validHtml)).not.toThrow();
  });

  test("rejects missing UI markers and token-shaped values", () => {
    expect(() => verifyDashboardHtml(validHtml.replace('id="dashboard"', 'id="missing"'))).toThrow("dashboard");
    expect(() => verifyDashboardHtml(validHtml + "stn.tok_deadbeef.secret")).toThrow("token-shaped");
  });
});

describe("dashboard URL verification", () => {
  test("checks the HTML and critical static module graph", async () => {
    const fixtures = new Map<string, [string, string]>([
      ["/", [validHtml, "text/html; charset=utf-8"]],
      ["/styles.css", [":root { color-scheme: dark; }", "text/css"]],
      ["/app.js", ["const DEFAULT_ENDPOINT = 'https://api.stensibly.com';", "text/javascript"]],
      ["/item-claim.css", [".detail-claim-form {}", "text/css"]],
      ["/item-claim.js", ["export function validateClaimInput() {}", "text/javascript"]],
      ["/item-progress-controller.js", ["export function installProgressController() {}", "text/javascript"]],
      ["/item-block-controller.js", ["export function installBlockController() {}", "text/javascript"]],
      ["/item-complete-controller.js", ["export function installCompletionController() {}", "text/javascript"]],
      ["/favicon.svg", ["<svg></svg>", "image/svg+xml"]],
    ]);
    globalThis.fetch = mockFetch(fixtures);

    await expect(verifyDashboardUrl("https://www.stensibly.com")).resolves.toBeUndefined();
  });

  test("rejects HTTP origins, bad content types, missing asset markers, and failed requests", async () => {
    await expect(verifyDashboardUrl("http://www.stensibly.com")).rejects.toThrow("HTTPS");

    const badType = new Map<string, [string, string]>([["/", [validHtml, "text/plain"]]]);
    globalThis.fetch = mockFetch(badType);
    await expect(verifyDashboardUrl("https://www.stensibly.com")).rejects.toThrow("content type");

    const missingMarker = fullFixtures();
    missingMarker.set("/app.js", ["console.log('wrong bundle')", "text/javascript"]);
    globalThis.fetch = mockFetch(missingMarker);
    await expect(verifyDashboardUrl("https://www.stensibly.com")).rejects.toThrow("expected marker");

    globalThis.fetch = (async () => new Response("missing", { status: 404 })) as typeof fetch;
    await expect(verifyDashboardUrl("https://www.stensibly.com")).rejects.toThrow("HTTP 404");
  });
});

function fullFixtures(): Map<string, [string, string]> {
  return new Map([
    ["/", [validHtml, "text/html"]],
    ["/styles.css", [":root {}", "text/css"]],
    ["/app.js", ["DEFAULT_ENDPOINT", "application/javascript"]],
    ["/item-claim.css", [".detail-claim", "text/css"]],
    ["/item-claim.js", ["validateClaimInput", "application/javascript"]],
    ["/item-progress-controller.js", ["installProgressController", "application/javascript"]],
    ["/item-block-controller.js", ["installBlockController", "application/javascript"]],
    ["/item-complete-controller.js", ["installCompletionController", "application/javascript"]],
    ["/favicon.svg", ["<svg", "image/svg+xml"]],
  ]);
}

function mockFetch(fixtures: Map<string, [string, string]>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const fixture = fixtures.get(url.pathname);
    if (!fixture) return new Response("missing", { status: 404 });
    return new Response(fixture[0], {
      status: 200,
      headers: { "content-type": fixture[1] },
    });
  }) as typeof fetch;
}
