import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildCallsignReservationRequest } from "../src/callsign-catalog";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const dayMs = 24 * 60 * 60 * 1_000;

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret));

describe("callsign lease server-clock fences", () => {
  test("rejects a caller-valid reservation that exceeds seven days from acceptance", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const now = Date.now();
    const request = buildCallsignReservationRequest({
      workspace,
      requestedCallsign: "Kite",
      workerSessionId: "chatgpt.kite.future",
      runId: "run_kite_future",
      requestId: "callsign:server-clock:reserve",
      requestedAt: new Date(now + 2 * dayMs).toISOString(),
      expiresAt: new Date(now + 8 * dayMs).toISOString(),
    });
    const input = {
      serviceSecret: secret,
      workspace,
      requestedCallsign: request.requestedCallsign,
      workerSessionId: request.workerSessionId,
      runId: request.runId,
      requestId: request.requestId,
      requestedAt: request.requestedAt,
      expiresAt: request.expiresAt,
      fingerprint: request.fingerprint,
      idempotencyKey: request.requestId,
    };

    const rejected = await t.mutation(convexApi.callsignLeases.reserve, input) as any;
    expect(rejected).toMatchObject({
      operation: "reserve",
      outcome: "rejected",
      reason: "expiry_too_far",
      lease: null,
      currentGeneration: 0,
      grantsIdentityContinuity: false,
      grantsAuthority: false,
    });
    expect(await t.mutation(convexApi.callsignLeases.reserve, input)).toEqual(rejected);

    const state = await t.run(async (ctx) => ({
      leases: await ctx.db.query("callsignLeases").collect(),
      commands: await ctx.db.query("callsignLeaseCommands").collect(),
    }));
    expect(state.leases).toHaveLength(0);
    expect(state.commands).toHaveLength(1);
  });

  test("rejects renewal beyond seven days from the renewal transaction clock", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const now = Date.now();
    const request = buildCallsignReservationRequest({
      workspace,
      requestedCallsign: "Kite",
      workerSessionId: "chatgpt.kite.renew",
      runId: "run_kite_renew",
      requestId: "callsign:server-clock:initial",
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60 * 60 * 1_000).toISOString(),
    });
    const accepted = await t.mutation(convexApi.callsignLeases.reserve, {
      serviceSecret: secret,
      workspace,
      requestedCallsign: request.requestedCallsign,
      workerSessionId: request.workerSessionId,
      runId: request.runId,
      requestId: request.requestId,
      requestedAt: request.requestedAt,
      expiresAt: request.expiresAt,
      fingerprint: request.fingerprint,
      idempotencyKey: request.requestId,
    }) as any;
    expect(accepted.outcome).toBe("accepted");

    const renewInput = {
      serviceSecret: secret,
      workspace,
      leaseId: accepted.lease.id,
      workerSessionId: accepted.lease.workerSessionId,
      runId: accepted.lease.runId,
      expectedGeneration: accepted.lease.generation,
      expiresAt: new Date(Date.now() + 8 * dayMs).toISOString(),
      idempotencyKey: "callsign:server-clock:renew",
    };
    const rejected = await t.mutation(convexApi.callsignLeases.renew, renewInput) as any;
    expect(rejected).toMatchObject({
      operation: "renew",
      outcome: "rejected",
      reason: "expiry_too_far",
      currentGeneration: 1,
      lease: {
        id: accepted.lease.id,
        expiresAt: accepted.lease.expiresAt,
        generation: 1,
        status: "active",
      },
    });
    expect(await t.mutation(convexApi.callsignLeases.renew, renewInput)).toEqual(rejected);

    const current = await t.mutation(convexApi.callsignLeases.get, {
      serviceSecret: secret,
      workspace,
      id: accepted.lease.id,
    }) as any;
    expect(current.expiresAt).toBe(accepted.lease.expiresAt);
  });
});

async function seedWorkspace(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("workspaces", {
      externalId: "ws_test",
      slug: workspace,
      name: "Test",
      createdAt: now,
      updatedAt: now,
    });
  });
}
