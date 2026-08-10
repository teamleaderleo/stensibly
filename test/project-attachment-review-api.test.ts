import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createProjectAttachmentReviewApi,
} from "../src/project-attachment-review-api.ts";
import type {
  ProjectRepositorySetupObservationLedger,
} from "../src/project-repository-setup-observation.ts";
import {
  SqliteProjectRepositorySetupObservationLedger,
} from "../src/project-repository-setup-observation-sqlite.ts";
import {
  compileProjectContract,
  renderProjectContract,
  type ProjectContract,
} from "../src/project-contract.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";

const principals: Record<string, TokenPrincipal> = {
  admin: {
    tokenId: "tok_attachment_review_admin",
    name: "attachment-review-admin",
    scopes: ["admin"],
    projects: ["scrapbook"],
  },
  reader: {
    tokenId: "tok_attachment_review_reader",
    name: "attachment-review-reader",
    scopes: ["read"],
    projects: ["scrapbook"],
  },
};

class FixedAuthenticator implements ApiTokenAuthenticator {
  async authenticate(rawToken: string): Promise<TokenPrincipal | null> {
    return principals[rawToken] ?? null;
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

describe("project attachment review API", () => {
  test("admin previews first acceptance without mutating attachment state", async () => {
    const app = createProjectAttachmentReviewApi(
      new FixedAuthenticator(),
      ledger,
      { required: true },
      observations,
    );
    const response = await app.request(
      "/projects/scrapbook/attachment/review",
      {
        method: "POST",
        headers: {
          ...bearer("admin"),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          source: source(baseContract),
          sourceRevision: "main@reviewed",
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      review: {
        project: "scrapbook",
        repositoryFullName: "teamleaderleo/scrapbook",
        defaultBranch: "main",
        sourceRevision: "main@reviewed",
        requiresAuthorityWidening: true,
        exactReplay: false,
        authorizesAttachmentAcceptance: false,
        authorizesProviderEffect: false,
        containsSecrets: false,
      },
    });
    expect(await ledger.getProjectAttachment("scrapbook")).toBeNull();
  });

  test("read-only principal cannot preview an admin attachment action", async () => {
    const app = createProjectAttachmentReviewApi(
      new FixedAuthenticator(),
      ledger,
      { required: true },
      observations,
    );
    const response = await app.request(
      "/projects/scrapbook/attachment/review",
      {
        method: "POST",
        headers: {
          ...bearer("reader"),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          source: source(baseContract),
          sourceRevision: "main@reviewed",
        }),
      },
    );
    expect(response.status).toBe(403);
    expect(await ledger.getProjectAttachment("scrapbook")).toBeNull();
  });

  test("exact accepted snapshot previews as a replay without widening", async () => {
    const snapshot = compileProjectContract(source(baseContract));
    await ledger.acceptProjectAttachment({
      project: "scrapbook",
      snapshot,
      sourceRevision: "main@accepted",
      acceptedBy: "token:operator",
      acceptAuthorityWidening: true,
    });
    const app = createProjectAttachmentReviewApi(
      new FixedAuthenticator(),
      ledger,
      { required: true },
      observations,
    );
    const response = await app.request(
      "/projects/scrapbook/attachment/review",
      {
        method: "POST",
        headers: {
          ...bearer("admin"),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          source: source(baseContract),
          sourceRevision: "main@same-bytes",
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      review: {
        exactReplay: true,
        requiresAuthorityWidening: false,
        diff: null,
      },
    });
  });

  test("missing proposal and mismatched source fail before any attachment mutation", async () => {
    const emptyStore = new StensiblyStore(":memory:");
    try {
      const emptyLedger = new SqliteWorkLedger(emptyStore);
      const emptyObservations = new SqliteProjectRepositorySetupObservationLedger(emptyStore);
      const missingApp = createProjectAttachmentReviewApi(
        new FixedAuthenticator(),
        emptyLedger,
        { required: true },
        emptyObservations,
      );
      const missing = await missingApp.request(
        "/projects/scrapbook/attachment/review",
        {
          method: "POST",
          headers: {
            ...bearer("admin"),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            source: source(baseContract),
            sourceRevision: "main@reviewed",
          }),
        },
      );
      expect(missing.status).toBe(409);
      expect(await missing.json()).toEqual({
        error: "A saved repository setup proposal is required before attachment review",
        code: "repository_setup_observation_required",
      });
      expect(await emptyLedger.getProjectAttachment("scrapbook")).toBeNull();
    } finally {
      emptyStore.close();
    }

    const app = createProjectAttachmentReviewApi(
      new FixedAuthenticator(),
      ledger,
      { required: true },
      observations,
    );
    const mismatch = await app.request(
      "/projects/scrapbook/attachment/review",
      {
        method: "POST",
        headers: {
          ...bearer("admin"),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          source: source({
            ...baseContract,
            repositories: ["teamleaderleo/stensibly"],
          }),
          sourceRevision: "main@mismatch",
        }),
      },
    );
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual({
      error: "Attachment review source does not match the saved repository proposal",
      code: "attachment_review_invalid",
    });
    expect(await ledger.getProjectAttachment("scrapbook")).toBeNull();
  });

  test("backend failures collapse to fixed review-context diagnostics", async () => {
    const failingObservations: ProjectRepositorySetupObservationLedger = {
      async getProjectRepositorySetupObservation() {
        throw new Error("private-provider-detail");
      },
      async recordProjectRepositorySetupObservation() {
        throw new Error("unused");
      },
    };
    const app = createProjectAttachmentReviewApi(
      new FixedAuthenticator(),
      ledger,
      { required: true },
      failingObservations,
    );
    const response = await app.request(
      "/projects/scrapbook/attachment/review",
      {
        method: "POST",
        headers: {
          ...bearer("admin"),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          source: source(baseContract),
          sourceRevision: "main@reviewed",
        }),
      },
    );
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("Attachment review context could not be read");
    expect(text).not.toContain("private-provider-detail");
  });
});

const baseContract: ProjectContract = {
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

function source(contract: ProjectContract): string {
  return renderProjectContract(contract, context);
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
