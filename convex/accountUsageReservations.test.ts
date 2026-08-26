import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ConvexCaller } from "../src/convex-ledger";
import {
  ConvexAccountUsageReservationStore,
} from "../src/account-usage-reservation-convex-store";
import type {
  AccountUsageSubject,
  ReserveAccountUsageInput,
} from "../src/account-usage-reservation";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "account-usage-reservation-service-secret";
const reserveRef = makeFunctionReference<"mutation">(
  "accountUsageReservations:reserve",
);

const accountSubject: AccountUsageSubject = {
  kind: "account",
  id: "acct_public_beta_1",
  workspace: "default",
};
const authorizationSubject: AccountUsageSubject = {
  kind: "authorization",
  id: "service_principal_ci",
  workspace: "default",
};
const admissionDecisionFingerprint = `sha256:${"a".repeat(64)}`;

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("hosted account usage reservation persistence", () => {
  test("reserves once, replays the durable receipt, and conflicts changed intent", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, "default");
    const store = accountUsageStore(t);
    const request = reserveInput(accountSubject, "request_replay_1", 2);

    const first = await store.reserve(request);
    expect(first.outcome).toBe("reserved");
    expect(first.receipt).toMatchObject({
      state: "reserved",
      units: 2,
      reservedAt: request.currentTime,
      usage: { consumed: 0, reserved: 2 },
      grantsAuthority: false,
      grantsProviderBudget: false,
    });

    const replay = await store.reserve({
      ...request,
      currentTime: "2026-08-26T12:00:30.000Z",
    });
    expect(replay.outcome).toBe("replay");
    expect(replay.receipt).toEqual(first.receipt);

    const conflict = await store.reserve({
      ...request,
      units: 3,
      currentTime: "2026-08-26T12:00:31.000Z",
    });
    expect(conflict.outcome).toBe("conflict");
    expect(conflict.receipt).toEqual(first.receipt);
  });

  test("serializes concurrent reserve attempts to one row", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, "default");
    const store = accountUsageStore(t);
    const request = reserveInput(accountSubject, "request_concurrent_1", 1);

    const results = await Promise.all([
      store.reserve(request),
      store.reserve(request),
    ]);
    expect(results.map((entry) => entry.outcome).sort()).toEqual([
      "replay",
      "reserved",
    ]);
    expect(results[0]!.receipt).toEqual(results[1]!.receipt);

    const rows = await t.run(async (ctx: any) =>
      await ctx.db.query("accountUsageReservations").collect()
    );
    expect(rows).toHaveLength(1);
  });

  test("persists settlement and enforces exact terminal replay", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, "default");
    const store = accountUsageStore(t);
    await store.reserve(reserveInput(accountSubject, "request_settle_1", 4));

    const consumed = await store.settle(accountSubject, "request_settle_1", {
      outcome: "consumed",
      settlementReference: "dispatch_receipt_1",
      currentTime: "2026-08-26T12:00:01.000Z",
    });
    expect(consumed).toMatchObject({
      state: "consumed",
      usage: { consumed: 4, reserved: 0 },
      settlementReference: "dispatch_receipt_1",
    });

    const replay = await store.settle(accountSubject, "request_settle_1", {
      outcome: "consumed",
      settlementReference: "dispatch_receipt_1",
      currentTime: "2026-08-26T12:00:02.000Z",
    });
    expect(replay).toEqual(consumed);

    await expect(store.settle(accountSubject, "request_settle_1", {
      outcome: "released",
      settlementReference: "dispatch_receipt_2",
      currentTime: "2026-08-26T12:00:03.000Z",
    })).rejects.toThrow("settlement conflicts");
  });

  test("keeps ambiguous usage reserved across reconnect until explicit reconciliation", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, "default");
    const first = accountUsageStore(t);
    await first.reserve(reserveInput(accountSubject, "request_ambiguous_1", 5));
    const ambiguous = await first.settle(accountSubject, "request_ambiguous_1", {
      outcome: "ambiguous",
      settlementReference: "dispatch_outcome_unknown",
      currentTime: "2026-08-26T12:00:01.000Z",
    });
    expect(ambiguous).toMatchObject({
      state: "ambiguous",
      usage: { consumed: 0, reserved: 5 },
    });

    const reconnect = accountUsageStore(t);
    expect(await reconnect.get(accountSubject, "request_ambiguous_1"))
      .toEqual(ambiguous);
    await expect(reconnect.settle(accountSubject, "request_ambiguous_1", {
      outcome: "consumed",
      settlementReference: "retry_without_reconciliation",
      currentTime: "2026-08-26T12:00:02.000Z",
    })).rejects.toThrow("requires explicit reconciliation");

    const reconciled = await reconnect.reconcile(
      accountSubject,
      "request_ambiguous_1",
      {
        outcome: "consumed",
        reconciliationReference: "readback_proved_consumed",
        currentTime: "2026-08-26T12:00:03.000Z",
      },
    );
    expect(reconciled).toMatchObject({
      state: "consumed",
      usage: { consumed: 5, reserved: 0 },
      settlementReference: "dispatch_outcome_unknown",
      reconciliationReference: "readback_proved_consumed",
    });

    const fresh = accountUsageStore(t);
    expect(await fresh.get(accountSubject, "request_ambiguous_1"))
      .toEqual(reconciled);
  });

  test("isolates account and authorization owners sharing one request identity", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, "default");
    const store = accountUsageStore(t);
    const requestIdentity = "request_shared_name";

    const account = await store.reserve(
      reserveInput(accountSubject, requestIdentity, 1),
    );
    const authorization = await store.reserve(
      reserveInput(authorizationSubject, requestIdentity, 2),
    );

    expect(account.outcome).toBe("reserved");
    expect(authorization.outcome).toBe("reserved");
    expect(account.receipt.subject).toEqual(accountSubject);
    expect(authorization.receipt.subject).toEqual(authorizationSubject);
    expect(await store.get(accountSubject, requestIdentity)).toEqual(account.receipt);
    expect(await store.get(authorizationSubject, requestIdentity))
      .toEqual(authorization.receipt);
  });

  test("isolates workspaces and refuses cross-workspace adapter subjects", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, "default");
    await seedWorkspace(t, "other");
    const defaultStore = accountUsageStore(t);
    const otherStore = accountUsageStore(t, "other");
    const otherSubject: AccountUsageSubject = {
      ...accountSubject,
      workspace: "other",
    };

    await defaultStore.reserve(
      reserveInput(accountSubject, "request_workspace_1", 1),
    );
    expect(await otherStore.get(otherSubject, "request_workspace_1"))
      .toBeNull();
    await expect(otherStore.get(accountSubject, "request_workspace_1"))
      .rejects.toThrow("storage failed");
  });

  test("fails closed when durable route or receipt evidence is corrupted", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, "default");
    const store = accountUsageStore(t);
    await store.reserve(reserveInput(accountSubject, "request_corrupt_1", 2));

    await t.run(async (ctx: any) => {
      const row = await ctx.db.query("accountUsageReservations").unique();
      await ctx.db.patch(row._id, {
        receiptFingerprint: `sha256:${"f".repeat(64)}`,
      });
    });
    await expect(store.get(accountSubject, "request_corrupt_1"))
      .rejects.toThrow("ACCOUNT_USAGE_RESERVATION_STORED_ROW_INVALID");
  });

  test("requires the service secret and an existing workspace", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, "default");
    const request = reserveInput(accountSubject, "request_secret_1", 1);

    await expect(t.mutation(reserveRef, {
      serviceSecret: "wrong-secret",
      workspace: "default",
      subjectKind: request.subject.kind,
      subjectId: request.subject.id,
      serviceClass: request.serviceClass,
      windowId: request.windowId,
      requestIdentity: request.requestIdentity,
      units: request.units,
      admissionDecisionFingerprint: request.admissionDecisionFingerprint,
      currentTime: request.currentTime,
    })).rejects.toThrow("Unauthorized");

    const missingStore = accountUsageStore(t, "missing");
    await expect(missingStore.reserve({
      ...request,
      subject: { ...request.subject, workspace: "missing" },
    })).rejects.toThrow("ACCOUNT_USAGE_RESERVATION_WORKSPACE_NOT_FOUND");
  });
});

function reserveInput(
  subject: AccountUsageSubject,
  requestIdentity: string,
  units: number,
): ReserveAccountUsageInput {
  return {
    subject,
    serviceClass: "hosted_read",
    windowId: "window_2026_08",
    requestIdentity,
    units,
    admissionDecisionFingerprint,
    currentTime: "2026-08-26T12:00:00.000Z",
  };
}

function accountUsageStore(
  t: ReturnType<typeof convexTest>,
  workspace = "default",
): ConvexAccountUsageReservationStore {
  return new ConvexAccountUsageReservationStore({
    client: convexCaller(t),
    serviceSecret,
    workspace,
  });
}

function convexCaller(t: ReturnType<typeof convexTest>): ConvexCaller {
  return {
    query: async (reference, args) => await t.query(reference, args),
    mutation: async (reference, args) => await t.mutation(reference, args),
  };
}

async function seedWorkspace(
  t: ReturnType<typeof convexTest>,
  slug: string,
): Promise<void> {
  await t.run(async (ctx: any) => {
    const existing = await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q: any) => q.eq("slug", slug))
      .unique();
    if (!existing) {
      await ctx.db.insert("workspaces", {
        externalId: `ws_${slug}`,
        slug,
        name: slug,
        createdAt: 1,
        updatedAt: 1,
      });
    }
  });
}
