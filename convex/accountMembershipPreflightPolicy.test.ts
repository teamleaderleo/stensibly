import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "membership-preflight-policy-secret";
const inspectRef = makeFunctionReference<"query">(
  "accountMembershipPreflight:inspect",
);

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("hosted membership preflight policy validation", () => {
  test("fails closed without returning malformed stored project values", async () => {
    const t = convexTest(schema, modules);
    await insertFixture(t, ["oauth-dogfood", "credential=private-value"]);

    const result = await inspect(t);
    expect(result).toMatchObject({
      state: "membership_malformed",
      workspaceFound: true,
      identityFound: true,
      accountAvailable: true,
      accountDisabled: false,
      membership: null,
      containsSecrets: false,
      readOnly: true,
      grantsMembershipChange: false,
    });
    expect(JSON.stringify(result)).not.toContain("credential=private-value");
  });

  test("rejects duplicate and over-count stored allowlists as malformed", async () => {
    const duplicate = convexTest(schema, modules);
    await insertFixture(duplicate, ["oauth-dogfood", "oauth-dogfood"]);
    expect(await inspect(duplicate)).toMatchObject({
      state: "membership_malformed",
      membership: null,
    });

    const excessive = convexTest(schema, modules);
    await insertFixture(
      excessive,
      Array.from({ length: 33 }, (_, index) => `project-${index}`),
    );
    expect(await inspect(excessive)).toMatchObject({
      state: "membership_malformed",
      membership: null,
    });
  });
});

async function inspect(t: ReturnType<typeof convexTest>) {
  return await t.query(inspectRef, {
    serviceSecret,
    workspace: "default",
    provider: "github",
    subject: "13091533",
  });
}

async function insertFixture(
  t: ReturnType<typeof convexTest>,
  projects: string[],
) {
  await t.run(async (ctx: any) => {
    const now = 1_000;
    const workspaceId = await ctx.db.insert("workspaces", {
      externalId: "workspace_default",
      slug: "default",
      name: "Default",
      createdAt: now,
      updatedAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      externalId: "acct_preflight_policy",
      displayName: "Private account",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("accountIdentities", {
      accountId,
      provider: "github",
      subject: "13091533",
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("workspaceMemberships", {
      workspaceId,
      accountId,
      role: "viewer",
      projects,
      createdAt: now,
      updatedAt: now,
    });
  });
}
