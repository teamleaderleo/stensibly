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
  test("records the first successful connection once and projects it only into an allowed project", async () => {
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

    const clock = vi.spyOn(Date, "now").mockReturnValue(1_234_567);
    try {
      await t.mutation(recordConnection, {
        serviceSecret,
        workspace,
        accountId: account.account.id,
        clientId: clientId("first"),
        resource,
      });
    } finally {
      clock.mockRestore();
    }
    expect(await evidence(t, account.account.id, "scrapbook")).toMatchObject({
      connectedAt: new Date(1_234_567).toISOString(),
      firstReadAt: null,
    });
    expect(await evidence(t, account.account.id, "other")).toMatchObject({
      connectedAt: null,
      firstReadAt: null,
    });

    const later = vi.spyOn(Date, "now").mockReturnValue(9_999_999);
    try {
      await t.mutation(recordConnection, {
        serviceSecret,
        workspace,
        accountId: account.account.id,
        clientId: clientId("second"),
        resource,
      });
    } finally {
      later.mockRestore();
    }
    expect(await evidence(t, account.account.id, "scrapbook")).toMatchObject({
      connectedAt: new Date(1_234_567).toISOString(),
    });
    const stored = await t.run(async (ctx) => {
      const ws = await ctx.db.query("workspaces").withIndex("by_slug", (q) => q.eq("slug", workspace)).unique();
      const dbAccount = await ctx.db.query("accounts").withIndex("by_external_id", (q) => q.eq("externalId", account.account.id)).unique();
      if (!ws || !dbAccount) throw new Error("MCP setup test state disappeared");
      return await ctx.db
        .query("mcpSetupConnections")
        .withIndex("by_workspace_account", (q) => q.eq("workspaceId", ws._id).eq("accountId", dbAccount._id))
        .unique();
    });
    expect(stored).toMatchObject({
      clientExternalId: clientId("first"),
      resource,
      connectedAt: 1_234_567,
    });
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

  test("allows current workspace-wide membership without inventing a project-specific connection row", async () => {
    const t = convexTest(schema, modules);
    const account = await upsertAccount(t, "3001");
    await ensureProject(t, "scrapbook");
    await registerClient(t, clientId("workspacewide"));
    await t.mutation(recordConnection, {
      serviceSecret,
      workspace,
      accountId: account.account.id,
      clientId: clientId("workspacewide"),
      resource,
    });
    expect((await evidence(t, account.account.id, "scrapbook")).connectedAt).not.toBeNull();
    const rows = await t.run(async (ctx) => await ctx.db.query("mcpSetupConnections").collect());
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "_creationTime",
      "_id",
      "accountId",
      "clientExternalId",
      "connectedAt",
      "resource",
      "workspaceId",
    ]);
  });

  test("rejects invalid or cross-workspace connection evidence before persistence", async () => {
    const t = convexTest(schema, modules);
    const account = await upsertAccount(t, "4001", ["scrapbook"]);
    await ensureProject(t, "scrapbook");
    await registerClient(t, clientId("valid"));
    await registerClient(t, clientId("foreign"), "other");

    await expect(t.mutation(recordConnection, {
      serviceSecret,
      workspace,
      accountId: account.account.id,
      clientId: "oauth_client_short",
      resource,
    })).rejects.toThrow("OAuth client identity is invalid");
    await expect(t.mutation(recordConnection, {
      serviceSecret,
      workspace,
      accountId: account.account.id,
      clientId: clientId("valid"),
      resource: "https://api.stensibly.com/mcp?token=hidden",
    })).rejects.toThrow("resource is invalid");
    await expect(t.mutation(recordConnection, {
      serviceSecret,
      workspace,
      accountId: account.account.id,
      clientId: clientId("foreign"),
      resource,
    })).rejects.toThrow("OAuth client is unavailable");

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
