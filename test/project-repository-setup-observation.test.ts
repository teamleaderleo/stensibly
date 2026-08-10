import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createProjectRepositorySetupObservationRecord,
  prepareProjectRepositorySetupObservation,
  projectRepositorySetupObservationFingerprint,
} from "../src/project-repository-setup-observation.ts";
import {
  SqliteProjectRepositorySetupObservationLedger,
} from "../src/project-repository-setup-observation-sqlite.ts";
import { StensiblyStore } from "../src/store.ts";

const scrapbook = {
  project: "scrapbook",
  repositoryFullName: "teamleaderleo/scrapbook",
  defaultBranch: "main",
  sourceKind: "github_conversation_context" as const,
};

let store: StensiblyStore;
let ledger: SqliteProjectRepositorySetupObservationLedger;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  ledger = new SqliteProjectRepositorySetupObservationLedger(store);
});

afterEach(() => store.close());

describe("pre-attachment repository setup observation contract", () => {
  test("prepares a deterministic non-authorizing Scrapbook observation", () => {
    const prepared = prepareProjectRepositorySetupObservation(null, scrapbook);
    expect(prepared).toMatchObject({
      project: "scrapbook",
      repositoryFullName: "teamleaderleo/scrapbook",
      defaultBranch: "main",
      sourceKind: "github_conversation_context",
      replay: null,
    });
    expect(prepared.semanticFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(prepared.semanticFingerprint).toBe(
      projectRepositorySetupObservationFingerprint(scrapbook),
    );

    const record = createProjectRepositorySetupObservationRecord({
      id: "repo_setup_12345678",
      ...scrapbook,
      semanticFingerprint: prepared.semanticFingerprint,
      observedAt: "2026-08-10T00:30:00.000Z",
    });
    expect(record).toMatchObject({
      version: 1,
      authorizesProviderEffect: false,
      containsSecrets: false,
    });
    expect(Object.isFrozen(record)).toBe(true);
  });

  test("admits an exact optional current-observation fence without changing semantic identity", () => {
    const unfenced = prepareProjectRepositorySetupObservation(null, scrapbook);
    const firstWrite = prepareProjectRepositorySetupObservation(null, {
      ...scrapbook,
      expectedCurrentObservationId: null,
    });
    const replacement = prepareProjectRepositorySetupObservation(null, {
      ...scrapbook,
      expectedCurrentObservationId: "repo_setup_12345678",
    });
    expect(firstWrite.expectedCurrentObservationId).toBeNull();
    expect(replacement.expectedCurrentObservationId).toBe("repo_setup_12345678");
    expect(firstWrite.semanticFingerprint).toBe(unfenced.semanticFingerprint);
    expect(replacement.semanticFingerprint).toBe(unfenced.semanticFingerprint);
  });

  test("rejects malformed or credential-shaped project, repository, branch, source, and fence values", () => {
    expect(() => prepareProjectRepositorySetupObservation(null, {
      ...scrapbook,
      project: "Scrapbook",
    })).toThrow("Project is invalid");
    expect(() => prepareProjectRepositorySetupObservation(null, {
      ...scrapbook,
      repositoryFullName: "teamleaderleo",
    })).toThrow();
    expect(() => prepareProjectRepositorySetupObservation(null, {
      ...scrapbook,
      defaultBranch: "refs/heads/main",
    })).toThrow("Repository default branch is invalid");
    expect(() => prepareProjectRepositorySetupObservation(null, {
      ...scrapbook,
      sourceKind: "webhook_guess" as any,
    })).toThrow("source kind is invalid");
    expect(() => prepareProjectRepositorySetupObservation(null, {
      ...scrapbook,
      expectedCurrentObservationId: "wrong",
    })).toThrow("observation id is invalid");

    const credentialBranch = ["secret://", "branch"].join("");
    expect(() => prepareProjectRepositorySetupObservation(null, {
      ...scrapbook,
      defaultBranch: credentialBranch,
    })).toThrow("Repository default branch is invalid");
  });

  test("rejects a record whose retained fingerprint does not match its semantics", () => {
    expect(() => createProjectRepositorySetupObservationRecord({
      id: "repo_setup_12345678",
      ...scrapbook,
      semanticFingerprint: `sha256:${"0".repeat(64)}`,
      observedAt: "2026-08-10T00:30:00.000Z",
    })).toThrow("fingerprint is invalid");
  });
});

describe("SQLite pre-attachment repository setup observations", () => {
  test("records, replays, and visibly replaces the current project proposal", async () => {
    const first = await ledger.recordProjectRepositorySetupObservation(scrapbook);
    expect(first).toMatchObject({
      replayed: false,
      replacedObservationId: null,
      observation: {
        project: "scrapbook",
        repositoryFullName: "teamleaderleo/scrapbook",
        defaultBranch: "main",
        sourceKind: "github_conversation_context",
        authorizesProviderEffect: false,
        containsSecrets: false,
      },
    });

    const replay = await ledger.recordProjectRepositorySetupObservation(scrapbook);
    expect(replay).toMatchObject({ replayed: true, replacedObservationId: null });
    expect(replay.observation.id).toBe(first.observation.id);

    const replaced = await ledger.recordProjectRepositorySetupObservation({
      ...scrapbook,
      defaultBranch: "develop",
    });
    expect(replaced.replayed).toBe(false);
    expect(replaced.replacedObservationId).toBe(first.observation.id);
    expect(replaced.observation.id).not.toBe(first.observation.id);
    expect(replaced.observation.defaultBranch).toBe("develop");

    const current = await ledger.getProjectRepositorySetupObservation("scrapbook");
    expect(current?.id).toBe(replaced.observation.id);
    expect(store.db.query(`
      SELECT COUNT(*) AS count
      FROM project_repository_setup_observations
      WHERE project_id = ?1
    `).get("scrapbook")).toEqual({ count: 2 });
  });

  test("compare-and-swap fences first writes and stale replacements inside the transaction", async () => {
    const first = await ledger.recordProjectRepositorySetupObservation({
      ...scrapbook,
      expectedCurrentObservationId: null,
    });
    const second = await ledger.recordProjectRepositorySetupObservation({
      ...scrapbook,
      defaultBranch: "develop",
      expectedCurrentObservationId: first.observation.id,
    });

    await expect(ledger.recordProjectRepositorySetupObservation({
      ...scrapbook,
      defaultBranch: "trunk",
      expectedCurrentObservationId: first.observation.id,
    })).rejects.toThrow("changed before write");
    await expect(ledger.recordProjectRepositorySetupObservation({
      ...scrapbook,
      defaultBranch: "release",
      expectedCurrentObservationId: null,
    })).rejects.toThrow("changed before write");

    const current = await ledger.getProjectRepositorySetupObservation("scrapbook");
    expect(current?.id).toBe(second.observation.id);
    expect(current?.defaultBranch).toBe("develop");
    expect(store.db.query(`
      SELECT COUNT(*) AS count
      FROM project_repository_setup_observations
      WHERE project_id = ?1
    `).get("scrapbook")).toEqual({ count: 2 });
  });

  test("treats source provenance changes as visible proposal replacement", async () => {
    const first = await ledger.recordProjectRepositorySetupObservation(scrapbook);
    const replaced = await ledger.recordProjectRepositorySetupObservation({
      ...scrapbook,
      sourceKind: "operator_supplied",
    });
    expect(replaced.replayed).toBe(false);
    expect(replaced.replacedObservationId).toBe(first.observation.id);
    expect(replaced.observation.sourceKind).toBe("operator_supplied");
  });

  test("isolates current observations by project", async () => {
    await ledger.recordProjectRepositorySetupObservation(scrapbook);
    await ledger.recordProjectRepositorySetupObservation({
      project: "other",
      repositoryFullName: "teamleaderleo/other",
      defaultBranch: "main",
      sourceKind: "operator_supplied",
    });

    expect((await ledger.getProjectRepositorySetupObservation("scrapbook"))?.repositoryFullName)
      .toBe("teamleaderleo/scrapbook");
    expect((await ledger.getProjectRepositorySetupObservation("other"))?.repositoryFullName)
      .toBe("teamleaderleo/other");
  });

  test("fails closed when stored semantics and fingerprint are tampered", async () => {
    const recorded = await ledger.recordProjectRepositorySetupObservation(scrapbook);
    store.db.query(`
      UPDATE project_repository_setup_observations
      SET default_branch = ?1
      WHERE id = ?2
    `).run("develop", recorded.observation.id);

    await expect(ledger.getProjectRepositorySetupObservation("scrapbook"))
      .rejects.toThrow("fingerprint is invalid");
  });
});
