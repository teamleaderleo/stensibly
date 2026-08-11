import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildWorkerEnrolmentRequest } from "../src/worker-enrolment";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const actorId = "api-token:oauth_grant_test_client";
const clientId = "mcp:api-token:oauth_grant_test_client";
const owner = { actorId, clientId, oauthAccountId: "acct_test" };

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret));

describe("durable worker enrolments", () => {
  test("accepts one canonical enrolment, mints an opaque workerRef, and replays exactly", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspaceAndProjects(t, ["stensibly"]);
    const request = enrolmentRequest({ workerSessionId: "chatgpt.kite.1" });
    const input = enrolInput(request, "worker:enrol:kite:1");

    const accepted = await t.mutation(convexApi.workerEnrolments.enrol, input) as any;
    expect(accepted).toMatchObject({
      version: 1,
      operation: "enrol",
      outcome: "accepted",
      reason: null,
      grantsAuthority: false,
      worker: {
        workerRef: expect.stringMatching(/^wrk_/),
        adapter: "chatgpt",
        profile: "generalist",
        workerSessionId: "chatgpt.kite.1",
        capabilities: ["github", "review"],
        toolAllowlist: ["github"],
        projectScope: ["stensibly"],
        preferredStances: ["review"],
        requestFingerprint: request.fingerprint,
        status: "active",
        callsign: null,
        callsignLeaseId: null,
        callsignLeaseGeneration: null,
        grantsAuthority: false,
      },
    });
    expect(await t.mutation(convexApi.workerEnrolments.enrol, input)).toEqual(accepted);

    const state = await rawState(t);
    expect(state.enrolments).toHaveLength(1);
    expect(state.commands).toHaveLength(1);
    expect(state.enrolments[0].externalId).toBe(accepted.worker.workerRef);
    expect(state.enrolments[0]).toMatchObject({ actorId, clientId, oauthAccountId: "acct_test" });
  });

  test("conflicts altered idempotent enrolment reuse", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspaceAndProjects(t, ["stensibly"]);
    const first = enrolmentRequest({ workerSessionId: "chatgpt.kite.replay" });
    const input = enrolInput(first, "worker:enrol:replay");
    await t.mutation(convexApi.workerEnrolments.enrol, input);

    const altered = enrolmentRequest({
      workerSessionId: "chatgpt.kite.replay",
      profile: "reviewer",
    });
    await expect(t.mutation(convexApi.workerEnrolments.enrol, {
      ...input,
      request: altered,
    })).rejects.toThrow("different worker enrolment command");
    expect((await rawState(t)).enrolments).toHaveLength(1);
  });

  test("keeps workerRef bound to the stable owner and hides it from another client", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspaceAndProjects(t, ["stensibly"]);
    const accepted = await t.mutation(
      convexApi.workerEnrolments.enrol,
      enrolInput(enrolmentRequest({ workerSessionId: "chatgpt.kite.owner" }), "worker:owner:enrol"),
    ) as any;

    const current = await t.mutation(convexApi.workerEnrolments.resolveCurrent, {
      serviceSecret: secret,
      workspace,
      actorId,
      clientId,
      workerRef: accepted.worker.workerRef,
    }) as any;
    expect(current.workerRef).toBe(accepted.worker.workerRef);

    expect(await t.mutation(convexApi.workerEnrolments.resolveCurrent, {
      serviceSecret: secret,
      workspace,
      actorId,
      clientId,
      workerRef: accepted.worker.workerRef,
      project: "outside-scope",
    })).toBeNull();
    expect(await t.mutation(convexApi.workerEnrolments.resolveCurrent, {
      serviceSecret: secret,
      workspace,
      actorId,
      clientId,
      workerRef: accepted.worker.workerRef,
      project: "stensibly",
    })).toMatchObject({ workerRef: accepted.worker.workerRef, status: "active" });

    expect(await t.mutation(convexApi.workerEnrolments.resolveCurrent, {
      serviceSecret: secret,
      workspace,
      actorId: "api-token:oauth_grant_other_client",
      clientId: "mcp:api-token:oauth_grant_other_client",
      workerRef: accepted.worker.workerRef,
    })).toBeNull();

    const foreignHeartbeat = await t.mutation(convexApi.workerEnrolments.heartbeat, {
      serviceSecret: secret,
      workspace,
      actorId: "api-token:oauth_grant_other_client",
      clientId: "mcp:api-token:oauth_grant_other_client",
      workerRef: accepted.worker.workerRef,
      idempotencyKey: "worker:foreign:heartbeat",
    }) as any;
    expect(foreignHeartbeat).toMatchObject({
      outcome: "rejected",
      reason: "worker_not_found",
      worker: null,
      grantsAuthority: false,
    });
  });

  test("requires every project in the requested workspace scope", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspaceAndProjects(t, ["stensibly"]);
    const request = enrolmentRequest({
      workerSessionId: "chatgpt.kite.projects",
      projectScope: ["missing", "stensibly"],
    });
    const rejected = await t.mutation(
      convexApi.workerEnrolments.enrol,
      enrolInput(request, "worker:project:missing"),
    ) as any;
    expect(rejected).toMatchObject({
      outcome: "rejected",
      reason: "project_not_found",
      missingProject: "missing",
      worker: null,
    });
    expect((await rawState(t)).enrolments).toHaveLength(0);
  });

  test("rejects a second active enrolment for the same owner session without duplicating state", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspaceAndProjects(t, ["stensibly"]);
    const request = enrolmentRequest({ workerSessionId: "chatgpt.kite.duplicate" });
    const first = await t.mutation(
      convexApi.workerEnrolments.enrol,
      enrolInput(request, "worker:duplicate:first"),
    ) as any;
    const duplicate = await t.mutation(
      convexApi.workerEnrolments.enrol,
      enrolInput(request, "worker:duplicate:second"),
    ) as any;
    expect(duplicate).toMatchObject({
      outcome: "rejected",
      reason: "active_session_exists",
      worker: { workerRef: first.worker.workerRef, status: "active" },
    });
    expect((await rawState(t)).enrolments).toHaveLength(1);
  });

  test("heartbeats and releases only the current owned enrolment and its callsign", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspaceAndProjects(t, ["stensibly"]);
    const accepted = await t.mutation(
      convexApi.workerEnrolments.enrol,
      enrolInput(
        enrolmentRequest({ workerSessionId: "chatgpt.kite.lifecycle", callsign: "Kite" }),
        "worker:lifecycle:enrol",
      ),
    ) as any;
    const heartbeatInput = {
      serviceSecret: secret,
      workspace,
      actorId,
      clientId,
      workerRef: accepted.worker.workerRef,
      idempotencyKey: "worker:lifecycle:heartbeat",
    };
    const heartbeat = await t.mutation(convexApi.workerEnrolments.heartbeat, heartbeatInput) as any;
    expect(heartbeat).toMatchObject({ outcome: "accepted", worker: { status: "active" } });
    expect(await t.mutation(convexApi.workerEnrolments.heartbeat, heartbeatInput)).toEqual(heartbeat);

    const released = await t.mutation(convexApi.workerEnrolments.release, {
      serviceSecret: secret,
      workspace,
      actorId,
      clientId,
      workerRef: accepted.worker.workerRef,
      idempotencyKey: "worker:lifecycle:release",
    }) as any;
    expect(released).toMatchObject({
      outcome: "accepted",
      worker: { status: "released", releasedAt: expect.any(String) },
    });
    expect(await t.mutation(convexApi.workerEnrolments.resolveCurrent, {
      serviceSecret: secret,
      workspace,
      actorId,
      clientId,
      workerRef: accepted.worker.workerRef,
    })).toBeNull();
    expect(await t.mutation(convexApi.workerEnrolments.get, {
      serviceSecret: secret,
      workspace,
      actorId,
      clientId,
      workerRef: accepted.worker.workerRef,
    })).toMatchObject({ status: "released" });
    expect(await t.mutation(convexApi.workerEnrolments.heartbeat, {
      ...heartbeatInput,
      idempotencyKey: "worker:lifecycle:heartbeat:after-release",
    })).toMatchObject({ outcome: "rejected", reason: "worker_not_active" });
    expect((await rawState(t)).leases).toEqual([
      expect.objectContaining({
        callsign: "Kite",
        workerEnrolmentId: expect.any(String),
        status: "released",
        releasedAt: expect.any(Number),
      }),
    ]);
  });

  test("reconciles expiry out of current resolution while preserving history", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspaceAndProjects(t, ["stensibly"]);
    const accepted = await t.mutation(
      convexApi.workerEnrolments.enrol,
      enrolInput(
        enrolmentRequest({ workerSessionId: "chatgpt.kite.expiry", callsign: "Kite" }),
        "worker:expiry:enrol",
      ),
    ) as any;
    const expiredAt = Date.now() - 1_000;
    await t.run(async (ctx) => {
      const enrolment = (await ctx.db.query("workerEnrolments").collect())
        .find((entry) => entry.externalId === accepted.worker.workerRef);
      if (!enrolment) throw new Error("Worker enrolment fixture disappeared");
      await ctx.db.patch(enrolment._id, { expiresAt: expiredAt });
      if (!enrolment.callsignLeaseId) throw new Error("Worker callsign fixture disappeared");
      await ctx.db.patch(enrolment.callsignLeaseId, { expiresAt: expiredAt });
    });

    expect(await t.mutation(convexApi.workerEnrolments.resolveCurrent, {
      serviceSecret: secret,
      workspace,
      actorId,
      clientId,
      workerRef: accepted.worker.workerRef,
    })).toBeNull();
    expect(await t.mutation(convexApi.workerEnrolments.get, {
      serviceSecret: secret,
      workspace,
      actorId,
      clientId,
      workerRef: accepted.worker.workerRef,
    })).toMatchObject({
      status: "expired",
      expiredAt: new Date(expiredAt).toISOString(),
    });
    expect(await t.mutation(convexApi.workerEnrolments.heartbeat, {
      serviceSecret: secret,
      workspace,
      actorId,
      clientId,
      workerRef: accepted.worker.workerRef,
      idempotencyKey: "worker:expiry:heartbeat",
    })).toMatchObject({ outcome: "rejected", reason: "worker_not_active" });
    expect((await rawState(t)).leases).toEqual([
      expect.objectContaining({
        callsign: "Kite",
        status: "expired",
        expiredAt,
      }),
    ]);
  });

  test("atomically joins a canonical callsign lease and replays the same worker", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspaceAndProjects(t, ["stensibly"]);
    const request = enrolmentRequest({
      workerSessionId: "chatgpt.kite.callsign",
      callsign: "Kite",
    });
    const input = enrolInput(request, "worker:callsign:joined");
    const accepted = await t.mutation(convexApi.workerEnrolments.enrol, input) as any;
    expect(accepted).toMatchObject({
      operation: "enrol",
      outcome: "accepted",
      reason: null,
      worker: {
        workerRef: expect.stringMatching(/^wrk_/),
        callsign: "Kite",
        callsignLeaseId: expect.stringMatching(/^csl_/),
        callsignLeaseGeneration: 1,
      },
      grantsAuthority: false,
    });
    expect(await t.mutation(convexApi.workerEnrolments.enrol, input)).toEqual(accepted);
    const state = await rawState(t);
    expect(state.enrolments).toEqual([
      expect.objectContaining({
        externalId: accepted.worker.workerRef,
        callsign: "Kite",
        callsignLeaseGeneration: 1,
      }),
    ]);
    expect(state.leases).toEqual([
      expect.objectContaining({
        externalId: accepted.worker.callsignLeaseId,
        callsign: "Kite",
        collisionKey: "kite",
        workerSessionId: "chatgpt.kite.callsign",
        workerEnrolmentId: state.enrolments[0]._id,
        generation: 1,
        status: "active",
        reservationRequestId: "worker:callsign:joined",
        reservationFingerprint: request.fingerprint,
      }),
    ]);
    expect(state.commands).toHaveLength(1);
  });

  test("rejects a colliding callsign without leaving an orphan worker or lease", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspaceAndProjects(t, ["stensibly"]);
    await t.mutation(
      convexApi.workerEnrolments.enrol,
      enrolInput(
        enrolmentRequest({ workerSessionId: "chatgpt.kite.first", callsign: "Kite" }),
        "worker:callsign:first",
      ),
    );

    const rejected = await t.mutation(
      convexApi.workerEnrolments.enrol,
      enrolInput(
        enrolmentRequest({ workerSessionId: "chatgpt.kite.second", callsign: "kite" }),
        "worker:callsign:collision",
      ),
    ) as any;
    expect(rejected).toMatchObject({
      operation: "enrol",
      outcome: "rejected",
      reason: "callsign_active_collision",
      worker: null,
      grantsAuthority: false,
    });
    const state = await rawState(t);
    expect(state.enrolments).toHaveLength(1);
    expect(state.leases).toHaveLength(1);
  });

  test("rejects invalid or overlong callsign joins without durable partial state", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspaceAndProjects(t, ["stensibly"]);

    const invalid = await t.mutation(
      convexApi.workerEnrolments.enrol,
      enrolInput(
        enrolmentRequest({ workerSessionId: "chatgpt.kite.invalid", callsign: "Kite!" }),
        "worker:callsign:invalid",
      ),
    ) as any;
    expect(invalid).toMatchObject({ outcome: "rejected", reason: "callsign_invalid", worker: null });

    const tooLong = await t.mutation(
      convexApi.workerEnrolments.enrol,
      enrolInput(
        enrolmentRequest({
          workerSessionId: "chatgpt.kite.too-long",
          callsign: "Kite",
          lifetimeMs: 8 * 24 * 60 * 60 * 1_000,
        }),
        "worker:callsign:too-long",
      ),
    ) as any;
    expect(tooLong).toMatchObject({
      outcome: "rejected",
      reason: "callsign_lifetime_too_long",
      worker: null,
    });

    const state = await rawState(t);
    expect(state.enrolments).toHaveLength(0);
    expect(state.leases).toHaveLength(0);
    expect(state.commands).toHaveLength(2);
  });
});

function enrolmentRequest(options: {
  workerSessionId: string;
  profile?: string;
  projectScope?: string[];
  callsign?: string;
  lifetimeMs?: number;
}) {
  const now = Date.now();
  return buildWorkerEnrolmentRequest({
    adapter: "chatgpt",
    profile: options.profile ?? "generalist",
    workerSessionId: options.workerSessionId,
    ...(options.callsign === undefined ? {} : { callsign: options.callsign }),
    capabilities: ["review", "github"],
    toolAllowlist: ["github"],
    projectScope: options.projectScope ?? ["stensibly"],
    preferredStances: ["review"],
    startedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (options.lifetimeMs ?? 2 * 60 * 60 * 1_000)).toISOString(),
    heartbeatSeconds: 300,
    correlationId: "corr_worker_test",
    causationId: "cause_worker_test",
  });
}

function enrolInput(request: ReturnType<typeof buildWorkerEnrolmentRequest>, idempotencyKey: string) {
  return {
    serviceSecret: secret,
    workspace,
    ...owner,
    request,
    idempotencyKey,
  };
}

async function seedWorkspaceAndProjects(t: ReturnType<typeof convexTest>, projects: string[]) {
  await t.run(async (ctx) => {
    const now = Date.now();
    const workspaceId = await ctx.db.insert("workspaces", {
      externalId: "ws_test",
      slug: workspace,
      name: "Test",
      createdAt: now,
      updatedAt: now,
    });
    for (const project of projects) {
      await ctx.db.insert("projects", {
        workspaceId,
        externalId: `project_test_${project}`,
        slug: project,
        name: project,
        createdAt: now,
        updatedAt: now,
      });
    }
  });
}

async function rawState(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ({
    enrolments: await ctx.db.query("workerEnrolments").collect(),
    leases: await ctx.db.query("callsignLeases").collect(),
    commands: await ctx.db.query("workerEnrolmentCommands").collect(),
  }));
}
