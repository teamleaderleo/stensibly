import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "oauth-client-lifecycle-audit-secret";
const workspace = "test";
const auditRef = makeFunctionReference<"query">(
  "mcpOAuthClientLifecycleAudit:auditClientLifecycles",
);

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("OAuth client lifecycle audit", () => {
  test("classifies lifecycle rows without exposing client metadata", async () => {
    const t = convexTest(schema, modules);
    const observedAt = Date.parse("2026-08-02T00:00:00.000Z");
    const workspaceId = await insertWorkspace(t, observedAt);
    await t.run(async (ctx: any) => {
      await ctx.db.insert("mcpOAuthClients", clientRecord(
        workspaceId,
        "client_legacy_secret_value",
        observedAt - 10_000,
      ));
      await ctx.db.insert("mcpOAuthClients", clientRecord(
        workspaceId,
        "client_unused_live_secret_value",
        observedAt - 9_000,
        {
          lifecycleState: "unused",
          unusedExpiresAt: observedAt + 1,
          cleanupScheduledAt: observedAt + 1,
          cleanupScheduleGeneration: 1,
        },
      ));
      await ctx.db.insert("mcpOAuthClients", clientRecord(
        workspaceId,
        "client_unused_expired_secret_value",
        observedAt - 8_000,
        {
          lifecycleState: "unused",
          unusedExpiresAt: observedAt,
          cleanupScheduledAt: observedAt,
          cleanupScheduleGeneration: 2,
        },
      ));
      await ctx.db.insert("mcpOAuthClients", clientRecord(
        workspaceId,
        "client_used_secret_value",
        observedAt - 7_000,
        {
          lifecycleState: "used",
          firstUsedAt: observedAt - 6_000,
        },
      ));
      await ctx.db.insert("mcpOAuthClients", clientRecord(
        workspaceId,
        "client_quarantine_shape_secret_value",
        observedAt - 5_000,
        { lifecycleState: "unused" },
      ));
      await ctx.db.insert("mcpOAuthClients", clientRecord(
        workspaceId,
        "client_contradictory_secret_value",
        observedAt - 4_000,
        {
          lifecycleState: "used",
          firstUsedAt: observedAt - 3_000,
          unusedExpiresAt: observedAt + 100,
        },
      ));
    });

    const result = await audit(t, observedAt);
    expect(result).toMatchObject({
      version: 1,
      workspace,
      workspaceFound: true,
      observedAt,
      scannedClients: 6,
      truncatedClients: false,
      counts: {
        total: 6,
        legacy: 1,
        unusedLive: 1,
        unusedExpired: 1,
        used: 1,
        malformed: 2,
      },
      malformedRowsTruncated: false,
      lifecycleShapeClear: false,
      requiresExplicitRepair: true,
      requiresCleanupEvidence: true,
      requiresFurtherInspection: false,
      containsSecrets: false,
      grantsOAuthEnablement: false,
    });
    expect(result.malformedRows).toHaveLength(2);
    expect(result.malformedRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        classification: "malformed",
        lifecycleState: "unused",
        hasUnusedExpiresAt: false,
        hasFirstUsedAt: false,
        hasCleanupScheduledAt: false,
        hasCleanupScheduleGeneration: false,
      }),
      expect.objectContaining({
        classification: "malformed",
        lifecycleState: "used",
        hasUnusedExpiresAt: true,
        hasFirstUsedAt: true,
      }),
    ]));

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("client_legacy_secret_value");
    expect(serialized).not.toContain("Lifecycle audit client");
    expect(serialized).not.toContain("chatgpt.com");
    expect(serialized).not.toContain("secretHash");
  });

  test("distinguishes a complete clear shape audit from a missing workspace", async () => {
    const observedAt = Date.parse("2026-08-02T01:00:00.000Z");
    const missing = await audit(convexTest(schema, modules), observedAt);
    expect(missing).toMatchObject({
      workspaceFound: false,
      scannedClients: 0,
      lifecycleShapeClear: false,
      requiresExplicitRepair: false,
      requiresCleanupEvidence: false,
      requiresFurtherInspection: true,
      grantsOAuthEnablement: false,
    });

    const t = convexTest(schema, modules);
    const workspaceId = await insertWorkspace(t, observedAt);
    await t.run(async (ctx: any) => {
      await ctx.db.insert("mcpOAuthClients", clientRecord(
        workspaceId,
        "client_clear_legacy",
        observedAt - 2,
      ));
      await ctx.db.insert("mcpOAuthClients", clientRecord(
        workspaceId,
        "client_clear_used",
        observedAt - 1,
        { lifecycleState: "used", firstUsedAt: observedAt - 1 },
      ));
    });
    const clear = await audit(t, observedAt);
    expect(clear).toMatchObject({
      workspaceFound: true,
      scannedClients: 2,
      counts: {
        total: 2,
        legacy: 1,
        unusedLive: 0,
        unusedExpired: 0,
        used: 1,
        malformed: 0,
      },
      lifecycleShapeClear: true,
      requiresExplicitRepair: false,
      requiresCleanupEvidence: false,
      requiresFurtherInspection: false,
      grantsOAuthEnablement: false,
    });
  });

  test("bounds malformed row references while retaining aggregate evidence", async () => {
    const t = convexTest(schema, modules);
    const observedAt = Date.parse("2026-08-02T02:00:00.000Z");
    const workspaceId = await insertWorkspace(t, observedAt);
    await t.run(async (ctx: any) => {
      for (let index = 0; index < 101; index += 1) {
        await ctx.db.insert("mcpOAuthClients", clientRecord(
          workspaceId,
          `client_malformed_${index}`,
          observedAt - index,
          { lifecycleState: "unused" },
        ));
      }
    });

    const result = await audit(t, observedAt);
    expect(result.counts.malformed).toBe(101);
    expect(result.malformedRows).toHaveLength(100);
    expect(result.malformedRowsTruncated).toBe(true);
    expect(result.requiresExplicitRepair).toBe(true);
    expect(result.requiresFurtherInspection).toBe(true);
    expect(result.lifecycleShapeClear).toBe(false);
  });

  test("rejects invalid observation times and invalid service authentication", async () => {
    const t = convexTest(schema, modules);
    await expect(audit(t, -1)).rejects.toThrow("Lifecycle audit time is invalid");
    await expect(audit(t, 1.5)).rejects.toThrow("Lifecycle audit time is invalid");
    await expect(t.query(auditRef, {
      serviceSecret: "wrong-secret",
      workspace,
      observedAt: 1,
    })).rejects.toThrow();
  });
});

async function audit(t: ReturnType<typeof convexTest>, observedAt: number) {
  return await t.query(auditRef, {
    serviceSecret,
    workspace,
    observedAt,
  });
}

async function insertWorkspace(
  t: ReturnType<typeof convexTest>,
  now: number,
) {
  return await t.run(async (ctx: any) => await ctx.db.insert("workspaces", {
    externalId: `workspace_${workspace}`,
    slug: workspace,
    name: "Lifecycle audit workspace",
    createdAt: now,
    updatedAt: now,
  }));
}

function clientRecord(
  workspaceId: any,
  externalId: string,
  now: number,
  fields: Record<string, unknown> = {},
) {
  return {
    workspaceId,
    externalId,
    clientName: "Lifecycle audit client",
    redirectUris: ["https://chatgpt.com/connector/oauth/callback"],
    tokenEndpointAuthMethod: "none" as const,
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
}
