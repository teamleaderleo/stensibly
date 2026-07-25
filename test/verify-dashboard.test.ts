import { afterEach, describe, expect, test } from "bun:test";
import { serializeDashboardAssets } from "../src/dashboard-assets.ts";
import {
  dashboardAssets,
  formatGitHubErrorAnnotation,
  verifyDashboardHtml,
  verifyDashboardUrl,
} from "../src/verify-dashboard.ts";

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

describe("GitHub dashboard verification annotations", () => {
  test("escapes workflow command data without hiding the diagnostic", () => {
    expect(formatGitHubErrorAnnotation("asset failed 100%\nnext line")).toBe(
      "::error title=Dashboard verification failed::asset failed 100%25%0Anext line",
    );
  });
});

describe("dashboard asset verification contract", () => {
  test("matches the markers in every canonical verification asset", async () => {
    for (const asset of dashboardAssets) {
      const source = await Bun.file(new URL(`../site${asset.path}`, import.meta.url)).text();
      expect(source, `${asset.path} should contain ${asset.marker}`).toContain(asset.marker);
      expect(asset.contentTypes.length).toBeGreaterThan(0);
    }
  });

  test("serializes the same manifest consumed by staged verification", () => {
    expect(JSON.parse(serializeDashboardAssets())).toEqual(dashboardAssets);
  });

  test("keeps the deployment workflow on the canonical manifest", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/deploy-dashboard.yml", import.meta.url),
    ).text();
    expect(workflow).toContain("bun src/dashboard-assets.ts");
    expect(workflow).toContain("jq -r '.[] | [.path, .kind, (.contentTypes | join(\",\")), .marker] | @tsv'");
    expect(workflow).not.toContain("asset_specs=(");
  });
});

describe("dashboard URL verification", () => {
  test("checks the HTML and canonical deployment-verification asset set", async () => {
    globalThis.fetch = mockFetch(fullFixtures());

    await expect(verifyDashboardUrl("https://www.stensibly.com")).resolves.toBeUndefined();
  });

  test("rejects HTTP origins, bad content types, missing asset markers, and failed requests", async () => {
    await expect(verifyDashboardUrl("http://www.stensibly.com")).rejects.toThrow("HTTPS");

    const badType = new Map<string, [string, string]>([["/", [validHtml, "text/plain"]]]);
    globalThis.fetch = mockFetch(badType);
    await expect(verifyDashboardUrl("https://www.stensibly.com")).rejects.toThrow("content type");

    const badAssetType = fullFixtures();
    badAssetType.set("/styles.css", [":root {}", "text/plain"]);
    globalThis.fetch = mockFetch(badAssetType);
    await expect(verifyDashboardUrl("https://www.stensibly.com")).rejects.toThrow(
      "https://www.stensibly.com/styles.css returned unexpected content type text/plain",
    );

    const missingMarker = fullFixtures();
    missingMarker.set("/app.js", ["console.log('wrong bundle')", "text/javascript"]);
    globalThis.fetch = mockFetch(missingMarker);
    await expect(verifyDashboardUrl("https://www.stensibly.com")).rejects.toThrow(
      'https://www.stensibly.com/app.js is missing expected marker "DEFAULT_ENDPOINT"',
    );

    globalThis.fetch = (async () => new Response("missing", { status: 404 })) as unknown as typeof fetch;
    await expect(verifyDashboardUrl("https://www.stensibly.com")).rejects.toThrow("HTTP 404");
  });
});

function fullFixtures(): Map<string, [string, string]> {
  const fixtures = new Map<string, [string, string]>([["/", [validHtml, "text/html"]]]);
  for (const asset of dashboardAssets) {
    fixtures.set(asset.path, [asset.marker, asset.contentTypes[0]]);
  }
  return fixtures;
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
