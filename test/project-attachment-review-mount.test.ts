import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHostedApp } from "../src/hosted-app.ts";
import {
  SqliteProjectRepositorySetupObservationLedger,
} from "../src/project-repository-setup-observation-sqlite.ts";
import {
  renderProjectContract,
  type ProjectContract,
} from "../src/project-contract.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";

const admin: TokenPrincipal = {
  tokenId: "tok_attachment_review_mount_admin",
  name: "attachment-review-mount-admin",
  scopes: ["admin"],
  projects: ["scrapbook"],
};

class FixedAuthenticator implements ApiTokenAuthenticator {
  async authenticate(rawToken: string): Promise<TokenPrincipal | null> {
    return rawToken === "admin" ? admin : null;
  }
}

let store: StensiblyStore;
let ledger: SqliteWorkLedger;
let observations: SqliteProjectRepositorySetupObservationLedger;

beforeEach(async () => {
  store = new StensiblyStore(":memory:");
  ledger = new SqliteWorkLedger(store);
  observations = new SqliteProjectRepositorySetupObservationLedger(store);
  await observations.recordProjectRepositorySetupObservation({
    project: "scrapbook",
    repositoryFullName: "teamleaderleo/scrapbook",
    defaultBranch: "main",
    sourceKind: "operator_supplied",
  });
});

afterEach(() => store.close());

describe("project attachment review aggregate mounts", () => {
  test("local server mounts the review against its SQLite proposal ledger", async () => {
    const app = createServerApp(store, {
      ledger,
      authenticator: new FixedAuthenticator(),
      httpAuth: { required: true },
    });

    const response = await preview(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      review: {
        project: "scrapbook",
        repositoryFullName: "teamleaderleo/scrapbook",
        defaultBranch: "main",
        sourceRevision: "main@reviewed",
        requiresAuthorityWidening: true,
        authorizesAttachmentAcceptance: false,
        authorizesProviderEffect: false,
      },
    });
    expect(await ledger.getProjectAttachment("scrapbook")).toBeNull();
  });

  test("hosted app mounts the review against the supplied proposal ledger", async () => {
    const app = createHostedApp({
      ledger,
      authenticator: new FixedAuthenticator(),
      repositorySetupObservations: observations,
    });

    const response = await preview(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      review: {
        project: "scrapbook",
        repositoryFullName: "teamleaderleo/scrapbook",
        defaultBranch: "main",
        sourceRevision: "main@reviewed",
        requiresAuthorityWidening: true,
        authorizesAttachmentAcceptance: false,
        authorizesProviderEffect: false,
      },
    });
    expect(await ledger.getProjectAttachment("scrapbook")).toBeNull();
  });
});

function preview(app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }) {
  return app.request("/api/v1/projects/scrapbook/attachment/review", {
    method: "POST",
    headers: {
      authorization: "Bearer admin",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      source: renderProjectContract(contract, context),
      sourceRevision: "main@reviewed",
    }),
  });
}

const contract: ProjectContract = {
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
};

const context = {
  goal: "Coordinate Scrapbook work.",
  boundaries: "Keep consequential effects approval-gated.",
  evidenceAndHandoff: "Leave exact repository evidence.",
  escalation: "Escalate missing authority.",
};
