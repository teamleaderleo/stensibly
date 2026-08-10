import { afterEach, describe, expect, test } from "bun:test";
import {
  getSqliteProjectRepositorySetupObservation,
  listSqliteProjectRepositorySetupObservationHistory,
  recordSqliteProjectRepositorySetupObservation,
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
