import { afterEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { createApiV1 } from "../src/api-v1.ts";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import { ConvexProjectAttachmentLedger } from "../src/project-attachment-convex-ledger.ts";
import {
  createProjectRepositorySetupObservationRecord,
  projectRepositorySetupObservationFingerprint,
} from "../src/project-repository-setup-observation.ts";
import {
  SqliteProjectRepositorySetupObservationLedger,
} from "../src/project-repository-setup-observation-sqlite.ts";
import {
  renderProjectContract,
  type ProjectContract,
} from "../src/project-contract.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";

const principal: TokenPrincipal = {
  tokenId: "tok_attachment_review_composition",
  name: "attachment-review-composition",
  scopes: ["admin"],
  projects: ["scrapbook"],
};

class FixedAuthenticator implements ApiTokenAuthenticator {
  async authenticate(rawToken: string): Promise<TokenPrincipal | null> {
    return rawToken === "admin" ? principal : null;
  }
}

const stores: StensiblyStore[] = [];
afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

describe("attachment review aggregate composition", () => {
  test("mounts the review action with the matching SQLite proposal ledger", async () => {
    const store = new StensiblyStore(":memory:");
    stores.push(store);
    const ledger = new SqliteWorkLedger(store);
    const observations = new SqliteProjectRepositorySetupObservationLedger(store);
    await observations.recordProjectRepositorySetupObservation({
      project: "scrapbook",
      repositoryFullName: "teamleaderleo/scrapbook",
      defaultBranch: "main",
      sourceKind: "operator_supplied",
    });

    const app = createApiV1(new FixedAuthenticator(), ledger, { required: true });
    const response = await review(app);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      review: {
        project: "scrapbook",
        repositoryFullName: "teamleaderleo/scrapbook",
        defaultBranch: "main",
        authorizesAttachmentAcceptance: false,
        authorizesProviderEffect: false,
      },
    });
    expect(await ledger.getProjectAttachment("scrapbook")).toBeNull();
  });

  test("mounts the review action with the matching Convex proposal ledger", async () => {
    const semantics = {
      project: "scrapbook",
      repositoryFullName: "teamleaderleo/scrapbook",
      defaultBranch: "main",
      sourceKind: "operator_supplied" as const,
    };
    const proposal = createProjectRepositorySetupObservationRecord({
      id: "repo_setup_composition01",
      ...semantics,
      semanticFingerprint: projectRepositorySetupObservationFingerprint(semantics),
      observedAt: "2026-08-10T02:00:00.000Z",
    });
    const client: ConvexCaller = {
      async query(reference) {
        const name = getFunctionName(reference);
        if (name === "projectRepositorySetupObservations:getCurrent") return proposal;
        if (name === "projectAttachments:getCurrent") return null;
        throw new Error(`Unexpected Convex query: ${name}`);
      },
      async mutation(reference) {
        throw new Error(`Unexpected Convex mutation: ${getFunctionName(reference)}`);
      },
    };
    const ledger = new ConvexProjectAttachmentLedger({
      client,
      serviceSecret: "service-secret",
      workspace: "default",
    });
    const app = createApiV1(new FixedAuthenticator(), ledger, { required: true });
    const response = await review(app);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      review: {
        project: "scrapbook",
        repositoryFullName: "teamleaderleo/scrapbook",
        defaultBranch: "main",
        authorizesAttachmentAcceptance: false,
        authorizesProviderEffect: false,
      },
    });
  });
});

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

function review(app: ReturnType<typeof createApiV1>): Promise<Response> {
  return app.request("/projects/scrapbook/attachment/review", {
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
