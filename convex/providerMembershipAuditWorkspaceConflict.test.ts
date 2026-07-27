import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "provider-membership-audit-workspace-conflict-secret";
const auditRef = makeFunctionReference<"query">(
  "providerMembershipAudit:auditProviderMembership",
);

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("provider membership audit workspace integrity", () => {
  test("blocks clean bootstrap when the workspace index is ambiguous", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx: any) => {
      for (const suffix of ["a", "b"]) {
        await ctx.db.insert("workspaces", {
          externalId: `ws_test_${suffix}`,
          slug: "test",
          name: `test-${suffix}`,
          createdAt: suffix === "a" ? 1 : 2,
          updatedAt: suffix === "a" ? 1 : 2,
        });
      }
    });

    const result = await t.query(auditRef, {
      serviceSecret,
      workspace: "test",
      provider: "github",
      subject: "identity-is-absent",
    }) as any;

    expect(result).toEqual({
      version: 1,
      workspace: "test",
      provider: "github",
      status: "workspace_conflict",
      membership: null,
      cleanBootstrapEligible: false,
      requiresSeparateMembershipPlan: true,
      containsSecrets: false,
      readOnly: true,
      grantsMembershipChange: false,
      grantsMembership: false,
      grantsLogin: false,
      grantsOAuthEnablement: false,
    });
  });
});
