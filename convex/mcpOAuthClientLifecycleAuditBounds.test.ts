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
    const workspaceId = await insertWorkspace(t, workspace, observedAt);

    for (let start = 0; start < 1_001; start += 100) {
      const end = Math.min(start + 100, 1_001);
      await t.run(async (ctx: any) => {
        for (let index = start; index < end; index += 1) {
          await ctx.db.insert("mcpOAuthClients", clientRecord(
            workspaceId,
            `client_bound_${index}`,
            observedAt + index,
          ));
        }
      });
    }

    const result = await audit(t, observedAt, null, workspace);
    expect(result).toMatchObject({
      workspaceFound: true,
      cursor: null,
      scannedClients: 1_000,
      truncatedClients: true,
      pageRowOverflow: false,
      pageComplete: false,
      workspaceAuditComplete: false,
      readBounds: {
        maximumRowsRead: 1_001,
        maximumBytesRead: 1_048_576,
      },
      counts: {
        total: 1_000,
        legacy: 1_000,
        unusedLive: 0,
        unusedExpired: 0,
        used: 0,
        malformed: 0,
      },
      malformedRows: [],
      malformedRowsTruncated: false,
      lifecycleShapeClear: false,
      requiresExplicitRepair: false,
      requiresCleanupEvidence: false,
      requiresFurtherInspection: true,
      containsSecrets: false,
      grantsOAuthEnablement: false,
    });
    expect(result.continueCursor).toEqual(expect.any(String));
  });

  test("reads only the exact requested workspace", async () => {
    const t = convexTest(schema, modules);
    const observedAt = Date.parse("2026-08-02T03:30:00.000Z");
    const targetWorkspaceId = await insertWorkspace(t, workspace, observedAt);
    const otherWorkspaceId = await insertWorkspace(t, "other-workspace", observedAt);
    await t.run(async (ctx: any) => {
      await ctx.db.insert("mcpOAuthClients", clientRecord(
        targetWorkspaceId,
        "client_target_legacy",
        observedAt,
      ));
      await ctx.db.insert("mcpOAuthClients", clientRecord(
        targetWorkspaceId,
        "client_target_malformed",
        observedAt + 1,
        { lifecycleState: "unused" },
      ));
      for (let index = 0; index < 25; index += 1) {
        await ctx.db.insert("mcpOAuthClients", clientRecord(
          otherWorkspaceId,
          `client_other_${index}`,
          observedAt + index,
          { lifecycleState: "unused" },
        ));
      }
    });

    const result = await audit(t, observedAt + 100, null, workspace);
    expect(result).toMatchObject({
      workspace: workspace,
      scannedClients: 2,
      pageRowOverflow: false,
      pageComplete: true,
      workspaceAuditComplete: true,
      counts: {
        total: 2,
        legacy: 1,
        unusedLive: 0,
        unusedExpired: 0,
        used: 0,
        malformed: 1,
      },
      requiresExplicitRepair: true,
      requiresFurtherInspection: false,
      grantsOAuthEnablement: false,
    });
    expect(result.malformedRows).toHaveLength(1);
  });

  test("returns pageable incomplete evidence for byte-heavy valid rows", async () => {
    const t = convexTest(schema, modules);
    const observedAt = Date.parse("2026-08-02T04:00:00.000Z");
    const workspaceId = await insertWorkspace(t, workspace, observedAt);
    const heavyRedirects = Array.from({ length: 20 }, (_, index) =>
      `https://example.com/callback/${index}/${"x".repeat(1_850)}`
    );
    for (let start = 0; start < 30; start += 5) {
      await t.run(async (ctx: any) => {
        for (let index = start; index < start + 5; index += 1) {
          await ctx.db.insert("mcpOAuthClients", clientRecord(
            workspaceId,
            `client_byte_heavy_${index}`,
            observedAt + index,
            { redirectUris: heavyRedirects },
          ));
        }
      });
    }

    let cursor: string | null = null;
    let scanned = 0;
    let pages = 0;
    let sawIncompletePage = false;
    do {
      const result = await audit(t, observedAt + 100, cursor, workspace);
      pages += 1;
      scanned += result.scannedClients;
      expect(result.readBounds).toEqual({
        maximumRowsRead: 1_001,
        maximumBytesRead: 1_048_576,
      });
      expect(result.scannedClients).toBeLessThanOrEqual(1_000);
      expect(result.pageRowOverflow).toBe(false);
      expect(result.counts.malformed).toBe(0);
      expect(result.containsSecrets).toBe(false);
      expect(result.grantsOAuthEnablement).toBe(false);
      expect(JSON.stringify(result)).not.toContain("client_byte_heavy_");
      expect(JSON.stringify(result)).not.toContain("example.com/callback");
      if (!result.pageComplete) sawIncompletePage = true;
      cursor = result.continueCursor;
      expect(pages).toBeLessThan(20);
    } while (cursor !== null);

    expect(scanned).toBe(30);
    expect(pages).toBeGreaterThan(1);
    expect(sawIncompletePage).toBe(true);
  });
});

async function audit(
  t: ReturnType<typeof convexTest>,
  observedAt: number,
  cursor: string | null,
  targetWorkspace: string,
) {
  return await t.query(auditRef, {
    serviceSecret,
    workspace: targetWorkspace,
    observedAt,
    paginationOpts: pagination(cursor),
  });
}

function pagination(cursor: string | null) {
  return {
    numItems: 1_000,
    cursor,
    maximumRowsRead: 1_001,
    maximumBytesRead: 1_048_576,
  };
}

async function insertWorkspace(
  t: ReturnType<typeof convexTest>,
  slug: string,
  now: number,
) {
  return await t.run(async (ctx: any) => await ctx.db.insert("workspaces", {
    externalId: `workspace_${slug}`,
    slug,
    name: `Lifecycle audit workspace ${slug}`,
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
    clientName: "Lifecycle audit bounds client",
    redirectUris: ["https://chatgpt.com/connector/oauth/callback"],
    tokenEndpointAuthMethod: "none" as const,
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
}
