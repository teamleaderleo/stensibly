import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "oauth-client-lifecycle-audit-bounds-secret";
const workspace = "audit-bounds";
const auditRef = makeFunctionReference<"query">(
  "mcpOAuthClientLifecycleAudit:auditClientLifecycles",
);

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("OAuth client lifecycle audit bounds", () => {
  test("marks a scan beyond the workspace ceiling as incomplete", async () => {
    const t = convexTest(schema, modules);
    const observedAt = Date.parse("2026-08-02T03:00:00.000Z");
    const workspaceId = await t.run(async (ctx: any) => await ctx.db.insert("workspaces", {
      externalId: `workspace_${workspace}`,
      slug: workspace,
      name: "Lifecycle audit bounds workspace",
      createdAt: observedAt,
      updatedAt: observedAt,
    }));

    for (let start = 0; start < 1_001; start += 100) {
      const end = Math.min(start + 100, 1_001);
      await t.run(async (ctx: any) => {
        for (let index = start; index < end; index += 1) {
          await ctx.db.insert("mcpOAuthClients", {
            workspaceId,
            externalId: `client_bound_${index}`,
            clientName: "Lifecycle audit bounds client",
            redirectUris: ["https://chatgpt.com/connector/oauth/callback"],
            tokenEndpointAuthMethod: "none",
            grantTypes: ["authorization_code"],
            responseTypes: ["code"],
            createdAt: observedAt + index,
            updatedAt: observedAt + index,
          });
        }
      });
    }

    const result = await t.query(auditRef, {
      serviceSecret,
      workspace,
      observedAt,
    });
    expect(result).toMatchObject({
      workspaceFound: true,
      scannedClients: 1_000,
      truncatedClients: true,
      counts: {
        total: 1_000,
        legacy: 1_000,
        unusedLive: 0,
        unusedExpired: 0,
        used: 0,
        malformed: 0,
      },
      malformedRows: [],
      malformedRowsTruncated: true,
      lifecycleShapeClear: false,
      requiresExplicitRepair: false,
      requiresCleanupEvidence: false,
      requiresFurtherInspection: true,
      containsSecrets: false,
      grantsOAuthEnablement: false,
    });
  });
});
