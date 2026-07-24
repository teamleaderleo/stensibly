import { describe, expect, test } from "bun:test";

const docs = await Bun.file(new URL("../docs/dashboard-deployment.md", import.meta.url)).text();

describe("dashboard deployment operations guide", () => {
  test("names the correct Vercel project, root, domains, and environment secrets", () => {
    expect(docs).toContain("project named `stensibly`");
    expect(docs).toContain("parked project named `stensibly-api`");
    expect(docs).toContain("Root Directory is exactly `site`");
    expect(docs).toContain("`www.stensibly.com`");
    expect(docs).toContain("`VERCEL_TOKEN`");
    expect(docs).toContain("`VERCEL_ORG_ID`");
    expect(docs).toContain("`VERCEL_PROJECT_ID`");
  });

  test("requires staged verification before promotion and disables automatic domain assignment", () => {
    expect(docs).toContain("turn off automatic assignment of custom production domains");
    expect(docs).toContain("`--skip-domain`");
    expect(docs).toContain("uses `vercel promote` only after those checks pass");
    expect(docs).toContain("Do not promote a deployment that has not passed the staged checks");
  });

  test("documents repository-root CLI use, clean-browser checks, and explicit rollback", () => {
    expect(docs).toContain("Run the CLI from the repository root");
    expect(docs).not.toContain("--cwd site");
    expect(docs).toContain("clean browser profile");
    expect(docs).toContain("vercel@56.5.0 rollback");
    expect(docs).toContain("Dashboard rollback changes static code only");
  });

  test("keeps unrelated production credentials out of the dashboard workflow", () => {
    expect(docs).toContain("does not receive");
    expect(docs).toContain("`STENSIBLY_SERVICE_SECRET`");
    expect(docs).toContain("`CONVEX_URL`");
    expect(docs).toContain("Cloudflare account or API credentials");
  });
});
