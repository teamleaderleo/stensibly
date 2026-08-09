import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  compileProjectContract,
  renderProjectContract,
} from "../src/project-contract.ts";
import { createServerApp } from "../src/server-app.ts";
import type {
  ProjectSetupStatusObserver,
} from "../src/setup-status-api.ts";
import type { SetupStatusInput, SetupStepStates } from "../src/setup-status.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";

const principals: Record<string, TokenPrincipal> = {
  reader: {
    tokenId: "tok_reader_internal",
    name: "setup-reader",
    scopes: ["read"],
    projects: ["scrapbook"],
  },
  outsider: {
    tokenId: "tok_outsider_internal",
    name: "other-reader",
    scopes: ["read"],
    projects: ["other"],
  },
};

class FixedAuthenticator implements ApiTokenAuthenticator {
  async authenticate(rawToken: string): Promise<TokenPrincipal | null> {
    return principals[rawToken] ?? null;
  }
}

class CountingAuthenticator extends FixedAuthenticator {
  calls = 0;

  override async authenticate(rawToken: string): Promise<TokenPrincipal | null> {
    this.calls += 1;
    return super.authenticate(rawToken);
  }
}

let store: StensiblyStore;
let ledger: SqliteWorkLedger;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  ledger = new SqliteWorkLedger(store);
});

afterEach(() => store.close());

describe("project setup status API", () => {
  test("keeps the route absent until an observer is configured", async () => {
    const app = createServerApp(store, {
      ledger,
      authenticator: new FixedAuthenticator(),
      httpAuth: { required: true },
    });
    const response = await app.request("/api/v1/projects/scrapbook/setup-status", {
      headers: bearer("reader"),
    });
    expect(response.status).toBe(404);
  });

  test("preserves anonymous local single-operator reads", async () => {
    const calls: unknown[] = [];
    const app = createServerApp(store, {
      ledger,
      authenticator: new FixedAuthenticator(),
      httpAuth: { required: false },
      setupStatusObserver: {
        observe(input) {
          calls.push(input);
          return { setup: setup("missing") };
        },
      },
    });
    const response = await app.request("/api/v1/projects/scrapbook/setup-status");
    expect(response.status).toBe(200);
    expect(calls).toEqual([{
      project: "scrapbook",
      principalKind: "anonymous",
      hasAcceptedAttachment: false,
    }]);
  });

  test("authenticates the setup route and ordinary API routes once each", async () => {
    const authenticator = new CountingAuthenticator();
    const app = createServerApp(store, {
      ledger,
      authenticator,
      httpAuth: { required: true },
      setupStatusObserver: { observe: () => ({ setup: setup("missing") }) },
    });

    const setupResponse = await app.request("/api/v1/projects/scrapbook/setup-status", {
      headers: bearer("reader"),
    });
    expect(setupResponse.status).toBe(200);
    expect(authenticator.calls).toBe(1);

    const itemsResponse = await app.request("/api/v1/items?project=scrapbook", {
      headers: bearer("reader"),
    });
    expect(itemsResponse.status).toBe(200);
    expect(authenticator.calls).toBe(2);
  });

  test("checks project read access before observing and returns missing-context recovery", async () => {
    const calls: unknown[] = [];
    const observer: ProjectSetupStatusObserver = {
      observe(input) {
        calls.push(input);
        return { setup: setup("missing") };
      },
    };
    const app = createServerApp(store, {
      ledger,
      authenticator: new FixedAuthenticator(),
      httpAuth: { required: true },
      setupStatusObserver: observer,
    });

    const denied = await app.request("/api/v1/projects/scrapbook/setup-status", {
      headers: bearer("outsider"),
    });
    expect(denied.status).toBe(403);
    expect(calls).toEqual([]);

    const visible = await app.request("/api/v1/projects/scrapbook/setup-status", {
      headers: bearer("reader"),
    });
    expect(visible.status).toBe(200);
    expect(await visible.json()).toMatchObject({
      setupStatus: {
        state: "ready",
        repositoryRecovery: {
          state: "repository_context_required",
          nextAction: "provide_repository_context",
          authorizesProviderEffect: false,
        },
        containsSecrets: false,
      },
    });
    expect(calls).toEqual([{
      project: "scrapbook",
      principalKind: "api_token",
      hasAcceptedAttachment: false,
    }]);
  });

  test("returns the advisory attachment plan from already-observed repository facts", async () => {
    const app = createServerApp(store, {
      ledger,
      authenticator: new FixedAuthenticator(),
      httpAuth: { required: true },
      setupStatusObserver: {
        observe: ({ hasAcceptedAttachment }) => ({
          setup: setup(hasAcceptedAttachment ? "ready" : "missing"),
          repositorySetup: {
            repositoryFullName: "teamleaderleo/scrapbook",
            defaultBranch: "main",
            runnerProfiles: ["codex-default"],
            workProfile: "draft_pr",
            checks: ["bun run typecheck", "bun test"],
          },
        }),
      },
    });
    const response = await app.request("/api/v1/projects/scrapbook/setup-status", {
      headers: bearer("reader"),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      setupStatus: {
        repositoryRecovery: {
          state: "attachment_required",
          repository: {
            fullName: "teamleaderleo/scrapbook",
            defaultBranch: "main",
          },
          nextAction: {
            kind: "review_and_accept_project_attachment",
            requiresAdmin: true,
          },
          verification: {
            repositoryMetadata: "get_repo",
            immutableFileRead: "fetch_file",
            immutableReadRef: "exact_commit_sha",
          },
          authorizesProviderEffect: false,
          containsSecrets: false,
        },
      },
    });
  });

  test("exposes only attachment existence while keeping the attachment record server-owned", async () => {
    await ledger.acceptProjectAttachment({
      project: "scrapbook",
      snapshot: attachmentSnapshot(),
      sourceRevision: "accepted-main",
      acceptedBy: "token:operator",
      acceptAuthorityWidening: true,
    });

    const calls: unknown[] = [];
    const readyApp = createServerApp(store, {
      ledger,
      authenticator: new FixedAuthenticator(),
      httpAuth: { required: true },
      setupStatusObserver: {
        observe(input) {
          calls.push(input);
          return { setup: setup(input.hasAcceptedAttachment ? "ready" : "missing") };
        },
      },
    });
    const ready = await readyApp.request("/api/v1/projects/scrapbook/setup-status", {
      headers: bearer("reader"),
    });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      setupStatus: { repositoryRecovery: null },
    });
    expect(calls).toEqual([{
      project: "scrapbook",
      principalKind: "api_token",
      hasAcceptedAttachment: true,
    }]);

    const staleApp = createServerApp(store, {
      ledger,
      authenticator: new FixedAuthenticator(),
      httpAuth: { required: true },
      setupStatusObserver: { observe: () => ({ setup: setup("missing") }) },
    });
    const stale = await staleApp.request("/api/v1/projects/scrapbook/setup-status", {
      headers: bearer("reader"),
    });
    expect(stale.status).toBe(400);
    expect(await stale.json()).toEqual({
      error: "Setup status observation is invalid",
      code: "invalid_observation",
    });
  });

  test("contains attachment observation failures before observer execution", async () => {
    const accepted = await ledger.acceptProjectAttachment({
      project: "scrapbook",
      snapshot: attachmentSnapshot(),
      sourceRevision: "accepted-main",
      acceptedBy: "token:operator",
      acceptAuthorityWidening: true,
    });
    store.db.query("UPDATE project_attachments SET content_sha256 = ?1 WHERE id = ?2")
      .run(`sha256:${"0".repeat(64)}`, accepted.attachment.id);

    const calls: unknown[] = [];
    const app = createServerApp(store, {
      ledger,
      authenticator: new FixedAuthenticator(),
      httpAuth: { required: true },
      setupStatusObserver: {
        observe(input) {
          calls.push(input);
          return { setup: setup("ready") };
        },
      },
    });
    const response = await app.request("/api/v1/projects/scrapbook/setup-status", {
      headers: bearer("reader"),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Project attachment observation failed",
      code: "attachment_observation_failed",
    });
    expect(calls).toEqual([]);
  });

  test("collapses observer failures to fixed non-secret output", async () => {
    const app = createServerApp(store, {
      ledger,
      authenticator: new FixedAuthenticator(),
      httpAuth: { required: true },
      setupStatusObserver: {
        observe() {
          throw new Error("observer-private-detail");
        },
      },
    });
    const response = await app.request("/api/v1/projects/scrapbook/setup-status", {
      headers: bearer("reader"),
    });
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("Setup status observation failed");
    expect(text).not.toContain("observer-private-detail");
  });
});

function setup(repository: "missing" | "ready"): SetupStatusInput {
  return {
    mode: "production",
    observedAt: "2026-08-10T00:00:00Z",
    serviceOrigin: "https://api.stensibly.com",
    mcpEndpoint: "https://api.stensibly.com/mcp",
    steps: states(repository),
    lastVerifiedStep: "first_read",
  };
}

function states(repository: "missing" | "ready"): SetupStepStates {
  return {
    deployment: "ready",
    backend: "ready",
    account: "ready",
    workspace: "ready",
    project: "ready",
    oauth_discovery: "ready",
    mcp_connection: "ready",
    first_read: "ready",
    repository,
    proofwake: "deferred",
  };
}

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
