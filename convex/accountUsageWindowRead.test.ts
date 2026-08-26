import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "account-usage-window-read-service-secret";
const reserveRef = makeFunctionReference<"mutation">(
  "accountUsageReservations:reserve",
);
const settleRef = makeFunctionReference<"mutation">(
  "accountUsageReservations:settle",
);
const readWindowRef = makeFunctionReference<"query">(
  "accountUsageReservations:readWindow",
);
const decisionFingerprint = `sha256:${"a".repeat(64)}`;
const observedAt = "2026-08-26T12:00:10.000Z";

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("durable account usage window reads", () => {
  test("compiles consumed and held reservations from the exact durable window", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, "default");

    await reserve(t, "acct_public_beta_1", "request_consumed", 3);
    await settle(t, "acct_public_beta_1", "request_consumed", "consumed", "settled_consumed");
    await reserve(t, "acct_public_beta_1", "request_ambiguous", 5);
    await settle(t, "acct_public_beta_1", "request_ambiguous", "ambiguous", "dispatch_unknown");
    await reserve(t, "acct_public_beta_1", "request_released", 7);
    await settle(t, "acct_public_beta_1", "request_released", "released", "settled_released");

    const evidence = await readWindow(t, "acct_public_beta_1");
    expect(evidence).toMatchObject({
      version: 1,
      subject: {
        kind: "account",
        id: "acct_public_beta_1",
        workspace: "default",
      },
      serviceClass: "hosted_read",
      windowId: "window_2026_08",
      usage: {
        state: "known",
        consumed: 3,
        reserved: 5,
        observedAt,
      },
      receiptCount: 3,
      grantsAuthority: false,
      grantsProviderBudget: false,
    });
    expect(evidence.receiptSetFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evidence.evidenceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("returns authoritative zero usage for an observed empty window", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, "default");

    const evidence = await readWindow(t, "acct_empty");
    expect(evidence.usage).toEqual({
      state: "known",
      consumed: 0,
      reserved: 0,
      observedAt,
    });
    expect(evidence.receiptCount).toBe(0);
  });

  test("isolates accounts, service classes, and window identities in the index query", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, "default");

    await reserve(t, "acct_target", "target_read", 2);
    await reserve(t, "acct_other", "other_account", 9);
    await reserve(t, "acct_target", "target_write", 8, {
      serviceClass: "hosted_write",
    });
    await reserve(t, "acct_target", "target_other_window", 7, {
      windowId: "window_other",
    });

    const evidence = await readWindow(t, "acct_target");
    expect(evidence.usage).toMatchObject({ consumed: 0, reserved: 2 });
    expect(evidence.receiptCount).toBe(1);
  });

  test("isolates account and authorization subjects with the same external id", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, "default");

    await reserve(t, "shared_identity", "account_request", 2);
    await reserve(t, "shared_identity", "authorization_request", 6, {
      subjectKind: "authorization",
    });

    const account = await readWindow(t, "shared_identity");
    const authorization = await readWindow(t, "shared_identity", {
      subjectKind: "authorization",
    });
    expect(account.usage.reserved).toBe(2);
    expect(authorization.usage.reserved).toBe(6);
  });

  test("fails closed when one durable row is corrupted before aggregation", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, "default");
    await reserve(t, "acct_corrupt", "request_corrupt", 2);

    await t.run(async (ctx: any) => {
      const row = await ctx.db.query("accountUsageReservations").unique();
      await ctx.db.patch(row._id, {
        receiptFingerprint: `sha256:${"f".repeat(64)}`,
      });
    });

    await expect(readWindow(t, "acct_corrupt"))
      .rejects.toThrow("ACCOUNT_USAGE_RESERVATION_STORED_ROW_INVALID");
  });

  test("fails closed when a row is newer than the declared observation", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, "default");
    await reserve(t, "acct_future", "request_future", 1);
    await settle(
      t,
      "acct_future",
      "request_future",
      "consumed",
      "settled_future",
      "2026-08-26T12:00:11.000Z",
    );

    await expect(readWindow(t, "acct_future"))
      .rejects.toThrow("future receipt evidence");
  });

  test("requires the service secret for window evidence", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, "default");

    await expect(t.query(readWindowRef, {
      serviceSecret: "wrong-secret",
      workspace: "default",
      subjectKind: "account",
      subjectId: "acct_public_beta_1",
      serviceClass: "hosted_read",
      windowId: "window_2026_08",
      observedAt,
    })).rejects.toThrow("Unauthorized");
  });
});

async function reserve(
  t: ReturnType<typeof convexTest>,
  subjectId: string,
  requestIdentity: string,
  units: number,
  override: {
    subjectKind?: "account" | "authorization";
    serviceClass?: "hosted_read" | "hosted_write" | "provider_backed_effect";
    windowId?: string;
  } = {},
): Promise<void> {
  await t.mutation(reserveRef, {
    serviceSecret,
    workspace: "default",
    subjectKind: override.subjectKind ?? "account",
    subjectId,
    serviceClass: override.serviceClass ?? "hosted_read",
    windowId: override.windowId ?? "window_2026_08",
    requestIdentity,
    units,
    admissionDecisionFingerprint: decisionFingerprint,
    currentTime: "2026-08-26T12:00:00.000Z",
  });
}

async function settle(
  t: ReturnType<typeof convexTest>,
  subjectId: string,
  requestIdentity: string,
  outcome: "consumed" | "released" | "ambiguous",
  settlementReference: string,
  currentTime = "2026-08-26T12:00:01.000Z",
): Promise<void> {
  await t.mutation(settleRef, {
    serviceSecret,
    workspace: "default",
    subjectKind: "account",
    subjectId,
    requestIdentity,
    outcome,
    settlementReference,
    currentTime,
  });
}

async function readWindow(
  t: ReturnType<typeof convexTest>,
  subjectId: string,
  override: {
    subjectKind?: "account" | "authorization";
    serviceClass?: "hosted_read" | "hosted_write" | "provider_backed_effect";
    windowId?: string;
  } = {},
): Promise<any> {
  const json = await t.query(readWindowRef, {
    serviceSecret,
    workspace: "default",
    subjectKind: override.subjectKind ?? "account",
    subjectId,
    serviceClass: override.serviceClass ?? "hosted_read",
    windowId: override.windowId ?? "window_2026_08",
    observedAt,
  });
  return JSON.parse(json);
}

async function seedWorkspace(
  t: ReturnType<typeof convexTest>,
  slug: string,
): Promise<void> {
  await t.run(async (ctx: any) => {
    await ctx.db.insert("workspaces", {
      externalId: `ws_${slug}`,
      slug,
      name: slug,
      createdAt: 1,
      updatedAt: 1,
    });
  });
}
