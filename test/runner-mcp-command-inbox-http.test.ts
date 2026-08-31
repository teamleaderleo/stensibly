import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const supervisor = { id: "service:supervisor", name: "Supervisor", kind: "service" as const };
const runner = { id: "agent:remote-runner", name: "Remote Runner", kind: "agent" as const };
const replacement = {
  id: "agent:replacement-runner",
  name: "Replacement Runner",
  kind: "agent" as const,
};
const protocolVersion = "2025-06-18";
const requestFingerprint = `sha256:${"a".repeat(64)}`;
const commandFingerprint = `sha256:${"b".repeat(64)}`;

let store: StensiblyStore;
let app: ReturnType<typeof createServerApp>;
let alphaItemId: string;
let alphaRunId: string;
let secretItemId: string;
let secretRunId: string;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  const alpha = createItem("alpha", "Execute alpha remotely");
  const secret = createItem("secret", "Execute secret remotely");
  alphaItemId = alpha.id;
  secretItemId = secret.id;
  alphaRunId = dispatch(alpha.id, "dispatch-alpha-command-inbox");
  secretRunId = dispatch(secret.id, "dispatch-secret-command-inbox");
  app = createServerApp(store);
});

afterEach(() => store.close());

describe("runner MCP adapter command inbox", () => {
  test("reserves a physical command through the exact workstation authority fence", async () => {
    const token = runnerToken(["alpha"]);
    const item = createItem("alpha", "Execute exact Glaeda repository query");
    const profileVersion = `sha256:${"e".repeat(64)}`;
    const dispatched = dispatchNextWork(store, {
      actor: supervisor,
      runnerType: "glaeda-workstation",
      runnerProfile: "repo-query/v1",
      runnerProfileVersion: profileVersion,
      itemId: item.id,
      leaseSeconds: 300,
      idempotencyKey: "dispatch-alpha-workstation-command",
    });
    if (!dispatched) throw new Error("workstation fixture did not dispatch");
    const claimed = await readToolJson<{
      run: {
        id: string;
        generation: number;
        leaseGeneration: number;
        leaseExpiresAt: string;
      };
      item: { id: string; claimGeneration: number };
    }>(await runnerRequest(token.token, toolCall(30, "claim_runner_work", {
      actor: runner,
      runnerType: "glaeda-workstation",
      runnerProfile: "repo-query/v1",
      runnerProfileVersion: profileVersion,
      runId: dispatched.run.id,
      leaseSeconds: 300,
      idempotencyKey: "claim-alpha-workstation-command",
    })));
    const reservation = {
      project: "alpha",
      itemId: claimed.item.id,
      itemClaimGeneration: claimed.item.claimGeneration,
      runId: claimed.run.id,
      runGeneration: claimed.run.generation,
      leaseGeneration: claimed.run.leaseGeneration,
      authorityHolderId: runner.id,
      authorityExpiresAt: claimed.run.leaseExpiresAt,
      actor: runner,
      adapterId: "glaeda-workstation",
      profileId: "repo-query/v1",
      profileVersion,
      requestFingerprint,
      commandId: "alpha-workstation-command-1",
      commandFingerprint,
      idempotencyKey: "reserve-alpha-workstation-command-1",
    };
    const first = await readToolJson<{
      outcome: string;
      dispatchAuthorized: boolean;
      command: { commandId: string };
    }>(await runnerRequest(token.token, toolCall(
      31,
      "reserve_workstation_adapter_command",
      reservation,
    )));
    expect(first).toMatchObject({
      outcome: "reserved",
      dispatchAuthorized: true,
      command: { commandId: reservation.commandId },
    });

    expect(await readToolError(await runnerRequest(token.token, toolCall(
      32,
      "reserve_workstation_adapter_command",
      {
        ...reservation,
        itemClaimGeneration: reservation.itemClaimGeneration + 1,
        commandId: "alpha-workstation-command-stale",
        commandFingerprint: `sha256:${"7".repeat(64)}`,
        idempotencyKey: "reserve-alpha-workstation-command-stale",
      },
    )))).toContain("claim generation or authority changed");
  });

  test("reserves, replays, reads, and settles one exact remote adapter command", async () => {
    const token = runnerToken(["alpha"]);
    const claimed = await claim(token.token, alphaRunId, "claim-alpha-command-inbox");
    const reservation = commandReservation(
      "alpha",
      alphaItemId,
      claimed,
      "alpha-command-1",
      "reserve-alpha-command-1",
    );

    expect(await readToolError(await runnerRequest(token.token, toolCall(
      100,
      "reserve_runner_adapter_command",
      {
        ...reservation,
        adapterId: "different-adapter",
        commandId: "alpha-command-wrong-adapter",
        idempotencyKey: "reserve-alpha-wrong-adapter",
      },
    )))).toContain("adapter or profile does not match the run");
    expect(await readToolError(await runnerRequest(token.token, toolCall(
      101,
      "reserve_runner_adapter_command",
      {
        ...reservation,
        profileId: "different-profile",
        commandId: "alpha-command-wrong-profile",
        idempotencyKey: "reserve-alpha-wrong-profile",
      },
    )))).toContain("adapter or profile does not match the run");
    expect(await readToolJson(await runnerRequest(token.token, toolCall(
      102,
      "get_runner_adapter_command",
      { project: "alpha", idempotencyKey: "reserve-alpha-wrong-adapter" },
    )))).toBeNull();
    expect(await readToolJson(await runnerRequest(token.token, toolCall(
      103,
      "get_runner_adapter_command",
      { project: "alpha", idempotencyKey: "reserve-alpha-wrong-profile" },
    )))).toBeNull();

    const first = await readToolJson<{
      outcome: string;
      dispatchAuthorized: boolean;
      command: { commandId: string; reservedAt: string };
      settlement: null;
    }>(await runnerRequest(token.token, toolCall(2, "reserve_runner_adapter_command", reservation)));
    expect(first).toMatchObject({
      outcome: "reserved",
      dispatchAuthorized: true,
      command: { commandId: reservation.commandId },
      settlement: null,
    });

    const replay = await readToolJson<{
      outcome: string;
      dispatchAuthorized: boolean;
      command: { commandId: string; reservedAt: string };
    }>(await runnerRequest(token.token, toolCall(3, "reserve_runner_adapter_command", reservation)));
    expect(replay).toMatchObject({
      outcome: "replayed",
      dispatchAuthorized: false,
      command: {
        commandId: reservation.commandId,
        reservedAt: first.command.reservedAt,
      },
    });

    const read = await readToolJson<{
      command: { project: string; commandId: string; commandFingerprint: string };
      settlement: null;
    }>(await runnerRequest(token.token, toolCall(4, "get_runner_adapter_command", {
      project: "alpha",
      idempotencyKey: reservation.idempotencyKey,
    })));
    expect(read).toEqual({
      command: expect.objectContaining({
        project: "alpha",
        commandId: reservation.commandId,
        commandFingerprint: reservation.commandFingerprint,
      }),
      settlement: null,
    });

    const outcome = terminalOutcome("alpha-terminal");
    const settled = await readToolJson<{
      outcome: string;
      settlement: { commandId: string; outcome: typeof outcome; outcomeSha256: string };
    }>(await runnerRequest(token.token, toolCall(5, "settle_runner_adapter_command", {
      project: "alpha",
      reservationIdempotencyKey: reservation.idempotencyKey,
      commandId: reservation.commandId,
      commandFingerprint: reservation.commandFingerprint,
      outcome,
    })));
    expect(settled).toMatchObject({
      outcome: "settled",
      settlement: {
        commandId: reservation.commandId,
        outcome,
        outcomeSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });

    const settledReplay = await readToolJson<{
      command: { commandId: string };
      settlement: { commandId: string; outcomeSha256: string };
    }>(await runnerRequest(token.token, toolCall(6, "get_runner_adapter_command", {
      project: "alpha",
      idempotencyKey: reservation.idempotencyKey,
    })));
    expect(settledReplay).toMatchObject({
      command: { commandId: reservation.commandId },
      settlement: {
        commandId: reservation.commandId,
        outcomeSha256: settled.settlement.outcomeSha256,
      },
    });

    expect(await readToolError(await runnerRequest(token.token, toolCall(
      7,
      "settle_runner_adapter_command",
      {
        project: "alpha",
        reservationIdempotencyKey: reservation.idempotencyKey,
        commandId: reservation.commandId,
        commandFingerprint: `sha256:${"c".repeat(64)}`,
        outcome,
      },
    )))).toContain("reservation identity changed");
  });

  test("claims stranded recovery ownership without granting remote execution authority", async () => {
    const token = runnerToken(["alpha"]);
    const claimed = await claim(token.token, alphaRunId, "claim-alpha-recovery-inbox");
    const reservation = commandReservation(
      "alpha",
      alphaItemId,
      claimed,
      "alpha-command-recovery",
      "reserve-alpha-command-recovery",
    );
    await readToolJson(await runnerRequest(
      token.token,
      toolCall(10, "reserve_runner_adapter_command", reservation),
    ));
    store.db.query(`
      UPDATE work_runs SET lease_expires_at = ?1 WHERE id = ?2
    `).run(new Date(Date.now() - 1_000).toISOString(), claimed.id);

    const recoveryInput = {
      project: "alpha",
      reservationIdempotencyKey: reservation.idempotencyKey,
      commandId: reservation.commandId,
      commandFingerprint: reservation.commandFingerprint,
      actor: replacement,
      leaseSeconds: 60,
      idempotencyKey: "recover-alpha-command",
    };
    const recovery = await readToolJson<{
      outcome: string;
      claim: {
        commandId: string;
        runId: string;
        recoveryGeneration: number;
        actor: typeof replacement;
        authorizesRedispatch: boolean;
        authorizesResume: boolean;
      };
    }>(await runnerRequest(token.token, toolCall(
      11,
      "claim_runner_adapter_command_recovery",
      recoveryInput,
    )));
    expect(recovery).toMatchObject({
      outcome: "claimed",
      claim: {
        commandId: reservation.commandId,
        runId: claimed.id,
        recoveryGeneration: 1,
        actor: replacement,
        authorizesRedispatch: false,
        authorizesResume: false,
      },
    });

    const replay = await readToolJson<{ outcome: string; claim: { recoveryGeneration: number } }>(
      await runnerRequest(token.token, toolCall(
        12,
        "claim_runner_adapter_command_recovery",
        recoveryInput,
      )),
    );
    expect(replay).toMatchObject({
      outcome: "replayed",
      claim: { recoveryGeneration: 1 },
    });

    const durable = await readToolJson<{
      command: { commandId: string };
      settlement: null;
    }>(await runnerRequest(token.token, toolCall(13, "get_runner_adapter_command", {
      project: "alpha",
      idempotencyKey: reservation.idempotencyKey,
    })));
    expect(durable).toEqual({
      command: expect.objectContaining({ commandId: reservation.commandId }),
      settlement: null,
    });
  });

  test("fences command inbox tools by scope and durable project identity", async () => {
    const alpha = runnerToken(["alpha"]);
    const reader = createApiToken(store, {
      name: "Alpha runner reader",
      scopes: ["read"],
      projects: ["alpha"],
    });
    expect((await runnerRequest(alpha.token, toolCall(20, "get_runner_adapter_command", {
      project: "secret",
      idempotencyKey: "unknown-secret-command",
    }))).status).toBe(403);
    expect((await runnerRequest(alpha.token, toolCall(21, "get_runner_adapter_command", {
      idempotencyKey: "missing-project-command",
    }))).status).toBe(400);
    expect((await runnerRequest(reader.token, toolCall(22, "reserve_runner_adapter_command", {
      project: "alpha",
    }))).status).toBe(403);

    const reserveDenied = await runnerRequest(alpha.token, toolCall(
      28,
      "reserve_runner_adapter_command",
      { project: "alpha", runId: secretRunId },
    ));
    expect(reserveDenied.status).toBe(403);
    expect((await reserveDenied.json() as { error?: { message?: string } }).error?.message)
      .toBe("Token cannot access project secret");

    const unrestricted = runnerToken(null);
    const claimed = await claim(
      unrestricted.token,
      secretRunId,
      "claim-secret-command-inbox",
    );
    const reservation = commandReservation(
      "secret",
      secretItemId,
      claimed,
      "secret-command-1",
      "reserve-secret-command-1",
    );
    await readToolJson(await runnerRequest(
      unrestricted.token,
      toolCall(23, "reserve_runner_adapter_command", reservation),
    ));

    const crossProjectCalls = [
      toolCall(24, "get_runner_adapter_command", {
        project: "alpha",
        idempotencyKey: reservation.idempotencyKey,
      }),
      toolCall(25, "settle_runner_adapter_command", {
        project: "alpha",
        reservationIdempotencyKey: reservation.idempotencyKey,
        commandId: reservation.commandId,
        commandFingerprint: reservation.commandFingerprint,
        outcome: terminalOutcome("secret-terminal"),
      }),
      toolCall(26, "claim_runner_adapter_command_recovery", {
        project: "alpha",
        reservationIdempotencyKey: reservation.idempotencyKey,
        commandId: reservation.commandId,
        commandFingerprint: reservation.commandFingerprint,
        actor: replacement,
        leaseSeconds: 60,
        idempotencyKey: "recover-secret-through-alpha",
      }),
    ];
    for (const call of crossProjectCalls) {
      const denied = await runnerRequest(alpha.token, call);
      expect(denied.status).toBe(403);
      const body = await denied.json() as { error?: { message?: string } };
      expect(body.error?.message).toBe("Token cannot access project secret");
    }

    expect(await readToolError(await runnerRequest(unrestricted.token, toolCall(
      27,
      "get_runner_adapter_command",
      {
        project: "alpha",
        idempotencyKey: reservation.idempotencyKey,
      },
    )))).toContain("belongs to another project");
  });
});

function runnerToken(projects: string[] | null) {
  return createApiToken(store, {
    name: projects === null ? "Unrestricted runner" : "Scoped runner",
    scopes: ["read", "write"],
    projects,
  });
}

function createItem(project: string, title: string) {
  return store.createItem({
    project,
    kind: "task",
    title,
    summary: `Canonical context for ${project}.`,
    nextAction: "Execute this through the runner command inbox.",
    priority: 80,
    actor: supervisor,
  });
}

function dispatch(itemId: string, idempotencyKey: string): string {
  return dispatchNextWork(store, {
    actor: supervisor,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    itemId,
    leaseSeconds: 300,
    idempotencyKey,
  })!.run.id;
}

async function claim(token: string, runId: string, idempotencyKey: string) {
  return await readToolJson<{
    run: {
      id: string;
      generation: number;
      leaseGeneration: number;
      itemId: string;
    };
  }>(await runnerRequest(token, toolCall(1, "claim_runner_work", {
    actor: runner,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    runId,
    leaseSeconds: 300,
    idempotencyKey,
  }))).then((value) => value.run);
}

function commandReservation(
  project: string,
  itemId: string,
  run: { id: string; generation: number; leaseGeneration: number },
  commandId: string,
  idempotencyKey: string,
) {
  return {
    project,
    itemId,
    runId: run.id,
    runGeneration: run.generation,
    leaseGeneration: run.leaseGeneration,
    actor: runner,
    adapterId: "generic-mcp",
    profileId: "codex-default",
    requestFingerprint,
    commandId,
    commandFingerprint,
    idempotencyKey,
  };
}

function terminalOutcome(terminalObservationId: string) {
  return {
    version: 1 as const,
    kind: "bounded_episode_completed" as const,
    observationCount: 1,
    observationsSha256: `sha256:${"d".repeat(64)}`,
    terminalObservationId,
    terminalObservationType: "interrupted",
    latestCheckpointExternalId: null,
    latestCheckpointSha256: null,
    containsPrivateContent: false as const,
    containsCredentials: false as const,
  };
}

async function runnerRequest(token: string, body: unknown): Promise<Response> {
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

async function readToolJson<T = unknown>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  const body = await response.json() as {
    result?: {
      content?: Array<{ type?: unknown; text?: unknown }>;
      isError?: boolean;
    };
  };
  expect(body.result?.isError).not.toBe(true);
  const first = body.result?.content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("Runner MCP response did not contain JSON text");
  }
  return JSON.parse(first.text) as T;
}

async function readToolError(response: Response): Promise<string> {
  expect(response.status).toBe(200);
  const body = await response.json() as {
    result?: {
      content?: Array<{ type?: unknown; text?: unknown }>;
      isError?: boolean;
    };
  };
  expect(body.result?.isError).toBe(true);
  const first = body.result?.content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("Runner MCP error did not contain text");
  }
  return first.text;
}
