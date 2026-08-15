import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const supervisor = {
  id: "service:resume-http-supervisor",
  name: "Resume HTTP Supervisor",
  kind: "service" as const,
};
const runner = {
  id: "agent:resume-http-runner",
  name: "Resume HTTP Runner",
  kind: "agent" as const,
};

let store: StensiblyStore;
let ledger: SqliteWorkLedger;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  ledger = new SqliteWorkLedger(store);
});

afterEach(() => store.close());

describe("Control Room resume inspection HTTP routes", () => {
  test("renders a read-only operator receipt and JSON evidence", async () => {
    const run = await claimedRun("resume_http");
    const app = createServerApp(store);

    const html = await app.request(`/runs/${encodeURIComponent(run.id)}/resume-inspection`);
    expect(html.status).toBe(200);
    const page = await html.text();
    expect(page).toContain("Resume inspection");
    expect(page).toContain("authorizesMutation=false");
    expect(page).toContain("authorizesResume=false");
    expect(page).not.toContain("<form");
    expect(page).not.toContain("<button");

    const json = await app.request(`/api/runs/${encodeURIComponent(run.id)}/resume-inspection`);
    expect(json.status).toBe(200);
    expect(await json.json()).toMatchObject({
      inspection: {
        runId: run.id,
        project: "resume_http",
        decision: "unknown",
        checkpoint: null,
        priorCommandId: null,
        priorCommandSettled: false,
        interruptionObserved: false,
        currentAuthorityPresent: true,
        continuationRef: null,
        authorizesMutation: false,
        authorizesResume: false,
        checks: expect.arrayContaining([
          expect.objectContaining({ id: "checkpoint-reference", state: "unknown" }),
          expect.objectContaining({ id: "interruption-evidence", state: "unknown" }),
          expect.objectContaining({ id: "continuation", state: "unknown" }),
          expect.objectContaining({ id: "current-authority", state: "pass" }),
          expect.objectContaining({ id: "current-capability-binding", state: "unknown" }),
          expect.objectContaining({ id: "authoritative-command", state: "unknown" }),
        ]),
      },
    });
  });

  test("uses the configured token authority and durable project allowlist", async () => {
    const allowed = await claimedRun("resume_allowed");
    const denied = await claimedRun("resume_secret");
    const token = createApiToken(store, {
      name: "Resume receipt reader",
      scopes: ["read"],
      projects: ["resume_allowed"],
    });
    const app = createServerApp(store, { httpAuth: { required: true } });

    const missing = await app.request(`/runs/${encodeURIComponent(allowed.id)}/resume-inspection`);
    expect(missing.status).toBe(401);

    const visible = await app.request(`/runs/${encodeURIComponent(allowed.id)}/resume-inspection`, {
      headers: { authorization: `Bearer ${token.token}` },
    });
    expect(visible.status).toBe(200);

    const hidden = await app.request(`/api/runs/${encodeURIComponent(denied.id)}/resume-inspection`, {
      headers: { authorization: `Bearer ${token.token}` },
    });
    expect(hidden.status).toBe(403);
    expect(await hidden.json()).toMatchObject({ error: "Token cannot access project resume_secret" });
  });

  test("does not mount SQLite resume receipts for a hosted backend declaration", async () => {
    const run = await claimedRun("resume_hosted_boundary");
    const app = createServerApp(store, { backend: "convex" });
    const response = await app.request(`/api/runs/${encodeURIComponent(run.id)}/resume-inspection`);
    expect(response.status).toBe(404);
  });
});

async function claimedRun(project: string) {
  const item = store.createItem({
    project,
    kind: "task",
    title: `Inspect ${project}`,
    priority: 80,
    actor: supervisor,
  });
  const dispatched = dispatchNextWork(store, {
    actor: supervisor,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    itemId: item.id,
    leaseSeconds: 900,
    idempotencyKey: `dispatch-${project}`,
  });
  if (!dispatched) throw new Error("Resume HTTP fixture did not dispatch");
  const run = await ledger.claimRunnerWork({
    actor: runner,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    project,
    runId: dispatched.run.id,
    leaseSeconds: 900,
    idempotencyKey: `claim-${project}`,
  });
  if (!run) throw new Error("Resume HTTP fixture was not claimed");
  return run;
}
