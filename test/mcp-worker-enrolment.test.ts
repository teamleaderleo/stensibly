import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";
import {
  buildRemoteMcpWorkerEnrolment,
  type WorkerEnrolmentProviderInput,
} from "../src/worker-enrolment-mcp.ts";

const project = "stensibly";
const now = Date.UTC(2026, 7, 11, 18, 30, 0);

describe("authenticated MCP worker enrolment", () => {
  test("derives stable ownership, scope, lifetime, and replay identity server-side", () => {
    const principal = writePrincipal();
    const first = buildRemoteMcpWorkerEnrolment({
      project,
      workerSessionId: "chat.session-42",
      callsign: "Keel",
      context: { principal },
      now,
    });
    const sameDay = buildRemoteMcpWorkerEnrolment({
      project,
      workerSessionId: "chat.session-42",
      callsign: "Keel",
      context: { principal: { ...principal, tokenId: "rotated-token" } },
      now: now + 60_000,
    });
    const nextDay = buildRemoteMcpWorkerEnrolment({
      project,
      workerSessionId: "chat.session-42",
      callsign: "Keel",
      context: { principal },
      now: now + 24 * 60 * 60 * 1_000,
    });

    expect(first).toEqual(sameDay);
    expect(first).toMatchObject({
      actorId: "api-token:oauth-grant-worker",
      clientId: "mcp:api-token:oauth-grant-worker",
      oauthAccountId: "acct-worker",
      request: {
        adapter: "remote-mcp",
        profile: "authenticated-generalist",
        workerSessionId: "chat.session-42",
        callsign: "Keel",
        capabilities: ["coordination"],
        toolAllowlist: [],
        projectScope: [project],
        preferredStances: [],
        heartbeatSeconds: 3_600,
        grantsAuthority: false,
      },
    });
    expect(Date.parse(first.request.expiresAt) - Date.parse(first.request.startedAt))
      .toBe(48 * 60 * 60 * 1_000);
    expect(first.idempotencyKey).toMatch(/^enrol_worker:v1:[a-f0-9]{64}$/);
    expect(nextDay.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  test("mounts only with a durable provider and exposes only three public inputs", async () => {
    const store = new StensiblyStore(":memory:");
    const bareServer = createMcpServer(new SqliteWorkLedger(store));
    const calls: WorkerEnrolmentProviderInput[] = [];
    const ledger = Object.assign(new SqliteWorkLedger(store), {
      async enrolWorker(input: WorkerEnrolmentProviderInput) {
        calls.push(input);
        return backendResult(input, "accepted");
      },
    });
    const server = createMcpServer(ledger, { principal: writePrincipal() });
    const bareClient = testClient("worker-enrolment-bare");
    const client = testClient("worker-enrolment-hosted");
    const [bareClientTransport, bareServerTransport] = InMemoryTransport.createLinkedPair();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await bareServer.connect(bareServerTransport);
      await bareClient.connect(bareClientTransport);
      expect((await bareClient.listTools()).tools.map((tool) => tool.name))
        .not.toContain("enrol_worker");

      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tool = (await client.listTools()).tools.find(
        (candidate) => candidate.name === "enrol_worker",
      );
      expect(tool?.inputSchema).toMatchObject({
        type: "object",
        required: ["project", "workerSessionId", "callsign"],
      });
      expect(Object.keys((tool?.inputSchema as { properties: object }).properties).sort())
        .toEqual(["callsign", "project", "workerSessionId"]);
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });

      const result = await call(client, {
        project,
        workerSessionId: "chat.session-42",
        callsign: "Keel",
      });
      expect(result).toEqual({
        version: 1,
        outcome: "accepted",
        reason: null,
        worker: {
          workerRef: "wrk_test",
          workerSessionId: "chat.session-42",
          callsign: "Keel",
          callsignLeaseGeneration: 1,
          status: "active",
          startedAt: calls[0]!.request.startedAt,
          expiresAt: calls[0]!.request.expiresAt,
          acceptedAt: calls[0]!.request.startedAt,
          lastHeartbeatAt: calls[0]!.request.startedAt,
          grantsAuthority: false,
        },
        reused: false,
        grantsAuthority: false,
      });
      expect(calls).toHaveLength(1);
      expect(Object.keys(calls[0]!).sort()).toEqual([
        "actorId",
        "clientId",
        "idempotencyKey",
        "oauthAccountId",
        "request",
      ]);
      expect(JSON.stringify(result)).not.toContain("requestFingerprint");
      expect(JSON.stringify(result)).not.toContain("callsignLeaseId");
    } finally {
      await bareClient.close();
      await bareServer.close();
      await client.close();
      await server.close();
      store.close();
    }
  });

  test("converges a later-bucket active-session collision and rejects forged bindings", async () => {
    const reused = await callWithProvider((input) =>
      backendResult(input, "rejected", "active_session_exists")
    );
    expect(reused).toMatchObject({
      outcome: "accepted",
      reason: null,
      reused: true,
      grantsAuthority: false,
      worker: { workerSessionId: "chat.session-42" },
    });

    const forged = await callWithProvider((input) => ({
      ...backendResult(input, "accepted"),
      worker: {
        ...(backendResult(input, "accepted") as { worker: Record<string, unknown> }).worker,
        projectScope: ["another-project"],
      },
    }), true);
    expect(forged).toContain("does not match the request");

    const drifted = await callWithProvider((input) => ({
      ...backendResult(input, "rejected", "active_session_exists"),
      worker: {
        ...(backendResult(input, "rejected", "active_session_exists") as {
          worker: Record<string, unknown>;
        }).worker,
        capabilities: ["coordination", "unreviewed-capability"],
      },
    }));
    expect(drifted).toMatchObject({
      outcome: "rejected",
      reason: "active_session_exists",
      worker: null,
    });
  });

  test("fails closed for missing, read-only, and project-scoped principals", () => {
    const base = {
      project,
      workerSessionId: "chat.session-42",
      callsign: "Keel",
      now,
    };
    expect(() => buildRemoteMcpWorkerEnrolment({ ...base, context: {} }))
      .toThrow("authenticated remote MCP principal");
    expect(() => buildRemoteMcpWorkerEnrolment({
      ...base,
      context: { principal: { ...writePrincipal(), scopes: ["read"] } },
    })).toThrow("write scope");
    expect(() => buildRemoteMcpWorkerEnrolment({
      ...base,
      context: { principal: { ...writePrincipal(), projects: ["other"] } },
    })).toThrow("outside this principal's project scope");
  });
});

function writePrincipal(): TokenPrincipal {
  return {
    tokenId: "token-worker",
    authorizationId: "oauth-grant-worker",
    oauthAccountId: "acct-worker",
    name: "Worker enrolment test",
    scopes: ["read", "write"],
    projects: [project],
  };
}

function testClient(name: string): Client {
  return new Client({ name, version: "0.0.1" }, { capabilities: {} });
}

function backendResult(
  input: WorkerEnrolmentProviderInput,
  outcome: "accepted" | "rejected",
  reason: "active_session_exists" | null = null,
) {
  return {
    version: 1,
    operation: "enrol",
    outcome,
    reason,
    worker: {
      workerRef: "wrk_test",
      adapter: input.request.adapter,
      profile: input.request.profile,
      workerSessionId: input.request.workerSessionId,
      capabilities: input.request.capabilities,
      toolAllowlist: input.request.toolAllowlist,
      projectScope: input.request.projectScope,
      preferredStances: input.request.preferredStances,
      startedAt: input.request.startedAt,
      expiresAt: input.request.expiresAt,
      heartbeatSeconds: input.request.heartbeatSeconds,
      correlationId: null,
      causationId: null,
      requestFingerprint: input.request.fingerprint,
      status: "active",
      acceptedAt: input.request.startedAt,
      lastHeartbeatAt: input.request.startedAt,
      releasedAt: null,
      expiredAt: null,
      callsign: input.request.callsign,
      callsignLeaseId: input.request.callsign ? "csl_test" : null,
      callsignLeaseGeneration: input.request.callsign ? 1 : null,
      grantsAuthority: false,
    },
    grantsAuthority: false,
  };
}

async function call(
  client: Client,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name: "enrol_worker", arguments: args });
  const text = textContent(result);
  if (result.isError) throw new Error(text);
  return JSON.parse(text) as Record<string, unknown>;
}

async function callWithProvider(
  provider: (input: WorkerEnrolmentProviderInput) => unknown,
  expectError = false,
): Promise<Record<string, unknown> | string> {
  const store = new StensiblyStore(":memory:");
  const ledger = Object.assign(new SqliteWorkLedger(store), {
    async enrolWorker(input: WorkerEnrolmentProviderInput) {
      return provider(input);
    },
  });
  const server = createMcpServer(ledger, { principal: writePrincipal() });
  const client = testClient("worker-enrolment-call");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "enrol_worker",
      arguments: { project, workerSessionId: "chat.session-42", callsign: "Keel" },
    });
    const text = textContent(result);
    if (expectError) {
      expect(result.isError).toBe(true);
      return text;
    }
    expect(result.isError).not.toBe(true);
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    await client.close();
    await server.close();
    store.close();
  }
}

function textContent(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) throw new Error("Missing content");
  const first = content[0] as { type?: unknown; text?: unknown };
  if (first.type !== "text" || typeof first.text !== "string") {
    throw new Error("Missing text content");
  }
  return first.text;
}
