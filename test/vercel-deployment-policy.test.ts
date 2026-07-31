import { describe, expect, test } from "bun:test";

const repositoryConfig = await Bun.file(
  new URL("../vercel.json", import.meta.url),
).json();
const dashboardConfig = await Bun.file(
  new URL("../site/vercel.json", import.meta.url),
).json();

const dashboardHeaders = new Map<string, Map<string, string>>(
  dashboardConfig.headers.map((entry: { source: string; headers: Array<{ key: string; value: string }> }): [string, Map<string, string>] => [
    entry.source,
    new Map<string, string>(entry.headers.map((header): [string, string] => [header.key, header.value])),
  ]),
);

const labsRootSource = "/labs";
const labsNestedSource = "/labs/:path(.*)";
const productionSource = "/((?!labs(?:/|$)).*)";

function matchesDashboardHeaderSource(source: string, path: string): boolean {
  if (source === labsRootSource) return path === "/labs";
  if (source === labsNestedSource) return path.startsWith("/labs/");
  return new RegExp(`^${source}$`).test(path);
}

describe("Vercel deployment policy", () => {
  test("disables automatic Git deployments for the repository-root project", () => {
    expect(repositoryConfig.git?.deploymentEnabled).toBe(false);
  });

  test("disables automatic Git deployments for the dashboard project", () => {
    expect(dashboardConfig.git?.deploymentEnabled).toBe(false);
  });

  test("preserves clean static hosting with disjoint labs and production header policies", () => {
    expect(dashboardConfig.cleanUrls).toBe(true);
    expect([...dashboardHeaders.keys()]).toEqual([
      labsRootSource,
      labsNestedSource,
      productionSource,
    ]);

    expect(matchesDashboardHeaderSource(labsRootSource, "/labs")).toBe(true);
    expect(matchesDashboardHeaderSource(labsNestedSource, "/labs")).toBe(false);
    for (const path of [
      "/labs/",
      "/labs/quiet-control/",
      "/labs/soft-companion/",
      "/labs/quiet-control/index.html",
    ]) {
      expect(matchesDashboardHeaderSource(labsNestedSource, path)).toBe(true);
      expect(matchesDashboardHeaderSource(productionSource, path)).toBe(false);
    }
    expect(matchesDashboardHeaderSource(productionSource, "/index.html")).toBe(true);
  });

  test("allows only same-origin labs framing while keeping the production dashboard unframeable", () => {
    for (const source of [labsRootSource, labsNestedSource]) {
      expect(dashboardHeaders.get(source)?.get("Content-Security-Policy")).toContain("frame-ancestors 'self'");
      expect(dashboardHeaders.get(source)?.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
      expect(dashboardHeaders.get(source)?.get("X-Content-Type-Options")).toBe("nosniff");
    }
    expect(dashboardHeaders.get(productionSource)?.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(dashboardHeaders.get(productionSource)?.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
