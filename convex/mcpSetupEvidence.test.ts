import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "mcp-setup-evidence-test-secret";
const workspace = "test";
const resource = "https://api.stensibly.com/mcp";
const recordConnection = makeFunctionReference<"mutation">("mcpSetupEvidence:recordConnection");
const getEvidence = makeFunctionReference<"query">("mcpSetupEvidence:getEvidence");
const clientId = (label: string) => `oauth_client_${label.padEnd(12, "x")}`;

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("durable MCP setup connection evidence", () => {
  test("binds connection evidence to issuance-time project scope across later membership expansion", async () => {
    const t = convexTest(schema, modules);
    const account = await upsertAccount(t, "1001", ["scrapbook"]);
    await ensureProject(t, "scrapbook");
    await ensureProject(t, "other");
    await registerClient(t, clientId("first"));
    await registerClient(t, clientId("second"));

    expect(await evidence(t, account.account.id, "scrapbook")).toEqual({
      version: 1,
      accountId: account.account.id,
      project: "scrapbook",
      connectedAt: null,
      firstReadAt: null,
      containsSecrets: false,
    });

    const firstClock = vi.spyOn(Date, "now").mockReturnValue(1_234_567);
    try {
      await t.mutation(recordConnection, {
        serviceSecret,
        workspace,
        accountId: account.account.id,
        clientId: clientId("first"),
        resource,
        projects: ["scrapbook"],
      });
    } finally {
      firstClock.mockRestore();
    }
    expect(await evidence(t, account.account.id, "scrapbook")).toMatchObject({
      connectedAt: new Date(1_234_567).toISOString(),
      firstReadAt: null,
    });
    expect((await evidence(t, account.account.id, "other")).connectedAt).toBeNull();

    await setMembershipProjects(t, account.account.id, ["scrapbook", "other"]);
    expect((await evidence(t, account.account.id, "other")).connectedAt).toBeNull();

    const secondClock = vi.spyOn(Date, "now").mockReturnValue(9_999_999);
    try {
      await t.mutation(recordConnection, {
        serviceSecret,
        workspace,
        accountId: account.account.id,
        clientId: clientId("second"),
        resource,
        projects: ["scrapbook", "other"],
      });
    } finally {
      secondClock.mockRestore();
    }
    expect((await evidence(t, account.account.id, "scrapbook")).connectedAt)
      .toBe(new Date(1_234_567).toISOString());
    expect((await evidence(t, account.account.id, "other")).connectedAt)
      .toBe(new Date(9_999_999).toISOString());

    const stored = await connectionRows(t, account.account.id);
    expect(stored).toHaveLength(2);
    expect(stored.map((row: any) => ({
      project: row.project,
      clientExternalId: row.clientExternalId,
      connectedAt: row.connectedAt,
    }))).toEqual([
      {
        project: "other",
        clientExternalId: clientId("second"),
        connectedAt: 9_999_999,
      },
      {
        project: "scrapbook",
        clientExternalId: clientId("first"),
        connectedAt: 1_234_567,
      },
    ]);
  });

  test("keeps account, membership, and workspace scope isolated", async () => {
    const t = convexTest(schema, modules);
    const first = await upsertAccount(t, "2001", ["scrapbook"]);
    const second = await upsertAccount(t, "2002", ["scrapbook"]);
    await ensureProject(t, "scrapbook");
    await registerClient(t, clientId("isolation"));
    await t.mutation(recordConnection, {
      serviceSecret,
      workspace,
      accountId: first.account.id,
      clientId: clientId("isolation"),
      resource,
      projects: ["scrapbook"],
    });

    expect((await evidence(t, first.account.id, "scrapbook")).connectedAt).not.toBeNull();
    expect((await evidence(t, second.account.id, "scrapbook")).connectedAt).toBeNull();

    await t.run(async (ctx) => {
      const ws = await ctx.db.query("workspaces").withIndex("by_slug", (q) => q.eq("slug", workspace)).unique();
      const account = await ctx.db.query("accounts").withIndex("by_external_id", (q) => q.eq("externalId", first.account.id)).unique();
      if (!ws || !account) throw new Error("MCP setup test state disappeared");
      const membership = await ctx.db
        .query("workspaceMemberships")
        .withIndex("by_account_workspace", (q) => q.eq("accountId", account._id).eq("workspaceId", ws._id))
        .unique();
      if (!membership) throw new Error("MCP setup membership disappeared");
      await ctx.db.patch(membership._id, { revokedAt: Date.now() });
    });
    expect((await evidence(t, first.account.id, "scrapbook")).connectedAt).toBeNull();
    expect((await t.query(getEvidence, {
      serviceSecret,
      workspace: "other",
      accountId: first.account.id,
      project: "scrapbook",
    }) as any).connectedAt).toBeNull();
  });

  test("retains a workspace-wide issuance claim as one sentinel connection", async () => {
    const t = convexTest(schema, modules);
    const account = await upsertAccount(t, "3001");
    await ensureProject(t, "scrapbook");
    await ensureProject(t, "other");
    await registerClient(t, clientId("workspacewide"));
    const clock = vi.spyOn(Date, "now").mockReturnValue(3_000_000);
    try {
      await t.mutation(recordConnection, {
        serviceSecret,
        workspace,
        accountId: account.account.id,
        clientId: clientId("workspacewide"),
        resource,
        projects: null,
      });
    } finally {
      clock.mockRestore();
    }
    const expected = new Date(3_000_000).toISOString();
    expect((await evidence(t, account.account.id, "scrapbook")).connectedAt).toBe(expected);
    expect((await evidence(t, account.account.id, "other")).connectedAt).toBe(expected);

    await ensureProject(t, "later");
    expect((await evidence(t, account.account.id, "later")).connectedAt).toBe(expected);
    const rows = await connectionRows(t, account.account.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      project: null,
      clientExternalId: clientId("workspacewide"),
      resource,
      connectedAt: 3_000_000,
    });
  });

  test("keeps legacy unscoped rows inert until fresh scoped evidence arrives", async () => {
    const t = convexTest(schema, modules);
    const account = await upsertAccount(t, "3501", ["scrapbook"]);
    await ensureProject(t, "scrapbook");
    await registerClient(t, clientId("legacy"));
    await t.run(async (ctx) => {
      const ws = await ctx.db.query("workspaces").withIndex("by_slug", (q) => q.eq("slug", workspace)).unique();
      const dbAccount = await ctx.db.query("accounts").withIndex("by_external_id", (q) => q.eq("externalId", account.account.id)).unique();
      if (!ws || !dbAccount) throw new Error("MCP setup test state disappeared");
      await ctx.db.insert("mcpSetupConnections", {
        workspaceId: ws._id,
        accountId: dbAccount._id,
        clientExternalId: clientId("legacy"),
        resource,
        connectedAt: 1_000,
      });
    });
    expect((await evidence(t, account.account.id, "scrapbook")).connectedAt).toBeNull();

    await t.mutation(recordConnection, {
      serviceSecret,
      workspace,
      accountId: account.account.id,
      clientId: clientId("legacy"),
      resource,
      projects: ["scrapbook"],
    });
    expect((await evidence(t, account.account.id, "scrapbook")).connectedAt).not.toBeNull();
  });

  test("rejects invalid, widened, or cross-workspace connection evidence before persistence", async () => {
    const t = convexTest(schema, modules);
    const account = await upsertAccount(t, "4001", ["scrapbook"]);
    await ensureProject(t, "scrapbook");
    await ensureProject(t, "other");
    await registerClient(t, clientId("valid"));
    await registerClient(t, clientId("foreign"), "other");

    await expect(t.mutation(recordConnection, {
      serviceSecret,
      workspace,
      accountId: account.account.id,
      clientId: "oauth_client_short",
      resource,
      projects: ["scrapbook"],
    })).rejects.toThrow("OAuth client identity is invalid");
    await expect(t.mutation(recordConnection, {
      serviceSecret,
      workspace,
      accountId: account.account.id,
      clientId: clientId("valid"),
      resource: "https://api.stensibly.com/mcp?token=hidden",
      projects: ["scrapbook"],
    })).rejects.toThrow("resource is invalid");
    await expect(t.mutation(recordConnection, {
      serviceSecret,
      workspace,
      accountId: account.account.id,
      clientId: clientId("foreign"),
      resource,
      projects: ["scrapbook"],
    })).rejects.toThrow("OAuth client is unavailable");
    await expect(t.mutation(recordConnection, {
      serviceSecret,
      workspace,
      accountId: account.account.id,
      clientId: clientId("valid"),
      resource,
      projects: ["other"],
    })).rejects.toThrow("project scope is unavailable");
    await expect(t.mutation(recordConnection, {
      serviceSecret,
      workspace,
      accountId: account.account.id,
      clientId: clientId("valid"),
      resource,
      projects: null,
    })).rejects.toThrow("project scope is unavailable");
    await expect(t.mutation(recordConnection, {
      serviceSecret,
      workspace,
      accountId: account.account.id,
      clientId: clientId("valid"),
      resource,
      projects: ["scrapbook", "scrapbook"],
    })).rejects.toThrow("project scope is invalid");

    expect(await t.run(async (ctx) => await ctx.db.query("mcpSetupConnections").collect()))
      .toEqual([]);
  });
});

async function upsertAccount(
  t: ReturnType<typeof convexTest>,
  subject: string,
  projects?: string[],
) {
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

async function setMembershipProjects(
  t: any,
  accountId: string,
  projects: string[],
) {
  await t.run(async (ctx: any) => {
    const ws = await ctx.db.query("workspaces").withIndex("by_slug", (q: any) => q.eq("slug", workspace)).unique();
    const account = await ctx.db.query("accounts").withIndex("by_external_id", (q: any) => q.eq("externalId", accountId)).unique();
    if (!ws || !account) throw new Error("MCP setup test state disappeared");
    const membership = await ctx.db
      .query("workspaceMemberships")
      .withIndex("by_account_workspace", (q: any) => q.eq("accountId", account._id).eq("workspaceId", ws._id))
      .unique();
    if (!membership) throw new Error("MCP setup membership disappeared");
    await ctx.db.patch(membership._id, { projects, updatedAt: Date.now() });
  });
}

async function ensureProject(t: any, project: string) {
  await t.run(async (ctx: any) => {
    const ws = await ctx.db.query("workspaces").withIndex("by_slug", (q: any) => q.eq("slug", workspace)).unique();
    if (!ws) throw new Error("MCP setup workspace disappeared");
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_workspace_slug", (q: any) => q.eq("workspaceId", ws._id).eq("slug", project))
      .unique();
    if (existing) return;
    await ctx.db.insert("projects", {
      workspaceId: ws._id,
      externalId: `project_${workspace}_${project}`,
      slug: project,
      name: project,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function registerClient(
  t: ReturnType<typeof convexTest>,
  id: string,
  targetWorkspace = workspace,
) {
  if (targetWorkspace !== workspace) {
    await t.mutation(convexApi.accounts.upsertProviderIdentity, {
      serviceSecret,
      workspace: targetWorkspace,
      provider: "github",
      subject: `seed-${targetWorkspace}`,
      username: `seed-${targetWorkspace}`,
      displayName: "Seed",
      emailVerified: false,
      bootstrapRole: "viewer",
    });
  }
  return await t.mutation(convexApi.mcpOAuth.registerClient, {
    serviceSecret,
    workspace: targetWorkspace,
    clientId: id,
    clientName: "ChatGPT",
    redirectUris: ["https://chatgpt.com/connector/oauth/callback"],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
}

async function evidence(
  t: ReturnType<typeof convexTest>,
  accountId: string,
  project: string,
) {
  return await t.query(getEvidence, {
    serviceSecret,
    workspace,
    accountId,
    project,
  }) as any;
}

async function connectionRows(
  t: any,
  accountId: string,
) {
  return await t.run(async (ctx: any) => {
    const ws = await ctx.db.query("workspaces").withIndex("by_slug", (q: any) => q.eq("slug", workspace)).unique();
    const account = await ctx.db.query("accounts").withIndex("by_external_id", (q: any) => q.eq("externalId", accountId)).unique();
    if (!ws || !account) throw new Error("MCP setup test state disappeared");
    const rows = await ctx.db
      .query("mcpSetupConnections")
      .withIndex("by_workspace_account", (q: any) => q.eq("workspaceId", ws._id).eq("accountId", account._id))
      .collect();
    return rows.sort((left: any, right: any) => String(left.project).localeCompare(String(right.project)));
  });
}
