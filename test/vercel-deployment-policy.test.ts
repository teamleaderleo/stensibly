import { describe, expect, test } from "bun:test";

const repositoryConfig = await Bun.file(
  new URL("../vercel.json", import.meta.url),
).json();
const dashboardConfig = await Bun.file(
  new URL("../site/vercel.json", import.meta.url),
).json();

describe("Vercel deployment policy", () => {
  test("disables automatic Git deployments for the repository-root project", () => {
    expect(repositoryConfig.git?.deploymentEnabled).toBe(false);
  });

  test("disables automatic Git deployments for the dashboard project", () => {
    expect(dashboardConfig.git?.deploymentEnabled).toBe(false);
  });

  test("preserves the dashboard static hosting configuration", () => {
    expect(dashboardConfig.cleanUrls).toBe(true);
    expect(Array.isArray(dashboardConfig.headers)).toBe(true);
    expect(dashboardConfig.headers[0]?.source).toBe("/(.*)");
  });
});
