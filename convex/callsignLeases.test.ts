import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildCallsignReservationRequest } from "../src/callsign-catalog";
import { callsignCollisionKey } from "../src/callsign-suggestions";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const baseArgs = { serviceSecret: secret, workspace };
const fingerprintPattern = /^sha256:[a-f0-9]{64}$/;

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret));

describe("hosted callsign leases", () => {
  test("accepts one canonical reservation and replays it exactly", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, workspace);
    const input = reserveInput({ requestedCallsign: " Kite ", requestId: "callsign:reserve:kite:1" });

    const accepted = await t.mutation(convexApi.callsignLeases.reserve, input) as any;
    expect(accepted).toMatchObject({
      version: 1,
      operation: "reserve",
      outcome: "accepted",
      reason: null,
      currentGeneration: 1,
      grantsIdentityContinuity: false,
      grantsAuthority: false,
      lease: {
        callsign: "Kite",
        collisionKey: callsignCollisionKey("Kite"),
        workerSessionId: "chatgpt.kite.1",
        runId: "run_kite_1",
        generation: 1,
        status: "active",
        reservationRequestId: input.requestId,
        reservationFingerprint: expect.stringMatching(fingerprintPattern),
        grantsIdentityContinuity: false,
        grantsAuthority: false,
      },
    });
    expect(await t.mutation(convexApi.callsignLeases.reserve, input)).toEqual(accepted);

    await expect(t.mutation(convexApi.callsignLeases.reserve, {
      ...input,
      requestedCallsign: "Rook",
    })).rejects.toThrow("different callsign lease command");

    const state = await rawState(t);
    expect(state.leases).toHaveLength(1);
    expect(state.commands).toHaveLength(1);
  });

  test("normalizes collisions and keeps one live holder", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, workspace);
    const first = await t.mutation(
      convexApi.callsignLeases.reserve,
      reserveInput({ requestedCallsign: "Kite", requestId: "callsign:collision:1" }),
    ) as any;
    const second = await t.mutation(
      convexApi.callsignLeases.reserve,
      reserveInput({
        requestedCallsign: "K_i-te",
        workerSessionId: "chatgpt.other.1",
        runId: "run_other_1",
        requestId: "callsign:collision:2",
      }),
    ) as any;

    expect(first.outcome).toBe("accepted");
    expect(second).toMatchObject({
      operation: "reserve",
      outcome: "rejected",
      reason: "active_collision",
      currentGeneration: 1,
      lease: {
        id: first.lease.id,
        workerSessionId: "chatgpt.kite.1",
        runId: "run_kite_1",
      },
    });
    const state = await rawState(t);
    expect(state.leases.filter((lease: any) => lease.status === "active")).toHaveLength(1);
    expect(state.leases).toHaveLength(1);
    expect(state.commands).toHaveLength(2);
  });

  test("renews only the exact live holder and generation", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, workspace);
    const accepted = await t.mutation(
      convexApi.callsignLeases.reserve,
      reserveInput({ requestId: "callsign:renew:reserve" }),
    ) as any;
    const renewedExpiry = new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString();
    const renewInput = {
      ...baseArgs,
      leaseId: accepted.lease.id,
      workerSessionId: accepted.lease.workerSessionId,
      runId: accepted.lease.runId,
      expectedGeneration: accepted.lease.generation,
      expiresAt: renewedExpiry,
      idempotencyKey: "callsign:renew:1",
    };

    const renewed = await t.mutation(convexApi.callsignLeases.renew, renewInput) as any;
    expect(renewed).toMatchObject({
      operation: "renew",
      outcome: "accepted",
      currentGeneration: 1,
      lease: {
        id: accepted.lease.id,
        generation: 1,
        status: "active",
        expiresAt: renewedExpiry,
      },
    });
    expect(await t.mutation(convexApi.callsignLeases.renew, renewInput)).toEqual(renewed);

    expect(await t.mutation(convexApi.callsignLeases.renew, {
      ...renewInput,
      expectedGeneration: 2,
      idempotencyKey: "callsign:renew:stale",
    })).toMatchObject({ outcome: "rejected", reason: "stale_generation" });
    expect(await t.mutation(convexApi.callsignLeases.renew, {
      ...renewInput,
      workerSessionId: "chatgpt.foreign.1",
      idempotencyKey: "callsign:renew:foreign",
    })).toMatchObject({ outcome: "rejected", reason: "holder_mismatch" });
  });

  test("release preserves history and ordinary reuse advances generation", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, workspace);
    const accepted = await t.mutation(
      convexApi.callsignLeases.reserve,
      reserveInput({ requestId: "callsign:reuse:first" }),
    ) as any;

    const released = await t.mutation(convexApi.callsignLeases.release, {
      ...baseArgs,
      leaseId: accepted.lease.id,
      workerSessionId: accepted.lease.workerSessionId,
      runId: accepted.lease.runId,
      expectedGeneration: 1,
      idempotencyKey: "callsign:release:first",
    }) as any;
    expect(released).toMatchObject({
      operation: "release",
      outcome: "accepted",
      currentGeneration: 1,
      lease: { status: "released", generation: 1, releasedAt: expect.any(String) },
    });

    const reused = await t.mutation(
      convexApi.callsignLeases.reserve,
      reserveInput({
        requestedCallsign: "K_i-te",
        workerSessionId: "chatgpt.kite.2",
        runId: "run_kite_2",
        requestId: "callsign:reuse:second",
        expectedGeneration: 1,
      }),
    ) as any;
    expect(reused).toMatchObject({
      operation: "reserve",
      outcome: "accepted",
      currentGeneration: 2,
      lease: {
        callsign: "K_i-te",
        collisionKey: callsignCollisionKey("Kite"),
        workerSessionId: "chatgpt.kite.2",
        runId: "run_kite_2",
        generation: 2,
        status: "active",
      },
    });

    const state = await rawState(t);
    expect(state.leases).toHaveLength(2);
    expect(state.leases.map((lease: any) => lease.generation).sort()).toEqual([1, 2]);
  });

  test("reconciles expiry and rejects renewal of an expired lease", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, workspace);
    const accepted = await t.mutation(
      convexApi.callsignLeases.reserve,
      reserveInput({ requestId: "callsign:expiry:reserve" }),
    ) as any;
    const expiredDeadline = Date.now() - 1_000;
    await t.run(async (ctx) => {
      const lease = (await ctx.db.query("callsignLeases").collect())
        .find((entry) => entry.externalId === accepted.lease.id);
      if (!lease) throw new Error("Lease fixture disappeared");
      await ctx.db.patch(lease._id, { expiresAt: expiredDeadline });
    });

    expect(await t.mutation(convexApi.callsignLeases.getCurrent, {
      ...baseArgs,
      callsign: "Kite",
    })).toBeNull();
    const expired = await t.mutation(convexApi.callsignLeases.get, {
      ...baseArgs,
      id: accepted.lease.id,
    }) as any;
    expect(expired).toMatchObject({
      status: "expired",
      generation: 1,
      expiredAt: new Date(expiredDeadline).toISOString(),
    });

    expect(await t.mutation(convexApi.callsignLeases.renew, {
      ...baseArgs,
      leaseId: accepted.lease.id,
      workerSessionId: accepted.lease.workerSessionId,
      runId: accepted.lease.runId,
      expectedGeneration: 1,
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      idempotencyKey: "callsign:expiry:renew",
    })).toMatchObject({ outcome: "rejected", reason: "lease_not_active" });
  });

  test("scopes leases to a workspace and permits the same callsign elsewhere", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, workspace);
    await seedWorkspace(t, "other");
    const accepted = await t.mutation(
      convexApi.callsignLeases.reserve,
      reserveInput({ requestId: "callsign:workspace:test" }),
    ) as any;

    expect(await t.mutation(convexApi.callsignLeases.get, {
      serviceSecret: secret,
      workspace: "other",
      id: accepted.lease.id,
    })).toBeNull();

    const other = await t.mutation(
      convexApi.callsignLeases.reserve,
      reserveInput({
        workspace: "other",
        workerSessionId: "chatgpt.other.1",
        runId: "run_other_1",
        requestId: "callsign:workspace:other",
      }),
    ) as any;
    expect(other).toMatchObject({ outcome: "accepted", currentGeneration: 1 });
    expect((await rawState(t)).leases).toHaveLength(2);
  });

  test("keeps inheritance fenced until hosted lineage policy is implemented", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t, workspace);
    const result = await t.mutation(
      convexApi.callsignLeases.reserve,
      reserveInput({
        requestId: "callsign:inheritance:fenced",
        runId: "run_kite_2",
        inheritance: {
          fromRunId: "run_kite_1",
          transferReference: "handoff:kite:1",
        },
      }),
    ) as any;
    expect(result).toMatchObject({
      operation: "reserve",
      outcome: "rejected",
      reason: "inheritance_not_supported",
      lease: null,
      grantsAuthority: false,
    });
    expect((await rawState(t)).leases).toHaveLength(0);
  });
});

function reserveInput(options: {
  workspace?: string;
  requestedCallsign?: string;
  workerSessionId?: string;
  runId?: string;
  requestId: string;
  expectedGeneration?: number;
  inheritance?: { fromRunId: string; transferReference: string };
}) {
  const requestedAt = new Date(Date.now()).toISOString();
  const request = buildCallsignReservationRequest({
    workspace: options.workspace ?? workspace,
    requestedCallsign: options.requestedCallsign ?? "Kite",
    workerSessionId: options.workerSessionId ?? "chatgpt.kite.1",
    runId: options.runId ?? "run_kite_1",
    requestId: options.requestId,
    requestedAt,
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    ...(options.expectedGeneration === undefined
      ? {}
      : { expectedGeneration: options.expectedGeneration }),
    ...(options.inheritance === undefined ? {} : { inheritance: options.inheritance }),
  });
  return {
    serviceSecret: secret,
    workspace: request.workspace,
    requestedCallsign: request.requestedCallsign,
    workerSessionId: request.workerSessionId,
    runId: request.runId,
    requestId: request.requestId,
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt,
    ...(request.expectedGeneration === null
      ? {}
      : { expectedGeneration: request.expectedGeneration }),
    ...(request.inheritance === null ? {} : { inheritance: request.inheritance }),
    fingerprint: request.fingerprint,
    idempotencyKey: request.requestId,
  };
}

async function seedWorkspace(t: ReturnType<typeof convexTest>, slug: string) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("workspaces", {
      externalId: `ws_${slug}`,
      slug,
      name: slug,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function rawState(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ({
    leases: await ctx.db.query("callsignLeases").collect(),
    commands: await ctx.db.query("callsignLeaseCommands").collect(),
  }));
}
