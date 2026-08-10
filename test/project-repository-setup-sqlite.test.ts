import { afterEach, describe, expect, test } from "bun:test";
import {
  getSqliteProjectRepositorySetupObservation,
  listSqliteProjectRepositorySetupObservationHistory,
  recordSqliteProjectRepositorySetupObservation,
  SqliteProjectRepositorySetupObservationLedger,
} from "../src/project-repository-setup-sqlite.ts";
import {
  ProjectRepositorySetupObservationConflictError,
} from "../src/project-repository-setup-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

let store: StensiblyStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

function open() {
  store = new StensiblyStore(":memory:");
  return store;
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    project: "scrapbook",
    repositoryFullName: "teamleaderleo/scrapbook",
    defaultBranch: "main",
    sourceKind: "github_conversation_context" as const,
    observedAt: "2026-08-10T00:30:00.000Z",
    expectedCurrentFingerprint: null,
    ...overrides,
  } as const;
}

describe("SQLite pre-attachment repository setup observations", () => {
  test("records and exactly replays the current proposal", () => {
    const db = open();
    const first = recordSqliteProjectRepositorySetupObservation(db, input());
    const replay = recordSqliteProjectRepositorySetupObservation(db, input({
      expectedCurrentFingerprint: first.observation.fingerprint,
    }));

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.observation).toEqual(first.observation);
    expect(getSqliteProjectRepositorySetupObservation(db, "scrapbook"))
      .toEqual(first.observation);
    expect(listSqliteProjectRepositorySetupObservationHistory(db, "scrapbook"))
      .toEqual([first.observation]);
  });

  test("replaces only from the exact current fingerprint and retains history", () => {
    const db = open();
    const first = recordSqliteProjectRepositorySetupObservation(db, input());
    const second = recordSqliteProjectRepositorySetupObservation(db, input({
      defaultBranch: "develop",
      observedAt: "2026-08-10T00:31:00.000Z",
      expectedCurrentFingerprint: first.observation.fingerprint,
    }));

    expect(second.replayed).toBe(false);
    expect(second.replacedFingerprint).toBe(first.observation.fingerprint);
    expect(second.observation.defaultBranch).toBe("develop");
    expect(getSqliteProjectRepositorySetupObservation(db, "scrapbook"))
      .toEqual(second.observation);
    expect(listSqliteProjectRepositorySetupObservationHistory(db, "scrapbook"))
      .toEqual([second.observation, first.observation]);
  });

  test("rejects stale replacement and older observations", () => {
    const db = open();
    const first = recordSqliteProjectRepositorySetupObservation(db, input());

    expect(() => recordSqliteProjectRepositorySetupObservation(db, input({
      defaultBranch: "develop",
      observedAt: "2026-08-10T00:31:00.000Z",
      expectedCurrentFingerprint: `sha256:${"0".repeat(64)}`,
    }))).toThrow(ProjectRepositorySetupObservationConflictError);
    expect(() => recordSqliteProjectRepositorySetupObservation(db, input({
      defaultBranch: "develop",
      observedAt: "2026-08-09T23:59:00.000Z",
      expectedCurrentFingerprint: first.observation.fingerprint,
    }))).toThrow("must be newer");

    expect(getSqliteProjectRepositorySetupObservation(db, "scrapbook"))
      .toEqual(first.observation);
  });

  test("migrates the merged #1356 SQLite schema without losing history", async () => {
    const db = open();
    db.db.exec(`
      CREATE TABLE project_repository_setup_observations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        repository_full_name TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        semantic_fingerprint TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE INDEX idx_project_repository_setup_observations_current
        ON project_repository_setup_observations(project_id, sequence DESC);
      CREATE INDEX idx_project_repository_setup_observations_fingerprint
        ON project_repository_setup_observations(
          project_id,
          semantic_fingerprint,
          sequence DESC
        );
    `);
    db.db.query(`
      INSERT INTO projects (id, name, created_at)
      VALUES ('scrapbook', 'scrapbook', '2026-08-10T00:29:00.000Z')
    `).run();
    const legacyInsert = db.db.query(`
      INSERT INTO project_repository_setup_observations (
        id,
        project_id,
        repository_full_name,
        default_branch,
        source_kind,
        semantic_fingerprint,
        observed_at
      ) VALUES (?1, 'scrapbook', 'teamleaderleo/scrapbook', ?2,
        'github_conversation_context', ?3, ?4)
    `);
    legacyInsert.run(
      "repo_setup_legacy-main",
      "main",
      `sha256:${"1".repeat(64)}`,
      "2026-08-10T00:30:00.000Z",
    );
    legacyInsert.run(
      "repo_setup_legacy-develop",
      "develop",
      `sha256:${"2".repeat(64)}`,
      "2026-08-10T00:31:00.000Z",
    );

    const ledger = new SqliteProjectRepositorySetupObservationLedger(db);
    const current = await ledger.getCurrentProjectRepositorySetupObservation("scrapbook");
    expect(current).toMatchObject({
      repositoryFullName: "teamleaderleo/scrapbook",
      defaultBranch: "develop",
      observedAt: "2026-08-10T00:31:00.000Z",
      authorizesProviderEffect: false,
      containsSecrets: false,
    });
    expect(listSqliteProjectRepositorySetupObservationHistory(db, "scrapbook")
      .map((observation) => observation.defaultBranch))
      .toEqual(["develop", "main"]);

    const columns = db.db
      .query<{ name: string }, []>(
        "PRAGMA table_info(project_repository_setup_observations)",
      )
      .all()
      .map((column) => column.name);
    expect(columns).toContain("fingerprint");
    expect(columns).toContain("recorded_at");
    expect(columns).toContain("is_current");
    expect(columns).not.toContain("semantic_fingerprint");
  });

  test("keeps projects isolated", () => {
    const db = open();
    const scrapbook = recordSqliteProjectRepositorySetupObservation(db, input());
    const stensibly = recordSqliteProjectRepositorySetupObservation(db, input({
      project: "stensibly",
      repositoryFullName: "teamleaderleo/stensibly",
      observedAt: "2026-08-10T00:30:01.000Z",
    }));

    expect(getSqliteProjectRepositorySetupObservation(db, "scrapbook"))
      .toEqual(scrapbook.observation);
    expect(getSqliteProjectRepositorySetupObservation(db, "stensibly"))
      .toEqual(stensibly.observation);
  });
});
