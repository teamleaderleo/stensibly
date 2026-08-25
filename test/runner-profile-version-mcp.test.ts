import { afterEach, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const supervisor = {
  id: "service:profile-version-mcp-supervisor",
  name: "Profile Version MCP Supervisor",
  kind: "service" as const,
};
const runner = {
  id: "agent:profile-version-mcp-runner",
  name: "Profile Version MCP Runner",
  kind: "agent" as const,
};
const exactVersion = "codex-default/2026-08-25";
const protocolVersion = "2025-06-18";
let store: StensiblyStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

describe("runner MCP exact profile version claims", () => {
  test("does not downgrade an exact-version run to a legacy-unknown claim", async () => {
    store = new StensiblyStore(":memory:");
    const item = store.createItem({
      project: "profile-version-mcp",
      kind: "task",
      title: "Claim through the public runner endpoint",
      summary: "The exact runner profile version must survive MCP admission.",
      nextAction: "Claim with the matching exact version.",
      priority: 80,
      actor: supervisor,
    });
    const queued = dispatchNextWork(store, {
      actor: supervisor,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      runnerProfileVersion: exactVersion,
      itemId: item.id,
      leaseSeconds: 300,
      idempotencyKey: "dispatch-profile-version-mcp",
    }, new Date())!;
    const token = createApiToken(store, {
      name: "Exact profile runner",
      scopes: ["read", "write"],
      projects: ["profile-version-mcp"],
    });
    const app = createServerApp(store);

    const unknown = await readToolJson<unknown>(await runnerRequest(
      app,
      token.token,
      toolCall(1, "claim_runner_work", {
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        runnerProfileVersion: null,
        runId: queued.run.id,
      }),
    ));
    expect(unknown).toBeNull();

    const claimed = await readToolJson<{
      run: {
        id: string;
        runnerProfile: string;
        runnerProfileVersion: string | null;
        status: string;
      };
    }>(await runnerRequest(
      app,
      token.token,
      toolCall(2, "claim_runner_work", {
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        runnerProfileVersion: exactVersion,
        runId: queued.run.id,
      }),
    ));
    expect(claimed.run).toMatchObject({
      id: queued.run.id,
      runnerProfile: "codex-default",
      runnerProfileVersion: exactVersion,
      status: "starting",
    });
  });

  test("remote reservations fence to the durable run version and preserve it through replay", async () => {
    store = new StensiblyStore(":memory:");
    const app = createServerApp(store);
    const token = createApiToken(store, {
      name: "Reservation fence runner",
      scopes: ["read", "write"],
      projects: ["profile-version-mcp"],
    });
    const itemId = store.createItem({
      project: "profile-version-mcp",
      kind: "task",
      title: "Reserve under the exact durable version",
      summary: "Remote reservations must match the durable run provenance.",
      nextAction: "Reserve with the matching exact version.",
      priority: 80,
      actor: supervisor,
    }).id;
    const queued = dispatchNextWork(store, {
      actor: supervisor,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      runnerProfileVersion: exactVersion,
      itemId,
      leaseSeconds: 3_600,
      idempotencyKey: "dispatch-reservation-fence",
    })!;
    const claimed = await readToolJson<{ run: { id: string; generation: number; leaseGeneration: number } }>(
      await runnerRequest(app, token.token, toolCall(1, "claim_runner_work", {
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        runnerProfileVersion: exactVersion,
        runId: queued.run.id,
      })),
    );

    const reservationInput = {
      project: "profile-version-mcp",
      itemId,
      runId: claimed.run.id,
      runGeneration: claimed.run.generation,
      leaseGeneration: claimed.run.leaseGeneration,
      actor: runner,
      adapterId: "generic-mcp",
      profileId: "codex-default",
      requestFingerprint: fingerprint("a1"),
      commandId: "command-reservation-fence",
      commandFingerprint: fingerprint("b2"),
      idempotencyKey: "reserve-profile-version-fence",
    };
    const reserved = await readToolJson<{
      outcome: string;
      command: { profileVersion: string | null };
    }>(await runnerRequest(app, token.token, toolCall(2, "reserve_runner_adapter_command", {
      ...reservationInput,
      profileVersion: exactVersion,
    })));
    expect(reserved).toMatchObject({
      outcome: "reserved",
      command: { profileVersion: exactVersion },
    });

    const readBack = await readToolJson<{
      command: { profileVersion: string | null };
      settlement: unknown;
    }>(await runnerRequest(app, token.token, toolCall(3, "get_runner_adapter_command", {
      project: "profile-version-mcp",
      idempotencyKey: reservationInput.idempotencyKey,
    })));
    expect(readBack.command.profileVersion).toBe(exactVersion);

    const replayed = await readToolJson<{ outcome: string; command: { profileVersion: string | null } }>(
      await runnerRequest(app, token.token, toolCall(4, "reserve_runner_adapter_command", {
        ...reservationInput,
        profileVersion: exactVersion,
        commandId: "command-reservation-replay",
        commandFingerprint: fingerprint("c3"),
      })),
    );
    expect(replayed).toMatchObject({
      outcome: "replayed",
      command: { profileVersion: exactVersion },
    });

    const driftedReplay = await readToolError(await runnerRequest(
      app,
      token.token,
      toolCall(5, "reserve_runner_adapter_command", {
        ...reservationInput,
        profileVersion: "codex-default/2026-08-26",
        commandId: "command-drifted-replay",
        commandFingerprint: fingerprint("d4"),
      }),
    ));
    expect(driftedReplay).toContain("profile version does not match the durable run");

    const admissionDrift = await readToolError(await runnerRequest(
      app,
      token.token,
      toolCall(6, "reserve_runner_adapter_command", {
        ...reservationInput,
        idempotencyKey: "reserve-admission-drift",
        commandId: "command-admission-drift",
        commandFingerprint: fingerprint("e5"),
        profileVersion: "codex-default/2026-08-26",
      }),
    ));
    expect(admissionDrift).toContain("profile version does not match the durable run");
    expect(await store!.db.query(
      "SELECT COUNT(*) AS count FROM runner_adapter_commands WHERE idempotency_key = 'reserve-admission-drift'",
    ).get()).toMatchObject({ count: 0 });
  });

  test("historical unknown versions stay explicitly unknown under remote reservations", async () => {
    store = new StensiblyStore(":memory:");
    const app = createServerApp(store);
    const token = createApiToken(store, {
      name: "Legacy reservation runner",
      scopes: ["read", "write"],
      projects: ["profile-version-mcp"],
    });
    const itemId = store.createItem({
      project: "profile-version-mcp",
      kind: "task",
      title: "Keep historical unknown explicit",
      summary: "Unknown run versions must not be upgraded from reservation metadata.",
      nextAction: "Reserve without inventing a version.",
      priority: 80,
      actor: supervisor,
    }).id;
    const queued = dispatchNextWork(store, {
      actor: supervisor,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      runnerProfileVersion: null,
      itemId,
      leaseSeconds: 3_600,
      idempotencyKey: "dispatch-legacy-reservation",
    })!;
    const claimed = await readToolJson<{ run: { id: string; generation: number; leaseGeneration: number; runnerProfileVersion: string | null } }>(
      await runnerRequest(app, token.token, toolCall(1, "claim_runner_work", {
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        runnerProfileVersion: null,
        runId: queued.run.id,
      })),
    );
    expect(claimed.run.runnerProfileVersion).toBeNull();

    const upgradeAttempt = await readToolError(await runnerRequest(
      app,
      token.token,
      toolCall(2, "reserve_runner_adapter_command", {
        project: "profile-version-mcp",
        itemId,
        runId: claimed.run.id,
        runGeneration: claimed.run.generation,
        leaseGeneration: claimed.run.leaseGeneration,
        actor: runner,
        adapterId: "generic-mcp",
        profileId: "codex-default",
        profileVersion: exactVersion,
        requestFingerprint: fingerprint("f6"),
        commandId: "command-upgrade-attempt",
        commandFingerprint: fingerprint("a7"),
        idempotencyKey: "reserve-upgrade-attempt",
      }),
    ));
    expect(upgradeAttempt).toContain("profile version does not match the durable run");

    const unknownReserved = await readToolJson<{
      outcome: string;
      command: { profileVersion: string | null };
    }>(await runnerRequest(app, token.token, toolCall(3, "reserve_runner_adapter_command", {
      project: "profile-version-mcp",
      itemId,
      runId: claimed.run.id,
      runGeneration: claimed.run.generation,
      leaseGeneration: claimed.run.leaseGeneration,
      actor: runner,
      adapterId: "generic-mcp",
      profileId: "codex-default",
      profileVersion: null,
      requestFingerprint: fingerprint("b8"),
      commandId: "command-explicit-unknown",
      commandFingerprint: fingerprint("c9"),
      idempotencyKey: "reserve-explicit-unknown",
    })));
    expect(unknownReserved).toMatchObject({
      outcome: "reserved",
      command: { profileVersion: null },
    });

    const runAfter = await store!.db.query(
      "SELECT runner_profile_version FROM work_runs WHERE id = ?1",
    ).get(queued.run.id);
    expect(runAfter).toMatchObject({ runner_profile_version: null });
  });
});

async function runnerRequest(
  app: ReturnType<typeof createServerApp>,
  token: string,
  body: unknown,
): Promise<Response> {
  return app.request("/runner/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
    },
    body: JSON.stringify(body),
  });
}

function toolCall(id: number, name: string, args: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

async function readToolJson<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  const body = await response.json() as {
    result?: { content?: Array<{ type?: unknown; text?: unknown }>; isError?: boolean };
  };
  const first = body.result?.content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("Runner MCP response did not contain JSON text");
  }
  return JSON.parse(first.text) as T;
}

async function readToolError(response: Response): Promise<string> {
  expect(response.status).toBe(200);
  const body = await response.json() as {
    result?: { content?: Array<{ type?: unknown; text?: unknown }>; isError?: boolean };
  };
  expect(body.result?.isError).toBe(true);
  const first = body.result?.content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("Runner MCP error response did not contain text");
  }
  return first.text;
}

function fingerprint(seed: string): string {
  let hex = "";
  while (hex.length < 64) hex += seed.repeat(64).slice(0, 64 - hex.length);
  return `sha256:${hex.slice(0, 64)}`;
}
