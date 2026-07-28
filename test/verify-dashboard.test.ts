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
<title>Stensibly · Shared work</title>
<meta name="description" content="Stensibly keeps shared work visible and resumable for people and agents." />
<link rel="stylesheet" href="/styles.css" />
<link rel="stylesheet" href="/item-claim.css" />
<link rel="stylesheet" href="/hosted-session.css" />
<link rel="stylesheet" href="/login-scrapbook.css" />
</head><body>
<button id="github-sign-in"></button>
<form id="connect-form"></form>
<section id="dashboard"></section>
<dialog id="item-detail-dialog"></dialog>
<p id="item-detail-announcer"></p>
<script src="/hosted-session-bridge.js" type="module"></script>
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

  test("accepts the checked-in dashboard shell", async () => {
    const source = await Bun.file(new URL("../site/index.html", import.meta.url)).text();
    expect(() => verifyDashboardHtml(source)).not.toThrow();
  });

  test("rejects retired shell copy, missing UI markers, and token-shaped values", () => {
    expect(() => verifyDashboardHtml(validHtml.replace("Shared work", "Agent scrapbook")))
      .toThrow("Shared work");
    expect(() => verifyDashboardHtml(validHtml.replace('id="dashboard"', 'id="missing"')))
      .toThrow("dashboard");
    expect(() => verifyDashboardHtml(validHtml + "stn.tok_deadbeef.secret"))
      .toThrow("token-shaped");
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

  test("includes the attributable item activity and login paths", () => {
    expect(dashboardAssets).toContainEqual(expect.objectContaining({
      path: "/item-detail-controller.js",
      marker: "activityThreadSection",
    }));
    expect(dashboardAssets).toContainEqual(expect.objectContaining({
      path: "/item-activity-thread.js",
      marker: "projectActivityThread",
    }));
    expect(dashboardAssets).toContainEqual(expect.objectContaining({
      path: "/styles.css",
      marker: ".detail-activity-thread",
    }));
    expect(dashboardAssets).toContainEqual(expect.objectContaining({
      path: "/login-scrapbook.css",
      marker: ".login-card",
    }));
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
    badAssetType.set("/styles.css", [".detail-activity-thread {}", "text/plain"]);
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