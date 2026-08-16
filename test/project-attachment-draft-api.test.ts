import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { compileProjectContract } from "../src/project-contract.ts";
import {
  SqliteProjectRepositorySetupObservationLedger,
} from "../src/project-repository-setup-observation-sqlite.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";

const admin: TokenPrincipal = {
  tokenId: "tok_attachment_draft_admin",
  name: "attachment-draft-admin",
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

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  ledger = new SqliteWorkLedger(store);
  observations = new SqliteProjectRepositorySetupObservationLedger(store);
});

afterEach(() => store.close());

describe("project attachment draft API", () => {
  test("generates a deterministic reviewable draft without mutating attachment state", async () => {
    const saved = await observations.recordProjectRepositorySetupObservation({
      project: "scrapbook",
      repositoryFullName: "teamleaderleo/scrapbook",
      defaultBranch: "main",
      sourceKind: "github_conversation_context",
    });
    const app = createServerApp(store, {
      ledger,
      authenticator: new FixedAuthenticator(),
      httpAuth: { required: true },
    });

    const first = await getDraft(app);
    const second = await getDraft(app);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      version: 1,
      project: "scrapbook",
      proposalId: saved.observation.id,
      proposalFingerprint: saved.observation.semanticFingerprint,
      repositoryFullName: "teamleaderleo/scrapbook",
      defaultBranch: "main",
      authorizesAttachmentAcceptance: false,
      authorizesProviderEffect: false,
      containsSecrets: false,
    });
    expect(first.sourceRevision).toBe(
      `generated:${saved.observation.id}:${saved.observation.semanticFingerprint}`,
    );
    expect(first.source).toContain("project: scrapbook");
    expect(first.source).toContain("teamleaderleo/scrapbook");
    const snapshot = compileProjectContract(first.source);
    expect(snapshot.source.contentSha256).toBe(first.sourceContentSha256);
    expect(snapshot.snapshotSha256).toBe(first.snapshotSha256);
    expect(snapshot.contract.repositories).toEqual(["teamleaderleo/scrapbook"]);
    expect(await ledger.getProjectAttachment("scrapbook")).toBeNull();
  });

  test("requires a saved proposal and changes revision when the proposal changes", async () => {
    const app = createServerApp(store, {
      ledger,
      authenticator: new FixedAuthenticator(),
      httpAuth: { required: true },
    });
    const missing = await app.request("/api/v1/projects/scrapbook/attachment/draft", {
      headers: bearer(),
    });
    expect(missing.status).toBe(409);

    const firstSaved = await observations.recordProjectRepositorySetupObservation({
      project: "scrapbook",
      repositoryFullName: "teamleaderleo/scrapbook",
      defaultBranch: "main",
      sourceKind: "github_conversation_context",
    });
    const first = await getDraft(app);
    const secondSaved = await observations.recordProjectRepositorySetupObservation({
      project: "scrapbook",
      repositoryFullName: "teamleaderleo/scrapbook",
      defaultBranch: "trunk",
      sourceKind: "github_conversation_context",
      expectedCurrentObservationId: firstSaved.observation.id,
    });
    const second = await getDraft(app);
    expect(second.proposalId).toBe(secondSaved.observation.id);
    expect(second.proposalFingerprint).toBe(secondSaved.observation.semanticFingerprint);
    expect(second.sourceRevision).not.toBe(first.sourceRevision);
    expect(second.source).toBe(first.source);
    expect(await ledger.getProjectAttachment("scrapbook")).toBeNull();
  });
});

async function getDraft(app: ReturnType<typeof createServerApp>): Promise<any> {
  const response = await app.request("/api/v1/projects/scrapbook/attachment/draft", {
    headers: bearer(),
  });
  expect(response.status).toBe(200);
  const payload = await response.json();
  return payload.draft;
}

function bearer(): Record<string, string> {
  return { authorization: "Bearer admin" };
}
