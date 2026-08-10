import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "mcp-first-read-test-secret";
const workspace = "test";
const resource = "https://api.stensibly.com/mcp";
const recordConnection = makeFunctionReference<"mutation">("mcpSetupEvidence:recordConnection");
const recordFirstRead = makeFunctionReference<"mutation">("mcpSetupEvidence:recordFirstRead");
const getEvidence = makeFunctionReference<"query">("mcpSetupEvidence:getEvidence");
const clientId = "oauth_client_firstread123";

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("durable MCP first-read evidence", () => {
  test("requires project-scoped connection evidence, then preserves the first successful project read", async () => {
    const t = convexTest(schema, modules);
    const account = await setupAccount(t, "5101", ["scrapbook"]);
    await ensureProject(t, "scrapbook");
    await registerClient(t);

    await expect(t.mutation(recordFirstRead, {
      serviceSecret,
      workspace,
      accountId: account.account.id,
      project: "scrapbook",
    })).rejects.toThrow("connection evidence is unavailable");

    const connectionClock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      await t.mutation(recordConnection, {
        serviceSecret,
        workspace,
        accountId: account.account.id,
        clientId,
        resource,
        projects: ["scrapbook"],
      });
    } finally {
      connectionClock.mockRestore();
    }

    const firstReadClock = vi.spyOn(Date, "now").mockReturnValue(1_000_500);
    try {
      await t.mutation(recordFirstRead, {
        serviceSecret,
        workspace,
        accountId: account.account.id,
        project: "scrapbook",
      });
    } finally {
      firstReadClock.mockRestore();
    }
    expect(await evidence(t, account.account.id, "scrapbook")).toMatchObject({
      connectedAt: new Date(1_000_000).toISOString(),
      firstReadAt: new Date(1_000_500).toISOString(),
    });

    const replayClock = vi.spyOn(Date, "now").mockReturnValue(9_999_999);
    try {
      await t.mutation(recordFirstRead, {
        serviceSecret,
        workspace,
        accountId: account.account.id,
        project: "scrapbook",
      });
    } finally {
      replayClock.mockRestore();
    }
    expect((await evidence(t, account.account.id, "scrapbook")).firstReadAt)
      .toBe(new Date(1_000_500).toISOString());

    const rows = await t.run(async (ctx) => await ctx.db.query("mcpSetupFirstReads").collect());
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "_creationTime",
      "_id",
      "accountId",
      "firstReadAt",
      "projectId",
      "workspaceId",
    ]);
  });

  test("later membership expansion cannot create first-read authority without matching connection coverage", async () => {
    const t = convexTest(schema, modules);
    const first = await setupAccount(t, "5201", ["scrapbook"]);
    const second = await setupAccount(t, "5202", ["other"]);
    await ensureProject(t, "scrapbook");
    await ensureProject(t, "other");
    await registerClient(t);
    await t.mutation(recordConnection, {
      serviceSecret,
      workspace,
      accountId: first.account.id,
      clientId,
      resource,
      projects: ["scrapbook"],
    });
    await t.mutation(recordFirstRead, {
      serviceSecret,
      workspace,
      accountId: first.account.id,
      project: "scrapbook",
    });

    expect((await evidence(t, first.account.id, "scrapbook")).firstReadAt).not.toBeNull();
    expect((await evidence(t, first.account.id, "other")).firstReadAt).toBeNull();
    expect((await evidence(t, second.account.id, "other")).firstReadAt).toBeNull();
    await expect(t.mutation(recordFirstRead, {
      serviceSecret,
      workspace,
      accountId: first.account.id,
      project: "other",
    })).rejects.toThrow("project access is unavailable");

    await setMembershipProjects(t, first.account.id, ["scrapbook", "other"]);
    await expect(t.mutation(recordFirstRead, {
      serviceSecret,
      workspace,
      accountId: first.account.id,
      project: "other",
    })).rejects.toThrow("connection evidence is unavailable");
    expect((await evidence(t, first.account.id, "other")).connectedAt).toBeNull();

    await t.mutation(recordConnection, {
      serviceSecret,
      workspace,
      accountId: first.account.id,
      clientId,
      resource,
      projects: ["other"],
    });
    await t.mutation(recordFirstRead, {
      serviceSecret,
      workspace,
      accountId: first.account.id,
      project: "other",
    });
    expect((await evidence(t, first.account.id, "other")).firstReadAt).not.toBeNull();

    await revokeMembership(t, first.account.id);
    expect((await evidence(t, first.account.id, "scrapbook")).connectedAt).toBeNull();
    expect((await evidence(t, first.account.id, "scrapbook")).firstReadAt).toBeNull();
  });

  test("rejects a trusted clock regression before persisting first-read evidence", async () => {
    const t = convexTest(schema, modules);
    const account = await setupAccount(t, "5301", ["scrapbook"]);
    await ensureProject(t, "scrapbook");
    await registerClient(t);
    const connectionClock = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    try {
      await t.mutation(recordConnection, {
        serviceSecret,
        workspace,
        accountId: account.account.id,
        clientId,
        resource,
        projects: ["scrapbook"],
      });
    } finally {
      connectionClock.mockRestore();
    }

    const regressed = vi.spyOn(Date, "now").mockReturnValue(1_999_999);
    try {
      await expect(t.mutation(recordFirstRead, {
        serviceSecret,
        workspace,
        accountId: account.account.id,
        project: "scrapbook",
      })).rejects.toThrow("predates connection evidence");
    } finally {
      regressed.mockRestore();
    }
    expect(await t.run(async (ctx) => await ctx.db.query("mcpSetupFirstReads").collect()))
      .toEqual([]);
  });
});

async function setupAccount(t: any, subject: string, projects?: string[]) {
  return await t.mutation(convexApi.accounts.upsertProviderIdentity, {
    serviceSecret,
    workspace,
    provider: "github",
    subject,
    username: `user-${subject}`,
    displayName: `User ${subject}`,
    emailVerified: false,
    bootstrapRole: "member",
    projects,
  }) as any;
}

async function ensureProject(t: any, project: string) {
  await t.run(async (ctx: any) => {
    const ws = await ctx.db.query("workspaces").withIndex("by_slug", (q: any) => q.eq("slug", workspace)).unique();
    if (!ws) throw new Error("First-read workspace disappeared");
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_workspace_slug", (q: any) => q.eq("workspaceId", ws._id).eq("slug", project))
      .unique();
    if (!existing) {
      await ctx.db.insert("projects", {
        workspaceId: ws._id,
        externalId: `project_${workspace}_${project}`,
        slug: project,
        name: project,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  });
}

async function setMembershipProjects(t: any, accountId: string, projects: string[]) {
  await t.run(async (ctx: any) => {
    const membership = await findMembership(ctx, accountId);
    await ctx.db.patch(membership._id, { projects, updatedAt: Date.now() });
  });
}

async function revokeMembership(t: any, accountId: string) {
  await t.run(async (ctx: any) => {
    const membership = await findMembership(ctx, accountId);
    await ctx.db.patch(membership._id, { revokedAt: Date.now() });
  });
}

async function findMembership(ctx: any, accountId: string) {
  const ws = await ctx.db.query("workspaces").withIndex("by_slug", (q: any) => q.eq("slug", workspace)).unique();
  const account = await ctx.db.query("accounts").withIndex("by_external_id", (q: any) => q.eq("externalId", accountId)).unique();
  if (!ws || !account) throw new Error("First-read test state disappeared");
  const membership = await ctx.db
    .query("workspaceMemberships")
    .withIndex("by_account_workspace", (q: any) => q.eq("accountId", account._id).eq("workspaceId", ws._id))
    .unique();
  if (!membership) throw new Error("First-read membership disappeared");
  return membership;
}

async function registerClient(t: any) {
  await t.mutation(convexApi.mcpOAuth.registerClient, {
    serviceSecret,
    workspace,
    clientId,
    clientName: "ChatGPT",
    redirectUris: ["https://chatgpt.com/connector/oauth/callback"],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
}

async function evidence(t: any, accountId: string, project: string) {
  return await t.query(getEvidence, {
    serviceSecret,
    workspace,
    accountId,
    project,
  }) as any;
}
