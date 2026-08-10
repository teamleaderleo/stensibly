import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHostedApp } from "../src/hosted-app.ts";
import { createHostedSetupStatusObserver } from "../src/hosted-setup-status.ts";
import {
  compileProjectContract,
  renderProjectContract,
} from "../src/project-contract.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";

const observedAtMillis = Date.parse("2026-08-10T00:15:00.000Z");

class ReadAuthenticator implements ApiTokenAuthenticator {
  async authenticate(rawToken: string): Promise<TokenPrincipal | null> {
    if (rawToken !== "read-token") return null;
    return {
      tokenId: "tok_hosted_setup_reader",
      name: "Hosted setup reader",
      scopes: ["read"],
      projects: ["scrapbook"],
    };
  }
}

let store: StensiblyStore;
let ledger: SqliteWorkLedger;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  ledger = new SqliteWorkLedger(store);
});

afterEach(() => store.close());

describe("hosted setup status observer", () => {
  test("reports only hosted facts it can prove", async () => {
    const observer = createHostedSetupStatusObserver({
      serviceOrigin: "https://API.Stensibly.Com",
      workspaceConfigured: true,
      oauthConfigured: true,
      now: () => observedAtMillis,
    });

    const tokenObservation = await observer.observe({
      project: "scrapbook",
      principalKind: "api_token",
      hasAcceptedAttachment: false,
    });
    expect(tokenObservation.setup).toMatchObject({
      mode: "production",
      observedAt: "2026-08-10T00:15:00.000Z",
      serviceOrigin: "https://api.stensibly.com",
      mcpEndpoint: "https://api.stensibly.com/mcp",
      lastVerifiedStep: "project",
      steps: {
        deployment: "ready",
        backend: "ready",
        account: "missing",
        workspace: "ready",
        project: "ready",
        oauth_discovery: "ready",
        mcp_connection: "missing",
        first_read: "missing",
        repository: "missing",
        proofwake: "deferred",
      },
    });

    const accountObservation = await observer.observe({
      project: "scrapbook",
      principalKind: "account",
      hasAcceptedAttachment: true,
    });
    expect(accountObservation.setup.steps.account).toBe("ready");
    expect(accountObservation.setup.steps.repository).toBe("ready");
    expect(accountObservation.setup.steps.mcp_connection).toBe("missing");
    expect(accountObservation.setup.steps.first_read).toBe("missing");
  });

  test("keeps absent workspace and OAuth visibly incomplete", async () => {
    const observer = createHostedSetupStatusObserver({
      serviceOrigin: "https://api.stensibly.com",
      workspaceConfigured: false,
      oauthConfigured: false,
      now: () => observedAtMillis,
    });
    const observation = await observer.observe({
      project: "scrapbook",
      principalKind: "account",
      hasAcceptedAttachment: false,
    });
    expect(observation.setup.steps.workspace).toBe("missing");
    expect(observation.setup.steps.oauth_discovery).toBe("missing");
  });

  test("rejects unsafe hosted origins and invalid observation clocks", async () => {
    for (const serviceOrigin of [
      "http://api.stensibly.com",
      "https://user:secret@api.stensibly.com",
      "https://api.stensibly.com/path",
      "https://api.stensibly.com/?token=value",
    ]) {
      expect(() => createHostedSetupStatusObserver({
        serviceOrigin,
        workspaceConfigured: true,
        oauthConfigured: false,
      })).toThrow("Hosted setup service origin");
    }

    const observer = createHostedSetupStatusObserver({
      serviceOrigin: "https://api.stensibly.com",
      workspaceConfigured: true,
      oauthConfigured: false,
      now: () => Number.NaN,
    });
    expect(() => observer.observe({
      project: "scrapbook",
      principalKind: "account",
      hasAcceptedAttachment: false,
    })).toThrow("observation time");
  });
});

describe("hosted setup status API mount", () => {
  test("exposes conservative hosted readiness and repository recovery", async () => {
    const app = createHostedApp({
      ledger,
      authenticator: new ReadAuthenticator(),
      workspace: "default",
      setupStatus: {
        serviceOrigin: "https://api.stensibly.com",
        now: () => observedAtMillis,
      },
    });

    const response = await app.request("/api/v1/projects/scrapbook/setup-status", {
      headers: bearer("read-token"),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      setupStatus: {
        mode: "production",
        state: "partially_configured",
        nextStep: "account",
        lastVerifiedStep: "project",
        repositoryRecovery: {
          state: "repository_context_required",
          nextAction: "provide_repository_context",
          authorizesProviderEffect: false,
        },
        steps: [
          { step: "deployment", state: "ready", required: true },
          { step: "backend", state: "ready", required: true },
          { step: "account", state: "missing", required: true },
          { step: "workspace", state: "ready", required: true },
          { step: "project", state: "ready", required: true },
          { step: "oauth_discovery", state: "missing", required: true },
          { step: "mcp_connection", state: "missing", required: true },
          { step: "first_read", state: "missing", required: true },
          { step: "repository", state: "missing", required: false },
          { step: "proofwake", state: "deferred", required: false },
        ],
        containsSecrets: false,
      },
    });
  });

  test("uses accepted attachment existence for hosted repository readiness", async () => {
    await ledger.acceptProjectAttachment({
      project: "scrapbook",
      snapshot: attachmentSnapshot(),
      sourceRevision: "accepted-main",
      acceptedBy: "token:operator",
      acceptAuthorityWidening: true,
    });
    const app = createHostedApp({
      ledger,
      authenticator: new ReadAuthenticator(),
      workspace: "default",
      setupStatus: {
        serviceOrigin: "https://api.stensibly.com",
        now: () => observedAtMillis,
      },
    });

    const response = await app.request("/api/v1/projects/scrapbook/setup-status", {
      headers: bearer("read-token"),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.setupStatus.repositoryRecovery).toBeNull();
    expect(body.setupStatus.steps.find((entry: any) => entry.step === "repository"))
      .toMatchObject({ state: "ready", required: false });
  });

  test("keeps the hosted route absent without a setup-status mount", async () => {
    const app = createHostedApp({
      ledger,
      authenticator: new ReadAuthenticator(),
      workspace: "default",
    });
    const response = await app.request("/api/v1/projects/scrapbook/setup-status", {
      headers: bearer("read-token"),
    });
    expect(response.status).toBe(404);
  });
});

function attachmentSnapshot() {
  return compileProjectContract(renderProjectContract({
    version: 1,
    project: "scrapbook",
    repositories: ["teamleaderleo/scrapbook"],
    runnerProfiles: ["codex-default"],
    concurrency: { project: 1, global: 1 },
    autonomousActions: ["inspect", "propose", "create_draft_pr"],
    approvalRequired: ["merge", "deploy"],
    checks: ["bun test"],
    tags: ["coordination"],
    relatedProjects: [],
  }, {
    goal: "Coordinate Scrapbook work.",
    boundaries: "Keep consequential effects approval-gated.",
    evidenceAndHandoff: "Leave exact repository evidence.",
    escalation: "Escalate missing authority.",
  }));
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
